import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    ALL_MAX_PER_DAY,
    buildTrailPath,
    buildTrailRoute,
    clusterPoints,
    composeTransform,
    groundDistanceKm,
    groupAnchor,
    lengthAtDay,
    nextDayIndex,
    normalizeTrailOptions,
    opacityBucket,
    orderStops,
    penLengthAt,
    PERMANENT_FLOOR_OPACITY,
    pointAtLength,
    scheduleStroke,
    SEGMENT_HIDDEN,
    SEGMENT_JUMP_DASHED,
    SEGMENT_NORMAL,
    splitTrailRuns,
    TRAIL_DEFAULTS,
    trailOpacity,
    visibleVertexRange,
} from './static/js/travel_trail.mjs';

// Quelques repères (lon, lat).
const PARIS = [2.3522, 48.8566];
const VERSAILLES = [2.1301, 48.8049];   // ~18 km de Paris
const LYON = [4.8357, 45.7640];         // ~390 km de Paris

// Point décalé de `km` vers l'est (approximation locale suffisante ici).
function east(point, km) {
    return [point[0] + km / (111.32 * Math.cos(point[1] * Math.PI / 180)), point[1]];
}

function north(point, km) {
    return [point[0], point[1] + km / 110.57];
}

test('les valeurs par défaut sont celles de defaultValues.json', () => {
    const json = JSON.parse(readFileSync(new URL('./static/json/defaultValues.json', import.meta.url), 'utf8'));
    assert.deepEqual(json.trail, { ...TRAIL_DEFAULTS });
});

test('normalizeTrailOptions borne et complète', () => {
    assert.deepEqual(normalizeTrailOptions(undefined), { ...TRAIL_DEFAULTS });
    const o = normalizeTrailOptions({
        enabled: true, routing: 'n/a', clusterKm: -3, jumpKm: 1e9, width: 0.2,
        opacity: '50', color: 'red', persistDays: 12, lineStyle: 'dotted', duration: 5,
    });
    assert.equal(o.enabled, true);
    assert.equal(o.routing, TRAIL_DEFAULTS.routing);
    assert.equal(o.clusterKm, 0.1);
    assert.equal(o.jumpKm, 5000);
    assert.equal(o.width, 1);
    assert.equal(o.opacity, 50);
    assert.equal(o.color, TRAIL_DEFAULTS.color);
    assert.equal(o.persistDays, TRAIL_DEFAULTS.persistDays);
    assert.equal(o.lineStyle, 'dotted');
    assert.equal(o.duration, 100);
    // « Tout le parcours » (0) est une valeur légitime, pas une absence.
    assert.equal(normalizeTrailOptions({ persistDays: 0 }).persistDays, 0);
    // Seul un vrai booléen active le trait.
    assert.equal(normalizeTrailOptions({ enabled: 'true' }).enabled, false);
});

test('deux villes éloignées le même jour forment deux groupes', () => {
    const points = [PARIS, east(PARIS, 0.5), VERSAILLES, east(VERSAILLES, 0.8), north(PARIS, 0.3)];
    const groups = clusterPoints(points, 2);
    assert.deepEqual(groups, [[0, 1, 4], [2, 3]]);
});

test('le regroupement suit les chaînes de proche en proche', () => {
    // Trois caches espacées de 1,5 km : chacune est à portée de sa voisine.
    const points = [PARIS, east(PARIS, 1.5), east(PARIS, 3)];
    assert.deepEqual(clusterPoints(points, 2), [[0, 1, 2]]);
    assert.deepEqual(clusterPoints(points, 1), [[0], [1], [2]]);
});

test('les coordonnées invalides sont ignorées', () => {
    assert.deepEqual(clusterPoints([PARIS, [NaN, 1], null, [0, 95]], 2), [[0]]);
    assert.deepEqual(clusterPoints([], 2), []);
});

test("l'étape d'un groupe est une vraie cache, la plus centrale", () => {
    const points = [east(PARIS, -1), PARIS, east(PARIS, 1), east(PARIS, 0.9)];
    const anchor = groupAnchor(points, [0, 1, 2, 3]);
    // Barycentre à +0,225 km : la cache à 0 km en est la plus proche.
    assert.equal(anchor, 1);
    assert.equal(groupAnchor(points, []), -1);
});

test('le plus proche voisin part de la position précédente', () => {
    const stops = [east(PARIS, 30), east(PARIS, 10), east(PARIS, 20)];
    assert.deepEqual(orderStops(stops, PARIS), [1, 2, 0]);
});

