// Export de la sélection filtrée — fonctions pures de
// static/js/export_selection.mjs (GPX/CSV générés côté client).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    exportSelectionFileName,
    selectionToCsv,
    selectionToGpx,
} from '../../static/js/export_selection.mjs';

const HEADER = 'gc_code;name;cache_type;latitude;longitude;date_find;found;'
    + 'published_date;difficulty;terrain;container;owner;country;state;source_kind';

const feature = (props, coords = [2.3501, 48.8501]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: props,
});

const geocache = (over = {}) => feature({
    source_kind: 'geocache',
    gc_code: 'GCE2E001',
    name: 'Traditionnelle 1',
    cache_type: 'Traditional Cache',
    date_find: '2026-01-01',
    found: true,
    published_date: '2020-05-04',
    difficulty: 1.5,
    terrain: 2,
    container: 'Micro',
    owner: 'Alice',
    country: 'France',
    state: 'Île-de-France',
    ...over,
});

const lab = (over = {}) => feature({
    source_kind: 'lab',
    gc_code: null,
    record_uid: 'lab:uid:stage',
    name: 'Étape finale',
    cache_type: 'Lab Cache',
    date_find: '2026-02-03',
    found: true,
    published_date: null,
    difficulty: null,
    terrain: null,
    container: null,
    owner: 'LabCo',
    country: null,
    state: null,
    ...over,
}, [3.14, 45.2]);

// --- CSV --------------------------------------------------------------------

test('selectionToCsv : BOM, en-tête, une ligne par feature (CRLF)', () => {
    const csv = selectionToCsv([geocache(), lab()]);
    assert.equal(csv.charCodeAt(0), 0xFEFF); // BOM UTF-8 pour Excel
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], HEADER);
    assert.equal(lines[1],
        'GCE2E001;Traditionnelle 1;Traditional Cache;48.8501;2.3501;2026-01-01;'
        + '1;2020-05-04;1.5;2;Micro;Alice;France;Île-de-France;geocache');
    // Lab : pas de gc_code ni D/T — cellules vides, source_kind « lab ».
    assert.equal(lines[2],
        ';Étape finale;Lab Cache;45.2;3.14;2026-02-03;1;;;;;LabCo;;;lab');
    // Le fichier se termine par une ligne vide après le dernier CRLF.
    assert.equal(lines.at(-1), '');
    assert.equal(lines.length, 4);
});

test('selectionToCsv : échappement « ; », guillemets doublés, retours à la ligne', () => {
    const csv = selectionToCsv([geocache({
        name: 'Nom; avec « guillemets »\n et retour',
        owner: 'Bob "B" Poseur',
    })]);
    const line = csv.slice(1).split('\r\n')[1];
    assert.ok(line.includes('"Nom; avec « guillemets »\n et retour"'));
    assert.ok(line.includes('"Bob ""B"" Poseur"'));
});

test('selectionToCsv : tableau vide ou absent → en-tête seule', () => {
    assert.equal(selectionToCsv([]), '\uFEFF' + HEADER + '\r\n');
    assert.equal(selectionToCsv(), '\uFEFF' + HEADER + '\r\n');
    assert.equal(selectionToCsv(null), '\uFEFF' + HEADER + '\r\n');
});

test('selectionToCsv : owner repli placed_by, source_kind géocache par défaut, found → 1/0', () => {
    const csv = selectionToCsv([geocache({ owner: '', placed_by: 'Repli', found: false, source_kind: undefined })]);
    const line = csv.slice(1).split('\r\n')[1];
    const cells = line.split(';');
    assert.equal(cells[6], '0');        // found
    assert.equal(cells[11], 'Repli');   // owner ← placed_by
    assert.equal(cells[14], 'geocache');// source_kind par défaut
});

test('selectionToCsv : feature sans géométrie → coordonnées vides', () => {
    const csv = selectionToCsv([{ type: 'Feature', geometry: null, properties: { gc_code: 'GC1' } }]);
    const cells = csv.slice(1).split('\r\n')[1].split(';');
    assert.equal(cells[3], '');
    assert.equal(cells[4], '');
});

// --- GPX --------------------------------------------------------------------

test('selectionToGpx : structure, wpt, nom/date/urlname', () => {
    const gpx = selectionToGpx([geocache()]);
    assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(gpx.includes('<gpx version="1.0" creator="MyGCFlow"'));
    assert.ok(gpx.includes(
        '<wpt lat="48.8501" lon="2.3501">'
        + '<time>2026-01-01T00:00:00Z</time>'
        + '<name>GCE2E001</name>'
        + '<desc>Traditional Cache — D1.5/T2 — Micro — Alice</desc>'
        + '<urlname>Traditionnelle 1</urlname>'
        + '</wpt>'));
    assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

test('selectionToGpx : échappement XML des cinq caractères', () => {
    const gpx = selectionToGpx([geocache({
        name: 'A & <B> "C" \'D\'',
        owner: 'E & F',
    })]);
    assert.ok(gpx.includes('<urlname>A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;</urlname>'));
    assert.ok(gpx.includes('E &amp; F'));
    assert.ok(!gpx.includes('A & <B>'));
});

test('selectionToGpx : Lab sans gc_code → nom comme libellé, pas de D/T ni time', () => {
    const gpx = selectionToGpx([lab({ date_find: null })]);
    assert.ok(gpx.includes('<wpt lat="45.2" lon="3.14"><name>Étape finale</name>'));
    assert.ok(gpx.includes('<desc>Lab Cache — LabCo</desc>'));
    assert.ok(!gpx.includes('<time>'));
    assert.ok(!gpx.includes('D?/T?'));
});

test('selectionToGpx : feature sans coordonnées ignorée ; vide → squelette seul', () => {
    const gpx = selectionToGpx([feature({ gc_code: 'GC1' }, null), geocache()]);
    assert.equal((gpx.match(/<wpt /g) || []).length, 1);
    const empty = selectionToGpx([]);
    assert.ok(!empty.includes('<wpt'));
    assert.ok(empty.trimEnd().endsWith('</gpx>'));
});

// --- Nom de fichier ----------------------------------------------------------

test('exportSelectionFileName : mygcflow-selection-YYYY-MM-DD.ext', () => {
    assert.equal(exportSelectionFileName('gpx', new Date(2026, 0, 7)),
        'mygcflow-selection-2026-01-07.gpx');
    assert.equal(exportSelectionFileName('csv', new Date(2026, 11, 31)),
        'mygcflow-selection-2026-12-31.csv');
});
