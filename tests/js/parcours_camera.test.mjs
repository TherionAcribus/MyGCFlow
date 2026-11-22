// Caméra de la lecture d'un parcours (static/js/parcours_camera.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CAMERA_DEFAULTS,
    cameraPoseAt,
    overviewBox,
    resolutionForZoom,
    toMercator,
} from '../../static/js/parcours_camera.mjs';
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline, headAt } from '../../static/js/parcours_timeline.mjs';

const KM_LON = 1 / (111.195 * Math.cos(45 * Math.PI / 180));
const KM_LAT = 1 / 111.195;
const stop = (key, xKm, extra = {}, yKm = 0) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: 5 + xKm * KM_LON, lat: 45 + yKm * KM_LAT, logId: null, localTime: null, ...extra,
});
const SIZE = [800, 600];
// Une image d'une vidéo à 25 i/s : 0,4 quantum (1 quantum = 100 ms).
const FRAME_Q = 0.4;

// Samedi : A, B (300 m), puis C à 20 km ; dimanche : D à 120 km.
function sample() {
    return buildParcoursTimeline(reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 0.3, { logId: 2 }), stop('C', 20.3, { logId: 3 })] },
            { date: '2025-07-13', stops: [stop('D', 140)] },
        ],
    }));
}

// Une balade en zigzag : des caches à 300-700 m les unes des autres.
function walk() {
    const points = [[0, 0], [0.3, 0.2], [0.1, 0.6], [0.6, 0.8], [0.9, 0.3], [1.4, 0.5], [1.2, 1.0]];
    return buildParcoursTimeline(reconstructParcours({
        days: [{ date: '2025-07-12', stops: points.map(([x, y], i) => stop(`w${i}`, x, { logId: i + 1 }, y)) }],
    }));
}

const span = (pose) => pose.resolution * SIZE[0];

// Position du géocacheur à l'écran, en part du demi-écran (0 = centre, 1 = bord).
function headShare(tl, q, pose) {
    const head = headAt(tl, q);
    const [hx, hy] = toMercator(head.lon, head.lat);
    return Math.max(
        Math.abs(hx - pose.center[0]) / pose.resolution / (SIZE[0] / 2),
        Math.abs(hy - pose.center[1]) / pose.resolution / (SIZE[1] / 2),
    );
}

test('pose : serrée à pied, dézoom sur le long trajet et la nuit, vue d’ensemble à la fin', () => {
    const tl = sample();
    const [a, b] = tl.stops;
    const atA = cameraPoseAt(tl, a.q + 2, SIZE);
    const atB = cameraPoseAt(tl, b.q + 4, SIZE);
    const longLeg = tl.legs[1];
    const driving = cameraPoseAt(tl, (longLeg.startQ + longLeg.endQ) / 2, SIZE);
    const night = tl.legs[2];
    const asleep = cameraPoseAt(tl, (night.startQ + night.endQ) / 2, SIZE);
    const end = cameraPoseAt(tl, tl.quanta, SIZE);
    assert.ok(span(atA) < 5000, `à pied : ${span(atA)} m`);
    assert.ok(span(driving) > 4 * span(atB));
    assert.ok(span(asleep) > span(driving));
    assert.ok(span(end) >= span(asleep) * 0.9);
    // Jamais plus près que le zoom maximal.
    assert.ok(atA.resolution >= resolutionForZoom(CAMERA_DEFAULTS.maxZoom) - 1e-9);
    assert.ok(atA.zoom <= CAMERA_DEFAULTS.maxZoom + 1e-9);
    // Le cadrage multiplie l'emprise visée, partout dans la lecture.
    for (const q of [a.q + 2, (night.startQ + night.endQ) / 2, tl.quanta]) {
        const wide = cameraPoseAt(tl, q, SIZE, { frame: 1.5 });
        const tight = cameraPoseAt(tl, q, SIZE, { frame: 0.7 });
        const mid = cameraPoseAt(tl, q, SIZE);
        assert.ok(wide.resolution > mid.resolution, `large @${q}`);
        assert.ok(tight.resolution <= mid.resolution + 1e-9, `serré @${q}`);
    }
    // À la fin, toutes les étapes sont à l'écran.
    const box = overviewBox(tl);
    for (const [x, y] of [[box[0], box[1]], [box[2], box[3]]]) {
        assert.ok(Math.abs(x - end.center[0]) / end.resolution <= SIZE[0] / 2);
        assert.ok(Math.abs(y - end.center[1]) / end.resolution <= SIZE[1] / 2);
    }
});

