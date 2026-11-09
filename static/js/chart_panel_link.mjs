// « Envoyer en panneau vidéo » : un graphique de la page Statistiques →
// un panneau Stats des pages carte (stats_model.mjs), qui se remplit au fil
// de l'animation. Module pur, testé par tests/js/chart_panel_link.test.mjs.
//
// Un panneau compte depuis le début de l'animation jusqu'au jour affiché :
// il n'a ni période, ni comparaison, ni filtre propre (il suit ceux de la
// page carte), ni découpage. Le graphique donne donc la source, la forme,
// la dimension et quelques options d'affichage ; le reste est signalé
// (`dropped`) pour que l'utilisateur sache ce qui ne suit pas.

import {
    EVOLUTION_METRICS_BY_KIND,
    POSES_METRICS_BY_KIND,
    STATS_MAX_ITEMS_RANGE,
    createStatsPanel,
    statsSourceRegistry,
} from './stats_model.mjs';
import { evolutionDatasetOf } from './chart_spec.mjs';
import { CHALLENGE_GRIDS } from './chart_challenge.mjs';

// Source du graphique → liste de panneaux (page) et source du panneau.
export function panelTarget(source) {
    switch (source) {
        case 'finds': return { list: 'panels', page: 'main', source: 'finds' };
        case 'dnf': return { list: 'panels', page: 'main', source: 'dnf' };
        case 'owned': return { list: 'panels', page: 'main', source: 'owned' };
        case 'poses.received': return { list: 'poses_panels', page: 'poses', source: 'finds' };
        case 'poses.dnf': return { list: 'poses_panels', page: 'poses', source: 'dnf' };
        case 'poses.favorites': return { list: 'poses_panels', page: 'poses', source: 'favorites' };
        default:
            if (evolutionDatasetOf(source) !== null) {
                return { list: 'evolution_panels', page: 'evolution', source: 'finds', archived: source.endsWith(':archived') };
            }
            return null;
    }
}

function registryOf(target) {
    if (target.page === 'evolution') return EVOLUTION_METRICS_BY_KIND;
    if (target.page === 'poses') return POSES_METRICS_BY_KIND;
    return statsSourceRegistry(target.source);
}

// Dimension du graphique → métrique d'un panneau à barres / anneau.
const METRIC_OF_GROUP = {
    month_of_year: 'month',
    weekday: 'weekday',
    year: 'year',
};
const TIME_GROUPS = new Set(['year', 'quarter', 'month', 'week', 'day']);
const SORT_OF = { natural: 'natural', value: 'count', label: 'label' };
const PALETTE_OF = { accent: 'accent', gc: 'gc', multi: 'multi', heat: 'heat' };

const clampItems = (n) => Math.min(STATS_MAX_ITEMS_RANGE[1], Math.max(STATS_MAX_ITEMS_RANGE[0], n));

// Forme du panneau : { kind, metric } ou null.
function shapeOf(spec, target, registry) {
    const { chart } = spec.view;
    const op = spec.measure.op;
    const has = (kind, metric) => (registry[kind] || []).includes(metric);
    if (chart === 'number') {
        if (op === 'count' || op === 'active') return { kind: 'counter', metric: 'summary' };
        // Records datés : la tuile du même nom (« record », « série »).
        const item = { max_per_day: 'best_day', streak: 'streak' }[op];
        return item && !spec.measure.current ? { kind: 'counter', metric: 'summary', items: [item] } : null;
    }
    // Grille de défi : la même grille dans les panneaux de la carte.
    if (chart === 'challenge') {
        const metric = CHALLENGE_GRIDS[spec.groupBy];
        return op === 'count' && metric && has('grid', metric) ? { kind: 'grid', metric } : null;
    }
    if (spec.groupBy === 'dt' && has('grid', 'dt') && op === 'count') return { kind: 'grid', metric: 'dt' };
    if (chart === 'calendar') return op === 'count' && has('grid', 'activity') ? { kind: 'grid', metric: 'activity' } : null;
    if (chart === 'line' || chart === 'area') {
        if (!TIME_GROUPS.has(spec.groupBy)) return null;
        if (target.page === 'evolution') {
            if (op === 'active') return { kind: 'line', metric: 'actives' };
            if (op === 'count' || op === 'cumulative') return { kind: 'line', metric: target.archived ? 'archivees' : 'placees' };
            return null;
        }
        return op === 'count' || op === 'cumulative' ? { kind: 'line', metric: 'cumulative' } : null;
    }
    if (chart === 'heatmap') return null;
    // Barres, anneau, radar : un comptage par catégorie.
    if (op !== 'count' && !(op === 'active' && target.page === 'evolution')) return null;
    if (spec.groupBy === 'month' && has('grid', 'finds_ym')) return { kind: 'grid', metric: 'finds_ym' };
    const metric = METRIC_OF_GROUP[spec.groupBy] || spec.groupBy;
    if (chart === 'donut' && has('donut', metric)) return { kind: 'donut', metric };
    if (has('bar', metric)) return { kind: 'bar', metric };
    return null;
}

// Graphique → { list, page, panel, dropped } ou { error }.
//   error : 'several-sources' (graphique multi-sources), 'unsupported'
//   (forme, mesure ou dimension sans panneau équivalent).
//   dropped : ce qui ne suit pas — 'periods', 'filters', 'split', 'measure'.
// `periods` / `filters` : ceux qui s'appliquent vraiment (tableau de bord
// compris, effectiveQueryOptions) ; à défaut, ceux du graphique.
export function panelFromSpec(spec, { title = '', periods = null, filters = null, newId } = {}) {
    if (spec.extraSources?.length) return { error: 'several-sources' };
    const target = panelTarget(spec.source);
    if (!target) return { error: 'unsupported' };
    const registry = registryOf(target);
    const shape = shapeOf(spec, target, registry);
    if (!shape) return { error: 'unsupported' };

    const options = {};
    const style = {};
    if (target.source !== 'finds') options.source = target.source;
    if (target.page === 'evolution' && (shape.kind === 'bar' || shape.kind === 'donut')) {
        options.counted = spec.measure.op === 'active' ? 'active' : (target.archived ? 'archived' : 'placed');
    }
    if (shape.kind === 'bar') {
        if (spec.view.chart === 'bar') options.orientation = spec.view.orientation === 'horizontal' ? 'horizontal' : 'vertical';
        options.max_items = clampItems(spec.view.top);
        if (SORT_OF[spec.view.sort] && spec.view.sort !== 'natural') options.sort = SORT_OF[spec.view.sort];
    }
    if (shape.kind === 'donut') options.max_items = clampItems(spec.view.top);
    if (shape.items) {
        options.items = shape.items;
        options.columns = 1;
    }
    if (PALETTE_OF[spec.view.palette] && shape.kind !== 'line' && shape.kind !== 'counter') {
        style.palette = PALETTE_OF[spec.view.palette];
    }
    const panel = createStatsPanel(shape.kind, shape.metric, { title, options, style }, newId);
    if (!panel) return { error: 'unsupported' };

    const dropped = [];
    const used = periods || spec.periods || [];
    if (used.length > 1 || used.some((p) => p.kind !== 'all' && p.kind !== 'dashboard')) dropped.push('periods');
    if (Object.values(filters || spec.filters || {}).some((v) => Array.isArray(v) && v.length)) dropped.push('filters');
    if (spec.splitBy) dropped.push('split');
    if (spec.goal || spec.view.projection) dropped.push('goal');
    return { list: target.list, page: target.page, panel, dropped };
}
