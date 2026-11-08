// Moteur de la page Statistiques : sources (chart_sources.mjs), périodes
// (chart_periods.mjs) et calcul (chart_query.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { dayOfYearSlot, findsTable, isoWeek, isoWeekday, weekStart } from '../../static/js/chart_sources.mjs';
import { expandPeriods, periodLength, todayDay } from '../../static/js/chart_periods.mjs';
import { OTHERS_KEY, UNKNOWN_KEY, filterMask, runChartQuery, timeKeyBounds } from '../../static/js/chart_query.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};

// Sept trouvailles + une sans date. Types : 0 Traditional, 1 Mystery, 2 Lab.
function payload() {
    const rows = [
        // date, published, kind, code, D, T, type, container, country, state, owner, attrs
        ['2023-01-15', '2020-01-15', 0, 'GC1', 1.5, 2, 0, 0, 0, 0, 0, [0]],
        ['2023-01-20', '2023-01-20', 0, 'GC2', 2, 1, 0, 1, 0, 0, 1, [0, 1]],
        ['2023-06-03', null, 0, 'GC3', 3, 3.5, 1, 0, 1, -1, 0, []],
        ['2024-01-10', '2010-05-01', 0, 'GC4', 1.5, 1.5, 0, 0, 0, 1, 2, [1]],
        ['2024-02-29', '2024-02-01', 0, 'GC5', 5, 5, 1, -1, 0, 1, 0, []],
        ['2024-02-29', null, 1, 'lab-1', null, null, 2, -1, 1, -1, -1, []],
        ['2024-12-31', '2024-12-25', 0, 'GC1', 1.5, 2, 0, 0, 0, 0, 0, [0]],
        [null, null, 0, 'GC9', 1, 1, 0, 0, 0, 0, 0, []],
    ];
    const column = (i) => rows.map((row) => row[i]);
    return {
        v: 1,
        count: rows.length,
        date: column(0),
        published: column(1),
        kind: column(2),
        code: column(3),
        difficulty: column(4),
        terrain: column(5),
        cache_type: column(6),
        container: column(7),
        country: column(8),
        state: column(9),
        owner: column(10),
        attributes: column(11),
        dicts: {
            cache_type: ['Traditional Cache', 'Unknown Cache', 'Adventure Lab'],
            container: ['Small', 'Micro'],
            country: ['France', 'Belgique'],
            state: ['Bretagne', 'Normandie'],
            owner: ['Alice', 'Bob', 'Chloé'],
            attribute: [{ key: '6', name: 'Kids' }, { key: '8', name: 'Scenic' }],
        },
    };
}

const table = findsTable(payload());
const TODAY = day('2026-11-08');
const run = (raw, options = {}) => runChartQuery(normalizeChartSpec(raw, () => 'abcdef'), table, { today: TODAY, ...options });
const values = (result, i = 0) => result.series[i].values;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test('dates : jour de semaine ISO, semaine ISO, case du jour sur 366', () => {
    assert.equal(isoWeekday(day('1970-01-01')), 4);
    assert.equal(isoWeekday(day('2024-01-01')), 1);
    assert.equal(isoWeekday(day('2024-01-07')), 7);
    assert.equal(weekStart(day('2024-01-07')), day('2024-01-01'));
    assert.equal(isoWeek(day('2024-01-01')), 1);
    assert.equal(isoWeek(day('2021-01-03')), 53);   // dimanche de la 53ᵉ semaine de 2020
    assert.equal(isoWeek(day('2024-12-30')), 1);    // lundi de la 1ʳᵉ semaine de 2025
    assert.equal(dayOfYearSlot(1, 1), 1);
    assert.equal(dayOfYearSlot(2, 29), 60);
    assert.equal(dayOfYearSlot(3, 1), 61);
    assert.equal(dayOfYearSlot(12, 31), 366);
});

