// Page Statistiques : liens vers les pages carte — carte filtrée sur une
// valeur, envoi en panneau vidéo.

import { showActionToast, showConfirmation, showError, showToast, t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { SOURCE_KIND_VALUES } from './chart_sources.mjs';
import { ELAPSED_UNITS, OTHERS_KEY, UNKNOWN_KEY, timeKeyBounds } from './chart_query.mjs';
import { evolutionDatasetOf, FILTER_FIELDS } from './chart_spec.mjs';
import { activeFilterCount } from './chart_filters.mjs';
import { clickTarget } from './chart_echarts.mjs';
import { discoveryModeFor, mapSelectionFor } from './chart_map_link.mjs';
import { panelFromSpec } from './chart_panel_link.mjs';
import { STATS_MAX_PANELS } from './stats_model.mjs';
import { effectiveQueryOptions } from './dashboard_model.mjs';
import { chartClickable, renderAllCharts, TIME_DIMS } from './stats_page_cards.js';
import {
    activeDashboard, attributeName, chartTitle, filterValueLabel, renderToolbar,
} from './stats_page_dashboard.js';
import { scheduleSave } from './stats_page_save.js';
import { fetchJson, tableOf } from './stats_page_data.js';
import { state } from './stats_page_state.js';
import { zoneBounds } from './stats_page_geo.js';
import { isoOfDay } from './chart_map_link.mjs';

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

export function onChartClick(host, params) {
    const card = host.closest('.stats-card');
    const entry = card ? state.results.get(card.dataset.chartId) : null;
    if (!entry?.result || !chartClickable(entry.spec, entry.result)) return;
    const target = clickTarget(entry.result, entry.spec, params);
    if (!target) return;
    if (entry.spec.view.chart === 'map') {
        confirmZoneLink(entry, target);
        return;
    }
    // La valeur cliquée a un équivalent en filtres/période du tableau :
    // proposer « Filtrer ce tableau » à côté de « Voir sur la carte ».
    const scope = dashboardScope(entry, target);
    if (!scope) {
        confirmMapLink(card.dataset.chartId, target);
        return;
    }
    showScopeChoice(card.dataset.chartId, target, scope);
}

// ---------------------------------------------------------------------------
// « Filtrer ce tableau » : une marque du graphique → filtres ou période du
// tableau de bord. Une dimension de catégorie devient un filtre (D/T en pose
// deux), une dimension de temps devient la période ; la période de la série
// cliquée fait de même dans une comparaison.
// ---------------------------------------------------------------------------

const FILTERABLE = new Set(FILTER_FIELDS);

function periodForTimeKey(dim, key) {
    if (dim === 'year') return { kind: 'year', year: key };
    if (dim === 'month') return { kind: 'month', year: Math.floor(key / 100), month: key % 100 };
    const b = timeKeyBounds(dim, key);
    return b ? { kind: 'range', from: isoOfDay(b[0]), to: isoOfDay(b[1]) } : null;
}

// Période d'une entrée de comparaison : la période nommée quand elle existe
// (2024, mars 2024, plage) sinon la plage résolue.
function periodForEntry(entry) {
    const as = entry?.as || entry?.period;
    if (as?.kind === 'year') return { kind: 'year', year: as.year };
    if (as?.kind === 'month') return { kind: 'month', year: as.year, month: as.month };
    if (as?.kind === 'range') return { kind: 'range', from: as.from, to: as.to };
    if (!entry) return null;
    return { kind: 'range', from: isoOfDay(entry.from), to: isoOfDay(entry.to) };
}

const isCategory = (key) => key !== null && key !== undefined && key !== OTHERS_KEY && key !== UNKNOWN_KEY;

export function dashboardScope(entry, target) {
    const { spec, result } = entry;
    const key = result.keys?.[target.keyIndex];
    const series = result.series?.[target.seriesIndex];
    const adds = {};
    let period = null;
    const push = (field, value) => { if (FILTERABLE.has(field)) (adds[field] ??= []).push(String(value)); };
    const pushDim = (dim, value) => {
        if (dim === 'dt' && typeof value === 'string' && value.includes('|')) {
            const [d, te] = value.split('|');
            push('difficulty', d);
            push('terrain', te);
        } else push(dim, value);
    };
    if (isCategory(key)) {
        if (result.dim === 'dt' || FILTERABLE.has(result.dim)) pushDim(result.dim, key);
        else if (TIME_DIMS.has(result.dim) && !result.elapsedUnit) period = periodForTimeKey(result.dim, key);
    }
    const split = series?.split;
    if (isCategory(split)) {
        if (spec.splitBy === 'year') { if (!period) period = { kind: 'year', year: split }; }
        else pushDim(spec.splitBy, split);
    }
    // Clic sur une série d'une comparaison : sa période devient celle du tableau.
    if (!period && result.periods.length > 1 && Number.isInteger(series?.periodIndex)) {
        period = periodForEntry(result.periods[series.periodIndex]);
    }
    if (!period && !Object.keys(adds).length) return null;
    const parts = [];
    if (period) parts.push(t('Période : ${p}', { p: state.labels.periodChoiceLabel(period) }));
    for (const [field, values] of Object.entries(adds)) {
        parts.push(state.labels.filterField(field) + ' : '
            + values.map((v) => filterValueLabel(field, v)).join(', '));
    }
    return { filters: adds, period, label: parts.join(' · ') };
}

// Applique le périmètre cliqué au tableau : les valeurs s'AJOUTENT aux
// filtres existants, la période est remplacée — « Annuler » rend les deux.
function applyDashboardScope(scope) {
    const dashboard = activeDashboard();
    const before = { filters: structuredClone(dashboard.filters), period: structuredClone(dashboard.period) };
    if (scope.period) dashboard.period = scope.period;
    if (Object.keys(scope.filters).length) {
        const filters = { ...(dashboard.filters || {}) };
        for (const [field, values] of Object.entries(scope.filters)) {
            filters[field] = [...new Set([...(filters[field] || []), ...values])];
        }
        dashboard.filters = filters;
    }
    scheduleSave({ immediate: true });
    renderToolbar();
    renderAllCharts();
    showActionToast(t('Périmètre appliqué : ${what}', { what: scope.label }), {
        label: t('Annuler'),
        onClick: () => {
            const current = state.doc?.dashboards.find((d) => d.id === dashboard.id);
            if (!current) return;
            current.filters = before.filters;
            current.period = before.period;
            scheduleSave({ immediate: true });
            renderToolbar();
            renderAllCharts();
        },
    });
}

// Choix après un clic : filtrer ce tableau, ou ouvrir la carte filtrée sur
// ces trouvailles (mêmes rôles data-gcm-role que la modale de confirmation).
let scopeSeq = 0;
function showScopeChoice(chartId, target, scope) {
    const entry = state.results.get(chartId);
    const link = mapLinkFor(chartId, target);
    const key = entry.result.keys?.[target.keyIndex];
    const title = isCategory(key)
        ? state.labels.axisLabel(entry.result.dim, key, { long: true, attributeName })
        : chartTitle(entry.spec);
    const titleId = `stats-scope-title-${++scopeSeq}`;
    const modalEl = document.createElement('div');
    modalEl.className = 'modal bs-modal fade gcm-confirm-modal';
    modalEl.tabIndex = -1;
    modalEl.setAttribute('aria-labelledby', titleId);
    modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="${titleId}"></h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body"><p class="mb-0" data-gcm-role="message"></p></div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-gcm-role="cancel"></button>
                    <button type="button" class="btn btn-outline-primary" data-gcm-role="confirm"></button>
                    <button type="button" class="btn btn-primary" data-gcm-role="filter"></button>
                </div>
            </div>
        </div>`;
    modalEl.querySelector(`#${titleId}`).textContent = title;
    modalEl.querySelector('[data-gcm-role="message"]').textContent = link
        ? t('Filtrer ce tableau sur « ${scope} », ou afficher ces trouvailles sur la carte (ses filtres seront remplacés).', { scope: scope.label })
        : t('Filtrer ce tableau sur « ${scope} ».', { scope: scope.label });
    const cancelBtn = modalEl.querySelector('[data-gcm-role="cancel"]');
    cancelBtn.textContent = t('Annuler');
    cancelBtn.addEventListener('click', () => modal.hide());
    const filterBtn = modalEl.querySelector('[data-gcm-role="filter"]');
    filterBtn.textContent = t('Filtrer ce tableau');
    filterBtn.addEventListener('click', () => {
        modal.hide();
        applyDashboardScope(scope);
    });
    const mapBtn = modalEl.querySelector('[data-gcm-role="confirm"]');
    if (link) {
        mapBtn.textContent = t('Voir sur la carte');
        mapBtn.addEventListener('click', () => {
            modal.hide();
            openMapWith(link);
        });
    } else mapBtn.remove();
    modalEl.querySelector('.btn-close').setAttribute('aria-label', t('Fermer'));
    document.body.appendChild(modalEl);
    const modal = getBsModal(modalEl);
    if (!modal) {
        modalEl.remove();
        return;
    }
    modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove(), { once: true });
    modal.show();
}

