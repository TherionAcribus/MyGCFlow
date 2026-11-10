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
import { GRID_DEFAULT_SIZE, normalizeGridSize } from './zone_grid.mjs';

export const CHART_SPEC_VERSION = 1;

// ---------------------------------------------------------------------------
// Vocabulaire
// ---------------------------------------------------------------------------

// Sources, en deux familles étanches :
//   personal   les données du joueur — trouvailles, DNF, caches posées
//              (page Mes Géocaches) et logs reçus sur ses caches (Mes
//              poses) ; elles se comparent entre elles ;
//   evolution  un jeu CSV de la page Évolution : « evolution:<id> » (caches
//              publiées) et « evolution:<id>:archived » (caches archivées).
//              Toutes les caches d'une zone, rien à voir avec le joueur :
//              jamais mêlées aux sources personnelles, ni à un autre jeu.
export const CHART_SOURCES = Object.freeze([
    'finds',            // mes trouvailles (page Mes Géocaches)
    'dnf',              // mes DNF
    'owned',            // mes caches posées (étapes du poseur)
    'poses.received',   // trouvailles reçues sur mes caches posées
    'poses.dnf',        // DNF reçus
    'poses.favorites',  // favoris reçus
]);
export const SOURCE_FAMILIES = Object.freeze(['personal', 'evolution']);
const EVOLUTION_SOURCE_RE = /^evolution:([1-9][0-9]{0,9})(:archived)?$/;
export const MAX_EXTRA_SOURCES = 3;

export function isChartSource(value) {
    return typeof value === 'string'
        && (CHART_SOURCES.includes(value) || EVOLUTION_SOURCE_RE.test(value));
}

export function isEvolutionSource(value) {
    return typeof value === 'string' && EVOLUTION_SOURCE_RE.test(value);
}

export function sourceFamily(source) {
    return isEvolutionSource(source) ? 'evolution' : 'personal';
}

// Jeu Évolution d'une source (nombre), ou null.
export function evolutionDatasetOf(source) {
    const match = typeof source === 'string' ? EVOLUTION_SOURCE_RE.exec(source) : null;
    return match ? Number(match[1]) : null;
}

export function evolutionSource(datasetId, { archived = false } = {}) {
    return 'evolution:' + datasetId + (archived ? ':archived' : '');
}

// Deux sources peuvent-elles partager un graphique ? Même famille et, pour
// Évolution, même jeu.
export function sameSourceGroup(a, b) {
    if (sourceFamily(a) !== sourceFamily(b)) return false;
    return sourceFamily(a) === 'personal' || evolutionDatasetOf(a) === evolutionDatasetOf(b);
}

// Mesures. « Flux » : comptées dans chaque intervalle. « Stock » : valeur
// lue en fin d'intervalle (cumul, caches vivantes).
export const MEASURE_OPS = Object.freeze(['count', 'distinct', 'mean', 'max_per_day', 'streak', 'gap', 'cumulative', 'active', 'dt_coverage', 'first_day', 'found_share']);
// Records datés : la valeur d'une case vient de jours précis (la meilleure
// journée, la plus longue série de jours consécutifs avec une trouvaille,
// la plus longue pause entre deux) — le résultat garde ces dates.
export const RECORD_OPS = Object.freeze(['max_per_day', 'streak', 'gap']);
export const STOCK_OPS = Object.freeze(['cumulative', 'active']);
// Mesures propres aux cartes par zones (zone_model.mjs) : combinaisons D/T
// différentes (sur 81) et jour de la première ligne de la zone (la
// « conquête »). `found_share` : part des caches d'un jeu Évolution que j'ai
// trouvées (croisement avec mes trouvailles, zone_model.mjs › createShareState).
export const ZONE_ONLY_OPS = Object.freeze(['dt_coverage', 'first_day', 'found_share']);
// Base de la part trouvée : caches actives à la date (défaut), ou toutes
// celles apparues jusque-là (`all`).
export const FOUND_SHARE_BASES = Object.freeze(['active', 'all']);
// `days` = jours avec au moins un événement ; `finder` = visiteurs
// différents (Mes poses).
export const DISTINCT_FIELDS = Object.freeze(['caches', 'days', 'cache_type', 'country', 'state', 'owner', 'finder', 'county']);
export const MEAN_FIELDS = Object.freeze(['difficulty', 'terrain', 'age']);
// « Caches actives à la date » n'a de sens que pour un ensemble qui naît et
// meurt : caches posées et caches publiées d'un jeu Évolution.
function activeAllowed(source) {
    return source === 'owned' || (isEvolutionSource(source) && !source.endsWith(':archived'));
}
// Part trouvée : les caches publiées d'un jeu Évolution, croisées avec mes
// trouvailles.
function foundShareAllowed(source) {
    return isEvolutionSource(source) && !source.endsWith(':archived');
}

