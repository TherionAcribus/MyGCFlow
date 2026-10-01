// Flash « cible » : un réticule qui converge sur le point puis se verrouille.
//
// Un anneau se contracte pendant que quatre traits de visée se rapprochent de
// lui ; à la convergence (~60 % de la durée) un point central apparaît, puis
// l'ensemble s'éteint. Le mouvement convergent se lit dans les deux sens :
// « la cache est repérée » à l'apparition, « la cache est verrouillée puis
// retirée » à la disparition (mode Évolution).
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

const FADE_IN = 0.12;
const FADE_OUT_FROM = 0.78;
// Convergence complète à cette fraction de la durée : le réticule reste ensuite
// stable le temps que le point central apparaisse, avant l'extinction.
const LOCK = 0.6;

function clamp01(t) {
    return Math.min(1, Math.max(0, Number(t) || 0));
}

function smoothstep(u) {
    return u * u * (3 - 2 * u);
}

// Géométrie et opacités du réticule à l'avancement t (0 -> 1), pour une taille
// de flash `size` (rayon de départ ~0,55·size, proche des autres formes).
export function targetFrame(t, size) {
    const r = clamp01(t);
    const s = Math.max(0, Number(size) || 0);
    // easeOut cubique sur la phase de convergence seule : le réticule se
    // verrouille à LOCK puis ne bouge plus.
    const e = 1 - Math.pow(1 - Math.min(r, LOCK) / LOCK, 3);
    const fadeIn = Math.min(1, r / FADE_IN);
    const fadeOut = r <= FADE_OUT_FROM ? 1 : 1 - smoothstep((r - FADE_OUT_FROM) / (1 - FADE_OUT_FROM));
    const opacity = fadeIn * fadeOut;

    const ringRadius = Math.max(1, s * (0.55 - 0.25 * e));   // 0,55·s -> 0,30·s
    const gap = Math.max(1.5, s * 0.04);                     // traits décollés de l'anneau
    const reach = s * 0.18 * (1 - e);                        // distance des traits, nulle au verrouillage
    const dotIn = smoothstep(clamp01((r - 0.45) / 0.3));     // le point nait au verrouillage

    return {
        ringRadius,
        ringOpacity: opacity,
        ringWidth: 1.5 + 1.5 * e,                            // trait qui s'épaissit en se verrouillant
        tickInner: ringRadius + gap + reach,
        tickOuter: ringRadius + gap + reach + Math.max(1.5, s * 0.08),
        tickOpacity: opacity,
        dotRadius: Math.max(0.8, s * 0.05) * dotIn,
        dotOpacity: opacity * dotIn,
    };
}
