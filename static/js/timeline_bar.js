// Barre de chronologie : sous la carte, hors de la zone capturée (jamais dans
// la vidéo). Elle montre la plage de l'animation — trait simple, histogramme
// des trouvailles ou courbe de progression — et un curseur sur le dernier jour
// affiché. Glisser le curseur (souris, doigt) ou le déplacer au clavier amène
// la carte et les panneaux Stats à cette date :
//   - au repos (ou après la fin), l'aperçu s'ouvre en pause à la date choisie ;
//   - en pause, il y reste ;
//   - pendant la lecture, il est mis en pause le temps du geste, puis repart
//     de la nouvelle date.
// Rien n'est enregistré dans les préférences : seuls l'affichage de la barre,
// son style et la surimpression plein écran sont retenus par ce navigateur
// (localStorage).
//
// En plein écran (classe fullscreen-mode posée sur <main> par ui.js), la
// barre devient une surimpression au bas de la carte — optionnelle : le
// bouton #btnTimelineBarFs du menu flottant bascule `fsOverlay`, mémorisé
// sous sa propre clé. Un MutationObserver sur la classe de <main> recalcule
// l'affichage à chaque entrée/sortie : ui.js n'a rien à appeler.
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
    yearLabelOffsets,
    yearStartOffsets,
} from './timeline_model.mjs';

const VISIBLE_KEY = 'timelineBarVisible';
const STYLE_KEY = 'timelineBarStyle';
// Surimpression plein écran : '1' affichée (défaut), '0' masquée.
const FS_KEY = 'timelineBarFullscreen';
// Fin d'une série de frappes : la musique est recalée et la lecture reprend.
const KEY_SETTLE_MS = 350;
// Molette : ~100 px cumulés par jour. Un cran classique fait 100-120 px ;
// en deltaMode 1 (lignes), une ligne vaut ~40 px — un cran ≈ 3 lignes.
const WHEEL_STEP_PX = 100;
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
// Bouton du menu flottant (#controlBar, plein écran seulement).
let fsButton = null;
// Surimpression plein écran — indépendante de `visible`, qui garde son
// rôle hors plein écran (bandeau sous la carte).
let fsOverlay = readStorage(FS_KEY) !== '0';
let style = 'histogram';
let seriesMemo = null;
// Calques hors écran : tout ce qui est fixe pendant la lecture (repères,
// série en deux teintes) n'y est redessiné qu'à changement de leur clé —
// par frame, draw() ne fait plus que deux drawImage et les mobiles
// (étiquettes, curseur, poignée, fantôme).
let layerRest = null;
let layerPlayed = null;
let layersKey = '';
// Couleurs des --timeline-* lues une fois : getComputedStyle par frame
// coûtait un style recalculé à chaque lot affiché. `colorsVersion` entre
// dans la clé des calques : une invalidation force leur reconstruction.
let colorsCache = null;
let colorsVersion = 0;
// Taille de la piste, tenue par le ResizeObserver — un
// getBoundingClientRect par frame forcerait un calcul de layout.
let trackSize = null;
// Geste en cours (pointeur ou série de frappes) : { resume, pointerId }.
let gesture = null;
let pendingOffset = null;
let seekFrame = 0;
let keySettleTimer = null;
// Molette : somme des deltas depuis le dernier jour sauté — les pavés
// émettent par petits pas sous le seuil d'un cran.
let wheelAccum = 0;
// Dernier état dessiné, pour convertir pointeur et touches en jours.
let lastState = null;
let lastSpan = 0;
// Jour survolé hors geste (ligne fantôme, date dans l'étiquette) — la
// carte ne bouge pas tant qu'il n'y a pas clic.
let hoverOffset = null;
// Menu contextuel ouvert (clic droit : pose des bornes de l'animation).
let menu = null;

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
    // bar.hidden et non `visible` : en plein écran, la surimpression peut
    // être affichée alors que la préférence bandeau est fausse.
    if (!bar || bar.hidden || frame) return;
    frame = requestAnimationFrame(draw);
}

function cssColor(styles, name, fallback) {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
}

