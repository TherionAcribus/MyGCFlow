// Cartes par zones de la page Statistiques : règles de la description
// (chart_spec.mjs), calcul (chart_zones.mjs), options ECharts et libellés.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    allowedCharts, allowedGroupBy, allowedLayouts, allowedNormalize, allowedSplitBy, normalizeChartSpec,
} from '../../static/js/chart_spec.mjs';
import { findsTable } from '../../static/js/chart_sources.mjs';
import { runZoneQuery, zoneClassOf, zoneMeasureOf } from '../../static/js/chart_zones.mjs';
import { buildChartOption, chartHeight, clickTarget, thumbnailOption, zoneLegend } from '../../static/js/chart_echarts.mjs';
import { makeLabels } from '../../static/js/chart_labels.mjs';
import { chartAnimates } from '../../static/js/chart_video.mjs';
import { panelFromSpec } from '../../static/js/chart_panel_link.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

const day = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return dayNumber({ y, m, d });
};
const TODAY = day('2026-11-09');
const spec = (raw) => normalizeChartSpec({ id: 'abcdef01', ...raw });

// Trouvailles : Bretagne (29, 56), Pays de la Loire (44), Belgique (pas de
// niveau 2), une hors carte.
const payload = {
    count: 7,
    date: ['2023-02-01', '2023-05-10', '2024-03-03', '2024-07-07', '2025-01-15', '2025-06-01', '2025-08-08'],
    code: ['GC1', 'GC2', 'GC3', 'GC4', 'GC5', 'GC6', 'GC7'],
    kind: [0, 0, 0, 0, 0, 0, 1],
    difficulty: [1, 2, 3, 2, 1.5, 4, null],
    terrain: [1, 2, 1, 2, 1.5, 4, null],
    cache_type: [0, 1, 0, 0, 1, 0, 2],
    dicts: {
        cache_type: ['Traditional', 'Mystery', 'Lab'],
        zone_country: ['FR', 'BE'],
        zone_region: ['FR-BRE', 'FR-PDL', 'BE-VLI'],
        zone_subregion: ['FR-29', 'FR-56', 'FR-44'],
    },
    zone_country: [0, 0, 0, 0, 1, 0, -1],
    zone_region: [0, 0, 1, 0, 2, 0, -1],
    zone_subregion: [0, 1, 2, 0, -1, 0, -1],
};
const table = findsTable(payload);

const tokens = {
    text: '#1f2b38', textMuted: '#5b6878', grid: '#e8ecf1', surface: '#ffffff', others: '#a9b1bb', unknown: '#cfd5dc',
    series: ['#2a78d6'], up: '#2a78d6', down: '#e34948', empty: '#eef1f5', heat: ['#e8f1fc', '#7aa7e0', '#104281'],
};
const labels = makeLabels({ locale: 'fr', zoneName: (id) => ({ 'FR-29': 'Finistère' }[id] || null) });
const ctx = { labels, tokens, typeColors: {}, attributeName: (k) => k };
const zoneMap = { name: 'mgz-test', bounds: [[-5, 49], [0, 46]], nameOf: (id) => id, levelNoun: (n) => `zones : ${n}` };

test('description : zones seulement en carte, carte seulement avec des zones', () => {
    const s = spec({ groupBy: 'zone_subregion', view: { chart: 'bar' }, splitBy: 'cache_type' });
    assert.equal(s.view.chart, 'map');
    assert.equal(s.splitBy, null);
    assert.equal(s.compare.layout, 'side');
    assert.deepEqual(s.view.map, { scale: 'quantile', classes: 5, frame: 'auto', highlight: true, gridSize: 25 });
    assert.deepEqual(allowedCharts({ groupBy: 'zone_region' }), ['map']);
    assert.ok(!allowedCharts({ groupBy: 'cache_type' }).includes('map'));
    assert.deepEqual(allowedSplitBy('zone_country'), []);
    assert.deepEqual(allowedLayouts({ view: { chart: 'map' } }), ['side']);
    // Les autres graphiques gardent leur forme (pas de réglages de carte).
    assert.equal(spec({ groupBy: 'year' }).view.map, undefined);
});

