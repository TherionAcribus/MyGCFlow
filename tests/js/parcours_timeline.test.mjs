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
    QUANTUM_MS,
    SCENE_DEFAULTS as S,
    TIMELINE_DEFAULTS as D,
    barSeries,
    barTicks,
    buildParcoursTimeline,
    dayCardAt,
    dayStats,
    endCardAt,
    formatClock,
    headAt,
    headModeAt,
    legTravelMode,
    nightLevelAt,
    normalizePlayback,
    openCardAt,
    sceneTimingOptions,
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
    const defaults = { pace: 'regular', hours: 'approx', camera: 'follow', framing: 'balanced', day_cards: true, head: 'mode', estimated_dashed: false };
    assert.deepEqual(normalizePlayback(null), defaults);
    assert.deepEqual(normalizePlayback({ pace: 'proportional', hours: 'slots', camera: 'fixed', framing: 'wide', day_cards: false, head: 'dot', estimated_dashed: true }),
        { pace: 'proportional', hours: 'slots', camera: 'fixed', framing: 'wide', day_cards: false, head: 'dot', estimated_dashed: true });
    assert.deepEqual(normalizePlayback({ pace: 'vite', hours: 3, camera: 'drone', framing: 'cinéma', day_cards: 'non', head: 'vélo' }), defaults);
});

test('carton d’ouverture : temps ajouté en tête, carton puis descente', () => {
    const tl = buildParcoursTimeline(sample(), { openCard: true, endCard: true });
    const [a] = tl.stops;
    assert.equal(a.q, D.openCardQ + D.openDescentQ + D.introQ);
    assert.equal(tl.openCardQ, D.openCardQ);
    assert.equal(tl.openDescentQ, D.openDescentQ);
    assert.equal(tl.quanta, tl.stops[2].q + D.stopQ + D.outroQ + D.endCardQ);
    // Le carton tient sa fenêtre, en fondu aux bords.
    assert.equal(openCardAt(tl, -1), null);
    assert.equal(openCardAt(tl, tl.openCardQ + 1), null);
    assert.equal(openCardAt(tl, tl.openCardQ / 2).alpha, 1);
    assert.ok(openCardAt(tl, 0).alpha < 0.5);
    // « Jour 1 » attend la fin du carton d'ouverture.
    assert.equal(dayCardAt(tl, tl.openCardQ - 1), null);
    assert.ok(dayCardAt(tl, tl.openCardQ + 1));
    // Sans cartons : rien n'est ajouté.
    const off = buildParcoursTimeline(sample());
    assert.equal(off.openCardQ, 0);
    assert.equal(off.stops[0].q, D.introQ);
    assert.equal(openCardAt(off, 2), null);
    // Durée imposée : le carton garde son temps écran (plancher), la
    // descente absorbe la compression avec visites et trajets.
    const fast = buildParcoursTimeline(sample(), { openCard: true, timing: { msPerDay: 50 } });
    assert.ok(fast.openCardQ >= 2 * D.openCardQ - 2, `plancher du carton : ${fast.openCardQ}`);
    assert.ok(fast.stops[0].q > fast.openCardQ);
});

test('rythme régulier : quanta d’arrivée, trajets bornés, nuit entre deux journées', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b, c] = tl.stops;
    assert.equal(a.q, D.introQ);
    const walk = Math.round(Math.min(D.legMaxQ, Math.max(D.legMinQ, D.legQPerSqrtKm * Math.sqrt(0.4))));
    assert.equal(b.q, a.q + D.stopQ + walk);
    // Le 13 est vide : le saut de 2 jours allonge la nuit (×1,5).
    assert.equal(c.q, b.q + D.stopQ + Math.round(1.5 * D.nightQ));
    assert.equal(tl.quanta, c.q + D.stopQ + D.outroQ);
    assert.deepEqual(tl.legs.map((l) => [l.from, l.to, l.night]), [[0, 1, false], [1, 2, true]]);
    // Le jour vide n'a pas d'entrée, mais le rang de la date est gardé.
    assert.deepEqual(tl.days.map((d) => [d.date, d.dayNumber]), [['2025-07-12', 1], ['2025-07-14', 3]]);
    assert.ok(Math.abs(tl.totalKm - (0.4 + 0.4)) < 0.01);
    assert.equal(buildParcoursTimeline({ days: [] }).quanta, 0);
});

