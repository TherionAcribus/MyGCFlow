// Itinéraires d'un parcours (static/js/parcours_routing.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import {
    cacheKey,
    legModeFor,
    pendingRuns,
    routeEffects,
    routeRuns,
} from '../../static/js/parcours_routing.mjs';

const LON_PER_KM = 1 / (111.195 * Math.cos(45 * Math.PI / 180));
const stop = (key, km, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: 5 + km * LON_PER_KM, lat: 45, logId: null, localTime: null, ...extra,
});
// A —0,5 km— B —0,5 km— C —20 km— D —1 km— E (logs dans l'ordre).
const DAYS = [{
    date: '2025-07-12',
    stops: [stop('A', 0, { logId: 1 }), stop('B', 0.5, { logId: 2 }), stop('C', 1, { logId: 3 }),
        stop('D', 21, { logId: 4 }), stop('E', 22, { logId: 5 })],
}];

test('mode d’un trajet : imposé, sinon selon la distance', () => {
    assert.equal(legModeFor(0.8), 'walk');
    assert.equal(legModeFor(12), 'car');
    assert.equal(legModeFor(450), 'straight');
    assert.equal(legModeFor(12, 'bike'), 'bike');
    assert.equal(legModeFor(0.3, 'straight'), 'straight');
    assert.equal(legModeFor(0.3, 'avion'), 'walk');
});

test('requêtes : une par suite de même profil, ni ligne droite ni trace', () => {
    const recon = reconstructParcours({ days: DAYS });
    const runs = routeRuns(recon);
    assert.deepEqual(runs.map((r) => [r.profile, r.keys]), [
        ['foot', ['A>B', 'B>C']],
        ['car', ['C>D']],
        ['foot', ['D>E']],
    ]);
    assert.equal(runs[0].waypoints.length, 3);
    // Mode imposé et trajet déjà sur une trace.
    const forced = routeRuns(recon, new Map([['C', { legMode: 'straight' }], ['D', { legMode: 'bike' }]]),
        { skip: new Set(['A>B']) });
    assert.deepEqual(forced.map((r) => [r.profile, r.keys]), [['foot', ['B>C']], ['bike', ['D>E']]]);
});

test('effets : durées (stationnement compris en voiture), chemins, trajets manquants', () => {
    const recon = reconstructParcours({ days: DAYS });
    const runs = routeRuns(recon);
    const cache = new Map([
        [cacheKey('foot', 'A>B'), { path: [[5, 45], [5.003, 45.001], [5.006, 45]], distanceM: 650, durationS: 480 }],
        [cacheKey('foot', 'B>C'), { path: null }],                               // pas de route
        [cacheKey('car', 'C>D'), { path: [[1, 1], [2, 2]], distanceM: 26000, durationS: 1500 }],
    ]);
    const { hints, paths, missing } = routeEffects(runs, cache);
    assert.deepEqual(hints.get('A>B'), { minutes: 8, km: 0.65, mode: 'walk' });
    assert.deepEqual(hints.get('C>D'), { minutes: 25 + 5, km: 26, mode: 'car' });
    assert.equal(hints.has('B>C'), false);
    assert.deepEqual([...paths.keys()], ['A>B', 'C>D']);
    assert.equal(missing, 1);                                                   // D>E
    assert.deepEqual(pendingRuns(runs, cache).map((r) => r.keys), [['D>E']]);
});

test('reconstruction : la durée d’un itinéraire remplace l’estimation', () => {
    const before = reconstructParcours({ days: DAYS }).days[0].stops;
    const legHints = new Map([['C>D', { minutes: 90, km: 30, mode: 'car' }]]);
    const after = reconstructParcours({ days: DAYS }, { legHints }).days[0];
    const gap = (stops, a, b) => stops.find((s) => s.key === b).arrivalMin - stops.find((s) => s.key === a).arrivalMin;
    const visitC = after.stops.find((s) => s.key === 'C').visitMin;
    assert.equal(Math.round(gap(after.stops, 'C', 'D') - visitC), 90);
    assert.notEqual(Math.round(gap(before, 'C', 'D')), Math.round(gap(after.stops, 'C', 'D')));
    const leg = after.legs.find((l) => l.from === 'C');
    assert.deepEqual([leg.mode, leg.km, leg.routed], ['car', 30, true]);
    // Mode imposé, sans itinéraire : estimation au vélo.
    const bike = reconstructParcours({ days: DAYS, overrides: [{ key: 'C', legMode: 'bike' }] }).days[0];
    assert.equal(bike.legs.find((l) => l.from === 'C').mode, 'bike');
});
