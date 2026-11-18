// Reconstruction d'un parcours : ordre de passage et heures, journée par
// journée (MyGCFlow_Plan_Parcours.md, § 4).
//
// Les données ne disent ni l'heure ni l'ordre réels : l'heure des GPX est
// factice, et les logs sont souvent saisis en bloc, parfois dans le désordre
// (virtuelles et earthcaches loguées une fois les réponses envoyées). On
// combine donc tous les indices, du plus sûr au plus faible :
//
// 1. ANCRES : étapes à heure sûre (heure de validation des Labs, heure
//    épinglée par l'utilisateur). Elles forment l'ossature, dans l'ordre
//    chronologique, et calent l'horaire.
// 2. ORDRE DES LOGS : `logId` croît avec l'ordre de SAISIE. Les types
//    « logables plus tard » sont mis de côté, puis les INTRUS (une étape
//    qu'il est nettement plus court de visiter ailleurs : log tardif, quel
//    que soit son type). L'ordre restant n'est retenu que s'il dessine un
//    chemin à peine plus long que le meilleur chemin géographique — sinon la
//    saisie ne suivait pas le passage.
// 3. GÉOGRAPHIE : plus court chemin (plus proche voisin + 2-opt de
//    travel_trail.mjs) quand rien d'autre ne tient, et insertion au moindre
//    détour de toutes les étapes mises de côté.
//
// Puis l'HORAIRE : début de journée, durée de visite par type, durée de
// trajet par distance (à pied ou en voiture) ; entre deux ancres, les durées
// estimées sont étirées ou comprimées pour tomber juste.
//
// Chaque étape garde sa CONFIANCE (`anchored`, `logged`, `geo`) et la raison
// de sa place (`reason`), affichées dans l'onglet Données et, plus tard,
// dans l'animation (« ≈ 10:40 »).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_reconstruct.test.mjs). Seuils calibrés par
// tools/parcours_bench.mjs (mesures dans docs/parcours.md).

import { groundDistanceKm, orderStops, timeOfDaySeconds } from './travel_trail.mjs';

export const CONFIDENCE_ANCHORED = 'anchored';
export const CONFIDENCE_LOGGED = 'logged';
export const CONFIDENCE_GEO = 'geo';
// Ordre fixé par l'utilisateur, heure estimée (lot 3).
export const CONFIDENCE_MANUAL = 'manual';

// Étapes posées par l'utilisateur (lot 3) : un lieu est une étape de plus,
// une base le départ et le retour de la journée. Ni l'un ni l'autre n'est
// compté parmi les étapes du parcours (numérotation, {etapes}).
export const KIND_PLACE = 'place';
export const KIND_BASE = 'base';
const UNCOUNTED_KINDS = new Set([KIND_PLACE, KIND_BASE]);
export function isCountedStop(stop) {
    return !UNCOUNTED_KINDS.has(stop?.kind);
}

// Raisons de la place d'une étape (codes, traduits par l'appelant).
export const REASON_TIME = 'time';            // heure sûre (Lab, épinglée)
export const REASON_LOG_ORDER = 'log-order';  // ordre de saisie des logs, retenu
export const REASON_LATE_TYPE = 'late-type';  // type souvent logué après coup
export const REASON_INTRUDER = 'intruder';    // log manifestement tardif
export const REASON_GEO = 'geo';              // ordre géographique (logs écartés ou absents)
export const REASON_INSERTED = 'inserted';    // sans indice : insérée au moindre détour
export const REASON_PINNED = 'pinned';        // heure épinglée par l'utilisateur
export const REASON_MANUAL = 'manual';        // ordre fixé par l'utilisateur
export const REASON_BASE = 'base';            // départ ou retour à la base
export const REASON_PHOTO = 'photo';          // heure d'une photo rattachée (lot 4)
export const REASON_TRACK = 'track';          // heure de passage d'une trace GPS (lot 5)

// Verdict sur l'ordre des logs d'une journée.
export const LOG_ORDER_TRUSTED = 'trusted';
export const LOG_ORDER_REJECTED = 'rejected';
export const LOG_ORDER_NONE = 'none';         // moins de deux étapes à log

