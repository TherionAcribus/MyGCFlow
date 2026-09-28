import test from 'node:test';
import assert from 'node:assert/strict';
import { createPausableTimeout } from './static/js/pausable_timer.mjs';

// Timers simulés : setTimer renvoie un id et mémorise (delay, cb) pour qu'on
// puisse les déclencher manuellement ; now() est piloté par le test.
function fakeTimers() {
    let nextId = 1;
    let clock = 0;
    const scheduled = new Map();
    return {
        now: () => clock,
        advance(ms) { clock += ms; },
        setTimer(cb, ms) {
            const id = nextId++;
            scheduled.set(id, { cb, ms });
            return id;
        },
        clearTimer(id) { scheduled.delete(id); },
        // Déclenche le rappel en attente et renvoie sa durée programmée.
        fire(id) {
            const t = scheduled.get(id);
            if (!t) return null;
            scheduled.delete(id);
            t.cb();
            return t.ms;
        },
        pending() { return [...scheduled.keys()]; },
        scheduled,
    };
}

test('arm() programme le rappel et il se déclenche', () => {
    const T = fakeTimers();
    let fired = 0;
    const timer = createPausableTimeout(() => fired++, T);
    timer.arm(100);
    assert.equal(timer.pending, true);
    const id = T.pending()[0];
    assert.equal(T.fire(id), 100);
    assert.equal(fired, 1);
    assert.equal(timer.pending, false);
});

test('pause() fige le temps restant, resume() le réécoule', () => {
    const T = fakeTimers();
    let fired = 0;
    const timer = createPausableTimeout(() => fired++, T);
    timer.arm(1000);
    T.advance(400);
    timer.pause();
    // Le temps masqué ne doit pas consommer le minuteur.
    T.advance(60000);
    assert.equal(fired, 0);
    timer.resume();
    const id = T.pending()[0];
    // 1000 - 400 écoulés = 600 restants.
    assert.equal(T.fire(id), 600);
    assert.equal(fired, 1);
});

test('pause() sans minuteur actif est sans effet', () => {
    const T = fakeTimers();
    const timer = createPausableTimeout(() => {}, T);
    timer.pause();
    timer.resume();
    assert.equal(T.pending().length, 0);
    assert.equal(timer.pending, false);
});

test('clear() annule définitivement', () => {
    const T = fakeTimers();
    let fired = 0;
    const timer = createPausableTimeout(() => fired++, T);
    timer.arm(500);
    timer.clear();
    assert.equal(T.pending().length, 0);
    assert.equal(timer.pending, false);
});

test('arm() remplace une programmation en cours', () => {
    const T = fakeTimers();
    const calls = [];
    const timer = createPausableTimeout(() => calls.push('cb'), T);
    timer.arm(500);
    timer.arm(800);
    assert.equal(T.pending().length, 1);
    const id = T.pending()[0];
    assert.equal(T.fire(id), 800);
    assert.deepEqual(calls, ['cb']);
});

test('arm(0) déclenche le rappel immédiatement et de façon synchrone', () => {
    const T = fakeTimers();
    let fired = 0;
    const timer = createPausableTimeout(() => fired++, T);
    timer.arm(0);
    assert.equal(fired, 1);
    assert.equal(timer.pending, false);
});

test('les pauses cumulées décalent le rappel d’autant', () => {
    const T = fakeTimers();
    let fired = 0;
    const timer = createPausableTimeout(() => fired++, T);
    timer.arm(1000);
    T.advance(100); timer.pause();
    T.advance(5000); timer.resume();
    T.advance(200); timer.pause();
    T.advance(5000); timer.resume();
    const id = T.pending()[0];
    // 1000 - (100 + 200) actifs = 700 restants, malgré 10 s de pause.
    assert.equal(T.fire(id), 700);
    assert.equal(fired, 1);
});
