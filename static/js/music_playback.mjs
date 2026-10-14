// Lecture de la musique telle que la vidéo l'utilisera — calculs purs (testés
// par test_music_playback.mjs), partagés par l'aperçu de l'animation et le
// bouton « Écouter » (background_audio.js).
//
// `plan` (cf. musicPlaybackPlan dans ui.js), durées en ms :
//   startMs   : point de départ dans le fichier (intro sautée)
//   loop      : { startMs, endMs } — motif répété, positions dans le fichier — ou null
//   fadeInMs, fadeOutMs : fondus, déjà bornés à la vidéo (clampFades)
//   videoMs   : durée de la vidéo (0 = inconnue)
//   volume    : gain plein (0 à 1)

// Position dans le fichier de la musique entendue à l'instant `videoMs` de la
// vidéo, et temps déjà joué en tours de boucle complets.
export function sourcePositionAt(videoMs, plan) {
    const t = Math.max(0, videoMs || 0);
    const startMs = plan?.startMs || 0;
    const loop = plan?.loop;
    const motifMs = loop ? loop.endMs - loop.startMs : 0;
    if (!(motifMs > 0)) return { sourceMs: startMs + t, playedLoopsMs: 0 };
    const playedLoopsMs = Math.floor(t / motifMs) * motifMs;
    return { sourceMs: loop.startMs + (t - playedLoopsMs), playedLoopsMs };
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
