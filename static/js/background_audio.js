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
// Tout passe par Web Audio, sur l'horloge du contexte audio : la piste
// décodée est programmée à l'échantillon près (boucle et raccords comme
// ffmpeg), le volume des fondus suit une rampe programmée, et une pause
// suspend le contexte — horloge, pistes et rampes s'arrêtent ensemble, rien
// n'est à reprogrammer à la reprise. Auparavant, un élément <audio> surveillé
// toutes les 50 ms bouclait en retard (jusqu'à une seconde en arrière-plan)
// et posait le volume des fondus par paliers.
//
// Le contexte audio « déverrouillé » par un geste utilisateur pour ce mux
// post-enregistrement est stocké sur window.mrMuxAudioCtx (voie unique, partagée
// avec ui.js qui l'initialise au clic).
import * as pkg from './index.js';
import { isRecordingActive } from './mapgl.js';
import { includedMusicFile, musicTrack } from './music_track.js';
import { gainSchedule, loopEntry, loopRepriseBuffer, playbackGain } from './music_playback.mjs';

// Écoute seule : « la fin » rejoue ces dernières secondes de la vidéo.
export const LISTEN_END_MS = 8000;

// Avance entre la programmation des pistes et leur départ sur l'horloge
// audio : une piste programmée dans le passé partirait tronquée.
const SCHEDULE_LEAD_S = 0.02;

// Une piste décodée est gardée une minute après l'arrêt : réécouter, ou
// relancer l'aperçu, repart sans redécoder. Au-delà, sa mémoire (~90 Mo pour
// 4 min en stéréo) est rendue.
const DECODED_KEEP_MS = 60_000;

// Deux étages de volume : `bgAudioGain` porte l'enveloppe des fondus,
// programmée une fois au départ ; `bgLevelGain` le volume choisi (curseur,
// niveau standard), réglable pendant la lecture (setPlaybackVolume).
let bgAudioCtx = null, bgAudioGain = null, bgLevelGain = null;

// Lissage d'un changement de volume en cours de lecture (constante de temps,
// s) : assez court pour suivre le curseur, assez long pour ne pas claquer.
const LEVEL_SMOOTHING_S = 0.03;
// Pistes programmées de la lecture en cours (fichier, reprise de boucle).
let bgSourceNodes = [];
let blockBackgroundAudioPlayback = false;
let bgAudioWatchTimer = null;
// La lecture ne part qu'une fois la piste décodée et programmée
// (`bgAudioBegun`) ; `bgAudioWanted` dit si elle doit jouer à ce moment-là
// (une pause a pu survenir pendant le décodage).
let bgAudioBegun = false, bgAudioWanted = false;
// 'preview' (aperçu de l'animation) ou 'listen' (écoute seule), null à l'arrêt.
let bgAudioMode = null;

// Dernière musique décodée ({ file, promise }) et minuteur qui l'oublie.
let decodedMusic = null;
let decodedForgetTimer = null;

// Piste décodée de `file`, à la fréquence de `sampleRate`. Décodée par un
// contexte à part : arrêter la lecture (fermer son contexte) pendant le
// décodage n'interrompt pas celui-ci, que la lecture suivante réutilise.
function decodeMusic(file, sampleRate) {
    clearTimeout(decodedForgetTimer);
    decodedForgetTimer = null;
    if (decodedMusic?.file !== file) {
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const promise = file.arrayBuffer().then((data) => new OAC(1, 1, sampleRate).decodeAudioData(data));
        decodedMusic = { file, promise };
        // Un échec n'est pas retenu : la prochaine lecture retente.
        promise.catch(() => { if (decodedMusic?.promise === promise) decodedMusic = null; });
    }
    return decodedMusic.promise;
}

function forgetDecodedMusicLater() {
    clearTimeout(decodedForgetTimer);
    decodedForgetTimer = setTimeout(() => {
        decodedMusic = null;
        decodedForgetTimer = null;
    }, DECODED_KEEP_MS);
}

function notifyPlayback(state, elapsedMs = 0) {
    document.dispatchEvent(new CustomEvent('mygcflow:music-playback', {
        detail: { state, mode: bgAudioMode, elapsedMs },
    }));
}

function playBackgroundAudio(context) {
    bgAudioCtx?.resume().catch((e) => console.warn(`${context} audio bloquée:`, e));
}

// Musiques déjà signalées illisibles pendant l'aperçu : l'avertissement n'est
// pas répété à chaque lancement de l'animation (l'écoute, demandée
// explicitement, le redonne à chaque fois).
const previewFailureNotified = new WeakSet();

