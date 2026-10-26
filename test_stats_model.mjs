import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    EVOLUTION_METRICS_BY_KIND,
    STATS_DEFAULTS,
    STATS_MAX_PANELS,
    AGE_BUCKETS,
    accumulatorMetricsFor,
    ageBucket,
    counterValues,
    countedUniverse,
    createEvolutionStatsAccumulator,
    createTweenStore,
    dayNumber,
    dayNumberOfDate,
    evolutionActivePeaks,
    evolutionCounterValues,
    evolutionEventsBetween,
    evolutionLineModel,
    evolutionMeanActiveAge,
    evolutionStateAt,
    evolutionStatusAcc,
    lineMilestones,
    lineModel,
    milestoneStep,
    ymdOfDay,
    UNKNOWN_KEY,
    OTHERS_KEY,
    arrangePanels,
    barModel,
    countFeatures,
    createStatsAccumulator,
    createStatsPanel,
    dtIndex,
    featuresUpTo,
    extremesOfFeatures,
    foldExtreme,
    formatDdm,
    gridModel,
    gridSpec,
    hasActiveHighlights,
    highlightLevel,
    layoutPanels,
    metricsForPanels,
    matchingStatsStylePreset,
    normalizeStatsSettings,
    offsetFreeCopy,
    parseYmd,
    rectsOverlap,
    statsKeyOf,
    statsStylePreset,
    yearTicks,
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

test('préréglages d\'apparence : style complet sur leurs champs, matching exact', () => {
    const clair = statsStylePreset('clair');
    assert.equal(clair.background_opacity, 92);
    assert.equal(clair.text_color, '#1a2b3c');
    assert.equal(statsStylePreset('introuvable'), null);
    // « sombre » reprend le style par défaut : un panneau neuf matche.
    const panel = createStatsPanel('bar', 'year');
    assert.equal(matchingStatsStylePreset(panel.style), 'sombre');
    // Un style qui reprend un préréglage, autres champs libres : matché.
    assert.equal(matchingStatsStylePreset({ ...panel.style, ...clair, font_size: 18 }), 'clair');
    // Un seul champ en écart (arrondi retouché) : plus de préréglage actif.
    assert.equal(matchingStatsStylePreset({ ...panel.style, radius: 4 }), null);
    // Couleurs comparées sans la casse.
    assert.equal(matchingStatsStylePreset(
        { ...panel.style, background: '#0B1A2B' }), 'sombre');
});

