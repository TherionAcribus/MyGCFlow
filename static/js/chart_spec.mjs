// Description d'un graphique de la page Statistiques — format versionné,
// normalisation et règles de compatibilité. Module pur (ni DOM ni ECharts),
// testé par tests/js/chart_spec.test.mjs.
//
// Toute l'interface (questions toutes faites, phrase à compléter, réglages
// avancés) édite cet objet ; le moteur (chart_query.mjs, lot 1) le transforme
// en séries, l'adaptateur (chart_echarts.mjs) en options ECharts. Plan :
// MyGCFlow_Plan_Statistiques.md, § 2.
//
// Exemple :
//   {
//     v: 1, id: 'a3f09c12', title: '',
//     source: 'finds',
//     measure: { op: 'count' },
//     groupBy: 'month_of_year', splitBy: null,
//     filters: null,                       // null = ceux du tableau de bord
//     periods: [{ kind: 'year', year: 2025 }, { kind: 'year', year: 2024 }],
//     compare: { layout: 'overlay', align: 'calendar', normalize: 'none', toDate: true },
//     view: { chart: 'bar', orientation: 'vertical', stack: false, palette: 'auto',
//             labels: false, log: false, top: 12, sort: 'natural', smooth: false },
//   }
//
// La normalisation rend TOUJOURS une description utilisable : valeur
// inconnue → défaut, combinaison impossible → réparée (graphique, mesure,
// regroupement, alignement compatibles). Seule exception : une version plus
// récente que celle du module (`v` > CHART_SPEC_VERSION) donne null — on ne
// devine pas un format futur, l'appelant garde l'original intact.

import { parseYmd } from './stats_model.mjs';

export const CHART_SPEC_VERSION = 1;

// ---------------------------------------------------------------------------
// Vocabulaire
// ---------------------------------------------------------------------------

// Sources : les trois jeux de données de l'app. « evolution:<id> » désigne un
// jeu CSV de la page Évolution. Seule `finds` est branchée au lot 1, mais le
// format les accepte toutes dès la v1 (pas de migration au lot 4).
export const CHART_SOURCES = Object.freeze([
    'finds',            // mes trouvailles (page Mes Géocaches)
    'dnf',              // mes DNF
    'owned',            // mes caches posées (étapes du poseur)
    'poses.received',   // trouvailles reçues sur mes caches posées
    'poses.dnf',        // DNF reçus
    'poses.favorites',  // favoris reçus
]);
const EVOLUTION_SOURCE_RE = /^evolution:[1-9][0-9]{0,9}$/;

export function isChartSource(value) {
    return typeof value === 'string'
        && (CHART_SOURCES.includes(value) || EVOLUTION_SOURCE_RE.test(value));
}

export function isEvolutionSource(value) {
    return typeof value === 'string' && EVOLUTION_SOURCE_RE.test(value);
}

// Mesures. « Flux » : comptées dans chaque intervalle. « Stock » : valeur
// lue en fin d'intervalle (cumul, caches vivantes).
export const MEASURE_OPS = Object.freeze(['count', 'distinct', 'mean', 'max_per_day', 'cumulative', 'active']);
export const STOCK_OPS = Object.freeze(['cumulative', 'active']);
// `days` = jours avec au moins un événement.
export const DISTINCT_FIELDS = Object.freeze(['caches', 'days', 'cache_type', 'country', 'state', 'owner']);
export const MEAN_FIELDS = Object.freeze(['difficulty', 'terrain', 'age']);
// « Caches vivantes à la date » n'a de sens que pour un ensemble qui naît et
// meurt : jeux Évolution et caches posées.
function activeAllowed(source) {
    return source === 'owned' || isEvolutionSource(source);
}

