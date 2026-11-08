// « Envoyer en panneau vidéo » (chart_panel_link.mjs) : graphique → panneau
// Stats des pages carte.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { panelFromSpec, panelTarget } from '../../static/js/chart_panel_link.mjs';
import { normalizeStatsPanel } from '../../static/js/stats_model.mjs';

const seqId = (() => { let n = 0; return () => (++n).toString(16).padStart(6, 'a'); })();
const convert = (raw, extra = {}) => panelFromSpec(normalizeChartSpec(raw), { newId: seqId, ...extra });

test('barres par type : panneau à barres des trouvailles, options reprises', () => {
    const out = convert({ groupBy: 'cache_type', view: { chart: 'bar', orientation: 'horizontal', top: 5, sort: 'value', palette: 'gc' } },
        { title: 'Mes types' });
    assert.equal(out.list, 'panels');
    assert.equal(out.page, 'main');
    assert.equal(out.panel.kind, 'bar');
    assert.equal(out.panel.metric, 'cache_type');
    assert.equal(out.panel.title, 'Mes types');
    assert.equal(out.panel.options.orientation, 'horizontal');
    assert.equal(out.panel.options.max_items, 5);
    assert.equal(out.panel.options.sort, 'count');
    assert.equal(out.panel.style.palette, 'gc');
    assert.equal(out.panel.options.source, undefined);
    assert.deepEqual(out.dropped, []);
    // Le panneau est valide tel quel (relu par la normalisation).
    assert.deepEqual(normalizeStatsPanel(out.panel), out.panel);
});

test('anneau, mois de l’année, jour de la semaine, D/T, calendrier, chiffre clé', () => {
    assert.deepEqual(pick(convert({ groupBy: 'container', view: { chart: 'donut' } })), ['donut', 'container']);
    assert.deepEqual(pick(convert({ groupBy: 'month_of_year' })), ['bar', 'month']);
    assert.deepEqual(pick(convert({ groupBy: 'weekday' })), ['bar', 'weekday']);
    assert.deepEqual(pick(convert({ groupBy: 'dt', view: { chart: 'heatmap' } })), ['grid', 'dt']);
    assert.deepEqual(pick(convert({ groupBy: 'day', view: { chart: 'calendar' } })), ['grid', 'activity']);
    assert.deepEqual(pick(convert({ groupBy: 'month' })), ['grid', 'finds_ym']);
    assert.deepEqual(pick(convert({ groupBy: 'none', view: { chart: 'number' } })), ['counter', 'summary']);
    assert.deepEqual(pick(convert({ groupBy: 'month', measure: { op: 'cumulative' }, view: { chart: 'line' } })), ['line', 'cumulative']);
});

function pick(out) {
    assert.ok(!out.error, out.error);
    return [out.panel.kind, out.panel.metric];
}

test('sources : DNF et caches posées (page principale), Mes poses, Évolution', () => {
    const dnf = convert({ source: 'dnf', groupBy: 'cache_type' });
    assert.equal(dnf.list, 'panels');
    assert.equal(dnf.panel.options.source, 'dnf');
    const fav = convert({ source: 'poses.favorites', groupBy: 'finder' });
    assert.equal(fav.list, 'poses_panels');
    assert.equal(fav.panel.options.source, 'favorites');
    assert.equal(fav.panel.metric, 'finder');
    const placed = convert({ source: 'evolution:4', groupBy: 'cache_type' });
    assert.equal(placed.list, 'evolution_panels');
    assert.equal(placed.panel.options.counted, 'placed');
    const archived = convert({ source: 'evolution:4:archived', groupBy: 'year', view: { chart: 'line' } });
    assert.deepEqual(pick(archived), ['line', 'archivees']);
    const active = convert({ source: 'evolution:4', groupBy: 'month', measure: { op: 'active' }, view: { chart: 'area' } });
    assert.deepEqual(pick(active), ['line', 'actives']);
    assert.equal(panelTarget('inconnu'), null);
});

test('ce qui ne suit pas est signalé', () => {
    const out = convert({
        groupBy: 'cache_type', splitBy: 'year', filters: { container: ['Micro'] },
        periods: [{ kind: 'year', year: 2025 }],
    });
    assert.deepEqual(out.dropped, ['periods', 'filters', 'split']);
    // Période du tableau de bord : celle qui s'applique vraiment.
    const dash = convert({ groupBy: 'cache_type' }, { periods: [{ kind: 'year', year: 2024 }] });
    assert.deepEqual(dash.dropped, ['periods']);
    assert.deepEqual(convert({ groupBy: 'cache_type' }, { periods: [{ kind: 'all' }] }).dropped, []);
});

test('pas de panneau équivalent', () => {
    assert.equal(convert({ groupBy: 'year', extraSources: ['dnf'] }).error, 'several-sources');
    // Moyenne, nombre distinct : un panneau ne fait que compter.
    assert.equal(convert({ groupBy: 'year', measure: { op: 'mean', field: 'difficulty' } }).error, 'unsupported');
    // Dimensions sans panneau : trimestres, année de publication.
    assert.equal(convert({ groupBy: 'quarter' }).error, 'unsupported');
    assert.equal(convert({ groupBy: 'published_year' }).error, 'unsupported');
});
