// Post-traitement des vidéos issues du pipeline MediaRecorder.
//
// Extrait de mapgl.js. Transformations blob -> blob, sans aucun état partagé
// avec l'animation, la carte ou la capture : normalisation de vitesse,
// intégration de la piste audio, et réécriture de la durée dans l'en-tête WebM.
import * as pkg from './index.js';
import fixWebmDuration from './fix-webm-duration.js';
import { clampPlaybackRate, MAX_BROWSER_PLAYBACK_RATE } from './video_timing.mjs';
import {
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
} from './recording_settings.mjs';

// Flag de debug local (cf. DEBUG_MAPGL dans mapgl.js).
const DEBUG_VIDEO_POST = false;
const dbgMapgl = (...args) => { if (DEBUG_VIDEO_POST) console.log(...args); };
function warnPlaybackRateClamped(requested, effective){
    const ratio = effective > 0 ? (requested / effective) : requested;
    console.warn(
        `Normalisation : accélération x${requested} impossible, le navigateur applique x${effective} `
        + `(plafond ${MAX_BROWSER_PLAYBACK_RATE}x). La vidéo restera ~${ratio.toFixed(1)}x plus lente que prévu.`
    );
    try {
        pkg.showToast && pkg.showToast(
            `Le navigateur limite l'accélération à x${effective} (x${requested} demandé) : `
            + `la vidéo restera environ ${ratio.toFixed(1)}x plus lente que prévu. `
            + `Utilisez le traitement serveur pour un rythme exact.`,
            'warning', 'Normalisation', 8000
        );
    } catch(_) {}
}

export function normalizeRecordedVideoSpeed(sourceBlob, factor){
    return new Promise((resolve, reject) => {
        try {
            const { requested: requestedRate, rate: targetRate } = clampPlaybackRate(factor);
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            const url = URL.createObjectURL(sourceBlob);
            video.src = url;

            const fps = normalizeRecordingFps(pkg.options?.record?.fps);
            const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
            const vbps = normalizeRecordingBitrateMbps(
                Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) / 1_000_000
            ) * 1_000_000;

            let rec = null; let chunks = [];
            let progressTimer = null;
            let safetyTimeout = null;

            const cleanup = () => {
                try { if (progressTimer) clearInterval(progressTimer); } catch(_) {}
                try { if (safetyTimeout) clearTimeout(safetyTimeout); } catch(_) {}
                try { URL.revokeObjectURL(url); } catch(_) {}
                try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                // Certains navigateurs rabaissent la valeur affectée au lieu de la
                // refuser : relire playbackRate donne le taux réellement appliqué.
                let effectiveRate = 1;
                try {
                    video.playbackRate = targetRate;
                    const applied = Number(video.playbackRate);
                    effectiveRate = (Number.isFinite(applied) && applied > 0) ? applied : targetRate;
                } catch(_) { effectiveRate = 1; }
                if (effectiveRate < requestedRate - 0.01) {
                    warnPlaybackRateClamped(requestedRate, effectiveRate);
                }
                // Les .webm de MediaRecorder rapportent souvent duration === Infinity :
                // ne pas le laisser fuiter dans setTimeout (Infinity → 0 → déclenchement immédiat).
                const rawDur = video.duration;
                const duration = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 0;

                const stream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                if (!stream) { cleanup(); reject(new Error('captureStream non supporté pour la normalisation')); return; }

                // Timeout basé sur la durée à 1x + 60s : filet de sécurité si playbackRate
                // est appliqué plus bas que ce que l'élément rapporte (relecture mensongère).
                const maxMs = duration > 0 ? (duration * 1000 + 60000) : 1800000; // 30 min de garde si durée inconnue
                safetyTimeout = setTimeout(() => {
                    safetyTimeout = null;
                    cleanup();
                    reject(new Error('Timeout normalisation vidéo (' + Math.round(maxMs / 1000) + 's) : lecture bloquée ?'));
                }, maxMs);

                rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps });
                rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                rec.onstop = () => {
                    cleanup();
                    try { resolve(new Blob(chunks, { type: mime })); } catch(e) { resolve(new Blob(chunks)); }
                };
                // C9 — Échec de l'encodeur pendant la normalisation : rejeter pour que
                // l'appelant poursuive sans normaliser (dégradation propre) au lieu de
                // rester bloqué sur une Promise jamais résolue.
                rec.onerror = (e) => {
                    cleanup();
                    reject(new Error('Erreur encodeur lors de la normalisation : ' + (e?.error?.message || e?.message || 'inconnue')));
                };
                rec.start(Math.max(1000 / fps, 50));

                progressTimer = setInterval(() => {
                    try {
                        const p = duration > 0 ? Math.min(100, Math.max(0, (video.currentTime / duration) * 100)) : 0;
                        const message = p > 0 ? `Normalisation ${p.toFixed(1)}%` : 'Normalisation en cours';
                        pkg.updateProgressBar({ progress: p, message: message });
                    } catch(_) {}
                }, 200);

                video.addEventListener('ended', () => {
                    try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
                });

                video.play().catch(err => {
                    cleanup();
                    reject(err);
                });
            });

            video.addEventListener('error', (e) => {
                cleanup();
                reject(new Error('Erreur lecture vidéo pour normalisation'));
            });
        } catch(e) {
            reject(e);
        }
    });
}