// Dimensions (axe des graphiques, ou découpage en séries).
export const TIME_DIMENSIONS = Object.freeze(['year', 'quarter', 'month', 'week', 'day']);
// Cycliques : indépendantes de l'année — faites pour comparer des périodes.
// Pas d'heure : l'import GPX pose une heure de trouvaille factice (19 h / 20 h
// UTC, bdd.py), qui ne dit rien de l'heure réelle.
export const CYCLIC_DIMENSIONS = Object.freeze(['month_of_year', 'week_of_year', 'day_of_year', 'weekday']);
export const CATEGORY_DIMENSIONS = Object.freeze([
    'cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'state',
    'owner', 'attribute', 'age', 'published_year',
]);
// Catégories ordonnées : une courbe y a un sens.
export const ORDINAL_CATEGORIES = Object.freeze(['difficulty', 'terrain', 'age', 'published_year']);
export const GROUP_DIMENSIONS = Object.freeze(['none', ...TIME_DIMENSIONS, ...CYCLIC_DIMENSIONS, ...CATEGORY_DIMENSIONS]);
// 2ᵉ dimension : une catégorie, ou l'année (« une série par année »).
export const SPLIT_DIMENSIONS = Object.freeze(['year', ...CATEGORY_DIMENSIONS]);
// Dimensions qui suivent l'écoulement du temps : seules à porter un cumul.
export const SEQUENTIAL_DIMENSIONS = Object.freeze([...TIME_DIMENSIONS, 'month_of_year', 'week_of_year', 'day_of_year']);

export function dimensionKind(dim) {
    if (dim === 'none') return 'none';
    if (TIME_DIMENSIONS.includes(dim)) return 'time';
    if (CYCLIC_DIMENSIONS.includes(dim)) return 'cyclic';
    if (CATEGORY_DIMENSIONS.includes(dim)) return 'category';
    return null;
}

// Filtres : sélection vide = neutre (le critère ne retire rien).
export const FILTER_FIELDS = Object.freeze([
    'source_kind', 'cache_type', 'container', 'difficulty', 'terrain',
    'country', 'state', 'owner', 'attribute', 'published_year',
]);
export const SOURCE_KINDS = Object.freeze(['geocache', 'lab']);
export const FILTER_VALUES_MAX = 500;
export const FILTER_VALUE_MAX = 200;

// Périodes.
export const PERIOD_KINDS = Object.freeze(['all', 'year', 'month', 'range', 'rolling', 'each']);
export const ROLLING_UNITS = Object.freeze(['day', 'month', 'year']);
export const EACH_UNITS = Object.freeze(['year', 'month']);
export const PERIOD_YEAR_RANGE = Object.freeze([1990, 2100]);
export const ROLLING_COUNT_RANGE = Object.freeze([1, 3650]);
export const MAX_PERIODS = 12;
// Plafond de séries d'un graphique (périodes déployées × valeurs de splitBy),
// appliqué au calcul (chart_query.mjs) : huit, la taille de la palette
// catégorielle validée pour les daltoniens (stats_page.css) — une 9ᵉ série
// rejoint « Autres », on ne génère jamais de teinte de plus.
export const MAX_SERIES = 8;
export const PERIOD_LABEL_MAX = 40;

// Comparaison.
export const COMPARE_LAYOUTS = Object.freeze(['overlay', 'side', 'delta']);
export const COMPARE_ALIGNS = Object.freeze(['calendar', 'elapsed', 'absolute']);
export const COMPARE_NORMALIZE = Object.freeze(['none', 'percent', 'per_day']);

// Vue.
export const CHART_TYPES = Object.freeze(['bar', 'line', 'area', 'donut', 'number', 'calendar', 'heatmap', 'radar']);
export const CHART_ORIENTATIONS = Object.freeze(['vertical', 'horizontal']);
export const CHART_PALETTES = Object.freeze(['auto', 'accent', 'gc', 'multi', 'heat']);
export const CHART_SORTS = Object.freeze(['natural', 'value', 'label']);
export const CHART_TOP_RANGE = Object.freeze([3, 50]);
export const CHART_TITLE_MAX = 80;

