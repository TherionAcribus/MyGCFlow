// Couche de zones colorées des cartes « Mes Géocaches » et « Évolution »
// (onglet Zones, docs/carte-zones.md › Couche de la carte).
//
// Les zones (pays, régions, départements…) se colorent jour après jour
// pendant l'aperçu et dans la vidéo. Les valeurs viennent de zone_model.mjs,
// le même calcul que les mini-cartes de la page Statistiques ; les ids de
// zones sont posés dans chaque point par le serveur (zones.py,
// bdd.create_geojson) ; les contours viennent de zone_geo.js.
//
// Branchements (mapgl.js), comme les panneaux Stats :
//   resetZonesForAnimation   départ (aperçu, deux pipelines vidéo)
//   accumulateZonesForDates  lot de jours affichés (fondus)
//   seekZonesToDate          saut de la barre de chronologie (sans fondu)
//   showZonesRest            arrêt : état final
//   updateZoneLayer          chaque rendu : fondus en cours, données changées
//   addZoneLegendToCanvas    légende peinte dans la vidéo
//
// L'échelle de couleurs est calculée sur l'état à la FIN de l'animation :
// une teinte garde le même sens tout du long.
//
// Données : l'index des trouvailles (« Mes Géocaches », cumul) ou la
// sélection du jeu ouvert (« Évolution », caches actives : une zone pâlit
// quand ses caches sont archivées).
//
// Part trouvée (`found_share`, croisement d'un jeu Évolution et de mes
// trouvailles) : sur « Évolution », la sélection du jeu ouvert croisée avec
// mes trouvailles (GET /api/stats/finds) ; sur « Mes Géocaches », le jeu
// choisi dans l'onglet, agrégé par le serveur (GET /api/stats/found_share,
// zone_share.py) — la carte ne charge pas ses centaines de milliers de caches.
//
// Affichage : préférence globale par page (`zones_display`,
// `evolution_zones_display`) ; apparence : thème (pkg.options.zones,
// zone_layer_model.mjs).

import * as pkg from './index.js';
import { t } from './notifications.js';
import { isEvolutionPage, isMainPage } from './app_mode.mjs';
import { findsTable, tableFromRecords } from './chart_sources.mjs';
import { foundDaysOf, mixedZoneTable } from './chart_zones.mjs';
import { ZONE_COLUMNS, createShareState, createZoneState, shareEventsOfTable, shareScaleThresholds, zoneScale } from './zone_model.mjs';
import { addGeoListener, fallbackCountries, retryZoneGeo, zoneFeatures, zoneName, zoneProps } from './zone_geo.js';
import { cellArea, cellLabel, cellRing, withGridColumn } from './zone_grid.mjs';
import { dayNumberOfDate, ymdOfDay } from './stats_model.mjs';
import {
    LEGEND_STYLE, ZONE_LAYER_DENSITY_MEASURES, classColors, dayOfDate, fadeProgress, legendEntries,
    legendOrigin, legendSize, mixHex, normalizeZoneLayerOptions, rgbaOf, zoneMeasureFor,
} from './zone_layer_model.mjs';

// Sous le trait (1000), les points (1001) et les flashs : au-dessus du fond.
const LAYER_Z_INDEX = 500;
// Révisions de l'index en rafale au rechargement : on attend qu'il se pose.
const REBUILD_DELAY_MS = 300;
const OUTLINE = 'rgba(40, 52, 66, 0.35)';
const EMPTY_OUTLINE = 'rgba(40, 52, 66, 0.18)';

let layer = null;
let featuresKey = null;
let model = null;            // { key, revision, state, countries, level }
let scale = null;            // zone_model.mjs › zoneScale
let scaleKey = null;
const classes = new Map();   // id → classe affichée
const fades = new Map();     // id → { from, start, rise }
let clock = 0;
let animating = false;
let refDay = null;           // jour de référence de l'échelle (fin)
let shownDay = null;
let status = 'off';          // off | loading | ready | error | empty
let revision = 0;            // signature vidéo (pipeline MediaRecorder)
let rebuildTimer = 0;
const styleCache = new Map();
let legendCanvas = null;
let legendKey = '';

const opts = () => normalizeZoneLayerOptions(pkg.options?.zones);

// Densité effective : la case « Par km² » peut rester cochée pour une
// mesure qui ne se compte pas — elle n'est appliquée que pour celles de
// ZONE_LAYER_DENSITY_MEASURES (le reste affiche la valeur brute).
const densityOf = (o) => o.perKm2 && ZONE_LAYER_DENSITY_MEASURES.includes(o.measure);

