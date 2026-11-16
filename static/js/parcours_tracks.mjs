// Traces GPS d'un parcours (MyGCFlow_Plan_Parcours.md, § 9 ; lot 5) :
// heure locale, rattachement des étapes, ancres, vrai chemin.
//
// Une trace (parcours_tracks.py) est une suite de segments de points
// [lon, lat, t], t en secondes UTC, simplifiés à l'import (10 m) : une ligne
// droite peut ne garder que ses deux bouts. On mesure donc la distance d'une
// étape à chaque TRONÇON de trace (projection, heure interpolée), pas aux
// seuls points.
//
// Heure LOCALE : les heures du parcours sont murales (Labs, photos), les
// traces en UTC. Décalage, du plus sûr au plus faible (`resolveUtcOffset`) :
// réglage du parcours, décalage noté dans l'EXIF des photos, comparaison
// d'heures murales SITUÉES sur la trace (étapes Lab, photos géolocalisées),
// fuseau de l'ordinateur à cette date.
//
// Rattachement d'une étape : chaque PASSAGE (suite de tronçons à moins de
// TRACK_MATCH_RADIUS_M) le jour de l'étape ; on garde celui où l'on s'est le
// plus attardé (le géocacheur cherche la cache — un aller-retour sur le même
// sentier passe deux fois), et l'arrivée est le premier instant à moins de
// max(TRACK_ARRIVAL_RADIUS_M, 2 × distance minimale). Cette heure devient une
// ANCRE de l'étape (raison `track`), après l'heure épinglée et celle des
// Labs, avant celle des photos.
//
// Vrai chemin : entre deux étapes consécutives rattachées au même segment de
// la même trace, dans l'ordre, le trajet suit la trace (`trackLegPaths`).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_tracks.test.mjs).

import { KIND_BASE, reconstructParcours } from './parcours_reconstruct.mjs';
import { cameraOffsets, matchPhotos, photoAnchors, photosByStop } from './parcours_photos.mjs';

export const TRACK_MATCH_RADIUS_M = 100;
export const TRACK_ARRIVAL_RADIUS_M = 30;
export const OFFSET_EVIDENCE_RADIUS_M = 50;

export const OFFSET_MANUAL = 'manual';
export const OFFSET_PHOTOS = 'photos';
export const OFFSET_EVIDENCE = 'evidence';
export const OFFSET_COMPUTER = 'computer';

const EARTH_M = 6371008.8;
const DEG = Math.PI / 180;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Décalage du fuseau de l'ordinateur à cette date (minutes, est positif).
export function computerUtcOffset(dateIso) {
    const d = new Date(`${dateIso}T12:00:00`);
    return Number.isFinite(d.getTime()) ? -d.getTimezoneOffset() : 0;
}

// Heure locale d'un instant UTC (secondes) : { date, minutes }.
export function localClock(tSeconds, offsetMin) {
    const d = new Date((tSeconds + offsetMin * 60) * 1000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 };
}

// Heure murale « AAAA-MM-JJ » + minutes → secondes, comme si c'était de l'UTC.
function wallSeconds(date, minutes) {
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) ? ms / 1000 + minutes * 60 : NaN;
}

// Point d'un tronçon [a, b] le plus proche de `p` : { d (m), u (0..1) },
// projection équirectangulaire locale autour de `p`.
function nearestOnSegment(p, a, b) {
    const k = Math.cos(p[1] * DEG);
    const ax = (a[0] - p[0]) * DEG * EARTH_M * k;
    const ay = (a[1] - p[1]) * DEG * EARTH_M;
    const bx = (b[0] - p[0]) * DEG * EARTH_M * k;
    const by = (b[1] - p[1]) * DEG * EARTH_M;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const u = length2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
    return { d: Math.hypot(ax + u * dx, ay + u * dy), u };
}

// Tronçons d'une trace : [{ trackId, segment, k, a, b }] (points [lon, lat, t]).
function* pieces(tracks) {
    for (const track of Array.isArray(tracks) ? tracks : []) {
        const segments = track.segments || [];
        for (let s = 0; s < segments.length; s++) {
            const segment = segments[s];
            if (segment.length === 1) {
                yield { trackId: track.id, segment: s, k: 0, a: segment[0], b: segment[0] };
            }
            for (let k = 0; k + 1 < segment.length; k++) {
                yield { trackId: track.id, segment: s, k, a: segment[k], b: segment[k + 1] };
            }
        }
    }
}

