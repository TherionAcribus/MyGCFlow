// Effets de points de la page Mes poses (points.poses_effects du thème,
// poses_effects.mjs ; docs/mode-poses.md). Décorateurs purs d'un style
// WebGLPoints, appelés par buildPointStyle (point_webgl_style.js), et style
// de la couche de lueur d'activité, posée sous les points sur la même source.
//
// Aucune mise à jour par image : le shader lit les attributs écrits par
// poses_data.js les jours de trouvaille (lastFind, heatVal, popLevels,
// popDay — poses_timeline.mjs › posesEffectAttrs) et les variables evo* du
// moteur (evolution_style.mjs). Le jour fractionnaire courant vaut
// evoDay + evoIntraMs / evoMsPerDay ; au repos (evoMsPerDay = 1, evoIntraMs =
// 0) c'est le jour de repos, et les transitions sont terminées (evoFrom =
// EVO_STATIC_FROM).
//
// Module pur (aucun DOM, aucun import du graphe index.js) : testé par
// tests/js/poses_point_style.test.mjs.

import { APPEAR_SIZE_KEYS, opacityKeyOf } from './point_decorators.mjs';
import { disappearScaleExpression, disappearOpacityExpression, EVO_FILTER, EVO_STATIC_FROM } from './evolution_style.mjs';
import { POP_LEVEL_MAX, POP_LEVEL_PACK } from './poses_timeline.mjs';

const TRANSPARENT = [0, 0, 0, 0];
// Durée de la croissance d'un point qui change de niveau (temps vidéo).
export const POP_TWEEN_MS = 500;
// Période de la pulsation des caches désactivées (temps vidéo).
export const PULSE_PERIOD_MS = 1600;
// Couleur vers laquelle pâlit une cache délaissée (vectoriel) : un gris-bleu
// moyen, et jamais plus de FRESHNESS_MAX_MIX — un gris clair rendait les
// points presque invisibles sur un fond de carte clair (vérifié en capture).
export const FRESHNESS_PALE = '#90a4ae';
export const FRESHNESS_MAX_MIX = 0.7;
// Baisse d'opacité à pâleur pleine : vectoriel (la couleur porte déjà
// l'effet), icônes (seul effet possible).
export const FRESHNESS_FADE = Object.freeze({ vector: 0.25, icon: 0.5 });
// Rayon de la lueur, en multiple du rayon du point : une trouvaille seule
// (niveau 0,5) → 1,6 ; chaleur saturée → 2.
export const ACTIVITY_RADIUS = Object.freeze({ base: 1.2, gain: 0.8 });
// Épaisseur du contour des archivées en style fantôme (px).
export const GHOST_STROKE_WIDTH = 2;
// Opacité des archivées : grisées (défaut historique), fantôme en vectoriel
// (le contour seul doit rester lisible), fantôme en icônes (pas de contour
// possible : très effacées).
export const ARCHIVED_OPACITY = Object.freeze({ grey: 0.55, ghostVector: 0.85, ghostIcon: 0.35 });

const v = (name) => ['var', name];
const g = (name) => ['get', name];
const PSTATE = g('pstate');
const IS_ACTIVE = ['==', PSTATE, 0];
const IS_DISABLED = ['==', PSTATE, 1];
const IS_ARCHIVED = ['==', PSTATE, 2];
const ANIMATING = ['<', v('evoFrom'), EVO_STATIC_FROM];

// Jour fractionnaire courant.
export const POSES_DAY = ['+', v('evoDay'), ['/', v('evoIntraMs'), v('evoMsPerDay')]];

const FILL_KEYS = ['circle-fill-color', 'shape-fill-color'];
const STROKE = {
    'circle-fill-color': ['circle-stroke-color', 'circle-stroke-width'],
    'shape-fill-color': ['shape-stroke-color', 'shape-stroke-width'],
};
const COLOR_KEYS = ['circle-fill-color', 'shape-fill-color', 'circle-stroke-color', 'shape-stroke-color'];

function isTransparent(color) {
    return Array.isArray(color) && color.length === 4 && color.every((x) => x === 0);
}

function multiplyOpacity(style, factor) {
    const key = opacityKeyOf(style);
    if (!key) return;
    style[key] = key in style ? ['*', style[key], factor] : factor;
}

// Échelle de taille selon la popularité : niveau courant, avec transition
// depuis le niveau précédent pendant POP_TWEEN_MS après le jour du changement.
export function popularityScaleExpression(maxScale) {
    const levels = g('popLevels');
    const from = ['%', levels, POP_LEVEL_PACK];
    const to = ['/', ['-', levels, from], POP_LEVEL_PACK];
    const ageMs = ['case',
        ['<', g('popDay'), v('evoFrom')], 1e8,
        ['+', ['*', ['-', v('evoDay'), g('popDay')], v('evoMsPerDay')], v('evoIntraMs')]];
    const t = ['clamp', ['/', ageMs, POP_TWEEN_MS], 0, 1];
    const level = ['+', from, ['*', ['-', to, from], t]];
    return ['+', 1, ['*', (Number(maxScale) || 2) - 1, ['/', level, POP_LEVEL_MAX]]];
}

// Part de pâleur (0..strength) d'une cache active sans trouvaille depuis plus
// de `afterDays` jours ; pleine à 2 × afterDays.
export function freshnessAmountExpression(afterDays, strength) {
    const after = Math.max(1, Number(afterDays) || 365);
    const idle = ['-', ['-', POSES_DAY, g('lastFind')], after];
    const amount = ['*', ['clamp', ['/', idle, after], 0, 1], (Number(strength) || 0) / 100];
    return ['case', IS_ACTIVE, amount, 0];
}