export function muxRecordedVideoWithAudio(sourceBlob, audioFile){
    return new Promise((resolve, reject) => {
        try {
            const video = document.createElement('video');
            video.muted = true; // pas de sortie audio à l'écran
            video.playsInline = true;
            video.preload = 'auto';
            const videoUrl = URL.createObjectURL(sourceBlob);
            video.src = videoUrl;

            // Préparer chargement/décodage audio (WebAudio, pas d'élément <audio>)
            const AC = window.AudioContext || window.webkitAudioContext;
            let audioCtx = window.mrMuxAudioCtx || null, audioGain = null, audioDest = null, audioBuffer = null, audioNode = null;
            let audioUrl = null; // conservé pour cleanup si nécessaire
            const loadAudioBuffer = async () => {
                const arr = await audioFile.arrayBuffer();
                if (!audioCtx) audioCtx = new AC();
                audioGain = audioCtx.createGain();
                audioGain.gain.value = Math.max(0, Math.min(1, Number(pkg.options?.record?.audio?.volume) || 1));
                audioDest = audioCtx.createMediaStreamDestination();
                audioGain.connect(audioDest);
                audioBuffer = await audioCtx.decodeAudioData(arr);
                audioNode = audioCtx.createBufferSource();
                audioNode.buffer = audioBuffer;
                audioNode.connect(audioGain);
            };

            const fps = normalizeRecordingFps(pkg.options?.record?.fps);
            const vbps = normalizeRecordingBitrateMbps(
                Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) / 1_000_000
            ) * 1_000_000;
            const abps = Number(pkg.options?.record?.mediaRecorder?.audioBitsPerSecond) || 128000;

            // Choisir un mime compatible audio (opus)
            const pickMuxMime = () => {
                const candidates = [
                    'video/webm;codecs=vp9,opus',
                    'video/webm;codecs=vp8,opus',
                    'video/webm;codecs=opus',
                    'video/webm'
                ];
                for (const m of candidates) {
                    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch(_) {}
                }
                return '';
            };
            const muxMime = pickMuxMime();

            let rec = null; let chunks = [];
            let muxSafetyTimeout = null;

            const cleanup = () => {
                try { if (muxSafetyTimeout) clearTimeout(muxSafetyTimeout); } catch(_) {}
                try { URL.revokeObjectURL(videoUrl); } catch(_) {}
                try { if (audioUrl) URL.revokeObjectURL(audioUrl); } catch(_) {}
                try { if (audioCtx && audioCtx !== window.mrMuxAudioCtx) audioCtx.close(); } catch(_) {}
                try { if (rec && rec.state !== 'inactive') rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                try {
                    const vStream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                    if (!vStream) { cleanup(); reject(new Error('captureStream non supporté pour mux audio')); return; }

                    // Timeout de sécurité : durée vidéo + 60s de marge.
                    // ATTENTION : les .webm issus de MediaRecorder rapportent souvent
                    // video.duration === Infinity (pas de cue de durée dans l'en-tête).
                    // Infinity passé à setTimeout est converti en 0 → déclenchement immédiat
                    // → le mux échouait toujours. On retombe donc sur un délai fixe généreux
                    // si la durée n'est pas finie ; l'arrêt normal se fait sur l'évènement 'ended'.
                    const rawDur = video.duration;
                    const duration = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 0;
                    const maxMs = duration > 0 ? (duration * 1000 + 60000) : 1800000; // 30 min de garde
                    muxSafetyTimeout = setTimeout(() => {
                        muxSafetyTimeout = null;
                        cleanup();
                        reject(new Error('Timeout mux audio (' + Math.round(maxMs / 1000) + 's) : lecture bloquée ?'));
                    }, maxMs);

                    // Charger et préparer le buffer audio
                    // (pas de sortie vers destination pour rester silencieux)
                    // Utiliser des promesses pour garantir l'ordre
                    Promise.resolve()
                        .then(() => loadAudioBuffer())
                        .then(() => {
                            // Composer flux (vidéo + piste audio)
                            const videoTracks = vStream.getVideoTracks();
                            if (videoTracks.length === 0) {
                                cleanup();
                                reject(new Error('Aucune piste vidéo disponible pour le mux audio'));
                                return;
                            }
                            const composed = new MediaStream([
                                ...videoTracks,
                                ...audioDest.stream.getAudioTracks()
                            ]);

                            // Debug: vérifier présence des pistes
                            try {
                                dbgMapgl('[MUX] tracks video:', vStream.getVideoTracks().length, 'audio:', audioDest.stream.getAudioTracks().length, 'mime:', muxMime);
                            } catch(_) {}

                            const mrOpts = { videoBitsPerSecond: vbps, audioBitsPerSecond: abps };
                            if (muxMime) mrOpts.mimeType = muxMime;
                            rec = new MediaRecorder(composed, mrOpts);
                            rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                            rec.onstop = () => {
                                cleanup();
                                const outType = muxMime || 'video/webm';
                                try { resolve(new Blob(chunks, { type: outType })); } catch(e) { resolve(new Blob(chunks)); }
                            };
                            // C9 — Échec de l'encodeur pendant le mux audio : rejeter pour
                            // que l'appelant livre la vidéo sans audio (dégradation propre)
                            // au lieu de rester bloqué sur une Promise jamais résolue.
                            rec.onerror = (e) => {
                                cleanup();
                                reject(new Error('Erreur encodeur lors du mux audio : ' + (e?.error?.message || e?.message || 'inconnue')));
                            };
                            rec.start(Math.max(1000 / fps, 50));

                            // Fin: quand la vidéo se termine
                            video.addEventListener('ended', () => {
                                try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
                            });

                            // Démarrer la lecture silencieuse
                            try { audioCtx.resume().catch(()=>{}); } catch(_) {}
                            try { video.currentTime = 0; } catch(_) {}
                            try {
                                audioNode.start(0);
                            } catch(e) {
                                cleanup();
                                reject(new Error('Impossible de démarrer la piste audio : ' + e.message));
                                return;
                            }
                            video.play().catch(err => { cleanup(); reject(err); });
                        })
                        .catch((e) => { cleanup(); reject(e); });
                } catch(e) {
                    cleanup();
                    reject(e);
                }
            });

            video.addEventListener('error', (e) => {
                cleanup();
                reject(new Error('Erreur lecture vidéo pour mux audio'));
            });
        } catch(e) {
            reject(e);
        }
    });
}

