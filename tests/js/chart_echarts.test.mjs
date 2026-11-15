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
    CALENDAR_MAX_YEARS, buildChartOption, calendarCell, clickTarget, calendarYears, chartHeight, contrastRatio, cumulativeFloor, distinctTypeColors, escapeHtml, numberModel, rampColor, thumbnailOption, trendModel, verdictModel, withClickHint,
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

test('types de même couleur sur la carte : une nuance chacun, stable et lisible sur le fond', () => {
    const shared = { 'Unknown Cache': '#0000FF', 'Wherigo Cache': '#0000FF', 'Letterbox Hybrid': '#0000FF',
        'Earthcache': '#87CEEB', 'Virtual Cache': '#87CEEB', 'Traditional Cache': '#008000' };
    for (const surface of ['#ffffff', '#1b2635']) {
        const colors = distinctTypeColors(shared, surface);
        // Le premier type de chaque couleur la garde, un type seul aussi.
        assert.equal(colors['Unknown Cache'], '#0000FF');
        assert.equal(colors.Earthcache, '#87CEEB');
        assert.equal(colors['Traditional Cache'], '#008000');
        // Six types, six couleurs.
        assert.equal(new Set(Object.values(colors)).size, 6);
        // Une nuance n'est pas moins lisible sur le fond que la couleur d'origine (ou que 2:1).
        for (const type of ['Wherigo Cache', 'Letterbox Hybrid']) {
            assert.ok(contrastRatio(colors[type], surface) >= Math.min(2, contrastRatio('#0000FF', surface)), `${type} sur ${surface}`);
        }
        // Même objet, même fond : même résultat (un type garde sa nuance d'un graphique à l'autre).
        assert.equal(distinctTypeColors(shared, surface), colors);
    }
    // Sur fond sombre, pas de bleu marine qui se fondrait dans le fond.
    assert.notEqual(distinctTypeColors(shared, '#1b2635')['Wherigo Cache'], distinctTypeColors(shared, '#ffffff')['Wherigo Cache']);
});

test('anneau : deux types de même couleur sur la carte y ont deux parts distinctes', () => {
    const shared = { ...typeColors, 'Multi-cache': '#008000' };
    const spec = normalizeChartSpec({ groupBy: 'cache_type', view: { chart: 'donut' } }, () => 'abcdef');
    const result = runChartQuery(spec, table, { today: TODAY });
    const o = buildChartOption(result, spec, { ...ctx, typeColors: shared });
    assert.equal(o.series[0].data[0].itemStyle.color, '#008000');
    assert.equal(new Set(o.series[0].data.map((d) => d.itemStyle.color)).size, o.series[0].data.length);
});

test('cumul depuis le début sur une période tardive : l\'axe ne part plus de zéro', () => {
    const progress = { groupBy: 'month', measure: { op: 'cumulative', from: 'all' }, view: { chart: 'area' } };
    // 2026 : 3 trouvailles avant, la courbe va de 4 à 5 — depuis zéro, un trait plat.
    const late = option({ ...progress, periods: [{ kind: 'year', year: 2026 }] });
    const floor = late.option.yAxis.min;
    assert.ok(floor > 0 && floor <= 4, `bas de l'axe ${floor}`);
    assert.equal(cumulativeFloor(late.result, late.spec), floor);
    // Toute la période : la courbe part de 1, l'axe de zéro.
    assert.equal(option(progress).option.yAxis.min, undefined);
    // Barres : leur longueur est la valeur, toujours depuis zéro.
    assert.equal(option({ ...progress, view: { chart: 'bar' }, periods: [{ kind: 'year', year: 2026 }] }).option.yAxis.min, undefined);
    // Cumul de la seule période : il part de zéro.
    assert.equal(option({ ...progress, measure: { op: 'cumulative' }, periods: [{ kind: 'year', year: 2026 }] }).option.yAxis.min, undefined);
    // Côte à côte : même bas d'axe pour chaque petit graphique.
    const side = option({ ...progress, periods: [{ kind: 'year', year: 2026 }, { kind: 'previous' }],
        compare: { layout: 'side', toDate: false } }).option;
    assert.equal(new Set(side.yAxis.map((axis) => axis.min)).size, 1);
});

