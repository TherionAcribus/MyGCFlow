import test from 'node:test';
import assert from 'node:assert/strict';

import {
    COLOR_FIDELITIES,
    DEFAULT_COLOR_FIDELITY,
    normalizeColorFidelity,
} from './static/js/color_fidelity.mjs';

test('le défaut est le format lisible partout', () => {
    // Un fichier illisible chez le destinataire est pire qu'un fichier un peu
    // moins net : le 4:4:4 ne doit jamais s'appliquer sans choix explicite.
    assert.equal(DEFAULT_COLOR_FIDELITY, 'compatible');
    assert.deepEqual([...COLOR_FIDELITIES], ['compatible', 'fidele']);
});

test('les deux valeurs connues passent telles quelles', () => {
    assert.equal(normalizeColorFidelity('compatible'), 'compatible');
    assert.equal(normalizeColorFidelity('fidele'), 'fidele');
});

test('toute autre valeur retombe sur le format compatible', () => {
    for (const value of ['yuv444p', 'FIDELE', '', null, undefined, 0, {}]) {
        assert.equal(normalizeColorFidelity(value), 'compatible');
    }
});
