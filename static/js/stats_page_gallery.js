// Page Statistiques : galerie des questions toutes faites et leurs aperçus.

import { t } from './notifications.js';
import { getBsModal } from './ui_bootstrap.js';
import { chartSources, createChartSpec } from './chart_spec.mjs';
import { buildChartOption, numberModel, thumbnailOption } from './chart_echarts.mjs';
import {
    dashboardSources, itemFromQuestion, MAX_ITEMS, QUESTION_GROUPS, questionFamily, QUESTIONS,
} from './dashboard_model.mjs';
import { withUndo } from './stats_page_card_actions.js';
import { cardSelector, chartContext, computeResult } from './stats_page_cards.js';
import { activeDashboard, chartTitle } from './stats_page_dashboard.js';
import { tableOf } from './stats_page_data.js';
import { openEditor } from './stats_page_editor.js';
import { $, echartsLocale, state } from './stats_page_state.js';
import { zoneMapFor } from './stats_page_geo.js';

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
            // « Mon prochain cap » : au-dessus du total des trouvailles.
            const item = previous.get(question.id)
                || itemFromQuestion(question.id, { title, dataset: dashboard.dataset, total: tableOf('finds').n });
            if (item) state.gallery.items.set(question.id, item);
            return card(question.id, question.icon, title, description, { preview: Boolean(item) });
        });
        if (cards.length) list.append(section(state.labels.questionGroup(group), cards));
    }
}

// Aperçus : observés une fois la modale visible (avant, ECharts mesurerait
// des conteneurs de taille nulle).
export function startGalleryPreviews() {
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
    // Carte dont les contours arrivent : l'aperçu attend (relancé par
    // l'événement « mygcflow:stats-geo »).
    if (spec.view.chart === 'map' && zoneMapFor(result, spec).loading) {
        state.gallery.geoWaiting.add(box);
        return;
    }
    // Galerie qui se ferme (choix immédiat d'une question) : boîte sans
    // taille. ECharts lève une erreur en posant une carte (geo) dans 0 × 0 ;
    // l'aperçu est simplement abandonné, la galerie le refera à l'ouverture.
    if (spec.view.chart === 'map' && (!box.clientWidth || !box.clientHeight)) return;
    setPreviewState(box, 'chart');
    const width = box.clientWidth;
    const option = thumbnailOption(buildChartOption(result, spec, { ...chartContext(), width }));
    const chart = window.echarts.init(box, null, { locale: echartsLocale(), renderer: 'canvas' });
    chart.setOption(option, true);
    state.gallery.charts.push(chart);
}

export function releaseGalleryPreviews() {
    state.gallery.observer?.disconnect();
    state.gallery.observer = null;
    if (state.gallery.frame) cancelAnimationFrame(state.gallery.frame);
    state.gallery.frame = 0;
    state.gallery.queue = [];
    state.gallery.geoWaiting.clear();
    for (const chart of state.gallery.charts) chart.dispose();
    state.gallery.charts = [];
}

window.addEventListener('mygcflow:stats-geo', () => {
    const waiting = [...state.gallery.geoWaiting].filter((box) => box.isConnected);
    state.gallery.geoWaiting.clear();
    if (!waiting.length) return;
    state.gallery.queue.push(...waiting);
    scheduleGalleryPreviews();
});

export function openGallery() {
    if (activeDashboard().items.length >= MAX_ITEMS) return;
    renderGallery();
    getBsModal('statsGalleryModal')?.show();
}

export function onGalleryPick(event) {
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