// ---------------------------------------------------------------------------
// Carte par zones : une zone → la carte en pause à la date de la vignette,
// cadrée sur la zone (lien d'entrée « ?at=…&bbox=… », lu par init.js).
// ---------------------------------------------------------------------------

export function zoneLinkUrl(entry, target) {
    const { spec, result } = entry;
    const series = result.series[target.seriesIndex];
    const id = result.keys[target.keyIndex];
    if (!series || !id || !Number.isFinite(series.day)) return null;
    // Source Évolution : « dataset » dit à la page quel jeu ouvrir — le
    // sien, pas le dernier mémorisé (lu par initEvolutionPage).
    const datasetId = evolutionDatasetOf(spec.source);
    const page = datasetId ? '/evolution' : '/';
    const params = new URLSearchParams();
    if (datasetId) params.set('dataset', String(datasetId));
    params.set('at', isoOfDay(series.day));
    const box = zoneBounds(id);
    if (box && box.every(Number.isFinite)) params.set('bbox', box.map((v) => v.toFixed(4)).join(','));
    return page + '?' + params.toString();
}

function confirmZoneLink(entry, target) {
    const url = zoneLinkUrl(entry, target);
    if (!url) return;
    const series = entry.result.series[target.seriesIndex];
    const zone = state.labels.axisLabel(entry.result.dim, entry.result.keys[target.keyIndex]);
    const date = new Intl.DateTimeFormat(state.labels.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(series.day * 86400000));
    showConfirmation(
        t("La carte s'ouvrira en pause au ${date}, cadrée sur ${zone}. Ses filtres ne changent pas.", { date, zone }),
        t('Voir sur la carte'),
        () => window.location.assign(url),
        null,
        { confirmText: t('Ouvrir la carte') },
    );
}

// Confirmation puis carte filtrée sur une valeur (ou un record daté).
export function confirmMapLink(chartId, target) {
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

export function sendToPanel(spec) {
    const { periods, filters } = effectiveQueryOptions(spec, activeDashboard());
    const out = panelFromSpec(spec, { title: chartTitle(spec), periods, filters });
    if (out.error) return;
    const pageName = PANEL_PAGE_NAMES[out.page]();
    const intro = t("Le graphique devient un panneau de la page « ${page} », qui se remplit au fil de l'animation.", { page: pageName });
    let warning = out.dropped.some((d) => d !== 'goal')
        ? ' ' + t('Il suit la période et les filtres de la carte : la période, les filtres et le découpage de ce graphique ne sont pas repris.')
        : '';
    if (out.dropped.includes('goal')) warning += ' ' + t("L'objectif et la projection restent sur cette page.");
    showConfirmation(intro + warning, t('Envoyer en panneau vidéo'), () => appendPanel(out), null, { confirmText: t('Envoyer') });
}

