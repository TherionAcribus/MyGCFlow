// Tableaux de bord de la page Statistiques : document sauvegardé
// (`dashboards.json`, dashboards_store.py), héritage période / filtres,
// questions toutes faites. Module pur, testé par
// tests/js/dashboard_model.test.mjs.
//
// Document :
//   { v: 1, active: '<id>', dashboards: [
//       { id, name, kind, dataset, period, filters, items: [{ size, spec }] } ] }
// `kind` : 'personal' (trouvailles, DNF, caches posées, Mes poses) ou
// 'evolution' (un jeu CSV, `dataset`). Barrière : un tableau ne contient que
// des graphiques de sa famille — un graphique d'une autre famille est
// écarté à la lecture, un graphique Évolution d'un autre jeu rattaché au jeu
// du tableau.
// `period` : une période (chart_spec.mjs › normalizePeriod), celle que les
// graphiques sans période propre héritent. `filters` : idem pour les filtres
// (lot 3 pour l'interface ; `{}` = aucun).

import {
    createChartSpec,
    evolutionDatasetOf,
    evolutionSource,
    isEvolutionSource,
    newChartId,
    normalizeChartSpec,
    normalizeFilters,
    normalizePeriod,
    sourceFamily,
} from './chart_spec.mjs';
import { ymdOfDay } from './stats_model.mjs';

export const DASHBOARDS_VERSION = 1;
export const MAX_DASHBOARDS = 20;
export const MAX_ITEMS = 24;
export const DASHBOARD_NAME_MAX = 60;
export const DASHBOARD_SIZES = Object.freeze(['S', 'M', 'L', 'XL']);
// Colonnes occupées sur 12.
export const SIZE_COLUMNS = Object.freeze({ S: 4, M: 6, L: 8, XL: 12 });
// Hauteur d'une carte : normale ou grande (calendrier sur plusieurs années,
// longue liste de propriétaires…). Hauteur du graphique en pixels.
export const DASHBOARD_HEIGHTS = Object.freeze(['M', 'L']);
export const HEIGHT_PIXELS = Object.freeze({ M: 300, L: 460 });
const ID_RE = /^[0-9a-f]{6,32}$/;
const DEFAULT_PERIOD = Object.freeze({ kind: 'all' });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function flatName(value) {
    if (typeof value !== 'string') return '';
    return Array.from(value.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, DASHBOARD_NAME_MAX).join('');
}

// Élément d'un tableau de bord : description de graphique + taille. Une
// description d'une version future (normalizeChartSpec → null) est écartée.
export function normalizeItem(raw, newId = newChartId) {
    if (!isObject(raw)) return null;
    const spec = normalizeChartSpec(raw.spec, newId);
    if (!spec) return null;
    return {
        size: DASHBOARD_SIZES.includes(raw.size) ? raw.size : 'M',
        height: DASHBOARD_HEIGHTS.includes(raw.height) ? raw.height : 'M',
        spec,
    };
}

export const DASHBOARD_KINDS = Object.freeze(['personal', 'evolution']);

// Rattache une description Évolution au jeu `datasetId` (sources
// « evolution:<id> » et « :archived » conservées).
export function rebindEvolution(spec, datasetId) {
    const rebind = (source) => evolutionSource(datasetId, { archived: String(source).endsWith(':archived') });
    return normalizeChartSpec({
        ...spec,
        source: rebind(spec.source),
        extraSources: (spec.extraSources || []).map(rebind),
    });
}

// Un élément dans la famille du tableau : tel quel, rattaché au jeu, ou
// null (écarté).
function fitItem(item, kind, dataset) {
    const family = sourceFamily(item.spec.source);
    if (kind === 'personal') return family === 'personal' ? item : null;
    if (family !== 'evolution') return null;
    if (evolutionDatasetOf(item.spec.source) === dataset) return item;
    return { ...item, spec: rebindEvolution(item.spec, dataset) };
}

