// Mesure des libellés mémoïsée (course de barres, labelsMaxWidth).
// Le dessin n'est pas testé au pixel près (canvas) : seule la logique pure du
// cache l'est, avec un faux contexte — largeur = 10 px par caractère, appels
// comptés.
import test from 'node:test';
import assert from 'node:assert/strict';

import { labelsMaxWidth } from './static/js/stats_render.mjs';

function fakeCtx() {
    return {
        font: '',
        calls: 0,
        measureText(s) { this.calls += 1; return { width: String(s).length * 10 }; },
    };
}

test('labelsMaxWidth : le pool complet dépasse les seuls libellés affichés', () => {
    const ctx = fakeCtx();
    const allLabels = ['Court', 'Un nom de catégorie très long', 'Moyen'];
    const shown = ['Court', 'Moyen'];
    const width = labelsMaxWidth(ctx, allLabels, 'sig');
    assert.equal(width, 'Un nom de catégorie très long'.length * 10);
    assert.ok(width > Math.max(...shown.map((l) => ctx.measureText(l).width)));
});

test('labelsMaxWidth : mémoïsée par tableau, remesurée par signature de police', () => {
    const ctx = fakeCtx();
    const allLabels = ['aa', 'bbbbb'];
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f1'), 50);
    const calls = ctx.calls;
    // Même tableau + même signature : aucun measureText supplémentaire.
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f1'), 50);
    assert.equal(ctx.calls, calls);
    // Autre signature de police → remesurée.
    assert.equal(labelsMaxWidth(ctx, allLabels, 'f2'), 50);
    assert.equal(ctx.calls, calls + 2);
    // Un autre tableau, même contenu : cache distinct (clé = identité).
    assert.equal(labelsMaxWidth(ctx, ['aa', 'bbbbb'], 'f1'), 50);
    assert.equal(ctx.calls, calls + 4);
});
