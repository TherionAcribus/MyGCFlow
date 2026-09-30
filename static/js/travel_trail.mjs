// Traits de déplacement : le chemin du géocacheur d'une étape à la suivante.
//
// Les dates des trouvailles ne disent pas dans quel ordre les caches d'un même
// jour ont été visitées, et passer par chacune dessinerait une pelote illisible.
// Le trajet relie donc des ÉTAPES : les caches d'un jour sont regroupées par
// proximité, chaque groupe est représenté par sa cache la plus centrale (le
// trait passe sur une vraie cache, jamais au milieu d'un lac), et les étapes du
// jour sont ordonnées automatiquement : plus proche voisin depuis la position
// précédente, puis 2-opt sur les petites journées.
//
// Le trajet complet est précalculé au lancement : pour que le trait ARRIVE sur
// les caches au moment où elles apparaissent, il faut connaître le prochain jour
// de trouvailles avant qu'il ne s'affiche, et le lissage en courbe a besoin du
// point suivant. Le calcul est linéaire (grille + union-find) ; le coût réel de
// la fonctionnalité est le dessin de chaque frame, borné par la persistance.
//
// Le dessin avance comme un stylo le long de la polyligne : longueur parcourue
// en fonction de l'horloge des points (temps vidéo en capture image par image),
// donc reproductible à l'identique d'un enregistrement à l'autre.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable. La
// projection vers les coordonnées de la carte est injectée (`project`).

export const TRAIL_ROUTINGS = Object.freeze(['day', 'clusters', 'all']);
export const TRAIL_JUMP_STYLES = Object.freeze(['arc', 'dashed', 'straight', 'hidden']);
export const TRAIL_CURVES = Object.freeze(['straight', 'smooth']);
export const TRAIL_LINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted']);
export const TRAIL_EFFECTS = Object.freeze(['none', 'glow']);
export const TRAIL_HEADS = Object.freeze(['none', 'dot', 'pulse']);
// Fenêtres de persistance proposées, en jours. 0 = tout le parcours reste.
export const TRAIL_PERSIST_DAYS = Object.freeze([7, 30, 90, 365, 0]);

// Mêmes bornes que settings_manager.py (TRAIL_*_RANGE) : un thème édité à la
// main ne doit pas produire un trait invisible ou démesuré.
export const TRAIL_CLUSTER_KM_RANGE = Object.freeze([0.1, 100]);
export const TRAIL_JUMP_KM_RANGE = Object.freeze([10, 5000]);
export const TRAIL_WIDTH_RANGE = Object.freeze([1, 20]);
export const TRAIL_OPACITY_RANGE = Object.freeze([10, 100]);
export const TRAIL_DURATION_RANGE = Object.freeze([100, 10000]);

// Valeurs par défaut, identiques au bloc `trail` de static/json/defaultValues.json
// et aux dataclasses Python (TrailOptions + AnimationPrefs.trail_duration_ms) :
// des tests verrouillent l'égalité.
export const TRAIL_DEFAULTS = Object.freeze({
    enabled: false,
    routing: 'clusters',
    clusterKm: 2,
    jumpKm: 150,
    jumpStyle: 'arc',
    curve: 'straight',
    color: '#00B8D4',
    width: 3,
    opacity: 85,
    lineStyle: 'solid',
    effect: 'none',
    head: 'dot',
    persistDays: 30,
    // Durée maximale du tracé d'une étape (ms). Réglage temporel : préférence
    // globale d'animation, comme la durée du flash, et non attribut du thème.
    duration: 800,
});

// Au-delà, le mode « toutes les caches » dessinerait une pelote et coûterait
// cher à ordonner : ce jour-là se replie sur le regroupement.
export const ALL_MAX_PER_DAY = 300;
// Le 2-opt (quadratique par passe) n'est appliqué qu'aux petites journées.
export const TWO_OPT_MAX_STOPS = 120;
const TWO_OPT_MAX_PASSES = 12;

