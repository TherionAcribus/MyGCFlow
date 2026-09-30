// Flash « implosion » : disparition d'une cache (mode Évolution).
//
// Miroir du flash d'apparition : là où celui-ci s'étend depuis le point,
// l'anneau d'implosion part large et se contracte vers le point en
// accélérant, en s'épaississant, puis s'éteint au moment où il se referme.
// L'œil lit ainsi d'un coup « une cache s'en va », même au milieu des flashs
// d'apparition d'autres caches.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Part de l'animation consacrée à l'apparition de l'anneau, puis à son extinction.
const FADE_IN = 0.15;
const FADE_OUT_FROM = 0.7;

function clamp01(t) {
    return Math.min(1, Math.max(0, Number(t) || 0));
}

function smoothstep(u) {
    return u * u * (3 - 2 * u);
}

// Géométrie et opacité à l'avancement t (0 -> 1), pour une taille de flash
// `size` (même échelle que les autres formes : rayon de départ = size/2 + size/10).
export function implodeFrame(t, size) {
    const r = clamp01(t);
    const s = Math.max(0, Number(size) || 0);
    const startRadius = s / 2 + s / 10;
    const contract = r * r;                       // lent au départ, puis s'effondre
    const fadeIn = Math.min(1, r / FADE_IN);
    const fadeOut = r <= FADE_OUT_FROM ? 1 : 1 - smoothstep((r - FADE_OUT_FROM) / (1 - FADE_OUT_FROM));
    return {
        ringRadius: Math.max(1, startRadius * (1 - contract)),
        ringOpacity: fadeIn * fadeOut,
        ringWidth: 1 + 2 * r,                     // trait qui s'épaissit en se refermant
    };
}
