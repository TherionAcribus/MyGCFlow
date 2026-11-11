// Moteur de la page Statistiques : sources (chart_sources.mjs), périodes
// (chart_periods.mjs) et calcul (chart_query.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec, withUpTo } from '../../static/js/chart_spec.mjs';
import { dayOfYearSlot, findsTable, isoWeek, isoWeekday, weekStart } from '../../static/js/chart_sources.mjs';
import { expandPeriods, periodLength, toDateCut, todayDay } from '../../static/js/chart_periods.mjs';
import {
    OTHERS_KEY, UNKNOWN_KEY, filterMask, runChartQuery, timeKeyBounds, unitIndexOfDay, unitStartDay,
} from '../../static/js/chart_query.mjs';
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
    assert.deepEqual(years.periods.map((p) => p.as.year), [2023, 2024]);
    assert.equal(years.truncated, false);
    const months = expandPeriods([{ kind: 'each', unit: 'month' }], { extent: table.extent, today: TODAY });
    assert.equal(months.truncated, true);
    assert.equal(months.periods.length, 8);
    assert.deepEqual([months.periods[0].as.year, months.periods[0].as.month], [2024, 5]);
    assert.deepEqual(months.periods.map((p) => p.index), [...Array(8).keys()]);
    const bounded = expandPeriods([{ kind: 'each', unit: 'year', from: '2024-03-01' }], { extent: table.extent, today: TODAY });
    assert.deepEqual(bounded.periods.map((p) => p.as.year), [2024]);
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
    const result = run({
        groupBy: 'year',
        periods: [{ kind: 'year', year: 2023 }, { kind: 'year', year: 2024 }],
        compare: { align: 'absolute' },
    });
    assert.equal(result.align, 'absolute');
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

// ---------------------------------------------------------------------------
// Comparaison (lot 2)
// ---------------------------------------------------------------------------

test('périodes relatives : en cours, précédente (année, mois, glissante, plage)', () => {
    const expand = (periods, today = TODAY) => expandPeriods(periods, { extent: table.extent, today }).periods;
    const [cur, prev] = expand([{ kind: 'current', unit: 'year' }, { kind: 'previous' }]);
    assert.deepEqual([cur.from, cur.to, cur.ongoing], [day('2026-01-01'), day('2026-12-31'), true]);
    assert.deepEqual([prev.from, prev.to, prev.ongoing], [day('2025-01-01'), day('2025-12-31'), false]);
    assert.deepEqual(prev.as, { kind: 'year', year: 2025 });
    // Chaîne : la précédente de la précédente.
    assert.deepEqual(expand([{ kind: 'year', year: 2024 }, { kind: 'previous' }, { kind: 'previous' }]).map((e) => e.as.year),
        [2024, 2023, 2022]);
    const [mar, feb] = expand([{ kind: 'month', year: 2024, month: 3 }, { kind: 'previous' }]);
    assert.deepEqual([feb.from, feb.to], [day('2024-02-01'), day('2024-02-29')]);
    assert.deepEqual(feb.as, { kind: 'month', year: 2024, month: 2 });
    const [, before] = expand([{ kind: 'rolling', unit: 'month', count: 12 }, { kind: 'previous' }]);
    assert.deepEqual([before.from, before.to], [day('2024-11-09'), day('2025-11-08')]);
    assert.deepEqual(before.as, { kind: 'previous_rolling', unit: 'month', count: 12 });
    const [, range] = expand([{ kind: 'range', from: '2024-01-11', to: '2024-01-20' }, { kind: 'previous' }]);
    assert.deepEqual([range.from, range.to], [day('2024-01-01'), day('2024-01-10')]);
    // La précédente de « tout » n'existe pas.
    assert.equal(expand([{ kind: 'all' }, { kind: 'previous' }]).length, 1);
    const [month] = expand([{ kind: 'current', unit: 'month' }]);
    assert.deepEqual([month.from, month.to], [day('2026-11-01'), day('2026-11-30')]);
    // Les 12 derniers mois se terminent aujourd'hui : pas « en cours ».
    assert.equal(expand([{ kind: 'rolling', unit: 'month', count: 12 }])[0].ongoing, false);
});

test('coupe « à date » : même jour du calendrier, 29 février ramené au 28', () => {
    const cut = (entry, current, today) => toDateCut(
        { from: day(entry) }, { from: day(current) }, day(today));
    assert.equal(cut('2025-01-01', '2026-01-01', '2026-11-08'), day('2025-11-08'));
    assert.equal(cut('2023-01-01', '2024-01-01', '2024-02-29'), day('2023-02-28'));
    assert.equal(cut('2025-10-01', '2026-11-01', '2026-11-08'), day('2025-10-08'));
    assert.equal(cut('2025-03-10', '2026-03-12', '2026-03-20'), day('2025-03-18'));
});