export const RECONSTRUCT_DEFAULTS = Object.freeze({
    // Fenêtre de journée (minutes depuis minuit) quand aucune ancre ne la fixe.
    dayStartMin: 9 * 60,
    dayEndMin: 22 * 60,
    earliestMin: 5 * 60,
    // Types dont le log suit souvent la visite de plusieurs heures ou jours.
    lateTypes: Object.freeze(['Virtual Cache', 'Earthcache', 'Webcam Cache', 'Locationless (Reverse) Cache']),
    // Ordre des logs retenu si son chemin ≤ trustRatio × le meilleur chemin
    // géographique, ou s'il ne le dépasse que de trustSlackKm (petits nuages).
    trustRatio: 1.3,
    trustSlackKm: 0.3,
    // Intrus : déplacer l'étape économise plus que max(minKm, part du chemin) ;
    // au plus maxShare des étapes à log.
    intruderMinKm: 0.5,
    intruderFraction: 0.15,
    intruderMaxShare: 0.2,
    // Trajets : à pied jusqu'à walkMaxKm, en voiture au-delà.
    walkMaxKm: 1.5,
    walkKmh: 4.5,
    walkDetour: 1.25,
    carKmh: 50,
    carFastKmh: 80,
    carFastFromKm: 30,
    carDetour: 1.3,
    parkMin: 5,
    // Vélo (mode imposé par l'utilisateur, lot 6).
    bikeKmh: 15,
    bikeDetour: 1.2,
    // Durée de visite par type (minutes).
    visitMin: Object.freeze({
        'Traditional Cache': 10,
        'Multi-cache': 40,
        'Unknown Cache': 15,
        'Letterbox Hybrid': 20,
        'Wherigo Cache': 45,
        'Virtual Cache': 10,
        Earthcache: 20,
        'Webcam Cache': 5,
        'Event Cache': 90,
        'Mega-Event Cache': 180,
        'Giga-Event Cache': 240,
        'Cache In Trash Out Event': 120,
        'Community Celebration Event': 90,
        'Geocaching HQ Block Party': 120,
        'GPS Adventures Exhibit': 60,
        'Locationless (Reverse) Cache': 5,
        // Les étapes d'une aventure se valident en rafales (banc : écart
        // médian de 12 s entre deux étapes au même endroit).
        'Lab Cache': 1,
    }),
    defaultVisitMin: 15,
    dnfVisitMin: 15,
    placeVisitMin: 30,
});

// Au-delà, ni recherche d'intrus (cubique) ni 2-opt : journées « power
// trail », ordre géographique simple.
export const FULL_ANALYSIS_MAX_STOPS = 300;

const EPS = 1e-9;

function options(raw) {
    return { ...RECONSTRUCT_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function point(stop) {
    return [stop.lon, stop.lat];
}

function isValidStop(stop) {
    return stop && typeof stop.key === 'string' && stop.key !== ''
        && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)
        && stop.lon >= -180 && stop.lon <= 180 && stop.lat >= -90 && stop.lat <= 90;
}

// Heure locale « HH:MM[:SS] » → minutes depuis minuit, null sinon.
export function timeToMinutes(value) {
    const seconds = timeOfDaySeconds(value);
    return seconds === null ? null : seconds / 60;
}

// Minutes depuis minuit → « HH:MM » (arrondi à la minute, borné à la journée).
export function minutesToTime(minutes) {
    if (!Number.isFinite(minutes)) return '';
    const total = Math.min(24 * 60 - 1, Math.max(0, Math.round(minutes)));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function visitMinutes(stop, opts = RECONSTRUCT_DEFAULTS) {
    if (stop.kind === 'dnf') return opts.dnfVisitMin;
    if (stop.kind === KIND_BASE) return 0;
    if (stop.kind === KIND_PLACE) return opts.placeVisitMin;
    const value = opts.visitMin[stop.type];
    return Number.isFinite(value) ? value : opts.defaultVisitMin;
}

// Trajet estimé pour une distance à vol d'oiseau : { km, mode, minutes }.
// `mode` (lot 6) : mode imposé ('walk', 'bike', 'car') ; sinon à pied
// jusqu'à walkMaxKm, en voiture au-delà.
export function legForKm(km, opts = RECONSTRUCT_DEFAULTS, mode = null) {
    if (mode === 'bike') {
        return { km, mode: 'bike', minutes: (km * opts.bikeDetour / opts.bikeKmh) * 60 };
    }
    if (mode === 'walk' || (mode !== 'car' && km <= opts.walkMaxKm)) {
        return { km, mode: 'walk', minutes: (km * opts.walkDetour / opts.walkKmh) * 60 };
    }
    const speed = km >= opts.carFastFromKm ? opts.carFastKmh : opts.carKmh;
    return { km, mode: 'car', minutes: opts.parkMin + (km * opts.carDetour / speed) * 60 };
}

// Trajet estimé entre deux points [lon, lat].
export function legEstimate(a, b, opts = RECONSTRUCT_DEFAULTS) {
    return legForKm(groundDistanceKm(a, b), opts);
}

// --- Chemins ------------------------------------------------------------------

function makeDistance(stops) {
    const n = stops.length;
    if (n <= FULL_ANALYSIS_MAX_STOPS) {
        const matrix = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const d = groundDistanceKm(point(stops[i]), point(stops[j]));
                matrix[i * n + j] = d;
                matrix[j * n + i] = d;
            }
        }
        return (a, b) => matrix[a * n + b];
    }
    return (a, b) => groundDistanceKm(point(stops[a]), point(stops[b]));
}

