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
import { showConfirmation, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { markSaving, reportSave } from './saved_indicator.mjs';
import {
    MAX_SERIES,
    allowedAligns,
    allowedCharts,
    allowedGroupBy,
    allowedLayouts,
    allowedNormalize,
    createChartSpec,
    normalizeChartSpec,
    periodsAreMultiple,
} from './chart_spec.mjs';
import { findsTable } from './chart_sources.mjs';
import { todayDay } from './chart_periods.mjs';
import { ELAPSED_UNITS, runChartQuery } from './chart_query.mjs';
import { GROUP_CHOICES, LOT1_CHARTS, MEASURE_CHOICES, makeLabels, measureKey, measureOfKey } from './chart_labels.mjs';
import { buildChartOption, numberModel } from './chart_echarts.mjs';
import {
    DASHBOARD_SIZES,
    MAX_ITEMS,
    QUESTIONS,
    QUESTION_GROUPS,
    SIZE_COLUMNS,
    chartPeriodChoices,
    comparePeriodChoices,
    defaultDocument,
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

const state = {
    table: null,
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

async function loadFinds() {
    const response = await fetch('/api/stats/finds');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return findsTable(await response.json());
}

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
        const [table, doc] = await Promise.all([loadFinds(), loadDashboards(), loadTypeColors()]);
        state.table = table;
        if (!table.n) {
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
    const attr = (state.table?.dicts.attribute || []).find((a) => a.key === key);
    return attr ? attr.name : key;
}

function chartTitle(spec) {
    return spec.title || state.labels.defaultTitle(spec);
}

// Menu de périodes. `choices` : la liste proposée ; `inherit` ajoute
// « Période du tableau de bord » (valeur vide).
function fillPeriodSelect(select, current, { inherit = false, choices = null } = {}) {
    const list = choices || periodChoices(state.table.extent, state.today);
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
    fillPeriodSelect($('statsGlobalPeriod'), dashboard.period);
    const { n, undated } = state.table;
    const nf = new Intl.NumberFormat(state.labels.locale);
    let note = t('${n} trouvailles', { n: nf.format(n) });
    if (undated) note += ' · ' + t('${n} sans date de trouvaille, non comptées', { n: nf.format(undated) });
    $('statsDataNote').textContent = note;
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
    card.dataset.chartId = spec.id;
    card.dataset.chart = spec.view.chart;

    const header = document.createElement('header');
    header.className = 'stats-card-header';
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
        menuButton('before', 'ti-arrow-left', t('Déplacer avant'), { disabled: index === 0 }),
        menuButton('after', 'ti-arrow-right', t('Déplacer après'), { disabled: index === count - 1 }),
        divider,
        menuButton('delete', 'ti-trash', t('Supprimer'), { danger: true }),
    );
    wrap.append(toggle, menu);
    return wrap;
}

function computeResult(spec, dashboard) {
    return runChartQuery(spec, state.table, {
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
    if (result.toDate) {
        const date = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
            .format(new Date(result.toDate.day * 86400000));
        notes.push(t('Comparaison à date : chaque période est arrêtée au ${date}.', { date }));
    }
    if (!result.meta.rows) notes.push(t('Aucune trouvaille sur cette période.'));
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

function renderChartInto(host, result, spec) {
    const option = buildChartOption(result, spec, chartContext());
    let chart = window.echarts.getInstanceByDom(host);
    if (!chart) chart = window.echarts.init(host, null, { locale: echartsLocale(), renderer: 'canvas' });
    chart.setOption(option, true);
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
            const copy = { size: item.size, spec: createChartSpec(structuredClone(item.spec)) };
            dashboard.items.splice(index + 1, 0, copy);
            scheduleSave({ immediate: true });
            renderDashboard();
            break;
        }
        case 'export':
            exportPng(item.spec);
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
    for (const group of QUESTION_GROUPS) {
        const cards = QUESTIONS.filter((q) => q.group === group).map((question) => {
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
    if (id === 'custom') {
        openEditor({ mode: 'new', item: { size: 'M', spec: createChartSpec({ groupBy: 'month' }) } });
        return;
    }
    const item = itemFromQuestion(id, { title: state.labels.question(id).title });
    if (!item) return;
    const dashboard = activeDashboard();
    dashboard.items.push(item);
    scheduleSave({ immediate: true });
    renderDashboard();
    $('statsGrid').querySelector(cardSelector(item.spec.id))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------

function fillMeasureSelect(spec) {
    const select = $('statsEdMeasure');
    select.replaceChildren(...MEASURE_CHOICES.map((choice) => new Option(state.labels.measurePhrase(choice.key), choice.key)));
    select.value = measureKey(spec.measure);
}

function fillGroupSelect(spec) {
    const select = $('statsEdGroupBy');
    const allowed = new Set(allowedGroupBy(spec.measure));
    select.replaceChildren();
    for (const { family, dims } of GROUP_CHOICES) {
        const group = document.createElement('optgroup');
        group.label = state.labels.groupFamily(family);
        for (const dim of dims) {
            const option = new Option(state.labels.groupPhrase(dim), dim);
            option.disabled = !allowed.has(dim);
            group.append(option);
        }
        select.append(group);
    }
    select.value = spec.groupBy;
}

function fillChartSelect(spec) {
    const select = $('statsEdChart');
    const charts = allowedCharts(spec).filter((chart) => LOT1_CHARTS.includes(chart));
    select.replaceChildren(...charts.map((chart) => new Option(state.labels.chart(chart), chart)));
    select.value = charts.includes(spec.view.chart) ? spec.view.chart : charts[0];
}

// Lignes « comparé à … » de la phrase : une par période après la première.
function renderCompareRows(spec) {
    const list = $('statsEdCompareList');
    list.replaceChildren();
    const compares = Array.isArray(spec.periods) ? spec.periods.slice(1) : [];
    const choices = comparePeriodChoices(state.table.extent, state.today);
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

function fillChoiceSelect(select, values, labelOf, current) {
    select.replaceChildren(...values.map((value) => new Option(labelOf(value), value)));
    select.value = values.includes(current) ? current : values[0];
}

function syncEditorForm() {
    const { item } = state.editor;
    const { spec } = item;
    fillMeasureSelect(spec);
    fillGroupSelect(spec);
    const first = spec.periods?.[0];
    fillPeriodSelect($('statsEdPeriod'), first && first.kind !== 'dashboard' ? first : null, {
        inherit: true,
        choices: chartPeriodChoices(state.table.extent, state.today),
    });
    renderCompareRows(spec);
    fillChartSelect(spec);

    // Comparaison : présentation, alignement, « à date » — seulement quand
    // le graphique compare plusieurs périodes.
    const multiple = periodsAreMultiple(spec.periods);
    $('statsEdCompareBlock').hidden = !multiple;
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
    $('statsEdOrientation').value = spec.view.orientation;
    $('statsEdTop').value = spec.view.top;
    $('statsEdSort').value = spec.view.sort;
    $('statsEdLabels').checked = spec.view.labels;
    $('statsEdSmooth').checked = spec.view.smooth;
    $('statsEdLog').checked = spec.view.log;

    const chart = spec.view.chart;
    const category = ['cache_type', 'container', 'country', 'state', 'owner', 'attribute', 'dt'].includes(spec.groupBy);
    $('statsEdOrientationRow').hidden = chart !== 'bar';
    $('statsEdTopRow').hidden = !category;
    $('statsEdSortRow').hidden = !category || chart === 'number';
    $('statsEdSmoothRow').hidden = chart !== 'line' && chart !== 'area';
    $('statsEdLogRow').hidden = chart === 'number' || chart === 'donut';
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
        title: $('statsEdTitle').value,
        measure: measureOfKey($('statsEdMeasure').value),
        groupBy: $('statsEdGroupBy').value,
        periods: readEditorPeriods(),
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
        },
    };
    // Titre venu d'une question (« Nombre de trouvailles ») : il ne décrit
    // plus le graphique dès que la mesure ou le regroupement change. Tant
    // que l'utilisateur n'a pas écrit le sien, il redevient automatique.
    const content = raw.groupBy !== spec.groupBy || measureKey(raw.measure) !== measureKey(spec.measure);
    if (content && !state.editor.titleTouched) raw.title = '';
    // Passer à « au total » propose le chiffre clé ; le quitter, les barres.
    if (raw.groupBy === 'none' && spec.groupBy !== 'none') raw.view.chart = 'number';
    if (raw.groupBy !== 'none' && spec.view.chart === 'number') raw.view.chart = 'bar';
    item.spec = normalizeChartSpec(raw);
    item.size = DASHBOARD_SIZES.includes($('statsEdSize').value) ? $('statsEdSize').value : item.size;
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
    state.previewChart = renderChartInto(host, result, spec);
    state.previewChart.resize();
}

function onEditorChange() {
    readEditorForm();
    syncEditorForm();
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
        rows: state.table?.n ?? null,
        undated: state.table?.undated ?? null,
        dashboard: dashboard ? {
            id: dashboard.id,
            name: dashboard.name,
            period: dashboard.period,
            items: dashboard.items.length,
        } : null,
        cards: dashboard ? dashboard.items.map((item) => {
            const entry = state.results.get(item.spec.id);
            return {
                id: item.spec.id,
                size: item.size,
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
                grids: (() => {
                    const grid = state.charts.get(item.spec.id)?.getOption().grid;
                    return Array.isArray(grid) ? grid.length : null;
                })(),
                rendered: item.spec.view.chart === 'number' || state.charts.has(item.spec.id),
            };
        }) : [],
        editor: state.editor ? { mode: state.editor.mode, spec: state.editor.item.spec, size: state.editor.item.size } : null,
    };
};

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

function bindEvents() {
    $('btnStatsRetry').addEventListener('click', loadPage);
    $('btnStatsAddChart').addEventListener('click', openGallery);
    $('btnStatsAddChartEmpty').addEventListener('click', openGallery);
    $('btnStatsRename').addEventListener('click', openRename);
    $('statsRenameForm').addEventListener('submit', submitRename);
    $('statsGlobalPeriod').addEventListener('change', onGlobalPeriodChange);
    $('statsGrid').addEventListener('click', onCardAction);
    $('statsGalleryList').addEventListener('click', onGalleryPick);
    for (const id of ['statsEdMeasure', 'statsEdGroupBy', 'statsEdPeriod', 'statsEdChart', 'statsEdSize',
        'statsEdOrientation', 'statsEdSort', 'statsEdLabels', 'statsEdSmooth', 'statsEdLog',
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
