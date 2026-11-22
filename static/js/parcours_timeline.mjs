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

export const CAMERA_FOLLOW = 'follow';
export const CAMERA_FIXED = 'fixed';
export const CAMERA_MODES = Object.freeze([CAMERA_FOLLOW, CAMERA_FIXED]);

// Cadrage de la caméra suivie (option `frame` de parcours_camera.mjs :
// multiplicateur de l'emprise visée — 1,5 montre ~50 % de plus autour).
export const FRAMING_TIGHT = 'tight';
export const FRAMING_BALANCED = 'balanced';
export const FRAMING_WIDE = 'wide';
export const FRAMINGS = Object.freeze([FRAMING_TIGHT, FRAMING_BALANCED, FRAMING_WIDE]);
export const FRAMING_FRAME = Object.freeze({ [FRAMING_TIGHT]: 0.7, [FRAMING_BALANCED]: 1, [FRAMING_WIDE]: 1.5 });

export const HEAD_PICTOGRAM = 'mode';
export const HEAD_DOT = 'dot';
export const HEAD_STYLES = Object.freeze([HEAD_PICTOGRAM, HEAD_DOT]);

// Lot 7 : caméra qui suit le géocacheur, cartons et nuit entre deux journées,
// pictogramme du mode de déplacement, trajets estimés en pointillés.
export const PLAYBACK_DEFAULTS = Object.freeze({
    pace: PACE_REGULAR,
    hours: HOURS_APPROX,
    camera: CAMERA_FOLLOW,
    framing: FRAMING_BALANCED,
    day_cards: true,
    head: HEAD_PICTOGRAM,
    estimated_dashed: false,
});

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
    endCardQ: 24,         // carton final de synthèse : temps d'écran ajouté
});

