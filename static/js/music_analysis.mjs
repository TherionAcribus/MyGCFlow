// Analyse d'une musique choisie : un seul décodage de la piste, dont on tire
// sa durée exacte, son blanc de fin et sa forme d'onde.
//
// La durée lue dans les métadonnées (élément <audio>) n'est qu'une estimation
// pour un MP3 à débit variable sans en-tête Xing : jusqu'à plusieurs secondes
// d'écart, alors que c'est elle qui fixe la durée d'une vidéo calée sur la
// musique. La piste décodée, elle, a sa longueur réelle.

import { trailingSilenceMs } from './audio_silence.mjs';
import { waveformPeaks } from './music_waveform.mjs';

// Fréquence de décodage : bien assez pour mesurer un niveau, et divise par
// trois la mémoire d'un morceau décodé à 48 kHz. Le rééchantillonnage ne
// change pas la durée.
const ANALYSIS_SAMPLE_RATE = 16000;

// Résultat pur, à partir des canaux décodés (testé par test_music_waveform.mjs).
export function analyzeChannels(channels, sampleRate) {
    const length = channels.length ? Math.max(...channels.map((c) => c.length)) : 0;
    return {
        durationMs: sampleRate > 0 ? (length / sampleRate) * 1000 : 0,
        trailingSilenceMs: trailingSilenceMs(channels, sampleRate),
        peaks: waveformPeaks(channels),
    };
}

// Décode `file` et l'analyse. Rejette si le navigateur ne sait pas décoder le
// format : l'appelant se replie alors sur la durée des métadonnées.
export async function analyzeMusicFile(file) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('OfflineAudioContext indisponible');
    const data = await file.arrayBuffer();
    // decodeAudioData rééchantillonne à la fréquence du contexte.
    const ctx = new OAC(1, 1, ANALYSIS_SAMPLE_RATE);
    const buffer = await ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return analyzeChannels(channels, buffer.sampleRate);
}