export function normalizeDashboard(raw, { newId = newChartId, defaultName = '' } = {}) {
    if (!isObject(raw)) return null;
    const dataset = Number.isInteger(raw.dataset) && raw.dataset >= 1 ? raw.dataset : null;
    const kind = raw.kind === 'evolution' && dataset ? 'evolution' : 'personal';
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw.items) ? raw.items : []) {
        const normalized = normalizeItem(entry, newId);
        const item = normalized ? fitItem(normalized, kind, dataset) : null;
        if (!item) continue;
        // Identifiants uniques dans le tableau : ils nomment les cartes.
        while (seen.has(item.spec.id)) item.spec.id = newId();
        seen.add(item.spec.id);
        items.push(item);
        if (items.length >= MAX_ITEMS) break;
    }
    return {
        id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId(),
        name: flatName(raw.name) || defaultName,
        kind,
        dataset: kind === 'evolution' ? dataset : null,
        period: normalizePeriod(raw.period) || { ...DEFAULT_PERIOD },
        filters: normalizeFilters(raw.filters) || {},
        items,
    };
}

// Document complet ; null s'il n'a aucun tableau utilisable (l'appelant en
// crée alors un par défaut).
export function normalizeDocument(raw, options = {}) {
    if (!isObject(raw) || raw.v !== DASHBOARDS_VERSION) return null;
    const dashboards = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw.dashboards) ? raw.dashboards : []) {
        const dashboard = normalizeDashboard(entry, options);
        if (!dashboard) continue;
        while (seen.has(dashboard.id)) dashboard.id = (options.newId || newChartId)();
        seen.add(dashboard.id);
        dashboards.push(dashboard);
        if (dashboards.length >= MAX_DASHBOARDS) break;
    }
    if (!dashboards.length) return null;
    const active = dashboards.some((d) => d.id === raw.active) ? raw.active : dashboards[0].id;
    return { v: DASHBOARDS_VERSION, active, dashboards };
}

// Périodes et filtres effectifs d'un graphique : les siens, sinon ceux du
// tableau de bord.
// « Période du tableau de bord » dans une comparaison (`{ kind: 'dashboard' }`)
// est remplacée par celle du tableau.
export function effectiveQueryOptions(spec, dashboard) {
    const base = dashboard?.period || DEFAULT_PERIOD;
    return {
        periods: spec.periods
            ? spec.periods.map((period) => (period.kind === 'dashboard' ? base : period))
            : [base],
        filters: spec.filters || dashboard?.filters || {},
    };
}

// Le graphique a-t-il une période propre (badge sur la carte) ? Comparer la
// période du tableau de bord à la précédente n'en est pas une : elle suit.
export const hasOwnPeriod = (spec) => Array.isArray(spec.periods) && spec.periods[0].kind !== 'dashboard';

// ---------------------------------------------------------------------------
// Questions toutes faites
// ---------------------------------------------------------------------------

// `spec` : modèle partiel passé à createChartSpec ; `periods` propres quand la
// question n'a de sens que sur tout l'historique (« ma meilleure année ») ou
// compare des périodes précises (« cette année contre l'an dernier »).
// `group` : section de la galerie (QUESTION_GROUPS).
const THIS_AND_LAST_YEAR = [{ kind: 'current', unit: 'year' }, { kind: 'previous' }];
const EACH_YEAR = [{ kind: 'each', unit: 'year' }];
// Source des questions Évolution : remplacée par le jeu du tableau
// (itemFromQuestion › dataset).
const EVO = 'evolution:1';
const EVO_ARCHIVED = 'evolution:1:archived';

export const QUESTION_GROUPS = Object.freeze(['overview', 'compare', 'when', 'caches', 'places', 'poses', 'dnf', 'zone', 'zone_caches']);

