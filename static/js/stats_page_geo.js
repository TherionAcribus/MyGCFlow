// Page Statistiques : cartes ECharts des cartes par zones.
//
// Les contours sont chargés par zone_geo.js (partagé avec la couche de zones
// de la carte). Pour chaque carte, une carte ECharts est composée (zones du
// cadrage, encarts des territoires lointains) et enregistrée
// (echarts.registerMap) ; chart_echarts.mjs › mapOption la dessine.
//
// Rien ne bloque : tant que les contours manquent, zoneMapFor répond
// { loading: true } et la carte affiche « Chargement… » ; à l'arrivée,
// l'écouteur posé par setGeoListener redessine.

import {
    addGeoListener, featureBBox, geoFailed, geoIndex, levelNoun, loadFile, loadIndex, requiredFiles, zoneName, zoneProps,
} from './zone_geo.js';

import { cellLabel, cellRing } from './zone_grid.mjs';

export {
    fallbackCountries, zoneAreas, zoneName,
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

// Carte prête pour un résultat ({ name, bounds, nameOf, levelNoun }), ou
// { loading: true } / { error: true }.
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
    if (level === 'grid') return composeGrid(echarts, result);
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

// Grille : les cases qui ont une valeur, calculées (zone_grid.mjs).
function composeGrid(echarts, result) {
    const lang = String(document.documentElement.lang || 'fr');
    const features = [];
    for (const id of result.keys) {
        const ring = cellRing(id);
        if (ring) features.push({ type: 'Feature', properties: { name: id }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    if (!features.length) return { empty: true };
    const frame = union(features.flatMap((f) => f.geometry.coordinates[0].map(([x, y]) => [x, y, x, y])));
    const w = frame[2] - frame[0] || 1;
    const h = frame[3] - frame[1] || 1;
    const bounds = [frame[0] - w * FRAME_MARGIN, frame[1] - h * FRAME_MARGIN, frame[2] + w * FRAME_MARGIN, frame[3] + h * FRAME_MARGIN];
    // Repères : les régions des pays présents, dessinées SOUS les cases
    // (sans donnée, donc sans couleur) — sans elles, les cases flottent.
    const countries = result.zones.countries || [];
    let backdrop = [];
    if (countries.length && !geoFailed()) {
        if (!geoIndex()) {
            loadIndex();
            return { loading: true };
        }
        const entries = requiredFiles('region', countries).map(loadFile);
        if (entries.some((e) => !e.data && !e.error)) return { loading: true };
        backdrop = entries.filter((e) => e.data).flatMap((e) => e.data.features)
            .filter((f) => intersects(bboxes.get(f), bounds))
            .map((f) => ({ type: 'Feature', properties: { name: f.properties.id }, geometry: f.geometry }));
    }
    const name = register(echarts, 'grid|' + backdrop.length + '|' + result.keys.join(','), [...backdrop, ...features]);
    const english = lang.toLowerCase().startsWith('en');
    return {
        name,
        bounds: [[bounds[0], bounds[3]], [bounds[2], bounds[1]]],
        aspectScale: aspectOf(bounds),
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