// Passages d'une trace près d'un point : suites de tronçons consécutifs à
// moins de `radiusM`. Chaque passage : { trackId, segment, start, end, minD,
// pieces: [{ k, d, u, t }] }.
export function passesNear(point, tracks, radiusM) {
    const passes = [];
    let current = null;
    for (const piece of pieces(tracks)) {
        const { d, u } = nearestOnSegment(point, piece.a, piece.b);
        const continues = current && current.trackId === piece.trackId && current.segment === piece.segment
            && current.lastK === piece.k - 1;
        if (d > radiusM) {
            if (current) passes.push(current);
            current = null;
            continue;
        }
        if (!continues) {
            if (current) passes.push(current);
            current = { trackId: piece.trackId, segment: piece.segment, start: piece.a[2], end: piece.b[2], minD: d, pieces: [] };
        }
        const t = piece.a[2] + u * (piece.b[2] - piece.a[2]);
        current.pieces.push({ k: piece.k, d, u, t, lon: piece.a[0] + u * (piece.b[0] - piece.a[0]), lat: piece.a[1] + u * (piece.b[1] - piece.a[1]) });
        current.end = piece.b[2];
        current.minD = Math.min(current.minD, d);
        current.lastK = piece.k;
    }
    if (current) passes.push(current);
    return passes;
}

// Décalage UTC du parcours : { minutes, source }.
export function resolveUtcOffset({ parcours = null, photos = [], tracks = [], reconstructed = null } = {}) {
    if (Number.isFinite(parcours?.utc_offset_minutes)) {
        return { minutes: parcours.utc_offset_minutes, source: OFFSET_MANUAL };
    }
    const fromExif = (photos || []).map((p) => p?.offsetMinutes).filter(Number.isFinite);
    if (fromExif.length > 0) return { minutes: median(fromExif), source: OFFSET_PHOTOS };
    // Heures murales situées sur la trace : étapes Lab, photos géolocalisées.
    const evidence = [];
    const consider = (lon, lat, date, minutes) => {
        if (!tracks?.length || !Number.isFinite(minutes)) return;
        const wall = wallSeconds(date, minutes);
        let best = null;
        for (const pass of passesNear([lon, lat], tracks, OFFSET_EVIDENCE_RADIUS_M)) {
            for (const piece of pass.pieces) {
                const delta = (wall - piece.t) / 60;
                // Même journée à un jour près, décalage plausible.
                if (delta < -14 * 60 || delta > 14 * 60) continue;
                if (!best || piece.d < best.d) best = { d: piece.d, delta };
            }
        }
        if (best) evidence.push(best.delta);
    };
    for (const day of reconstructed?.days || []) {
        for (const stop of day.stops) {
            const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(stop.localTime || '');
            if (stop.kind === 'lab' && m) consider(stop.lon, stop.lat, day.date, Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / 60);
        }
    }
    for (const photo of photos || []) {
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(photo?.takenAt || '');
        if (m && Number.isFinite(photo.lat) && Number.isFinite(photo.lon)) {
            consider(photo.lon, photo.lat, m[1], Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60);
        }
    }
    if (evidence.length > 0) return { minutes: Math.round(median(evidence) / 15) * 15, source: OFFSET_EVIDENCE };
    const first = reconstructed?.days?.find((d) => d.stops.length > 0)?.date || reconstructed?.days?.[0]?.date;
    return { minutes: first ? computerUtcOffset(first) : 0, source: OFFSET_COMPUTER };
}

