// Page Statistiques : liens vers les pages carte — carte filtrée sur une
// valeur, envoi en panneau vidéo.

import { showConfirmation, showError, showToast, t } from './notifications.js';
import { SOURCE_KIND_VALUES } from './chart_sources.mjs';
import { ELAPSED_UNITS } from './chart_query.mjs';
import { activeFilterCount } from './chart_filters.mjs';
import { clickTarget } from './chart_echarts.mjs';
import { discoveryModeFor, mapSelectionFor } from './chart_map_link.mjs';
import { panelFromSpec } from './chart_panel_link.mjs';
import { STATS_MAX_PANELS } from './stats_model.mjs';
import { effectiveQueryOptions } from './dashboard_model.mjs';
import { chartClickable, TIME_DIMS } from './stats_page_cards.js';
import { activeDashboard, attributeName, chartTitle } from './stats_page_dashboard.js';
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
    confirmMapLink(card.dataset.chartId, target);
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
    const page = spec.source.startsWith('evolution:') ? '/evolution' : '/';
    const params = new URLSearchParams({ at: isoOfDay(series.day) });
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

