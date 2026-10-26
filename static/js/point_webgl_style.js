// Construction du style WebGLPoints de la couche de points.
//
// Extrait de mapgl.js. Fonction pure options -> objet de style ; sa seule
// dependance externe est la table plate des couleurs GC.
import { gcColorsFlat } from './gc_colors.js';
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
import { ownerPointOptions as normalizeOwnerPoint } from './owner_model.mjs';

// Couleur totalement transparente, au format tableau [r, g, b, a] attendu par
// les expressions de style WebGL (le mot-clé CSS 'transparent' n'est pas
// reconnu par le parseur de couleurs d'OpenLayers).
const TRANSPARENT = [0, 0, 0, 0];
// Construit l'objet de style WebGLPoints (icône sprite ou cercle/triangle uni)
// à partir des options de points courantes. Le style WebGL est figé à la
// création du layer (il compile des shaders) : cette fonction n'est donc à
// appeler qu'à la (re)création du layer, jamais à chaque frame d'animation.
//
// `evolution` : style des pages « cycle de vie » (Évolution, Mes poses), où
// tous les points sont présents dès le départ et apparaissent / disparaissent
// selon le jour courant (voir evolution_style.mjs ; le filtre de visibilité
// est posé sur le layer). `poses` : en plus, rendu grisé des caches
// désactivées ou archivées (attribut 'pstate', voir applyPosesState).
// `owner` : couche des caches posées de la carte principale (owner_data.js) —
// forme et contour propres en vectoriel (pointOptions.owner), même grisé
// que sur la page Mes poses ; l'anneau des icônes est une couche à part
// (buildOwnerRingStyle).
export function buildPointStyle(pointOptions, { evolution = false, poses = false, owner = false } = {}) {
    // Validation et valeurs par défaut pour éviter NaN dans les shaders WebGL
    const pointSize = Math.max(1, parseInt(pointOptions.center.size) || 3);
    const borderSizeValue = Math.max(0, parseInt(pointOptions.border.size) || 0);
    const borderWidth = borderSizeValue / 5; // Épaisseur réelle de la bordure
    let borderColor;

    if (pointOptions.border.mode == "gc") {
        borderColor = [
            'match',
            ['get', 'cache_type'],
            ...gcColorsFlat,
            '#000000' // couleur par défaut
        ]
    } else if (pointOptions.border.mode == "fix") {
        borderColor = pointOptions.border.color
    } else if (pointOptions.border.mode == "none") {
        borderColor = TRANSPARENT // Pas utilisé mais défini pour cohérence
    }


    let fillColor;
    if (pointOptions.center.mode == "gc") {
        fillColor = [
            'match',
            ['get', 'cache_type'],
            ...gcColorsFlat,
            '#000000' // couleur par défaut
        ]
    } else if (pointOptions.center.mode == "fix") {
        fillColor = pointOptions.center.color
    } else if (pointOptions.center.mode == "none") {
        fillColor = TRANSPARENT
    }

    let pointStyle;
    let greyIconOffset = null;
    if (pointOptions.mode == "icone") {
        // Utilisation du sprite Geocaching: offset/size dynamiques selon le type ('cache_type')
        if (pointOptions.sprite && pointOptions.sprite.map) {
            const sp = pointOptions.sprite;

            // Mapping des valeurs 'cache_type' des features -> clés du sprite
            const typeToKey = (sp.typeMap) || {
                'Traditional Cache': 'trad',
                'Multi-cache': 'multi',
                'Mystery Cache': 'myst',
                'Unknown Cache': 'unknown',
                'Letterbox Hybrid': 'letterbox',
                'Event Cache': 'event',
                'Mega-Event Cache': 'mega',
                'Giga-Event Cache': 'giga',
                'Earthcache': 'earth',
                'Virtual Cache': 'virtual',
                'Wherigo Cache': 'wherigo',
                'Lab Cache': 'lab',
                'Adventure Lab': 'adventurelab',
                'Cache In Trash Out Event': 'cito',
                'Community Celebration Event': 'event',
                'Geocaching HQ Block Party': 'hq',
                'GPS Adventures Exhibit': 'maze',
                'Locationless (Reverse) Cache': 'locationless',
                'Webcam Cache': 'webcam'
            };

            // Pour le jeu 'smiley', forcer tous les points à utiliser 'found'
            if (pointOptions.iconSet === 'smiley') {
                Object.keys(typeToKey).forEach(cacheType => {
                    typeToKey[cacheType] = 'found';
                });
            }

            const typeEntries = Object.entries(typeToKey);

            // Construire des expressions 'match' par type réel
            const buildMatchArray = (prop, defaultValue) => {
                const arr = ['match', ['get', 'cache_type']];
                typeEntries.forEach(([cacheType, key]) => {
                    const r = sp.map[key];
                    if (!r) return;
                    if (prop === 'offset') {
                        arr.push(cacheType, [r.x, r.y]);
                    } else if (prop === 'size') {
                        arr.push(cacheType, [r.w, r.h]);
                    }
                });
                arr.push(defaultValue);
                return arr;
            };

            // Par défaut: premier rect dispo
            const defaultRect = (() => {
                const firstKey = Object.keys(sp.map)[0];
                return firstKey ? sp.map[firstKey] : {x:0,y:0,w:32,h:32};
            })();

            const desiredPx = Math.max(1, parseInt(pointOptions.iconSize || defaultRect.w));
            const scaleRatio = desiredPx / (defaultRect.w || 1);

            // Support retina (@2x) sans changer la méta logique : on choisit l'URL selon devicePixelRatio, mais
            // on conserve width/height logiques (1x) pour les offsets et icon-scale.
            const pixelRatio = (window.devicePixelRatio && window.devicePixelRatio >= 2) ? 2 : 1;
            const iconUrl = (pixelRatio > 1 && sp.url2x) ? sp.url2x : sp.url;
            const logicalSheetW = sp.sheetWidth;
            const logicalSheetH = sp.sheetHeight;

            // Page Mes poses : même icône dans la rangée grisée de la feuille
            // (désactivées, archivées), quand elle existe.
            if (poses || owner) {
                const grey = ['match', ['get', 'cache_type']];
                typeEntries.forEach(([cacheType, key]) => {
                    const r = sp.map[key];
                    if (!r) return;
                    const hasGrey = Number.isFinite(sp.greyRowY) && r.x <= (sp.greyMaxX ?? -1);
                    grey.push(cacheType, hasGrey ? [r.x, r.y + sp.greyRowY] : [r.x, r.y]);
                });
                grey.push([defaultRect.x, defaultRect.y]);
                greyIconOffset = grey;
            }

            pointStyle = {
                'icon-src': iconUrl,
                'icon-size': buildMatchArray('size', [defaultRect.w, defaultRect.h]),
                // tailles de feuille RESTENT logiques (1x) pour préserver les offsets
                'icon-width': logicalSheetW,
                'icon-height': logicalSheetH,
                'icon-offset': buildMatchArray('offset', [defaultRect.x, defaultRect.y]),
                'icon-offset-origin': 'top-left',
                'icon-scale': scaleRatio,
                'icon-rotate-with-view': false,
            };
        } else {
            // Fallback simple: rien si sprite absent
            pointStyle = {
                'circle-radius': pointSize,
                'circle-fill-color': fillColor || '#FF0000'
            };
        }
    } else if (owner) {
        pointStyle = ownerShapeStyle(pointOptions, pointSize, fillColor || '#FF0000', borderColor, borderSizeValue, borderWidth);
    } else {
        if (pointOptions.shape == "circle") {
            // Si taille bordure = 0 OU mode = none, pas de bordure du tout
            if (borderSizeValue == 0 || pointOptions.border.mode == "none") {
            pointStyle = {
            'circle-radius': pointSize,
                    'circle-fill-color': fillColor || '#FF0000',
            'circle-rotate-with-view': false,
            'circle-displacement': [0, 0],
            'circle-opacity': 1
            }
            } else {
                // Bordure avec épaisseur variable
                pointStyle = {
                    'circle-radius': pointSize,
                    'circle-fill-color': fillColor || '#FF0000',
                    'circle-stroke-color': borderColor || '#000000',
                    'circle-stroke-width': borderWidth,
                'circle-rotate-with-view': false,
                'circle-displacement': [0, 0],
                'circle-opacity': 1
                }
            }


    } else if (pointOptions.shape == "triangle") {
        // Si taille bordure = 0 OU mode = none, pas de bordure du tout
        if (borderSizeValue == 0 || pointOptions.border.mode == "none") {
        pointStyle = {
            'shape-points': 3,
            'shape-radius': pointSize,
            'shape-fill-color': fillColor || '#FF0000',
            'shape-rotate-with-view': true,
            }
        } else {
            // Bordure avec épaisseur variable
            pointStyle = {
            'shape-points': 3,
                'shape-radius': pointSize,
                'shape-fill-color': fillColor || '#FF0000',
                'shape-stroke-color': borderColor || '#000000',
                'shape-stroke-width': borderWidth,
            'shape-rotate-with-view': true,
            }
            }
        }

    }

    if (evolution) {
        if (poses) applyPosesColors(pointStyle, greyIconOffset);
        applyEvolutionTimeline(pointStyle, pointOptions);
        if (poses) applyPosesOpacity(pointStyle);
    } else if (owner) {
        applyMainPageTimeline(pointStyle, pointOptions, greyIconOffset);
    } else {
        // Avant l'apparition et la persistance, qui enveloppent ces valeurs :
        // les DNF en profitent comme les trouvailles.
        applyDnfStyle(pointStyle, pointOptions.mode == "icone" ? pointOptions.sprite : null);
        if (pointOptions.appearAnimation) {
            applyAppearAnimation(pointStyle);
        }
        if (Number(pointOptions.recentGlowDays) > 0) {
            applyRecentGlow(pointStyle);
        }
        // En dernier : multiplie les tailles et l'opacité déjà enveloppées.
        applyDnfVanish(pointStyle);
    }

    return pointStyle;
}