test('description : mesures propres aux cartes et compatibilités', () => {
    assert.deepEqual(allowedGroupBy({ op: 'dt_coverage' }), ['zone_country', 'zone_region', 'zone_subregion', 'zone_grid']);
    assert.equal(spec({ measure: { op: 'first_day' }, groupBy: 'year' }).groupBy, 'zone_country');
    assert.ok(!allowedGroupBy({ op: 'streak' }).includes('zone_region'));
    assert.ok(!allowedGroupBy({ op: 'distinct', field: 'country' }).includes('zone_region'));
    assert.ok(allowedGroupBy({ op: 'distinct', field: 'caches' }).includes('zone_region'));
    assert.ok(allowedGroupBy({ op: 'cumulative', from: 'all' }).includes('zone_subregion'));
    // Pas de zones hors des trouvailles (lot 3).
    assert.ok(!allowedGroupBy({ op: 'count' }, 'dnf').includes('zone_region'));
    assert.deepEqual(allowedNormalize({ measure: { op: 'count' }, groupBy: 'zone_region' }), ['none', 'per_km2']);
    assert.deepEqual(allowedNormalize({ measure: { op: 'mean', field: 'difficulty' }, groupBy: 'zone_region' }), ['none']);
    assert.equal(spec({ groupBy: 'zone_region', compare: { normalize: 'per_km2' } }).compare.normalize, 'per_km2');
});

test('description : moments clés réservés aux cartes, et seuls', () => {
    const map = spec({ groupBy: 'zone_region', periods: [{ kind: 'year', year: 2024 }, { kind: 'moments', rule: 'milestones' }] });
    assert.deepEqual(map.periods, [{ kind: 'moments', rule: 'milestones' }]);
    assert.equal(spec({ groupBy: 'year', periods: [{ kind: 'moments' }] }).periods, null);
    assert.deepEqual(spec({ groupBy: 'zone_region', periods: [{ kind: 'moments', rule: '??' }] }).periods,
        [{ kind: 'moments', rule: 'year_end' }]);
});

test('ni vidéo animée ni panneau vidéo pour une carte', () => {
    const s = spec({ groupBy: 'zone_region' });
    assert.equal(chartAnimates(s), false);
    assert.ok(panelFromSpec(s).error);
});

