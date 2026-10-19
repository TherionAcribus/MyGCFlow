// node --test test_images_model.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    IMAGES_DEFAULTS,
    IMAGES_MAX_ITEMS,
    IMAGE_ANCHORS,
    createImageItem,
    imageFileName,
    normalizeImagesSettings,
} from './static/js/images_model.mjs';

test('vecteurs partagés avec le serveur (image_settings.py)', () => {
    const cases = JSON.parse(readFileSync(
        new URL('./tests/fixtures/images/settings_cases.json', import.meta.url), 'utf8'));
    assert.ok(cases.length > 10);
    for (const { name, input, expected } of cases) {
        assert.deepEqual(normalizeImagesSettings(input), expected, name);
    }
});

test('identifiants manquants, invalides ou en double régénérés', () => {
    let n = 0;
    const newId = () => `00000${n++}`.padStart(8, '0');
    const { items } = normalizeImagesSettings({ items: [
        {}, { id: 'PAS-HEX!' }, { id: 'abcdef12' }, { id: 'abcdef12' },
    ] }, IMAGES_DEFAULTS, newId);
    const ids = items.map((item) => item.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(ids[2], 'abcdef12');
});

test('patch de premier niveau : une clé absente garde la valeur courante', () => {
    const current = normalizeImagesSettings({ items: [{ id: 'aaaaaa01', file: '0123456789abcdef.png' }] });
    const patched = normalizeImagesSettings({ enabled: false }, current);
    assert.equal(patched.enabled, false);
    assert.deepEqual(patched.items.map((item) => item.id), ['aaaaaa01']);
    assert.equal(normalizeImagesSettings({ items: [] }, current).items.length, 0);
});

test('nouvelle image : défauts, surcharges, nom et fichier validés', () => {
    const item = createImageItem('0123456789abcdef.png', 'Logo\ndu club',
        { position: { anchor: 'top-left', width: 9999 }, style: { shape: 'circle' } }, () => 'abcdef99');
    assert.equal(item.id, 'abcdef99');
    assert.equal(item.name, 'Logo du club');
    assert.equal(item.position.anchor, 'top-left');
    assert.equal(item.position.width, 1200);
    assert.equal(item.position.dx, 16);
    assert.equal(item.style.shape, 'circle');
    assert.equal(item.style.fit, 'contain');
    assert.equal(createImageItem('../evil.png').file, '');
});

test('emplacements : ceux des panneaux, sauf le centre', () => {
    assert.equal(IMAGE_ANCHORS.length, 8);
    assert.ok(!IMAGE_ANCHORS.includes('middle-center'));
    assert.equal(IMAGES_MAX_ITEMS, 4);
    assert.equal(imageFileName('0123456789abcdef.jpg'), '0123456789abcdef.jpg');
    assert.equal(imageFileName('0123456789abcdef.gif'), '');
});
