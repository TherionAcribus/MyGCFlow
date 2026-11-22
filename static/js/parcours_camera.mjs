// Caméra de la lecture d'un parcours (MyGCFlow_Plan_Parcours.md, lot 7) :
// elle suit le géocacheur le long de son chemin, dézoome d'elle-même pour un
// long trajet, la nuit (de la fin d'une journée au début de la suivante) et à
// la fin (vue d'ensemble).
//
// La pose ne dépend que de la position du moteur (quanta fractionnaires) :
// l'aperçu et la vidéo image par image cadrent pareil, un saut retombe sur la
// même pose qu'un déroulé continu. Elle est lue dans deux pistes précalculées
// une fois par chronologie et par taille de vue (docs/parcours.md) :
// - centre : la position du géocacheur, lissée (gaussienne), avec un peu
//   d'avance dans le sens de la marche — il ne part pas avant lui ;
// - zoom : de quoi montrer ce qu'il vient de parcourir et ce qu'il va
//   parcourir, maximum tenu sur une fenêtre (pas de respiration d'une cache à
//   l'autre), vitesse bornée puis lissage.
// Le géocacheur est enfin gardé dans l'écran (filet de sécurité).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_camera.test.mjs). Coordonnées en EPSG:3857.

import { QUANTUM_MS, headAt } from './parcours_timeline.mjs';

const R = 6378137;
const DEG = Math.PI / 180;
// Résolution du zoom 0 en EPSG:3857 (tuiles de 256 px).
const RESOLUTION_Z0 = (2 * Math.PI * R) / 256;

export const CAMERA_DEFAULTS = Object.freeze({
    centerSigmaQ: 4,     // lissage du centre (écart type, en quanta)
    leadQ: 3,            // avance dans le sens de la marche (quanta de déplacement)…
    leadShare: 0.3,      // …au plus cette part du demi-écran
    lookBackQ: 4,        // le cadre garde ce qui vient d'être parcouru…
    lookAheadQ: 8,       // …et montre ce qui va l'être
    safeShare: 0.7,      // ce cadre tient dans cette part du demi-écran
    overviewShare: 0.85, // la vue d'ensemble finale, dans celle-ci
    holdBackQ: 15,       // un dézoom est tenu ce temps avant de rezoomer…
    holdAheadQ: 2,       // …et anticipé de si peu
    maxZoomPerQ: 0.25,   // vitesse de zoom maximale (niveaux par quantum : 2,5 par seconde)
    zoomSigmaQ: 4,       // lissage du zoom
    minSpanM: 900,       // plus petit cadrage (mètres au sol)
    maxZoom: 16,
    headMarginPx: 40,    // le géocacheur reste à cette distance du bord
    frame: 1,            // multiplicateur de l'emprise visée (cadrage serré/large)
});

const SAMPLE_Q = 0.5;
const MAX_TRACKS = 4;

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

function clampIndex(i, n) {
    return i < 0 ? 0 : i >= n ? n - 1 : i;
}

// Lissage gaussien (bords prolongés) d'un signal échantillonné.
function gaussian(values, sigma) {
    const n = values.length;
    if (!(sigma > 0)) return Float64Array.from(values);
    const radius = Math.ceil(3 * sigma);
    const weights = [];
    let total = 0;
    for (let k = -radius; k <= radius; k++) {
        const w = Math.exp(-(k * k) / (2 * sigma * sigma));
        weights.push(w);
        total += w;
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += weights[k + radius] * values[clampIndex(i + k, n)];
        out[i] = sum / total;
    }
    return out;
}

// Maximum glissant sur [i - back, i + ahead] échantillons.
function dilate(values, back, ahead) {
    const n = values.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let max = -Infinity;
        for (let k = Math.max(0, i - back); k <= Math.min(n - 1, i + ahead); k++) {
            if (values[k] > max) max = values[k];
        }
        out[i] = max;
    }
    return out;
}

