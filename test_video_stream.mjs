// Tests du flux de délestage MediaRecorder (static/js/video_stream.mjs).
// Le fetch est simulé : on vérifie l'ordre des envois, la séquentialité
// (jamais deux appends en vol), la propagation d'erreur et l'abandon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVideoStream } from './static/js/video_stream.mjs';

// fetch factice : enregistre les appels ; optionalDelay/outcomes pilotent
// la concurrence et les échecs.
function fakeServer({ appendLatency = 0 } = {}) {
    const calls = [];
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url, opts });
        if (url.includes('append')) {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            if (appendLatency) await new Promise(r => setTimeout(r, appendLatency));
            inflight--;
        }
        if (url.includes('begin')) return jsonOk({ success: true, stream_id: 'abc123' });
        if (url.includes('finish')) return jsonOk({ success: true, file: 'mygcflow.webm' });
        return jsonOk({ success: true });
    };
    return { calls, fetchImpl, get maxInflight() { return maxInflight; } };
}

function jsonOk(obj, status = 200) {
    return { ok: status < 400, status, json: async () => obj };
}
function jsonErr(obj, status) {
    return { ok: false, status, json: async () => obj };
}

test('begin → push séquentiel → finish : ordre et index respectés', async () => {
    const srv = fakeServer({ appendLatency: 5 });
    const vs = createVideoStream({ fetchImpl: srv.fetchImpl });

    await vs.begin();
    for (let i = 0; i < 5; i++) vs.push(new Blob([`chunk${i}`]));
    const result = await vs.finish('out.webm');

    assert.equal(result.file, 'mygcflow.webm');
    const appends = srv.calls.filter(c => c.url.includes('append'));
    assert.equal(appends.length, 5);
    // Jamais deux appends en vol simultanés : la séquentialité conditionne
    // l'ordre d'écriture du fichier EBML.
    assert.equal(srv.maxInflight, 1);
    // Les index envoyés sont 0..4 dans l'ordre.
    const indexes = [];
    for (const c of appends) indexes.push(c.opts.body.get('index'));
    assert.deepEqual(indexes, ['0', '1', '2', '3', '4']);
});

test('push avant begin est ignoré silencieusement', async () => {
    const srv = fakeServer();
    const vs = createVideoStream({ fetchImpl: srv.fetchImpl });
    vs.push(new Blob(['x']));
    await vs.drain();
    assert.equal(srv.calls.length, 0);
});

test('un append en échec fait échouer drain() et bloque les suivants', async () => {
    const calls = [];
    let count = 0;
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.includes('begin')) return jsonOk({ success: true, stream_id: 's1' });
        if (url.includes('append') && count++ === 1) return jsonErr({ success: false, message: 'hors séquence' }, 409);
        return jsonOk({ success: true });
    };
    const vs = createVideoStream({ fetchImpl });
    await vs.begin();
    vs.push(new Blob(['a']));
    vs.push(new Blob(['b']));
    vs.push(new Blob(['c']));
    await assert.rejects(vs.drain(), /hors séquence/);
    assert.ok(vs.error);
    // Le troisième push a été court-circuité (failure déjà positionné à l'arrivée
    // du second) : maximum 2 appends partis.
    assert.ok(calls.filter(u => u.includes('append')).length <= 2);
});

test('finish sans flux ouvert rejette', async () => {
    const vs = createVideoStream({ fetchImpl: async () => jsonOk({ success: true }) });
    await assert.rejects(vs.finish('x.webm'));
});

test('abort purge le flux et le désactive', async () => {
    const srv = fakeServer();
    const vs = createVideoStream({ fetchImpl: srv.fetchImpl });
    await vs.begin();
    vs.push(new Blob(['a']));
    await vs.abort();
    assert.equal(vs.active, false);
    assert.ok(srv.calls.some(c => c.url.includes('abort')));
    // Les push suivants ne partent plus.
    vs.push(new Blob(['b']));
    await vs.drain();
    assert.equal(srv.calls.filter(c => c.url.includes('append')).length, 1);
});

test('erreur HTTP sur finish propage le message serveur', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('begin')) return jsonOk({ success: true, stream_id: 's2' });
        if (url.includes('finish')) return jsonErr({ success: false, message: 'Flux vidéo inconnu' }, 404);
        return jsonOk({ success: true });
    };
    const vs = createVideoStream({ fetchImpl });
    await vs.begin();
    await assert.rejects(vs.finish('x.webm'), /Flux vidéo inconnu/);
});
