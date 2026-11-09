// Objectif et projection de la page Statistiques (chart_goal.mjs) : caps
// ronds, rythme, bilan d'un chiffre clé, cumul prolongé, dessin.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goalApplies, normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { runChartQuery } from '../../static/js/chart_query.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';
import { buildChartOption, numberModel } from '../../static/js/chart_echarts.mjs';
import { nextMilestone, numberOutlook, periodPace, projectionValues } from '../../static/js/chart_goal.mjs';
import { itemFromQuestion } from '../../static/js/dashboard_model.mjs';
import { panelFromSpec } from '../../static/js/chart_panel_link.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
// 1ᵉʳ mars 2026 : 60ᵉ jour de l'année.
const TODAY = day('2026-03-01');

// Une trouvaille tous les deux jours depuis le 2 janvier 2026 (30 au
// 28 février), plus 3 en 2025.
const DATES = ['2025-05-01', '2025-06-01', '2025-07-01'];
for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 0, 2 + 2 * i));
    DATES.push(d.toISOString().slice(0, 10));
}
const table = findsTable({
    count: DATES.length, date: DATES, published: DATES.map(() => null), kind: DATES.map(() => 0),
    code: DATES.map((_, i) => 'GC' + i), attributes: DATES.map(() => []), dicts: {},
});

const tokens = {
    text: '#1f2b38', textMuted: '#5b6878', grid: '#e8ecf1', surface: '#ffffff', others: '#a9b1bb',
    unknown: '#cfd5dc', series: ['#2a78d6', '#eb6834'], up: '#2a78d6', down: '#e34948', empty: '#eef1f5',
    heat: ['#e8f1fc', '#104281'],
};
const labels = makeLabels({ locale: 'fr' });
const ctx = { labels, tokens, typeColors: {}, attributeName: (k) => k, width: 600, today: TODAY };
const query = (raw) => {
    const spec = normalizeChartSpec(raw);
    return { spec, result: runChartQuery(spec, table, { today: TODAY }) };
};

test('caps ronds', () => {
    assert.equal(nextMilestone(0), 10);
    assert.equal(nextMilestone(812), 1000);
    assert.equal(nextMilestone(1000), 1500);
    assert.equal(nextMilestone(9999), 10000);
    assert.equal(nextMilestone(12345), 15000);
});

test('rythme et bilan d’un chiffre clé', () => {
    const year = { from: day('2026-01-01'), to: day('2026-12-31'), as: { kind: 'year' } };
    // 60 jours écoulés, 60 trouvailles : une par jour.
    assert.equal(periodPace(60, year, TODAY), 1);
    const out = numberOutlook({ value: 60, goal: 100, entry: year, today: TODAY });
    assert.equal(out.ratio, 0.6);
    assert.equal(out.projected, 60 + 305);
    assert.equal(out.eta, TODAY + 40);
    // Objectif hors d'atteinte avant la fin de la période : ce qui manquerait.
    const far = numberOutlook({ value: 60, goal: 1000, entry: year, today: TODAY });
    assert.equal(far.eta, null);
    assert.equal(far.short, 1000 - 365);
    // Atteint : le jour.
    const done = numberOutlook({ value: 120, goal: 100, entry: year, today: TODAY, goalDay: day('2026-02-20') });
    assert.equal(done.reached, true);
    assert.equal(done.ratio, 1);
    assert.equal(done.reachedDay, day('2026-02-20'));
    // Toute la période : pas de fin à projeter, une date d'objectif.
    const all = { from: day('2025-03-02'), to: day('2026-02-28'), as: { kind: 'all' } };
    const open = numberOutlook({ value: 365, goal: 500, entry: all, today: TODAY });
    assert.equal(open.projected, null);
    assert.equal(open.eta, TODAY + 135);
    // Période finie : la progression seulement.
    const past = numberOutlook({ value: 3, goal: 10, entry: { from: day('2025-01-01'), to: day('2025-12-31'), as: { kind: 'year' } }, today: TODAY });
    assert.deepEqual([past.projected, past.eta, past.short], [null, null, null]);
});

test('textes du bilan', () => {
    const year = { from: day('2026-01-01'), to: day('2026-12-31'), as: { kind: 'year' } };
    const lines = (o, projection = false) => labels.outlookLines(o, { op: 'count' }, { projection });
    const eta = lines(numberOutlook({ value: 60, goal: 100, entry: year, today: TODAY }));
    assert.match(eta.progress, /^60 \/ 100 · 60\s%$/);
    assert.deepEqual(eta.lines, ['À ce rythme : 100 le 10 avr. 2026']);
    const short = lines(numberOutlook({ value: 60, goal: 1000, entry: year, today: TODAY }), true);
    assert.deepEqual(short.lines, ["À ce rythme : 365 en fin de période, 635 de moins que l'objectif"]);
    const pace = lines(numberOutlook({ value: 60, entry: year, today: TODAY }), true);
    assert.deepEqual(pace, { progress: '', lines: ['À ce rythme : 365 en fin de période'] });
    const done = lines(numberOutlook({ value: 120, goal: 100, entry: year, today: TODAY, goalDay: day('2026-02-20') }));
    assert.deepEqual(done.lines, ['Objectif atteint le 20 févr. 2026']);
});

