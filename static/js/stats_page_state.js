// Page Statistiques : état partagé et constantes communes aux modules
// stats_page_*.js (point d'entrée : stats_page.js).

import { t } from './notifications.js';
import { tableFromRecords } from './chart_sources.mjs';
import { todayDay } from './chart_periods.mjs';
import { makeLabels } from './chart_labels.mjs';
import { zoneName } from './stats_page_geo.js';


// Locale ECharts (libellés de ses outils) selon la langue de l'interface. Le
// français vient de static/vendor/echarts/langFR.js, chargé par le gabarit ;
// l'anglais est inclus dans echarts.min.js.
export function echartsLocale(lang = document.documentElement.lang) {
    return String(lang || '').toLowerCase().startsWith('fr') ? 'FR' : 'EN';
}

export const SAVE_DELAY_MS = 500;
export const SAVE_RETRY_DELAY_MS = 5000;
export const $ = (id) => document.getElementById(id);

// Table vide : source sans données (ou injoignable).
export const EMPTY_TABLE = tableFromRecords([]);
export const PERSONAL_SOURCES = ['finds', 'dnf', 'owned', 'poses.received', 'poses.dnf', 'poses.favorites'];

export const state = {
    // Tables par source (« finds », « poses.received », « evolution:3 »…).
    tables: new Map(),
    sourceErrors: new Set(),  // sources dont le chargement a échoué (pas des zéros)
    // Filtres repris de la carte, en attente d'« Appliquer » : { period }
    // (période proposée ou null), null quand le formulaire n'en vient pas.
    mapTake: null,
    // Présentation ouverte : diapositives, position, défilement automatique.
    present: null,
    datasets: [],               // jeux Évolution [{ id, name, … }]
    datasetsFailed: false,      // la liste des jeux n'a pas pu être lue
    evolutionLoads: new Map(),  // id de jeu → promesse de chargement
    missingDatasets: new Set(), // jeux supprimés depuis
    doc: null,
    labels: makeLabels({ t, locale: document.documentElement.lang || 'fr', zoneName }),
    tokens: null,
    typeColors: {},
    today: todayDay(),
    charts: new Map(),          // id de graphique → instance ECharts
    results: new Map(),         // id → { result, spec } (relevé E2E)
    // Mémoïsation : un résultat ne dépend que de la requête et des données.
    // Déplacer une carte, renommer, changer de thème… ne recalcule rien.
    resultCache: new Map(),     // clé de requête → résultat calculé
    dataRev: 0,                 // révision des tables : toute écriture invalide le cache
    rendered: new Map(),        // id → { result, tokensRev } : ce qui est réellement dessiné
    tokensRev: 0,               // révision du thème : un changement impose un redraw
    geoRev: 0,                  // révision des contours chargés (cartes par zones)
    deferred: new Set(),        // ids de cartes hors écran, dessinées à l'approche
    lazyObserver: null,         // IntersectionObserver des cartes différées
    resizeObserver: null,
    saveTimer: null,
    saveRetryTimer: null,
    saveSeq: 0,             // compteur de modifications : détecte un edit pendant le vol
    docDirty: false,        // document modifié depuis le dernier écrit confirmé
    docRev: null,           // révision du fichier chargée/confirmée (base du PUT)
    saveFailed: false,
    corruptDocument: false, // fichier dashboards.json illisible au chargement
    backupAvailable: false,
    conflictOpen: false,    // dialogue « autre onglet » déjà affiché
    editor: null,               // { mode: 'edit'|'new', index, item }
    video: null,                // vidéo animée en cours (openVideo)
    lastImage: null,            // dernière image du tableau (relevé E2E)
    previewChart: null,
    ready: false,
    // Préférence d'accessibilité : les graphiques sont posés sans animation.
    reduceMotion: false,
    valuesSpec: null,           // graphique dont la modale « valeurs » est ouverte
    busy: 0,                    // attentes en cours (whileBusy)
    // Galerie : éléments prêts à ajouter (id de question → élément) et
    // aperçus dessinés à l'approche.
    gallery: { items: new Map(), dashboardId: null, charts: [], queue: [], observer: null, frame: 0, geoWaiting: new Set() },
};

// Couleurs lues dans les variables CSS (stats_page.css, palette clair /
// sombre) : le thème change → nouvelles valeurs, graphiques redessinés.
export function readTokens() {
    const style = getComputedStyle(document.documentElement);
    const v = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
        text: v('--color-text', '#1f2b38'),
        // Police réelle de la page : un canvas ne sait pas « hériter ».
        font: getComputedStyle(document.body).fontFamily || 'sans-serif',
        textMuted: v('--color-text-muted', '#5b6878'),
        grid: v('--chart-grid', '#e1e6ec'),
        surface: v('--color-surface', '#ffffff'),
        others: v('--chart-others', '#a9b1bb'),
        unknown: v('--chart-unknown', '#cfd5dc'),
        up: v('--chart-up', '#2a78d6'),
        down: v('--chart-down', '#e34948'),
        empty: v('--chart-empty', '#eef1f5'),
        heat: Array.from({ length: 5 }, (_, i) => v(`--chart-heat-${i + 1}`, '#3987e5')),
        series: Array.from({ length: 8 }, (_, i) => v(`--chart-series-${i + 1}`, '#2a78d6')),
    };
}

