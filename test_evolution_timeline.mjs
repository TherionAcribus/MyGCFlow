import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activeAt,
    beginEvolution,
    buildCountryRegionTree,
    buildEvolutionBase,
    buildRegionCountyTree,
    buildTimeline,
    counterAt,
    counterMaxFor,
    createEvolutionClock,
    dateToDayNumber,
    dayIndexOf,
    dateOfDayIndex,
    endEvolution,
    evolutionFrameVariables,
    eventsInRange,
    filterRows,
    isoToDayNumber,
    lonLatExtentOf,
    maxEventsInWindow,
    stepEvolution,
} from './static/js/evolution_timeline.mjs';
import { EVO_NEVER_DAY, EVO_STATIC_FROM } from './static/js/evolution_style.mjs';

// Jeu de données : placements triés, comme les renvoie le serveur.
//   A placée j0, jamais archivée           (France / Alsace / Bas-Rhin, Tradi Small 1.5/2)
//   B placée j2, archivée j5               (France / Bretagne / Finistère, Mystery Micro 3/3.5)
//   C placée j2, archivée sans date        (France / — / Bas-Rhin, Tradi Regular, D inconnue, T2)
//   D placée j3, archivée j3               (Suisse / Vaud / —, Tradi Small 1.5/3.5)
//   E placée j7, archivage incohérent j1   (France / Alsace / Bas-Rhin, Mystery, taille et D inconnues, T3.5)
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
    size: [0, 1, 2, 0, 3],
    sizes: ['Small', 'Micro', 'Regular', ''],
    difficulty: [0, 1, 2, 0, 2],
    difficulties: ['1.5', '3', ''],
    terrain: [0, 1, 0, 1, 1],
    terrains: ['2', '3.5'],
    country: [0, 0, 0, 1, 0],
    countries: ['France', 'Suisse'],
    region: [0, 1, 2, 3, 0],
    regions: ['Alsace', 'Bretagne', '', 'Vaud'],
    county: [0, 1, 0, 2, 0],
    counties: ['Bas-Rhin', 'Finistère', ''],
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

