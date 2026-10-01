// Flash « écho » : deux anneaux expansifs déphasés (mode apparition).
//
// L'anneau principal reprend la courbe des formes pleines (easeOut cubique sur
// le rayon, fondu cubique sur l'opacité) ; un second anneau part du point avec
// un temps de retard, plus fin et plus discret, comme une réverbération de la
// première onde.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Retard du second anneau (fraction de la durée) et part de la fin où il
// apparaît : assez tard pour se lire comme un écho, assez tôt pour finir sa
// course avant l'extinction complète du premier.
const ECHO_LAG = 0.3;
const ECHO_FADE_IN = 0.08;
// L'écho reste en retrait du premier anneau : plus fin et moins opaque.
const ECHO_DIM = 0.55;

function clamp01(t) {
    return Math.min(1, Math.max(0, Number(t) || 0));
}

function smoothstep(u) {
    return u * u * (3 - 2 * u);
}

// Courbe d'un anneau : même échelle que les autres formes (rayon de s/10 à
// s/2 + s/10), easeOut cubique comme ol.easing.easeOut.
function ring(u, s) {
    const e = 1 - Math.pow(1 - u, 3);
    return {
        radius: s / 10 + e * (s / 2),
        opacity: 1 - Math.pow(u, 3),
        width: 2,
    };
}

// Anneaux à l'avancement t (0 -> 1), pour une taille de flash `size`.
// `rings` est ordonné de l'écho (dessiné dessous) vers l'anneau principal.
export function echoFrame(t, size) {
    const r = clamp01(t);
    const s = Math.max(0, Number(size) || 0);

    const second = ring(clamp01((r - ECHO_LAG) / (1 - ECHO_LAG)), s);
    second.opacity *= ECHO_DIM * smoothstep(clamp01((r - ECHO_LAG) / ECHO_FADE_IN));
    second.width = 1.25;

    return { rings: [second, ring(r, s)] };
}