export const QUESTIONS = Object.freeze([
    { id: 'total', group: 'overview', icon: 'ti-hash', size: 'S', spec: { groupBy: 'none', view: { chart: 'number' } } },
    { id: 'days', group: 'overview', icon: 'ti-calendar-event', size: 'S', spec: { groupBy: 'none', measure: { op: 'distinct', field: 'days' }, view: { chart: 'number' } } },
    { id: 'countries_count', group: 'overview', icon: 'ti-world', size: 'S', spec: { groupBy: 'none', measure: { op: 'distinct', field: 'country' }, view: { chart: 'number' } } },
    { id: 'by_year', group: 'overview', icon: 'ti-chart-bar', size: 'M', spec: { groupBy: 'year', periods: [{ kind: 'all' }], view: { chart: 'bar', labels: true } } },
    { id: 'progress', group: 'overview', icon: 'ti-chart-line', size: 'M', spec: { groupBy: 'month', measure: { op: 'cumulative', from: 'all' }, view: { chart: 'area' } } },
    { id: 'record', group: 'overview', icon: 'ti-trophy', size: 'M', spec: { groupBy: 'year', measure: { op: 'max_per_day' }, periods: [{ kind: 'all' }], view: { chart: 'bar' } } },

    { id: 'ahead', group: 'compare', icon: 'ti-run', size: 'M', spec: { groupBy: 'day_of_year', measure: { op: 'cumulative' }, periods: THIS_AND_LAST_YEAR, view: { chart: 'line' }, compare: { toDate: false } } },
    { id: 'year_vs_last', group: 'compare', icon: 'ti-arrows-diff', size: 'M', spec: { groupBy: 'month_of_year', periods: THIS_AND_LAST_YEAR, view: { chart: 'bar' }, compare: { toDate: false } } },
    { id: 'year_delta', group: 'compare', icon: 'ti-plus-minus', size: 'M', spec: { groupBy: 'month_of_year', periods: THIS_AND_LAST_YEAR, view: { chart: 'bar' }, compare: { layout: 'delta' } } },
    { id: 'vs_previous_12', group: 'compare', icon: 'ti-scale', size: 'S', spec: { groupBy: 'none', periods: [{ kind: 'rolling', unit: 'month', count: 12 }, { kind: 'previous' }], view: { chart: 'number' } } },
    { id: 'all_years', group: 'compare', icon: 'ti-chart-arrows-vertical', size: 'L', spec: { groupBy: 'day_of_year', measure: { op: 'cumulative' }, periods: EACH_YEAR, view: { chart: 'line' }, compare: { toDate: false } } },
    { id: 'months_by_year', group: 'compare', icon: 'ti-chart-dots', size: 'L', spec: { groupBy: 'month_of_year', periods: EACH_YEAR, view: { chart: 'line' }, compare: { toDate: false } } },
    { id: 'types_vs_last', group: 'compare', icon: 'ti-chart-donut-2', size: 'L', spec: { groupBy: 'cache_type', periods: THIS_AND_LAST_YEAR, view: { chart: 'donut' }, compare: { layout: 'side' } } },

    { id: 'months', group: 'when', icon: 'ti-calendar-month', size: 'M', spec: { groupBy: 'month_of_year', view: { chart: 'bar' } } },
    { id: 'weekdays', group: 'when', icon: 'ti-calendar-week', size: 'M', spec: { groupBy: 'weekday', view: { chart: 'bar' } } },

    { id: 'types', group: 'caches', icon: 'ti-chart-donut', size: 'M', spec: { groupBy: 'cache_type', view: { chart: 'donut' } } },
    { id: 'difficulty', group: 'caches', icon: 'ti-stairs-up', size: 'M', spec: { groupBy: 'difficulty', view: { chart: 'bar' } } },
    { id: 'terrain', group: 'caches', icon: 'ti-mountain', size: 'M', spec: { groupBy: 'terrain', view: { chart: 'bar' } } },
    { id: 'containers', group: 'caches', icon: 'ti-box', size: 'M', spec: { groupBy: 'container', view: { chart: 'bar' } } },
    { id: 'age', group: 'caches', icon: 'ti-hourglass', size: 'M', spec: { groupBy: 'age', view: { chart: 'bar' } } },

    { id: 'countries', group: 'places', icon: 'ti-flag', size: 'M', spec: { groupBy: 'country', view: { chart: 'bar', orientation: 'horizontal', top: 10 } } },
    { id: 'owners', group: 'places', icon: 'ti-users', size: 'M', spec: { groupBy: 'owner', view: { chart: 'bar', orientation: 'horizontal', top: 10 } } },

    // Mes poses et mes caches posées.
    { id: 'received_by_month', group: 'poses', icon: 'ti-map-pin-check', size: 'M', spec: { source: 'poses.received', groupBy: 'month', view: { chart: 'bar' } } },
    { id: 'favorites_total', group: 'poses', icon: 'ti-heart', size: 'S', spec: { source: 'poses.favorites', groupBy: 'none', view: { chart: 'number' } } },
    { id: 'top_caches', group: 'poses', icon: 'ti-map-pins', size: 'M', spec: { source: 'poses.received', groupBy: 'cache', view: { chart: 'bar', orientation: 'horizontal', top: 10 } } },
    { id: 'top_finders', group: 'poses', icon: 'ti-user-heart', size: 'M', spec: { source: 'poses.received', groupBy: 'finder', view: { chart: 'bar', orientation: 'horizontal', top: 10 } } },
    { id: 'owned_active', group: 'poses', icon: 'ti-activity', size: 'M', spec: { source: 'owned', measure: { op: 'active' }, groupBy: 'month', periods: [{ kind: 'all' }], view: { chart: 'area' } } },
    { id: 'finds_vs_received', group: 'poses', icon: 'ti-arrows-exchange', size: 'M', spec: { source: 'finds', extraSources: ['poses.received'], groupBy: 'year', periods: [{ kind: 'all' }], view: { chart: 'bar' } } },

    // Mes DNF.
    { id: 'dnf_by_year', group: 'dnf', icon: 'ti-mood-sad', size: 'M', spec: { source: 'dnf', groupBy: 'year', periods: [{ kind: 'all' }], view: { chart: 'bar' } } },
    { id: 'finds_vs_dnf', group: 'dnf', icon: 'ti-scale', size: 'M', spec: { source: 'finds', extraSources: ['dnf'], groupBy: 'year', periods: [{ kind: 'all' }], view: { chart: 'line' } } },

    // Évolution d'une zone.
    { id: 'evo_active_now', family: 'evolution', group: 'zone', icon: 'ti-map-pin', size: 'S', spec: { source: EVO, measure: { op: 'active' }, groupBy: 'none', view: { chart: 'number' } } },
    { id: 'evo_active', family: 'evolution', group: 'zone', icon: 'ti-activity', size: 'M', spec: { source: EVO, measure: { op: 'active' }, groupBy: 'month', view: { chart: 'area' } } },
    { id: 'evo_flows', family: 'evolution', group: 'zone', icon: 'ti-arrows-exchange', size: 'M', spec: { source: EVO, extraSources: [EVO_ARCHIVED], groupBy: 'year', view: { chart: 'bar' } } },
    { id: 'evo_published', family: 'evolution', group: 'zone', icon: 'ti-chart-bar', size: 'M', spec: { source: EVO, groupBy: 'year', view: { chart: 'bar' } } },
    { id: 'evo_types', family: 'evolution', group: 'zone_caches', icon: 'ti-chart-donut', size: 'M', spec: { source: EVO, measure: { op: 'active' }, groupBy: 'cache_type', view: { chart: 'donut' } } },
    { id: 'evo_counties', family: 'evolution', group: 'zone_caches', icon: 'ti-map', size: 'M', spec: { source: EVO, measure: { op: 'active' }, groupBy: 'county', view: { chart: 'bar', orientation: 'horizontal', top: 10 } } },
    { id: 'evo_dt', family: 'evolution', group: 'zone_caches', icon: 'ti-grid-dots', size: 'M', spec: { source: EVO, measure: { op: 'active' }, groupBy: 'dt', view: { chart: 'heatmap' } } },
]);

