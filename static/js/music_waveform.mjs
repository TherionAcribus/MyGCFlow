// Mini forme d'onde de la musique, avec ce qu'en fera la vidéo : où elle est
// coupée, où commence le fondu, où la boucle reprend, où la vidéo continue sans
// son.
//
// Module pur (testé par test_music_waveform.mjs) : calcul des pics, de la
// chronologie et du tracé. Le dessin SVG est fait par ui.js.

// Nombre de pics gardés d'une piste : bien plus que de colonnes affichées,
// pour rester net quand la boucle ne montre qu'une partie de la piste.
export const WAVEFORM_PEAK_COUNT = 2000;

// Pics normalisés (0 à 1) d'une piste : le maximum absolu, tous canaux
// confondus, de chacune des `count` tranches égales. `channels` : un
// Float32Array par canal.
export function waveformPeaks(channels, count = WAVEFORM_PEAK_COUNT) {
    if (!Array.isArray(channels) || !channels.length || !(count > 0)) return [];
    const length = Math.max(...channels.map((c) => c.length));
    if (!length) return [];
    const buckets = Math.min(count, length);
    const peaks = new Array(buckets).fill(0);
    for (const data of channels) {
        for (let b = 0; b < buckets; b++) {
            const start = Math.floor((b * length) / buckets);
            const end = Math.min(data.length, Math.floor(((b + 1) * length) / buckets));
            let max = peaks[b];
            for (let i = start; i < end; i++) {
                const v = Math.abs(data[i]);
                if (v > max) max = v;
            }
            peaks[b] = max;
        }
    }
    const highest = Math.max(...peaks);
    return highest > 0 ? peaks.map((p) => Math.min(1, p / highest)) : peaks;
}

// Chronologie de la vidéo vue depuis la musique (toutes durées en ms).
//   fileMs   : durée du fichier ;  videoMs : durée de la vidéo (0 = inconnue)
//   loopMs   : longueur du motif répété, ou 0 sans boucle
//   fadeMs   : durée du fondu de sortie, ou 0
//   toleranceMs : écart en deçà duquel musique et vidéo sont de même durée
//                 (ni partie coupée, ni fin muette : même règle que le texte
//                 d'état de l'interface)
// Renvoie l'étendue affichée et ses éléments :
//   segments  : copies de la musique posées sur la chronologie
//               { startMs, endMs, sourceStartMs } — une seule sans boucle
//   loopPoints: instants où la boucle reprend au début
//   cut       : partie de la musique au-delà de la fin de la vidéo (non jouée) ;
//               son début marque la fin de la vidéo
//   silent    : fin de vidéo sans musique (musique plus courte, sans boucle)
//   fade      : fondu de sortie
export function musicTimeline({ fileMs, videoMs = 0, loopMs = 0, fadeMs = 0, toleranceMs = 0 }) {
    const empty = { spanMs: 0, segments: [], loopPoints: [], cut: null, silent: null, fade: null };
    if (!(fileMs > 0)) return empty;
    const hasVideo = videoMs > 0;
    const loop = hasVideo && loopMs > 0;
    const spanMs = loop ? videoMs : Math.max(fileMs, hasVideo ? videoMs : 0);
    const beyond = (a, b) => a - b > toleranceMs;

    const segments = [];
    const loopPoints = [];
    if (loop) {
        for (let start = 0; start < videoMs; start += loopMs) {
            if (start > 0) loopPoints.push(start);
            segments.push({ startMs: start, endMs: Math.min(start + loopMs, videoMs), sourceStartMs: 0 });
        }
    } else {
        segments.push({ startMs: 0, endMs: fileMs, sourceStartMs: 0 });
    }
    return {
        spanMs,
        segments,
        loopPoints,
        cut: hasVideo && beyond(spanMs, videoMs) ? { startMs: videoMs, endMs: spanMs } : null,
        silent: hasVideo && !loop && beyond(videoMs, fileMs) ? { startMs: fileMs, endMs: videoMs } : null,
        fade: hasVideo && fadeMs > 0 ? { startMs: Math.max(0, videoMs - fadeMs), endMs: videoMs } : null,
    };
}

// Tracé SVG (attribut `d`) de la forme d'onde sur la chronologie, symétrique
// autour de l'axe horizontal, dans un repère `width` x `height`. Une colonne
// par unité de largeur ; hors des segments (vidéo sans musique), l'onde est
// plate.
export function waveformPath(peaks, timeline, fileMs, { width = 1000, height = 100, minHeight = 1 } = {}) {
    if (!peaks?.length || !(timeline?.spanMs > 0) || !(fileMs > 0)) return '';
    const mid = height / 2;
    const amplitudes = [];
    for (let x = 0; x < width; x++) {
        const t = ((x + 0.5) / width) * timeline.spanMs;
        const segment = timeline.segments.find((s) => t >= s.startMs && t < s.endMs);
        let a = 0;
        if (segment) {
            const source = segment.sourceStartMs + (t - segment.startMs);
            const index = Math.min(peaks.length - 1, Math.floor((source / fileMs) * peaks.length));
            a = Math.max(minHeight / height, peaks[index] || 0);
        }
        amplitudes.push(a * mid);
    }
    const round = (v) => Math.round(v * 10) / 10;
    const top = amplitudes.map((a, x) => `${x === 0 ? 'M' : 'L'}${x},${round(mid - a)}`);
    const bottom = amplitudes.map((a, x) => `L${x},${round(mid + a)}`).reverse();
    return `${top.join('')}L${width},${round(mid - amplitudes[width - 1])}`
        + `L${width},${round(mid + amplitudes[width - 1])}${bottom.join('')}Z`;
}

// Position (0 à `width`) d'un instant de la chronologie.
export function timelineX(ms, timeline, width = 1000) {
    if (!(timeline?.spanMs > 0)) return 0;
    return Math.round((Math.max(0, Math.min(ms, timeline.spanMs)) / timeline.spanMs) * width * 10) / 10;
}