// Dimensions (axe des graphiques, ou découpage en séries).
export const TIME_DIMENSIONS = Object.freeze(['year', 'quarter', 'month', 'week', 'day']);
// Cycliques : indépendantes de l'année — faites pour comparer des périodes.
// Pas d'heure : l'import GPX pose une heure de trouvaille factice (19 h / 20 h
// UTC, bdd.py), qui ne dit rien de l'heure réelle.
export const CYCLIC_DIMENSIONS = Object.freeze(['month_of_year', 'week_of_year', 'day_of_year', 'weekday']);
// `cache` : la cache posée visitée, `finder` : le visiteur (Mes poses) ;
// `county` : le département (jeux Évolution).
export const CATEGORY_DIMENSIONS = Object.freeze([
    'cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'state',
    'owner', 'attribute', 'age', 'published_year', 'published_month', 'cache', 'finder', 'county',
]);
// Zones géographiques (zones.py, colonnes zone_* des tables) : seulement
// dessinées en carte (`map`), jamais en 2ᵉ dimension. Plan :
// MyGCFlow_Plan_Carte_Zones.md.
// `zone_grid` : cases hexagonales calculées sur les coordonnées
// (zone_grid.mjs), taille dans view.map.gridSize.
export const ZONE_DIMENSIONS = Object.freeze(['zone_country', 'zone_region', 'zone_subregion', 'zone_grid']);
// Catégories ordonnées : une courbe y a un sens.
export const ORDINAL_CATEGORIES = Object.freeze(['difficulty', 'terrain', 'age', 'published_year']);
export const GROUP_DIMENSIONS = Object.freeze(['none', ...TIME_DIMENSIONS, ...CYCLIC_DIMENSIONS, ...CATEGORY_DIMENSIONS, ...ZONE_DIMENSIONS]);
// 2ᵉ dimension : une catégorie, ou l'année (« une série par année »).
// (Pas le mois de publication : il n'existe que pour la grille Jasmer.)
export const SPLIT_DIMENSIONS = Object.freeze(['year', ...CATEGORY_DIMENSIONS.filter((dim) => dim !== 'published_month')]);
// Dimensions qui suivent l'écoulement du temps : seules à porter un cumul.
export const SEQUENTIAL_DIMENSIONS = Object.freeze([...TIME_DIMENSIONS, 'month_of_year', 'week_of_year', 'day_of_year']);

// Dimensions disponibles selon la source : chacune n'a que les propriétés
// que ses données portent (pas d'attributs hors des trouvailles, pas de
// propriétaire pour ses propres caches, pas de visiteur hors de Mes poses…).
const COMMON_DIMENSIONS = Object.freeze([
    ...TIME_DIMENSIONS, ...CYCLIC_DIMENSIONS,
    'cache_type', 'container', 'difficulty', 'terrain', 'dt', 'country', 'state',
]);
const EXTRA_DIMENSIONS = Object.freeze({
    finds: ['owner', 'attribute', 'age', 'published_year', 'published_month', ...ZONE_DIMENSIONS],
    dnf: ['owner', 'age', 'published_year', 'published_month'],
    owned: [],
    poses: ['cache', 'finder', 'age'],
    evolution: ['county', ...ZONE_DIMENSIONS],
});

function sourceKey(source) {
    if (isEvolutionSource(source)) return 'evolution';
    if (String(source).startsWith('poses.')) return 'poses';
    return source;
}