// Les --timeline-* ne changent qu'avec le thème ou le plein écran
// (surimpression sombre, cf. ui_improvements.css) : le style calculé est
// lu une fois puis seulement à chaque invalidation — jamais par frame.
function colorsFor() {
    if (!colorsCache) {
        const styles = getComputedStyle(bar);
        colorsCache = {
            played: cssColor(styles, '--timeline-played', '#0072c6'),
            rest: cssColor(styles, '--timeline-rest', 'rgba(108, 117, 125, 0.35)'),
            cursor: cssColor(styles, '--timeline-cursor', '#1d273b'),
            tick: cssColor(styles, '--timeline-tick', 'rgba(108, 117, 125, 0.3)'),
            label: cssColor(styles, '--timeline-label', 'rgba(108, 117, 125, 0.85)'),
        };
    }
    return colorsCache;
}

function invalidateColors() {
    colorsCache = null;
    colorsVersion++;
}

// Prochaine frame : calques à reconstruire quelle que soit leur clé.
function invalidateLayers() {
    layersKey = '';
}

// Les deux calques hors écran, reconstruits seulement quand la clé change
// (série — révision + plage —, taille, densité, style, version de
// couleurs). `layerRest` porte les repères d'année et la série « à venir »
// ; `layerPlayed` la même série en teinte « jouée » — sans repères : ils
// ne sont pas re-teintés dans la partie jouée. Les étiquettes d'année en
// sont volontairement absentes : dessinées par frame au-dessus des deux
// teintes, le calque « joué » les recouvrirait sinon.
function ensureLayers(state, span, series, w, h, ratio, colors) {
    const key = `${seriesMemo.key}|${w}x${h}@${ratio}|${style}|${colorsVersion}`;
    if (key === layersKey) return;
    if (!layerRest) {
        layerRest = document.createElement('canvas');
        layerPlayed = document.createElement('canvas');
    }
    const dw = Math.max(1, Math.round(w * ratio));
    const dh = Math.max(1, Math.round(h * ratio));
    layerRest.width = layerPlayed.width = dw;
    layerRest.height = layerPlayed.height = dh;
    const restCtx = layerRest.getContext('2d');
    restCtx.scale(ratio, ratio);
    restCtx.fillStyle = colors.tick;
    for (const yearOffset of yearStartOffsets(state.start, span)) {
        const x = Math.round(yearOffset / span * w) + 0.5;
        restCtx.fillRect(x - 0.5, 0, 1, h);
    }
    drawSeries(restCtx, series, span, w, h, colors.rest);
    const playedCtx = layerPlayed.getContext('2d');
    playedCtx.scale(ratio, ratio);
    drawSeries(playedCtx, series, span, w, h, colors.played);
    layersKey = key;
}

