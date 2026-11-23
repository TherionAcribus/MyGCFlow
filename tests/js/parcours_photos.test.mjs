// Photos d'un parcours (static/js/parcours_photos.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MATCH_GPS,
    MATCH_MANUAL,
    MATCH_TIME,
    cameraKey,
    cameraOffsets,
    photoCameraOffset,
    matchPhotos,
    photoAnchors,
    photoClock,
    photoTimeTrusted,
    photosByStop,
    reconstructWithPhotos,
    suggestPhotoPlaces,
} from '../../static/js/parcours_photos.mjs';
import { REASON_PHOTO, reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline } from '../../static/js/parcours_timeline.mjs';

const DEG_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));
const at = (x) => 5 + x * DEG_PER_100M;
const stop = (key, x, extra = {}) => ({
    key, kind: 'find', type: 'Traditional Cache', lon: at(x), lat: 45, logId: null, localTime: null, ...extra,
});
// Trois caches alignées, 1 km entre chacune, logs dans l'ordre.
const DAYS = [{ date: '2025-07-12', stops: [stop('A', 0, { logId: 1 }), stop('B', 10, { logId: 2 }), stop('C', 20, { logId: 3 })] }];
const photo = (id, extra = {}) => ({ id, takenAt: null, lat: null, lon: null, camera: null, stopKey: null, ...extra });

test('heure corrigée : décalage de l’appareil, passage de minuit', () => {
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 90 }, { camera: 'X', offsetMinutes: 'n' }]);
    assert.deepEqual([...offsets], [['Canon', 90]]);
    assert.deepEqual(photoClock(photo(1, { takenAt: '2025-07-12T10:30:00' })), { date: '2025-07-12', minutes: 630 });
    assert.deepEqual(photoClock(photo(1, { takenAt: '2025-07-12T23:00:00', camera: 'Canon' }), offsets),
        { date: '2025-07-13', minutes: 30 });
    assert.equal(photoClock(photo(1, { takenAt: '12/07/2025' })), null);
});

