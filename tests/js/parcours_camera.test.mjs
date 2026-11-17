// Caméra de la lecture d'un parcours (static/js/parcours_camera.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CAMERA_DEFAULTS,
    cameraFocusAt,
    cameraPoseAt,
    overviewBox,
    resolutionForZoom,
    toMercator,
} from '../../static/js/parcours_camera.mjs';
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline, headAt } from '../../static/js/parcours_timeline.mjs';

const KM_LON = 1 / (111.195 * Math.cos(45 * Math.PI / 180));
const stop = (key, xKm, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: 5 + xKm * KM_LON, lat: 45, logId: null, localTime: null, ...extra,
});
const SIZE = [800, 600];

// Samedi : A, B (300 m), puis C à 20 km ; dimanche : D à 120 km.
function sample() {
    return buildParcoursTimeline(reconstructParcours({
        days: [
            { date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 0.3, { logId: 2 }), stop('C', 20.3, { logId: 3 })] },
            { date: '2025-07-13', stops: [stop('D', 140)] },
        ],
    }));
}

const span = (pose) => pose.resolution * SIZE[0];

test('cadrage visé : étape, trajet, nuit, vue d’ensemble', () => {
    const tl = sample();
    const [a, , c, d] = tl.stops;
    assert.ok(cameraFocusAt(tl, a.q)[2] - cameraFocusAt(tl, a.q)[0] < 1000);
    const long = tl.legs[1];
    const box = cameraFocusAt(tl, (long.startQ + long.endQ) / 2);
    assert.ok(box[2] - box[0] > 20000 * 0.99 / Math.cos(45 * Math.PI / 180) * 0.7);
    const night = tl.legs[2];
    assert.equal(night.night, true);
    const nightBox = cameraFocusAt(tl, night.startQ + 1);
    assert.ok(nightBox[0] <= toMercator(c.lon, c.lat)[0] && nightBox[2] >= toMercator(d.lon, d.lat)[0]);
    assert.deepEqual(cameraFocusAt(tl, tl.quanta), overviewBox(tl));
    assert.equal(cameraFocusAt({ stops: [], legs: [] }, 0), null);
});

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
});

test('pose : continue d’un quantum à l’autre, et le géocacheur reste dans l’écran', () => {
    const tl = sample();
    let previous = null;
    for (let q = 0; q <= tl.quanta; q += 0.25) {
        const pose = cameraPoseAt(tl, q, SIZE);
        const head = headAt(tl, q);
        const [hx, hy] = toMercator(head.lon, head.lat);
        const dx = Math.abs(hx - pose.center[0]) / pose.resolution;
        const dy = Math.abs(hy - pose.center[1]) / pose.resolution;
        assert.ok(dx <= SIZE[0] / 2 - CAMERA_DEFAULTS.headMarginPx + 1e-6, `q=${q} dx=${dx}`);
        assert.ok(dy <= SIZE[1] / 2 - CAMERA_DEFAULTS.headMarginPx + 1e-6, `q=${q} dy=${dy}`);
        if (previous) {
            // Variation de zoom bornée entre deux images (pas de saut).
            assert.ok(Math.abs(Math.log2(pose.resolution / previous.resolution)) < 0.35, `q=${q}`);
        }
        previous = pose;
    }
});

test('pose : même résultat quel que soit le chemin (déterministe)', () => {
    const tl = sample();
    const q = tl.legs[1].startQ + 3.4;
    assert.deepEqual(cameraPoseAt(tl, q, SIZE), cameraPoseAt(tl, q, SIZE));
    assert.equal(cameraPoseAt(tl, q, [0, 0]), null);
    assert.equal(cameraPoseAt(null, q, SIZE), null);
});
