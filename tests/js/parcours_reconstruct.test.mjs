// Reconstruction d'un parcours (static/js/parcours_reconstruct.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CONFIDENCE_ANCHORED,
    CONFIDENCE_GEO,
    CONFIDENCE_LOGGED,
    CONFIDENCE_MANUAL,
    KIND_BASE,
    KIND_PLACE,
    REASON_BASE,
    REASON_MANUAL,
    REASON_PINNED,
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

test('durée de visite imposée : elle décale les étapes suivantes', () => {
    const stops = [stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2 }), stop('C', 6, { logId: 3 })];
    const day = reconstructDay(
        { date: '2025-07-12', stops },
        { overrides: new Map([['A', { visitMin: 120 }]]) },
    );
    const [a, b] = day.stops;
    assert.equal(a.visitMin, 120);
    const walk03 = legEstimate([a.lon, a.lat], [b.lon, b.lat]).minutes;
    assert.ok(Math.abs(b.arrivalMin - (540 + 120 + walk03)) < 1e-6);
    // Bien plus tard qu'avec les 10 min estimées d'une Traditional.
    const auto = reconstructDay({ date: '2025-07-12', stops });
    assert.ok(b.arrivalMin > auto.stops[1].arrivalMin + 100);
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

// --- Ajustements manuels (lot 3) ------------------------------------------------

test('ordre manuel : les étapes classées gardent l’ordre choisi, les autres s’y insèrent', () => {
    const inputs = {
        days: [{ date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2 }), stop('C', 6, { logId: 3 }), stop('D', 9, { logId: 4 })] }],
        overrides: [{ key: 'C', rank: 0 }, { key: 'A', rank: 1 }],
    };
    const [day] = reconstructParcours(inputs).days;
    assert.equal(day.manual, true);
    const order = day.stops.map((s) => s.key);
    assert.ok(order.indexOf('C') < order.indexOf('A'), order.join(''));
    assert.equal(day.stops.find((s) => s.key === 'C').reason, REASON_MANUAL);
    assert.equal(day.stops.find((s) => s.key === 'C').confidence, CONFIDENCE_MANUAL);
    // Sans rang, l'ordre automatique reste en place.
    assert.equal(reconstructParcours({ days: inputs.days }).days[0].manual, false);
});

test('ordre contraire aux heures sûres : recul de l’horloge signalé', () => {
    const inputs = {
        days: [{ date: '2025-07-12', stops: [
            stop('A', 0, { localTime: '09:00' }),
            stop('B', 3, { localTime: '10:00' }),
            stop('C', 6, { localTime: '12:00' }),
        ] }],
        overrides: [{ key: 'C', rank: 0 }, { key: 'A', rank: 1 }, { key: 'B', rank: 2 }],
    };
    const [day] = reconstructParcours(inputs).days;
    assert.deepEqual(day.stops.map((s) => s.key), ['C', 'A', 'B']);
    // L'horloge affichée recule : 12 h puis 9 h.
    assert.equal(day.stops[0].arrivalMin, 12 * 60);
    assert.equal(day.stops[1].arrivalMin, 9 * 60);
    assert.equal(day.diagnostics.clockBacktrack, true);
    // Ordre compatible avec les heures sûres : pas de recul.
    const auto = reconstructParcours({ days: inputs.days }).days[0];
    assert.equal(auto.diagnostics.clockBacktrack, false);
});

test('heure épinglée : ancre exacte, raison « épinglée »', () => {
    const [day] = reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 3, { logId: 2 })] }],
        overrides: [{ key: 'B', pinnedTime: '15:00' }],
    }).days;
    const b = day.stops.find((s) => s.key === 'B');
    assert.equal(b.arrivalMin, 15 * 60);
    assert.equal(b.reason, REASON_PINNED);
    assert.equal(b.confidence, CONFIDENCE_ANCHORED);
});