export function pathLength(order, dist) {
    let total = 0;
    for (let k = 1; k < order.length; k++) total += dist(order[k - 1], order[k]);
    return total;
}

// Meilleur chemin ouvert (heuristique) sur un sous-ensemble d'étapes :
// plus proche voisin depuis une extrémité du nuage, puis 2-opt (orderStops).
function geoOrder(indices, stops) {
    if (indices.length <= 2) return [...indices];
    const local = orderStops(indices.map((i) => point(stops[i])), null);
    return local.map((k) => indices[k]);
}

// Surcoût d'une insertion de `u` avant path[k] (k = path.length : à la fin).
function insertionCost(path, u, k, dist) {
    if (path.length === 0) return 0;
    if (k === 0) return dist(u, path[0]);
    if (k === path.length) return dist(path[k - 1], u);
    return dist(path[k - 1], u) + dist(u, path[k]) - dist(path[k - 1], path[k]);
}

function bestInsertion(path, u, dist, minK = 0) {
    let bestK = minK;
    let bestCost = Infinity;
    for (let k = minK; k <= path.length; k++) {
        const cost = insertionCost(path, u, k, dist);
        if (cost < bestCost - EPS) {
            bestK = k;
            bestCost = cost;
        }
    }
    return [bestK, bestCost];
}

// Insertion la moins coûteuse d'abord (une chaîne d'étapes libres s'enfile
// de proche en proche), sans jamais réordonner le chemin existant. Coût = le
// détour en MINUTES de trajet (à pied ou en voiture, legForKm).
//
// Une variante qui pénalisait aussi le dépassement du temps disponible entre
// deux ancres a été mesurée sur un historique réel (tools/parcours_bench.mjs,
// heures Lab masquées) : toujours moins bonne que le détour seul, même avec
// les bornes de la journée en ancres virtuelles — retirée (docs/parcours.md).
function insertCheapestFirst(path, free, dist, opts) {
    const leg = (a, b) => legForKm(dist(a, b), opts).minutes;
    const remaining = [...free];
    while (remaining.length > 0) {
        const m = path.length;
        let pick = 0;
        let pickK = 0;
        let pickCost = Infinity;
        for (let r = 0; r < remaining.length; r++) {
            const u = remaining[r];
            for (let k = 0; k <= m; k++) {
                const prev = k > 0 ? path[k - 1] : -1;
                const next = k < m ? path[k] : -1;
                let cost = 0;
                if (prev >= 0) cost += leg(prev, u);
                if (next >= 0) cost += leg(u, next);
                if (prev >= 0 && next >= 0) cost -= leg(prev, next);
                if (cost < pickCost - EPS) {
                    pick = r;
                    pickK = k;
                    pickCost = cost;
                }
            }
        }
        path.splice(pickK, 0, remaining[pick]);
        remaining.splice(pick, 1);
    }
    return path;
}