// Chaleur d'activité normalisée (0..1) : chaleur à la dernière trouvaille,
// divisée par deux tous les `halfLifeDays` jours, saturée (une trouvaille
// seule = 0,5).
export function activityLevelExpression(halfLifeDays) {
    const halfLife = Math.max(1e-3, Number(halfLifeDays) || 14);
    const heat = ['*', g('heatVal'), ['^', 2, ['/', ['-', g('lastFind'), POSES_DAY], halfLife]]];
    return ['/', heat, ['+', heat, 1]];
}

// Taille selon la popularité : multiplie toutes les tailles du symbole.
export function applyPosesPopularity(style, effects) {
    if (!effects?.popularity?.enabled) return;
    const scale = popularityScaleExpression(effects.popularity.max_scale);
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in style) style[key] = ['*', style[key], scale];
    }
}

// Fraîcheur : en vectoriel, les couleurs pâlissent ; dans les deux modes,
// l'opacité baisse un peu (seul effet possible sur une icône).
export function applyPosesFreshness(style, effects) {
    if (!effects?.freshness?.enabled) return;
    const amount = freshnessAmountExpression(effects.freshness.after_days, effects.freshness.strength);
    const icon = 'icon-src' in style;
    if (!icon) {
        for (const key of COLOR_KEYS) {
            if (!(key in style) || isTransparent(style[key])) continue;
            style[key] = ['interpolate', ['linear'], ['*', amount, FRESHNESS_MAX_MIX], 0, style[key], 1, FRESHNESS_PALE];
        }
    }
    multiplyOpacity(style, ['-', 1, ['*', amount, icon ? FRESHNESS_FADE.icon : FRESHNESS_FADE.vector]]);
}

// Pulsation lente des désactivées, pendant l'animation seulement (au repos,
// le point garde son opacité pleine).
export function applyDisabledPulse(style, effects) {
    if (!effects?.disabled_pulse) return;
    const wave = ['+', 0.5, ['*', 0.5, ['sin', ['*', v('now'), (2 * Math.PI) / PULSE_PERIOD_MS]]]];
    multiplyOpacity(style, ['case', ['all', IS_DISABLED, ANIMATING], ['+', 0.45, ['*', 0.55, wave]], 1]);
}

// Style fantôme des archivées (vectoriel) : centre transparent, contour à la
// couleur grisée du point. À appeler APRÈS le grisé (applyPosesColors), dont
// il reprend la couleur.
export function applyPosesGhost(style, effects) {
    if (effects?.archived_style !== 'ghost') return;
    for (const fillKey of FILL_KEYS) {
        if (!(fillKey in style) || isTransparent(style[fillKey])) continue;
        const [strokeKey, widthKey] = STROKE[fillKey];
        const fill = style[fillKey];
        const stroke = strokeKey in style ? style[strokeKey] : TRANSPARENT;
        const width = widthKey in style ? style[widthKey] : 0;
        style[strokeKey] = ['case', IS_ARCHIVED, strokeKey in style ? stroke : fill, stroke];
        // Épaisseur du thème (nombre fixe ici : les tailles animées sont
        // posées après) ; OpenLayers n'a pas d'opérateur « max ».
        const ghostWidth = typeof width === 'number' ? Math.max(width, GHOST_STROKE_WIDTH) : GHOST_STROKE_WIDTH;
        style[widthKey] = ['case', IS_ARCHIVED, ghostWidth, width];
        style[fillKey] = ['case', IS_ARCHIVED, TRANSPARENT, fill];
    }
}

// Opacité des archivées selon le style choisi et le mode d'affichage.
export function archivedOpacityFor(effects, iconMode) {
    if (effects?.archived_style !== 'ghost') return ARCHIVED_OPACITY.grey;
    return iconMode ? ARCHIVED_OPACITY.ghostIcon : ARCHIVED_OPACITY.ghostVector;
}

// Couche de lueur d'activité (sous les points, même source) : un disque à la
// couleur choisie, qui grandit et s'intensifie avec la chaleur, suit la
// taille du point (popularité) et sa disparition ; rien pour une archivée.
// null quand l'effet est décoché.
export function buildPosesActivityStyle(pointOptions, effects) {
    if (!effects?.activity?.enabled) return null;
    const iconMode = pointOptions?.mode === 'icone';
    const base = iconMode
        ? Math.max(4, (parseInt(pointOptions.iconSize) || 24) / 2)
        : Math.max(1, parseInt(pointOptions?.center?.size) || 3);
    const level = activityLevelExpression(effects.activity.half_life_days);
    let radius = ['*', base, ['+', ACTIVITY_RADIUS.base, ['*', ACTIVITY_RADIUS.gain, level]], disappearScaleExpression()];
    if (effects.popularity?.enabled) radius = ['*', radius, popularityScaleExpression(effects.popularity.max_scale)];
    const intensity = (Number(effects.activity.intensity) || 60) / 100;
    return {
        'circle-radius': radius,
        'circle-fill-color': effects.activity.color || '#ffb300',
        'circle-opacity': ['case', IS_ARCHIVED, 0, ['*', intensity, level, disappearOpacityExpression()]],
        'circle-rotate-with-view': false,
    };
}

// Filtre de la couche de lueur : points visibles (EVO_FILTER) déjà trouvés.
export const POSES_ACTIVITY_FILTER = ['all', EVO_FILTER, ['>', g('heatVal'), 0]];
