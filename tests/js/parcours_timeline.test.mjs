// Temps écran d'un parcours (static/js/parcours_timeline.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import {
    HOURS_APPROX,
    HOURS_EXACT,
    HOURS_NONE,
    HOURS_SLOTS,
    PACE_PROPORTIONAL,
    TIMELINE_DEFAULTS as D,
    buildParcoursTimeline,
    formatClock,
    headAt,
    normalizePlayback,
    stateAt,
    stopsInRange,
    trailAt,
} from '../../static/js/parcours_timeline.mjs';

const DEG_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));
const stop = (key, x, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: 5 + x * DEG_PER_100M, lat: 45, logId: null, localTime: null, ...extra,
});

// Deux journées : A, B (400 m) le 12 ; C le 14 (le 13 est vide).
function sample() {
    return reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 4, { logId: 2 })] },
            { date: '2025-07-13', stops: [] },
            { date: '2025-07-14', stops: [stop('C', 8, { kind: 'lab', type: 'Lab Cache', localTime: '10:30' })] },
        ],
    });
}

test('réglages de lecture normalisés', () => {
    assert.deepEqual(normalizePlayback(null), { pace: 'regular', hours: 'approx' });
    assert.deepEqual(normalizePlayback({ pace: 'proportional', hours: 'slots' }), { pace: 'proportional', hours: 'slots' });
    assert.deepEqual(normalizePlayback({ pace: 'vite', hours: 3 }), { pace: 'regular', hours: 'approx' });
});

test('rythme régulier : quanta d’arrivée, trajets bornés, nuit entre deux journées', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b, c] = tl.stops;
    assert.equal(a.q, D.introQ);
    const walk = Math.round(Math.min(D.legMaxQ, Math.max(D.legMinQ, D.legQPerSqrtKm * Math.sqrt(0.4))));
    assert.equal(b.q, a.q + D.stopQ + walk);
    assert.equal(c.q, b.q + D.stopQ + D.nightQ);
    assert.equal(tl.quanta, c.q + D.stopQ + D.outroQ);
    assert.deepEqual(tl.legs.map((l) => [l.from, l.to, l.night]), [[0, 1, false], [1, 2, true]]);
    // Le jour vide n'a pas d'entrée, mais le rang de la date est gardé.
    assert.deepEqual(tl.days.map((d) => [d.date, d.dayNumber]), [['2025-07-12', 1], ['2025-07-14', 3]]);
    assert.ok(Math.abs(tl.totalKm - (0.4 + 0.4)) < 0.01);
    assert.equal(buildParcoursTimeline({ days: [] }).quanta, 0);
});

test('rythme proportionnel : durées réelles converties', () => {
    const tl = buildParcoursTimeline(sample(), { pace: PACE_PROPORTIONAL });
    const [a, b] = tl.stops;
    // Visite de 10 min → 5 quanta ; trajet ~6,7 min → 3 quanta.
    assert.equal(a.departQ - a.q, 5);
    const legQ = Math.max(1, Math.round(tl.legs[0].endQ - tl.legs[0].startQ));
    assert.equal(b.q, a.departQ + legQ);
    assert.ok(legQ >= 3 && legQ <= 4);
});

test('tête : immobile à l’étape, puis le long du trajet', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b] = tl.stops;
    assert.deepEqual(headAt(tl, 0), { lon: a.lon, lat: a.lat, leg: -1, progress: 0 });
    const leg = tl.legs[0];
    const mid = headAt(tl, (leg.startQ + leg.endQ) / 2);
    assert.equal(mid.leg, 0);
    assert.ok(Math.abs(mid.progress - 0.5) < 1e-9);
    assert.ok(Math.abs(mid.lon - (a.lon + b.lon) / 2) < 1e-9);
    assert.equal(headAt(tl, b.q).lon, b.lon);
    assert.equal(headAt({ stops: [] }, 3), null);
});

test('état affiché : étapes atteintes, heure interpolée, distance, nuit', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b, c] = tl.stops;
    const before = stateAt(tl, 0);
    assert.equal(before.stopsReached, 0);
    assert.equal(before.minutes, a.arrivalMin);
    const atA = stateAt(tl, a.q);
    assert.equal(atA.stopsReached, 1);
    assert.equal(atA.finds, 1);
    assert.equal(atA.date, '2025-07-12');
    assert.equal(atA.estimated, true);
    // Pendant le trajet A → B : heure entre le départ de A et l'arrivée en B.
    const leg = tl.legs[0];
    const during = stateAt(tl, (leg.startQ + leg.endQ) / 2);
    assert.ok(during.minutes > a.arrivalMin + a.visitMin && during.minutes < b.arrivalMin);
    assert.ok(during.km > 0 && during.km < tl.legs[0].km);
    // La nuit : la date et l'heure du lendemain.
    const night = tl.legs[1];
    const sleeping = stateAt(tl, night.startQ + 1);
    assert.equal(sleeping.date, '2025-07-14');
    assert.equal(sleeping.dayNumber, 3);
    assert.equal(sleeping.minutes, c.arrivalMin);
    const atC = stateAt(tl, c.q);
    assert.equal(atC.labs, 1);
    assert.equal(atC.minutes, 10 * 60 + 30);
    assert.equal(atC.estimated, false);
});

test('base : bref arrêt à l’écran, jamais comptée parmi les étapes', () => {
    const tl = buildParcoursTimeline(reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('A', 4, { logId: 1 })] }],
        places: [{ id: 1, kind: 'base', name: 'Hôtel', lat: 45, lon: 5, date: null }],
    }));
    assert.deepEqual(tl.stops.map((s) => s.kind), ['base', 'find', 'base']);
    assert.equal(tl.stops[0].departQ - tl.stops[0].q, D.baseQ);
    const end = stateAt(tl, tl.quanta);
    assert.equal(end.stopsReached, 1);
    assert.equal(end.finds, 1);
});

test('trait : trajets terminés et trajet en cours', () => {
    const tl = buildParcoursTimeline(sample());
    const leg = tl.legs[0];
    assert.deepEqual(trailAt(tl, 0), { done: 0, current: null });
    const half = trailAt(tl, (leg.startQ + leg.endQ) / 2);
    assert.equal(half.done, 0);
    assert.equal(half.current.leg, 0);
    assert.equal(trailAt(tl, tl.quanta).done, 2);
});

test('étapes d’une plage de quanta', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b, c] = tl.stops;
    assert.deepEqual(stopsInRange(tl, 0, a.q), [0]);
    assert.deepEqual(stopsInRange(tl, a.q + 1, c.q), [1, 2]);
    assert.deepEqual(stopsInRange(tl, b.q + 1, c.q - 1), []);
});

test('format de l’heure selon le réglage', () => {
    const labels = { morning: 'matin', noon: 'midi', afternoon: 'après-midi', evening: 'soir' };
    assert.equal(formatClock(640, true, HOURS_APPROX), '≈ 10:40');
    assert.equal(formatClock(640, false, HOURS_APPROX), '10:40');
    assert.equal(formatClock(640, true, HOURS_EXACT), '10:40');
    assert.equal(formatClock(640, true, HOURS_NONE), '');
    assert.equal(formatClock(640, true, HOURS_SLOTS, labels), 'matin');
    assert.equal(formatClock(12.5 * 60, true, HOURS_SLOTS, labels), 'midi');
    assert.equal(formatClock(15 * 60, true, HOURS_SLOTS, labels), 'après-midi');
    assert.equal(formatClock(19 * 60, true, HOURS_SLOTS, labels), 'soir');
    assert.equal(formatClock(NaN, true, HOURS_EXACT), '');
});
