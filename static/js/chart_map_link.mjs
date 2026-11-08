// Retour à la carte : un clic sur une barre (une part, un point) d'un
// graphique de trouvailles → la sélection de filtres de la page « Mes
// Géocaches » qui montre exactement ces trouvailles. Module pur, testé par
// tests/js/chart_map_link.test.mjs.
//
// La page carte relit sa sélection dans localStorage « filtersSelection »
// au chargement (ui.js › restoreSelectedValues) et l'applique (filtres
// « Données »). Forme utilisée ici :
//   type, container, difficulty, terrain   listes exclusives (absente = tout)
//   countries + countries_excluded         pays retenus / écartés
//   owners, attributes                     listes inclusives
//   dates, published_dates                 { startDate, endDate } ISO
// Une clé absente garde le réglage par défaut de la carte (tout coché).
// Les types de points affichés (géocaches / Labs) ne sont pas dans cette
// sélection mais dans la préférence globale `main_discovery_sources` :
// `discoveryModeFor` donne le mode à poser.
//
// Seules les trouvailles ont une carte filtrable ainsi : DNF, caches posées,
// Mes poses et Évolution n'ont pas de sélection persistée — pas de lien.

import { OTHERS_KEY, UNKNOWN_KEY, ymdOfDay } from './stats_model.mjs';
import { chartSources } from './chart_spec.mjs';
import { ABSENT, cyclicBounds, timeKeyBounds, unitIndexOfDay, unitStartDay } from './chart_query.mjs';

const pad = (n) => String(n).padStart(2, '0');
export function isoOfDay(day) {
    const { y, m, d } = ymdOfDay(day);
    return `${y}-${pad(m)}-${pad(d)}`;
}

// Listes exclusives de la carte et champ correspondant des graphiques.
const EXCLUSIVE = { cache_type: 'type', container: 'container', difficulty: 'difficulty', terrain: 'terrain' };
const INCLUSIVE = { owner: 'owners', attribute: 'attributes' };
// Option « Non renseigné » des filtres pays / région de la carte
// (UNKNOWN_GEO de geojson_cache.py) : écartée dès qu'un pays est choisi.
export const UNKNOWN_GEO = '__unknown__';
const excludedCountries = (state) => [
    ...state.countries.filter((c) => !state.selection.countries.includes(c)), UNKNOWN_GEO,
];

function intersectRange(range, lo, hi) {
    return [Math.max(range[0], lo), Math.min(range[1], hi)];
}

// Restreint une liste exclusive (ou inclusive) à `values` : intersection
// avec ce qui est déjà posé.
function restrict(selection, key, values) {
    const current = selection[key];
    selection[key] = Array.isArray(current) ? current.filter((v) => values.includes(v)) : [...values];
}

// Les Labs n'ont ni taille, ni difficulté, ni attributs, et un seul type
// (« Adventure Lab ») : une valeur de ces dimensions désigne l'un ou l'autre
// type de points.
export const LAB_CACHE_TYPE = 'Adventure Lab';
const GEOCACHE_ONLY = new Set(['container', 'difficulty', 'terrain', 'dt', 'attribute']);
function restrictKinds(state, kinds) {
    state.kinds = state.kinds ? state.kinds.filter((k) => kinds.includes(k)) : [...kinds];
}

// Une valeur d'une dimension → la sélection. false : dimension sans
// équivalent sur la carte (jour de la semaine, âge, région…).
function applyDimension(state, dim, key, { result, series, keyIndex = null }) {
    if (key === OTHERS_KEY || key === UNKNOWN_KEY) return false;
    const { selection } = state;
    if (dim === 'cache_type') restrictKinds(state, [key === LAB_CACHE_TYPE ? 'lab' : 'geocache']);
    if (GEOCACHE_ONLY.has(dim)) restrictKinds(state, ['geocache']);
    if (EXCLUSIVE[dim]) {
        restrict(selection, EXCLUSIVE[dim], [String(key)]);
        return true;
    }
    if (INCLUSIVE[dim]) {
        restrict(selection, INCLUSIVE[dim], [String(key)]);
        return true;
    }
    switch (dim) {
        case 'none':
            return true;
        case 'dt': {
            const [d, t] = String(key).split('|');
            restrict(selection, 'difficulty', [d]);
            restrict(selection, 'terrain', [t]);
            return true;
        }
        case 'country':
            restrict(selection, 'countries', [String(key)]);
            selection.countries_excluded = excludedCountries(state);
            return true;
        case 'published_year':
            selection.published_dates = { startDate: `${key}-01-01`, endDate: `${key}-12-31` };
            return true;
        case 'year':
        case 'quarter':
        case 'month':
        case 'week':
        case 'day': {
            if (keyIndex !== null && result.align === 'elapsed') {
                const start = series.dates?.[keyIndex];
                if (start === null || start === undefined) return false;
                const unit = result.elapsedUnit;
                state.range = intersectRange(state.range, start, unitStartDay(unit, unitIndexOfDay(unit, start) + 1) - 1);
                return true;
            }
            const [lo, hi] = timeKeyBounds(dim, key);
            state.range = intersectRange(state.range, lo, hi);
            return true;
        }
        case 'month_of_year':
        case 'week_of_year':
        case 'day_of_year': {
            if (result.align === 'elapsed') {
                const start = series.dates?.[keyIndex];
                if (start === null || start === undefined) return false;
                const unit = result.elapsedUnit;
                state.range = intersectRange(state.range, start, unitStartDay(unit, unitIndexOfDay(unit, start) + 1) - 1);
                return true;
            }
            // Calendrier : seulement dans une période d'une année civile.
            if (!Number.isFinite(state.range[0]) || !Number.isFinite(state.range[1])) return false;
            const y = ymdOfDay(state.range[0]).y;
            if (ymdOfDay(state.range[1]).y !== y) return false;
            const bounds = cyclicBounds(dim, key, y);
            if (!bounds || bounds === ABSENT) return false;
            state.range = intersectRange(state.range, bounds[0], bounds[1]);
            return true;
        }
        default:
            return false;
    }
}

