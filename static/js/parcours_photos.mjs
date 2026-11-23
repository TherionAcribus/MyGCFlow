// Photos d'un parcours (MyGCFlow_Plan_Parcours.md, § 8 ; lot 4) : heure
// corrigée, rattachement aux étapes, ancres pour la reconstruction.
//
// Une photo (parcours_photos.py) porte l'heure MURALE de l'appareil
// (`takenAt`, « AAAA-MM-JJTHH:MM:SS »), parfois une position GPS, et le nom
// de l'appareil. Rattachement, du plus sûr au plus faible :
//
// 1. MANUEL (`stopKey`) : choisi par l'utilisateur ;
// 2. POSITION : l'étape la plus proche à moins de PHOTO_MATCH_RADIUS_M, le
//    même jour quand la photo a une heure ;
// 3. HEURE : sans position, une photo à heure de confiance va à l'étape dont
//    la visite (± marge) contient son heure, sinon à l'arrivée la plus proche
//    dans PHOTO_TIME_WINDOW_MIN.
//
// Heure de confiance : celle d'un téléphone (photo géolocalisée : l'horloge
// suit le réseau) ou d'un appareil dont l'utilisateur a recalé l'horloge
// (`cameras[].offsetMinutes`, même 0 ; clé : `cameraKey`). Une photo rattachée par position ou à
// la main, à heure de confiance, devient une ANCRE de son étape (raison
// `photo`) — sauf si l'étape a déjà une heure sûre (épinglée, Lab).
//
// Les ancres changent l'horaire, et l'horaire sert au rattachement par
// l'heure : `reconstructWithPhotos` fait deux passes (reconstruction sans
// photo, rattachement, ancres, reconstruction finale, rattachement final).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_photos.test.mjs).

import { groundDistanceKm } from './travel_trail.mjs';
import { KIND_BASE, reconstructParcours } from './parcours_reconstruct.mjs';

export const PHOTO_MATCH_RADIUS_M = 150;
export const PHOTO_TIME_WINDOW_MIN = 45;
// Marge autour de la visite estimée pour le rattachement par l'heure.
const VISIT_MARGIN_MIN = 10;

export const MATCH_MANUAL = 'manual';
export const MATCH_GPS = 'gps';
export const MATCH_TIME = 'time';

const TAKEN_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

// Décalages par appareil : Map clé d'appareil → minutes.
export function cameraOffsets(cameras) {
    const map = new Map();
    for (const c of Array.isArray(cameras) ? cameras : []) {
        if (c && typeof c.camera === 'string' && Number.isFinite(c.offsetMinutes)) map.set(c.camera, c.offsetMinutes);
    }
    return map;
}

// Clé d'appareil d'une photo (celle d'un recalage) : « marque modèle »,
// suivie de « #numéro » quand l'EXIF donne le numéro de série du boîtier —
// deux appareils du même modèle ont ainsi chacun leur horloge. null sans
// appareil.
export function cameraKey(photo) {
    if (!photo?.camera) return null;
    return photo.cameraSerial ? `${photo.camera}#${photo.cameraSerial}` : photo.camera;
}

// Décalage d'horloge d'une photo : celui de son boîtier, sinon celui du
// modèle (photos sans numéro de série, ou envoyées avant sa lecture : un
// boîtier recalé ainsi le reste) ; undefined si aucun.
export function photoCameraOffset(photo, offsets = new Map()) {
    const key = cameraKey(photo);
    if (!key) return undefined;
    return offsets.has(key) ? offsets.get(key) : offsets.get(photo.camera);
}

// Heure corrigée d'une photo : { date: 'AAAA-MM-JJ', minutes } (décalage de
// l'appareil appliqué, la date suit si l'heure passe minuit), ou null.
export function photoClock(photo, offsets = new Map()) {
    const m = TAKEN_RE.exec(String(photo?.takenAt || ''));
    if (!m) return null;
    const offset = photoCameraOffset(photo, offsets) || 0;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
        + offset * 60000;
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 };
}

export function hasPosition(photo) {
    return Number.isFinite(photo?.lat) && Number.isFinite(photo?.lon);
}

