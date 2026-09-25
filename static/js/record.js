import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { CAPTURE_IMAGE_QUALITY, CAPTURE_IMAGE_TYPE } from './capture_image_format.mjs';
import {
    createUploadBatcher,
    normalizeBatchSize,
    DEFAULT_BATCH_SIZE,
    DEFAULT_BATCH_MAX_WAIT_MS,
} from './upload_batcher.mjs';

// Fonction utilitaire pour convertir dataUrl en Blob WebP
function dataUrlToBlob(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            // Pas de willReadFrequently : canvas seulement dessiné puis exporté via toBlob
            // (jamais relu), ce qui préserve l'accélération GPU.
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error(pkg.t('Échec conversion en Blob')));
                }
            }, CAPTURE_IMAGE_TYPE, CAPTURE_IMAGE_QUALITY);
        };
        img.onerror = () => reject(new Error(pkg.t('Échec chargement image')));
        img.src = dataUrl;
    });
}

// Nombre de tentatives d'upload par défaut (en plus de la tentative initiale)
const DEFAULT_UPLOAD_RETRIES = 3;
// Délai de base entre deux tentatives (backoff exponentiel : 400ms, 800ms, 1600ms...)
const UPLOAD_RETRY_BASE_DELAY = 400;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function imageFileName(counter, numberSize) {
    return `image_${String(counter).padStart(numberSize, '0')}.webp`;
}

function currentNumberSize() {
    const size = Number(pkg.options?.record?.numberOfDigits);
    return Number.isFinite(size) && size > 0 ? Math.floor(size) : 4;
}

function currentRetries() {
    return Math.max(0, Number(pkg.options?.record?.uploadRetries ?? DEFAULT_UPLOAD_RETRIES));
}

/** Taille de lot effective (configurable, bornée). Exposée pour le dimensionnement
 *  de la backpressure côté capture (cf. mapgl.js). */
export function getUploadBatchSize() {
    return normalizeBatchSize(pkg.options?.record?.uploadBatchSize, DEFAULT_BATCH_SIZE);
}

function batchMaxWaitMs() {
    const wait = Number(pkg.options?.record?.uploadBatchMaxWaitMs);
    return Number.isFinite(wait) && wait >= 0 ? wait : DEFAULT_BATCH_MAX_WAIT_MS;
}

// Repli automatique : un serveur antérieur à l'ajout de /upload_images répond 404.
// Dans ce cas on bascule définitivement (pour la session) sur l'envoi image par image.
let batchEndpointUnavailable = false;

class HttpError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
        // 4xx : erreur client, un nouvel essai ne la corrigera pas.
        this.noRetry = status >= 400 && status < 500;
    }
}

// Exécute `attemptFn` avec retry/backoff sur erreur réseau ou 5xx.
async function withRetry(attemptFn, retries, label) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await attemptFn();
        } catch (error) {
            lastError = error;
            if (error.noRetry || attempt === retries) break;
            const wait = UPLOAD_RETRY_BASE_DELAY * Math.pow(2, attempt);
            console.warn(`[UPLOAD] Tentative ${attempt + 1}/${retries + 1} échouée pour ${label} (nouvel essai dans ${wait}ms):`, error.message);
            await delay(wait);
        }
    }

    console.error(`[UPLOAD] Échec définitif de l’envoi de ${label} après ${retries + 1} tentative(s):`, lastError);
    throw lastError;
}

async function postForm(url, formData) {
    const response = await fetch(url, {
        method: 'POST',
        body: formData // FormData, pas de headers Content-Type explicite
    });

    if (!response.ok) {
        throw new HttpError(`Erreur lors de l’envoi de l’image (${response.status})`, response.status);
    }

    return await response.json();
}

// Envoi d'une seule image (voie historique, conservée pour le repli et pour les
// appels ponctuels hors file d'attente).
async function uploadOne({ blob, counter, numberSize }, retries) {
    const fileName = imageFileName(counter, numberSize);

    return withRetry(async () => {
        const fd = new FormData();
        fd.append('image', blob, fileName);
        fd.append('counter', counter.toString());
        fd.append('numberSize', numberSize.toString());
        return postForm(`${CONFIG.BASE_URL}/upload_image`, fd);
    }, retries, fileName);
}

