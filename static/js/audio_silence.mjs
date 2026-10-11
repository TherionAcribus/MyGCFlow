// Détection du blanc de fin d'une piste audio.
//
// Beaucoup de fichiers de musique se terminent par quelques secondes de
// silence : une vidéo calée sur leur durée brute finit alors sans son. La
// partie calcul est pure (testée par test_audio_silence.mjs) ; seule
// detectTrailingSilenceMs touche aux API du navigateur.

// En dessous de ce niveau (dBFS, crête) un échantillon compte comme du silence.
export const SILENCE_THRESHOLD_DB = -50;
// Un blanc plus court n'est pas signalé : c'est la fin normale d'un morceau.
export const MIN_TRAILING_SILENCE_MS = 1000;
// Marge conservée après le dernier son audible, pour ne pas couper net la
// queue d'une réverbération passée juste sous le seuil.
export const SILENCE_TAIL_MARGIN_MS = 300;

// Fréquence de décodage : bien assez pour mesurer un niveau, et divise par
// trois la mémoire d'un morceau décodé à 48 kHz.
const ANALYSIS_SAMPLE_RATE = 16000;

// Durée (ms) du silence qui termine la piste. `channels` : un Float32Array par
// canal. Une piste entièrement silencieuse renvoie sa durée complète.
export function trailingSilenceMs(channels, sampleRate, thresholdDb = SILENCE_THRESHOLD_DB) {
    if (!Array.isArray(channels) || channels.length === 0 || !(sampleRate > 0)) return 0;
    const threshold = Math.pow(10, thresholdDb / 20);
    const length = Math.max(...channels.map(c => c.length));
    let lastAudible = -1;
    for (const data of channels) {
        // Inutile de redescendre sous le dernier son déjà trouvé sur un autre canal.
        for (let i = data.length - 1; i > lastAudible; i--) {
            if (Math.abs(data[i]) > threshold) { lastAudible = i; break; }
        }
    }
    return ((length - 1 - lastAudible) / sampleRate) * 1000;
}

// Vrai quand le blanc mérite d'être signalé à l'utilisateur.
export function hasNotableTrailingSilence(silenceMs) {
    return Number.isFinite(silenceMs) && silenceMs >= MIN_TRAILING_SILENCE_MS;
}

// Durée utile de la musique une fois le blanc de fin retiré (marge comprise).
export function trimmedDurationMs(durationMs, silenceMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return durationMs;
    if (!hasNotableTrailingSilence(silenceMs)) return durationMs;
    const trimmed = durationMs - silenceMs + SILENCE_TAIL_MARGIN_MS;
    // Piste entièrement silencieuse : rien d'utile à garder, ne pas rogner.
    if (silenceMs >= durationMs || trimmed <= 0) return durationMs;
    return Math.min(durationMs, trimmed);
}

// Décode le fichier et mesure son blanc de fin (ms). Rejette si le navigateur
// ne sait pas décoder le format : l'appelant considère alors qu'il n'y en a pas.
export async function detectTrailingSilenceMs(file) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('OfflineAudioContext indisponible');
    const data = await file.arrayBuffer();
    // decodeAudioData rééchantillonne à la fréquence du contexte.
    const ctx = new OAC(1, 1, ANALYSIS_SAMPLE_RATE);
    const buffer = await ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return trailingSilenceMs(channels, buffer.sampleRate);
}