// Dimensions d'une source, ou communes à plusieurs (`none` compris).
export function sourceDimensions(sources) {
    const list = (Array.isArray(sources) ? sources : [sources]).filter(isChartSource);
    if (!list.length) list.push('finds');
    const sets = list.map((source) => new Set([...COMMON_DIMENSIONS, ...(EXTRA_DIMENSIONS[sourceKey(source)] || [])]));
    return ['none', ...GROUP_DIMENSIONS.filter((dim) => dim !== 'none' && sets.every((set) => set.has(dim)))];
}

// Valeurs distinctes et moyennes possibles pour des sources.
export function sourceDistinctFields(sources) {
    const dims = new Set(sourceDimensions(sources));
    return DISTINCT_FIELDS.filter((field) => field === 'caches' || field === 'days' || dims.has(field));
}

export function sourceMeanFields(sources) {
    const dims = new Set(sourceDimensions(sources));
    return MEAN_FIELDS.filter((field) => field !== 'age' || dims.has('age'));
}

export function dimensionKind(dim) {
    if (dim === 'none') return 'none';
    if (TIME_DIMENSIONS.includes(dim)) return 'time';
    if (CYCLIC_DIMENSIONS.includes(dim)) return 'cyclic';
    if (CATEGORY_DIMENSIONS.includes(dim)) return 'category';
    if (ZONE_DIMENSIONS.includes(dim)) return 'zone';
    return null;
}

// Filtres : sélection vide = neutre (le critère ne retire rien).
export const FILTER_FIELDS = Object.freeze([
    'source_kind', 'cache_type', 'container', 'difficulty', 'terrain',
    'country', 'state', 'county', 'owner', 'cache', 'finder', 'attribute', 'published_year',
]);
export const SOURCE_KINDS = Object.freeze(['geocache', 'lab']);
export const FILTER_VALUES_MAX = 500;
export const FILTER_VALUE_MAX = 200;

// Périodes. Trois sortes relatives, résolues au calcul :
//   current   l'année (ou le mois) en cours — suit le calendrier ;
//   previous  la période juste avant l'entrée qui la précède dans la liste
//             (2024 avant 2025, les 12 mois avant les 12 derniers…) ;
//   dashboard la période du tableau de bord, quand le graphique la compare
//             à d'autres (periods: null = héritage sans comparaison).
export const PERIOD_KINDS = Object.freeze(['all', 'year', 'month', 'range', 'rolling', 'each', 'current', 'previous', 'dashboard', 'moments']);
// « Moments clés » (cartes seulement) : une vignette par moment, déployés
// sur les données par zone_model.mjs › keyMoments.
export const MOMENT_PERIOD_RULES = Object.freeze(['year_end', 'quarter_end', 'milestones', 'new_zone']);
export const CURRENT_UNITS = Object.freeze(['year', 'month']);
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
export const COMPARE_NORMALIZE = Object.freeze(['none', 'percent', 'per_day', 'per_km2']);

