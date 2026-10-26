// Table des flashs par événement : la copie JS (static/js/event_flash.mjs)
// doit rester celle du serveur (event_flash.py), écrite dans
// tests/fixtures/flash/event_flash_kinds.json par tests/test_event_flash.py.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    EVENT_FLASH_DEFAULTS,
    EVENT_FLASH_KINDS,
    EVENT_FLASH_MODES,
    OWNER_FLASH_DEFAULTS,
    OWNER_FLASH_KINDS,
    normalizeOwnerFlashes,
    ownerFlashKindOf,
    resolveOwnerFlash,
} from '../../static/js/event_flash.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/flash/event_flash_kinds.json', import.meta.url), 'utf8'));

test('mêmes types, dans le même ordre de priorité', () => {
    assert.deepEqual([...EVENT_FLASH_KINDS], table.kinds);
});

test('mêmes formes permises', () => {
    assert.deepEqual([...EVENT_FLASH_MODES], table.modes);
});

test('mêmes défauts', () => {
    for (const kind of table.kinds) {
        assert.deepEqual({ ...EVENT_FLASH_DEFAULTS[kind] }, table.defaults[kind], kind);
    }
});

test('étapes du poseur : mêmes types et défauts que le serveur', () => {
    assert.deepEqual([...OWNER_FLASH_KINDS], table.owner_kinds);
    for (const kind of table.owner_kinds) {
        assert.deepEqual({ ...OWNER_FLASH_DEFAULTS[kind] }, table.owner_defaults[kind], kind);
    }
});

test('étapes du poseur : désarchivage = réactivation, type inconnu écarté', () => {
    assert.equal(ownerFlashKindOf('unarchive'), 'enable');
    assert.equal(ownerFlashKindOf('maintenance'), 'maintenance');
    assert.equal(ownerFlashKindOf('find'), null);
});

test('étapes du poseur : « same » reprend le flash principal, « none » éteint', () => {
    const flash = { mode: 'circle', size: 50, owner: normalizeOwnerFlashes({
        place: { mode: 'same' }, maintenance: { mode: 'none' },
    }) };
    assert.equal(resolveOwnerFlash('place', flash), flash);
    assert.equal(resolveOwnerFlash('maintenance', flash), null);
    const archive = resolveOwnerFlash('archive', flash);
    assert.equal(archive.mode, 'implode');
    assert.deepEqual(archive.rgb, { r: 0x61, g: 0x61, b: 0x61 });
    assert.equal(resolveOwnerFlash('inconnu', flash), null);
});