// Page qui a une couche de zones : 'main', 'evolution' ou null.
export function zoneLayerPage() {
    if (isMainPage()) return 'main';
    if (isEvolutionPage()) return 'evolution';
    return null;
}

// Préférence d'affichage de la page.
export function zoneDisplayKey() {
    return zoneLayerPage() === 'evolution' ? 'evolution_zones_display' : 'zones_display';
}

function enabled() {
    return zoneLayerPage() !== null && window.userSettings?.[zoneDisplayKey()] === true;
}

// Révision des données de la page (index des trouvailles, sélection du jeu).
function dataRevision() {
    if (zoneLayerPage() === 'evolution') return pkg.evolutionStatsIndex?.()?.revision ?? 0;
    return Number(pkg.pointsByDateRevision) || 0;
}

function getMap() {
    try { return pkg.getMap?.() || null; } catch (_) { return null; }
}

// Jour de fin : celle de l'animation, sinon la dernière trouvaille (le
// jour de repos du jeu en Évolution).
function endDay() {
    if (zoneLayerPage() === 'evolution') {
        const rest = pkg.evolutionZoneTable?.()?.restDay;
        return Number.isFinite(rest) ? rest : model?.state?.extent?.last ?? null;
    }
    const end = pkg.options?.animation?.dateEnd instanceof Date ? pkg.options.animation.dateEnd : pkg.metadata?.endDate;
    const day = end instanceof Date ? dayOfDate(end) : (end ? dayOfDate(new Date(end)) : null);
    return Number.isFinite(day) ? day : model?.state?.extent?.last ?? null;
}

// ---------------------------------------------------------------------------
// Données : index des points → table → état zone_model

function propsOf(feature) {
    return feature?.properties || feature?.getProperties?.() || {};
}

// ---------------------------------------------------------------------------
// Part trouvée : données attendues (jeu agrégé, ou mes trouvailles)

const SHARE_CACHE_MAX = 4;
const shareCache = new Map();   // url → { status, events, ids, rows, etag, rev, version }
let findsEntry = null;          // { status, found, version }

function readShare(entry, payload, etag) {
    const p = payload || {};
    const col = (name) => Int32Array.from(Array.isArray(p[name]) ? p[name] : []);
    entry.events = {
        day: col('day'), zone: col('zone'), placed: col('placed'),
        archived: col('archived'), found: col('found'), lost: col('lost'),
    };
    entry.ids = Array.isArray(p.ids) ? p.ids : [];
    entry.rows = p.counts?.caches || 0;
    entry.etag = etag;
    entry.status = 'ready';
}

