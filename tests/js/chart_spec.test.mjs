// Description d'un graphique de la page Statistiques (static/js/chart_spec.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CHART_SPEC_DEFAULTS,
    CHART_SPEC_VERSION,
    FILTER_VALUES_MAX,
    MAX_PERIODS,
    allowedAligns,
    allowedCharts,
    allowedGroupBy,
    allowedSplitBy,
    createChartSpec,
    dimensionKind,
    isChartSource,
    newChartId,
    normalizeChartSpec,
    normalizeFilters,
    normalizeMeasure,
    normalizePeriod,
    normalizePeriods,
} from '../../static/js/chart_spec.mjs';

const fixedId = () => 'abc123';

test('une entrée vide donne la description par défaut, avec un identifiant neuf', () => {
    const spec = normalizeChartSpec(undefined, fixedId);
    assert.deepEqual(spec, {
        v: CHART_SPEC_VERSION,
        id: 'abc123',
        title: '',
        source: 'finds',
        measure: { op: 'count' },
        groupBy: 'year',
        splitBy: null,
        filters: null,
        periods: null,
        compare: { layout: 'overlay', align: 'elapsed', normalize: 'none', toDate: true },
        view: { ...CHART_SPEC_DEFAULTS.view },
    });
});

test('les valeurs par défaut forment elles-mêmes une description normalisée', () => {
    const defaults = { ...CHART_SPEC_DEFAULTS, id: 'abc123' };
    assert.deepEqual(normalizeChartSpec(defaults), JSON.parse(JSON.stringify(defaults)));
});

test('une description valide ressort identique (point fixe)', () => {
    const raw = {
        v: 1,
        id: 'a3f09c12',
        title: 'Cette année contre l\'an dernier',
        source: 'finds',
        measure: { op: 'count' },
        groupBy: 'month_of_year',
        splitBy: 'cache_type',
        filters: { cache_type: ['Traditional Cache'], country: ['France'] },
        periods: [{ kind: 'year', year: 2025 }, { kind: 'year', year: 2024, label: 'L\'an dernier' }],
        compare: { layout: 'delta', align: 'elapsed', normalize: 'percent', toDate: false },
        view: {
            chart: 'line', orientation: 'horizontal', stack: true, palette: 'gc',
            labels: true, log: true, top: 20, sort: 'value', smooth: true,
        },
    };
    const spec = normalizeChartSpec(raw);
    assert.deepEqual(spec, raw);
    assert.deepEqual(normalizeChartSpec(spec), spec);
});

test('identifiant : hexadécimal 6-32 gardé, sinon régénéré', () => {
    assert.equal(normalizeChartSpec({ id: 'deadbeef' }).id, 'deadbeef');
    assert.equal(normalizeChartSpec({ id: 'sel00001' }, fixedId).id, 'abc123');
    assert.equal(normalizeChartSpec({ id: 'abc' }, fixedId).id, 'abc123');
    assert.match(newChartId(), /^[0-9a-f]{12}$/);
});

test('createChartSpec part d\'un modèle mais prend toujours un identifiant neuf', () => {
    const spec = createChartSpec({ id: 'deadbeef', groupBy: 'weekday' }, fixedId);
    assert.equal(spec.id, 'abc123');
    assert.equal(spec.groupBy, 'weekday');
});

test('version : absente = v1, future = null (format inconnu, on ne devine pas)', () => {
    assert.equal(normalizeChartSpec({ groupBy: 'month' }).v, 1);
    assert.equal(normalizeChartSpec({ v: CHART_SPEC_VERSION + 1, groupBy: 'month' }), null);
    assert.equal(normalizeChartSpec({ v: 'abc' }).v, 1);
});

test('titre aplati, blancs de bord retirés, tronqué en points de code', () => {
    assert.equal(normalizeChartSpec({ title: '  Mes\ntrouvailles\r\n ' }).title, 'Mes trouvailles');
    const long = '🎯'.repeat(100);
    assert.equal(Array.from(normalizeChartSpec({ title: long }).title).length, 80);
    assert.equal(normalizeChartSpec({ title: 42 }).title, '');
});

test('sources : liste connue et jeux Évolution par identifiant', () => {
    for (const source of ['finds', 'dnf', 'owned', 'poses.received', 'poses.dnf', 'poses.favorites', 'evolution:3']) {
        assert.ok(isChartSource(source), source);
        assert.equal(normalizeChartSpec({ source }).source, source);
    }
    for (const source of ['evolution:', 'evolution:0', 'evolution:abc', 'poses', 'FINDS', null]) {
        assert.equal(isChartSource(source), false, String(source));
        assert.equal(normalizeChartSpec({ source }).source, 'finds');
    }
});

