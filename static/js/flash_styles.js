// Styles OpenLayers des flashs de points : une fonction par forme.
//
// Extrait de mapgl.js. Fonctions pures (rayon, opacite, options, type de cache)
// -> ol.style.Style, sans aucun etat partage avec l'animation ou la capture.
// L'orchestration des flashs (flashRecord/flash/createFlashElements) reste dans
// mapgl.js : elle pilote animationLayer, lu et mute a plusieurs endroits de la
// boucle d'animation et du pipeline d'enregistrement.
import * as pkg from './index.js';
import { defaultGcColors } from './gc_colors.js';
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