export function photoTimeTrusted(photo, offsets = new Map()) {
    if (!TAKEN_RE.test(String(photo?.takenAt || ''))) return false;
    return hasPosition(photo) || photoCameraOffset(photo, offsets) !== undefined;
}

// Étapes candidates : toutes sauf les bases (on ne photographie pas « le
// retour à l'hôtel » comme une étape), avec leur journée.
function candidates(reconstructed) {
    const out = [];
    for (const day of reconstructed?.days || []) {
        for (const stop of day.stops) {
            if (stop.kind !== KIND_BASE) out.push({ stop, date: day.date });
        }
    }
    return out;
}

// Rattachement de chaque photo : Map id → { key, source, distanceM?,
// lostKey? } ; key null si la photo n'est rattachée à rien.
//
// Une étape choisie à la main qui ne figure plus dans le parcours (cache
// exclue, lieu supprimé) n'est pas oubliée : `stopKey` reste stocké, pour
// que la photo la retrouve si elle revient (annulation, cache réincluse).
// En attendant, la photo suit le rattachement automatique, et `lostKey`
// signale l'étape disparue.
export function matchPhotos(reconstructed, photos, offsets = new Map(),
    { radiusM = PHOTO_MATCH_RADIUS_M, windowMin = PHOTO_TIME_WINDOW_MIN } = {}) {
    const all = candidates(reconstructed);
    const known = new Set(all.map((c) => c.stop.key));
    const result = new Map();
    for (const photo of Array.isArray(photos) ? photos : []) {
        if (!photo || !Number.isFinite(photo.id)) continue;
        if (photo.stopKey && known.has(photo.stopKey)) {
            result.set(photo.id, { key: photo.stopKey, source: MATCH_MANUAL });
            continue;
        }
        const lost = photo.stopKey ? { lostKey: photo.stopKey } : null;
        const clock = photoClock(photo, offsets);
        if (hasPosition(photo)) {
            let best = null;
            for (const c of all) {
                if (clock && c.date !== clock.date) continue;
                const m = groundDistanceKm([photo.lon, photo.lat], [c.stop.lon, c.stop.lat]) * 1000;
                if (m <= radiusM && (!best || m < best.distanceM)) best = { key: c.stop.key, source: MATCH_GPS, distanceM: m };
            }
            result.set(photo.id, { ...(best || { key: null, source: null }), ...lost });
            continue;
        }
        if (clock && photoTimeTrusted(photo, offsets)) {
            let best = null;
            for (const c of all) {
                if (c.date !== clock.date || !Number.isFinite(c.stop.arrivalMin)) continue;
                const start = c.stop.arrivalMin - VISIT_MARGIN_MIN;
                const end = c.stop.arrivalMin + (c.stop.visitMin || 0) + VISIT_MARGIN_MIN;
                const gap = clock.minutes < start ? start - clock.minutes : clock.minutes > end ? clock.minutes - end : 0;
                if (gap <= windowMin && (!best || gap < best.gap)) best = { key: c.stop.key, source: MATCH_TIME, gap };
            }
            result.set(photo.id, { ...(best ? { key: best.key, source: MATCH_TIME } : { key: null, source: null }), ...lost });
            continue;
        }
        result.set(photo.id, { key: null, source: null, ...lost });
    }
    return result;
}

// Ancres tirées des photos : Map clé d'étape → minutes (la plus tôt des
// photos de l'étape). Seulement les rattachements manuels ou par position
// (celui par l'heure découle de l'horaire : il ne peut pas le caler), à
// heure de confiance, le jour même de l'étape.
export function photoAnchors(reconstructed, photos, matches, offsets = new Map()) {
    const dateOf = new Map();
    for (const day of reconstructed?.days || []) for (const stop of day.stops) dateOf.set(stop.key, day.date);
    const anchors = new Map();
    for (const photo of Array.isArray(photos) ? photos : []) {
        const match = matches.get(photo?.id);
        if (!match?.key || (match.source !== MATCH_MANUAL && match.source !== MATCH_GPS)) continue;
        if (!photoTimeTrusted(photo, offsets)) continue;
        const clock = photoClock(photo, offsets);
        if (!clock || clock.date !== dateOf.get(match.key)) continue;
        const current = anchors.get(match.key);
        if (current === undefined || clock.minutes < current) anchors.set(match.key, clock.minutes);
    }
    return anchors;
}

