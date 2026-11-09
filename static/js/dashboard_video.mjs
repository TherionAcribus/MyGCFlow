// Vidéo d'un tableau de bord entier : un écran d'ouverture puis chaque
// graphique à tour de rôle, comme le mode présentation, enregistré. Logique
// pure (découpage du temps, fondus, comptage des chiffres clés), testée par
// tests/js/dashboard_video.test.mjs ; le dessin vit dans stats_page_video.js.

// Durée de chaque graphique, en secondes (défaut : 6).
export const SLIDE_SECONDS = Object.freeze([4, 6, 8, 10]);
export const DEFAULT_SLIDE_SECONDS = 6;
// Écran d'ouverture (nom du tableau, période).
export const INTRO_MS = 3000;
// Fondu d'entrée de chaque écran.
export const FADE_MS = 500;
// Part d'un écran consacrée à l'animation (révélation, comptage) ; le reste
// garde le graphique complet à l'écran.
export const ANIMATED_SHARE = 0.7;

export function slideSeconds(value) {
    const n = Number(value);
    return SLIDE_SECONDS.includes(n) ? n : DEFAULT_SLIDE_SECONDS;
}

// Durée totale (ms) d'une vidéo de `count` graphiques.
export function dashboardVideoDuration(count, seconds) {
    return INTRO_MS + Math.max(0, count) * slideSeconds(seconds) * 1000;
}

// Où en est la vidéo au temps `t` (ms) :
//   { kind: 'intro' | 'slide' | 'end', index, local (ms depuis le début de
//     l'écran), progress (0 → 1 de l'animation), fade (0 → 1, opacité) }.
export function videoMoment(t, count, seconds) {
    const slideMs = slideSeconds(seconds) * 1000;
    const fadeOf = (local) => Math.min(1, Math.max(0, local / FADE_MS));
    if (t < INTRO_MS) return { kind: 'intro', index: -1, local: t, progress: Math.min(1, t / (INTRO_MS * ANIMATED_SHARE)), fade: fadeOf(t) };
    const rest = t - INTRO_MS;
    const index = Math.floor(rest / slideMs);
    if (index >= count) return { kind: 'end', index: count - 1, local: slideMs, progress: 1, fade: 1 };
    const local = rest - index * slideMs;
    return {
        kind: 'slide',
        index,
        local,
        progress: Math.min(1, local / (slideMs * ANIMATED_SHARE)),
        fade: fadeOf(local),
    };
}

// Chiffre clé qui monte de 0 à sa valeur : décélération en fin de course.
export function countUp(value, progress) {
    if (!Number.isFinite(value)) return value;
    const p = Math.min(1, Math.max(0, progress));
    const eased = 1 - (1 - p) ** 3;
    const raw = value * eased;
    return Number.isInteger(value) ? Math.round(raw) : raw;
}

// Musique choisie dans la fenêtre → champs du traitement serveur
// (/process_recorded_video) : un morceau de la bibliothèque (nom), ou un
// fichier envoyé (à joindre par l'appelant). Bouclée si elle est plus courte
// que la vidéo, fondue à la fin.
export const MUSIC_FADE_OUT_S = 2;
export function musicFields(music) {
    if (!music) return null;
    const fields = { audio_loop: '1', audio_fade_out: String(MUSIC_FADE_OUT_S) };
    if (music.kind === 'library') {
        fields.audio = music.file;
        if (music.start > 0) fields.audio_start = String(music.start);
    }
    return fields;
}
