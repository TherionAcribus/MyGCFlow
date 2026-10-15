// Musique jouée à l'écran : pendant l'aperçu de l'animation, et seule via le
// bouton « Écouter » du sous-onglet Musique.
//
// Extrait de mapgl.js. Concerne uniquement la lecture « à l'écran » : pendant un
// enregistrement la piste n'est pas jouée mais muxée après coup dans la vidéo
// (cf. muxRecordedVideoWithAudio dans video_postprocess.js).
//
// Les deux lectures appliquent le même plan (musicPlaybackPlan, ui.js) : on
// entend à l'écoute ce que la vidéo contiendra. Leur état est diffusé par
// l'évènement `mygcflow:music-playback` sur document (detail : state
// 'playing' | 'position' | 'stopped', mode, elapsedMs) — la forme d'onde y
// pose sa tête de lecture.
//
// Le contexte audio « déverrouillé » par un geste utilisateur pour ce mux
// post-enregistrement est stocké sur window.mrMuxAudioCtx (voie unique, partagée
// avec ui.js qui l'initialise au clic).
import * as pkg from './index.js';
import { isRecordingActive } from './mapgl.js';
import { includedMusicFile, musicTrack } from './music_track.js';
import {
    crossfadedLoopBuffer, crossfadedLoopOffsetMs, playbackGain, sourcePositionAt,
} from './music_playback.mjs';

// Écoute seule : « la fin » rejoue ces dernières secondes de la vidéo.
export const LISTEN_END_MS = 8000;

let bgAudioCtx = null, bgAudioEl = null, bgAudioSource = null, bgAudioGain = null, bgAudioActive = false;
let blockBackgroundAudioPlayback = false;
let bgAudioWatchTimer = null;
// La lecture ne part qu'une fois la piste placée sur sa position de départ
// (`bgAudioBegun`) ; `bgAudioWanted` dit si elle doit jouer à ce moment-là
// (une pause a pu survenir pendant le chargement).
let bgAudioBegun = false, bgAudioWanted = false;
// 'preview' (aperçu de l'animation) ou 'listen' (écoute seule), null à l'arrêt.
let bgAudioMode = null;

function notifyPlayback(state, elapsedMs = 0) {
    document.dispatchEvent(new CustomEvent('mygcflow:music-playback', {
        detail: { state, mode: bgAudioMode, elapsedMs },
    }));
}

function playBackgroundAudio(context) {
    try { bgAudioCtx.resume().catch(()=>{}); } catch(_) {}
    // Lecture par piste construite (raccord fondu) : reprendre le contexte suffit.
    if (!bgAudioEl) { bgAudioActive = true; return; }
    const el = bgAudioEl;
    el.play().then(()=>{ bgAudioActive = true; }).catch((e) => {
        console.warn(`${context} audio bloquée:`, e);
        // Lecture refusée par la politique d'autoplay : rien à signaler, un
        // prochain geste la débloquera. Toute autre erreur : piste illisible.
        if (e?.name !== 'NotAllowedError' && el === bgAudioEl) playbackFailed(e);
    });
}

// Musiques déjà signalées illisibles pendant l'aperçu : l'avertissement n'est
// pas répété à chaque lancement de l'animation (l'écoute, demandée
// explicitement, le redonne à chaque fois).
const previewFailureNotified = new WeakSet();

// Le navigateur ne sait pas lire la musique (format non pris en charge — .wma,
// .aiff… — ou fichier endommagé). Sans cela, l'écoute affichait « Arrêter »
// sur un silence, sans fin. La lecture est arrêtée et l'utilisateur prévenu :
// l'export, lui, passe par ffmpeg, qui lit bien plus de formats.
function playbackFailed(error) {
    if (!bgAudioMode) return; // déjà arrêtée
    console.warn('Musique illisible par le navigateur:', error);
    const mode = bgAudioMode;
    const file = musicTrack.file();
    stopBackgroundMusic();
    if (mode === 'preview') {
        if (!file || previewFailureNotified.has(file)) return;
        previewFailureNotified.add(file);
    }
    pkg.showToast?.(
        pkg.t('Le navigateur ne sait pas lire cette musique : elle ne peut pas être écoutée ici. L\'export vidéo, qui passe par ffmpeg, peut tout de même l\'intégrer.'),
        'warning', pkg.t('Musique'), 8000,
    );
}

