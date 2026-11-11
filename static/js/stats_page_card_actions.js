// Page Statistiques : actions du menu d'une carte, déplacer et
// redimensionner à la souris.

import { showActionToast, showConfirmation, t } from './notifications.js';
import { createChartSpec } from './chart_spec.mjs';
import { DASHBOARD_SIZES, HEIGHT_PIXELS, MAX_ITEMS, SIZE_COLUMNS } from './dashboard_model.mjs';
import { renderDashboard } from './stats_page_cards.js';
import { activeDashboard, chartTitle } from './stats_page_dashboard.js';
import { retrySources } from './stats_page_data.js';
import { openEditor } from './stats_page_editor.js';
import { exportPng, exportSvg, openExplain, openValues } from './stats_page_exports.js';
import { sendToPanel } from './stats_page_links.js';
import { openPresentation } from './stats_page_present.js';
import { scheduleSave } from './stats_page_save.js';
import { $, state } from './stats_page_state.js';
import { openVideo } from './stats_page_video.js';

// ---------------------------------------------------------------------------
// Actions des cartes
// ---------------------------------------------------------------------------

function itemIndex(id) {
    return activeDashboard().items.findIndex((item) => item.spec.id === id);
}

// La dernière organisation des cartes est annulable : la copie d'avant la
// mutation est restaurée par « Annuler » dans le toast (un seul niveau —
// l'action la plus récente remplace la précédente).
export function withUndo(message, mutate) {
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

export function onCardAction(event) {
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
        case 'explain':
            openExplain(item.spec);
            break;
        case 'present':
            openPresentation(item.spec.id);
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

export function fileSafe(name) {
    // « \/ » échappé dans la classe : sinon le lexer JS de pybabel ferme la
    // regex à ce « / » et perd les t() des ~500 lignes suivantes.
    return String(name).replace(/[\\\/:*?<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'graphique';
}

export function download(blob, name) {
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
// Déplacer et redimensionner à la souris
// ---------------------------------------------------------------------------

// Glisser-déposer HTML5 : la carte ne devient « glissable » que saisie par
// sa poignée (sinon la sélection de texte et les graphiques s'en mêlent).
export function onGridPointerDown(event) {
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

export function onDragStart(event) {
    const card = event.target.closest?.('.stats-card');
    if (!card || !card.draggable) return;
    state.dragId = card.dataset.chartId;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragId);
}

export function onDragOver(event) {
    if (!state.dragId) return;
    const card = event.target.closest('.stats-card');
    if (!card || card.dataset.chartId === state.dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    card.classList.add(dropSide(card, event) === 'before' ? 'drop-before' : 'drop-after');
}

export function onDrop(event) {
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

export function endDrag() {
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