export function normalizePlayback(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const flag = (key) => (typeof o[key] === 'boolean' ? o[key] : PLAYBACK_DEFAULTS[key]);
    return {
        pace: PACES.includes(o.pace) ? o.pace : PLAYBACK_DEFAULTS.pace,
        hours: HOURS_DISPLAYS.includes(o.hours) ? o.hours : PLAYBACK_DEFAULTS.hours,
        camera: CAMERA_MODES.includes(o.camera) ? o.camera : PLAYBACK_DEFAULTS.camera,
        framing: FRAMINGS.includes(o.framing) ? o.framing : PLAYBACK_DEFAULTS.framing,
        day_cards: flag('day_cards'),
        head: HEAD_STYLES.includes(o.head) ? o.head : PLAYBACK_DEFAULTS.head,
        estimated_dashed: flag('estimated_dashed'),
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
//   endCard : ajoute `endCardQ` quanta de clôture après l'outro, le temps
//             d'afficher le carton final de synthèse (cartons activés).
//   timing ({ msPerDay, fixedTotal }) : sous le quantum naturel, les contenus
//             « à lire » — photos, nuits (carton du jour), intro, outro et
//             carton final — gardent leur durée écran naturelle, le temps
//             manquant étant pris sur les visites et les trajets. Avec
//             `fixedTotal` (durée imposée, musique), le total de quanta est
//             conservé ; sinon la chronologie s'allonge d'autant.
export function buildParcoursTimeline(reconstructed, {
    pace = PACE_REGULAR, photosByStop = null, legPaths = null, endCard = false, options = null, timing = null,
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
                if (night) {
                    // Trou calendaire avant la journée : la nuit dure plus —
                    // ellipse ressentie (lendemain ×1, un jour sauté ×1,5,
                    // plafond ×2).
                    const jump = Math.max(1,
                        (days[dayIndex].dayNumber || 0) - (days[dayIndex - 1].dayNumber || 0));
                    duration = quanta(o.nightQ * Math.min(2, 1 + 0.5 * (jump - 1)));
                }
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
                    // Chemin d'un itinéraire (lot 6) : son mode ; d'une trace : « track ».
                    mode: night ? 'night' : (leg?.routed ? leg.mode : path ? 'track' : (leg?.mode || 'walk')),
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
    const quantaCount = stops.length ? q + o.outroQ + (endCard ? o.endCardQ : 0) : 0;
    return compressTimeline(
        { quanta: quantaCount, endCardQ: endCard ? o.endCardQ : 0, stops, legs, days, totalKm: km },
        timing, o,
    );
}

// Part du budget que les contenus « à lire » (photos, nuits, cartons) peuvent
// occuper au maximum quand la durée est imposée : au-delà, leurs planchers se
// réduisent ensemble plutôt que d'écraser les visites et les trajets.
const FLOOR_MAX_SHARE = 0.7;

// Réalloue les quanta de la chronologie naturelle quand le quantum est
// compressé (msPerDay < QUANTUM_MS) : les contenus à lire gardent leur durée
// écran naturelle — leur plancher —, le reste absorbe la compression.
function compressTimeline(tl, timing, o) {
    const msPerDay = Number(timing?.msPerDay);
    if (!tl.stops.length || !Number.isFinite(msPerDay) || !(msPerDay < QUANTUM_MS)) return tl;
    const stretch = QUANTUM_MS / msPerDay;   // > 1 : un quantum vaut moins de 100 ms
    const floorQ = (naturalQ) => Math.max(1, Math.round(naturalQ * stretch));
    const items = {
        intro: { natural: o.introQ, floor: true },
        outro: { natural: o.outroQ, floor: true },
        endCard: { natural: tl.endCardQ, floor: true },
    };
    // Par étape : durée hors photos (élastique) et bloc des photos (plancher) ;
    // par trajet : trajet de jour (élastique) ou nuit (plancher).
    const baseDwells = tl.stops.map((stop) => {
        const block = stop.photoQ * stop.photos.length;
        return { natural: (stop.departQ - stop.q) - block, elastic: true };
    });
    const photoBlocks = tl.stops.map((stop) => {
        const block = stop.photoQ * stop.photos.length;
        return block > 0 ? { natural: block, floor: true } : null;
    });
    const legItems = tl.legs.map((leg) => ({ natural: leg.endQ - leg.startQ, floor: leg.night }));
    const all = [items.intro, items.outro, items.endCard, ...baseDwells, ...photoBlocks.filter(Boolean), ...legItems]
        .filter((it) => it.natural > 0);
    let floorTotal = 0;
    let elasticTotal = 0;
    for (const it of all) {
        if (it.floor) floorTotal += floorQ(it.natural);
        else elasticTotal += it.natural;
    }
    let floorScale = 1;
    let elasticScale = 1;
    if (timing.fixedTotal) {
        const budget = tl.quanta;
        const cap = Math.floor(budget * FLOOR_MAX_SHARE);
        if (floorTotal > cap) floorScale = cap / floorTotal;
        const pool = Math.max(0, budget - Math.min(floorTotal, cap));
        elasticScale = elasticTotal > 0 ? pool / elasticTotal : 0;
    }
    const allocOf = (it) => it.floor
        ? Math.max(1, Math.round(floorQ(it.natural) * floorScale))
        : Math.max(1, Math.round(it.natural * elasticScale));
    let q = allocOf(items.intro);
    if (tl.days.length) tl.days[0].startQ = q;
    for (let i = 0; i < tl.stops.length; i++) {
        const stop = tl.stops[i];
        const leg = i > 0 ? tl.legs[i - 1] : null;
        if (leg) {
            leg.startQ = q;
            leg.endQ = q + allocOf(legItems[i - 1]);
            q = leg.endQ;
            if (leg.night) tl.days[stop.day].startQ = leg.startQ;
        }
        const blockQ = photoBlocks[i] ? allocOf(photoBlocks[i]) : 0;
        stop.photoQ = blockQ ? blockQ / stop.photos.length : 0;
        stop.q = q;
        stop.departQ = q + allocOf(baseDwells[i]) + blockQ;
        q = stop.departQ;
    }
    tl.endCardQ = tl.endCardQ ? allocOf(items.endCard) : 0;
    tl.quanta = q + allocOf(items.outro) + tl.endCardQ;
    return tl;
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

// Position à `progress` le long du trajet `legIndex` ([lon, lat]) : le
// dernier point de legPoints, sans recopier le chemin.
function pointOnLeg(timeline, legIndex, progress) {
    const leg = timeline.legs[legIndex];
    const a = timeline.stops[leg.from];
    const b = timeline.stops[leg.to];
    const path = leg.path || [[a.lon, a.lat], [b.lon, b.lat]];
    if (progress >= 1) return path[path.length - 1];
    const { index, f } = legCut(leg, progress);
    const p = path[index];
    const r = path[Math.min(index + 1, path.length - 1)];
    return [p[0] + (r[0] - p[0]) * f, p[1] + (r[1] - p[1]) * f];
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
        const [lon, lat] = pointOnLeg(timeline, legIndex, progress);
        return { lon, lat, leg: legIndex, progress };
    }
    const reached = Math.max(0, reachedIndex(timeline, qf));
    return { lon: stops[reached].lon, lat: stops[reached].lat, leg: -1, progress: 0 };
}

// Comptes cumulés d'étapes par nature, pré-calculés une fois par
// chronologie : `stateAt` les lit en O(1) au lieu de recompter les étapes
// atteintes à chaque appel (plusieurs fois par image pendant la lecture).
const countPrefixMemo = new WeakMap();

function countPrefix(timeline) {
    let prefix = countPrefixMemo.get(timeline);
    if (!prefix) {
        const stops = timeline?.stops || [];
        const counted = new Int32Array(stops.length + 1);
        const finds = new Int32Array(stops.length + 1);
        const labs = new Int32Array(stops.length + 1);
        const favorites = new Int32Array(stops.length + 1);
        for (let i = 0; i < stops.length; i++) {
            const kind = stops[i].kind;
            counted[i + 1] = counted[i];
            finds[i + 1] = finds[i];
            labs[i + 1] = labs[i];
            favorites[i + 1] = favorites[i];
            if (kind === 'place' || kind === 'base') continue;
            counted[i + 1]++;
            if (kind === 'lab') labs[i + 1]++;
            else if (kind === 'find') {
                finds[i + 1]++;
                if (stops[i].favorite) favorites[i + 1]++;
            }
        }
        prefix = { counted, finds, labs, favorites };
        countPrefixMemo.set(timeline, prefix);
    }
    return prefix;
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
    // Lieux et bases posés par l'utilisateur : pas des étapes du parcours
    // (comptes cumulés pré-calculés à la construction).
    const counts = countPrefix(timeline);
    const counted = counts.counted[reached + 1];
    const finds = counts.finds[reached + 1];
    const labs = counts.labs[reached + 1];
    const favorites = counts.favorites[reached + 1];
    const day = timeline.days[dayIndex];
    return {
        reached,
        stopsReached: counted,
        finds,
        labs,
        favorites,
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
// a un, le trajet en cours avec sa part parcourue. Les fins de trajet
// croissent le long de la chronologie : borne dichotomique.
export function trailAt(timeline, qf) {
    const legs = timeline?.legs || [];
    let done = 0;
    let hi = legs.length;
    while (done < hi) {
        const mid = (done + hi) >> 1;
        if (legs[mid].endQ <= qf) done = mid + 1;
        else hi = mid;
    }
    const current = done < legs.length && legs[done].startQ <= qf
        ? { leg: done, progress: smoothstep(clamp((qf - legs[done].startQ) / Math.max(1e-9, legs[done].endQ - legs[done].startQ), 0, 1)) }
        : null;
    return { done, current };
}

// Étapes qui apparaissent dans les quanta [first, last] (index dans `stops`).
// Les quanta croissent le long de la chronologie : bornes dichotomiques.
export function stopsInRange(timeline, first, last) {
    const stops = timeline?.stops || [];
    const out = [];
    let lo = 0;
    let hi = stops.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stops[mid].q < first) lo = mid + 1;
        else hi = mid;
    }
    for (let i = lo; i < stops.length && stops[i].q <= last; i++) out.push(i);
    return out;
}

// --- Nuit, cartons de jour, tête (lot 7) ---------------------------------------

export const SCENE_DEFAULTS = Object.freeze({
    nightRampShare: 0.3,  // part de la nuit pour assombrir (puis éclaircir)
    cardFromShare: 0.25,  // le carton paraît au quart de la nuit…
    cardHoldQ: 6,         // …et reste ce temps après l'arrivée à la 1re étape
    cardFadeQ: 3,
});

// Durées de scène ramenées au rythme de lecture : fondu et maintien du carton
// de journée gardent leur temps écran quand le quantum est compressé (durée
// imposée, rythme rapide). À vitesse naturelle ou plus lente : les défauts.
export function sceneTimingOptions(msPerDay) {
    const scale = QUANTUM_MS / Math.max(1e-3, Number(msPerDay) || QUANTUM_MS);
    if (!(scale > 1)) return {};
    return {
        cardHoldQ: SCENE_DEFAULTS.cardHoldQ * scale,
        cardFadeQ: SCENE_DEFAULTS.cardFadeQ * scale,
    };
}

// Assombrissement de la nuit à `qf` : 0 (jour) à 1 (cœur de la nuit).
export function nightLevelAt(timeline, qf, options = {}) {
    const o = { ...SCENE_DEFAULTS, ...options };
    const legIndex = legIndexAt(timeline, qf);
    if (legIndex < 0 || !timeline.legs[legIndex].night) return 0;
    const leg = timeline.legs[legIndex];
    const t = clamp((qf - leg.startQ) / Math.max(1e-9, leg.endQ - leg.startQ), 0, 1);
    return smoothstep(clamp(Math.min(t, 1 - t) / Math.max(1e-9, o.nightRampShare), 0, 1));
}

// Jambes de nuit par étape d'arrivée, calculées une fois par chronologie :
// `dayCardAt` est appelé à chaque image pendant la lecture.
const nightIntoMemo = new WeakMap();

function nightIntoMap(timeline) {
    let map = nightIntoMemo.get(timeline);
    if (!map) {
        map = new Map();
        for (const leg of timeline?.legs || []) if (leg.night) map.set(leg.to, leg);
        nightIntoMemo.set(timeline, map);
    }
    return map;
}

// Bilan d'une journée pour son carton : étapes comptées et km parcourus
// dans la journée (le trajet de nuit qui l'amène n'y compte pas), et saut
// calendaire avant elle (`gapDays` = 1 au lendemain, > 1 après des jours
// vides — la nuit de transition est d'autant plus longue).
export function dayStats(timeline, dayIndex) {
    const day = timeline?.days?.[dayIndex];
    if (!day) return null;
    let counted = 0;
    for (let i = day.first; i <= day.last; i++) {
        const kind = timeline.stops[i]?.kind;
        if (kind !== 'place' && kind !== 'base') counted++;
    }
    const km = Math.max(0, (timeline.stops[day.last]?.km ?? 0) - (timeline.stops[day.first]?.km ?? 0));
    const prev = timeline.days[dayIndex - 1];
    const gapDays = prev ? Math.max(1, (day.dayNumber || 0) - (prev.dayNumber || 0)) : 1;
    return { counted, km, gapDays };
}

// Carton de journée à `qf` : { day (index dans `days`), alpha } ou null.
// Seulement pour un parcours de plusieurs journées : le premier dès le
// début, les suivants pendant la nuit qui y mène.
export function dayCardAt(timeline, qf, options = {}) {
    const days = timeline?.days || [];
    if (days.length < 2) return null;
    const o = { ...SCENE_DEFAULTS, ...options };
    const nightInto = nightIntoMap(timeline);
    for (let d = 0; d < days.length; d++) {
        const first = timeline.stops[days[d].first];
        const night = nightInto.get(days[d].first);
        const from = night ? night.startQ + (night.endQ - night.startQ) * o.cardFromShare : 0;
        const to = first.q + o.cardHoldQ;
        if (qf < from || qf > to) continue;
        const fadeIn = night ? clamp((qf - from) / o.cardFadeQ, 0, 1) : 1;
        const fadeOut = clamp((to - qf) / o.cardFadeQ, 0, 1);
        return { day: d, alpha: Math.min(fadeIn, fadeOut) };
    }
    return null;
}

// Carton final de synthèse à `qf` : { alpha } ou null. Il occupe les
// `endCardQ` derniers quanta, temps ajouté quand la chronologie est
// construite avec `endCard` (cartons activés).
export function endCardAt(timeline, qf, options = {}) {
    if (!timeline?.stops?.length) return null;
    const o = { ...TIMELINE_DEFAULTS, ...SCENE_DEFAULTS, ...options };
    const from = timeline.quanta - (timeline.endCardQ || o.endCardQ);
    if (qf < from || qf > timeline.quanta) return null;
    const fadeIn = clamp((qf - from) / o.cardFadeQ, 0, 1);
    const fadeOut = clamp((timeline.quanta - qf) / o.cardFadeQ, 0, 1);
    return { alpha: Math.min(fadeIn, fadeOut) };
}

export const HEAD_MODES = Object.freeze(['walk', 'bike', 'car', 'plane', 'night']);

// Mode de déplacement d'un trajet, pour le pictogramme de la tête : celui de
// l'itinéraire ou imposé ; sur une trace ou en ligne droite, déduit de la
// vitesse de l'horaire (au-delà de 150 km en ligne droite : l'avion).
export function legTravelMode(timeline, legIndex) {
    const leg = timeline?.legs?.[legIndex];
    if (!leg) return 'walk';
    if (leg.night) return 'night';
    if (leg.mode === 'walk' || leg.mode === 'bike' || leg.mode === 'car') return leg.mode;
    if (leg.mode === 'straight' && leg.km > 150) return 'plane';
    const a = timeline.stops[leg.from];
    const b = timeline.stops[leg.to];
    const minutes = (b.arrivalMin ?? NaN) - ((a.arrivalMin ?? NaN) + (a.visitMin ?? 0));
    if (Number.isFinite(minutes) && minutes > 0) {
        const speed = leg.km / (minutes / 60);
        if (speed < 7) return 'walk';
        if (speed < 22) return 'bike';
        return speed > 250 ? 'plane' : 'car';
    }
    return leg.km <= 1.5 ? 'walk' : 'car';
}

// Pictogramme de la tête à `qf` : le trajet en cours ; à l'arrêt, le trajet
// qui y a mené (sinon le suivant).
export function headModeAt(timeline, qf) {
    const legs = timeline?.legs || [];
    if (legs.length === 0) return 'walk';
    const legIndex = legIndexAt(timeline, qf);
    if (legIndex >= 0) return legTravelMode(timeline, legIndex);
    const reached = Math.max(0, reachedIndex(timeline, qf));
    // Jambe qui a mené à l'étape atteinte : la plus récente dont l'arrivée la
    // précède — `to` croît le long de la chronologie, recherche dichotomique.
    // Une nuit coupe : le trajet qui suit reprend la main.
    let lo = 0;
    let hi = legs.length - 1;
    let prev = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (legs[mid].to <= reached) {
            prev = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    if (prev >= 0 && !legs[prev].night) return legTravelMode(timeline, prev);
    // Sinon : le prochain trajet, premier non nocturne dont le départ n'est
    // pas avant l'étape atteinte — `from` croît lui aussi.
    lo = 0;
    hi = legs.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (legs[mid].from < reached) lo = mid + 1;
        else hi = mid;
    }
    for (let k = lo; k < legs.length && legs[k].night; k++) lo++;
    return lo < legs.length ? legTravelMode(timeline, lo) : 'walk';
}

// --- Barre de chronologie --------------------------------------------------------
//
// La barre (timeline_bar.js) compte en « jours » du moteur, donc ici en quanta :
// sa piste couvre `span` quanta à partir de `firstQ`. Le quantum k y est l'état
// affiché après lui (position du moteur ≈ k) — une étape est comptée au premier
// quantum entier qui atteint son arrivée, comme dans stateAt.

function isBarCounted(stop) {
    return stop.kind !== 'place' && stop.kind !== 'base';
}

// Par quantum : arrivées des étapes comptées (`events`, Labs à part dans
// `secondary`) et étapes atteintes à la fin du quantum (`level`) ; `base` :
// étapes arrivées avant `firstQ`.
export function barSeries(timeline, firstQ, span) {
    const n = Math.max(0, Math.floor(Number(span) || 0));
    const events = new Float64Array(n);
    const secondary = new Float64Array(n);
    const level = new Float64Array(n);
    let base = 0;
    for (const stop of timeline?.stops || []) {
        if (!isBarCounted(stop)) continue;
        const offset = Math.ceil(stop.q - 1e-6) - firstQ;
        if (offset < 0) base++;
        else if (offset < n) (stop.kind === 'lab' ? secondary : events)[offset]++;
    }
    let total = base;
    for (let k = 0; k < n; k++) {
        total += events[k] + secondary[k];
        level[k] = total;
    }
    return { events, secondary, level, base };
}

// Repères de la piste :
//   bands : nuits entre deux journées { from, to } (quanta de la piste) ;
//   days  : début de chaque journée { offset, day } (index dans `days`), la
//           première comprise — seulement pour plusieurs journées ;
//   hours : heures pleines d'une journée unique { offset, hour }, au premier
//           quantum où l'heure affichée l'atteint.
export function barTicks(timeline, firstQ, span) {
    const out = { bands: [], days: [], hours: [] };
    const n = Math.max(0, Math.floor(Number(span) || 0));
    const days = timeline?.days || [];
    if (!n || days.length === 0) return out;
    const inAxis = (offset) => offset >= 0 && offset < n;
    if (days.length > 1) {
        for (const leg of timeline.legs || []) {
            if (!leg.night) continue;
            const from = Math.max(0, Math.floor(leg.startQ) - firstQ);
            const to = Math.min(n, Math.ceil(leg.endQ) - firstQ);
            if (to > from) out.bands.push({ from, to });
        }
        // Une journée commence à la piste à la fin de sa nuit (arrivée à sa
        // première étape) : l'étiquette suit la bande au lieu de la couvrir.
        days.forEach((day, d) => {
            const first = timeline.stops[day.first];
            const offset = (d === 0 || !first ? 0 : Math.ceil(first.q - 1e-6)) - firstQ;
            if (inAxis(offset)) out.days.push({ offset, day: d });
        });
        return out;
    }
    let last = NaN;
    for (let k = 0; k < n; k++) {
        const state = stateAt(timeline, firstQ + k);
        const hour = Number.isFinite(state?.minutes) ? Math.floor(state.minutes / 60) : NaN;
        if (!Number.isFinite(hour)) continue;
        if (Number.isFinite(last) && hour > last) out.hours.push({ offset: k, hour });
        last = Number.isFinite(last) ? Math.max(last, hour) : hour;
    }
    return out;
}