// Reprises en fondu enchaîné : un élément <audio> ne peut pas se superposer à
// lui-même. La piste est alors décodée et construite avec ses raccords
// (crossfadedLoopBuffer, même forme que ffmpeg), puis lue en boucle par Web
// Audio. Le temps écoulé suit l'horloge du contexte, qui s'arrête quand la
// pause le suspend.
let bgBufferNode = null;

function startBufferPlayback(file, plan, { fromVideoMs, stopAtVideoEnd }) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = bgAudioCtx = new AC();
    bgAudioGain = ctx.createGain();
    bgAudioGain.gain.value = playbackGain(fromVideoMs, plan);
    bgAudioGain.connect(ctx.destination);
    let startedAt = null; // horloge du contexte au départ de la piste
    file.arrayBuffer()
        .then((data) => ctx.decodeAudioData(data))
        .then((decoded) => {
            if (ctx !== bgAudioCtx) return; // arrêtée pendant le décodage
            const joined = crossfadedLoopBuffer(ctx, decoded, plan.loop);
            const node = bgBufferNode = ctx.createBufferSource();
            node.buffer = joined.buffer;
            node.loop = true;
            node.loopStart = joined.loopStartSeconds;
            node.loopEnd = joined.buffer.duration;
            node.connect(bgAudioGain);
            node.start(0, crossfadedLoopOffsetMs(fromVideoMs, plan.loop) / 1000);
            startedAt = ctx.currentTime;
            bgAudioBegun = true;
            // Une pause a pu survenir pendant le décodage.
            if (bgAudioWanted) playBackgroundAudio('Lecture');
            else ctx.suspend().catch(()=>{});
        })
        .catch((e) => {
            if (ctx === bgAudioCtx) playbackFailed(e);
        });
    const videoS = plan.videoMs / 1000;
    bgAudioWatchTimer = setInterval(() => {
        if (ctx !== bgAudioCtx || startedAt === null) return;
        const elapsedS = fromVideoMs / 1000 + (ctx.currentTime - startedAt);
        if (stopAtVideoEnd && videoS > 0 && elapsedS >= videoS) {
            stopBackgroundMusic();
            return;
        }
        bgAudioGain.gain.value = playbackGain(elapsedS * 1000, plan);
        notifyPlayback('position', elapsedS * 1000);
    }, 50);
}

