// Barre de chronologie : sous la carte, hors de la zone capturée (jamais dans
// la vidéo). Elle montre la plage de l'animation — trait simple, histogramme
// des trouvailles ou courbe de progression — et un curseur sur le dernier jour
// affiché. Glisser le curseur (souris, doigt) ou le déplacer au clavier amène
// la carte et les panneaux Stats à cette date :
//   - au repos (ou après la fin), l'aperçu s'ouvre en pause à la date choisie ;
//   - en pause, il y reste ;
//   - pendant la lecture, il est mis en pause le temps du geste, puis repart
//     de la nouvelle date.
// Rien n'est enregistré dans les préférences : seuls l'affichage de la barre
// et son style sont retenus par ce navigateur (localStorage).
//
// Le saut lui-même vit dans mapgl.js (seekAnimationToDate), la pause et la
// reprise dans ui.js (mêmes chemins que les boutons).
import * as pkg from './index.js';
import { counterAt } from './evolution_timeline.mjs';
import { isEvolutionPage } from './app_mode.mjs';
import {
    bucketDaysFor,
    bucketize,
    clampOffset,
    cumulative,
    cursorFraction,
    dateOfOffset,
    dayOffsetOf,
    normalizeTimelineStyle,
    offsetAtFraction,
    offsetForKey,
    seriesExtent,
    spanDays,
    yearStartOffsets,
} from './timeline_model.mjs';

const VISIBLE_KEY = 'timelineBarVisible';
const STYLE_KEY = 'timelineBarStyle';
// Fin d'une série de frappes : la musique est recalée et la lecture reprend.
const KEY_SETTLE_MS = 350;
// Sous cette largeur, les dates des bornes et le choix du style cèdent la
// place à la piste.
const NARROW_PX = 520;

// var et non let pour ce que lit refreshTimelineBar : ui.js l'appelle
// (refreshTimingPlan, updateControlBar) pendant sa propre évaluation, avant
// celle de ce module — un let serait encore en zone morte (ReferenceError).
var bar = null;
var visible = false;
var frame = 0;
let track = null;
let canvas = null;
let toggleButton = null;
let style = 'histogram';
let seriesMemo = null;
// Geste en cours (pointeur ou série de frappes) : { resume, pointerId }.
let gesture = null;
let pendingOffset = null;
let seekFrame = 0;
let keySettleTimer = null;
// Dernier état dessiné, pour convertir pointeur et touches en jours.
let lastState = null;
let lastSpan = 0;

function readStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
}

// --- Données ---------------------------------------------------------------------

// Par jour de la plage : `events` (trouvailles, ou poses en mode Évolution),
// `secondary` (archivages, Évolution seulement) et `level`, la valeur à la fin
// du jour (cumul des trouvailles, ou caches actives).
function seriesFor(state, span) {
    const evolution = isEvolutionPage();
    const index = evolution ? pkg.evolutionStatsIndex?.() : null;
    const revision = evolution ? `evo:${index?.revision ?? 'none'}` : `gc:${pkg.pointsByDateRevision ?? 0}`;
    const key = `${revision}|${state.start.getTime()}|${span}`;
    if (seriesMemo?.key === key) return seriesMemo.series;

    const events = new Float64Array(span);
    let secondary = null;
    let level;
    if (evolution) {
        secondary = new Float64Array(span);
        level = new Float64Array(span);
        const timeline = index?.timeline;
        const first = index?.dayOf?.(state.start);
        if (timeline && Number.isFinite(first)) {
            let placed = counterAt(timeline, first - 1, 'placed');
            let archived = counterAt(timeline, first - 1, 'archived');
            for (let k = 0; k < span; k++) {
                const nextPlaced = counterAt(timeline, first + k, 'placed');
                const nextArchived = counterAt(timeline, first + k, 'archived');
                events[k] = nextPlaced - placed;
                secondary[k] = nextArchived - archived;
                placed = nextPlaced;
                archived = nextArchived;
                level[k] = counterAt(timeline, first + k, 'active');
            }
        }
    } else {
        // Locationless masquées comprises : comptées comme le compteur de
        // caches, même sans point sur la carte.
        let base = 0;
        for (const byDate of [pkg.pointsByDate, pkg.hiddenPointsByDate]) {
            if (!byDate) continue;
            for (const [dateKey, list] of byDate.entries()) {
                const n = list?.length || 0;
                if (!n) continue;
                const offset = dayOffsetOf(new Date(dateKey), state.start);
                if (offset < 0) base += n;
                else if (offset < span) events[offset] += n;
            }
        }
        level = cumulative(events, base);
    }
    const series = { events, secondary, level };
    seriesMemo = { key, series };
    return series;
}

// --- Dessin ----------------------------------------------------------------------

export function refreshTimelineBar() {
    if (!bar || !visible || frame) return;
    frame = requestAnimationFrame(draw);
}

