// Génère static/js/theme_thumb_map.js : le fond de carte des vignettes de
// thèmes à carte vectorielle (cf. static/js/theme_thumbs.js).
//
//   node generate_theme_thumb_map.mjs
//
// Source : le MÊME fichier que le fond vectoriel réel
// (static/json/world-countries-50m.topo.json). On en extrait une fenêtre fixe
// sur l'Europe de l'Ouest, projetée en Web Mercator dans le repère de la
// vignette (150×90), simplifiée puis sérialisée en un seul chemin SVG.
//
// La simplification se fait ARC PAR ARC (avant l'assemblage des anneaux) :
// deux pays voisins partagent le même arc, donc la même frontière simplifiée —
// ni trou ni chevauchement entre aplats.
//
// À relancer seulement si la fenêtre, la tolérance ou le fichier source change.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(ROOT, 'static', 'json', 'world-countries-50m.topo.json');
const TARGET = join(ROOT, 'static', 'js', 'theme_thumb_map.js');

// Repère de la vignette (identique à VB_W / VB_H de theme_thumbs.js).
const VB_W = 150;
const VB_H = 90;

// Fenêtre : bord ouest, latitude du bord nord et échelle. Choisie pour que les
// trois caches d'exemple de la vignette ([34,60], [74,34], [112,62]) tombent
// sur la terre ferme (Charentes, Rhénanie, Slovénie) et que la scène mêle
// mers, côtes et frontières intérieures.
const LON_WEST = -7.8;
const LAT_NORTH = 54.3;
const DEG_PER_UNIT = 0.2;

// Tolérance Douglas-Peucker et surface minimale d'un anneau (unités vignette),
// marge de découpe hors cadre (le trait des bords coupés reste invisible).
const TOLERANCE = 0.22;
const MIN_RING_AREA = 0.6;
const CLIP_MARGIN = 4;

const mercatorDeg = (lat) =>
    (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
const MERC_NORTH = mercatorDeg(LAT_NORTH);
const project = ([lon, lat]) => [
    (lon - LON_WEST) / DEG_PER_UNIT,
    (MERC_NORTH - mercatorDeg(lat)) / DEG_PER_UNIT,
];

function simplify(points, tolerance) {
    if (points.length <= 2) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = points[a];
        const [bx, by] = points[b];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let worst = -1;
        let worstDist = tolerance * tolerance;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            t = Math.min(1, Math.max(0, t));
            const ex = px - (ax + t * dx);
            const ey = py - (ay + t * dy);
            const dist = ex * ex + ey * ey;
            if (dist > worstDist) { worstDist = dist; worst = i; }
        }
        if (worst !== -1) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

// Sutherland–Hodgman contre un rectangle.
function clipRing(ring, xMin, yMin, xMax, yMax) {
    const edges = [
        [(p) => p[0] >= xMin, (p, q) => [xMin, p[1] + ((q[1] - p[1]) * (xMin - p[0])) / (q[0] - p[0])]],
        [(p) => p[0] <= xMax, (p, q) => [xMax, p[1] + ((q[1] - p[1]) * (xMax - p[0])) / (q[0] - p[0])]],
        [(p) => p[1] >= yMin, (p, q) => [p[0] + ((q[0] - p[0]) * (yMin - p[1])) / (q[1] - p[1]), yMin]],
        [(p) => p[1] <= yMax, (p, q) => [p[0] + ((q[0] - p[0]) * (yMax - p[1])) / (q[1] - p[1]), yMax]],
    ];
    let out = ring;
    for (const [inside, cross] of edges) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            if (inside(cur)) {
                if (!inside(prev)) out.push(cross(prev, cur));
                out.push(cur);
            } else if (inside(prev)) {
                out.push(cross(prev, cur));
            }
        }
        if (!out.length) return out;
    }
    return out;
}

function ringArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
}

const topo = JSON.parse(readFileSync(SOURCE, 'utf8'));
const { scale, translate } = topo.transform;

// Arcs décodés (delta + quantification), projetés puis simplifiés.
const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    const points = arc.map(([dx, dy]) => {
        x += dx;
        y += dy;
        return project([x * scale[0] + translate[0], y * scale[1] + translate[1]]);
    });
    return simplify(points, TOLERANCE);
});

function buildRing(arcIndexes) {
    const ring = [];
    for (const index of arcIndexes) {
        const points = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
        // Le premier point d'un arc répète le dernier du précédent.
        for (let i = ring.length ? 1 : 0; i < points.length; i++) ring.push(points[i]);
    }
    ring.pop(); // anneau fermé : dernier point = premier
    return ring;
}

const fmt = (n) => String(Math.round(n * 10) / 10);
const subpaths = [];
for (const geometry of topo.objects.countries.geometries) {
    const polygons = geometry.type === 'Polygon' ? [geometry.arcs]
        : geometry.type === 'MultiPolygon' ? geometry.arcs : [];
    for (const polygon of polygons) {
        for (const arcIndexes of polygon) {
            const clipped = clipRing(
                buildRing(arcIndexes),
                -CLIP_MARGIN, -CLIP_MARGIN, VB_W + CLIP_MARGIN, VB_H + CLIP_MARGIN,
            );
            if (clipped.length < 3 || ringArea(clipped) < MIN_RING_AREA) continue;
            // Points arrondis au dixième ; doublons consécutifs retirés.
            const parts = [];
            for (const [x, y] of clipped) {
                const part = `${fmt(x)},${fmt(y)}`;
                if (parts[parts.length - 1] !== part) parts.push(part);
            }
            if (parts.length > 1 && parts[0] === parts[parts.length - 1]) parts.pop();
            if (parts.length >= 3) subpaths.push(`M${parts.join('L')}Z`);
        }
    }
}

const path = subpaths.join('');
writeFileSync(TARGET, `// FICHIER GÉNÉRÉ par generate_theme_thumb_map.mjs — ne pas modifier à la main.
//
// Pays d'Europe de l'Ouest (Natural Earth 1:50m, même source que le fond
// vectoriel réel), en Web Mercator dans le repère ${VB_W}×${VB_H} des vignettes de
// thèmes : un sous-chemin par anneau, frontières partagées entre pays voisins.
export const THUMB_COUNTRIES_PATH = '${path}';
`);
console.log(`${TARGET} : ${subpaths.length} anneaux, ${path.length} caractères`);