// Rattachement des étapes aux traces : Map clé → { trackId, segment, k, u,
// lon, lat, date, minutes, distanceM, dwellS }.
export function matchStopsToTracks(reconstructed, tracks, offsetMin,
    { radiusM = TRACK_MATCH_RADIUS_M, arrivalRadiusM = TRACK_ARRIVAL_RADIUS_M } = {}) {
    const matches = new Map();
    if (!tracks?.length) return matches;
    for (const day of reconstructed?.days || []) {
        for (const stop of day.stops) {
            if (stop.kind === KIND_BASE) continue;
            let best = null;
            for (const pass of passesNear([stop.lon, stop.lat], tracks, radiusM)) {
                const closest = pass.pieces.reduce((a, b) => (b.d < a.d ? b : a));
                if (localClock(closest.t, offsetMin).date !== day.date) continue;
                const dwell = pass.end - pass.start;
                if (!best || dwell > best.dwell + 1e-9 || (Math.abs(dwell - best.dwell) <= 1e-9 && pass.minD < best.pass.minD)) {
                    best = { pass, dwell };
                }
            }
            if (!best) continue;
            const limit = Math.max(arrivalRadiusM, 2 * best.pass.minD);
            const arrival = best.pass.pieces.find((piece) => piece.d <= limit) || best.pass.pieces[0];
            const clock = localClock(arrival.t, offsetMin);
            matches.set(stop.key, {
                trackId: best.pass.trackId,
                segment: best.pass.segment,
                k: arrival.k,
                u: arrival.u,
                t: arrival.t,
                lon: arrival.lon,
                lat: arrival.lat,
                date: clock.date,
                minutes: clock.minutes,
                distanceM: best.pass.minD,
                dwellS: best.dwell,
            });
        }
    }
    return matches;
}

export function trackAnchors(matches) {
    const anchors = new Map();
    for (const [key, match] of matches) anchors.set(key, match.minutes);
    return anchors;
}

// Chemins réels : Map « from>to » → [[lon, lat], ...], pour deux étapes
// consécutives rattachées au même segment de la même trace, dans l'ordre.
export function trackLegPaths(reconstructed, matches, tracks) {
    const segmentOf = new Map();
    for (const track of tracks || []) {
        (track.segments || []).forEach((segment, s) => segmentOf.set(`${track.id}:${s}`, segment));
    }
    const paths = new Map();
    for (const day of reconstructed?.days || []) {
        for (let i = 1; i < day.stops.length; i++) {
            const a = matches.get(day.stops[i - 1].key);
            const b = matches.get(day.stops[i].key);
            if (!a || !b || a.trackId !== b.trackId || a.segment !== b.segment || !(b.t > a.t)) continue;
            const points = segmentOf.get(`${a.trackId}:${a.segment}`);
            if (!points) continue;
            const path = [[a.lon, a.lat]];
            for (let k = a.k + 1; k <= b.k; k++) path.push([points[k][0], points[k][1]]);
            path.push([b.lon, b.lat]);
            paths.set(`${day.stops[i - 1].key}>${day.stops[i].key}`, path);
        }
    }
    return paths;
}

// Reconstruction complète, traces et photos comprises : { ordered, matches
// (photos), byStop, trackMatches, legPaths, utcOffset }. `legHints` : durées
// des itinéraires calculés (lot 6), passées à chaque reconstruction.
export function reconstructWithEvidence(inputs, options = null, { legHints = null } = {}) {
    const photos = Array.isArray(inputs?.photos) ? inputs.photos : [];
    const tracks = Array.isArray(inputs?.tracks) ? inputs.tracks : [];
    let ordered = reconstructParcours(inputs, { options, legHints });
    const utcOffset = resolveUtcOffset({ parcours: inputs?.parcours, photos, tracks, reconstructed: ordered });
    const trackMatches = matchStopsToTracks(ordered, tracks, utcOffset.minutes);
    const fromTracks = trackAnchors(trackMatches);
    if (fromTracks.size > 0) ordered = reconstructParcours(inputs, { options, trackAnchors: fromTracks, legHints });
    let matches = new Map();
    if (photos.length > 0) {
        const offsets = cameraOffsets(inputs?.cameras);
        matches = matchPhotos(ordered, photos, offsets);
        const fromPhotos = photoAnchors(ordered, photos, matches, offsets);
        if (fromPhotos.size > 0) {
            ordered = reconstructParcours(inputs, { options, trackAnchors: fromTracks, photoAnchors: fromPhotos, legHints });
            matches = matchPhotos(ordered, photos, offsets);
        }
    }
    return {
        ordered,
        matches,
        byStop: photosByStop(photos, matches, cameraOffsets(inputs?.cameras)),
        trackMatches,
        legPaths: trackLegPaths(ordered, trackMatches, tracks),
        utcOffset,
    };
}
