// Page Statistiques : contours des cartes par zones.
//
// Les fichiers de static/geo/ (produits par tools/build_geo_zones.py, cf.
// docs/carte-zones.md) sont chargés à la demande : le catalogue
// (index.json), puis les pays, régions ou sous-régions dont un résultat a
// besoin. Pour chaque carte, une carte ECharts est composée (zones du
// cadrage, encarts des territoires lointains) et enregistrée
// (echarts.registerMap) ; chart_echarts.mjs › mapOption la dessine.
//
// Rien ne bloque : tant que les contours manquent, zoneMapFor répond
// { loading: true } et la carte affiche « Chargement… » ; à l'arrivée,
// l'écouteur posé par setGeoListener redessine.

const GEO_BASE = '/static/geo/';
// Marge autour des zones cadrées, en part de la taille du cadre.
const FRAME_MARGIN = 0.04;
// Encarts : côté de chaque boîte, en part du plus petit côté du pays, et
// agrandissement maximal (La Réunion reste petite à côté de la métropole).
const INSET_SIZE = 0.18;
const INSET_MAX_ZOOM = 2.5;
const MAP_CACHE_MAX = 40;

let indexPromise = null;
let index = null;
let failed = false;
let listener = null;
const files = new Map();      // chemin → { promise, data, error }
const props = new Map();      // id → propriétés (nom, surface, parent) — tous niveaux
const bboxes = new Map();     // feature → [x0, y0, x1, y1]
const maps = new Map();       // clé de composition → nom enregistré

const english = () => String(document.documentElement.lang || 'fr').toLowerCase().startsWith('en');

export function setGeoListener(fn) {
    listener = fn;
}

function notify() {
    listener?.();
}

export function geoIndex() {
    return index;
}

function loadIndex() {
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

function loadFile(rel) {
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
                props.set(feature.properties.id, feature.properties);
                bboxes.set(feature, bboxOf(feature.geometry));
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

// ---------------------------------------------------------------------------
// Noms, surfaces, pays sans niveau 2

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
    const fallback = level === 'region' ? (english() ? 'regions' : 'régions') : (english() ? 'zones' : 'zones');
    const label = labels.size === 1 ? [...labels][0] : fallback;
    return `${label} : ${n}`;
}

// ---------------------------------------------------------------------------
// Géométrie

function bboxOf(geometry) {
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

function union(boxes) {
    let out = null;
    for (const b of boxes) {
        if (!b || !Number.isFinite(b[0])) continue;
        out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : [...b];
    }
    return out;
}

// Rapport largeur / hauteur d'un degré à la latitude du cadre (projection
// équirectangulaire d'ECharts) : 0,7 en France, 0,85 au Texas.
function aspectOf(box) {
    const mid = ((box[1] + box[3]) / 2) * Math.PI / 180;
    return Math.min(1, Math.max(0.35, Math.cos(mid)));
}

const intersects = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function transformGeometry(geometry, fn) {
    const mapRing = (ring) => ring.map(([x, y]) => fn(x, y));
    if (geometry.type === 'MultiPolygon') {
        return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map(mapRing)) };
    }
    return { type: 'Polygon', coordinates: geometry.coordinates.map(mapRing) };
}