test('ellipse : la nuit dure selon le trou calendaire', () => {
    const tl = buildParcoursTimeline(reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0), stop('B', 1)] },
            { date: '2025-07-13', stops: [stop('C', 2), stop('D', 3)] },
            { date: '2025-07-14', stops: [] },
            { date: '2025-07-15', stops: [stop('E', 4)] },
            { date: '2025-07-16', stops: [] },
            { date: '2025-07-17', stops: [] },
            { date: '2025-07-18', stops: [stop('F', 5)] },
        ],
    }));
    const [lendemain, unJourSaute, troisJoursSautes] = tl.legs.filter((leg) => leg.night);
    // Lendemain : durée de base ; un jour sauté : ×1,5 ; plafond ×2 au-delà.
    assert.equal(lendemain.endQ - lendemain.startQ, D.nightQ);
    assert.equal(unJourSaute.endQ - unJourSaute.startQ, Math.round(1.5 * D.nightQ));
    assert.equal(troisJoursSautes.endQ - troisJoursSautes.startQ, 2 * D.nightQ);
});

test('dayStats : bilan de la journée et trou calendaire', () => {
    const tl = buildParcoursTimeline(sample());
    const d1 = dayStats(tl, 0);
    assert.equal(d1.counted, 2);
    assert.ok(Math.abs(d1.km - 0.4) < 0.01);
    assert.equal(d1.gapDays, 1);
    const d2 = dayStats(tl, 1);
    assert.equal(d2.counted, 1);
    assert.equal(d2.gapDays, 2);
    // Le trajet de nuit qui amène la journée n'entre pas dans ses km.
    assert.equal(d2.km, 0);
    assert.equal(dayStats(tl, 5), null);
    assert.equal(dayStats(null, 0), null);
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

test('état affiché : PF donnés sur les trouvailles atteintes ({pf})', () => {
    const tl = buildParcoursTimeline(reconstructParcours({
        days: [{
            date: '2025-07-12',
            stops: [stop('A', 0, { logId: 1 }), stop('B', 4, { logId: 2, favorite: true })],
        }],
    }));
    const [a, b] = tl.stops;
    assert.equal(b.favorite, true);
    assert.equal(stateAt(tl, a.q).favorites, 0);
    assert.equal(stateAt(tl, b.q).favorites, 1);
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

test('nuit : assombrissement en cloche, nul le jour', () => {
    const tl = buildParcoursTimeline(sample());
    const night = tl.legs[1];
    assert.equal(nightLevelAt(tl, tl.stops[0].q), 0);
    assert.equal(nightLevelAt(tl, night.startQ), 0);
    assert.equal(nightLevelAt(tl, (night.startQ + night.endQ) / 2), 1);
    const quarter = nightLevelAt(tl, night.startQ + (night.endQ - night.startQ) * 0.15);
    assert.ok(quarter > 0 && quarter < 1);
    assert.equal(nightLevelAt(tl, tl.stops[2].q + 1), 0);
});

test('cartons de jour : le premier au début, les suivants pendant la nuit', () => {
    const tl = buildParcoursTimeline(sample());
    const night = tl.legs[1];
    assert.deepEqual(dayCardAt(tl, 0), { day: 0, alpha: 1 });
    assert.equal(dayCardAt(tl, tl.stops[0].q + 6 + 1), null);
    assert.equal(dayCardAt(tl, night.startQ + 1), null);
    const card = dayCardAt(tl, night.endQ);
    assert.equal(card.day, 1);
    assert.equal(card.alpha, 1);
    assert.ok(dayCardAt(tl, night.startQ + (night.endQ - night.startQ) * 0.3).alpha < 1);
    // Une seule journée : aucun carton.
    const single = buildParcoursTimeline(reconstructParcours({ days: [{ date: '2025-07-12', stops: [stop('A', 0)] }] }));
    assert.equal(dayCardAt(single, 0), null);
});

test('carton final : temps d’écran ajouté après l’outro, fondu en queue', () => {
    const plain = buildParcoursTimeline(sample());
    const tl = buildParcoursTimeline(sample(), { endCard: true });
    // `endCard` allonge la chronologie du temps du carton.
    assert.equal(tl.quanta, plain.quanta + D.endCardQ);
    assert.equal(endCardAt(tl, 0), null);
    assert.equal(endCardAt(tl, tl.quanta - D.endCardQ - 1), null);
    const start = tl.quanta - D.endCardQ;
    assert.ok(endCardAt(tl, start + 1).alpha < 1);          // fondu d'entrée
    assert.equal(endCardAt(tl, start + S.cardFadeQ + 1).alpha, 1);
    assert.ok(endCardAt(tl, tl.quanta - 2).alpha < 1);      // fondu de sortie
    assert.equal(endCardAt(tl, tl.quanta + 1), null);
    // Sans `endCard`, le carton retombe sur l'outro mais la durée ne bouge pas.
    assert.equal(buildParcoursTimeline(sample()).quanta, plain.quanta);
    assert.equal(endCardAt({ stops: [] }, 0), null);
});

test('tête : mode du trajet, déduit de la vitesse sur une trace ou en ligne droite', () => {
    const tl = buildParcoursTimeline(sample());
    const walk = tl.legs[0];
    assert.equal(legTravelMode(tl, 1), 'night');
    assert.equal(headModeAt(tl, (walk.startQ + walk.endQ) / 2), 'walk');
    // À l'arrêt : le trajet qui y a mené ; à la première étape, le suivant.
    assert.equal(headModeAt(tl, tl.stops[0].q + 1), 'walk');
    assert.equal(headModeAt(tl, tl.stops[1].q + 1), 'walk');
    assert.equal(headModeAt(tl, (tl.legs[1].startQ + tl.legs[1].endQ) / 2), 'night');
    const fake = (mode, km, minutes) => ({
        stops: [{ arrivalMin: 600, visitMin: 0 }, { arrivalMin: 600 + minutes }],
        legs: [{ from: 0, to: 1, km, mode, night: false }],
    });
    assert.equal(legTravelMode(fake('bike', 2, 60), 0), 'bike');
    assert.equal(legTravelMode(fake('track', 2, 30), 0), 'walk');
    assert.equal(legTravelMode(fake('track', 8, 30), 0), 'bike');
    assert.equal(legTravelMode(fake('track', 40, 30), 0), 'car');
    assert.equal(legTravelMode(fake('straight', 600, 90), 0), 'plane');
    assert.equal(legTravelMode(fake('straight', 3, NaN), 0), 'car');
});

test('barre de chronologie : arrivées par quantum, Labs à part, cumul', () => {
    const tl = buildParcoursTimeline(sample());
    const [a, b, c] = tl.stops;
    const s = barSeries(tl, 0, tl.quanta);
    assert.equal(s.events.length, tl.quanta);
    assert.equal(s.base, 0);
    assert.equal(s.events[a.q], 1);
    assert.equal(s.events[b.q], 1);
    assert.equal(s.secondary[c.q], 1); // C est un Lab
    assert.equal(s.events.reduce((x, y) => x + y, 0), 2);
    assert.equal(s.level[a.q - 1], 0);
    assert.equal(s.level[a.q], 1);
    assert.equal(s.level[tl.quanta - 1], 3);
    // Cumul cohérent avec l'état affiché au même quantum.
    for (const q of [a.q, b.q - 1, b.q, c.q, tl.quanta - 1]) {
        assert.equal(s.level[q], stateAt(tl, q).stopsReached, `quantum ${q}`);
    }
    // Piste décalée : les arrivées antérieures passent dans `base`.
    const late = barSeries(tl, b.q, tl.quanta - b.q);
    assert.equal(late.base, 1);
    assert.equal(late.events[0], 1);
    assert.equal(late.level[0], 2);
});

test('barre de chronologie : nuits et débuts de journée, heures d’une journée unique', () => {
    const tl = buildParcoursTimeline(sample());
    const night = tl.legs.find((leg) => leg.night);
    const ticks = barTicks(tl, 0, tl.quanta);
    assert.deepEqual(ticks.bands, [{ from: night.startQ, to: night.endQ }]);
    assert.deepEqual(ticks.days, [{ offset: 0, day: 0 }, { offset: tl.stops[2].q, day: 1 }]);
    assert.deepEqual(ticks.hours, []);

    // Une journée de 9:00 à 11:20 (heures sûres) : 10:00 et 11:00 marquées,
    // au premier quantum où l'heure affichée les atteint.
    const single = buildParcoursTimeline(reconstructParcours({
        days: [{ date: '2025-07-12', stops: [
            stop('A', 0, { localTime: '09:00' }),
            stop('B', 4, { localTime: '10:30' }),
            stop('C', 8, { localTime: '11:20' }),
        ] }],
    }));
    const one = barTicks(single, 0, single.quanta);
    assert.deepEqual(one.bands, []);
    assert.deepEqual(one.days, []);
    assert.deepEqual(one.hours.map((h) => h.hour), [10, 11]);
    for (const { offset, hour } of one.hours) {
        assert.ok(stateAt(single, offset).minutes >= hour * 60);
        assert.ok(stateAt(single, offset - 1).minutes < hour * 60);
    }
    assert.deepEqual(barTicks(null, 0, 10), { bands: [], days: [], hours: [] });
});

// Deux journées aux trajets francs : A, B (5 km), C (5 km) le 12 ; D (10 km)
// le 14 — assez de contenu élastique pour lire la réallocation sous durée
// imposée.
function journey() {
    return reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 50, { logId: 2 }), stop('C', 100, { logId: 3 })] },
            { date: '2025-07-13', stops: [] },
            { date: '2025-07-14', stops: [stop('D', 200, { logId: 4 })] },
        ],
    });
}

