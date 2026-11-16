// Page Parcours : utilitaires des étapes (static/js/parcours_model.mjs).
// L'ordre et les heures sont testés par parcours_reconstruct.test.mjs.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parcoursExtent, parcoursStops, rangeDayCount } from '../../static/js/parcours_model.mjs';

const stop = (key, extra = {}) => ({ key, lon: 5, lat: 45, ...extra });

test('étapes du parcours, dans l’ordre des jours', () => {
    const ordered = { days: [{ stops: [stop('a'), stop('b')] }, { stops: [] }, { stops: [stop('c')] }] };
    assert.deepEqual(parcoursStops(ordered).map((s) => s.key), ['a', 'b', 'c']);
    assert.deepEqual(parcoursStops(null), []);
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