// Famille d'une question (personnelle par défaut).
export const questionFamily = (question) => question.family || 'personal';

// Tableau de bord de la première visite, et d'un nouveau tableau Évolution.
export const DEFAULT_QUESTIONS = Object.freeze(['total', 'days', 'countries_count', 'by_year', 'progress', 'ahead', 'types', 'months']);
export const DEFAULT_EVOLUTION_QUESTIONS = Object.freeze(['evo_active_now', 'evo_active', 'evo_flows', 'evo_types', 'evo_counties']);

export function questionById(id) {
    return QUESTIONS.find((q) => q.id === id) || null;
}

// Nouvel élément depuis une question (titre laissé vide : le titre par
// défaut suit la mesure et le regroupement ; celui de la question est posé
// par l'appelant, qui a la traduction).
export function itemFromQuestion(id, { newId = newChartId, title = '', dataset = null } = {}) {
    const question = questionById(id);
    if (!question) return null;
    let spec = createChartSpec({ ...question.spec, title }, newId);
    if (questionFamily(question) === 'evolution') {
        if (!dataset) return null;
        spec = { ...rebindEvolution(spec, dataset), id: spec.id };
    }
    return { size: question.size, height: 'M', spec };
}

// Nouveau tableau : personnel (questions de départ) ou Évolution d'un jeu.
// `withCharts: false` : vide.
export function defaultDashboard({
    newId = newChartId, name = '', titleOf = () => '', kind = 'personal', dataset = null, withCharts = true,
} = {}) {
    const evolution = kind === 'evolution' && Number.isInteger(dataset) && dataset >= 1;
    const questions = withCharts ? (evolution ? DEFAULT_EVOLUTION_QUESTIONS : DEFAULT_QUESTIONS) : [];
    return {
        id: newId(),
        name,
        kind: evolution ? 'evolution' : 'personal',
        dataset: evolution ? dataset : null,
        period: { ...DEFAULT_PERIOD },
        filters: {},
        items: questions.map((id) => itemFromQuestion(id, { newId, title: titleOf(id), dataset })).filter(Boolean),
    };
}

