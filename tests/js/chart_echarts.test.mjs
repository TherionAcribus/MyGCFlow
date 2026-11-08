// Adaptateur ECharts de la page Statistiques (static/js/chart_echarts.mjs) :
// forme des options, jamais les pixels.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { runChartQuery } from '../../static/js/chart_query.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';
import {
    CALENDAR_MAX_YEARS, buildChartOption, calendarCell, calendarYears, chartHeight, contrastRatio, escapeHtml, numberModel, rampColor,
} from '../../static/js/chart_echarts.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const TODAY = dayNumber({ y: 2026, m: 11, d: 8 });
const tokens = {
    text: '#1f2b38',
    textMuted: '#5b6878',
    grid: '#e8ecf1',
    surface: '#ffffff',
    others: '#a9b1bb',
    unknown: '#cfd5dc',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    up: '#2a78d6',
    down: '#e34948',
    empty: '#eef1f5',
    heat: ['#e8f1fc', '#104281'],
};
const typeColors = { 'Traditional Cache': '#008000', 'Multi-cache': '#FFA500', 'Locationless (Reverse) Cache': '#FFFFFF' };
const ctx = { labels: makeLabels({ locale: 'fr' }), tokens, typeColors, attributeName: (k) => k };

const table = findsTable({
    count: 5,
    date: ['2025-01-01', '2025-01-02', '2025-03-03', '2026-01-04', '2026-02-05'],
    published: [null, null, null, null, null],
    kind: [0, 0, 0, 0, 0],
    code: ['GC1', 'GC2', 'GC3', 'GC4', 'GC5'],
    difficulty: [1, 2, 3, 4, 5],
    terrain: [1, 2, 3, 4, 5],
    cache_type: [0, 1, 0, 2, -1],
    container: [-1, -1, -1, -1, -1],
    country: [0, 0, 0, 0, 0],
    state: [-1, -1, -1, -1, -1],
    owner: [0, 1, 2, 3, 4],
    attributes: [[], [], [], [], []],
    dicts: {
        cache_type: ['Traditional Cache', 'Multi-cache', 'Locationless (Reverse) Cache'],
        container: [], country: ['France'], state: [], owner: ['A', 'B', 'C', 'D', 'E'], attribute: [],
    },
});

function option(raw, options = {}) {
    const spec = normalizeChartSpec(raw, () => 'abcdef');
    const result = runChartQuery(spec, table, { today: TODAY, ...options });
    return { spec, result, option: buildChartOption(result, spec, ctx) };
}

test('barres d\'une série : marques fines, bout arrondi, pas de légende', () => {
    const { option: o } = option({ groupBy: 'year' });
    assert.equal(o.series.length, 1);
    const [bar] = o.series;
    assert.equal(bar.type, 'bar');
    assert.equal(bar.barMaxWidth, 24);
    assert.deepEqual(bar.itemStyle.borderRadius, [4, 4, 0, 0]);
    assert.deepEqual(bar.data, [3, 2]);
    assert.equal(bar.color, tokens.series[0]);
    assert.equal(o.legend.show, false);
    assert.deepEqual(o.xAxis.data, ['2025', '2026']);
    assert.equal(o.yAxis.type, 'value');
    assert.equal(o.tooltip.trigger, 'axis');
    assert.equal(o.aria.enabled, true);
    assert.equal(o.yAxis.splitLine.lineStyle.type, 'solid');
});

test('barres horizontales : axes échangés, première catégorie en haut', () => {
    const { option: o } = option({ groupBy: 'owner', view: { orientation: 'horizontal' } });
    assert.equal(o.yAxis.type, 'category');
    assert.equal(o.yAxis.inverse, true);
    assert.equal(o.xAxis.type, 'value');
    assert.deepEqual(o.series[0].itemStyle.borderRadius, [0, 4, 4, 0]);
});

test('types de caches : couleurs de la carte, blanc illisible remplacé, inconnu en gris', () => {
    const { result, option: o } = option({ groupBy: 'cache_type' });
    const colors = Object.fromEntries(result.keys.map((key, i) => [key, o.series[0].data[i].itemStyle.color]));
    assert.equal(colors['Traditional Cache'], '#008000');
    assert.equal(colors['Multi-cache'], '#FFA500');
    assert.equal(colors['Locationless (Reverse) Cache'], tokens.textMuted);
    assert.equal(colors.unknown, tokens.unknown);
});

