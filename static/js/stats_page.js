// Point d'entrée de la page « Statistiques » (/stats).
//
// Page sans carte : elle ne charge ni OpenLayers ni index.js (graphe complet
// de la page carte). Elle tire des modules autonomes — thème, « Quitter »,
// modales — et les modules purs chart_*.mjs / dashboard_model.mjs. Le calcul
// et la fabrication des options ECharts sont purs et testés sous Node ; ce
// fichier ne fait que le câblage DOM. Plan : MyGCFlow_Plan_Statistiques.md ;
// doc : docs/page-statistiques.md.

import { syncThemeFromSettings } from './theme.js';
import { bindQuitButtons } from './app_quit.js';
import { showActionToast, showConfirmation, showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { markSaving, markSaved, markSaveError } from './saved_indicator.mjs';
import { closingSaveRequest, createSaveQueue } from './dashboard_saver.mjs';
import {
    MAX_SERIES,
    allowedAligns,
    allowedCharts,
    allowedGroupBy,
    allowedLayouts,
    allowedNormalize,
    allowedSplitBy,
    chartSources,
    createChartSpec,
    hasSeveralSeries,
    MAX_EXTRA_SOURCES,
    normalizeChartSpec,
    normalizeMeasure,
    periodsAreMultiple,
    sourceDimensions,
} from './chart_spec.mjs';
import {
    dnfTable, evolutionTables, findsTable, ownedTable, posesTables, tableFromRecords,
} from './chart_sources.mjs';
import { todayDay } from './chart_periods.mjs';
import { ELAPSED_UNITS, filterMask, runChartQueries } from './chart_query.mjs';
import { activeFilterCount, describeFilters } from './chart_filters.mjs';
import { clearFilterForm, destroyFilterForm, readFilterForm, renderFilterForm } from './stats_filters_ui.js';
import { GROUP_CHOICES, EDITOR_CHARTS, MEASURE_CHOICES, makeLabels, measureKey, measureOfKey } from './chart_labels.mjs';
import {
    axisLabels, buildChartOption, calendarCell, calendarYears, challengeText, chartHeight, clickTarget, numberModel,
    seriesIdentity, thumbnailOption,
} from './chart_echarts.mjs';
import {
    VIDEO_DURATIONS, VIDEO_FPS, VIDEO_SIZES, chartAnimates, lockOption, niceCeil, revealIndex, revealProgress,
    revealResult, valueMax,
} from './chart_video.mjs';
import fixWebmDuration from './fix-webm-duration.js';
import { SOURCE_KIND_VALUES } from './chart_sources.mjs';
import { chartLinksToMap, discoveryModeFor, filtersFromMapSelection, mapSelectionFor } from './chart_map_link.mjs';
import { panelFromSpec } from './chart_panel_link.mjs';
import { STATS_MAX_PANELS } from './stats_model.mjs';
import {
    DASHBOARD_HEIGHTS,
    DASHBOARD_SIZES,
    HEIGHT_PIXELS,
    MAX_DASHBOARDS,
    MAX_ITEMS,
    QUESTIONS,
    QUESTION_GROUPS,
    SIZE_COLUMNS,
    chartPeriodChoices,
    comparePeriodChoices,
    dashboardSources,
    defaultDashboard,
    defaultDocument,
    duplicateDashboard,
    exportDashboard,
    importDashboard,
    questionFamily,
    effectiveQueryOptions,
    hasOwnPeriod,
    itemFromQuestion,
    normalizeDocument,
    periodChoices,
    periodOfValue,
    periodValue,
} from './dashboard_model.mjs';

// Locale ECharts (libellés de ses outils) selon la langue de l'interface. Le
// français vient de static/vendor/echarts/langFR.js, chargé par le gabarit ;
// l'anglais est inclus dans echarts.min.js.
export function echartsLocale(lang = document.documentElement.lang) {
    return String(lang || '').toLowerCase().startsWith('fr') ? 'FR' : 'EN';
}

const SAVE_DELAY_MS = 500;
const SAVE_RETRY_DELAY_MS = 5000;
const $ = (id) => document.getElementById(id);

// Table vide : source sans données (ou injoignable).
const EMPTY_TABLE = tableFromRecords([]);
const PERSONAL_SOURCES = ['finds', 'dnf', 'owned', 'poses.received', 'poses.dnf', 'poses.favorites'];

const state = {
    // Tables par source (« finds », « poses.received », « evolution:3 »…).
    tables: new Map(),
    sourceErrors: new Set(),  // sources dont le chargement a échoué (pas des zéros)
    // Filtres repris de la carte, en attente d'« Appliquer » : { period }
    // (période proposée ou null), null quand le formulaire n'en vient pas.
    mapTake: null,
    datasets: [],               // jeux Évolution [{ id, name, … }]
    evolutionLoads: new Map(),  // id de jeu → promesse de chargement
    missingDatasets: new Set(), // jeux supprimés depuis
    doc: null,
    labels: makeLabels({ t, locale: document.documentElement.lang || 'fr' }),
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
    previewChart: null,
    ready: false,
    // Préférence d'accessibilité : les graphiques sont posés sans animation.
    reduceMotion: false,
    valuesSpec: null,           // graphique dont la modale « valeurs » est ouverte
    busy: 0,                    // attentes en cours (whileBusy)
    // Galerie : éléments prêts à ajouter (id de question → élément) et
    // aperçus dessinés à l'approche.
    gallery: { items: new Map(), dashboardId: null, charts: [], queue: [], observer: null, frame: 0 },
};

// ---------------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------------

// Couleurs lues dans les variables CSS (stats_page.css, palette clair /
// sombre) : le thème change → nouvelles valeurs, graphiques redessinés.
function readTokens() {
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

function watchTheme() {
    const observer = new MutationObserver(() => {
        state.tokens = readTokens();
        state.tokensRev += 1;
        if (state.ready) renderAllCharts();
        if (state.editor) renderPreview();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
}

// La date du jour fixe les périodes relatives (« Cette année »), la coupe
// « à date » et la case en cours. Relue au retour sur l'onglet et chaque
// minute : une page restée ouverte passé minuit — ou le 31 décembre —
// suivait sinon l'ancienne date jusqu'au rechargement. La clé du cache de
// résultats contient la date : un changement recalcule les graphiques.
const TODAY_CHECK_MS = 60 * 1000;

function refreshToday() {
    const today = todayDay();
    if (today === state.today) return;
    state.today = today;
    if (state.ready) {
        renderToolbar();
        renderAllCharts();
    }
    if (state.editor) {
        syncEditorForm();
        renderPreview();
    }
}

function watchToday() {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshToday();
    });
    setInterval(refreshToday, TODAY_CHECK_MS);
}

// « Réduire les animations » (réglage système) : suivi comme le thème —
// un changement redessine sans animation, les résultats restent en cache.
function watchReducedMotion() {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
        state.reduceMotion = query.matches;
        if (state.ready) renderAllCharts();
    };
    apply();
    query.addEventListener('change', apply);
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

async function loadUserSettings() {
    try {
        const response = await fetch('/api/settings');
        if (!response.ok) return;
        const settings = await response.json();
        window.userSettings = settings;
        syncThemeFromSettings(settings);
    } catch (e) {
        console.warn('[stats] Préférences non chargées :', e?.message || e);
    }
}

async function loadTypeColors() {
    try {
        const response = await fetch('/static/json/defaultGcColors.json');
        if (response.ok) state.typeColors = await response.json();
    } catch (_) {
        state.typeColors = {};
    }
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return response.json();
}

// Sources personnelles : les trouvailles sont indispensables (échec = page
// en erreur) ; DNF, caches posées et Mes poses sont facultatifs — pas de
// logs importés = tables vides, mais un ÉCHEC n'est pas un zéro : la source
// est marquée indisponible (sourceErrors) et le graphique propose une relance.
const PERSONAL_LOADERS = [
    { url: '/api/stats/dnf', sources: ['dnf'], apply: (p) => [['dnf', dnfTable(p)]] },
    { url: '/api/stats/owned', sources: ['owned'], apply: (p) => [['owned', ownedTable(p)]] },
    { url: '/api/poses/data', sources: ['poses.received', 'poses.dnf', 'poses.favorites'],
      apply: (p) => {
          const tables = posesTables(p);
          return [['poses.received', tables.received], ['poses.dnf', tables.dnf],
                  ['poses.favorites', tables.favorites]];
      } },
];
const SOURCE_LOADER = new Map(PERSONAL_LOADERS.flatMap((l) => l.sources.map((s) => [s, l])));

// Toute écriture d'une table change les données : le cache de résultats
// est invalidé via dataRev (les cartes concernées seront recalculées).
function setTable(source, table) {
    state.tables.set(source, table);
    state.dataRev += 1;
}

function loadPersonalLoader(loader) {
    return fetchJson(loader.url).then((payload) => {
        for (const [source, table] of loader.apply(payload)) {
            setTable(source, table);
            state.sourceErrors.delete(source);
        }
    }).catch((e) => {
        console.warn('[stats] Source indisponible :', e?.message || e);
        for (const source of loader.sources) {
            setTable(source, EMPTY_TABLE);
            state.sourceErrors.add(source);
        }
    });
}

async function loadPersonalSources() {
    const [finds] = await Promise.all([
        fetchJson('/api/stats/finds').then(findsTable),
        ...PERSONAL_LOADERS.map(loadPersonalLoader),
    ]);
    setTable('finds', finds);
}

// Recharge les sources en échec d'un graphique (bouton « Réessayer »), puis
// redessine tout : la note des données et le résumé des filtres en dépendent.
function retrySources(spec) {
    const failed = chartSources(spec).filter((s) => state.sourceErrors.has(s));
    const loaders = [...new Set(failed.map((s) => SOURCE_LOADER.get(s)).filter(Boolean))];
    const datasets = failed.filter((s) => s.startsWith('evolution:'))
        .map((s) => s.split(':')[1]);
    // L'échec n'est pas gardé en cache : ensureEvolution relancera le GET.
    for (const id of datasets) state.evolutionLoads.delete(id);
    return Promise.all([...loaders.map(loadPersonalLoader), ...datasets.map(ensureEvolution)])
        .then(renderDashboard);
}

async function loadDatasets() {
    try {
        state.datasets = (await fetchJson('/api/evolution/datasets')).datasets || [];
    } catch (_) {
        state.datasets = [];
    }
}

// Jeu Évolution chargé à la demande (premier affichage d'un tableau qui
// l'utilise). Un jeu supprimé (404) donne des tables vides et la mention
// « n'existe plus » ; toute autre erreur est temporaire : la source est
// marquée indisponible et la promesse n'est pas gardée — une relance repart.
function ensureEvolution(id) {
    if (!id) return Promise.resolve();
    if (!state.evolutionLoads.has(id)) {
        state.evolutionLoads.set(id, fetchJson('/api/evolution/datasets/' + id + '/data')
            .then((payload) => {
                const { placed, archived } = evolutionTables(payload);
                setTable('evolution:' + id, placed);
                setTable('evolution:' + id + ':archived', archived);
                state.sourceErrors.delete('evolution:' + id);
                state.sourceErrors.delete('evolution:' + id + ':archived');
            })
            .catch((e) => {
                const sources = ['evolution:' + id, 'evolution:' + id + ':archived'];
                if (/^HTTP 404\b/.test(e?.message || '')) {
                    state.missingDatasets.add(id);
                } else {
                    for (const source of sources) state.sourceErrors.add(source);
                    // Pas de promesse en cache : la prochaine tentative repart.
                    state.evolutionLoads.delete(id);
                }
                for (const source of sources) setTable(source, EMPTY_TABLE);
            }));
    }
    return state.evolutionLoads.get(id);
}

const tableOf = (source) => state.tables.get(source) || EMPTY_TABLE;

// Étendue des données d'un tableau (menus de périodes) : réunion de ses
// sources.
function dashboardExtent(dashboard = activeDashboard()) {
    const extents = dashboardSources(dashboard).map((source) => tableOf(source).extent).filter(Boolean);
    if (!extents.length) return null;
    return { first: Math.min(...extents.map((e) => e.first)), last: Math.max(...extents.map((e) => e.last)) };
}

const dashboardTables = (dashboard = activeDashboard()) => dashboardSources(dashboard).map(tableOf);

async function loadDashboards() {
    const response = await fetch('/api/dashboards');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    state.docRev = typeof body.rev === 'string' ? body.rev : null;
    state.corruptDocument = body.corrupt === true;
    state.backupAvailable = body.backup_available === true;
    return normalizeDocument(body.document);
}

function newDefaultDocument() {
    return defaultDocument({
        name: t('Mon tableau de bord'),
        titleOf: (id) => state.labels.question(id).title,
    });
}

function showSection(id) {
    for (const section of ['statsLoading', 'statsLoadError', 'statsEmptyState', 'statsDashboard']) {
        $(section).hidden = section !== id;
    }
}

async function loadPage() {
    $('statsLoadingText').textContent = t('Chargement de vos statistiques…');
    showSection('statsLoading');
    try {
        const [, doc] = await Promise.all([loadPersonalSources(), loadDashboards(), loadTypeColors(), loadDatasets()]);
        // Rien à compter nulle part : la page invite à importer.
        const personal = PERSONAL_SOURCES.some((source) => tableOf(source).n > 0);
        if (!personal && !state.datasets.length) {
            showSection('statsEmptyState');
            return;
        }
        state.doc = doc;
        if (!state.doc && state.corruptDocument) {
            state.doc = await recoverCorruptDocument();
        }
        if (!state.doc) {
            // Première visite (ou fichier corrompu abandonné) : un tableau
            // de bord prêt à lire, enregistré tout de suite pour qu'il
            // survive au rechargement.
            state.doc = newDefaultDocument();
            scheduleSave({ immediate: true });
        }
        const { dataset } = activeDashboard();
        if (dataset) {
            // Premier appel après le démarrage : le serveur prépare le jeu
            // (~3 s pour un jeu national) — dire ce qui se passe.
            $('statsLoadingText').textContent = t('Chargement du jeu Évolution « ${name} »…', { name: datasetName(dataset) });
            await ensureEvolution(dataset);
        }
        state.ready = true;
        showSection('statsDashboard');
        renderDashboard();
    } catch (e) {
        console.error('[stats] Chargement impossible :', e);
        showSection('statsLoadError');
    }
}

// ---------------------------------------------------------------------------
// Sauvegarde
// ---------------------------------------------------------------------------

// Une écriture à la fois ; la dernière version du document gagne. En-tête
// X-Dashboard-Rev : la révision chargée — si le fichier a bougé depuis
// (autre onglet), le serveur répond 409 plutôt que d'écraser à l'aveugle.
const saveQueue = createSaveQueue(async (doc, rev) => {
    try {
        const response = await fetch('/api/dashboards', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json',
                       'X-Dashboard-Rev': rev === null ? 'none' : rev },
            body: JSON.stringify(doc),
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 409) return { ok: 'conflict' };
        if (!response.ok || body.success === false) return { ok: false };
        return { ok: true, rev: typeof body.rev === 'string' ? body.rev : rev };
    } catch (_) {
        return { ok: false };
    }
});

function flushSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.docDirty) return Promise.resolve(true);
    const seq = state.saveSeq;
    const status = $('statsSaveStatus');
    markSaving(status);
    state.saveFailed = false;
    return saveQueue.push(state.doc, state.docRev).then((result) => {
        if (result?.ok === true) {
            state.docRev = result.rev ?? state.docRev;
            // Modifié pendant le vol : reste « à enregistrer », le minuteur
            // armé par scheduleSave renverra la file.
            if (state.saveSeq === seq) state.docDirty = false;
            markSaved(status);
            return true;
        }
        if (result?.ok === 'conflict') {
            handleSaveConflict();
            return false;
        }
        state.saveFailed = true;
        markSaveError(status);
        scheduleSaveRetry();
        return false;
    });
}