test('le 2-opt défait un croisement', () => {
    // Carré parcouru par le plus proche voisin depuis un coin décalé : sans
    // 2-opt, le chemin se croise ; la longueur doit baisser ou rester minimale.
    const a = PARIS;
    const stops = [east(a, 1), north(east(a, 1), 1), north(a, 1), east(a, 2.2), north(east(a, 2.2), 1)];
    const order = orderStops(stops, a);
    const length = (ids) => {
        let total = groundDistanceKm(a, stops[ids[0]]);
        for (let i = 1; i < ids.length; i++) total += groundDistanceKm(stops[ids[i - 1]], stops[ids[i]]);
        return total;
    };
    // Aucune permutation voisine (échange de deux étapes) ne fait mieux.
    for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
            const swapped = [...order];
            [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
            assert.ok(length(order) <= length(swapped) + 1e-9, `${order} vs ${swapped}`);
        }
    }
    assert.equal(new Set(order).size, stops.length);
});

test('sans point de départ, la journée est balayée depuis une extrémité', () => {
    const stops = [east(PARIS, 5), PARIS, east(PARIS, 10)];
    const order = orderStops(stops, null);
    assert.ok(order[0] === 1 || order[0] === 2, 'départ sur une extrémité');
    assert.equal(order[1], 0);
});

test('mode « un point par jour » : une seule étape quotidienne', () => {
    const route = buildTrailRoute([
        { day: 10, points: [PARIS, VERSAILLES, east(PARIS, 1)] },
        { day: 12, points: [LYON] },
    ], { routing: 'day' });
    assert.equal(route.lon.length, 2);
    assert.deepEqual([...route.days], [10, 12]);
    assert.deepEqual([...route.dayLastStop], [0, 1]);
});

test('mode « groupes » : une étape par groupe, enchaînées depuis la veille', () => {
    const route = buildTrailRoute([
        { day: 2, points: [LYON] },
        { day: 1, points: [PARIS] },
        { day: 3, points: [VERSAILLES, east(LYON, 1), PARIS] },
    ], { routing: 'clusters', clusterKm: 2 });
    assert.deepEqual([...route.days], [1, 2, 3]);
    // Jour 3 : on repart de Lyon, donc la cache près de Lyon d'abord.
    assert.deepEqual([...route.day], [1, 2, 3, 3, 3]);
    assert.ok(groundDistanceKm([route.lon[2], route.lat[2]], LYON) < 2);
    assert.equal(route.dayLastStop[2], 4);
});

test('mode « toutes les caches » : repli sur les groupes au-delà du plafond', () => {
    const many = Array.from({ length: ALL_MAX_PER_DAY + 1 }, (_, i) => east(PARIS, i * 0.001));
    const route = buildTrailRoute([{ day: 1, points: many }], { routing: 'all', clusterKm: 2 });
    assert.equal(route.lon.length, 1);
    const few = [PARIS, east(PARIS, 0.1), east(PARIS, 0.2)];
    assert.equal(buildTrailRoute([{ day: 1, points: few }], { routing: 'all' }).lon.length, 3);
});

test('le trajet est déterministe', () => {
    const days = Array.from({ length: 40 }, (_, d) => ({
        day: d,
        points: Array.from({ length: 7 }, (_, i) => east(north(PARIS, (d * 7 + i) % 13), (d * 3 + i * 5) % 17)),
    }));
    const a = buildTrailRoute(days, { routing: 'clusters' });
    const b = buildTrailRoute(days.map((d) => ({ day: d.day, points: [...d.points] })), { routing: 'clusters' });
    assert.deepEqual(a, b);
    const pa = buildTrailPath(a, { curve: 'smooth' });
    const pb = buildTrailPath(b, { curve: 'smooth' });
    assert.deepEqual(pa, pb);
});

test('grands sauts : arc, pointillés ou trait masqué', () => {
    const route = buildTrailRoute([
        { day: 1, points: [PARIS] },
        { day: 2, points: [VERSAILLES] },
        { day: 3, points: [LYON] },
    ], { routing: 'day' });

    const straight = buildTrailPath(route, { jumpKm: 150, jumpStyle: 'straight' });
    assert.equal(straight.cum.length, 3);
    assert.deepEqual([...straight.kind], [SEGMENT_NORMAL, SEGMENT_NORMAL, SEGMENT_NORMAL]);

    const dashed = buildTrailPath(route, { jumpKm: 150, jumpStyle: 'dashed' });
    assert.equal(dashed.kind[2], SEGMENT_JUMP_DASHED);
    assert.equal(dashed.kind[1], SEGMENT_NORMAL, 'Paris -> Versailles reste un trajet local');

    const hidden = buildTrailPath(route, { jumpKm: 150, jumpStyle: 'hidden' });
    assert.equal(hidden.kind[2], SEGMENT_HIDDEN);

    const arc = buildTrailPath(route, { jumpKm: 150, jumpStyle: 'arc' });
    assert.ok(arc.cum.length > 3, "l'arc est échantillonné");
    assert.equal(arc.stopVertex[2], arc.cum.length - 1);
    // Le milieu de l'arc s'écarte de la corde d'environ 20 % de sa longueur.
    const from = [route.lon[1], route.lat[1]];
    const to = [route.lon[2], route.lat[2]];
    const mid = Math.floor((arc.stopVertex[1] + arc.stopVertex[2]) / 2);
    const chord = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const px = arc.xy[2 * mid];
    const py = arc.xy[2 * mid + 1];
    const offset = Math.abs((to[0] - from[0]) * (from[1] - py) - (from[0] - px) * (to[1] - from[1])) / chord;
    assert.ok(offset > chord * 0.15 && offset < chord * 0.25, `écart ${offset / chord}`);
    // L'arc est plus long que la corde.
    assert.ok(arc.length > straight.length);
});

