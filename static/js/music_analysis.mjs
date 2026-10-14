// Analyse d'une musique choisie : un seul décodage de la piste, dont on tire
// sa durée exacte, son blanc de fin, sa forme d'onde et son niveau sonore.
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
        ...loudnessStats(channels, sampleRate),
    };
}

// --- Harmonisation du volume ------------------------------------------------
//
// Un gain fixe par morceau, calculé ici et appliqué à l'identique par
// l'aperçu, l'écoute et les deux exports (passé à ffmpeg comme volume) : ce
// qu'on entend est ce que la vidéo contiendra. Le filtre loudnorm de ffmpeg
// aurait ajusté le niveau en continu, à l'export seulement.

// Niveau visé (dBFS, moyenne quadratique des passages audibles) : celui d'une
// musique mastérisée sans excès.
export const LOUDNESS_TARGET_DB = -16;
// Tranches de mesure et seuil sous lequel une tranche compte comme silence
// (ne pas laisser une intro ou un blanc tirer le niveau vers le bas : même
// principe que le « gating » de la mesure LUFS).
const LOUDNESS_BLOCK_MS = 400;
const LOUDNESS_GATE_DB = -50;
// Marge sous la crête : la piste analysée est rééchantillonnée, sa crête
// mesurée peut être un peu sous la vraie.
const PEAK_CEILING = 0.9;
// Bornes du gain d'harmonisation (environ ±20 dB).
const NORMALIZE_GAIN_RANGE = [0.1, 10];

const toDb = (v) => 20 * Math.log10(v);

// Niveau des passages audibles (`loudnessDb`, dBFS) et crête (`peak`, 0 à 1)
// d'une piste. null pour une piste muette.
export function loudnessStats(channels, sampleRate) {
    const empty = { loudnessDb: null, peak: 0 };
    if (!Array.isArray(channels) || !channels.length || !(sampleRate > 0)) return empty;
    const length = Math.max(...channels.map((c) => c.length));
    const block = Math.max(1, Math.round((LOUDNESS_BLOCK_MS / 1000) * sampleRate));
    const gate = Math.pow(10, LOUDNESS_GATE_DB / 10); // en puissance
    let peak = 0, kept = 0, sum = 0;
    for (let start = 0; start < length; start += block) {
        const end = Math.min(length, start + block);
        let power = 0;
        for (const data of channels) {
            for (let i = start; i < end && i < data.length; i++) {
                const v = data[i];
                power += v * v;
                const a = Math.abs(v);
                if (a > peak) peak = a;
            }
        }
        power /= (end - start) * channels.length;
        if (power > gate) { sum += power; kept++; }
    }
    if (!kept) return { loudnessDb: null, peak };
    return { loudnessDb: 10 * Math.log10(sum / kept), peak };
}

// Gain qui amène le niveau mesuré vers LOUDNESS_TARGET_DB, sans que la crête
// ne dépasse PEAK_CEILING (pas de saturation : un morceau calme mais à crêtes
// fortes est moins relevé). 1 si la mesure manque.
export function normalizationGain({ loudnessDb, peak } = {}) {
    if (!Number.isFinite(loudnessDb) || !(peak > 0)) return 1;
    const wanted = Math.pow(10, (LOUDNESS_TARGET_DB - loudnessDb) / 20);
    const [min, max] = NORMALIZE_GAIN_RANGE;
    return Math.max(min, Math.min(max, wanted, PEAK_CEILING / peak));
}

// Le gain en décibels, pour l'affichage.
export function gainDb(gain) {
    return gain > 0 ? toDb(gain) : 0;
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