// Vitesse bornée, en ne faisant que monter le signal (dézoomer) : la passe
// avant ralentit les zooms, la passe arrière avance les dézooms.
function limitRate(values, step) {
    const out = Float64Array.from(values);
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] - step);
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.max(out[i], out[i + 1] - step);
    return out;
}

// Vue d'ensemble : toutes les étapes, en EPSG:3857.
function overviewOf(timeline) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const stop of timeline.stops) {
        const [x, y] = toMercator(stop.lon, stop.lat);
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
    }
    return box;
}

// Pistes de la caméra pour une vue de `size` px : centre (x, y) et
// logarithme de la résolution, tous les SAMPLE_Q quanta.
function buildTrack(timeline, size, o) {
    const [w, h] = size;
    const stops = timeline.stops;
    const lastDepart = stops[stops.length - 1].departQ;
    const n = Math.max(2, Math.ceil(Math.max(timeline.quanta || 0, lastDepart) / SAMPLE_Q) + 2);
    const perSample = (q) => q / SAMPLE_Q;

    // Ce que la caméra vise à chaque échantillon : le géocacheur, puis la vue
    // d'ensemble (son centre, et une demi-étendue ramenée à safeShare).
    const frame = Math.max(0.2, Math.min(5, Number(o.frame) || 1));
    const overview = overviewOf(timeline);
    const ocx = (overview[0] + overview[2]) / 2;
    const ocy = (overview[1] + overview[3]) / 2;
    const ohx = ((overview[2] - overview[0]) / 2) * (o.safeShare / o.overviewShare);
    const ohy = ((overview[3] - overview[1]) / 2) * (o.safeShare / o.overviewShare);
    const tx = new Float64Array(n);
    const ty = new Float64Array(n);
    const ex = new Float64Array(n);
    const ey = new Float64Array(n);
    const minLog = new Float64Array(n);
    const floor = resolutionForZoom(o.maxZoom);
    for (let i = 0; i < n; i++) {
        const q = i * SAMPLE_Q;
        let lat;
        if (q > lastDepart) {
            tx[i] = ocx;
            ty[i] = ocy;
            ex[i] = ohx;
            ey[i] = ohy;
            lat = 2 * Math.atan(Math.exp(ocy / R)) - Math.PI / 2;
        } else {
            const head = headAt(timeline, q);
            [tx[i], ty[i]] = toMercator(head.lon, head.lat);
            lat = head.lat * DEG;
        }
        // Échelle de Mercator : un mètre au sol vaut 1/cos(lat) unités.
        const minSpan = o.minSpanM * frame / Math.max(0.05, Math.cos(lat));
        minLog[i] = Math.log(Math.max(floor, minSpan / (o.safeShare * Math.min(w, h))));
    }

    const cx0 = gaussian(tx, o.centerSigmaQ / SAMPLE_Q);
    const cy0 = gaussian(ty, o.centerSigmaQ / SAMPLE_Q);

    // Zoom : ce qui est parcouru sur [-lookBackQ, +lookAheadQ] tient, vu du
    // centre, dans safeShare du demi-écran.
    const back = Math.round(perSample(o.lookBackQ));
    const ahead = Math.round(perSample(o.lookAheadQ));
    const halfW = (w / 2) * o.safeShare;
    const halfH = (h / 2) * o.safeShare;
    const need = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let dx = 0;
        let dy = 0;
        for (let j = Math.max(0, i - back); j <= Math.min(n - 1, i + ahead); j++) {
            dx = Math.max(dx, Math.abs(tx[j] - cx0[i]) + ex[j]);
            dy = Math.max(dy, Math.abs(ty[j] - cy0[i]) + ey[j]);
        }
        need[i] = Math.max(minLog[i], Math.log(Math.max(dx * frame / halfW, dy * frame / halfH, 1e-9)));
    }
    // Dézoom tenu : une balade garde un seul cadre, pas un par cache.
    const held = dilate(need, Math.round(perSample(o.holdBackQ)), Math.round(perSample(o.holdAheadQ)));
    const limited = limitRate(held, o.maxZoomPerQ * SAMPLE_Q * Math.LN2);
    const logRes = gaussian(limited, o.zoomSigmaQ / SAMPLE_Q);

    // Avance dans le sens de la marche, bornée à leadShare du demi-écran.
    const leadX = new Float64Array(n);
    const leadY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = clampIndex(i - 1, n);
        const b = clampIndex(i + 1, n);
        const span = Math.max(1, b - a) * SAMPLE_Q;
        let lx = ((cx0[b] - cx0[a]) / span) * o.leadQ;
        let ly = ((cy0[b] - cy0[a]) / span) * o.leadQ;
        const cap = o.leadShare * (Math.min(w, h) / 2) * Math.exp(logRes[i]);
        const length = Math.hypot(lx, ly);
        if (length > cap) {
            lx *= cap / length;
            ly *= cap / length;
        }
        leadX[i] = lx;
        leadY[i] = ly;
    }
    const lx = gaussian(leadX, o.centerSigmaQ / SAMPLE_Q);
    const ly = gaussian(leadY, o.centerSigmaQ / SAMPLE_Q);
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        cx[i] = cx0[i] + lx[i];
        cy[i] = cy0[i] + ly[i];
    }
    return { n, cx, cy, logRes };
}

