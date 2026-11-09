// Séries et records de la page Statistiques : meilleure journée, plus longue
// série de jours de cache, série en cours, plus longue pause — calcul
// (chart_query.mjs › dayRecord), libellés, dessin, liens carte et panneau.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedGroupBy, normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { dayRecord, runChartQuery } from '../../static/js/chart_query.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';
import { buildChartOption, numberModel, recordIndex } from '../../static/js/chart_echarts.mjs';
import { chartLinksToMap, mapSelectionFor } from '../../static/js/chart_map_link.mjs';
import { panelFromSpec } from '../../static/js/chart_panel_link.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
const TODAY = day('2025-03-02');

// Juillet 2024 : 1-2-3 (série de 3), le 10 ; fin d'année : 31/12 → 02/01
// (série de 3 à cheval) ; 1ᵉʳ mars 2025 : deux trouvailles (meilleure
// journée), veille d'aujourd'hui (série en cours d'un jour).
const DATES = ['2024-07-01', '2024-07-02', '2024-07-03', '2024-07-10', '2024-12-31',
    '2025-01-01', '2025-01-02', '2025-03-01', '2025-03-01'];
const table = findsTable({
    count: DATES.length,
    date: DATES,
    published: DATES.map(() => null),
    kind: DATES.map(() => 0),
    code: DATES.map((_, i) => 'GC' + i),
    difficulty: DATES.map(() => 1.5),
    terrain: DATES.map(() => 2),
    attributes: DATES.map(() => []),
    dicts: {},
});

const tokens = {
    text: '#1f2b38', textMuted: '#5b6878', grid: '#e8ecf1', surface: '#ffffff', others: '#a9b1bb',
    unknown: '#cfd5dc', series: ['#2a78d6'], up: '#2a78d6', down: '#e34948', empty: '#eef1f5',
    heat: ['#e8f1fc', '#104281'],
};
const labels = makeLabels({ locale: 'fr' });
const ctx = { labels, tokens, typeColors: {}, attributeName: (k) => k, width: 600 };

function run(measure, groupBy = 'none', extra = {}) {
    const spec = normalizeChartSpec({ measure, groupBy, periods: [{ kind: 'all' }], ...extra });
    return { spec, result: runChartQuery(spec, table, { today: TODAY }) };
}

test('dayRecord : meilleure journée, série, pause, série en cours', () => {
    const counts = new Map([[10, 1], [11, 3], [12, 1], [20, 3], [21, 1]]);
    assert.deepEqual(dayRecord('max_per_day', counts), { value: 3, from: 11, to: 11 });   // la plus ancienne
    assert.deepEqual(dayRecord('streak', counts), { value: 3, from: 10, to: 12 });
    assert.deepEqual(dayRecord('gap', counts), { value: 7, from: 13, to: 19 });
    // En cours : jusqu'à la fin, ou la veille ; sinon 0.
    assert.deepEqual(dayRecord('streak', counts, { current: true, end: 21 }), { value: 2, from: 20, to: 21 });
    assert.deepEqual(dayRecord('streak', counts, { current: true, end: 22 }), { value: 2, from: 20, to: 21 });
    assert.equal(dayRecord('streak', counts, { current: true, end: 23 }).value, 0);
    assert.deepEqual(dayRecord('streak', new Map()), { value: 0, from: null, to: null });
    assert.equal(dayRecord('gap', new Map([[5, 1]])).value, 0);
});

test('calcul : valeur et jours du record, par case', () => {
    const streak = run({ op: 'streak' }).result.series[0];
    assert.deepEqual(streak.values, [3]);
    assert.deepEqual(streak.records, [{ from: day('2024-07-01'), to: day('2024-07-03') }]);   // la plus ancienne
    // Par année : la série à cheval sur le 1ᵉʳ janvier est coupée.
    const byYear = run({ op: 'streak' }, 'year').result.series[0];
    assert.deepEqual(byYear.values, [3, 2]);
    assert.deepEqual(byYear.records[1], { from: day('2025-01-01'), to: day('2025-01-02') });
    // Pause : du 11 juillet au 30 décembre.
    const gap = run({ op: 'gap' }).result.series[0];
    assert.deepEqual(gap.values, [173]);
    assert.deepEqual(gap.records, [{ from: day('2024-07-11'), to: day('2024-12-30') }]);
    const best = run({ op: 'max_per_day' }).result.series[0];
    assert.deepEqual(best.values, [2]);
    assert.deepEqual(best.records, [{ from: day('2025-03-01'), to: day('2025-03-01') }]);
    // En cours : jugée à aujourd'hui, même sur « toute la période » (qui
    // finit à la dernière trouvaille).
    assert.deepEqual(run({ op: 'streak', current: true }).result.series[0].values, [1]);
    const later = runChartQuery(normalizeChartSpec({ measure: { op: 'streak', current: true }, groupBy: 'none', periods: [{ kind: 'all' }] }),
        table, { today: day('2025-03-10') });
    assert.deepEqual(later.series[0].values, [0]);
    assert.deepEqual(later.series[0].records, [null]);
    // Tri par valeur : les jours suivent leur case.
    const sorted = run({ op: 'streak' }, 'year', { view: { sort: 'value' } }).result;
    assert.deepEqual(sorted.series[0].records[0], { from: day('2024-07-01'), to: day('2024-07-03') });
});

