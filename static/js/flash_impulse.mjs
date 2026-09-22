// Flash « impulsion » : courbes d'animation et décalage des points d'une journée.
//
// Deux couches par flash : un halo en dégradé (lueur brève, qui s'éteint vite)
// et un anneau fin qui s'élargit très vite puis ralentit. L'anneau garde toute
// son opacité pendant le premier tiers avant de s'effacer : apparition vive,
// disparition douce, là où les autres formes s'estompent dès le premier instant.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Décalage maximal entre les flashs d'une même journée : une grosse arrivée
// devient une vague au lieu d'un allumage simultané, sans ralentissement perceptible.
export const IMPULSE_MAX_STAGGER_MS = 120;

// Part de l'animation pendant laquelle l'anneau reste pleinement opaque.
const RING_HOLD = 0.35;

function clamp01(t) {
    return Math.min(1, Math.max(0, Number(t) || 0));
}

function smoothstep(u) {
    return u * u * (3 - 2 * u);
}

// Géométrie et opacités d'un flash impulsion à l'avancement t (0 -> 1), pour une
// taille de flash `size` (même échelle que les autres formes : rayon maximal de
// l'anneau = size/2 + size/10).
export function impulseFrame(t, size) {
    const r = clamp01(t);
    const s = Math.max(0, Number(size) || 0);
    const expand = 1 - Math.pow(1 - r, 4);       // ~76 % du chemin à t = 0,3
    const fade = r <= RING_HOLD ? 0 : smoothstep((r - RING_HOLD) / (1 - RING_HOLD));
    return {
        ringRadius: s / 10 + expand * (s / 2),
        ringOpacity: 1 - fade,
        ringWidth: 1 + 2 * (1 - r),              // trait qui s'affine en s'éloignant
        haloRadius: s * (0.25 + 0.2 * (1 - Math.pow(1 - r, 3))),
        haloOpacity: (1 - r) * (1 - r),          // lueur intense puis vite éteinte
    };
}

// Fraction pseudo-aléatoire [0, 1) stable pour une position donnée : le même
// point est toujours décalé de la même façon, en lecture comme en enregistrement.
export function staggerFraction(lon, lat) {
    const x = Math.sin((Number(lon) || 0) * 12.9898 + (Number(lat) || 0) * 78.233) * 43758.5453;
    return x - Math.floor(x);
}

// Retard d'un flash en ms (lecture live).
export function staggerDelayMs(lon, lat) {
    return staggerFraction(lon, lat) * IMPULSE_MAX_STAGGER_MS;
}

// Retard d'un flash en captures (enregistrement), proportionnel au nombre de
// captures que dure un flash de `durationMs` : le retard reste le même en temps
// vidéo quel que soit le fps.
export function staggerDelayFrames(lon, lat, flashFrames, durationMs) {
    const duration = Number(durationMs);
    const frames = Number(flashFrames);
    if (!(duration > 0) || !(frames > 0)) return 0;
    return Math.round(staggerDelayMs(lon, lat) * frames / duration);
}
