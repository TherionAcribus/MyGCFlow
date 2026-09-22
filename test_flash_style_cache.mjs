import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createFlashStyleCache,
    liveFlashStep,
    LIVE_FLASH_STEPS_PER_SECOND,
} from './static/js/flash_style_cache.mjs';

test('un flash live compte un pas par frame 60 Hz', () => {
    assert.equal(LIVE_FLASH_STEPS_PER_SECOND, 60);
    assert.deepEqual(liveFlashStep(0, 2000), { step: 0, steps: 120 });
    assert.deepEqual(liveFlashStep(1000, 2000), { step: 60, steps: 120 });
});

test('un flash live n\'atteint jamais le dernier pas avant son expiration', () => {
    assert.deepEqual(liveFlashStep(1999.9, 2000), { step: 119, steps: 120 });
    // Au-delà de la durée (l'appelant a normalement déjà expiré le flash).
    assert.deepEqual(liveFlashStep(5000, 2000), { step: 119, steps: 120 });
});

test('une durée nulle ou invalide ne produit ni division par zéro ni NaN', () => {
    assert.deepEqual(liveFlashStep(10, 0), { step: 0, steps: 1 });
    assert.deepEqual(liveFlashStep(10, 'abc'), { step: 0, steps: 1 });
    assert.deepEqual(liveFlashStep(-5, 1000), { step: 0, steps: 60 });
});

test('une même clé ne reconstruit pas le style', () => {
    const cache = createFlashStyleCache();
    let builds = 0;
    const build = () => { builds += 1; return { value: { id: builds }, bytes: 100 }; };
    const a = cache.get('k', build);
    const b = cache.get('k', build);
    assert.equal(builds, 1);
    assert.equal(a, b);
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 100);
});

test('le budget mémoire évince l\'entrée la moins récemment utilisée', () => {
    const cache = createFlashStyleCache({ maxBytes: 250 });
    const make = (name) => () => ({ value: name, bytes: 100 });
    cache.get('a', make('a'));
    cache.get('b', make('b'));
    cache.get('a', make('a'));   // 'a' redevient la plus récente
    cache.get('c', make('c'));   // 300 > 250 : 'b' est évincée
    assert.equal(cache.size, 2);
    assert.equal(cache.bytes, 200);

    let rebuilt = false;
    cache.get('b', () => { rebuilt = true; return { value: 'b', bytes: 100 }; });
    assert.equal(rebuilt, true);
    let aRebuilt = false;
    cache.get('c', () => { aRebuilt = true; return { value: 'c', bytes: 100 }; });
    assert.equal(aRebuilt, false);
});

test('une entrée plus grosse que le budget est quand même servie', () => {
    const cache = createFlashStyleCache({ maxBytes: 10 });
    cache.get('small', () => ({ value: 's', bytes: 5 }));
    assert.equal(cache.get('huge', () => ({ value: 'h', bytes: 1000 })), 'h');
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 1000);
});

test('clear() vide le cache', () => {
    const cache = createFlashStyleCache();
    cache.get('k', () => ({ value: 1, bytes: 10 }));
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});
