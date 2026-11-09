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
//
// Sens inverse (« Reprendre les filtres de la carte ») :
// filtersFromMapSelection, en fin de fichier.

import { OTHERS_KEY, UNKNOWN_KEY, dayNumber, parseYmd, ymdOfDay } from './stats_model.mjs';
import { chartSources } from './chart_spec.mjs';
import { ABSENT, cyclicBounds, filterMask, timeKeyBounds, unitIndexOfDay, unitStartDay } from './chart_query.mjs';
import { filterChoices } from './chart_filters.mjs';

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
        case 'published_month': {
            const [lo, hi] = timeKeyBounds('month', key);
            selection.published_dates = { startDate: isoOfDay(lo), endDate: isoOfDay(hi) };
            return true;
        }
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
    // Record daté (meilleure journée, série) : ses jours seulement.
    const record = series.records?.[keyIndex];
    if (record) state.range = intersectRange(state.range, record.from, record.to);
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
    'published_month',
]);
export function chartLinksToMap(spec) {
    // Une pause n'a aucune trouvaille à montrer.
    if (spec.measure?.op === 'gap') return false;
    return chartSources(spec).every((source) => source === 'finds') && LINKABLE.has(spec.groupBy)
        && (!spec.splitBy || LINKABLE.has(spec.splitBy));
}

// ---------------------------------------------------------------------------
// Sens inverse : les filtres de la carte → ceux du tableau de bord
// ---------------------------------------------------------------------------
//
// « Reprendre les filtres de la carte » (fenêtre Filtres de la page
// Statistiques). La carte filtre ses trouvailles selon `filtersSelection`
// (bdd.js › filterFeaturesClientSide) ; ce qui a un équivalent devient un
// filtre de la page, le reste est signalé (`notes`). Règles de la carte :
//   - type, taille, D, T : listes exclusives — vide = aucun point, tout
//     coché = pas de filtre. Taille, D et T ne s'appliquent pas aux Labs
//     (gardés) ; le type, si ;
//   - pays / régions : options décochées (`*_excluded`, sinon déduites des
//     cochées) ; « Non renseigné » n'a pas d'équivalent sur la page ;
//   - propriétaires, attributs (tous requis) : vides = neutres, Labs gardés ;
//   - dates de trouvaille → période du tableau (`range`) ; dates de pose →
//     années de publication quand elles tombent sur des années entières ;
//   - recherche texte : sans équivalent (la page n'a pas les noms) ;
//   - géocaches / Labs : préférence `main_discovery_sources` (`discovery`).
// Neutralité jugée sur les trouvailles (`table`) : un critère qui ne retire
// aucune trouvaille n'est pas repris.
//
// Renvoie { filters, period, notes, count, empty } :
//   filters  filtres du tableau ({} : aucun) ; period : { kind: 'range' } ou
//            null (les dates de la carte ne retirent rien) ;
//   notes    [{ code, … }] : 'search' (text), 'published_dates' (from, to),
//            'unknown_country', 'unknown_state', 'labs' (un filtre propre aux
//            géocaches écarte ici les Labs que la carte garde) ;
//   count    trouvailles retenues ; empty : la carte n'en montre aucune
//            (filters et period valent alors null).
const GEOCACHE_FIELDS = ['container', 'difficulty', 'terrain', 'owner', 'attribute'];

function isoDayOf(value) {
    const ymd = parseYmd(typeof value === 'string' ? value : '');
    return ymd ? dayNumber(ymd) : null;
}