// Charge (ou revalide quand les données de la page ont changé) les
// événements agrégés d'un jeu. Une revalidation garde l'entrée prête : la
// couche ne clignote pas à chaque filtre.
function shareEntry(url, rev) {
    let entry = shareCache.get(url);
    if (!entry) {
        entry = { status: 'loading', version: 0, rev: null, fetching: false };
        shareCache.set(url, entry);
        while (shareCache.size > SHARE_CACHE_MAX) shareCache.delete(shareCache.keys().next().value);
    }
    if (entry.rev === rev || entry.fetching) return entry;
    entry.rev = rev;
    entry.fetching = true;
    const done = () => {
        entry.fetching = false;
        entry.version++;
        refreshZoneLayer();
    };
    fetch(url, { headers: { Accept: 'application/json' } }).then(async (response) => {
        if (response.status === 404) {
            entry.status = 'missing';
            return done();
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const etag = response.headers.get('ETag');
        // Même version (revalidation après un filtre) : rien à relire.
        if (etag && etag === entry.etag && entry.status === 'ready') {
            entry.fetching = false;
            return undefined;
        }
        readShare(entry, await response.json(), etag);
        return done();
    }).catch((e) => {
        console.warn('[zones] Part trouvée indisponible :', e?.message || e);
        // Une revalidation ratée garde la version déjà affichée.
        if (entry.status !== 'ready') entry.status = 'error';
        done();
    });
    return entry;
}

// Mes trouvailles (code → jour de la première), pour la page Évolution.
function findsDays() {
    if (findsEntry) return findsEntry;
    const entry = { status: 'loading', found: null, version: 0 };
    findsEntry = entry;
    fetch('/api/stats/finds', { headers: { Accept: 'application/json' } })
        .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then((payload) => {
            entry.found = foundDaysOf(findsTable(payload));
            entry.status = 'ready';
        })
        .catch((e) => {
            console.warn('[zones] Trouvailles indisponibles :', e?.message || e);
            entry.status = 'error';
        })
        .finally(() => {
            entry.version++;
            refreshZoneLayer();
        });
    return entry;
}

// Pays des contours à charger, d'après les ids de zones (« FR-29 » → FR).
const countriesOfIds = (ids) => [...new Set(ids.filter(Boolean).map((id) => String(id).split('-')[0]))].sort();

function waiting(key, rev, level, wait) {
    model = { key, wait, revision: rev, level, countries: [], rows: 0 };
    return model;
}

function buildShareModel(o, rev, fallback, zoneTable) {
    if (zoneLayerPage() === 'evolution') {
        const finds = findsDays();
        const key = ['share', 'evolution', rev, o.level, o.gridSize, o.shareBase, fallback ? 'f' : '-', finds.version].join('|');
        if (model?.key === key) return model;
        if (finds.status !== 'ready') return waiting(key, rev, o.level, finds.status);
        const source = pkg.evolutionZoneTable?.();
        const raw = source?.table || { n: 0, day: new Int32Array(0), endDay: new Float64Array(0), dicts: {} };
        const table = zoneTable(raw);
        const ids = table.dicts?.[ZONE_COLUMNS[o.level]] || [];
        const events = shareEventsOfTable(table, {
            column: table[ZONE_COLUMNS[o.level]], foundDay: (code) => finds.found.get(code),
        });
        const state = createShareState({ ids, events, base: o.shareBase });
        const countries = (table.dicts?.zone_country || []).filter(Boolean);
        model = { key, revision: rev, state, countries, level: o.level, rows: raw.n, cells: table.dicts.zone_grid || null };
        scaleKey = null;
        return model;
    }
    if (!o.shareDataset) {
        const key = 'share|none|' + rev;
        return model?.key === key ? model : waiting(key, rev, o.level, 'no-dataset');
    }
    let url = '/api/stats/found_share?dataset=' + o.shareDataset + '&level=' + o.level;
    if (o.level === 'grid') url += '&grid=' + o.gridSize;
    const entry = shareEntry(url, rev);
    const key = ['share', 'main', url, o.shareBase, entry.version].join('|');
    if (model?.key === key) {
        // Revalidation sans changement : la couche reste telle quelle.
        model.revision = rev;
        return model;
    }
    if (entry.status !== 'ready') return waiting(key, rev, o.level, entry.status);
    const grid = o.level === 'grid';
    model = {
        key, revision: rev, level: o.level, rows: entry.rows,
        state: createShareState({ ids: entry.ids, events: entry.events, base: o.shareBase }),
        countries: grid ? [] : countriesOfIds(entry.ids), cells: grid ? entry.ids : null,
    };
    scaleKey = null;
    return model;
}

function buildModel() {
    const o = opts();
    const fallback = fallbackCountries();
    const rev = dataRevision();
    // Niveau « grille » : colonne de cases calculée sur les coordonnées.
    const zoneTable = (table) => (o.level === 'grid'
        ? withGridColumn(table, o.gridSize)
        : mixedZoneTable(table, o.level, fallback));
    if (o.measure === 'found_share') return buildShareModel(o, rev, fallback, zoneTable);
    const density = densityOf(o);
    const key = `${zoneLayerPage()}|${rev}|${o.level}|${o.gridSize}|${o.measure}|${density ? 'k' : '-'}|${fallback ? 'f' : '-'}`;
    if (model?.key === key) return model;
    // Densité : surfaces lues à chaque valeur (les contours arrivent après
    // le modèle) ; en grille, la surface d'une case est calculée.
    const areas = density ? (o.level === 'grid' ? cellArea : (id) => zoneProps(id)?.area_km2) : null;
    if (zoneLayerPage() === 'evolution') {
        // Caches actives (sauf « première cache », qui n'a pas de fin).
        const source = pkg.evolutionZoneTable?.();
        const raw = source?.table || { n: 0, day: new Int32Array(0), endDay: new Float64Array(0), dicts: {} };
        const table = zoneTable(raw);
        const measure = { ...zoneMeasureFor(o.measure), mode: o.measure === 'first_day' ? 'cumulative' : 'active', per: areas ? 'km2' : null };
        const state = createZoneState({ table, level: o.level, measure, areas });
        const countries = (table.dicts?.zone_country || []).filter(Boolean);
        model = { key, revision: rev, state, countries, level: o.level, rows: raw.n, cells: table.dicts.zone_grid || null };
        scaleKey = null;
        return model;
    }
    const records = [];
    for (const byDate of [pkg.pointsByDate, pkg.hiddenPointsByDate]) {
        if (!byDate) continue;
        for (const [dateKey, list] of byDate.entries()) {
            const day = dayNumberOfDate(new Date(dateKey));
            if (!Number.isFinite(day) || !list?.length) continue;
            for (const feature of list) {
                const p = propsOf(feature);
                const [lon, lat] = feature?.geometry?.coordinates
                    || (feature?.getGeometry ? ol.proj.toLonLat(feature.getGeometry().getCoordinates()) : []);
                records.push({
                    day, lat, lon,
                    zone_country: p.zone_country, zone_region: p.zone_region, zone_subregion: p.zone_subregion,
                    cache_type: p.cache_type, difficulty: p.difficulty, terrain: p.terrain, code: p.gc_code,
                });
            }
        }
    }
    const table = zoneTable(tableFromRecords(records, { source: 'finds' }));
    const state = createZoneState({ table, level: o.level, measure: { ...zoneMeasureFor(o.measure), per: areas ? 'km2' : null }, areas });
    const countries = (table.dicts?.zone_country || []).filter(Boolean);
    model = { key, revision: rev, state, countries, level: o.level, rows: records.length, cells: table.dicts.zone_grid || null };
    scaleKey = null;
    return model;
}

// ---------------------------------------------------------------------------
// Contours → features OpenLayers

function ensureLayer(map) {
    if (!layer) {
        layer = new ol.layer.Vector({
            source: new ol.source.Vector(),
            style: styleFor,
            zIndex: LAYER_Z_INDEX,
            updateWhileAnimating: true,
            updateWhileInteracting: true,
        });
        layer.set('name', 'zones');
    }
    if (!map.getLayers().getArray().includes(layer)) map.addLayer(layer);
    return layer;
}

function ensureFeatures(level, countries) {
    if (level === 'grid') return ensureGridFeatures();
    const geo = zoneFeatures(level, countries);
    if (geo.status !== 'ready') return geo.status;
    const key = level + '|' + countries.join(',');
    if (featuresKey === key) return 'ready';
    const format = new ol.format.GeoJSON({ featureProjection: 'EPSG:3857' });
    const list = format.readFeatures({ type: 'FeatureCollection', features: geo.features });
    for (const feature of list) feature.setId(feature.get('id'));
    const source = layer.getSource();
    source.clear(true);
    source.addFeatures(list);
    featuresKey = key;
    return 'ready';
}

// Grille : une case par id présent dans les données, calculée
// (zone_grid.mjs), sans fichier de contours.
function ensureGridFeatures() {
    const key = 'grid|' + model.key;
    if (featuresKey === key) return 'ready';
    const list = [];
    for (const id of model.cells || []) {
        const ring = cellRing(id);
        if (!ring) continue;
        const feature = new ol.Feature(new ol.geom.Polygon([ring.map((c) => ol.proj.fromLonLat(c))]));
        feature.setId(id);
        list.push(feature);
    }
    const source = layer.getSource();
    source.clear(true);
    source.addFeatures(list);
    featuresKey = key;
    return 'ready';
}

// ---------------------------------------------------------------------------
// Classes et fondus

function computeScale() {
    const o = opts();
    const day = endDay();
    const key = `${model.key}|${day}|${o.scale}|${o.classes}`;
    if (scaleKey === key) return;
    refDay = day;
    const values = model.state.seek(day ?? Infinity).values();
    // Part trouvée : échelle fixe 0–100 % (seuils ronds de
    // shareScaleThresholds), le réglage « Échelle des couleurs » est sans
    // effet et l'onglet le grise comme pour une date.
    const share = o.measure === 'found_share';
    scale = zoneScale(values, {
        mode: o.measure === 'first_day' ? 'year' : share ? 'fixed' : o.scale,
        classes: o.classes,
        thresholds: share ? shareScaleThresholds(o.classes) : [],
    });
    scaleKey = key;
    model.state.drainChanged();
    shownDay = null;
}

const classOfValue = (v) => (scale && v !== null && v !== undefined ? scale.classOf(v) : null);

function colorOf(cls) {
    if (cls === null || cls === undefined) return null;
    return classColors(opts().color, scale?.classes || 1)[cls] || null;
}

// Couleur affichée d'une zone à l'instant `now` (fondu compris).
function displayedColor(id, now) {
    const target = colorOf(classes.get(id));
    const fade = fades.get(id);
    if (!fade) return target;
    const k = fadeProgress(fade.start, now);
    if (k >= 1) return target;
    if (fade.from === null) return target;
    if (target === null) return fade.from;
    return mixHex(fade.from, target, k);
}

// État complet au jour `day`, sans fondu (départ, saut, repos).
function showDay(day) {
    const state = model.state;
    state.seek(day ?? Infinity);
    state.drainChanged();
    classes.clear();
    fades.clear();
    for (const [id, v] of state.values()) {
        const cls = classOfValue(v);
        if (cls !== null) classes.set(id, cls);
    }
    shownDay = day;
    touch();
}

// Avancée au jour `day` : les zones qui changent de classe passent en fondu.
function advanceTo(day, now) {
    const state = model.state;
    state.seek(day);
    shownDay = day;
    let changed = false;
    for (const id of state.drainChanged()) {
        const cls = classOfValue(state.valueOf(id));
        const prev = classes.has(id) ? classes.get(id) : null;
        if (cls === prev) continue;
        const from = displayedColor(id, now);
        if (cls === null) classes.delete(id);
        else classes.set(id, cls);
        fades.set(id, { from, start: now, rise: prev === null || (cls !== null && cls > prev) });
        changed = true;
    }
    if (changed) touch();
}

function touch() {
    revision++;
    layer?.changed();
}

// ---------------------------------------------------------------------------
// Style

function staticStyle(cls) {
    const o = opts();
    const key = `${cls}|${o.color}|${o.opacity}|${o.outline}|${scale?.classes}`;
    let style = styleCache.get(key);
    if (!style) {
        const color = colorOf(cls);
        style = new ol.style.Style({
            fill: color ? new ol.style.Fill({ color: rgbaOf(color, o.opacity / 100) }) : undefined,
            stroke: o.outline ? new ol.style.Stroke({ color: color ? OUTLINE : EMPTY_OUTLINE, width: color ? 0.8 : 0.6 }) : undefined,
        });
        if (styleCache.size > 200) styleCache.clear();
        styleCache.set(key, style);
    }
    return style;
}

function styleFor(feature) {
    const id = feature.getId();
    const fade = fades.get(id);
    const cls = classes.has(id) ? classes.get(id) : null;
    if (!fade || fadeProgress(fade.start, clock) >= 1) {
        return cls === null && !opts().outline ? null : staticStyle(cls);
    }
    const o = opts();
    const k = fadeProgress(fade.start, clock);
    const target = colorOf(cls);
    const alpha = o.opacity / 100;
    let fill;
    if (fade.from === null && target) fill = rgbaOf(target, alpha * k);
    else if (target === null && fade.from) fill = rgbaOf(fade.from, alpha * (1 - k));
    else fill = rgbaOf(mixHex(fade.from, target, k), alpha);
    let stroke = o.outline ? new ol.style.Stroke({ color: OUTLINE, width: 0.8 }) : undefined;
    // Éclat : le contour s'allume puis s'éteint quand la zone monte de classe.
    if (o.glow && fade.rise && target) {
        stroke = new ol.style.Stroke({ color: rgbaOf(target, 0.25 + 0.7 * (1 - k)), width: 1 + 3.5 * (1 - k) });
    }
    return new ol.style.Style({ fill: new ol.style.Fill({ color: fill }), stroke });
}

// ---------------------------------------------------------------------------
// Légende (à l'écran : canvas dans #mapWithFrames ; vidéo : même dessin)

function legendTitle() {
    const o = opts();
    const evolution = zoneLayerPage() === 'evolution';
    // Densité : même unité que les mini-cartes Statistiques, pour 1 000 km².
    const unit = densityOf(o) ? ' ' + t('/ 1 000 km²') : '';
    if (o.measure === 'distinct_types') return t('Types de caches différents') + unit;
    if (o.measure === 'dt_coverage') return t('Combinaisons D/T');
    if (o.measure === 'first_day') return evolution ? t('Première cache posée') : t('Première trouvaille');
    if (o.measure === 'found_share') {
        return o.shareBase === 'all' ? t('Part des caches publiées trouvées') : t('Part des caches actives trouvées');
    }
    return (evolution ? t('Caches actives') : t('Trouvailles')) + unit;
}

function legendModel() {
    const o = opts();
    if (!o.legend || status !== 'ready' || !scale || scale.min === null) return null;
    const lang = document.documentElement.lang || 'fr';
    const density = densityOf(o);
    // Densité : bornes en valeurs/km², affichées pour 1 000 km² (2 chiffres
    // significatifs : « 0,44 », « 29 »).
    const fmt = new Intl.NumberFormat(lang, density ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 0 });
    const entries = legendEntries(scale, o, {
        formatNumber: (v) => fmt.format(density ? v * 1000 : v),
        percent: o.measure === 'found_share',
        float: density,
    });
    return entries.length ? { title: legendTitle(), entries, position: o.legendPosition } : null;
}