test('le lissage passe par toutes les étapes', () => {
    const route = buildTrailRoute([
        { day: 1, points: [PARIS] },
        { day: 2, points: [east(north(PARIS, 5), 5)] },
        { day: 3, points: [east(PARIS, 10)] },
    ], { routing: 'day' });
    const path = buildTrailPath(route, { curve: 'smooth', jumpKm: 150 });
    assert.ok(path.cum.length > 3);
    for (let i = 0; i < route.lon.length; i++) {
        const v = path.stopVertex[i];
        assert.equal(path.xy[2 * v], route.lon[i]);
        assert.equal(path.xy[2 * v + 1], route.lat[i]);
    }
    // Longueurs cumulées croissantes, jours croissants.
    for (let v = 1; v < path.cum.length; v++) {
        assert.ok(path.cum[v] >= path.cum[v - 1]);
        assert.ok(path.vday[v] >= path.vday[v - 1]);
    }
});

test('longueur et index des jours de trouvailles', () => {
    const route = buildTrailRoute([
        { day: 5, points: [[0, 0]] },
        { day: 8, points: [[1, 0]] },
        { day: 9, points: [[1, 1]] },
    ], { routing: 'day' });
    const path = buildTrailPath(route, { jumpKm: 5000 });
    assert.equal(nextDayIndex(route, 4), 0);
    assert.equal(nextDayIndex(route, 5), 1);
    assert.equal(nextDayIndex(route, 7), 1);
    assert.equal(nextDayIndex(route, 9), 3);
    assert.equal(lengthAtDay(route, path, 0), 0);
    assert.equal(lengthAtDay(route, path, 1), 1);
    assert.equal(lengthAtDay(route, path, 2), 2);
});

test('à l\'heure, le trait part au plus tard et arrive avec les caches', () => {
    const pen = { fromLen: 0, toLen: 10, startAt: 0, endAt: 100 };
    const next = scheduleStroke(pen, { now: 1000, targetLen: 30, arrivalAt: 3000, maxDurationMs: 800, behindLen: 10 });
    assert.deepEqual(next, { fromLen: 10, toLen: 30, startAt: 2200, endAt: 3000 });
    assert.equal(penLengthAt(next, 2000), 10, 'attend sur place');
    assert.equal(penLengthAt(next, 3000), 30, 'arrive à l\'apparition');
    assert.equal(penLengthAt(next, 2600), 20, 'mi-parcours à mi-temps (courbe symétrique)');
});

test('un écart court raccourcit le trait', () => {
    const pen = { fromLen: 0, toLen: 10, startAt: 0, endAt: 100 };
    const next = scheduleStroke(pen, { now: 1000, targetLen: 30, arrivalAt: 1050, maxDurationMs: 800, behindLen: 10 });
    assert.deepEqual(next, { fromLen: 10, toLen: 30, startAt: 1000, endAt: 1050 });
});

test('en retard, le trait repart tout de suite de sa position courante', () => {
    // Le trait précédent (0 -> 10) n'est qu'à mi-chemin.
    const pen = { fromLen: 0, toLen: 10, startAt: 0, endAt: 100 };
    const next = scheduleStroke(pen, { now: 50, targetLen: 30, arrivalAt: 5000, maxDurationMs: 800, behindLen: 10 });
    assert.equal(next.fromLen, 5);
    assert.equal(next.startAt, 50, 'pas d\'attente');
    assert.equal(next.endAt, 850);
    assert.equal(penLengthAt(next, 50), 5, 'aucun saut');
    // Stylo posé mais en deçà des caches déjà affichées : aussi en retard.
    const idle = { fromLen: 0, toLen: 0, startAt: 0, endAt: 0 };
    const late = scheduleStroke(idle, { now: 10, targetLen: 30, arrivalAt: 5000, maxDurationMs: 800, behindLen: 20 });
    assert.equal(late.startAt, 10);
});