test('à date : la période passée est coupée au même jour, la note le signale', () => {
    const tbl = findsTable({
        count: 4, date: ['2025-03-01', '2025-12-01', '2026-02-01', '2026-03-01'],
        dicts: {},
    });
    const spec = (toDate) => normalizeChartSpec({
        groupBy: 'none', periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }],
        view: { chart: 'number' }, compare: { toDate },
    });
    const today = day('2026-06-15');
    const cut = runChartQuery(spec(true), tbl, { today });
    assert.deepEqual(cut.series.map((s) => s.values[0]), [2, 1]);
    assert.deepEqual(cut.toDate, { day: today });
    assert.equal(cut.periods[1].cut, true);
    assert.equal(cut.periods[1].to, day('2025-06-15'));
    const full = runChartQuery(spec(false), tbl, { today });
    assert.deepEqual(full.series.map((s) => s.values[0]), [2, 2]);
    assert.equal(full.toDate, null);
});

test('« depuis le début » : admis pour une période à fin propre, retiré ailleurs', () => {
    const periodsOf = (periods) => normalizeChartSpec({ periods }).periods;
    assert.deepEqual(periodsOf([{ kind: 'year', year: 2024, upTo: true }]), [{ kind: 'year', year: 2024, upTo: true }]);
    assert.deepEqual(periodsOf([{ kind: 'current', unit: 'year', upTo: true }])[0].upTo, true);
    assert.deepEqual(periodsOf([{ kind: 'range', from: '2024-01-01', to: '2024-02-01', upTo: true }])[0].upTo, true);
    for (const kind of [{ kind: 'all' }, { kind: 'rolling', unit: 'month', count: 12 }, { kind: 'each', unit: 'year' }]) {
        assert.equal(periodsOf([{ ...kind, upTo: true }])[0].upTo, undefined, kind.kind);
    }
    // Seul `true` compte.
    assert.equal(periodsOf([{ kind: 'year', year: 2024, upTo: 'oui' }])[0].upTo, undefined);
    assert.deepEqual(withUpTo({ kind: 'year', year: 2024 }, true), { kind: 'year', year: 2024, upTo: true });
    assert.deepEqual(withUpTo({ kind: 'year', year: 2024, upTo: true }, false), { kind: 'year', year: 2024 });
    assert.deepEqual(withUpTo({ kind: 'all' }, true), { kind: 'all' });
});

test('« depuis le début » : du début des données à la fin de la période, la précédente aussi', () => {
    const expand = (periods, today = TODAY) => expandPeriods(periods, { extent: table.extent, today }).periods;
    const [y2024, y2023] = expand([{ kind: 'year', year: 2024, upTo: true }, { kind: 'previous' }]);
    assert.deepEqual([y2024.from, y2024.to, y2024.anchor], [day('2023-01-15'), day('2024-12-31'), day('2024-01-01')]);
    assert.deepEqual(y2024.as, { kind: 'year', year: 2024, upTo: true });
    // La précédente suit sa base : jusqu'à fin 2023 (depuis le 1ᵉʳ janvier,
    // antérieur aux données).
    assert.deepEqual([y2023.from, y2023.to], [day('2023-01-01'), day('2023-12-31')]);
    assert.deepEqual(y2023.as, { kind: 'year', year: 2023, upTo: true });
    // Une base ordinaire garde une précédente ordinaire.
    assert.equal(expand([{ kind: 'year', year: 2024 }, { kind: 'previous' }])[1].as.upTo, undefined);
    // Période antérieure aux données : son propre début.
    const [old] = expand([{ kind: 'year', year: 2020, upTo: true }]);
    assert.deepEqual([old.from, old.to], [day('2020-01-01'), day('2020-12-31')]);
    // Sans données : la période elle-même.
    const [bare] = expandPeriods([{ kind: 'year', year: 2024, upTo: true }], { extent: null, today: TODAY }).periods;
    assert.equal(bare.from, day('2024-01-01'));
});

test('« depuis le début » : chiffres cumulés, coupe « à date » sur le début de la période', () => {
    const count = (period) => run({ groupBy: 'none', periods: [period], view: { chart: 'number' } }).series[0].values[0];
    assert.equal(count({ kind: 'year', year: 2024 }), 4);
    assert.equal(count({ kind: 'year', year: 2024, upTo: true }), 7);
    assert.equal(count({ kind: 'year', year: 2023, upTo: true }), 3);
    assert.equal(count({ kind: 'month', year: 2024, month: 1, upTo: true }), 4);

    // Cette année face à l'an dernier, à date : tout au 15 juin 2026 contre
    // tout au 15 juin 2025.
    const tbl = findsTable({
        count: 4, date: ['2025-03-01', '2025-12-01', '2026-02-01', '2026-03-01'], dicts: {},
    });
    const result = runChartQuery(normalizeChartSpec({
        groupBy: 'none', periods: [{ kind: 'current', unit: 'year', upTo: true }, { kind: 'previous' }],
        view: { chart: 'number' },
    }), tbl, { today: day('2026-06-15') });
    assert.deepEqual(result.series.map((s) => s.values[0]), [4, 1]);
    assert.equal(result.periods[1].to, day('2025-06-15'));
    assert.equal(result.periods[1].cut, true);
});

