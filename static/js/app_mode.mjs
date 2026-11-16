// Mode de la page courante.
//
// L'application sert quatre pages construites sur la même interface :
// - le mode principal (« / », trouvailles importées depuis un GPX) ;
// - le mode Évolution (« /evolution », apparition et disparition des caches
//   d'une zone importées depuis des CSV) ;
// - « Mes poses » (« /poses », vie des caches posées par le joueur, tirée de
//   ses logs importés) ;
// - « Parcours » (« /parcours », une journée ou des vacances rejouées cache
//   par cache, ordre et heures reconstruits — MyGCFlow_Plan_Parcours.md).
// Le serveur l'indique par l'attribut data-mode du <body> ; les jeux de
// données ne cohabitent jamais dans une même page.
//
// Évolution et Mes poses partagent le même moteur d'animation (« cycle de
// vie ») : points ajoutés une fois, visibilité décidée par le shader selon le
// jour, plusieurs jours par image, ni caméra, ni trajet, ni DNF. Les branches
// qui tiennent à ce moteur testent isLifecyclePage() ; celles qui tiennent aux
// bases CSV restent sur isEvolutionPage().
//
// Module feuille : aucune dépendance, évaluable avant tout autre module
// (cf. AGENTS.md, ordre d'évaluation des modules).

export const MODE_MAIN = 'main';
export const MODE_EVOLUTION = 'evolution';
export const MODE_POSES = 'poses';
export const MODE_PARCOURS = 'parcours';
export const APP_MODES = Object.freeze([MODE_MAIN, MODE_EVOLUTION, MODE_POSES, MODE_PARCOURS]);

// Valeur inconnue ou absente : mode principal (comportement historique).
export function appMode(doc = globalThis.document) {
    const mode = doc?.body?.dataset?.mode;
    return APP_MODES.includes(mode) ? mode : MODE_MAIN;
}

export function isMainPage(doc = globalThis.document) {
    return appMode(doc) === MODE_MAIN;
}

export function isEvolutionPage(doc = globalThis.document) {
    return appMode(doc) === MODE_EVOLUTION;
}

export function isPosesPage(doc = globalThis.document) {
    return appMode(doc) === MODE_POSES;
}

export function isParcoursPage(doc = globalThis.document) {
    return appMode(doc) === MODE_PARCOURS;
}

// Pages animées par le moteur « cycle de vie » (Évolution, Mes poses). Liste
// explicite : le Parcours n'en fait pas partie (son horloge avance d'étape
// en étape, pas de jour en jour).
const LIFECYCLE_MODES = Object.freeze([MODE_EVOLUTION, MODE_POSES]);
export function isLifecyclePage(doc = globalThis.document) {
    return LIFECYCLE_MODES.includes(appMode(doc));
}

// Mode désigné par un argument d'appel : un nom de mode, ou l'ancien booléen
// « page Évolution ? » des helpers d'avant le 3e mode (true → evolution,
// false/absent → main). Un nom inconnu retombe sur le mode principal.
export function modeOf(value) {
    if (value === true) return MODE_EVOLUTION;
    return APP_MODES.includes(value) ? value : MODE_MAIN;
}

// Valeur propre à la page : map[mode] (mode = celui de la page courante, ou
// celui passé en argument), repli sur map.main.
export function perPage(map, mode = appMode()) {
    const key = modeOf(mode);
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : map[MODE_MAIN];
}