test('moteur : jour de l’objectif atteint, départ d’un cumul', () => {
    const { result } = query({ groupBy: 'none', periods: [{ kind: 'year', year: 2026 }], goal: { value: 10 }, view: { chart: 'number' } });
    assert.equal(result.series[0].goalDay, day('2026-01-20'));   // 10ᵉ trouvaille
    const cumulative = query({ groupBy: 'month', measure: { op: 'cumulative', from: 'all' }, periods: [{ kind: 'year', year: 2026 }], view: { chart: 'line' } });
    assert.equal(cumulative.result.series[0].base, 3);
});

test('spec : objectif et projection seulement là où ils ont un sens', () => {
    assert.ok(goalApplies({ measure: { op: 'count' }, groupBy: 'none', view: { chart: 'number' } }));
    assert.ok(goalApplies({ measure: { op: 'cumulative' }, groupBy: 'month', view: { chart: 'area' } }));
    assert.ok(!goalApplies({ measure: { op: 'count' }, groupBy: 'month', view: { chart: 'bar' } }));
    assert.ok(!goalApplies({ measure: { op: 'mean', field: 'difficulty' }, groupBy: 'none', view: { chart: 'number' } }));
    assert.deepEqual(normalizeChartSpec({ groupBy: 'none', view: { chart: 'number' }, goal: { value: '250' } }).goal, { value: 250 });
    assert.equal(normalizeChartSpec({ groupBy: 'year', goal: { value: 250 }, view: { projection: true } }).goal, null);
    assert.equal(normalizeChartSpec({ groupBy: 'year', view: { projection: true } }).view.projection, false);
    assert.equal(normalizeChartSpec({ groupBy: 'none', view: { chart: 'number' }, goal: { value: 0 } }).goal, null);
    // « Mon prochain cap » : posé à l'ajout, sur le total.
    assert.deepEqual(itemFromQuestion('next_milestone', { total: 812 }).spec.goal, { value: 1000 });
});

test('cumul prolongé à ce rythme, jusqu’à la fin de la période', () => {
    const { spec, result } = query({
        groupBy: 'month', measure: { op: 'cumulative' }, periods: [{ kind: 'year', year: 2026 }],
        view: { chart: 'line', projection: true }, goal: { value: 200 },
    });
    const s = result.series[0];
    const values = projectionValues(result, s, TODAY);
    // Mars (case du jour) : la valeur connue ; décembre : 30 + 30/60 × 305.
    assert.equal(values[1], null);
    assert.equal(values[2], s.values[2]);
    assert.ok(Math.abs(values[11] - (30 + (30 / 60) * 305)) < 1e-9);
    const option = buildChartOption(result, spec, ctx);
    assert.equal(option.series.length, 2);
    assert.equal(option.series[1].lineStyle.type, 'dashed');
    assert.deepEqual(option.series[0].markLine.data, [{ yAxis: 200 }]);
    // L'axe contient l'objectif et la fin projetée.
    assert.equal(option.yAxis.max({ max: 30 }), 200);    // fin projetée ~182, objectif 200
    // Jour de l'année, année ordinaire : la projection part d'aujourd'hui,
    // pas du 29 février (qui garde une valeur de cumul).
    const doy = query({ groupBy: 'day_of_year', measure: { op: 'cumulative' }, periods: [{ kind: 'year', year: 2026 }], view: { chart: 'line', projection: true } });
    const proj = projectionValues(doy.result, doy.result.series[0], TODAY);
    // 1ᵉʳ mars : case 61 de l'année de référence (bissextile), index 60.
    assert.equal(proj.findIndex((v) => v !== null), 60);

    // Sans « aujourd'hui » (vidéo) : pas de projection.
    assert.equal(buildChartOption(result, spec, { ...ctx, today: null }).series.length, 1);
    // Période finie : rien à prolonger.
    const past = query({ groupBy: 'month', measure: { op: 'cumulative' }, periods: [{ kind: 'year', year: 2025 }], view: { chart: 'line', projection: true } });
    assert.equal(projectionValues(past.result, past.result.series[0], TODAY), null);
});

test('chiffre clé : bilan sur la première valeur ; le panneau vidéo ne le reprend pas', () => {
    const { spec, result } = query({ groupBy: 'none', periods: [{ kind: 'current', unit: 'year' }], goal: { value: 100 }, view: { chart: 'number', projection: true } });
    const [block] = numberModel(result, spec, ctx);
    assert.equal(block.outlook.goal, 100);
    assert.equal(block.outlook.value, 30);
    assert.equal(block.outlook.lines.length, 2);
    assert.equal(numberModel(result, spec, { ...ctx, today: null })[0].outlook, undefined);
    assert.ok(panelFromSpec(spec, { newId: () => 'abcdef01' }).dropped.includes('goal'));
});
