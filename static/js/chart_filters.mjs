// Filtres de la page Statistiques : valeurs proposées par champ, résumé des
// filtres actifs. Module pur (ni DOM ni Tom Select), testé par
// tests/js/chart_filters.test.mjs. Le formulaire lui-même vit dans
// stats_filters_ui.js ; l'application des filtres, dans chart_query.mjs
// (filterMask).
//
// Format (chart_spec.mjs › normalizeFilters) : { champ: [valeurs] }. Une
// sélection vide est neutre ; plusieurs valeurs d'un champ = « l'une ou
// l'autre », sauf les attributs (tous requis), comme sur la carte.

import { CONTAINER_ORDER } from './stats_model.mjs';
import { DICT_FIELDS, SOURCE_KIND_VALUES } from './chart_sources.mjs';
import { FILTER_FIELDS, normalizeFilters } from './chart_spec.mjs';
import { filterMask } from './chart_query.mjs';

// Champs du formulaire, dans l'ordre d'affichage.
export const FILTER_FORM_FIELDS = Object.freeze([
    'source_kind', 'cache_type', 'container', 'difficulty', 'terrain',
    'country', 'state', 'county', 'owner', 'cache', 'finder', 'attribute', 'published_year',
]);

// Rubriques du formulaire : la cache, le lieu, les personnes. Chaque champ
// de FILTER_FORM_FIELDS figure dans une seule rubrique.
export const FILTER_FORM_GROUPS = Object.freeze([
    Object.freeze({ id: 'cache', fields: Object.freeze(['source_kind', 'cache_type', 'container', 'difficulty', 'terrain', 'attribute', 'published_year', 'cache']) }),
    Object.freeze({ id: 'place', fields: Object.freeze(['country', 'state', 'county']) }),
    Object.freeze({ id: 'people', fields: Object.freeze(['owner', 'finder']) }),
]);

function containerRank(value) {
    const i = CONTAINER_ORDER.findIndex((v) => v.toLowerCase() === String(value).toLowerCase());
    return i < 0 ? CONTAINER_ORDER.length : i;
}

// Nombre de lignes par valeur d'un champ dans une table — seulement les
// lignes retenues par tous les masques de `masks`.
function countValues(table, field, masks = []) {
    const counts = new Map();
    const add = (value) => counts.set(value, (counts.get(value) || 0) + 1);
    for (let r = 0; r < table.n; r++) {
        if (masks.length && !masks.every((mask) => mask[r])) continue;
        if (field === 'source_kind') add(SOURCE_KIND_VALUES[table.kind[r]]);
        else if (DICT_FIELDS.includes(field)) {
            const idx = table[field][r];
            if (idx >= 0) add(table.dicts[field][idx]);
        } else if (field === 'difficulty' || field === 'terrain') {
            if (!Number.isNaN(table[field][r])) add(String(table[field][r]));
        } else if (field === 'published_year') {
            if (table.publishedYear[r]) add(String(table.publishedYear[r]));
        } else if (field === 'attribute') {
            for (const idx of table.attributes[r]) {
                const key = table.dicts.attribute[idx]?.key;
                if (key !== undefined) add(key);
            }
        }
    }
    return counts;
}

// Valeurs d'un champ présentes dans une ou plusieurs tables (les sources
// d'un tableau de bord), avec leur nombre de lignes : [{ value, count }].
// Ordre : naturel pour ce qui en a un (D/T croissants, années
// décroissantes, contenants du plus petit au plus grand), sinon du plus
// fréquent au plus rare.
export function filterChoices(tables, field) {
    const counts = new Map();
    for (const table of Array.isArray(tables) ? tables : [tables]) {
        if (!table) continue;
        for (const [value, count] of countValues(table, field)) counts.set(value, (counts.get(value) || 0) + count);
    }
    const choices = [...counts].map(([value, count]) => ({ value, count }));
    const byCount = (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value));
    if (field === 'difficulty' || field === 'terrain') choices.sort((a, b) => Number(a.value) - Number(b.value));
    else if (field === 'published_year') choices.sort((a, b) => Number(b.value) - Number(a.value));
    else if (field === 'container') choices.sort((a, b) => containerRank(a.value) - containerRank(b.value) || byCount(a, b));
    else if (field === 'source_kind') choices.sort((a, b) => SOURCE_KIND_VALUES.indexOf(a.value) - SOURCE_KIND_VALUES.indexOf(b.value));
    else choices.sort(byCount);
    return choices;
}

// Comptes « à facettes » : pour chaque champ, le nombre de lignes par
// valeur sous les filtres des AUTRES champs — ce qu'on obtiendrait en
// cochant aussi cette valeur (les valeurs d'un champ s'ajoutent les unes
// aux autres). Les attributs, tous requis, se comptent sous tous les
// filtres, les leurs compris. Résultat : Map champ → Map valeur → nombre ;
// une valeur absente compte 0.
export function filterFacets(tables, filters, fields = FILTER_FORM_FIELDS) {
    const list = (Array.isArray(tables) ? tables : [tables]).filter(Boolean);
    const active = Object.entries(cleanFilters(filters));
    // Un masque par champ filtré et par table, combinés ensuite.
    const masks = list.map((table) => active.map(([field, values]) => [field, filterMask(table, { [field]: values })]));
    const out = new Map();
    for (const field of fields) {
        const counts = new Map();
        list.forEach((table, i) => {
            const others = masks[i].filter(([f]) => f !== field || field === 'attribute').map(([, mask]) => mask);
            for (const [value, count] of countValues(table, field, others)) counts.set(value, (counts.get(value) || 0) + count);
        });
        out.set(field, counts);
    }
    return out;
}

// Lignes d'une table retenues par les filtres.
export function matchingCount(table, filters) {
    if (!table) return 0;
    const mask = filterMask(table, cleanFilters(filters));
    let n = 0;
    for (let r = 0; r < table.n; r++) n += mask[r];
    return n;
}

// Nombre de champs filtrés.
export function activeFilterCount(filters) {
    if (!filters) return 0;
    return FILTER_FIELDS.filter((field) => Array.isArray(filters[field]) && filters[field].length).length;
}

// Résumé lisible : [{ field, values: [libellés] }], dans l'ordre du
// formulaire. `valueLabel(field, value)` nomme une valeur.
export function describeFilters(filters, valueLabel = (field, value) => value) {
    if (!filters) return [];
    return FILTER_FORM_FIELDS
        .filter((field) => Array.isArray(filters[field]) && filters[field].length)
        .map((field) => ({ field, values: filters[field].map((value) => valueLabel(field, value)) }));
}

// Filtres lus d'un formulaire ({ champ: [valeurs] }, listes vides
// comprises) → format normalisé, sans les listes vides.
export function cleanFilters(raw) {
    return normalizeFilters(raw || {}) || {};
}
