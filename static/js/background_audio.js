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
import { normalizeAudioVolume } from './recording_settings.mjs';
import { includedMusicFile } from './music_track.js';

let bgAudioCtx = null, bgAudioEl = null, bgAudioSource = null, bgAudioGain = null, bgAudioActive = false;
let blockBackgroundAudioPlayback = false;
let bgAudioWatchTimer = null;
// La lecture ne part qu'une fois la piste placée sur son point de départ
// (`bgAudioBegun`) ; `bgAudioWanted` dit si elle doit jouer à ce moment-là
// (une pause a pu survenir pendant le chargement).
let bgAudioBegun = false, bgAudioWanted = false;

function playBackgroundAudio(context) {
    try { bgAudioCtx.resume().catch(()=>{}); } catch(_) {}
    bgAudioEl.play().then(()=>{ bgAudioActive = true; }).catch(e => console.warn(`${context} audio bloquée:`, e));
}

// Boucle et fondu de sortie de l'aperçu (cf. audioLoopPlan / audioFadeOutPlan
// dans ui.js). Tout se règle sur la position de lecture de la piste, qui
// avance et se met en pause avec l'animation — rien à reprogrammer à la
// reprise. Le temps écoulé depuis le début de la vidéo est la somme des tours
// de boucle déjà joués et du chemin parcouru depuis le point de départ.
// La boucle est faite ici, pas par le navigateur : la sienne reprendrait au
// début du fichier, intro comprise.
function startPlaybackWatch(volume, startS) {
    const fade = pkg.audioFadeOutPlan?.();
    const fadeIn = pkg.audioFadeInPlan?.();
    const loop = pkg.audioLoopPlan?.();
    if (!fade && !fadeIn && !loop) return;
    const loopStartS = loop ? loop.startMs / 1000 : startS;
    let playedLoopsS = 0;
    bgAudioWatchTimer = setInterval(() => {
        if (!bgAudioEl || !bgAudioGain || !bgAudioBegun) return;
        let position = bgAudioEl.currentTime;
        if (loop) {
            const loopEndS = loop.endMs ? loop.endMs / 1000 : bgAudioEl.duration;
            if (bgAudioEl.ended || (loopEndS > loopStartS && position >= loopEndS)) {
                playedLoopsS += Math.min(position, loopEndS || position) - loopStartS;
                bgAudioEl.currentTime = position = loopStartS;
                // Arrivée en fin de fichier, la piste s'est arrêtée d'elle-même.
                if (bgAudioEl.paused && bgAudioWanted) playBackgroundAudio('Boucle');
            }
        }
        // Les deux fondus se multiplient : ils ne se chevauchent que sur une
        // vidéo très courte, où clampFades les a déjà réduits.
        const elapsed = playedLoopsS + position - startS;
        const unit = (v) => Math.max(0, Math.min(1, v));
        let gain = volume;
        if (fadeIn) gain *= unit(elapsed / fadeIn.seconds);
        if (fade) gain *= unit((fade.endMs / 1000 - elapsed) / fade.seconds);
        bgAudioGain.gain.value = gain;
    }, 50);
}

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

        const file = includedMusicFile();
        if (!file) return;

        const volume = normalizeAudioVolume(pkg.options?.record?.audio?.volume);
        const AC = window.AudioContext || window.webkitAudioContext;
        bgAudioCtx = new AC();

        bgAudioEl = new Audio(URL.createObjectURL(file));
        bgAudioEl.preload = 'auto';
        // Jamais la boucle du navigateur : elle reprendrait au début du
        // fichier, intro comprise (la boucle est faite par startPlaybackWatch).
        bgAudioEl.loop = false;

        bgAudioSource = bgAudioCtx.createMediaElementSource(bgAudioEl);
        bgAudioGain = bgAudioCtx.createGain();
        // Fondu d'entrée : partir du silence, la montée suit (startPlaybackWatch).
        bgAudioGain.gain.value = pkg.audioFadeInPlan?.() ? 0 : volume;
        bgAudioSource.connect(bgAudioGain).connect(bgAudioCtx.destination);
        // Point de départ (intro sautée) : la position ne peut être posée
        // qu'une fois les métadonnées lues ; jouer avant ferait entendre un
        // éclat d'intro.
        const startS = (pkg.audioStartMs?.() || 0) / 1000;
        startPlaybackWatch(volume, startS);
        bgAudioWanted = true;
        const el = bgAudioEl;
        const begin = () => {
            if (el !== bgAudioEl) return; // arrêtée ou remplacée entre-temps
            if (startS > 0) el.currentTime = startS;
            bgAudioBegun = true;
            if (bgAudioWanted) playBackgroundAudio('Lecture');
        };
        if (startS > 0 && el.readyState < 1) el.addEventListener('loadedmetadata', begin, { once: true });
        else begin();
    } catch(e) {
        console.warn('startBackgroundMusicIfAny error:', e);
    }
}

// Pause douce : conserve l'élément, le contexte et la position de lecture pour
// que resumeBackgroundMusic reprenne exactement où la musique s'était arrêtée.
export function pauseBackgroundMusic(){
    bgAudioWanted = false;
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
        // Piste déjà finie au moment de la pause : ne pas la relancer depuis
        // zéro (une boucle, elle, la replace d'elle-même sur son départ).
        if (bgAudioEl.ended && !pkg.audioLoopPlan?.()) {
            stopBackgroundMusic();
            return;
        }
        bgAudioWanted = true;
        // Pas encore placée sur son point de départ : elle partira d'elle-même.
        if (!bgAudioBegun) return;
        playBackgroundAudio('Reprise');
    } catch(e) {
        console.warn('resumeBackgroundMusic error:', e);
    }
}

export function stopBackgroundMusic(){
    if (bgAudioWatchTimer) { clearInterval(bgAudioWatchTimer); bgAudioWatchTimer = null; }
    try { if (bgAudioEl) { bgAudioEl.pause(); URL.revokeObjectURL(bgAudioEl.src); } } catch(_) {}
    try { if (bgAudioCtx) { bgAudioCtx.close(); } } catch(_) {}
    bgAudioEl = bgAudioCtx = bgAudioSource = bgAudioGain = null;
    bgAudioActive = false;
    bgAudioBegun = bgAudioWanted = false;
}

// Bouton « Parcourir… » de l'input musique (masqué visuellement) : le
// sélecteur natif s'ouvre via click(). Le nom du fichier choisi et ses
// métadonnées sont déjà rendus par #audioFileInfo au 'change' de l'input
// (displayAudioFileInfo, ui.js) : rien d'autre à câbler ici.
const audioFileInputEl = document.getElementById('inputAudioFile');
const audioFileBrowseBtn = document.getElementById('btnAudioFileBrowse');
if (audioFileInputEl && audioFileBrowseBtn) {
    audioFileBrowseBtn.addEventListener('click', () => audioFileInputEl.click());
}