const FONT = () => getComputedStyle(document.body).fontFamily || 'sans-serif';

function measureFn(ctx) {
    return (text, size) => {
        ctx.font = `${size === LEGEND_STYLE.titleSize ? '600 ' : ''}${size}px ${FONT()}`;
        return ctx.measureText(text).width;
    };
}

// Dessine la légende dans `ctx`, coin haut-gauche (x, y), à l'échelle `k`.
function drawLegend(ctx, legend, size, x, y, k) {
    const s = LEGEND_STYLE;
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.fillStyle = dark ? 'rgba(24, 30, 38, 0.86)' : 'rgba(255, 255, 255, 0.88)';
    ctx.beginPath();
    ctx.roundRect(0, 0, size.width, size.height, s.radius);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = dark ? '#e6ebf1' : '#1f2b38';
    ctx.font = `600 ${s.titleSize}px ${FONT()}`;
    ctx.fillText(legend.title, s.padding, s.padding + s.row / 2);
    ctx.font = `${s.labelSize}px ${FONT()}`;
    legend.entries.forEach((entry, i) => {
        const cy = s.padding + s.row * (i + 1) + s.row / 2;
        ctx.fillStyle = rgbaOf(entry.color, Math.max(0.55, opts().opacity / 100));
        ctx.fillRect(s.padding, cy - s.swatch / 2, s.swatch, s.swatch);
        ctx.fillStyle = dark ? '#c9d1db' : '#3b4757';
        ctx.fillText(entry.label, s.padding + s.swatch + s.gap, cy);
    });
    ctx.restore();
}

