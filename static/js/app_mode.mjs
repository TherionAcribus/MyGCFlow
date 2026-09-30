// Mode de la page courante.
//
// L'application sert deux pages construites sur la même interface : le mode
// principal (« / », trouvailles importées depuis un GPX) et le mode Évolution
// (« /evolution », apparition et disparition des caches d'une zone importées
// depuis des CSV). Le serveur l'indique par l'attribut data-mode du <body> ;
// les deux jeux de données ne cohabitent jamais dans une même page.

export const MODE_MAIN = 'main';
export const MODE_EVOLUTION = 'evolution';

export function appMode(doc = globalThis.document) {
    const mode = doc?.body?.dataset?.mode;
    return mode === MODE_EVOLUTION ? MODE_EVOLUTION : MODE_MAIN;
}

export function isEvolutionPage(doc = globalThis.document) {
    return appMode(doc) === MODE_EVOLUTION;
}
