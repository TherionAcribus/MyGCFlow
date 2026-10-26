// Modèles de la ligne d'infos : texte libre + balises remplacées par les
// valeurs courantes. Aucune dépendance au DOM : logique pure, testable.
//
// Mode Évolution — {date}      : date affichée (texte de #spanCurrentDate) ;
//                  {actives}   : caches présentes à la date courante ;
//                  {placees}   : cumul des caches placées depuis le début ;
//                  {archivees} : cumul des caches archivées depuis le début ;
//                  {total}     : taille de la sélection, constante.
// Mode principal — {date}      : date affichée ;
//                  {trouvees}  : compteur courant de caches trouvées ;
//                  {total}     : taille de la sélection ;
//                  {pct}       : trouvées / total en pourcentage (« 42 % ») ;
//                  {dnf}       : cumul des tentatives DNF à la date ;
//                  {dnf_resolus} : cumul des DNF résolus par une trouvaille.
// Mes poses      — {date}, {total} ;
//                  {actives}   : caches posées non archivées à la date ;
//                  {posees}    : cumul des caches apparues ;
//                  {archivees} : caches archivées À LA DATE (une cache
//                                désarchivée en sort : actives + archivees
//                                = posees), contrairement au cumul d'Évolution ;
//                  {desactivees} : caches désactivées à la date ;
//                  {trouvailles}, {favoris}, {dnf}, {logs} : cumuls reçus ;
//                  {trouveurs} : joueurs distincts ayant trouvé une cache.

import { WIDEST_DATE } from './infos_reserve.mjs';

// Modèle par défaut du mode Évolution, identique à la ligne historique
// « date · compteur » et à la préférence `evolution_infos_template` côté
// serveur (settings.json).
export const DEFAULT_EVOLUTION_TEMPLATE = '{date} · {actives}';
// Modèle par défaut de Mes poses (préférence `poses_infos_template`).
export const DEFAULT_POSES_TEMPLATE = '{date} · {actives} · {trouvailles}';

// Balises reconnues par mode, dans l'ordre où l'onglet Infos les propose.
// Une balise d'un autre mode reste littérale chez soi : l'utilisateur voit
// sa faute de frappe plutôt qu'un trou dans la ligne.
export const EVOLUTION_INFO_TAGS = ['date', 'actives', 'placees', 'archivees', 'total'];
export const MAIN_INFO_TAGS = ['date', 'trouvees', 'total', 'pct', 'dnf', 'dnf_resolus'];
export const POSES_INFO_TAGS = [
    'date', 'actives', 'posees', 'archivees', 'desactivees',
    'trouvailles', 'favoris', 'dnf', 'logs', 'trouveurs', 'total',
];

// {tag} : insensible à la casse, espaces tolérés autour du nom ({ ACTIVES }).
// Le motif est construit par mode (voir renderInfosTemplate).
const patternByTags = new Map();
function tagPattern(tags) {
    const key = tags.join('|');
    if (!patternByTags.has(key)) {
        patternByTags.set(key, new RegExp(`\\{\\s*(${key})\\s*\\}`, 'gi'));
    }
    return patternByTags.get(key);
}

// Remplace les balises reconnues (paramètre `tags`) par les valeurs courantes.
// Les accolades inconnues ({nom}, balise d'un autre mode…) restent littérales.
export function renderInfosTemplate(template, values = {}, tags = EVOLUTION_INFO_TAGS) {
    return String(template ?? '').replace(
        tagPattern(tags),
        (match, tag) => String(values[tag.toLowerCase()] ?? ''),
    );
}

// Texte de réserve : le même modèle rendu avec les plus grandes valeurs à
// venir, pour figer la largeur de la cartouche (même rôle que
// reservedInfosText dans infos_reserve.mjs). `maxValues` donne le maximum de
// chaque balise autre que {date}, qui prend la plus large date possible.
export function reservedInfosTemplateText(template, maxValues = {}, tags = EVOLUTION_INFO_TAGS) {
    const widest = { date: WIDEST_DATE };
    for (const tag of tags) {
        if (tag === 'date') continue;
        widest[tag] = String(maxValues[tag] ?? 0);
    }
    return renderInfosTemplate(template, widest, tags);
}
