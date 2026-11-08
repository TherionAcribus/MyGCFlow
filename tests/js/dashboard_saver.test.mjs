// File d'écriture des tableaux de bord (dashboard_saver.mjs) :
// sérialisation des envois, « le plus récent gagne », rétention après échec.

import test from 'node:test';
import assert from 'node:assert/strict';

import { KEEPALIVE_MAX_BYTES, closingSaveRequest, createSaveQueue } from '../../static/js/dashboard_saver.mjs';

// send pilotable : chaque appel est enregistré, la promesse résout au déblocage.
function recorder(results = []) {
    const calls = [];
    const waits = [];
    const send = (doc, rev) => {
        calls.push({ doc, rev });
        const scripted = results.length ? results[calls.length - 1] : undefined;
        if (scripted !== undefined) return Promise.resolve(scripted);
        return new Promise((resolve) => waits.push(resolve));
    };
    return { calls, waits, send };
}

test('un push seul envoie le document avec la révision courante', async () => {
    const { calls, send } = recorder([{ ok: true, rev: 'r1' }]);
    const queue = createSaveQueue(send);
    const out = await queue.push({ v: 1 }, 'r0');
    assert.deepEqual(out, { ok: true, rev: 'r1' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { doc: { v: 1 }, rev: 'r0' });
    assert.equal(queue.pending, false);
});

test('la révision renvoyée devient la base de l\'envoi suivant', async () => {
    const { calls, send } = recorder([{ ok: true, rev: 'r1' }, { ok: true, rev: 'r2' }]);
    const queue = createSaveQueue(send);
    await queue.push({ v: 1 }, 'r0');
    await queue.push({ v: 2 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].rev, 'r1');
});

test('un push pendant le vol renvoie la version la plus récente', async () => {
    const { calls, waits, send } = recorder();
    const queue = createSaveQueue(send);
    const first = queue.push({ v: 1 }, 'r0');
    assert.equal(calls.length, 1);            // une seule requête en vol
    const second = queue.push({ v: 2 });      // modification pendant le vol
    assert.equal(calls.length, 1);
    waits[0]({ ok: true, rev: 'r1' });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls.length, 2);            // puis le plus récent part
    assert.deepEqual(calls[1].doc, { v: 2 });
    waits[1]({ ok: true, rev: 'r2' });
    assert.deepEqual(await first, { ok: true, rev: 'r2' });
    assert.deepEqual(await second, { ok: true, rev: 'r2' });
});

test('un échec conserve le document en file, renvoyé au push suivant', async () => {
    const { calls, send } = recorder([{ ok: false }, { ok: true, rev: 'r1' }]);
    const queue = createSaveQueue(send);
    const out = await queue.push({ v: 1 }, 'r0');
    assert.deepEqual(out, { ok: false });
    assert.equal(queue.pending, true);        // toujours à écrire
    const retry = await queue.push({ v: 1 });
    assert.deepEqual(retry, { ok: true, rev: 'r1' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].rev, 'r0');         // base inchangée après l'échec
});

test('un conflit se propage sans réécrire et garde le document en file', async () => {
    const { calls, send } = recorder([{ ok: 'conflict' }]);
    const queue = createSaveQueue(send);
    const out = await queue.push({ v: 1 }, 'r0');
    assert.deepEqual(out, { ok: 'conflict' });
    assert.equal(calls.length, 1);
    assert.equal(queue.pending, true);
});

test('setRev adopte une révision sans écrire', async () => {
    const { calls, send } = recorder([{ ok: true, rev: 'r9' }]);
    const queue = createSaveQueue(send);
    queue.setRev('rX');
    await queue.push({ v: 1 });
    assert.equal(calls[0].rev, 'rX');
});

// ----- Sauvegarde de secours à la fermeture (limite keepalive) -----

const docOf = (sizes, active = 'd1') => ({
    v: 1,
    active,
    dashboards: sizes.map((n, i) => ({
        id: 'd' + (i + 1), name: 'T' + (i + 1),
        items: Array.from({ length: n }, () => ({ size: 'M', spec: { v: 1, title: 'x'.repeat(400) } })),
    })),
});

test('fermeture : le document entier part quand il tient', () => {
    const doc = docOf([2, 2]);
    const out = closingSaveRequest(doc);
    assert.equal(out.url, '/api/dashboards');
    assert.deepEqual(JSON.parse(out.body), doc);
});

test('fermeture : trop gros, seul le tableau affiché part', () => {
    const doc = docOf([24, 24, 24, 24, 24, 24], 'd3');
    assert.ok(new TextEncoder().encode(JSON.stringify(doc)).length > KEEPALIVE_MAX_BYTES);
    const out = closingSaveRequest(doc);
    assert.equal(out.url, '/api/dashboards/d3');
    const body = JSON.parse(out.body);
    assert.equal(body.active, 'd3');
    assert.deepEqual(body.dashboard, doc.dashboards[2]);
});

test('fermeture : la limite compte des octets, pas des caractères', () => {
    // 3 octets par « é » en UTF-8 : sous la limite en caractères, au-dessus en octets.
    const doc = { v: 1, active: 'd1', dashboards: [{ id: 'd1', name: 'é'.repeat(30), items: [] }] };
    const chars = JSON.stringify(doc).length;
    assert.equal(closingSaveRequest(doc, { maxBytes: chars + 10 }), null);
});

test('fermeture : rien à envoyer sans document ni tableau', () => {
    assert.equal(closingSaveRequest(null), null);
    assert.equal(closingSaveRequest({ v: 1, dashboards: [] }, { maxBytes: 5 }), null);
});
