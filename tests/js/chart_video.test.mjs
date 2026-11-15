// Comparaison animée en vidéo (chart_video.mjs) : avancée, résultat partiel,
// échelle figée.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import {
    chartAnimates, ellipsize, fitFontSize, lockOption, niceCeil, revealIndex, revealProgress, revealResult, valueMax,
    VIDEO_HOLD, VIDEO_HOLD_MIN_MS,
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
    // Formes sans axe de temps : révélées dans l'ordre de leurs clés —
    // parts de l'anneau qui balaient, cases qui se remplissent.
    for (const view of [
        { chart: 'donut' }, { chart: 'radar' },
    ]) assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'cache_type', view })), view.chart === 'donut');
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'dt', view: { chart: 'heatmap' } })), true);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'day', view: { chart: 'calendar' } })), true);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'dt', view: { chart: 'challenge' } })), true);
    // … mais jamais sans au moins deux clés, ni en écart.
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'cache_type', view: { chart: 'donut' } }), { keys: ['Multi-cache'], delta: null, series: [] }), false);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'dt', view: { chart: 'challenge' } }), { keys: [1, 2], delta: { values: [] }, series: [] }), false);
    // Ni carte, ni chiffre clé.
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'zone_country', view: { chart: 'map' } })), false);
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'none', view: { chart: 'number' } })), false);
    // Barres, courbes, aires : toujours soumises à un axe ordonné (jour de
    // la semaine : cyclique mais pas ordonné pour l'animation).
    assert.equal(chartAnimates(normalizeChartSpec({ groupBy: 'weekday', view: { chart: 'line' } })), false);
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

test('avancée : plancher de 2 s sur la pause finale', () => {
    // 15 % de 6 s = 0,9 s < plancher : l'animation court sur 4 s.
    assert.equal(revealProgress(0, 6000, VIDEO_HOLD, VIDEO_HOLD_MIN_MS), 0);
    assert.equal(revealProgress(2000, 6000, VIDEO_HOLD, VIDEO_HOLD_MIN_MS), 0.5);
    assert.equal(revealProgress(4000, 6000, VIDEO_HOLD, VIDEO_HOLD_MIN_MS), 1);
    // Au-delà du plancher, la part relative reprend la main (15 s → 2,25 s).
    assert.equal(revealProgress(6375, 15000, VIDEO_HOLD, VIDEO_HOLD_MIN_MS), 0.5);
    // Plafond à la moitié de la vidéo : l'animation reste visible.
    assert.equal(revealProgress(1500, 3000, VIDEO_HOLD, VIDEO_HOLD_MIN_MS), 1);
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

// Textes du canevas : mesure simulée, 10 px par caractère.
const px10 = (s) => s.length * 10;

test('ellipsize : tronque avec « … » au lieu de compresser', () => {
    // Rentre : inchangé.
    assert.equal(ellipsize('court', 200, px10), 'court');
    assert.equal(ellipsize('pile', 40, px10), 'pile');
    // Trop long : la plus grande coupe qui tient avec « … » (5 + 1 = 6 car.).
    assert.equal(ellipsize('Septembre', 60, px10), 'Septe…');
    assert.equal(ellipsize('Septembre', 59, px10), 'Sept…');
    // Même « … » seul ne tient pas : rendu quand même.
    assert.equal(ellipsize('long', 5, px10), '…');
    // Entrées non chaînes.
    assert.equal(ellipsize(null, 50, px10), '');
    assert.equal(ellipsize(undefined, 50, px10), '');
    assert.equal(ellipsize('', 50, px10), '');
    assert.equal(ellipsize(1234, 30, px10), '12…');
    assert.equal(ellipsize('abc', 0, px10), '');
});

test('fitFontSize : taille réduite pour tenir, bornée par un plancher', () => {
    // Rentre : taille de base inchangée.
    assert.equal(fitFontSize('ok', 100, 200, px10), 100);
    assert.equal(fitFontSize('pile', 100, 40, px10), 100);
    // Déborde : proportionnelle (10 car. = 100 px, 100 × 60/100).
    assert.equal(fitFontSize('0123456789', 100, 60, px10), 60);
    // Plancher : la réduction ne descend pas sous baseSize × minRatio.
    assert.equal(fitFontSize('0123456789', 100, 20, px10), 50);
    assert.equal(fitFontSize('0123456789', 100, 20, px10, 0.3), 30);
    // Vide / non chaîne : rien à mesurer, taille de base.
    assert.equal(fitFontSize('', 100, 10, px10), 100);
    assert.equal(fitFontSize(null, 100, 10, px10), 100);
    assert.equal(fitFontSize(123, 100, 10, px10), 50); // 30 px → 100/3, sous le plancher → 50
});