test('mesures : champ par défaut, champ inconnu remplacé, « actives » réservé aux ensembles vivants', () => {
    assert.deepEqual(normalizeMeasure({ op: 'distinct' }), { op: 'distinct', field: 'caches' });
    assert.deepEqual(normalizeMeasure({ op: 'distinct', field: 'country' }), { op: 'distinct', field: 'country' });
    assert.deepEqual(normalizeMeasure({ op: 'distinct', field: 'difficulty' }), { op: 'distinct', field: 'caches' });
    assert.deepEqual(normalizeMeasure({ op: 'mean' }), { op: 'mean', field: 'difficulty' });
    assert.deepEqual(normalizeMeasure({ op: 'mean', field: 'age' }), { op: 'mean', field: 'age' });
    assert.deepEqual(normalizeMeasure({ op: 'count', field: 'country' }), { op: 'count' });
    assert.deepEqual(normalizeMeasure({ op: 'cumulative', from: 'all' }), { op: 'cumulative', from: 'all' });
    assert.deepEqual(normalizeMeasure({ op: 'cumulative', from: 'x' }), { op: 'cumulative' });
    assert.deepEqual(normalizeMeasure({ op: 'active' }, 'finds'), { op: 'count' });
    assert.deepEqual(normalizeMeasure({ op: 'active' }, 'owned'), { op: 'active' });
    assert.deepEqual(normalizeMeasure({ op: 'active' }, 'evolution:2'), { op: 'active' });
    assert.deepEqual(normalizeMeasure('max_per_day'), { op: 'max_per_day' });
    assert.deepEqual(normalizeMeasure({ op: 'sum' }), { op: 'count' });
});

test('un cumul impose un axe qui suit le temps (repli sur le mois)', () => {
    assert.ok(!allowedGroupBy({ op: 'cumulative' }).includes('cache_type'));
    assert.ok(!allowedGroupBy({ op: 'cumulative' }).includes('weekday'));
    assert.ok(allowedGroupBy({ op: 'cumulative' }).includes('day_of_year'));
    const spec = normalizeChartSpec({ measure: { op: 'cumulative' }, groupBy: 'cache_type' });
    assert.equal(spec.groupBy, 'month');
    assert.equal(normalizeChartSpec({ measure: { op: 'cumulative' } }).groupBy, 'month');
    assert.equal(normalizeChartSpec({ measure: { op: 'cumulative' }, groupBy: 'day_of_year' }).groupBy, 'day_of_year');
});

test('genre des dimensions', () => {
    assert.equal(dimensionKind('none'), 'none');
    assert.equal(dimensionKind('month'), 'time');
    assert.equal(dimensionKind('month_of_year'), 'cyclic');
    assert.equal(dimensionKind('owner'), 'category');
    assert.equal(dimensionKind('bogus'), null);
});

test('2ᵉ dimension : jamais l\'axe lui-même, pas « année » sur un axe de temps, rien sur un chiffre clé', () => {
    assert.ok(!allowedSplitBy('cache_type').includes('cache_type'));
    assert.ok(allowedSplitBy('cache_type').includes('year'));
    assert.ok(!allowedSplitBy('month').includes('year'));
    assert.ok(allowedSplitBy('month_of_year').includes('year'));
    assert.deepEqual(allowedSplitBy('none'), []);
    assert.equal(normalizeChartSpec({ groupBy: 'month', splitBy: 'year' }).splitBy, null);
    assert.equal(normalizeChartSpec({ groupBy: 'month_of_year', splitBy: 'year' }).splitBy, 'year');
    assert.equal(normalizeChartSpec({ groupBy: 'country', splitBy: 'country' }).splitBy, null);
    assert.equal(normalizeChartSpec({ groupBy: 'country', splitBy: 'bogus' }).splitBy, null);
});