// Retire de `chain` les intrus : à chaque tour, l'étape qu'il est le plus
// avantageux de visiter ailleurs dans la chaîne, tant que l'économie dépasse
// le seuil. Retourne les étapes retirées (chaîne modifiée en place).
function extractIntruders(chain, dist, opts) {
    const removed = [];
    const maxMoves = Math.floor(chain.length * opts.intruderMaxShare);
    while (removed.length < maxMoves && chain.length >= 3) {
        const threshold = Math.max(opts.intruderMinKm, opts.intruderFraction * pathLength(chain, dist));
        let bestPos = -1;
        let bestSaving = threshold;
        for (let p = 0; p < chain.length; p++) {
            const u = chain[p];
            const prev = p > 0 ? chain[p - 1] : -1;
            const next = p < chain.length - 1 ? chain[p + 1] : -1;
            let gain;
            if (prev < 0) gain = dist(u, next);
            else if (next < 0) gain = dist(prev, u);
            else gain = dist(prev, u) + dist(u, next) - dist(prev, next);
            const rest = chain.filter((_, q) => q !== p);
            const [, cost] = bestInsertion(rest, u, dist);
            const saving = gain - cost;
            if (saving > bestSaving + EPS) {
                bestSaving = saving;
                bestPos = p;
            }
        }
        if (bestPos < 0) break;
        removed.push(chain[bestPos]);
        chain.splice(bestPos, 1);
    }
    return removed;
}

// --- Une journée --------------------------------------------------------------

// Ordre de passage d'une journée. `stops` : étapes valides de la journée ;
// `anchorMin[i]` : heure sûre (minutes) ou null ; `prevEnd` : [lon, lat] de
// la dernière étape de la veille (oriente l'ordre géographique), ou null.
// Retourne { order, reasons, confidence, diagnostics }.
function orderDay(stops, anchorMin, prevEnd, opts) {
    const n = stops.length;
    const dist = makeDistance(stops);
    const reasons = new Array(n).fill(REASON_INSERTED);
    const confidence = new Array(n).fill(CONFIDENCE_GEO);
    const late = new Set(opts.lateTypes);
    const diagnostics = {
        logOrder: LOG_ORDER_NONE, logRatio: null, lateTypes: 0, intruders: 0, anchors: 0,
    };

    const anchors = [];
    const logged = [];
    const free = [];
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(anchorMin[i])) {
            anchors.push(i);
            reasons[i] = REASON_TIME;
            confidence[i] = CONFIDENCE_ANCHORED;
        } else if (Number.isFinite(stops[i].logId)) {
            if (late.has(stops[i].type)) {
                free.push(i);
                reasons[i] = REASON_LATE_TYPE;
                diagnostics.lateTypes++;
            } else {
                logged.push(i);
            }
        } else {
            free.push(i);
        }
    }
    anchors.sort((a, b) => anchorMin[a] - anchorMin[b] || a - b);
    diagnostics.anchors = anchors.length;
    logged.sort((a, b) => stops[a].logId - stops[b].logId || a - b);

    // Ordre des logs : intrus, puis verdict géométrique.
    let chain = [...logged];
    let trusted = false;
    if (chain.length >= 2) {
        if (n <= FULL_ANALYSIS_MAX_STOPS) {
            for (const u of extractIntruders(chain, dist, opts)) {
                free.push(u);
                reasons[u] = REASON_INTRUDER;
                diagnostics.intruders++;
            }
        }
        const logLen = pathLength(chain, dist);
        const geoLen = pathLength(geoOrder(chain, stops), dist);
        diagnostics.logRatio = geoLen > EPS ? logLen / geoLen : 1;
        trusted = logLen <= opts.trustRatio * geoLen + EPS || logLen - geoLen <= opts.trustSlackKm;
        diagnostics.logOrder = trusted ? LOG_ORDER_TRUSTED : LOG_ORDER_REJECTED;
    } else if (chain.length === 1) {
        free.push(chain[0]);
        chain = [];
    }

    if (!trusted && diagnostics.intruders > 0) {
        // Ordre des logs écarté : « log tardif » n'a plus de sens.
        for (let i = 0; i < n; i++) if (reasons[i] === REASON_INTRUDER) reasons[i] = REASON_GEO;
        diagnostics.intruders = 0;
    }

    let path;
    if (trusted) {
        for (const u of chain) {
            reasons[u] = REASON_LOG_ORDER;
            confidence[u] = CONFIDENCE_LOGGED;
        }
        // Ancres dans l'ordre chronologique, chacune après la précédente,
        // au moindre détour : l'ordre des logs et celui des heures tiennent
        // tous les deux.
        path = [...chain];
        let minK = 0;
        for (const a of anchors) {
            const [k] = bestInsertion(path, a, dist, minK);
            path.splice(k, 0, a);
            minK = k + 1;
        }
    } else if (anchors.length >= 2) {
        for (const u of chain) reasons[u] = REASON_GEO;
        free.push(...chain);
        path = [...anchors];
    } else {
        // Ni logs fiables ni deux ancres : ordre géographique de toute la
        // journée (une ancre seule ne contraint pas l'ordre), orienté depuis
        // la veille.
        for (const u of chain) reasons[u] = REASON_GEO;
        path = geoOrder(stops.map((_, i) => i), stops);
        if (prevEnd && path.length > 1) {
            const dFirst = groundDistanceKm(prevEnd, point(stops[path[0]]));
            const dLast = groundDistanceKm(prevEnd, point(stops[path[path.length - 1]]));
            if (dLast < dFirst - EPS) path.reverse();
        }
        for (const i of path) if (reasons[i] === REASON_INSERTED) reasons[i] = REASON_GEO;
        return { order: path, reasons, confidence, diagnostics };
    }

    const inPath = new Set(path);
    insertCheapestFirst(path, free.filter((i) => !inPath.has(i)), dist, opts);
    return { order: path, reasons, confidence, diagnostics };
}

