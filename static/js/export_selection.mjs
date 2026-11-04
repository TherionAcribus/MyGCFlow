// Export de la sélection filtrée (onglet Données, « Exporter la sélection »).
//
// Fonctions PURES — aucune dépendance DOM ni réseau : l'ensemble à exporter
// est passé en argument (bdd.js lui donne les features affichées, le même
// ensemble que le compteur « n / total »). Testé par
// tests/js/export_selection.test.mjs.
//
// Format CSV aligné sur l'export des panneaux Stats (stats_panels.js) :
// séparateur « ; » (convention Excel francophone), BOM UTF-8 en tête pour
// qu'Excel ouvre l'UTF-8 sans assistant, lignes CRLF.

import { featureOwner } from './filter_model.mjs';

// Colonnes du CSV — noms de propriétés du GeoJSON (bdd.py:create_geojson,
// lab_geojson.py:lab_feature), plus latitude/longitude lues dans la
// géométrie (Point, convention GeoJSON [lon, lat]).
const CSV_FIELDS = [
    'gc_code', 'name', 'cache_type', 'latitude', 'longitude', 'date_find',
    'found', 'published_date', 'difficulty', 'terrain', 'container', 'owner',
    'country', 'state', 'source_kind',
];

// Cellule CSV : entre guillemets si elle contient « ; », un guillemet ou un
// saut de ligne, guillemets internes doublés. Le guillemet s'écrit \x22 dans
// l'expression régulière : un guillemet double littéral dans une regex fait
// perdre le fil au lexer JS de pybabel, qui n'extrait alors plus les chaînes
// t() qui suivent dans le fichier (même règle que stats_panels.js:csvCell).
function csvCell(value) {
    const s = String(value ?? '');
    return /[;\x22\r\n]/.test(s) ? '"' + s.replace(/\x22/g, '""') + '"' : s;
}

// Coordonnées [lon, lat] de la géométrie Point, normalisées en nombres ;
// null quand elles sont absentes ou non finies.
function pointLonLat(feature) {
    const c = feature?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    return (Number.isFinite(lon) && Number.isFinite(lat)) ? [lon, lat] : null;
}

// Valeur CSV d'une colonne pour une feature.
function csvValue(feature, field) {
    const p = feature?.properties || {};
    switch (field) {
        case 'latitude': return pointLonLat(feature)?.[1] ?? '';
        case 'longitude': return pointLonLat(feature)?.[0] ?? '';
        case 'found': return p.found ? '1' : '0';
        case 'owner': return featureOwner(p) || '';
        // Même défaut que filterFeaturesClientSide (bdd.js) : une feature
        // sans source_kind est une géocache.
        case 'source_kind': return p.source_kind || 'geocache';
        default: return p[field] ?? '';
    }
}

// La sélection en CSV : une ligne d'en-tête puis une ligne par feature,
// BOM UTF-8 + CRLF (cf. en-tête du module). Tableau vide → en-tête seule.
export function selectionToCsv(features) {
    const rows = [CSV_FIELDS.map(csvCell).join(';')];
    for (const f of features || []) {
        rows.push(CSV_FIELDS.map((field) => csvCell(csvValue(f, field))).join(';'));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

// --- GPX -------------------------------------------------------------------
// GPX 1.0 minimal : un <wpt> par feature positionnée (une feature sans
// coordonnées finies ne peut pas être un waypoint — elle est ignorée, ce qui
// n'arrive pas sur le jeu affiché où tout point en a).
// Échappement XML des cinq caractères : le libellé d'une cache peut contenir
// &, <, > ou des guillemets.
function xmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\x22/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// date_find « YYYY-MM-DD » → instant xsd:dateTime attendu par <time>.
// null ou illisible → pas d'élément.
function gpxTime(dateFind) {
    const s = String(dateFind || '');
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(0, 10)}T00:00:00Z` : null;
}

// <name> du waypoint : code GC ; les Labs n'en ont pas — le titre de l'étape
// fait office de libellé, record_uid en dernier recours.
function gpxName(p) {
    return p.gc_code || p.name || p.record_uid || '';
}

// <desc> : type, notes D/T, taille et propriétaire — les morceaux absents
// sont omis (les Labs n'ont ni D/T ni taille).
function gpxDesc(p) {
    const parts = [];
    if (p.cache_type) parts.push(String(p.cache_type));
    const d = p.difficulty;
    const t = p.terrain;
    if (d !== null && d !== undefined && d !== '' || t !== null && t !== undefined && t !== '') {
        parts.push(`D${d ?? '?'}/T${t ?? '?'}`);
    }
    if (p.container) parts.push(String(p.container));
    const owner = featureOwner(p);
    if (owner) parts.push(owner);
    return parts.join(' — ');
}

// La sélection en GPX 1.0 : <name> = code, <urlname> = nom de la cache,
// <time> = date de découverte, <desc> = type/D/T/propriétaire.
export function selectionToGpx(features) {
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.0" creator="MyGCFlow" xmlns="http://www.topografix.com/GPX/1/0">',
    ];
    for (const f of features || []) {
        const ll = pointLonLat(f);
        if (!ll) continue;
        const p = f?.properties || {};
        const children = [];
        const time = gpxTime(p.date_find);
        if (time) children.push(`<time>${time}</time>`);
        const name = gpxName(p);
        if (name) children.push(`<name>${xmlEscape(name)}</name>`);
        const desc = gpxDesc(p);
        if (desc) children.push(`<desc>${xmlEscape(desc)}</desc>`);
        if (p.name) children.push(`<urlname>${xmlEscape(p.name)}</urlname>`);
        lines.push(`<wpt lat="${ll[1]}" lon="${ll[0]}">${children.join('')}</wpt>`);
    }
    lines.push('</gpx>');
    return lines.join('\n') + '\n';
}

// Nom du fichier proposé au téléchargement : date locale du jour de
// l'export. `date` injectable pour les tests.
export function exportSelectionFileName(ext, date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `mygcflow-selection-${y}-${m}-${d}.${ext}`;
}