// Segments du trajet (tableau `kind`, indexé par le sommet d'arrivée).
export const SEGMENT_NORMAL = 0;
export const SEGMENT_JUMP_DASHED = 1;
export const SEGMENT_HIDDEN = 2;

// Échantillonnage des courbes.
export const ARC_SAMPLES = 24;
export const SMOOTH_MAX_SAMPLES = 8;
// Renflement d'un arc de grand saut, en part de la longueur du segment.
export const ARC_BULGE = 0.2;

// Mode « tout le parcours » : les derniers jours restent vifs, puis le trait se
// pose à cette opacité (relative à l'opacité choisie).
export const PERMANENT_FLOOR_OPACITY = 0.35;
export const PERMANENT_RECENT_DAYS = 30;
// Paliers d'opacité : un tracé (stroke) par palier et par type de segment.
export const OPACITY_LEVELS = 8;

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEGREE = Math.PI * EARTH_RADIUS_KM / 180;
const DEG = Math.PI / 180;
const LENGTH_EPSILON = 1e-6;

// --- Options ------------------------------------------------------------------

function choice(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function clampNumber(value, [min, max], fallback, integer = false) {
    const number = Number(value);
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(number)) return fallback;
    const clamped = Math.min(max, Math.max(min, number));
    return integer ? Math.round(clamped) : clamped;
}

function hexColor(value, fallback) {
    const m = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value) : null;
    if (!m) return fallback;
    // Expansion courte : les sélecteurs <input type="color"> et hexToRgb
    // n'acceptent que la forme « #rrggbb ».
    const hex = m[1];
    return hex.length === 3 ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : value;
}

// Réglages du trait bornés et complétés. Toute valeur absente ou invalide
// reprend la valeur par défaut : le moteur n'a jamais à revérifier.
export function normalizeTrailOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const d = TRAIL_DEFAULTS;
    // Liste fermée de jours ; 0 = « tout le parcours ». Les types inattendus
    // (booléen, null, objet, chaîne vide, non-entier) reprennent le défaut —
    // False vaudrait 0 et activerait le mode permanent par accident.
    const rawPersist = o.persistDays;
    const persist = (rawPersist === null || rawPersist === undefined || rawPersist === ''
        || typeof rawPersist === 'boolean' || typeof rawPersist === 'object')
        ? NaN : Number(rawPersist);
    return {
        enabled: o.enabled === true,
        routing: choice(o.routing, TRAIL_ROUTINGS, d.routing),
        clusterKm: clampNumber(o.clusterKm, TRAIL_CLUSTER_KM_RANGE, d.clusterKm),
        jumpKm: clampNumber(o.jumpKm, TRAIL_JUMP_KM_RANGE, d.jumpKm, true),
        jumpStyle: choice(o.jumpStyle, TRAIL_JUMP_STYLES, d.jumpStyle),
        curve: choice(o.curve, TRAIL_CURVES, d.curve),
        color: hexColor(o.color, d.color),
        width: clampNumber(o.width, TRAIL_WIDTH_RANGE, d.width, true),
        opacity: clampNumber(o.opacity, TRAIL_OPACITY_RANGE, d.opacity, true),
        lineStyle: choice(o.lineStyle, TRAIL_LINE_STYLES, d.lineStyle),
        effect: choice(o.effect, TRAIL_EFFECTS, d.effect),
        head: choice(o.head, TRAIL_HEADS, d.head),
        persistDays: Number.isInteger(persist) && TRAIL_PERSIST_DAYS.includes(persist) ? persist : d.persistDays,
        duration: clampNumber(o.duration, TRAIL_DURATION_RANGE, d.duration, true),
    };
}

// --- Distances ----------------------------------------------------------------

