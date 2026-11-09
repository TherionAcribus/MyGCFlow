// Page Statistiques : mode présentation, un graphique par écran.

import { showToast, t } from './notifications.js';
import { periodsAreMultiple } from './chart_spec.mjs';
import { keyAction, presentDelay, presentSlides, startIndex, stepIndex } from './present_model.mjs';
import { hasOwnPeriod } from './dashboard_model.mjs';
import { cardNote, renderChartInto, renderNumber } from './stats_page_cards.js';
import { activeDashboard, chartTitle, periodsBadge } from './stats_page_dashboard.js';
import { $, state } from './stats_page_state.js';

// ---------------------------------------------------------------------------
// Mode présentation : un graphique par écran, en plein écran
// ---------------------------------------------------------------------------

// Commandes masquées après ce temps sans mouvement de souris.
const PRESENT_IDLE_MS = 2500;

export function presentEl() {
    return $('statsPresent');
}

// Ouvre la présentation (sur le graphique `chartId`, sinon le premier).
export async function openPresentation(chartId = null) {
    const dashboard = activeDashboard();
    // Les cartes différées ont leur résultat : il suffit qu'il soit calculé.
    const slides = presentSlides(dashboard.items, state.results);
    if (!slides.length) {
        showToast(t('Aucun graphique à présenter.'), 'info');
        return;
    }
    const delay = presentDelay($('statsPresentDelay').value);
    state.present = {
        slides, index: startIndex(slides, chartId), auto: false, delay,
        chart: null, timer: 0, idleTimer: 0, resizeFrame: 0,
        fullscreen: false, returnFocus: document.activeElement,
    };
    const el = presentEl();
    el.hidden = false;
    document.body.classList.add('is-presenting');
    document.addEventListener('keydown', onPresentKey);
    el.addEventListener('pointermove', onPresentActivity);
    window.addEventListener('resize', onPresentResize);
    document.addEventListener('fullscreenchange', onPresentFullscreenChange);
    // Plein écran : refusé (iframe, réglage du navigateur) → la présentation
    // occupe quand même toute la fenêtre.
    try {
        if (el.requestFullscreen) {
            await el.requestFullscreen({ navigationUI: 'hide' });
            if (state.present) state.present.fullscreen = true;
        }
    } catch (_) { /* fenêtre seulement */ }
    if (!state.present) return;
    showSlide(state.present.index);
    syncPresentControls();
    onPresentActivity();
    $('btnStatsPresentNext').focus();
}