// Heures d'arrivée (minutes depuis minuit) le long de `order`. `scale[k]`
// s'applique au pas k (visite de k + trajet vers k + 1) : 1 = durées
// estimées, < 1 = journée comprimée, > 1 = étirée entre deux ancres. Les
// durées de visite rendues sont les durées mises à l'échelle.
// Trajets : itinéraire calculé (`legHints`, « from>to » → { minutes, km,
// mode }, lot 6) s'il y en a un, sinon estimation, au mode imposé par
// l'étape de départ (`overrides`, legMode) le cas échéant.
function scheduleDay(stops, order, anchorMin, opts, { overrides = null, legHints = null } = {}) {
    const m = order.length;
    // Durée de visite imposée (lot « durée réglable ») ou estimée du type.
    const visit = order.map((i) => {
        const forced = overrides?.get?.(stops[i].key)?.visitMin;
        return Number.isFinite(forced) && forced >= 0 ? Math.min(forced, 12 * 60) : visitMinutes(stops[i], opts);
    });
    const legs = [];
    const travel = [0];
    for (let k = 1; k < m; k++) {
        const from = stops[order[k - 1]];
        const to = stops[order[k]];
        const hint = legHints?.get?.(`${from.key}>${to.key}`);
        const forced = overrides?.get?.(from.key)?.legMode;
        const leg = hint && Number.isFinite(hint.minutes)
            ? { km: hint.km, mode: hint.mode, minutes: hint.minutes, routed: true }
            : legForKm(groundDistanceKm(point(from), point(to)), opts, forced === 'straight' ? null : forced);
        legs.push({ from: from.key, to: to.key, ...leg });
        travel.push(leg.minutes);
    }
    // Durée estimée de l'arrivée en k à l'arrivée en k + 1 ; la dernière
    // étape n'a que sa visite.
    const step = (k) => visit[k] + (k + 1 < m ? travel[k + 1] : 0);
    const sumSteps = (from, to) => {
        let total = 0;
        for (let k = from; k < to; k++) total += step(k);
        return total;
    };
    const scale = new Array(m).fill(1);
    const setScale = (from, to, value) => {
        for (let k = from; k < to; k++) scale[k] = value;
    };
    const anchorPos = [];
    for (let k = 0; k < m; k++) if (Number.isFinite(anchorMin[order[k]])) anchorPos.push(k);
    let compressed = false;

    // Fin de journée dépassée après `from` (arrivée `at`) : on comprime, sauf
    // si le segment commence lui-même au-delà.
    const fitTail = (from, at) => {
        const est = sumSteps(from, m);
        if (est > 0 && at + est > opts.dayEndMin && at < opts.dayEndMin) {
            setScale(from, m, (opts.dayEndMin - at) / est);
            compressed = true;
        }
    };

    const arrival = new Array(m).fill(0);
    let pivot = 0;
    if (anchorPos.length === 0) {
        arrival[0] = opts.dayStartMin;
        fitTail(0, opts.dayStartMin);
    } else {
        pivot = anchorPos[0];
        const t0 = anchorMin[order[pivot]];
        arrival[pivot] = t0;
        // Avant la première ancre : à rebours, borné au petit matin.
        const before = sumSteps(0, pivot);
        if (before > 0 && t0 - before < opts.earliestMin) {
            setScale(0, pivot, Math.max(0, t0 - opts.earliestMin) / before);
            compressed = true;
        }
        // Entre deux ancres : durées mises à l'échelle pour tomber juste.
        for (let a = 0; a + 1 < anchorPos.length; a++) {
            const p = anchorPos[a];
            const q = anchorPos[a + 1];
            const span = sumSteps(p, q);
            setScale(p, q, span > 0 ? Math.max(0, anchorMin[order[q]] - anchorMin[order[p]]) / span : 0);
        }
        const last = anchorPos[anchorPos.length - 1];
        fitTail(last, anchorMin[order[last]]);
    }
    for (let k = pivot - 1; k >= 0; k--) arrival[k] = arrival[k + 1] - step(k) * scale[k];
    for (let k = pivot + 1; k < m; k++) arrival[k] = arrival[k - 1] + step(k - 1) * scale[k - 1];
    // Les ancres tombent juste par construction ; on les pose exactement
    // (pas d'erreur d'arrondi cumulée).
    for (const k of anchorPos) arrival[k] = anchorMin[order[k]];
    return { arrival, visit: visit.map((v, k) => v * scale[k]), legs, compressed };
}