// Grisé (pstate) puis apparition, persistance et effacement de la carte
// principale, dans le même ordre que pour les trouvailles.
// Grisé plus soutenu que sur la page Mes poses : quelques caches posées
// parmi les trouvailles doivent rester repérables une fois archivées.
const OWNER_GREY = Object.freeze({
    disabledGrey: '#9e9e9e', disabledMix: 0.6,
    archivedGrey: '#8a8a8a', archivedMix: 0.8, archivedOpacity: 0.85,
});

function applyMainPageTimeline(pointStyle, pointOptions, greyIconOffset) {
    applyPosesColors(pointStyle, greyIconOffset, OWNER_GREY);
    if (pointOptions.appearAnimation) applyAppearAnimation(pointStyle);
    if (Number(pointOptions.recentGlowDays) > 0) applyRecentGlow(pointStyle);
    applyPosesOpacity(pointStyle, OWNER_GREY.archivedOpacity);
    applyDnfVanish(pointStyle);
}

// --- Caches posées (carte principale, owner_data.js) ------------------------
//
// pointOptions.owner = { shape, borderColor, borderWidth } (thème,
// points.owner_*, normalisé par owner_model.mjs). Une forme de même rayon
// paraît plus petite qu'un cercle : chaque forme a son facteur, pour un
// encombrement voisin.
const OWNER_SHAPE_GEOMETRY = {
    triangle: { points: 3, radius: 1.4, angle: 0 },
    square: { points: 4, radius: 1.3, angle: Math.PI / 4 },
    diamond: { points: 4, radius: 1.5, angle: 0 },
    star: { points: 5, radius: 1.9, radius2: 0.85, angle: 0 },
};

