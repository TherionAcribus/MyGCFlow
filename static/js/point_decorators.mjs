// Décorateurs de styles WebGLPoints — extrait de point_webgl_style.js pour
// être réutilisé par les couches annexes (anneau des caches posées, style
// dédié des DNF) sans importer le graphe des couleurs GC. Fonctions pures :
// elles enveloppent in place les valeurs de taille et d'opacité d'un objet
// de style par des expressions d'animation.
import {
    appearOpacityExpression,
    appearScaleExpression,
    POINT_APPEAR_MS,
    withAppearScale,
    withRecentGlowColor,
    withRecentGlowScale,
} from './point_appear.mjs';
import {
    disappearOpacityExpression,
    disappearScaleExpression,
    EVO_AGE,
    POINT_DISAPPEAR_MS,
} from './evolution_style.mjs';

// Couleurs éclaircies par la persistance des points récents. La bordure est
// laissée telle quelle : c'est le point lui-même qui doit s'éclairer.
export const GLOW_COLOR_KEYS = ['circle-fill-color', 'shape-fill-color'];

// Propriétés de taille (multipliées par l'échelle d'apparition) et d'opacité,
// selon le type de symbole du style.
export const APPEAR_SIZE_KEYS = ['circle-radius', 'circle-stroke-width', 'shape-radius', 'shape-radius2', 'shape-stroke-width', 'icon-scale'];
const APPEAR_OPACITY_KEY = { circle: 'circle-opacity', shape: 'shape-opacity', icon: 'icon-opacity' };

export function opacityKeyOf(pointStyle) {
    const symbol = Object.keys(APPEAR_OPACITY_KEY).find((prefix) => `${prefix}-radius` in pointStyle || `${prefix}-src` in pointStyle);
    return symbol ? APPEAR_OPACITY_KEY[symbol] : null;
}

// Ajoute l'apparition animée (voir point_appear.mjs) à un style de points. Les
// features doivent porter l'attribut numérique 'appear' et le layer la variable
// 'now' : c'est displayWebGLPoints() qui s'en charge.
export function applyAppearAnimation(pointStyle) {
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = withAppearScale(pointStyle[key]);
    }
    const opacityKey = opacityKeyOf(pointStyle);
    if (opacityKey) pointStyle[opacityKey] = appearOpacityExpression();
}

// Ajoute la persistance des points récents (voir point_appear.mjs) : les points
// des derniers jours restent plus clairs et un peu plus gros. Repose sur les
// mêmes prérequis que l'apparition animée, plus la variable de style 'glowMs'
// (durée de la fenêtre en temps d'animation).
export function applyRecentGlow(pointStyle) {
    for (const key of GLOW_COLOR_KEYS) {
        if (key in pointStyle) pointStyle[key] = withRecentGlowColor(pointStyle[key]);
    }
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = withRecentGlowScale(pointStyle[key]);
    }
}

// La feature DNF porte 'vanish' : tant qu'il vaut DNF_NOT_VANISHING le point
// est pleinement opaque ; écrit à la résolution, il porte l'échelle et
// l'opacité sur POINT_DISAPPEAR_MS depuis cet instant (mapgl.js écrit
// l'instant de départ sur l'horloge des points ; il vaut DNF_NOT_VANISHING
// tant que la cache reste un échec — ou après annulation d'un effacement
// amorcé).
export const DNF_NOT_VANISHING = -1e9;
const VANISHING = ['>', ['get', 'vanish'], DNF_NOT_VANISHING / 10];
const VANISH_AGE = ['-', ['var', 'now'], ['get', 'vanish']];

export function applyDnfVanish(pointStyle) {
    const scale = ['case', VANISHING,
        ['interpolate', ['linear'], VANISH_AGE, 0, 1, 0.3 * POINT_DISAPPEAR_MS, 1.2, POINT_DISAPPEAR_MS, 0], 1];
    const opacity = ['case', VANISHING,
        ['interpolate', ['linear'], VANISH_AGE, 0, 1, POINT_DISAPPEAR_MS, 0], 1];
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = ['*', pointStyle[key], scale];
    }
    const opacityKey = opacityKeyOf(pointStyle);
    if (opacityKey) {
        pointStyle[opacityKey] = opacityKey in pointStyle ? ['*', pointStyle[opacityKey], opacity] : opacity;
    }
}
