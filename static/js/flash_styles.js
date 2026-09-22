// Styles OpenLayers des flashs de points : une fonction par forme.
//
// Extrait de mapgl.js. Fonctions pures (rayon, opacite, options, type de cache)
// -> ol.style.Style, sans aucun etat partage avec l'animation ou la capture.
// flashStyleAt() est le point d'entree de l'animation : il met ces styles en
// cache (voir flash_style_cache.mjs) pour ne pas rasteriser une forme par flash
// et par frame. L'orchestration des flashs (flashRecord/flashFeatures/
// drawActiveFlashes/createFlashElements) reste dans
// mapgl.js : elle pilote animationLayer, lu et mute a plusieurs endroits de la
// boucle d'animation et du pipeline d'enregistrement.
import * as pkg from './index.js';
import { defaultGcColors } from './gc_colors.js';
import { createFlashStyleCache } from './flash_style_cache.mjs';
import { impulseFrame } from './flash_impulse.mjs';

const flashStyleCache = createFlashStyleCache();

// Composantes RGB de la couleur d'un flash impulsion. 'none' (transparent)
// garde une impulsion blanche : sans couleur, l'effet n'aurait plus rien à montrer.
function impulseRgb(flashOptions, cacheType) {
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        const gcColor = defaultGcColors[cacheType];
        const rgb = gcColor && gcColor.startsWith('#') ? pkg.hexToRgb(gcColor) : null;
        return rgb || { r: 128, g: 128, b: 128 };
    }
    if (flashOptions.color_type === 'none') return { r: 255, g: 255, b: 255 };
    return flashOptions.rgb;
}

// Sprite du halo, dessiné une seule fois par couleur : un cœur blanc qui vire à
// la couleur du flash puis s'évanouit. Chaque frame n'en change que l'échelle et
// l'opacité, sans le redessiner.
const HALO_SPRITE_SIZE = 128;
const haloSprites = new Map();

function haloSprite({ r, g, b }) {
    const key = `${r},${g},${b}`;
    let canvas = haloSprites.get(key);
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = HALO_SPRITE_SIZE;
    const ctx = canvas.getContext('2d');
    const c = HALO_SPRITE_SIZE / 2;
    const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.18, `rgba(${r}, ${g}, ${b}, 0.95)`);
    gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.4)`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, HALO_SPRITE_SIZE, HALO_SPRITE_SIZE);
    haloSprites.set(key, canvas);
    return canvas;
}

function impulseStyles(frame, flashOptions, cacheType) {
    const rgb = impulseRgb(flashOptions, cacheType);
    return [
        new ol.style.Style({
            image: new ol.style.Icon({
                img: haloSprite(rgb),
                scale: (2 * frame.haloRadius) / HALO_SPRITE_SIZE,
                opacity: frame.haloOpacity,
            }),
        }),
        new ol.style.Style({
            image: new ol.style.Circle({
                radius: frame.ringRadius,
                stroke: new ol.style.Stroke({
                    color: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${frame.ringOpacity})`,
                    width: frame.ringWidth,
                }),
            }),
        }),
    ];
}

// Base de couleur effectivement utilisée par les fonctions de style ci-dessous,
// en reprenant exactement leur ordre de décision (un mode 'gc' sans type de cache
// ou sans table GC chargée retombe sur la couleur fixe). Elle entre dans la clé
// du cache : changer la couleur en cours d'animation produit donc de nouveaux
// styles au lieu de réutiliser les anciens.
function flashColorKey(flashOptions, cacheType) {
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        return 'gc:' + (defaultGcColors[cacheType] ?? '');
    }
    if (flashOptions.color_type === 'none') return 'none';
    const rgb = flashOptions.rgb;
    return `fix:${rgb?.r},${rgb?.g},${rgb?.b}`;
}

// Mémoire approximative du canvas rastérisé : carré englobant la forme et son
// contour, à la densité de l'écran.
function estimateFlashStyleBytes(radius) {
    const side = Math.ceil((2 * radius + 6) * (window.devicePixelRatio || 1));
    return side * side * 4;
}

// Style d'un flash au pas `step` sur `steps` (0 = apparition). Les réglages
// (forme, taille, couleur) sont relus à chaque appel, comme avant : un changement
// en cours d'animation s'applique aux flashs déjà lancés. Seule la rastérisation
// est mise en cache.
// Pour le mode 'impulse', renvoie un tableau de styles (halo puis anneau) à
// dessiner dans cet ordre.
export function flashStyleAt(step, steps, flashOptions, cacheType = null) {
    const ratio = step / steps;
    const mode = flashOptions.mode;
    const size = flashOptions.size;
    const key = `${mode}|${size}|${flashColorKey(flashOptions, cacheType)}|${ratio}`;
    return flashStyleCache.get(key, () => {
        if (mode === 'impulse') {
            const frame = impulseFrame(ratio, size);
            return {
                value: impulseStyles(frame, flashOptions, cacheType),
                bytes: estimateFlashStyleBytes(frame.ringRadius),
            };
        }
        const radius = ol.easing.easeOut(ratio) * (size / 2) + (size / 10);
        const opacity = ol.easing.easeOut(1 - ratio);
        const build = FLASH_STYLE_BUILDERS[mode] || circleStyle;
        return {
            value: build(radius, opacity, flashOptions, cacheType),
            bytes: estimateFlashStyleBytes(radius),
        };
    });
}

export function starStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            const rgb = pkg.hexToRgb(gcColor);
            color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 5, // 5 points pour une étoile
            radius: radius, // Rayon extérieur
            radius2: radius / 2, // Rayon intérieur (pour la forme de l'étoile)
            angle: 0, // Angle initial de l'étoile
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`, // Contour noir avec l'opacité calculée
                width: 2, // Largeur du contour
            }),
            fill: new ol.style.Fill({
                color: color, // Remplissage avec la couleur déterminée
            }),
        }),
    });
    return style;
}

// Scintillement : étoile fine à 4 branches avec un éclat blanc, pour un effet
// d'étincelle qui brille à l'apparition du point. Utilise les mêmes réglages que
// les autres flashs (taille, durée, couleur).
export function sparkleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné (même logique que les autres flashs)
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            if (gcColor.startsWith('#')) {
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                color = gcColor;
            }
        } else {
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        color = `rgba(0, 0, 0, 0)`;
    } else {
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,                 // 4 branches = forme d'étincelle
            radius: radius,            // rayon extérieur (pointe des branches)
            radius2: radius * 0.18,    // rayon intérieur faible = branches fines et pointues
            angle: 0,
            fill: new ol.style.Fill({
                color: color,
            }),
            stroke: new ol.style.Stroke({
                color: `rgba(255, 255, 255, ${opacity})`, // éclat blanc lumineux
                width: 1.5,
            }),
        }),
    });
    return style;
}

export function circleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.Circle({
            radius: radius,
            stroke: new ol.style.Stroke({
                color: color,
                width: 2,
            }),
        }),
    });
    return style;
}

export function squareStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,
            radius: radius,
            angle: Math.PI / 4, // Rotation de 45° pour un carré aligné
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}

export function triangleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 3,
            radius: radius,
            angle: 0,
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}

export function diamondStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,
            radius: radius,
            angle: 0, // Losange pointant vers le haut
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}

// Forme de flash -> fonction de style. Un mode inconnu retombe sur le cercle.
const FLASH_STYLE_BUILDERS = {
    star: starStyle,
    sparkle: sparkleStyle,
    circle: circleStyle,
    square: squareStyle,
    triangle: triangleStyle,
    diamond: diamondStyle,
};
