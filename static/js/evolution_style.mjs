// Visibilité, apparition et disparition des points du mode Évolution,
// calculées par la carte graphique.
//
// En mode Évolution, toutes les caches filtrées sont ajoutées UNE SEULE FOIS à
// la couche WebGLPoints, chacune avec son jour de placement ('placedDay'), son
// jour d'archivage ('archivedDay', EVO_NEVER_DAY si elle n'en a pas) et son
// décalage de vague ('stagger', ms, mode impulsion). Ajouter ou modifier des
// features pendant l'animation obligerait OpenLayers à reconstruire les
// buffers de TOUS les points à chaque jour : intenable au-delà de quelques
// dizaines de milliers de caches. Seules des variables de style changent
// donc pendant l'animation :
//
//   evoDay      jour courant (index depuis l'origine du jeu de données) ;
//   evoIntraMs  temps d'animation écoulé depuis que evoDay est devenu courant ;
//   evoFrom     premier jour animé : ce qui précède est dessiné sans animation ;
//   evoMsPerDay durée d'un jour, dans l'unité de l'horloge des points ;
//   evoStagger  1 si le décalage de vague (mode impulsion) s'applique, 0 sinon.
//
// Les valeurs restent petites (index de jours < 1e5, durées de l'ordre de la
// seconde) : pas d'horloge absolue dans le shader, donc pas de perte de
// précision en float32.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Jour d'archivage des caches qui ne disparaissent jamais (actives, ou
// archivées sans date connue).
export const EVO_NEVER_DAY = 1e6;
// evoFrom hors animation : tous les points sont dessinés dans leur état final.
export const EVO_STATIC_FROM = 2e6;
// Âge attribué aux points dessinés sans animation : bien au-delà de toute durée
// d'effet (apparition, disparition, persistance des points récents).
export const EVO_STATIC_MS = 1e8;
// Durée de la disparition d'un point (rétrécissement + fondu).
export const POINT_DISAPPEAR_MS = 450;

// Noms des variables de style utilisées par les expressions ci-dessous.
export const EVO_STYLE_VARIABLES = Object.freeze(['evoDay', 'evoIntraMs', 'evoFrom', 'evoMsPerDay', 'evoStagger']);

const v = (name) => ['var', name];
const g = (name) => ['get', name];

// Temps écoulé depuis l'apparition du point (ms). Négatif tant que le décalage
// de vague n'est pas écoulé : le point reste alors invisible.
export const EVO_AGE = ['case',
    ['<', g('placedDay'), v('evoFrom')], EVO_STATIC_MS,
    ['-',
        ['+', ['*', ['-', v('evoDay'), g('placedDay')], v('evoMsPerDay')], v('evoIntraMs')],
        ['*', g('stagger'), v('evoStagger')]]];

// Temps écoulé depuis la disparition du point (ms) ; -1 tant qu'il est actif.
export const EVO_GONE = ['case',
    ['>', g('archivedDay'), v('evoDay')], -1,
    ['<', g('archivedDay'), v('evoFrom')], EVO_STATIC_MS,
    ['+', ['*', ['-', v('evoDay'), g('archivedDay')], v('evoMsPerDay')], v('evoIntraMs')]];

// Filtre de la couche : un point est dessiné (et cliquable) une fois placé et
// jusqu'à la fin de sa disparition.
export const EVO_FILTER = ['all',
    ['<=', g('placedDay'), v('evoDay')],
    ['<', EVO_GONE, POINT_DISAPPEAR_MS]];

// Disparition : léger sursaut puis rétrécissement jusqu'à zéro, avec fondu.
export function disappearScaleExpression(durationMs = POINT_DISAPPEAR_MS) {
    return ['interpolate', ['linear'], EVO_GONE,
        0, 1,
        0.3 * durationMs, 1.2,
        durationMs, 0];
}

export function disappearOpacityExpression(durationMs = POINT_DISAPPEAR_MS) {
    return ['interpolate', ['linear'], EVO_GONE,
        0, 1,
        durationMs, 0];
}

// Valeurs des variables pour dessiner l'état final d'un jour donné, hors
// animation (carte au repos).
export function staticEvolutionVariables(restDay) {
    return {
        evoDay: Number.isFinite(restDay) ? restDay : 0,
        evoIntraMs: 0,
        evoFrom: EVO_STATIC_FROM,
        evoMsPerDay: 1,
        evoStagger: 0,
    };
}