function ownerPointOptions(pointOptions) {
    return normalizeOwnerPoint(pointOptions?.owner);
}

function ownerShapeStyle(pointOptions, pointSize, fillColor, themeBorderColor, themeBorderSize, themeBorderWidth) {
    const own = ownerPointOptions(pointOptions);
    // « Comme les trouvailles » : forme du thème ; le contour reste le sien
    // s'il en a un, celui du thème sinon.
    const shape = own.shape === 'same' ? (pointOptions.shape === 'triangle' ? 'triangle' : 'circle') : own.shape;
    let stroke = null;
    if (own.borderWidth > 0) {
        stroke = { color: own.borderColor, width: own.borderWidth };
    } else if (own.shape === 'same' && themeBorderSize > 0 && pointOptions.border?.mode !== 'none') {
        stroke = { color: themeBorderColor || '#000000', width: themeBorderWidth };
    }
    if (shape === 'circle') {
        const style = { 'circle-radius': pointSize, 'circle-fill-color': fillColor, 'circle-rotate-with-view': false };
        if (stroke) Object.assign(style, { 'circle-stroke-color': stroke.color, 'circle-stroke-width': stroke.width });
        return style;
    }
    const geom = OWNER_SHAPE_GEOMETRY[shape];
    // La forme « same » d'un thème triangle garde ses proportions.
    const radiusFactor = own.shape === 'same' ? 1 : geom.radius;
    const style = {
        'shape-points': geom.points,
        'shape-radius': pointSize * radiusFactor,
        'shape-angle': geom.angle,
        'shape-fill-color': fillColor,
        'shape-rotate-with-view': false,
    };
    if (geom.radius2) style['shape-radius2'] = pointSize * geom.radius2;
    if (stroke) Object.assign(style, { 'shape-stroke-color': stroke.color, 'shape-stroke-width': stroke.width });
    return style;
}

