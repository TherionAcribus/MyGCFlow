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

// Champs du formulaire, dans l'ordre d'affichage.
export const FILTER_FORM_FIELDS = Object.freeze([
    'source_kind', 'cache_type', 'container', 'difficulty', 'terrain',
    'country', 'state', 'owner', 'attribute', 'published_year',
]);

function containerRank(value) {
    const i = CONTAINER_ORDER.findIndex((v) => v.toLowerCase() === String(value).toLowerCase());
    return i < 0 ? CONTAINER_ORDER.length : i;
}

// Valeurs d'un champ présentes dans la table, avec leur nombre de
// trouvailles : [{ value, count }]. Ordre : naturel pour ce qui en a un
// (D/T croissants, années décroissantes, contenants du plus petit au plus
// grand), sinon du plus fréquent au plus rare.
export function filterChoices(table, field) {
    const counts = new Map();
    const add = (value) => counts.set(value, (counts.get(value) || 0) + 1);
    for (let r = 0; r < table.n; r++) {
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
    const choices = [...counts].map(([value, count]) => ({ value, count }));
    const byCount = (a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value));
    if (field === 'difficulty' || field === 'terrain') choices.sort((a, b) => Number(a.value) - Number(b.value));
    else if (field === 'published_year') choices.sort((a, b) => Number(b.value) - Number(a.value));
    else if (field === 'container') choices.sort((a, b) => containerRank(a.value) - containerRank(b.value) || byCount(a, b));
    else if (field === 'source_kind') choices.sort((a, b) => SOURCE_KIND_VALUES.indexOf(a.value) - SOURCE_KIND_VALUES.indexOf(b.value));
    else choices.sort(byCount);
    return choices;
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
