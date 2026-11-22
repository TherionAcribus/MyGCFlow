// File d'écritures des ajustements (static/js/parcours_adjust.mjs) : fusion
// locale, envois séquentiels, resynchronisation après un envoi refusé — dont
// le cas où la relecture échoue elle-même (la file ne doit pas se figer).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createParcoursAdjust } from '../../static/js/parcours_adjust.mjs';

// updateButtons touche le DOM (boutons Annuler/Rétablir de la page) : absents.
globalThis.document = { getElementById: () => null };

// Mini-serveur : même fusion que parcours_store.patch_overrides (champ
// présent remplacé, ligne vidée retirée), journal des requêtes et échecs
// scriptés (`failures` consommée une fois).
const OVERRIDE_FIELDS = ['rank', 'pinnedTime', 'day', 'excluded', 'legMode', 'visitMin', 'position'];
const EMPTY_ROW = { rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null, position: null };

function mergeInto(serverRows, patches) {
    const rows = new Map(serverRows.map((o) => [o.key, { ...o }]));
    for (const patch of patches) {
        const row = rows.get(patch.key) || { key: patch.key, ...EMPTY_ROW };
        for (const field of OVERRIDE_FIELDS) {
            if (field in patch) row[field] = patch[field];
        }
        const empty = OVERRIDE_FIELDS.every((f) => (row[f] ?? null) === null || row[f] === false);
        if (empty) rows.delete(patch.key);
        else rows.set(patch.key, row);
    }
    return [...rows.values()];
}

function harness() {
    const calls = [];
    const failures = new Set();
    const server = { overrides: [] };
    const toasts = [];
    const state = { selectedId: 7, inputs: { overrides: [], places: [], photos: [], cameras: [], tracks: [] } };
    const adjust = createParcoursAdjust({
        getState: () => state,
        fetchJson: async (url, options = {}) => {
            const method = options.method || 'GET';
            calls.push(`${method} ${url}`);
            if (failures.delete(`${method} ${url}`)) throw new Error('HTTP 503');
            if (method === 'PATCH' && url.endsWith('/overrides')) {
                server.overrides = mergeInto(server.overrides, JSON.parse(options.body).overrides);
                return { overrides: server.overrides.map((o) => ({ ...o })) };
            }
            if (method === 'GET' && url.endsWith('/adjustments')) {
                return {
                    overrides: server.overrides.map((o) => ({ ...o })),
                    places: [], photos: [], cameras: [], tracks: [],
                };
            }
            throw new Error(`unexpected ${method} ${url}`);
        },
        rebuild: () => {},
        renderStops: () => {},
        applyTimeline: () => {},
        renderLayer: () => {},
        linkPhoto: () => {},
        clockRunning: () => false,
        showToast: (message, type) => toasts.push({ message, type }),
        t: (x) => x,
    });
    return { adjust, calls, failures, server, state, toasts };
}

// Les envois passent par une file de promesses : quelques macrotâches la
// vident quand les fetch répondent tout de suite.
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const patchCalls = (calls) => calls.filter((c) => c.startsWith('PATCH'));
const reloadCalls = (calls) => calls.filter((c) => c.includes('/adjustments'));

test('deux gestes en file partent dans l’ordre et composent', async () => {
    const { adjust, calls, server, state } = harness();
    adjust.save([{ key: 'gc:1', rank: 0 }]);
    adjust.save([{ key: 'gc:1', rank: 3 }]);
    await drain();
    assert.equal(patchCalls(calls).length, 2);
    assert.deepEqual(server.overrides.map((o) => [o.key, o.rank]), [['gc:1', 3]]);
    assert.deepEqual(state.inputs.overrides.map((o) => o.key), ['gc:1']);
    assert.equal(reloadCalls(calls).length, 0);
    assert.equal(adjust.queued(), 0);
});

test('envoi refusé : l’état local est resynchronisé par /adjustments', async () => {
    const { adjust, calls, failures, server, state, toasts } = harness();
    failures.add('PATCH /api/parcours/7/overrides');
    adjust.save([{ key: 'gc:1', rank: 0 }]);
    await drain();
    assert.equal(patchCalls(calls).length, 1);
    assert.equal(reloadCalls(calls).length, 1);
    assert.equal(server.overrides.length, 0);
    assert.deepEqual(state.inputs.overrides, []);
    assert.deepEqual(toasts.map((toast) => toast.type), ['error']);
    assert.equal(adjust.depths().undo, 0);
    assert.equal(adjust.queued(), 0);
});

test('relecture impossible après un refus : les gestes suivants partent quand même', async () => {
    const { adjust, calls, failures, server, state } = harness();
    failures.add('PATCH /api/parcours/7/overrides');
    failures.add('GET /api/parcours/7/adjustments');
    adjust.save([{ key: 'gc:1', rank: 0 }]);
    await drain();
    assert.equal(patchCalls(calls).length, 1);
    assert.equal(reloadCalls(calls).length, 1);
    // Relecture ratée : le geste refusé reste affiché.
    assert.deepEqual(state.inputs.overrides.map((o) => o.key), ['gc:1']);

    // Réseau revenu : la file, jadis figée rejetée, doit repartir et la
    // resynchronisation est retentée.
    adjust.save([{ key: 'gc:2', rank: 0 }]);
    await drain();
    assert.equal(patchCalls(calls).length, 2);
    assert.equal(reloadCalls(calls).length, 2);
    assert.deepEqual(server.overrides.map((o) => o.key), ['gc:2']);
    assert.deepEqual(state.inputs.overrides.map((o) => o.key), ['gc:2']);
});