// Anneau des caches posées en mode icônes : un disque à la couleur du
// contour, un peu plus grand que l'icône, dessiné dessous par sa propre
// couche (une icône WebGL n'a pas de contour). null : pas d'anneau (mode
// vectoriel, épaisseur nulle).
export function buildOwnerRingStyle(pointOptions) {
    if (pointOptions?.mode !== 'icone' || !pointOptions.sprite?.map) return null;
    const own = ownerPointOptions(pointOptions);
    if (own.borderWidth <= 0) return null;
    const iconPx = Math.max(1, parseInt(pointOptions.iconSize) || 24);
    const style = {
        'circle-radius': iconPx / 2 + own.borderWidth,
        'circle-fill-color': own.borderColor,
        'circle-rotate-with-view': false,
    };
    applyMainPageTimeline(style, pointOptions, null);
    return style;
}

// Points DNF (source_kind 'dnf', docs/logs-geocaching.md) : noirs en
// vectoriel — bordure blanche quand le thème en dessine une, pour rester
// visibles sur un fond sombre — et icône DNF en mode icônes, quel que soit
// leur type de cache (gardé tel quel pour les filtres).
export const DNF_FILL_COLOR = '#000000';
export const DNF_STROKE_COLOR = '#ffffff';
const IS_DNF = ['==', ['get', 'source_kind'], 'dnf'];

// Fin d'un DNF trouvé (mapgl.js, syncDnf) : l'attribut 'vanish' porte
// l'instant de départ sur l'horloge des points ; il vaut DNF_NOT_VANISHING
// pour tous les autres points. Même courbe que la disparition du mode
// Évolution : léger sursaut, rétrécissement jusqu'à zéro, fondu.
export const DNF_NOT_VANISHING = -1e9;
const VANISHING = ['>', ['get', 'vanish'], DNF_NOT_VANISHING / 10];
const VANISH_AGE = ['-', ['var', 'now'], ['get', 'vanish']];

function applyDnfVanish(pointStyle) {
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

function applyDnfStyle(pointStyle, sprite) {
    const forDnf = (key, value) => {
        if (key in pointStyle) pointStyle[key] = ['case', IS_DNF, value, pointStyle[key]];
    };
    forDnf('circle-fill-color', DNF_FILL_COLOR);
    forDnf('shape-fill-color', DNF_FILL_COLOR);
    forDnf('circle-stroke-color', DNF_STROKE_COLOR);
    forDnf('shape-stroke-color', DNF_STROKE_COLOR);
    const rect = sprite?.map?.dnf;
    if (rect) {
        forDnf('icon-offset', [rect.x, rect.y]);
        forDnf('icon-size', [rect.w, rect.h]);
    }
}

// Page Mes poses : état de chaque cache dans l'attribut 'pstate' (0 active,
// 1 désactivée, 2 archivée), réécrit les jours où il change. En vectoriel, la
// couleur du thème vire au gris (désactivée : gris franc, opacité pleine ;
// archivée : gris clair, à demi effacée) ; en icônes, l'icône de la rangée
// grisée de la feuille. Le type reste lisible sous le gris.
export const POSES_DISABLED_GREY = '#9e9e9e';
export const POSES_ARCHIVED_GREY = '#bdbdbd';
const POSES_DISABLED_MIX = 0.6;
const POSES_ARCHIVED_MIX = 0.85;
export const POSES_ARCHIVED_OPACITY = 0.55;
const PSTATE = ['get', 'pstate'];
const IS_DISABLED = ['==', PSTATE, 1];
const IS_ARCHIVED = ['==', PSTATE, 2];
const POSES_COLOR_KEYS = ['circle-fill-color', 'shape-fill-color', 'circle-stroke-color', 'shape-stroke-color'];

function mixColor(color, grey, amount) {
    return ['interpolate', ['linear'], amount, 0, color, 1, grey];
}

const POSES_GREY = Object.freeze({
    disabledGrey: POSES_DISABLED_GREY, disabledMix: POSES_DISABLED_MIX,
    archivedGrey: POSES_ARCHIVED_GREY, archivedMix: POSES_ARCHIVED_MIX,
});

function applyPosesColors(pointStyle, greyIconOffset, grey = POSES_GREY) {
    for (const key of POSES_COLOR_KEYS) {
        if (!(key in pointStyle)) continue;
        const color = pointStyle[key];
        // Couleur transparente (centre ou bordure « aucune ») : rien à griser.
        if (Array.isArray(color) && color.length === 4 && color.every((v) => v === 0)) continue;
        pointStyle[key] = ['case',
            IS_ARCHIVED, mixColor(color, grey.archivedGrey, grey.archivedMix),
            IS_DISABLED, mixColor(color, grey.disabledGrey, grey.disabledMix),
            color];
    }
    if (greyIconOffset && 'icon-offset' in pointStyle) {
        pointStyle['icon-offset'] = ['case', ['>', PSTATE, 0], greyIconOffset, pointStyle['icon-offset']];
    }
}

// Après applyEvolutionTimeline, qui pose l'opacité d'apparition/disparition.
function applyPosesOpacity(pointStyle, archivedOpacity = POSES_ARCHIVED_OPACITY) {
    const opacityKey = opacityKeyOf(pointStyle);
    if (!opacityKey) return;
    const factor = ['case', IS_ARCHIVED, archivedOpacity, 1];
    pointStyle[opacityKey] = opacityKey in pointStyle ? ['*', pointStyle[opacityKey], factor] : factor;
}

// Couleurs éclaircies par la persistance des points récents. La bordure est
// laissée telle quelle : c'est le point lui-même qui doit s'éclairer.
const GLOW_COLOR_KEYS = ['circle-fill-color', 'shape-fill-color'];

// Propriétés de taille (multipliées par l'échelle d'apparition) et d'opacité,
// selon le type de symbole du style.
const APPEAR_SIZE_KEYS = ['circle-radius', 'circle-stroke-width', 'shape-radius', 'shape-radius2', 'shape-stroke-width', 'icon-scale'];
const APPEAR_OPACITY_KEY = { circle: 'circle-opacity', shape: 'shape-opacity', icon: 'icon-opacity' };

// Ajoute l'apparition animée (voir point_appear.mjs) à un style de points. Les
// features doivent porter l'attribut numérique 'appear' et le layer la variable
// 'now' : c'est displayWebGLPoints() qui s'en charge.
function applyAppearAnimation(pointStyle) {
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = withAppearScale(pointStyle[key]);
    }
    const symbol = Object.keys(APPEAR_OPACITY_KEY).find((prefix) => `${prefix}-radius` in pointStyle || `${prefix}-src` in pointStyle);
    if (symbol) pointStyle[APPEAR_OPACITY_KEY[symbol]] = appearOpacityExpression();
}