// Sources proposées dans un tableau : les siennes, jamais celles de l'autre
// famille.
export function dashboardSources(dashboard) {
    if (dashboard?.kind === 'evolution' && dashboard.dataset) {
        return [evolutionSource(dashboard.dataset), evolutionSource(dashboard.dataset, { archived: true })];
    }
    return ['finds', 'dnf', 'owned', 'poses.received', 'poses.dnf', 'poses.favorites'];
}

// La description respecte-t-elle la famille du tableau ?
export function specFitsDashboard(spec, dashboard) {
    const allowed = new Set(dashboardSources(dashboard));
    return [spec.source, ...(spec.extraSources || [])].every((s) => allowed.has(s));
}

export { isEvolutionSource };

export function defaultDocument(options = {}) {
    const dashboard = defaultDashboard(options);
    return { v: DASHBOARDS_VERSION, active: dashboard.id, dashboards: [dashboard] };
}

// ---------------------------------------------------------------------------
// Périodes proposées dans les menus
// ---------------------------------------------------------------------------

// Toutes les données, les 12 derniers mois, l'année et le mois en cours
// (relatifs : ils suivent le calendrier), puis chaque année passée des
// données, de la plus récente à la plus ancienne.
export function periodChoices(extent, today) {
    const current = ymdOfDay(today).y;
    const choices = [
        { kind: 'all' },
        { kind: 'rolling', unit: 'month', count: 12 },
        { kind: 'current', unit: 'year' },
        { kind: 'current', unit: 'month' },
    ];
    if (extent) {
        const first = ymdOfDay(extent.first).y;
        const last = Math.min(ymdOfDay(extent.last).y, current - 1);
        for (let y = last; y >= first; y--) choices.push({ kind: 'year', year: y });
    }
    return choices;
}

