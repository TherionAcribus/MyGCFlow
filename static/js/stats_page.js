// Point d'entrée de la page « Statistiques » (/stats).
//
// Page sans carte : elle ne charge ni OpenLayers ni index.js (graphe complet
// de la page carte). Elle tire des modules autonomes — thème, « Quitter »,
// modales — et les modules purs chart_*.mjs / dashboard_model.mjs. Le calcul
// et la fabrication des options ECharts sont purs et testés sous Node ; les
// modules stats_page_*.js ne font que le câblage DOM, un par fonction de la
// page (état partagé, données, sauvegarde, tableau de bord, cartes, actions,
// liens carte, vidéo, exports, galerie, éditeur, présentation). Ce fichier
// garde le suivi du thème et de la date, le relevé E2E et le démarrage.
// Plan : MyGCFlow_Plan_Statistiques.md ; doc : docs/page-statistiques.md.

import { bindQuitButtons } from './app_quit.js';
import { todayDay } from './chart_periods.mjs';
import { clearFilterForm, destroyFilterForm } from './stats_filters_ui.js';
import { measureKey } from './chart_labels.mjs';
import { presentDelay } from './present_model.mjs';
import {
    endDrag, onCardAction, onDragOver, onDragStart, onDrop, onGridPointerDown,
} from './stats_page_card_actions.js';
import {
    cardSelector, challengeSnapshot, chartClickable, onHostsResized, renderAllCharts,
} from './stats_page_cards.js';
import {
    activeDashboard, applyFilters, chartTitle, importDashboardFile, onDashboardMenuClick,
    onFiltersSummaryClick, onGlobalPeriodChange, openFilters, openRename, refreshData, releaseRangePick,
    renderToolbar, resetMapFiltersReport, submitNewDashboard, submitRangePick, submitRename,
    syncNewDashboardForm, takeMapFilters,
} from './stats_page_dashboard.js';
import { loadPage, loadUserSettings, retrySources, tableOf } from './stats_page_data.js';
import {
    addComparePeriod, addSource, onCompareListClick, onEditorChange, onFilterModeChange, onSourceListClick,
    readEditorForm, renderPreview, saveEditor, syncEditorForm,
} from './stats_page_editor.js';
import { downloadValuesCsv, onAfterPrint, onBeforePrint } from './stats_page_exports.js';
import {
    filterGallery, onGalleryPick, openGallery, releaseGalleryPreviews, startGalleryPreviews,
} from './stats_page_gallery.js';
import {
    closePresentation, openPresentation, presentEl, presentGo, scheduleAutoAdvance, showSlide,
    togglePresentAuto,
} from './stats_page_present.js';
import { flushSave, saveQueue } from './stats_page_save.js';
import { $, echartsLocale, readTokens, state } from './stats_page_state.js';
import {
    closeVideo, onMusicChange, onMusicFile, recordVideo, releaseVideo, revealVideo, syncVideoTotal,
} from './stats_page_video.js';

// ---------------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------------

