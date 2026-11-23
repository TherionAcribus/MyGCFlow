// Photos d'un parcours (static/js/parcours_photos.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MATCH_GPS,
    MATCH_MANUAL,
    MATCH_TIME,
    PHOTO_FILTER_FAVORITE,
    PHOTO_FILTER_HIDDEN,
    PHOTO_FILTER_UNLINKED,
    UNKNOWN_CAMERA,
    cameraKey,
    favoritePhotoIds,
    cameraOffsets,
    photoCameraOffset,
    matchPhotos,
    pairCandidates,
    pairOffset,
    photoAnchors,
    photoClock,
    photoGridGroups,
    photoTimeTrusted,
    photoTimeVerified,
    photosByStop,
    reconstructWithPhotos,
    routePhotos,
    suggestPhotoPlaces,
} from '../../static/js/parcours_photos.mjs';
import { REASON_PHOTO, reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import { buildParcoursTimeline, headAt, legPauses, stateAt } from '../../static/js/parcours_timeline.mjs';
import { photoSlots } from '../../static/js/parcours_photo_layout.mjs';

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

test('heure d’une photo : supposée juste dès qu’elle est datée, vérifiée si géolocalisée ou recalée', () => {
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 0 }]);
    assert.equal(photoTimeTrusted(photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Nikon' })), true);
    assert.equal(photoTimeTrusted(photo(1, { takenAt: '2025-07-12T10:00:00' })), true);
    assert.equal(photoTimeTrusted(photo(1, { lat: 45, lon: 5 })), false);
    assert.equal(photoTimeVerified(photo(1, { takenAt: '2025-07-12T10:00:00', lat: 45, lon: 5 })), true);
    assert.equal(photoTimeVerified(photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Canon' }), offsets), true);
    assert.equal(photoTimeVerified(photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Nikon' }), offsets), false);
    assert.equal(photoTimeVerified(photo(1, { lat: 45, lon: 5 })), false);
});

test('appareil inconnu (ni marque ni modèle) : une horloge commune, recalable', () => {
    const p = photo(1, { takenAt: '2025-07-12T10:00:00' });
    assert.equal(cameraKey(p), UNKNOWN_CAMERA);
    assert.equal(photoTimeVerified(p), false);
    const offsets = cameraOffsets([{ camera: UNKNOWN_CAMERA, offsetMinutes: -60 }]);
    assert.equal(photoCameraOffset(p, offsets), -60);
    assert.equal(photoClock(p, offsets).minutes, 9 * 60);
    assert.equal(photoTimeVerified(p, offsets), true);
    // Un appareil nommé n'en hérite pas.
    assert.equal(photoCameraOffset(photo(2, { takenAt: '2025-07-12T10:00:00', camera: 'Nikon' }), offsets), undefined);
});

test('deux boîtiers du même modèle : une horloge chacun, repli sur le modèle', () => {
    const a = photo(1, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D', cameraSerial: '111' });
    const b = photo(2, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D', cameraSerial: '222' });
    const old = photo(3, { takenAt: '2025-07-12T10:00:00', camera: 'Canon EOS 80D' });  // sans numéro
    assert.equal(cameraKey(a), 'Canon EOS 80D#111');
    assert.equal(cameraKey(old), 'Canon EOS 80D');
    assert.equal(cameraKey(photo(4)), UNKNOWN_CAMERA);
    // Boîtier A recalé seul : B reste non recalé.
    let offsets = cameraOffsets([{ camera: 'Canon EOS 80D#111', offsetMinutes: 30 }]);
    assert.equal(photoClock(a, offsets).minutes, 10 * 60 + 30);
    assert.equal(photoClock(b, offsets).minutes, 10 * 60);
    assert.equal(photoTimeVerified(b, offsets), false);
    assert.equal(photoTimeVerified(old, offsets), false);
    // Recalage du modèle (photos d'avant le numéro de série) : hérité par
    // les boîtiers qui n'en ont pas à eux.
    offsets = cameraOffsets([{ camera: 'Canon EOS 80D#111', offsetMinutes: 30 }, { camera: 'Canon EOS 80D', offsetMinutes: -60 }]);
    assert.equal(photoCameraOffset(a, offsets), 30);
    assert.equal(photoCameraOffset(b, offsets), -60);
    assert.equal(photoCameraOffset(old, offsets), -60);
    assert.equal(photoTimeVerified(b, offsets), true);
    assert.equal(photoCameraOffset(photo(4), offsets), undefined);
});

test('recalage par une paire : décalage absolu, références d’autres appareils à heure sûre', () => {
    const camera = photo(1, { takenAt: '2025-07-13T08:00:00', camera: 'Canon EOS 80D' });
    const phone = photo(2, { takenAt: '2025-07-12T11:20:00', camera: 'Apple iPhone 13', lat: 45, lon: 5 });
    // 13/07 08:00 → 12/07 11:20 : −20 h 40.
    assert.equal(pairOffset(camera, phone), -1240);
    // Décalage absolu : celui déjà posé sur l'appareil n'y entre pas.
    assert.equal(pairOffset(camera, phone, cameraOffsets([{ camera: 'Canon EOS 80D', offsetMinutes: 30 }])), -1240);
    // Référence d'un appareil recalé : son heure corrigée compte.
    const nikon = photo(3, { takenAt: '2025-07-13T07:00:00', camera: 'Nikon' });
    const offsets = cameraOffsets([{ camera: 'Nikon', offsetMinutes: 60 }]);
    assert.equal(pairOffset(camera, nikon, offsets), 0);
    // Au-delà de 2 jours, ou sans heure : pas de décalage.
    assert.equal(pairOffset(camera, photo(4, { takenAt: '2025-07-01T08:00:00', lat: 45, lon: 5 })), null);
    assert.equal(pairOffset(camera, photo(5, { lat: 45, lon: 5 })), null);

    const photos = [
        camera, phone, nikon,
        photo(6, { takenAt: '2025-07-13T07:59:00', camera: 'Canon EOS 80D' }),      // même appareil
        photo(7, { takenAt: '2025-07-13T09:00:00', camera: 'Sony' }),               // non recalé
        photo(8, { takenAt: '2025-07-13T08:10:00', lat: 45, lon: 5 }),              // téléphone sans nom
    ];
    // Les plus proches de l'heure actuelle de la photo d'abord.
    assert.deepEqual(pairCandidates(photos, camera, offsets).map((p) => p.id), [3, 8, 2]);
    assert.deepEqual(pairCandidates(photos, camera).map((p) => p.id), [8, 2]);
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
        photo(7, { camera: 'Nikon', takenAt: '2025-07-12T09:55:00' }),             // non recalé : heure supposée juste
        photo(8, { camera: 'Nikon' }),                                            // sans heure ni position
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
    assert.deepEqual(matches.get(7), { key: 'C', source: MATCH_TIME });
    assert.deepEqual(matches.get(8), { key: null, source: null });
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

test('rattachement par l’heure : à égalité dans les marges, la visite la plus proche', () => {
    // B quitté à 10:30, C atteint à 10:35 : à 10:36, les deux marges de
    // 10 min contiennent l'heure — c'est C, où l'on vient d'arriver.
    const ordered = {
        days: [{
            date: '2025-07-12',
            stops: [
                { ...stop('B', 10), arrivalMin: 10 * 60, visitMin: 30 },
                { ...stop('C', 20), arrivalMin: 10 * 60 + 35, visitMin: 15 },
            ],
        }],
    };
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 0 }]);
    const at = (hhmm) => matchPhotos(ordered, [photo(1, { camera: 'Canon', takenAt: `2025-07-12T${hhmm}:00` })], offsets).get(1).key;
    assert.equal(at('10:36'), 'C');
    assert.equal(at('10:31'), 'B');
    assert.equal(at('10:15'), 'B');
});

test('ancres : position ou manuel, photo datée du jour de l’étape, la plus tôt par étape', () => {
    const ordered = reconstructParcours({ days: DAYS });
    const photos = [
        photo(1, { lat: 45, lon: at(10), takenAt: '2025-07-12T14:20:00' }),
        photo(2, { lat: 45, lon: at(10.2), takenAt: '2025-07-12T14:10:00' }),
        photo(3, { stopKey: 'C', takenAt: '2025-07-12T16:00:00', camera: 'Nikon' }),  // non recalé : heure supposée juste
        photo(4, { stopKey: 'A', camera: 'Nikon' }),                                  // sans heure : pas d'ancre
        photo(5, { stopKey: 'A', takenAt: '2025-07-14T09:00:00', camera: 'Sony' }),   // horloge fausse d'un jour : pas d'ancre
    ];
    const matches = matchPhotos(ordered, photos);
    const anchors = photoAnchors(ordered, photos, matches);
    assert.deepEqual([...anchors], [['B', 14 * 60 + 10], ['C', 16 * 60]]);
    assert.deepEqual([...photosByStop(photos, matches)], [['B', [2, 1]], ['C', [3]], ['A', [5, 4]]]);
    // Masquée (lot 8) : toujours une ancre, mais pas montrée.
    const hidden = photos.map((p) => (p.id === 2 ? { ...p, hidden: true } : p));
    assert.deepEqual([...photoAnchors(ordered, hidden, matches)], [['B', 14 * 60 + 10], ['C', 16 * 60]]);
    assert.deepEqual([...photosByStop(hidden, matches)], [['B', [1]], ['C', [3]], ['A', [5, 4]]]);
});

test('reconstruction : photos sans GPS ni appareil, rattachées à la main, donnent le sens de la journée', () => {
    // Sans logs ni veille, le plus court chemin se parcourt dans les deux
    // sens ; les heures des photos (supposées justes) tranchent : C puis A.
    const days = [{ date: '2025-07-12', stops: [stop('A', 0), stop('C', 20)] }];
    const result = reconstructWithPhotos({
        days,
        photos: [
            photo(1, { stopKey: 'C', takenAt: '2025-07-12T10:00:00' }),
            photo(2, { stopKey: 'A', takenAt: '2025-07-12T11:00:00' }),
        ],
        cameras: [],
    });
    assert.deepEqual(result.ordered.days[0].stops.map((s) => s.key), ['C', 'A']);
    assert.equal(result.ordered.days[0].stops[0].reason, REASON_PHOTO);
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
    // « Seules les premières » : les 4 premières gardent leur temps entier,
    // les suivantes ne sont pas montrées.
    const first = buildParcoursTimeline(ordered, {
        photosByStop: byStop, options: { maxPhotosPerStop: 4, photoOverflow: 'first' },
    }).stops[0];
    assert.deepEqual(first.photos, [1, 2, 3, 4]);
    assert.equal(first.photoQ, 15);
    assert.equal(first.departQ - first.q, 12 + 15 * 4);
    // Les favorites passent d'abord, montrées dans l'ordre de prise de vue.
    const fav = buildParcoursTimeline(ordered, {
        photosByStop: byStop, photoFavorites: new Set([6, 2]), options: { maxPhotosPerStop: 4, photoOverflow: 'first' },
    }).stops[0];
    assert.deepEqual(fav.photos, [1, 2, 3, 6]);
    // Une favorite déjà parmi les premières ne prend pas deux places.
    assert.deepEqual(buildParcoursTimeline(ordered, {
        photosByStop: byStop, photoFavorites: new Set([1]), options: { maxPhotosPerStop: 4, photoOverflow: 'first' },
    }).stops[0].photos, [1, 2, 3, 4]);
    // Sous le plafond, rien ne change.
    const few = new Map([['A', [1, 2]]]);
    assert.deepEqual(buildParcoursTimeline(ordered, { photosByStop: few, options: { photoOverflow: 'first' } }).stops[0].photos,
        [1, 2]);
});

test('grille : regroupée par journée (heure corrigée), filtres non rattachées et masquées', () => {
    const offsets = cameraOffsets([{ camera: 'Canon', offsetMinutes: 120 }]);
    const photos = [
        photo(1, { takenAt: '2025-07-13T09:00:00' }),
        photo(2, { takenAt: '2025-07-12T23:00:00', camera: 'Canon' }),   // +2 h : le 13 à 01:00
        photo(3, { takenAt: '2025-07-12T10:00:00', hidden: true }),
        photo(4),                                                        // sans heure
        photo(5, { takenAt: '2025-07-12T08:00:00' }),
    ];
    const matches = new Map([[1, { key: 'A', source: MATCH_MANUAL }], [3, { key: 'B', source: MATCH_GPS }]]);
    assert.deepEqual(photoGridGroups(photos, matches, offsets), [
        { date: '2025-07-12', ids: [5, 3] },
        { date: '2025-07-13', ids: [2, 1] },
        { date: null, ids: [4] },
    ]);
    assert.deepEqual(photoGridGroups(photos, matches, offsets, PHOTO_FILTER_UNLINKED).map((g) => g.ids), [[5], [2], [4]]);
    assert.deepEqual(photoGridGroups(photos, matches, offsets, PHOTO_FILTER_HIDDEN), [{ date: '2025-07-12', ids: [3] }]);
    const starred = photos.map((p) => (p.id === 4 || p.id === 5 ? { ...p, favorite: true } : p));
    assert.deepEqual(photoGridGroups(starred, matches, offsets, PHOTO_FILTER_FAVORITE).map((g) => g.ids), [[5], [4]]);
    assert.deepEqual([...favoritePhotoIds(starred)], [4, 5]);
    assert.deepEqual(photoGridGroups([], matches), []);
});

test('photos en chemin : au trajet de leur heure, arrêt du géocacheur, créneaux à leur place', () => {
    // A (x=0), B (x=10), C (x=20) : visites estimées dans la journée.
    const ordered = reconstructParcours({ days: DAYS });
    const [a, b] = ordered.days[0].stops;
    const leave = a.arrivalMin + (a.visitMin || 0);
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
    const mid = (leave + b.arrivalMin) / 2;
    const photos = [
        photo(1, { lat: 45.002, lon: at(5), takenAt: `2025-07-12T${hhmm(mid)}:00` }),   // entre A et B, à ~220 m du trajet
        photo(2, { lat: 45, lon: at(10.3), takenAt: `2025-07-12T${hhmm(mid)}:00` }),    // sur B : rattachée, pas en chemin
        photo(3, { lat: 45.002, lon: at(5), takenAt: `2025-07-12T${hhmm(mid)}:00`, hidden: true }),
        photo(4, { lat: 45.002, lon: at(5), takenAt: '2025-07-12T05:00:00' }),           // avant la première étape
        photo(5, { camera: 'Nikon', takenAt: `2025-07-12T${hhmm(mid)}:00` }),            // sans position
    ];
    const matches = matchPhotos(ordered, photos);
    const byLeg = routePhotos(ordered, photos, matches);
    assert.deepEqual([...byLeg.keys()], ['A>B']);
    assert.deepEqual(byLeg.get('A>B').map((r) => r.id), [1]);

    // Chronologie : le trajet A>B s'allonge d'une photo (15 quanta) et le
    // géocacheur s'arrête à mi-chemin le temps de la montrer.
    const plain = buildParcoursTimeline(ordered);
    const tl = buildParcoursTimeline(ordered, { photosByLeg: byLeg });
    const leg = tl.legs[0];
    assert.equal((leg.endQ - leg.startQ) - (plain.legs[0].endQ - plain.legs[0].startQ), 15);
    assert.ok(Math.abs(leg.photos[0].f - 0.5) < 1e-6, String(leg.photos[0].f));
    assert.ok(Math.abs(leg.photos[0].lon - at(5)) < 1e-9);
    const [pause] = legPauses(leg);
    assert.ok(Math.abs(pause.toQ - pause.fromQ - 15) < 1e-9);
    const during = [pause.fromQ + 1, pause.fromQ + 7, pause.toQ - 0.5].map((q) => headAt(tl, q).lon);
    assert.ok(during.every((lon) => Math.abs(lon - at(5)) < 1e-9), JSON.stringify(during));
    assert.ok(headAt(tl, pause.fromQ - 2).lon < at(5) && headAt(tl, pause.toQ + 2).lon > at(5));
    assert.ok(Math.abs(headAt(tl, leg.endQ - 1e-6).lon - at(10)) < 1e-4);
    // L'heure affichée passe par celle de la photo pendant l'arrêt.
    assert.ok(Math.abs(stateAt(tl, pause.fromQ + 7).minutes - Math.round(mid)) < 1e-6,
        String(stateAt(tl, pause.fromQ + 7).minutes));
    // Créneau : sur l'arrêt, avant les photos de B, à la position de l'arrêt.
    const slots = photoSlots(buildParcoursTimeline(ordered, { photosByLeg: byLeg, photosByStop: new Map([['B', [2]]]) }));
    assert.deepEqual(slots.map((s) => [s.photoId, s.route ?? false, s.order]), [[1, true, 0], [2, false, 1]]);
    assert.equal(slots[0].stop, null);
    assert.ok(Math.abs(slots[0].at[0] - at(5)) < 1e-9);
    // Durée imposée : l'arrêt est un contenu à lire (plancher, comme les
    // photos d'une étape) — en quanta de 50 ms il en garde plus que ses 15
    // naturels, le trajet absorbe la compression ; il reste dans le trajet.
    const squeezed = buildParcoursTimeline(ordered, { photosByLeg: byLeg, timing: { msPerDay: 50, fixedTotal: true } });
    const [squeezedPause] = legPauses(squeezed.legs[0]);
    assert.ok(squeezedPause.toQ - squeezedPause.fromQ > 15, String(squeezedPause.toQ - squeezedPause.fromQ));
    assert.ok(squeezedPause.fromQ >= squeezed.legs[0].startQ && squeezedPause.toQ <= squeezed.legs[0].endQ);
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