test('durée imposée : contenus à lire gardés, temps repris sur le reste', () => {
    const photos = new Map([['A', ['p1', 'p2', 'p3']]]);
    const opts = { photosByStop: photos, endCard: true };
    const natural = buildParcoursTimeline(journey(), opts);
    const tl = buildParcoursTimeline(journey(), { ...opts, timing: { msPerDay: QUANTUM_MS / 2, fixedTotal: true } });
    // Le total de quanta tient la durée imposée (à l'arrondi d'allocation près).
    assert.ok(Math.abs(tl.quanta - natural.quanta) <= tl.stops.length + tl.legs.length + 4);
    // Photos, nuit et carton final : davantage de quanta que la compression
    // uniforme (un quantum de 50 ms en demande le double pour le même écran).
    const [a] = tl.stops;
    assert.ok(a.photoQ * a.photos.length > D.photoQ * Math.min(3, D.maxPhotosPerStop));
    const night = tl.legs.find((leg) => leg.night);
    assert.ok(night.endQ - night.startQ > D.nightQ);
    assert.ok(tl.endCardQ > D.endCardQ);
    // …pris sur les trajets et les visites, qui se compressent.
    assert.ok(tl.legs[0].endQ - tl.legs[0].startQ < natural.legs[0].endQ - natural.legs[0].startQ);
    assert.ok(tl.stops[1].departQ - tl.stops[1].q < natural.stops[1].departQ - natural.stops[1].q);
    // Le carton final lit la fenêtre réellement allouée.
    assert.ok(endCardAt(tl, tl.quanta - tl.endCardQ + 1).alpha > 0);
    // L'état reste cohérent sur la chronologie réallouée.
    for (const q of [a.q, tl.stops[1].q, tl.quanta - 1]) {
        assert.equal(stopsInRange(tl, q, q).length, stateAt(tl, q).stopsReached - stateAt(tl, q - 1).stopsReached);
    }
});