function watchTheme() {
    const observer = new MutationObserver(() => {
        state.tokens = readTokens();
        state.tokensRev += 1;
        if (state.ready) renderAllCharts();
        if (state.editor) renderPreview();
        if (state.present) showSlide(state.present.index, { animate: false });
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
        // Dernière image du tableau : taille en pixels, netteté, cartes et
        // graphiques dessinés.
        image: state.lastImage,
        presentation: state.present ? {
            index: state.present.index,
            count: state.present.slides.length,
            chartId: state.present.slides[state.present.index],
            auto: state.present.auto,
            delay: state.present.delay,
            fullscreen: document.fullscreenElement === presentEl(),
            idle: presentEl().classList.contains('is-idle'),
            drawn: Boolean(state.present.chart) || Boolean($('statsPresentBody').querySelector('.stats-number-value')),
        } : null,
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
                // Carte par zones : niveau, pays chargés, classes, zones
                // contournées par vignette ; `drawn` = vignettes dessinées
                // (0 tant que les contours se chargent).
                zones: entry?.result?.zones ? (() => {
                    const option = state.charts.get(item.spec.id)?.getOption();
                    return {
                        level: entry.result.zones.level,
                        countries: entry.result.zones.countries,
                        classes: entry.result.zones.scale.classes,
                        changed: entry.result.series.map((s) => s.changed),
                        days: entry.result.series.map((s) => s.day),
                        unknown: entry.result.meta.unknown,
                        outOfFrame: entry.result.meta.outOfFrame || 0,
                        frame: item.spec.view.map?.frame ?? null,
                        drawn: Array.isArray(option?.geo) ? option.geo.length : 0,
                        map: Array.isArray(option?.geo) ? option.geo[0]?.map ?? null : null,
                        legend: option?.visualMap?.[0]?.pieces?.map((p) => p.label) ?? null,
                        // Valeurs écrites sur les zones (« Afficher les
                        // valeurs »), par vignette : { geo, values: [{ name,
                        // text }] } — avant le masquage des chevauchements.
                        values: (option?.series || []).filter((s) => s.type === 'scatter')
                            .map((s) => ({ geo: s.geoIndex, values: s.data.map((d) => ({ name: d.name, text: d.text })) })),
                    };
                })() : null,
            };
        }) : [],
        save: { dirty: state.docDirty, failed: state.saveFailed, pending: saveQueue.pending },
        editor: state.editor ? { mode: state.editor.mode, spec: state.editor.item.spec, size: state.editor.item.size } : null,
        video: state.video ? {
            mode: state.video.mode, chartId: state.video.spec?.id ?? null, slides: state.video.slides?.length ?? null,
            music: state.video.music ? { kind: state.video.music.kind, file: state.video.music.file || state.video.music.name } : null,
            phase: state.video.phase, file: state.video.file, folder: state.video.folder || null,
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
    $('statsVideoDuration').addEventListener('change', syncVideoTotal);
    $('statsVideoMusic').addEventListener('change', onMusicChange);
    $('statsVideoMusicFile').addEventListener('change', onMusicFile);
    $('btnStatsAddChart').addEventListener('click', openGallery);
    $('btnStatsAddChartEmpty').addEventListener('click', openGallery);
    $('btnStatsRename').addEventListener('click', openRename);
    $('statsRenameForm').addEventListener('submit', submitRename);
    $('statsGlobalPeriod').addEventListener('change', onGlobalPeriodChange);
    $('statsGlobalUpTo').addEventListener('change', onGlobalPeriodChange);
    $('statsRangeForm').addEventListener('submit', submitRangePick);
    $('statsRangeModal').addEventListener('hidden.bs.modal', releaseRangePick);
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
    $('statsGallerySearch').addEventListener('input', filterGallery);
    $('statsGalleryModal').addEventListener('shown.bs.modal', startGalleryPreviews);
    $('statsGalleryModal').addEventListener('hidden.bs.modal', releaseGalleryPreviews);
    $('statsDashboardMenu').addEventListener('click', onDashboardMenuClick);
    $('statsShareMenu').addEventListener('click', onDashboardMenuClick);
    $('statsNewDashboardForm').addEventListener('submit', submitNewDashboard);
    for (const id of ['statsNewKindPersonal', 'statsNewKindEvolution', 'statsNewDataset']) {
        $(id).addEventListener('change', syncNewDashboardForm);
    }
    $('statsNewName').addEventListener('input', () => { $('statsNewName').dataset.touched = '1'; });
    $('statsNewDashboardModal').addEventListener('shown.bs.modal', () => $('statsNewName').select());
    // « Réessayer » de l'aperçu quand une source du graphique est en échec :
    // mêmes sources que la carte, puis l'aperçu se redessine.
    $('statsEdPreviewNumber').addEventListener('click', (event) => {
        if (!event.target.closest('.stats-card-retry') || !state.editor) return;
        retrySources(state.editor.item.spec).then(renderPreview);
    });
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
    $('btnStatsPresent').addEventListener('click', () => openPresentation());
    $('btnStatsPresentPrev').addEventListener('click', () => presentGo('prev'));
    $('btnStatsPresentNext').addEventListener('click', () => presentGo('next'));
    $('btnStatsPresentPlay').addEventListener('click', togglePresentAuto);
    $('btnStatsPresentExit').addEventListener('click', closePresentation);
    $('statsPresentDelay').addEventListener('change', () => {
        if (!state.present) return;
        state.present.delay = presentDelay($('statsPresentDelay').value);
        scheduleAutoAdvance();
    });
    $('statsFiltersModal').addEventListener('hidden.bs.modal', () => destroyFilterForm($('statsFiltersForm')));
    $('statsFiltersSummary').addEventListener('click', onFiltersSummaryClick);
    $('statsEdFilterMode').addEventListener('change', onFilterModeChange);
    for (const id of ['statsEdSource', 'statsEdSourceList', 'statsEdMeasure', 'statsEdGroupBy', 'statsEdSplitBy', 'statsEdPeriod', 'statsEdUpTo', 'statsEdChart', 'statsEdSize',
        'statsEdOrientation', 'statsEdSort', 'statsEdLabels', 'statsEdHeight', 'statsEdSmooth', 'statsEdRecord', 'statsEdGoal', 'statsEdProjection', 'statsEdLog', 'statsEdStack', 'statsEdPalette',
        'statsEdLayout', 'statsEdAlign', 'statsEdToDate', 'statsEdNormalize', 'statsEdCompareList',
        'statsEdMapFrame', 'statsEdMapScale', 'statsEdMapClasses', 'statsEdGridSize']) {
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