// Photos à montrer par étape (ordre de prise de vue) : Map clé → [id]. Une
// photo masquée (`hidden`, lot 8) reste un indice (rattachement, ancre)
// mais n'est pas montrée : elle n'y figure pas.
export function photosByStop(photos, matches, offsets = new Map()) {
    const byKey = new Map();
    const sorted = (Array.isArray(photos) ? photos : []).filter((photo) => photo && !photo.hidden).sort((a, b) => {
        const ca = photoClock(a, offsets);
        const cb = photoClock(b, offsets);
        const ka = ca ? `${ca.date}${String(Math.round(ca.minutes * 60)).padStart(6, '0')}` : '~';
        const kb = cb ? `${cb.date}${String(Math.round(cb.minutes * 60)).padStart(6, '0')}` : '~';
        return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
    });
    for (const photo of sorted) {
        const key = matches.get(photo.id)?.key;
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(photo.id);
    }
    return byKey;
}

// Lieux proposés (lot 10) pour les photos géolocalisées qui ne tombent sur
// aucune étape : regroupées par journée et par proximité. Une photo rejoint
// un groupe à moins de radiusM / 2 de sa première photo : toutes sont alors
// à moins de radiusM du centre, où le lieu sera posé — elles s'y
// rattacheront seules. Seules les journées du parcours (`dates`) comptent ;
// les photos masquées, sans heure ou rattachées sont laissées — une photo
// dont l'étape choisie à la main a disparu est proposée comme les autres.
// → [{ date, lat, lon, minutes (heure de la première photo : géolocalisée,
// elle est de confiance), photoIds }], dans l'ordre chronologique.
export function suggestPhotoPlaces(photos, matches, offsets = new Map(),
    { radiusM = PHOTO_MATCH_RADIUS_M, dates = null } = {}) {
    const groups = [];
    const sorted = (Array.isArray(photos) ? photos : [])
        .map((photo) => ({ photo, clock: photoClock(photo, offsets) }))
        .filter(({ photo, clock }) => photo && !photo.hidden && hasPosition(photo) && clock
            && !matches.get(photo.id)?.key && (!dates || dates.has(clock.date)))
        .sort((a, b) => (a.clock.date === b.clock.date ? a.clock.minutes - b.clock.minutes : a.clock.date < b.clock.date ? -1 : 1));
    for (const { photo, clock } of sorted) {
        const near = groups.find((g) => g.date === clock.date
            && groundDistanceKm([g.seed.lon, g.seed.lat], [photo.lon, photo.lat]) * 1000 <= radiusM / 2);
        if (near) near.members.push(photo);
        else groups.push({ date: clock.date, seed: photo, members: [photo], minutes: clock.minutes });
    }
    return groups.map((g) => ({
        date: g.date,
        lat: g.members.reduce((sum, p) => sum + p.lat, 0) / g.members.length,
        lon: g.members.reduce((sum, p) => sum + p.lon, 0) / g.members.length,
        minutes: g.minutes,
        photoIds: g.members.map((p) => p.id),
    }));
}

// Reconstruction complète, photos comprises : { ordered, matches, anchors,
// byStop }.
export function reconstructWithPhotos(inputs, options = null) {
    const photos = Array.isArray(inputs?.photos) ? inputs.photos : [];
    const offsets = cameraOffsets(inputs?.cameras);
    let ordered = reconstructParcours(inputs, { options });
    if (photos.length === 0) {
        return { ordered, matches: new Map(), anchors: new Map(), byStop: new Map() };
    }
    let matches = matchPhotos(ordered, photos, offsets);
    const anchors = photoAnchors(ordered, photos, matches, offsets);
    if (anchors.size > 0) {
        ordered = reconstructParcours(inputs, { options, photoAnchors: anchors });
        matches = matchPhotos(ordered, photos, offsets);
    }
    return { ordered, matches, anchors, byStop: photosByStop(photos, matches, offsets) };
}