// Distance au sol (haversine), en km, entre deux points [lon, lat].
export function groundDistanceKm(a, b) {
    const lat1 = a[1] * DEG;
    const lat2 = b[1] * DEG;
    const dLat = lat2 - lat1;
    const dLon = (b[0] - a[0]) * DEG;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Un point valide est dans les bornes du monde : une longitude hors
// [-180, 180] (540, par exemple) est une donnée invalide, ignorée — pas de
// repliement silencieux qui la téléporterait à l'autre bout de la carte.
function isValidPoint(point) {
    return Array.isArray(point)
        && Number.isFinite(point[0]) && Number.isFinite(point[1])
        && point[0] >= -180 && point[0] <= 180
        && point[1] >= -90 && point[1] <= 90;
}

// Projection équirectangulaire locale, en km : exacte à quelques pour mille
// près à l'échelle d'une journée de géocaching, et bien plus rapide que
// l'haversine pour comparer des milliers de paires. Les longitudes sont
// dépliées autour de celle du premier index (`lonRef`, déterministe) : deux
// caches de part et d'autre de l'antiméridien (179.999 / -179.999) restent
// contiguës au lieu d'être à 360° l'une de l'autre.
function localKm(points, indices) {
    let latSum = 0;
    for (const i of indices) latSum += points[i][1];
    const cosLat = Math.max(0.01, Math.cos((latSum / Math.max(1, indices.length)) * DEG));
    const lonRef = indices.length ? points[indices[0]][0] : 0;
    const xs = new Float64Array(points.length);
    const ys = new Float64Array(points.length);
    for (const i of indices) {
        const d = points[i][0] - lonRef;
        const w = d - Math.round(d / 360) * 360; // [-180, 180] autour de la référence
        xs[i] = w * KM_PER_DEGREE * cosLat;
        ys[i] = points[i][1] * KM_PER_DEGREE;
    }
    return { xs, ys, lonRef, cosLat };
}

// Point isolé ([lon, lat]) projeté dans le repère d'un localKm existant :
// même dépliage de la longitude autour de `lonRef`.
function localKmXY(p, lonRef, cosLat) {
    const d = p[0] - lonRef;
    const w = d - Math.round(d / 360) * 360;
    return [w * KM_PER_DEGREE * cosLat, p[1] * KM_PER_DEGREE];
}

// --- Regroupement -------------------------------------------------------------

// Groupes de caches à moins de `radiusKm` les unes des autres, de proche en
// proche (lien simple) : une grille de cellules de la taille du rayon, et une
// union des voisines dans les 3×3 cellules alentour. Linéaire en pratique.
// Retourne des tableaux d'index, dans l'ordre de leur premier élément.
export function clusterPoints(points, radiusKm) {
    const valid = [];
    for (let i = 0; i < (points?.length || 0); i++) {
        if (isValidPoint(points[i])) valid.push(i);
    }
    if (valid.length === 0) return [];
    if (valid.length === 1) return [[valid[0]]];

    const radius = clampNumber(radiusKm, TRAIL_CLUSTER_KM_RANGE, TRAIL_DEFAULTS.clusterKm);
    const radius2 = radius * radius;
    const { xs, ys } = localKm(points, valid);

    const parent = new Int32Array(points.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        // Racine = plus petit index : résultat indépendant de l'ordre des unions.
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    const cells = new Map();
    for (const i of valid) {
        const cx = Math.floor(xs[i] / radius);
        const cy = Math.floor(ys[i] / radius);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = cells.get(`${cx + dx},${cy + dy}`);
                if (!cell) continue;
                for (const j of cell) {
                    if (find(i) === find(j)) continue;
                    const ex = xs[i] - xs[j];
                    const ey = ys[i] - ys[j];
                    if (ex * ex + ey * ey <= radius2) union(i, j);
                }
            }
        }
        const key = `${cx},${cy}`;
        const own = cells.get(key);
        if (own) own.push(i);
        else cells.set(key, [i]);
    }

    const groups = new Map();
    for (const i of valid) {
        const root = find(i);
        const group = groups.get(root);
        if (group) group.push(i);
        else groups.set(root, [i]);
    }
    return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

// Index de la cache la plus proche du barycentre du groupe (médoïde approché),
// calculé sur les coordonnées locales `xs`/`ys` d'une journée : une seule
// projection par journée pour toutes les ancres, au lieu d'une allocation par
// groupe. En cas d'égalité, le plus petit index : déterministe.
function groupAnchorXY(xs, ys, indices) {
    if (indices.length === 0) return -1;
    if (indices.length === 1) return indices[0];
    let cx = 0;
    let cy = 0;
    for (const i of indices) {
        cx += xs[i];
        cy += ys[i];
    }
    cx /= indices.length;
    cy /= indices.length;
    let best = -1;
    let bestD = Infinity;
    for (const i of indices) {
        const d = (xs[i] - cx) ** 2 + (ys[i] - cy) ** 2;
        if (d < bestD || (d === bestD && i < best)) {
            best = i;
            bestD = d;
        }
    }
    return best;
}

export function groupAnchor(points, indices) {
    const list = (indices || []).filter((i) => isValidPoint(points[i]));
    if (list.length === 0) return -1;
    if (list.length === 1) return list[0];
    const { xs, ys } = localKm(points, list);
    return groupAnchorXY(xs, ys, list);
}

// --- Ordre de passage ---------------------------------------------------------

// Ordre de visite des étapes d'une journée : plus proche voisin depuis `start`
// (dernière position connue, [lon, lat], ou null), puis 2-opt sur les petites
// journées pour défaire les croisements. Chemin ouvert : départ fixé, arrivée
// libre. Sans point de départ, on part d'une extrémité du nuage (l'étape la plus
// éloignée de son barycentre), pour balayer la journée d'un bout à l'autre.
export function orderStops(stops, start = null) {
    const n = stops?.length || 0;
    if (n <= 1) return n === 1 ? [0] : [];

    // Le plus proche voisin compare ~n²/2 paires : en coordonnées locales km
    // (une seule projection pour toute la journée) plutôt qu'en haversine,
    // ~50× moins cher par comparaison pour la même précision de classe. Sans
    // point de départ, l'ordre peut différer légèrement de l'haversine sur de
    // grandes distances (projection locale) — déterministe.
    const loc = localKm(stops, stops.map((_, i) => i));

    const remaining = new Set();
    for (let i = 0; i < n; i++) remaining.add(i);
    const order = [];
    let currentX;
    let currentY;

    if (isValidPoint(start)) {
        [currentX, currentY] = localKmXY(start, loc.lonRef, loc.cosLat);
    } else {
        // Extrémité du nuage : l'étape la plus éloignée du barycentre local.
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < n; i++) {
            cx += loc.xs[i];
            cy += loc.ys[i];
        }
        cx /= n;
        cy /= n;
        let far = 0;
        let farD = -1;
        for (let i = 0; i < n; i++) {
            const dx = loc.xs[i] - cx;
            const dy = loc.ys[i] - cy;
            const d = dx * dx + dy * dy;
            if (d > farD) {
                far = i;
                farD = d;
            }
        }
        order.push(far);
        remaining.delete(far);
        currentX = loc.xs[far];
        currentY = loc.ys[far];
    }

    while (remaining.size > 0) {
        let best = -1;
        let bestD = Infinity;
        for (const i of remaining) {
            const dx = loc.xs[i] - currentX;
            const dy = loc.ys[i] - currentY;
            const d = dx * dx + dy * dy;
            if (d < bestD || (d === bestD && i < best)) {
                best = i;
                bestD = d;
            }
        }
        order.push(best);
        remaining.delete(best);
        currentX = loc.xs[best];
        currentY = loc.ys[best];
    }

    // 2-opt en distances réelles (haversine) : borné aux petites journées, son
    // coût est négligeable et l'exactitude des sauts est conservée.
    if (n > TWO_OPT_MAX_STOPS) return order;
    return twoOpt(order, stops, isValidPoint(start) ? start : null);
}

