// Page Statistiques : cartes ECharts des cartes par zones.
//
// Les contours sont chargés par zone_geo.js (partagé avec la couche de zones
// de la carte). Pour chaque carte, une carte ECharts est composée (zones du
// cadrage, encarts des territoires lointains) et enregistrée
// (echarts.registerMap) ; chart_echarts.mjs › mapOption la dessine.
//
// Rien ne bloque : tant que les contours manquent, zoneMapFor répond
// { loading: true } et la carte affiche « Chargement… » ; à l'arrivée,
// l'écouteur posé par setGeoListener redessine. Sans aucune zone à cadrer
// (sélection vide en cadrage automatique), il répond { empty: true } et la
// carte affiche « Aucune donnée ».

import {
    addGeoListener, featureBBox, geoFailed, geoIndex, levelNoun, loadFile, loadIndex, requiredFiles, zoneName, zoneProps,
} from './zone_geo.js';

import { cellLabel, cellRing } from './zone_grid.mjs';
import { mapFrameContinent, mapFrameCountry } from './chart_spec.mjs';

export {
    fallbackCountries, geoFilesFailed, retryZoneGeo, zoneAreas, zoneName,
} from './zone_geo.js';
import { zoneBounds as geoZoneBounds } from './zone_geo.js';

// Emprise d'une zone (lien vers la carte) : contours chargés, ou case de
// grille calculée.
export function zoneBounds(id) {
    const ring = cellRing(id);
    if (ring) return union(ring.map(([x, y]) => [x, y, x, y]));
    return geoZoneBounds(id);
}

// Marge autour des zones cadrées, en part de la taille du cadre.
const FRAME_MARGIN = 0.04;
// Encarts : côté de chaque boîte, en part du plus petit côté du pays, et
// agrandissement maximal (La Réunion reste petite à côté de la métropole).
const INSET_SIZE = 0.18;
const INSET_MAX_ZOOM = 2.5;
const MAP_CACHE_MAX = 40;

const maps = new Map();       // clé de composition → nom enregistré
const bboxes = { get: featureBBox };

