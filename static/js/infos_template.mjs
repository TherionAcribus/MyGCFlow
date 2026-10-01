// Modèle de la ligne d'infos du mode Évolution : texte libre + balises
// remplacées par les valeurs courantes ({date}, {actives}, {placees},
// {archivees}, {total}). Aucune dépendance au DOM : logique pure, testable.
//
// - {date}      : date affichée (texte de #spanCurrentDate) ;
// - {actives}   : caches présentes à la date courante (monte et descend) ;
// - {placees}   : cumul des caches placées depuis le début ;
// - {archivees} : cumul des caches archivées depuis le début ;
// - {total}     : taille de la sélection, constante pendant l'animation.

import { WIDEST_DATE } from './infos_reserve.mjs';

// Modèle par défaut, identique à la ligne historique « date · compteur » et
// à la préférence `evolution_infos_template` côté serveur (settings.json).
export const DEFAULT_EVOLUTION_TEMPLATE = '{date} · {actives}';

// Balises reconnues, dans l'ordre où l'onglet Infos les propose.
export const EVOLUTION_INFO_TAGS = ['date', 'actives', 'placees', 'archivees', 'total'];

// Balises numériques : pour la réserve de largeur elles prennent leur valeur
// maximale à venir ; {date} prend la plus large des dates possibles.
const NUMERIC_TAGS = ['actives', 'placees', 'archivees', 'total'];

// {tag} : insensible à la casse, espaces tolérés autour du nom ({ ACTIVES }).
const TAG_PATTERN = /\{\s*(date|actives|placees|archivees|total)\s*\}/gi;

// Remplace les balises connues par les valeurs courantes. Les accolades
// inconnues ({nom}, {archive}…) restent littérales : l'utilisateur voit sa
// faute de frappe plutôt qu'un trou dans la ligne.
export function renderInfosTemplate(template, values = {}) {
    return String(template ?? '').replace(
        TAG_PATTERN,
        (match, tag) => String(values[tag.toLowerCase()] ?? ''),
    );
}

// Texte de réserve : le même modèle rendu avec les plus grandes valeurs à
// venir, pour figer la largeur de la cartouche (même rôle que
// reservedInfosText dans infos_reserve.mjs).
export function reservedInfosTemplateText(template, maxValues = {}) {
    const widest = { date: WIDEST_DATE };
    for (const tag of NUMERIC_TAGS) {
        widest[tag] = String(maxValues[tag] ?? 0);
    }
    return renderInfosTemplate(template, widest);
}