test('position.height : null par défaut, nullable et bornée', () => {
    const heightOf = (position) => normalizeStatsSettings({ panels: [
        { kind: 'bar', metric: 'year', position },
    ] }).panels[0].position.height;
    assert.equal(heightOf({}), null);
    assert.equal(heightOf({ height: null }), null);
    assert.equal(heightOf({ height: 90 }), 90);
    assert.equal(heightOf({ height: '300' }), 300);
    // Non numérique → null (automatique), comme le serveur (_int_in None).
    assert.equal(heightOf({ height: 'abc' }), null);
    assert.equal(heightOf({ height: 5000 }), 1200);
    // Sous le plancher : bornée comme la largeur (0 → 60), pas annulée.
    assert.equal(heightOf({ height: 0 }), 60);
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
    // finds_ym : mêmes clés année × 100 + mois que Jasmer, sur date_find.
    assert.equal(statsKeyOf('finds_ym', p), 202103);
    assert.equal(statsKeyOf('finds_ym', { date_find: '2021-03-14' }), 202103);
    assert.equal(statsKeyOf('finds_ym', { date_find: 'pfff' }), null);
    assert.equal(statsKeyOf('finds_ym', { date_find: '2021-02-31' }), null);
    assert.equal(statsKeyOf('finds_ym', {}), null);
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

test('âge à la trouvaille : tranches en jours puis en mois calendaires révolus', () => {
    const age = (published, found) => ageBucket(parseYmd(published), parseYmd(found));
    assert.equal(age('2020-03-15', '2020-03-15'), 0);           // le jour même
    assert.equal(age('2020-03-15', '2020-03-16'), 1);
    assert.equal(age('2020-03-15', '2020-03-22'), 1);           // 7 jours
    assert.equal(age('2020-03-15', '2020-03-23'), 2);           // 8 jours
    assert.equal(age('2020-03-15', '2020-04-14'), 2);           // pas encore un mois
    assert.equal(age('2020-03-15', '2020-04-15'), 3);           // un mois révolu
    assert.equal(age('2020-01-31', '2020-02-29'), 2);           // 29 j, mois non révolu
    assert.equal(age('2020-03-15', '2020-09-14'), 3);
    assert.equal(age('2020-03-15', '2020-09-15'), 4);           // 6 mois
    assert.equal(age('2020-03-15', '2021-03-15'), 5);           // 1 an
    assert.equal(age('2020-03-15', '2022-03-15'), 6);           // 2 ans
    assert.equal(age('2010-03-15', '2015-03-14'), 6);
    assert.equal(age('2010-03-15', '2015-03-15'), 7);           // 5 ans
    assert.equal(age('2005-03-15', '2015-03-15'), 8);           // 10 ans
    assert.equal(age('2001-03-15', '2016-03-15'), 9);           // 15 ans
    assert.equal(age('2001-03-15', '2026-03-15'), AGE_BUCKETS - 1);
    // Trouvée avant d'être publiée, dates absentes : exclue.
    assert.equal(age('2020-03-15', '2020-03-14'), null);
    assert.equal(ageBucket(null, parseYmd('2020-03-14')), null);
    // Clé de la métrique : date de publication antérieure à mai 2000 = corrompue.
    assert.equal(statsKeyOf('age', { published_date: '2020-03-15', date_find: '2020-03-15' }), 0);
    assert.equal(statsKeyOf('age', { published_date: '1999-03-15', date_find: '2020-03-15' }), null);
    assert.equal(statsKeyOf('age', lab().properties), null);
    assert.equal(statsKeyOf('published', { published_date: '2000-05-02' }), dayNumber({ y: 2000, m: 5, d: 2 }));
    assert.equal(statsKeyOf('published', { published_date: '2000-04-30' }), null);
});

test('histogramme âge : 10 tranches fixes dans l\'ordre, Labs exclus', () => {
    const acc = countFeatures([
        geocache(1, 1, { published_date: '2021-03-14' }),       // le jour même
        geocache(1, 1, { published_date: '2001-01-01' }),       // 20 ans
        lab(),
    ], ['age']);
    const model = barModel('age', acc, acc, createStatsPanel('bar', 'age').options);
    assert.deepEqual(model.rows.map((r) => r.key), Array.from({ length: AGE_BUCKETS }, (_, i) => i));
    assert.equal(model.rows[0].count, 1);
    assert.equal(model.rows[AGE_BUCKETS - 1].count, 1);
    assert.equal(model.excluded, 1);
    assert.equal(createStatsPanel('bar', 'age').options.orientation, 'horizontal');
    assert.deepEqual(accumulatorMetricsFor(createStatsPanel('counter', 'summary', { options: { items: ['oldest', 'same_day'] } })),
        ['published', 'age']);
});

test('points extrêmes : record par axe, locationless et positions invalides ignorées', () => {
    const at = (lon, lat, extra = {}) => ({ ...geocache(1, 1, extra), geometry: { type: 'Point', coordinates: [lon, lat] } });
    const acc = createStatsAccumulator(['extremes']);
    acc.add([
        at(2.35, 48.85, { gc_code: 'GCPARIS', name: 'Paris', date_find: '2020-01-01' }),
        at(-4.48, 48.39, { gc_code: 'GCBREST' }),
        at(7.75, 48.58, { gc_code: 'GCSTRAS' }),
        at(5.37, 43.29, { gc_code: 'GCMARS' }),
        // Position fictive, nulle, hors bornes : jamais un record.
        at(170, 89, { cache_type: 'Locationless (Reverse) Cache' }),
        at(0, 0),
        at(200, 95),
        lab(),
        // Égalité avec Paris au nord : la première reste.
        at(3, 48.85, { gc_code: 'GCTIE' }),
    ]);
    const v = counterValues(acc, ['north', 'south', 'east', 'west']);
    assert.equal(v.north.find.gc_code, 'GCPARIS');
    assert.equal(v.north.find.name, 'Paris');
    assert.equal(v.north.find.day, dayNumber({ y: 2020, m: 1, d: 1 }));
    assert.equal(v.north.value, 48.85);
    assert.equal(v.north.axis, 'lat');
    assert.equal(v.south.find.gc_code, 'GCMARS');
    assert.equal(v.east.find.gc_code, 'GCSTRAS');
    assert.equal(v.east.axis, 'lon');
    assert.equal(v.west.value, -4.48);
    // Sans la métrique : rien de retenu, tuiles vides.
    const none = counterValues(countFeatures([at(1, 1)], ['day']), ['north']);
    assert.equal(none.north.find, null);
    assert.deepEqual(accumulatorMetricsFor(createStatsPanel('counter', 'summary', { options: { items: ['north', 'west'] } })),
        ['extremes']);
    acc.reset();
    assert.equal(acc.extremes.north, null);
});

test('extremesOfFeatures + foldExtreme : repli du record retiré, premier à égalité', () => {
    const at = (lon, lat, extra = {}) => ({ ...geocache(1, 1, extra), geometry: { type: 'Point', coordinates: [lon, lat] } });
    // Deux jours : le record du nord naît au second ; retiré, c'est celui du
    // premier qui reprend (saut en arrière, stats_panels › removeDays).
    const ex1 = extremesOfFeatures([
        at(2.0, 47.0, { gc_code: 'GC1', date_find: '2021-01-01' }),
        at(-3.0, 44.0, { gc_code: 'GC2', date_find: '2021-01-01' }),
    ]);
    const ex2 = extremesOfFeatures([
        at(5.0, 49.0, { gc_code: 'GC3', date_find: '2021-01-02' }),
    ]);
    assert.equal(ex1.north.gc_code, 'GC1');
    assert.equal(ex2.north.gc_code, 'GC3');
    // Ordre chronologique, comparaisons strictes : à égalité le premier
    // reste, comme à l'accumulation.
    assert.equal(foldExtreme('north', [ex1.north, ex2.north]).gc_code, 'GC3');
    const tie = { lat: 49.0, lon: 9, day: 5, gc_code: 'GCTIE' };
    assert.equal(foldExtreme('north', [ex2.north, tie]).gc_code, 'GC3');
    assert.equal(foldExtreme('north', [tie, ex2.north]).gc_code, 'GCTIE');
    // Autres axes : sud = min de lat, est/ouest = max/min de lon ; null ignoré.
    assert.equal(foldExtreme('south', [null, ex1.south, ex2.south]).gc_code, 'GC2');
    assert.equal(foldExtreme('east', [ex1.east, ex2.east]).gc_code, 'GC3');
    assert.equal(foldExtreme('west', [ex1.west, ex2.west]).gc_code, 'GC2');
    assert.equal(foldExtreme('north', []), null);
});

test('coordonnées au format géocaching : degrés et minutes décimales', () => {
    assert.equal(formatDdm(48.8566, 'lat'), 'N 48° 51.396');
    assert.equal(formatDdm(2.3522, 'lon'), 'E 002° 21.132');
    assert.equal(formatDdm(-4.4861, 'lon'), 'W 004° 29.166');
    assert.equal(formatDdm(-33.8688, 'lat'), 'S 33° 52.128');
    assert.equal(formatDdm(5.05, 'lat'), 'N 05° 03.000');
    // 59.9999… minutes arrondies à 60 : la retenue passe au degré.
    assert.equal(formatDdm(9.9999999, 'lat'), 'N 10° 00.000');
});

test('paliers : pas le plus fin donnant au plus 5 paliers, aucun sous 100', () => {
    assert.equal(milestoneStep(0), null);
    assert.equal(milestoneStep(99), null);
    assert.equal(milestoneStep(100), 100);
    assert.equal(milestoneStep(450), 100);      // 100…400
    assert.equal(milestoneStep(600), 200);      // 6 × 100 → trop, 3 × 200
    assert.equal(milestoneStep(1234), 500);     // 6 × 200 → trop, 2 × 500
    assert.equal(milestoneStep(5000), 1000);
    assert.equal(milestoneStep(12000), 5000);
    assert.equal(milestoneStep(10_000_000), 100000);
});

test('paliers : jour de franchissement sur l\'état courant, null tant que non atteint', () => {
    // 120 trouvailles le 1er janvier 2024, 100 de plus le 3 → total 220.
    const day1 = Array.from({ length: 120 }, () => onDay('2024-01-01'));
    const day3 = Array.from({ length: 100 }, () => onDay('2024-01-03'));
    const ref = countFeatures([...day1, ...day3], ['day']);
    const cur = countFeatures(day1, ['day']);
    const first = dayNumber({ y: 2024, m: 1, d: 1 });
    // Référence 220 → pas de 100 : paliers 100 et 200.
    assert.deepEqual(lineMilestones(lineModel(ref, ref)), [
        { value: 100, day: first }, { value: 200, day: first + 2 },
    ]);
    // En cours d'animation, le pas reste celui de la référence ; 200 pas encore atteint.
    assert.deepEqual(lineMilestones(lineModel(cur, ref)), [
        { value: 100, day: first }, { value: 200, day: null },
    ]);
    assert.deepEqual(lineMilestones(lineModel(countFeatures(day1.slice(0, 50), ['day']), null)), []);
});

test('compteurs : plus ancienne cache trouvée, trouvées le jour de leur publication', () => {
    const empty = counterValues(countFeatures([lab()], ['published', 'age']), ['oldest', 'same_day']);
    assert.deepEqual(empty.oldest, { value: 0, day: null });
    assert.equal(empty.same_day.value, 0);
    const acc = createStatsAccumulator(['published', 'age']);
    acc.add([geocache(1, 1, { published_date: '2012-05-04', date_find: '2012-05-04' })]);
    let v = counterValues(acc, ['oldest', 'same_day']);
    assert.equal(v.oldest.value, 2012);
    assert.equal(v.oldest.day, dayNumber({ y: 2012, m: 5, d: 4 }));
    assert.equal(v.same_day.value, 1);
    // Une plus ancienne arrive : la mémoïsation suit la révision.
    acc.add([geocache(1, 1, { published_date: '2003-02-01' }), lab()]);
    v = counterValues(acc, ['oldest', 'same_day']);
    assert.equal(v.oldest.value, 2003);
    assert.equal(v.oldest.day, dayNumber({ y: 2003, m: 2, d: 1 }));
    assert.equal(v.same_day.value, 1);
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

test('remove : miroir exact de add — comptes, exclus, clés gardées à 0', () => {
    const metrics = ['dt', 'cache_type', 'attribute', 'day'];
    const batchA = [
        geocache(1, 1, { attributes: [{ name: 'Scenic view' }, { name: 'Bikes allowed' }] }),
        geocache(4, 4.5),
        lab(),                                                    // exclue de D/T
    ];
    const batchB = [
        geocache(2, 3.5, { attributes: [{ name: 'Scenic view' }] }),
        geocache(2, 3.5, { date_find: '2021-04-02' }),
        lab(),                                                    // exclue de D/T
    ];
    const full = createStatsAccumulator(metrics).add([...batchA, ...batchB]);
    full.remove(batchB);
    const partial = createStatsAccumulator(metrics).add(batchA);
    assert.equal(full.total, partial.total);
    // Les clés retombées à 0 sont gardées par remove (invariant vérifié plus
    // bas) : la comparaison porte sur les valeurs non nulles.
    const nonzero = (map) => Object.fromEntries([...map].filter(([, n]) => n > 0));
    for (const metric of metrics) {
        assert.deepEqual(nonzero(full.counts.get(metric)),
            nonzero(partial.counts.get(metric)), metric);
        assert.equal(full.excluded.get(metric), partial.excluded.get(metric), metric);
    }
    // Une clé retombée à 0 reste dans les comptes : les barres glissent vers
    // 0 au lieu de perdre leur ligne (invariant de remove, cf. stats_model).
    const batchC = [geocache(5, 5)];
    const acc = createStatsAccumulator(metrics).add([...batchA, ...batchC]);
    acc.remove(batchC);
    assert.equal(acc.count('dt', 80), 0);
    assert.ok(acc.counts.get('dt').has(80));
    // Planchers à 0 : retirer plus que compté ne descend pas sous 0.
    acc.remove([geocache(5, 5), geocache(5, 5)]);
    assert.equal(acc.count('dt', 80), 0);
    // Aucune horloge écrite par le retrait : pas de surlignage.
    const revision = acc.revision;
    acc.remove([]);
    assert.equal(acc.revision, revision);                         // lot vide : rien
    assert.equal(acc.lastHit.get('dt').size, 0);
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
    assert.equal(model.loops, 0);
    assert.equal(model.cells[0].count, 1);
});

test('grille D/T : tours de matrice = compte minimal sur les 81 cases', () => {
    // Les 81 combinaisons (demi-points de 1 à 5 sur D et T), deux fois chacune
    // sauf la case 5/5 trouvée une seule fois → un tour complet.
    const values = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
    const combo = () => values.flatMap((d) => values.map((t) => geocache(d, t)));
    const twoPasses = [...combo(), ...combo().filter((f) => !(f.properties.difficulty === 5 && f.properties.terrain === 5))];
    const acc = countFeatures(twoPasses, ['dt']);
    let model = gridModel('dt', acc, acc);
    assert.equal(model.filled, 81);
    assert.equal(model.loops, 1);
    // Une troisième passe complète : la case faible atteint 2 → deux tours.
    model = gridModel('dt', countFeatures([...twoPasses, ...combo()], ['dt']), acc);
    assert.equal(model.loops, 2);
});

test('tours de calendrier et de Jasmer : cases disponibles seulement, 29 février compris', () => {
    // Une trouvaille chaque jour de 2024 (bissextile) : un tour de calendrier.
    const year = [];
    for (let day = dayNumber({ y: 2024, m: 1, d: 1 }); day <= dayNumber({ y: 2024, m: 12, d: 31 }); day++) {
        const { y, m, d } = ymdOfDay(day);
        year.push(geocache(1, 1, { date_find: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }));
    }
    let acc = countFeatures(year, ['calendar']);
    assert.equal(gridModel('calendar', acc, acc).loops, 1);
    // 2023 (non bissextile) en plus : le 29 février reste à 1 → toujours un tour.
    const common = year.filter((f) => f.properties.date_find !== '2024-02-29')
        .map((f) => geocache(1, 1, { date_find: f.properties.date_find.replace('2024', '2023') }));
    acc = countFeatures([...year, ...common], ['calendar']);
    assert.equal(gridModel('calendar', acc, acc).loops, 1);

    // Jasmer borné à juillet 2000 : mai, juin, juillet suffisent pour un tour.
    const end = { y: 2000, m: 7 };
    acc = countFeatures(['2000-05-03', '2000-06-01', '2000-07-31']
        .map((published_date) => geocache(1, 1, { published_date })), ['jasmer']);
    assert.equal(gridModel('jasmer', acc, acc, { end }).loops, 1);
    assert.equal(gridModel('jasmer', acc, acc, { end: { y: 2000, m: 8 } }).loops, 0);
});

test('année d\'activité : semaines en colonnes, lundi en tête, hors année désactivé', () => {
    // 2024 commence un lundi : 53 colonnes, aucune case avant le 1ᵉʳ janvier.
    let spec = gridSpec('activity', { year: 2024 });
    assert.equal(spec.rows, 7);
    assert.equal(spec.cols, 53);
    assert.equal(spec.keyAt(0, 0), dayNumber({ y: 2024, m: 1, d: 1 }));
    assert.equal(spec.disabled(0, 0), false);
    // 2023 commence un dimanche : 6 cases désactivées en tête de première colonne.
    spec = gridSpec('activity', { year: 2023 });
    assert.equal(spec.keyAt(6, 0), dayNumber({ y: 2023, m: 1, d: 1 }));
    assert.equal(spec.disabled(5, 0), true);
    assert.equal(spec.cols, 53);
    // 2012, bissextile commençant un dimanche : 54 colonnes.
    assert.equal(gridSpec('activity', { year: 2012 }).cols, 54);
    // Chaque jour de l'année exactement une fois parmi les cases actives.
    let available = 0;
    for (let r = 0; r < 7; r++) for (let c = 0; c < spec.cols; c++) if (!spec.disabled(r, c)) available += 1;
    assert.equal(available, 365);

    // Comptes lus dans la métrique `day` ; l'échelle vient de la référence.
    const panel = createStatsPanel('grid', 'activity');
    assert.deepEqual(accumulatorMetricsFor(panel), ['day']);
    assert.equal(panel.options.cell_mode, 'heat');
    assert.equal(panel.position.width, 520);
    const acc = countFeatures([onDay('2023-01-01'), onDay('2023-01-01'), onDay('2023-03-15'),
        onDay('2022-12-31'), lab({ date_find: 'x' })], ['day']);
    const model = gridModel('activity', acc, acc, { year: 2023 });
    assert.equal(model.filled, 2);
    assert.equal(model.available, 365);
    assert.equal(model.max, 2);
    assert.equal(model.excluded, 1);
    assert.equal(model.cells[6 * model.cols].count, 2);     // dimanche 1ᵉʳ janvier, colonne 0
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

test('grille finds_ym : années des trouvailles en lignes, aucune case désactivée', () => {
    // Géométrie déclarée par le contexte : 2020 → 2022, trois lignes.
    const spec = gridSpec('finds_ym', { years: [2020, 2022] });
    assert.equal(spec.rows, 3);
    assert.equal(spec.cols, 12);
    assert.deepEqual(spec.rowKeys, [2020, 2021, 2022]);
    assert.equal(spec.keyAt(2, 11), 202212);
    // Un mois sans trouvaille est une information, pas un trou : rien de
    // désactivé, même avant la première ou après la dernière trouvaille.
    for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) assert.equal(spec.disabled(r, c), false);
    }
    // Sans contexte : repli sur l'année courante, une seule ligne.
    const seule = gridSpec('finds_ym');
    assert.equal(seule.rows, 1);
    assert.deepEqual(seule.rowKeys, [new Date().getFullYear()]);

    // gridModel lit les bornes sur les comptes de la RÉFÉRENCE (la grille ne
    // grandit pas pendant l'animation) : 2019 et 2024 → six lignes.
    const reference = countFeatures([
        onDay('2019-05-12'), onDay('2024-11-03'), onDay('2024-11-20'),
    ], ['finds_ym']);
    const current = countFeatures([onDay('2019-05-12')], ['finds_ym']);
    const model = gridModel('finds_ym', current, reference);
    assert.deepEqual(model.rowKeys, [2019, 2020, 2021, 2022, 2023, 2024]);
    assert.equal(model.rows, 6);
    assert.equal(model.available, 72);
    assert.equal(model.filled, 1);              // mai 2019 seul, côté courant
    assert.equal(model.max, 2);                 // novembre 2024, référence
    // La clé de la case « mai 2019 » est joignable : key + count dans cells.
    assert.equal(model.cells.find((cell) => cell.key === 201905).count, 1);
    const nov2024 = model.cells.find((cell) => cell.key === 202411);
    assert.equal(nov2024.count, 0);
    const modelRef = gridModel('finds_ym', reference, reference);
    assert.equal(modelRef.cells.find((cell) => cell.key === 202411).count, 2);
    // Comptage dense : le défaut est l'intensité, pas « remplie ou vide ».
    assert.equal(createStatsPanel('grid', 'finds_ym').options.cell_mode, 'heat');
    // La dépendance de la grille est sa propre métrique (clés sur date_find).
    assert.deepEqual(accumulatorMetricsFor(createStatsPanel('grid', 'finds_ym')), ['finds_ym']);
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

test('barres : mémoïsé par révision, lignes retournées isolées du cache', () => {
    const acc = createStatsAccumulator(['cache_type']);
    acc.add(types({ Traditional: 3, Multi: 2, Mystery: 1 }));
    const options = { sort: 'count', max_items: 8 };
    const m1 = barModel('cache_type', acc, acc, options);
    const m2 = barModel('cache_type', acc, acc, options);
    // animateRows écrit shown/slot sur les lignes (et slots sur le modèle) :
    // les copies renvoyées ne doivent pas polluer les appels suivants.
    m1.rows[0].shown = 999;
    m1.rows[0].slot = 7;
    m1.slots = 4;
    assert.equal(m2.rows[0].shown, undefined);
    assert.equal(m2.rows[0].slot, undefined);
    assert.equal(m2.slots, undefined);
    assert.deepEqual(m2.rows.map((r) => r.key), ['Traditional', 'Multi', 'Mystery']);
    // Nouvelle révision → valeurs recalculées.
    acc.add(types({ Traditional: 1 }));
    const m3 = barModel('cache_type', acc, acc, options);
    assert.equal(m3.rows.find((r) => r.key === 'Traditional').count, 4);
});

test('barres : tri « label » — un autre labelOf force le recalcul', () => {
    const acc = createStatsAccumulator(['cache_type']);
    acc.add(types({ Aaa: 3, Bbb: 2 }));
    const options = { sort: 'label', max_items: 8 };
    const m1 = barModel('cache_type', acc, acc, options, String);
    assert.deepEqual(m1.rows.map((r) => r.key), ['Aaa', 'Bbb']);
    // labelOf comparé par identité : une autre fonction → autre ordre servi.
    const reverse = barModel('cache_type', acc, acc, options,
        (key) => (key === 'Aaa' ? 'z' : 'a'));
    assert.deepEqual(reverse.rows.map((r) => r.key), ['Bbb', 'Aaa']);
    // Le même labelOf qu'au premier appel recalcule (le cache porte l'autre).
    const again = barModel('cache_type', acc, acc, options, String);
    assert.deepEqual(again.rows.map((r) => r.key), ['Aaa', 'Bbb']);
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

test('empilement : du coin vers l\'intérieur, écart fixe de 8 px', () => {
    const top = layoutPanels([
        item('a', 'top-left'),
        item('b', 'top-left', { height: 50 }),
        item('c', 'top-left'),
    ], box);
    assert.equal(top.get('a').y, 16);
    assert.equal(top.get('b').y, 16 + 100 + 8);
    assert.equal(top.get('c').y, 16 + 100 + 8 + 50 + 8);
    assert.equal(rectsOverlap(top.get('a'), top.get('b')), false);

    const bottom = layoutPanels([item('a', 'bottom-right'), item('b', 'bottom-right')], box);
    assert.equal(bottom.get('a').y, 600 - 16 - 100);
    assert.equal(bottom.get('b').y, 600 - 16 - 100 - 8 - 100);
    assert.deepEqual(bottom.get('b').css, { right: 16, bottom: 600 - bottom.get('b').y - 100 });

    const middle = layoutPanels([item('a', 'middle-left'), item('b', 'middle-left')], box);
    // Pile de 208 px centrée : 196 → 404.
    assert.equal(middle.get('a').y, 196);
    assert.equal(middle.get('b').y, 304);
});

test('empilement : les marges de la pile sont celles de son premier panneau', () => {
    // Des dx/dy divergents sur les suivants (réglages non normalisés) ne
    // décalent ni l'écart ni l'alignement.
    const layout = layoutPanels([
        item('a', 'top-right', { dx: 30, dy: 40 }),
        item('b', 'top-right', { dx: 5, dy: 90 }),
    ], box);
    assert.equal(layout.get('a').y, 40);
    assert.equal(layout.get('b').y, 40 + 100 + 8);
    assert.equal(layout.get('b').x, 1000 - 30 - 200);

    // Réordonner une pile à marges communes ne la déplace pas : seul
    // l'ordre des panneaux change.
    const ab = layoutPanels([item('a', 'top-left', { height: 60 }), item('b', 'top-left')], box);
    const ba = layoutPanels([item('b', 'top-left'), item('a', 'top-left', { height: 60 })], box);
    assert.equal(ab.get('a').y, 16);
    assert.equal(ba.get('b').y, 16);
    assert.equal(ab.get('b').y + 100, ba.get('a').y + 60);
});

test('normalisation : marges communes aux panneaux d’un même coin', () => {
    const panel = (id, position) => ({ id, kind: 'bar', metric: 'year', position });
    const { panels, configs } = normalizeStatsSettings({
        panels: [
            panel('aaaaaa01', { anchor: 'top-left', dx: 30, dy: 40 }),
            panel('aaaaaa02', { mode: 'free', anchor: 'top-left', dx: 2, dy: 3, x: 0.5, y: 0.5 }),
            panel('aaaaaa03', { anchor: 'bottom-right', dx: 12, dy: 8 }),
            panel('aaaaaa04', { anchor: 'top-left', dx: 16, dy: 8 }),
            panel('aaaaaa05', { anchor: 'bottom-right' }),
        ],
        configs: [{ name: 'Pile', panels: [
            panel('bbbbbb01', { anchor: 'middle-right', dx: 20, dy: 0 }),
            panel('bbbbbb02', { anchor: 'middle-right', dx: 50, dy: 50 }),
        ] }],
    });
    const margins = (p) => [p.position.dx, p.position.dy];
    assert.deepEqual(panels.map(margins), [[30, 40], [2, 3], [12, 8], [30, 40], [12, 8]]);
    assert.deepEqual(configs[0].panels.map(margins), [[20, 0], [20, 0]]);
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
    // « total » seul doit quand même compter : sa pseudo-métrique constante
    // évite l'ensemble vide qui court-circuiterait accumulateStatsForDates.
    assert.deepEqual(
        accumulatorMetricsFor({ kind: 'counter', metric: 'summary', options: { items: ['total'] } }),
        ['total'],
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
        ['total', 'days', 'best_day', 'streak', 'types', 'countries', 'states', 'attributes', 'owners']);
    assert.equal(v.total.value, 9);         // toutes les features, acc.total
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

test('jalons d\'années : les 1ᵉʳ janvier strictement entre les bornes', () => {
    const mid = (y) => dayNumber({ y, m: 6, d: 15 });
    // Début et fin dans la même année : aucun jalon.
    assert.deepEqual(yearTicks(mid(2021), dayNumber({ y: 2021, m: 11, d: 1 })), []);
    // Mi-2010 → mi-2023 : 13 jalons, 2011…2023.
    const ticks = yearTicks(mid(2010), mid(2023));
    assert.deepEqual(ticks.map((t) => t.label), Array.from({ length: 13 }, (_, i) => String(2011 + i)));
    assert.equal(ticks[0].day, dayNumber({ y: 2011, m: 1, d: 1 }));
    // Un 1ᵉʳ janvier en borne n'est pas répété.
    assert.deepEqual(yearTicks(dayNumber({ y: 2015, m: 1, d: 1 }), mid(2017)).map((t) => t.label),
        ['2016', '2017']);
    assert.deepEqual(yearTicks(mid(2015), dayNumber({ y: 2017, m: 1, d: 1 })).map((t) => t.label),
        ['2016']);
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

test('lineModel : jours et points mémoïsés par révision d\'accumulateur', () => {
    const acc = createStatsAccumulator(['day']);
    acc.add([onDay('2024-01-01'), onDay('2024-01-03'), onDay('2024-01-03')], null);
    const m1 = lineModel(acc, acc);
    const m2 = lineModel(acc, acc);
    assert.equal(m2.points, m1.points);                 // même tableau, pas recalculé
    acc.add([onDay('2024-01-10')], null);
    const m3 = lineModel(acc, acc);
    assert.notEqual(m3.points, m1.points);              // révision → recalculé
    assert.equal(m3.total, m1.total + 1);               // et le compte suit
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

test('course de barres : allLabels liste toutes les clés classées, hors top-N compris', () => {
    const reference = countFeatures(
        types({ A: 10, B: 8, C: 5, 'Un nom de catégorie très long': 1 }), ['cache_type']);
    const options = { sort: 'race', max_items: 2 };
    const model = barModel('cache_type', reference, reference, options, String);
    assert.deepEqual(model.rows.map((r) => r.key), ['A', 'B']);
    // Le pool d'étiquettes dépasse le top-N : le long nom hors classement y est.
    assert.deepEqual(model.allLabels, ['A', 'B', 'C', 'Un nom de catégorie très long']);
    // Modèle mémoïsé : même tableau servi tant que la révision ne change pas —
    // c'est ce qui rend la mémoïsation de mesure du dessin efficace.
    const again = barModel('cache_type', reference, reference, options, String);
    assert.equal(again.allLabels, model.allLabels);
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
    assert.equal(layout.get('b').y, 16 + 100 + 8);
});

test('évitement : la pile d’un coin démarre sous le titre ou au-dessus d’une boîte basse', () => {
    const title = { x: 10, y: 10, width: 250, height: 50 };
    const top = layoutPanels([item('a', 'top-left'), item('b', 'top-left')], box, [title]);
    assert.equal(top.get('a').y, 10 + 50 + 8);
    assert.equal(top.get('b').y, 10 + 50 + 8 + 100 + 8);
    // Boîte d'un autre côté : rien ne bouge.
    const right = layoutPanels([item('r', 'top-right')], box, [title]);
    assert.equal(right.get('r').y, 16);
    const low = { x: 700, y: 560, width: 290, height: 30 };
    const bottom = layoutPanels([item('c', 'bottom-right')], box, [low]);
    assert.equal(bottom.get('c').y + 100, 560 - 8);
});

test('évitement : toute la hauteur de la pile compte, pas seulement son premier panneau', () => {
    // Infos posées en bas à gauche, sous le premier panneau mais dans la
    // course du second : la pile haut-gauche repart sous la boîte.
    const infos = { x: 10, y: 180, width: 150, height: 30 };
    const top = layoutPanels([item('a', 'top-left'), item('b', 'top-left')], box, [infos]);
    assert.equal(top.get('a').y, 180 + 30 + 8);
    assert.equal(rectsOverlap(top.get('b'), infos), false);
    // Pile du bas, boîte au-dessus du premier panneau : même règle.
    const title = { x: 800, y: 400, width: 150, height: 40 };
    const bottom = layoutPanels([item('c', 'bottom-right'), item('d', 'bottom-right')], box, [title]);
    assert.equal(bottom.get('c').y + 100, 400 - 8);
    assert.equal(rectsOverlap(bottom.get('d'), title), false);
});

test('réorganiser : un panneau qui ne gêne personne reste où il est', () => {
    const { placements, conflict } = arrangePanels([
        { id: 'f', mode: 'free', x: 0.5, y: 0.5, width: 200, height: 100 },
        item('a', 'top-left'),
        item('b', 'bottom-right'),
    ], box, [], new Map([['top-left', { dx: 16, dy: 16 }], ['bottom-right', { dx: 16, dy: 16 }]]));
    assert.deepEqual(placements.get('f'), { mode: 'free' });
    assert.deepEqual(placements.get('a'), { mode: 'anchor', anchor: 'top-left', dx: 16, dy: 16 });
    assert.deepEqual(placements.get('b'), { mode: 'anchor', anchor: 'bottom-right', dx: 16, dy: 16 });
    assert.equal(conflict, 0);
});

test('réorganiser : seul le panneau en conflit bouge, vers le premier emplacement libre', () => {
    // Deux panneaux libres superposés : le premier reste, le second part
    // au premier coin préféré (bas-gauche), avec les marges par défaut.
    const free = (id) => ({ id, mode: 'free', x: 0.1, y: 0.1, width: 200, height: 100 });
    const { placements, conflict } = arrangePanels([free('f1'), free('f2')], box);
    assert.deepEqual(placements.get('f1'), { mode: 'free' });
    assert.deepEqual(placements.get('f2'), { mode: 'anchor', anchor: 'bottom-left', dx: 16, dy: 16 });
    assert.equal(conflict, 0);
});

test('réorganiser : la taille compte — une pile pleine n’est plus choisie', () => {
    // Pile haut-gauche : 16 + 250 + 8 + 250 = 524 px sur 600. Un troisième
    // panneau de 250 px déborderait ; bas-gauche chevaucherait la pile (même
    // colonne) : il part en bas à droite, et prend les marges de cette pile.
    const tall = (id, anchor, extra = {}) => item(id, anchor, { height: 250, ...extra });
    const margins = new Map([['top-left', { dx: 16, dy: 16 }], ['bottom-right', { dx: 30, dy: 24 }]]);
    const { placements, conflict } = arrangePanels([
        tall('a', 'top-left'), tall('b', 'top-left'), tall('c', 'top-left'),
    ], box, [], margins);
    assert.equal(placements.get('a').anchor, 'top-left');
    assert.equal(placements.get('b').anchor, 'top-left');
    assert.deepEqual(placements.get('c'), { mode: 'anchor', anchor: 'bottom-right', dx: 30, dy: 24 });
    assert.equal(conflict, 0);
});

test('réorganiser : un panneau libre sur le titre en est écarté', () => {
    const title = { x: 400, y: 10, width: 200, height: 50 };
    const { placements } = arrangePanels([
        { id: 'f', mode: 'free', x: 0.5, y: 0, width: 200, height: 100 },
    ], box, [title]);
    assert.equal(placements.get('f').mode, 'anchor');
    assert.equal(placements.get('f').anchor, 'bottom-left');
});

test('réorganiser : sans place pour tous, le conflit restant est signalé', () => {
    const huge = (id) => item(id, 'top-left', { width: 900, height: 500 });
    const { placements, conflict } = arrangePanels([huge('a'), huge('b'), huge('c')], box);
    assert.equal(placements.size, 3);
    assert.ok(conflict > 0);
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
        // Jours de pose et d'archivage sur les propriétés, comme
        // evolution_data.js › buildFeatures — la durée de vie et l'âge
        // moyen les lisent.
        features: rows.map((i) => ({
            properties: {
                cache_type: `T${i}`, country: 'France',
                placedDay: base.placed[i], archivedDay: base.archived[i],
            },
        })),
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

test('évolution : deltas de saut — rewind défait le replay', () => {
    const index = evolutionIndex();
    const metrics = ['cache_type'];
    // Photographie des trois univers pour comparer à evolutionStateAt —
    // les clés retombées à 0 sont filtrées (remove/undo les gardent, cf.
    // l'invariant « clés à 0 » de l'accumulateur).
    const snap = (acc) => Object.fromEntries(['active', 'placed', 'archived'].map((name) => {
        const view = acc.setView(name);
        return [name, {
            total: view.total,
            counts: Object.fromEntries(
                [...view.counts.get('cache_type')].filter(([, n]) => n > 0)),
        }];
    }));
    const acc = evolutionStateAt(index, metrics, 2);
    // En avant : le delta (2, 10] = les deux archivages ; (10, 20] = la pose.
    const ev1 = evolutionEventsBetween(index, 2, 10);
    acc.add(ev1.placed, null);
    acc.remove(ev1.archived, null);
    assert.deepEqual(snap(acc), snap(evolutionStateAt(index, metrics, 10)));
    const ev2 = evolutionEventsBetween(index, 10, 20);
    acc.add(ev2.placed, null);
    acc.remove(ev2.archived, null);
    assert.deepEqual(snap(acc), snap(evolutionStateAt(index, metrics, 20)));
    // En arrière : les mêmes événements défaits rendent l'état exact.
    acc.rewind(ev2);
    assert.deepEqual(snap(acc), snap(evolutionStateAt(index, metrics, 10)));
    acc.rewind(ev1);
    assert.deepEqual(snap(acc), snap(evolutionStateAt(index, metrics, 2)));
});

test('évolution : rewind défait l\'archivage avant la pose (plancher à 0)', () => {
    // Fenêtre défaite contenant une pose ET l'archivage qui la suit : posée
    // jour 5, archivée jour 8 — elle n'existait pas encore au jour cible 4.
    // Défaire la pose d'abord ferait passer l'actif à −1 (planché à 0), puis
    // le désarchivage la ferait resurgir à 1 au lieu de 0. T0 est posée avant
    // la fenêtre et archivée dedans : elle repasse à l'actif au jour 4.
    const rows = [0, 1];
    const index = {
        timeline: buildTimeline(
            { placed: Int32Array.from([1, 5]), archived: Int32Array.from([9, 8]) }, rows),
        features: [cache({ cache_type: 'T0', country: 'France' }),
            cache({ cache_type: 'T9', country: 'France' })],
        originDay: 0,
    };
    const metrics = ['cache_type'];
    const acc = evolutionStateAt(index, metrics, 10);
    acc.rewind(evolutionEventsBetween(index, 4, 10));
    const active = Object.fromEntries(
        [...acc.setView('active').counts.get('cache_type')].filter(([, n]) => n > 0));
    assert.deepEqual(active, { T0: 1 });                       // pas de fantôme T9
    assert.equal(acc.setView('active').total, 1);
    assert.equal(acc.setView('placed').total, 1);              // seule T0 posée
    assert.equal(acc.setView('archived').total, 0);            // rien d'archivé au 4
    assert.deepEqual(
        Object.fromEntries(['active', 'placed', 'archived'].map((name) => {
            const view = acc.setView(name);
            return [name, Object.fromEntries(
                [...view.counts.get('cache_type')].filter(([, n]) => n > 0))];
        })),
        { active: { T0: 1 }, placed: { T0: 1 }, archived: {} });
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

test('évolution : durée de vie — tranches et univers par défaut', () => {
    // KEY_OF.lifetime : <1 an, 1-2, 2-3, 3-5, 5-10, 10 ans et +.
    for (const [days, bucket] of [[364, 0], [365, 1], [729, 1], [730, 2],
        [1094, 2], [1095, 3], [1824, 3], [1825, 4], [3649, 4], [3650, 5]]) {
        assert.equal(statsKeyOf('lifetime', { placedDay: 0, archivedDay: days }), bucket, `${days} j`);
    }
    // Jamais archivée ou sans dates : exclue.
    assert.equal(statsKeyOf('lifetime', { placedDay: 0, archivedDay: EVO_NEVER_DAY }), null);
    assert.equal(statsKeyOf('lifetime', {}), null);
    // « Compter » : 'archived' est le défaut de la durée de vie (seul
    // ensemble qui se remplit), 'active' pour les autres métriques.
    assert.equal(countedUniverse({ metric: 'lifetime', options: {} }), 'archived');
    assert.equal(countedUniverse({ metric: 'cache_type', options: {} }), 'active');
    assert.equal(countedUniverse({ metric: 'lifetime', options: { counted: 'placed' } }), 'placed');
});

test('évolution : durée de vie comptée dans l\'univers archivé', () => {
    const index = evolutionIndex();
    // T0 : 3 jours, T2 : 8 jours → « <1 an » ; T1 et T3 jamais archivées.
    const acc = evolutionStateAt(index, ['lifetime'], 20);
    assert.deepEqual(Object.fromEntries(acc.setView('archived').counts.get('lifetime')), { 0: 2 });
    assert.equal(acc.setView('archived').excluded.get('lifetime'), 0);
    // Dans « placées », les quatre caches sont lues : les deux jamais
    // archivées comptent parmi les exclues.
    assert.deepEqual(Object.fromEntries(acc.setView('placed').counts.get('lifetime')), { 0: 2 });
    assert.equal(acc.setView('placed').excluded.get('lifetime'), 2);
});

test('évolution : âge moyen des actives', () => {
    const index = evolutionIndex();
    // Jour 10 : seule T1 (posée jour 1) est active — âge 9.
    assert.equal(evolutionMeanActiveAge(index, 10), 9);
    // Jour 20 : T1 (19 j) et T3 (0 j) → moyenne 9,5.
    assert.equal(evolutionMeanActiveAge(index, 20), 9.5);
    // Jour 2 : T0, T1, T2 (2 + 1 + 0) → moyenne 1.
    assert.equal(evolutionMeanActiveAge(index, 2), 1);
    // Sans active : null — la tuile affiche « — ».
    const empty = {
        timeline: buildTimeline({ placed: new Int32Array(0), archived: new Int32Array(0) }, []),
        features: [],
    };
    assert.equal(evolutionMeanActiveAge(empty, 0), null);
    // evolutionCounterValues la publie comme les autres chiffres.
    assert.equal(evolutionCounterValues(index, 20, null, ['age_moyen']).age_moyen.value, 9.5);
});

// ---------------------------------------------------------------------------
// Copie d'un panneau libre : offsetFreeCopy
// ---------------------------------------------------------------------------

// Cadre 1000×600, panneau 200×100 : espace restant 800×500.
const freeRect = (x, y, width = 200, height = 100) => ({ x, y, width, height, container: { width: 1000, height: 600 } });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('offsetFreeCopy : une copie ancrée garde sa position (elle s\'empile)', () => {
    const position = { mode: 'anchor', anchor: 'top-left', dx: 16, dy: 16, x: 0, y: 0 };
    assert.equal(offsetFreeCopy(position, freeRect(16, 16)), position);
});

test('offsetFreeCopy : une copie libre est décalée de 24 px vers le bas et la droite', () => {
    const copy = offsetFreeCopy({ mode: 'free', x: 0.5, y: 0.5, width: 200 }, freeRect(400, 250));
    assert.ok(near(copy.x, 424 / 800));
    assert.ok(near(copy.y, 274 / 500));
    assert.equal(copy.mode, 'free');
    assert.equal(copy.width, 200);
});

test('offsetFreeCopy : au bord, la copie part dans l\'autre sens', () => {
    const copy = offsetFreeCopy({ mode: 'free', x: 1, y: 1 }, freeRect(800, 500));
    assert.ok(near(copy.x, 776 / 800));
    assert.ok(near(copy.y, 476 / 500));
});

test('offsetFreeCopy : sans place sur un axe, cet axe ne bouge pas', () => {
    // Panneau aussi large que le cadre : x inchangé, y décalé.
    const copy = offsetFreeCopy({ mode: 'free', x: 0, y: 0.2 }, freeRect(0, 100, 1000, 100));
    assert.equal(copy.x, 0);
    assert.ok(near(copy.y, 124 / 500));
});

test('offsetFreeCopy : panneau non affiché, décalage en fraction', () => {
    const copy = offsetFreeCopy({ mode: 'free', x: 0.5, y: 1 }, null);
    assert.ok(near(copy.x, 0.54));
    assert.ok(near(copy.y, 0.96));
});

// ---------------------------------------------------------------------------
// Sources comptées (page principale) : trouvailles, DNF, caches posées
// ---------------------------------------------------------------------------

test('source d\'un panneau : trouvailles par défaut, registre et tuiles propres', async () => {
    const { statsPanelSource, statsPanelRegistry, statsSourceCounterItems, DNF_METRICS_BY_KIND } = await import('./static/js/stats_model.mjs');
    const dnf = createStatsPanel('bar', 'difficulty', { options: { source: 'dnf' } });
    const finds = createStatsPanel('bar', 'attribute');
    assert.equal(statsPanelSource(dnf), 'dnf');
    assert.equal(statsPanelSource(finds), 'finds');
    // Attributs : sans objet pour les DNF ; la source ne joue que sur la page principale.
    assert.ok(!DNF_METRICS_BY_KIND.bar.includes('attribute'));
    assert.ok(statsPanelRegistry(finds, 'main').bar.includes('attribute'));
    assert.ok(!statsPanelRegistry({ ...finds, options: { source: 'owned' } }, 'main').bar.includes('attribute'));
    assert.ok(statsPanelRegistry(dnf, 'poses').bar.includes('finder'));
    assert.ok(statsSourceCounterItems('owned').includes('maintenances'));
    assert.ok(!statsSourceCounterItems('finds').includes('dnf_open'));
});

test('métriques à compter : une liste par source', () => {
    const settings = normalizeStatsSettings({ panels: [
        { id: 'aaaaaa21', kind: 'grid', metric: 'dt' },
        { id: 'aaaaaa22', kind: 'bar', metric: 'year', options: { source: 'dnf' } },
        { id: 'aaaaaa23', kind: 'counter', metric: 'summary', options: { source: 'owned', items: ['total', 'owned_active'] } },
    ] });
    assert.deepEqual([...metricsForPanels(settings, { mode: 'main' })], ['dt']);
    assert.deepEqual([...metricsForPanels(settings, { mode: 'main', source: 'dnf' })], ['year']);
    assert.deepEqual([...metricsForPanels(settings, { mode: 'main', source: 'owned' })], ['total']);
});

test('tuiles d\'état : valeurs neutres tant que stats_panels ne les remplit pas', () => {
    const acc = createStatsAccumulator(['total']);
    const values = counterValues(acc, ['dnf_open', 'dnf_ratio', 'maintenances']);
    assert.deepEqual(values.dnf_open, { value: 0 });
    assert.deepEqual(values.dnf_ratio, { value: 0, pct: true });
    assert.deepEqual(values.maintenances, { value: 0 });
});
