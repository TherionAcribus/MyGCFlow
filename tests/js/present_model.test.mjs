// Mode présentation de la page Statistiques (present_model.mjs) :
// diapositives, navigation, touches, délais.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PRESENT_DEFAULT_DELAY, keyAction, presentDelay, presentSlides, startIndex, stepIndex,
} from '../../static/js/present_model.mjs';

const item = (id) => ({ spec: { id } });

test('diapositives : les graphiques lisibles, dans l’ordre du tableau', () => {
    const results = new Map([
        ['a1', { result: {} }],
        ['b2', { result: null, error: ['dnf'] }],   // source en échec
        ['c3', { result: {} }],
    ]);
    assert.deepEqual(presentSlides([item('a1'), item('b2'), item('c3'), item('d4')], results), ['a1', 'c3']);
    assert.deepEqual(presentSlides(null, results), []);
});

test('départ : le graphique demandé, sinon le premier', () => {
    assert.equal(startIndex(['a1', 'c3'], 'c3'), 1);
    assert.equal(startIndex(['a1', 'c3'], 'zz'), 0);
    assert.equal(startIndex(['a1', 'c3']), 0);
});

test('navigation : bornée à la main, en boucle en défilement automatique', () => {
    assert.equal(stepIndex(0, 3, -1), 0);
    assert.equal(stepIndex(2, 3, 1), 2);
    assert.equal(stepIndex(1, 3, 1), 2);
    assert.equal(stepIndex(2, 3, 1, { loop: true }), 0);
    assert.equal(stepIndex(0, 3, -1, { loop: true }), 2);
    assert.equal(stepIndex(0, 0, 1), 0);
});

test('touches et délais', () => {
    assert.equal(keyAction('ArrowRight'), 'next');
    assert.equal(keyAction(' '), 'next');
    assert.equal(keyAction('PageUp'), 'prev');
    assert.equal(keyAction('Home'), 'first');
    assert.equal(keyAction('End'), 'last');
    assert.equal(keyAction('Escape'), 'close');
    assert.equal(keyAction('p'), 'toggle');
    assert.equal(keyAction('a'), null);
    assert.equal(presentDelay('20'), 20);
    assert.equal(presentDelay(7), PRESENT_DEFAULT_DELAY);
});