// Vue.
export const CHART_TYPES = Object.freeze(['bar', 'line', 'area', 'donut', 'number', 'calendar', 'heatmap', 'radar', 'challenge', 'map']);
// Carte par zones : échelle de couleurs (zone_model.mjs › zoneScale),
// nombre de classes, cadrage.
export const MAP_SCALES = Object.freeze(['quantile', 'linear', 'log']);
export const MAP_CLASSES_RANGE = Object.freeze([3, 7]);
export const MAP_FRAMES = Object.freeze(['auto', 'world']);
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
    extraSources: Object.freeze([]),
    measure: Object.freeze({ op: 'count' }),
    groupBy: 'year',
    splitBy: null,
    filters: null,
    periods: null,
    // Objectif ({ value }) : un chiffre clé (compte) ou une courbe de cumul.
    goal: null,
    // Alignement par défaut = celui de l'axe par défaut (l'année, axe de temps).
    compare: Object.freeze({ layout: 'overlay', align: 'elapsed', normalize: 'none', toDate: true }),
    view: Object.freeze({
        chart: 'bar', orientation: 'vertical', stack: false, palette: 'auto',
        labels: false, log: false, top: 12, sort: 'natural', smooth: false, record: false, projection: false,
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

// `sources` : la source du graphique, ou toutes celles qu'il compare — une
// mesure doit valoir pour chacune.
export function normalizeMeasure(raw, sources = 'finds') {
    const list = Array.isArray(sources) ? sources : [sources];
    const op = choice(isObject(raw) ? raw.op : raw, MEASURE_OPS, 'count');
    if (op === 'active' && !list.every(activeAllowed)) return { op: 'count' };
    if (op === 'found_share') {
        if (!list.every(foundShareAllowed)) return { op: 'count' };
        return raw?.base === 'all' ? { op, base: 'all' } : { op };
    }
    if (op === 'distinct') return { op, field: choice(raw?.field, sourceDistinctFields(list), 'caches') };
    if (op === 'mean') return { op, field: choice(raw?.field, sourceMeanFields(list), 'difficulty') };
    // Série « en cours » : celle qui court jusqu'à la fin de la période (ou
    // la veille — la journée n'est pas finie).
    if (op === 'streak') return raw?.current === true ? { op, current: true } : { op };
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
    } else if (kind === 'current') {
        period = { kind, unit: choice(raw.unit, CURRENT_UNITS, 'year') };
    } else if (kind === 'previous' || kind === 'dashboard') {
        period = { kind };
    } else if (kind === 'moments') {
        period = { kind, rule: choice(raw.rule, MOMENT_PERIOD_RULES, 'year_end') };
    }
    if (!period) return null;
    const label = flatText(raw.label, PERIOD_LABEL_MAX);
    if (label) period.label = label;
    return period;
}

// null = période du tableau de bord (héritée). Une liste dont aucune entrée
// n'est valide retombe aussi sur l'héritage. « La période précédente » en
// tête de liste ne précède rien : écartée.
export function normalizePeriods(raw) {
    if (!Array.isArray(raw)) return null;
    const periods = [];
    for (const item of raw) {
        const period = normalizePeriod(item);
        if (!period || (period.kind === 'previous' && !periods.length)) continue;
        periods.push(period);
        if (periods.length >= MAX_PERIODS) break;
    }
    if (!periods.length) return null;
    // La période du tableau de bord seule = l'héritage simple.
    if (periods.length === 1 && periods[0].kind === 'dashboard' && !periods[0].label) return null;
    return periods;
}

// La liste donne-t-elle plusieurs séries (plusieurs entrées, ou « chaque
// année / mois ») ? null (héritée) : une seule.
export function periodsAreMultiple(periods) {
    return Array.isArray(periods) && (periods.length > 1 || periods.some((p) => p.kind === 'each'));
}

// ---------------------------------------------------------------------------
// Compatibilités
// ---------------------------------------------------------------------------

// Regroupements possibles pour une mesure et des sources : un cumul suit le
// temps ; « caches actives » se lit en fin d'intervalle (temps) ou de
// période (total, catégories) ; seules les dimensions de toutes les sources.
// Séries et pauses se comptent en jours : une case d'un jour ou d'une
// semaine n'en contient pas.
const NO_RUN_DIMS = ['day', 'week', 'day_of_year', 'week_of_year', 'weekday', 'published_month'];

// Mesures qu'une carte par zones sait calculer (zone_model.mjs) : comptes,
// cumul, caches actives, valeurs distinctes (caches, jours, types,
// propriétaires), moyenne de D ou de T, et ses deux mesures propres. Les
// records datés n'ont pas d'équivalent par zone.
const ZONE_DISTINCT = ['caches', 'days', 'cache_type', 'owner'];
export function zoneMeasureAllowed(measure) {
    const op = measure?.op;
    if (op === 'distinct') return ZONE_DISTINCT.includes(measure.field);
    if (op === 'mean') return measure.field === 'difficulty' || measure.field === 'terrain';
    return ['count', 'cumulative', 'active', ...ZONE_ONLY_OPS].includes(op);
}

export function allowedGroupBy(measure, sources = 'finds') {
    const all = sourceDimensions(sources);
    if (ZONE_ONLY_OPS.includes(measure?.op)) return all.filter((dim) => ZONE_DIMENSIONS.includes(dim));
    const dims = zoneMeasureAllowed(measure) ? all : all.filter((dim) => !ZONE_DIMENSIONS.includes(dim));
    const zones = dims.filter((dim) => ZONE_DIMENSIONS.includes(dim));
    if (measure?.op === 'streak' && measure.current) return ['none'];
    if (measure?.op === 'streak' || measure?.op === 'gap') return dims.filter((dim) => !NO_RUN_DIMS.includes(dim));
    if (measure?.op === 'cumulative') return [...dims.filter((dim) => SEQUENTIAL_DIMENSIONS.includes(dim)), ...zones];
    if (measure?.op === 'active') {
        return dims.filter((dim) => dim === 'none' || SEQUENTIAL_DIMENSIONS.includes(dim)
            || (CATEGORY_DIMENSIONS.includes(dim) && dim !== 'published_month') || ZONE_DIMENSIONS.includes(dim));
    }
    return dims;
}

// 2ᵉ dimension possible : jamais la même que l'axe ; « par année » n'a pas
// de sens sur un axe de temps continu (il le découpe déjà) ; pas de
// découpage d'un chiffre clé ; seulement celles des sources.
export function allowedSplitBy(groupBy, sources = 'finds') {
    if (groupBy === 'none' || groupBy === 'published_month' || ZONE_DIMENSIONS.includes(groupBy)) return [];
    const dims = new Set(sourceDimensions(sources));
    return SPLIT_DIMENSIONS.filter((dim) => dim !== groupBy && dims.has(dim)
        && !(dim === 'year' && dimensionKind(groupBy) === 'time'));
}

// Sources ajoutées à un graphique (« mes trouvailles et les trouvailles
// reçues ») : même groupe que la source principale (sameSourceGroup), sans
// doublon, MAX_EXTRA_SOURCES au plus.
export function normalizeExtraSources(raw, source) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!isChartSource(item) || item === source || out.includes(item)) continue;
        if (!sameSourceGroup(source, item)) continue;
        out.push(item);
        if (out.length >= MAX_EXTRA_SOURCES) break;
    }
    return out;
}

