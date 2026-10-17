import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    STATS_DEFAULTS,
    STATS_MAX_PANELS,
    UNKNOWN_KEY,
    OTHERS_KEY,
    barModel,
    countFeatures,
    createStatsAccumulator,
    createStatsPanel,
    dtIndex,
    featuresUpTo,
    gridModel,
    gridSpec,
    hasActiveHighlights,
    highlightLevel,
    layoutPanels,
    metricsForPanels,
    normalizeStatsSettings,
    parseYmd,
    rectsOverlap,
    statsKeyOf,
} from './static/js/stats_model.mjs';

const cache = (properties) => ({ type: 'Feature', properties });
const geocache = (difficulty, terrain, extra = {}) => cache({
    source_kind: 'geocache',
    cache_type: 'Traditional Cache',
    container: 'Small',
    date_find: '2021-03-14',
    published_date: '2010-06-01',
    difficulty,
    terrain,
    ...extra,
});
const lab = (extra = {}) => cache({
    source_kind: 'lab',
    cache_type: 'Adventure Lab',
    container: null,
    difficulty: null,
    terrain: null,
    date_find: '2022-07-01',
    published_date: null,
    ...extra,
});

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

test('vecteurs partagés avec le serveur (stats_settings.py)', () => {
    const cases = JSON.parse(readFileSync(
        new URL('./tests/fixtures/stats/settings_cases.json', import.meta.url), 'utf8'));
    assert.ok(cases.length > 10);
    for (const { name, input, expected } of cases) {
        assert.deepEqual(normalizeStatsSettings(input), expected, name);
    }
});