test('arbre région -> départements sans libellés vides', () => {
    const tree = buildRegionCountyTree(buildEvolutionBase(PAYLOAD));
    // C a un département (Bas-Rhin) mais pas de région : ignoré, une région
    // vide n'est pas une clé. Vaud (D) n'a pas de département : la région
    // reste une clé avec une liste vide, pour que le select Département
    // n'affiche rien quand seule cette région est retenue.
    assert.deepEqual(tree, { Alsace: ['Bas-Rhin'], Bretagne: ['Finistère'], Vaud: [] });
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

test('filtres Type / Taille / D / T / Département : combinés, « Aucun », libellés vides', () => {
    const base = buildEvolutionBase(PAYLOAD);
    // Type seul.
    assert.deepEqual([...filterRows(base, { types: ['Unknown Cache'] })], [1, 4]);
    // Taille + région combinés : E (taille inconnue) et C (région inconnue)
    // passent leur critère vide mais C n'est pas Small.
    assert.deepEqual(
        [...filterRows(base, { sizes: ['Small'], regions: ['Alsace', 'Vaud'] })],
        [0, 3, 4]);
    // « Aucun » sur n'importe quel critère : rien ne passe.
    assert.deepEqual([...filterRows(base, { types: [] })], []);
    assert.deepEqual([...filterRows(base, { sizes: ['Small'], counties: [] })], []);
    // C et E n'ont pas de difficulté : un filtre difficulté les conserve.
    assert.deepEqual([...filterRows(base, { difficulties: ['1.5'] })], [0, 2, 3, 4]);
    // D n'a pas de département : il passe aussi un filtre département actif.
    assert.deepEqual([...filterRows(base, { counties: ['Bas-Rhin'] })], [0, 2, 3, 4]);
    // Critère null : inactif ; seul le terrain filtre ici.
    assert.deepEqual([...filterRows(base, { types: null, terrains: ['2'] })], [0, 2]);
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

test('compteur configurable : cumuls placées/archivées jour par jour', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const tl = buildTimeline(base, filterRows(base, {}));
    // j0:A  j2:B,C  j3:D placée ET archivée  j5:B archivée  j7:E placée ET archivée
    assert.equal(counterAt(tl, 0, 'placed'), 1);
    assert.equal(counterAt(tl, 1, 'placed'), 1);
    assert.equal(counterAt(tl, 2, 'placed'), 3);
    assert.equal(counterAt(tl, 3, 'placed'), 4);
    assert.equal(counterAt(tl, 7, 'placed'), 5);
    assert.equal(counterAt(tl, 2, 'archived'), 0);
    assert.equal(counterAt(tl, 3, 'archived'), 1);
    assert.equal(counterAt(tl, 5, 'archived'), 2);
    assert.equal(counterAt(tl, 7, 'archived'), 3);
    // D et E, placées et archivées le même jour, comptent dans les deux
    // cumuls mais ne changent pas les actives (net nul).
    assert.equal(counterAt(tl, 3, 'placed') - counterAt(tl, 2, 'placed'), 1);
    assert.equal(counterAt(tl, 3, 'archived') - counterAt(tl, 2, 'archived'), 1);
    assert.equal(counterAt(tl, 3), counterAt(tl, 2));
    assert.equal(counterAt(tl, 7, 'placed') - counterAt(tl, 6, 'placed'), 1);
    assert.equal(counterAt(tl, 7, 'archived') - counterAt(tl, 6, 'archived'), 1);
    assert.equal(counterAt(tl, 7), counterAt(tl, 6));
});

test('compteur configurable : hors bornes, jour non fini et mode inconnu', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const tl = buildTimeline(base, filterRows(base, {}));
    // Avant le premier jour : 0 ; après le dernier : le total cumulé.
    assert.equal(counterAt(tl, -4, 'placed'), 0);
    assert.equal(counterAt(tl, -4, 'archived'), 0);
    assert.equal(counterAt(tl, 100, 'placed'), 5);
    assert.equal(counterAt(tl, 100, 'archived'), 3);
    // Un jour non fini indexerait hors des sommes préfixées : 0.
    assert.equal(counterAt(tl, NaN, 'placed'), 0);
    assert.equal(counterAt(tl, Infinity, 'archived'), 0);
    assert.equal(counterAt(null, 3, 'placed'), 0);
    // Mode absent ou inconnu : comportement historique (caches actives).
    assert.equal(counterAt(tl, 4), 3);
    assert.equal(counterAt(tl, 4, 'active'), 3);
    assert.equal(counterAt(tl, 4, 'trouvailles'), activeAt(tl, 4));
});

test('compteur configurable : valeur maximale selon le mode', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const tl = buildTimeline(base, filterRows(base, {}));
    assert.equal(counterMaxFor(tl, 'active'), 3);    // pic d'actives
    assert.equal(counterMaxFor(tl, 'placed'), 5);    // total des placements
    assert.equal(counterMaxFor(tl, 'archived'), 3);  // total des archivages
    assert.equal(counterMaxFor(tl, 'autre'), 3);     // repli sur le pic
    assert.equal(counterMaxFor(null, 'placed'), 0);
    const empty = buildTimeline(base, new Int32Array(0));
    assert.equal(counterAt(empty, 3, 'placed'), 0);
    assert.equal(counterMaxFor(empty, 'archived'), 0);
});

test('les index d\'événements désignent la position dans les lignes filtrées', () => {
    const base = buildEvolutionBase(PAYLOAD);
    const rows = filterRows(base, { countries: ['Suisse'], regions: null });
    const tl = buildTimeline(base, rows);
    assert.deepEqual([...rows], [3]);
    assert.deepEqual([...eventsInRange(tl, 3, 3).placed], [0]);
    assert.deepEqual([...tl.activeByDay], [0]);
});

test('étendue des caches : cas courant, aucune ligne, zone à cheval sur l\'antiméridien', () => {
    const base = buildEvolutionBase(PAYLOAD);
    assert.deepEqual(lonLatExtentOf(base, Int32Array.from([0, 1, 3])), [-3.2, 46.5, 7.1, 48.5]);
    assert.equal(lonLatExtentOf(base, new Int32Array(0)), null);

    // Fidji : de 177° E à 179° O. Mesurée telle quelle, l'étendue ferait le
    // tour du globe ; ramenée dans [0, 360[, elle reste étroite.
    const fiji = buildEvolutionBase({
        origin: '2024-01-01', code: ['GC1', 'GC2', 'GC3'],
        lon: [177.4, 179.9, -179.2], lat: [-18.1, -16.8, -16.5], placed: [0, 0, 0], archived: [-1, -1, -1],
    });
    assert.deepEqual(lonLatExtentOf(fiji, Int32Array.from([0, 1, 2])).map((v) => Math.round(v * 10) / 10),
        [177.4, -18.1, 180.8, -16.5]);
    // Toutes à l'ouest de Greenwich : rien à ramener.
    const americas = buildEvolutionBase({
        origin: '2024-01-01', code: ['GC1', 'GC2'],
        lon: [-120, -70], lat: [40, 10], placed: [0, 0], archived: [-1, -1],
    });
    assert.deepEqual(lonLatExtentOf(americas, Int32Array.from([0, 1])), [-120, 10, -70, 40]);
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