// Mesure la durée réelle (en ms) d'un blob vidéo, même si l'en-tête WebM
// rapporte duration === Infinity (cas MediaRecorder). On utilise l'astuce
// du "seek vers la fin" qui force le navigateur à recalculer la vraie durée.
function getBlobDurationMs(blob){
    return new Promise((resolve) => {
        let settled = false;
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        const url = URL.createObjectURL(blob);
        const finish = (durSec) => {
            if (settled) return;
            settled = true;
            try { URL.revokeObjectURL(url); } catch(_) {}
            resolve((Number.isFinite(durSec) && durSec > 0) ? Math.round(durSec * 1000) : 0);
        };
        v.onloadedmetadata = () => {
            const d = v.duration;
            if (!Number.isFinite(d) || d <= 0) {
                // Forcer la résolution de la durée en cherchant très loin
                v.ontimeupdate = () => { v.ontimeupdate = null; finish(v.duration); };
                try { v.currentTime = 1e101; } catch(_) { finish(0); }
            } else {
                finish(d);
            }
        };
        v.onerror = () => finish(0);
        // Garde-fou si aucun évènement ne se déclenche
        setTimeout(() => finish(v.duration), 10000);
        v.src = url;
    });
}

// Réécrit l'en-tête WebM du blob final pour y inscrire la durée → les lecteurs
// affichent la durée et autorisent la navigation (seek). Renvoie le blob corrigé
// (ou l'original en cas d'échec ou de format non-WebM).
export async function fixWebmFinalDuration(blob){
    try {
        if (!blob || !/webm/i.test(blob.type || '')) return blob;
        const durMs = await getBlobDurationMs(blob);
        if (durMs > 0) {
            const fixed = await fixWebmDuration(blob, durMs, { logger: false });
            dbgMapgl('[duration-fix] durée écrite:', durMs, 'ms');
            return fixed || blob;
        }
        console.warn('[duration-fix] durée non mesurable, blob inchangé');
    } catch(e) {
        console.warn('[duration-fix] échec, blob inchangé:', e);
    }
    return blob;
}