// Toutes les sources d'un graphique.
export const chartSources = (spec) => [spec.source, ...(spec.extraSources || [])];

// Le graphique a-t-il plusieurs séries (périodes ou sources) ?
export function hasSeveralSeries(spec) {
    return periodsAreMultiple(spec.periods) || (spec.extraSources || []).length > 0;
}

// Alignements de périodes pour un axe : temps continu → jours écoulés ou
// vraie date ; cyclique → calendrier ou jours écoulés ; catégorie ou chiffre
// clé → sans objet (« calendar », valeur neutre).
export function allowedAligns(groupBy) {
    const kind = dimensionKind(groupBy);
    if (kind === 'time') return ['elapsed', 'absolute'];
    // Le jour de la semaine n'a pas de « depuis le début » : lundi est lundi.
    if (kind === 'cyclic' && groupBy !== 'weekday') return ['calendar', 'elapsed'];
    return ['calendar'];
}

// Mise à l'échelle des valeurs : en pourcentage du total de chaque série
// (comptes, valeurs distinctes, cumul → part atteinte), ou par jour de
// période (comptes et caches distinctes, sur un chiffre clé ou des
// catégories — un axe de temps a déjà ses intervalles).
export function allowedNormalize({ measure, groupBy } = {}) {
    const out = ['none'];
    // Carte : densité (par km²) pour ce qui se compte.
    if (dimensionKind(groupBy) === 'zone') {
        if (['count', 'cumulative', 'active', 'distinct'].includes(measure?.op)) out.push('per_km2');
        return out;
    }
    if (['count', 'distinct', 'cumulative'].includes(measure?.op)) out.push('percent');
    const kind = dimensionKind(groupBy);
    if ((measure?.op === 'count' || (measure?.op === 'distinct' && measure.field === 'caches'))
        && (kind === 'none' || kind === 'category')) out.push('per_day');
    return out;
}

