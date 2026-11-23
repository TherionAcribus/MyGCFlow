// Photos d'un parcours (MyGCFlow_Plan_Parcours.md, § 8 ; lot 4) : heure
// corrigée, rattachement aux étapes, ancres pour la reconstruction.
//
// Une photo (parcours_photos.py) porte l'heure MURALE de l'appareil
// (`takenAt`, « AAAA-MM-JJTHH:MM:SS »), parfois une position GPS, et le nom
// de l'appareil. Rattachement, du plus sûr au plus faible :
//
// 1. MANUEL (`stopKey`) : choisi par l'utilisateur ;
// 2. POSITION : l'étape la plus proche à moins de PHOTO_MATCH_RADIUS_M, le
//    même jour quand la photo a une heure — position de l'EXIF, ou lue sur
//    une trace GPS à l'heure recalée d'un appareil sans GPS ;
// 3. HEURE : sans position, une photo datée va à l'étape dont
//    la visite (± marge) contient son heure, sinon à l'arrivée la plus proche
//    dans PHOTO_TIME_WINDOW_MIN.
//
// Heure de la photo : celle de l'appareil, supposée juste (un téléphone suit
// le réseau), corrigée du décalage de son horloge quand l'utilisateur l'a
// recalée (`cameras[].offsetMinutes` ; clé : `cameraKey`, « appareil
// inconnu » sans marque ni modèle). Une horloge très fausse s'écarte
// d'elle-même : une ancre ne vaut que le jour même de l'étape. Heure
// VÉRIFIÉE (`photoTimeVerified`) : photo géolocalisée ou appareil recalé —
// seules références d'un recalage par une paire. Une photo rattachée par
// position ou à la main, datée, devient une ANCRE de son étape (raison
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
// Position lue sur une trace GPS du parcours à l'heure (recalée) de la photo
// (`locatePhotosOnTracks`, parcours_tracks.mjs) : rattachée comme une photo
// géolocalisée, mais jamais ancre — la trace cale déjà ses étapes.
export const MATCH_TRACK = 'track';
export const MATCH_TIME = 'time';
export const POSITION_TRACK = 'track';

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
// deux appareils du même modèle ont ainsi chacun leur horloge.
// UNKNOWN_CAMERA sans marque ni modèle dans l'EXIF : ces photos partagent
// une horloge, recalable comme les autres.
export const UNKNOWN_CAMERA = '?';

export function cameraKey(photo) {
    if (!photo?.camera) return UNKNOWN_CAMERA;
    return photo.cameraSerial ? `${photo.camera}#${photo.cameraSerial}` : photo.camera;
}