test('le stylo ne recule jamais', () => {
    const pen = { fromLen: 0, toLen: 50, startAt: 0, endAt: 0 };
    const next = scheduleStroke(pen, { now: 10, targetLen: 20, arrivalAt: 100, maxDurationMs: 800 });
    assert.equal(next.toLen, 50);
    assert.equal(penLengthAt(next, 1000), 50);
});

test('point et plage visibles du trajet', () => {
    const path = {
        xy: Float64Array.from([0, 0, 10, 0, 10, 10, 20, 10]),
        cum: Float64Array.from([0, 10, 20, 30]),
        vday: Int32Array.from([1, 2, 3, 4]),
        kind: new Uint8Array(4),
    };
    assert.deepEqual(pointAtLength(path, 15), { x: 10, y: 5, segment: 2 });
    assert.deepEqual(pointAtLength(path, 10), { x: 10, y: 0, segment: 1 });
    assert.deepEqual(visibleVertexRange(path, 15, 0), { first: 1, last: 2, partial: true, point: [10, 5] });
    assert.deepEqual(visibleVertexRange(path, 30, 3), { first: 2, last: 3, partial: false, point: [20, 10] });
    assert.equal(visibleVertexRange(path, 0, 0), null, 'rien de tracé');
    assert.equal(visibleVertexRange(path, 15, 4), null, 'tout est trop ancien');
});

test('opacité : traînée qui s\'efface et parcours complet atténué', () => {
    assert.equal(trailOpacity(0, 30), 1);
    assert.equal(trailOpacity(30, 30), 0);
    assert.ok(trailOpacity(10, 30) > trailOpacity(20, 30));
    assert.equal(trailOpacity(-5, 30), 1, 'segment en cours de tracé');
    assert.equal(trailOpacity(0, 0), 1);
    assert.ok(Math.abs(trailOpacity(1000, 0) - PERMANENT_FLOOR_OPACITY) < 1e-12);
    assert.equal(opacityBucket(0), 0);
    assert.equal(opacityBucket(1), 1);
    assert.equal(opacityBucket(0.3), 0.375);
    assert.equal(opacityBucket(0.25), 0.25);
});

test('découpage en tronçons de même type et même opacité', () => {
    const kind = Uint8Array.from([0, 0, 0, 2, 0, 0]);
    const bucket = [0, 0.5, 0.5, 0.5, 1, 1];
    const runs = splitTrailRuns(kind, (v) => bucket[v], 1, 5);
    assert.deepEqual(runs, [
        { kind: 0, bucket: 0.5, start: 1, end: 2 },
        { kind: 2, bucket: 0.5, start: 3, end: 3 },
        { kind: 0, bucket: 1, start: 4, end: 5 },
    ]);
});

test('transformation composée = application successive', () => {
    const inner = [2, 0, 0, -2, 10, 20];
    const outer = [0.5, 0.1, -0.1, 0.5, 3, 4];
    const apply = (t, [x, y]) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    const m = composeTransform(outer, inner);
    const p = [7, -3];
    const expected = apply(outer, apply(inner, p));
    const actual = apply(m, p);
    assert.ok(Math.abs(actual[0] - expected[0]) < 1e-12);
    assert.ok(Math.abs(actual[1] - expected[1]) < 1e-12);
});

test('précalcul sur un gros jeu de données (mesure)', () => {
    // 50 000 caches sur 3 000 jours, réparties sur la France.
    let seed = 42;
    const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };
    const days = [];
    let total = 0;
    for (let d = 0; d < 3000 && total < 50000; d++) {
        const center = [-1 + random() * 8, 43 + random() * 6];
        const count = 1 + Math.floor(random() * 32);
        const points = [];
        for (let i = 0; i < count && total < 50000; i++, total++) {
            points.push([center[0] + (random() - 0.5) * 0.3, center[1] + (random() - 0.5) * 0.2]);
        }
        days.push({ day: d, points });
    }
    const t0 = performance.now();
    const route = buildTrailRoute(days, { routing: 'clusters', clusterKm: 2 });
    const t1 = performance.now();
    const path = buildTrailPath(route, { curve: 'smooth', jumpKm: 150, jumpStyle: 'arc' });
    const t2 = performance.now();
    console.log(`[trail] ${total} caches, ${route.lon.length} étapes, ${path.cum.length} sommets : `
        + `trajet ${(t1 - t0).toFixed(1)} ms, géométrie ${(t2 - t1).toFixed(1)} ms`);
    assert.ok(route.lon.length > 0);
    // Garde-fou très large : seul un emballement (quadratique global) échoue.
    assert.ok(t2 - t0 < 5000);
});
