// Caméra de la lecture d'un parcours (MyGCFlow_Plan_Parcours.md, lot 7) :
// serrée sur le géocacheur, elle dézoome d'elle-même pour un long trajet, la
// nuit (de la fin d'une journée au début de la suivante) et à la fin (vue
// d'ensemble).
//
// La pose ne dépend que de la position du moteur (quanta fractionnaires) :
// l'aperçu et la vidéo image par image cadrent pareil, un saut retombe sur la
// même pose qu'un déroulé continu. Lissage : moyenne pondérée des cadrages
// visés sur une fenêtre de ±`smoothQ` quanta (centre en Web Mercator,
// résolution en logarithme), puis le géocacheur est gardé dans l'écran.
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_camera.test.mjs). Coordonnées en EPSG:3857.

import { headAt, legIndexAt, reachedIndex } from './parcours_timeline.mjs';

const R = 6378137;
const DEG = Math.PI / 180;
// Résolution du zoom 0 en EPSG:3857 (tuiles de 256 px).
const RESOLUTION_Z0 = (2 * Math.PI * R) / 256;

export const CAMERA_DEFAULTS = Object.freeze({
    smoothQ: 8,          // demi-fenêtre de lissage, en quanta
    paddingPx: 70,       // marge autour du cadrage visé
    minSpanM: 900,       // plus petit cadrage (mètres au sol)
    maxZoom: 16,
    headMarginPx: 40,    // le géocacheur reste à cette distance du bord
    stopNeighborKm: 2,   // à l'arrêt, les trajets voisins plus courts restent cadrés
});

const SAMPLE_Q = 0.25;

export function toMercator(lon, lat) {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    return [R * lon * DEG, R * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2))];
}

export function resolutionForZoom(zoom) {
    return RESOLUTION_Z0 / 2 ** zoom;
}

export function zoomForResolution(resolution) {
    return Math.log2(RESOLUTION_Z0 / resolution);
}

function emptyBox() {
    return [Infinity, Infinity, -Infinity, -Infinity];
}

function extend(box, [x, y]) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
    return box;
}

function validBox(box) {
    return box && Number.isFinite(box[0]) && box[2] >= box[0];
}

// Cadrages précalculés d'une chronologie (gardés par chronologie) : un par
// trajet (son chemin entier), un par étape (l'étape et le milieu des courts
// trajets de la même journée qui l'encadrent), la vue d'ensemble.
const plans = new WeakMap();

