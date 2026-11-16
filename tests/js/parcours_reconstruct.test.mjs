// Reconstruction d'un parcours (static/js/parcours_reconstruct.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CONFIDENCE_ANCHORED,
    CONFIDENCE_GEO,
    CONFIDENCE_LOGGED,
    LOG_ORDER_NONE,
    LOG_ORDER_REJECTED,
    LOG_ORDER_TRUSTED,
    REASON_GEO,
    REASON_INSERTED,
    REASON_INTRUDER,
    REASON_LATE_TYPE,
    REASON_LOG_ORDER,
    REASON_TIME,
    legEstimate,
    minutesToTime,
    reconstructDay,
    reconstructParcours,
    timeToMinutes,
} from '../../static/js/parcours_reconstruct.mjs';

// Étapes sur une ligne est-ouest à 45° N : `x` en centaines de mètres
// (0,1 km ≈ 0,00127° de longitude).
const DEG_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));
const at = (x) => 5 + x * DEG_PER_100M;
const stop = (key, x, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: at(x), lat: 45, logId: null, localTime: null, ...extra,
});
const keys = (day) => day.stops.map((s) => s.key);

test('heures : conversions', () => {
    assert.equal(timeToMinutes('10:42:30'), 642.5);
    assert.equal(timeToMinutes('25:00'), null);
    assert.equal(timeToMinutes(null), null);
    assert.equal(minutesToTime(642.5), '10:43');
    assert.equal(minutesToTime(-5), '00:00');
    assert.equal(minutesToTime(NaN), '');
});

test('trajets : à pied jusqu’à 1,5 km, en voiture au-delà', () => {
    const walk = legEstimate([5, 45], [at(10), 45]);
    assert.equal(walk.mode, 'walk');
    assert.ok(Math.abs(walk.km - 1) < 0.01);
    assert.ok(Math.abs(walk.minutes - 1 * 1.25 / 4.5 * 60) < 0.5);
    const car = legEstimate([5, 45], [at(200), 45]);
    assert.equal(car.mode, 'car');
    assert.ok(Math.abs(car.minutes - (5 + 20 * 1.3 / 50 * 60)) < 0.5);
});

test('journée vide ou étapes sans position', () => {
    const day = reconstructDay({ date: '2025-07-12', stops: [stop('GC1', 0, { lon: NaN })] });
    assert.deepEqual(day.stops, []);
    assert.equal(day.dropped, 1);
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_NONE);
});

test('logs saisis dans l’ordre du passage : ordre retenu, confiance « logs »', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [stop('C', 6, { logId: 3 }), stop('A', 0, { logId: 1 }), stop('D', 9, { logId: 4 }), stop('B', 3, { logId: 2 })],
    });
    assert.deepEqual(keys(day), ['A', 'B', 'C', 'D']);
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_TRUSTED);
    assert.ok(day.stops.every((s) => s.confidence === CONFIDENCE_LOGGED && s.reason === REASON_LOG_ORDER));
    // Le sens vient des logs : saisis de D vers A, le parcours va de D vers A.
    const reversed = reconstructDay({
        date: '2025-07-12',
        stops: [stop('A', 0, { logId: 4 }), stop('B', 3, { logId: 3 }), stop('C', 6, { logId: 2 }), stop('D', 9, { logId: 1 })],
    });
    assert.deepEqual(keys(reversed), ['D', 'C', 'B', 'A']);
});

test('logs saisis en désordre : ordre géographique', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [
            stop('A', 0, { logId: 1 }), stop('E', 12, { logId: 2 }), stop('B', 3, { logId: 3 }),
            stop('F', 15, { logId: 4 }), stop('C', 6, { logId: 5 }), stop('D', 9, { logId: 6 }),
        ],
    });
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_REJECTED);
    assert.ok(day.diagnostics.logRatio > 1.3);
    const order = keys(day);
    assert.ok(order.join('') === 'ABCDEF' || order.join('') === 'FEDCBA', order.join(''));
    assert.ok(day.stops.every((s) => s.confidence === CONFIDENCE_GEO && s.reason === REASON_GEO));
});

test('virtuelle loguée après coup : remise à sa place sur le chemin', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [
            stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2 }), stop('D', 9, { logId: 3 }),
            stop('E', 12, { logId: 4 }), stop('V', 6, { logId: 9, type: 'Virtual Cache' }),
        ],
    });
    assert.deepEqual(keys(day), ['A', 'B', 'V', 'D', 'E']);
    const v = day.stops.find((s) => s.key === 'V');
    assert.equal(v.reason, REASON_LATE_TYPE);
    assert.equal(v.confidence, CONFIDENCE_GEO);
    assert.equal(day.diagnostics.lateTypes, 1);
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_TRUSTED);
});

test('log tardif d’une traditionnelle : repéré comme intrus et replacé', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [
            stop('B', 3, { logId: 1 }), stop('C', 6, { logId: 2 }), stop('D', 9, { logId: 3 }),
            stop('E', 12, { logId: 4 }), stop('F', 15, { logId: 5 }), stop('A', 0, { logId: 6 }),
        ],
    });
    assert.deepEqual(keys(day), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.equal(day.stops[0].reason, REASON_INTRUDER);
    assert.equal(day.diagnostics.intruders, 1);
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_TRUSTED);
});

