// Lecture de la musique telle que la vidéo l'utilisera — calculs purs (testés
// par test_music_playback.mjs), partagés par l'aperçu de l'animation et le
// bouton « Écouter » (background_audio.js).
//
// `plan` (cf. musicPlaybackPlan dans ui.js), durées en ms :
//   startMs   : point de départ dans le fichier (intro sautée)
//   loop      : { startMs, endMs, crossfadeMs } — motif répété, positions dans
//               le fichier, et raccord fondu entre les reprises (0 = net) — ou null
//   fadeInMs, fadeOutMs : fondus, déjà bornés à la vidéo (clampFades)
//   videoMs   : durée de la vidéo (0 = inconnue)
//   volume    : gain plein (0 à 1)

// Part maximale du motif que peut occuper un raccord fondu. ffmpeg exige un
// motif plus long que deux raccords (capture._audio_filter_graph) : 40 % laisse
// de la marge, et un raccord trop long est raccourci plutôt qu'abandonné.
const MAX_CROSSFADE_SHARE = 0.4;

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

// Position dans le fichier de la musique entendue à l'instant `videoMs` de la
// vidéo, et temps déjà joué en tours de boucle complets. Pendant un raccord
// fondu, c'est la position de la reprise (celle qui monte).
export function sourcePositionAt(videoMs, plan) {
    const t = Math.max(0, videoMs || 0);
    const startMs = plan?.startMs || 0;
    const loop = plan?.loop;
    const periodMs = loopPeriodMs(loop);
    if (!(periodMs > 0)) return { sourceMs: startMs + t, playedLoopsMs: 0 };
    const playedLoopsMs = Math.floor(t / periodMs) * periodMs;
    return { sourceMs: loop.startMs + (t - playedLoopsMs), playedLoopsMs };
}

// Piste à raccord fondu, prête à boucler — même construction que ffmpeg
// (capture._audio_filter_graph), échantillon par échantillon :
//     motif[0, m-c]  puis  (motif[m-c, m] qui s'efface + motif[0, c] qui monte) + motif[c, m-c]
// La seconde partie (la reprise) se répète : boucler de `loopStartSeconds` à
// la fin. Courbes en quart de sinus, à puissance constante, comme
// afade:curve=qsin. `channels` : canaux décodés du fichier entier ;
// startMs/endMs : le motif ; crossfadeMs : le raccord (cf. loopCrossfadeMs).
export function crossfadedLoopChannels(channels, sampleRate, { startMs, endMs, crossfadeMs }) {
    const at = (ms) => Math.round((ms / 1000) * sampleRate);
    const motifStart = at(startMs);
    const m = at(endMs) - motifStart;
    const c = at(crossfadeMs);
    const period = m - c;
    const out = channels.map((data) => {
        const motif = data.subarray(motifStart, motifStart + m);
        const result = new Float32Array(2 * period);
        result.set(motif.subarray(0, period), 0);
        for (let i = 0; i < c; i++) {
            const x = (i + 0.5) / c;
            result[period + i] = motif[period + i] * Math.cos((Math.PI / 2) * x)
                + motif[i] * Math.sin((Math.PI / 2) * x);
        }
        result.set(motif.subarray(c, period), period + c);
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

// Position dans la piste de crossfadedLoopChannels à l'instant `videoMs` :
// le premier tour, puis la reprise répétée.
export function crossfadedLoopOffsetMs(videoMs, loop) {
    const periodMs = loopPeriodMs(loop);
    const t = Math.max(0, videoMs || 0);
    if (!(periodMs > 0) || t < periodMs) return t;
    return periodMs + ((t - periodMs) % periodMs);
}

// Gain à l'instant `elapsedMs` de la vidéo : volume plein, multiplié par les
// fondus d'entrée et de sortie. Ils ne se chevauchent que sur une vidéo très
// courte, où clampFades les a réduits.
export function playbackGain(elapsedMs, plan) {
    const unit = (v) => Math.max(0, Math.min(1, v));
    let gain = plan?.volume ?? 1;
    if (plan?.fadeInMs > 0) gain *= unit(elapsedMs / plan.fadeInMs);
    if (plan?.fadeOutMs > 0 && plan.videoMs > 0) gain *= unit((plan.videoMs - elapsedMs) / plan.fadeOutMs);
    return gain;
}