// « Non enregistré » : une relance automatique, puis un clic sur l'état
// en propose une autre (le document reste en file tant qu'il n'est pas écrit).
function scheduleSaveRetry() {
    clearTimeout(state.saveRetryTimer);
    state.saveRetryTimer = setTimeout(() => {
        if (state.docDirty && state.saveFailed) flushSave();
    }, SAVE_RETRY_DELAY_MS);
}

// Le fichier a changé depuis notre chargement (autre onglet, autre machine) :
// l'utilisateur choisit d'écraser ou de reprendre la version du disque.
// `conflictOpen` évite d'empiler les dialogues si une écriture échoue de
// nouveau pendant que la première est affichée.
async function handleSaveConflict() {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    markSaveError($('statsSaveStatus'));
    let body;
    try {
        body = await (await fetch('/api/dashboards', { headers: { Accept: 'application/json' } })).json();
    } catch (_) {
        state.conflictOpen = false;
        state.saveFailed = true;
        scheduleSaveRetry();
        return;
    }
    const other = normalizeDocument(body.document);
    const rev = typeof body.rev === 'string' ? body.rev : null;
    showConfirmation(
        t('Ce tableau de bord a été modifié dans un autre onglet. Écraser ces modifications par les vôtres ?'),
        t('Conflit de sauvegarde'),
        () => {
            state.conflictOpen = false;
            state.docRev = rev;
            state.docDirty = true;
            state.saveFailed = false;
            flushSave();
        },
        () => {
            state.conflictOpen = false;
            state.saveFailed = false;
            // Plus rien à reprendre côté disque : garder notre version.
            if (other) {
                state.doc = other;
                state.docRev = rev;
                state.docDirty = false;
                markSaved($('statsSaveStatus'));
                renderDashboard();
                return;
            }
            state.docRev = rev;
            state.docDirty = true;
            flushSave();
        },
        { confirmText: t('Écraser'), cancelText: t('Reprendre l\'autre version'), danger: true });
}

// Actions discrètes (ajout, suppression, déplacement) : `immediate`, pour
// qu'un rechargement juste après ne perde rien.
function scheduleSave({ immediate = false } = {}) {
    state.docDirty = true;
    state.saveSeq += 1;
    state.saveFailed = false;
    clearTimeout(state.saveTimer);
    if (immediate) return flushSave();
    state.saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    return null;
}

// Fichier illisible au chargement : proposer la copie de sécurité `.bak`.
// Refus ou échec → document neuf (le serveur garde le corrompu sous
// `.corrupt` au lieu de l'écraser, la preuve et la `.bak` survivent).
function recoverCorruptDocument() {
    if (!state.backupAvailable) {
        showError(t('Le fichier des tableaux de bord est illisible et aucune sauvegarde n\'existe : un tableau neuf sera créé.'));
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        showConfirmation(
            t('Le fichier des tableaux de bord est illisible. Restaurer la dernière sauvegarde ?'),
            t('Tableaux de bord'),
            () => restoreBackupDocument().then(resolve),
            () => resolve(null),
            { confirmText: t('Restaurer'), cancelText: t('Repartir à zéro') });
    });
}

async function restoreBackupDocument() {
    try {
        const response = await fetch('/api/dashboards/restore', { method: 'POST' });
        const body = await response.json();
        if (!response.ok || body.success === false) throw new Error(body.error || `HTTP ${response.status}`);
        state.docRev = typeof body.rev === 'string' ? body.rev : null;
        const doc = normalizeDocument(body.document);
        if (doc) return doc;
        throw new Error('empty');
    } catch (e) {
        console.warn('[stats] Restauration impossible :', e?.message || e);
    }
    showError(t('La restauration de la sauvegarde a échoué.'));
    return null;
}

window.addEventListener('pagehide', () => {
    if (!state.docDirty) return;
    // Dernière chance : keepalive survit au déchargement de la page. La
    // révision voyage aussi : un conflit est refusé plutôt qu'écrasé.
    // Au-delà de 64 Kio, le navigateur refuse l'envoi keepalive : seul le
    // tableau affiché part alors (closingSaveRequest).
    const request = closingSaveRequest(state.doc);
    if (!request) return;
    try {
        fetch(request.url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json',
                       'X-Dashboard-Rev': state.docRev === null ? 'none' : state.docRev },
            body: request.body,
            keepalive: true,
        }).catch(() => {});
    } catch (_) {}
});

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

function activeDashboard() {
    return state.doc.dashboards.find((d) => d.id === state.doc.active) || state.doc.dashboards[0];
}

function attributeName(key) {
    const attr = (tableOf('finds').dicts.attribute || []).find((a) => a.key === key);
    return attr ? attr.name : key;
}

function datasetName(id) {
    return state.datasets.find((d) => d.id === id)?.name || t('Jeu ${id}', { id });
}

function chartTitle(spec) {
    return spec.title || state.labels.defaultTitle(spec);
}

// Menu de périodes. `choices` : la liste proposée ; `inherit` ajoute
// « Période du tableau de bord » (valeur vide).
function fillPeriodSelect(select, current, { inherit = false, choices = null } = {}) {
    const list = choices || periodChoices(dashboardExtent(), state.today);
    select.replaceChildren();
    if (inherit) select.append(new Option(t('Période du tableau de bord'), ''));
    const values = new Set();
    for (const period of list) {
        const value = periodValue(period);
        values.add(value);
        select.append(new Option(state.labels.periodChoiceLabel(period), value));
    }
    // Période posée ailleurs (question, import) absente de la liste.
    const currentValue = periodValue(current);
    if (current && !values.has(currentValue)) {
        select.append(new Option(state.labels.periodChoiceLabel(current), currentValue));
    }
    select.value = currentValue;
}

// Pastille d'un graphique qui a ses propres périodes ou en compare
// plusieurs : « 2024 », « Cette année · La période précédente »…
function periodsBadge(spec) {
    if (!Array.isArray(spec.periods)) return '';
    if (spec.periods.length > 2) return t('${n} périodes', { n: spec.periods.length });
    return spec.periods.map((p) => state.labels.periodChoiceLabel(p)).join(' · ');
}

function renderToolbar() {
    const dashboard = activeDashboard();
    $('statsDashboardName').textContent = dashboard.name || t('Mon tableau de bord');
    const kind = $('statsDashboardKind');
    kind.hidden = dashboard.kind !== 'evolution';
    kind.textContent = dashboard.kind === 'evolution' ? t('Évolution · ${name}', { name: datasetName(dashboard.dataset) }) : '';
    renderDashboardMenu();
    fillPeriodSelect($('statsGlobalPeriod'), dashboard.period);
    $('statsDataNote').textContent = dataNote(dashboard);
    renderFiltersSummary(dashboard);
}

// Ce que contient le tableau : « 6 trouvailles · 2 DNF · 12 trouvailles
// reçues » ou, pour un jeu Évolution, ses publications et archivages.
function dataNote(dashboard) {
    const nf = new Intl.NumberFormat(state.labels.locale);
    const parts = [];
    let main;
    if (dashboard.kind === 'evolution') {
        if (state.missingDatasets.has(dashboard.dataset)) return t("Ce jeu Évolution n'existe plus.");
        // Jeu en erreur : pas de comptes nuls trompeurs, l'état suffit.
        if (state.sourceErrors.has('evolution:' + dashboard.dataset)) {
            return t('Jeu « ${name} » : données indisponibles', { name: datasetName(dashboard.dataset) });
        }
        main = tableOf('evolution:' + dashboard.dataset);
        parts.push(t('${n} caches publiées', { n: nf.format(main.n) }));
        parts.push(t('${n} archivages datés', { n: nf.format(tableOf('evolution:' + dashboard.dataset + ':archived').n) }));
    } else {
        main = tableOf('finds');
        parts.push(t('${n} trouvailles', { n: nf.format(main.n) }));
        const others = [
            ['dnf', (n) => t('${n} DNF', { n })],
            ['owned', (n) => t('${n} caches posées', { n })],
            ['poses.received', (n) => t('${n} trouvailles reçues', { n })],
        ];
        for (const [source, text] of others) {
            const n = tableOf(source).n;
            if (n) parts.push(text(nf.format(n)));
        }
    }
    if (activeFilterCount(dashboard.filters)) {
        const kept = filterMask(main, dashboard.filters).reduce((sum, v) => sum + v, 0);
        parts.push(t('${n} avec les filtres', { n: nf.format(kept) }));
    }
    const undated = tableOf('finds').undated;
    if (dashboard.kind !== 'evolution' && undated) {
        parts.push(t('${n} sans date de trouvaille, non comptées', { n: nf.format(undated) }));
    }
    // Sources dont le chargement a échoué : signalées, pas confondues avec 0.
    const failed = dashboardSources(dashboard).filter((s) => state.sourceErrors.has(s));
    if (failed.length) {
        const names = [...new Set(failed.map((s) => s.startsWith('evolution:')
            ? t('Jeu « ${name} »', { name: datasetName(s.split(':')[1]) })
            : state.labels.sourceLabel(s)))];
        parts.push(t('${names} : données indisponibles', { names: names.join(', ') }));
    }
    return parts.join(' · ');
}

// ----- Plusieurs tableaux de bord

function renderDashboardMenu() {
    const menu = $('statsDashboardMenu');
    menu.replaceChildren();
    for (const dashboard of state.doc.dashboards) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-item' + (dashboard.id === state.doc.active ? ' active' : '');
        button.dataset.dashboardId = dashboard.id;
        const icon = document.createElement('i');
        icon.className = 'ti ' + (dashboard.kind === 'evolution' ? 'ti-stack' : 'ti-layout-dashboard') + ' me-2';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon, document.createTextNode(dashboard.name || t('Mon tableau de bord')));
        if (dashboard.id === state.doc.active) button.setAttribute('aria-current', 'true');
        li.append(button);
        menu.append(li);
    }
    const divider = document.createElement('li');
    divider.innerHTML = '<hr class="dropdown-divider">';
    menu.append(divider);
    const full = state.doc.dashboards.length >= MAX_DASHBOARDS;
    menu.append(menuButton('new-dashboard', 'ti-plus', t('Nouveau tableau de bord…'), { disabled: full }));
    menu.append(menuButton('duplicate-dashboard', 'ti-copy', t('Dupliquer ce tableau de bord'), { disabled: full }));
    menu.append(menuButton('export-dashboard', 'ti-file-export', t('Exporter ce tableau de bord (fichier)')));
    menu.append(menuButton('import-dashboard', 'ti-file-import', t('Importer un tableau de bord…'), { disabled: full }));
    menu.append(menuButton('print-dashboard', 'ti-printer', t('Imprimer')));
    const dangerDivider = document.createElement('li');
    dangerDivider.innerHTML = '<hr class="dropdown-divider">';
    menu.append(dangerDivider);
    menu.append(menuButton('delete-dashboard', 'ti-trash', t('Supprimer ce tableau de bord'),
        { danger: true, disabled: state.doc.dashboards.length < 2 }));
}

function duplicateActiveDashboard() {
    if (state.doc.dashboards.length >= MAX_DASHBOARDS) return;
    const source = activeDashboard();
    const copy = duplicateDashboard(source, { name: t('${name} (copie)', { name: source.name }) });
    state.doc.dashboards.push(copy);
    state.doc.active = copy.id;
    scheduleSave({ immediate: true });
    renderDashboard();
}

// Fichier d'un tableau de bord, à partager : sans identifiants ; un tableau
// Évolution emporte le NOM de son jeu.
function exportActiveDashboard() {
    const dashboard = activeDashboard();
    const file = exportDashboard(dashboard, {
        datasetName: dashboard.kind === 'evolution' ? datasetName(dashboard.dataset) : null,
    });
    download(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
        fileSafe(dashboard.name || t('Mon tableau de bord')) + '.json');
}

const IMPORT_ERRORS = {
    'not-a-dashboard': () => t("Ce fichier n'est pas un tableau de bord MyGCFlow."),
    'unknown-version': () => t('Ce tableau de bord vient d\'une version plus récente de MyGCFlow.'),
    'no-dataset': () => t("Ce tableau de bord porte sur une zone Évolution : importez d'abord un jeu sur la page Évolution."),
};

async function importDashboardFile(file) {
    let raw;
    try {
        raw = JSON.parse(await file.text());
    } catch (_) {
        showError(IMPORT_ERRORS['not-a-dashboard'](), t('Importer un tableau de bord'));
        return;
    }
    if (state.doc.dashboards.length >= MAX_DASHBOARDS) return;
    const { dashboard, warning, error } = importDashboard(raw, {
        datasets: state.datasets,
        defaultName: t('Mon tableau de bord'),
    });
    if (error) {
        showError(IMPORT_ERRORS[error](), t('Importer un tableau de bord'));
        return;
    }
    state.doc.dashboards.push(dashboard);
    state.doc.active = dashboard.id;
    scheduleSave({ immediate: true });
    await ensureEvolution(dashboard.dataset);
    renderDashboard();
    if (warning === 'dataset-guessed') {
        showToast(t('Jeu Évolution d\'origine introuvable : le tableau porte sur « ${name} ».', { name: datasetName(dashboard.dataset) }),
            'warning', t('Importer un tableau de bord'));
    } else {
        showToast(t('Tableau de bord « ${name} » importé.', { name: dashboard.name }), 'success');
    }
}

async function switchDashboard(id) {
    if (!state.doc.dashboards.some((d) => d.id === id) || id === state.doc.active) return;
    state.doc.active = id;
    scheduleSave({ immediate: true });
    const { dataset } = activeDashboard();
    if (dataset) {
        await whileBusy(t('Chargement du jeu Évolution « ${name} »…', { name: datasetName(dataset) }),
            () => ensureEvolution(dataset));
        // Un autre tableau a été choisi pendant l'attente : il se dessinera
        // lui-même.
        if (state.doc.active !== id) return;
    }
    renderDashboard();
}

// Attente visible (changement de tableau, actualisation) : rien sous
// BUSY_DELAY_MS — un passage instantané ne clignote pas —, puis un message
// et la grille atténuée (non cliquable : elle montre encore l'ancien état).
const BUSY_DELAY_MS = 200;

async function whileBusy(text, work) {
    state.busy += 1;
    const timer = setTimeout(() => {
        $('statsBusyText').textContent = text;
        $('statsBusy').hidden = false;
        $('statsGrid').classList.add('is-busy');
        $('statsGrid').setAttribute('aria-busy', 'true');
    }, BUSY_DELAY_MS);
    try {
        return await work();
    } finally {
        clearTimeout(timer);
        state.busy -= 1;
        if (!state.busy) {
            $('statsBusy').hidden = true;
            $('statsGrid').classList.remove('is-busy');
            $('statsGrid').removeAttribute('aria-busy');
        }
    }
}

// « Actualiser » : relit toutes les sources sans recharger la page (un
// import fait sur la carte entre-temps). Les trouvailles et les jeux
// Évolution répondent 304 s'ils n'ont pas bougé. Un échec des trouvailles
// garde les données affichées ; les autres sources suivent la règle
// habituelle (échec = indisponible, pas zéro).
async function refreshData() {
    const button = $('btnStatsRefresh');
    if (button.disabled || !state.ready) return;
    button.disabled = true;
    button.classList.add('is-running');
    try {
        await whileBusy(t('Actualisation des données…'), async () => {
            // Jeux Évolution : tous à relire, l'actif tout de suite, les
            // autres au prochain passage sur leur tableau.
            state.evolutionLoads.clear();
            state.missingDatasets.clear();
            const [finds] = await Promise.all([
                fetchJson('/api/stats/finds').then(findsTable),
                ...PERSONAL_LOADERS.map(loadPersonalLoader),
                loadDatasets(),
            ]);
            setTable('finds', finds);
            await ensureEvolution(activeDashboard().dataset);
        });
        renderDashboard();
        showToast(t('Données actualisées.'), 'success');
    } catch (e) {
        console.warn('[stats] Actualisation impossible :', e?.message || e);
        renderDashboard();
        showError(t("Les données n'ont pas pu être relues : les précédentes restent affichées."), t('Actualiser les données'));
    } finally {
        button.disabled = false;
        button.classList.remove('is-running');
    }
}