test('bas d\'axe d\'un cumul : valeur ronde sous la plus petite valeur', () => {
    const spec = { measure: { op: 'cumulative', from: 'all' }, view: { chart: 'line' } };
    const result = (values) => ({ normalize: 'none', series: [{ values }] });
    assert.equal(cumulativeFloor(result([2950, 3100, null, 3326]), spec), 2900);
    assert.equal(cumulativeFloor(result([12040, 12050, 12061]), spec), 12040);
    // La courbe occupe déjà plus de la moitié de la hauteur : zéro.
    assert.equal(cumulativeFloor(result([64, 2000, 4000]), spec), undefined);
    // Plate (rien de trouvé sur la période) : zéro, la ligne reste en haut.
    assert.equal(cumulativeFloor(result([3000, 3000]), spec), undefined);
    // Un objectif déjà dépassé reste dans le cadre.
    assert.equal(cumulativeFloor(result([2950, 3326]), { ...spec, goal: { value: 1000 } }), undefined);
});

test('bilan d\'une comparaison : réponse en clair, à date, flèche dans le bon sens', () => {
    const periods = [{ kind: 'current', unit: 'year' }, { kind: 'previous' }];
    const { spec, result } = option({ groupBy: 'month_of_year', measure: { op: 'cumulative' }, periods,
        compare: { toDate: false }, view: { chart: 'line' } });
    const model = verdictModel(result, spec, ctx);
    // 2026 au 8 novembre : 2 ; 2025 au 8 novembre : 3.
    assert.equal(model.sign, -1);
    assert.equal(model.lead, '2026 à ce jour : 2');
    assert.equal(model.text, '−1');
    assert.match(model.ratio, /33\s?%/);
    assert.match(model.versus, /^par rapport au 8 nov\.? 2025$/);
    // Périodes révolues : sur toute leur durée, « par rapport à 2024 » (2026,
    // en cours, se compare à date même nommée par son année).
    const whole = option({ groupBy: 'month', periods: [{ kind: 'year', year: 2025 }, { kind: 'year', year: 2024 }],
        view: { chart: 'bar' } });
    const past = verdictModel(whole.result, whole.spec, ctx);
    assert.equal(past.lead, '2025 : 3');
    assert.equal(past.versus, 'par rapport à 2024');
    assert.equal(past.ratio, '');
    // Le chiffre clé a déjà son écart ; une seule période n'a pas de bilan.
    const number = option({ groupBy: 'none', periods, view: { chart: 'number' } });
    assert.equal(verdictModel(number.result, number.spec, ctx), null);
    const single = option({ groupBy: 'month' });
    assert.equal(verdictModel(single.result, single.spec, ctx), null);
});

test('aide de clic : ligne ajoutée au bas de l\'infobulle, échappée, rien sur une infobulle vide', () => {
    const { option: o } = option({ groupBy: 'year' });
    const hinted = withClickHint(o, 'Cliquer : voir <la> carte', tokens);
    const params = [{ dataIndex: 0, seriesIndex: 0, value: 3, color: '#2a78d6', axisValueLabel: '2025' }];
    const base = o.tooltip.formatter(params);
    const html = hinted.tooltip.formatter(params);
    assert.ok(html.startsWith(base));
    assert.match(html, /Cliquer : voir &lt;la&gt; carte<\/div>$/);
    assert.match(html, new RegExp(tokens.textMuted));
    // L'option d'origine n'est pas touchée ; sans aide, rien ne change.
    assert.equal(o.tooltip.formatter(params), base);
    assert.equal(withClickHint(o, null, tokens), o);
    // Infobulle vide (case sans valeur) : reste vide.
    const empty = withClickHint({ tooltip: { formatter: () => '' } }, 'Cliquer', tokens);
    assert.equal(empty.tooltip.formatter(), '');
});