function syncLegend() {
    const host = document.getElementById('mapWithFrames');
    const legend = enabled() ? legendModel() : null;
    const key = legend ? JSON.stringify(legend) + '|' + opts().opacity + '|' + document.documentElement.getAttribute('data-bs-theme') : '';
    if (!legend) {
        if (legendCanvas) legendCanvas.hidden = true;
        legendKey = '';
        return;
    }
    if (!host) return;
    if (!legendCanvas) {
        legendCanvas = document.createElement('canvas');
        legendCanvas.id = 'zoneLegend';
        legendCanvas.className = 'zone-legend';
        legendCanvas.setAttribute('role', 'img');
        const map = document.getElementById('map');
        host.insertBefore(legendCanvas, map ? map.nextSibling : host.firstChild);
    }
    legendCanvas.hidden = false;
    legendCanvas.setAttribute('aria-label', legend.title + ' : ' + legend.entries.map((e) => e.label).join(', '));
    if (key === legendKey) return;
    legendKey = key;
    const ctx = legendCanvas.getContext('2d');
    const size = legendSize(legend.entries, legend.title, measureFn(ctx));
    const dpr = window.devicePixelRatio || 1;
    legendCanvas.width = Math.ceil(size.width * dpr);
    legendCanvas.height = Math.ceil(size.height * dpr);
    legendCanvas.style.width = size.width + 'px';
    legendCanvas.style.height = size.height + 'px';
    const m = LEGEND_STYLE.margin + 'px';
    const [vertical, horizontal] = legend.position.split('-');
    legendCanvas.style.top = vertical === 'top' ? m : '';
    legendCanvas.style.bottom = vertical === 'bottom' ? m : '';
    legendCanvas.style.left = horizontal === 'left' ? m : '';
    legendCanvas.style.right = horizontal === 'right' ? m : '';
    ctx.clearRect(0, 0, legendCanvas.width, legendCanvas.height);
    drawLegend(ctx, legend, size, 0, 0, dpr);
    revision++;
}