// Les constantes de temps des réglages sont en quanta au rythme naturel
// (QUANTUM_MS = 100 ms) : `msPerDay` les exprime en temps écran — le lissage,
// les fenêtres et la vitesse de zoom gardent leur durée réelle quand la
// lecture est accélérée (durée imposée) ou ralentie.
function timedOptions(o) {
    const scale = QUANTUM_MS / Math.max(1e-3, Number(o.msPerDay) || QUANTUM_MS);
    if (Math.abs(scale - 1) < 1e-9) return o;
    const scaled = { ...o };
    for (const key of ['centerSigmaQ', 'leadQ', 'lookBackQ', 'lookAheadQ', 'holdBackQ', 'holdAheadQ', 'zoomSigmaQ']) {
        scaled[key] = o[key] * scale;
    }
    scaled.maxZoomPerQ = o.maxZoomPerQ / scale;
    return scaled;
}

// Pistes gardées par chronologie, et par taille de vue et options.
const tracks = new WeakMap();

function trackFor(timeline, size, options) {
    let bySize = tracks.get(timeline);
    if (!bySize) {
        bySize = new Map();
        tracks.set(timeline, bySize);
    }
    const key = `${size[0]}x${size[1]}${Object.keys(options).length ? JSON.stringify(options) : ''}`;
    let track = bySize.get(key);
    if (!track) {
        track = buildTrack(timeline, size, timedOptions({ ...CAMERA_DEFAULTS, ...options }));
        if (bySize.size >= MAX_TRACKS) bySize.delete(bySize.keys().next().value);
        bySize.set(key, track);
    }
    return track;
}

// Pose de la caméra à `qf` pour une vue de `size` ([largeur, hauteur] en px
// CSS) : { center: [x, y] (EPSG:3857), resolution, zoom }. null sans étape.
export function cameraPoseAt(timeline, qf, size, options = {}) {
    if (!(timeline?.stops?.length) || !Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) return null;
    const o = { ...CAMERA_DEFAULTS, ...options };
    const track = trackFor(timeline, size, options);
    const f = Math.min(track.n - 1, Math.max(0, (Number(qf) || 0) / SAMPLE_Q));
    const i = Math.min(track.n - 2, Math.floor(f));
    const t = f - i;
    const center = [
        track.cx[i] + (track.cx[i + 1] - track.cx[i]) * t,
        track.cy[i] + (track.cy[i + 1] - track.cy[i]) * t,
    ];
    const resolution = Math.exp(track.logRes[i] + (track.logRes[i + 1] - track.logRes[i]) * t);
    // Filet de sécurité : le géocacheur reste dans l'écran.
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
    return overviewOf(timeline);
}