function cameraPlan(timeline) {
    let plan = plans.get(timeline);
    if (plan) return plan;
    const o = CAMERA_DEFAULTS;
    const stops = timeline.stops;
    const points = stops.map((stop) => toMercator(stop.lon, stop.lat));
    const legBoxes = timeline.legs.map((leg) => {
        const box = emptyBox();
        if (leg.path) for (const [lon, lat] of leg.path) extend(box, toMercator(lon, lat));
        extend(box, points[leg.from]);
        extend(box, points[leg.to]);
        return box;
    });
    const midpoint = (k) => {
        const leg = timeline.legs[k];
        if (leg.path && leg.path.length > 2) {
            const [lon, lat] = leg.path[Math.floor(leg.path.length / 2)];
            return toMercator(lon, lat);
        }
        const a = points[leg.from];
        const b = points[leg.to];
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    const legInto = new Map();
    const legFrom = new Map();
    timeline.legs.forEach((leg, k) => {
        legInto.set(leg.to, k);
        legFrom.set(leg.from, k);
    });
    const stopBoxes = points.map((point, i) => {
        const box = extend(emptyBox(), point);
        for (const k of [legInto.get(i), legFrom.get(i)]) {
            // Un long trajet se cadre pendant le trajet : l'étape reste serrée.
            if (k === undefined || timeline.legs[k].night || timeline.legs[k].km > o.stopNeighborKm) continue;
            extend(box, midpoint(k));
        }
        return box;
    });
    const overview = points.reduce((box, point) => extend(box, point), emptyBox());
    plan = { points, legBoxes, stopBoxes, overview };
    plans.set(timeline, plan);
    return plan;
}

// Cadrage visé à la position `qf` (sans lissage) : le trajet en cours, la
// nuit (deux journées), l'étape, la vue d'ensemble après la dernière étape.
export function cameraFocusAt(timeline, qf) {
    const stops = timeline?.stops || [];
    if (stops.length === 0) return null;
    const plan = cameraPlan(timeline);
    const legIndex = legIndexAt(timeline, qf);
    if (legIndex >= 0) return plan.legBoxes[legIndex];
    const last = stops[stops.length - 1];
    if (qf > last.departQ) return plan.overview;
    return plan.stopBoxes[Math.max(0, reachedIndex(timeline, qf))];
}

// Centre et résolution qui montrent `box` dans une vue de `size` px.
function poseForBox(box, size, o) {
    const [w, h] = size;
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    // Échelle de Mercator : un mètre au sol vaut 1/cos(lat) unités.
    const lat = (2 * Math.atan(Math.exp(cy / R)) - Math.PI / 2);
    const minSpan = o.minSpanM / Math.max(0.05, Math.cos(lat));
    const spanX = Math.max(box[2] - box[0], minSpan);
    const spanY = Math.max(box[3] - box[1], minSpan);
    const usableW = Math.max(40, w - 2 * o.paddingPx);
    const usableH = Math.max(40, h - 2 * o.paddingPx);
    const resolution = Math.max(resolutionForZoom(o.maxZoom), spanX / usableW, spanY / usableH);
    return { center: [cx, cy], resolution };
}

// Pose de la caméra à `qf` pour une vue de `size` ([largeur, hauteur] en px
// CSS) : { center: [x, y] (EPSG:3857), resolution, zoom }. null sans étape.
export function cameraPoseAt(timeline, qf, size, options = {}) {
    if (!(timeline?.stops?.length) || !Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) return null;
    const o = { ...CAMERA_DEFAULTS, ...options };
    let sumW = 0;
    let x = 0;
    let y = 0;
    let logRes = 0;
    // Échantillons tous les quarts de quantum : un cadrage qui change d'un
    // coup (arrivée d'un long trajet) ne pèse qu'un échantillon à la fois.
    const steps = Math.max(0, Math.round(o.smoothQ / SAMPLE_Q));
    for (let i = -steps; i <= steps; i++) {
        const box = cameraFocusAt(timeline, Math.max(0, qf + i * SAMPLE_Q));
        if (!validBox(box)) continue;
        const pose = poseForBox(box, size, o);
        const weight = steps + 1 - Math.abs(i);
        sumW += weight;
        x += pose.center[0] * weight;
        y += pose.center[1] * weight;
        logRes += Math.log(pose.resolution) * weight;
    }
    if (sumW === 0) return null;
    const center = [x / sumW, y / sumW];
    const resolution = Math.exp(logRes / sumW);
    // Le géocacheur reste dans l'écran : le lissage anticipe et retarde, un
    // trajet rapide le sortirait sinon du cadre.
    const head = headAt(timeline, qf);
    if (head) {
        const [hx, hy] = toMercator(head.lon, head.lat);
        const halfW = Math.max(0, size[0] / 2 - o.headMarginPx) * resolution;
        const halfH = Math.max(0, size[1] / 2 - o.headMarginPx) * resolution;
        center[0] = Math.min(hx + halfW, Math.max(hx - halfW, center[0]));
        center[1] = Math.min(hy + halfH, Math.max(hy - halfH, center[1]));
    }
    return { center, resolution, zoom: zoomForResolution(resolution) };
}

// Vue d'ensemble : toutes les étapes (cadrage de fin).
export function overviewBox(timeline) {
    if (!(timeline?.stops?.length)) return null;
    return [...cameraPlan(timeline).overview];
}
