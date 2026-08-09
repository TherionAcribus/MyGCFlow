import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createUploadBatcher,
    normalizeBatchSize,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
} from './static/js/upload_batcher.mjs';

// Ordonnanceur de timers contrôlé : évite toute attente réelle dans les tests.
function fakeTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        scheduleTimer(fn) {
            const id = nextId++;
            pending.set(id, fn);
            return id;
        },
        cancelTimer(id) {
            pending.delete(id);
        },
        get scheduled() { return pending.size; },
        fire() {
            const callbacks = [...pending.values()];
            pending.clear();
            callbacks.forEach(fn => fn());
        },
    };
}

test('les tailles de lot invalides retombent sur le défaut et restent bornées', () => {
    assert.equal(normalizeBatchSize(undefined), DEFAULT_BATCH_SIZE);
    assert.equal(normalizeBatchSize('abc'), DEFAULT_BATCH_SIZE);
    assert.equal(normalizeBatchSize(0), 1);
    assert.equal(normalizeBatchSize(-5), 1);
    assert.equal(normalizeBatchSize(10_000), MAX_BATCH_SIZE);
    assert.equal(normalizeBatchSize('16'), 16);
    assert.equal(normalizeBatchSize(12.7), 12);
});

test('un lot part dès qu’il est plein, en une seule requête', async () => {
    const sent = [];
    const timers = fakeTimers();
    const batcher = createUploadBatcher({
        batchSize: 3,
        send: (payloads) => { sent.push(payloads); return Promise.resolve({ success: true }); },
        ...timers,
    });

    const p1 = batcher.add('a');
    const p2 = batcher.add('b');
    assert.equal(sent.length, 0, 'lot incomplet : rien ne part');
    assert.equal(batcher.bufferedCount, 2);

    const p3 = batcher.add('c');
    await Promise.all([p1, p2, p3]);

    assert.equal(sent.length, 1, 'une seule requête pour 3 images');
    assert.deepEqual(sent[0], ['a', 'b', 'c']);
    assert.equal(batcher.bufferedCount, 0);
    assert.equal(timers.scheduled, 0, 'le timer d’attente est annulé quand le lot part');
});

test('un lot incomplet part au bout du délai d’attente', async () => {
    const sent = [];
    const timers = fakeTimers();
    const batcher = createUploadBatcher({
        batchSize: 10,
        maxWaitMs: 500,
        send: (payloads) => { sent.push(payloads); return Promise.resolve(null); },
        ...timers,
    });

    const p = batcher.add('seule');
    assert.equal(timers.scheduled, 1);
    timers.fire();
    await p;

    assert.deepEqual(sent, [['seule']]);
});

test('flush() envoie immédiatement le lot partiel', async () => {
    const sent = [];
    const timers = fakeTimers();
    const batcher = createUploadBatcher({
        batchSize: 20,
        send: (payloads) => { sent.push(payloads); return Promise.resolve(null); },
        ...timers,
    });

    const p1 = batcher.add(1);
    const p2 = batcher.add(2);
    await batcher.flush();
    await Promise.all([p1, p2]);

    assert.deepEqual(sent, [[1, 2]]);
    assert.equal(timers.scheduled, 0);
    // Un flush à vide est neutre (pas de requête parasite en fin d'enregistrement).
    assert.equal(await batcher.flush(), null);
    assert.equal(sent.length, 1);
});

test('une taille de lot de 1 conserve le comportement image par image', async () => {
    const sent = [];
    const batcher = createUploadBatcher({
        batchSize: 1,
        send: (payloads) => { sent.push(payloads); return Promise.resolve(null); },
        ...fakeTimers(),
    });

    await Promise.all([batcher.add('x'), batcher.add('y')]);
    assert.deepEqual(sent, [['x'], ['y']]);
});

test('l’échec d’un lot est propagé à chacune de ses images', async () => {
    const boom = new Error('HTTP 500');
    const batcher = createUploadBatcher({
        batchSize: 2,
        send: () => Promise.reject(boom),
        ...fakeTimers(),
    });

    const results = await Promise.allSettled([batcher.add('a'), batcher.add('b')]);
    assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
    results.forEach(r => assert.equal(r.reason, boom));
});

test('drain() vide le tampon puis attend les lots en vol', async () => {
    const sent = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const batcher = createUploadBatcher({
        batchSize: 2,
        send: async (payloads) => { sent.push(payloads); await gate; },
        ...fakeTimers(),
    });

    batcher.add('a');
    batcher.add('b');          // lot plein → parti
    const pending = batcher.add('c'); // reste en tampon
    assert.equal(batcher.batchesInFlight, 1);

    const drained = batcher.drain();
    release();
    await drained;

    assert.deepEqual(sent, [['a', 'b'], ['c']]);
    assert.equal(batcher.bufferedCount, 0);
    assert.equal(batcher.batchesInFlight, 0);
    await pending;
});

test('reset() abandonne le tampon sans laisser de promesse en suspens', async () => {
    const timers = fakeTimers();
    const batcher = createUploadBatcher({
        batchSize: 5,
        send: () => Promise.resolve(null),
        ...timers,
    });

    const p = batcher.add('orpheline');
    batcher.reset('Enregistrement réinitialisé');

    await assert.rejects(p, /Enregistrement réinitialisé/);
    assert.equal(batcher.bufferedCount, 0);
    assert.equal(timers.scheduled, 0, 'le timer d’attente est annulé');
});
