import test from 'node:test';
import assert from 'node:assert/strict';

import { createMapDirtyTracker, DEFAULT_KEEPALIVE_MS } from './static/js/map_dirty.mjs';

test('la première frame est toujours dessinée', () => {
    const tracker = createMapDirtyTracker();
    assert.equal(tracker.shouldDraw(0, 'sig'), true);
});

test('une carte inchangée ne redéclenche pas de rendu avant le rafraîchissement de sécurité', () => {
    const tracker = createMapDirtyTracker({ keepAliveMs: 250 });
    tracker.noteDraw(1000, 'sig');
    assert.equal(tracker.shouldDraw(1033, 'sig'), false);
    assert.equal(tracker.shouldDraw(1200, 'sig'), false);
    // Sans dessin, captureStream n'émet plus rien : on redessine quand même.
    assert.equal(tracker.shouldDraw(1250, 'sig'), true);
});

test('un changement de carte est consommé par un seul dessin', () => {
    const tracker = createMapDirtyTracker();
    tracker.noteDraw(1000, 'sig');
    tracker.markDirty();
    assert.equal(tracker.shouldDraw(1010, 'sig'), true);
    tracker.noteDraw(1010, 'sig');
    assert.equal(tracker.shouldDraw(1020, 'sig'), false);
});

test('un flash en cours force le rendu de chaque frame', () => {
    const tracker = createMapDirtyTracker();
    tracker.beginAnimation();
    tracker.beginAnimation();
    tracker.noteDraw(1000, 'sig');
    assert.equal(tracker.shouldDraw(1010, 'sig'), true);

    tracker.endAnimation();
    tracker.noteDraw(1010, 'sig');
    assert.equal(tracker.shouldDraw(1020, 'sig'), true);

    tracker.endAnimation();
    tracker.noteDraw(1020, 'sig');
    assert.equal(tracker.animationCount, 0);
    assert.equal(tracker.shouldDraw(1030, 'sig'), false);
});

test('le compteur d\'animations ne devient jamais négatif et se réinitialise avec la couche', () => {
    const tracker = createMapDirtyTracker();
    tracker.endAnimation();
    assert.equal(tracker.animationCount, 0);

    tracker.beginAnimation();
    tracker.beginAnimation();
    tracker.resetAnimations();
    assert.equal(tracker.animationCount, 0);
});

test('un changement de contenu des overlays déclenche un rendu sans changement de carte', () => {
    const tracker = createMapDirtyTracker();
    tracker.noteDraw(1000, '0 Titre 12 - 01/01/2020');
    assert.equal(tracker.shouldDraw(1010, '0 Titre 12 - 01/01/2020'), false);
    assert.equal(tracker.shouldDraw(1010, '0 Titre 13 - 02/01/2020'), true);
});

test('reset repart d\'un état neuf', () => {
    const tracker = createMapDirtyTracker();
    tracker.beginAnimation();
    tracker.noteDraw(1000, 'sig');
    tracker.reset();
    assert.equal(tracker.animationCount, 0);
    assert.equal(tracker.shouldDraw(1000, 'sig'), true);
});

test('le rafraîchissement de sécurité a une valeur par défaut exploitable', () => {
    assert.ok(DEFAULT_KEEPALIVE_MS > 0 && DEFAULT_KEEPALIVE_MS <= 500);
    const tracker = createMapDirtyTracker({ keepAliveMs: 'invalide' });
    tracker.noteDraw(0, 'sig');
    assert.equal(tracker.shouldDraw(DEFAULT_KEEPALIVE_MS - 1, 'sig'), false);
    assert.equal(tracker.shouldDraw(DEFAULT_KEEPALIVE_MS, 'sig'), true);
});
