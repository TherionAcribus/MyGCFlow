// Page Statistiques : valeurs en tableau (CSV), images d'un graphique
// (PNG, SVG) et du tableau entier, impression.

import { showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { describeFilters } from './chart_filters.mjs';
import { axisLabels, buildChartOption, numberModel, seriesIdentity } from './chart_echarts.mjs';
import { paintDashboardImage } from './stats_image.js';
import { effectiveQueryOptions } from './dashboard_model.mjs';
import { download, fileSafe } from './stats_page_card_actions.js';
import { chartContext, renderAllCharts, renderDeferred } from './stats_page_cards.js';
import {
    activeDashboard, chartTitle, dataNote, datasetName, filterValueLabel,
} from './stats_page_dashboard.js';
import { $, echartsLocale, readTokens, state } from './stats_page_state.js';

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

export function openValues(spec) {
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
export function downloadValuesCsv() {
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

// Un graphique redessiné hors écran, sans animation (état final), à la
// taille donnée : `use` reçoit l'instance ECharts, libérée ensuite.
function withOffscreenChart(result, spec, { renderer, width, height, ratio = 1, background }, use) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + width + 'px;height:' + height + 'px';
    document.body.append(box);
    const chart = window.echarts.init(box, null, { renderer, width, height, devicePixelRatio: ratio, locale: echartsLocale() });
    try {
        const option = buildChartOption(result, spec, { ...chartContext(), width });
        chart.setOption({ ...option, animation: false, backgroundColor: background });
        return use(chart);
    } finally {
        chart.dispose();
        box.remove();
    }
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
    return withOffscreenChart(entry.result, spec, { renderer: 'svg', width, height, background: state.tokens.surface },
        (svgChart) => svgChart.renderToSVGString());
}

// ---------------------------------------------------------------------------
// Image du tableau entier (stats_image.js) : enregistrée en PNG ou copiée
// ---------------------------------------------------------------------------

// Graphique d'une carte pour l'image : redessiné à la netteté de l'image,
// fond transparent (celui de la carte est déjà peint).
function chartImageCanvas(chartId, width, height, ratio) {
    const entry = state.results.get(chartId);
    if (!entry?.result) return null;
    return withOffscreenChart(entry.result, entry.spec, { renderer: 'canvas', width, height, ratio, background: 'transparent' },
        (chart) => chart.getRenderedCanvas({ pixelRatio: ratio, backgroundColor: 'transparent' }));
}

// En-tête de l'image : de quoi parle le tableau (période, données,
// filtres) ; « MyGCFlow · date » en pied de page.
function dashboardImageHeader(dashboard) {
    const first = [];
    if (dashboard.kind === 'evolution') first.push(t('Évolution · ${name}', { name: datasetName(dashboard.dataset) }));
    first.push(state.labels.periodChoiceLabel(dashboard.period));
    const data = dataNote(dashboard);
    if (data) first.push(data);
    const filters = describeFilters(dashboard.filters, filterValueLabel)
        .map(({ field, values }) => state.labels.filterField(field) + ' : ' + values.join(', '));
    return [first.join(' · '), filters.length ? t('Filtres') + ' : ' + filters.join(' · ') : ''];
}

async function dashboardImageBlob() {
    if (!state.ready || !activeDashboard().items.length) throw new Error('no dashboard');
    // Cartes encore différées : dessinées d'abord, la disposition est finale.
    renderDeferred();
    const dashboard = activeDashboard();
    const tokens = state.tokens || readTokens();
    const root = getComputedStyle(document.documentElement);
    const page = getComputedStyle(document.body).backgroundColor;
    const date = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    const out = await paintDashboardImage({
        grid: $('statsGrid'),
        title: dashboard.name || t('Mon tableau de bord'),
        lines: dashboardImageHeader(dashboard),
        footer: 'MyGCFlow · ' + date,
        colors: {
            background: page && page !== 'rgba(0, 0, 0, 0)' ? page : tokens.surface,
            heading: root.getPropertyValue('--color-heading').trim() || tokens.text,
            muted: tokens.textMuted,
            font: tokens.font,
        },
        chartCanvas: chartImageCanvas,
    });
    const blob = await new Promise((resolve) => out.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('toBlob');
    state.lastImage = {
        width: out.canvas.width, height: out.canvas.height, ratio: out.ratio,
        cards: out.cards, charts: out.charts, bytes: blob.size,
    };
    return blob;
}

export async function saveDashboardImage() {
    try {
        const blob = await dashboardImageBlob();
        download(blob, fileSafe(activeDashboard().name || t('Mon tableau de bord')) + '.png');
    } catch (e) {
        console.warn('[stats] Image du tableau :', e?.message || e);
        showError(t("L'image du tableau n'a pas pu être créée."));
    }
}

// Copie dans le presse-papiers, à coller dans un message ou un forum. La
// promesse est passée telle quelle à ClipboardItem : le geste de
// l'utilisateur reste valable pendant le dessin.
export async function copyDashboardImage() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        showError(t('Ce navigateur ne sait pas copier une image : enregistrez-la plutôt en PNG.'));
        return;
    }
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': dashboardImageBlob() })]);
        showToast(t('Image du tableau copiée : collez-la où vous voulez.'), 'success');
    } catch (e) {
        console.warn('[stats] Copie de l’image du tableau :', e?.message || e);
        showError(t("L'image du tableau n'a pas pu être copiée."));
    }
}

export function exportSvg(spec) {
    const svg = chartSvg(spec);
    if (svg) download(new Blob([svg], { type: 'image/svg+xml' }), fileSafe(chartTitle(spec)) + '.svg');
}

export function exportPng(spec) {
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
// Impression : toujours sur fond clair
// ---------------------------------------------------------------------------

export function onBeforePrint() {
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

export function onAfterPrint() {
    if (state.printTheme) {
        document.documentElement.setAttribute('data-bs-theme', state.printTheme);
        state.printTheme = null;
    }
}