export function filtersFromMapSelection(selection, { table, discovery = 'geocaches' }) {
    const sel = selection && typeof selection === 'object' ? selection : {};
    const filters = {};
    const notes = [];
    const nothing = () => ({ filters: null, period: null, notes, count: 0, empty: true });
    const present = (field) => filterChoices(table, field).map((choice) => String(choice.value));
    let kinds = [...(DISCOVERY_MODES[discovery] || DISCOVERY_MODES.geocaches)];
    const labsOnly = () => { kinds = kinds.filter((k) => k === 'lab'); };

    // Type : s'applique à tous les points, Labs compris (« Adventure Lab »).
    if (Array.isArray(sel.type)) {
        const all = present('cache_type');
        const chosen = new Set(sel.type.map(String));
        const kept = all.filter((v) => chosen.has(v));
        if (!kept.length) return nothing();
        if (kept.length < all.length) filters.cache_type = kept;
    }

    // Taille, D, T : géocaches seules. « Aucun » coché : il ne reste que
    // les Labs.
    for (const field of ['container', 'difficulty', 'terrain']) {
        if (!Array.isArray(sel[field])) continue;
        const canon = field === 'container' ? String : (v) => String(Number(v));
        const all = present(field);
        const chosen = new Set(sel[field].map(canon));
        const kept = all.filter((v) => chosen.has(v));
        if (!kept.length) labsOnly();
        else if (kept.length < all.length) filters[field] = kept;
    }

    // Pays, régions.
    for (const [key, field, note] of [['countries', 'country', 'unknown_country'], ['states', 'state', 'unknown_state']]) {
        const excludedRaw = sel[key + '_excluded'];
        const checked = sel[key];
        if (!Array.isArray(excludedRaw) && !Array.isArray(checked)) continue;
        const all = present(field);
        let unknownRows = 0;
        for (let r = 0; r < table.n; r++) if (table[field][r] < 0) unknownRows++;
        let excluded;
        if (Array.isArray(excludedRaw)) excluded = new Set(excludedRaw.map(String));
        else {
            const chosen = new Set(checked.map(String));
            excluded = new Set([...all, UNKNOWN_GEO].filter((v) => !chosen.has(v)));
        }
        const kept = all.filter((v) => !excluded.has(v));
        const keepsUnknown = !excluded.has(UNKNOWN_GEO) && unknownRows > 0;
        const dropsUnknown = excluded.has(UNKNOWN_GEO) && unknownRows > 0;
        if (kept.length === all.length && !dropsUnknown) continue;
        if (keepsUnknown) notes.push({ code: note });
        if (!kept.length) {
            if (keepsUnknown) continue;
            return nothing();
        }
        filters[field] = kept;
    }

    // Propriétaires, attributs : géocaches seules, liste vide neutre.
    if (Array.isArray(sel.owners) && sel.owners.length) {
        const all = new Set(present('owner'));
        const kept = [...new Set(sel.owners.map(String))].filter((v) => all.has(v));
        if (!kept.length) labsOnly();
        else filters.owner = kept;
    }
    if (Array.isArray(sel.attributes) && sel.attributes.length) {
        const keys = new Set((table.dicts?.attribute || []).map((a) => a.key));
        const wanted = [...new Set(sel.attributes.map(String))];
        if (wanted.every((k) => keys.has(k))) filters.attribute = wanted;
        else labsOnly();
    }

    // Dates de pose : reprises si elles écartent une date connue. (La carte
    // écarte aussi les géocaches sans date dès que la plage est posée, même
    // au défaut ; la plage par défaut n'est pas pour autant un choix.)
    const pubFrom = isoDayOf(sel.published_dates?.startDate);
    const pubTo = isoDayOf(sel.published_dates?.endDate);
    if (pubFrom !== null && pubTo !== null) {
        let removes = false;
        for (let r = 0; r < table.n && !removes; r++) {
            const pub = table.published[r];
            removes = !Number.isNaN(pub) && (pub < pubFrom || pub > pubTo);
        }
        if (removes) {
            const a = ymdOfDay(pubFrom);
            const b = ymdOfDay(pubTo);
            if (a.m === 1 && a.d === 1 && b.m === 12 && b.d === 31) {
                const years = present('published_year').filter((y) => Number(y) >= a.y && Number(y) <= b.y);
                if (!years.length) return nothing();
                filters.published_year = years;
            } else {
                notes.push({ code: 'published_dates', from: isoOfDay(pubFrom), to: isoOfDay(pubTo) });
            }
        }
    }

    // Dates de trouvaille → période du tableau, si elles retirent quelque chose.
    let period = null;
    const from = isoDayOf(sel.dates?.startDate);
    const to = isoDayOf(sel.dates?.endDate);
    if (from !== null && to !== null) {
        if (from > to) return nothing();
        let removes = false;
        for (let r = 0; r < table.n && !removes; r++) removes = table.day[r] < from || table.day[r] > to;
        if (removes) period = { kind: 'range', from: isoOfDay(from), to: isoOfDay(to) };
    }

    const search = typeof sel.search === 'string' ? sel.search.trim() : '';
    if (search) notes.push({ code: 'search', text: search });

    // Géocaches / Labs.
    const presentKinds = present('source_kind');
    kinds = kinds.filter((k) => presentKinds.includes(k));
    if (!kinds.length) return nothing();
    if (kinds.length < presentKinds.length) filters.source_kind = kinds;
    if (!kinds.includes('geocache')) {
        // Plus de géocaches : leurs filtres propres n'ont plus d'objet (et
        // écarteraient les Labs, qui n'ont ni taille, ni D/T, ni attributs).
        for (const field of GEOCACHE_FIELDS) delete filters[field];
    } else if (kinds.includes('lab') && [...GEOCACHE_FIELDS, 'published_year'].some((f) => filters[f])
        && table.kind.includes(1)) {
        // (Années de pose : un Lab sans date, gardé par la carte, est écarté ici.)
        notes.push({ code: 'labs' });
    }

    const mask = filterMask(table, filters);
    let count = 0;
    for (let r = 0; r < table.n; r++) {
        if (mask[r] && (!period || (table.day[r] >= from && table.day[r] <= to))) count++;
    }
    if (!count) return nothing();
    return { filters, period, notes, count, empty: false };
}
