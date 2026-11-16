// Temps écran d'un parcours (MyGCFlow_Plan_Parcours.md, § 5) : quand chaque
// étape apparaît dans la vidéo, où est le géocacheur entre deux étapes, quelle
// heure afficher.
//
// Le moteur d'animation des pages « cycle de vie » avance en « jours » ; sur
// la page Parcours, un jour est un QUANTUM de temps écran (QUANTUM_MS à la
// vitesse naturelle, 10 par seconde). Chaque étape porte le quantum de son
// arrivée : le moteur la fait apparaître (et flasher) à ce quantum, et la
// position fractionnaire du moteur (quantum + part écoulée) donne celle de la
// tête et du trait. Durée totale, calage sur la musique, enregistrement image
// par image : tout passe par le moteur existant, qui ne fait que changer la
// durée d'un quantum.
//
// Deux rythmes :
// - « régulier » (défaut) : chaque étape a la même durée à l'écran, un trajet
//   dure a·√km, borné ;
// - « proportionnel » : visites et trajets proportionnels aux durées
//   reconstruites (parcours_reconstruct.mjs) — les longues attentes et les
//   longs trajets se voient.
// Entre deux journées, une transition de durée fixe (la nuit).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_timeline.test.mjs).

export const QUANTUM_MS = 100;
export const NATURAL_QUANTA_PER_SECOND = 1000 / QUANTUM_MS;

export const PACE_REGULAR = 'regular';
export const PACE_PROPORTIONAL = 'proportional';
export const PACES = Object.freeze([PACE_REGULAR, PACE_PROPORTIONAL]);

export const HOURS_APPROX = 'approx';
export const HOURS_EXACT = 'exact';
export const HOURS_SLOTS = 'slots';
export const HOURS_NONE = 'none';
export const HOURS_DISPLAYS = Object.freeze([HOURS_APPROX, HOURS_EXACT, HOURS_SLOTS, HOURS_NONE]);

export const PLAYBACK_DEFAULTS = Object.freeze({ pace: PACE_REGULAR, hours: HOURS_APPROX });

// Durées en quanta (× 100 ms à la vitesse naturelle).
export const TIMELINE_DEFAULTS = Object.freeze({
    introQ: 5,            // avant la première étape
    outroQ: 10,           // après la dernière
    stopQ: 12,            // régulier : durée d'une étape à l'écran
    legMinQ: 4,           // régulier : trajet le plus court
    legMaxQ: 30,          // régulier : trajet le plus long
    baseQ: 4,             // départ ou retour à la base : un bref arrêt
    photoQ: 15,           // chaque photo d'une étape (lot 4) : 1,5 s de plus
    maxPhotosPerStop: 4,  // au-delà, les photos se partagent ce temps
    legQPerSqrtKm: 6,     // régulier : trajet = 6·√km quanta, borné
    nightQ: 20,           // transition entre deux journées
    propQPerMinute: 0.5,  // proportionnel : 1 quantum pour 2 minutes réelles
    propMinStopQ: 3,      // proportionnel : une étape reste visible un instant
    propMinLegQ: 1,
});

export function normalizePlayback(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        pace: PACES.includes(o.pace) ? o.pace : PLAYBACK_DEFAULTS.pace,
        hours: HOURS_DISPLAYS.includes(o.hours) ? o.hours : PLAYBACK_DEFAULTS.hours,
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function quanta(value, min = 1) {
    return Math.max(min, Math.round(value));
}

function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : NaN;
}

