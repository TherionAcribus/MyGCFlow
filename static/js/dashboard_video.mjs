// Vidéo d'un tableau de bord entier : un écran d'ouverture puis chaque
// graphique à tour de rôle, comme le mode présentation, enregistré. Logique
// pure (découpage du temps, fondus, comptage des chiffres clés), testée par
// tests/js/dashboard_video.test.mjs ; le dessin vit dans stats_page_video.js.

// Durée de chaque graphique, en secondes (défaut : 6).
export const SLIDE_SECONDS = Object.freeze([4, 6, 8, 10]);
export const DEFAULT_SLIDE_SECONDS = 6;
// Écran d'ouverture (nom du tableau, période).
export const INTRO_MS = 3000;
// Écran de fin : la vidéo se referme sur sa carte de titre (bookend) — au
// choix de l'utilisateur (`outro`), sinon elle s'arrête sur le dernier
// graphique.
export const OUTRO_MS = 3000;
// Fondu d'entrée de chaque écran.
export const FADE_MS = 500;
// Part d'un écran consacrée à l'animation (révélation, comptage) ; le reste
// garde le graphique complet à l'écran.
export const ANIMATED_SHARE = 0.7;

// `allowAny` : une durée « calée sur la musique » est arbitraire (ex.
// 7,33 s) — tout nombre fini dans ]0, 600] est accepté ; sinon seuls les
// quatre choix du select sont valides, le reste retombe sur le défaut.
export function slideSeconds(value, allowAny = false) {
    const n = Number(value);
    if (allowAny) return Number.isFinite(n) && n > 0 && n <= 600 ? n : DEFAULT_SLIDE_SECONDS;
    return SLIDE_SECONDS.includes(n) ? n : DEFAULT_SLIDE_SECONDS;
}

// Durée totale (ms) d'une vidéo de `count` graphiques : ouverture, un
// écran par graphique, fermeture sur la carte de titre si `outro`.
export function dashboardVideoDuration(count, seconds, allowAny = false, outro = true) {
    return INTRO_MS + Math.max(0, count) * slideSeconds(seconds, allowAny) * 1000 + (outro ? OUTRO_MS : 0);
}

// Où en est la vidéo au temps `t` (ms) :
//   { kind: 'intro' | 'slide' | 'outro' | 'end', index, local (ms depuis le
//     début de l'écran), progress (0 → 1 de l'animation), fade (0 → 1,
//     opacité) }. Sans `outro`, 'end' suit directement le dernier graphique.
export function videoMoment(t, count, seconds, allowAny = false, outro = true) {
    const slideMs = slideSeconds(seconds, allowAny) * 1000;
    const fadeOf = (local) => Math.min(1, Math.max(0, local / FADE_MS));
    if (t < INTRO_MS) return { kind: 'intro', index: -1, local: t, progress: Math.min(1, t / (INTRO_MS * ANIMATED_SHARE)), fade: fadeOf(t) };
    const rest = t - INTRO_MS;
    const index = Math.floor(rest / slideMs);
    if (index >= count) {
        // Après le dernier graphique : écran de fin (même carte de titre
        // qu'à l'ouverture), puis 'end' au-delà de la durée totale.
        const outroLocal = rest - count * slideMs;
        if (outro && outroLocal < OUTRO_MS) {
            return {
                kind: 'outro',
                index: count,
                local: outroLocal,
                progress: Math.min(1, outroLocal / (OUTRO_MS * ANIMATED_SHARE)),
                fade: fadeOf(outroLocal),
            };
        }
        return { kind: 'end', index: count - 1, local: slideMs, progress: 1, fade: 1 };
    }
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
// (/process_recorded_video) : un morceau de la bibliothèque (nom, avec ses
// bornes [start, end] reprises de la carte — le motif bouclé les respecte),
// ou un fichier envoyé (à joindre par l'appelant). Bouclée si elle est plus
// courte que la vidéo ; `fadeOut` / `fadeIn` (secondes) sont les fondus
// réglés dans la fenêtre — un fondu d'entrée nul n'est pas envoyé.
export const MUSIC_FADE_OUT_S = 2;
export function musicFields(music, { fadeOut = MUSIC_FADE_OUT_S, fadeIn = 0 } = {}) {
    if (!music) return null;
    const fields = { audio_loop: '1', audio_fade_out: String(fadeOut) };
    if (fadeIn > 0) fields.audio_fade_in = String(fadeIn);
    if (music.kind === 'library') {
        fields.audio = music.file;
        if (music.start > 0) fields.audio_start = String(music.start);
        if (music.end > 0) fields.audio_end = String(music.end);
    }
    return fields;
}