test('journée corrigée et exclusion', () => {
    const result = reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0), stop('V', 2, { type: 'Virtual Cache' })] },
            { date: '2025-07-13', stops: [stop('B', 40), stop('X', 41)] },
        ],
        overrides: [{ key: 'V', day: '2025-07-13' }, { key: 'X', excluded: true }, { key: 'Z', day: '2025-07-12' }],
    });
    const [d1, d2] = result.days;
    assert.deepEqual(d1.stops.map((s) => s.key), ['A']);
    assert.deepEqual(d2.stops.map((s) => s.key).sort(), ['B', 'V']);
    assert.equal(d2.stops.find((s) => s.key === 'V').movedFrom, '2025-07-12');
    assert.deepEqual(d2.excluded.map((s) => s.key), ['X']);
    assert.equal(result.stopCount, 3);
});

test('lieu posé : une étape de plus, à son heure, non comptée', () => {
    const result = reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 6, { logId: 2 })] }],
        places: [
            { id: 7, kind: KIND_PLACE, name: 'Belvédère', lat: 45, lon: stop('P', 3).lon, date: '2025-07-12', time: null },
            { id: 8, kind: KIND_PLACE, name: 'Hors plage', lat: 45, lon: 5, date: '2025-08-01', time: null },
        ],
    });
    const [day] = result.days;
    assert.deepEqual(day.stops.map((s) => s.key), ['A', 'place:7', 'B']);
    const place = day.stops[1];
    assert.equal(place.kind, KIND_PLACE);
    assert.equal(place.index, null);
    assert.equal(place.visitMin, 30);
    assert.equal(result.stopCount, 2);
    assert.deepEqual(day.stops.map((s) => s.index), [1, null, 2]);
});

test('base : départ et retour de chaque journée, la base datée prime', () => {
    const result = reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 10), stop('B', 20)] },
            { date: '2025-07-13', stops: [stop('C', 30)] },
            { date: '2025-07-14', stops: [] },
        ],
        places: [
            { id: 1, kind: KIND_BASE, name: 'Camping', lat: 45, lon: stop('H', 0).lon, date: null },
            { id: 2, kind: KIND_BASE, name: 'Hôtel', lat: 45, lon: stop('H2', 40).lon, date: '2025-07-13' },
        ],
    });
    const [d1, d2, d3] = result.days;
    assert.deepEqual(d1.stops.map((s) => s.key),
        ['place:1:2025-07-12:start', 'A', 'B', 'place:1:2025-07-12:end']);
    assert.deepEqual(d2.stops.map((s) => s.key), ['place:2:2025-07-13:start', 'C', 'place:2:2025-07-13:end']);
    assert.deepEqual(d3.stops, []);
    // Départ de la base à 9 h ; la base ne compte pas, sa visite dure 0.
    assert.equal(d1.stops[0].arrivalMin, 540);
    assert.equal(d1.stops[0].visitMin, 0);
    assert.equal(d1.stops[0].reason, REASON_BASE);
    assert.equal(d1.stops[1].arrivalMin > 540, true);
    assert.equal(result.stopCount, 3);
});

test('bases à rôles : partir d’un hôtel, dormir au camping', () => {
    const result = reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('A', 10), stop('B', 20)] }],
        places: [
            { id: 1, kind: KIND_BASE, name: 'Hôtel', lat: 45, lon: 5, date: null, role: 'start' },
            { id: 2, kind: KIND_BASE, name: 'Camping', lat: 46, lon: 6, date: null, role: 'end' },
        ],
    });
    const [day] = result.days;
    assert.deepEqual(day.stops.map((s) => s.key),
        ['place:1:2025-07-12:start', 'A', 'B', 'place:2:2025-07-12:end']);
    assert.equal(day.stops[0].visitMin, 0);
    assert.equal(day.stops[0].reason, REASON_BASE);
    assert.equal(day.stops[3].reason, REASON_BASE);

    // Une base datée « retour » prime sur le retour de la base globale.
    const dated = reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('A', 10)] }],
        places: [
            { id: 1, kind: KIND_BASE, name: 'Maison', lat: 45, lon: 5, date: null },
            { id: 2, kind: KIND_BASE, name: 'Refuge', lat: 46, lon: 6, date: '2025-07-12', role: 'end' },
        ],
    });
    assert.deepEqual(dated.days[0].stops.map((s) => s.key),
        ['place:1:2025-07-12:start', 'A', 'place:2:2025-07-12:end']);
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