test('spec : regroupements possibles, série en cours au total seulement', () => {
    assert.deepEqual(allowedGroupBy({ op: 'streak', current: true }), ['none']);
    assert.ok(!allowedGroupBy({ op: 'streak' }).includes('day'));
    assert.ok(!allowedGroupBy({ op: 'gap' }).includes('weekday'));
    assert.ok(allowedGroupBy({ op: 'gap' }).includes('cache_type'));
    const current = normalizeChartSpec({ measure: { op: 'streak', current: true }, groupBy: 'year' });
    assert.equal(current.groupBy, 'none');
    assert.equal(current.view.chart, 'number');
    assert.deepEqual(normalizeChartSpec({ measure: { op: 'streak', current: 'yes' } }).measure, { op: 'streak' });
});

test('libellés : jours, dates du record, chiffre clé', () => {
    assert.equal(labels.formatValue(23, { op: 'streak' }), '23 j');
    assert.equal(labels.measureName({ op: 'streak', current: true }), 'Série en cours');
    assert.equal(labels.recordText({ from: day('2024-07-01'), to: day('2024-07-03') }), 'du 1 juil. 2024 au 3 juil. 2024');
    assert.equal(labels.recordText({ from: day('2025-03-01'), to: day('2025-03-01') }), 'le 1 mars 2025');
    assert.equal(labels.recordText(null), '');
    const { spec, result } = run({ op: 'streak' });
    const [block] = numberModel(result, spec, ctx);
    assert.equal(block.text, '3 j');
    assert.equal(block.record, 'du 1 juil. 2024 au 3 juil. 2024');
});

test('dessin : le record épinglé sur une série seule', () => {
    assert.equal(recordIndex([1, 5, 3, 5]), 1);
    assert.equal(recordIndex([null, 0]), -1);
    const { spec, result } = run({ op: 'count' }, 'month', { view: { chart: 'bar', record: true } });
    const option = buildChartOption(result, spec, ctx);
    const mark = option.series[0].markPoint;
    assert.equal(mark.symbol, 'pin');
    const k = result.keys.indexOf(202407);
    assert.deepEqual(mark.data[0].coord, [k, 4]);
    // Sans l'option, ou avec plusieurs séries : pas d'épingle.
    const plain = run({ op: 'count' }, 'month', { view: { chart: 'bar' } });
    assert.equal(buildChartOption(plain.result, plain.spec, ctx).series[0].markPoint, undefined);
    const two = normalizeChartSpec({ groupBy: 'month_of_year', periods: [{ kind: 'year', year: 2025 }, { kind: 'year', year: 2024 }],
        view: { chart: 'bar', record: true } });
    const series = buildChartOption(runChartQuery(two, table, { today: TODAY }), two, ctx).series;
    assert.equal(series.length, 2);
    assert.ok(series.every((s) => !s.markPoint));
});

test('liens : la carte sur les jours du record, la tuile de la carte', () => {
    const { spec, result } = run({ op: 'streak' }, 'year');
    const link = mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: 1 });
    assert.deepEqual(link.selection.dates, { startDate: '2025-01-01', endDate: '2025-01-02' });
    const total = run({ op: 'max_per_day' });
    assert.deepEqual(mapSelectionFor({ spec: total.spec, result: total.result, seriesIndex: 0, keyIndex: 0 }).selection.dates,
        { startDate: '2025-03-01', endDate: '2025-03-01' });
    // Une pause n'a rien à montrer.
    assert.equal(chartLinksToMap(run({ op: 'gap' }).spec), false);

    const tile = (measure) => panelFromSpec(normalizeChartSpec({ measure, groupBy: 'none', view: { chart: 'number' } }), { newId: () => 'abcdef01' });
    assert.deepEqual(tile({ op: 'streak' }).panel.options.items, ['streak']);
    assert.deepEqual(tile({ op: 'max_per_day' }).panel.options.items, ['best_day']);
    assert.equal(tile({ op: 'streak', current: true }).error, 'unsupported');
});