// Lit `file` comme la vidéo l'utilisera, à partir de l'instant `fromVideoMs`
// de la vidéo. Boucle et fondus se règlent sur la position de lecture de la
// piste, qui avance et se met en pause avec l'animation — rien à reprogrammer
// à la reprise. Le temps écoulé depuis le début de la vidéo est la somme des
// tours de boucle déjà joués et du chemin parcouru depuis la position de
// départ. La boucle est faite ici, pas par le navigateur : la sienne
// reprendrait au début du fichier, intro comprise.
// `stopAtVideoEnd` : l'écoute seule s'arrête d'elle-même avec la vidéo.
function startPlayback(file, { mode, fromVideoMs = 0, stopAtVideoEnd = false }) {
    stopBackgroundMusic();
    const plan = pkg.musicPlaybackPlan?.() || { startMs: 0, loop: null, fadeInMs: 0, fadeOutMs: 0, videoMs: 0, volume: 1 };
    bgAudioMode = mode;
    bgAudioWanted = true;
    if (plan.loop?.crossfadeMs > 0) {
        startBufferPlayback(file, plan, { fromVideoMs, stopAtVideoEnd });
        notifyPlayback('playing', fromVideoMs);
        return;
    }
    const { sourceMs, playedLoopsMs } = sourcePositionAt(fromVideoMs, plan);
    const loop = plan.loop;
    const AC = window.AudioContext || window.webkitAudioContext;
    bgAudioCtx = new AC();
    bgAudioEl = new Audio(URL.createObjectURL(file));
    bgAudioEl.preload = 'auto';
    bgAudioEl.loop = false;
    bgAudioSource = bgAudioCtx.createMediaElementSource(bgAudioEl);
    bgAudioGain = bgAudioCtx.createGain();
    // Gain de l'instant de départ : 0 pour un fondu d'entrée, sans éclat.
    bgAudioGain.gain.value = playbackGain(fromVideoMs, plan);
    bgAudioSource.connect(bgAudioGain).connect(bgAudioCtx.destination);
    // Source illisible : signalée par l'élément dès le chargement, avant même
    // la lecture (cf. playbackFailed).
    const failedEl = bgAudioEl;
    failedEl.addEventListener('error', () => {
        if (failedEl === bgAudioEl) playbackFailed(failedEl.error);
    }, { once: true });

    let playedLoopsS = playedLoopsMs / 1000;
    const startS = plan.startMs / 1000;
    const loopStartS = loop ? loop.startMs / 1000 : startS;
    const loopEndS = loop ? loop.endMs / 1000 : 0;
    const videoS = plan.videoMs / 1000;
    bgAudioWatchTimer = setInterval(() => {
        if (!bgAudioEl || !bgAudioGain || !bgAudioBegun) return;
        let position = bgAudioEl.currentTime;
        if (loop && (bgAudioEl.ended || position >= loopEndS)) {
            playedLoopsS += Math.min(position, loopEndS) - loopStartS;
            bgAudioEl.currentTime = position = loopStartS;
            // Arrivée en fin de fichier, la piste s'est arrêtée d'elle-même.
            if (bgAudioEl.paused && bgAudioWanted) playBackgroundAudio('Boucle');
        }
        const elapsedS = playedLoopsS + position - startS;
        if (stopAtVideoEnd && ((videoS > 0 && elapsedS >= videoS) || (!loop && bgAudioEl.ended))) {
            stopBackgroundMusic();
            return;
        }
        bgAudioGain.gain.value = playbackGain(elapsedS * 1000, plan);
        notifyPlayback('position', elapsedS * 1000);
    }, 50);

    // Position de départ (intro sautée, ou fin de vidéo pour l'écoute) : elle
    // ne peut être posée qu'une fois les métadonnées lues ; jouer avant ferait
    // entendre un éclat du début du fichier.
    const el = bgAudioEl;
    const begin = () => {
        if (el !== bgAudioEl) return; // arrêtée ou remplacée entre-temps
        if (sourceMs > 0) el.currentTime = sourceMs / 1000;
        bgAudioBegun = true;
        if (bgAudioWanted) playBackgroundAudio('Lecture');
    };
    if (sourceMs > 0 && el.readyState < 1) el.addEventListener('loadedmetadata', begin, { once: true });
    else begin();
    notifyPlayback('playing', fromVideoMs);
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
        // sans passage par resumeBackgroundMusic, ou écoute en cours) pour ne
        // pas fuiter de contexte.
        stopBackgroundMusic();
        const file = includedMusicFile();
        if (!file) return;
        startPlayback(file, { mode: 'preview' });
    } catch(e) {
        console.warn('startBackgroundMusicIfAny error:', e);
    }
}

// Écoute seule de la musique choisie, telle que la vidéo l'utilisera — même
// si « Inclure la musique » est décochée. `fromEnd` : seulement les
// dernières secondes, pour juger la fin (coupure, fondu) sans attendre.
// Refusée pendant l'animation ou une capture, qui ont la main sur la musique.
export function listenToMusic({ fromEnd = false } = {}) {
    const file = musicTrack.file();
    if (!file || isRecordingActive() || pkg.isAnimationInProgress?.()) return false;
    const videoMs = pkg.musicPlaybackPlan?.().videoMs || 0;
    startPlayback(file, {
        mode: 'listen',
        fromVideoMs: fromEnd ? Math.max(0, videoMs - LISTEN_END_MS) : 0,
        stopAtVideoEnd: true,
    });
    return true;
}

export function isListeningToMusic() {
    return bgAudioMode === 'listen';
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
        if (!bgAudioCtx) {
            startBackgroundMusicIfAny();
            return;
        }
        // Piste déjà finie au moment de la pause : ne pas la relancer depuis
        // zéro (une boucle, elle, la replace d'elle-même sur son départ).
        if (bgAudioEl?.ended && !pkg.musicPlaybackPlan?.().loop) {
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
    const wasPlaying = !!bgAudioCtx;
    try { if (bgBufferNode) bgBufferNode.stop(); } catch(_) {}
    bgBufferNode = null;
    try { if (bgAudioEl) { bgAudioEl.pause(); URL.revokeObjectURL(bgAudioEl.src); } } catch(_) {}
    try { if (bgAudioCtx) { bgAudioCtx.close(); } } catch(_) {}
    bgAudioEl = bgAudioCtx = bgAudioSource = bgAudioGain = null;
    bgAudioActive = false;
    bgAudioBegun = bgAudioWanted = false;
    if (wasPlaying) notifyPlayback('stopped');
    bgAudioMode = null;
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