// 2-opt sur un chemin ouvert. Le premier nœud est fixe : le point de départ
// externe s'il existe, sinon la première étape choisie.
function twoOpt(order, stops, start) {
    const nodes = start ? [start, ...order.map((i) => stops[i])] : order.map((i) => stops[i]);
    const ids = start ? [-1, ...order] : [...order];
    const m = nodes.length;
    if (m < 3) return order;

    const dist = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            const d = groundDistanceKm(nodes[i], nodes[j]);
            dist[i * m + j] = d;
            dist[j * m + i] = d;
        }
    }
    const path = Array.from({ length: m }, (_, i) => i);
    const d = (a, b) => dist[path[a] * m + path[b]];

    for (let pass = 0; pass < TWO_OPT_MAX_PASSES; pass++) {
        let improved = false;
        for (let i = 1; i < m - 1; i++) {
            for (let j = i + 1; j < m; j++) {
                const before = d(i - 1, i) + (j + 1 < m ? d(j, j + 1) : 0);
                const after = d(i - 1, j) + (j + 1 < m ? d(i, j + 1) : 0);
                if (after < before - 1e-9) {
                    for (let a = i, b = j; a < b; a++, b--) {
                        const tmp = path[a];
                        path[a] = path[b];
                        path[b] = tmp;
                    }
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    const result = path.map((p) => ids[p]);
    return start ? result.slice(1) : result;
}

// --- Trajet -------------------------------------------------------------------

// Étapes d'une journée selon le mode de tracé : index des caches retenues.
function dayStops(points, options) {
    if (options.routing === 'all' && points.length <= ALL_MAX_PER_DAY) {
        return points.map((_, i) => i).filter((i) => isValidPoint(points[i]));
    }
    const groups = options.routing === 'day'
        ? [points.map((_, i) => i)]
        : clusterPoints(points, options.clusterKm);
    // Une projection locale par journée, partagée par toutes les ancres :
    // l'ancre (barycentre + médoïde) est invariante par translation du repère.
    // clusterPoints garde sa propre projection interne — nécessaire avant de
    // connaître les groupes.
    const loc = localKm(points, points.map((_, i) => i).filter((i) => isValidPoint(points[i])));
    return groups
        .map((group) => groupAnchorXY(loc.xs, loc.ys, group.filter((i) => isValidPoint(points[i]))))
        .filter((i) => i >= 0);
}

// Trajet complet à partir des jours de trouvailles, triés ou non :
// `days` = [{ day: numéro de jour (entier), points: [[lon, lat], ...] }].
// Retourne les étapes en colonnes (lon, lat, day) et, pour chaque jour
// ayant au moins une étape, l'index de sa dernière étape.
export function buildTrailRoute(days, rawOptions = {}) {
    const options = normalizeTrailOptions(rawOptions);
    const sorted = (Array.isArray(days) ? days : [])
        .filter((d) => d && Number.isFinite(d.day) && Array.isArray(d.points) && d.points.length > 0)
        .sort((a, b) => a.day - b.day);

    const lon = [];
    const lat = [];
    const stopDay = [];
    const routeDays = [];
    const dayLastStop = [];
    // Journées où « toutes les caches » a dépassé le plafond et a été replié
    // sur le regroupement : rapportées pour informer l'utilisateur.
    const fallbackDays = [];
    let previous = null;

    for (const { day, points } of sorted) {
        const fallback = options.routing === 'all' && points.length > ALL_MAX_PER_DAY;
        const indices = dayStops(points, options);
        if (indices.length === 0) continue;
        const stops = indices.map((i) => points[i]);
        const order = orderStops(stops, previous);
        for (const k of order) {
            lon.push(stops[k][0]);
            lat.push(stops[k][1]);
            stopDay.push(day);
        }
        previous = stops[order[order.length - 1]];
        routeDays.push(day);
        dayLastStop.push(lon.length - 1);
        if (fallback) fallbackDays.push(day);
    }

    return {
        lon: Float64Array.from(lon),
        lat: Float64Array.from(lat),
        day: Int32Array.from(stopDay),
        days: Int32Array.from(routeDays),
        dayLastStop: Int32Array.from(dayLastStop),
        fallbackDays: Int32Array.from(fallbackDays),
    };
}

// --- Géométrie ----------------------------------------------------------------

function quadraticPoint(p0, c, p1, t) {
    const u = 1 - t;
    return [
        u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
        u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ];
}

// Catmull-Rom centripète (formulation de Barry et Goldman) entre p1 et p2.
function catmullRomPoint(p0, p1, p2, p3, t) {
    const knot = (a, b) => Math.max(1e-9, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const tt = t1 + (t2 - t1) * t;
    const lerp = (a, b, ta, tb) => {
        const w = (tt - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
    };
    const a1 = lerp(p0, p1, t0, t1);
    const a2 = lerp(p1, p2, t1, t2);
    const a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2);
    const b2 = lerp(a2, a3, t1, t3);
    return lerp(b1, b2, t1, t2);
}

function samePoint(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}

// Polyligne du trajet, en coordonnées de carte (via `project(lon, lat)`).
// Colonnes par sommet : xy (x, y entrelacés), cum (longueur cumulée), vday (jour
// de l'étape vers laquelle on se dirige) et kind (type du segment qui ARRIVE
// sur ce sommet). stopVertex donne le sommet de chaque étape.
export function buildTrailPath(route, {
    project = (x, y) => [x, y],
    curve = TRAIL_DEFAULTS.curve,
    jumpKm = TRAIL_DEFAULTS.jumpKm,
    jumpStyle = TRAIL_DEFAULTS.jumpStyle,
} = {}) {
    const count = route?.lon?.length || 0;
    const xy = [];
    const cum = [];
    const vday = [];
    const kind = [];
    const stopVertex = new Int32Array(count);
    if (count === 0) {
        return {
            xy: new Float64Array(0), cum: new Float64Array(0), vday: new Int32Array(0),
            kind: new Uint8Array(0), stopVertex, length: 0,
        };
    }

    // Dépliage cumulatif des longitudes avant projection : chaque étape reste
    // dans le même « monde » que la précédente, donc [179.9, -179.9] devient
    // [179.9, 180.1] et le trait franchit la couture ±180 au lieu de traverser
    // la carte entière. lonLat garde les coordonnées BRUTES : l'haversine gère
    // déjà le passage de l'antiméridien (sauts, distances au sol).
    const projected = [];
    let prevLon = route.lon[0];
    for (let i = 0; i < count; i++) {
        let lon = route.lon[i];
        if (i > 0) {
            lon -= Math.round((lon - prevLon) / 360) * 360;
        }
        prevLon = lon;
        projected.push(project(lon, route.lat[i]));
    }
    const lonLat = (i) => [route.lon[i], route.lat[i]];
    const isJump = (i) => i > 0 && i < count && groundDistanceKm(lonLat(i - 1), lonLat(i)) > jumpKm;

    let length = 0;
    const push = (p, day, segmentKind) => {
        const n = xy.length / 2;
        if (n > 0) length += Math.hypot(p[0] - xy[xy.length - 2], p[1] - xy[xy.length - 1]);
        xy.push(p[0], p[1]);
        cum.push(length);
        vday.push(day);
        kind.push(segmentKind);
    };

    push(projected[0], route.day[0], SEGMENT_NORMAL);
    stopVertex[0] = 0;

    for (let i = 1; i < count; i++) {
        const from = projected[i - 1];
        const to = projected[i];
        const day = route.day[i];
        const jump = isJump(i);
        let segmentKind = SEGMENT_NORMAL;
        if (jump && jumpStyle === 'hidden') segmentKind = SEGMENT_HIDDEN;
        else if (jump && jumpStyle === 'dashed') segmentKind = SEGMENT_JUMP_DASHED;

        if (jump && jumpStyle === 'arc' && !samePoint(from, to)) {
            // Toujours à gauche du sens de parcours : un aller-retour dessine
            // deux arcs distincts au lieu de se superposer.
            const dx = to[0] - from[0];
            const dy = to[1] - from[1];
            const control = [
                (from[0] + to[0]) / 2 - dy * ARC_BULGE * 2,
                (from[1] + to[1]) / 2 + dx * ARC_BULGE * 2,
            ];
            for (let s = 1; s <= ARC_SAMPLES; s++) {
                push(quadraticPoint(from, control, to, s / ARC_SAMPLES), day, segmentKind);
            }
        } else if (!jump && curve === 'smooth' && !samePoint(from, to)) {
            // Les voisins servent de tangentes ; au bord d'un saut ou du trajet,
            // on prolonge le segment lui-même (tangente droite).
            const prev = i >= 2 && !isJump(i - 1) && !samePoint(projected[i - 2], from)
                ? projected[i - 2]
                : [2 * from[0] - to[0], 2 * from[1] - to[1]];
            const next = i + 1 < count && !isJump(i + 1) && !samePoint(projected[i + 1], to)
                ? projected[i + 1]
                : [2 * to[0] - from[0], 2 * to[1] - from[1]];
            const km = groundDistanceKm(lonLat(i - 1), lonLat(i));
            const samples = Math.min(SMOOTH_MAX_SAMPLES, Math.max(2, Math.ceil(km)));
            for (let s = 1; s < samples; s++) {
                push(catmullRomPoint(prev, from, to, next, s / samples), day, segmentKind);
            }
            push(to, day, segmentKind);
        } else {
            push(to, day, segmentKind);
        }
        stopVertex[i] = xy.length / 2 - 1;
    }

    return {
        xy: Float64Array.from(xy),
        cum: Float64Array.from(cum),
        vday: Int32Array.from(vday),
        kind: Uint8Array.from(kind),
        stopVertex,
        length,
    };
}

// Longueur parcourue quand le stylo atteint la dernière étape du jour `dayIndex`
// (index dans route.days).
export function lengthAtDay(route, path, dayIndex) {
    if (dayIndex < 0 || dayIndex >= route.dayLastStop.length) return 0;
    return path.cum[path.stopVertex[route.dayLastStop[dayIndex]]];
}

// Premier index de route.days strictement postérieur à `day` (recherche
// dichotomique ; route.days est trié).
export function nextDayIndex(route, day) {
    const days = route.days;
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (days[mid] > day) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

// --- Stylo --------------------------------------------------------------------

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

// Longueur tracée à l'instant `now` : { fromLen, toLen, startAt, endAt }. Avant
// le départ, le stylo attend ; après l'arrivée, il reste posé.
export function penLengthAt(pen, now) {
    if (!pen) return 0;
    if (!(now > pen.startAt)) return pen.fromLen;
    if (!(now < pen.endAt) || !(pen.endAt > pen.startAt)) return pen.toLen;
    const progress = (now - pen.startAt) / (pen.endAt - pen.startAt);
    return pen.fromLen + (pen.toLen - pen.fromLen) * smoothstep(progress);
}

// Nouveau trait vers `targetLen`, qui doit arriver à `arrivalAt` (instant où les
// caches visées apparaissent) en durant au plus `maxDurationMs`.
//
// - À l'heure (le stylo est posé là où il devait être) : départ le plus tard
//   possible, pour que le trait touche les caches à leur apparition.
// - En retard (lot de plusieurs jours affichés d'un coup, trait précédent pas
//   fini, ou `behindLen` pas encore atteint) : départ immédiat depuis la position
//   courante. Le stylo ne saute jamais ; il rattrape son retard sur ce trait.
export function scheduleStroke(pen, { now, targetLen, arrivalAt, maxDurationMs, behindLen = 0 }) {
    const current = penLengthAt(pen, now);
    const target = Math.max(current, Number(targetLen) || 0);
    const available = Math.max(0, Number(arrivalAt) - now);
    const duration = Math.min(Math.max(0, Number(maxDurationMs) || 0), available);
    const lagging = current < behindLen - LENGTH_EPSILON
        || (pen ? current < pen.toLen - LENGTH_EPSILON : false);
    const startAt = lagging ? now : now + available - duration;
    return { fromLen: current, toLen: target, startAt, endAt: startAt + duration };
}

// Coordonnées du point situé à la longueur `len` du trajet, et index du sommet
// d'arrivée du segment qui le contient (0 si len <= 0).
export function pointAtLength(path, len) {
    const n = path.cum.length;
    if (n === 0) return null;
    if (!(len > 0)) return { x: path.xy[0], y: path.xy[1], segment: 0 };
    if (len >= path.cum[n - 1]) return { x: path.xy[2 * (n - 1)], y: path.xy[2 * n - 1], segment: n - 1 };
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path.cum[mid] >= len) hi = mid;
        else lo = mid + 1;
    }
    const a = path.cum[lo - 1];
    const b = path.cum[lo];
    const t = b > a ? (len - a) / (b - a) : 1;
    return {
        x: path.xy[2 * (lo - 1)] + (path.xy[2 * lo] - path.xy[2 * (lo - 1)]) * t,
        y: path.xy[2 * lo - 1] + (path.xy[2 * lo + 1] - path.xy[2 * lo - 1]) * t,
        segment: lo,
    };
}

// Segments à dessiner : ceux qui arrivent sur un sommet d'index `first` à `last`
// inclus (segment v = sommet v-1 -> sommet v). `first` : premier sommet dont le
// jour est >= minDay. `last` : segment contenant le stylo ; `partial` vaut vrai
// si le stylo est au milieu de ce segment (dessiner jusqu'à `point`).
export function visibleVertexRange(path, penLen, minDay) {
    const n = path.cum.length;
    if (n < 2 || !(penLen > 0)) return null;
    const head = pointAtLength(path, penLen);
    const last = head.segment;
    const partial = penLen < path.cum[last] - LENGTH_EPSILON;

    let lo = 1;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path.vday[mid] >= minDay) hi = mid;
        else lo = mid + 1;
    }
    const first = lo;
    if (first > last) return null;
    return { first, last, partial, point: [head.x, head.y] };
}

// --- Apparence ----------------------------------------------------------------

// Opacité relative (0..1) d'un segment âgé de `ageDays` jours. Traînée : fondu
// jusqu'à disparaître au bout de la fenêtre. Tout le parcours : les derniers
// jours restent vifs, puis le trait se pose à un plancher.
export function trailOpacity(ageDays, persistDays) {
    const age = Math.max(0, Number(ageDays) || 0);
    const persist = Number(persistDays) || 0;
    if (persist > 0) {
        const fade = Math.min(1, age / persist);
        return (1 - fade) ** 1.5;
    }
    const fade = Math.min(1, age / PERMANENT_RECENT_DAYS);
    return PERMANENT_FLOOR_OPACITY + (1 - PERMANENT_FLOOR_OPACITY) * (1 - fade);
}

// Palier d'opacité (multiple de 1/levels) : regroupe les segments d'opacité
// voisine dans un même tracé. 0 = invisible.
export function opacityBucket(opacity, levels = OPACITY_LEVELS) {
    const o = Number(opacity) || 0;
    if (o <= 0) return 0;
    return Math.min(levels, Math.ceil(o * levels - 1e-9)) / levels;
}

// Découpe les segments `from`..`to` en tronçons consécutifs de même type et de
// même palier d'opacité : chacun devient un seul tracé canvas.
export function splitTrailRuns(kind, bucketOf, from, to) {
    const runs = [];
    let current = null;
    for (let v = from; v <= to; v++) {
        const k = kind[v];
        const b = bucketOf(v);
        if (current && current.kind === k && current.bucket === b) {
            current.end = v;
        } else {
            current = { kind: k, bucket: b, start: v, end: v };
            runs.push(current);
        }
    }
    return runs;
}

// Transformation affine composée (format OpenLayers [a, b, c, d, e, f]) :
// applique `inner` puis `outer`. Sert à passer des coordonnées de carte aux
// pixels du canvas en une seule multiplication par sommet.
export function composeTransform(outer, inner) {
    const [a1, b1, c1, d1, e1, f1] = outer;
    const [a2, b2, c2, d2, e2, f2] = inner;
    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ];
}
