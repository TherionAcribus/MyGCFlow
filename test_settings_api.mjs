import test from 'node:test';
import assert from 'node:assert/strict';

import { saveSettingsPatch } from './static/js/settings_api.mjs';

// Serveur simulé : chaque appel est enregistré et sa réponse reste en attente
// jusqu'à ce que le test la débloque. Permet de vérifier ce qui part sur le
// réseau, et surtout quand.
function fakeServer({ ok = true } = {}) {
    const calls = [];
    globalThis.fetch = (url, options) => {
        const call = { url, body: JSON.parse(options.body) };
        return new Promise(resolve => {
            call.respond = () => resolve({ ok });
            calls.push(call);
        });
    };
    return calls;
}

// Laisse tourner les microtâches en attente (les maillons de la file).
const flush = () => new Promise(resolve => setImmediate(resolve));

test('une seule requête est en vol à la fois', async () => {
    const calls = fakeServer();

    const first = saveSettingsPatch({ language: 'en' });
    const second = saveSettingsPatch({ theme: 'dark' });
    await flush();

    // Sans file d'attente, les deux `fetch` seraient déjà partis ensemble.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { language: 'en' });

    calls[0].respond();
    assert.equal(await first, true);
    await flush();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { theme: 'dark' });
    calls[1].respond();
    assert.equal(await second, true);
});

test("l'ordre d'envoi suit l'ordre des appels, pas celui des réponses", async () => {
    const calls = fakeServer();

    // Le cas réel : blur puis Entrée sur le centre de carte enregistrent deux
    // fois le même champ. Si la première requête traîne et arrive en dernier,
    // c'est l'ancienne valeur qui reste enregistrée.
    const saves = [
        saveSettingsPatch({ map_default_zoom: 10 }),
        saveSettingsPatch({ map_default_zoom: 11 }),
        saveSettingsPatch({ map_default_zoom: 12 }),
    ];

    for (let i = 0; i < saves.length; i++) {
        await flush();
        assert.equal(calls.length, i + 1);
        calls[i].respond();
    }

    await Promise.all(saves);
    assert.deepEqual(calls.map(c => c.body.map_default_zoom), [10, 11, 12]);
});

test('un échec ne bloque pas les écritures suivantes', async () => {
    const calls = fakeServer({ ok: false });

    const failed = saveSettingsPatch({ theme: 'dark' });
    const next = saveSettingsPatch({ language: 'fr' });
    await flush();

    calls[0].respond();
    assert.equal(await failed, false);
    await flush();

    assert.equal(calls.length, 2);
    calls[1].respond();
    assert.equal(await next, false);
});

test('un patch vide ne part pas sur le réseau', async () => {
    const calls = fakeServer();

    assert.equal(await saveSettingsPatch(null), true);
    assert.equal(await saveSettingsPatch('nope'), true);

    assert.equal(calls.length, 0);
});