function opacityKeyOf(pointStyle) {
    const symbol = Object.keys(APPEAR_OPACITY_KEY).find((prefix) => `${prefix}-radius` in pointStyle || `${prefix}-src` in pointStyle);
    return symbol ? APPEAR_OPACITY_KEY[symbol] : null;
}

// Mode Évolution : chaque point rétrécit et s'estompe à sa disparition ;
// l'apparition animée et la persistance des points récents, si elles sont
// activées dans le thème, se calculent sur l'âge déduit du jour courant.
function applyEvolutionTimeline(pointStyle, pointOptions) {
    const appear = Boolean(pointOptions.appearAnimation);
    if (Number(pointOptions.recentGlowDays) > 0) {
        for (const key of GLOW_COLOR_KEYS) {
            if (key in pointStyle) pointStyle[key] = withRecentGlowColor(pointStyle[key], POINT_APPEAR_MS, EVO_AGE);
        }
        for (const key of APPEAR_SIZE_KEYS) {
            if (key in pointStyle) pointStyle[key] = withRecentGlowScale(pointStyle[key], POINT_APPEAR_MS, EVO_AGE);
        }
    }
    const scale = appear
        ? ['*', disappearScaleExpression(), appearScaleExpression(POINT_APPEAR_MS, EVO_AGE)]
        : disappearScaleExpression();
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = ['*', pointStyle[key], scale];
    }
    const opacityKey = opacityKeyOf(pointStyle);
    if (opacityKey) {
        pointStyle[opacityKey] = appear
            ? ['*', disappearOpacityExpression(), appearOpacityExpression(POINT_APPEAR_MS, EVO_AGE)]
            : disappearOpacityExpression();
    }
}

// Ajoute la persistance des points récents (voir point_appear.mjs) : les points
// des derniers jours restent plus clairs et un peu plus gros. Repose sur les
// mêmes prérequis que l'apparition animée, plus la variable de style 'glowMs'
// (durée de la fenêtre en temps d'animation).
function applyRecentGlow(pointStyle) {
    for (const key of GLOW_COLOR_KEYS) {
        if (key in pointStyle) pointStyle[key] = withRecentGlowColor(pointStyle[key]);
    }
    for (const key of APPEAR_SIZE_KEYS) {
        if (key in pointStyle) pointStyle[key] = withRecentGlowScale(pointStyle[key]);
    }
}
