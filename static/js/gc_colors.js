// Couleurs officielles Geocaching par type de cache.
//
// Extrait de mapgl.js. Source unique consommée par deux rendus distincts :
// les styles de points WebGL (expressions 'match', d'ou le tableau a plat) et
// les styles de flash (lookup par type).
//
// `defaultGcColors` et `gcColorsFlat` sont exportes en `let` : les modules qui
// les importent beneficient de la liaison vivante d'ES modules et voient donc
// le remplissage fait ici par requetedefaultGcColors(), sans accesseur et sans
// changer la forme du code appelant.
import * as pkg from './index.js';
import { CONFIG } from './init.js';

const DEBUG_GC_COLORS = false;
const dbgMapgl = (...args) => { if (DEBUG_GC_COLORS) console.log(...args); };

// couleurs GC par défaut
export let defaultGcColors;
// Tableau à plat des couleurs GC précalculé pour les expressions WebGL 'match'
// Évite de recalculer Object.entries().flat() à chaque appel de displayWebGLPoints
export let gcColorsFlat = [];
// récupère les couleurs GC par défaut dans le JSON
// (permet d'être facilement modifiable contrairement à un dict en dur)
export async function requetedefaultGcColors(){
    try {
        const response = await fetch(`${CONFIG.BASE_URL}/static/json/defaultGcColors.json`);
        if (!response.ok) {
            const errorMsg = `Erreur lors du chargement des couleurs GC (${response.status}): ${response.statusText}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
        defaultGcColors = await response.json();
        dbgMapgl('🎨 Couleurs GC chargées avec succès:', defaultGcColors);
        dbgMapgl('🎨 Test hexToRgb avec #008000:', pkg.hexToRgb('#008000'));
        dbgMapgl('🎨 Toutes les clés disponibles:', Object.keys(defaultGcColors));
    } catch (error) {
        console.error('Erreur lors du chargement des couleurs GC:', error);
        // Utiliser des couleurs par défaut en cas d'erreur
        defaultGcColors = {
            'Traditional Cache': '#008000',
            'Multi-cache': '#FFA500',
            'Mystery Cache': '#0000FF',
            'EarthCache': '#87CEEB',
            'Letterbox Hybrid': '#0000FF',
            'Event Cache': '#FF0000',
            'Unknown Cache': '#0000FF',
            'Wherigo Cache': '#0000FF',
            'Virtual Cache': '#87CEEB',
            'Webcam Cache': '#87CEEB',
            'Giga-Event Cache': '#FF0000',
            'Mega-Event Cache': '#FF0000',
            'Cache In Trash Out Event': '#FF0000',
            'Community Celebration Event': '#FF0000',
            'GPS Adventures Exhibit': '#FF0000',
            'Locationless (Reverse) Cache': '#FFFFFF'
        };
        console.warn('Utilisation des couleurs GC par défaut suite à une erreur de chargement');
    }
    gcColorsFlat = Object.entries(defaultGcColors).flat();
}
