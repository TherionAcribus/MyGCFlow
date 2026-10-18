import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    EVOLUTION_METRICS_BY_KIND,
    STATS_DEFAULTS,
    STATS_MAX_PANELS,
    accumulatorMetricsFor,
    counterValues,
    createEvolutionStatsAccumulator,
    createTweenStore,
    dayNumber,
    dayNumberOfDate,
    evolutionActivePeaks,
    evolutionCounterValues,
    evolutionLineModel,
    evolutionStateAt,
    evolutionStatusAcc,
    lineModel,
    ymdOfDay,
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
import { buildTimeline } from './static/js/evolution_timeline.mjs';
import { EVO_NEVER_DAY } from './static/js/evolution_style.mjs';

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

test('dtIndex : demi-points 1 → 5 sur 0 → 8, -1 sinon', () => {
    assert.equal(dtIndex(1), 0);
    assert.equal(dtIndex(1.5), 1);
    assert.equal(dtIndex(5), 8);
    assert.equal(dtIndex(3), 4);
    // Hors bornes ou pas un demi-point : donnée invalide, exclue, pas rabattue.
    assert.equal(dtIndex(4.75), -1);
    assert.equal(dtIndex(7), -1);
    assert.equal(dtIndex(0), -1);
    assert.equal(dtIndex(0.5), -1);
    assert.equal(dtIndex(5.5), -1);
    assert.equal(dtIndex(1.2), -1);
    assert.equal(dtIndex('2.5'), 3);
    assert.equal(dtIndex('7'), -1);
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
    // Calendrier réel : « 31 février » rejeté au lieu d'être rabattu sur mars.
    assert.equal(parseYmd('2021-02-31'), null);
    assert.equal(parseYmd('2021-04-31'), null);
    assert.equal(parseYmd('2021-02-29'), null);
    assert.deepEqual(parseYmd('2020-02-29'), { y: 2020, m: 2, d: 29 });
    assert.equal(parseYmd('1900-02-29'), null);
    assert.deepEqual(parseYmd('2000-02-29'), { y: 2000, m: 2, d: 29 });
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

test('clés month/weekday : mois 1-12, semaine ISO lundi = 0', () => {
    assert.equal(statsKeyOf('month', { date_find: '2021-03-14' }), 3);
    assert.equal(statsKeyOf('month', { date_find: '2021-02-31' }), null);
    // 2021-03-14 était un dimanche → 6 ; le lendemain lundi → 0.
    assert.equal(statsKeyOf('weekday', { date_find: '2021-03-14' }), 6);
    assert.equal(statsKeyOf('weekday', { date_find: '2021-03-15' }), 0);
    // 1970-01-01, le jour 0, était un jeudi → 3 (y compris avant, via modulo).
    assert.equal(statsKeyOf('weekday', { date_find: '1970-01-01' }), 3);
    assert.equal(statsKeyOf('weekday', { date_find: '1969-12-29' }), 0);
    assert.equal(statsKeyOf('weekday', { date_find: 'pfff' }), null);
});

test('clés attribute/owner : liste multi-valuée, inc négatif ignoré', () => {
    const props = {
        owner: '  René  ',
        attributes: [
            { name: 'Scenic view', inc: 1 },
            { name: 'Available during winter', inc: 0 },   // forme « négative »
            { name: 'Dogs allowed', inc: '0' },            // idem en chaîne
            { name: '  ' },                                 // nom vide : ignoré
            { name: 'Picnic tables nearby' },              // inc absent = positif
        ],
    };
    assert.deepEqual(statsKeyOf('attribute', props), ['Scenic view', 'Picnic tables nearby']);
    assert.deepEqual(statsKeyOf('attribute', { attributes: 'pas une liste' }), []);
    assert.deepEqual(statsKeyOf('attribute', {}), []);
    assert.equal(statsKeyOf('owner', props), 'René');
    assert.equal(statsKeyOf('owner', {}), UNKNOWN_KEY);
    assert.equal(statsKeyOf('owner', { owner: ' ' }), UNKNOWN_KEY);
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

test('accumulateur : D/T hors plage et dates impossibles comptés en exclus', () => {
    const acc = createStatsAccumulator(['dt', 'calendar', 'day']);
    acc.add([
        geocache(7, 3),                                // difficulté > 5
        geocache(1.2, 3),                              // pas un demi-point
        geocache(2, 3, { date_find: '2021-02-31' }),   // jour inexistant
        geocache(2, 3),                                // valide
    ]);

    assert.equal(acc.total, 4);
    assert.equal(acc.excluded.get('dt'), 2);
    assert.equal(acc.count('dt', 2 * 9 + 4), 2);       // les deux caches valides en D/T (D2/T3)
    assert.equal(acc.excluded.get('calendar'), 1);
    assert.equal(acc.excluded.get('day'), 1);
    assert.equal(acc.count('calendar', 314), 3);       // les trois caches au 14/03
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

test('accumulateur : attributs multi-valués, exclue si aucun', () => {
    const acc = createStatsAccumulator(['attribute', 'owner', 'weekday']);
    acc.add([
        geocache(1, 1, { attributes: [{ name: 'Scenic view' }, { name: 'Bikes allowed' }], owner: 'A' }),
        geocache(2, 2, { attributes: [{ name: 'Scenic view' }], owner: 'A' }),
        geocache(3, 3, { attributes: [{ name: 'Dogs allowed', inc: 0 }] }),   // négatif seul → exclue
        geocache(4, 4, { owner: 'B' }),                                       // pas d'attributs → exclue
    ]);

    assert.equal(acc.count('attribute', 'Scenic view'), 2);
    assert.equal(acc.count('attribute', 'Bikes allowed'), 1);
    assert.equal(acc.count('attribute', 'Dogs allowed'), 0);   // inc 0 : pas comptée
    assert.equal(acc.excluded.get('attribute'), 2);
    assert.equal(acc.count('owner', 'A'), 2);
    assert.equal(acc.count('owner', UNKNOWN_KEY), 1);          // la cache sans owner
    // Somme des comptes ≠ total pour une métrique multi-valuée : une cache
    // compte une fois par attribut porté, zéro si elle n'en a pas.
    assert.equal(acc.count('weekday', 6), 4);                  // les 4 au dimanche
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

test('surlignage O(1) : latestHit, le dernier at décide pour toutes les clés', () => {
    const acc = createStatsAccumulator(['dt']);
    // Trois lots à horloges croissantes, trois cases D/T distinctes.
    acc.add([geocache(1, 1)], 1000);
    acc.add([geocache(2, 2)], 2000);
    acc.add([geocache(3, 3)], 3000);
    const latest = acc.latestHit.get('dt');
    assert.equal(latest.at, 3000);
    assert.equal(latest.newAt, 3000);

    const panels = [{ metric: 'dt', options: { highlight: 'every' } }];
    // Le dernier at (3000) est dans la fenêtre (2900, 3500] → surbrillance.
    assert.equal(hasActiveHighlights(acc, panels, 3500, 600), true);
    // Il l'a dépassée (3000 ∉ (3000, 3600]) → plus rien, comme le scan des
    // clés : at monotone ≤ now, le plus récent est le dernier à s'éteindre.
    assert.equal(hasActiveHighlights(acc, panels, 3600, 600), false);
    // Horloge non finie → jamais de surbrillance.
    assert.equal(hasActiveHighlights(acc, panels, NaN, 600), false);
    assert.equal(hasActiveHighlights(acc, panels, Infinity, 600), false);
});

test("surlignage O(1) : mode 'new' lit le dernier déblocage, pas le dernier incrément", () => {
    const acc = createStatsAccumulator(['dt']);
    acc.add([geocache(1, 1)], 1000);              // déblocage de la case
    acc.add([geocache(1, 1)], 3000);              // re-incrément de la même case
    assert.equal(acc.latestHit.get('dt').at, 3000);
    assert.equal(acc.latestHit.get('dt').newAt, 1000);

    const every = [{ metric: 'dt', options: { highlight: 'every' } }];
    const news = [{ metric: 'dt', options: { highlight: 'new' } }];
    // at=3000 ∈ (2500, 3100] mais newAt=1000 hors fenêtre.
    assert.equal(hasActiveHighlights(acc, every, 3100, 600), true);
    assert.equal(hasActiveHighlights(acc, news, 3100, 600), false);
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

test('barres : axes fixes mois (12) et jours de semaine (7, lundi en tête)', () => {
    const acc = countFeatures([
        geocache(1, 1, { date_find: '2021-01-05' }),       // mardi
        geocache(1, 1, { date_find: '2021-03-14' }),       // dimanche
        geocache(1, 1, { date_find: '2021-03-14' }),
    ], ['month', 'weekday']);
    const month = barModel('month', acc, acc, { sort: 'natural' });
    assert.equal(month.rows.length, 12);                 // axe fixe, trous visibles
    assert.equal(month.rows[0].key, 1);
    assert.equal(month.rows[0].count, 1);                // janvier
    assert.equal(month.rows[2].count, 2);                // mars
    const weekday = barModel('weekday', acc, acc, {});
    assert.equal(weekday.rows.length, 7);
    assert.equal(weekday.rows[0].key, 0);                // lundi en tête
    assert.equal(weekday.rows[1].count, 1);              // mardi
    assert.equal(weekday.rows[6].count, 2);              // dimanche
    // Attributs et propriétaires : catégories → top-N + « Autres ».
    const lots = countFeatures(Array.from({ length: 15 }, (_, i) =>
        geocache(1, 1, { owner: `CO${i}` })), ['owner']);
    const model = barModel('owner', lots, lots, { max_items: 4 });
    assert.equal(model.rows.at(-1).key, OTHERS_KEY);
    assert.equal(model.rows.at(-1).count, 12);
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

// ---------------------------------------------------------------------------
// Lot 3 : anneaux, courbe, compteurs, course de barres, position libre
// ---------------------------------------------------------------------------

const onDay = (date, extra = {}) => geocache(1, 1, { date_find: date, ...extra });

test('jours : numéro entier consécutif, aller-retour, date locale', () => {
    const a = dayNumber({ y: 2024, m: 2, d: 28 });
    assert.equal(dayNumber({ y: 2024, m: 2, d: 29 }), a + 1);
    assert.equal(dayNumber({ y: 2024, m: 3, d: 1 }), a + 2);
    assert.deepEqual(ymdOfDay(a + 2), { y: 2024, m: 3, d: 1 });
    // Changement d'heure : la date locale à minuit donne toujours le jour civil.
    assert.equal(dayNumberOfDate(new Date(2026, 2, 29)), dayNumber({ y: 2026, m: 3, d: 29 }));
    assert.equal(statsKeyOf('day', { date_find: '2024-02-29' }), a + 1);
    assert.equal(statsKeyOf('country', { country: ' France ' }), 'France');
    assert.equal(statsKeyOf('state', { state: null }), UNKNOWN_KEY);
});

test('dépendances : courbe et compteurs comptent ce dont ils ont besoin', () => {
    assert.deepEqual(accumulatorMetricsFor({ kind: 'line', metric: 'cumulative' }), ['day']);
    assert.deepEqual(
        accumulatorMetricsFor({ kind: 'counter', metric: 'summary', options: { items: ['streak', 'days', 'countries'] } }),
        ['day', 'country'],
    );
    assert.deepEqual(accumulatorMetricsFor({ kind: 'donut', metric: 'state' }), ['state']);
    const settings = normalizeStatsSettings({ panels: [
        { id: 'aaaaaa01', kind: 'line', metric: 'cumulative' },
        { id: 'aaaaaa02', kind: 'counter', metric: 'summary', options: { items: ['types', 'states'] } },
    ] });
    assert.deepEqual([...metricsForPanels(settings)].sort(), ['cache_type', 'day', 'state']);
});

test('compteurs : jours, record (le plus ancien à égalité), plus longue série, distincts connus', () => {
    const acc = countFeatures([
        onDay('2024-01-01', { country: 'France', state: 'Bretagne' }),
        onDay('2024-01-02', { country: 'France', state: 'Normandie' }),
        onDay('2024-01-02', { country: 'Belgique', cache_type: 'Multi-cache' }),
        onDay('2024-01-03'),
        onDay('2024-01-05'),
        onDay('2024-01-05'),
        onDay('2024-01-06', { country: null }),
        onDay('2024-01-07', { attributes: [{ name: 'Scenic view' }, { name: 'Bikes allowed' }], owner: 'A' }),
        onDay('2024-01-08', { attributes: [{ name: 'Scenic view' }], owner: 'B' }),
    ], ['day', 'cache_type', 'country', 'state', 'attribute', 'owner']);
    const v = counterValues(acc,
        ['days', 'best_day', 'streak', 'types', 'countries', 'states', 'attributes', 'owners']);
    assert.equal(v.days.value, 7);
    assert.equal(v.best_day.value, 2);
    assert.equal(v.best_day.day, dayNumber({ y: 2024, m: 1, d: 2 }));
    assert.equal(v.streak.value, 4);
    assert.equal(v.streak.start, dayNumber({ y: 2024, m: 1, d: 5 }));
    assert.equal(v.types.value, 2);
    assert.equal(v.countries.value, 2);     // « inconnu » ne compte pas
    assert.equal(v.states.value, 2);
    // Attributs distincts : une cache peut en porter plusieurs.
    assert.equal(v.attributes.value, 2);
    assert.equal(v.owners.value, 2);
});

test('courbe : cumul par jour, axe calé sur la référence, tête prolongée à plat', () => {
    const reference = countFeatures([
        onDay('2024-01-01'), onDay('2024-01-03'), onDay('2024-01-03'), onDay('2024-01-10'),
    ], ['day']);
    const current = countFeatures([onDay('2024-01-01'), onDay('2024-01-03'), onDay('2024-01-03')], ['day']);
    const head = dayNumber({ y: 2024, m: 1, d: 6 });
    const model = lineModel(current, reference, { headDay: head });
    assert.equal(model.max, 4);
    assert.equal(model.first, dayNumber({ y: 2024, m: 1, d: 1 }));
    assert.equal(model.last, dayNumber({ y: 2024, m: 1, d: 10 }));
    assert.deepEqual(model.points.map((p) => p.total), [1, 3]);
    assert.equal(model.total, 3);
    assert.equal(model.headDay, head);
    // Fin d'animation après la dernière trouvaille : l'axe s'étend.
    const later = dayNumber({ y: 2024, m: 2, d: 1 });
    assert.equal(lineModel(current, reference, { endDay: later }).last, later);
    assert.equal(lineModel(countFeatures([], ['day']), countFeatures([], ['day'])).empty, true);
});

test('course de barres : ordre et top-N suivent l’état courant, échelle du meneur', () => {
    const reference = countFeatures(types({ A: 10, B: 8, C: 1 }), ['cache_type']);
    const current = countFeatures(types({ A: 1, B: 3, C: 1 }), ['cache_type']);
    const model = barModel('cache_type', current, reference, { sort: 'race', max_items: 2 });
    assert.equal(model.race, true);
    assert.deepEqual(model.rows.map((r) => r.key), ['B', 'A']);
    assert.equal(model.max, 3);
    assert.equal(model.rows.some((r) => r.key === OTHERS_KEY), false);
});

test('valeurs animées : immédiates au départ, glissent ensuite, figées au repos', () => {
    const tween = createTweenStore(600);
    assert.equal(tween.set('a', 10, 1000), 10);          // première passe : immédiat
    tween.settle();
    assert.equal(tween.set('b', 4, 1000), 0);            // nouvelle clé : part de 0
    assert.equal(tween.set('a', 20, 2000), 10);
    const mid = tween.get('a', 2300);
    assert.ok(mid > 15 && mid < 20, `mi-parcours ${mid}`);
    assert.equal(tween.get('a', 2600), 20);
    assert.equal(tween.isActive(2300), true);
    assert.equal(tween.isActive(2600), false);
    // Cible relancée en cours de route : repart de la valeur affichée.
    tween.set('a', 30, 2300);
    assert.equal(tween.get('a', 2300), mid);
    // Sans horloge (repos) : valeur finale.
    assert.equal(tween.set('a', 50, Number.NaN), 50);
    tween.clear();
    assert.equal(tween.get('a', 0), undefined);
});

test('position libre : fraction de l’espace restant, hors des piles', () => {
    const layout = layoutPanels([
        { id: 'f', mode: 'free', x: 0.5, y: 1, width: 200, height: 100 },
        item('a', 'top-left'),
        item('b', 'top-left'),
    ], box);
    assert.deepEqual(layout.get('f').css, { left: 400, top: 500 });
    // Le panneau libre ne pousse pas la pile du coin.
    assert.equal(layout.get('b').y, 16 + 100 + 16);
});

test('évitement : la pile d’un coin démarre sous le titre ou au-dessus d’une boîte basse', () => {
    const title = { x: 10, y: 10, width: 250, height: 50 };
    const top = layoutPanels([item('a', 'top-left'), item('b', 'top-left')], box, [title]);
    assert.equal(top.get('a').y, 10 + 50 + 8);
    assert.equal(top.get('b').y, 10 + 50 + 8 + 100 + 16);
    // Boîte d'un autre côté : rien ne bouge.
    const right = layoutPanels([item('r', 'top-right')], box, [title]);
    assert.equal(right.get('r').y, 16);
    const low = { x: 700, y: 560, width: 290, height: 30 };
    const bottom = layoutPanels([item('c', 'bottom-right')], box, [low]);
    assert.equal(bottom.get('c').y + 100, 560 - 8);
});


// ---------------------------------------------------------------------------
// Mode Évolution : trois univers (actives / poses / archivages)
// ---------------------------------------------------------------------------

const evoFeature = (i) => ({ properties: { cache_type: `T${i}`, country: 'France' } });

// Chronologie jouet : 4 caches — poses aux jours 0, 1, 2 et 20 ; archivages
// aux jours 3 (T0) et 10 (T2). Les jours sont des indices depuis l'origin.
function evolutionIndex() {
    const base = {
        placed: Int32Array.from([0, 1, 2, 20]),
        archived: Int32Array.from([3, EVO_NEVER_DAY, 10, EVO_NEVER_DAY]),
    };
    const rows = [0, 1, 2, 3];
    return {
        timeline: buildTimeline(base, rows),
        features: rows.map(evoFeature),
        originDay: 0,
    };
}

test('évolution : accumulateur à trois univers, add et remove', () => {
    const acc = createEvolutionStatsAccumulator(['cache_type']);
    acc.add([evoFeature(0), evoFeature(1)], null);
    assert.deepEqual(Object.fromEntries(acc.setView('active').counts.get('cache_type')), { T0: 1, T1: 1 });
    assert.deepEqual(Object.fromEntries(acc.setView('placed').counts.get('cache_type')), { T0: 1, T1: 1 });
    assert.equal(acc.setView('archived').total, 0);
    acc.remove([evoFeature(0)], null);
    // Une clé archivée reste à 0 dans l'ensemble actif : la barre glisse vers
    // 0 au fil de l'animation plutôt que de disparaître d'un coup.
    assert.deepEqual(Object.fromEntries(acc.setView('active').counts.get('cache_type')), { T0: 0, T1: 1 });
    assert.deepEqual(Object.fromEntries(acc.setView('archived').counts.get('cache_type')), { T0: 1 });
    assert.equal(acc.setView('active').total, 1);
    // Le cumul des poses ne redescend jamais.
    assert.equal(acc.setView('placed').total, 2);
});

test('évolution : latestHit porte le max des horloges par univers', () => {
    const acc = createEvolutionStatsAccumulator(['cache_type']);
    acc.add([evoFeature(0)], 1000);                        // T0 débloquée
    acc.add([evoFeature(0), evoFeature(1)], 2000);         // T0 ré-incrémentée, T1 débloquée
    // Seul le premier univers cible (actives à la pose) reçoit l'horloge.
    assert.equal(acc.sets.active.latestHit.get('cache_type').at, 2000);
    assert.equal(acc.sets.active.latestHit.get('cache_type').newAt, 2000);  // déblocage de T1
    assert.equal(acc.sets.placed.latestHit.get('cache_type').at, null);
    // L'archivage alimente « archivées », sans toucher à l'actif.
    acc.remove([evoFeature(0)], 3000);
    assert.equal(acc.sets.archived.latestHit.get('cache_type').at, 3000);
    assert.equal(acc.sets.archived.latestHit.get('cache_type').newAt, 3000);
    assert.equal(acc.sets.active.latestHit.get('cache_type').at, 2000);
    // setView propage latestHit : c'est ce que hasActiveEvolutionHighlights lit.
    assert.equal(acc.setView('active').latestHit, acc.sets.active.latestHit);
    assert.equal(acc.setView('archived').latestHit, acc.sets.archived.latestHit);
    // Le même test O(1) que l'accumulateur principal s'applique à la vue.
    const accView = { latestHit: acc.setView('active').latestHit };
    const panels = [{ metric: 'cache_type', options: { highlight: 'every' } }];
    assert.equal(hasActiveHighlights(accView, panels, 2500, 600), true);
    assert.equal(hasActiveHighlights(accView, panels, 2600, 600), false);
});

test('évolution : evolutionStateAt rejoue les événements, pas les jours', () => {
    const index = evolutionIndex();
    // Au jour 10 : poses des jours 0-2 (3 caches), archivages des jours 3 et
    // 10 (2 caches) — le placement du jour 20 n'est pas encore arrivé. Un
    // slice par nombre de jours lirait trop loin dans les ordres.
    const acc = evolutionStateAt(index, ['cache_type'], 10);
    assert.equal(acc.setView('placed').total, 3);
    assert.equal(acc.setView('archived').total, 2);
    assert.equal(acc.setView('active').total, 1);
    assert.deepEqual(Object.fromEntries(acc.setView('active').counts.get('cache_type')),
        { T0: 0, T1: 1, T2: 0 });
    // Le jour 20 : les quatre caches ont été posées.
    const end = evolutionStateAt(index, ['cache_type'], 20);
    assert.equal(end.setView('placed').total, 4);
    assert.equal(end.setView('active').total, 2);
});

test('évolution : référence « pics » et ligne de statut', () => {
    const index = evolutionIndex();
    // Pics de l'ensemble actif : chaque type n'a jamais dépassé 1 en même
    // temps (T3 posée au jour 20 compte aussi).
    const peaks = evolutionActivePeaks(index, ['cache_type'], 20);
    assert.equal(peaks.total, 3);
    assert.deepEqual(Object.fromEntries(peaks.counts.get('cache_type')),
        { T0: 1, T1: 1, T2: 1, T3: 1 });
    // Statut au jour 10 : 1 active, 2 archivées ; la référence fige le pic.
    const status = evolutionStatusAcc(index, 10);
    assert.deepEqual(Object.fromEntries(status.counts.get('status')), { active: 1, archived: 2 });
    const ref = evolutionStatusAcc(index, 20, { reference: true });
    assert.deepEqual(Object.fromEntries(ref.counts.get('status')), { active: 3, archived: 2 });
});

test('évolution : courbe et tuiles de compteurs', () => {
    const index = evolutionIndex();
    const model = evolutionLineModel(index, 'actives', 10);
    assert.equal(model.points.length, 11);
    assert.equal(model.points.at(-1).total, 1);
    assert.equal(model.max, 3);          // pic d'actives sur toute la plage
    assert.equal(model.headDay, 10);
    // Compteurs au jour 10 + catégories distinctes de l'ensemble actif.
    const acc = evolutionStateAt(index, ['cache_type', 'country'], 10);
    const values = evolutionCounterValues(index, 10, acc.setView('active'),
        ['actives', 'placees', 'archivees', 'peak', 'types', 'countries']);
    assert.equal(values.actives.value, 1);
    assert.equal(values.placees.value, 3);
    assert.equal(values.archivees.value, 2);
    assert.equal(values.peak.value, 3);
    assert.equal(values.types.value, 1);
    assert.equal(values.countries.value, 1);
});

test('évolution : métriques acceptées par la normalisation', () => {
    for (const [kind, metrics] of Object.entries(EVOLUTION_METRICS_BY_KIND)) {
        for (const metric of metrics) {
            assert.ok(createStatsPanel(kind, metric), `${kind}:${metric}`);
        }
    }
    // Un panneau barre accepte l'univers « Compter » quand il est fourni ;
    // absent, la clé n'est pas sérialisée (vecteurs du mode principal).
    const panel = createStatsPanel('bar', 'county', { options: { counted: 'placed' } });
    assert.equal(panel.options.counted, 'placed');
    const plain = createStatsPanel('bar', 'county', {});
    assert.equal('counted' in plain.options, false);
});