test('anneau : une part par catégorie non vide, légende, pourcentages en infobulle', () => {
    const { option: o } = option({ groupBy: 'cache_type', view: { chart: 'donut' } });
    assert.equal(o.series[0].type, 'pie');
    assert.deepEqual(o.series[0].radius, ['48%', '72%']);
    assert.equal(o.series[0].data.length, 4);
    assert.equal(o.series[0].data[0].itemStyle.color, '#008000');
    assert.notEqual(o.legend.show, false);
    const tip = o.tooltip.formatter({ color: '#008000', name: 'Traditionnelle', value: 2, seriesIndex: 0 });
    assert.match(tip, /40\s?%/);
});

test('courbe et aire : trait de 2 px, aire à 10 %, points masqués sur un long axe', () => {
    const line = option({ groupBy: 'month', view: { chart: 'line' } }).option;
    assert.equal(line.series[0].type, 'line');
    assert.equal(line.series[0].lineStyle.width, 2);
    assert.equal(line.series[0].areaStyle, undefined);
    const area = option({ groupBy: 'month', view: { chart: 'area' } }).option;
    assert.equal(area.series[0].areaStyle.opacity, 0.1);
    const days = option({ groupBy: 'day', view: { chart: 'line' } }).option;
    assert.equal(days.series[0].showSymbol, false);
    // Plus de 400 jours : zoom à la molette et glissière.
    assert.deepEqual(days.dataZoom.map((z) => z.type), ['inside', 'slider']);
    // Une vingtaine de mois : ni l'un ni l'autre.
    assert.equal(line.dataZoom, undefined);
});

test('plusieurs périodes : une série chacune, nommée par sa période, légende affichée', () => {
    const { option: o } = option({
        groupBy: 'month_of_year',
        periods: [{ kind: 'year', year: 2025 }, { kind: 'year', year: 2026 }],
    });
    // 2026 est en cours (aujourd'hui = 8 novembre 2026) : 2025 est coupé
    // au même jour (« à date », par défaut).
    assert.deepEqual(o.series.map((s) => s.name), ['2025 (au 8 nov.)', '2026 (en cours)']);
    assert.deepEqual(o.series.map((s) => s.color), [tokens.series[0], tokens.series[1]]);
    assert.notEqual(o.legend.show, false);
    assert.equal(o.grid.top, 36);
});

test('2ᵉ dimension par type : la couleur suit le type, pas le rang', () => {
    const { option: o } = option({ groupBy: 'year', splitBy: 'cache_type' });
    const byName = Object.fromEntries(o.series.map((s) => [s.name, s.color]));
    assert.equal(byName['Traditional Cache'], '#008000');
    assert.equal(byName['Multi-cache'], '#FFA500');
});

test('échelle logarithmique : zéros retirés', () => {
    const { option: o } = option({ groupBy: 'month', view: { log: true } });
    assert.equal(o.yAxis.type, 'log');
    assert.ok(!o.series[0].data.includes(0));
});

test('étiquettes de valeur : seulement si demandées et pas trop de barres', () => {
    assert.equal(option({ groupBy: 'year', view: { labels: true } }).option.series[0].label.show, true);
    assert.equal(option({ groupBy: 'year' }).option.series[0].label.show, false);
    assert.equal(option({ groupBy: 'day', view: { labels: true } }).option.series[0].label.show, false);
});

test('infobulle : clé en toutes lettres, valeur formatée, HTML échappé', () => {
    const { option: o } = option({ groupBy: 'owner' });
    const html = o.tooltip.formatter([{ dataIndex: 0, seriesIndex: 0, value: 1, color: '#000' }]);
    assert.match(html, /<b>1<\/b>/);
    assert.equal(escapeHtml('<b>"A" & \'B\'</b>'), '&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;');
});

test('chiffre clé : pas d\'option ECharts, valeur formatée', () => {
    const { spec, result, option: o } = option({ groupBy: 'none', view: { chart: 'number' } });
    assert.equal(o, null);
    assert.deepEqual(numberModel(result, spec, ctx), [{ label: '', value: 5, text: '5', delta: null }]);
});

test('contraste', () => {
    assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
    assert.equal(contrastRatio('#fff', '#ffffff'), 1);
    assert.equal(contrastRatio('rouge', '#ffffff'), null);
});

// ---------------------------------------------------------------------------
// Comparaison (lot 2)
// ---------------------------------------------------------------------------

const twoYears = [{ kind: 'year', year: 2026 }, { kind: 'previous' }];

test('côte à côte : un repère par période, même échelle, titre par période', () => {
    const { option: o } = option({
        groupBy: 'cache_type', periods: twoYears, compare: { layout: 'side', toDate: false },
    });
    assert.equal(o.grid.length, 2);
    assert.equal(o.xAxis.length, 2);
    assert.deepEqual(o.series.map((s) => s.xAxisIndex), [0, 1]);
    assert.equal(o.yAxis[0].max, o.yAxis[1].max);
    assert.deepEqual(o.title.map((t) => t.text), ['2026 (en cours)', '2025']);
    assert.equal(o.legend.show, false);
});

