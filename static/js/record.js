import * as pkg from './index.js';
import { CONFIG } from './init.js';

// Fonction utilitaire pour convertir dataUrl en Blob WebP
function dataUrlToBlob(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Échec conversion en Blob'));
                }
            }, 'image/webp', 0.9); // WebP avec qualité 95%
        };
        img.onerror = () => reject(new Error('Échec chargement image'));
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

// Envoie le blob au serveur avec retry automatique sur erreur réseau ou 5xx.
// Les erreurs client (4xx) ne sont pas retentées car un nouvel essai ne les corrigera pas.
async function uploadBlobWithRetry(blob, counter, retries) {
    const fileName = `image_${String(counter).padStart(pkg.options.record.numberOfDigits, '0')}.webp`;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const fd = new FormData();
            fd.append('image', blob, fileName);
            fd.append('counter', counter.toString());
            fd.append('numberSize', pkg.options.record.numberOfDigits.toString());

            const response = await fetch(`${CONFIG.BASE_URL}/upload_image`, {
                method: 'POST',
                body: fd // FormData, pas de headers Content-Type explicite
            });

            if (!response.ok) {
                // 4xx : erreur client, inutile de retenter
                if (response.status >= 400 && response.status < 500) {
                    const err = new Error(`Erreur client lors de l’envoi de l’image (${response.status})`);
                    err.noRetry = true;
                    throw err;
                }
                throw new Error(`Erreur serveur lors de l’envoi de l’image (${response.status})`);
            }

            return await response.json();
        } catch (error) {
            lastError = error;
            // Ne pas retenter les erreurs client, ni au-delà du nombre de tentatives
            if (error.noRetry || attempt === retries) {
                break;
            }
            const wait = UPLOAD_RETRY_BASE_DELAY * Math.pow(2, attempt);
            console.warn(`[UPLOAD] Tentative ${attempt + 1}/${retries + 1} échouée pour ${fileName} (nouvel essai dans ${wait}ms):`, error.message);
            await delay(wait);
        }
    }

    console.error(`[UPLOAD] Échec définitif de l’envoi de ${fileName} après ${retries + 1} tentative(s):`, lastError);
    throw lastError;
}

export function sendImageToServer(imageData, counter) {
    let blobPromise;

    // Détecter si c'est déjà un Blob (canvas-only) ou une dataUrl (html2canvas)
    if (imageData instanceof Blob) {
        // C'est déjà un Blob, on peut l'utiliser directement
        blobPromise = Promise.resolve(imageData);
    } else if (typeof imageData === 'string' && imageData.startsWith('data:')) {
        // C'est une dataUrl, on la convertit en Blob
        blobPromise = dataUrlToBlob(imageData);
    } else {
        return Promise.reject(new Error('Type de données image non supporté'));
    }

    const retries = Math.max(0, Number(pkg.options?.record?.uploadRetries ?? DEFAULT_UPLOAD_RETRIES));
    return blobPromise.then(blob => uploadBlobWithRetry(blob, counter, retries));
}
