// File d'upload bornée du mode images.
//
// Extrait de mapgl.js. Découple la capture de l'upload : on n'attend plus la fin
// du POST avant de capturer la frame suivante (l'upload bloquait la capture →
// saccades). Un plafond de concurrence évite une consommation mémoire non bornée
// si le réseau est plus lent que la capture.
//
// Les images ne partent plus une par une mais par lots (cf. record.js /
// upload_batcher.mjs) : le plafond s'exprime donc en lots, converti ici en
// nombre d'images tolérées en vol.
import * as pkg from './index.js';
import { perfMetrics } from './recording_perf.js';

const MAX_UPLOAD_BATCHES_IN_FLIGHT = 4;
let uploadInFlight = 0;
let pendingUploads = [];
let uploadQueueError = null;
// Génération de la file : une erreur issue d'un enregistrement précédent (lot
// abandonné au reset) ne doit pas faire échouer l'enregistrement en cours.
let uploadSession = 0;

// Plafond d'images simultanément en tampon + en vol. Avec la taille de lot par
// défaut (12) et 4 lots, ~48 frames WebP peuvent être retenues en mémoire.
function maxImagesInFlight() {
    let batchSize = 1;
    try { batchSize = pkg.getUploadBatchSize(); } catch(_) {}
    return MAX_UPLOAD_BATCHES_IN_FLIGHT * Math.max(1, batchSize);
}

export function resetUploadQueue() {
    uploadSession++;
    try { pkg.resetImageUploadQueue(); } catch(_) {}
    uploadInFlight = 0;
    pendingUploads = [];
    uploadQueueError = null;
}

// Met une image en file d'envoi groupé (suivi pour backpressure et attente finale).
// NB : le temps mesuré inclut désormais l'attente du remplissage du lot — c'est la
// latence de bout en bout de la frame, pas le seul temps réseau.
export function enqueueImageUpload(blob, counter) {
    const session = uploadSession;
    uploadInFlight++;
    const t0 = performance.now();
    const p = pkg.queueImageUpload(blob, counter)
        .then(() => {
            perfMetrics.uploadTimeMs += (performance.now() - t0);
            perfMetrics.uploadOk += 1;
        })
        .catch((err) => {
            if (session !== uploadSession) return; // file réinitialisée entre-temps
            perfMetrics.uploadFail += 1;
            if (!uploadQueueError) uploadQueueError = err;
            throw err;
        })
        .finally(() => {
            if (session !== uploadSession) return;
            uploadInFlight--;
            const i = pendingUploads.indexOf(p);
            if (i >= 0) pendingUploads.splice(i, 1);
        });
    pendingUploads.push(p);
    return p;
}

// Backpressure : attend qu'un créneau se libère si trop d'images sont en vol.
// Propage une éventuelle erreur d'upload déjà survenue pour abandonner tôt.
export async function awaitUploadSlot() {
    if (uploadQueueError) throw uploadQueueError;
    while (uploadInFlight >= maxImagesInFlight()) {
        // Le lot partiel n'attend pas son délai : sans ce flush, on patienterait
        // pour rien alors que le tampon est déjà plein côté file.
        try { pkg.flushImageUploads(); } catch(_) {}
        await Promise.race(pendingUploads.map(p => p.catch(() => {})));
        if (uploadQueueError) throw uploadQueueError;
    }
}

// Attend la fin de tous les uploads en attente (fin d'enregistrement, avant assemblage).
// Le lot partiel restant est envoyé d'abord : sinon les dernières frames ne
// partiraient qu'au bout du délai d'attente du lot.
export async function awaitAllUploads() {
    try { await pkg.drainImageUploads(); } catch(_) {}
    await Promise.allSettled(pendingUploads.slice());
    if (uploadQueueError) throw uploadQueueError;
}