// Filtres du graphique (ou du tableau de bord) → la sélection. false : un
// filtre sans équivalent (région, cache, visiteur…) — la carte montrerait
// plus que le graphique.
function applyFilters(state, filters) {
    for (const [field, values] of Object.entries(filters || {})) {
        if (!Array.isArray(values) || !values.length) continue;
        if (GEOCACHE_ONLY.has(field)) restrictKinds(state, ['geocache']);
        if (field === 'cache_type' && !values.includes(LAB_CACHE_TYPE)) restrictKinds(state, ['geocache']);
        if (EXCLUSIVE[field]) restrict(state.selection, EXCLUSIVE[field], values.map(String));
        else if (INCLUSIVE[field]) {
            // Attributs : tous requis, comme sur la carte — la liste entière.
            state.selection[INCLUSIVE[field]] = [...values];
        } else if (field === 'country') {
            restrict(state.selection, 'countries', values);
            state.selection.countries_excluded = excludedCountries(state);
        } else if (field === 'source_kind') {
            restrictKinds(state, values);
        } else if (field === 'published_year') {
            const years = values.map(Number).sort((a, b) => a - b);
            const contiguous = years.every((y, i) => i === 0 || y === years[i - 1] + 1);
            if (!contiguous) return false;
            state.selection.published_dates = { startDate: `${years[0]}-01-01`, endDate: `${years.at(-1)}-12-31` };
        } else {
            return false;
        }
    }
    return true;
}

// Sélection de la carte pour une valeur cliquée, ou null (pas de lien).
//   spec, result   le graphique et son calcul (runChartQueries)
//   seriesIndex    la série cliquée ; keyIndex : la clé de l'axe
//   filters        filtres effectifs du graphique (les siens ou ceux du tableau)
//   countries      pays connus des trouvailles (pour « countries_excluded »)
// Renvoie { selection, range: [début, fin] (numéros de jour), kinds } —
// kinds : types de points retenus par un filtre (« geocache », « lab »),
// null sans filtre.
export function mapSelectionFor({ spec, result, seriesIndex, keyIndex, filters = null, countries = [] }) {
    if (chartSources(spec).some((source) => source !== 'finds')) return null;
    const series = result.series[seriesIndex];
    const entry = series ? result.periods[series.periodIndex] : null;
    if (!entry || keyIndex < 0 || keyIndex >= result.keys.length) return null;
    const selection = {};
    // « Toute la période » : pas de borne (elle commence à la 1ʳᵉ trouvaille,
    // inutile de l'écrire).
    const open = entry.as?.kind === 'all';
    const state = { selection, range: open ? [-Infinity, Infinity] : [entry.from, entry.to], countries, kinds: null };
    if (!applyDimension(state, result.dim, result.keys[keyIndex], { result, series, keyIndex })) return null;
    if (series.split !== null && series.split !== undefined
        && !applyDimension(state, spec.splitBy, series.split, { result, series })) return null;
    if (!applyFilters(state, filters)) return null;
    if (state.range[0] > state.range[1] || (state.kinds && !state.kinds.length)) return null;
    if (Number.isFinite(state.range[0]) && Number.isFinite(state.range[1])) {
        selection.dates = { startDate: isoOfDay(state.range[0]), endDate: isoOfDay(state.range[1]) };
    }
    return { selection, range: state.range, kinds: state.kinds };
}

// Mode « sources affichées » de la carte (préférence main_discovery_sources)
// qui montre les types voulus : `kinds` d'un filtre, sinon tous ceux que
// les trouvailles contiennent (`present`). null : rien à changer (le mode
// actuel convient, ou il n'y a aucun type).
export const DISCOVERY_MODES = Object.freeze({ geocaches: ['geocache'], labs: ['lab'], both: ['geocache', 'lab'] });
export function discoveryModeFor(kinds, present, current) {
    const wanted = (kinds || present).filter((k) => present.includes(k));
    if (!wanted.length) return null;
    const mode = wanted.length === 2 ? 'both' : (wanted[0] === 'lab' ? 'labs' : 'geocaches');
    return mode === current ? null : mode;
}

// Le graphique a-t-il un lien vers la carte (pour l'indiquer : curseur,
// infobulle) ? Trouvailles seules, et une dimension qui a un équivalent.
const LINKABLE = new Set([
    'none', 'year', 'quarter', 'month', 'week', 'day', 'month_of_year', 'week_of_year', 'day_of_year',
    'cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'owner', 'attribute', 'published_year',
]);
export function chartLinksToMap(spec) {
    return chartSources(spec).every((source) => source === 'finds') && LINKABLE.has(spec.groupBy)
        && (!spec.splitBy || LINKABLE.has(spec.splitBy));
}
