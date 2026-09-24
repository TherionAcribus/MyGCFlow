import test from 'node:test';
import assert from 'node:assert/strict';

import {
    centroid,
    clampToExtent,
    DEFAULT_RESPONSE_MS,
    smoothingFactor,
    stepCenter,
} from './static/js/camera_follow.mjs';

test('le lissage ne dépend pas de la cadence', () => {
    // Même durée totale, découpée en 1 pas ou en 10 : même chemin parcouru.
    const gros = smoothingFactor(1000, DEFAULT_RESPONSE_MS);
    let restant = 1;
    for (let i = 0; i < 10; i++) restant *= 1 - smoothingFactor(100, DEFAULT_RESPONSE_MS);
    assert.ok(Math.abs((1 - restant) - gros) < 1e-9);
});

test('la caméra dérive vers sa cible sans jamais la dépasser', () => {
    let center = [0, 0];
    const target = [1000, 0];
    for (let i = 0; i < 200; i++) {
        const step = stepCenter(center, target, 100, { resolution: 1, deadZonePx: 0 });
        assert.ok(step.center[0] >= center[0], 'la caméra ne recule pas');
        assert.ok(step.center[0] <= target[0], 'la caméra ne dépasse pas sa cible');
        center = step.center;
    }
    assert.ok(Math.abs(center[0] - 1000) < 1, 'la caméra finit par arriver');
});

test('la zone morte évite le frémissement permanent', () => {
    // 1,5 pixel d'écart avec une résolution de 10 unités par pixel.
    const step = stepCenter([0, 0], [15, 0], 100, { resolution: 10, deadZonePx: 2 });
    assert.equal(step.moved, false);
    assert.deepEqual(step.center, [0, 0]);

    const loin = stepCenter([0, 0], [100, 0], 100, { resolution: 10, deadZonePx: 2 });
    assert.equal(loin.moved, true);
});

test('un pas de durée nulle ne bouge pas la caméra', () => {
    const step = stepCenter([0, 0], [1000, 0], 0, { resolution: 1, deadZonePx: 0 });
    assert.equal(step.moved, false);
});

test('sans cible ou sans position, la caméra ne bouge pas', () => {
    assert.equal(stepCenter(null, [1, 1], 100).moved, false);
    assert.equal(stepCenter([0, 0], null, 100).moved, false);
});

test('la cible est ramenée dans l\'étendue des données', () => {
    const extent = [0, 0, 100, 100];
    assert.deepEqual(clampToExtent([500, 50], extent), [100, 50]);
    assert.deepEqual(clampToExtent([-20, 120], extent), [0, 100]);
    assert.deepEqual(clampToExtent([50, 50], extent), [50, 50]);
    // Étendue absente ou absurde : on ne touche à rien.
    assert.deepEqual(clampToExtent([500, 50], null), [500, 50]);
    assert.deepEqual(clampToExtent([500, 50], [10, 10, 0, 0]), [500, 50]);

    // Un point isolé hors zone ne peut donc pas emmener la caméra dans le vide.
    const step = stepCenter([0, 0], [10_000, 0], 5000, { resolution: 1, deadZonePx: 0, extent });
    assert.ok(step.center[0] <= 100);
});

test('le barycentre ignore les coordonnées invalides', () => {
    assert.deepEqual(centroid([[0, 0], [10, 20]]), [5, 10]);
    assert.deepEqual(centroid([[0, 0], [NaN, 5], null, [10, 10]]), [5, 5]);
    assert.equal(centroid([]), null);
    assert.equal(centroid(null), null);
    assert.equal(centroid([[NaN, NaN]]), null);
});
