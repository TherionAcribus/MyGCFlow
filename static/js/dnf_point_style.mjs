// Style WebGL dédié des points DNF (source_kind 'dnf', docs/logs-geocaching.md),
// réglé par le thème (pointOptions.dnf, normalisé par dnf_model.mjs) —
// extrait de point_webgl_style.js, dont il ne dépend pas (module pur).
//
// Vectoriel : forme propre — ou celle des trouvailles (« same ») — couleur
// de point et contour propres. Icônes : icône des échecs (« dnf », défaut)
// ou celle du type de cache (« type »), alors marquée de l'anneau à la
// couleur du contour (buildDnfRingStyle, couche sous l'icône). Les
// décorations (apparition, persistance, effacement à la résolution) sont
// celles de point_decorators.mjs, comme les autres couches de points.
import { dnfPointOptions } from './dnf_model.mjs';
import { SHAPE_GEOMETRY } from './point_geometry.mjs';
import {
    applyAppearAnimation,
    applyDnfVanish,
    applyRecentGlow,
} from './point_decorators.mjs';

// Vectoriel : forme dédiée — même table de géométrie que les caches posées
// — couleur de point et contour propres. « same » prend la forme des
// trouvailles ; son contour est alors celui du thème, à la couleur DNF.
export function dnfShapeStyle(pointOptions, pointSize, themeBorderSize, themeBorderWidth) {
    const dnf = dnfPointOptions(pointOptions?.dnf);
    const shape = dnf.shape === 'same'
        ? (pointOptions.shape === 'triangle' ? 'triangle' : 'circle')
        : dnf.shape;
    let stroke = null;
    if (dnf.borderWidth > 0) {
        stroke = { color: dnf.borderColor, width: dnf.borderWidth };
    } else if (dnf.shape === 'same' && themeBorderSize > 0 && pointOptions.border?.mode !== 'none') {
        stroke = { color: dnf.borderColor, width: themeBorderWidth };
    }
    if (shape === 'circle') {
        const style = { 'circle-radius': pointSize, 'circle-fill-color': dnf.color, 'circle-rotate-with-view': false };
        if (stroke) Object.assign(style, { 'circle-stroke-color': stroke.color, 'circle-stroke-width': stroke.width });
        return style;
    }
    const geom = SHAPE_GEOMETRY[shape];
    const radiusFactor = dnf.shape === 'same' ? 1 : geom.radius;
    const style = {
        'shape-points': geom.points,
        'shape-radius': pointSize * radiusFactor,
        'shape-angle': geom.angle,
        'shape-fill-color': dnf.color,
        'shape-rotate-with-view': false,
    };
    if (geom.radius2) style['shape-radius2'] = pointSize * geom.radius2;
    if (stroke) Object.assign(style, { 'shape-stroke-color': stroke.color, 'shape-stroke-width': stroke.width });
    return style;
}

// Mode icônes : « dnf » écrase les correspondances par type par l'icône des
// échecs ; « type » les garde — l'anneau du contour la marque alors.
export function applyDnfIcon(pointStyle, pointOptions) {
    if (dnfPointOptions(pointOptions?.dnf).icon !== 'dnf') return;
    const rect = pointOptions.sprite?.map?.dnf;
    if (!rect || !('icon-offset' in pointStyle)) return;
    pointStyle['icon-offset'] = [rect.x, rect.y];
    pointStyle['icon-size'] = [rect.w, rect.h];
}

// Anneau des points DNF en mode icônes : disque à la couleur du contour
// sous l'icône, dessiné par sa propre couche — c'est lui qui marque un DNF
// quand l'icône du type est choisie. null : vectoriel ou épaisseur nulle.
export function buildDnfRingStyle(pointOptions) {
    if (pointOptions?.mode !== 'icone' || !pointOptions.sprite?.map) return null;
    const dnf = dnfPointOptions(pointOptions?.dnf);
    if (dnf.borderWidth <= 0) return null;
    const iconPx = Math.max(1, parseInt(pointOptions.iconSize) || 24);
    const style = {
        'circle-radius': iconPx / 2 + dnf.borderWidth,
        'circle-fill-color': dnf.borderColor,
        'circle-rotate-with-view': false,
    };
    if (pointOptions.appearAnimation) applyAppearAnimation(style);
    if (Number(pointOptions.recentGlowDays) > 0) applyRecentGlow(style);
    applyDnfVanish(style);
    return style;
}