function cssColor(styles, name, fallback) {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
}

function draw() {
    // Appelé aussi directement (pointerdown, touche) : un dessin déjà
    // planifié par refreshTimelineBar redessinerait une seconde fois.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!bar || !visible) return;
    const state = pkg.getTimelineState?.() || null;
    const span = state ? spanDays(state.start, state.end) : 0;
    const usable = !!state && span > 0;
    lastState = usable ? state : null;
    lastSpan = usable ? span : 0;
    // Pendant un glissement, le curseur suit le pointeur sans attendre le saut.
    const offset = usable
        ? clampOffset(pendingOffset ?? dayOffsetOf(state.position, state.start), span)
        : 0;

    syncLabels(state, span, offset, usable);

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!usable) return;
    ctx.scale(ratio, ratio);
    const w = rect.width;
    const h = rect.height;

    const styles = getComputedStyle(bar);
    const colors = {
        played: cssColor(styles, '--timeline-played', '#0072c6'),
        rest: cssColor(styles, '--timeline-rest', 'rgba(108, 117, 125, 0.35)'),
        cursor: cssColor(styles, '--timeline-cursor', '#1d273b'),
        tick: cssColor(styles, '--timeline-tick', 'rgba(108, 117, 125, 0.3)'),
    };

    ctx.fillStyle = colors.tick;
    for (const yearOffset of yearStartOffsets(state.start, span)) {
        const x = Math.round(yearOffset / span * w) + 0.5;
        ctx.fillRect(x - 0.5, 0, 1, h);
    }

    const series = seriesFor(state, span);
    const cursorX = cursorFraction(offset, span) * w;
    // La série entière en teinte « à venir », puis la partie jouée par-dessus,
    // découpée au curseur : une tranche à cheval est coupée à la bonne date.
    drawSeries(ctx, series, span, w, h, colors.rest);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cursorX, h);
    ctx.clip();
    drawSeries(ctx, series, span, w, h, colors.played);
    ctx.restore();

    ctx.fillStyle = colors.cursor;
    ctx.fillRect(Math.round(cursorX) - 1, 0, 2, h);
    if (style === 'simple') {
        // Poignée gardée entière aux deux bouts de la piste.
        const radius = 6;
        ctx.beginPath();
        ctx.arc(Math.min(w - radius, Math.max(radius, cursorX)), h / 2, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawSeries(ctx, series, span, w, h, color) {
    const pad = 3;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (style === 'simple') {
        const trackH = 6;
        roundRect(ctx, 0, (h - trackH) / 2, w, trackH, trackH / 2);
        ctx.fill();
        return;
    }
    if (style === 'histogram') {
        const bucketDays = bucketDaysFor(span, w);
        const main = bucketize(series.events, bucketDays);
        const extra = series.secondary ? bucketize(series.secondary, bucketDays) : null;
        let max = 0;
        for (let b = 0; b < main.length; b++) max = Math.max(max, main[b] + (extra ? extra[b] : 0));
        if (!(max > 0)) return;
        const usableH = h - pad;
        for (let b = 0; b < main.length; b++) {
            const total = main[b] + (extra ? extra[b] : 0);
            if (!(total > 0)) continue;
            const x0 = b * bucketDays / span * w;
            const x1 = Math.min(span, (b + 1) * bucketDays) / span * w;
            const barW = Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0));
            // Au moins 2 px : une tranche à une seule trouvaille reste visible.
            const mainH = main[b] > 0 ? Math.max(2, main[b] / max * usableH) : 0;
            ctx.globalAlpha = 1;
            ctx.fillRect(x0, h - mainH, barW, mainH);
            if (extra && extra[b] > 0) {
                // Évolution : les archivages empilés, en teinte atténuée.
                const extraH = Math.max(2, extra[b] / max * usableH);
                ctx.globalAlpha = 0.45;
                ctx.fillRect(x0, h - mainH - extraH, barW, extraH);
            }
        }
        ctx.globalAlpha = 1;
        return;
    }
    // Courbe : valeur à la fin de chaque jour, sur l'écart min..max de la
    // plage (un long passé avant la date de début écraserait la progression).
    const { min, max } = seriesExtent(series.level);
    const range = max - min || 1;
    const yOf = (v) => h - pad - (v - min) / range * (h - 2 * pad);
    const step = Math.max(1, Math.floor(span / Math.max(1, w)));
    ctx.beginPath();
    ctx.moveTo(0, yOf(series.level[0] ?? min));
    for (let k = 0; k < span; k += step) ctx.lineTo((k + 1) / span * w, yOf(series.level[k]));
    ctx.lineTo(w, yOf(series.level[span - 1]));
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.rect(x, y, w, h);
    }
}

function formatCount(n) {
    try { return Math.round(n).toLocaleString(document.documentElement.lang || undefined); }
    catch (_) { return String(Math.round(n)); }
}