// La musique ne se décode pas — ni l'original ni sa version lisible
// convertie par le serveur (cf. ensurePlayableMusic) : fichier endommagé,
// format inconnu, ou version lisible pas encore obtenue. Sans cela, l'écoute
// affichait « Arrêter » sur un silence, sans fin. La lecture est arrêtée et
// l'utilisateur prévenu.
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
        pkg.t('Cette musique ne peut pas être lue (format non pris en charge ou fichier endommagé).'),
        'warning', pkg.t('Musique'), 8000,
    );
}

// Programme la musique à l'instant `when` de l'horloge audio, depuis
// l'instant `fromMs` de la vidéo. Sans boucle, une piste : le fichier, depuis
// le point de départ. En boucle, deux pistes qui s'enchaînent à l'échantillon
// près : le reste du premier tour, lu dans le fichier, puis la reprise
// (raccord compris, cf. loopRepriseBuffer) répétée sans fin. La boucle est
// faite ici, pas par la piste du fichier : elle reprendrait au début du
// fichier, intro comprise, et sans raccord.
function scheduleSources(ctx, decoded, plan, fromMs, when) {
    const nodes = [];
    const play = (buffer, at, offsetS, { durationS, loop = false } = {}) => {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.loop = loop;
        node.connect(bgAudioGain);
        if (durationS === undefined) node.start(at, offsetS);
        else node.start(at, offsetS, durationS);
        nodes.push(node);
    };
    if (!plan.loop) {
        const offsetS = (plan.startMs + fromMs) / 1000;
        // Jusqu'au point de fin, à défaut jusqu'au bout du fichier.
        const endS = plan.endMs > 0 ? Math.min(plan.endMs / 1000, decoded.duration) : decoded.duration;
        if (offsetS < endS) play(decoded, when, offsetS, { durationS: endS - offsetS });
        return nodes;
    }
    const entry = loopEntry(fromMs, plan.loop);
    if (entry.first) {
        play(decoded, when, entry.first.sourceMs / 1000, { durationS: entry.first.durationMs / 1000 });
    }
    play(loopRepriseBuffer(ctx, decoded, plan.loop), when + entry.repriseDelayMs / 1000,
        entry.repriseOffsetMs / 1000, { loop: true });
    return nodes;
}

// Volume programmé depuis l'instant `fromMs` de la vidéo (cf. gainSchedule).
function scheduleGain(param, plan, fromMs, when) {
    const [first, ...rest] = gainSchedule(plan, fromMs);
    param.cancelScheduledValues(0);
    param.setValueAtTime(first.gain, when);
    for (const point of rest) param.linearRampToValueAtTime(point.gain, when + (point.ms - fromMs) / 1000);
}

// Lit `file` comme la vidéo l'utilisera, à partir de l'instant `fromVideoMs`
// de la vidéo.
// `stopAtVideoEnd` : l'écoute seule s'arrête d'elle-même avec la vidéo.
function startPlayback(file, { mode, fromVideoMs = 0, stopAtVideoEnd = false }) {
    stopBackgroundMusic();
    let plan = pkg.musicPlaybackPlan?.() || { startMs: 0, loop: null, fadeInMs: 0, fadeOutMs: 0, videoMs: 0, volume: 1 };
    bgAudioMode = mode;
    bgAudioWanted = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = bgAudioCtx = new AC();
    // L'enveloppe des fondus est programmée à volume plein ; le volume choisi
    // s'applique après elle, et peut changer pendant la lecture.
    const level = bgLevelGain = ctx.createGain();
    level.gain.value = plan.volume ?? 1;
    level.connect(ctx.destination);
    plan = { ...plan, volume: 1 };
    const gain = bgAudioGain = ctx.createGain();
    // Gain de l'instant de départ : 0 pour un fondu d'entrée, sans éclat.
    gain.gain.value = playbackGain(fromVideoMs, plan);
    gain.connect(level);

    // Instant de la vidéo où la musique démarre, horloge audio de ce départ,
    // et durée de musique au-delà de laquelle l'écoute n'a plus rien à jouer
    // (musique plus courte que la vidéo, sans boucle).
    let baseMs = fromVideoMs, startedAt = null, musicOverMs = Infinity;
    decodeMusic(file, ctx.sampleRate)
        .then((decoded) => {
            if (ctx !== bgAudioCtx) return; // arrêtée pendant le décodage
            const when = ctx.currentTime + SCHEDULE_LEAD_S;
            // L'aperçu rattrape le temps du décodage : l'animation, elle, n'a
            // pas attendu. L'horloge du contexte, partie de zéro avec la
            // demande et figée par une pause, mesure exactement ce retard.
            if (mode === 'preview') baseMs = fromVideoMs + when * 1000;
            bgSourceNodes = scheduleSources(ctx, decoded, plan, baseMs, when);
            scheduleGain(gain.gain, plan, baseMs, when);
            if (stopAtVideoEnd && plan.videoMs > 0) {
                const endAt = when + Math.max(0, plan.videoMs - baseMs) / 1000;
                bgSourceNodes.forEach((node) => node.stop(endAt));
            }
            if (!plan.loop) {
                const endMs = plan.endMs > 0 ? Math.min(plan.endMs, decoded.duration * 1000) : decoded.duration * 1000;
                musicOverMs = endMs - plan.startMs;
            }
            startedAt = when;
            bgAudioBegun = true;
            // Une pause a pu survenir pendant le décodage.
            if (bgAudioWanted) playBackgroundAudio('Lecture');
            else ctx.suspend().catch(() => {});
        })
        .catch((e) => {
            if (ctx === bgAudioCtx) playbackFailed(e);
        });

    // Tête de lecture et fin de l'écoute seule : rien de sonore ne dépend de
    // ce minuteur.
    bgAudioWatchTimer = setInterval(() => {
        if (ctx !== bgAudioCtx || startedAt === null) return;
        const elapsedMs = baseMs + Math.max(0, ctx.currentTime - startedAt) * 1000;
        if (stopAtVideoEnd && ((plan.videoMs > 0 && elapsedMs >= plan.videoMs) || elapsedMs >= musicOverMs)) {
            stopBackgroundMusic();
            return;
        }
        notifyPlayback('position', elapsedMs);
    }, 50);
    notifyPlayback('playing', fromVideoMs);
}