test('alignements selon l\'axe', () => {
    assert.deepEqual(allowedAligns('month'), ['elapsed', 'absolute']);
    assert.deepEqual(allowedAligns('day_of_year'), ['calendar', 'elapsed']);
    assert.deepEqual(allowedAligns('cache_type'), ['calendar']);
    assert.deepEqual(allowedAligns('none'), ['calendar']);
    assert.equal(normalizeChartSpec({ groupBy: 'month', compare: { align: 'calendar' } }).compare.align, 'elapsed');
    assert.equal(normalizeChartSpec({ groupBy: 'month', compare: { align: 'absolute' } }).compare.align, 'absolute');
    assert.equal(normalizeChartSpec({ groupBy: 'weekday', compare: { align: 'absolute' } }).compare.align, 'calendar');
});

test('écart : exactement deux périodes fixes, sinon superposé ; gardé si les périodes sont héritées', () => {
    const two = [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2025 }];
    assert.equal(normalizeChartSpec({ periods: two, compare: { layout: 'delta' } }).compare.layout, 'delta');
    assert.equal(normalizeChartSpec({ periods: two.slice(0, 1), compare: { layout: 'delta' } }).compare.layout, 'overlay');
    assert.equal(normalizeChartSpec({
        periods: [{ kind: 'each', unit: 'year' }, { kind: 'all' }], compare: { layout: 'delta' },
    }).compare.layout, 'overlay');
    assert.equal(normalizeChartSpec({ compare: { layout: 'delta' } }).compare.layout, 'delta');
});

test('graphiques compatibles selon l\'axe et la mesure', () => {
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'none' }), ['number', 'bar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'month' }), ['bar', 'line', 'area']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'day' }), ['bar', 'line', 'area', 'calendar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'cache_type' }), ['bar', 'donut', 'radar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'mean' }, groupBy: 'cache_type' }), ['bar', 'radar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'difficulty' }), ['bar', 'line', 'area', 'donut', 'radar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'dt' }), ['bar', 'donut', 'heatmap', 'radar']);
    assert.deepEqual(allowedCharts({ measure: { op: 'count' }, groupBy: 'weekday' }), ['bar', 'line', 'area', 'donut', 'radar']);
    assert.ok(allowedCharts({ measure: { op: 'count' }, groupBy: 'month_of_year', splitBy: 'year' }).includes('heatmap'));
});

test('un graphique incompatible est remplacé par le premier compatible', () => {
    assert.equal(normalizeChartSpec({ groupBy: 'none', view: { chart: 'line' } }).view.chart, 'number');
    assert.equal(normalizeChartSpec({ groupBy: 'month', view: { chart: 'donut' } }).view.chart, 'bar');
    assert.equal(normalizeChartSpec({ groupBy: 'month', view: { chart: 'line' } }).view.chart, 'line');
    assert.equal(normalizeChartSpec({ groupBy: 'country', view: { chart: 'donut' } }).view.chart, 'donut');
    assert.equal(normalizeChartSpec({ measure: { op: 'mean' }, groupBy: 'country', view: { chart: 'donut' } }).view.chart, 'bar');
});

test('vue : valeurs inconnues remplacées, top borné', () => {
    const view = normalizeChartSpec({
        view: { orientation: 'diagonal', stack: 'yes', palette: 'rainbow', top: 999, sort: 'random' },
    }).view;
    assert.equal(view.orientation, 'vertical');
    assert.equal(view.stack, false);
    assert.equal(view.palette, 'auto');
    assert.equal(view.top, 50);
    assert.equal(view.sort, 'natural');
    assert.equal(normalizeChartSpec({ view: { top: 1 } }).view.top, 3);
    assert.equal(normalizeChartSpec({ view: { top: '7' } }).view.top, 7);
});

test('filtres : null hérite, objet propre (même vide), valeurs canoniques et dédoublonnées', () => {
    assert.equal(normalizeFilters(null), null);
    assert.equal(normalizeFilters(undefined), null);
    assert.equal(normalizeFilters(['France']), null);
    assert.deepEqual(normalizeFilters({}), {});
    assert.deepEqual(normalizeFilters({ country: [] }), {});
    assert.deepEqual(normalizeFilters({
        country: [' France ', 'France', '', 12, null],
        difficulty: ['1.5', 2, '2.0', 6, 1.25, 'x', true],
        published_year: [2004, '2010', 1850, 'abc'],
        source_kind: ['lab', 'geocache', 'other'],
        bogus: ['x'],
    }), {
        source_kind: ['lab', 'geocache'],
        difficulty: ['1.5', '2'],
        country: ['France', '12'],
        published_year: ['2004', '2010'],
    });
    const many = Array.from({ length: FILTER_VALUES_MAX + 20 }, (_, i) => `v${i}`);
    assert.equal(normalizeFilters({ owner: many }).owner.length, FILTER_VALUES_MAX);
});