// Construit la chronologie écran d'un parcours reconstruit
// (reconstructParcours). Retourne :
//   quanta : nombre de quanta (jours du moteur) de l'animation ;
//   stops  : étapes dans l'ordre, avec `q` (quantum d'arrivée), `departQ`,
//            `day` (index dans `days`), `km` (distance parcourue à l'arrivée) ;
//   legs   : trajets { from, to, startQ, endQ, km, mode, night } (index dans
//            `stops`) ;
//   days   : journées ayant des étapes { date, dayNumber, first, last, startQ }
//            — `dayNumber` : rang de la date dans la plage (1 = premier jour).
//   photos sur chaque étape : `photos` (ids, dans l'ordre d'affichage), et
//   `photoQ` (quanta de chaque photo) quand `photosByStop` en donne ;
//   vrai chemin d'un trajet : `path` ([[lon, lat], ...], extrémités
//   comprises) et `cum` (km cumulés) quand `legPaths` (« from>to ») en donne
//   — sa longueur remplace la distance à vol d'oiseau.
export function buildParcoursTimeline(reconstructed, {
    pace = PACE_REGULAR, photosByStop = null, legPaths = null, options = null,
} = {}) {
    const o = { ...TIMELINE_DEFAULTS, ...(options || {}) };
    const proportional = pace === PACE_PROPORTIONAL;
    const stops = [];
    const legs = [];
    const days = [];
    const rawDays = Array.isArray(reconstructed?.days) ? reconstructed.days : [];
    const origin = rawDays.length ? dayNumber(rawDays[0].date) : NaN;
    let q = o.introQ;
    let km = 0;
    for (const rawDay of rawDays) {
        const dayStops = Array.isArray(rawDay?.stops) ? rawDay.stops : [];
        if (dayStops.length === 0) continue;
        const dayIndex = days.length;
        const legByKey = new Map((rawDay.legs || []).map((leg) => [`${leg.from}>${leg.to}`, leg]));
        days.push({
            date: rawDay.date,
            dayNumber: Number.isFinite(origin) ? dayNumber(rawDay.date) - origin + 1 : dayIndex + 1,
            first: stops.length,
            last: stops.length + dayStops.length - 1,
            startQ: q,
        });
        for (let k = 0; k < dayStops.length; k++) {
            const stop = dayStops[k];
            if (stops.length > 0) {
                const prev = stops[stops.length - 1];
                const night = k === 0;
                const leg = night ? null : legByKey.get(`${prev.key}>${stop.key}`);
                const path = night ? null : legPaths?.get?.(`${prev.key}>${stop.key}`) || null;
                const cum = path ? cumulativeKm(path) : null;
                const legKm = cum ? cum[cum.length - 1] : (leg ? leg.km : distanceKm(prev, stop));
                let duration;
                if (night) duration = o.nightQ;
                else if (proportional) {
                    // Le trajet dure ce que dit l'horaire (ancres comprises),
                    // à défaut l'estimation du trajet.
                    const depart = (prev.arrivalMin ?? 0) + (prev.visitMin ?? 0);
                    const scheduled = Number.isFinite(stop.arrivalMin) ? stop.arrivalMin - depart : NaN;
                    const minutes = scheduled > 0 ? scheduled : (leg?.minutes ?? 0);
                    duration = quanta(minutes * o.propQPerMinute, o.propMinLegQ);
                } else duration = quanta(clamp(o.legQPerSqrtKm * Math.sqrt(legKm), o.legMinQ, o.legMaxQ));
                legs.push({
                    from: stops.length - 1,
                    to: stops.length,
                    startQ: q,
                    endQ: q + duration,
                    km: legKm,
                    mode: night ? 'night' : (path ? 'track' : (leg?.mode || 'walk')),
                    night,
                    ...(path ? { path, cum } : {}),
                });
                if (night) days[dayIndex].startQ = q;
                q += duration;
                km += legKm;
            }
            let dwell;
            if (stop.kind === 'base') dwell = o.baseQ;
            else if (proportional) dwell = quanta((stop.visitMin ?? 0) * o.propQPerMinute, o.propMinStopQ);
            else dwell = o.stopQ;
            // Photos : chacune a son temps d'écran, ajouté à celui de l'étape.
            const photos = photosByStop?.get?.(stop.key) || [];
            const photoQ = photos.length ? o.photoQ * Math.min(photos.length, o.maxPhotosPerStop) / photos.length : 0;
            dwell += photoQ * photos.length;
            stops.push({ ...stop, q, departQ: q + dwell, day: dayIndex, km, photos, photoQ });
            q += dwell;
        }
    }
    const quantaCount = stops.length ? q + o.outroQ : 0;
    return { quanta: quantaCount, stops, legs, days, totalKm: km };
}