// Rang manuel (lot 3) : les étapes classées par l'utilisateur gardent son
// ordre ; les autres s'y insèrent au moindre détour. L'ordre manuel prime
// sur tout, y compris sur l'heure des ancres (l'horaire s'en accommode).
function applyManualRanks(stops, order, ranks, reasons, confidence, anchorMin, opts) {
    const ranked = order.filter((i) => Number.isFinite(ranks[i]))
        .sort((a, b) => ranks[a] - ranks[b] || a - b);
    if (ranked.length === 0) return order;
    for (const i of ranked) {
        if (Number.isFinite(anchorMin[i])) continue;
        reasons[i] = REASON_MANUAL;
        confidence[i] = CONFIDENCE_MANUAL;
    }
    const rankedSet = new Set(ranked);
    return insertCheapestFirst([...ranked], order.filter((i) => !rankedSet.has(i)), makeDistance(stops), opts);
}

// Reconstruit une journée : `day` = { date, stops } des entrées
// (parcours_dataset.py). Options :
//   overrides : Map clé → { rank?, pinnedTime? } (ajustements, lot 3) ;
//   prevEnd   : [lon, lat] de la dernière étape de la veille, ou null ;
//   baseStart/baseEnd : { key, name, lon, lat } — départ et retour de la
//                  journée (rôles « start »/« end » des bases ; une base
//                  « both » sert les deux, une seule extrémité possible) ;
//   trackAnchors : Map clé → minutes, heure de passage des traces GPS (lot 5,
//                  parcours_tracks.mjs) — après l'heure épinglée et celle
//                  des Labs ;
//   photoAnchors : Map clé → minutes, heure des photos rattachées (lot 4,
//                  parcours_photos.mjs) — en dernier.
//   legHints : Map « from>to » → { minutes, km, mode }, itinéraires calculés
//              (lot 6, parcours_routing.mjs).
export function reconstructDay(day, {
    overrides = null, prevEnd = null, baseStart = null, baseEnd = null,
    trackAnchors = null, photoAnchors = null, legHints = null,
    options: raw = null,
} = {}) {
    const opts = options(raw);
    const rawStops = Array.isArray(day?.stops) ? day.stops : [];
    const stops = rawStops.filter(isValidStop);
    const result = {
        date: day?.date,
        stops: [],
        legs: [],
        excluded: Array.isArray(day?.excluded) ? day.excluded : [],
        manual: false,
        dropped: rawStops.length - stops.length,
        diagnostics: { logOrder: LOG_ORDER_NONE, logRatio: null, lateTypes: 0, intruders: 0, anchors: 0, compressed: false, clockBacktrack: false },
    };
    if (stops.length === 0) return result;

    const pinned = stops.map((stop) => timeToMinutes(overrides?.get?.(stop.key)?.pinnedTime));
    const anchorOf = (map) => stops.map((stop) => {
        const value = map?.get?.(stop.key);
        return Number.isFinite(value) ? value : null;
    });
    const fromTrack = anchorOf(trackAnchors);
    const fromPhoto = anchorOf(photoAnchors);
    const anchorMin = stops.map((stop, i) => {
        const value = pinned[i] ?? timeToMinutes(stop.localTime) ?? fromTrack[i] ?? fromPhoto[i];
        return Number.isFinite(value) ? value : null;
    });
    const ranks = stops.map((stop) => {
        const rank = overrides?.get?.(stop.key)?.rank;
        return Number.isFinite(rank) ? rank : null;
    });
    const hasStart = !!baseStart && Number.isFinite(baseStart.lon) && Number.isFinite(baseStart.lat);
    const hasEnd = !!baseEnd && Number.isFinite(baseEnd.lon) && Number.isFinite(baseEnd.lat);
    const start = hasStart ? [baseStart.lon, baseStart.lat] : prevEnd;
    const ordered = orderDay(stops, anchorMin, start, opts);
    const { reasons, confidence, diagnostics } = ordered;
    for (let i = 0; i < stops.length; i++) {
        // Heure épinglée, ou lieu posé à son heure : un choix de l'utilisateur.
        if (Number.isFinite(pinned[i]) || (stops[i].kind === KIND_PLACE && timeToMinutes(stops[i].localTime) !== null)) {
            reasons[i] = REASON_PINNED;
        } else if (timeToMinutes(stops[i].localTime) === null && Number.isFinite(fromTrack[i])) {
            reasons[i] = REASON_TRACK;
        } else if (timeToMinutes(stops[i].localTime) === null && Number.isFinite(fromPhoto[i])) {
            reasons[i] = REASON_PHOTO;
        }
    }
    let order = applyManualRanks(stops, ordered.order, ranks, reasons, confidence, anchorMin, opts);
    result.manual = order !== ordered.order;

    // Bases : départ et retour de la journée, aux deux bouts du chemin — deux
    // bases distinctes possibles (rôles « start »/« end »). Clé propre à la
    // journée : une même base sert plusieurs jours.
    let all = stops;
    const baseStop = (base, suffix) => ({
        key: `${base.key}:${day.date}:${suffix}`, kind: KIND_BASE, type: 'Base', name: base.name || '', code: null,
        lon: base.lon, lat: base.lat, logId: null, localTime: null, placeId: base.id ?? null,
    });
    const pushBase = () => {
        anchorMin.push(null);
        reasons.push(REASON_BASE);
        confidence.push(CONFIDENCE_MANUAL);
    };
    if (hasStart) {
        all = [...all, baseStop(baseStart, 'start')];
        pushBase();
        order = [all.length - 1, ...order];
    }
    if (hasEnd) {
        all = [...all, baseStop(baseEnd, 'end')];
        pushBase();
        order = [...order, all.length - 1];
    }
    const { arrival, visit, legs, compressed } = scheduleDay(all, order, anchorMin, opts, { overrides, legHints });
    // Ordre contraire aux heures sûres (manuel, ou ancres en contradiction) :
    // l'horloge affichée recule au passage d'une ancre à l'autre.
    let clockBacktrack = false;
    for (let k = 1; k < arrival.length; k++) {
        if (arrival[k] < arrival[k - 1] - 1e-6) { clockBacktrack = true; break; }
    }
    result.stops = order.map((i, k) => ({
        ...all[i],
        order: k + 1,
        arrivalMin: arrival[k],
        visitMin: visit[k],
        confidence: confidence[i],
        reason: reasons[i],
    }));
    result.legs = legs;
    result.diagnostics = { ...diagnostics, compressed, clockBacktrack };
    return result;
}