test('mesures : portée et équivalents zone_model', () => {
    assert.deepEqual(zoneMeasureOf(spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' } })),
        { measure: { op: 'count', per: null }, scope: 'all' });
    assert.deepEqual(zoneMeasureOf(spec({ groupBy: 'zone_region', measure: { op: 'distinct', field: 'caches' } })).measure,
        { op: 'distinct', field: 'code', per: null });
    assert.equal(zoneMeasureOf(spec({ groupBy: 'zone_region', measure: { op: 'first_day' } })).scope, 'all');
});

test('calcul : une vignette par année, cumul ou compte de la période', () => {
    const each = [{ kind: 'each', unit: 'year' }];
    const cumul = runZoneQuery(spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' }, periods: each }), table, { today: TODAY });
    assert.equal(cumul.kind, 'zone');
    assert.deepEqual(cumul.series.map((s) => s.day), [day('2023-12-31'), day('2024-12-31'), day('2025-12-31')]);
    // À égalité, par identifiant.
    assert.deepEqual(cumul.keys, ['FR-BRE', 'BE-VLI', 'FR-PDL']);
    assert.deepEqual(cumul.series.map((s) => s.values), [[2, null, null], [3, null, 1], [4, 1, 1]]);
    // Zones nouvelles ou changées depuis la vignette précédente.
    assert.deepEqual(cumul.series.map((s) => s.changed), [[], ['FR-BRE', 'FR-PDL'], ['FR-BRE', 'BE-VLI']]);
    assert.equal(cumul.meta.unknown, 1);    // le Lab hors carte
    assert.deepEqual(cumul.zones.countries, ['BE', 'FR']);

    const flow = runZoneQuery(spec({ groupBy: 'zone_region', periods: each }), table, { today: TODAY });
    assert.deepEqual(flow.series.map((s) => s.values[flow.keys.indexOf('FR-BRE')]), [2, 1, 1]);
});

test('calcul : pays sans niveau 2 montrés à leur niveau 1', () => {
    const s = spec({ groupBy: 'zone_subregion', periods: [{ kind: 'all' }] });
    const plain = runZoneQuery(s, table, { today: TODAY });
    assert.deepEqual(plain.keys.sort(), ['FR-29', 'FR-44', 'FR-56']);
    const mixed = runZoneQuery(s, table, { today: TODAY, fallbackCountries: new Set(['BE']) });
    assert.deepEqual(mixed.keys.sort(), ['BE-VLI', 'FR-29', 'FR-44', 'FR-56']);
    assert.equal(mixed.meta.unknown, 1);
});

test('calcul : moments clés, densité, première trouvaille, filtres', () => {
    const moments = runZoneQuery(spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' },
        periods: [{ kind: 'moments', rule: 'year_end' }] }), table, { today: TODAY });
    assert.deepEqual(moments.periods.map((p) => p.as.moment.kind), ['year_end', 'year_end', 'last']);
    assert.equal(labels.periodLabel(moments.periods[0]), '2023');
    assert.equal(labels.periodLabel(moments.periods[2]), '2025');   // dernier jour = fin 2025 fusionnée

    const dense = runZoneQuery(spec({ groupBy: 'zone_region', compare: { normalize: 'per_km2' } }), table,
        { today: TODAY, areas: new Map([['FR-BRE', 1000]]) });
    assert.equal(dense.series[0].values[dense.keys.indexOf('FR-BRE')], 4 / 1000);
    assert.ok(!dense.keys.includes('FR-PDL'));   // surface inconnue : pas de valeur

    const first = runZoneQuery(spec({ groupBy: 'zone_subregion', measure: { op: 'first_day' } }), table, { today: TODAY });
    assert.equal(first.series[0].values[first.keys.indexOf('FR-29')], day('2023-02-01'));
    assert.equal(first.zones.scale.mode, 'year');

    const mysteries = runZoneQuery(spec({ groupBy: 'zone_region', filters: { cache_type: ['Mystery'] } }), table, { today: TODAY });
    assert.deepEqual(mysteries.keys.sort(), ['BE-VLI', 'FR-BRE']);
    assert.equal(mysteries.meta.rows, 2);
});

test('échelle commune et classes', () => {
    const result = runZoneQuery(spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' },
        periods: [{ kind: 'each', unit: 'year' }], view: { map: { classes: 3, scale: 'linear' } } }), table, { today: TODAY });
    assert.equal(result.zones.scale.mode, 'linear');
    assert.deepEqual(result.zones.scale.breaks, [2, 3]);
    assert.equal(zoneClassOf(result.zones.scale, 1), 0);
    assert.equal(zoneClassOf(result.zones.scale, 4), 2);
    const s = spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' } });
    assert.deepEqual(zoneLegend(result, s, ctx).map((c) => c.label), ['1', '2', '3–4']);
});

