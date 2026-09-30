import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activeAt,
    beginEvolution,
    buildCountryRegionTree,
    buildEvolutionBase,
    buildTimeline,
    createEvolutionClock,
    dateToDayNumber,
    dayIndexOf,
    dateOfDayIndex,
    endEvolution,
    evolutionFrameVariables,
    eventsInRange,
    filterRows,
    isoToDayNumber,
    maxEventsInWindow,
    stepEvolution,
} from './static/js/evolution_timeline.mjs';
import { EVO_NEVER_DAY, EVO_STATIC_FROM } from './static/js/evolution_style.mjs';

// Jeu de données : placements triés, comme les renvoie le serveur.
//   A placée j0, jamais archivée           (France / Alsace)
//   B placée j2, archivée j5               (France / Bretagne)
//   C placée j2, archivée sans date        (France / —)
//   D placée j3, archivée j3               (Suisse / Vaud)
//   E placée j7, archivage incohérent j1   (France / Alsace)
const PAYLOAD = {
    dataset: { id: 1, name: 'Test', revision: 3 },
    origin: '2024-03-30',
    count: 5,
    code: ['GCA', 'GCB', 'GCC', 'GCD', 'GCE'],
    lon: [7.1, -3.2, 2.3, 6.6, 7.2],
    lat: [48.5, 48.1, 48.8, 46.5, 48.6],
    placed: [0, 2, 2, 3, 7],
    archived: [-1, 5, -1, 3, 1],
    status: [0, 1, 2, 1, 1],
    type: [0, 1, 0, 0, 1],
    types: ['Traditional Cache', 'Unknown Cache'],
    country: [0, 0, 0, 1, 0],
    countries: ['France', 'Suisse'],
    region: [0, 1, 2, 3, 0],
    regions: ['Alsace', 'Bretagne', '', 'Vaud'],
    meta: { snapshotDate: '2024-04-20' },
};

test('les jours suivent la date calendaire, changement d\'heure compris', () => {
    // Nuit du 30 au 31 mars 2024 : 23 h en France.
    assert.equal(isoToDayNumber('2024-03-31') - isoToDayNumber('2024-03-30'), 1);
    assert.equal(dateToDayNumber(new Date(2024, 2, 31)) - dateToDayNumber(new Date(2024, 2, 30)), 1);
    const base = buildEvolutionBase(PAYLOAD);
    assert.equal(dayIndexOf(base, new Date(2024, 3, 1)), 2);
    const d = dateOfDayIndex(base, 2);
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2024, 3, 1, 0]);
    assert.ok(Number.isNaN(isoToDayNumber('pas une date')));
});

test('la base convertit les colonnes et ramène un archivage incohérent au placement', () => {
    const base = buildEvolutionBase(PAYLOAD);
    assert.equal(base.count, 5);
    assert.deepEqual([...base.archived], [EVO_NEVER_DAY, 5, EVO_NEVER_DAY, 3, 7]);
    assert.equal(base.clampedArchives, 1);
    assert.ok(base.lon instanceof Float64Array);
});

test('arbre pays -> régions sans libellés vides', () => {
    const tree = buildCountryRegionTree(buildEvolutionBase(PAYLOAD));
    assert.deepEqual(tree, { France: ['Alsace', 'Bretagne'], Suisse: ['Vaud'] });
});

test('filtre Pays / Région : inactif, sélection, « Aucun », libellés vides toujours inclus', () => {
    const base = buildEvolutionBase(PAYLOAD);
    assert.deepEqual([...filterRows(base, {})], [0, 1, 2, 3, 4]);
    assert.deepEqual([...filterRows(base, { countries: ['France'], regions: null })], [0, 1, 2, 4]);
    // C (région inconnue) reste incluse quand on ne garde que l'Alsace.
    assert.deepEqual([...filterRows(base, { countries: ['France'], regions: ['Alsace'] })], [0, 2, 4]);
    assert.deepEqual([...filterRows(base, { countries: [], regions: ['Alsace'] })], []);
    assert.deepEqual([...filterRows(base, { countries: ['France'], regions: [] })], []);
});

test('chronologie : événements par jour et caches actives', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const rows = filterRows(base, {});
    const tl = buildTimeline(base, rows);
    assert.equal(tl.firstDay, 0);
    assert.equal(tl.lastDay, 7);
    // j0:A  j2:B,C  j3:D placée et archivée  j5:B archivée  j7:E placée et archivée
    assert.deepEqual([...tl.activeByDay], [1, 1, 3, 3, 3, 2, 2, 2]);
    assert.equal(tl.peakActive, 3);
    assert.equal(tl.maxEventsPerDay, 2);
    assert.equal(activeAt(tl, -4), 0);
    assert.equal(activeAt(tl, 4), 3);
    assert.equal(activeAt(tl, 100), 2);

    const ev = eventsInRange(tl, 2, 3);
    assert.deepEqual([...ev.placed], [1, 2, 3]);
    assert.deepEqual([...ev.archived], [3]);
    assert.deepEqual([...eventsInRange(tl, 5, 5).archived], [1]);
    assert.deepEqual([...eventsInRange(tl, 20, 30).placed], []);
    assert.equal(maxEventsInWindow(tl, 2), 4);
});

test('les index d\'événements désignent la position dans les lignes filtrées', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const rows = filterRows(base, { countries: ['Suisse'], regions: null });
    const tl = buildTimeline(base, rows);
    assert.deepEqual([...rows], [3]);
    assert.deepEqual([...eventsInRange(tl, 3, 3).placed], [0]);
    assert.deepEqual([...tl.activeByDay], [0]);
});

test('chronologie vide', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const tl = buildTimeline(base, new Int32Array(0));
    assert.equal(activeAt(tl, 3), 0);
    assert.equal(eventsInRange(tl, 0, 10).placed.length, 0);
    assert.equal(maxEventsInWindow(tl, 5), 0);
});

test('horloge : départ, pas, pause figée, fin libre, repos', () => {
    const clock = createEvolutionClock();
    clock.restDay = 7;
    assert.deepEqual(evolutionFrameVariables(clock, { now: 50 }).evoFrom, EVO_STATIC_FROM);
    assert.equal(evolutionFrameVariables(clock, { now: 50 }).evoDay, 7);

    beginEvolution(clock, 2, 1000);
    let v = evolutionFrameVariables(clock, { now: 1000, msPerDay: 100 });
    assert.deepEqual(v, { evoDay: 1, evoIntraMs: 0, evoFrom: 2, evoMsPerDay: 100, evoStagger: 0 });

    stepEvolution(clock, 2, 1000);
    assert.equal(evolutionFrameVariables(clock, { now: 1040, msPerDay: 100 }).evoIntraMs, 40);
    // Pause : le temps écoulé est plafonné à un jour, rien ne se termine ni ne
    // se rejoue à la reprise.
    assert.equal(evolutionFrameVariables(clock, { now: 90000, msPerDay: 100 }).evoIntraMs, 100);

    stepEvolution(clock, 3, 90000, true);
    assert.equal(evolutionFrameVariables(clock, { now: 95000, msPerDay: 100, stagger: true }).evoIntraMs, 5000);
    assert.equal(evolutionFrameVariables(clock, { now: 95000, msPerDay: 100, stagger: true }).evoStagger, 1);

    endEvolution(clock);
    assert.equal(evolutionFrameVariables(clock, { now: 96000 }).evoDay, 7);
});