test('mini-barres d\'un chiffre clé : une par année, en part de la plus forte, année en cours repérée', () => {
    const { spec, result } = option({ groupBy: 'year', periods: [{ kind: 'all' }] });
    // 2025 : 3 trouvailles, 2026 (en cours) : 2.
    const model = trendModel(result, spec, { ...ctx, today: TODAY });
    assert.deepEqual(model.bars.map((b) => [b.label, b.value, b.partial]), [['2025', 3, false], ['2026', 2, true]]);
    assert.equal(model.bars[0].level, 1);
    assert.match(model.text, /^Par année : 2025 : 3 · 2026 : 2$/);
    // Une seule année : rien à situer.
    const one = option({ groupBy: 'year', periods: [{ kind: 'year', year: 2025 }] });
    assert.equal(trendModel(one.result, one.spec, ctx), null);
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

test('anneau en vidéo : place et légende du résultat complet dès la première part', () => {
    const { spec, result } = option({ groupBy: 'cache_type', view: { chart: 'donut' } });
    const full = buildChartOption(result, spec, ctx);
    // Une seule part révélée : sans `layoutResult`, l'anneau serait centré,
    // sans légende — il glissait à gauche à l'arrivée de la deuxième.
    const first = result.series[0].values.findIndex((v) => v > 0);
    const partial = { ...result, series: [{ ...result.series[0], values: result.series[0].values.map((v, k) => (k === first ? v : null)) }] };
    assert.deepEqual(buildChartOption(partial, spec, ctx).series[0].center, ['50%', '50%']);
    const video = buildChartOption(partial, spec, { ...ctx, layoutResult: result });
    assert.deepEqual(video.series[0].center, full.series[0].center);
    assert.deepEqual(video.series[0].data.map((d) => d.name), full.series[0].data.map((d) => d.name));
    assert.notEqual(video.legend.show, false);
    // Les parts à venir sont vides (ni secteur ni étiquette).
    assert.deepEqual(video.series[0].data.map((d) => d.value === '-'), full.series[0].data.map((d) => d.keyIndex !== first));
    const tip = video.tooltip.formatter({ color: '#008000', name: 'x', value: result.series[0].values[first], seriesIndex: 0 });
    assert.match(tip, /100\s?%/);
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
    assert.deepEqual(numberModel(result, spec, ctx), [{ label: '', value: 5, text: '5', record: '', delta: null }]);
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
    assert.match(html, /−50\s?%/);
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
    assert.match(blocks[0].delta.ratio, /−33\s?%/);
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

// ---------------------------------------------------------------------------
// Sources (lot 4)
// ---------------------------------------------------------------------------

import { runChartQueries } from '../../static/js/chart_query.mjs';
import { tableFromRecords } from '../../static/js/chart_sources.mjs';

const received = tableFromRecords([
    { day: dayNumber({ y: 2025, m: 2, d: 1 }) },
    { day: dayNumber({ y: 2026, m: 3, d: 1 }) },
    { day: dayNumber({ y: 2026, m: 4, d: 1 }) },
], { source: 'poses.received' });
const tableOf = (source) => (source === 'finds' ? table : received);

function multi(raw) {
    const spec = normalizeChartSpec({ source: 'finds', extraSources: ['poses.received'], ...raw }, () => 'abcdef');
    const result = runChartQueries(spec, tableOf, { today: TODAY });
    return { spec, result, option: buildChartOption(result, spec, ctx) };
}

test('plusieurs sources : une série nommée par source, légende', () => {
    const { option: o } = multi({ groupBy: 'year' });
    assert.deepEqual(o.series.map((s) => s.name), ['Trouvailles', 'Trouvailles reçues']);
    assert.deepEqual(o.series.map((s) => s.color), [tokens.series[0], tokens.series[1]]);
    assert.notEqual(o.legend.show, false);
});

test('écart entre deux sources : infobulle avec les deux sources', () => {
    const { result, option: o } = multi({ groupBy: 'year', compare: { layout: 'delta' } });
    assert.deepEqual(result.delta.values, [2, 0]);
    assert.match(o.title.text, /Trouvailles par rapport à Trouvailles reçues/);
});

test('chiffre clé sur deux sources : l\'écart nomme l\'autre source', () => {
    const { spec, result } = multi({ groupBy: 'none', view: { chart: 'number' } });
    const blocks = numberModel(result, spec, ctx);
    assert.deepEqual(blocks.map((b) => b.label), ['Trouvailles', 'Trouvailles reçues']);
    assert.equal(blocks[0].delta.versus, 'par rapport aux trouvailles reçues');
    assert.equal(blocks[0].delta.text, '+2');
});

test('titres par défaut selon la source', () => {
    const labels = ctx.labels;
    assert.equal(labels.defaultTitle(normalizeChartSpec({ source: 'poses.received', groupBy: 'month' })), 'Trouvailles reçues par mois');
    assert.equal(labels.defaultTitle(normalizeChartSpec({ source: 'owned', measure: { op: 'active' }, groupBy: 'year' })), 'Caches actives par année');
    assert.equal(labels.defaultTitle(normalizeChartSpec({ source: 'poses.received', measure: { op: 'distinct', field: 'finder' }, groupBy: 'month' })),
        'Visiteurs différents — Trouvailles reçues par mois');
    assert.equal(labels.defaultTitle(normalizeChartSpec({ source: 'finds', extraSources: ['poses.received'], groupBy: 'year' })),
        'Trouvailles / Trouvailles reçues par année');
    assert.equal(labels.sourceLabel('evolution:3:archived'), 'Caches archivées');
    assert.equal(labels.sourceNoun('evolution:3'), 'Caches publiées');
});

// ---------------------------------------------------------------------------
// Retour à la carte (lot 6) : le clic désigne une série et une clé
// ---------------------------------------------------------------------------

test("clic : barre, part d'anneau, case du calendrier, écart", () => {
    const bars = option({ groupBy: 'year' });
    assert.deepEqual(clickTarget(bars.result, bars.spec, { componentType: 'series', seriesIndex: 0, dataIndex: 1 }),
        { seriesIndex: 0, keyIndex: 1 });
    assert.equal(clickTarget(bars.result, bars.spec, { componentType: 'xAxis' }), null);

    // Anneau : les parts nulles sont retirées, la part porte sa clé.
    const donut = option({ groupBy: 'cache_type', view: { chart: 'donut' } });
    const slice = donut.option.series[0].data.at(-1);
    const target = clickTarget(donut.result, donut.spec, { componentType: 'series', seriesIndex: 0, dataIndex: 99, data: slice });
    assert.equal(donut.result.keys[target.keyIndex], donut.result.keys[slice.keyIndex]);

    const calendar = option({ groupBy: 'day', view: { chart: 'calendar' }, periods: [{ kind: 'year', year: 2025 }] });
    const hit = clickTarget(calendar.result, calendar.spec, { componentType: 'series', seriesIndex: 0, value: ['2025-03-03', 1] });
    assert.equal(calendar.result.keys[hit.keyIndex], dayNumber({ y: 2025, m: 3, d: 3 }));

    const delta = option({
        groupBy: 'month_of_year', periods: [{ kind: 'year', year: 2026 }, { kind: 'year', year: 2025 }],
        compare: { layout: 'delta', toDate: false },
    });
    assert.ok(delta.result.delta);
    assert.equal(clickTarget(delta.result, delta.spec, { componentType: 'series', seriesIndex: 0, dataIndex: 0 }), null);
});

test('vignette de la galerie : la forme seule, sans texte ni interaction', () => {
    const shapes = [
        { groupBy: 'year', view: { chart: 'bar', labels: true } },
        { groupBy: 'month', measure: { op: 'cumulative', from: 'all' }, view: { chart: 'area' } },
        { groupBy: 'cache_type', view: { chart: 'donut', labels: true } },
        { groupBy: 'month_of_year', periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }], view: { chart: 'bar' }, compare: { layout: 'delta' } },
        { groupBy: 'cache_type', periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }], view: { chart: 'donut' }, compare: { layout: 'side' } },
        { groupBy: 'dt', view: { chart: 'heatmap' } },
        { groupBy: 'weekday', view: { chart: 'radar' } },
        { groupBy: 'day', view: { chart: 'calendar' } },
    ];
    for (const raw of shapes) {
        const { option: o } = option(raw);
        const thumb = thumbnailOption(o);
        const what = raw.view.chart + '/' + (raw.compare?.layout || '-');
        assert.equal(thumb.animation, false, what);
        assert.equal(thumb.tooltip.show, false, what);
        assert.equal(thumb.legend.show, false, what);
        assert.equal(thumb.title, undefined, what);
        assert.equal(thumb.dataZoom, undefined, what);
        for (const axis of [thumb.xAxis, thumb.yAxis].flat().filter(Boolean)) {
            assert.equal(axis.axisLabel.show, false, what);
        }
        for (const s of thumb.series) {
            assert.equal(s.silent, true, what);
            assert.equal(s.label.show, false, what);
            assert.equal(s.markLine, undefined, what);
        }
        for (const v of [thumb.visualMap].flat().filter(Boolean)) assert.equal(v.show, false, what);
        // L'option d'origine n'est pas touchée (elle peut servir ailleurs).
        assert.notEqual(o.animation, false, what);
    }
    // Anneau seul recentré (sa légende à droite a disparu).
    const donut = thumbnailOption(option({ groupBy: 'cache_type', view: { chart: 'donut' } }).option);
    assert.deepEqual(donut.series[0].center, ['50%', '50%']);
    assert.equal(thumbnailOption(null), null);
});

test('grille de défi : la vidéo fige l\'échelle des couleurs (lockedMax)', () => {
    const { spec, result } = option({ groupBy: 'dt', periods: [{ kind: 'all' }], view: { chart: 'challenge' } });
    const colorOf = (o, key) => o.series[0].data.find((d) => result.keys[d.keyIndex] === key).itemStyle.color;
    // Sans échelle figée, une case à 1 sur un maximum de 1 prend la teinte
    // la plus foncée ; avec un maximum figé à 4, elle reste claire.
    const free = buildChartOption(result, spec, ctx);
    const locked = buildChartOption(result, spec, { ...ctx, lockedMax: 4 });
    assert.equal(colorOf(free, '1|1'), rampColor(tokens.heat, 1));
    assert.equal(colorOf(locked, '1|1'), rampColor(tokens.heat, 0.25 + 0.75 / 4));
});
