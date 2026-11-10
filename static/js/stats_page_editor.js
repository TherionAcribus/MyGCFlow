// Page Statistiques : éditeur d'un graphique (phrase, options, aperçu).

import { t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import {
    allowedAligns, allowedCharts, allowedGroupBy, allowedLayouts, allowedNormalize, allowedSplitBy,
    chartSources, goalApplies, hasSeveralSeries, MAX_EXTRA_SOURCES, MAX_SERIES, normalizeChartSpec,
    normalizeMeasure, sourceDimensions,
} from './chart_spec.mjs';
import { ELAPSED_UNITS } from './chart_query.mjs';
import { activeFilterCount } from './chart_filters.mjs';
import { destroyFilterForm, readFilterForm, renderFilterForm } from './stats_filters_ui.js';
import { EDITOR_CHARTS, GROUP_CHOICES, MEASURE_CHOICES, measureKey, measureOfKey } from './chart_labels.mjs';
import {
    chartPeriodChoices, comparePeriodChoices, DASHBOARD_HEIGHTS, DASHBOARD_SIZES, dashboardSources,
    HEIGHT_PIXELS, MAX_ITEMS, periodOfValue,
} from './dashboard_model.mjs';
import { withUndo } from './stats_page_card_actions.js';
import { computeResult, renderChartInto, renderNumber } from './stats_page_cards.js';
import { activeDashboard, attributeName, chartTitle, fillPeriodSelect } from './stats_page_dashboard.js';
import { dashboardExtent, dashboardTables, tableOf } from './stats_page_data.js';
import { $, state } from './stats_page_state.js';

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

export function addSource() {
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

export function onSourceListClick(event) {
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

export function onFilterModeChange() {
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

export function syncEditorForm() {
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
    // Carte par zones : taille des cases (grille), échelle et nuances.
    const map = spec.view.chart === 'map' ? spec.view.map : null;
    $('statsEdGridRow').hidden = spec.groupBy !== 'zone_grid';
    $('statsEdMapScaleRow').hidden = !map;
    $('statsEdMapClassesRow').hidden = !map;
    if (map) {
        $('statsEdGridSize').value = String(map.gridSize);
        $('statsEdMapScale').value = map.scale;
        // Une date de première trouvaille se classe par années.
        $('statsEdMapScale').disabled = spec.measure.op === 'first_day';
        $('statsEdMapClasses').value = String(map.classes);
    }
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
    // Objectif, projection : chiffre clé qui compte, courbe de cumul.
    const goalable = goalApplies(spec);
    $('statsEdGoalRow').hidden = !goalable;
    $('statsEdProjectionRow').hidden = !goalable;
    $('statsEdGoal').value = spec.goal ? String(spec.goal.value) : '';
    $('statsEdProjection').checked = spec.view.projection;
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
export function readEditorForm() {
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
        goal: Number($('statsEdGoal').value) > 0 ? { value: Math.round(Number($('statsEdGoal').value)) } : null,
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
            projection: $('statsEdProjection').checked,
            log: $('statsEdLog').checked,
            stack: $('statsEdStack').checked,
            palette: $('statsEdPaletteRow').hidden ? spec.view.palette : $('statsEdPalette').value,
            ...(spec.view.map ? {
                map: {
                    ...spec.view.map,
                    gridSize: Number($('statsEdGridSize').value),
                    scale: $('statsEdMapScale').value,
                    classes: Number($('statsEdMapClasses').value),
                },
            } : {}),
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

export function renderPreview() {
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

export function onEditorChange() {
    readEditorForm();
    syncEditorForm();
    syncEditorFilters();
    renderPreview();
}

// « Comparer à une autre période » : ajoute « la période précédente » (de
// la dernière de la liste), le choix le plus courant.
export function addComparePeriod() {
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

export function onCompareListClick(event) {
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

export function openEditor({ mode, index = -1, item }) {
    state.editor = { mode, index, item: structuredClone(item), titleTouched: false, sizeTouched: false };
    $('statsEditorTitle').textContent = mode === 'new' ? t('Nouveau graphique') : t('Modifier le graphique');
    syncEditorForm();
    syncEditorFilters({ rebuild: true });
    // Section des filtres ouverte d'office quand le graphique en a.
    $('statsEdFiltersSection').open = state.editor.item.spec.filters !== null;
    const modal = getBsModal('statsEditorModal');
    modal?.show();
}

export function saveEditor() {
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