const ID_RE = /^[0-9a-f]{6,32}$/;
const YMD_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export const CHART_SPEC_DEFAULTS = Object.freeze({
    v: CHART_SPEC_VERSION,
    title: '',
    source: 'finds',
    measure: Object.freeze({ op: 'count' }),
    groupBy: 'year',
    splitBy: null,
    filters: null,
    periods: null,
    // Alignement par défaut = celui de l'axe par défaut (l'année, axe de temps).
    compare: Object.freeze({ layout: 'overlay', align: 'elapsed', normalize: 'none', toDate: true }),
    view: Object.freeze({
        chart: 'bar', orientation: 'vertical', stack: false, palette: 'auto',
        labels: false, log: false, top: 12, sort: 'natural', smooth: false,
    }),
});

// ---------------------------------------------------------------------------
// Coercitions élémentaires
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const choice = (value, allowed, fallback) => (
    typeof value === 'string' && allowed.includes(value) ? value : fallback
);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function intIn(value, fallback, [min, max]) {
    let number = null;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^[ \t]*-?[0-9]+(?:\.[0-9]+)?[ \t]*$/.test(value)) number = Number(value);
    if (number === null || !Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

// Entier strictement dans la plage, sinon null (pas de rabattement : une
// année 1850 est une erreur, pas 1990).
function strictInt(value, [min, max]) {
    const number = typeof value === 'string' && /^[ \t]*[0-9]+[ \t]*$/.test(value) ? Number(value) : value;
    return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

// Texte d'une ligne : aplati, blancs de bord retirés, tronqué en points de
// code (un emoji = 1).
function flatText(value, max) {
    if (typeof value !== 'string') return '';
    const flat = value.replace(/[\r\n\t]+/g, ' ').trim();
    return Array.from(flat).slice(0, max).join('');
}

// « YYYY-MM-DD » d'une date qui existe, sinon null.
function ymd(value) {
    return typeof value === 'string' && YMD_RE.test(value) && parseYmd(value) ? value : null;
}

export function newChartId(random = Math.random) {
    let id = '';
    for (let i = 0; i < 12; i++) id += Math.floor(random() * 16).toString(16);
    return id;
}

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------

export function normalizeMeasure(raw, source = 'finds') {
    const op = choice(isObject(raw) ? raw.op : raw, MEASURE_OPS, 'count');
    if (op === 'active' && !activeAllowed(source)) return { op: 'count' };
    if (op === 'distinct') return { op, field: choice(raw?.field, DISTINCT_FIELDS, 'caches') };
    if (op === 'mean') return { op, field: choice(raw?.field, MEAN_FIELDS, 'difficulty') };
    if (op === 'cumulative') {
        // Cumul depuis le début de chaque période (défaut) ou depuis toujours.
        return raw?.from === 'all' ? { op, from: 'all' } : { op };
    }
    return { op };
}

// Valeur de filtre canonique selon le champ, ou null si invalide.
function filterValue(field, value) {
    if (field === 'difficulty' || field === 'terrain') {
        const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof number !== 'number' || !Number.isFinite(number)) return null;
        if (number < 1 || number > 5 || number * 2 !== Math.round(number * 2)) return null;
        return String(number);
    }
    if (field === 'published_year') {
        const year = strictInt(value, PERIOD_YEAR_RANGE);
        return year === null ? null : String(year);
    }
    if (field === 'source_kind') return SOURCE_KINDS.includes(value) ? value : null;
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    const text = flatText(value, FILTER_VALUE_MAX);
    return text || null;
}

// null = filtres du tableau de bord (hérités) ; un objet = filtres propres au
// graphique (`{}` : propres et vides, donc aucun filtre, même si le tableau
// de bord en pose). Une liste vide est retirée : elle ne filtre rien.
export function normalizeFilters(raw) {
    if (raw === null || raw === undefined || !isObject(raw)) return null;
    const out = {};
    for (const field of FILTER_FIELDS) {
        if (!Array.isArray(raw[field])) continue;
        const values = [];
        for (const item of raw[field]) {
            const value = filterValue(field, item);
            if (value !== null && !values.includes(value)) values.push(value);
            if (values.length >= FILTER_VALUES_MAX) break;
        }
        if (values.length) out[field] = values;
    }
    return out;
}

export function normalizePeriod(raw) {
    if (!isObject(raw)) return null;
    const kind = choice(raw.kind, PERIOD_KINDS, null);
    let period = null;
    if (kind === 'all') {
        period = { kind };
    } else if (kind === 'year') {
        const year = strictInt(raw.year, PERIOD_YEAR_RANGE);
        if (year !== null) period = { kind, year };
    } else if (kind === 'month') {
        const year = strictInt(raw.year, PERIOD_YEAR_RANGE);
        const month = strictInt(raw.month, [1, 12]);
        if (year !== null && month !== null) period = { kind, year, month };
    } else if (kind === 'range') {
        let from = ymd(raw.from);
        let to = ymd(raw.to);
        if (from && to) {
            // Bornes inversées : remises dans l'ordre plutôt que rejetées.
            if (from > to) [from, to] = [to, from];
            period = { kind, from, to };
        }
    } else if (kind === 'rolling') {
        period = {
            kind,
            unit: choice(raw.unit, ROLLING_UNITS, 'month'),
            count: intIn(raw.count, 12, ROLLING_COUNT_RANGE),
        };
    } else if (kind === 'each') {
        period = { kind, unit: choice(raw.unit, EACH_UNITS, 'year') };
        let from = ymd(raw.from);
        let to = ymd(raw.to);
        if (from && to && from > to) [from, to] = [to, from];
        if (from) period.from = from;
        if (to) period.to = to;
    }
    if (!period) return null;
    const label = flatText(raw.label, PERIOD_LABEL_MAX);
    if (label) period.label = label;
    return period;
}

// null = période du tableau de bord (héritée). Une liste dont aucune entrée
// n'est valide retombe aussi sur l'héritage.
export function normalizePeriods(raw) {
    if (!Array.isArray(raw)) return null;
    const periods = [];
    for (const item of raw) {
        const period = normalizePeriod(item);
        if (period) periods.push(period);
        if (periods.length >= MAX_PERIODS) break;
    }
    return periods.length ? periods : null;
}

// ---------------------------------------------------------------------------
// Compatibilités
// ---------------------------------------------------------------------------

// Regroupements possibles pour une mesure : un cumul (ou un état « actives »)
// suit le temps.
export function allowedGroupBy(measure) {
    return STOCK_OPS.includes(measure?.op) ? [...SEQUENTIAL_DIMENSIONS] : [...GROUP_DIMENSIONS];
}

// 2ᵉ dimension possible : jamais la même que l'axe ; « par année » n'a pas
// de sens sur un axe de temps continu (il le découpe déjà) ; pas de
// découpage d'un chiffre clé.
export function allowedSplitBy(groupBy) {
    if (groupBy === 'none') return [];
    return SPLIT_DIMENSIONS.filter((dim) => dim !== groupBy
        && !(dim === 'year' && dimensionKind(groupBy) === 'time'));
}

// Alignements de périodes pour un axe : temps continu → jours écoulés ou
// vraie date ; cyclique → calendrier ou jours écoulés ; catégorie ou chiffre
// clé → sans objet (« calendar », valeur neutre).
export function allowedAligns(groupBy) {
    const kind = dimensionKind(groupBy);
    if (kind === 'time') return ['elapsed', 'absolute'];
    if (kind === 'cyclic') return ['calendar', 'elapsed'];
    return ['calendar'];
}

// Le cumul et la moyenne ne s'additionnent pas en parts d'un tout.
const ADDITIVE_OPS = ['count', 'distinct', 'max_per_day'];
// Catégories assez peu nombreuses et sans ordre pour un anneau / un radar.
const PART_CYCLIC = ['weekday', 'month_of_year'];

// Types de graphiques compatibles, dans l'ordre de préférence (le premier
// sert de repli à la normalisation).
export function allowedCharts({ measure, groupBy, splitBy } = {}) {
    const kind = dimensionKind(groupBy);
    if (kind === 'none') return ['number', 'bar'];
    const charts = ['bar'];
    if (kind === 'time' || kind === 'cyclic' || ORDINAL_CATEGORIES.includes(groupBy)) {
        charts.push('line', 'area');
    }
    const parts = kind === 'category' || PART_CYCLIC.includes(groupBy);
    if (parts && ADDITIVE_OPS.includes(measure?.op)) charts.push('donut');
    if (groupBy === 'day') charts.push('calendar');
    if (groupBy === 'dt' || splitBy) charts.push('heatmap');
    if (parts) charts.push('radar');
    return charts;
}

// ---------------------------------------------------------------------------
// Description complète
// ---------------------------------------------------------------------------

function normalizeCompare(raw, groupBy, periods) {
    const src = isObject(raw) ? raw : {};
    const defaults = CHART_SPEC_DEFAULTS.compare;
    let layout = choice(src.layout, COMPARE_LAYOUTS, defaults.layout);
    // L'écart oppose exactement deux périodes fixes. Avec des périodes
    // héritées (null), le contrôle revient au calcul : on garde le choix.
    if (layout === 'delta' && periods
        && (periods.length !== 2 || periods.some((p) => p.kind === 'each'))) {
        layout = defaults.layout;
    }
    const aligns = allowedAligns(groupBy);
    return {
        layout,
        align: choice(src.align, aligns, aligns[0]),
        normalize: choice(src.normalize, COMPARE_NORMALIZE, defaults.normalize),
        toDate: bool(src.toDate, defaults.toDate),
    };
}

function normalizeView(raw, spec) {
    const src = isObject(raw) ? raw : {};
    const defaults = CHART_SPEC_DEFAULTS.view;
    const charts = allowedCharts(spec);
    return {
        chart: choice(src.chart, charts, charts[0]),
        orientation: choice(src.orientation, CHART_ORIENTATIONS, defaults.orientation),
        stack: bool(src.stack, defaults.stack),
        palette: choice(src.palette, CHART_PALETTES, defaults.palette),
        labels: bool(src.labels, defaults.labels),
        log: bool(src.log, defaults.log),
        top: intIn(src.top, defaults.top, CHART_TOP_RANGE),
        sort: choice(src.sort, CHART_SORTS, defaults.sort),
        smooth: bool(src.smooth, defaults.smooth),
    };
}

// Montée de version : v1 est la première, rien à migrer. Une description
// sans `v` est lue comme v1.
function migrate(raw) {
    const version = raw.v === undefined ? CHART_SPEC_VERSION : raw.v;
    if (!Number.isInteger(version) || version < 1) return raw;
    if (version > CHART_SPEC_VERSION) return null;
    return raw;
}

export function normalizeChartSpec(raw, newId = newChartId) {
    const src = isObject(raw) ? migrate(raw) : {};
    if (src === null) return null;

    const source = isChartSource(src.source) ? src.source : CHART_SPEC_DEFAULTS.source;
    const measure = normalizeMeasure(src.measure, source);
    // Repli d'un cumul sur le mois, lisible sur toute durée (une courbe par
    // année n'aurait que quelques points).
    const fallbackGroup = STOCK_OPS.includes(measure.op) ? 'month' : CHART_SPEC_DEFAULTS.groupBy;
    const groupBy = choice(src.groupBy, allowedGroupBy(measure), fallbackGroup);
    const splitBy = choice(src.splitBy, allowedSplitBy(groupBy), null);
    const periods = normalizePeriods(src.periods);

    const spec = {
        v: CHART_SPEC_VERSION,
        id: typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : newId(),
        title: flatText(src.title, CHART_TITLE_MAX),
        source,
        measure,
        groupBy,
        splitBy,
        filters: normalizeFilters(src.filters),
        periods,
        compare: normalizeCompare(src.compare, groupBy, periods),
    };
    spec.view = normalizeView(src.view, spec);
    return spec;
}

// Nouvelle description à partir d'un modèle partiel (question toute faite,
// choix de la galerie). L'identifiant est toujours neuf.
export function createChartSpec(overrides = {}, newId = newChartId) {
    return normalizeChartSpec({ ...overrides, id: undefined }, newId);
}