test('rythme rapide : les planchers rallongent la chronologie', () => {
    const photos = new Map([['A', ['p1', 'p2', 'p3']]]);
    const opts = { photosByStop: photos, endCard: true };
    const natural = buildParcoursTimeline(journey(), opts);
    const tl = buildParcoursTimeline(journey(), { ...opts, timing: { msPerDay: QUANTUM_MS / 2, fixedTotal: false } });
    // Sans durée imposée, les planchers s'ajoutent : chaque contenu à lire
    // garde ses secondes (deux fois plus de quanta à 50 ms).
    const night = tl.legs.find((leg) => leg.night);
    // Le trou d'un jour allonge déjà la nuit à 1,5 × nightQ, le plancher
    // de secondes la double ensuite pour tenir l'écran (2 × 1,5 = 3 ×).
    assert.equal(night.endQ - night.startQ, 3 * D.nightQ);
    assert.equal(tl.stops[0].photoQ * 3, 2 * D.photoQ * 3);
    assert.equal(tl.endCardQ, 2 * D.endCardQ);
    // Visites et trajets inchangés ; la chronologie s'allonge d'autant.
    assert.equal(tl.legs[0].endQ - tl.legs[0].startQ, natural.legs[0].endQ - natural.legs[0].startQ);
    assert.equal(tl.stops[1].departQ - tl.stops[1].q, natural.stops[1].departQ - natural.stops[1].q);
    assert.ok(tl.quanta > natural.quanta);
    // L'arrivée de chaque étape reste avant son départ, dans l'ordre.
    let prev = 0;
    for (const stop of tl.stops) {
        assert.ok(stop.q > prev && stop.departQ > stop.q);
        prev = stop.departQ;
    }
});

test('quantum naturel ou plus lent : chronologie inchangée', () => {
    const photos = new Map([['A', ['p1']]]);
    const opts = { photosByStop: photos, endCard: true };
    const natural = buildParcoursTimeline(journey(), opts);
    for (const msPerDay of [QUANTUM_MS, 2 * QUANTUM_MS]) {
        const tl = buildParcoursTimeline(journey(), { ...opts, timing: { msPerDay, fixedTotal: true } });
        assert.equal(tl.quanta, natural.quanta);
        assert.deepEqual(tl.stops.map((stop) => [stop.q, stop.departQ]), natural.stops.map((stop) => [stop.q, stop.departQ]));
    }
});

test('scène : fondu et maintien du carton en temps écran', () => {
    assert.deepEqual(sceneTimingOptions(QUANTUM_MS), {});
    assert.deepEqual(sceneTimingOptions(2 * QUANTUM_MS), {});
    const o = sceneTimingOptions(QUANTUM_MS / 2);
    assert.equal(o.cardHoldQ, 2 * S.cardHoldQ);
    assert.equal(o.cardFadeQ, 2 * S.cardFadeQ);
});