function syncLabels(state, span, offset, usable) {
    const startLabel = document.getElementById('timelineBarStart');
    const endLabel = document.getElementById('timelineBarEnd');
    const dateLabel = document.getElementById('timelineBarDate');
    const recording = !!state?.recording;
    bar.classList.toggle('is-disabled', !usable || recording);
    track.setAttribute('aria-disabled', String(!usable || recording));
    if (!usable) {
        if (startLabel) startLabel.textContent = '';
        if (endLabel) endLabel.textContent = '';
        if (dateLabel) dateLabel.textContent = '';
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '0');
        track.setAttribute('aria-valuenow', '0');
        track.setAttribute('aria-valuetext', pkg.t('Aucune donnée à parcourir'));
        return;
    }
    const format = (date) => pkg.formatDateDisplay?.(date) ?? date.toLocaleDateString();
    if (startLabel) startLabel.textContent = format(state.start);
    if (endLabel) endLabel.textContent = format(state.end);
    const date = dateOfOffset(state.start, offset);
    const series = seriesFor(state, span);
    const count = formatCount(series.level[offset] ?? 0);
    const countText = isEvolutionPage()
        ? pkg.t('${count} actives', { count })
        : pkg.t('${count} caches', { count });
    const text = `${format(date)} · ${countText}`;
    if (dateLabel && dateLabel.textContent !== text) dateLabel.textContent = text;
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(span - 1));
    track.setAttribute('aria-valuenow', String(offset));
    track.setAttribute('aria-valuetext', text);
}

// --- Saut ------------------------------------------------------------------------

// Début d'un geste : l'aperçu doit être en pause pour accepter un saut.
// Renvoie null si le saut est impossible (enregistrement, pas de données).
function beginGesture() {
    if (gesture) return gesture;
    const playback = pkg.previewPlaybackState?.();
    if (!lastState || playback === 'recording' || lastState.recording) return null;
    let resume = false;
    if (playback === 'idle') {
        if (!pkg.startPausedPreview?.()) return null;
    } else if (playback === 'playing') {
        pkg.setPreviewPaused?.(true);
        resume = true;
    }
    gesture = { resume, pointerId: null };
    return gesture;
}

function endGesture() {
    if (!gesture) return;
    flushSeek();
    const { resume } = gesture;
    gesture = null;
    clearTimeout(keySettleTimer);
    keySettleTimer = null;
    // Musique recalée en pause, puis reprise : elle repart avec l'animation.
    pkg.resyncPreviewMusic?.();
    if (resume) pkg.setPreviewPaused?.(false);
    refreshTimelineBar();
}

// Un saut par frame au plus : glisser vite ne reconstruit pas la carte à
// chaque événement de pointeur.
function requestSeek(offset) {
    pendingOffset = offset;
    refreshTimelineBar();
    if (!seekFrame) seekFrame = requestAnimationFrame(flushSeek);
}

function flushSeek() {
    if (seekFrame) cancelAnimationFrame(seekFrame);
    seekFrame = 0;
    if (pendingOffset === null) return;
    const offset = pendingOffset;
    pendingOffset = null;
    const state = pkg.getTimelineState?.();
    if (!state) return;
    pkg.seekAnimationToDate?.(dateOfOffset(state.start, offset));
}

function offsetFromPointer(event) {
    const rect = track.getBoundingClientRect();
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    // Plage relue à chaque événement : elle peut changer en cours de geste
    // (refreshTimingPlan), alors que lastSpan date du dernier dessin.
    const state = pkg.getTimelineState?.();
    const span = state ? spanDays(state.start, state.end) : lastSpan;
    return offsetAtFraction(Math.min(1, Math.max(0, fraction)), span);
}

function currentOffset() {
    if (pendingOffset !== null) return pendingOffset;
    const state = pkg.getTimelineState?.();
    return state ? dayOffsetOf(state.position, state.start) : 0;
}

function onPointerDown(event) {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    // Un deuxième pointeur en plein glissement ne doit pas détourner le drag.
    if (gesture && gesture.pointerId !== null) return;
    draw(); // état frais : plage et données ont pu changer depuis le dernier dessin
    if (!lastState) return;
    const offset = offsetFromPointer(event);
    if (!beginGesture()) return;
    // Le pointeur succède à une série de frappes éventuelle (geste clavier,
    // pointerId null) : son minuteur de fin ne doit plus terminer le geste
    // — `gesture.pointerId` ci-dessous conserve le `resume` d'origine.
    clearTimeout(keySettleTimer);
    keySettleTimer = null;
    gesture.pointerId = event.pointerId;
    try { track.setPointerCapture(event.pointerId); } catch (_) {}
    track.focus({ preventScroll: true });
    bar.classList.add('is-dragging');
    requestSeek(offset);
    event.preventDefault();
}