// Volume choisi modifié (curseur, niveau standard) pendant l'aperçu ou
// l'écoute : la lecture en cours le suit aussitôt, en douceur.
export function setPlaybackVolume(volume) {
    if (!bgAudioCtx || !bgLevelGain || !Number.isFinite(volume)) return;
    bgLevelGain.gain.setTargetAtTime(Math.max(0, volume), bgAudioCtx.currentTime, LEVEL_SMOOTHING_S);
}

// Volume de la lecture en cours (étage du volume choisi), null à l'arrêt.
export function playbackVolume() {
    return bgLevelGain ? bgLevelGain.gain.value : null;
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
        // Version lisible si le navigateur ne sait pas décoder l'original.
        startPlayback(musicTrack.playable(file), { mode: 'preview' });
    } catch(e) {
        console.warn('startBackgroundMusicIfAny error:', e);
    }
}

// Écoute seule de la musique choisie, telle que la vidéo l'utilisera — même
// si « Inclure la musique » est décochée. `fromEnd` : seulement les
// dernières secondes, pour juger la fin (coupure, fondu) sans attendre.
// Refusée pendant l'animation ou une capture, qui ont la main sur la musique.
// `fromVideoMs` : à partir de cet instant de la vidéo (clic sur la forme
// d'onde).
export function listenToMusic({ fromEnd = false, fromVideoMs = null } = {}) {
    const file = musicTrack.playable();
    if (!file || isRecordingActive() || pkg.isAnimationInProgress?.()) return false;
    const videoMs = pkg.musicPlaybackPlan?.().videoMs || 0;
    let from = fromEnd ? Math.max(0, videoMs - LISTEN_END_MS) : 0;
    if (Number.isFinite(fromVideoMs)) from = Math.max(0, fromVideoMs);
    startPlayback(file, {
        mode: 'listen',
        fromVideoMs: from,
        stopAtVideoEnd: true,
    });
    return true;
}

export function isListeningToMusic() {
    return bgAudioMode === 'listen';
}

// Pause douce : suspendre le contexte fige son horloge, et avec elle les
// pistes programmées et les rampes de volume ; resumeBackgroundMusic reprend
// exactement où la musique s'était arrêtée.
export function pauseBackgroundMusic(){
    bgAudioWanted = false;
    try { if (bgAudioCtx) bgAudioCtx.suspend().catch(()=>{}); } catch(_) {}
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
        bgAudioWanted = true;
        // Pas encore décodée : elle partira d'elle-même.
        if (!bgAudioBegun) return;
        playBackgroundAudio('Reprise');
    } catch(e) {
        console.warn('resumeBackgroundMusic error:', e);
    }
}

export function stopBackgroundMusic(){
    if (bgAudioWatchTimer) { clearInterval(bgAudioWatchTimer); bgAudioWatchTimer = null; }
    const wasPlaying = !!bgAudioCtx;
    for (const node of bgSourceNodes) {
        try { node.stop(); } catch(_) {}
    }
    bgSourceNodes = [];
    try { if (bgAudioCtx) bgAudioCtx.close().catch(()=>{}); } catch(_) {}
    bgAudioCtx = bgAudioGain = bgLevelGain = null;
    bgAudioBegun = bgAudioWanted = false;
    if (wasPlaying) {
        notifyPlayback('stopped');
        forgetDecodedMusicLater();
    }
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
