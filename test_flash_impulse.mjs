import test from 'node:test';
import assert from 'node:assert/strict';

import {
    IMPULSE_MAX_STAGGER_MS,
    impulseFrame,
    staggerDelayFrames,
    staggerDelayMs,
    staggerFraction,
} from './static/js/flash_impulse.mjs';

test('l\'anneau part du centre et finit à la même taille que les autres formes', () => {
    const start = impulseFrame(0, 40);
    const end = impulseFrame(1, 40);
    assert.equal(start.ringRadius, 4);          // size / 10
    assert.equal(end.ringRadius, 24);           // size / 10 + size / 2
    assert.equal(end.ringOpacity, 0);
    assert.equal(end.haloOpacity, 0);
});

test('l\'expansion est rapide au début puis ralentit', () => {
    const early = impulseFrame(0.3, 100);
    // Plus des trois quarts de l'expansion sont faits au premier tiers.
    assert.ok((early.ringRadius - 10) / 50 > 0.75);
});

test('l\'anneau reste opaque au début puis s\'efface progressivement', () => {
    assert.equal(impulseFrame(0.2, 40).ringOpacity, 1);
    assert.equal(impulseFrame(0.35, 40).ringOpacity, 1);
    const values = [0.4, 0.6, 0.8, 0.95].map((t) => impulseFrame(t, 40).ringOpacity);
    for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1]);
});

test('le halo s\'éteint plus vite que l\'anneau', () => {
    const mid = impulseFrame(0.5, 40);
    assert.ok(mid.haloOpacity < mid.ringOpacity);
});

test('une entrée hors bornes ou invalide ne produit pas de NaN', () => {
    for (const frame of [impulseFrame(-1, 40), impulseFrame(2, 40), impulseFrame(NaN, 'x')]) {
        for (const value of Object.values(frame)) assert.ok(Number.isFinite(value));
    }
});

test('le décalage est stable pour un même point et borné', () => {
    assert.equal(staggerFraction(2.35, 48.85), staggerFraction(2.35, 48.85));
    for (let i = 0; i < 500; i++) {
        const f = staggerFraction(-5 + i * 0.037, 42 + i * 0.013);
        assert.ok(f >= 0 && f < 1);
        const ms = staggerDelayMs(-5 + i * 0.037, 42 + i * 0.013);
        assert.ok(ms >= 0 && ms < IMPULSE_MAX_STAGGER_MS);
    }
});

test('des points voisins sont décalés différemment', () => {
    const delays = new Set();
    for (let i = 0; i < 20; i++) delays.add(Math.round(staggerDelayMs(2.35 + i * 0.001, 48.85)));
    assert.ok(delays.size > 10);
});

test('le décalage en captures correspond au même temps vidéo quel que soit le fps', () => {
    const ms = staggerDelayMs(2.35, 48.85);
    // Flash de 600 ms : 18 captures à 30 fps, 36 à 60 fps.
    assert.equal(staggerDelayFrames(2.35, 48.85, 18, 600), Math.round(ms * 30 / 1000));
    assert.equal(staggerDelayFrames(2.35, 48.85, 36, 600), Math.round(ms * 60 / 1000));
    assert.equal(staggerDelayFrames(2.35, 48.85, 18, 0), 0);
});