// Légende dans une image de la vidéo (w × h, échelle `scaleFactor`).
export function addZoneLegendToCanvas(ctx, w, h, scaleFactor = 1) {
    if (!enabled() || !layer?.getVisible()) return;
    const legend = legendModel();
    if (!legend) return;
    const size = legendSize(legend.entries, legend.title, measureFn(ctx));
    const scaled = { width: size.width * scaleFactor, height: size.height * scaleFactor };
    const origin = legendOrigin(legend.position, scaled, w, h, LEGEND_STYLE.margin * scaleFactor);
    drawLegend(ctx, legend, size, origin.x, origin.y, scaleFactor);
}

// ---------------------------------------------------------------------------
// Cycle de vie

// Prépare la couche : données, contours, échelle. Vrai si elle est prête.
function prepare() {
    const map = getMap();
    if (!enabled() || !map) {
        if (layer) layer.setVisible(false);
        status = 'off';
        syncLegend();
        return false;
    }
    const m = buildModel();
    ensureLayer(map);
    // Part trouvée : jeu agrégé ou trouvailles pas encore là, jeu à choisir.
    if (m.wait) {
        status = m.wait;
        layer.setVisible(false);
        syncLegend();
        return false;
    }
    if (!m.rows) {
        status = 'empty';
        layer.setVisible(false);
        syncLegend();
        return false;
    }
    const geo = ensureFeatures(m.level, m.countries);
    status = geo;
    if (geo !== 'ready') {
        layer.setVisible(false);
        syncLegend();
        return false;
    }
    computeScale();
    layer.setVisible(true);
    return true;
}