// Décalage d'horloge d'une photo : celui de son boîtier, sinon celui du
// modèle (photos sans numéro de série, ou envoyées avant sa lecture : un
// boîtier recalé ainsi le reste) ; undefined si aucun.
export function photoCameraOffset(photo, offsets = new Map()) {
    const key = cameraKey(photo);
    return offsets.has(key) ? offsets.get(key) : offsets.get(photo?.camera);
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

// Photos complétées des positions lues sur la trace (Map id → { lon, lat }) :
// `posSource` les distingue d'une position EXIF. Les autres sont rendues
// telles quelles.
export function withTrackPositions(photos, positions) {
    const list = Array.isArray(photos) ? photos : [];
    if (!positions?.size) return list;
    return list.map((photo) => {
        const at = positions.get(photo?.id);
        return at && !hasPosition(photo) ? { ...photo, lat: at.lat, lon: at.lon, posSource: POSITION_TRACK } : photo;
    });
}

// --- Recalage par une paire de photos ----------------------------------------
//
// Une photo de l'appareil à recaler et une photo de RÉFÉRENCE prise au même
// moment (téléphone géolocalisé, ou appareil déjà recalé) : la différence de
// leurs heures est le décalage de l'appareil. Borné comme côté serveur
// (OFFSET_RANGE_MINUTES de parcours_photos.py) : au-delà, ce n'est plus la
// même sortie.
export const PAIR_OFFSET_MAX_MIN = 2 * 24 * 60;

// Décalage (minutes entières) à donner à l'appareil de `photo` pour que son
// heure soit celle de `reference`, ou null. L'heure de `photo` est prise
// brute (le décalage est absolu, pas une correction de l'actuel) ; celle de
// la référence, corrigée.
export function pairOffset(photo, reference, offsets = new Map()) {
    const raw = photoClock(photo);
    const ref = photoClock(reference, offsets);
    if (!raw || !ref) return null;
    const days = (Date.parse(`${ref.date}T00:00:00Z`) - Date.parse(`${raw.date}T00:00:00Z`)) / 86400000;
    const offset = Math.round(days * 24 * 60 + ref.minutes - raw.minutes);
    return Math.abs(offset) <= PAIR_OFFSET_MAX_MIN ? offset : null;
}

// Références possibles pour recaler l'appareil de `photo` : les photos à
// heure vérifiée d'un AUTRE appareil (position EXIF, ou appareil recalé),
// les plus proches de l'heure actuelle de `photo` d'abord (son horloge est
// fausse, mais rarement de beaucoup).
export function pairCandidates(photos, photo, offsets = new Map()) {
    const own = cameraKey(photo);
    const at = photoClock(photo, offsets);
    const instant = (c) => Date.parse(`${c.date}T00:00:00Z`) / 60000 + c.minutes;
    return (Array.isArray(photos) ? photos : [])
        .filter((p) => p && p.id !== photo?.id && cameraKey(p) !== own && photoTimeVerified(p, offsets)
            && pairOffset(photo, p, offsets) !== null)
        .map((p) => ({ photo: p, gap: at ? Math.abs(instant(photoClock(p, offsets)) - instant(at)) : 0 }))
        .sort((a, b) => a.gap - b.gap || a.photo.id - b.photo.id)
        .map((c) => c.photo);
}

// Heure utilisable (ancre, rattachement par l'heure, trace) : toute photo
// datée — l'horloge de l'appareil est supposée juste, sauf recalage.
export function photoTimeTrusted(photo) {
    return TAKEN_RE.test(String(photo?.takenAt || ''));
}

// Heure vérifiée : photo géolocalisée (l'horloge suit le réseau) ou appareil
// recalé par l'utilisateur (même à 0).
export function photoTimeVerified(photo, offsets = new Map()) {
    if (!photoTimeTrusted(photo)) return false;
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
            const source = photo.posSource === POSITION_TRACK ? MATCH_TRACK : MATCH_GPS;
            let best = null;
            for (const c of all) {
                if (clock && c.date !== clock.date) continue;
                const m = groundDistanceKm([photo.lon, photo.lat], [c.stop.lon, c.stop.lat]) * 1000;
                if (m <= radiusM && (!best || m < best.distanceM)) best = { key: c.stop.key, source, distanceM: m };
            }
            result.set(photo.id, { ...(best || { key: null, source: null }), ...lost });
            continue;
        }
        if (clock && photoTimeTrusted(photo)) {
            // Écart à la visite élargie de la marge, puis, à égalité (deux
            // visites voisines dont les marges se chevauchent), écart à la
            // visite elle-même : une photo prise à l'arrivée sur une étape
            // n'est pas donnée à la précédente.
            const outside = (start, end) => (clock.minutes < start ? start - clock.minutes
                : clock.minutes > end ? clock.minutes - end : 0);
            let best = null;
            for (const c of all) {
                if (c.date !== clock.date || !Number.isFinite(c.stop.arrivalMin)) continue;
                const arrival = c.stop.arrivalMin;
                const leave = arrival + (c.stop.visitMin || 0);
                const gap = outside(arrival - VISIT_MARGIN_MIN, leave + VISIT_MARGIN_MIN);
                const core = outside(arrival, leave);
                if (gap <= windowMin && (!best || gap < best.gap || (gap === best.gap && core < best.core))) {
                    best = { key: c.stop.key, source: MATCH_TIME, gap, core };
                }
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
// (celui par l'heure découle de l'horaire : il ne peut pas le caler),
// de photos datées, le jour même de l'étape.
export function photoAnchors(reconstructed, photos, matches, offsets = new Map()) {
    const dateOf = new Map();
    for (const day of reconstructed?.days || []) for (const stop of day.stops) dateOf.set(stop.key, day.date);
    const anchors = new Map();
    for (const photo of Array.isArray(photos) ? photos : []) {
        const match = matches.get(photo?.id);
        if (!match?.key || (match.source !== MATCH_MANUAL && match.source !== MATCH_GPS)) continue;
        if (!photoTimeTrusted(photo)) continue;
        const clock = photoClock(photo, offsets);
        if (!clock || clock.date !== dateOf.get(match.key)) continue;
        const current = anchors.get(match.key);
        if (current === undefined || clock.minutes < current) anchors.set(match.key, clock.minutes);
    }
    return anchors;
}

// Ordre de prise de vue (heure corrigée), sans heure à la fin, puis par id.
function byShot(offsets) {
    const key = (photo) => {
        const c = photoClock(photo, offsets);
        return c ? `${c.date}${String(Math.round(c.minutes * 60)).padStart(6, '0')}` : '~';
    };
    return (a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
    };
}

// Photos à montrer par étape (ordre de prise de vue) : Map clé → [id]. Une
// photo masquée (`hidden`, lot 8) reste un indice (rattachement, ancre)
// mais n'est pas montrée : elle n'y figure pas.
export function photosByStop(photos, matches, offsets = new Map()) {
    const byKey = new Map();
    const sorted = (Array.isArray(photos) ? photos : []).filter((photo) => photo && !photo.hidden).sort(byShot(offsets));
    for (const photo of sorted) {
        const key = matches.get(photo.id)?.key;
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(photo.id);
    }
    return byKey;
}

// Photos « en chemin » (option `en_route` de l'affichage) : géolocalisées
// (EXIF ou trace), datées, non masquées et rattachées à
// aucune étape — prises entre deux étapes, loin de l'une comme de l'autre.
// Chacune va au trajet de sa journée dont la fenêtre [départ, arrivée]
// contient son heure (à PHOTO_TIME_WINDOW_MIN près ; à égalité, le trajet le
// plus proche) ; avant la première étape ou après la dernière, aucune.
// → Map « from>to » → [{ id, lon, lat, minutes (heure de la photo) }] dans
// l'ordre de prise de vue.
export function routePhotos(reconstructed, photos, matches, offsets = new Map(),
    { windowMin = PHOTO_TIME_WINDOW_MIN } = {}) {
    const byLeg = new Map();
    const days = new Map((reconstructed?.days || []).map((day) => [day.date, day.stops || []]));
    const sorted = (Array.isArray(photos) ? photos : []).filter((photo) => photo && !photo.hidden
        && hasPosition(photo) && !matches?.get?.(photo.id)?.key && photoTimeTrusted(photo))
        .sort(byShot(offsets));
    for (const photo of sorted) {
        const clock = photoClock(photo, offsets);
        const stops = clock ? days.get(clock.date) : null;
        if (!stops || stops.length < 2) continue;
        let best = null;
        for (let i = 1; i < stops.length; i++) {
            const a = stops[i - 1];
            const b = stops[i];
            if (!Number.isFinite(a.arrivalMin) || !Number.isFinite(b.arrivalMin)) continue;
            const depart = a.arrivalMin + (a.visitMin || 0);
            const gap = clock.minutes < depart ? depart - clock.minutes
                : clock.minutes > b.arrivalMin ? clock.minutes - b.arrivalMin : 0;
            if (gap > windowMin) continue;
            const km = segmentDistanceKm([photo.lon, photo.lat], [a.lon, a.lat], [b.lon, b.lat]);
            if (!best || gap < best.gap || (gap === best.gap && km < best.km)) best = { key: `${a.key}>${b.key}`, gap, km };
        }
        if (!best) continue;
        if (!byLeg.has(best.key)) byLeg.set(best.key, []);
        byLeg.get(best.key).push({ id: photo.id, lon: photo.lon, lat: photo.lat, minutes: clock.minutes });
    }
    return byLeg;
}

// Distance (km) d'un point [lon, lat] au segment [a, b], projection
// équirectangulaire locale — assez juste à l'échelle d'un trajet.
function segmentDistanceKm(p, a, b) {
    const k = Math.cos((p[1] * Math.PI) / 180) * 111.195;
    const ax = (a[0] - p[0]) * k;
    const ay = (a[1] - p[1]) * 111.195;
    const dx = (b[0] - a[0]) * k;
    const dy = (b[1] - a[1]) * 111.195;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    return Math.hypot(ax + u * dx, ay + u * dy);
}

// Grille de l'onglet Photos : filtre, puis regroupement par journée (date
// corrigée de l'appareil).
export const PHOTO_FILTER_ALL = 'all';
export const PHOTO_FILTER_UNLINKED = 'unlinked';
export const PHOTO_FILTER_HIDDEN = 'hidden';
export const PHOTO_FILTER_FAVORITE = 'favorite';
export const PHOTO_FILTERS = Object.freeze([
    PHOTO_FILTER_ALL, PHOTO_FILTER_UNLINKED, PHOTO_FILTER_FAVORITE, PHOTO_FILTER_HIDDEN,
]);

export function photoInFilter(photo, match, filter) {
    if (filter === PHOTO_FILTER_UNLINKED) return !match?.key;
    if (filter === PHOTO_FILTER_HIDDEN) return !!photo?.hidden;
    if (filter === PHOTO_FILTER_FAVORITE) return !!photo?.favorite;
    return true;
}

// Ids des photos favorites (cartons, priorité au-delà du plafond).
export function favoritePhotoIds(photos) {
    return new Set((Array.isArray(photos) ? photos : []).filter((p) => p?.favorite).map((p) => p.id));
}

// → [{ date: 'AAAA-MM-JJ' | null (sans heure), ids }] : journées dans
// l'ordre, photos sans heure en dernier ; dans une journée, l'ordre de prise
// de vue.
export function photoGridGroups(photos, matches, offsets = new Map(), filter = PHOTO_FILTER_ALL) {
    const groups = [];
    const sorted = (Array.isArray(photos) ? photos : [])
        .filter((photo) => photo && photoInFilter(photo, matches?.get?.(photo.id), filter))
        .sort(byShot(offsets));
    for (const photo of sorted) {
        const date = photoClock(photo, offsets)?.date || null;
        const last = groups[groups.length - 1];
        if (last && last.date === date) last.ids.push(photo.id);
        else groups.push({ date, ids: [photo.id] });
    }
    return groups;
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