// Clé courte d'une composition (djb2).
function hashKey(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// ---------------------------------------------------------------------------
// Carte d'un résultat

// Fichiers nécessaires : pays du monde, ou niveau 1 / 2 des pays présents (un
// pays sans niveau 2 donne son niveau 1).
function requiredFiles(level, countries) {
    if (level === 'country') return ['countries.json'];
    const out = [];
    for (const cc of countries) {
        const entry = index.by_country[cc];
        if (!entry) continue;
        const file = (level === 'subregion' && entry.subregion ? entry.subregion : entry.region)?.file;
        if (file) out.push(file);
    }
    return [...new Set(out)];
}

// Groupe d'encart d'une zone : { cc, name, zones } ou null.
function insetGroups(countries) {
    const groups = [];
    for (const cc of countries) {
        for (const inset of index.by_country[cc]?.insets || []) groups.push({ cc, ...inset, ids: new Set(inset.zones) });
    }
    return groups;
}

function groupOf(groups, id) {
    const parent = props.get(id)?.parent;
    return groups.find((g) => g.ids.has(id) || (parent && g.ids.has(parent))) || null;
}

// Carte prête pour un résultat ({ name, bounds, nameOf, levelNoun }), ou
// { loading: true } / { error: true }.
export function zoneMapFor(result, spec) {
    const echarts = window.echarts;
    const zones = result?.zones;
    if (!zones || !echarts) return { error: true };
    if (failed) return { error: true };
    if (!index) {
        loadIndex();
        return { loading: true };
    }
    const level = zones.level;
    const countries = zones.countries;
    if (level !== 'country' && !countries.length) {
        // Aucune ligne rattachée : rien à cadrer, carte vide du monde.
        return composeEmpty(echarts, level);
    }
    const rels = requiredFiles(level, countries);
    const entries = rels.map(loadFile);
    if (entries.some((e) => e.error)) return { error: true };
    if (entries.some((e) => !e.data)) return { loading: true };

    const features = entries.flatMap((e) => e.data.features);
    const data = new Set(result.keys);
    const frameWorld = spec?.view?.map?.frame === 'world';
    const groups = frameWorld ? [] : insetGroups(countries);
    const main = [];
    const insets = new Map();
    const mainCountries = new Set();
    const countryOf = (id) => String(id).split('-')[0];
    for (const f of features) {
        if (!data.has(f.properties.id)) continue;
        const g = groupOf(groups, f.properties.id);
        if (g) {
            if (!insets.has(g)) insets.set(g, []);
            insets.get(g).push(f);
        } else {
            main.push(f);
            mainCountries.add(countryOf(f.properties.id));
        }
    }
    // Un encart seulement pour un pays qui a aussi des zones « normales »
    // avec des données : la seule Réunion est cadrée telle quelle, et la
    // Réunion d'une carte des États-Unis reste à sa place.
    for (const g of [...insets.keys()]) {
        if (!mainCountries.has(g.cc)) {
            main.push(...insets.get(g));
            insets.delete(g);
        }
    }
    const moveInsets = main.length > 0 && insets.size > 0;
    let frame;
    if (frameWorld || !data.size) frame = union(features.map((f) => bboxes.get(f)));
    else frame = union((moveInsets ? main : features.filter((f) => data.has(f.properties.id))).map((f) => bboxes.get(f)));
    if (!frame) return composeEmpty(echarts, level);
    const w = frame[2] - frame[0] || 1;
    const h = frame[3] - frame[1] || 1;
    frame = [frame[0] - w * FRAME_MARGIN, frame[1] - h * FRAME_MARGIN, frame[2] + w * FRAME_MARGIN, frame[3] + h * FRAME_MARGIN];

    // Zones du cadre (les autres débordaient sur les vignettes voisines),
    // puis les encarts, déplacés sous le cadre, de gauche à droite.
    const out = [];
    const keyParts = [level];
    const moved = moveInsets ? new Set([...insets.keys()]) : new Set();
    for (const f of features) {
        const g = moved.size ? groupOf(groups, f.properties.id) : null;
        if (g && moved.has(g)) continue;
        if (!intersects(bboxes.get(f), frame)) continue;
        out.push({ type: 'Feature', properties: { name: f.properties.id }, geometry: f.geometry });
        keyParts.push(f.properties.id);
    }
    let bounds = frame;
    if (moveInsets) {
        // Côté des boîtes : une part du pays (sa partie hors encarts), pas
        // du cadre — un cadre de la France au Texas donnerait une Réunion
        // grande comme l'Espagne.
        const home = union(features.filter((f) => countryOf(f.properties.id) === [...moved][0].cc
            && !groupOf(groups, f.properties.id)).map((f) => bboxes.get(f))) || frame;
        const side = Math.min(home[2] - home[0], home[3] - home[1], frame[2] - frame[0], frame[3] - frame[1]) * INSET_SIZE;
        const gap = side * 0.12;
        let x = frame[0];
        const y = frame[1] - gap - side;
        for (const g of moved) {
            const members = features.filter((f) => groupOf(groups, f.properties.id) === g);
            const box = union(insets.get(g).map((f) => bboxes.get(f)));
            const scale = Math.min(INSET_MAX_ZOOM, side / Math.max(box[2] - box[0], box[3] - box[1], 1e-6));
            const fn = (px, py) => [x + (px - box[0]) * scale, y + (py - box[1]) * scale];
            for (const f of members) {
                out.push({ type: 'Feature', properties: { name: f.properties.id }, geometry: transformGeometry(f.geometry, fn) });
            }
            keyParts.push(`${g.cc}:${g.name}@${x.toFixed(3)},${y.toFixed(3)},${scale.toFixed(4)}`);
            x += side + gap;
        }
        bounds = union([frame, [frame[0], y, x - gap, frame[1]]]);
    }
    const name = register(echarts, keyParts.join('|'), out);
    return {
        name,
        bounds: [[bounds[0], bounds[3]], [bounds[2], bounds[1]]],
        aspectScale: aspectOf(bounds),
        nameOf: (id) => zoneName(id) || id,
        levelNoun: (n) => levelNoun(level, countries, n),
    };
}

function composeEmpty(echarts, level) {
    if (level !== 'country') return { error: true };
    const entry = loadFile('countries.json');
    if (entry.error) return { error: true };
    if (!entry.data) return { loading: true };
    const out = entry.data.features.map((f) => ({ type: 'Feature', properties: { name: f.properties.id }, geometry: f.geometry }));
    return { name: register(echarts, 'country|*', out), bounds: null, nameOf: (id) => zoneName(id) || id, levelNoun: (n) => levelNoun(level, [], n) };
}

function register(echarts, key, features) {
    const known = maps.get(key);
    if (known) return known;
    const name = 'mgz-' + hashKey(key);
    echarts.registerMap(name, { type: 'FeatureCollection', features });
    if (maps.size >= MAP_CACHE_MAX) maps.delete(maps.keys().next().value);
    maps.set(key, name);
    return name;
}

// Emprise d'une zone (lien vers la carte : cadrer la zone cliquée).
export function zoneBounds(id) {
    for (const [feature, box] of bboxes) {
        if (feature.properties.id === id) return box;
    }
    return null;
}
