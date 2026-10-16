// Lecture de la musique telle que la vidéo l'utilisera — calculs purs (testés
// par test_music_playback.mjs), partagés par l'aperçu de l'animation et le
// bouton « Écouter » (background_audio.js).
//
// `plan` (cf. musicPlaybackPlan dans ui.js), durées en ms :
//   startMs   : point de départ dans le fichier (intro sautée)
//   loop      : { startMs, endMs, crossfadeMs } — motif répété, positions dans
//               le fichier, et raccord fondu entre les reprises (0 = net) — ou null
//   endMs     : point de fin dans le fichier (la musique s'y arrête), ou 0
//   fadeInMs, fadeOutMs : fondus, déjà bornés à la musique jouée (clampFades)
//   fadeOutEndMs : instant de la vidéo où finit le fondu de sortie — là où la
//               musique s'arrête —, à défaut la fin de la vidéo
//   videoMs   : durée de la vidéo (0 = inconnue)
//   volume    : gain plein (0 à 1)

// Part maximale du motif que peut occuper un raccord fondu. ffmpeg exige un
// motif plus long que deux raccords (capture._audio_filter_graph) : 40 % laisse
// de la marge, et un raccord trop long est raccourci plutôt qu'abandonné.
const MAX_CROSSFADE_SHARE = 0.4;

// Raccord appliqué à chaque reprise de boucle quand aucun fondu n'est demandé :
// une coupe nette tombe sur un échantillon quelconque et s'entend comme un
// « clic ». 10 ms suffisent à l'effacer sans qu'on perçoive un fondu. Passe
// par le même chemin qu'un raccord demandé (ffmpeg, aperçu, repli navigateur).
export const LOOP_JOIN_MS = 10;

// Durée effective du raccord fondu d'un motif de `motifMs`.
export function loopCrossfadeMs(motifMs, wantedMs) {
    if (!(motifMs > 0) || !(wantedMs > 0)) return 0;
    return Math.min(wantedMs, motifMs * MAX_CROSSFADE_SHARE);
}

// Durée entre deux reprises de la boucle : le motif, moins le raccord fondu
// où la reprise chevauche la fin du tour précédent.
export function loopPeriodMs(loop) {
    if (!loop) return 0;
    return (loop.endMs - loop.startMs) - (loop.crossfadeMs || 0);
}

// Reprise de la boucle — même construction que ffmpeg
// (capture._audio_filter_graph), échantillon par échantillon :
//     (motif[m-c, m] qui s'efface + motif[0, c] qui monte) + motif[c, m-c]
// Elle dure m - c et s'enchaîne à elle-même ; le premier tour, motif[0, m-c],
// se lit tel quel dans le fichier. Courbes en quart de sinus, à puissance
// constante, comme afade:curve=qsin. `channels` : canaux décodés du fichier
// entier ; startMs/endMs : le motif ; crossfadeMs : le raccord (cf.
// loopCrossfadeMs). Renvoie aussi la position du motif et la longueur de
// la reprise, en échantillons.
export function loopRepriseChannels(channels, sampleRate, { startMs, endMs, crossfadeMs }) {
    const at = (ms) => Math.round((ms / 1000) * sampleRate);
    const motifStart = at(startMs);
    const m = at(endMs) - motifStart;
    const c = at(crossfadeMs || 0);
    const period = m - c;
    const out = channels.map((data) => {
        const motif = data.subarray(motifStart, motifStart + m);
        const reprise = new Float32Array(period);
        for (let i = 0; i < c; i++) {
            const x = (i + 0.5) / c;
            reprise[i] = motif[period + i] * Math.cos((Math.PI / 2) * x)
                + motif[i] * Math.sin((Math.PI / 2) * x);
        }
        reprise.set(motif.subarray(c, period), c);
        return reprise;
    });
    return { channels: out, motifStart, period };
}

// Piste complète prête à boucler : le premier tour puis la reprise (cf.
// loopRepriseChannels) — boucler de `loopStartSeconds` à la fin. Lue d'un
// seul nœud par le repli navigateur de l'export (video_postprocess.js).
export function crossfadedLoopChannels(channels, sampleRate, loop) {
    const { channels: reprises, motifStart, period } = loopRepriseChannels(channels, sampleRate, loop);
    const out = channels.map((data, index) => {
        const result = new Float32Array(2 * period);
        result.set(data.subarray(motifStart, motifStart + period), 0);
        result.set(reprises[index], period);
        return result;
    });
    return { channels: out, loopStartSeconds: period / sampleRate };
}