test('identifiants manquants, invalides ou en double régénérés', () => {
    let n = 0;
    const newId = () => `00000${n++}`.padStart(8, '0');
    const { panels } = normalizeStatsSettings({ panels: [
        { kind: 'grid', metric: 'dt' },
        { id: 'PAS-HEX!', kind: 'grid', metric: 'dt' },
        { id: 'abcdef12', kind: 'bar', metric: 'year' },
        { id: 'abcdef12', kind: 'bar', metric: 'terrain' },
    ] }, STATS_DEFAULTS, newId);
    const ids = panels.map((p) => p.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(ids[2], 'abcdef12');
    for (const id of ids) assert.match(id, /^[0-9a-f]{6,32}$/);
});

test('patch de premier niveau : une clé absente garde la valeur courante', () => {
    const current = normalizeStatsSettings({ panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
    const patched = normalizeStatsSettings({ enabled: false }, current);
    assert.equal(patched.enabled, false);
    assert.deepEqual(patched.panels.map((p) => p.id), ['aaaaaa01']);
});

test('createStatsPanel : défauts de la métrique, surcharges, id neuf', () => {
    const panel = createStatsPanel('bar', 'cache_type', { position: { anchor: 'top-right' } });
    assert.equal(panel.options.sort, 'count');
    assert.equal(panel.style.palette, 'gc');
    assert.equal(panel.position.anchor, 'top-right');
    assert.equal(panel.position.width, 280);
    assert.match(panel.id, /^[0-9a-f]{12}$/);
    assert.equal(createStatsPanel('grid', 'year'), null);
});

test('metricsForPanels : seulement les panneaux actifs, rien si coupé', () => {
    const settings = normalizeStatsSettings({ panels: [
        { id: 'aaaaaa01', kind: 'grid', metric: 'dt' },
        { id: 'aaaaaa02', kind: 'bar', metric: 'year', enabled: false },
        { id: 'aaaaaa03', kind: 'bar', metric: 'cache_type' },
    ] });
    assert.deepEqual([...metricsForPanels(settings)].sort(), ['cache_type', 'dt']);
    assert.equal(metricsForPanels({ ...settings, enabled: false }).size, 0);
    assert.ok(STATS_MAX_PANELS >= 3);
});

// ---------------------------------------------------------------------------
// Bucketisation
// ---------------------------------------------------------------------------

test('dtIndex : demi-points 1 → 5 sur 0 → 8, bornés, -1 sinon', () => {
    assert.equal(dtIndex(1), 0);
    assert.equal(dtIndex(1.5), 1);
    assert.equal(dtIndex(5), 8);
    assert.equal(dtIndex(4.75), 8);
    assert.equal(dtIndex(7), 8);
    assert.equal(dtIndex(0), 0);
    assert.equal(dtIndex('2.5'), 3);
    assert.equal(dtIndex(null), -1);
    assert.equal(dtIndex(undefined), -1);
    assert.equal(dtIndex(''), -1);
    assert.equal(dtIndex(Number.NaN), -1);
});

test('parseYmd : découpe sans Date, rejette les dates impossibles', () => {
    assert.deepEqual(parseYmd('2021-03-14'), { y: 2021, m: 3, d: 14 });
    assert.deepEqual(parseYmd('2021-03-14T10:00:00'), { y: 2021, m: 3, d: 14 });
    assert.equal(parseYmd('2021-13-01'), null);
    assert.equal(parseYmd('2021-3-1'), null);
    assert.equal(parseYmd(null), null);
});

test('clés par métrique : Jasmer depuis mai 2000, calendrier mois×jour, tailles inconnues', () => {
    const p = geocache(2, 3.5).properties;
    assert.equal(statsKeyOf('dt', p), 2 * 9 + 5);
    assert.equal(statsKeyOf('jasmer', p), 201006);
    assert.equal(statsKeyOf('jasmer', { published_date: '2000-04-30' }), null);
    assert.equal(statsKeyOf('jasmer', { published_date: '2000-05-03' }), 200005);
    assert.equal(statsKeyOf('calendar', { date_find: '2020-02-29' }), 229);
    assert.equal(statsKeyOf('container', { container: null }), UNKNOWN_KEY);
    assert.equal(statsKeyOf('container', { container: 'Unknown' }), UNKNOWN_KEY);
    assert.equal(statsKeyOf('cache_type', lab().properties), 'Adventure Lab');
    assert.equal(statsKeyOf('year', p), 2021);
    assert.equal(statsKeyOf('difficulty', lab().properties), null);
});

// ---------------------------------------------------------------------------
// Accumulateur
// ---------------------------------------------------------------------------

test('accumulateur : Lab compté en type, exclu de D/T', () => {
    const acc = createStatsAccumulator(['dt', 'cache_type', 'container', 'jasmer']);
    acc.add([geocache(1, 1), geocache(1, 1), geocache(5, 5), lab()]);

    assert.equal(acc.total, 4);
    assert.equal(acc.count('dt', 0), 2);
    assert.equal(acc.count('dt', 80), 1);
    assert.equal(acc.excluded.get('dt'), 1);
    assert.equal(acc.count('cache_type', 'Adventure Lab'), 1);
    assert.equal(acc.count('cache_type', 'Traditional Cache'), 3);
    assert.equal(acc.count('container', UNKNOWN_KEY), 1);
    assert.equal(acc.excluded.get('jasmer'), 1);
    // Somme de la matrice + exclues = total : ce que vérifie le test E2E
    // contre le compteur de caches affiché.
    const dtSum = [...acc.counts.get('dt').values()].reduce((s, n) => s + n, 0);
    assert.equal(dtSum + acc.excluded.get('dt'), acc.total);
});

test('accumulateur : métriques non demandées non calculées, reset', () => {
    const acc = createStatsAccumulator(['year']);
    acc.add([geocache(1, 1)]);
    assert.equal(acc.counts.has('dt'), false);
    const revision = acc.revision;
    acc.reset();
    assert.equal(acc.total, 0);
    assert.equal(acc.count('year', 2021), 0);
    assert.ok(acc.revision > revision);
});

test('accumulateur : features OpenLayers (getProperties) acceptées', () => {
    const olFeature = { getProperties: () => geocache(2, 2).properties };
    const acc = createStatsAccumulator(['dt']).add([olFeature]);
    assert.equal(acc.count('dt', 2 * 9 + 2), 1);
});

test('surlignage : déblocage seulement au passage de 0 à 1', () => {
    const acc = createStatsAccumulator(['dt']);
    acc.add([geocache(1, 1)]);            // état initial, sans horloge
    acc.add([geocache(1, 1)], 1000);      // incrément d'une case déjà remplie
    acc.add([geocache(2, 2)], 2000);      // déblocage

    const known = acc.lastHit.get('dt').get(0);
    const unlocked = acc.lastHit.get('dt').get(2 * 9 + 2);
    assert.equal(known.at, 1000);
    assert.equal(known.newAt, null);
    assert.equal(unlocked.newAt, 2000);

    assert.equal(highlightLevel(known, 1100, 600, 'new'), 0);
    assert.ok(highlightLevel(known, 1100, 600, 'every') > 0.8);
    assert.equal(highlightLevel(unlocked, 2300, 600, 'new'), 0.5);
    assert.equal(highlightLevel(unlocked, 2600, 600, 'new'), 0);
    assert.equal(highlightLevel(unlocked, 2100, 600, 'none'), 0);

    const panels = [{ metric: 'dt', options: { highlight: 'new' } }];
    assert.equal(hasActiveHighlights(acc, panels, 2100, 600), true);
    assert.equal(hasActiveHighlights(acc, panels, 2700, 600), false);
});

test('featuresUpTo : coupe à la date incluse, clés toDateString', () => {
    const index = new Map([
        [new Date(2021, 0, 1).toDateString(), [geocache(1, 1)]],
        [new Date(2021, 0, 2).toDateString(), [geocache(2, 2), geocache(3, 3)]],
        [new Date(2021, 0, 3).toDateString(), [geocache(4, 4)]],
    ]);
    assert.equal(featuresUpTo(index).length, 4);
    assert.equal(featuresUpTo(index, new Date(2021, 0, 2)).length, 3);
    assert.equal(featuresUpTo(index, new Date(2020, 11, 31)).length, 0);
});

// ---------------------------------------------------------------------------
// Grilles
// ---------------------------------------------------------------------------

test('grille D/T : 81 cases, échelle de la référence, couverture', () => {
    const reference = countFeatures([geocache(1, 1), geocache(1, 1), geocache(1, 1), geocache(3, 4)], ['dt']);
    const current = countFeatures([geocache(1, 1), lab()], ['dt']);
    const model = gridModel('dt', current, reference);

    assert.equal(model.cells.length, 81);
    assert.equal(model.available, 81);
    assert.equal(model.filled, 1);
    assert.equal(model.max, 3);
    assert.equal(model.excluded, 1);
    assert.equal(model.cells[0].count, 1);
});

test('grille Jasmer : mai 2000 → mois de fin, cases hors plage désactivées', () => {
    const spec = gridSpec('jasmer', { end: { y: 2002, m: 3 } });
    assert.deepEqual(spec.rowKeys, [2000, 2001, 2002]);
    assert.equal(spec.disabled(0, 3), true);    // avril 2000
    assert.equal(spec.disabled(0, 4), false);   // mai 2000
    assert.equal(spec.disabled(2, 2), false);   // mars 2002
    assert.equal(spec.disabled(2, 3), true);    // avril 2002
    assert.equal(spec.keyAt(1, 0), 200101);

    const acc = countFeatures([geocache(1, 1, { published_date: '2001-01-15' })], ['jasmer']);
    const model = gridModel('jasmer', acc, acc, { end: { y: 2002, m: 3 } });
    // 8 mois en 2000, 12 en 2001, 3 en 2002.
    assert.equal(model.available, 23);
    assert.equal(model.filled, 1);
});

test('grille calendrier : 366 cases, 29 février valide, 31 avril impossible', () => {
    const acc = countFeatures([], ['calendar']);
    const model = gridModel('calendar', acc, acc);
    assert.equal(model.available, 366);
    const spec = gridSpec('calendar');
    assert.equal(spec.disabled(1, 28), false);  // 29 février
    assert.equal(spec.disabled(1, 29), true);   // 30 février
    assert.equal(spec.disabled(3, 30), true);   // 31 avril
    assert.equal(spec.keyAt(11, 24), 1225);
});

// ---------------------------------------------------------------------------
// Histogrammes
// ---------------------------------------------------------------------------

const types = (spec) => Object.entries(spec).flatMap(([type, n]) =>
    Array.from({ length: n }, () => geocache(1, 1, { cache_type: type })));

test('barres : ordre figé sur la référence même si l\'état courant s\'inverse', () => {
    const reference = countFeatures(types({ Traditional: 10, Multi: 5, Mystery: 2 }), ['cache_type']);
    // À mi-parcours, Mystery devance Multi.
    const current = countFeatures(types({ Traditional: 3, Multi: 1, Mystery: 2 }), ['cache_type']);
    const model = barModel('cache_type', current, reference, { sort: 'count', max_items: 8 });

    assert.deepEqual(model.rows.map((r) => r.key), ['Traditional', 'Multi', 'Mystery']);
    assert.equal(model.max, 10);
    assert.deepEqual(model.rows.map((r) => r.count), [3, 1, 2]);
});

test('barres : top-N + « Autres » choisis sur la référence', () => {
    const reference = countFeatures(types({ A: 9, B: 8, C: 7, D: 1, E: 1 }), ['cache_type']);
    const current = countFeatures(types({ A: 1, D: 1, E: 1 }), ['cache_type']);
    const model = barModel('cache_type', current, reference, { sort: 'count', max_items: 3 });

    assert.deepEqual(model.rows.map((r) => r.key), ['A', 'B', OTHERS_KEY]);
    const others = model.rows[2];
    assert.deepEqual(others.keys.sort(), ['C', 'D', 'E']);
    assert.equal(others.refCount, 9);
    assert.equal(others.count, 2);
});

test('barres : ordre naturel des tailles, D/T fixes, années contiguës', () => {
    const features = [
        geocache(1, 1, { container: 'Large' }),
        geocache(1, 1, { container: 'Micro' }),
        geocache(1, 1, { container: 'Regular' }),
        lab(),
    ];
    const acc = countFeatures(features, ['container', 'difficulty', 'year']);

    assert.deepEqual(barModel('container', acc, acc, { sort: 'natural' }).rows.map((r) => r.key),
        ['Micro', 'Regular', 'Large', UNKNOWN_KEY]);
    const difficulty = barModel('difficulty', acc, acc, { sort: 'natural' });
    assert.equal(difficulty.rows.length, 9);
    assert.equal(difficulty.excluded, 1);
    assert.equal(barModel('difficulty', acc, acc, { hide_empty: true }).rows.length, 1);

    const years = countFeatures([
        geocache(1, 1, { date_find: '2018-01-01' }),
        geocache(1, 1, { date_find: '2021-01-01' }),
    ], ['year']);
    assert.deepEqual(barModel('year', years, years, {}).rows.map((r) => r.key),
        [2018, 2019, 2020, 2021]);
});

test('barres : les grandeurs ordonnées ne passent jamais par « Autres »', () => {
    const acc = countFeatures(Array.from({ length: 12 }, (_, i) =>
        geocache(1, 1, { date_find: `${2010 + i}-05-05` })), ['year']);
    const model = barModel('year', acc, acc, { max_items: 3 });
    assert.equal(model.rows.length, 12);
});

// ---------------------------------------------------------------------------
// Mise en page
// ---------------------------------------------------------------------------

const box = { width: 1000, height: 600 };
const item = (id, anchor, extra = {}) => ({ id, anchor, dx: 16, dy: 16, width: 200, height: 100, ...extra });

test('ancres seules : coins, centres, CSS relatif à l\'ancre', () => {
    const layout = layoutPanels([
        item('tl', 'top-left'),
        item('br', 'bottom-right'),
        item('mc', 'middle-center'),
        item('tc', 'top-center'),
    ], box);

    assert.deepEqual(layout.get('tl').css, { left: 16, top: 16 });
    assert.deepEqual(layout.get('br').css, { right: 16, bottom: 16 });
    assert.equal(layout.get('br').x, 1000 - 16 - 200);
    assert.equal(layout.get('mc').x, 400);
    assert.equal(layout.get('mc').y, 250);
    assert.equal(layout.get('tc').x, 400);
    for (const rect of layout.values()) assert.equal(rect.overflow, false);
});

test('empilement : du coin vers l\'intérieur, dy = espacement', () => {
    const top = layoutPanels([
        item('a', 'top-left'),
        item('b', 'top-left', { dy: 8, height: 50 }),
        item('c', 'top-left', { dy: 8 }),
    ], box);
    assert.equal(top.get('a').y, 16);
    assert.equal(top.get('b').y, 16 + 100 + 8);
    assert.equal(top.get('c').y, 16 + 100 + 8 + 50 + 8);
    assert.equal(rectsOverlap(top.get('a'), top.get('b')), false);

    const bottom = layoutPanels([item('a', 'bottom-right'), item('b', 'bottom-right', { dy: 10 })], box);
    assert.equal(bottom.get('a').y, 600 - 16 - 100);
    assert.equal(bottom.get('b').y, 600 - 16 - 100 - 10 - 100);
    assert.deepEqual(bottom.get('b').css, { right: 16, bottom: 600 - bottom.get('b').y - 100 });

    const middle = layoutPanels([item('a', 'middle-left'), item('b', 'middle-left', { dy: 20 })], box);
    // Pile de 220 px centrée : 190 → 410.
    assert.equal(middle.get('a').y, 190);
    assert.equal(middle.get('b').y, 310);
});

test('débordement : rect ramené dans le cadre et signalé', () => {
    const layout = layoutPanels([
        item('a', 'top-left', { height: 400 }),
        item('b', 'top-left', { height: 400 }),
        item('wide', 'bottom-left', { width: 1500 }),
    ], box);
    const b = layout.get('b');
    assert.equal(b.overflow, true);
    assert.ok(b.y + b.height <= 600);
    assert.equal(layout.get('wide').width, 1000);
    assert.equal(layout.get('wide').overflow, true);
    assert.equal(layout.get('a').overflow, true);  // même pile
});