function onDashboardMenuClick(event) {
    const pick = event.target.closest('[data-dashboard-id]');
    if (pick) {
        switchDashboard(pick.dataset.dashboardId);
        return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'new-dashboard') openNewDashboard();
    if (action === 'duplicate-dashboard') duplicateActiveDashboard();
    if (action === 'export-dashboard') exportActiveDashboard();
    if (action === 'import-dashboard') $('statsImportInput').click();
    if (action === 'print-dashboard') window.print();
    if (action === 'delete-dashboard') deleteDashboard();
}

function syncNewDashboardForm() {
    const evolution = $('statsNewKindEvolution').checked;
    const hasDatasets = state.datasets.length > 0;
    $('statsNewDatasetRow').hidden = !evolution || !hasDatasets;
    $('statsNewNoDataset').hidden = !evolution || hasDatasets;
    $('btnStatsNewDashboardCreate').disabled = evolution && !hasDatasets;
    const name = $('statsNewName');
    // Nom proposé tant que l'utilisateur n'a pas écrit le sien.
    if (!name.dataset.touched) {
        name.value = evolution && hasDatasets
            ? datasetName(Number($('statsNewDataset').value))
            : t('Mon tableau de bord');
    }
}

function openNewDashboard() {
    $('statsNewDataset').replaceChildren(...state.datasets.map((d) => new Option(d.name, String(d.id))));
    $('statsNewKindPersonal').checked = true;
    $('statsNewWithCharts').checked = true;
    delete $('statsNewName').dataset.touched;
    syncNewDashboardForm();
    getBsModal('statsNewDashboardModal')?.show();
}

async function submitNewDashboard(event) {
    event.preventDefault();
    const evolution = $('statsNewKindEvolution').checked;
    const dataset = evolution ? Number($('statsNewDataset').value) : null;
    if (evolution && !dataset) return;
    const name = Array.from($('statsNewName').value.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 60).join('');
    const dashboard = defaultDashboard({
        name: name || t('Mon tableau de bord'),
        kind: evolution ? 'evolution' : 'personal',
        dataset,
        withCharts: $('statsNewWithCharts').checked,
        titleOf: (id) => state.labels.question(id).title,
    });
    state.doc.dashboards.push(dashboard);
    state.doc.active = dashboard.id;
    scheduleSave({ immediate: true });
    getBsModal('statsNewDashboardModal')?.hide();
    await ensureEvolution(dataset);
    renderDashboard();
}

function deleteDashboard() {
    if (state.doc.dashboards.length < 2) return;
    const dashboard = activeDashboard();
    showConfirmation(
        t('Supprimer le tableau de bord « ${name} » et ses graphiques ?', { name: dashboard.name }),
        t('Supprimer'),
        async () => {
            state.doc.dashboards = state.doc.dashboards.filter((d) => d.id !== dashboard.id);
            state.doc.active = state.doc.dashboards[0].id;
            scheduleSave({ immediate: true });
            await ensureEvolution(activeDashboard().dataset);
            renderDashboard();
        },
        null,
        { danger: true, confirmText: t('Supprimer') },
    );
}

const filterValueLabel = (field, value) => state.labels.filterValue(field, value, { attributeName });

// Pastilles des filtres du tableau de bord : « Type de cache : … » ×.
function renderFiltersSummary(dashboard) {
    const count = activeFilterCount(dashboard.filters);
    const badge = $('statsFiltersCount');
    badge.hidden = !count;
    badge.textContent = String(count);
    const summary = $('statsFiltersSummary');
    summary.replaceChildren();
    summary.hidden = !count;
    for (const { field, values } of describeFilters(dashboard.filters, filterValueLabel)) {
        const chip = document.createElement('span');
        chip.className = 'stats-filter-chip';
        const text = document.createElement('span');
        text.textContent = state.labels.filterField(field) + ' : ' + values.join(', ');
        text.title = text.textContent;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.removeFilter = field;
        remove.setAttribute('aria-label', t('Retirer le filtre ${field}', { field: state.labels.filterField(field) }));
        remove.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
        chip.append(text, remove);
        summary.append(chip);
    }
}

function onFiltersSummaryClick(event) {
    const button = event.target.closest('[data-remove-filter]');
    if (!button) return;
    const dashboard = activeDashboard();
    const filters = { ...dashboard.filters };
    delete filters[button.dataset.removeFilter];
    dashboard.filters = filters;
    scheduleSave({ immediate: true });
    renderToolbar();
    renderAllCharts();
}

function renderDashboardFilterForm(filters) {
    renderFilterForm($('statsFiltersForm'), {
        tables: dashboardTables(),
        filters,
        labels: state.labels,
        attributeName,
        idPrefix: 'statsFilter-',
    });
}

function openFilters() {
    const dashboard = activeDashboard();
    renderDashboardFilterForm(dashboard.filters);
    resetMapFiltersReport();
    // La carte filtre « Mes Géocaches » : rien à reprendre pour un tableau
    // Évolution, ni sans trouvailles.
    $('statsMapFilters').hidden = dashboard.kind === 'evolution' || !tableOf('finds').n;
    getBsModal('statsFiltersModal')?.show();
}

function applyFilters() {
    const dashboard = activeDashboard();
    const take = state.mapTake;
    const before = { filters: structuredClone(dashboard.filters), period: structuredClone(dashboard.period) };
    dashboard.filters = readFilterForm($('statsFiltersForm'));
    if (take?.period && $('statsMapPeriod')?.checked) dashboard.period = take.period;
    state.mapTake = null;
    scheduleSave({ immediate: true });
    getBsModal('statsFiltersModal')?.hide();
    renderToolbar();
    renderAllCharts();
    // Filtres (et période) de la carte : ils remplacent les précédents,
    // « Annuler » les rend.
    if (take) {
        showActionToast(t('Filtres de la carte appliqués.'), { label: t('Annuler'), onClick: () => {
            const current = state.doc?.dashboards.find((d) => d.id === dashboard.id);
            if (!current) return;
            current.filters = before.filters;
            current.period = before.period;
            scheduleSave({ immediate: true });
            renderToolbar();
            renderAllCharts();
        } });
    }
}

function resetMapFiltersReport() {
    state.mapTake = null;
    const report = $('statsMapFiltersReport');
    report.replaceChildren();
    report.hidden = true;
}

// Phrase de compte rendu d'un critère de la carte sans équivalent ici.
function mapFilterNote(note) {
    switch (note.code) {
        case 'search': return t('la recherche « ${text} »', { text: note.text });
        case 'published_dates':
            return t('les dates de pose ${range} : la page filtre par année entière', {
                range: state.labels.periodChoiceLabel({ kind: 'range', from: note.from, to: note.to }),
            });
        case 'unknown_country': return t('les trouvailles sans pays, que la carte garde');
        case 'unknown_state': return t('les trouvailles sans région, que la carte garde');
        case 'labs': return t('les Lab Caches, que la carte garde malgré les filtres propres aux géocaches');
        default: return '';
    }
}

// « Reprendre les filtres de la carte » : la sélection enregistrée par la
// carte (localStorage filtersSelection) remplit le formulaire ; ses dates de
// trouvaille sont proposées comme période. Rien n'est appliqué avant
// « Appliquer ».
async function takeMapFilters() {
    let selection = null;
    try { selection = JSON.parse(localStorage.getItem('filtersSelection') || 'null'); } catch (_) { /* illisible : aucun filtre */ }
    // Géocaches / Labs : préférence de la carte, relue (elle a pu changer
    // depuis l'ouverture de la page).
    try {
        window.userSettings = await fetchJson('/api/settings');
    } catch (e) {
        console.warn('[stats] Préférences non relues :', e?.message || e);
    }
    const discovery = window.userSettings?.main_discovery_sources || 'geocaches';
    const out = filtersFromMapSelection(selection, { table: tableOf('finds'), discovery });
    resetMapFiltersReport();
    const report = $('statsMapFiltersReport');
    const line = (text, className = '') => {
        const p = document.createElement('p');
        p.className = 'mb-1 ' + className;
        p.textContent = text;
        report.append(p);
        return p;
    };
    report.hidden = false;
    if (out.empty) {
        report.dataset.state = 'empty';
        line(t("Avec ses filtres actuels, la carte n'affiche aucune trouvaille : rien n'est repris."), 'text-warning-emphasis');
        return;
    }
    renderDashboardFilterForm(out.filters);
    state.mapTake = { period: out.period };
    const nf = new Intl.NumberFormat(state.labels.locale);
    if (!Object.keys(out.filters).length && !out.period) {
        report.dataset.state = 'none';
        line(t('La carte montre toutes vos trouvailles : aucun filtre à reprendre.'));
    } else {
        report.dataset.state = 'taken';
        line(out.count === 1
            ? t('Filtres de la carte repris (1 trouvaille) : vérifiez-les, puis appliquez.')
            : t('Filtres de la carte repris (${n} trouvailles) : vérifiez-les, puis appliquez.', { n: nf.format(out.count) }));
    }
    if (out.period) {
        const row = document.createElement('div');
        row.className = 'form-check mb-1';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'form-check-input';
        input.id = 'statsMapPeriod';
        input.checked = true;
        const label = document.createElement('label');
        label.className = 'form-check-label';
        label.htmlFor = input.id;
        label.textContent = t('Période du tableau de bord : ${range} (dates de trouvaille de la carte)', {
            range: state.labels.periodChoiceLabel(out.period),
        });
        row.append(input, label);
        report.append(row);
    }
    const notes = out.notes.map(mapFilterNote).filter(Boolean);
    if (notes.length) {
        line(t('Sans équivalent ici :'), 'text-muted');
        const list = document.createElement('ul');
        list.className = 'text-muted mb-1';
        for (const text of notes) {
            const li = document.createElement('li');
            li.textContent = text;
            list.append(li);
        }
        report.append(list);
    }
}

// Cartes reconstruites ou réutilisées : une carte dont le contenu (item +
// état de ses sources) n'a pas changé garde son DOM et son instance ECharts —
// déplacer, renommer ou ajouter une carte ne redessine pas tout le tableau.
function cardKey(item) {
    const failed = chartSources(item.spec).some((s) => state.sourceErrors.has(s));
    return JSON.stringify(item) + (failed ? '|erreur' : '');
}

function releaseCard(id) {
    state.charts.get(id)?.dispose();
    state.charts.delete(id);
    state.rendered.delete(id);
    state.deferred.delete(id);
}

// Les états de menu qui dépendent de la position, pas du contenu.
function syncCardMenuState(card, index, count) {
    const set = (action, disabled) => {
        const button = card.querySelector('[data-action=' + action + ']');
        if (button) button.disabled = disabled;
    };
    set('duplicate', count >= MAX_ITEMS);
    set('before', index === 0);
    set('after', index === count - 1);
}

function renderDashboard() {
    renderToolbar();
    const dashboard = activeDashboard();
    const grid = $('statsGrid');
    const count = dashboard.items.length;

    const previous = new Map();
    for (const el of grid.querySelectorAll('.stats-card')) previous.set(el.dataset.chartId, el);

    const placed = dashboard.items.map((item, index) => {
        const key = cardKey(item);
        let card = previous.get(item.spec.id);
        if (card) previous.delete(item.spec.id);
        if (card && card.dataset.itemKey !== key) {
            releaseCard(item.spec.id); // contenu changé : instance libérée
            card = null;
        }
        if (!card) {
            card = cardElement(item, index, count);
            card.dataset.itemKey = key;
        }
        syncCardMenuState(card, index, count);
        return card;
    });
    // Cartes retirées ou remplacées : leurs instances ECharts sont libérées.
    for (const [id] of previous) releaseCard(id);
    state.results.clear();
    state.resizeObserver.disconnect();
    grid.replaceChildren(...placed);
    $('statsGridEmpty').hidden = count > 0;
    $('btnStatsAddChart').disabled = count >= MAX_ITEMS;
    renderAllCharts();
}

// Sélecteur d'une carte (identifiant hexadécimal, sans caractère à échapper).
function cardSelector(id) {
    return '[data-chart-id=' + CSS.escape(id) + ']';
}

function cardElement(item, index, count) {
    const { spec } = item;
    const card = document.createElement('article');
    card.className = `stats-card stats-size-${item.size}`;
    card.style.setProperty('--stats-cols', SIZE_COLUMNS[item.size]);
    card.style.setProperty('--stats-chart-height', HEIGHT_PIXELS[item.height || 'M'] + 'px');
    card.dataset.chartId = spec.id;
    card.dataset.chart = spec.view.chart;
    card.dataset.height = item.height || 'M';

    const header = document.createElement('header');
    header.className = 'stats-card-header';
    // Poignée : glisser la carte ailleurs dans la grille (le menu garde
    // « Déplacer avant / après » pour le clavier).
    const grip = document.createElement('span');
    grip.className = 'stats-card-grip ti ti-grip-vertical';
    grip.title = t('Glisser pour déplacer');
    grip.setAttribute('aria-hidden', 'true');
    header.append(grip);
    const title = document.createElement('h2');
    title.className = 'stats-card-title';
    title.textContent = chartTitle(spec);
    header.append(title);
    if (hasOwnPeriod(spec) || periodsAreMultiple(spec.periods)) {
        const badge = document.createElement('span');
        badge.className = 'stats-card-period';
        badge.textContent = periodsBadge(spec);
        badge.title = hasOwnPeriod(spec)
            ? t('Période propre à ce graphique') + ' : ' + badge.textContent
            : badge.textContent;
        header.append(badge);
    }
    header.append(cardMenu(spec, index, count));
    card.append(header);
    if (spec.filters !== null) {
        // Filtres propres, VISIBLES (plus seulement en infobulle) : ils
        // remplacent ceux du tableau de bord — le périmètre se lit d'un coup.
        const scope = document.createElement('p');
        scope.className = 'stats-card-scope';
        const icon = document.createElement('i');
        icon.className = 'ti ti-filter stats-card-filter';
        icon.setAttribute('aria-hidden', 'true');
        const described = describeFilters(spec.filters, filterValueLabel)
            .map(({ field, values }) => state.labels.filterField(field) + ' : ' + values.join(', '));
        const text = document.createElement('span');
        text.className = 'stats-card-scope-text';
        text.textContent = t('Filtres propres') + ' : '
            + (described.length ? described.join(' · ') : t('aucun — les filtres du tableau sont ignorés'));
        scope.append(icon, text);
        scope.title = t('Ces filtres remplacent ceux du tableau de bord : ${what}',
            { what: text.textContent.slice(t('Filtres propres').length + 3) });
        card.append(scope);
    }

    const body = document.createElement('div');
    body.className = 'stats-card-body';
    body.append(cardBodyContent(spec));
    card.append(body);
    const note = document.createElement('p');
    note.className = 'stats-card-note';
    note.hidden = true;
    card.append(note);
    // Coin : glisser pour changer la largeur (S → XL) et la hauteur.
    const resize = document.createElement('span');
    resize.className = 'stats-card-resize';
    resize.title = t('Glisser pour redimensionner');
    resize.setAttribute('aria-hidden', 'true');
    card.append(resize);
    return card;
}

// Contenu d'un corps de carte : le chiffre clé ou l'hôte du graphique.
// Réutilisé par renderAllCharts pour restaurer le conteneur après un état
// « indisponible » affiché à sa place.
function cardBodyContent(spec) {
    if (spec.view.chart === 'number') {
        const number = document.createElement('div');
        number.className = 'stats-number';
        return number;
    }
    const host = document.createElement('div');
    host.className = 'stats-chart';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', chartTitle(spec));
    return host;
}

