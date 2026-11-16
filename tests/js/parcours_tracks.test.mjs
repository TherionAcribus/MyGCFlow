// Traces GPS d'un parcours (static/js/parcours_tracks.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REASON_TRACK, reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline, headAt, legCut } from '../../static/js/parcours_timeline.mjs';
import {
    OFFSET_COMPUTER,
    OFFSET_EVIDENCE,
    OFFSET_MANUAL,
    OFFSET_PHOTOS,
    localClock,
    matchStopsToTracks,
    passesNear,
    reconstructWithEvidence,
    resolveUtcOffset,
    trackLegPaths,
} from '../../static/js/parcours_tracks.mjs';

// Repère : x en centaines de mètres vers l'est, y vers le nord, autour de
// (5°, 45°).
const LON_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));
const LAT_PER_100M = 0.1 / 111.195;
const lon = (x) => 5 + x * LON_PER_100M;
const lat = (y) => 45 + y * LAT_PER_100M;
const T0 = Date.UTC(2025, 6, 12, 8, 0, 0) / 1000;   // 12/07/2025 08:00 UTC
const pt = (x, y, minutes) => [lon(x), lat(y), T0 + minutes * 60];
const stop = (key, x, y = 0.2, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: lon(x), lat: lat(y), logId: null, localTime: null, ...extra,
});

// Aller : A (x=0) à 08:00, pause de 10 min à B (x=10) de 08:20 à 08:30,
// C (x=20) à 08:50 ; retour rapide par B (09:10) jusqu'à A (09:30).
const TRACK = {
    id: 7,
    segments: [[
        pt(0, 0, 0), pt(10, 0, 20), pt(10.05, 0, 25), pt(10, 0, 30), pt(20, 0, 50),
        pt(10, 0, 70), pt(0, 0, 90),
    ]],
};
const DAYS = [{ date: '2025-07-12', stops: [stop('A', 0), stop('B', 10), stop('C', 20)] }];

test('heure locale d’un instant UTC', () => {
    assert.deepEqual(localClock(T0, 120), { date: '2025-07-12', minutes: 600 });
    assert.deepEqual(localClock(T0, -9 * 60), { date: '2025-07-11', minutes: 23 * 60 });
});

test('passages : tronçons à moins du rayon, distance au tronçon et heure interpolée', () => {
    // À mi-chemin entre deux points gardés (simplifiés), à 20 m de la trace.
    const passes = passesNear([lon(5), lat(0.2)], [TRACK], 100);
    assert.equal(passes.length, 2);  // aller et retour
    const [aller] = passes;
    assert.ok(Math.abs(aller.minD - 20) < 0.5, String(aller.minD));
    const closest = aller.pieces.reduce((a, b) => (b.d < a.d ? b : a));
    assert.ok(Math.abs(closest.t - (T0 + 10 * 60)) < 2);
    assert.deepEqual(passesNear([lon(5), lat(5)], [TRACK], 100), []);
});

test('décalage UTC : réglage, EXIF des photos, Labs sur la trace, ordinateur', () => {
    const recon = reconstructParcours({ days: DAYS });
    assert.deepEqual(resolveUtcOffset({ parcours: { utc_offset_minutes: -300 } }), { minutes: -300, source: OFFSET_MANUAL });
    assert.deepEqual(resolveUtcOffset({ photos: [{ offsetMinutes: 120 }, { offsetMinutes: 60 }, { offsetMinutes: 120 }] }),
        { minutes: 120, source: OFFSET_PHOTOS });
    // Une étape Lab validée à 10:20 (heure murale), là où la trace passe à
    // 08:20 UTC : UTC+2.
    const withLab = reconstructParcours({
        days: [{ date: '2025-07-12', stops: [stop('L', 10, 0.1, { kind: 'lab', type: 'Lab Cache', localTime: '10:22' })] }],
    });
    assert.deepEqual(resolveUtcOffset({ tracks: [TRACK], reconstructed: withLab }), { minutes: 120, source: OFFSET_EVIDENCE });
    const fallback = resolveUtcOffset({ tracks: [TRACK], reconstructed: recon });
    assert.equal(fallback.source, OFFSET_COMPUTER);
    assert.ok(Number.isFinite(fallback.minutes));
});

test('rattachement : le passage où l’on s’attarde, arrivée au plus près', () => {
    const recon = reconstructParcours({ days: DAYS });
    const matches = matchStopsToTracks(recon, [TRACK], 120);
    // B : l'aller (pause de 10 min) l'emporte sur le retour rapide.
    const b = matches.get('B');
    assert.equal(b.trackId, 7);
    assert.ok(Math.abs(b.minutes - (10 * 60 + 20)) < 1.5, String(b.minutes));
    assert.ok(b.dwellS >= 10 * 60);
    // A : départ (aller) et retour ont une durée voisine : le plus long gagne.
    assert.ok(matches.has('A'));
    assert.ok(Math.abs(matches.get('C').minutes - (10 * 60 + 50)) < 1.5);
    // Autre jour : rien.
    const nextDay = reconstructParcours({ days: [{ date: '2025-07-13', stops: [stop('B', 10)] }] });
    assert.equal(matchStopsToTracks(nextDay, [TRACK], 120).size, 0);
    // Trop loin : rien.
    const far = reconstructParcours({ days: [{ date: '2025-07-12', stops: [stop('Z', 10, 3)] }] });
    assert.equal(matchStopsToTracks(far, [TRACK], 120).size, 0);
});

test('vrai chemin entre deux étapes rattachées, dans l’ordre', () => {
    const recon = reconstructParcours({ days: DAYS });
    const matches = matchStopsToTracks(recon, [TRACK], 120);
    const paths = trackLegPaths(recon, matches, [TRACK]);
    const ab = paths.get('B>C') || paths.get('A>B');
    assert.ok(ab && ab.length >= 2);
    for (const [x] of ab) assert.ok(Number.isFinite(x));
});

test('reconstruction : heures de la trace comme ancres, trajets sur la trace', () => {
    // Coude : de A vers le nord, puis vers l'est jusqu'à B.
    const corner = { id: 1, segments: [[pt(0, 0, 0), pt(0, 10, 20), pt(10, 10, 40)]] };
    const inputs = {
        parcours: { utc_offset_minutes: 120 },
        days: [{ date: '2025-07-12', stops: [stop('A', 0, 0), stop('B', 10, 10)] }],
        tracks: [corner],
    };
    const result = reconstructWithEvidence(inputs);
    const [a, b] = result.ordered.days[0].stops;
    assert.equal(a.arrivalMin, 600);
    assert.equal(Math.round(b.arrivalMin), 640);
    assert.equal(b.reason, REASON_TRACK);
    assert.equal(b.confidence, 'anchored');
    assert.deepEqual(result.utcOffset, { minutes: 120, source: OFFSET_MANUAL });
    const tl = buildParcoursTimeline(result.ordered, { legPaths: result.legPaths });
    const leg = tl.legs[0];
    assert.equal(leg.mode, 'track');
    assert.ok(Math.abs(leg.km - 2) < 0.01, String(leg.km));     // 1 km + 1 km, pas √2
    // À mi-trajet, le géocacheur est au coude, pas sur la diagonale.
    const mid = headAt(tl, (leg.startQ + leg.endQ) / 2);
    assert.ok(Math.abs(mid.lon - lon(0)) < 1e-6 && Math.abs(mid.lat - lat(10)) < 1e-6, JSON.stringify(mid));
    assert.deepEqual(legCut({ path: [[0, 0], [1, 0], [2, 0]], cum: [0, 1, 2] }, 0.75), { index: 1, f: 0.5 });
});
