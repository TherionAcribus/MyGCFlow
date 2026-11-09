// Grilles de défis de la page Statistiques (chart_challenge.mjs) : D/T 81,
// Calendrier 366, Jasmer, mois de trouvaille — géométrie, calcul, bilan,
// dessin, liens vers la carte et les panneaux vidéo.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChartSpec } from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { runChartQuery } from '../../static/js/chart_query.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';
import { challengeGrid, challengeSummary } from '../../static/js/chart_challenge.mjs';
import { buildChartOption, challengeText, chartHeight, clickTarget, thumbnailOption } from '../../static/js/chart_echarts.mjs';
import { mapSelectionFor, chartLinksToMap } from '../../static/js/chart_map_link.mjs';
import { panelFromSpec } from '../../static/js/chart_panel_link.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
const TODAY = day('2026-11-09');

// 5 trouvailles : deux D1,5/T2, un D2/T1, un Lab (sans D/T), une avant la
// première publication possible (mai 2000).
const table = findsTable({
    count: 5,
    date: ['2023-01-15', '2023-02-28', '2024-02-29', '2024-02-29', '2024-03-01'],
    published: ['2003-05-02', '2001-01-01', '2024-02-10', null, '1999-12-31'],
    kind: [0, 0, 0, 1, 0],
    code: ['GC1', 'GC2', 'GC3', 'lab', 'GC5'],
    difficulty: [1.5, 2, 1.5, null, 1.5],
    terrain: [2, 1, 2, null, 2],
    attributes: [[], [], [], [], []],
    dicts: {},
});

const tokens = {
    text: '#1f2b38', textMuted: '#5b6878', grid: '#e8ecf1', surface: '#ffffff', others: '#a9b1bb',
    unknown: '#cfd5dc', series: ['#2a78d6'], up: '#2a78d6', down: '#e34948', empty: '#eef1f5',
    heat: ['#e8f1fc', '#104281'],
};
const labels = makeLabels({ locale: 'fr' });
const ctx = { labels, tokens, typeColors: {}, attributeName: (k) => k, width: 600 };

function run(groupBy, extra = {}) {
    const spec = normalizeChartSpec({ groupBy, periods: [{ kind: 'all' }], view: { chart: 'challenge', labels: true }, ...extra });
    assert.equal(spec.view.chart, 'challenge', groupBy);
    return { spec, result: runChartQuery(spec, table, { today: TODAY }) };
}

test('géométrie : D/T 81, calendrier 366, Jasmer depuis mai 2000, mois de la période', () => {
    const all = { from: day('2023-01-15'), to: day('2024-03-01'), fullTo: day('2024-03-01') };
    const dt = challengeGrid('dt', all, TODAY);
    assert.equal(dt.cells.length, 81);
    assert.equal(dt.cells[0].key, '1|1');
    assert.equal(dt.cells[1].key, '1|1.5');      // lignes : difficulté, colonnes : terrain
    assert.equal(dt.cells[80].key, '5|5');

    const calendar = challengeGrid('day_of_year', all, TODAY);
    assert.equal(calendar.cells.length, 366);
    assert.equal(calendar.rows, 12);
    const feb = calendar.cells.filter((c) => c.r === 1);
    assert.equal(feb.length, 29);                 // pas de 30 ni de 31 février
    assert.equal(feb.at(-1).key, 60);             // 29 février : case 60

    const jasmer = challengeGrid('published_month', all, TODAY);
    assert.equal(jasmer.cells[0].key, 200005);
    assert.equal(jasmer.cells.at(-1).key, 202403); // fin de la période
    assert.equal(jasmer.cells.length, 8 + 23 * 12 + 3);
    // Période qui finit après aujourd'hui : rien au-delà du mois en cours.
    const year = { from: day('2026-01-01'), to: day('2026-12-31'), fullTo: day('2026-12-31') };
    assert.equal(challengeGrid('published_month', year, TODAY).cells.at(-1).key, 202611);
    assert.equal(challengeGrid('month', year, TODAY).cells.length, 11);

    const months = challengeGrid('month', all, TODAY);
    assert.deepEqual(months.rowKeys, [2023, 2024]);
    assert.equal(months.cells.length, 15);        // janvier 2023 → mars 2024
    assert.equal(challengeGrid('year', all, TODAY), null);
});

test('bilan : cases trouvées, tours complets, cases du tour suivant', () => {
    assert.deepEqual(challengeSummary([0, 2, 1, 3]), { filled: 3, available: 4, loops: 0, next: [0] });
    assert.deepEqual(challengeSummary([1, 2, 1]), { filled: 3, available: 3, loops: 1, next: [0, 2] });
    assert.deepEqual(challengeSummary([null, 4]), { filled: 1, available: 2, loops: 0, next: [0] });
    assert.deepEqual(challengeSummary([]), { filled: 0, available: 0, loops: 0, next: [] });
});

test('calcul : chaque case a sa valeur, les lignes sans valeur sont comptées à part', () => {
    const dt = run('dt').result;
    assert.equal(dt.keys.length, 81);
    assert.equal(dt.series[0].values[dt.keys.indexOf('1.5|2')], 3);
    assert.equal(dt.series[0].values[dt.keys.indexOf('2|1')], 1);
    assert.equal(dt.meta.unknown, 1);              // le Lab
    assert.equal(dt.grid.metric, 'dt');

    const calendar = run('day_of_year').result;
    assert.equal(calendar.series[0].values[59], 2);  // deux trouvailles un 29 février

    const jasmer = run('published_month').result;
    assert.equal(jasmer.series[0].values[jasmer.keys.indexOf(200305)], 1);
    assert.equal(jasmer.series[0].values[jasmer.keys.indexOf(202402)], 1);
    // Sans date (le Lab) ou avant mai 2000 : hors grille, signalés.
    assert.equal(jasmer.meta.unknown, 2);
    assert.equal(jasmer.series[0].values.reduce((a, b) => a + b, 0), 3);

    // Une période : seules ses trouvailles comptent.
    const y2023 = run('dt', { periods: [{ kind: 'year', year: 2023 }] }).result;
    assert.equal(y2023.series[0].values.reduce((a, b) => a + b, 0), 2);
});

