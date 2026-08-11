// Construction du style WebGLPoints de la couche de points.
//
// Extrait de mapgl.js. Fonction pure options -> objet de style ; sa seule
// dependance externe est la table plate des couleurs GC.
import { gcColorsFlat } from './gc_colors.js';

// Couleur totalement transparente, au format tableau [r, g, b, a] attendu par
// les expressions de style WebGL (le mot-clé CSS 'transparent' n'est pas
// reconnu par le parseur de couleurs d'OpenLayers).
const TRANSPARENT = [0, 0, 0, 0];
// Construit l'objet de style WebGLPoints (icône sprite ou cercle/triangle uni)
// à partir des options de points courantes. Le style WebGL est figé à la
// création du layer (il compile des shaders) : cette fonction n'est donc à
// appeler qu'à la (re)création du layer, jamais à chaque frame d'animation.
export function buildPointStyle(pointOptions) {
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

    return pointStyle;
}
