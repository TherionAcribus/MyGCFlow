// Tableaux de bord de la page Statistiques : document sauvegardé
// (`dashboards.json`, dashboards_store.py), héritage période / filtres,
// questions toutes faites. Module pur, testé par
// tests/js/dashboard_model.test.mjs.
//
// Document :
//   { v: 1, active: '<id>', dashboards: [
//       { id, name, period, filters, items: [{ size, spec }] } ] }
// `period` : une période (chart_spec.mjs › normalizePeriod), celle que les
// graphiques sans période propre héritent. `filters` : idem pour les filtres
// (lot 3 pour l'interface ; `{}` = aucun).

import {
    createChartSpec,
    newChartId,
    normalizeChartSpec,
    normalizeFilters,
    normalizePeriod,
} from './chart_spec.mjs';
import { ymdOfDay } from './stats_model.mjs';

export const DASHBOARDS_VERSION = 1;
export const MAX_DASHBOARDS = 20;
export const MAX_ITEMS = 24;
export const DASHBOARD_NAME_MAX = 60;
export const DASHBOARD_SIZES = Object.freeze(['S', 'M', 'L', 'XL']);
// Colonnes occupées sur 12.
export const SIZE_COLUMNS = Object.freeze({ S: 4, M: 6, L: 8, XL: 12 });
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
    return { size: DASHBOARD_SIZES.includes(raw.size) ? raw.size : 'M', spec };
}

export function normalizeDashboard(raw, { newId = newChartId, defaultName = '' } = {}) {
    if (!isObject(raw)) return null;
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw.items) ? raw.items : []) {
        const item = normalizeItem(entry, newId);
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

export const QUESTION_GROUPS = Object.freeze(['overview', 'compare', 'when', 'caches', 'places']);

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
]);

// Tableau de bord de la première visite.
export const DEFAULT_QUESTIONS = Object.freeze(['total', 'days', 'countries_count', 'by_year', 'progress', 'ahead', 'types', 'months']);

export function questionById(id) {
    return QUESTIONS.find((q) => q.id === id) || null;
}

// Nouvel élément depuis une question (titre laissé vide : le titre par
// défaut suit la mesure et le regroupement ; celui de la question est posé
// par l'appelant, qui a la traduction).
export function itemFromQuestion(id, { newId = newChartId, title = '' } = {}) {
    const question = questionById(id);
    if (!question) return null;
    return { size: question.size, spec: createChartSpec({ ...question.spec, title }, newId) };
}

export function defaultDashboard({ newId = newChartId, name = '', titleOf = () => '' } = {}) {
    return {
        id: newId(),
        name,
        period: { ...DEFAULT_PERIOD },
        filters: {},
        items: DEFAULT_QUESTIONS.map((id) => itemFromQuestion(id, { newId, title: titleOf(id) })),
    };
}

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