// Version navigateur : piste à raccord fondu, en AudioBuffer prêt à boucler
// (de `loopStartSeconds` à la fin), à partir du fichier décodé.
export function crossfadedLoopBuffer(ctx, decoded, loop) {
    const source = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) source.push(decoded.getChannelData(c));
    const built = crossfadedLoopChannels(source, decoded.sampleRate, loop);
    const buffer = ctx.createBuffer(built.channels.length, built.channels[0].length, decoded.sampleRate);
    built.channels.forEach((data, c) => buffer.copyToChannel(data, c));
    return { buffer, loopStartSeconds: built.loopStartSeconds };
}

// Version navigateur de loopRepriseChannels : la reprise en AudioBuffer, à
// lire en boucle sur toute sa longueur.
export function loopRepriseBuffer(ctx, decoded, loop) {
    const source = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) source.push(decoded.getChannelData(c));
    const built = loopRepriseChannels(source, decoded.sampleRate, loop);
    const buffer = ctx.createBuffer(built.channels.length, built.period, decoded.sampleRate);
    built.channels.forEach((data, c) => buffer.copyToChannel(data, c));
    return buffer;
}

// Entrée dans une boucle à l'instant `videoMs` de la vidéo : ce qui reste du
// premier tour (`first`, lu dans le fichier à partir de `sourceMs`, pendant
// `durationMs`, ou null s'il est passé), puis la reprise répétée, qui démarre
// `repriseDelayMs` plus tard, à `repriseOffsetMs` de son début.
export function loopEntry(videoMs, loop) {
    const periodMs = loopPeriodMs(loop);
    const t = Math.max(0, videoMs || 0);
    if (t < periodMs) {
        return {
            first: { sourceMs: loop.startMs + t, durationMs: periodMs - t },
            repriseDelayMs: periodMs - t,
            repriseOffsetMs: 0,
        };
    }
    return { first: null, repriseDelayMs: 0, repriseOffsetMs: periodMs > 0 ? (t - periodMs) % periodMs : 0 };
}

// Gain à l'instant `elapsedMs` de la vidéo : volume plein, multiplié par les
// fondus d'entrée et de sortie. Ils ne se chevauchent que sur une vidéo très
// courte, où clampFades les a réduits.
export function playbackGain(elapsedMs, plan) {
    const unit = (v) => Math.max(0, Math.min(1, v));
    let gain = plan?.volume ?? 1;
    if (plan?.fadeInMs > 0) gain *= unit(elapsedMs / plan.fadeInMs);
    const fadeOutEnd = fadeOutEndMs(plan);
    if (plan?.fadeOutMs > 0 && fadeOutEnd > 0) gain *= unit((fadeOutEnd - elapsedMs) / plan.fadeOutMs);
    return gain;
}

// Fin du fondu de sortie (ms de vidéo) : là où la musique s'arrête, à défaut
// la fin de la vidéo ; 0 si aucune n'est connue.
function fadeOutEndMs(plan) {
    if (plan?.fadeOutEndMs > 0) return plan.fadeOutEndMs;
    return plan?.videoMs > 0 ? plan.videoMs : 0;
}

// Nombre de paliers d'une portion où les deux fondus se chevauchent (vidéo
// très courte) : leur produit n'y est plus linéaire.
const OVERLAP_STEPS = 16;

// Volume de la lecture à programmer dès l'instant `fromMs` de la vidéo : les
// points { ms, gain } entre lesquels il varie linéairement (playbackGain aux
// bornes des fondus). Le navigateur les suit à l'échantillon près sur
// l'horloge audio, au lieu de paliers posés par une minuterie ; une pause
// (contexte suspendu) fige l'horloge, et le volume avec elle.
export function gainSchedule(plan, fromMs = 0) {
    const from = Math.max(0, fromMs || 0);
    const videoMs = plan?.videoMs > 0 ? plan.videoMs : 0;
    const fadeInEnd = plan?.fadeInMs > 0 ? plan.fadeInMs : 0;
    const fadeOutEnd = plan?.fadeOutMs > 0 ? fadeOutEndMs(plan) : 0;
    const fadeOutStart = fadeOutEnd ? fadeOutEnd - plan.fadeOutMs : 0;
    const marks = [from, fadeInEnd, fadeOutStart, fadeOutEnd, videoMs]
        .filter((ms) => ms >= from && (!videoMs || ms <= videoMs));
    const times = [...new Set(marks)].sort((a, b) => a - b);
    const points = [];
    times.forEach((ms, index) => {
        const previous = times[index - 1];
        // Portion couverte par les deux fondus : subdivisée.
        if (previous !== undefined && fadeInEnd && fadeOutStart && previous >= fadeOutStart && ms <= fadeInEnd) {
            for (let step = 1; step < OVERLAP_STEPS; step++) {
                const at = previous + ((ms - previous) * step) / OVERLAP_STEPS;
                points.push({ ms: at, gain: playbackGain(at, plan) });
            }
        }
        points.push({ ms, gain: playbackGain(ms, plan) });
    });
    return points;
}
