import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, FETCH_TIMEOUTS } from './static/js/fetch_with_timeout.mjs';


// fetch minimaliste qui rejette quand le signal d'annulation se déclenche,
// comme le fait un vrai fetch dont le délai a expiré.
const hangingFetch = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
});


test('une requête qui réussit renvoie sa réponse', async () => {
    const result = await fetchWithTimeout('http://x', {}, { fetchImpl: async () => 'réponse' });
    assert.equal(result, 'réponse');
});

test('le délai est annulé après une réponse : pas de timer qui traîne', async () => {
    let cleared = 0;
    await fetchWithTimeout('http://x', {}, {
        fetchImpl: async () => 'ok',
        setTimer: () => 42,
        clearTimer: () => { cleared += 1; },
    });
    assert.equal(cleared, 1);
});

test('une requête suspendue rejette avec une erreur lisible après le délai', async () => {
    await assert.rejects(
        fetchWithTimeout('http://x', {}, { fetchImpl: hangingFetch, timeoutMs: 20 }),
        /délai dépassé/,
    );
});

test('une erreur non-timeout est propagée telle quelle', async () => {
    const boom = new Error('réseau coupé');
    await assert.rejects(
        fetchWithTimeout('http://x', {}, { fetchImpl: async () => { throw boom; } }),
        (err) => err === boom,
    );
});

test('les options passent à fetch avec le signal d\'annulation ajouté', async () => {
    let seen;
    await fetchWithTimeout('http://x', { method: 'POST', headers: { a: '1' } }, {
        fetchImpl: async (url, options) => { seen = options; return 'ok'; },
    });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers.a, '1');
    assert.ok(seen.signal instanceof AbortSignal);
});

test('les délais recommandés restent cohérents : status < control < upload < vidéo', () => {
    assert.ok(FETCH_TIMEOUTS.status < FETCH_TIMEOUTS.control);
    assert.ok(FETCH_TIMEOUTS.control < FETCH_TIMEOUTS.upload);
    assert.ok(FETCH_TIMEOUTS.upload <= FETCH_TIMEOUTS.videoUpload);
});