// Une source n'a pas pu être chargée : le graphique affiche l'explication et
// une relance plutôt qu'un rendu qui ressemblerait à un vrai zéro.
function unavailableBlock(failed) {
    const box = document.createElement('div');
    box.className = 'stats-card-unavailable';
    const icon = document.createElement('i');
    icon.className = 'ti ti-cloud-off';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('p');
    const names = failed.map((source) => source.startsWith('evolution:')
        ? t('Jeu « ${name} »', { name: datasetName(source.split(':')[1]) })
        : state.labels.sourceLabel(source)).join(' · ');
    text.textContent = t('${names} : données indisponibles', { names });
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm btn-outline-secondary stats-card-retry';
    retry.textContent = t('Réessayer');
    const refresh = document.createElement('i');
    refresh.className = 'ti ti-refresh me-1';
    refresh.setAttribute('aria-hidden', 'true');
    retry.prepend(refresh);
    box.append(icon, text, retry);
    return box;
}

function menuButton(action, icon, label, { danger = false, disabled = false } = {}) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'dropdown-item text-danger' : 'dropdown-item';
    button.dataset.action = action;
    button.disabled = disabled;
    const i = document.createElement('i');
    i.className = `ti ${icon} me-2`;
    i.setAttribute('aria-hidden', 'true');
    button.append(i, document.createTextNode(label));
    li.append(button);
    return li;
}

// « Envoyer en panneau vidéo » : grisé (avec la raison en bulle) quand le
// graphique n'a pas d'équivalent.
function panelMenuButton(spec) {
    const out = panelFromSpec(spec, { title: '' });
    const li = menuButton('to-panel', 'ti-movie', t('Envoyer en panneau vidéo'), { disabled: Boolean(out.error) });
    if (out.error) {
        li.title = out.error === 'several-sources'
            ? t("Un panneau vidéo ne compte qu'une source.")
            : t("Ce graphique n'a pas d'équivalent en panneau vidéo.");
    }
    return li;
}

function cardMenu(spec, index, count) {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown stats-card-menu';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost-secondary btn-icon btn-sm';
    toggle.dataset.bsToggle = 'dropdown';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', t('Actions du graphique'));
    toggle.title = t('Actions du graphique');
    const icon = document.createElement('i');
    icon.className = 'ti ti-dots';
    icon.setAttribute('aria-hidden', 'true');
    toggle.append(icon);
    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu dropdown-menu-end';
    const divider = document.createElement('li');
    divider.innerHTML = '<hr class="dropdown-divider">';
    // Source en échec : pas d'image ni de vidéo à produire.
    const unavailable = chartSources(spec).some((s) => state.sourceErrors.has(s));
    menu.append(
        menuButton('edit', 'ti-pencil', t('Modifier')),
        menuButton('duplicate', 'ti-copy', t('Dupliquer'), { disabled: count >= MAX_ITEMS }),
        menuButton('values', 'ti-table', t('Voir les valeurs'), { disabled: unavailable }),
        menuButton('export', 'ti-download', t('Exporter en image (PNG)'), { disabled: unavailable || spec.view.chart === 'number' }),
        menuButton('export-svg', 'ti-vector', t('Exporter en image vectorielle (SVG)'), { disabled: unavailable || spec.view.chart === 'number' }),
        panelMenuButton(spec),
        menuButton('video', 'ti-video', t('Créer une vidéo animée'), { disabled: unavailable || !chartAnimates(spec) }),
        menuButton('before', 'ti-arrow-left', t('Déplacer avant'), { disabled: index === 0 }),
        menuButton('after', 'ti-arrow-right', t('Déplacer après'), { disabled: index === count - 1 }),
        divider,
        menuButton('delete', 'ti-trash', t('Supprimer'), { danger: true }),
    );
    wrap.append(toggle, menu);
    return wrap;
}

// Le résultat ne dépend que de la requête effective et des données : il est
// mémorisé (dataRev invalide à chaque rechargement de source). Le cache est
// borné — l'aperçu de l'éditeur génère une clé par frappe.
const RESULT_CACHE_MAX = 300;

function computeResult(spec, dashboard) {
    const key = JSON.stringify({ spec, period: dashboard.period, filters: dashboard.filters,
        kind: dashboard.kind, dataset: dashboard.dataset, today: state.today }) + '|' + state.dataRev;
    const cached = state.resultCache.get(key);
    if (cached) {
        // Réinsertion : l'entrée la plus ancienne partira en première.
        state.resultCache.delete(key);
        state.resultCache.set(key, cached);
        return cached;
    }
    const result = runChartQueries(spec, tableOf, {
        ...effectiveQueryOptions(spec, dashboard),
        today: state.today,
        labelOf: (dim, key) => state.labels.axisLabel(dim, key, { attributeName }),
    });
    if (state.resultCache.size >= RESULT_CACHE_MAX) {
        state.resultCache.delete(state.resultCache.keys().next().value);
    }
    state.resultCache.set(key, result);
    return result;
}

function chartContext() {
    return { labels: state.labels, tokens: state.tokens, typeColors: state.typeColors, attributeName,
        reduceMotion: state.reduceMotion };
}

// Note sous un graphique : ce qui n'est pas compté ou a été coupé.
function cardNote(result, spec) {
    const notes = [];
    if (spec.groupBy === 'attribute' && result.meta.noAttribute) {
        notes.push(t('Sans attribut : ${n}', { n: result.meta.noAttribute }));
    }
    if (result.truncated) notes.push(t('Seules les 8 périodes les plus récentes sont affichées.'));
    const chart = spec.view.chart;
    if (chart === 'challenge' && result.meta.unknown) {
        const n = result.meta.unknown;
        notes.push(spec.groupBy === 'dt' ? t('Sans D/T : ${n}', { n }) : t('Sans date de publication : ${n}', { n }));
    }
    if ((chart === 'calendar' || chart === 'heatmap' || chart === 'challenge') && result.periods.length > 1) {
        notes.push(t('Seule la première période est dessinée.'));
    }
    if (chart === 'calendar' && calendarYears(result).truncated) {
        notes.push(t('Seules les 3 années les plus récentes sont dessinées.'));
    }
    if (result.toDate) {
        const date = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
            .format(new Date(result.toDate.day * 86400000));
        notes.push(t('Comparaison à date : chaque période est arrêtée au ${date}.', { date }));
    }
    if (!result.meta.rows) notes.push(t('Aucune donnée sur cette période.'));
    return notes.join(' · ');
}

function renderNumber(container, result, spec, dashboard) {
    const entries = numberModel(result, spec, chartContext());
    container.replaceChildren();
    for (const entry of entries) {
        const block = document.createElement('div');
        block.className = 'stats-number-block';
        const value = document.createElement('div');
        value.className = 'stats-number-value';
        value.textContent = entry.text;
        const caption = document.createElement('div');
        caption.className = 'stats-number-caption';
        const { periods } = effectiveQueryOptions(spec, dashboard);
        caption.textContent = entry.label || state.labels.periodChoiceLabel(periods[0]);
        block.append(value, caption);
        // Record daté : ses jours, et la carte de ces jours-là.
        if (entry.record) {
            const record = document.createElement('div');
            record.className = 'stats-number-record';
            record.textContent = entry.record;
            block.append(record);
            if (chartClickable(spec, result)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-link btn-sm stats-number-map';
                button.innerHTML = '<i class="ti ti-map me-1" aria-hidden="true"></i>';
                button.append(document.createTextNode(t('Voir sur la carte')));
                const seriesIndex = entries.indexOf(entry);
                button.addEventListener('click', () => confirmMapLink(spec.id, { seriesIndex, keyIndex: 0 }));
                block.append(button);
            }
        }
        if (entry.delta) block.append(deltaLine(entry.delta));
        container.append(block);
    }
}

