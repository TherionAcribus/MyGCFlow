import test from 'node:test';
import assert from 'node:assert/strict';

import { implodeFrame } from './static/js/flash_implode.mjs';

test('l\'anneau part large et se referme sur le point', () => {
    const size = 30;
    const start = implodeFrame(0, size);
    const middle = implodeFrame(0.5, size);
    const end = implodeFrame(1, size);
    assert.equal(start.ringRadius, size / 2 + size / 10);
    assert.ok(middle.ringRadius < start.ringRadius);
    assert.ok(end.ringRadius < middle.ringRadius);
    assert.equal(end.ringRadius, 1);
});

test('le rayon ne fait que décroître et le trait s\'épaissit', () => {
    let previous = implodeFrame(0, 40);
    for (let i = 1; i <= 20; i++) {
        const frame = implodeFrame(i / 20, 40);
        assert.ok(frame.ringRadius <= previous.ringRadius);
        assert.ok(frame.ringWidth >= previous.ringWidth);
        previous = frame;
    }
});

test('apparition rapide, extinction au moment où l\'anneau se referme', () => {
    assert.equal(implodeFrame(0, 30).ringOpacity, 0);
    assert.equal(implodeFrame(0.2, 30).ringOpacity, 1);
    assert.equal(implodeFrame(0.6, 30).ringOpacity, 1);
    assert.ok(implodeFrame(0.85, 30).ringOpacity < 1);
    assert.equal(implodeFrame(1, 30).ringOpacity, 0);
});

test('entrées hors bornes ramenées dans [0, 1]', () => {
    assert.deepEqual(implodeFrame(-1, 30), implodeFrame(0, 30));
    assert.deepEqual(implodeFrame(2, 30), implodeFrame(1, 30));
    assert.equal(implodeFrame(0.5, 'abc').ringRadius, 1);
});