const DEG = Math.PI / 180;
function distanceKm(a, b) {
    const dLat = (b.lat - a.lat) * DEG;
    const dLon = (b.lon - a.lon) * DEG;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

function cumulativeKm(path) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) {
        cum.push(cum[i - 1] + distanceKm({ lon: path[i - 1][0], lat: path[i - 1][1] }, { lon: path[i][0], lat: path[i][1] }));
    }
    return cum;
}

// Avancement `progress` (0..1, en distance) le long d'un trajet : { index, f }
// — la position est entre path[index] et path[index + 1], à la fraction f.
// Sans chemin, le trajet est le segment [départ, arrivée] (index 0).
export function legCut(leg, progress) {
    if (!leg?.path || leg.path.length < 2) return { index: 0, f: progress };
    const total = leg.cum[leg.cum.length - 1];
    if (!(total > 0)) return { index: 0, f: 0 };
    const target = progress * total;
    let lo = 0;
    let hi = leg.cum.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (leg.cum[mid] <= target) lo = mid;
        else hi = mid;
    }
    const span = leg.cum[hi] - leg.cum[lo];
    return { index: lo, f: span > 0 ? (target - leg.cum[lo]) / span : 0 };
}

// Points du trajet parcourus jusqu'à `progress` ([lon, lat], départ compris,
// position courante en dernier).
export function legPoints(timeline, legIndex, progress) {
    const leg = timeline.legs[legIndex];
    const a = timeline.stops[leg.from];
    const b = timeline.stops[leg.to];
    const path = leg.path || [[a.lon, a.lat], [b.lon, b.lat]];
    if (progress >= 1) return path;
    const { index, f } = legCut(leg, progress);
    const p = path[index];
    const r = path[Math.min(index + 1, path.length - 1)];
    return [...path.slice(0, index + 1), [p[0] + (r[0] - p[0]) * f, p[1] + (r[1] - p[1]) * f]];
}

// Dernière étape atteinte à la position `qf` (quanta fractionnaires) : -1
// avant la première.
export function reachedIndex(timeline, qf) {
    const stops = timeline?.stops || [];
    let lo = 0;
    let hi = stops.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (stops[mid].q <= qf) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

// Trajet en cours à `qf` (index dans `legs`), ou -1.
export function legIndexAt(timeline, qf) {
    const legs = timeline?.legs || [];
    let lo = 0;
    let hi = legs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (qf < legs[mid].startQ) hi = mid - 1;
        else if (qf >= legs[mid].endQ) lo = mid + 1;
        else return mid;
    }
    return -1;
}

// Position du géocacheur à `qf` : { lon, lat, leg, progress } ; progress
// (0..1, adouci) le long du trajet `leg` (-1 à l'arrêt). null sans étape.
export function headAt(timeline, qf) {
    const stops = timeline?.stops || [];
    if (stops.length === 0) return null;
    const legIndex = legIndexAt(timeline, qf);
    if (legIndex >= 0) {
        const leg = timeline.legs[legIndex];
        const progress = smoothstep(clamp((qf - leg.startQ) / Math.max(1e-9, leg.endQ - leg.startQ), 0, 1));
        const points = legPoints(timeline, legIndex, progress);
        const [lon, lat] = points[points.length - 1];
        return { lon, lat, leg: legIndex, progress };
    }
    const reached = Math.max(0, reachedIndex(timeline, qf));
    return { lon: stops[reached].lon, lat: stops[reached].lat, leg: -1, progress: 0 };
}

