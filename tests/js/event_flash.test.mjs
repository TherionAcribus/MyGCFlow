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