test('pose : le géocacheur reste près du centre, zoom et déplacement doux', () => {
    for (const tl of [sample(), walk()]) {
        let previous = null;
        for (let q = 0; q <= tl.quanta; q += FRAME_Q) {
            const pose = cameraPoseAt(tl, q, SIZE);
            assert.ok(headShare(tl, q, pose) <= 0.7, `q=${q} : ${headShare(tl, q, pose)}`);
            if (previous) {
                // Au plus ~2 niveaux de zoom par seconde (la piste les borne).
                const levels = Math.abs(Math.log2(pose.resolution / previous.resolution));
                assert.ok(levels <= (CAMERA_DEFAULTS.maxZoomPerQ * FRAME_Q) * 1.05, `q=${q} : ${levels} niveau(x)`);
                // Pas de saut : au plus 20 px d'une image à l'autre.
                const px = Math.hypot(pose.center[0] - previous.center[0], pose.center[1] - previous.center[1]) / pose.resolution;
                assert.ok(px <= 20, `q=${q} : ${px} px`);
            }
            previous = pose;
        }
    }
});

test('pose : la caméra ne part pas avant le géocacheur', () => {
    const tl = walk();
    for (const leg of tl.legs) {
        // Une seconde avant le départ, la caméra ne s'est pas encore mise en route.
        const q = leg.startQ - 10;
        if (q < tl.stops[leg.from].q) continue;
        const pose = cameraPoseAt(tl, q, SIZE);
        assert.ok(headShare(tl, q, pose) < 0.05, `trajet ${leg.from}>${leg.to} : ${headShare(tl, q, pose)}`);
    }
});

test('pose : pas de respiration du zoom pendant une balade', () => {
    const tl = walk();
    const first = tl.stops[0].departQ;
    // Jusqu'à l'avant-dernière étape : ensuite vient le dézoom de la vue d'ensemble.
    const last = tl.stops[tl.stops.length - 2].q;
    const zooms = [];
    for (let q = first; q <= last; q += FRAME_Q) zooms.push(cameraPoseAt(tl, q, SIZE).zoom);
    // Un seul cadre pour toute la balade : à peine un quart de niveau d'écart.
    assert.ok(Math.max(...zooms) - Math.min(...zooms) < 0.25, `${Math.min(...zooms)} → ${Math.max(...zooms)}`);
});

test('pose : même résultat quel que soit le chemin (déterministe)', () => {
    const tl = sample();
    const q = tl.legs[1].startQ + 3.4;
    const direct = cameraPoseAt(tl, q, SIZE);
    // Une autre taille de vue construit une autre piste, sans toucher celle-ci.
    cameraPoseAt(tl, q, [1920, 1080]);
    for (let r = 0; r < q; r += 0.7) cameraPoseAt(tl, r, SIZE);
    assert.deepEqual(cameraPoseAt(tl, q, SIZE), direct);
    assert.deepEqual(cameraPoseAt(sample(), q, SIZE), direct);
    assert.equal(cameraPoseAt(tl, q, [0, 0]), null);
    assert.equal(cameraPoseAt(null, q, SIZE), null);
    assert.equal(overviewBox({ stops: [], legs: [] }), null);
});

test('durée imposée : le confort de la caméra se mesure en temps écran', () => {
    const tl = sample();
    // La vitesse de zoom est bornée par seconde d'écran : à quantum comprimé
    // (durée imposée, musique), le même plafond par milliseconde doit tenir.
    const maxZoomRate = (msPerDay) => {
        let worst = 0;
        for (let q = 0; q + FRAME_Q <= tl.quanta; q += FRAME_Q) {
            const a = cameraPoseAt(tl, q, SIZE, { msPerDay });
            const b = cameraPoseAt(tl, q + FRAME_Q, SIZE, { msPerDay });
            worst = Math.max(worst, Math.abs(b.zoom - a.zoom) / (FRAME_Q * msPerDay));
        }
        return worst;
    };
    assert.ok(maxZoomRate(50) <= maxZoomRate(100) * 1.05);
    assert.ok(maxZoomRate(50) <= 0.0026);  // 2,5 niveaux par seconde d'écran
    // Au rythme naturel, `msPerDay` explicite ne change rien.
    const q = tl.stops[1].q + 2;
    assert.deepEqual(cameraPoseAt(tl, q, SIZE, { msPerDay: 100 }), cameraPoseAt(tl, q, SIZE));
});
