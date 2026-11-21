// Parkings proposés comme lieux (static/js/parcours_parkings.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestParkings } from '../../static/js/parcours_parkings.mjs';

const days = [
    { date: '2025-07-12', stops: [{ code: 'GC1' }, { code: null }, { code: 'GC2' }, { code: 'GC3' }] },
    { date: '2025-07-13', stops: [{ code: 'GC4' }] },
];

test('par journée, dans l’ordre des étapes ; un parking partagé n’en fait qu’un', () => {
    const parkings = [
        { code: 'GC3', name: 'P3', lat: 45.2, lon: 5.2 },
        { code: 'GC1', name: 'P1', lat: 45.1, lon: 5.1 },
        // À ~15 m de P1 : le même parking.
        { code: 'GC2', name: null, lat: 45.10013, lon: 5.1 },
        { code: 'GC4', name: 'P4', lat: 45.4, lon: 5.4 },
        { code: 'GC9', name: 'Hors parcours', lat: 45.9, lon: 5.9 },
        { code: 'GC1', name: 'Sans position', lat: null, lon: 5 },
    ];
    const out = suggestParkings(days, parkings);
    assert.deepEqual([...out.keys()], ['2025-07-12', '2025-07-13']);
    assert.deepEqual(out.get('2025-07-12').map((p) => [p.name, p.codes]), [['P1', ['GC1', 'GC2']], ['P3', ['GC3']]]);
    assert.deepEqual(out.get('2025-07-13').map((p) => p.name), ['P4']);
});

test('un parking déjà posé comme lieu de la journée n’est plus proposé', () => {
    const parkings = [{ code: 'GC1', name: 'P1', lat: 45.1, lon: 5.1 }, { code: 'GC4', name: 'P4', lat: 45.1, lon: 5.1 }];
    const placed = [{ lat: 45.1002, lon: 5.1, date: '2025-07-12' }];
    const out = suggestParkings(days, parkings, placed);
    assert.equal(out.has('2025-07-12'), false);
    // Un lieu d'une autre journée ne compte pas ; une base sans date, si.
    assert.deepEqual(out.get('2025-07-13').map((p) => p.name), ['P4']);
    assert.equal(suggestParkings(days, parkings, [{ lat: 45.1, lon: 5.1, date: null }]).size, 0);
    assert.equal(suggestParkings(null, null).size, 0);
});
