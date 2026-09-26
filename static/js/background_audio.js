// Musique de fond jouée pendant la prévisualisation de l'animation.
//
// Extrait de mapgl.js. Concerne uniquement la lecture « à l'écran » : pendant un
// enregistrement la piste n'est pas jouée mais muxée après coup dans la vidéo
// (cf. muxRecordedVideoWithAudio dans video_postprocess.js).
//
// Le contexte audio « déverrouillé » par un geste utilisateur pour ce mux
// post-enregistrement est stocké sur window.mrMuxAudioCtx (voie unique, partagée
// avec ui.js qui l'initialise au clic).
import * as pkg from './index.js';
import { isRecordingActive } from './mapgl.js';

let bgAudioCtx = null, bgAudioEl = null, bgAudioSource = null, bgAudioGain = null, bgAudioActive = false;
let blockBackgroundAudioPlayback = false;

// Posé par les pipelines d'enregistrement : la musique ne doit pas démarrer
// pendant une capture, même si l'animation est (re)lancée en interne.
export function setBackgroundAudioBlocked(blocked) {
    blockBackgroundAudioPlayback = !!blocked;
}

export function startBackgroundMusicIfAny(){
    try {
        // Ne pas jouer pendant l'enregistrement ni si bloqué explicitement
        if (isRecordingActive()) return;
        if (blockBackgroundAudioPlayback) return;

        // Nettoyer une éventuelle instance précédente (ex. relance après pause
        // sans passage par resumeBackgroundMusic) pour ne pas fuiter de contexte.
        stopBackgroundMusic();

        const enabled = !!(pkg.options?.record?.audio?.enabled);
        if (!enabled) return;

        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        if (!file) return;

        const volume = Number(pkg.options?.record?.audio?.volume) || 1;
        const AC = window.AudioContext || window.webkitAudioContext;
        bgAudioCtx = new AC();

        bgAudioEl = new Audio(URL.createObjectURL(file));
        bgAudioEl.preload = 'auto';
        // Lecture unique : le son ne doit pas se relancer automatiquement en fin de piste
        bgAudioEl.loop = false;

        bgAudioSource = bgAudioCtx.createMediaElementSource(bgAudioEl);
        bgAudioGain = bgAudioCtx.createGain();
        bgAudioGain.gain.value = Math.max(0, Math.min(1, volume));
        bgAudioSource.connect(bgAudioGain).connect(bgAudioCtx.destination);

        try { bgAudioCtx.resume().catch(()=>{}); } catch(_) {}
        bgAudioEl.play().then(()=>{ bgAudioActive = true; }).catch(e => console.warn('Lecture audio bloquée:', e));
    } catch(e) {
        console.warn('startBackgroundMusicIfAny error:', e);
    }
}

// Pause douce : conserve l'élément, le contexte et la position de lecture pour
// que resumeBackgroundMusic reprenne exactement où la musique s'était arrêtée.
export function pauseBackgroundMusic(){
    try { if (bgAudioEl) bgAudioEl.pause(); } catch(_) {}
    try { if (bgAudioCtx) bgAudioCtx.suspend().catch(()=>{}); } catch(_) {}
    bgAudioActive = false;
}

// Reprend la piste en pause à sa position courante. Si rien n'était en pause
// (ex. reprise sans musique démarrée), tente un démarrage normal.
export function resumeBackgroundMusic(){
    try {
        if (isRecordingActive() || blockBackgroundAudioPlayback) {
            stopBackgroundMusic();
            return;
        }
        if (!bgAudioEl || !bgAudioCtx) {
            startBackgroundMusicIfAny();
            return;
        }
        // Piste déjà finie au moment de la pause : ne pas la relancer depuis zéro
        if (bgAudioEl.ended) {
            stopBackgroundMusic();
            return;
        }
        try { bgAudioCtx.resume().catch(()=>{}); } catch(_) {}
        bgAudioEl.play().then(()=>{ bgAudioActive = true; }).catch(e => console.warn('Reprise audio bloquée:', e));
    } catch(e) {
        console.warn('resumeBackgroundMusic error:', e);
    }
}

export function stopBackgroundMusic(){
    try { if (bgAudioEl) { bgAudioEl.pause(); URL.revokeObjectURL(bgAudioEl.src); } } catch(_) {}
    try { if (bgAudioCtx) { bgAudioCtx.close(); } } catch(_) {}
    bgAudioEl = bgAudioCtx = bgAudioSource = bgAudioGain = null;
    bgAudioActive = false;
}