// Envoi groupé : un seul multipart pour N images → N fois moins d'allers-retours
// HTTP et de passages dans Flask. Les écritures étant nommées par compteur, un
// nouvel essai du lot complet est idempotent (mêmes fichiers réécrits).
async function uploadBatch(items, retries) {
    const label = items.length === 1
        ? imageFileName(items[0].counter, items[0].numberSize)
        : `lot de ${items.length} images (${imageFileName(items[0].counter, items[0].numberSize)}…)`;

    return withRetry(async () => {
        const fd = new FormData();
        for (const item of items) {
            fd.append('images', item.blob, imageFileName(item.counter, item.numberSize));
            fd.append('counters', item.counter.toString());
        }
        fd.append('numberSize', items[0].numberSize.toString());

        try {
            return await postForm(`${CONFIG.BASE_URL}/upload_images`, fd);
        } catch (error) {
            if (error.status === 404 && !batchEndpointUnavailable) {
                batchEndpointUnavailable = true;
                console.warn('[UPLOAD] /upload_images indisponible (404) : repli sur l’envoi image par image.');
                return await uploadItemsIndividually(items, retries);
            }
            throw error;
        }
    }, retries, label);
}

// Repli : envoi séquentiel des images d'un lot sur l'ancienne route.
async function uploadItemsIndividually(items, retries) {
    const results = [];
    for (const item of items) {
        results.push(await uploadOne(item, retries));
    }
    return { success: true, count: results.length, fallback: true };
}

let batcher = null;

function getBatcher() {
    // La taille de lot est figée à la création : l'accumulateur n'est jamais
    // remplacé en cours d'enregistrement (des images en tampon seraient perdues).
    // resetImageUploadQueue() le libère entre deux enregistrements, ce qui relit
    // la configuration courante.
    if (!batcher) {
        batcher = createUploadBatcher({
            batchSize: getUploadBatchSize(),
            maxWaitMs: batchMaxWaitMs(),
            send: (items) => (batchEndpointUnavailable
                ? uploadItemsIndividually(items, currentRetries())
                : uploadBatch(items, currentRetries())),
        });
    }
    return batcher;
}

function toBlobPromise(imageData) {
    // Détecter si c'est déjà un Blob (canvas-only) ou une dataUrl (html2canvas)
    if (imageData instanceof Blob) {
        return Promise.resolve(imageData);
    }
    if (typeof imageData === 'string' && imageData.startsWith('data:')) {
        return dataUrlToBlob(imageData);
    }
    return Promise.reject(new Error(pkg.t('Type de données image non supporté')));
}

/**
 * Met une image en file d'envoi groupé. La promesse retournée se résout quand le
 * lot contenant cette image a été accepté par le serveur (et rejette si le lot a
 * définitivement échoué). L'appelant garde donc un suivi par frame.
 */
export function queueImageUpload(imageData, counter) {
    const numberSize = currentNumberSize();
    return toBlobPromise(imageData)
        .then(blob => getBatcher().add({ blob, counter, numberSize }));
}

/** Force l'envoi immédiat du lot partiel en attente (fin de capture, backpressure). */
export function flushImageUploads() {
    return batcher ? batcher.flush() : Promise.resolve(null);
}

/** Vide le tampon puis attend la fin de tous les lots en vol. */
export function drainImageUploads() {
    return batcher ? batcher.drain() : Promise.resolve();
}

/** Abandonne le tampon (nouvel enregistrement / annulation). */
export function resetImageUploadQueue() {
    if (!batcher) return;
    batcher.reset(pkg.t('Enregistrement réinitialisé'));
    batcher = null; // relecture de la configuration au prochain enregistrement
}

/** Envoi immédiat d'une image, sans passer par la file (compatibilité). */
export function sendImageToServer(imageData, counter) {
    const numberSize = currentNumberSize();
    return toBlobPromise(imageData)
        .then(blob => uploadOne({ blob, counter, numberSize }, currentRetries()));
}
