// node --test test_images_model.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    IMAGES_DEFAULTS,
    IMAGES_MAX_ITEMS,
    IMAGE_ANCHORS,
    IMAGE_STYLE_PRESETS,
    createImageItem,
    imageFileName,
    imageItemDefaults,
    imageStylePreset,
    imagesItemsKey,
    isImageFile,
    normalizeImageItem,
    normalizeImagesSettings,
    SCHEDULE_UNREACHED,
    dayNumberToIso,
    dayOfNthFind,
    hasSchedule,
    scheduleBounds,
    scheduleRangeIssue,
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

test('listes indépendantes : chaque page a la sienne', () => {
    assert.equal(imagesItemsKey(false), 'items');
    assert.equal(imagesItemsKey(true), 'evolution_items');
    // Clé absente → liste vide, jamais une copie de `items`.
    assert.deepEqual(normalizeImagesSettings({ items: [{ id: 'aaaaaa01' }] }).evolution_items, []);
    const current = normalizeImagesSettings({
        items: [{ id: 'aaaaaa01', file: '0123456789abcdef.png' }],
        evolution_items: [{ id: 'bbbbbb01', file: 'fedcba9876543210.jpg' }],
    });
    const patched = normalizeImagesSettings({ items: [] }, current);
    assert.equal(patched.items.length, 0);
    assert.deepEqual(patched.evolution_items.map((item) => item.id), ['bbbbbb01']);
    // Bloc non objet : les deux listes reprennent leurs valeurs courantes.
    const kept = normalizeImagesSettings('oui', current);
    assert.equal(kept.items.length, 1);
    assert.equal(kept.evolution_items.length, 1);
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

test('isImageFile : type MIME ou extension, ni GPX ni musique', () => {
    assert.equal(isImageFile({ name: 'logo.PNG', type: '' }), true);
    assert.equal(isImageFile({ name: 'blason.svg', type: '' }), true);
    assert.equal(isImageFile({ name: 'photo', type: 'image/jpeg' }), true);
    assert.equal(isImageFile({ name: 'scan.tiff', type: 'image/tiff' }), false);
    assert.equal(isImageFile({ name: 'my-finds.gpx', type: 'application/gpx+xml' }), false);
    assert.equal(isImageFile({ name: 'musique.mp3', type: 'audio/mpeg' }), false);
    assert.equal(isImageFile(null), false);
});

test('préréglages : repartent du style par défaut, valides, rond = hauteur aux proportions', () => {
    const item = normalizeImageItem({
        position: { height: 120 },
        style: { shape: 'rect', opacity: 40, padding: 30, background_opacity: 50 },
    });
    for (const name of Object.keys(IMAGE_STYLE_PRESETS)) {
        const { style } = imageStylePreset(item, name);
        // Un préréglage passe la normalisation sans être modifié.
        assert.deepEqual(normalizeImageItem({ style }).style, style, name);
    }
    const avatar = imageStylePreset(item, 'avatar');
    assert.equal(avatar.style.shape, 'circle');
    assert.equal(avatar.height, null);
    // Réglages précédents oubliés : opacité et marge reviennent au défaut.
    assert.equal(avatar.style.opacity, imageItemDefaults().style.opacity);
    assert.equal(avatar.style.padding, 0);
    // Forme non ronde : la hauteur imposée est gardée.
    assert.equal(imageStylePreset(item, 'badge').height, 120);
    assert.equal(imageStylePreset(item, 'inconnu'), null);
});

test('scheduleRangeIssue : planing invisible pendant toute la période animée', () => {
    const range = ['2026-01-01', '2026-01-31'];
    assert.equal(scheduleRangeIssue({ start: null, end: null }, ...range), null);
    assert.equal(scheduleRangeIssue({ start: '2026-01-10', end: '2026-01-20' }, ...range), null);
    // Avant le début mais jusqu'après : visible dès la première frame.
    assert.equal(scheduleRangeIssue({ start: '2025-12-01', end: null }, ...range), null);
    assert.equal(scheduleRangeIssue({ start: '2026-01-31', end: null }, ...range), null);
    assert.equal(scheduleRangeIssue({ start: '2026-02-01', end: null }, ...range), 'after');
    // « Disparaît le » est exclu : disparue le premier jour = jamais vue.
    assert.equal(scheduleRangeIssue({ start: null, end: '2026-01-01' }, ...range), 'before');
    assert.equal(scheduleRangeIssue({ start: null, end: '2026-01-02' }, ...range), null);
    assert.equal(scheduleRangeIssue({ start: '2026-01-10', end: '2026-01-10' }, ...range), 'empty');
    // Sans période connue (pas de données) : seule la fenêtre vide compte.
    assert.equal(scheduleRangeIssue({ start: '2030-01-01', end: null }, null, null), null);
    assert.equal(scheduleRangeIssue({ start: '2026-01-10', end: '2026-01-05' }, null, null), 'empty');
});

test('dayOfNthFind : jour où le compteur atteint n, null au-delà du total', () => {
    const dayCounts = [[100, 2], [101, 0], [105, 3]];
    assert.equal(dayOfNthFind(dayCounts, 1), 100);
    assert.equal(dayOfNthFind(dayCounts, 2), 100);
    assert.equal(dayOfNthFind(dayCounts, 3), 105);
    assert.equal(dayOfNthFind(dayCounts, 5), 105);
    assert.equal(dayOfNthFind(dayCounts, 6), null);
    assert.equal(dayOfNthFind(dayCounts, 0), null);
    assert.equal(dayOfNthFind([], 1), null);
    assert.equal(dayNumberToIso(20454), '2026-01-01');
    assert.equal(dayNumberToIso(NaN), null);
});

test('planing par jalons : bornes converties en dates, jalon jamais atteint', () => {
    const isoOfFind = (n) => ({ 3: '2026-01-03', 5: '2026-01-05' }[n] || null);
    const byFind = (start_find, end_find) => normalizeImageItem({
        schedule: { by: 'find', start_find, end_find, start: '2020-01-01' },
    }).schedule;
    assert.deepEqual(scheduleBounds(byFind(3, 5), isoOfFind), { start: '2026-01-03', end: '2026-01-05' });
    // Apparition jamais atteinte : plus tard que toute animation ;
    // disparition jamais atteinte : pas de fin.
    assert.deepEqual(scheduleBounds(byFind(99, 77), isoOfFind), { start: SCHEDULE_UNREACHED, end: null });
    assert.equal(scheduleRangeIssue(scheduleBounds(byFind(99, null), isoOfFind), '2026-01-01', '2026-01-06'), 'after');
    // Les dates gardées ne comptent pas en mode jalons, et inversement.
    assert.equal(hasSchedule(byFind(null, null)), false);
    assert.equal(hasSchedule(byFind(3, null)), true);
    const byDate = normalizeImageItem({ schedule: { start_find: 3 } }).schedule;
    assert.equal(byDate.by, 'date');
    assert.equal(hasSchedule(byDate), false);
    assert.deepEqual(scheduleBounds(byDate, isoOfFind), { start: null, end: null });
});

test('configurations : instantanés normalisés, premier nom gagnant, douze au plus', () => {
    const settings = normalizeImagesSettings({ configs: [
        { name: ' Club ', items: [{ id: 'aaaa0401', file: '0123456789abcdef.png' }] },
        { name: 'Club', items: [] },
        ...Array.from({ length: 14 }, (_, n) => ({ name: `C${n}`, items: [] })),
    ] });
    assert.equal(settings.configs.length, 12);
    assert.equal(settings.configs[0].name, 'Club');
    assert.equal(settings.configs[0].items[0].schedule.by, 'date');
    // Patch de premier niveau : les configurations survivent à un patch
    // des listes.
    const patched = normalizeImagesSettings({ items: [] }, settings);
    assert.equal(patched.configs.length, 12);
});