test('anneaux côte à côte : la même catégorie garde sa teinte', () => {
    const { option: o } = option({
        groupBy: 'cache_type', periods: twoYears, view: { chart: 'donut' }, compare: { toDate: false },
    });
    assert.equal(o.series.length, 2);
    assert.deepEqual(o.series.map((s) => s.center[0]), ['25%', '75%']);
    const color = (s, name) => s.data.find((d) => d.name === name)?.itemStyle.color;
    assert.equal(color(o.series[0], 'Locationless (Reverse) Cache'), tokens.textMuted);
    assert.equal(o.title.length, 2);
});

test('écart : barres bleues au-dessus de zéro, rouges en dessous, infobulle complète', () => {
    const { result, option: o } = option({
        groupBy: 'month_of_year', periods: twoYears, compare: { layout: 'delta', toDate: false },
    });
    assert.ok(result.delta);
    const [bar] = o.series;
    const colors = bar.data.map((d) => d.itemStyle.color);
    // Janvier : 1 (2026) − 2 (2025) = −1 → rouge ; février : 1 − 0 → bleu.
    assert.equal(bar.data[0].value, -1);
    assert.equal(colors[0], tokens.down);
    assert.equal(bar.data[1].value, 1);
    assert.equal(colors[1], tokens.up);
    assert.deepEqual(bar.data[0].itemStyle.borderRadius, [0, 0, 4, 4]);
    const html = o.tooltip.formatter([{ dataIndex: 0 }]);
    assert.match(html, /2026/);
    assert.match(html, /−1/);
    assert.match(html, /-50\s?%/);
});

test('axe « depuis le début » : Mois 1…, vraie date de chaque série dans l\'infobulle', () => {
    const { option: o } = option({
        groupBy: 'month', periods: twoYears, compare: { align: 'elapsed', toDate: false },
    });
    assert.equal(o.xAxis.data[0], 'Mois 1');
    assert.equal(o.xAxis.data.length, 12);
    const html = o.tooltip.formatter([
        { dataIndex: 0, seriesIndex: 0, value: 1, color: '#000' },
        { dataIndex: 0, seriesIndex: 1, value: 2, color: '#111' },
    ]);
    assert.match(html, /janv\. 2026/);
    assert.match(html, /janv\. 2025/);
});

test('case en cours : remplissage atténué, bord en tirets', () => {
    const { result, option: o } = option({ groupBy: 'month', periods: [{ kind: 'current', unit: 'year' }] });
    const partial = result.series[0].partial;
    assert.equal(result.keys[partial], 202611);
    const item = o.series[0].data[partial];
    assert.equal(item.itemStyle.borderType, 'dashed');
    assert.equal(item.itemStyle.opacity, 0.45);
});

test('pourcentages : axe et valeurs en %', () => {
    const { option: o } = option({ groupBy: 'cache_type', compare: { normalize: 'percent' } });
    assert.equal(o.yAxis.axisLabel.formatter(40), '40,0 %');
});

test('chiffre clé comparé : l\'écart avec la deuxième période sur la première', () => {
    const { spec, result } = option({ groupBy: 'none', view: { chart: 'number' }, periods: twoYears, compare: { toDate: false } });
    const blocks = numberModel(result, spec, ctx);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.value), [2, 3]);
    assert.equal(blocks[0].delta.text, '−1');
    assert.equal(blocks[0].delta.sign, -1);
    assert.match(blocks[0].delta.ratio, /-33\s?%/);
    assert.equal(blocks[0].delta.versus, 'par rapport à 2025');
    assert.equal(blocks[1].delta, null);
});

// ---------------------------------------------------------------------------
// Graphisme (lot 3)
// ---------------------------------------------------------------------------

test('palettes d\'une série de barres : automatique, une couleur, une par valeur, dégradé', () => {
    const colorsOf = (o) => o.series[0].data.map((d) => (typeof d === 'object' && d !== null ? d.itemStyle.color : o.series[0].color));
    // Automatique : propriétaires d'une seule teinte (l'axe les nomme).
    const auto = option({ groupBy: 'owner' }).option;
    assert.deepEqual([...new Set(colorsOf(auto))], [tokens.series[0]]);
    // Une par valeur : teintes de la palette dans l'ordre.
    const multi = option({ groupBy: 'owner', view: { palette: 'multi' } }).option;
    assert.deepEqual(colorsOf(multi).slice(0, 3), tokens.series.slice(0, 3));
    // Une par valeur sur les types : la palette, pas les couleurs de la carte.
    const typesMulti = option({ groupBy: 'cache_type', view: { palette: 'multi' } }).option;
    assert.equal(colorsOf(typesMulti)[0], tokens.series[0]);
    // Une seule couleur, même pour les types.
    const accent = option({ groupBy: 'cache_type', view: { palette: 'accent' } }).option;
    assert.ok(accent.series[0].data.every((d) => typeof d !== 'object' || d === null));
    // Dégradé : la plus grande barre a la couleur la plus forte.
    const heat = option({ groupBy: 'year', view: { palette: 'heat' } }).option;
    assert.equal(colorsOf(heat)[0], '#104281');
});