// Ajustements du lot 3 appliqués aux entrées, avant la reconstruction :
// étapes déplacées vers une autre journée (`day`), exclues (`excluded`),
// lieux posés ajoutés à leur journée. Retourne { days, overrides, bases }.
export function applyAdjustments(inputs) {
    const overrides = new Map();
    for (const o of Array.isArray(inputs?.overrides) ? inputs.overrides : []) {
        if (o && typeof o.key === 'string') overrides.set(o.key, o);
    }
    const rawDays = Array.isArray(inputs?.days) ? inputs.days : [];
    const days = rawDays.map((day) => ({ date: day?.date, stops: [], excluded: [] }));
    const byDate = new Map(days.map((day) => [day.date, day]));
    rawDays.forEach((rawDay, d) => {
        for (const stop of Array.isArray(rawDay?.stops) ? rawDay.stops : []) {
            const o = overrides.get(stop.key);
            const target = (o?.day && byDate.get(o.day)) || days[d];
            const moved = target !== days[d] ? { ...stop, movedFrom: rawDay.date } : stop;
            (o?.excluded ? target.excluded : target.stops).push(moved);
        }
    });
    // Bases par rôle : `both` sert départ et retour, `start`/`end` une seule
    // extrémité — partir d'un hôtel, dormir ailleurs. Une portée (datée ou
    // toutes journées) garde au plus une base par rôle : la dernière posée.
    const bases = { all: {}, byDate: new Map() };
    for (const place of Array.isArray(inputs?.places) ? inputs.places : []) {
        if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
        const key = `place:${place.id}`;
        if (place.kind === KIND_BASE) {
            const base = { key, id: place.id, name: place.name, lon: place.lon, lat: place.lat };
            const role = (place.role === 'start' || place.role === 'end') ? place.role : 'both';
            if (place.date) {
                const scope = bases.byDate.get(place.date) || {};
                scope[role] = base;
                bases.byDate.set(place.date, scope);
            } else {
                bases.all[role] = base;
            }
        } else if (place.kind === KIND_PLACE && byDate.has(place.date)) {
            byDate.get(place.date).stops.push({
                key, kind: KIND_PLACE, type: 'Place', name: place.name || '', code: null,
                lon: place.lon, lat: place.lat, logId: null, localTime: place.time || null, placeId: place.id,
            });
        }
    }
    return { days, overrides, bases };
}