test('options ECharts : vignettes, légende, contours des zones changées', () => {
    const s = spec({ groupBy: 'zone_region', measure: { op: 'cumulative', from: 'all' }, periods: [{ kind: 'each', unit: 'year' }] });
    const result = runZoneQuery(s, table, { today: TODAY });
    const loading = buildChartOption(result, s, ctx);
    assert.equal(loading.series.length, 0);
    assert.match(loading.title.text, /Chargement/);
    assert.match(buildChartOption(result, s, { ...ctx, zoneMap: { error: true } }).title.text, /indisponibles/);

    const option = buildChartOption(result, s, { ...ctx, zoneMap, width: 900 });
    assert.equal(option.geo.length, 3);
    assert.equal(option.series.length, 3);
    assert.ok(option.series.every((x, i) => x.type === 'map' && x.geoIndex === i));
    assert.deepEqual(option.geo[0].boundingCoords, zoneMap.bounds);
    assert.deepEqual(option.geo[2].regions.map((r) => r.name), ['FR-BRE', 'BE-VLI']);
    assert.equal(option.visualMap.type, 'piecewise');
    assert.equal(option.visualMap.pieces.length, result.zones.scale.classes);
    assert.deepEqual(option.series[0].data, [{ name: 'FR-BRE', value: 2 }]);
    assert.deepEqual(option.title.map((x) => x.text), ['2023', '2024', '2025']);
    assert.equal(option.title[2].subtext, 'zones : 3 · Trouvailles : 6');
    // Infobulle : nom, valeur, écart avec la vignette précédente.
    const html = option.tooltip.formatter({ name: 'FR-BRE', seriesIndex: 2 });
    assert.match(html, /FR-BRE/);
    assert.match(html, /\+1 depuis 2024/);
    // Clic sur une zone → sa clé et sa vignette.
    assert.deepEqual(clickTarget(result, s, { componentType: 'series', name: 'BE-VLI', seriesIndex: 2 }), { seriesIndex: 2, keyIndex: 1 });
    assert.ok(chartHeight(result, s, 900) > 0);
    const thumb = thumbnailOption(option);
    assert.equal(thumb.visualMap.show, false);
    assert.equal(thumb.title, undefined);

    // Une seule vignette : pas de titres, hauteur de la carte du tableau.
    const single = runZoneQuery(spec({ groupBy: 'zone_region' }), table, { today: TODAY });
    const one = buildChartOption(single, spec({ groupBy: 'zone_region' }), { ...ctx, zoneMapOf: () => zoneMap });
    assert.deepEqual(one.title, []);
    assert.equal(chartHeight(single, spec({ groupBy: 'zone_region' }), 900), null);
});

test('libellés : zones, première trouvaille, densité, moments', () => {
    assert.equal(labels.axisLabel('zone_subregion', 'FR-29'), 'Finistère');
    assert.equal(labels.axisLabel('zone_subregion', 'FR-56'), 'FR-56');   // contours pas encore chargés
    assert.match(labels.formatValue(day('2023-02-01'), { op: 'first_day' }), /2023/);
    assert.match(labels.formatValue(0.0123, { op: 'count' }, { normalize: 'per_km2' }), /km²/);
    assert.equal(labels.periodChoiceLabel({ kind: 'moments', rule: 'milestones' }), 'Moments clés : paliers (100ᵉ, 1 000ᵉ…)');
    assert.equal(labels.periodLabel({ as: { kind: 'moment', moment: { kind: 'milestone', value: 1000, day: 0 } } }), '1 000ᵉ trouvaille'.replace(' ', ' '));
    assert.equal(labels.defaultTitle(spec({ groupBy: 'zone_subregion', measure: { op: 'first_day' } })),
        'Première trouvaille sur une carte des départements, comtés…');
});

test('jeu Évolution : carte des caches actives, qui redescend', async () => {
    const { evolutionTables } = await import('../../static/js/chart_sources.mjs');
    // origin 2020-01-01 ; A placée j0 archivée j10, B j5 active, C (autre
    // région) j20 active.
    const { placed } = evolutionTables({
        count: 3, origin: '2020-01-01', code: ['GCA', 'GCB', 'GCC'],
        placed: [0, 5, 20], archived: [10, -1, -1], status: [1, 0, 0],
        type: [0, 0, 0], types: ['Traditional Cache'], size: [], sizes: [], difficulty: [], difficulties: [],
        terrain: [], terrains: [], country: [], countries: [], region: [], regions: [], county: [], counties: [],
        zone_country: [0, 0, 0], zone_countries: ['FR'],
        zone_region: [0, 0, 1], zone_regions: ['FR-BRE', 'FR-PDL'],
        zone_subregion: [0, 0, 1], zone_subregions: ['FR-29', 'FR-44'],
    });
    const s = spec({ source: 'evolution:1', measure: { op: 'active' }, groupBy: 'zone_region',
        periods: [{ kind: 'range', from: '2020-01-01', to: '2020-01-08' }, { kind: 'range', from: '2020-01-01', to: '2020-01-31' }] });
    assert.equal(s.view.chart, 'map');
    const result = runZoneQuery(s, placed, { today: TODAY });
    const at = (i, id) => result.series[i].values[result.keys.indexOf(id)];
    assert.equal(at(0, 'FR-BRE'), 2);
    assert.equal(at(1, 'FR-BRE'), 1);     // A archivée le 11 janvier
    assert.equal(at(1, 'FR-PDL'), 1);
});