test('table : lignes sans date écartées, colonnes décodées, étendue', () => {
    assert.equal(table.n, 7);
    assert.equal(table.undated, 1);
    assert.deepEqual(table.extent, { first: day('2023-01-15'), last: day('2024-12-31') });
    assert.equal(table.doy[4], 60);
    assert.equal(table.kind[5], 1);
    assert.ok(Number.isNaN(table.difficulty[5]));
    assert.equal(table.container[4], -1);
    assert.equal(table.age[1], 0);              // trouvée le jour de sa publication
    assert.equal(table.ageDays[0], day('2023-01-15') - day('2020-01-15'));
    assert.equal(table.age[2], -1);             // pas de date de publication
    assert.equal(table.publishedYear[3], 2010);
});

test('table vide ou abîmée', () => {
    const empty = findsTable({ count: 0 });
    assert.equal(empty.n, 0);
    assert.equal(empty.extent, null);
    const broken = findsTable({ count: 2, date: ['2024-02-30', 'x'] });
    assert.equal(broken.n, 0);
    assert.equal(broken.undated, 2);
    assert.equal(findsTable(null).n, 0);
});

// ---------------------------------------------------------------------------
// Périodes
// ---------------------------------------------------------------------------

test('périodes : année, mois, plage, glissante, toutes', () => {
    const extent = table.extent;
    const one = (period) => expandPeriods([period], { extent, today: TODAY }).periods[0];
    assert.deepEqual([one({ kind: 'year', year: 2024 }).from, one({ kind: 'year', year: 2024 }).to],
        [day('2024-01-01'), day('2024-12-31')]);
    assert.equal(periodLength(one({ kind: 'month', year: 2024, month: 2 })), 29);
    assert.equal(periodLength(one({ kind: 'month', year: 2023, month: 2 })), 28);
    assert.deepEqual([one({ kind: 'range', from: '2024-01-01', to: '2024-01-31' }).from,
        one({ kind: 'range', from: '2024-01-01', to: '2024-01-31' }).to], [day('2024-01-01'), day('2024-01-31')]);
    const rolling = one({ kind: 'rolling', unit: 'month', count: 12 });
    assert.deepEqual([rolling.from, rolling.to], [day('2025-11-09'), TODAY]);
    const days = one({ kind: 'rolling', unit: 'day', count: 7 });
    assert.equal(periodLength(days), 7);
    const year = one({ kind: 'rolling', unit: 'year', count: 1 });
    assert.equal(year.from, day('2025-11-09'));
    // Fin de mois plus courte : 3 mois avant le 31 mai = 28/29 février.
    const short = expandPeriods([{ kind: 'rolling', unit: 'month', count: 3 }], { extent, today: day('2024-05-31') }).periods[0];
    assert.equal(short.from, day('2024-03-01'));
    assert.deepEqual([one({ kind: 'all' }).from, one({ kind: 'all' }).to], [extent.first, extent.last]);
    assert.equal(expandPeriods([{ kind: 'all' }], { extent: null, today: TODAY }).periods[0].from, TODAY);
});

test('périodes « chaque » : une entrée par année ou mois des données, plafonnée aux plus récentes', () => {
    const years = expandPeriods([{ kind: 'each', unit: 'year' }], { extent: table.extent, today: TODAY });
    assert.deepEqual(years.periods.map((p) => p.year), [2023, 2024]);
    assert.equal(years.truncated, false);
    const months = expandPeriods([{ kind: 'each', unit: 'month' }], { extent: table.extent, today: TODAY });
    assert.equal(months.truncated, true);
    assert.equal(months.periods.length, 8);
    assert.deepEqual([months.periods[0].year, months.periods[0].month], [2024, 5]);
    assert.deepEqual(months.periods.map((p) => p.index), [...Array(8).keys()]);
    const bounded = expandPeriods([{ kind: 'each', unit: 'year', from: '2024-03-01' }], { extent: table.extent, today: TODAY });
    assert.deepEqual(bounded.periods.map((p) => p.year), [2024]);
    assert.deepEqual(expandPeriods([{ kind: 'each', unit: 'year' }], { extent: null, today: TODAY }).periods, []);
});

test('jour courant local', () => {
    assert.equal(todayDay(new Date(2026, 10, 8, 23, 30)), day('2026-11-08'));
});

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------