// Un seul écouteur pour la page (stats_page_cards.js redessine).
let unlisten = null;
export function setGeoListener(fn) {
    unlisten?.();
    unlisten = addGeoListener(fn);
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

// Groupe d'encart d'une zone : { cc, name, zones } ou null.
function insetGroups(countries) {
    const groups = [];
    for (const cc of countries) {
        for (const inset of geoIndex().by_country[cc]?.insets || []) groups.push({ cc, ...inset, ids: new Set(inset.zones) });
    }
    return groups;
}

function groupOf(groups, id) {
    const parent = zoneProps(id)?.parent;
    return groups.find((g) => g.ids.has(id) || (parent && g.ids.has(parent))) || null;
}

// Cadrages fixes ([ouest, sud, est, nord]) : le monde et les continents
// (chart_spec.mjs › MAP_CONTINENTS). Ce qui dépasse est découpé.
const FIXED_FRAMES = {
    world: [-180, -58, 180, 84],
    europe: [-25, 27, 45, 71.5],
    northamerica: [-168, 7, -52, 72],
    southamerica: [-82, -56.5, -34, 13.5],
    africa: [-26, -35.5, 58, 38],
    asia: [25, -11, 150, 56],
    oceania: [110, -48, 180, 1],
};

// Pays gardés par le cadrage d'une carte (chart_zones.mjs › frameCountries) :
// null = tous. Un continent attend le catalogue (index.json › continents) ;
// tant qu'il manque, le résultat est calculé sans filtre puis recalculé à son
// arrivée (geoRev entre dans la clé du cache des résultats).
export function frameCountriesOf(spec) {
    const frame = spec?.view?.map?.frame;
    const cc = mapFrameCountry(frame);
    if (cc) return new Set([cc]);
    const continent = mapFrameContinent(frame);
    if (!continent) return null;
    const index = geoIndex();
    if (!index) {
        if (!geoFailed()) loadIndex();
        return null;
    }
    return new Set(Object.entries(index.continents || {}).filter(([, c]) => c === continent).map(([id]) => id));
}

// Découpe d'un anneau par un rectangle (Sutherland–Hodgman, un bord après
// l'autre) : ECharts ne découpe pas une `geo`, une zone qui dépasse du cadre
// déborderait sur les vignettes voisines.
function clipRing(ring, [x0, y0, x1, y1]) {
    const edges = [
        [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
        [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
        [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
        [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
    ];
    let out = ring;
    for (const [inside, cut] of edges) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            if (inside(cur)) {
                if (!inside(prev)) out.push(cut(prev, cur));
                out.push(cur);
            } else if (inside(prev)) {
                out.push(cut(prev, cur));
            }
        }
        if (!out.length) return null;
    }
    return out.length >= 3 ? [...out, out[0]] : null;
}

export function clipGeometry(geometry, box) {
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    const kept = [];
    for (const poly of polys) {
        const outer = clipRing(poly[0], box);
        if (!outer) continue;
        kept.push([outer, ...poly.slice(1).map((ring) => clipRing(ring, box)).filter(Boolean)]);
    }
    if (!kept.length) return null;
    return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
}

// Emprise de la plus grande partie d'un pays (cadrage sur un pays au niveau
// des pays : la France sans la Guyane).
function mainPartBBox(geometry) {
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    let best = null;
    let bestArea = -1;
    for (const poly of polys) {
        const box = union(poly[0].map(([x, y]) => [x, y, x, y]));
        const area = (box[2] - box[0]) * (box[3] - box[1]) * Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
        if (area > bestArea) {
            best = box;
            bestArea = area;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Points d'étiquette (valeurs écrites sur les zones)
//
// [x, y, largeur, hauteur] dans les coordonnées de la carte composée : le
// point intérieur des contours (`ix` / `iy`, posé par build_geo_zones.py) et
// l'emprise de la partie qui le contient — pas celle de toute la zone (la
// France avec la Guyane). La taille décide si la valeur tient dans la zone.

function ringBox(ring) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

const polygonsOf = (geometry) => (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]);
const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const boxHas = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

const anchorCache = new WeakMap();
function anchorOf(f) {
    if (anchorCache.has(f)) return anchorCache.get(f);
    const { ix, iy } = f.properties || {};
    let out = null;
    if (Number.isFinite(ix) && Number.isFinite(iy)) {
        // Plus petite partie qui contient le point (une île dans une baie
        // n'emprunte pas l'emprise de la côte qui l'entoure).
        let best = null;
        for (const poly of polygonsOf(f.geometry)) {
            const box = ringBox(poly[0]);
            if (box && boxHas(box, ix, iy) && (!best || boxArea(box) < boxArea(best))) best = box;
        }
        best ||= bboxes.get(f);
        if (best) out = { x: ix, y: iy, box: best };
    }
    anchorCache.set(f, out);
    return out;
}

const anchorAt = (x, y, box) => [x, y, box[2] - box[0], box[3] - box[1]];

// Zone entière, éventuellement déplacée en encart (`fn`, `scale`).
function placedAnchor(f, fn = null, scale = 1) {
    const a = anchorOf(f);
    if (!a) return null;
    if (!fn) return anchorAt(a.x, a.y, a.box);
    const [x, y] = fn(a.x, a.y);
    return [x, y, (a.box[2] - a.box[0]) * scale, (a.box[3] - a.box[1]) * scale];
}

// Zone découpée par le cadre : le point intérieur s'il y est resté (emprise
// réduite à la partie gardée), sinon le centre de la plus grande partie
// gardée (la Russie d'Europe sur la carte de l'Europe).
function clippedAnchor(f, geometry, frame) {
    const a = anchorOf(f);
    if (a && boxHas(frame, a.x, a.y)) {
        const box = [Math.max(frame[0], a.box[0]), Math.max(frame[1], a.box[1]), Math.min(frame[2], a.box[2]), Math.min(frame[3], a.box[3])];
        return anchorAt(a.x, a.y, box);
    }
    let best = null;
    for (const poly of polygonsOf(geometry)) {
        const box = ringBox(poly[0]);
        if (box && (!best || boxArea(box) > boxArea(best))) best = box;
    }
    return best ? [(best[0] + best[2]) / 2, (best[1] + best[3]) / 2, best[2] - best[0], best[3] - best[1]] : null;
}

function withMargin(box) {
    const w = box[2] - box[0] || 1;
    const h = box[3] - box[1] || 1;
    return [box[0] - w * FRAME_MARGIN, box[1] - h * FRAME_MARGIN, box[2] + w * FRAME_MARGIN, box[3] + h * FRAME_MARGIN];
}

// Carte prête pour un résultat ({ name, bounds, nameOf, levelNoun }), ou
// { loading: true } / { error: true } / { empty: true }.
export function zoneMapFor(result, spec) {
    const echarts = window.echarts;
    const zones = result?.zones;
    if (!zones || !echarts) return { error: true };
    if (geoFailed()) return { error: true };
    if (!geoIndex()) {
        loadIndex();
        return { loading: true };
    }
    const level = zones.level;
    const frameSpec = spec?.view?.map?.frame || 'auto';
    const frameCountry = mapFrameCountry(frameSpec);
    const fixedBox = FIXED_FRAMES[frameSpec] || null;
    if (level === 'grid') return composeGrid(echarts, result, { fixedBox, frameCountry });
    const countries = zones.countries;
    // Pays dessinés : ceux des données, plus le pays du cadrage (montré en
    // entier même sans donnée).
    const drawn = [...new Set([...countries, ...(frameCountry ? [frameCountry] : [])])].sort();
    if (level !== 'country' && !drawn.length && !fixedBox) {
        // Aucune ligne rattachée : rien à cadrer — état vide, pas une erreur
        // de contours (la grille répond { empty: true } dans le même cas).
        return { empty: true };
    }
    // Fond (monde, continent, pays) : les pays voisins, sans couleur.
    const framed = Boolean(fixedBox || frameCountry);
    const backdrop = framed && level !== 'country';
    const rels = [...new Set([...requiredFiles(level, drawn), ...(backdrop ? ['countries.json'] : [])])];
    const entries = rels.map(loadFile);
    if (entries.some((e) => e.error)) return { error: true };
    if (entries.some((e) => !e.data)) return { loading: true };

    const backdropEntry = backdrop ? loadFile('countries.json') : null;
    const features = entries.filter((e) => e !== backdropEntry).flatMap((e) => e.data.features);
    const data = new Set(result.keys);
    const countryOf = (id) => String(id).split('-')[0];
    // Au niveau des pays, un cadrage sur un pays garde ses voisins (fond) ;
    // aux autres niveaux, seules les zones du pays sont dessinées.
    const ofFrame = (f) => !frameCountry || level === 'country' || countryOf(f.properties.id) === frameCountry;
    // Encarts (Outre-mer, Alaska…) : pas sur le monde, où ils sont à leur place.
    const groups = frameSpec === 'world' ? [] : insetGroups(drawn);
    const main = [];
    const insets = new Map();
    const mainCountries = new Set();
    for (const f of features) {
        if (!ofFrame(f)) continue;
        if (!framed && !data.has(f.properties.id)) continue;
        const g = groupOf(groups, f.properties.id);
        if (g) {
            if (!insets.has(g)) insets.set(g, []);
            insets.get(g).push(f);
        } else if (data.has(f.properties.id)) {
            main.push(f);
            mainCountries.add(countryOf(f.properties.id));
        }
    }
    // Encarts déplacés sous le cadre :
    // - pays : tous ceux du pays (le pays en entier) ;
    // - continent : ceux qui ont des données hors de la boîte ;
    // - automatique : ceux d'un pays qui a aussi des zones « normales » avec
    //   des données (la seule Réunion est cadrée telle quelle, et la Réunion
    //   d'une carte des États-Unis reste à sa place).
    for (const g of [...insets.keys()]) {
        const members = insets.get(g);
        let keep;
        if (frameCountry) keep = g.cc === frameCountry;
        else if (fixedBox) keep = members.some((f) => data.has(f.properties.id)) && !members.some((f) => intersects(bboxes.get(f), fixedBox));
        else keep = mainCountries.has(g.cc);
        if (!keep) {
            if (!framed) main.push(...members);
            insets.delete(g);
        }
    }
    const moveInsets = insets.size > 0 && (main.length > 0 || framed);
    let frame;
    if (fixedBox) {
        frame = [...fixedBox];
    } else if (frameCountry) {
        // Le pays en entier (hors encarts), qu'il ait des données ou non.
        const home = level === 'country'
            ? features.filter((f) => f.properties.id === frameCountry).map((f) => mainPartBBox(f.geometry))
            : features.filter((f) => countryOf(f.properties.id) === frameCountry && !groupOf(groups, f.properties.id))
                .map((f) => bboxes.get(f));
        frame = union(home);
        if (frame) frame = withMargin(frame);
    } else if (frameSpec === 'world' || !data.size) {
        frame = withMargin(union(features.map((f) => bboxes.get(f))) || [0, 0, 0, 0]);
    } else {
        const box = union((moveInsets ? main : features.filter((f) => data.has(f.properties.id))).map((f) => bboxes.get(f)));
        frame = box ? withMargin(box) : null;
    }
    if (!frame) return composeEmpty(echarts, level);

    // Zones du cadre (les autres débordaient sur les vignettes voisines),
    // découpées sur un cadrage choisi ; puis les encarts, déplacés sous le
    // cadre, de gauche à droite.
    const out = [];
    const keyParts = [level, frameSpec];
    // Points d'étiquette des zones qui ont une valeur (pas du fond).
    const anchors = new Map();
    const place = (f, geometry, anchor = null) => {
        out.push({ type: 'Feature', properties: { name: f.properties.id }, geometry });
        keyParts.push(f.properties.id);
        if (anchor && data.has(f.properties.id)) anchors.set(f.properties.id, anchor);
    };
    const backdropIds = [];
    if (backdropEntry) {
        const own = new Set(drawn);
        for (const f of backdropEntry.data.features) {
            if (own.has(f.properties.id) || !intersects(bboxes.get(f), frame)) continue;
            const geometry = clipGeometry(f.geometry, frame);
            if (geometry) {
                place(f, geometry);
                backdropIds.push(f.properties.id);
            }
        }
    }
    const moved = moveInsets ? new Set([...insets.keys()]) : new Set();
    for (const f of features) {
        const g = moved.size ? groupOf(groups, f.properties.id) : null;
        if (g && moved.has(g)) continue;
        if (!ofFrame(f) || !intersects(bboxes.get(f), frame)) continue;
        const geometry = framed ? clipGeometry(f.geometry, frame) : f.geometry;
        if (geometry && data.has(f.properties.id)) {
            place(f, geometry, framed ? clippedAnchor(f, geometry, frame) : placedAnchor(f));
        } else if (geometry) {
            place(f, geometry);
        }
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
            const members = insets.get(g);
            const box = union(members.map((f) => bboxes.get(f)));
            const scale = Math.min(INSET_MAX_ZOOM, side / Math.max(box[2] - box[0], box[3] - box[1], 1e-6));
            const fn = (px, py) => [x + (px - box[0]) * scale, y + (py - box[1]) * scale];
            for (const f of members) place(f, transformGeometry(f.geometry, fn), data.has(f.properties.id) ? placedAnchor(f, fn, scale) : null);
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
        // Pays voisins (fond d'un cadrage) : habillés à part, inertes.
        backdrop: backdropIds,
        anchors,
        nameOf: (id) => zoneName(id) || id,
        levelNoun: (n) => levelNoun(level, countries, n),
    };
}

// Grille : les cases qui ont une valeur, calculées (zone_grid.mjs).
function composeGrid(echarts, result, { fixedBox = null, frameCountry = null } = {}) {
    const lang = String(document.documentElement.lang || 'fr');
    const framed = Boolean(fixedBox || frameCountry);
    let features = [];
    for (const id of result.keys) {
        const ring = cellRing(id);
        if (ring) features.push({ type: 'Feature', properties: { name: id }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    if (!features.length && !framed) return { empty: true };
    // Repères : les régions des pays présents (et du pays cadré), dessinées
    // SOUS les cases (sans donnée, donc sans couleur) — sans elles, les
    // cases flottent ; sur un cadrage choisi, les pays voisins en plus.
    const countries = [...new Set([...(result.zones.countries || []), ...(frameCountry ? [frameCountry] : [])])].sort();
    let regions = [];
    let world = null;
    if ((countries.length || framed) && !geoFailed()) {
        if (!geoIndex()) {
            loadIndex();
            return { loading: true };
        }
        const entries = requiredFiles('region', countries).map(loadFile);
        if (framed) world = loadFile('countries.json');
        if ([...entries, ...(world ? [world] : [])].some((e) => !e.data && !e.error)) return { loading: true };
        regions = entries.filter((e) => e.data).flatMap((e) => e.data.features);
    }
    let bounds;
    if (fixedBox) {
        bounds = [...fixedBox];
    } else if (frameCountry) {
        const groups = insetGroups([frameCountry]);
        const home = union(regions.filter((f) => String(f.properties.id).split('-')[0] === frameCountry
            && !groupOf(groups, f.properties.id)).map((f) => bboxes.get(f)));
        if (!home) return features.length ? composeGrid(echarts, result) : { empty: true };
        bounds = withMargin(home);
    } else {
        bounds = withMargin(union(features.flatMap((f) => f.geometry.coordinates[0].map(([x, y]) => [x, y, x, y]))));
    }
    const clip = (f) => {
        const geometry = framed ? clipGeometry(f.geometry, bounds) : f.geometry;
        return geometry ? { type: 'Feature', properties: { name: f.properties.id ?? f.properties.name }, geometry } : null;
    };
    const near = (f) => intersects(bboxes.get(f), bounds);
    const own = new Set(countries);
    const neighbours = (world?.data ? world.data.features.filter((f) => !own.has(f.properties.id) && near(f)) : [])
        .map(clip).filter(Boolean);
    const backdrop = [...neighbours, ...regions.filter(near).map(clip).filter(Boolean)];
    features = features.map(clip).filter(Boolean);
    // Points d'étiquette : centre de la case (ou de ce qui en reste dans le
    // cadre).
    const anchors = new Map();
    for (const f of features) {
        const box = ringBox(polygonsOf(f.geometry)[0][0]);
        if (box) anchors.set(f.properties.name, anchorAt((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box));
    }
    const name = register(echarts, 'grid|' + (fixedBox || frameCountry || 'auto') + '|' + backdrop.length + '|' + result.keys.join(','),
        [...backdrop, ...features]);
    const english = lang.toLowerCase().startsWith('en');
    return {
        name,
        bounds: [[bounds[0], bounds[3]], [bounds[2], bounds[1]]],
        aspectScale: aspectOf(bounds),
        backdrop: neighbours.map((f) => f.properties.name),
        anchors,
        nameOf: (id) => cellLabel(id, { locale: lang, west: english ? 'W' : 'O' }),
        levelNoun: (n) => (english ? 'cells: ' : 'cases : ') + n,
    };
}

function composeEmpty(echarts, level) {
    if (level !== 'country') return { error: true };
    const entry = loadFile('countries.json');
    if (entry.error) return { error: true };
    if (!entry.data) return { loading: true };
    const out = entry.data.features.map((f) => ({ type: 'Feature', properties: { name: f.properties.id }, geometry: f.geometry }));
    // Un cadre (le monde) : sans lui, les proportions de la carte sont
    // inconnues et la vignette s'étirerait à la taille de la tuile.
    const frame = union(entry.data.features.map((f) => bboxes.get(f)));
    return {
        name: register(echarts, 'country|*', out),
        bounds: frame ? [[frame[0], frame[3]], [frame[2], frame[1]]] : null,
        ...(frame ? { aspectScale: aspectOf(frame) } : {}),
        nameOf: (id) => zoneName(id) || id,
        levelNoun: (n) => levelNoun(level, [], n),
    };
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

