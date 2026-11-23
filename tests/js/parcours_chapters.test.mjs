// Chapitres de la vidéo d'un parcours (static/js/parcours_chapters.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline } from '../../static/js/parcours_timeline.mjs';
import { chapterMarks, chaptersForUpload, createChapterLog } from '../../static/js/parcours_chapters.mjs';

const DEG_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));
const stop = (key, x, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: 5 + x * DEG_PER_100M, lat: 45, logId: null, localTime: null, ...extra,
});

// Trois journées avec étapes : le 12, le 14 (le 13 est vide) et le 15.
function sample() {
    return reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 4, { logId: 2 })] },
            { date: '2025-07-13', stops: [] },
            { date: '2025-07-14', stops: [stop('C', 8)] },
            { date: '2025-07-15', stops: [stop('D', 12)] },
        ],
    });
}

test('un repère par journée : 0 pour la première, début de la nuit ensuite', () => {
    const tl = buildParcoursTimeline(sample(), { openCard: true });
    const marks = chapterMarks(tl);
    assert.deepEqual(marks.map((m) => m.dayNumber), [1, 3, 4]);
    assert.deepEqual(marks.map((m) => m.date), ['2025-07-12', '2025-07-14', '2025-07-15']);
    // La première couvre le carton d'ouverture.
    assert.equal(marks[0].q, 0);
    // Les suivantes s'ouvrent sur la nuit, avant la première étape du jour.
    const nights = tl.legs.filter((leg) => leg.night);
    assert.deepEqual(marks.slice(1).map((m) => m.q), nights.map((leg) => leg.startQ));
    assert.ok(marks[1].q < tl.stops[tl.days[1].first].q);
    assert.deepEqual(chapterMarks(null), []);
});

test('journal de capture : instants relevés au premier pas qui atteint chaque repère', () => {
    const tl = buildParcoursTimeline(sample());
    const marks = chapterMarks(tl);
    const log = createChapterLog();
    log.begin(tl, 0);
    // Aperçu (pas de temps vidéo) : rien n'est noté.
    log.note(marks[1].q, null);
    assert.deepEqual(log.entries(), []);
    log.note(0, 40);
    log.note(marks[1].q - 1, 900);
    log.note(marks[1].q, 1000);
    // Un pas qui couvre plusieurs quanta franchit les deux derniers repères.
    log.note(marks[2].q + 3, 2500);
    assert.deepEqual(log.entries().map((e) => [e.dayNumber, e.ms]), [[1, 0], [3, 1000], [4, 2500]]);
    // Nouveau départ : journal vidé.
    log.begin(tl, 0);
    assert.deepEqual(log.entries(), []);
});

test('départ en cours de parcours : le chapitre qui contient le départ ouvre à 0 s', () => {
    const tl = buildParcoursTimeline(sample());
    const marks = chapterMarks(tl);
    const log = createChapterLog();
    log.begin(tl, marks[1].q + 2);
    log.note(marks[1].q + 2, 500);
    log.note(marks[2].q, 1500);
    assert.deepEqual(log.entries().map((e) => [e.dayNumber, e.ms]), [[3, 0], [4, 1500]]);
});

test('chapitres envoyés : secondes, vitesse appliquée, date formatée', () => {
    const entries = [
        { dayNumber: 1, date: '2025-07-12', ms: 0 },
        { dayNumber: 3, date: '2025-07-14', ms: 24000 },
        { dayNumber: 4, date: '2025-07-15', ms: 50001 },
    ];
    assert.deepEqual(chaptersForUpload(entries, 2, (iso) => iso.split('-').reverse().join('/')), [
        { start: 0, day: 1, date: '12/07/2025' },
        { start: 12, day: 3, date: '14/07/2025' },
        { start: 25.001, day: 4, date: '15/07/2025' },
    ]);
    // Deux journées sur la même image : la seconde remplace la première.
    assert.deepEqual(chaptersForUpload([entries[0], { ...entries[1], ms: 0 }, entries[2]]).map((c) => [c.day, c.start]),
        [[3, 0], [4, 50.001]]);
    // Une seule journée : pas de chapitres.
    assert.deepEqual(chaptersForUpload([entries[0]]), []);
    assert.deepEqual(chaptersForUpload(null), []);
});