// Périodes d'un graphique (éditeur) : celles du tableau de bord, plus
// « chaque année / chaque mois » (une série par année ou mois des données).
export function chartPeriodChoices(extent, today) {
    return [...periodChoices(extent, today), { kind: 'each', unit: 'year' }, { kind: 'each', unit: 'month' }];
}

// Périodes « comparé à » : la période précédente d'abord (la plus courante),
// puis les mêmes que pour le graphique.
export function comparePeriodChoices(extent, today) {
    return [{ kind: 'previous' }, ...chartPeriodChoices(extent, today)];
}

// Valeur stable d'une période pour un <select> (null = héritée).
export function periodValue(period) {
    return period ? JSON.stringify(period) : '';
}

export function periodOfValue(value) {
    if (!value) return null;
    try {
        return normalizePeriod(JSON.parse(value));
    } catch (_) {
        return null;
    }
}


// ---------------------------------------------------------------------------
// Partager un tableau de bord (fichier JSON)
// ---------------------------------------------------------------------------

export const DASHBOARD_FILE_FORMAT = 'mygcflow-dashboard';
export const DASHBOARD_FILE_VERSION = 1;

// Contenu du fichier d'export : le tableau sans ses identifiants, et pour un
// tableau Évolution le NOM de son jeu (l'identifiant ne veut rien dire sur
// une autre installation).
export function exportDashboard(dashboard, { datasetName = null } = {}) {
    const body = {
        name: dashboard.name,
        kind: dashboard.kind,
        period: dashboard.period,
        filters: dashboard.filters,
        items: dashboard.items.map((item) => ({ size: item.size, height: item.height, spec: { ...item.spec, id: undefined } })),
    };
    if (dashboard.kind === 'evolution') body.datasetName = datasetName || '';
    return { format: DASHBOARD_FILE_FORMAT, v: DASHBOARD_FILE_VERSION, dashboard: JSON.parse(JSON.stringify(body)) };
}

// Fichier lu → { dashboard, warning } ou { error }. Identifiants neufs ;
// un tableau Évolution est rattaché au jeu de même nom, sinon au premier
// jeu (warning: 'dataset-guessed'), et refusé sans aucun jeu
// (error: 'no-dataset'). La barrière s'applique comme à la lecture du
// document (normalizeDashboard).
export function importDashboard(raw, { newId = newChartId, datasets = [], defaultName = '' } = {}) {
    if (!isObject(raw) || raw.format !== DASHBOARD_FILE_FORMAT || !isObject(raw.dashboard)) {
        return { error: 'not-a-dashboard' };
    }
    if (!Number.isInteger(raw.v) || raw.v < 1 || raw.v > DASHBOARD_FILE_VERSION) return { error: 'unknown-version' };
    const source = raw.dashboard;
    let dataset = null;
    let warning = null;
    if (source.kind === 'evolution') {
        if (!datasets.length) return { error: 'no-dataset' };
        const byName = datasets.find((d) => d.name === source.datasetName);
        dataset = (byName || datasets[0]).id;
        if (!byName) warning = 'dataset-guessed';
    }
    const items = (Array.isArray(source.items) ? source.items : [])
        .filter(isObject)
        .map((item) => ({ ...item, spec: isObject(item.spec) ? { ...item.spec, id: undefined } : item.spec }));
    const dashboard = normalizeDashboard({ ...source, id: undefined, dataset, items }, { newId, defaultName });
    return { dashboard, warning };
}

// Copie d'un tableau : identifiants neufs (tableau et graphiques).
export function duplicateDashboard(dashboard, { newId = newChartId, name = '' } = {}) {
    const copy = structuredClone(dashboard);
    copy.id = undefined;
    copy.name = name || dashboard.name;
    copy.items = copy.items.map((item) => ({ ...item, spec: { ...item.spec, id: undefined } }));
    return normalizeDashboard(copy, { newId });
}