test('total : nombre de trouvailles', () => {
    const result = run({ groupBy: 'none', view: { chart: 'number' } });
    assert.deepEqual(result.keys, ['total']);
    assert.deepEqual(values(result), [7]);
    assert.equal(result.meta.rows, 7);
    assert.equal(result.meta.undated, 1);
});

test('par année, axe continu, années futures sans valeur', () => {
    const result = run({ groupBy: 'year' });
    assert.deepEqual(result.keys, [2023, 2024]);
    assert.deepEqual(values(result), [3, 4]);
    const future = run({ groupBy: 'year', periods: [{ kind: 'range', from: '2024-01-01', to: '2027-12-31' }] });
    assert.deepEqual(future.keys, [2024, 2025, 2026, 2027]);
    assert.deepEqual(values(future), [4, 0, 0, null]);
});

test('par mois sur une année : douze mois, trous à zéro', () => {
    const result = run({ groupBy: 'month', periods: [{ kind: 'year', year: 2024 }] });
    assert.equal(result.keys.length, 12);
    assert.equal(result.keys[0], 202401);
    assert.deepEqual(values(result), [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(timeKeyBounds('month', 202402), [day('2024-02-01'), day('2024-02-29')]);
    assert.deepEqual(timeKeyBounds('quarter', 20244), [day('2024-10-01'), day('2024-12-31')]);
});

test('trimestres, semaines et jours', () => {
    const quarters = run({ groupBy: 'quarter', periods: [{ kind: 'year', year: 2023 }] });
    assert.deepEqual(quarters.keys, [20231, 20232, 20233, 20234]);
    assert.deepEqual(values(quarters), [2, 1, 0, 0]);
    const weeks = run({ groupBy: 'week', periods: [{ kind: 'month', year: 2023, month: 1 }] });
    assert.equal(weeks.keys[0], weekStart(day('2023-01-01')));
    assert.equal(values(weeks).reduce((a, b) => a + (b || 0), 0), 2);
    const days = run({ groupBy: 'day', periods: [{ kind: 'month', year: 2024, month: 2 }] });
    assert.equal(days.keys.length, 29);
    assert.equal(values(days)[28], 2);
});

test('dimensions cycliques : domaine complet, 29 février en case 60', () => {
    const months = run({ groupBy: 'month_of_year' });
    assert.deepEqual(months.keys, [...Array(12).keys()].map((i) => i + 1));
    assert.deepEqual(values(months), [3, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    const weekdays = run({ groupBy: 'weekday' });
    assert.equal(weekdays.keys.length, 7);
    assert.equal(values(weekdays).reduce((a, b) => a + b, 0), 7);
    const doy = run({ groupBy: 'day_of_year' });
    assert.equal(doy.keys.length, 366);
    assert.equal(values(doy)[59], 2);
    assert.equal(values(doy)[365], 1);
});

test('catégories : tri par nombre, « Inconnu » en dernier, top N + « Autres »', () => {
    const types = run({ groupBy: 'cache_type' });
    assert.deepEqual(types.keys, ['Traditional Cache', 'Unknown Cache', 'Adventure Lab']);
    assert.deepEqual(values(types), [4, 2, 1]);
    const states = run({ groupBy: 'state' });
    assert.deepEqual(states.keys, ['Bretagne', 'Normandie', UNKNOWN_KEY]);
    assert.deepEqual(values(states), [3, 2, 2]);
    const owners = run({ groupBy: 'owner', view: { top: 3 } });
    assert.deepEqual(owners.keys, ['Alice', 'Bob', 'Chloé', UNKNOWN_KEY]);
    const capped = runChartQuery({ ...normalizeChartSpec({ groupBy: 'owner' }), view: { ...normalizeChartSpec({}).view, top: 1 } },
        table, { today: TODAY });
    assert.deepEqual(capped.keys, ['Alice', OTHERS_KEY, UNKNOWN_KEY]);
    assert.deepEqual(values(capped), [4, 2, 1]);
});

test('anneau : pas plus de parts que de teintes', () => {
    const result = run({ groupBy: 'owner', view: { chart: 'donut', top: 50 } });
    assert.ok(result.keys.length <= 8);
});

test('contenants dans leur ordre naturel', () => {
    const result = run({ groupBy: 'container' });
    assert.deepEqual(result.keys, ['Micro', 'Small', UNKNOWN_KEY]);
    assert.deepEqual(values(result), [1, 4, 2]);
});

test('difficulté, terrain, D/T, âge, année de publication', () => {
    const difficulty = run({ groupBy: 'difficulty' });
    assert.equal(difficulty.keys.length, 10);
    assert.equal(difficulty.keys[1], '1.5');
    assert.equal(values(difficulty)[1], 3);
    assert.equal(difficulty.keys[9], UNKNOWN_KEY);
    assert.equal(values(difficulty)[9], 1);
    const dt = run({ groupBy: 'dt' });
    assert.equal(dt.keys[0], '1.5|2');
    assert.equal(values(dt)[0], 2);
    const age = run({ groupBy: 'age' });
    assert.deepEqual(age.keys.slice(0, 10), [...Array(10).keys()]);
    assert.equal(values(age)[0], 1);
    assert.equal(age.keys[10], UNKNOWN_KEY);
    const published = run({ groupBy: 'published_year' });
    assert.equal(published.keys[0], 2010);
    assert.equal(published.keys.at(-2), 2024);
    assert.equal(published.keys.length, 16);
    assert.equal(values(published).at(-1), 2);
});

test('attributs multi-valués : une trouvaille compte dans chaque attribut, les autres sont signalées', () => {
    const result = run({ groupBy: 'attribute' });
    assert.deepEqual(result.keys, ['6', '8']);
    assert.deepEqual(values(result), [3, 2]);
    assert.equal(result.meta.noAttribute, 3);
});

test('mesures : caches distinctes, jours, pays, moyennes, record du jour', () => {
    assert.deepEqual(values(run({ groupBy: 'none', measure: { op: 'distinct', field: 'caches' } })), [6]);
    assert.deepEqual(values(run({ groupBy: 'none', measure: { op: 'distinct', field: 'days' } })), [6]);
    assert.deepEqual(values(run({ groupBy: 'year', measure: { op: 'distinct', field: 'country' } })), [2, 2]);
    assert.deepEqual(values(run({ groupBy: 'none', measure: { op: 'distinct', field: 'state' } })), [2]);
    const mean = values(run({ groupBy: 'none', measure: { op: 'mean', field: 'difficulty' } }))[0];
    assert.equal(mean, (1.5 + 2 + 3 + 1.5 + 5 + 1.5) / 6);
    const meanByType = run({ groupBy: 'cache_type', measure: { op: 'mean', field: 'terrain' } });
    assert.equal(values(meanByType)[2], null);
    const age = values(run({ groupBy: 'none', measure: { op: 'mean', field: 'age' } }))[0];
    const ages = [day('2023-01-15') - day('2020-01-15'), 0, day('2024-01-10') - day('2010-05-01'),
        day('2024-02-29') - day('2024-02-01'), day('2024-12-31') - day('2024-12-25')];
    assert.equal(age, ages.reduce((a, b) => a + b, 0) / ages.length);
    assert.deepEqual(values(run({ groupBy: 'year', measure: { op: 'max_per_day' } })), [1, 2]);
});

test('cumul : depuis le début de la période, ou depuis toujours', () => {
    const from2024 = run({ groupBy: 'month', measure: { op: 'cumulative' }, periods: [{ kind: 'year', year: 2024 }] });
    assert.deepEqual(values(from2024), [1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4]);
    const fromAll = run({ groupBy: 'month', measure: { op: 'cumulative', from: 'all' }, periods: [{ kind: 'year', year: 2024 }] });
    assert.deepEqual(values(fromAll), [4, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7]);
    const yearly = run({ groupBy: 'year', measure: { op: 'cumulative' } });
    assert.deepEqual(values(yearly), [3, 7]);
});

test('cumul au-delà d\'aujourd\'hui : pas de valeur', () => {
    const result = runChartQuery(normalizeChartSpec({ groupBy: 'month', measure: { op: 'cumulative' } }), table, {
        today: day('2024-02-15'), periods: [{ kind: 'year', year: 2024 }],
    });
    // Février a commencé : sa valeur reste (3), mars est à venir (null).
    assert.deepEqual(values(result).slice(0, 3), [1, 3, null]);
});

test('filtres : valeurs d\'un champ en « ou », champs en « et », attributs tous requis', () => {
    const count = (filters) => values(run({ groupBy: 'none' }, { filters }))[0];
    assert.equal(count(null), 7);
    assert.equal(count({}), 7);
    assert.equal(count({ cache_type: ['Traditional Cache'] }), 4);
    assert.equal(count({ cache_type: ['Traditional Cache', 'Adventure Lab'] }), 5);
    assert.equal(count({ cache_type: ['Traditional Cache'], country: ['Belgique'] }), 0);
    assert.equal(count({ source_kind: ['lab'] }), 1);
    assert.equal(count({ difficulty: ['1.5'] }), 3);
    assert.equal(count({ published_year: ['2024'] }), 2);
    assert.equal(count({ attribute: ['6'] }), 3);
    assert.equal(count({ attribute: ['6', '8'] }), 1);
    assert.equal(count({ attribute: ['99'] }), 0);
    assert.equal(count({ owner: ['Inconnu au bataillon'] }), 0);
    assert.equal(filterMask(table, { bogus: ['x'] }).reduce((a, b) => a + b, 0), 7);
});

test('plusieurs périodes : une série chacune, même axe catégoriel', () => {
    const result = run({ groupBy: 'cache_type', periods: [{ kind: 'year', year: 2023 }, { kind: 'year', year: 2024 }] });
    assert.equal(result.series.length, 2);
    assert.deepEqual(result.series.map((s) => s.id), ['p0', 'p1']);
    assert.deepEqual(values(result, 0), [2, 1, 0]);
    assert.deepEqual(values(result, 1), [2, 1, 1]);
});

test('plusieurs périodes sur un axe de temps : chacune à sa vraie date', () => {
    const result = run({ groupBy: 'year', periods: [{ kind: 'year', year: 2023 }, { kind: 'year', year: 2024 }] });
    assert.deepEqual(result.keys, [2023, 2024]);
    assert.deepEqual(values(result, 0), [3, null]);
    assert.deepEqual(values(result, 1), [null, 4]);
});

test('2ᵉ dimension : une série par valeur, « Inconnu » compris', () => {
    const result = run({ groupBy: 'year', splitBy: 'country' });
    assert.deepEqual(result.series.map((s) => s.split), ['France', 'Belgique']);
    assert.deepEqual(values(result, 0), [2, 3]);
    assert.deepEqual(values(result, 1), [1, 1]);
    const byYear = run({ groupBy: 'cache_type', splitBy: 'year' });
    assert.deepEqual(byYear.series.map((s) => s.split), [2024, 2023]);
});

test('tri par valeur ou par libellé, « Autres » et « Inconnu » restent en fin', () => {
    const byValue = run({ groupBy: 'state', view: { sort: 'value' } });
    assert.deepEqual(byValue.keys, ['Bretagne', 'Normandie', UNKNOWN_KEY]);
    const byLabel = run({ groupBy: 'cache_type', view: { sort: 'label' } }, {
        labelOf: (dim, key) => ({ 'Traditional Cache': 'Traditionnelle', 'Unknown Cache': 'Mystère', 'Adventure Lab': 'Lab' })[key],
    });
    assert.deepEqual(byLabel.keys, ['Adventure Lab', 'Unknown Cache', 'Traditional Cache']);
    assert.deepEqual(values(byLabel), [1, 2, 4]);
});

test('base vide : axe vide ou zéro, sans erreur', () => {
    const empty = findsTable({ count: 0 });
    const spec = normalizeChartSpec({ groupBy: 'cache_type' });
    assert.deepEqual(runChartQuery(spec, empty, { today: TODAY }).keys, []);
    const total = runChartQuery(normalizeChartSpec({ groupBy: 'none' }), empty, { today: TODAY });
    assert.deepEqual(total.series[0].values, [0]);
    const years = runChartQuery(normalizeChartSpec({ groupBy: 'year' }), empty, { today: TODAY });
    assert.deepEqual(years.keys, [2026]);
});