// « ▲ +12 (+18 %) par rapport à 2025 » : la flèche porte le sens (et sa
// couleur), le texte reste dans les couleurs de texte.
function deltaLine(delta) {
    const line = document.createElement('div');
    line.className = 'stats-number-delta';
    line.classList.add(delta.sign > 0 ? 'is-up' : delta.sign < 0 ? 'is-down' : 'is-flat');
    const icon = document.createElement('i');
    icon.className = `ti ${delta.sign > 0 ? 'ti-trending-up' : delta.sign < 0 ? 'ti-trending-down' : 'ti-minus'}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = delta.ratio ? delta.text + ' (' + delta.ratio + ')' : delta.text;
    line.append(icon, document.createTextNode(' ' + text + ' ' + delta.versus));
    return line;
}

// Les marques d'un graphique ouvrent-elles la carte ? (curseur « main »)
const TIME_DIMS = new Set(['year', 'quarter', 'month', 'week', 'day']);
function chartClickable(spec, result) {
    if (!chartLinksToMap(spec) || result.delta) return false;
    // Chiffre clé : seulement un record daté (« Voir sur la carte »).
    if (spec.view.chart === 'number') return spec.measure.op === 'max_per_day' || spec.measure.op === 'streak';
    return !['heatmap', 'radar'].includes(spec.view.chart);
}

// Bilan d'une grille de défi (relevé E2E).
function challengeSnapshot(result) {
    const text = result?.grid ? challengeText(result, chartContext()) : null;
    if (!text) return null;
    const { filled, available, loops, next } = text.summary;
    return { metric: result.grid.metric, filled, available, loops, next: next.length,
        coverage: text.coverage, tours: text.tours, missing: text.missing };
}

function renderChartInto(host, result, spec) {
    const width = host.clientWidth || host.parentElement?.clientWidth || 0;
    const option = buildChartOption(result, spec, { ...chartContext(), width });
    if (!chartClickable(spec, result)) {
        for (const series of option.series || []) series.cursor = 'default';
    }
    // Calendrier : un bandeau par année, la carte s'allonge.
    const height = chartHeight(result, spec, width);
    host.style.height = height ? height + 'px' : '';
    // Les cases du calendrier ont une taille en pixels, calculée sur la
    // largeur : un redimensionnement qui la change impose un nouveau dessin
    // (onHostsResized), pas un simple resize().
    if (spec.view.chart === 'calendar') host.dataset.calendarCell = String(calendarCell(width));
    else delete host.dataset.calendarCell;
    // Grille de défi : cases carrées et centrées sur la largeur dessinée.
    if (spec.view.chart === 'challenge') host.dataset.challengeWidth = String(width);
    else delete host.dataset.challengeWidth;
    let chart = window.echarts.getInstanceByDom(host);
    if (!chart) {
        chart = window.echarts.init(host, null, { locale: echartsLocale(), renderer: 'canvas' });
        chart.on('click', (params) => onChartClick(host, params));
    }
    chart.setOption(option, true);
    chart.resize();
    return chart;
}

// Au-delà de ce nombre de cartes, celles hors écran ne sont dessinées qu'à
// l'approche (le résultat est calculé quand même : exports et relevés exacts).
const DEFER_CHARTS_BEYOND = 12;
const DEFER_MARGIN_PX = 400;

function nearViewport(host) {
    const rect = host.getBoundingClientRect();
    return rect.bottom > -DEFER_MARGIN_PX && rect.top < window.innerHeight + DEFER_MARGIN_PX;
}

// Dessine le contenu d'une carte : bloc « indisponible », chiffre clé ou
// graphique ECharts (différé si la carte est loin de l'écran).
function renderCard(item, card, dashboard) {
    const { spec } = item;
    const body = card.querySelector('.stats-card-body');
    const note = card.querySelector('.stats-card-note');
    const failed = chartSources(spec).filter((s) => state.sourceErrors.has(s));
    if (failed.length) {
        state.results.set(spec.id, { result: null, spec, error: failed });
        state.rendered.delete(spec.id);
        note.hidden = true;
        body.replaceChildren(unavailableBlock(failed));
        return;
    }
    const result = computeResult(spec, dashboard);
    state.results.set(spec.id, { result, spec });
    // Après un état « indisponible », remettre le conteneur attendu.
    if (!body.querySelector('.stats-chart, .stats-number')) {
        body.replaceChildren(cardBodyContent(spec));
    }
    note.textContent = cardNote(result, spec);
    note.hidden = !note.textContent;
    const seen = state.rendered.get(spec.id);
    const fresh = seen?.result === result && seen.tokensRev === state.tokensRev;
    if (spec.view.chart === 'number') {
        if (!fresh) {
            renderNumber(card.querySelector('.stats-number'), result, spec, dashboard);
            state.rendered.set(spec.id, { result, tokensRev: state.tokensRev });
        }
        return;
    }
    const host = card.querySelector('.stats-chart');
    if (state.charts.has(spec.id) && fresh) {
        // Même requête, même thème : l'instance déjà dessinée suffit.
        state.resizeObserver.observe(host);
        return;
    }
    // Grande collection, carte loin de l'écran : dessin différé à l'approche.
    if (!window.echarts.getInstanceByDom(host) && dashboard.items.length > DEFER_CHARTS_BEYOND && !nearViewport(host)) {
        host.classList.add('is-pending');
        state.deferred.add(spec.id);
        state.lazyObserver.observe(host);
        return;
    }
    host.classList.remove('is-pending');
    state.deferred.delete(spec.id);
    state.lazyObserver?.unobserve(host);
    state.charts.set(spec.id, renderChartInto(host, result, spec));
    state.rendered.set(spec.id, { result, tokensRev: state.tokensRev });
    state.resizeObserver.observe(host);
}

function renderAllCharts() {
    if (!state.tokens) state.tokens = readTokens();
    state.deferred.clear();
    state.lazyObserver?.disconnect();
    state.lazyObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target.closest('.stats-card');
            const item = card && activeDashboard().items.find((i) => i.spec.id === card.dataset.chartId);
            if (item) renderCard(item, card, activeDashboard());
        }
    }, { rootMargin: DEFER_MARGIN_PX + 'px' });
    const dashboard = activeDashboard();
    for (const item of dashboard.items) {
        const card = $('statsGrid').querySelector(cardSelector(item.spec.id));
        if (card) renderCard(item, card, dashboard);
    }
}

// Cartes différées dessinées d'office : export ou impression. Sans
// argument, toutes les cartes différées ; sinon une seule.
function renderDeferred(onlyId = null) {
    const dashboard = activeDashboard();
    for (const id of [...state.deferred]) {
        if (onlyId && id !== onlyId) continue;
        const card = $('statsGrid').querySelector(cardSelector(id));
        const item = card && dashboard.items.find((i) => i.spec.id === id);
        if (item) renderCard(item, card, dashboard);
    }
}

// Redimensionnement d'un graphique (fenêtre, carte) : ECharts suit la
// nouvelle taille ; un calendrier dont la taille de case change est redessiné
// — au cadre suivant, car le redessin change la hauteur de l'hôte et
// relancerait l'observateur pendant sa propre notification.
const resizedCalendars = new Set();

function onHostsResized(entries) {
    for (const { target: host } of entries) {
        const drawn = host.dataset.calendarCell;
        const challengeWidth = host.dataset.challengeWidth;
        if ((drawn !== undefined && Number(drawn) !== calendarCell(host.clientWidth))
            || (challengeWidth !== undefined && Number(challengeWidth) !== host.clientWidth)) {
            if (!resizedCalendars.size) requestAnimationFrame(redrawResizedCalendars);
            resizedCalendars.add(host);
            continue;
        }
        window.echarts.getInstanceByDom(host)?.resize();
    }
}

function redrawResizedCalendars() {
    const hosts = [...resizedCalendars];
    resizedCalendars.clear();
    for (const host of hosts) {
        if (!host.isConnected) continue;
        if (host === $('statsEdPreview')) {
            renderPreview();
            continue;
        }
        const id = host.closest('.stats-card')?.dataset.chartId;
        const entry = id && state.results.get(id);
        if (entry?.result) state.charts.set(id, renderChartInto(host, entry.result, entry.spec));
    }
}

// ---------------------------------------------------------------------------
// Retour à la carte : clic sur une valeur → carte filtrée sur ces trouvailles
// ---------------------------------------------------------------------------

// Ce que la carte montrera, en clair : « février 2024 · Taille : Micro ».
function mapLinkSummary(spec, result, target, link) {
    const parts = [];
    const fmt = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const dates = link.selection.dates;
    if (dates) {
        const from = fmt.format(new Date(dates.startDate + 'T00:00:00Z'));
        const to = fmt.format(new Date(dates.endDate + 'T00:00:00Z'));
        parts.push(from === to ? from : t('du ${from} au ${to}', { from, to }));
    }
    const category = (dim, key) => {
        if (dim === 'none' || TIME_DIMS.has(dim) || ELAPSED_UNITS[dim]) return;
        parts.push(state.labels.dimension(dim) + ' : ' + state.labels.axisLabel(dim, key, { long: true, attributeName }));
    };
    category(result.dim, result.keys[target.keyIndex]);
    const series = result.series[target.seriesIndex];
    if (series.split !== null && series.split !== undefined) category(spec.splitBy, series.split);
    if (activeFilterCount(effectiveQueryOptions(spec, activeDashboard()).filters)) {
        parts.push(t('filtres du graphique'));
    }
    return parts.join(' · ') || t('toutes vos trouvailles');
}

// Sélection de la carte pour un clic, ou null (pas de lien).
function mapLinkFor(chartId, target) {
    const entry = state.results.get(chartId);
    if (!entry || !target) return null;
    const { spec, result } = entry;
    if (!result || !chartClickable(spec, result)) return null;
    const finds = tableOf('finds');
    return mapSelectionFor({
        spec,
        result,
        seriesIndex: target.seriesIndex,
        keyIndex: target.keyIndex,
        filters: effectiveQueryOptions(spec, activeDashboard()).filters,
        countries: finds.dicts?.country || [],
    });
}

function presentKinds() {
    const finds = tableOf('finds');
    const seen = new Set();
    for (let r = 0; r < finds.n && seen.size < SOURCE_KIND_VALUES.length; r++) seen.add(finds.kind[r]);
    return SOURCE_KIND_VALUES.filter((_, i) => seen.has(i));
}

async function openMapWith(link) {
    try {
        localStorage.setItem('filtersSelection', JSON.stringify(link.selection));
    } catch (e) {
        showError(t('Impossible de préparer les filtres de la carte.'));
        return;
    }
    // Géocaches / Labs : préférence globale de la carte, posée si le
    // graphique compte un autre type de points que ceux affichés.
    const current = window.userSettings?.main_discovery_sources || 'geocaches';
    const mode = discoveryModeFor(link.kinds, presentKinds(), current);
    if (mode) {
        try {
            await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ main_discovery_sources: mode }),
            });
        } catch (e) {
            console.warn('[stats] Sources de la carte non changées :', e?.message || e);
        }
    }
    window.location.assign('/');
}

function onChartClick(host, params) {
    const card = host.closest('.stats-card');
    const entry = card ? state.results.get(card.dataset.chartId) : null;
    if (!entry?.result || !chartClickable(entry.spec, entry.result)) return;
    const target = clickTarget(entry.result, entry.spec, params);
    if (!target) return;
    confirmMapLink(card.dataset.chartId, target);
}

// Confirmation puis carte filtrée sur une valeur (ou un record daté).
function confirmMapLink(chartId, target) {
    const entry = state.results.get(chartId);
    const link = mapLinkFor(chartId, target);
    if (!entry || !link) {
        showToast(t("Cette valeur n'a pas d'équivalent dans les filtres de la carte."), 'info');
        return;
    }
    showConfirmation(
        t('La carte affichera ces trouvailles : ${what}. Ses filtres actuels seront remplacés.', {
            what: mapLinkSummary(entry.spec, entry.result, target, link),
        }),
        t('Voir sur la carte'),
        () => openMapWith(link),
        null,
        { confirmText: t('Ouvrir la carte') },
    );
}

// ---------------------------------------------------------------------------
// Envoyer en panneau vidéo (onglet Stats des pages carte)
// ---------------------------------------------------------------------------

const PANEL_PAGE_NAMES = {
    main: () => t('Mes Géocaches'),
    poses: () => t('Mes poses'),
    evolution: () => t('Évolution'),
};

async function appendPanel(out) {
    const pageName = PANEL_PAGE_NAMES[out.page]();
    try {
        const settings = await fetchJson('/api/settings');
        const list = Array.isArray(settings?.stats?.[out.list]) ? settings.stats[out.list] : [];
        if (list.length >= STATS_MAX_PANELS) {
            showError(t('La page « ${page} » a déjà ${n} panneaux : retirez-en un dans son onglet Stats.', {
                page: pageName, n: STATS_MAX_PANELS,
            }));
            return false;
        }
        const response = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stats: { [out.list]: [...list, out.panel] } }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (e) {
        console.warn('[stats] Panneau non envoyé :', e?.message || e);
        showError(t("L'envoi du panneau a échoué."));
        return false;
    }
    showToast(t('Panneau ajouté à la page « ${page} » : il apparaîtra sur la carte et dans la vidéo.', { page: pageName }), 'success');
    return true;
}

function sendToPanel(spec) {
    const { periods, filters } = effectiveQueryOptions(spec, activeDashboard());
    const out = panelFromSpec(spec, { title: chartTitle(spec), periods, filters });
    if (out.error) return;
    const pageName = PANEL_PAGE_NAMES[out.page]();
    const intro = t("Le graphique devient un panneau de la page « ${page} », qui se remplit au fil de l'animation.", { page: pageName });
    const warning = out.dropped.length
        ? ' ' + t('Il suit la période et les filtres de la carte : la période, les filtres et le découpage de ce graphique ne sont pas repris.')
        : '';
    showConfirmation(intro + warning, t('Envoyer en panneau vidéo'), () => appendPanel(out), null, { confirmText: t('Envoyer') });
}

// ---------------------------------------------------------------------------
// Vidéo animée : le graphique dessiné image par image hors écran, enregistré
// (MediaRecorder), puis converti en MP4 par le serveur (même traitement que
// les vidéos de la carte). Repli : le WebM brut, téléchargeable.
// ---------------------------------------------------------------------------

const videoModal = () => getBsModal($('statsVideoModal'));

// setup → recording → done ; « Annuler » devient « Fermer » à la fin.
function setVideoPhase(phase) {
    if (state.video) state.video.phase = phase;
    $('statsVideoSetup').hidden = phase !== 'setup';
    $('statsVideoRecording').hidden = phase !== 'recording';
    $('statsVideoDone').hidden = phase !== 'done';
    $('btnStatsVideoStart').hidden = phase !== 'setup';
    $('btnStatsVideoReveal').hidden = phase !== 'done' || !state.video?.file;
    $('btnStatsVideoDownload').hidden = phase !== 'done';
    $('btnStatsVideoCancel').textContent = phase === 'done' ? t('Fermer') : t('Annuler');
}

function setVideoStatus(text, percent = null) {
    $('statsVideoStatus').textContent = text;
    if (percent !== null) {
        const bar = $('statsVideoProgress');
        bar.style.width = Math.round(percent) + '%';
        bar.parentElement.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
}

function releaseVideo() {
    const video = state.video;
    if (!video) return;
    video.cancelled = true;
    const player = $('statsVideoPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (video.objectUrl) URL.revokeObjectURL(video.objectUrl);
    $('statsVideoStage').replaceChildren();
    state.video = null;
}

function openVideo(spec) {
    const entry = state.results.get(spec.id);
    if (!entry?.result || !chartAnimates(spec, entry.result)) {
        showToast(t('Ce graphique ne peut pas être animé.'), 'info');
        return;
    }
    releaseVideo();
    const select = $('statsVideoDuration');
    if (!select.options.length) {
        for (const seconds of VIDEO_DURATIONS) select.add(new Option(t('${n} secondes', { n: seconds }), String(seconds)));
        select.value = '10';
    }
    state.video = { spec, phase: 'setup', cancelled: false, file: null, objectUrl: null };
    setVideoPhase('setup');
    videoModal().show();
}

function videoMimeType() {
    const recorder = window.MediaRecorder;
    if (!recorder?.isTypeSupported) return null;
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => recorder.isTypeSupported(type)) || null;
}

// Une image : titre, repère de l'axe atteint (« Mars »), graphique partiel.
function videoPainter(spec, result, { width, height }) {
    const tokens = state.tokens || readTokens();
    // Les polices d'ECharts (12 px) sont pensées pour l'écran : le graphique
    // est mis en page comme sur une fenêtre de 540 px de haut puis dessiné en
    // pleine définition (devicePixelRatio) — textes lisibles dans la vidéo.
    const scale = Math.min(width, height) / 540;
    const pad = Math.round(28 * scale);
    const titleSize = Math.round(24 * scale);
    const top = pad * 2 + titleSize;
    const chartW = width - pad * 2;
    const chartH = height - top - pad;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + Math.round(chartW / scale) + 'px;height:' + Math.round(chartH / scale) + 'px';
    document.body.append(box);
    const chart = window.echarts.init(box, null, {
        renderer: 'canvas', devicePixelRatio: scale, locale: echartsLocale(),
        width: Math.round(chartW / scale), height: Math.round(chartH / scale),
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const stacked = spec.view.stack && result.series.length > 1;
    const max = spec.view.log ? undefined : niceCeil(valueMax(result, { stacked }));
    const kind = spec.view.chart === 'bar' ? 'bar' : 'line';
    const ctx = { ...chartContext(), tokens, width: chartW / scale };
    const heads = axisLabels(result, ctx, { long: true });
    const title = chartTitle(spec);
    const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    const paint = (progress) => {
        const option = lockOption(buildChartOption(revealResult(result, progress, { chart: kind }), spec, ctx), max);
        chart.setOption(option, true);
        g.fillStyle = tokens.surface;
        g.fillRect(0, 0, width, height);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'left';
        g.fillStyle = tokens.text;
        g.font = '600 ' + titleSize + 'px ' + font;
        g.fillText(title, pad, pad + titleSize * 0.9, width - pad * 2 - titleSize * 6);
        g.textAlign = 'right';
        g.fillStyle = tokens.textMuted;
        g.font = '700 ' + Math.round(titleSize * 1.15) + 'px ' + font;
        g.fillText(heads[revealIndex(result, progress)] ?? '', width - pad, pad + titleSize * 0.9);
        const source = box.querySelector('canvas');
        if (source) g.drawImage(source, pad, top, chartW, chartH);
    };
    const dispose = () => {
        chart.dispose();
        box.remove();
    };
    return { canvas, paint, dispose };
}

// Avance du temps de la vidéo : requestAnimationFrame quand la page est
// visible, minuteur sinon (un onglet masqué n'a plus d'images).
const nextFrame = (fn) => (document.hidden ? setTimeout(fn, 1000 / VIDEO_FPS) : requestAnimationFrame(fn));

async function recordVideo() {
    const video = state.video;
    const entry = video && state.results.get(video.spec.id);
    if (!entry?.result) return;
    const mimeType = videoMimeType();
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
        showError(t("Ce navigateur ne sait pas enregistrer de vidéo."));
        return;
    }
    const size = VIDEO_SIZES[$('statsVideoSize').value] || VIDEO_SIZES.hd;
    const duration = (Number($('statsVideoDuration').value) || 10) * 1000;
    const { spec, result } = entry;
    setVideoPhase('recording');
    setVideoStatus(t('Enregistrement…'), 0);
    const painter = videoPainter(spec, result, size);
    $('statsVideoStage').replaceChildren(painter.canvas);
    painter.paint(0);
    const stream = painter.canvas.captureStream(VIDEO_FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    const start = performance.now();
    await new Promise((resolve) => {
        const tick = () => {
            if (video.cancelled) return resolve();
            const elapsed = performance.now() - start;
            painter.paint(revealProgress(elapsed, duration));
            setVideoStatus(t('Enregistrement…'), Math.min(100, (elapsed / duration) * 100));
            if (elapsed >= duration) return resolve();
            return nextFrame(tick);
        };
        nextFrame(tick);
    });
    const recorded = performance.now() - start;
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    painter.dispose();
    if (video.cancelled) return;

    let blob = new Blob(chunks, { type: 'video/webm' });
    try {
        blob = (await fixWebmDuration(blob, recorded, { logger: false })) || blob;
    } catch (_) { /* durée non réécrite : ffmpeg la recalcule */ }
    await convertVideo(video, blob, fileSafe(chartTitle(spec)));
}

async function pollTask(id, onProgress) {
    const started = Date.now();
    for (;;) {
        if (Date.now() - started > 10 * 60 * 1000) throw new Error('timeout');
        const response = await fetch('/tasks/' + encodeURIComponent(id) + '?include_result=true');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const status = await response.json();
        if (typeof status.progress === 'number') onProgress(status.progress);
        if (status.state === 'finished') return status.result || {};
        if (status.state === 'failed') throw new Error(status.error || status.message || 'failed');
        await new Promise((resolve) => setTimeout(resolve, 700));
    }
}

// Conversion MP4 par le serveur ; à défaut, le WebM enregistré.
async function convertVideo(video, blob, name) {
    setVideoStatus(t('Conversion en MP4…'), 0);
    let result = null;
    try {
        const form = new FormData();
        form.append('video', blob, 'statistiques.webm');
        form.append('fileName', name);
        form.append('fps', String(VIDEO_FPS));
        form.append('slowdown', '1');
        const response = await fetch('/process_recorded_video', { method: 'POST', body: form });
        const data = await response.json();
        if (!data?.task_id) throw new Error(data?.message || 'no task');
        result = await pollTask(data.task_id, (p) => { if (!video.cancelled) setVideoStatus(t('Conversion en MP4…'), p); });
    } catch (e) {
        console.warn('[stats] Conversion vidéo impossible :', e?.message || e);
    }
    if (video.cancelled) return;
    const player = $('statsVideoPlayer');
    const download = $('btnStatsVideoDownload');
    if (result?.file) {
        video.file = result.file;
        video.folder = result.folder || null;
        const url = '/download_video/' + encodeURIComponent(result.file);
        player.src = url + '?inline=1';
        download.href = url;
        download.removeAttribute('download');
        $('statsVideoDoneNote').textContent = result.folder
            ? t('Vidéo enregistrée : ${file}, dans ${folder}.', { file: result.file, folder: result.folder })
            : result.file;
    } else {
        video.objectUrl = URL.createObjectURL(blob);
        player.src = video.objectUrl;
        download.href = video.objectUrl;
        download.download = name + '.webm';
        $('statsVideoDoneNote').textContent = t('La conversion en MP4 a échoué : la vidéo est proposée au format WebM.');
    }
    $('statsVideoStage').replaceChildren();
    setVideoPhase('done');
}

async function revealVideo() {
    const file = state.video?.file;
    if (!file) return;
    try {
        const response = await fetch('/reveal_video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
    } catch (e) {
        showError(t("Impossible d'ouvrir le dossier des vidéos."));
    }
}

function closeVideo() {
    videoModal().hide();
}

// ---------------------------------------------------------------------------
// Actions des cartes
// ---------------------------------------------------------------------------

function itemIndex(id) {
    return activeDashboard().items.findIndex((item) => item.spec.id === id);
}

// La dernière organisation des cartes est annulable : la copie d'avant la
// mutation est restaurée par « Annuler » dans le toast (un seul niveau —
// l'action la plus récente remplace la précédente).
function withUndo(message, mutate) {
    const dashboard = activeDashboard();
    const before = structuredClone(dashboard.items);
    mutate();
    scheduleSave({ immediate: true });
    renderDashboard();
    showActionToast(message, { label: t('Annuler'), onClick: () => {
        const current = state.doc?.dashboards.find((d) => d.id === dashboard.id);
        if (!current) return;
        current.items = structuredClone(before);
        scheduleSave({ immediate: true });
        renderDashboard();
    } });
}

function onCardAction(event) {
    const card = event.target.closest('.stats-card');
    if (!card) return;
    const retry = event.target.closest('.stats-card-retry');
    if (retry) {
        const item = activeDashboard().items[itemIndex(card.dataset.chartId)];
        if (item) retrySources(item.spec);
        return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const dashboard = activeDashboard();
    const index = itemIndex(card.dataset.chartId);
    if (index < 0) return;
    const item = dashboard.items[index];
    switch (button.dataset.action) {
        case 'edit':
            openEditor({ mode: 'edit', index, item });
            break;
        case 'duplicate': {
            if (dashboard.items.length >= MAX_ITEMS) return;
            const copy = { size: item.size, height: item.height, spec: createChartSpec(structuredClone(item.spec)) };
            withUndo(t('Graphique dupliqué.'), () => dashboard.items.splice(index + 1, 0, copy));
            break;
        }
        case 'values':
            openValues(item.spec);
            break;
        case 'export':
            exportPng(item.spec);
            break;
        case 'export-svg':
            exportSvg(item.spec);
            break;
        case 'to-panel':
            sendToPanel(item.spec);
            break;
        case 'video':
            openVideo(item.spec);
            break;
        case 'before':
        case 'after': {
            const target = button.dataset.action === 'before' ? index - 1 : index + 1;
            if (target < 0 || target >= dashboard.items.length) return;
            withUndo(t('Graphique déplacé.'), () => {
                [dashboard.items[index], dashboard.items[target]] = [dashboard.items[target], dashboard.items[index]];
            });
            break;
        }
        case 'delete':
            showConfirmation(
                t('Supprimer le graphique « ${title} » ?', { title: chartTitle(item.spec) }),
                t('Supprimer'),
                () => {
                    const i = itemIndex(item.spec.id);
                    if (i < 0) return;
                    withUndo(t('Graphique « ${title} » supprimé.', { title: chartTitle(item.spec) }),
                        () => activeDashboard().items.splice(i, 1));
                },
                null,
                { danger: true, confirmText: t('Supprimer') },
            );
            break;
        default:
            break;
    }
}

function fileSafe(name) {
    // « \/ » échappé dans la classe : sinon le lexer JS de pybabel ferme la
    // regex à ce « / » et perd les t() des ~500 lignes suivantes.
    return String(name).replace(/[\\\/:*?<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'graphique';
}

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// « Voir les valeurs » : les données du graphique en tableau, export CSV
// ---------------------------------------------------------------------------

// Lignes du tableau : affichage (cells) et valeurs brutes pour le CSV (raw).
function valuesModel(result, spec, dashboard) {
    const ctx = chartContext();
    if (spec.view.chart === 'number') {
        const { periods } = effectiveQueryOptions(spec, dashboard);
        return {
            head: [t('Période'), t('Valeur'), t('Écart')],
            rows: numberModel(result, spec, ctx).map((entry) => {
                const label = entry.label || state.labels.periodChoiceLabel(periods[0]);
                return {
                    cells: [label, entry.text, entry.delta ? entry.delta.text + ' ' + entry.delta.versus : ''],
                    raw: [label, entry.value ?? '', ''],
                };
            }),
        };
    }
    const fmt = (v) => state.labels.formatValue(v, spec.measure, { normalize: result.normalize });
    const columns = seriesIdentity(result, spec, ctx).map((s) => s.name);
    const delta = result.delta?.values || null;
    if (delta) columns.push(t('Écart'));
    const keys = axisLabels(result, ctx, { long: true });
    return {
        head: [state.labels.dimension(result.dim), ...columns],
        rows: result.keys.map((key, i) => ({
            cells: [keys[i], ...result.series.map((s) => fmt(s.values[i])),
                    ...(delta ? [fmt(delta[i])] : [])],
            raw: [keys[i], ...result.series.map((s) => s.values[i] ?? ''),
                    ...(delta ? [delta[i] ?? ''] : [])],
        })),
    };
}

function openValues(spec) {
    renderDeferred(spec.id);
    const entry = state.results.get(spec.id);
    if (!entry?.result) return;
    state.valuesSpec = spec;
    $('statsValuesTitle').textContent = chartTitle(spec);
    const { head, rows } = valuesModel(entry.result, spec, activeDashboard());
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const name of head) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = name;
        hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        row.cells.forEach((text, i) => {
            const cell = i === 0 ? document.createElement('th') : document.createElement('td');
            if (i === 0) cell.scope = 'row';
            cell.textContent = text;
            tr.append(cell);
        });
        tbody.append(tr);
    }
    $('statsValuesTable').replaceChildren(thead, tbody);
    getBsModal('statsValuesModal')?.show();
}

// CSV « français » : séparateur ; et BOM pour qu'Excel lise l'UTF-8.
function downloadValuesCsv() {
    const spec = state.valuesSpec;
    const entry = spec && state.results.get(spec.id);
    if (!entry?.result) return;
    const { head, rows } = valuesModel(entry.result, spec, activeDashboard());
    const cell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        // « \x22 » et non un guillemet littéral dans les regex : sinon le
        // lexer JS de pybabel croit qu'une chaîne s'ouvre (AGENTS.md).
        return /[;\x22\n]/.test(s) ? '"' + s.replace(/\x22/g, '""') + '"' : s;
    };
    const csv = String.fromCharCode(0xFEFF)
        + [head, ...rows.map((r) => r.raw)].map((r) => r.map(cell).join(';')).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileSafe(chartTitle(spec)) + '.csv');
}

// Image vectorielle : le même graphique redessiné hors écran par le moteur
// SVG d'ECharts, à la taille de la carte, fond de la carte compris.
export function chartSvg(spec) {
    renderDeferred(spec.id);
    const entry = state.results.get(spec.id);
    const chart = state.charts.get(spec.id);
    if (!entry || !chart) return null;
    const host = chart.getDom();
    const width = Math.max(200, host.clientWidth);
    const height = Math.max(150, host.clientHeight);
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + width + 'px;height:' + height + 'px';
    document.body.append(box);
    const svgChart = window.echarts.init(box, null, { renderer: 'svg', width, height, locale: echartsLocale() });
    try {
        const option = buildChartOption(entry.result, spec, { ...chartContext(), width });
        svgChart.setOption({ ...option, animation: false, backgroundColor: state.tokens.surface });
        return svgChart.renderToSVGString();
    } finally {
        svgChart.dispose();
        box.remove();
    }
}

function exportSvg(spec) {
    const svg = chartSvg(spec);
    if (svg) download(new Blob([svg], { type: 'image/svg+xml' }), fileSafe(chartTitle(spec)) + '.svg');
}

function exportPng(spec) {
    renderDeferred(spec.id);
    const chart = state.charts.get(spec.id);
    if (!chart) return;
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: state.tokens.surface });
    const link = document.createElement('a');
    link.href = url;
    link.download = fileSafe(chartTitle(spec)) + '.png';
    document.body.append(link);
    link.click();
    link.remove();
}

// ---------------------------------------------------------------------------
// Déplacer et redimensionner à la souris
// ---------------------------------------------------------------------------

// Glisser-déposer HTML5 : la carte ne devient « glissable » que saisie par
// sa poignée (sinon la sélection de texte et les graphiques s'en mêlent).
function onGridPointerDown(event) {
    const grip = event.target.closest('.stats-card-grip');
    if (grip) grip.closest('.stats-card').draggable = true;
    const corner = event.target.closest('.stats-card-resize');
    if (corner) startResize(event, corner.closest('.stats-card'));
}

function clearDropMarks() {
    for (const card of $('statsGrid').querySelectorAll('.drop-before, .drop-after')) {
        card.classList.remove('drop-before', 'drop-after');
    }
}

// Avant ou après la carte visée : moitié gauche / droite, ou haut / bas
// pour une carte pleine largeur.
function dropSide(card, event) {
    const rect = card.getBoundingClientRect();
    if (card.classList.contains('stats-size-XL')) return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
}

function onDragStart(event) {
    const card = event.target.closest?.('.stats-card');
    if (!card || !card.draggable) return;
    state.dragId = card.dataset.chartId;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragId);
}

function onDragOver(event) {
    if (!state.dragId) return;
    const card = event.target.closest('.stats-card');
    if (!card || card.dataset.chartId === state.dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    card.classList.add(dropSide(card, event) === 'before' ? 'drop-before' : 'drop-after');
}

function onDrop(event) {
    if (!state.dragId) return;
    const card = event.target.closest('.stats-card');
    event.preventDefault();
    const dragged = state.dragId;
    endDrag();
    if (!card || card.dataset.chartId === dragged) return;
    const items = activeDashboard().items;
    const from = items.findIndex((item) => item.spec.id === dragged);
    if (from < 0) return;
    withUndo(t('Graphique déplacé.'), () => {
        const [moved] = items.splice(from, 1);
        let to = items.findIndex((item) => item.spec.id === card.dataset.chartId);
        if (dropSide(card, event) === 'after') to += 1;
        items.splice(to, 0, moved);
    });
}

function endDrag() {
    state.dragId = null;
    clearDropMarks();
    for (const card of $('statsGrid').querySelectorAll('.stats-card')) {
        card.classList.remove('is-dragging');
        card.draggable = false;
    }
}

// Coin de redimensionnement : la largeur suit la souris par colonnes de la
// grille et se cale sur la taille la plus proche (S, M, L, XL) ; tirer
// vers le bas d'au moins 60 px donne la grande hauteur, vers le haut la
// normale. Validé au relâcher.
const SIZE_BY_COLUMNS = DASHBOARD_SIZES.map((size) => [SIZE_COLUMNS[size], size]);

function nearestSize(columns) {
    return SIZE_BY_COLUMNS.reduce((best, [cols, size]) => (
        Math.abs(cols - columns) < Math.abs(SIZE_COLUMNS[best] - columns) ? size : best), 'M');
}

function startResize(event, card) {
    event.preventDefault();
    const index = itemIndex(card.dataset.chartId);
    if (index < 0) return;
    const item = activeDashboard().items[index];
    const grid = $('statsGrid');
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
    const column = (grid.clientWidth - 11 * gap) / 12 + gap;
    const start = { x: event.clientX, y: event.clientY, cols: SIZE_COLUMNS[item.size], height: item.height || 'M' };
    let size = item.size;
    let height = start.height;
    card.classList.add('is-resizing');
    const apply = () => {
        card.classList.remove(...DASHBOARD_SIZES.map((s) => 'stats-size-' + s));
        card.classList.add('stats-size-' + size);
        card.style.setProperty('--stats-cols', SIZE_COLUMNS[size]);
        card.style.setProperty('--stats-chart-height', HEIGHT_PIXELS[height] + 'px');
        card.dataset.height = height;
    };
    const move = (e) => {
        size = nearestSize(start.cols + (e.clientX - start.x) / column);
        const dy = e.clientY - start.y;
        height = dy > 60 ? 'L' : dy < -60 ? 'M' : start.height;
        apply();
    };
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        card.classList.remove('is-resizing');
        if (size === item.size && height === (item.height || 'M')) return;
        withUndo(t('Taille du graphique modifiée.'), () => {
            item.size = size;
            item.height = height;
        });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// Impression : toujours sur fond clair
// ---------------------------------------------------------------------------

function onBeforePrint() {
    // Les cartes différées hors écran doivent exister sur le papier.
    renderDeferred();
    const root = document.documentElement;
    if (root.getAttribute('data-bs-theme') === 'dark') {
        state.printTheme = 'dark';
        root.setAttribute('data-bs-theme', 'light');
        state.tokens = readTokens();
        state.tokensRev += 1;
        if (state.ready) renderAllCharts();
    }
}

function onAfterPrint() {
    if (state.printTheme) {
        document.documentElement.setAttribute('data-bs-theme', state.printTheme);
        state.printTheme = null;
    }
}

// ---------------------------------------------------------------------------
// Galerie
// ---------------------------------------------------------------------------

// Chaque question montre un aperçu sur les données réelles, avec la période
// et les filtres du tableau : ce qui sera ajouté. Les aperçus se dessinent
// à l'approche (IntersectionObserver), quelques-uns par image — une
// question « actives » sur un jeu Évolution national coûte ~50 ms.
const GALLERY_FRAME_BUDGET_MS = 12;

function renderGallery() {
    releaseGalleryPreviews();
    const list = $('statsGalleryList');
    list.replaceChildren();
    const card = (id, icon, title, description, { preview = true } = {}) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stats-gallery-card';
        button.dataset.question = id;
        if (preview) {
            const box = document.createElement('span');
            box.className = 'stats-gallery-preview is-pending';
            box.dataset.preview = id;
            box.setAttribute('aria-hidden', 'true');
            button.append(box);
        }
        const row = document.createElement('span');
        row.className = 'stats-gallery-row';
        const i = document.createElement('i');
        i.className = `ti ${icon} stats-gallery-icon`;
        i.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'stats-gallery-text';
        const strong = document.createElement('strong');
        strong.textContent = title;
        const small = document.createElement('span');
        small.className = 'stats-gallery-description';
        small.textContent = description;
        text.append(strong, small);
        row.append(i, text);
        button.append(row);
        return button;
    };
    // Une section par thème, « Graphique personnalisé » en tête.
    const section = (title, cards) => {
        const wrap = document.createElement('section');
        wrap.className = 'stats-gallery-section';
        const heading = document.createElement('h3');
        heading.className = 'stats-gallery-heading';
        heading.textContent = title;
        const grid = document.createElement('div');
        grid.className = 'stats-gallery';
        grid.append(...cards);
        wrap.append(heading, grid);
        return wrap;
    };
    list.append(section(t('Partir de zéro'), [
        card('custom', 'ti-adjustments', t('Graphique personnalisé'), t('Partir de zéro et tout choisir.'), { preview: false }),
    ]));
    // Questions de la famille du tableau seulement.
    const dashboard = activeDashboard();
    // Éléments gardés d'une ouverture à l'autre sur le même tableau : mêmes
    // identifiants, donc aperçus repris du cache de résultats. Un élément
    // ajouté en sort (le suivant aura un nouvel identifiant).
    const previous = state.gallery.dashboardId === dashboard.id ? state.gallery.items : new Map();
    state.gallery.items = new Map();
    state.gallery.dashboardId = dashboard.id;
    for (const group of QUESTION_GROUPS) {
        const cards = QUESTIONS.filter((q) => q.group === group && questionFamily(q) === dashboard.kind).map((question) => {
            const { title, description } = state.labels.question(question.id);
            // L'élément de l'aperçu est celui qui sera ajouté : son résultat
            // est déjà en cache au moment du choix.
            const item = previous.get(question.id) || itemFromQuestion(question.id, { title, dataset: dashboard.dataset });
            if (item) state.gallery.items.set(question.id, item);
            return card(question.id, question.icon, title, description, { preview: Boolean(item) });
        });
        if (cards.length) list.append(section(state.labels.questionGroup(group), cards));
    }
}

// Aperçus : observés une fois la modale visible (avant, ECharts mesurerait
// des conteneurs de taille nulle).
function startGalleryPreviews() {
    const root = $('statsGalleryModal').querySelector('.modal-body');
    state.gallery.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.gallery.observer.unobserve(entry.target);
            state.gallery.queue.push(entry.target);
        }
        scheduleGalleryPreviews();
    }, { root, rootMargin: '200px 0px' });
    for (const box of $('statsGalleryList').querySelectorAll('[data-preview]')) state.gallery.observer.observe(box);
}

function scheduleGalleryPreviews() {
    if (state.gallery.frame || !state.gallery.queue.length) return;
    state.gallery.frame = requestAnimationFrame(() => {
        state.gallery.frame = 0;
        const until = performance.now() + GALLERY_FRAME_BUDGET_MS;
        // Au moins un aperçu par image, même s'il dépasse le budget.
        do {
            const box = state.gallery.queue.shift();
            if (box?.isConnected) renderGalleryPreview(box);
        } while (state.gallery.queue.length && performance.now() < until);
        scheduleGalleryPreviews();
    });
}

function setPreviewState(box, status, text = '') {
    box.classList.remove('is-pending');
    box.dataset.state = status;
    box.closest('.stats-gallery-card')?.classList.toggle('is-empty', status === 'empty' || status === 'error');
    if (text) {
        const span = document.createElement('span');
        span.className = 'stats-gallery-preview-text';
        if (status === 'number') span.classList.add('is-number');
        span.textContent = text;
        box.replaceChildren(span);
    }
}

function renderGalleryPreview(box) {
    const item = state.gallery.items.get(box.dataset.preview);
    if (!item) return;
    const { spec } = item;
    if (chartSources(spec).some((s) => state.sourceErrors.has(s))) {
        setPreviewState(box, 'error', t('Données indisponibles'));
        return;
    }
    const result = computeResult(spec, activeDashboard());
    if (!result.meta.rows) {
        setPreviewState(box, 'empty', t('Aucune donnée pour l’instant'));
        return;
    }
    if (spec.view.chart === 'number') {
        const [first] = numberModel(result, spec, chartContext());
        setPreviewState(box, 'number', first?.text ?? '');
        return;
    }
    setPreviewState(box, 'chart');
    const width = box.clientWidth;
    const option = thumbnailOption(buildChartOption(result, spec, { ...chartContext(), width }));
    const chart = window.echarts.init(box, null, { locale: echartsLocale(), renderer: 'canvas' });
    chart.setOption(option, true);
    state.gallery.charts.push(chart);
}

function releaseGalleryPreviews() {
    state.gallery.observer?.disconnect();
    state.gallery.observer = null;
    if (state.gallery.frame) cancelAnimationFrame(state.gallery.frame);
    state.gallery.frame = 0;
    state.gallery.queue = [];
    for (const chart of state.gallery.charts) chart.dispose();
    state.gallery.charts = [];
}

function openGallery() {
    if (activeDashboard().items.length >= MAX_ITEMS) return;
    renderGallery();
    getBsModal('statsGalleryModal')?.show();
}

function onGalleryPick(event) {
    const button = event.target.closest('[data-question]');
    if (!button) return;
    const id = button.dataset.question;
    getBsModal('statsGalleryModal')?.hide();
    const dashboard = activeDashboard();
    if (id === 'custom') {
        const source = dashboardSources(dashboard)[0];
        openEditor({ mode: 'new', item: { size: 'M', height: 'M', spec: createChartSpec({ source, groupBy: 'month' }) } });
        return;
    }
    const item = state.gallery.items.get(id);
    if (!item || dashboard.items.length >= MAX_ITEMS) return;
    // Un même élément ne s'ajoute qu'une fois (nouvel identifiant à la
    // prochaine ouverture de la galerie).
    state.gallery.items.delete(id);
    const title = chartTitle(item.spec);
    withUndo(t('Graphique ajouté : ${title}.', { title }), () => dashboard.items.push(item));
    $('statsGrid').querySelector(cardSelector(item.spec.id))
        ?.scrollIntoView({ block: 'nearest', behavior: state.reduceMotion ? 'auto' : 'smooth' });
}

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------

// Sources de la phrase : la principale, puis chaque « et [source] ». Les
// menus ne proposent que les sources de la famille du tableau (barrière).
function fillSourceSelects(spec) {
    const allowed = dashboardSources(activeDashboard());
    const option = (source) => {
        const empty = tableOf(source).n === 0;
        const suffix = state.sourceErrors.has(source) ? t('(indisponible)')
            : empty ? t('(aucune donnée)') : '';
        const text = state.labels.sourceLabel(source) + (suffix ? ' ' + suffix : '');
        return new Option(text, source);
    };
    const main = $('statsEdSource');
    main.replaceChildren(...allowed.map(option));
    main.value = spec.source;
    const list = $('statsEdSourceList');
    list.replaceChildren();
    spec.extraSources.forEach((source, i) => {
        const label = document.createElement('label');
        label.className = 'stats-phrase-word';
        label.htmlFor = 'statsEdExtraSource' + i;
        label.textContent = t('et dans');
        const row = document.createElement('div');
        row.className = 'stats-compare-row';
        const select = document.createElement('select');
        select.className = 'form-select';
        select.id = 'statsEdExtraSource' + i;
        select.dataset.extraSource = String(i);
        select.replaceChildren(...allowed.map(option));
        select.value = source;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-ghost-secondary btn-icon';
        remove.dataset.removeSource = String(i);
        remove.setAttribute('aria-label', t('Retirer cette source'));
        remove.title = t('Retirer cette source');
        remove.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
        row.append(select, remove);
        list.append(label, row);
    });
    const free = allowed.filter((source) => !chartSources(spec).includes(source));
    $('statsEdAddSourceRow').hidden = !free.length || spec.extraSources.length >= MAX_EXTRA_SOURCES;
}

function readEditorSources() {
    const source = $('statsEdSource').value;
    const extraSources = [...$('statsEdSourceList').querySelectorAll('select')].map((select) => select.value);
    return { source, extraSources };
}

function addSource() {
    if (!state.editor) return;
    readEditorForm();
    const { item } = state.editor;
    const free = dashboardSources(activeDashboard()).filter((source) => !chartSources(item.spec).includes(source));
    if (!free.length) return;
    // De préférence une source qui a des données.
    const next = free.find((source) => tableOf(source).n > 0) || free[0];
    item.spec = normalizeChartSpec({ ...item.spec, extraSources: [...item.spec.extraSources, next] });
    syncEditorForm();
    renderPreview();
    $('statsEdExtraSource' + (item.spec.extraSources.length - 1))?.focus();
}

function onSourceListClick(event) {
    const button = event.target.closest('[data-remove-source]');
    if (!button || !state.editor) return;
    readEditorForm();
    const { item } = state.editor;
    const extraSources = [...item.spec.extraSources];
    extraSources.splice(Number(button.dataset.removeSource), 1);
    item.spec = normalizeChartSpec({ ...item.spec, extraSources });
    syncEditorForm();
    renderPreview();
    $('btnStatsEdAddSource').focus();
}

// Mesures valables pour toutes les sources du graphique.
function fillMeasureSelect(spec) {
    const sources = chartSources(spec);
    const choices = MEASURE_CHOICES.filter((choice) => measureKey(normalizeMeasure(choice.measure, sources)) === choice.key);
    const select = $('statsEdMeasure');
    select.replaceChildren(...choices.map((choice) => new Option(state.labels.measurePhrase(choice.key), choice.key)));
    select.value = measureKey(spec.measure);
}

// Regroupements : ceux des sources (les autres n'apparaissent pas), grisés
// quand la mesure les exclut.
function fillGroupSelect(spec) {
    const sources = chartSources(spec);
    const available = new Set(sourceDimensions(sources));
    const allowed = new Set(allowedGroupBy(spec.measure, sources));
    const select = $('statsEdGroupBy');
    select.replaceChildren();
    for (const { family, dims } of GROUP_CHOICES) {
        const options = dims.filter((dim) => available.has(dim)).map((dim) => {
            const option = new Option(state.labels.groupPhrase(dim), dim);
            option.disabled = !allowed.has(dim);
            return option;
        });
        if (!options.length) continue;
        const group = document.createElement('optgroup');
        group.label = state.labels.groupFamily(family);
        group.append(...options);
        select.append(group);
    }
    select.value = spec.groupBy;
}

function fillChartSelect(spec) {
    const select = $('statsEdChart');
    const charts = allowedCharts(spec).filter((chart) => EDITOR_CHARTS.includes(chart));
    select.replaceChildren(...charts.map((chart) => new Option(state.labels.chart(chart), chart)));
    select.value = charts.includes(spec.view.chart) ? spec.view.chart : charts[0];
}

// Lignes « comparé à … » de la phrase : une par période après la première.
function renderCompareRows(spec) {
    const list = $('statsEdCompareList');
    list.replaceChildren();
    const compares = Array.isArray(spec.periods) ? spec.periods.slice(1) : [];
    const choices = comparePeriodChoices(dashboardExtent(), state.today);
    compares.forEach((period, i) => {
        const label = document.createElement('label');
        label.className = 'stats-phrase-word';
        label.htmlFor = 'statsEdCompare' + i;
        label.textContent = i === 0 ? t('comparé à') : t('et à');
        const row = document.createElement('div');
        row.className = 'stats-compare-row';
        const select = document.createElement('select');
        select.className = 'form-select';
        select.id = 'statsEdCompare' + i;
        select.dataset.compareIndex = String(i);
        fillPeriodSelect(select, period, { choices });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-ghost-secondary btn-icon';
        remove.dataset.removeCompare = String(i);
        remove.setAttribute('aria-label', t('Retirer cette période'));
        remove.title = t('Retirer cette période');
        const icon = document.createElement('i');
        icon.className = 'ti ti-x';
        icon.setAttribute('aria-hidden', 'true');
        remove.append(icon);
        row.append(select, remove);
        list.append(label, row);
    });
    $('btnStatsEdAddCompare').disabled = (spec.periods?.length || 1) >= MAX_SERIES;
}

function fillSplitSelect(spec) {
    const dims = allowedSplitBy(spec.groupBy, chartSources(spec));
    const select = $('statsEdSplitBy');
    select.replaceChildren(new Option(t('rien'), ''), ...dims.map((dim) => new Option(state.labels.dimension(dim), dim)));
    select.value = spec.splitBy || '';
    $('statsEdSplitRow').hidden = !dims.length;
}

// Palettes proposées : pour des barres d'une seule série ou un anneau.
function paletteChoices(spec) {
    const chart = spec.view.chart;
    const single = !spec.splitBy && !hasSeveralSeries(spec);
    if (chart === 'donut') return ['auto', 'multi'];
    if (chart === 'bar' && single && spec.compare.layout !== 'delta') return ['auto', 'accent', 'multi', 'heat'];
    return [];
}

// Filtres de l'éditeur : mode (hérités / propres) et formulaire. Le
// formulaire n'est construit qu'à l'ouverture ou au changement de mode — le
// reconstruire à chaque changement couperait la saisie dans Tom Select.
function syncEditorFilters({ rebuild = false } = {}) {
    const { spec } = state.editor.item;
    const own = spec.filters !== null;
    $('statsEdFilterMode').value = own ? 'own' : 'inherit';
    const container = $('statsEdFiltersForm');
    if (rebuild) {
        destroyFilterForm(container);
        container.replaceChildren();
        if (own) {
            renderFilterForm(container, {
                tables: dashboardTables(),
                filters: spec.filters,
                labels: state.labels,
                attributeName,
                idPrefix: 'statsEdFilter-',
                onChange: onEditorChange,
            });
        }
    }
    const count = activeFilterCount(spec.filters);
    $('statsEdFiltersBadge').hidden = !own;
    $('statsEdFiltersBadge').textContent = count ? String(count) : t('propres');
}

function onFilterModeChange() {
    if (!state.editor) return;
    readEditorForm();
    const { item } = state.editor;
    // Filtres propres : on part de ceux du tableau de bord.
    const filters = $('statsEdFilterMode').value === 'own' ? structuredClone(activeDashboard().filters || {}) : null;
    item.spec = normalizeChartSpec({ ...item.spec, filters });
    syncEditorForm();
    syncEditorFilters({ rebuild: true });
    renderPreview();
}

function fillChoiceSelect(select, values, labelOf, current) {
    select.replaceChildren(...values.map((value) => new Option(labelOf(value), value)));
    select.value = values.includes(current) ? current : values[0];
}

function syncEditorForm() {
    const { item } = state.editor;
    const { spec } = item;
    fillSourceSelects(spec);
    fillMeasureSelect(spec);
    fillGroupSelect(spec);
    const first = spec.periods?.[0];
    fillPeriodSelect($('statsEdPeriod'), first && first.kind !== 'dashboard' ? first : null, {
        inherit: true,
        choices: chartPeriodChoices(dashboardExtent(), state.today),
    });
    renderCompareRows(spec);
    fillSplitSelect(spec);
    fillChartSelect(spec);

    // Comparaison : présentation, alignement, « à date » — seulement quand
    // le graphique compare plusieurs périodes ou plusieurs sources.
    $('statsEdCompareBlock').hidden = !hasSeveralSeries(spec);
    fillChoiceSelect($('statsEdLayout'), allowedLayouts(spec), state.labels.layout, spec.compare.layout);
    const aligns = allowedAligns(spec.groupBy);
    fillChoiceSelect($('statsEdAlign'), aligns,
        (align) => state.labels.align(align, ELAPSED_UNITS[spec.groupBy]), spec.compare.align);
    $('statsEdAlignRow').hidden = aligns.length < 2;
    $('statsEdToDate').checked = spec.compare.toDate;
    const normalizes = allowedNormalize(spec);
    fillChoiceSelect($('statsEdNormalize'), normalizes, state.labels.normalize, spec.compare.normalize);
    $('statsEdNormalizeRow').hidden = normalizes.length < 2;
    $('statsEdTitle').value = spec.title;
    $('statsEdTitle').placeholder = state.labels.defaultTitle(spec);
    const size = $('statsEdSize');
    size.replaceChildren(...DASHBOARD_SIZES.map((s) => new Option(state.labels.size(s), s)));
    size.value = item.size;
    $('statsEdHeight').value = item.height || 'M';
    $('statsEdHeightCol').hidden = spec.view.chart === 'number';
    $('statsEdOrientation').value = spec.view.orientation;
    $('statsEdTop').value = spec.view.top;
    $('statsEdSort').value = spec.view.sort;
    $('statsEdLabels').checked = spec.view.labels;
    $('statsEdSmooth').checked = spec.view.smooth;
    $('statsEdRecord').checked = spec.view.record;
    $('statsEdLog').checked = spec.view.log;

    const chart = spec.view.chart;
    const category = ['cache_type', 'container', 'country', 'state', 'owner', 'attribute', 'dt', 'cache', 'finder', 'county'].includes(spec.groupBy);
    $('statsEdOrientationRow').hidden = chart !== 'bar';
    $('statsEdTopRow').hidden = !category;
    $('statsEdSortRow').hidden = !category || chart === 'number';
    $('statsEdSmoothRow').hidden = chart !== 'line' && chart !== 'area';
    $('statsEdLogRow').hidden = !['bar', 'line', 'area'].includes(chart);
    const palettes = paletteChoices(spec);
    fillChoiceSelect($('statsEdPalette'), palettes.length ? palettes : ['auto'], state.labels.palette, spec.view.palette);
    $('statsEdPaletteRow').hidden = palettes.length < 2;
    // Empiler : plusieurs séries superposées en barres, courbe ou aire.
    const several = Boolean(spec.splitBy) || hasSeveralSeries(spec);
    $('statsEdStack').checked = spec.view.stack;
    $('statsEdStackRow').hidden = !several || !['bar', 'line', 'area'].includes(chart)
        || spec.compare.layout === 'delta';
    // Record mis en avant : une seule série, en barres, courbe ou aire.
    $('statsEdRecordRow').hidden = several || !['bar', 'line', 'area'].includes(chart) || spec.compare.layout === 'delta';
}

// Périodes de la phrase : la première (vide = celle du tableau de bord),
// puis chaque « comparé à ». Sans comparaison, la période du tableau de
// bord s'écrit null (héritage simple).
function readEditorPeriods() {
    const first = periodOfValue($('statsEdPeriod').value);
    const compares = [...$('statsEdCompareList').querySelectorAll('select')]
        .map((select) => periodOfValue(select.value))
        .filter(Boolean);
    if (compares.length) return [first || { kind: 'dashboard' }, ...compares];
    return first ? [first] : null;
}

// Formulaire → description normalisée (une combinaison impossible est
// réparée par la normalisation, puis le formulaire se recale dessus).
function readEditorForm() {
    const { item } = state.editor;
    const spec = item.spec;
    const raw = {
        ...spec,
        ...readEditorSources(),
        title: $('statsEdTitle').value,
        measure: measureOfKey($('statsEdMeasure').value),
        groupBy: $('statsEdGroupBy').value,
        splitBy: $('statsEdSplitBy').value || null,
        periods: readEditorPeriods(),
        filters: $('statsEdFilterMode').value === 'own' ? readFilterForm($('statsEdFiltersForm')) : null,
        compare: {
            ...spec.compare,
            layout: $('statsEdLayout').value || spec.compare.layout,
            align: $('statsEdAlign').value || spec.compare.align,
            toDate: $('statsEdToDate').checked,
            normalize: $('statsEdNormalize').value || spec.compare.normalize,
        },
        view: {
            ...spec.view,
            chart: $('statsEdChart').value,
            orientation: $('statsEdOrientation').value,
            top: Number($('statsEdTop').value),
            sort: $('statsEdSort').value,
            labels: $('statsEdLabels').checked,
            smooth: $('statsEdSmooth').checked,
            record: $('statsEdRecord').checked,
            log: $('statsEdLog').checked,
            stack: $('statsEdStack').checked,
            palette: $('statsEdPaletteRow').hidden ? spec.view.palette : $('statsEdPalette').value,
        },
    };
    // Titre venu d'une question (« Nombre de trouvailles ») : il ne décrit
    // plus le graphique dès que la mesure ou le regroupement change. Tant
    // que l'utilisateur n'a pas écrit le sien, il redevient automatique.
    const content = raw.groupBy !== spec.groupBy || measureKey(raw.measure) !== measureKey(spec.measure)
        || raw.source !== spec.source || raw.extraSources.join() !== spec.extraSources.join();
    if (content && !state.editor.titleTouched) raw.title = '';
    // Passer à « au total » propose le chiffre clé ; le quitter, les barres.
    if (raw.groupBy === 'none' && spec.groupBy !== 'none') raw.view.chart = 'number';
    if (raw.groupBy !== 'none' && spec.view.chart === 'number') raw.view.chart = 'bar';
    item.spec = normalizeChartSpec(raw);
    item.size = DASHBOARD_SIZES.includes($('statsEdSize').value) ? $('statsEdSize').value : item.size;
    item.height = DASHBOARD_HEIGHTS.includes($('statsEdHeight').value) ? $('statsEdHeight').value : (item.height || 'M');
    // Un chiffre clé devenu graphique quitte la petite taille (et
    // inversement), sauf si l'utilisateur a choisi la taille lui-même.
    if (!state.editor.sizeTouched) {
        const wasNumber = spec.view.chart === 'number';
        const isNumber = item.spec.view.chart === 'number';
        if (wasNumber && !isNumber && item.size === 'S') item.size = 'M';
        if (!wasNumber && isNumber) item.size = 'S';
    }
}

function renderPreview() {
    if (!state.editor) return;
    const { spec } = state.editor.item;
    const dashboard = activeDashboard();
    const result = computeResult(spec, dashboard);
    $('statsEdPreviewTitle').textContent = chartTitle(spec);
    const host = $('statsEdPreview');
    const number = $('statsEdPreviewNumber');
    if (spec.view.chart === 'number') {
        host.hidden = true;
        number.hidden = false;
        renderNumber(number, result, spec, dashboard);
        return;
    }
    number.hidden = true;
    host.hidden = false;
    host.style.setProperty('--stats-chart-height', HEIGHT_PIXELS[state.editor.item.height || 'M'] + 'px');
    state.previewChart = renderChartInto(host, result, spec);
    state.previewChart.resize();
    // Fenêtre redimensionnée : l'aperçu suit (calendrier redessiné).
    state.resizeObserver.observe(host);
}

function onEditorChange() {
    readEditorForm();
    syncEditorForm();
    syncEditorFilters();
    renderPreview();
}

// « Comparer à une autre période » : ajoute « la période précédente » (de
// la dernière de la liste), le choix le plus courant.
function addComparePeriod() {
    if (!state.editor) return;
    readEditorForm();
    const { item } = state.editor;
    const periods = item.spec.periods ? [...item.spec.periods] : [{ kind: 'dashboard' }];
    if (periods.length >= MAX_SERIES) return;
    periods.push({ kind: 'previous' });
    item.spec = normalizeChartSpec({ ...item.spec, periods });
    syncEditorForm();
    renderPreview();
    $('statsEdCompare' + (periods.length - 2))?.focus();
}

function onCompareListClick(event) {
    const button = event.target.closest('[data-remove-compare]');
    if (!button || !state.editor) return;
    readEditorForm();
    const { item } = state.editor;
    const periods = [...(item.spec.periods || [])];
    periods.splice(Number(button.dataset.removeCompare) + 1, 1);
    item.spec = normalizeChartSpec({ ...item.spec, periods });
    syncEditorForm();
    renderPreview();
    $('btnStatsEdAddCompare').focus();
}

function openEditor({ mode, index = -1, item }) {
    state.editor = { mode, index, item: structuredClone(item), titleTouched: false, sizeTouched: false };
    $('statsEditorTitle').textContent = mode === 'new' ? t('Nouveau graphique') : t('Modifier le graphique');
    syncEditorForm();
    syncEditorFilters({ rebuild: true });
    // Section des filtres ouverte d'office quand le graphique en a.
    $('statsEdFiltersSection').open = state.editor.item.spec.filters !== null;
    const modal = getBsModal('statsEditorModal');
    modal?.show();
}

function saveEditor() {
    if (!state.editor) return;
    readEditorForm();
    const { mode, index, item } = state.editor;
    const dashboard = activeDashboard();
    getBsModal('statsEditorModal')?.hide();
    if (mode === 'new') {
        if (dashboard.items.length >= MAX_ITEMS) return;
        withUndo(t('Graphique ajouté.'), () => dashboard.items.push(item));
    } else if (dashboard.items[index]) {
        withUndo(t('Graphique enregistré.'), () => { dashboard.items[index] = item; });
    }
}

// ---------------------------------------------------------------------------
// Renommer, période globale
// ---------------------------------------------------------------------------

function openRename() {
    $('statsRenameInput').value = activeDashboard().name;
    getBsModal('statsRenameModal')?.show();
}

function submitRename(event) {
    event.preventDefault();
    const name = $('statsRenameInput').value.replace(/[\r\n\t]+/g, ' ').trim();
    if (!name) return;
    activeDashboard().name = Array.from(name).slice(0, 60).join('');
    scheduleSave({ immediate: true });
    getBsModal('statsRenameModal')?.hide();
    renderToolbar();
}

function onGlobalPeriodChange() {
    const period = periodOfValue($('statsGlobalPeriod').value);
    if (!period) return;
    activeDashboard().period = period;
    scheduleSave();
    renderAllCharts();
}

// ---------------------------------------------------------------------------
// Relevé E2E
// ---------------------------------------------------------------------------

window.getStatsPageSnapshot = () => {
    const dashboard = state.doc ? activeDashboard() : null;
    return {
        echartsVersion: window.echarts?.version || null,
        locale: echartsLocale(),
        ready: state.ready,
        today: state.today,
        reduceMotion: state.reduceMotion,
        sourceErrors: [...state.sourceErrors],
        busy: state.busy > 0,
        // Aperçus de la galerie ouverte : état de chacun (pending, chart,
        // number, empty, error) et texte affiché.
        gallery: [...document.querySelectorAll('#statsGalleryList [data-preview]')].map((box) => ({
            id: box.dataset.preview,
            state: box.dataset.state || 'pending',
            text: box.textContent,
            drawn: Boolean(window.echarts?.getInstanceByDom(box)),
        })),
        rows: state.tables.has('finds') ? tableOf('finds').n : null,
        undated: state.tables.has('finds') ? tableOf('finds').undated : null,
        sources: Object.fromEntries([...state.tables].map(([source, table]) => [source, table.n])),
        datasets: state.datasets.map((d) => ({ id: d.id, name: d.name })),
        dashboards: state.doc ? state.doc.dashboards.map((d) => ({ id: d.id, name: d.name, kind: d.kind, dataset: d.dataset, items: d.items.length })) : [],
        dashboard: dashboard ? {
            id: dashboard.id,
            name: dashboard.name,
            period: dashboard.period,
            filters: dashboard.filters,
            kind: dashboard.kind,
            dataset: dashboard.dataset,
            items: dashboard.items.length,
        } : null,
        cards: dashboard ? dashboard.items.map((item) => {
            const entry = state.results.get(item.spec.id);
            return {
                id: item.spec.id,
                size: item.size,
                // Hauteur choisie (M / L) ; `height` = hauteur affichée en px.
                heightKey: item.height || 'M',
                chart: item.spec.view.chart,
                groupBy: item.spec.groupBy,
                measure: measureKey(item.spec.measure),
                title: chartTitle(item.spec),
                unavailable: entry?.error ?? null,
                deferred: state.deferred.has(item.spec.id),
                keys: entry?.result?.keys ?? null,
                series: entry?.result?.series.map((s) => s.values) ?? null,
                periods: entry?.result?.periods.map((p) => state.labels.seriesPeriodLabel(p)) ?? null,
                align: entry?.result?.align ?? null,
                toDate: Boolean(entry?.result?.toDate),
                delta: entry?.result?.delta?.values ?? null,
                partial: entry?.result?.series.map((s) => s.partial) ?? null,
                layout: item.spec.compare.layout,
                splitBy: item.spec.splitBy,
                source: item.spec.source,
                extraSources: item.spec.extraSources,
                seriesSources: entry?.result?.series.map((s) => s.source) ?? null,
                filters: item.spec.filters,
                height: (() => {
                    const host = $('statsGrid').querySelector(cardSelector(item.spec.id) + ' .stats-chart');
                    return host ? host.getBoundingClientRect().height : null;
                })(),
                grids: (() => {
                    const grid = state.charts.get(item.spec.id)?.getOption().grid;
                    return Array.isArray(grid) ? grid.length : null;
                })(),
                rendered: item.spec.view.chart === 'number' || state.charts.has(item.spec.id),
                // Calendrier : taille de case du dernier dessin (px).
                calendarCell: (() => {
                    const host = $('statsGrid').querySelector(cardSelector(item.spec.id) + ' .stats-chart');
                    return host?.dataset.calendarCell ? Number(host.dataset.calendarCell) : null;
                })(),
                linksToMap: entry?.result ? chartClickable(item.spec, entry.result) : false,
                challenge: challengeSnapshot(entry?.result),
                // Records datés de la première série ({ from, to } en jours).
                records: entry?.result?.series[0]?.records ?? null,
                recordText: document.querySelector(`.stats-card[data-chart-id="${item.spec.id}"] .stats-number-record`)?.textContent ?? null,
            };
        }) : [],
        save: { dirty: state.docDirty, failed: state.saveFailed, pending: saveQueue.pending },
        editor: state.editor ? { mode: state.editor.mode, spec: state.editor.item.spec, size: state.editor.item.size } : null,
        video: state.video ? {
            chartId: state.video.spec.id, phase: state.video.phase, file: state.video.file, folder: state.video.folder || null,
        } : null,
    };
};

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

function bindEvents() {
    $('btnStatsRetry').addEventListener('click', loadPage);
    $('btnStatsRefresh').addEventListener('click', refreshData);
    $('btnStatsVideoStart').addEventListener('click', () => { recordVideo(); });
    $('btnStatsVideoCancel').addEventListener('click', closeVideo);
    $('btnStatsVideoClose').addEventListener('click', closeVideo);
    $('btnStatsVideoReveal').addEventListener('click', revealVideo);
    $('statsVideoModal').addEventListener('hidden.bs.modal', releaseVideo);
    $('btnStatsAddChart').addEventListener('click', openGallery);
    $('btnStatsAddChartEmpty').addEventListener('click', openGallery);
    $('btnStatsRename').addEventListener('click', openRename);
    $('statsRenameForm').addEventListener('submit', submitRename);
    $('statsGlobalPeriod').addEventListener('change', onGlobalPeriodChange);
    $('statsGrid').addEventListener('click', onCardAction);
    $('statsGrid').addEventListener('pointerdown', onGridPointerDown);
    $('statsGrid').addEventListener('dragstart', onDragStart);
    $('statsGrid').addEventListener('dragover', onDragOver);
    $('statsGrid').addEventListener('drop', onDrop);
    $('statsGrid').addEventListener('dragend', endDrag);
    $('statsImportInput').addEventListener('change', () => {
        const file = $('statsImportInput').files?.[0];
        $('statsImportInput').value = '';
        if (file) importDashboardFile(file);
    });
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    $('statsGalleryList').addEventListener('click', onGalleryPick);
    $('statsGalleryModal').addEventListener('shown.bs.modal', startGalleryPreviews);
    $('statsGalleryModal').addEventListener('hidden.bs.modal', releaseGalleryPreviews);
    $('statsDashboardMenu').addEventListener('click', onDashboardMenuClick);
    $('statsNewDashboardForm').addEventListener('submit', submitNewDashboard);
    for (const id of ['statsNewKindPersonal', 'statsNewKindEvolution', 'statsNewDataset']) {
        $(id).addEventListener('change', syncNewDashboardForm);
    }
    $('statsNewName').addEventListener('input', () => { $('statsNewName').dataset.touched = '1'; });
    $('statsNewDashboardModal').addEventListener('shown.bs.modal', () => $('statsNewName').select());
    $('btnStatsEdAddSource').addEventListener('click', addSource);
    $('statsEdSourceList').addEventListener('click', onSourceListClick);
    $('btnStatsFilters').addEventListener('click', openFilters);
    $('btnStatsValuesCsv').addEventListener('click', downloadValuesCsv);
    $('btnStatsFiltersApply').addEventListener('click', applyFilters);
    $('btnStatsFiltersClear').addEventListener('click', () => {
        clearFilterForm($('statsFiltersForm'));
        resetMapFiltersReport();
    });
    $('btnStatsFiltersFromMap').addEventListener('click', takeMapFilters);
    $('statsFiltersModal').addEventListener('hidden.bs.modal', () => destroyFilterForm($('statsFiltersForm')));
    $('statsFiltersSummary').addEventListener('click', onFiltersSummaryClick);
    $('statsEdFilterMode').addEventListener('change', onFilterModeChange);
    for (const id of ['statsEdSource', 'statsEdSourceList', 'statsEdMeasure', 'statsEdGroupBy', 'statsEdSplitBy', 'statsEdPeriod', 'statsEdChart', 'statsEdSize',
        'statsEdOrientation', 'statsEdSort', 'statsEdLabels', 'statsEdHeight', 'statsEdSmooth', 'statsEdRecord', 'statsEdLog', 'statsEdStack', 'statsEdPalette',
        'statsEdLayout', 'statsEdAlign', 'statsEdToDate', 'statsEdNormalize', 'statsEdCompareList']) {
        $(id).addEventListener('change', onEditorChange);
    }
    $('statsEdCompareList').addEventListener('click', onCompareListClick);
    $('btnStatsEdAddCompare').addEventListener('click', addComparePeriod);
    $('statsEdTop').addEventListener('change', onEditorChange);
    $('statsEdSize').addEventListener('change', () => {
        if (state.editor) state.editor.sizeTouched = true;
    });
    $('statsEdTitle').addEventListener('input', () => {
        state.editor.titleTouched = true;
        readEditorForm();
        $('statsEdPreviewTitle').textContent = chartTitle(state.editor.item.spec);
    });
    $('btnStatsEdSave').addEventListener('click', saveEditor);
    const editor = $('statsEditorModal');
    // L'aperçu se dessine une fois la modale visible : ECharts mesure son
    // conteneur, nul tant que la modale est masquée.
    editor.addEventListener('shown.bs.modal', renderPreview);
    editor.addEventListener('hidden.bs.modal', () => {
        destroyFilterForm($('statsEdFiltersForm'));
        state.previewChart?.dispose();
        state.previewChart = null;
        state.editor = null;
    });
    $('statsRenameModal').addEventListener('shown.bs.modal', () => $('statsRenameInput').select());
    // « Non enregistré » cliquable : relance l'écriture en attente.
    $('statsSaveStatus').addEventListener('click', () => {
        if (state.docDirty) flushSave();
    });

    state.resizeObserver = new ResizeObserver(onHostsResized);
}

bindQuitButtons();
bindEvents();
watchTheme();
watchToday();
watchReducedMotion();
state.tokens = readTokens();
Promise.all([loadUserSettings(), loadPage()]).finally(() => {
    window.mygcflowStatsReady = true;
});