test('heure de confiance : téléphone géolocalisé ou appareil recalé', () => {
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 0 }]);
    assert.equal(photoTimeTrusted(photo(1, { takenAt: '2025-07-12T10:00:00', lat: 45, lon: 5 })), true);
    assert.equal(photoTimeTrusted(photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Canon' }), offsets), true);
    assert.equal(photoTimeTrusted(photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Nikon' }), offsets), false);
    assert.equal(photoTimeTrusted(photo(1, { lat: 45, lon: 5 })), false);
});

test('deux boîtiers du même modèle : une horloge chacun, repli sur le modèle', () => {
    const a = photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D', cameraSerial: '111' });
    const b = photo(2, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D', cameraSerial: '222' });
    const old = photo(3, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D' });  // sans numéro
    assert.equal(cameraKey(a), 'Canon EOS 80D#111');
    assert.equal(cameraKey(old), 'Canon EOS 80D');
    assert.equal(cameraKey(photo(4)), null);
    // Boîtier A recalé seul : B reste non recalé.
    let offsets = cameraOffsets([{ camera: 'Canon EOS 80D#111', offsetMinutes: 30 }]);
    assert.equal(photoClock(a, offsets).minutes, 10 * 60 + 30);
    assert.equal(photoClock(b, offsets).minutes, 10 * 60);
    assert.equal(photoTimeTrusted(b, offsets), false);
    assert.equal(photoTimeTrusted(old, offsets), false);
    // Recalage du modèle (photos d'avant le numéro de série) : hérité par
    // les boîtiers qui n'en ont pas à eux.
    offsets = cameraOffsets([{ camera: 'Canon EOS 80D#111', offsetMinutes: 30 }, { camera: 'Canon EOS 80D', offsetMinutes: -60 }]);
    assert.equal(photoCameraOffset(a, offsets), 30);
    assert.equal(photoCameraOffset(b, offsets), -60);
    assert.equal(photoCameraOffset(old, offsets), -60);
    assert.equal(photoTimeTrusted(b, offsets), true);
    assert.equal(photoCameraOffset(photo(4), offsets), undefined);
});

test('rattachement : manuel, par position (même jour), par l’heure, ou rien', () => {
    const ordered = reconstructParcours({ days: DAYS });
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 0 }]);
    const b = ordered.days[0].stops.find((s) => s.key === 'B');
    const photos = [
        photo(1, { stopKey: 'C' }),
        photo(2, { stopKey: 'ZZZ' }),
        photo(3, { lat: 45, lon: at(10.5), takenAt: '2025-07-12T11:00:00' }),      // 50 m de B
        photo(4, { lat: 45, lon: at(10.5), takenAt: '2025-07-13T11:00:00' }),      // autre jour
        photo(5, { lat: 45, lon: at(15) }),                                       // 500 m de tout
        photo(6, { camera: 'Canon', takenAt: `2025-07-12T${String(Math.floor(b.arrivalMin / 60)).padStart(2, '0')}:${String(Math.round(b.arrivalMin % 60)).padStart(2, '0')}:00` }),
        photo(7, { camera: 'Nikon', takenAt: '2025-07-12T10:00:00' }),             // heure non recalée
    ];
    const matches = matchPhotos(ordered, photos, offsets);
    assert.deepEqual(matches.get(1), { key: 'C', source: MATCH_MANUAL });
    assert.deepEqual(matches.get(2), { key: null, source: null, lostKey: 'ZZZ' });
    assert.equal(matches.get(3).key, 'B');
    assert.equal(matches.get(3).source, MATCH_GPS);
    assert.ok(matches.get(3).distanceM < 60);
    assert.deepEqual(matches.get(4), { key: null, source: null });
    assert.deepEqual(matches.get(5), { key: null, source: null });
    assert.deepEqual(matches.get(6), { key: 'B', source: MATCH_TIME });
    assert.deepEqual(matches.get(7), { key: null, source: null });
});

test('étape choisie à la main puis retirée : rattachement automatique en attendant son retour', () => {
    const ordered = reconstructParcours({ days: DAYS });
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 0 }]);
    const b = ordered.days[0].stops.find((s) => s.key === 'B');
    const hhmm = `${String(Math.floor(b.arrivalMin / 60)).padStart(2, '0')}:${String(Math.round(b.arrivalMin % 60)).padStart(2, '0')}`;
    const photos = [
        photo(1, { stopKey: 'place:9', lat: 45, lon: at(10.5), takenAt: '2025-07-12T11:00:00' }),  // 50 m de B
        photo(2, { stopKey: 'place:9', camera: 'Canon', takenAt: `2025-07-12T${hhmm}:00` }),
        photo(3, { stopKey: 'place:9', lat: 45, lon: at(5), takenAt: '2025-07-12T12:00:00' }),     // loin de tout
    ];
    const matches = matchPhotos(ordered, photos, offsets);
    assert.equal(matches.get(1).key, 'B');
    assert.equal(matches.get(1).source, MATCH_GPS);
    assert.equal(matches.get(1).lostKey, 'place:9');
    assert.deepEqual(matches.get(2), { key: 'B', source: MATCH_TIME, lostKey: 'place:9' });
    assert.deepEqual(matches.get(3), { key: null, source: null, lostKey: 'place:9' });
    // Rattachée par position, elle cale son étape comme une autre ; hors de
    // tout, elle est proposée comme lieu.
    assert.deepEqual([...photoAnchors(ordered, photos, matches, offsets)], [['B', 11 * 60]]);
    assert.deepEqual(suggestPhotoPlaces(photos, matches, offsets).map((p) => p.photoIds), [[3]]);
    // L'étape revient : la photo la retrouve.
    const back = reconstructParcours({ days: [{ ...DAYS[0], stops: [...DAYS[0].stops, stop('place:9', 30)] }] });
    assert.deepEqual(matchPhotos(back, photos, offsets).get(3), { key: 'place:9', source: MATCH_MANUAL });
});

test('ancres : position ou manuel, heure de confiance, la plus tôt par étape', () => {
    const ordered = reconstructParcours({ days: DAYS });
    const photos = [
        photo(1, { lat: 45, lon: at(10), takenAt: '2025-07-12T14:20:00' }),
        photo(2, { lat: 45, lon: at(10.2), takenAt: '2025-07-12T14:10:00' }),
        photo(3, { stopKey: 'C', takenAt: '2025-07-12T16:00:00', camera: 'Nikon' }),  // non recalé : pas d'ancre
    ];
    const matches = matchPhotos(ordered, photos);
    const anchors = photoAnchors(ordered, photos, matches);
    assert.deepEqual([...anchors], [['B', 14 * 60 + 10]]);
    assert.deepEqual([...photosByStop(photos, matches)], [['B', [2, 1]], ['C', [3]]]);
    // Masquée (lot 8) : toujours une ancre, mais pas montrée.
    const hidden = photos.map((p) => (p.id === 2 ? { ...p, hidden: true } : p));
    assert.deepEqual([...photoAnchors(ordered, hidden, matches)], [['B', 14 * 60 + 10]]);
    assert.deepEqual([...photosByStop(hidden, matches)], [['B', [1]], ['C', [3]]]);
});