test('ancres (Labs) : ordre chronologique, caches insérées, heures calées', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [
            stop('L2', 12, { kind: 'lab', type: 'Lab Cache', localTime: '11:00:00' }),
            stop('L1', 0, { kind: 'lab', type: 'Lab Cache', localTime: '10:00:00' }),
            stop('G1', 4), stop('G2', 8),
        ],
    });
    assert.deepEqual(keys(day), ['L1', 'G1', 'G2', 'L2']);
    const [l1, g1, g2, l2] = day.stops;
    assert.equal(l1.arrivalMin, 600);
    assert.equal(l2.arrivalMin, 660);
    assert.ok(l1.arrivalMin < g1.arrivalMin && g1.arrivalMin < g2.arrivalMin && g2.arrivalMin < l2.arrivalMin);
    assert.equal(l1.confidence, CONFIDENCE_ANCHORED);
    assert.equal(l1.reason, REASON_TIME);
    assert.equal(g1.reason, REASON_INSERTED);
    assert.equal(day.diagnostics.anchors, 2);
});

test('ancres et logs fiables : les deux ordres sont respectés', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [
            stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2 }), stop('C', 9, { logId: 3 }), stop('D', 12, { logId: 4 }),
            stop('L1', 1.5, { kind: 'lab', type: 'Lab Cache', localTime: '09:30' }),
            stop('L2', 10.5, { kind: 'lab', type: 'Lab Cache', localTime: '11:30' }),
        ],
    });
    assert.deepEqual(keys(day), ['A', 'L1', 'B', 'C', 'L2', 'D']);
    assert.equal(day.diagnostics.logOrder, LOG_ORDER_TRUSTED);
});

test('épingle (ajustement manuel) : prise comme ancre', () => {
    const day = reconstructDay(
        { date: '2025-07-12', stops: [stop('A', 0), stop('B', 3)] },
        { overrides: new Map([['B', { pinnedTime: '14:15' }]]) },
    );
    const b = day.stops.find((s) => s.key === 'B');
    assert.equal(b.arrivalMin, 14 * 60 + 15);
    assert.equal(b.confidence, CONFIDENCE_ANCHORED);
});

test('horaire sans ancre : départ à 9 h, durées par type, heures croissantes', () => {
    const day = reconstructDay({
        date: '2025-07-12',
        stops: [stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2, type: 'Multi-cache' }), stop('C', 6, { logId: 3 })],
    });
    const [a, b, c] = day.stops;
    assert.equal(a.arrivalMin, 540);
    assert.equal(a.visitMin, 10);
    assert.equal(b.visitMin, 40);
    const walk03 = legEstimate([a.lon, a.lat], [b.lon, b.lat]).minutes;
    assert.ok(Math.abs(b.arrivalMin - (540 + 10 + walk03)) < 1e-6);
    assert.ok(c.arrivalMin > b.arrivalMin + 40);
    assert.deepEqual(day.legs.map((l) => [l.from, l.to, l.mode]), [['A', 'B', 'walk'], ['B', 'C', 'walk']]);
    assert.equal(day.diagnostics.compressed, false);
});

test('journée trop longue : comprimée pour finir à 22 h', () => {
    const stops = Array.from({ length: 30 }, (_, i) => stop(`M${String(i).padStart(2, '0')}`, i * 3,
        { logId: i + 1, type: 'Multi-cache' }));
    const day = reconstructDay({ date: '2025-07-12', stops });
    const last = day.stops[day.stops.length - 1];
    assert.equal(day.diagnostics.compressed, true);
    assert.ok(Math.abs(last.arrivalMin + last.visitMin - 22 * 60) < 1e-6);
    assert.equal(day.stops[0].arrivalMin, 540);
});

test('parcours : jours dans l’ordre, numérotation globale, la veille oriente le lendemain', () => {
    const result = reconstructParcours({
        days: [
            // Lendemain sans logs : ordre géographique, à partir du bout le
            // plus proche de la fin de la veille (x = 20).
            { date: '2025-07-13', stops: [stop('Y', 30), stop('X', 24), stop('Z', 36)] },
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 20, { logId: 2 })] },
            { date: '2025-07-14', stops: [] },
        ],
    });
    assert.deepEqual(result.days.map((d) => d.date), ['2025-07-12', '2025-07-13', '2025-07-14']);
    assert.deepEqual(result.days.map(keys), [['A', 'B'], ['X', 'Y', 'Z'], []]);
    assert.deepEqual(result.days[1].stops.map((s) => s.index), [3, 4, 5]);
    assert.equal(result.stopCount, 5);
});

test('déterministe : même entrée, même résultat', () => {
    const input = {
        days: [{
            date: '2025-07-12',
            stops: [stop('A', 0), stop('B', 5), stop('C', 2), stop('D', 2.0001), stop('E', 8, { logId: 3 }), stop('F', 1, { logId: 1 })],
        }],
    };
    assert.deepEqual(reconstructParcours(input), reconstructParcours(input));
});