// Options, préférence ou données changées : tout est recalculé, la couche
// montre le jour courant (animation) ou l'état final (repos).
export function refreshZoneLayer() {
    styleCache.clear();
    // Jour lu avant la reconstruction : computeScale efface shownDay, et un
    // réglage changé pendant un aperçu (ou des contours arrivés en route)
    // ne doit pas ramener la couche au jour de fin.
    const day = animating ? shownDay : null;
    if (prepare()) showDay(day ?? endDay());
    syncLegend();
    // Ligne d'état de l'onglet (données arrivées après coup).
    pkg.syncZoneStatus?.();
}

// Bouton « Réessayer » de l'onglet Zones (ligne d'état en erreur) : les
// chargements en échec — contours (zone_geo), jeu agrégé ou trouvailles
// (part trouvée) — repartent à zéro, puis la couche se reconstruit.
// « missing » (jeu supprimé) n'est pas retenté : il faut un autre choix.
export function retryZoneLayer() {
    // D'abord les caches de données (le notify() de retryZoneGeo relance
    // déjà un refreshZoneLayer via les écouteurs).
    for (const [url, entry] of shareCache) {
        if (entry.status === 'error') shareCache.delete(url);
    }
    if (findsEntry?.status === 'error') findsEntry = null;
    retryZoneGeo();
    refreshZoneLayer();
}

// Réglages d'apparence seuls (couleur, opacité, contours, lueur, légende) :
// ni les données ni l'échelle ne changent — on repeint, sans reconstruire
// le modèle ni reclasser les zones (curseur d'opacité suivi en direct).
export function refreshZoneLayerAppearance() {
    styleCache.clear();
    touch();
    syncLegend();
}

// `startDate` : début effectif de l'animation (mapgl.js › animationStartDate).
export function resetZonesForAnimation({ startDate = null } = {}) {
    animating = true;
    if (!prepare()) return;
    const start = startDate instanceof Date ? dayOfDate(startDate) : null;
    showDay(Number.isFinite(start) ? start - 1 : -Infinity);
    syncLegend();
}

export function accumulateZonesForDates(dates, now) {
    if (!animating || status !== 'ready' || !dates?.length || !model) return;
    if (Number.isFinite(now)) clock = now;
    const day = dayNumberOfDate(dates[dates.length - 1]);
    if (Number.isFinite(day)) advanceTo(day, clock);
}

export function seekZonesToDate(date) {
    if (status !== 'ready' || !model) return;
    const day = date instanceof Date ? dayOfDate(date) : null;
    if (Number.isFinite(day)) showDay(day);
}

export function showZonesRest() {
    animating = false;
    if (status === 'ready' && model) showDay(endDay());
}

// À chaque rendu : fondus en cours (vrai = encore une frame), données
// changées depuis le dernier calcul (rechargement, filtre).
export function updateZoneLayer(now) {
    if (Number.isFinite(now)) clock = now;
    // Fin naturelle de l'aperçu (sans passage par l'arrêt) : la carte garde
    // son état final, la couche aussi, mais elle redevient « au repos ».
    if (animating && pkg.isAnimationInProgress?.() === false) animating = false;
    if (!animating && enabled() && model && model.revision !== dataRevision()) {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(refreshZoneLayer, REBUILD_DELAY_MS);
    }
    if (!fades.size) return false;
    let running = false;
    for (const [id, fade] of fades) {
        if (fadeProgress(fade.start, clock) >= 1) fades.delete(id);
        else running = true;
    }
    touch();
    return running;
}

export function getZoneLayerRevision() {
    return revision;
}

// ---------------------------------------------------------------------------
// Fiche de zone au clic (mapgl.js › inspectZoneAt)

// Date du jour montré (aperçu en pause : jour courant ; repos : jour de fin).
function shownDate() {
    if (!Number.isFinite(shownDay)) return null;
    const { y, m, d } = ymdOfDay(shownDay);
    return new Date(y, m - 1, d);
}