// Présentations d'une comparaison. L'écart oppose exactement deux périodes
// fixes, sans 2ᵉ dimension, sur un graphique qui sait le montrer ; un anneau
// ne se superpose pas (côte à côte seulement). Périodes héritées (null) :
// rien à vérifier, tout reste possible sauf ce que le graphique exclut.
export function allowedLayouts({ periods, splitBy, view, extraSources = [] } = {}) {
    const chart = view?.chart;
    // Carte : une vignette par période.
    if (chart === 'map') return ['side'];
    // Calendrier et grille ne dessinent qu'une période (la première) ; le
    // radar superpose ses polygones.
    if (chart === 'calendar' || chart === 'heatmap' || chart === 'radar' || chart === 'challenge') return ['overlay'];
    const layouts = chart === 'donut' ? ['side'] : ['overlay', 'side'];
    const deltaCharts = ['bar', 'line', 'area', 'number'];
    const known = Array.isArray(periods);
    const extra = (extraSources || []).length;
    // Deux séries exactement : deux périodes d'une source, ou une période
    // de deux sources.
    let pair = false;
    if (extra === 0) pair = !known || (periods.length === 2 && !periods.some((p) => p.kind === 'each'));
    else if (extra === 1) pair = !known || (periods.length === 1 && periods[0].kind !== 'each');
    if (pair && !splitBy && deltaCharts.includes(chart)) layouts.push('delta');
    return layouts;
}

// Le cumul et la moyenne ne s'additionnent pas en parts d'un tout ; les
// caches actives d'une date, si.
const ADDITIVE_OPS = ['count', 'distinct', 'max_per_day', 'active'];
// Catégories assez peu nombreuses et sans ordre pour un anneau / un radar.
const PART_CYCLIC = ['weekday', 'month_of_year'];
// Grilles de défis (chart_challenge.mjs › CHALLENGE_GRIDS) : D/T 81,
// Calendrier 366, Jasmer, mois de trouvaille — des cases trouvées ou non,
// donc un comptage, d'une seule source et sans 2ᵉ dimension.
const CHALLENGE_GROUPS = ['dt', 'day_of_year', 'published_month', 'month'];
const CHALLENGE_OPS = ['count', 'distinct'];

// Types de graphiques compatibles, dans l'ordre de préférence (le premier
// sert de repli à la normalisation).
export function allowedCharts({ measure, groupBy, splitBy, extraSources = [] } = {}) {
    // Le mois de publication n'existe que pour la grille Jasmer.
    if (groupBy === 'published_month') return ['challenge'];
    const kind = dimensionKind(groupBy);
    if (kind === 'zone') return ['map'];
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
    if (CHALLENGE_GROUPS.includes(groupBy) && !splitBy && !(extraSources || []).length
        && CHALLENGE_OPS.includes(measure?.op)) charts.push('challenge');
    return charts;
}

// ---------------------------------------------------------------------------
// Description complète
// ---------------------------------------------------------------------------

function normalizeCompare(raw, spec) {
    const src = isObject(raw) ? raw : {};
    const defaults = CHART_SPEC_DEFAULTS.compare;
    const layouts = allowedLayouts(spec);
    const aligns = allowedAligns(spec.groupBy);
    const normalizes = allowedNormalize(spec);
    return {
        layout: choice(src.layout, layouts, layouts[0]),
        align: choice(src.align, aligns, aligns[0]),
        normalize: choice(src.normalize, normalizes, defaults.normalize),
        toDate: bool(src.toDate, defaults.toDate),
    };
}

// Objectif et projection : un chiffre clé qui compte (trouvailles, caches,
// jours…) ou une courbe de cumul.
export const GOAL_RANGE = Object.freeze([1, 10000000]);
export function goalApplies({ measure, groupBy, view } = {}) {
    const chart = view?.chart;
    if (groupBy === 'none' && chart === 'number') return ['count', 'distinct'].includes(measure?.op);
    return measure?.op === 'cumulative' && (chart === 'line' || chart === 'area');
}

function normalizeGoal(raw, spec) {
    if (!isObject(raw) || !goalApplies(spec)) return null;
    const value = strictInt(raw.value, GOAL_RANGE);
    return value === null ? null : { value };
}