function onPointerMove(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    requestSeek(offsetFromPointer(event));
}

function onPointerUp(event) {
    // Avant le garde-fou : la classe doit être retirée même quand le geste
    // a déjà été terminé par ailleurs (minuteur clavier, blur) et que ce
    // relâchement arrive en retard.
    bar.classList.remove('is-dragging');
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // Le geste se termine d'abord : le releasePointerCapture ci-dessous
    // réémet lostpointercapture, qui réentre dans ce gestionnaire — geste
    // déjà null, il sort au garde-fou.
    endGesture();
    try { track.releasePointerCapture(event.pointerId); } catch (_) {}
}

function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    draw();
    if (!lastState) return;
    const target = offsetForKey(event.key, { shift: event.shiftKey }, currentOffset(), lastState.start, lastSpan);
    if (target === null) return;
    event.preventDefault();
    if (!beginGesture()) return;
    requestSeek(target);
    // Une frappe pendant un glissement déplace le curseur mais ne doit pas
    // faire terminer le geste du pointeur 350 ms plus tard (la lecture
    // repartirait en plein drag, sans jamais retirer is-dragging).
    if (gesture.pointerId === null) {
        // Touche maintenue : l'aperçu reste en pause tant que les frappes
        // s'enchaînent, et ne repart qu'à leur fin.
        clearTimeout(keySettleTimer);
        keySettleTimer = setTimeout(endGesture, KEY_SETTLE_MS);
    }
}

// --- Affichage et style ----------------------------------------------------------

function setVisible(next, { persist = true } = {}) {
    visible = !!next;
    if (bar) bar.hidden = !visible;
    document.getElementById('mapTabsContainer')?.classList.toggle('has-timeline-bar', visible);
    if (toggleButton) {
        toggleButton.setAttribute('aria-pressed', String(visible));
        toggleButton.classList.toggle('active', visible);
    }
    if (persist) writeStorage(VISIBLE_KEY, visible ? '1' : '0');
    if (!visible && gesture) endGesture();
    // La carte change de taille (bandeau : le séparateur rebride sa hauteur
    // en tenant compte de la barre ; latéral : la colonne se partage).
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    refreshTimelineBar();
}

function setStyle(next, { persist = true } = {}) {
    style = normalizeTimelineStyle(next);
    bar?.querySelectorAll('[data-timeline-style]').forEach((button) => {
        const active = button.dataset.timelineStyle === style;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('active', active);
    });
    if (persist) writeStorage(STYLE_KEY, style);
    refreshTimelineBar();
}

export function isTimelineBarVisible() {
    return visible;
}

// Tests : ce que la barre affiche, sans lire le canvas.
export function getTimelineBarSnapshot() {
    const state = pkg.getTimelineState?.() || null;
    return {
        visible,
        style,
        state,
        valueNow: Number(track?.getAttribute('aria-valuenow')),
        valueMax: Number(track?.getAttribute('aria-valuemax')),
        valueText: track?.getAttribute('aria-valuetext') || '',
        dragging: !!gesture,
    };
}

function initTimelineBar() {
    bar = document.getElementById('timelineBar');
    track = document.getElementById('timelineBarTrack');
    canvas = document.getElementById('timelineBarCanvas');
    toggleButton = document.getElementById('btnTimelineBar');
    if (!bar || !track || !canvas) return;

    track.addEventListener('pointerdown', onPointerDown);
    track.addEventListener('pointermove', onPointerMove);
    track.addEventListener('pointerup', onPointerUp);
    track.addEventListener('pointercancel', onPointerUp);
    // Filet de sécurité : un pointerup peut se perdre (alt-tab pendant le
    // glissement). L'événement porte pointerId, le garde-fou suffit.
    track.addEventListener('lostpointercapture', onPointerUp);
    track.addEventListener('keydown', onKeyDown);
    track.addEventListener('blur', () => { if (gesture && gesture.pointerId === null) endGesture(); });

    bar.querySelectorAll('[data-timeline-style]').forEach((button) => {
        button.addEventListener('click', () => setStyle(button.dataset.timelineStyle));
    });
    toggleButton?.addEventListener('click', () => setVisible(!visible));

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
            bar.classList.toggle('is-narrow', bar.clientWidth > 0 && bar.clientWidth < NARROW_PX);
            refreshTimelineBar();
        }).observe(bar);
    }
    document.addEventListener('theme:applied', refreshTimelineBar);

    setStyle(readStorage(STYLE_KEY), { persist: false });
    setVisible(readStorage(VISIBLE_KEY) === '1', { persist: false });
}

// Module listé après ui.js dans index.js : il s'initialise lui-même, une fois
// le DOM prêt (cf. « Ordre d'évaluation des modules », AGENTS.md).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimelineBar);
} else {
    initTimelineBar();
}