test('textes : couverture, tours, cases qui manquent', () => {
    const { result } = run('dt');
    const text = challengeText(result, ctx);
    assert.match(text.coverage, /^Combinaisons : 2\/81 \(2\s%\)$/);   // espace fine insécable
    assert.equal(text.tours, 'Tours de matrice : 0');
    assert.equal(text.missing, 'Il manque 79 cases');
    // Peu de cases manquantes : elles sont nommées.
    const values = new Array(81).fill(1);
    values[80] = 0;
    values[10] = 0;
    const few = labels.challengeLines('dt', challengeSummary(values), result.keys);
    assert.equal(few.missing, 'Il manque : D1,5 / T1,5 · D5 / T5');
    // Un tour complet : ce qui manque au suivant.
    const round = labels.challengeLines('calendar', challengeSummary([2, 1, 2]), [1, 60, 366]);
    assert.equal(round.missing, 'Pour le tour 2 : 29 févr.');
    assert.equal(round.tours, 'Tours de calendrier : 1');
    assert.equal(labels.challengeLines('jasmer', challengeSummary([0]), [200005]).missing, 'Il manque : mai 2000');
});

test('dessin : une case par case disponible, cases carrées, bilan en titre', () => {
    for (const groupBy of ['dt', 'day_of_year', 'published_month', 'month']) {
        const { spec, result } = run(groupBy);
        const option = buildChartOption(result, spec, ctx);
        assert.equal(option.series[0].type, 'heatmap');
        assert.equal(option.series[0].data.length, result.grid.cells.length, groupBy);
        assert.equal(option.grid.width / option.xAxis.data.length, option.grid.height / option.yAxis.data.length, groupBy);
        assert.equal(option.xAxis.data.length * option.yAxis.data.length, result.grid.rows * result.grid.cols, groupBy);
        assert.match(option.title.text, /·/);
        assert.ok(chartHeight(result, spec, 600) > option.grid.height, groupBy);
        // Vignette de la galerie : sans le bilan.
        assert.equal(thumbnailOption(option).title, undefined);
    }
    const { spec, result } = run('dt');
    const option = buildChartOption(result, spec, ctx);
    const filled = option.series[0].data.find((d) => d.value[2] > 0);
    const empty = option.series[0].data.find((d) => d.value[2] === 0);
    assert.equal(empty.itemStyle.color, tokens.empty);
    assert.notEqual(filled.itemStyle.color, tokens.empty);
    // Clic : une case trouvée désigne sa clé, une case vide rien.
    const target = clickTarget(result, spec, { componentType: 'series', seriesIndex: 0, data: filled, value: filled.value });
    assert.deepEqual(target, { seriesIndex: 0, keyIndex: filled.keyIndex });
    assert.equal(clickTarget(result, spec, { componentType: 'series', seriesIndex: 0, data: empty, value: empty.value }), null);
});

test('Jasmer couchée : une colonne par année, une ligne par mois', () => {
    const { spec, result } = run('published_month');
    const option = buildChartOption(result, spec, ctx);
    assert.equal(option.xAxis.data[0], '2000');
    assert.equal(option.yAxis.data.length, 12);
    // Mai 2000 : colonne 0, ligne 4.
    assert.deepEqual(option.series[0].data[0].value.slice(0, 2), [0, 4]);
    // Plus de lignes que de colonnes seulement : la grille D/T reste droite.
    const dt = run('dt');
    assert.equal(buildChartOption(dt.result, dt.spec, ctx).yAxis.data.length, 9);
});

test('tour complet : les cases restées au minimum sont cerclées', () => {
    const spec = normalizeChartSpec({ groupBy: 'month', periods: [{ kind: 'year', year: 2023 }], view: { chart: 'challenge' } });
    const result = runChartQuery(spec, table, { today: TODAY });
    result.series[0].values = result.series[0].values.map((_, i) => (i === 3 ? 1 : 2));
    const option = buildChartOption(result, spec, ctx);
    const ringed = option.series[0].data.filter((d) => d.itemStyle.borderWidth === 2);
    assert.deepEqual(ringed.map((d) => d.keyIndex), [3]);
});

test('liens : carte filtrée (mois de publication), panneau vidéo de la même grille', () => {
    const { spec, result } = run('published_month');
    assert.equal(chartLinksToMap(spec), true);
    const link = mapSelectionFor({ spec, result, seriesIndex: 0, keyIndex: result.keys.indexOf(200305) });
    assert.deepEqual(link.selection.published_dates, { startDate: '2003-05-01', endDate: '2003-05-31' });

    const metrics = { dt: 'dt', day_of_year: 'calendar', published_month: 'jasmer', month: 'finds_ym' };
    for (const [groupBy, metric] of Object.entries(metrics)) {
        const out = panelFromSpec(run(groupBy).spec, { newId: () => 'abcdef01' });
        assert.equal(out.panel?.kind, 'grid', groupBy);
        assert.equal(out.panel.metric, metric, groupBy);
    }
});
