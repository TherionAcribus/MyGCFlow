import test from 'node:test';
import assert from 'node:assert/strict';

import { fireworksFrame } from './static/js/flash_fireworks.mjs';

const reach = (frame) => Math.max(...frame.particles.map((p) => Math.hypot(p.x2, p.y2)));

test('les traînées jaillissent depuis le point', () => {
    const size = 40;
    const early = fireworksFrame(0.05, size);
    const mid = fireworksFrame(0.4, size);
    assert.ok(reach(mid) > reach(early));
    // Douze traînées dès le départ, les étincelles un peu après.
    assert.equal(early.particles.length, 12);
    assert.equal(mid.particles.length, 20);
});

test('les particules retombent (gravité)', () => {
    const frame = fireworksFrame(0.8, 40);
    // Traînée horizontale (angle 0) : sa pointe est passée sous l'horizon.
    assert.ok(frame.particles[0].y2 > 0);
});

test('l\'éclat central précède la gerbe et s\'éteint', () => {
    assert.ok(fireworksFrame(0.08, 40).coreOpacity > 0.9);
    assert.equal(fireworksFrame(0.5, 40).coreOpacity, 0);
});

test('tout s\'éteint à la fin', () => {
    assert.ok(fireworksFrame(0.5, 40).particleOpacity === 1);
    assert.equal(fireworksFrame(1, 40).particleOpacity, 0);
});

test('l\'étendue couvre toutes les particules', () => {
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
        const frame = fireworksFrame(t, 40);
        for (const p of frame.particles) {
            for (const v of [p.x1, p.y1, p.x2, p.y2]) assert.ok(Math.abs(v) <= frame.extent);
        }
    }
});

test('valeurs bornées hors de [0, 1]', () => {
    assert.deepEqual(fireworksFrame(-1, 40), fireworksFrame(0, 40));
    assert.deepEqual(fireworksFrame(2, 40), fireworksFrame(1, 40));
});
