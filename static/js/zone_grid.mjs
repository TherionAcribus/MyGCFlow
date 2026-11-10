// Niveau « grille » des cartes par zones : cases hexagonales régulières
// calculées à partir des coordonnées, sans fichier de contours. Module pur,
// testé par tests/js/zone_grid.test.mjs. Doc : docs/carte-zones.md › Grille.
//
// Projection locale équirectangulaire autour d'une latitude de référence
// `lat0` (celle des données, arrondie à 5°) : x = lon·K·cos(lat0),
// y = lat·K. Une case de 25 km fait 25 km d'un centre à l'autre près de
// lat0 ; sa surface réelle est corrigée par cos(lat)/cos(lat0).
//
// Hexagones « pointe en haut », coordonnées axiales (q, r). Id d'une case :
// « h<taille>/<lat0>/<q>/<r> » — la taille et la référence en font partie,
// deux grilles différentes ne mélangent jamais leurs cases.

export const GRID_SIZES = Object.freeze([5, 10, 25, 50, 100]);   // km entre deux centres
export const GRID_DEFAULT_SIZE = 25;
const KM_PER_DEG = 111.32;
const SQRT3 = Math.sqrt(3);
const LAT0_STEP = 5;
const LAT0_MAX = 70;
const ID_RE = /^h(\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/;

export const normalizeGridSize = (value) => (GRID_SIZES.includes(Number(value)) ? Number(value) : GRID_DEFAULT_SIZE);

// Latitude de référence d'un ensemble de points : la médiane, arrondie à 5°
// (stable quand quelques points changent ; même grille d'une page à l'autre
// pour les mêmes données).
export function gridReference(latitudes) {
    const list = [];
    for (const lat of latitudes) if (Number.isFinite(lat) && lat >= -90 && lat <= 90) list.push(lat);
    if (!list.length) return 0;
    list.sort((a, b) => a - b);
    const median = list[Math.floor(list.length / 2)];
    const rounded = Math.round(median / LAT0_STEP) * LAT0_STEP;
    return Math.max(-LAT0_MAX, Math.min(LAT0_MAX, rounded));
}

const radiusOf = (size) => size / SQRT3;
const scaleX = (lat0) => KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180);

// Case d'un point (id), ou null pour une position invalide.
export function cellOf(lon, lat, size, lat0) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || (lon === 0 && lat === 0)) return null;
    const R = radiusOf(size);
    const x = lon * scaleX(lat0);
    const y = lat * KM_PER_DEG;
    const qf = ((SQRT3 / 3) * x - y / 3) / R;
    const rf = ((2 / 3) * y) / R;
    // Arrondi cubique.
    const sf = -qf - rf;
    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(sf);
    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - sf);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return `h${size}/${lat0}/${q}/${r}`;
}

export function parseCell(id) {
    const m = ID_RE.exec(String(id));
    if (!m) return null;
    return { size: Number(m[1]), lat0: Number(m[2]), q: Number(m[3]), r: Number(m[4]) };
}

function centerKm(cell) {
    const R = radiusOf(cell.size);
    return [R * SQRT3 * (cell.q + cell.r / 2), R * 1.5 * cell.r];
}

// Centre [lon, lat].
export function cellCenter(id) {
    const cell = parseCell(id);
    if (!cell) return null;
    const [x, y] = centerKm(cell);
    return [x / scaleX(cell.lat0), y / KM_PER_DEG];
}

// Contour [[lon, lat] × 7] (fermé), pointe en haut.
export function cellRing(id) {
    const cell = parseCell(id);
    if (!cell) return null;
    const R = radiusOf(cell.size);
    const [cx, cy] = centerKm(cell);
    const kx = scaleX(cell.lat0);
    const ring = [];
    for (let i = 0; i < 6; i++) {
        const a = ((60 * i + 30) * Math.PI) / 180;
        ring.push([(cx + R * Math.cos(a)) / kx, (cy + R * Math.sin(a)) / KM_PER_DEG]);
    }
    ring.push(ring[0]);
    return ring;
}

// Surface réelle (km²) : hexagone du plan local, corrigé de la latitude.
export function cellArea(id) {
    const cell = parseCell(id);
    if (!cell) return null;
    const R = radiusOf(cell.size);
    const lat = cellCenter(id)[1];
    const k = Math.cos((lat * Math.PI) / 180) / Math.cos((cell.lat0 * Math.PI) / 180);
    return ((3 * SQRT3) / 2) * R * R * Math.max(0, k);
}

// Libellé lisible : « 47,2° N · 1,5° O ».
export function cellLabel(id, { locale = 'fr', north = 'N', south = 'S', east = 'E', west = 'O' } = {}) {
    const center = cellCenter(id);
    if (!center) return String(id);
    const fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const [lon, lat] = center;
    return `${fmt.format(Math.abs(lat))}° ${lat >= 0 ? north : south} · ${fmt.format(Math.abs(lon))}° ${lon >= 0 ? east : west}`;
}

// Colonne « zone_grid » d'une table de chart_sources.mjs (qui porte `lat` et
// `lon`) : id de case par ligne (index dans dicts.zone_grid, -1 = sans
// position). Nouvelle table, la table d'origine reste intacte.
export function withGridColumn(table, size, { lat0 = null } = {}) {
    const n = table?.n || 0;
    const lat = table?.lat;
    const lon = table?.lon;
    const column = new Int32Array(n).fill(-1);
    const ids = [];
    if (n && lat && lon) {
        const ref = lat0 ?? gridReference(lat);
        const index = new Map();
        for (let r = 0; r < n; r++) {
            const id = cellOf(lon[r], lat[r], size, ref);
            if (id === null) continue;
            let k = index.get(id);
            if (k === undefined) {
                k = ids.length;
                ids.push(id);
                index.set(id, k);
            }
            column[r] = k;
        }
    }
    return { ...table, zone_grid: column, dicts: { ...(table?.dicts || {}), zone_grid: ids } };
}