function normalizeView(raw, spec) {
    const src = isObject(raw) ? raw : {};
    const defaults = CHART_SPEC_DEFAULTS.view;
    const charts = allowedCharts(spec);
    const chart = choice(src.chart, charts, charts[0]);
    return {
        chart,
        orientation: choice(src.orientation, CHART_ORIENTATIONS, defaults.orientation),
        stack: bool(src.stack, defaults.stack),
        palette: choice(src.palette, CHART_PALETTES, defaults.palette),
        labels: bool(src.labels, defaults.labels),
        log: bool(src.log, defaults.log),
        top: intIn(src.top, defaults.top, CHART_TOP_RANGE),
        sort: choice(src.sort, CHART_SORTS, defaults.sort),
        smooth: bool(src.smooth, defaults.smooth),
        // Mettre le record en avant (barres, courbes, aires d'une série).
        record: bool(src.record, defaults.record),
        // Prolonger à ce rythme (chart_goal.mjs), là où un objectif a un sens.
        projection: bool(src.projection, defaults.projection) && goalApplies({ ...spec, view: { chart } }),
        // Réglages de carte, seulement sur une carte (les autres graphiques
        // gardent leur forme).
        ...(chart === 'map' ? { map: normalizeMapView(src.map) } : {}),
    };
}

export const MAP_VIEW_DEFAULTS = Object.freeze({
    scale: 'quantile', classes: 5, frame: 'auto', highlight: true, gridSize: GRID_DEFAULT_SIZE,
});

function normalizeMapView(raw) {
    const src = isObject(raw) ? raw : {};
    const d = MAP_VIEW_DEFAULTS;
    return {
        scale: choice(src.scale, MAP_SCALES, d.scale),
        classes: intIn(src.classes, d.classes, MAP_CLASSES_RANGE),
        frame: choice(src.frame, MAP_FRAMES, d.frame),
        // Contour des zones qui ont changé depuis la vignette précédente.
        highlight: bool(src.highlight, d.highlight),
        // Grille : km entre deux centres de cases (zone_grid.mjs › GRID_SIZES).
        gridSize: normalizeGridSize(src.gridSize),
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
    const extraSources = normalizeExtraSources(src.extraSources, source);
    const sources = [source, ...extraSources];
    const measure = normalizeMeasure(src.measure, sources);
    // Repli d'un cumul sur le mois, lisible sur toute durée (une courbe par
    // année n'aurait que quelques points).
    const fallbackGroup = STOCK_OPS.includes(measure.op) ? 'month' : CHART_SPEC_DEFAULTS.groupBy;
    const groups = allowedGroupBy(measure, sources);
    // (Série en cours : « au total » seulement.)
    const groupBy = choice(src.groupBy, groups, groups.includes(fallbackGroup) ? fallbackGroup : groups[0]);
    const splitBy = choice(src.splitBy, allowedSplitBy(groupBy, sources), null);
    const periods = normalizePeriods(src.periods);

    const spec = {
        v: CHART_SPEC_VERSION,
        id: typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : newId(),
        title: flatText(src.title, CHART_TITLE_MAX),
        source,
        extraSources,
        measure,
        groupBy,
        splitBy,
        filters: normalizeFilters(src.filters),
        periods,
    };
    // La vue d'abord : la présentation de la comparaison dépend du graphique.
    const view = normalizeView(src.view, spec);
    // Moments clés : carte seulement, et seuls (ils remplacent la liste).
    if (spec.periods) {
        const moments = spec.periods.find((p) => p.kind === 'moments');
        if (view.chart !== 'map') {
            const kept = spec.periods.filter((p) => p.kind !== 'moments');
            spec.periods = kept.length ? kept : null;
        } else if (moments) {
            spec.periods = [moments];
        }
    }
    spec.compare = normalizeCompare(src.compare, { ...spec, view });
    spec.view = view;
    spec.goal = normalizeGoal(src.goal, spec);
    return spec;
}

// Nouvelle description à partir d'un modèle partiel (question toute faite,
// choix de la galerie). L'identifiant est toujours neuf.
export function createChartSpec(overrides = {}, newId = newChartId) {
    return normalizeChartSpec({ ...overrides, id: undefined }, newId);
}
