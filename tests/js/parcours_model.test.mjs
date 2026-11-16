// Page Parcours : modèle pur des étapes (static/js/parcours_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    orderParcours,
    parcoursExtent,
    parcoursStops,
    provisionalDayOrder,
    rangeDayCount,
} from '../../static/js/parcours_model.mjs';

const stop = (key, extra = {}) => ({ key, kind: 'find', lon: 5, lat: 45, logId: null, localTime: null, ...extra });

test('ordre provisoire : saisie des logs, puis heure des Labs, puis le reste', () => {
    const ordered = provisionalDayOrder([
        stop('GC9'),
        stop('lab:b', { kind: 'lab', localTime: '14:05:00' }),
        stop('GC2', { logId: 502 }),
        stop('lab:a', { kind: 'lab', localTime: '09:30:00' }),
        stop('dnf:400', { kind: 'dnf', logId: 400 }),
        stop('GC1'),
    ]);
    assert.deepEqual(ordered.map((s) => s.key), ['dnf:400', 'GC2', 'lab:a', 'lab:b', 'GC1', 'GC9']);
});

test('ordre provisoire : les étapes sans position valide sont écartées', () => {
    const ordered = provisionalDayOrder([
        stop('GC1', { lon: null }),
        stop('GC2', { lat: 91 }),
        stop('GC3', { lon: 540 }),
        stop(''),
        stop('GC4'),
    ]);
    assert.deepEqual(ordered.map((s) => s.key), ['GC4']);
    assert.deepEqual(provisionalDayOrder(null), []);
});

test('parcours ordonné : jours triés, numérotation globale et par jour', () => {
    const result = orderParcours({
        days: [
            { date: '2025-07-13', stops: [stop('GC3', { logId: 2 })] },
            { date: '2025-07-12', stops: [stop('GC2', { logId: 9 }), stop('GC1', { logId: 1 }), stop('GCX', { lon: NaN })] },
            { date: '2025-07-14', stops: [] },
        ],
    });
    assert.deepEqual(result.days.map((d) => d.date), ['2025-07-12', '2025-07-13', '2025-07-14']);
    assert.deepEqual(parcoursStops(result).map((s) => [s.key, s.index, s.dayIndex]),
        [['GC1', 1, 1], ['GC2', 2, 2], ['GC3', 3, 1]]);
    assert.equal(result.stopCount, 3);
    assert.equal(result.dropped, 1);
    assert.deepEqual(orderParcours(null), { days: [], stopCount: 0, dropped: 0 });
});

test('emprise des étapes', () => {
    assert.deepEqual(parcoursExtent([stop('a', { lon: 5, lat: 45 }), stop('b', { lon: 6.5, lat: 44 }), stop('c', { lat: NaN })]),
        [5, 44, 6.5, 45]);
    assert.equal(parcoursExtent([]), null);
});

test('nombre de jours d’une plage, bornes comprises', () => {
    assert.equal(rangeDayCount('2025-07-12', '2025-07-12'), 1);
    assert.equal(rangeDayCount('2025-07-12', '2025-07-20'), 9);
    // Changement d'heure d'octobre : calcul en UTC, pas de demi-journée perdue.
    assert.equal(rangeDayCount('2025-10-25', '2025-10-27'), 3);
    assert.equal(rangeDayCount('2025-07-13', '2025-07-12'), 0);
    assert.equal(rangeDayCount('13/07/2025', '2025-07-12'), 0);
});