test('reconstruction avec photos : l’heure d’une photo cale son étape', () => {
    const result = reconstructWithPhotos({
        days: DAYS,
        photos: [photo(9, { lat: 45, lon: at(20), takenAt: '2025-07-12T15:30:00' })],
        cameras: [],
    });
    const c = result.ordered.days[0].stops.find((s) => s.key === 'C');
    assert.equal(c.arrivalMin, 15 * 60 + 30);
    assert.equal(c.reason, REASON_PHOTO);
    assert.equal(c.confidence, 'anchored');
    assert.deepEqual([...result.byStop], [['C', [9]]]);
    // Une heure Lab prime sur celle d'une photo.
    const lab = reconstructWithPhotos({
        days: [{ date: '2025-07-12', stops: [stop('L', 0, { kind: 'lab', type: 'Lab Cache', localTime: '09:15' })] }],
        photos: [photo(1, { lat: 45, lon: at(0), takenAt: '2025-07-12T11:00:00' })],
    });
    assert.equal(lab.ordered.days[0].stops[0].arrivalMin, 9 * 60 + 15);
    assert.equal(reconstructWithPhotos({ days: DAYS }).matches.size, 0);
});

test('chronologie : chaque photo ajoute son temps d’écran à l’étape', () => {
    const { ordered, byStop } = reconstructWithPhotos({
        days: DAYS,
        photos: [1, 2, 3, 4, 5, 6].map((id) => photo(id, { stopKey: 'A' })),
    });
    const tl = buildParcoursTimeline(ordered, { photosByStop: byStop });
    const a = tl.stops[0];
    assert.deepEqual(a.photos, [1, 2, 3, 4, 5, 6]);
    // 4 photos au plus en temps cumulé, partagé entre les 6.
    assert.equal(a.departQ - a.q, 12 + 15 * 4);
    assert.equal(a.photoQ, 10);
    assert.equal(tl.stops[1].photos.length, 0);
});

test('lieux proposés : photos géolocalisées hors étapes, groupées par journée et proximité', () => {
    const ordered = reconstructParcours({ days: DAYS });
    const photos = [
        photo(1, { lat: 45, lon: at(5), takenAt: '2025-07-12T12:10:00' }),     // entre A et B, à 500 m
        photo(2, { lat: 45, lon: at(5.5), takenAt: '2025-07-12T12:05:00' }),   // à 50 m de la 1 : même lieu
        photo(3, { lat: 45, lon: at(15), takenAt: '2025-07-12T15:00:00' }),
        photo(4, { lat: 45, lon: at(10.2), takenAt: '2025-07-12T13:00:00' }),  // sur B : rattachée
        photo(5, { lat: 45, lon: at(5), takenAt: '2025-07-14T09:00:00' }),     // hors des dates
        photo(6, { lat: 45, lon: at(5), takenAt: '2025-07-12T12:00:00', hidden: true }),
        photo(7, { lat: 45, lon: at(5), takenAt: null }),                      // sans heure
        photo(8, { lat: 45, lon: at(5), takenAt: '2025-07-12T12:00:00', stopKey: 'C' }),
    ];
    const matches = matchPhotos(ordered, photos);
    const places = suggestPhotoPlaces(photos, matches, new Map(), { dates: new Set(['2025-07-12', '2025-07-13']) });
    assert.deepEqual(places.map((p) => [p.date, p.photoIds, p.minutes]),
        [['2025-07-12', [2, 1], 12 * 60 + 5], ['2025-07-12', [3], 15 * 60]]);
    assert.ok(Math.abs(places[0].lon - at(5.25)) < 1e-9);
    // Une photo à plus de la moitié du rayon de la première ouvre un autre groupe.
    const far = [photo(1, { lat: 45, lon: at(5), takenAt: '2025-07-12T12:00:00' }),
        photo(2, { lat: 45, lon: at(5.8), takenAt: '2025-07-12T12:01:00' })];
    assert.equal(suggestPhotoPlaces(far, matchPhotos(ordered, far)).length, 2);
    // Sans position, rien à proposer (rattachement à la main).
    assert.deepEqual(suggestPhotoPlaces([photo(3, { takenAt: '2025-07-12T15:00:00', camera: 'Nikon' })], new Map()), []);
});