export function closePresentation() {
    const present = state.present;
    if (!present) return;
    state.present = null;
    clearTimeout(present.timer);
    clearTimeout(present.idleTimer);
    cancelAnimationFrame(present.resizeFrame);
    present.chart?.dispose();
    const el = presentEl();
    el.hidden = true;
    el.classList.remove('is-idle');
    $('statsPresentBody').replaceChildren();
    document.body.classList.remove('is-presenting');
    document.removeEventListener('keydown', onPresentKey);
    el.removeEventListener('pointermove', onPresentActivity);
    window.removeEventListener('resize', onPresentResize);
    document.removeEventListener('fullscreenchange', onPresentFullscreenChange);
    if (document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
    present.returnFocus?.focus?.();
}

// Texte de période d'une diapositive : celle du graphique s'il en a une,
// sinon celle du tableau.
export function slidePeriod(spec, dashboard) {
    if (hasOwnPeriod(spec) || periodsAreMultiple(spec.periods)) return periodsBadge(spec);
    return state.labels.periodChoiceLabel(dashboard.period);
}

export function showSlide(index, { animate = true } = {}) {
    const present = state.present;
    if (!present) return;
    present.index = index;
    const id = present.slides[index];
    const entry = state.results.get(id);
    const dashboard = activeDashboard();
    present.chart?.dispose();
    present.chart = null;
    const body = $('statsPresentBody');
    body.replaceChildren();
    if (!entry?.result) return;
    const { spec, result } = entry;
    $('statsPresentTitle').textContent = chartTitle(spec);
    $('statsPresentPeriod').textContent = slidePeriod(spec, dashboard);
    const note = cardNote(result, spec);
    $('statsPresentNote').textContent = note;
    $('statsPresentNote').hidden = !note;
    $('statsPresentCount').textContent = t('${n} / ${count}', { n: index + 1, count: present.slides.length });
    body.classList.toggle('is-entering', animate && !state.reduceMotion);
    if (spec.view.chart === 'number') {
        const number = document.createElement('div');
        number.className = 'stats-number stats-present-number';
        body.append(number);
        renderNumber(number, result, spec, dashboard);
    } else {
        const host = document.createElement('div');
        host.className = 'stats-chart stats-present-chart';
        host.setAttribute('role', 'img');
        host.setAttribute('aria-label', chartTitle(spec));
        // Toute la hauteur disponible ; calendrier et grille de défi gardent
        // la leur (cases carrées) et défilent si besoin.
        body.append(host);
        present.chart = renderChartInto(host, result, spec, { fill: Math.max(240, body.clientHeight) });
    }
    if (animate && !state.reduceMotion) requestAnimationFrame(() => body.classList.remove('is-entering'));
    syncPresentControls();
    scheduleAutoAdvance();
}

export function presentGo(action) {
    const present = state.present;
    if (!present) return;
    const count = present.slides.length;
    let index = present.index;
    if (action === 'next') index = stepIndex(index, count, 1, { loop: present.auto });
    else if (action === 'prev') index = stepIndex(index, count, -1, { loop: present.auto });
    else if (action === 'first') index = 0;
    else if (action === 'last') index = count - 1;
    if (index !== present.index) showSlide(index);
    else scheduleAutoAdvance();
}

function syncPresentControls() {
    const present = state.present;
    if (!present) return;
    const count = present.slides.length;
    $('btnStatsPresentPrev').disabled = !present.auto && present.index === 0;
    $('btnStatsPresentNext').disabled = !present.auto && present.index === count - 1;
    const play = $('btnStatsPresentPlay');
    play.setAttribute('aria-pressed', String(present.auto));
    play.querySelector('.ti').className = 'ti ' + (present.auto ? 'ti-player-pause' : 'ti-player-play');
    presentEl().classList.toggle('is-playing', present.auto);
}

// Défilement automatique : la barre du haut se remplit pendant le délai
// (sans animation si « réduire les animations »), puis le suivant.
export function scheduleAutoAdvance() {
    const present = state.present;
    if (!present) return;
    clearTimeout(present.timer);
    const bar = $('statsPresentProgress');
    bar.style.transition = 'none';
    bar.style.width = '0';
    if (!present.auto || present.slides.length < 2) return;
    const ms = present.delay * 1000;
    if (!state.reduceMotion) {
        // Relancer la transition depuis zéro.
        void bar.offsetWidth;
        bar.style.transition = `width ${ms}ms linear`;
        bar.style.width = '100%';
    }
    present.timer = setTimeout(() => presentGo('next'), ms);
}

export function togglePresentAuto() {
    const present = state.present;
    if (!present) return;
    present.auto = !present.auto;
    syncPresentControls();
    scheduleAutoAdvance();
}

function onPresentKey(event) {
    if (!state.present || event.altKey || event.ctrlKey || event.metaKey) return;
    // Les commandes gardent leurs touches (Entrée / Espace sur un bouton,
    // flèches dans le menu des durées).
    const tag = event.target?.tagName;
    if (tag === 'SELECT' || (tag === 'BUTTON' && (event.key === ' ' || event.key === 'Enter'))) return;
    const action = keyAction(event.key);
    if (!action) return;
    event.preventDefault();
    if (action === 'close') closePresentation();
    else if (action === 'toggle') togglePresentAuto();
    else presentGo(action);
    onPresentActivity();
}

// Souris immobile : commandes et curseur masqués.
function onPresentActivity() {
    const present = state.present;
    if (!present) return;
    const el = presentEl();
    el.classList.remove('is-idle');
    clearTimeout(present.idleTimer);
    // (Une commande qui a le focus clavier reste visible : CSS :focus-within.)
    present.idleTimer = setTimeout(() => {
        if (state.present) el.classList.add('is-idle');
    }, PRESENT_IDLE_MS);
}

function onPresentResize() {
    const present = state.present;
    if (!present) return;
    cancelAnimationFrame(present.resizeFrame);
    present.resizeFrame = requestAnimationFrame(() => {
        if (state.present) showSlide(state.present.index, { animate: false });
    });
}

// Sortie du plein écran (Échap géré par le navigateur) : fin de la
// présentation.
function onPresentFullscreenChange() {
    if (state.present?.fullscreen && document.fullscreenElement !== presentEl()) closePresentation();
}