test('périodes : chaque sorte, bornes remises dans l\'ordre, libellé facultatif', () => {
    assert.deepEqual(normalizePeriod({ kind: 'all' }), { kind: 'all' });
    assert.deepEqual(normalizePeriod({ kind: 'year', year: '2024' }), { kind: 'year', year: 2024 });
    assert.equal(normalizePeriod({ kind: 'year', year: 1850 }), null);
    assert.equal(normalizePeriod({ kind: 'year', year: 2024.5 }), null);
    assert.deepEqual(normalizePeriod({ kind: 'month', year: 2024, month: 2 }), { kind: 'month', year: 2024, month: 2 });
    assert.equal(normalizePeriod({ kind: 'month', year: 2024, month: 13 }), null);
    assert.deepEqual(normalizePeriod({ kind: 'range', from: '2024-03-01', to: '2023-01-31' }),
        { kind: 'range', from: '2023-01-31', to: '2024-03-01' });
    assert.equal(normalizePeriod({ kind: 'range', from: '2023-02-29', to: '2023-03-01' }), null);
    assert.equal(normalizePeriod({ kind: 'range', from: '2023-02-01T00:00', to: '2023-03-01' }), null);
    assert.deepEqual(normalizePeriod({ kind: 'rolling' }), { kind: 'rolling', unit: 'month', count: 12 });
    assert.deepEqual(normalizePeriod({ kind: 'rolling', unit: 'day', count: 99999 }), { kind: 'rolling', unit: 'day', count: 3650 });
    assert.deepEqual(normalizePeriod({ kind: 'each' }), { kind: 'each', unit: 'year' });
    assert.deepEqual(normalizePeriod({ kind: 'each', unit: 'month', from: '2024-12-31', to: '2020-01-01' }),
        { kind: 'each', unit: 'month', from: '2020-01-01', to: '2024-12-31' });
    assert.deepEqual(normalizePeriod({ kind: 'each', from: 'bad', to: '2020-01-01' }),
        { kind: 'each', unit: 'year', to: '2020-01-01' });
    assert.deepEqual(normalizePeriod({ kind: 'year', year: 2024, label: '  L\'an\ndernier ' }),
        { kind: 'year', year: 2024, label: 'L\'an dernier' });
    assert.equal(normalizePeriod({ kind: 'week' }), null);
    assert.equal(normalizePeriod('2024'), null);
});

test('liste de périodes : null hérite, invalides écartées, plafond', () => {
    assert.equal(normalizePeriods(null), null);
    assert.equal(normalizePeriods([]), null);
    assert.equal(normalizePeriods([{ kind: 'bogus' }]), null);
    assert.deepEqual(normalizePeriods([{ kind: 'bogus' }, { kind: 'all' }]), [{ kind: 'all' }]);
    const many = Array.from({ length: MAX_PERIODS + 5 }, (_, i) => ({ kind: 'year', year: 2000 + i }));
    assert.equal(normalizePeriods(many).length, MAX_PERIODS);
});

test('comparaison : normalisation et « à date »', () => {
    const compare = normalizeChartSpec({
        groupBy: 'weekday', compare: { normalize: 'per_day', toDate: false, layout: 'side' },
    }).compare;
    assert.deepEqual(compare, { layout: 'side', align: 'calendar', normalize: 'per_day', toDate: false });
    assert.equal(normalizeChartSpec({ compare: { normalize: 'log' } }).compare.normalize, 'none');
    assert.equal(normalizeChartSpec({ compare: 'overlay' }).compare.layout, 'overlay');
});

test('la normalisation est idempotente sur des entrées abîmées', () => {
    const inputs = [
        null, 42, 'x', [],
        { measure: { op: 'cumulative' }, groupBy: 'owner', splitBy: 'owner', view: { chart: 'donut' } },
        { groupBy: 'none', splitBy: 'year', view: { chart: 'heatmap' }, compare: { layout: 'delta', align: 'absolute' } },
        { source: 'evolution:7', measure: { op: 'active' }, groupBy: 'weekday', periods: [{ kind: 'all' }, {}] },
    ];
    for (const input of inputs) {
        const once = normalizeChartSpec(input, fixedId);
        assert.deepEqual(normalizeChartSpec(once, fixedId), once, JSON.stringify(input));
    }
});
