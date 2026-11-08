// Comparaison animée en vidéo (chart_video.mjs) : avancée, résultat partiel,
// échelle figée.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import {
    chartAnimates, lockOption, niceCeil, revealIndex, revealProgress, revealResult, valueMax,
} from '../../static/js/chart_video.mjs';

const result = {
    keys: [1, 2, 3, 4],
    series: [
        { values: [2, 4, 6, 8] },
        { values: [1, 3, null, null] },
    ],
};

test('quels graphiques s’animent', () => {
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'month_of_year', view: { chart: 'line' } })), true);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'year' })), true);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'cache_type' })), false);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'day', view: { chart: 'calendar' } })), false);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'year' }), { keys: [2024], delta: null, series: [] }), false);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'year' }), { keys: [1, 2], delta: { values: [] }, series: [] }), false);
});

test('avancée : linéaire puis pause sur le graphique complet', () => {
    assert.equal(revealProgress(0, 10), 0);
    assert.equal(revealProgress(4.25, 10), 0.5);
    assert.equal(revealProgress(8.5, 10), 1);
    assert.equal(revealProgress(10, 10), 1);
    assert.equal(revealProgress(3, 0), 1);
});

test('résultat partiel : barres qui grandissent, courbes qui glissent', () => {
    const half = revealResult(result, 0.625, { chart: 'bar' });
    // 2,5 clés atteintes : deux pleines, la 3ᵉ à moitié, la 4ᵉ vide.
    assert.deepEqual(half.series[0].values, [2, 4, 3, null]);
    assert.deepEqual(half.series[1].values, [1, 3, null, null]);
    const line = revealResult(result, 0.625, { chart: 'line' });
    assert.deepEqual(line.series[0].values, [2, 4, 5, null]);
    assert.deepEqual(revealResult(result, 1).series[0].values, [2, 4, 6, 8]);
    assert.deepEqual(revealResult(result, 0).series[0].values, [null, null, null, null]);
    // Le résultat d'origine n'est pas touché.
    assert.deepEqual(result.series[0].values, [2, 4, 6, 8]);
    assert.equal(revealIndex(result, 0.625), 2);
    assert.equal(revealIndex(result, 1), 3);
    assert.equal(revealIndex(result, 0), 0);
});

test('échelle figée sur la plus grande valeur, arrondie', () => {
    assert.equal(valueMax(result), 8);
    assert.equal(valueMax(result, { stacked: true }), 8);
    assert.equal(valueMax({ keys: [1, 2], series: [{ values: [3, 1] }, { values: [4, 9] }] }, { stacked: true }), 10);
    assert.equal(niceCeil(8), 10);
    assert.equal(niceCeil(180), 200);
    assert.equal(niceCeil(21), 25);
    assert.equal(niceCeil(0), 1);
    const option = lockOption({ xAxis: { type: 'category' }, yAxis: { type: 'value' }, dataZoom: [{}] }, 10);
    assert.equal(option.yAxis.max, 10);
    assert.equal(option.yAxis.min, 0);
    assert.equal(option.xAxis.max, undefined);
    assert.equal(option.dataZoom, undefined);
    assert.equal(option.animation, false);
});