// Contenu de la fiche de la zone sous le pixel : nom, date du jour montré,
// valeur de la mesure active et détail éventuel (comptes de la part trouvée).
// Les points et le trait restent prioritaires : mapgl.js n'appelle ceci que
// quand aucun d'eux n'est touché.
export function zonePopupAt(pixel) {
    const map = getMap();
    if (!map || !enabled() || status !== 'ready' || !layer?.getVisible() || !model) return null;
    // Test géométrique et non forEachFeatureAtPixel : celui-ci détecte le
    // style rendu, et une zone sans valeur n'a que sa frontière — son
    // intérieur ne serait pas cliquable.
    const coordinate = map.getCoordinateFromPixel(pixel);
    if (!coordinate) return null;
    const feature = layer.getSource().getFeaturesAtCoordinate(coordinate)[0] || null;
    if (!feature) return null;
    const id = feature.getId();
    const o = opts();
    const evolution = zoneLayerPage() === 'evolution';
    const lang = document.documentElement.lang || 'fr';
    const density = densityOf(o);
    const fmt = new Intl.NumberFormat(lang, density ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 });
    const title = (o.level === 'grid' ? cellLabel(id, { locale: lang }) : zoneName(id)) || String(id);
    const value = model.state.valueOf(id);
    let main;
    let detail = '';
    if (value === null || value === undefined) {
        main = evolution ? t('Aucune cache à ce jour') : t('Aucune trouvaille à ce jour');
    } else if (o.measure === 'first_day') {
        const { y, m, d } = ymdOfDay(value);
        const first = pkg.formatDateDisplay?.(new Date(y, m - 1, d)) || String(value);
        main = evolution ? t('Première cache posée : ${date}', { date: first }) : t('Première trouvaille : ${date}', { date: first });
    } else if (o.measure === 'distinct_types') {
        main = density
            ? t('${n} types de caches / 1 000 km²', { n: fmt.format(value * 1000) })
            : t('${n} types de caches', { n: fmt.format(value) });
    } else if (o.measure === 'dt_coverage') {
        main = t('${n} combinaisons D/T sur 81', { n: fmt.format(value) });
    } else if (o.measure === 'found_share') {
        main = fmt.format(value) + ' %';
        const part = model.state.parts?.(id);
        if (part) detail = t('${n} sur ${of} caches', { n: fmt.format(part[0]), of: fmt.format(part[1]) });
    } else if (density) {
        main = evolution
            ? t('${n} caches actives / 1 000 km²', { n: fmt.format(value * 1000) })
            : t('${n} trouvailles / 1 000 km²', { n: fmt.format(value * 1000) });
    } else {
        main = evolution ? t('${n} caches actives', { n: fmt.format(value) }) : t('${n} trouvailles', { n: fmt.format(value) });
    }
    const date = shownDate();
    return {
        title, main, detail,
        subtitle: date ? t('Au ${date}', { date: pkg.formatDateDisplay?.(date) || '' }) : '',
    };
}

// Relevé E2E. `values` : dans l'unité affichée (pour 1 000 km² en densité).
export function getZoneLayerDebugState() {
    const density = densityOf(opts());
    const values = model?.state
        ? Object.fromEntries([...model.state.values()].map(([id, v]) => [id, density ? v * 1000 : v])) : {};
    // Part trouvée : [trouvées, base] par zone.
    const parts = model?.state?.parts
        ? Object.fromEntries(Object.keys(values).map((id) => [id, model.state.parts(id)])) : null;
    return {
        parts,
        enabled: enabled(),
        status,
        visible: Boolean(layer?.getVisible()),
        onMap: Boolean(layer && getMap()?.getLayers().getArray().includes(layer)),
        options: opts(),
        level: model?.level ?? null,
        countries: model?.countries ?? [],
        features: layer ? layer.getSource().getFeatures().length : 0,
        day: shownDay,
        refDay,
        animating,
        values,
        classes: Object.fromEntries(classes),
        fading: fades.size,
        scale: scale ? { mode: scale.mode, breaks: scale.breaks, classes: scale.classes } : null,
        legend: legendCanvas && !legendCanvas.hidden ? legendModel() : null,
        revision,
    };
}

// ---------------------------------------------------------------------------
// Démarrage : contours arrivés → recalcul ; préférences prêtes au jalon
// mygcflow:ready. S'initialise lui-même (cf. AGENTS.md, ordre d'évaluation).

function initZoneLayer() {
    if (!zoneLayerPage()) return;
    addGeoListener(() => { if (enabled()) refreshZoneLayer(); });
    refreshZoneLayer();
}

if (window.mygcflowReady) {
    initZoneLayer();
} else {
    window.addEventListener('mygcflow:ready', initZoneLayer, { once: true });
}