// Reconstruit tout le parcours, jours dans l'ordre des dates : la dernière
// étape d'une journée oriente la suivante. Les ajustements du lot 3
// (`inputs.overrides`, `inputs.places`) sont appliqués. Numérotation globale
// `index` des étapes comptées (pas des lieux ni des bases).
export function reconstructParcours(inputs, {
    options: raw = null, trackAnchors = null, photoAnchors = null, legHints = null,
} = {}) {
    const { days: adjusted, overrides, bases } = applyAdjustments(inputs);
    adjusted.sort((a, b) => (String(a?.date) < String(b?.date) ? -1 : String(a?.date) > String(b?.date) ? 1 : 0));
    const days = [];
    let prevEnd = null;
    let index = 0;
    let dropped = 0;
    for (const rawDay of adjusted) {
        // Une base ne sert que les journées qui ont des étapes. Pour chaque
        // extrémité : la base datée prime (rôle précis puis « both »), sinon
        // celle de toutes les journées.
        const scope = bases.byDate.get(rawDay.date);
        const hasStops = rawDay.stops.length > 0;
        const baseStart = hasStops
            && (scope?.start || scope?.both || bases.all.start || bases.all.both || null);
        const baseEnd = hasStops
            && (scope?.end || scope?.both || bases.all.end || bases.all.both || null);
        const day = reconstructDay(rawDay, { overrides, prevEnd, baseStart, baseEnd, trackAnchors, photoAnchors, legHints, options: raw });
        for (const stop of day.stops) stop.index = isCountedStop(stop) ? ++index : null;
        dropped += day.dropped;
        if (day.stops.length > 0) {
            const last = day.stops[day.stops.length - 1];
            prevEnd = [last.lon, last.lat];
        }
        days.push(day);
    }
    return { days, stopCount: index, dropped };
}