test('dégradé : interpolation le long de la rampe', () => {
    assert.equal(rampColor(['#000000', '#ffffff'], 0), '#000000');
    assert.equal(rampColor(['#000000', '#ffffff'], 1), '#ffffff');
    assert.equal(rampColor(['#000000', '#ffffff'], 0.5), '#808080');
    assert.equal(rampColor(['#000000', '#ffffff'], 7), '#ffffff');
});

test('grille D/T : 9 × 9 cases, difficulté en x, terrain en y, cases vides au fond', () => {
    const { option: o } = option({ groupBy: 'dt', view: { chart: 'heatmap' } });
    assert.equal(o.xAxis.data.length, 9);
    assert.equal(o.yAxis.data.length, 9);
    assert.equal(o.series[0].type, 'heatmap');
    assert.equal(o.series[0].data.length, 81);
    // D1/T1 (rangée 0, colonne 0) : une trouvaille.
    assert.deepEqual(o.series[0].data[0], [0, 0, 1]);
    assert.deepEqual(o.series[0].data[1], [0, 1, '-']);
    assert.equal(o.visualMap.max, 1);
    assert.deepEqual(o.visualMap.inRange.color, tokens.heat);
});

test('grille regroupement × 2ᵉ dimension : une rangée par valeur', () => {
    const { option: o } = option({ groupBy: 'year', splitBy: 'cache_type', view: { chart: 'heatmap' } });
    assert.deepEqual(o.xAxis.data, ['2025', '2026']);
    assert.equal(o.yAxis.data.length, 4);
    assert.equal(o.series[0].data.length, 8);
});

test('calendrier : un bandeau par année, au plus trois, hauteur suivant les années', () => {
    const { result, spec, option: o } = option({ groupBy: 'day', view: { chart: 'calendar' } });
    assert.deepEqual(calendarYears(result).years, [2026, 2025]);
    assert.equal(o.calendar.length, 2);
    assert.equal(o.calendar[0].range, '2026');
    assert.equal(o.calendar[0].dayLabel.firstDay, 1);
    // Noms rangés du dimanche au samedi (convention ECharts).
    assert.equal(o.calendar[0].dayLabel.nameMap[0], 'dim.');
    assert.equal(o.calendar[0].dayLabel.nameMap[1], 'lun.');
    assert.deepEqual(o.calendar[0].cellSize, [13, 13]);
    assert.equal(o.series.length, 2);
    assert.deepEqual(o.series[1].data[0], ['2025-01-01', 1]);
    assert.equal(chartHeight(result, spec), 40 + 2 * (13 * 7 + 38));
    assert.equal(chartHeight(result, { view: { chart: 'bar' } }), null);
    // Cases carrées selon la largeur, bornées.
    assert.equal(calendarCell(1000), 17);
    assert.equal(calendarCell(300), 8);
    assert.equal(calendarCell(4000), 18);
    assert.equal(chartHeight(result, spec, 1000), 40 + 2 * (17 * 7 + 38));
    // Petites cases : un jour sur deux nommé.
    const narrow = buildChartOption(result, spec, { ...ctx, width: 600 });
    assert.deepEqual(narrow.calendar[0].dayLabel.nameMap, ['', 'lun.', '', 'mer.', '', 'ven.', '']);
    const long = calendarYears({ periods: [{ from: dayNumber({ y: 2015, m: 1, d: 1 }), to: dayNumber({ y: 2026, m: 1, d: 1 }) }] });
    assert.equal(long.years.length, CALENDAR_MAX_YEARS);
    assert.equal(long.truncated, true);
});

test('radar : un indicateur par clé, une forme par série, même maximum', () => {
    const { option: o } = option({
        groupBy: 'weekday', view: { chart: 'radar' },
        periods: [{ kind: 'year', year: 2026 }, { kind: 'previous' }], compare: { toDate: false },
    });
    assert.equal(o.radar.indicator.length, 7);
    assert.equal(o.radar.indicator[0].name, 'lun.');
    assert.equal(o.series[0].type, 'radar');
    assert.equal(o.series[0].data.length, 2);
    assert.ok(new Set(o.radar.indicator.map((i) => i.max)).size === 1);
    assert.notEqual(o.legend.show, false);
});
