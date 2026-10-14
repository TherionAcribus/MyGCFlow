// Mini forme d'onde de la musique, avec ce qu'en fera la vidéo : où elle est
// coupée, où commence le fondu, où la boucle reprend, où la vidéo continue sans
// son.
//
// Module pur (testé par test_music_waveform.mjs) : calcul des pics, de la
// chronologie et du tracé. Le dessin SVG est fait par ui.js.

// Bornes des durées de fondu (secondes) : mêmes valeurs côté serveur
// (settings_manager.AUDIO_FADE_*_SECONDS).
export const FADE_LIMITS = Object.freeze({ min: 0.5, max: 30, step: 0.5 });

// Durée de fondu saisie, bornée ; `fallback` si la valeur est illisible.
export function normalizeFadeSeconds(value, fallback) {
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return fallback;
    return Math.max(FADE_LIMITS.min, Math.min(FADE_LIMITS.max, n));
}

// Fondus d'entrée et de sortie appliqués à une vidéo de `videoMs` : réduits
// dans les mêmes proportions quand, ensemble, ils dépassent la vidéo — sinon
// la musique ne remonterait jamais à son plein volume. Calcul unique, lu par
// l'aperçu, les deux exports et la forme d'onde.
export function clampFades({ videoMs, fadeInMs = 0, fadeOutMs = 0 }) {
    const fadeIn = Math.max(0, fadeInMs || 0);
    const fadeOut = Math.max(0, fadeOutMs || 0);
    const total = fadeIn + fadeOut;
    if (!(videoMs > 0) || total <= videoMs) return { fadeInMs: fadeIn, fadeOutMs: fadeOut };
    const ratio = videoMs / total;
    return { fadeInMs: fadeIn * ratio, fadeOutMs: fadeOut * ratio };
}

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
// L'axe est celui du fichier : la vidéo commence au point de départ choisi
// (`startMs`), ce qui laisse voir l'intro sautée et permet de désigner un
// instant de la musique d'un clic.
//   fileMs   : durée du fichier ;  videoMs : durée de la vidéo (0 = inconnue)
//   startMs  : point de départ dans la musique (0 = début du fichier)
//   loopMs   : longueur du motif répété (depuis le départ), ou 0 sans boucle
//   fadeMs   : durée du fondu de sortie, ou 0
//   fadeInMs : durée du fondu d'entrée, ou 0
//   toleranceMs : écart en deçà duquel musique et vidéo sont de même durée
//                 (ni partie coupée, ni fin muette : même règle que le texte
//                 d'état de l'interface)
// Renvoie l'étendue affichée et ses éléments :
//   segments  : copies de la musique posées sur la chronologie
//               { startMs, endMs, sourceStartMs } — une seule sans boucle ;
//               en boucle, la première montre aussi l'intro sautée
//   startMs   : début de la vidéo sur l'axe (le point de départ)
//   intro     : début de la musique sauté, ou null
//   loopPoints: instants où la boucle reprend au point de départ
//   cut       : partie de la musique au-delà de la fin de la vidéo (non jouée) ;
//               son début marque la fin de la vidéo
//   silent    : fin de vidéo sans musique (musique plus courte, sans boucle)
//   fade      : fondu de sortie ;  fadeIn : fondu d'entrée
export function musicTimeline({ fileMs, startMs = 0, videoMs = 0, loopMs = 0, fadeMs = 0, fadeInMs = 0, toleranceMs = 0 }) {
    const empty = {
        spanMs: 0, startMs: 0, segments: [], intro: null, loopPoints: [], cut: null, silent: null, fade: null, fadeIn: null,
    };
    if (!(fileMs > 0)) return empty;
    const start = Math.max(0, Math.min(Number(startMs) || 0, fileMs));
    const hasVideo = videoMs > 0;
    const loop = hasVideo && loopMs > 0;
    const videoEnd = start + (hasVideo ? videoMs : 0);
    const spanMs = loop ? videoEnd : Math.max(fileMs, videoEnd);
    const beyond = (a, b) => a - b > toleranceMs;

    const segments = [];
    const loopPoints = [];
    if (loop) {
        segments.push({ startMs: 0, endMs: Math.min(start + loopMs, videoEnd), sourceStartMs: 0 });
        for (let at = start + loopMs; at < videoEnd; at += loopMs) {
            loopPoints.push(at);
            segments.push({ startMs: at, endMs: Math.min(at + loopMs, videoEnd), sourceStartMs: start });
        }
    } else {
        segments.push({ startMs: 0, endMs: fileMs, sourceStartMs: 0 });
    }
    return {
        spanMs,
        startMs: start,
        segments,
        intro: start > 0 ? { startMs: 0, endMs: start } : null,
        loopPoints,
        cut: hasVideo && beyond(spanMs, videoEnd) ? { startMs: videoEnd, endMs: spanMs } : null,
        silent: hasVideo && !loop && beyond(videoEnd, fileMs) ? { startMs: fileMs, endMs: videoEnd } : null,
        fade: hasVideo && fadeMs > 0 ? { startMs: Math.max(start, videoEnd - fadeMs), endMs: videoEnd } : null,
        fadeIn: hasVideo && fadeInMs > 0 ? { startMs: start, endMs: Math.min(videoEnd, start + fadeInMs) } : null,
    };
}

// Position dans le fichier de la musique entendue à l'instant `ms` de la
// chronologie (une reprise de boucle renvoie dans le motif), ou null là où la
// vidéo n'a pas de musique.
export function sourceMsAt(ms, timeline) {
    const segment = timeline?.segments?.find((s) => ms >= s.startMs && ms < s.endMs);
    return segment ? segment.sourceStartMs + (ms - segment.startMs) : null;
}

// Instant de la chronologie sous une position (0 à `width`) : l'inverse de
// timelineX, pour choisir le point de départ d'un clic.
export function timelineMsAt(x, timeline, width = 1000) {
    if (!(timeline?.spanMs > 0) || !(width > 0)) return 0;
    return Math.max(0, Math.min(1, x / width)) * timeline.spanMs;
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