// setAttribute écrit le DOM même à valeur égale (mutation → invalidation)
// : on ne touche un attribut ARIA que s'il change réellement.
function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function draw() {
    // Appelé aussi directement (pointerdown, touche) : un dessin déjà
    // planifié par refreshTimelineBar redessinerait une seconde fois.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!bar || bar.hidden) return;
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

    // Taille tenue par le ResizeObserver ; mesure synchrone seulement tant
    // qu'il n'a pas tiré — ses notifications passent après le layout, une
    // frame plus tard qu'une lecture immédiate.
    if (!trackSize) trackSize = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(trackSize.width * ratio));
    const height = Math.max(1, Math.round(trackSize.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!usable) return;
    const w = trackSize.width;
    const h = trackSize.height;

    const colors = colorsFor();
    const series = seriesFor(state, span);
    // La partie fixe — repères, série « à venir » puis « jouée » — vient
    // des calques mémoïsés. Composite en pixels device (transform
    // identité) : la sous-image bridée au curseur s'arrête exactement à
    // cursorX, comme le clip rect(0,0,cursorX,h) d'avant — une tranche à
    // cheval est coupée à la bonne date.
    ensureLayers(state, span, series, w, h, ratio, colors);
    ctx.drawImage(layerRest, 0, 0);
    const cursorX = cursorFraction(offset, span) * w;
    ctx.drawImage(layerPlayed,
        0, 0, cursorX * ratio, h * ratio,
        0, 0, cursorX * ratio, h * ratio);
    ctx.scale(ratio, ratio);

    // Années par-dessus les barres, sous le curseur : seuls les repères
    // qui laissent la place au texte (glouton, cf. yearLabelOffsets), et
    // jamais au-delà du bord droit de la piste.
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colors.label;
    for (const yearOffset of yearLabelOffsets(yearStartOffsets(state.start, span), span, w)) {
        const x = Math.round(yearOffset / span * w) + 0.5;
        const label = String(dateOfOffset(state.start, yearOffset).getFullYear());
        if (x + 3 + ctx.measureText(label).width > w - 2) continue;
        ctx.fillText(label, x + 3, h - 1);
    }

    ctx.fillStyle = colors.cursor;
    ctx.fillRect(Math.round(cursorX) - 1, 0, 2, h);
    if (style === 'simple') {
        // Poignée gardée entière aux deux bouts de la piste.
        const radius = 6;
        ctx.beginPath();
        ctx.arc(Math.min(w - radius, Math.max(radius, cursorX)), h / 2, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Fantôme de survol : où un clic amènerait le curseur. Sautée au droit
    // du curseur réel — le survol n'y apprend rien et l'alpha y assombrit
    // juste le trait (pas de clignotement à l'approche non plus).
    if (hoverOffset !== null && hoverOffset !== offset && !gesture) {
        ctx.globalAlpha = 0.45;
        const x = Math.round(cursorFraction(hoverOffset, span) * w) + 0.5;
        ctx.fillRect(x - 0.5, 0, 1, h);
        ctx.globalAlpha = 1;
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
    const disabled = !usable || recording;
    // Attributs et classe écrits seulement sur changement : appelée à
    // chaque frame, la fonction ne doit pas invalider le DOM sans raison.
    if (bar.classList.contains('is-disabled') !== disabled) {
        bar.classList.toggle('is-disabled', disabled);
    }
    setAttr(track, 'aria-disabled', String(disabled));
    if (!usable) {
        if (startLabel?.textContent) startLabel.textContent = '';
        if (endLabel?.textContent) endLabel.textContent = '';
        if (dateLabel?.textContent) dateLabel.textContent = '';
        setAttr(track, 'aria-valuemin', '0');
        setAttr(track, 'aria-valuemax', '0');
        setAttr(track, 'aria-valuenow', '0');
        setAttr(track, 'aria-valuetext', pkg.t('Aucune donnée à parcourir'));
        return;
    }
    const format = (date) => pkg.formatDateDisplay?.(date) ?? date.toLocaleDateString();
    const startText = format(state.start);
    const endText = format(state.end);
    if (startLabel && startLabel.textContent !== startText) startLabel.textContent = startText;
    if (endLabel && endLabel.textContent !== endText) endLabel.textContent = endText;
    const series = seriesFor(state, span);
    const textAt = (dayOffset) => {
        // Singulier/pluriel choisi sur le compte numérique (formatCount rend
        // une chaîne localisée) — pas de ngettext côté JS, d'où deux msgids.
        const level = series.level[dayOffset] ?? 0;
        const count = formatCount(level);
        const countText = isEvolutionPage()
            ? (level > 1 ? pkg.t('${count} actives', { count }) : pkg.t('${count} active', { count }))
            : (level > 1 ? pkg.t('${count} caches', { count }) : pkg.t('${count} cache', { count }));
        return `${format(dateOfOffset(state.start, dayOffset))} · ${countText}`;
    };
    // Le survol affiche la date visée, mais les attributs ARIA restent sur
    // le curseur réel : le fantôme n'est pas la valeur du slider.
    const labelOffset = (hoverOffset !== null && !gesture) ? hoverOffset : offset;
    const text = textAt(labelOffset);
    if (dateLabel && dateLabel.textContent !== text) dateLabel.textContent = text;
    setAttr(track, 'aria-valuemin', '0');
    setAttr(track, 'aria-valuemax', String(span - 1));
    setAttr(track, 'aria-valuenow', String(offset));
    setAttr(track, 'aria-valuetext', labelOffset === offset ? text : textAt(offset));
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
    // La rafale de molette est finie : le prochain cran repart de zéro.
    wheelAccum = 0;
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
    // Le geste remplace le survol : le fantôme cède la place au curseur.
    hoverOffset = null;
    gesture.pointerId = event.pointerId;
    try { track.setPointerCapture(event.pointerId); } catch (_) {}
    track.focus({ preventScroll: true });
    bar.classList.add('is-dragging');
    requestSeek(offset);
    event.preventDefault();
}

function onPointerMove(event) {
    if (!gesture) {
        // Hors geste : simple survol. Le fantôme montre où un clic
        // amènerait le curseur — sans toucher la carte (lecteur vidéo).
        if (!lastState) draw(); // pas encore dessiné : plage inconnue
        if (!lastState || lastState.recording) return;
        const offset = offsetFromPointer(event);
        if (offset !== hoverOffset) {
            hoverOffset = offset;
            refreshTimelineBar();
        }
        return;
    }
    if (gesture.pointerId !== event.pointerId) return;
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

// Molette : un cran promène le curseur d'un jour (Maj : une semaine), comme
// les flèches du clavier — la position visée est celle du curseur, pas du
// survol.
function onWheel(event) {
    // Ctrl/Cmd + molette = zoom pincement du navigateur, pas du scrub.
    if (event.ctrlKey || event.metaKey) return;
    // Un glissement pointeur en cours possède le curseur (même garde que
    // le clavier).
    if (gesture && gesture.pointerId !== null) return;
    draw(); // état frais : plage et données ont pu changer depuis le dernier dessin
    // Barre inutilisable : la page reste libre de défiler (pas de
    // preventDefault).
    if (!lastState || lastState.recording) return;
    event.preventDefault(); // la page ne doit pas scroller pendant le scrub

    // deltaX quand la molette/le pavé roule surtout horizontalement (Maj
    // compris : le navigateur traduit alors le cran vertical en deltaX).
    let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (event.deltaMode === 1) delta *= 40; // DOM_DELTA_LINE → pixels
    // Changement de sens : repartir dans l'autre direction n'hérite pas du
    // reste accumulé.
    if (Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0;
    wheelAccum += delta;
    const steps = Math.trunc(wheelAccum / WHEEL_STEP_PX);
    if (!steps) return; // accumulation insuffisante pour un jour
    wheelAccum -= steps * WHEEL_STEP_PX;
    // Cible calculée AVANT beginGesture, comme onKeyDown : depuis le repos,
    // startPausedPreview lance l'aperçu au début de la plage — lire
    // currentOffset() après donnerait 0 au lieu du curseur au repos.
    // Plage relue à chaque cran, comme offsetFromPointer : elle peut
    // changer en cours de geste (refreshTimingPlan), lastSpan date du
    // dernier dessin.
    const state = pkg.getTimelineState?.();
    const span = state ? spanDays(state.start, state.end) : lastSpan;
    const target = clampOffset(currentOffset() + steps * (event.shiftKey ? 7 : 1), span);
    // Au repos, beginGesture ouvre l'aperçu en pause : la molette promène
    // le curseur jour par jour.
    if (!beginGesture()) return;
    requestSeek(target);
    // Comme les frappes : la rafale chaîne les sauts (un par frame via
    // requestSeek) puis termine — musique recalée, reprise éventuelle.
    if (gesture.pointerId === null) {
        clearTimeout(keySettleTimer);
        keySettleTimer = setTimeout(endGesture, KEY_SETTLE_MS);
    }
}

// --- Menu contextuel --------------------------------------------------------------
//
// Clic droit sur la piste : pose les bornes de l'animation comme les boutons
// « Sélection » de l'onglet Animation (setAnimationDates, ui.js). Le menu
// natif n'a rien d'utile sur une piste : preventDefault est systématique.

function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', onMenuOutsidePointerDown, true);
}

function onMenuOutsidePointerDown(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
}

// Flèches entre les items (en sautant les désactivés), Échap rend le focus
// à la piste — pattern menu ARIA minimal.
function onMenuKeyDown(event) {
    if (event.key === 'Escape') {
        closeMenu();
        track.focus({ preventScroll: true });
        event.preventDefault();
        return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    items[(index + delta + items.length) % items.length].focus();
    event.preventDefault();
}

function onContextMenu(event) {
    event.preventDefault();
    // Comme onPointerDown : plage et données ont pu changer depuis le dernier
    // dessin — le libellé des items affiche la date du jour visé.
    draw();
    const state = lastState;
    if (!state || state.recording) return;
    const day = dateOfOffset(state.start, offsetFromPointer(event));
    const date = pkg.formatDateDisplay?.(day) ?? day.toLocaleDateString();

    closeMenu(); // une nouvelle ouverture remplace l'ancien menu
    menu = document.createElement('div');
    menu.className = 'timeline-bar-menu';
    menu.setAttribute('role', 'menu');
    menu.addEventListener('keydown', onMenuKeyDown);

    const addItem = (label, onPick, disabled = false) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'timeline-bar-menu-item';
        item.setAttribute('role', 'menuitem');
        item.disabled = disabled;
        item.textContent = label;
        item.addEventListener('click', () => { if (!item.disabled) onPick(); closeMenu(); });
        menu.appendChild(item);
    };
    const addSeparator = () => {
        const separator = document.createElement('div');
        separator.className = 'timeline-bar-menu-separator';
        menu.appendChild(separator);
    };

    addItem(pkg.t('Début de l\'animation ici (${date})', { date }),
        () => pkg.setAnimationDates({ start: day }));
    addItem(pkg.t('Fin de l\'animation ici (${date})', { date }),
        () => pkg.setAnimationDates({ end: day }));
    addSeparator();
    // « Plage complète » = bornes aux valeurs par défaut des données. Sans
    // effet — désactivé — quand la plage affichée y est déjà. L'étendue vient
    // de getSelectionDateExtent : metadata.startDate/endDate sont réécrits
    // avec la plage choisie à chaque démarrage d'animation (mapgl.js).
    const extent = pkg.getSelectionDateExtent?.() || {};
    const atFullRange = extent.start instanceof Date && extent.end instanceof Date
        ? dayOffsetOf(state.start, extent.start) === 0 && dayOffsetOf(state.end, extent.end) === 0
        : true;
    addItem(pkg.t('Plage complète'),
        () => pkg.setAnimationDates({ start: null, end: null }), atFullRange);

    // Position fixe aux coordonnées du clic, bridée dans le viewport (taille
    // mesurée après insertion : elle dépend des libellés).
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) {
        menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
    }
    if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
    }

    document.addEventListener('pointerdown', onMenuOutsidePointerDown, true);
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

// --- Affichage et style ----------------------------------------------------------

// Le plein écran est la classe `fullscreen-mode` posée sur <main> par ui.js
// (toggleFullscreenMode) — pas l'API Fullscreen du navigateur.
function inFullscreen() {
    return document.querySelector('main')?.classList.contains('fullscreen-mode') === true;
}

// Visibilité réelle de la barre selon le contexte : bandeau piloté par
// `visible` hors plein écran, surimpression pilotée par `fsOverlay` en
// plein écran — `visible` garde son rôle pour le retour au mode normal.
// Le rangement (fantôme, molette, menu, geste) suit le masquage effectif :
// en plein écran la barre peut rester affichée alors que `visible` est
// faux, et réciproquement.
function applyVisibility() {
    if (!bar) return;
    bar.hidden = inFullscreen() ? !fsOverlay : !visible;
    // Toute transition (masquage, bandeau ↔ surimpression plein écran)
    // peut changer la taille : forcer une mesure au prochain dessin —
    // le RO mettra à jour ensuite.
    trackSize = null;
    if (!bar.hidden) return;
    hoverOffset = null;
    wheelAccum = 0; // une rafale de molette ne survit pas au masquage
    closeMenu(); // la piste masquée n'a plus de menu à afficher
    if (gesture) endGesture();
}

function setVisible(next, { persist = true } = {}) {
    visible = !!next;
    applyVisibility();
    document.getElementById('mapTabsContainer')?.classList.toggle('has-timeline-bar', visible);
    if (toggleButton) {
        toggleButton.setAttribute('aria-pressed', String(visible));
        toggleButton.classList.toggle('active', visible);
    }
    if (persist) writeStorage(VISIBLE_KEY, visible ? '1' : '0');
    // La carte change de taille (bandeau : le séparateur rebride sa hauteur
    // en tenant compte de la barre ; latéral : la colonne se partage). En
    // plein écran la surimpression ne change rien — mais l'événement est
    // aussi inoffensif (la carte y est déjà recalculée par ui.js).
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    refreshTimelineBar();
}

// Surimpression plein écran : le bouton du menu flottant reflète le choix
// (aria-pressed + .active, comme les préréglages de la barre d'outils).
function setFsOverlay(next, { persist = true } = {}) {
    fsOverlay = !!next;
    if (fsButton) {
        fsButton.setAttribute('aria-pressed', String(fsOverlay));
        fsButton.classList.toggle('active', fsOverlay);
    }
    if (persist) writeStorage(FS_KEY, fsOverlay ? '1' : '0');
    applyVisibility();
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
    invalidateLayers(); // le dessin de la série dépend du style (clé des calques)
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
        fsOverlay,
        style,
        state,
        valueNow: Number(track?.getAttribute('aria-valuenow')),
        valueMax: Number(track?.getAttribute('aria-valuemax')),
        valueText: track?.getAttribute('aria-valuetext') || '',
        dragging: !!gesture,
        hover: hoverOffset,
    };
}

function initTimelineBar() {
    bar = document.getElementById('timelineBar');
    track = document.getElementById('timelineBarTrack');
    canvas = document.getElementById('timelineBarCanvas');
    toggleButton = document.getElementById('btnTimelineBar');
    fsButton = document.getElementById('btnTimelineBarFs');
    if (!bar || !track || !canvas) return;

    track.addEventListener('pointerdown', onPointerDown);
    track.addEventListener('pointermove', onPointerMove);
    track.addEventListener('pointerup', onPointerUp);
    track.addEventListener('pointercancel', onPointerUp);
    // Filet de sécurité : un pointerup peut se perdre (alt-tab pendant le
    // glissement). L'événement porte pointerId, le garde-fou suffit.
    track.addEventListener('lostpointercapture', onPointerUp);
    // Pointeur parti (ou capture relâchée en fin de geste) : plus de
    // fantôme — le dessin suivant ne le cherche que hors geste.
    track.addEventListener('pointerleave', () => {
        hoverOffset = null;
        refreshTimelineBar();
    });
    track.addEventListener('keydown', onKeyDown);
    // passive: false — sans quoi preventDefault est ignoré et la page
    // défile pendant le scrub.
    track.addEventListener('wheel', onWheel, { passive: false });
    // Clic droit : pose des bornes de l'animation (menu dédié). Aucun geste
    // ne démarre — onPointerDown ignore déjà les boutons ≠ principal.
    track.addEventListener('contextmenu', onContextMenu);
    track.addEventListener('blur', () => { if (gesture && gesture.pointerId === null) endGesture(); });

    bar.querySelectorAll('[data-timeline-style]').forEach((button) => {
        button.addEventListener('click', () => setStyle(button.dataset.timelineStyle));
    });
    toggleButton?.addEventListener('click', () => setVisible(!visible));
    fsButton?.addEventListener('click', () => setFsOverlay(!fsOverlay));

    // Entrée/sortie du plein écran : ui.js bascule la classe sur <main>.
    // À chaque changement, la barre repasse de bandeau à surimpression (ou
    // l'inverse) — le module s'observe lui-même, ui.js n'a rien à appeler.
    const mainElement = document.querySelector('main');
    if (mainElement && typeof MutationObserver === 'function') {
        new MutationObserver(() => {
            // Les --timeline-* diffèrent en plein écran (surimpression
            // sombre) : couleurs — et donc calques — à relire. applyVisibility
            // remet trackSize à null (bandeau ↔ surimpression change la taille).
            invalidateColors();
            applyVisibility();
            refreshTimelineBar();
        }).observe(mainElement, { attributes: true, attributeFilter: ['class'] });
    }

    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
            bar.classList.toggle('is-narrow', bar.clientWidth > 0 && bar.clientWidth < NARROW_PX);
            // La taille utile est celle de la piste (le canvas la remplit à
            // 100 %) : relevée une fois par redimensionnement au lieu d'un
            // getBoundingClientRect par frame. Les calques, dimensionnés
            // dessus, sont à reconstruire.
            trackSize = canvas.getBoundingClientRect();
            invalidateLayers();
            refreshTimelineBar();
        });
        observer.observe(bar);
        observer.observe(track);
    }
    // Nouveau thème → nouvelles --timeline-* : couleurs et calques à relire.
    document.addEventListener('theme:applied', () => {
        invalidateColors();
        refreshTimelineBar();
    });
    // data-bs-theme peut aussi bouger sans theme:applied
    // (syncThemeFromSettings au démarrage, mode « system » suivant l'OS) :
    // observer l'attribut couvre tous les chemins d'écriture.
    if (typeof MutationObserver === 'function') {
        new MutationObserver(() => {
            invalidateColors();
            refreshTimelineBar();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
    }

    setStyle(readStorage(STYLE_KEY), { persist: false });
    setVisible(readStorage(VISIBLE_KEY) === '1', { persist: false });
    // fsOverlay est déjà lu à la déclaration : ne synchronise que le bouton.
    setFsOverlay(fsOverlay, { persist: false });
}

// Module listé après ui.js dans index.js : il s'initialise lui-même, une fois
// le DOM prêt (cf. « Ordre d'évaluation des modules », AGENTS.md).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimelineBar);
} else {
    initTimelineBar();
}
