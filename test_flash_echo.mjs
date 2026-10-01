import test from 'node:test';
import assert from 'node:assert/strict';

import { echoFrame } from './static/js/flash_echo.mjs';

test('l\'anneau principal suit la courbe des formes pleines', () => {
    const size = 30;
    const start = echoFrame(0, size);
    const end = echoFrame(1, size);
    const main = (f) => f.rings[1];
    assert.equal(main(start).radius, size / 10);
    assert.equal(main(end).radius, size / 2 + size / 10);
    assert.equal(main(start).opacity, 1);
    assert.equal(main(end).opacity, 0);
});

test('l\'écho part du point en retard sur l\'anneau principal', () => {
    const size = 30;
    const echo = (f) => f.rings[0];
    assert.equal(echo(echoFrame(0.2, size)).opacity, 0);
    assert.ok(echo(echoFrame(0.5, size)).opacity > 0);
    // Même retard que le décalage d'avancement : l'écho est toujours en retrait.
    for (const t of [0.5, 0.7, 0.9]) {
        const frame = echoFrame(t, size);
        assert.ok(echo(frame).radius < frame.rings[1].radius);
        assert.ok(echo(frame).width < frame.rings[1].width);
    }
});

test('l\'écho reste plus discret que l\'anneau principal', () => {
    for (const t of [0.5, 0.7, 0.9]) {
        const frame = echoFrame(t, 40);
        assert.ok(frame.rings[0].opacity <= frame.rings[1].opacity);
    }
});

test('entrées hors bornes ramenées dans [0, 1]', () => {
    assert.deepEqual(echoFrame(-1, 30), echoFrame(0, 30));
    assert.deepEqual(echoFrame(2, 30), echoFrame(1, 30));
    assert.equal(echoFrame(0.5, 'abc').rings[1].radius, 0);
});
