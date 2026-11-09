// Contours des zones (static/geo/, produits par tools/build_geo_zones.py, cf.
// docs/carte-zones.md) : chargement à la demande, noms, surfaces, emprises.
// Partagé par la page Statistiques (stats_page_geo.js, cartes ECharts) et la
// couche de zones de la carte (zone_layer.js, OpenLayers).
//
// Rien ne bloque : on demande un fichier (loadFile), on regarde s'il est là
// (`entry.data`), et les écouteurs (addGeoListener) sont prévenus à chaque
// arrivée ou échec.

const GEO_BASE = '/static/geo/';

let indexPromise = null;
let index = null;
let failed = false;
const listeners = new Set();
const files = new Map();      // chemin → { promise, data, error }
const props = new Map();      // id → propriétés (nom, surface, parent) — tous niveaux
const bboxes = new Map();     // feature → [x0, y0, x1, y1]
const bboxById = new Map();   // id → [x0, y0, x1, y1]

const english = () => String(document.documentElement.lang || 'fr').toLowerCase().startsWith('en');

export function addGeoListener(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify() {
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.warn('[zones] écouteur', e); }
    }
}

export function geoIndex() {
    return index;
}

export function geoFailed() {
    return failed;
}

export function loadIndex() {
    indexPromise ??= fetch(GEO_BASE + 'index.json')
        .then((resp) => {
            if (!resp.ok) throw new Error('index.json : ' + resp.status);
            return resp.json();
        })
        .then((data) => {
            index = data;
            notify();
        })
        .catch((err) => {
            console.warn('[zones] catalogue indisponible', err);
            failed = true;
            notify();
        });
    return indexPromise;
}

// Révision d'un fichier (cache navigateur long, invalidé à chaque contenu).
function fileUrl(rel) {
    const entry = rel === 'countries.json' ? index?.countries
        : Object.values(index?.by_country || {}).flatMap((c) => [c.region, c.subregion]).find((e) => e?.file === rel);
    return GEO_BASE + rel + (entry?.rev ? '?v=' + entry.rev : '');
}

// { promise, data, error } d'un fichier (chemin relatif à static/geo/).
export function loadFile(rel) {
    let entry = files.get(rel);
    if (entry) return entry;
    entry = { promise: null, data: null, error: false };
    files.set(rel, entry);
    entry.promise = fetch(fileUrl(rel))
        .then((resp) => {
            if (!resp.ok) throw new Error(rel + ' : ' + resp.status);
            return resp.json();
        })
        .then((data) => {
            for (const feature of data.features || []) {
                const box = bboxOf(feature.geometry);
                props.set(feature.properties.id, feature.properties);
                bboxes.set(feature, box);
                bboxById.set(feature.properties.id, box);
            }
            entry.data = data;
            notify();
        })
        .catch((err) => {
            console.warn('[zones] contours indisponibles', err);
            entry.error = true;
            notify();
        });
    return entry;
}

// Fichiers nécessaires : pays du monde, ou niveau 1 / 2 des pays présents
// (un pays sans niveau 2 donne son niveau 1). Le catalogue doit être là.
export function requiredFiles(level, countries) {
    if (level === 'country') return ['countries.json'];
    const out = [];
    for (const cc of countries) {
        const entry = index?.by_country?.[cc];
        if (!entry) continue;
        const file = (level === 'subregion' && entry.subregion ? entry.subregion : entry.region)?.file;
        if (file) out.push(file);
    }
    return [...new Set(out)];
}

// Fichiers d'un niveau pour des pays : { status: 'ready' | 'loading' |
// 'error', features }. Lance les chargements manquants.
export function zoneFeatures(level, countries) {
    if (failed) return { status: 'error', features: [] };
    if (!index) {
        loadIndex();
        return { status: 'loading', features: [] };
    }
    const entries = requiredFiles(level, countries).map(loadFile);
    if (entries.some((e) => e.error)) return { status: 'error', features: [] };
    if (entries.some((e) => !e.data)) return { status: 'loading', features: [] };
    return { status: 'ready', features: entries.flatMap((e) => e.data.features) };
}

// ---------------------------------------------------------------------------
// Noms, surfaces, pays sans niveau 2

export function zoneProps(id) {
    return props.get(id) || null;
}

export function zoneName(id) {
    const p = props.get(id);
    if (!p) return null;
    return (english() ? p.name_en : p.name_fr) || p.name || null;
}

// Surfaces (km²) des zones chargées, pour la densité.
export function zoneAreas() {
    const out = new Map();
    for (const [id, p] of props) out.set(id, p.area_km2);
    return out;
}

// Pays qui n'ont pas de niveau 2 : affichés à leur niveau 1 sur une carte
// des sous-régions. null tant que le catalogue n'est pas là.
export function fallbackCountries() {
    if (!index) return null;
    return new Set(Object.entries(index.by_country).filter(([, c]) => !c.subregion).map(([cc]) => cc));
}

// « départements : 41 », « régions : 13 », « zones : 52 » (plusieurs pays).
export function levelNoun(level, countries, n) {
    const lang = english() ? 'en' : 'fr';
    if (level === 'country') return (english() ? 'countries: ' : 'pays : ') + n;
    const labels = new Set(countries.map((cc) => index?.by_country?.[cc]?.[level]?.label?.[lang]).filter(Boolean));
    const fallback = level === 'region' ? (english() ? 'regions' : 'régions') : 'zones';
    const label = labels.size === 1 ? [...labels][0] : fallback;
    return `${label} : ${n}`;
}

// ---------------------------------------------------------------------------
// Géométrie

export function bboxOf(geometry) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const polys = geometry?.type === 'MultiPolygon' ? geometry.coordinates : geometry ? [geometry.coordinates] : [];
    for (const poly of polys) {
        for (const ring of poly) {
            for (const [x, y] of ring) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    return [x0, y0, x1, y1];
}

// Emprise d'une feature chargée, ou d'une zone par son id.
export function featureBBox(feature) {
    return bboxes.get(feature) || null;
}

export function zoneBounds(id) {
    return bboxById.get(id) || null;
}
