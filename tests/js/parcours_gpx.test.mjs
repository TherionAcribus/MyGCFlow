// Export GPX d'un parcours (static/js/parcours_gpx.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParcoursGpx } from '../../static/js/parcours_gpx.mjs';

const DAYS = [
    {
        date: '2025-07-12',
        stops: [
            { key: 'GCPAR03', kind: 'cache', code: 'GCPAR03', name: 'La grotte', lat: 45.9, lon: 6.1, arrivalMin: 630 },
            { key: 'place:2', kind: 'place', name: 'Vue sur la vallée', lat: 45.91, lon: 6.12, arrivalMin: 675 },
        ],
    },
    {
        date: '2025-07-13',
        stops: [
            { key: 'GCPAR04', kind: 'cache', code: 'GCPAR04', name: 'Le pont', lat: 45.95, lon: 6.15 },
            { key: 'GCPAR05', kind: 'cache', code: 'GCPAR05', name: 'Sans position', lat: null, lon: null, arrivalMin: 700 },
        ],
    },
];

test('une route par journée, étapes ordonnées, heures en UTC', () => {
    const gpx = buildParcoursGpx({ name: 'Vacances', days: DAYS, utcOffsetMinutes: 120 });
    assert.match(gpx, /<gpx version="1\.1" creator="MyGCFlow"/);
    assert.equal(gpx.match(/<rte>/g).length, 2);
    assert.match(gpx, /<name>Vacances · 2025-07-12<\/name>/);

    // L'heure d'arrivée (10:30 locales, UTC+2) est servie en UTC.
    assert.match(gpx, /<time>2025-07-12T08:30:00\.000Z<\/time>/);
    // Codes de caches et noms de lieux, ordre conservé.
    const first = gpx.indexOf('<name>GCPAR03</name>');
    const second = gpx.indexOf('<name>Vue sur la vallée</name>');
    assert.ok(first > 0 && second > first);
    // Un stop nommé emporte son nom en <desc>, l'étape sans heure pas de <time>.
    assert.match(gpx, /<desc>La grotte<\/desc>/);
    assert.equal(gpx.indexOf('<time>', gpx.indexOf('GCPAR04')), -1);
    // L'étape sans position est ignorée.
    assert.equal(gpx.indexOf('GCPAR05'), -1);
});

test('échappement XML et parcours vide', () => {
    const gpx = buildParcoursGpx({
        name: 'L\'été <à> "Annecy" & ailleurs',
        days: [{ date: '2025-07-12', stops: [
            { key: 'place:1', name: 'Chez <Mémé> & Pop', lat: 45.9, lon: 6.1, arrivalMin: 0 },
        ] }],
    });
    assert.match(gpx, /Chez &lt;Mémé&gt; &amp; Pop/);
    const empty = buildParcoursGpx({ name: 'Vide', days: [] });
    assert.equal(empty.includes('<rte>'), false);
    assert.ok(empty.startsWith('<?xml'));
});