// État affiché à `qf` : étape atteinte, journée, heure (minutes depuis
// minuit, interpolée entre les heures reconstruites), heure estimée ou sûre,
// distance parcourue, comptes d'étapes par nature.
export function stateAt(timeline, qf) {
    const stops = timeline?.stops || [];
    if (stops.length === 0) return null;
    const reached = reachedIndex(timeline, qf);
    const legIndex = legIndexAt(timeline, qf);
    let dayIndex;
    let minutes;
    let estimated;
    let km;
    if (legIndex >= 0) {
        const leg = timeline.legs[legIndex];
        const a = stops[leg.from];
        const b = stops[leg.to];
        const t = clamp((qf - leg.startQ) / Math.max(1e-9, leg.endQ - leg.startQ), 0, 1);
        if (leg.night) {
            // La nuit : la nouvelle journée commence, l'heure est celle de la
            // première étape du lendemain.
            dayIndex = b.day;
            minutes = b.arrivalMin;
            estimated = b.confidence !== 'anchored';
        } else {
            dayIndex = a.day;
            const depart = a.arrivalMin + (a.visitMin ?? 0);
            minutes = depart + (b.arrivalMin - depart) * t;
            estimated = a.confidence !== 'anchored' || b.confidence !== 'anchored';
        }
        km = a.km + leg.km * smoothstep(t);
    } else {
        const at = stops[Math.max(0, reached)];
        dayIndex = at.day;
        if (reached < 0) {
            minutes = at.arrivalMin;
        } else {
            const t = clamp((qf - at.q) / Math.max(1e-9, at.departQ - at.q), 0, 1);
            minutes = at.arrivalMin + (at.visitMin ?? 0) * t;
        }
        estimated = at.confidence !== 'anchored';
        km = reached < 0 ? 0 : at.km;
    }
    // Lieux et bases posés par l'utilisateur : pas des étapes du parcours.
    let counted = 0;
    let finds = 0;
    let labs = 0;
    for (let i = 0; i <= reached; i++) {
        const kind = stops[i].kind;
        if (kind === 'place' || kind === 'base') continue;
        counted++;
        if (kind === 'lab') labs++;
        else if (kind === 'find') finds++;
    }
    const day = timeline.days[dayIndex];
    return {
        reached,
        stopsReached: counted,
        finds,
        labs,
        dayIndex,
        date: day?.date ?? null,
        dayNumber: day?.dayNumber ?? dayIndex + 1,
        minutes,
        estimated,
        km,
    };
}

// Heure affichée selon le réglage : « 10:40 », « ≈ 10:40 », une tranche de
// la journée (`slotLabels` : { morning, noon, afternoon, evening }, fournis
// traduits par l'appelant) ou rien.
export function formatClock(minutes, estimated, mode, slotLabels = {}) {
    if (!Number.isFinite(minutes) || mode === HOURS_NONE) return '';
    if (mode === HOURS_SLOTS) {
        const h = minutes / 60;
        if (h < 12) return slotLabels.morning ?? '';
        if (h < 14) return slotLabels.noon ?? '';
        if (h < 18) return slotLabels.afternoon ?? '';
        return slotLabels.evening ?? '';
    }
    const total = clamp(Math.round(minutes), 0, 24 * 60 - 1);
    const text = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    return mode === HOURS_APPROX && estimated ? `≈ ${text}` : text;
}

// Trajets à dessiner jusqu'à `qf` : index des trajets terminés et, s'il y en
// a un, le trajet en cours avec sa part parcourue.
export function trailAt(timeline, qf) {
    const legs = timeline?.legs || [];
    let done = 0;
    while (done < legs.length && legs[done].endQ <= qf) done++;
    const current = done < legs.length && legs[done].startQ <= qf
        ? { leg: done, progress: smoothstep(clamp((qf - legs[done].startQ) / Math.max(1e-9, legs[done].endQ - legs[done].startQ), 0, 1)) }
        : null;
    return { done, current };
}

// Étapes qui apparaissent dans les quanta [first, last] (index dans `stops`).
export function stopsInRange(timeline, first, last) {
    const out = [];
    for (let i = 0; i < (timeline?.stops || []).length; i++) {
        const q = timeline.stops[i].q;
        if (q >= first && q <= last) out.push(i);
    }
    return out;
}