test('à date sur des mois de l\'année : mois coupés et futurs sans valeur, case en cours repérée', () => {
    const tbl = findsTable({
        count: 3, date: ['2025-06-10', '2025-06-20', '2025-09-01'], dicts: {},
    });
    const result = runChartQuery(normalizeChartSpec({
        groupBy: 'month_of_year', periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }],
    }), tbl, { today: day('2026-06-15') });
    const [now, before] = result.series;
    assert.deepEqual(now.values.slice(4, 8), [0, 0, null, null]);
    // 2025 coupé au 15 juin : la trouvaille du 20 juin et septembre ne
    // comptent pas, juillet et après sans valeur.
    assert.deepEqual(before.values.slice(4, 9), [0, 1, null, null, null]);
    assert.equal(now.partial, 5);
    assert.equal(before.partial, 5);
});

test('alignement « depuis le début » : rangs, longueur de la plus longue période', () => {
    assert.equal(unitStartDay('month', unitIndexOfDay('month', day('2024-02-17'))), day('2024-02-01'));
    assert.equal(unitStartDay('week', unitIndexOfDay('week', day('2024-01-07'))), day('2024-01-01'));
    assert.equal(unitStartDay('quarter', unitIndexOfDay('quarter', day('2024-05-17'))), day('2024-04-01'));
    const result = run({
        groupBy: 'month', periods: [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2023 }],
        compare: { align: 'elapsed' },
    });
    assert.equal(result.align, 'elapsed');
    assert.equal(result.elapsedUnit, 'month');
    assert.deepEqual(result.keys, [...Array(12).keys()]);
    assert.deepEqual(values(result, 0).slice(0, 3), [1, 2, 0]);
    assert.deepEqual(values(result, 1).slice(0, 6), [2, 0, 0, 0, 0, 1]);
    assert.equal(result.series[0].dates[1], day('2024-02-01'));
    assert.equal(result.series[1].dates[1], day('2023-02-01'));
    // Glissantes : les 2 derniers mois contre les 2 d'avant, en jours.
    const rolling = runChartQuery(normalizeChartSpec({
        groupBy: 'day', periods: [{ kind: 'rolling', unit: 'day', count: 3 }, { kind: 'previous' }],
        compare: { align: 'elapsed' },
    }), table, { today: day('2024-03-02') });
    assert.deepEqual(rolling.keys, [0, 1, 2]);
    assert.deepEqual(values(rolling, 0), [2, 0, 0]);
});

test('alignement calendrier d\'un cumul par jour de l\'année : le 29 février d\'une année ordinaire garde la valeur de la veille', () => {
    const result = run({
        groupBy: 'day_of_year', measure: { op: 'cumulative' },
        periods: [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2023 }],
        compare: { toDate: false },
    });
    assert.equal(values(result, 1)[59], values(result, 1)[58]);
    const counts = run({
        groupBy: 'day_of_year', periods: [{ kind: 'year', year: 2023 }, { kind: 'year', year: 2024 }],
        compare: { toDate: false },
    });
    assert.equal(values(counts, 0)[59], null);
    assert.equal(values(counts, 1)[59], 2);
});

test('pourcentages et valeurs par jour', () => {
    const percent = run({ groupBy: 'cache_type', compare: { normalize: 'percent' } });
    assert.deepEqual(values(percent).map((v) => Math.round(v * 10) / 10), [57.1, 28.6, 14.3]);
    assert.equal(percent.normalize, 'percent');
    const cumulative = run({ groupBy: 'year', measure: { op: 'cumulative' }, compare: { normalize: 'percent' } });
    assert.deepEqual(values(cumulative).map((v) => Math.round(v)), [43, 100]);
    const perDay = run({ groupBy: 'none', periods: [{ kind: 'year', year: 2024 }], compare: { normalize: 'per_day' } });
    assert.equal(values(perDay)[0], 4 / 366);
});

test('écart : première période moins la seconde, et en proportion', () => {
    const result = run({
        groupBy: 'cache_type', periods: [{ kind: 'year', year: 2024 }, { kind: 'year', year: 2023 }],
        compare: { layout: 'delta' },
    });
    assert.deepEqual(result.keys, ['Traditional Cache', 'Unknown Cache', 'Adventure Lab']);
    assert.deepEqual(result.delta.values, [0, 0, 1]);
    assert.deepEqual(result.delta.ratios, [0, 0, null]);
    assert.equal(run({ groupBy: 'cache_type', compare: { layout: 'delta' } }).delta, null);
});

test('grille D/T : toutes les combinaisons présentes, sans « Autres »', () => {
    const grid = run({ groupBy: 'dt', view: { chart: 'heatmap', top: 3 } });
    assert.ok(!grid.keys.includes(OTHERS_KEY));
    assert.equal(grid.keys.filter((k) => k !== UNKNOWN_KEY).length, 5);
    const bars = run({ groupBy: 'dt', view: { chart: 'bar', top: 3 } });
    assert.ok(bars.keys.includes(OTHERS_KEY));
});
