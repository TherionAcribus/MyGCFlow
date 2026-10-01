import test from 'node:test';
import assert from 'node:assert/strict';

import { targetFrame } from './static/js/flash_target.mjs';

test('le réticule converge puis se verrouille', () => {
    const size = 30;
    const start = targetFrame(0, size);
    const lock = targetFrame(0.6, size);
    const end = targetFrame(1, size);
    assert.ok(lock.ringRadius < start.ringRadius);
    // Après la convergence (60 % de la durée), la géométrie ne bouge plus.
    assert.equal(end.ringRadius, lock.ringRadius);
    assert.equal(end.tickOuter, lock.tickOuter);
});

test('les traits de visée se referment sur l\'anneau', () => {
    const size = 30;
    for (const t of [0, 0.3, 0.6, 1]) {
        const frame = targetFrame(t, size);
        assert.ok(frame.tickOuter > frame.tickInner);
        assert.ok(frame.tickInner > frame.ringRadius);
    }
    // À la fin, les traits touchent presque l'anneau verrouillé.
    const end = targetFrame(1, size);
    assert.ok(end.tickInner - end.ringRadius < 3);
});

test('le point central nait au verrouillage', () => {
    assert.equal(targetFrame(0.3, 30).dotOpacity, 0);
    assert.ok(targetFrame(0.7, 30).dotOpacity > 0);
});

test('apparition rapide, extinction en fin de course', () => {
    assert.equal(targetFrame(0, 30).ringOpacity, 0);
    assert.equal(targetFrame(0.3, 30).ringOpacity, 1);
    assert.ok(targetFrame(0.9, 30).ringOpacity < 1);
    assert.equal(targetFrame(1, 30).ringOpacity, 0);
});

test('entrées hors bornes ramenées dans [0, 1]', () => {
    assert.deepEqual(targetFrame(-1, 30), targetFrame(0, 30));
    assert.deepEqual(targetFrame(2, 30), targetFrame(1, 30));
    assert.equal(targetFrame(0.5, 'abc').ringRadius, 1);
});
