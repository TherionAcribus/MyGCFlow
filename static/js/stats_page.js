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
import { showConfirmation, showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { markSaving, reportSave } from './saved_indicator.mjs';
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
import { axisLabels, buildChartOption, calendarYears, chartHeight, clickTarget, numberModel } from './chart_echarts.mjs';
import {
    VIDEO_DURATIONS, VIDEO_FPS, VIDEO_SIZES, chartAnimates, lockOption, niceCeil, revealIndex, revealProgress,
    revealResult, valueMax,
} from './chart_video.mjs';
import fixWebmDuration from './fix-webm-duration.js';
import { SOURCE_KIND_VALUES } from './chart_sources.mjs';
import { chartLinksToMap, discoveryModeFor, mapSelectionFor } from './chart_map_link.mjs';
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
const $ = (id) => document.getElementById(id);

// Table vide : source sans données (ou injoignable).
const EMPTY_TABLE = tableFromRecords([]);
const PERSONAL_SOURCES = ['finds', 'dnf', 'owned', 'poses.received', 'poses.dnf', 'poses.favorites'];

const state = {
    // Tables par source (« finds », « poses.received », « evolution:3 »…).
    tables: new Map(),
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
    resizeObserver: null,
    saveTimer: null,
    savePending: false,
    editor: null,               // { mode: 'edit'|'new', index, item }
    video: null,                // vidéo animée en cours (openVideo)
    previewChart: null,
    ready: false,
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
        if (state.ready) renderAllCharts();
        if (state.editor) renderPreview();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
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
// en erreur) ; DNF, caches posées et Mes poses sont facultatifs (pas de logs
// importés = tables vides).
async function loadPersonalSources() {
    const optional = (promise, build) => promise.then(build).catch((e) => {
        console.warn('[stats] Source indisponible :', e?.message || e);
        return null;
    });
    const [finds, dnf, owned, poses] = await Promise.all([
        fetchJson('/api/stats/finds').then(findsTable),
        optional(fetchJson('/api/stats/dnf'), dnfTable),
        optional(fetchJson('/api/stats/owned'), ownedTable),
        optional(fetchJson('/api/poses/data'), posesTables),
    ]);
    state.tables.set('finds', finds);
    state.tables.set('dnf', dnf || EMPTY_TABLE);
    state.tables.set('owned', owned || EMPTY_TABLE);
    state.tables.set('poses.received', poses?.received || EMPTY_TABLE);
    state.tables.set('poses.dnf', poses?.dnf || EMPTY_TABLE);
    state.tables.set('poses.favorites', poses?.favorites || EMPTY_TABLE);
}

async function loadDatasets() {
    try {
        state.datasets = (await fetchJson('/api/evolution/datasets')).datasets || [];
    } catch (_) {
        state.datasets = [];
    }
}

// Jeu Évolution chargé à la demande (premier affichage d'un tableau qui
// l'utilise). Un jeu supprimé depuis donne des tables vides.
function ensureEvolution(id) {
    if (!id) return Promise.resolve();
    if (!state.evolutionLoads.has(id)) {
        state.evolutionLoads.set(id, fetchJson('/api/evolution/datasets/' + id + '/data')
            .then((payload) => {
                const { placed, archived } = evolutionTables(payload);
                state.tables.set('evolution:' + id, placed);
                state.tables.set('evolution:' + id + ':archived', archived);
            })
            .catch(() => {
                state.missingDatasets.add(id);
                state.tables.set('evolution:' + id, EMPTY_TABLE);
                state.tables.set('evolution:' + id + ':archived', EMPTY_TABLE);
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
        if (!state.doc) {
            // Première visite : un tableau de bord prêt à lire, enregistré
            // tout de suite pour qu'il survive au rechargement.
            state.doc = newDefaultDocument();
            scheduleSave({ immediate: true });
        }
        await ensureEvolution(activeDashboard().dataset);
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

async function putDocument() {
    try {
        const response = await fetch('/api/dashboards', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.doc),
        });
        return response.ok;
    } catch (_) {
        return false;
    }
}

function flushSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.savePending) return Promise.resolve(true);
    state.savePending = false;
    const status = $('statsSaveStatus');
    markSaving(status);
    return reportSave(status, putDocument());
}

// Actions discrètes (ajout, suppression, déplacement) : `immediate`, pour
// qu'un rechargement juste après ne perde rien.
function scheduleSave({ immediate = false } = {}) {
    state.savePending = true;
    clearTimeout(state.saveTimer);
    if (immediate) return flushSave();
    state.saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    return null;
}

window.addEventListener('pagehide', () => {
    if (!state.savePending) return;
    // Dernière chance : keepalive survit au déchargement de la page.
    try {
        fetch('/api/dashboards', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.doc),
            keepalive: true,
        });
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
    await ensureEvolution(activeDashboard().dataset);
    renderDashboard();
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

function openFilters() {
    renderFilterForm($('statsFiltersForm'), {
        tables: dashboardTables(),
        filters: activeDashboard().filters,
        labels: state.labels,
        attributeName,
        idPrefix: 'statsFilter-',
    });
    getBsModal('statsFiltersModal')?.show();
}

function applyFilters() {
    activeDashboard().filters = readFilterForm($('statsFiltersForm'));
    scheduleSave({ immediate: true });
    getBsModal('statsFiltersModal')?.hide();
    renderToolbar();
    renderAllCharts();
}

function renderDashboard() {
    renderToolbar();
    const dashboard = activeDashboard();
    const grid = $('statsGrid');

    // Les cartes sont reconstruites : leurs instances ECharts sont libérées.
    for (const chart of state.charts.values()) chart.dispose();
    state.charts.clear();
    state.results.clear();
    state.resizeObserver.disconnect();
    grid.replaceChildren(...dashboard.items.map((item, index) => cardElement(item, index, dashboard.items.length)));
    $('statsGridEmpty').hidden = dashboard.items.length > 0;
    $('btnStatsAddChart').disabled = dashboard.items.length >= MAX_ITEMS;
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
    if (spec.filters !== null) {
        // Filtres propres : ceux du tableau de bord ne s'appliquent pas.
        const icon = document.createElement('i');
        icon.className = 'ti ti-filter stats-card-filter';
        const described = describeFilters(spec.filters, filterValueLabel)
            .map(({ field, values }) => state.labels.filterField(field) + ' : ' + values.join(', '));
        icon.title = t('Filtres propres à ce graphique') + ' — ' + (described.length ? described.join(' · ') : t('aucun'));
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.title);
        header.append(icon);
    }
    header.append(cardMenu(spec, index, count));
    card.append(header);

    const body = document.createElement('div');
    body.className = 'stats-card-body';
    if (spec.view.chart === 'number') {
        const number = document.createElement('div');
        number.className = 'stats-number';
        body.append(number);
    } else {
        const host = document.createElement('div');
        host.className = 'stats-chart';
        host.setAttribute('role', 'img');
        host.setAttribute('aria-label', chartTitle(spec));
        body.append(host);
    }
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
    menu.append(
        menuButton('edit', 'ti-pencil', t('Modifier')),
        menuButton('duplicate', 'ti-copy', t('Dupliquer'), { disabled: count >= MAX_ITEMS }),
        menuButton('export', 'ti-download', t('Exporter en image (PNG)'), { disabled: spec.view.chart === 'number' }),
        menuButton('export-svg', 'ti-vector', t('Exporter en image vectorielle (SVG)'), { disabled: spec.view.chart === 'number' }),
        panelMenuButton(spec),
        menuButton('video', 'ti-video', t('Créer une vidéo animée'), { disabled: !chartAnimates(spec) }),
        menuButton('before', 'ti-arrow-left', t('Déplacer avant'), { disabled: index === 0 }),
        menuButton('after', 'ti-arrow-right', t('Déplacer après'), { disabled: index === count - 1 }),
        divider,
        menuButton('delete', 'ti-trash', t('Supprimer'), { danger: true }),
    );
    wrap.append(toggle, menu);
    return wrap;
}

function computeResult(spec, dashboard) {
    return runChartQueries(spec, tableOf, {
        ...effectiveQueryOptions(spec, dashboard),
        today: state.today,
        labelOf: (dim, key) => state.labels.axisLabel(dim, key, { attributeName }),
    });
}

function chartContext() {
    return { labels: state.labels, tokens: state.tokens, typeColors: state.typeColors, attributeName };
}

// Note sous un graphique : ce qui n'est pas compté ou a été coupé.
function cardNote(result, spec) {
    const notes = [];
    if (spec.groupBy === 'attribute' && result.meta.noAttribute) {
        notes.push(t('Sans attribut : ${n}', { n: result.meta.noAttribute }));
    }
    if (result.truncated) notes.push(t('Seules les 8 périodes les plus récentes sont affichées.'));
    const chart = spec.view.chart;
    if ((chart === 'calendar' || chart === 'heatmap') && result.periods.length > 1) {
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
    return chartLinksToMap(spec) && !['heatmap', 'radar', 'number'].includes(spec.view.chart) && !result.delta;
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
    let chart = window.echarts.getInstanceByDom(host);
    if (!chart) {
        chart = window.echarts.init(host, null, { locale: echartsLocale(), renderer: 'canvas' });
        chart.on('click', (params) => onChartClick(host, params));
    }
    chart.setOption(option, true);
    chart.resize();
    return chart;
}

function renderAllCharts() {
    if (!state.tokens) state.tokens = readTokens();
    const dashboard = activeDashboard();
    for (const item of dashboard.items) {
        const card = $('statsGrid').querySelector(cardSelector(item.spec.id));
        if (!card) continue;
        const result = computeResult(item.spec, dashboard);
        state.results.set(item.spec.id, { result, spec: item.spec });
        const note = card.querySelector('.stats-card-note');
        note.textContent = cardNote(result, item.spec);
        note.hidden = !note.textContent;
        if (item.spec.view.chart === 'number') {
            renderNumber(card.querySelector('.stats-number'), result, item.spec, dashboard);
        } else {
            const host = card.querySelector('.stats-chart');
            state.charts.set(item.spec.id, renderChartInto(host, result, item.spec));
            state.resizeObserver.observe(host);
        }
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
    if (!chartClickable(spec, result)) return null;
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
    if (!entry || !chartClickable(entry.spec, entry.result)) return;
    const target = clickTarget(entry.result, entry.spec, params);
    if (!target) return;
    const link = mapLinkFor(card.dataset.chartId, target);
    if (!link) {
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
    if (!entry || !chartAnimates(spec, entry.result)) {
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
    if (!entry) return;
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

function onCardAction(event) {
    const button = event.target.closest('[data-action]');
    const card = event.target.closest('.stats-card');
    if (!button || !card) return;
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
            dashboard.items.splice(index + 1, 0, copy);
            scheduleSave({ immediate: true });
            renderDashboard();
            break;
        }
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
            [dashboard.items[index], dashboard.items[target]] = [dashboard.items[target], dashboard.items[index]];
            scheduleSave({ immediate: true });
            renderDashboard();
            break;
        }
        case 'delete':
            showConfirmation(
                t('Supprimer le graphique « ${title} » ?', { title: chartTitle(item.spec) }),
                t('Supprimer'),
                () => {
                    const i = itemIndex(item.spec.id);
                    if (i < 0) return;
                    activeDashboard().items.splice(i, 1);
                    scheduleSave({ immediate: true });
                    renderDashboard();
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
    return String(name).replace(/[\\/:*?<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'graphique';
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

// Image vectorielle : le même graphique redessiné hors écran par le moteur
// SVG d'ECharts, à la taille de la carte, fond de la carte compris.
export function chartSvg(spec) {
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
    const [moved] = items.splice(from, 1);
    let to = items.findIndex((item) => item.spec.id === card.dataset.chartId);
    if (dropSide(card, event) === 'after') to += 1;
    items.splice(to, 0, moved);
    scheduleSave({ immediate: true });
    renderDashboard();
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
        item.size = size;
        item.height = height;
        scheduleSave({ immediate: true });
        renderDashboard();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// Impression : toujours sur fond clair
// ---------------------------------------------------------------------------

function onBeforePrint() {
    const root = document.documentElement;
    if (root.getAttribute('data-bs-theme') === 'dark') {
        state.printTheme = 'dark';
        root.setAttribute('data-bs-theme', 'light');
        state.tokens = readTokens();
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

function renderGallery() {
    const list = $('statsGalleryList');
    list.replaceChildren();
    const card = (id, icon, title, description) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stats-gallery-card';
        button.dataset.question = id;
        const i = document.createElement('i');
        i.className = `ti ${icon} stats-gallery-icon`;
        i.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'stats-gallery-text';
        const strong = document.createElement('strong');
        strong.textContent = title;
        const small = document.createElement('span');
        small.textContent = description;
        text.append(strong, small);
        button.append(i, text);
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
        card('custom', 'ti-adjustments', t('Graphique personnalisé'), t('Partir de zéro et tout choisir.')),
    ]));
    // Questions de la famille du tableau seulement.
    const family = activeDashboard().kind;
    for (const group of QUESTION_GROUPS) {
        const cards = QUESTIONS.filter((q) => q.group === group && questionFamily(q) === family).map((question) => {
            const { title, description } = state.labels.question(question.id);
            return card(question.id, question.icon, title, description);
        });
        if (cards.length) list.append(section(state.labels.questionGroup(group), cards));
    }
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
    const item = itemFromQuestion(id, { title: state.labels.question(id).title, dataset: dashboard.dataset });
    if (!item) return;
    dashboard.items.push(item);
    scheduleSave({ immediate: true });
    renderDashboard();
    $('statsGrid').querySelector(cardSelector(item.spec.id))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        const text = state.labels.sourceLabel(source) + (empty ? ' ' + t('(aucune donnée)') : '');
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
    if (mode === 'new') {
        if (dashboard.items.length < MAX_ITEMS) dashboard.items.push(item);
    } else if (dashboard.items[index]) {
        dashboard.items[index] = item;
    }
    scheduleSave({ immediate: true });
    getBsModal('statsEditorModal')?.hide();
    renderDashboard();
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
                keys: entry?.result.keys ?? null,
                series: entry?.result.series.map((s) => s.values) ?? null,
                periods: entry?.result.periods.map((p) => state.labels.seriesPeriodLabel(p)) ?? null,
                align: entry?.result.align ?? null,
                toDate: Boolean(entry?.result.toDate),
                delta: entry?.result.delta?.values ?? null,
                partial: entry?.result.series.map((s) => s.partial) ?? null,
                layout: item.spec.compare.layout,
                splitBy: item.spec.splitBy,
                source: item.spec.source,
                extraSources: item.spec.extraSources,
                seriesSources: entry?.result.series.map((s) => s.source) ?? null,
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
                linksToMap: entry ? chartClickable(item.spec, entry.result) : false,
            };
        }) : [],
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
    $('btnStatsFiltersApply').addEventListener('click', applyFilters);
    $('btnStatsFiltersClear').addEventListener('click', () => clearFilterForm($('statsFiltersForm')));
    $('statsFiltersModal').addEventListener('hidden.bs.modal', () => destroyFilterForm($('statsFiltersForm')));
    $('statsFiltersSummary').addEventListener('click', onFiltersSummaryClick);
    $('statsEdFilterMode').addEventListener('change', onFilterModeChange);
    for (const id of ['statsEdSource', 'statsEdSourceList', 'statsEdMeasure', 'statsEdGroupBy', 'statsEdSplitBy', 'statsEdPeriod', 'statsEdChart', 'statsEdSize',
        'statsEdOrientation', 'statsEdSort', 'statsEdLabels', 'statsEdHeight', 'statsEdSmooth', 'statsEdLog', 'statsEdStack', 'statsEdPalette',
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

    state.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) window.echarts.getInstanceByDom(entry.target)?.resize();
    });
}

bindQuitButtons();
bindEvents();
watchTheme();
state.tokens = readTokens();
Promise.all([loadUserSettings(), loadPage()]).finally(() => {
    window.mygcflowStatsReady = true;
});
