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
// L'axe déborde la plage d'une marge grisée de chaque côté (timelineAxis) :
// les poignées en haut des bornes se tirent pour la raccourcir ou l'étendre,
// comme le clic droit (pose des bornes, setAnimationDates). Des repères
// marquent les trouvailles rondes, les jours de DNF et les étapes des caches
// posées affichées, et le planing des Images ; une bulle donne,
// au survol, la date, le nombre du jour (ou de la tranche), le total et
// l'instant de la vidéo.
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
import { counterAt, dateToDayNumber } from './evolution_timeline.mjs';
import { isEvolutionPage, isMainPage, isPosesPage } from './app_mode.mjs';
import { lifecycleEngine } from './lifecycle_engine.mjs';
import { ownerPointOptions } from './owner_model.mjs';
import {
    bucketDaysFor,
    bucketize,
    clampOffset,
    columnExtremes,
    cumulative,
    cursorFraction,
    dateOfOffset,
    dayOffsetOf,
    formatVideoTime,
    milestoneMarks,
    nextEventOffset,
    normalizeTimelineStyle,
    offsetAtFraction,
    offsetForKey,
    seriesExtent,
    spanDays,
    timelineAxis,
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
// Poignées des bornes : languettes en haut de la piste. Seule cette bande
// les saisit — plus bas, un clic près d'une borne reste un saut.
const HANDLE_TAB_W = 6;
const HANDLE_TAB_H = 11;
const HANDLE_ZONE_PX = 16;
const HANDLE_HIT_PX = 7;
// Repères : saisis par la bulle à ±4 px du jour survolé.
const MARK_HIT_PX = 4;

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
let milestonesMemo = null;
let cacheMarksMemo = null;
let sideMarksMemo = null;
// Calques hors écran : tout ce qui est fixe pendant la lecture (repères
// d'année, série en deux teintes) n'y est redessiné qu'à changement de leur
// clé — par frame, draw() ne fait plus que deux drawImage et les mobiles
// (voile hors plage, repères, poignées, étiquettes, curseur, fantôme).
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
// lastSpan : jours de la plage ; lastAxis : axe de la piste (timelineAxis).
let lastState = null;
let lastSpan = 0;
let lastAxis = null;
// Jour de l'AXE survolé hors geste (ligne fantôme, date dans l'étiquette et
// la bulle) — la carte ne bouge pas tant qu'il n'y a pas clic.
let hoverOffset = null;
// Poignée survolée ('start' | 'end' | null) : curseur de redimensionnement.
let hoverHandle = null;
// Poignée tirée : { which, pointerId, from, to } (jours de l'axe), bornes
// posées au relâchement seulement.
let rangeDrag = null;
// Menu contextuel ouvert (clic droit : pose des bornes de l'animation).
let menu = null;
// Bulle (survol, glissement) : sur <body>, en position fixe.
let tip = null;
let tipText = '';

function readStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
}

function formatDate(date) {
    return pkg.formatDateDisplay?.(date) ?? date.toLocaleDateString();
}

function formatCount(n) {
    try { return Math.round(n).toLocaleString(document.documentElement.lang || undefined); }
    catch (_) { return String(Math.round(n)); }
}

// --- Données ---------------------------------------------------------------------

// Axe de la piste pour l'état courant : la plage, plus les marges que
// l'étendue de la sélection permet (bornes de « Plage complète »).
function axisFor(state) {
    const defaults = pkg.getAnimationDateDefaults?.() || {};
    const extent = defaults.start instanceof Date && defaults.end instanceof Date
        ? defaults
        : (pkg.getSelectionDateExtent?.() || {});
    return timelineAxis(state.start, state.end, extent.start, extent.end);
}

// Par jour de l'axe : `events` (trouvailles, ou poses en mode Évolution),
// `secondary` (archivages, Évolution seulement), `level`, la valeur à la fin
// du jour (cumul des trouvailles, ou caches actives), et `base`, le cumul de
// la veille du premier jour (trouvailles marquantes).
function seriesFor(axis) {
    const evolution = isEvolutionPage();
    const poses = isPosesPage();
    const index = evolution ? pkg.evolutionStatsIndex?.() : null;
    const engine = poses ? lifecycleEngine() : null;
    const revision = evolution ? `evo:${index?.revision ?? 'none'}`
        : poses ? `poses:${engine?.statsIndex?.()?.revision ?? 'none'}`
        : `gc:${pkg.pointsByDateRevision ?? 0}`;
    const span = axis.span;
    const key = `${revision}|${axis.start.getTime()}|${span}`;
    if (seriesMemo?.key === key) return seriesMemo.series;
    // Mes poses : trouvailles reçues par jour, autres logs en second,
    // courbe du cumul des trouvailles reçues (moteur de la page).
    if (poses) {
        const series = engine?.timelineSeries?.(axis.start, span)
            || { events: new Float64Array(span), secondary: new Float64Array(span), level: new Float64Array(span), base: 0 };
        seriesMemo = { key, series };
        return series;
    }

    const events = new Float64Array(span);
    let secondary = null;
    let level;
    let base = 0;
    if (evolution) {
        secondary = new Float64Array(span);
        level = new Float64Array(span);
        const timeline = index?.timeline;
        const first = index?.dayOf?.(axis.start);
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
        for (const byDate of [pkg.pointsByDate, pkg.hiddenPointsByDate]) {
            if (!byDate) continue;
            for (const [dateKey, list] of byDate.entries()) {
                const n = list?.length || 0;
                if (!n) continue;
                const offset = dayOffsetOf(new Date(dateKey), axis.start);
                if (offset < 0) base += n;
                else if (offset < span) events[offset] += n;
            }
        }
        level = cumulative(events, base);
    }
    const series = { events, secondary, level, base };
    seriesMemo = { key, series };
    return series;
}

// Repères de l'axe, triés : trouvailles rondes (page principale et Mes
// poses), repères par cache (Mes poses : 'ftf', 'cacheRound'), jours de DNF
// et étapes des caches posées affichées (page principale) et
// apparitions/disparitions des images planifiées. { offset, kind, label }.
function marksFor(axis, series) {
    const marks = [];
    if (!isEvolutionPage()) {
        if (milestonesMemo?.key !== seriesMemo.key) {
            milestonesMemo = { key: seriesMemo.key, marks: milestoneMarks(series.level, series.base) };
        }
        for (const { offset, value } of milestonesMemo.marks) {
            marks.push({
                offset,
                kind: 'milestone',
                label: isPosesPage()
                    ? pkg.t('${count}ᵉ trouvaille reçue', { count: formatCount(value) })
                    : pkg.t('${count}ᵉ trouvaille', { count: formatCount(value) }),
            });
        }
        // Mes poses : repères par cache (première trouvaille, paliers ronds),
        // mémoïsés comme les jalons sur la clé de la série courante.
        if (isPosesPage()) {
            const engine = lifecycleEngine();
            if (cacheMarksMemo?.key !== seriesMemo.key) {
                cacheMarksMemo = {
                    key: seriesMemo.key,
                    marks: engine?.milestones?.(axis.start, axis.span) || [],
                };
            }
            for (const m of cacheMarksMemo.marks) {
                marks.push({
                    offset: m.offset,
                    kind: m.kind,
                    label: m.kind === 'ftf'
                        ? pkg.t('Première trouvaille : ${code}', { code: m.code })
                        : pkg.t('${count}ᵉ trouvaille : ${code}', { count: formatCount(m.value), code: m.code }),
                });
            }
        }
    }
    // Page principale : jours DNF et étapes des caches posées, quand la
    // famille est affichée (comme les lignes de la légende — getXxxEntries
    // est vide sinon). Mémoïsés sur la série et les révisions des deux
    // sources : une bascule de case ou un rechargement les recompute.
    if (isMainPage()) {
        const sideKey = `${seriesMemo.key}|${pkg.dnfRevision ?? 0}|${pkg.ownerRevision ?? 0}`;
        if (sideMarksMemo?.key !== sideKey) {
            sideMarksMemo = { key: sideKey, marks: sideEventMarks(axis) };
        }
        marks.push(...sideMarksMemo.marks);
    }
    const first = dateToDayNumber(axis.start);
    for (const mark of pkg.getImageScheduleMarks?.() || []) {
        const offset = mark.day - first;
        if (offset < 0 || offset >= axis.span) continue;
        marks.push({
            offset,
            kind: mark.kind === 'out' ? 'image-out' : 'image-in',
            label: mark.kind === 'out'
                ? pkg.t('Disparition : ${name}', { name: mark.name })
                : pkg.t('Apparition : ${name}', { name: mark.name }),
        });
    }
    marks.sort((a, b) => a.offset - b.offset);
    return marks;
}

// Libellé de bulle d'une étape du poseur (kinds d'event_flash.mjs ; la pose
// elle-même est marquée au jour d'apparition, kind 'owner-place').
function ownerStepLabel(kind, code) {
    switch (kind) {
        case 'archive': return pkg.t('Cache archivée : ${code}', { code });
        case 'unarchive': return pkg.t('Cache désarchivée : ${code}', { code });
        case 'disable': return pkg.t('Cache désactivée : ${code}', { code });
        case 'enable': return pkg.t('Cache réactivée : ${code}', { code });
        case 'maintenance': return pkg.t('Maintenance : ${code}', { code });
        default: return pkg.t('Étape du poseur : ${code}', { code });
    }
}

// Repères des familles hors trouvailles de la page principale : chaque jour
// de DNF (une tentative répétée rejoue son flash, elle garde son repère) et
// chaque étape des caches posées — pose, puis étapes du poseur. Les jours
// hors de l'axe ne donnent rien.
function sideEventMarks(axis) {
    const first = dateToDayNumber(axis.start);
    const marks = [];
    const push = (day, kind, label) => {
        const offset = day - first;
        if (offset >= 0 && offset < axis.span) marks.push({ offset, kind, label });
    };
    for (const entry of pkg.getDnfEntries?.() || []) {
        const code = entry.feature?.properties?.gc_code || '?';
        entry.visitDays.forEach((day, i) => {
            push(day, 'dnf', i === 0
                ? pkg.t('DNF : ${code}', { code })
                : pkg.t('DNF n°${count} : ${code}', { count: formatCount(i + 1), code }));
        });
    }
    for (const entry of pkg.getOwnerEntries?.() || []) {
        const code = entry.feature?.properties?.gc_code || '?';
        push(entry.appearDay, 'owner-place', pkg.t('Cache posée : ${code}', { code }));
        for (const event of entry.events) {
            push(event.day, 'owner-event', ownerStepLabel(event.kind, code));
        }
    }
    return marks;
}

// Plage affichée sur l'axe ({ from, to }, jours inclus) : celle qu'une
// poignée tirée propose, sinon celle de l'animation.
function displayedRange(axis) {
    if (rangeDrag) return { from: rangeDrag.from, to: rangeDrag.to };
    return { from: axis.rangeOffset, to: axis.rangeOffset + axis.rangeSpan - 1 };
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
            veil: cssColor(styles, '--timeline-veil', 'rgba(255, 255, 255, 0.6)'),
            handle: cssColor(styles, '--timeline-handle', '#1d273b'),
            milestone: cssColor(styles, '--timeline-milestone', '#2fb344'),
            ftf: cssColor(styles, '--timeline-ftf', '#009dff'),
            image: cssColor(styles, '--timeline-image', '#f59f00'),
            dnf: cssColor(styles, '--timeline-dnf', '#263238'),
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
// (série — révision + axe —, taille, densité, style, version de couleurs).
// `layerRest` porte les repères d'année et la série « à venir » ;
// `layerPlayed` la même série en teinte « jouée » — sans repères : ils ne
// sont pas re-teintés dans la partie jouée. Les étiquettes d'année en sont
// volontairement absentes : dessinées par frame au-dessus des deux teintes,
// le calque « joué » les recouvrirait sinon.
function ensureLayers(axis, series, w, h, ratio, colors) {
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
    for (const yearOffset of yearStartOffsets(axis.start, axis.span)) {
        const x = Math.round(yearOffset / axis.span * w) + 0.5;
        restCtx.fillRect(x - 0.5, 0, 1, h);
    }
    drawSeries(restCtx, series, axis.span, w, h, colors.rest);
    const playedCtx = layerPlayed.getContext('2d');
    playedCtx.scale(ratio, ratio);
    drawSeries(playedCtx, series, axis.span, w, h, colors.played);
    layersKey = key;
}

// setAttribute écrit le DOM même à valeur égale (mutation → invalidation)
// : on ne touche un attribut ARIA que s'il change réellement.
function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// Abscisse (px CSS) du bord droit du jour `axisOffset` — là où se pose le
// curseur une fois ce jour affiché.
function dayEndX(axisOffset, axis, w) {
    return cursorFraction(axisOffset, axis.span) * w;
}

function draw() {
    // Appelé aussi directement (pointerdown, touche) : un dessin déjà
    // planifié par refreshTimelineBar redessinerait une seconde fois.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!bar || bar.hidden) return;
    const state = pkg.getTimelineState?.() || null;
    const span = state ? spanDays(state.start, state.end) : 0;
    const axis = state && span > 0 ? axisFor(state) : null;
    const usable = !!axis;
    lastState = usable ? state : null;
    lastSpan = usable ? span : 0;
    lastAxis = axis;
    // Pendant un glissement, le curseur suit le pointeur sans attendre le saut.
    const offset = usable
        ? clampOffset(pendingOffset ?? dayOffsetOf(state.position, state.start), span)
        : 0;

    const series = usable ? seriesFor(axis) : null;
    syncLabels(state, axis, series, offset, usable);

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
    if (!usable) {
        syncTip(null, null, 0);
        return;
    }
    const w = trackSize.width;
    const h = trackSize.height;

    const colors = colorsFor();
    // La partie fixe — repères, série « à venir » puis « jouée » — vient
    // des calques mémoïsés. Composite en pixels device (transform
    // identité) : la sous-image bridée au curseur s'arrête exactement à
    // cursorX, comme le clip rect(0,0,cursorX,h) d'avant — une tranche à
    // cheval est coupée à la bonne date.
    ensureLayers(axis, series, w, h, ratio, colors);
    ctx.drawImage(layerRest, 0, 0);
    const cursorAxis = offset + axis.rangeOffset;
    const cursorX = dayEndX(cursorAxis, axis, w);
    ctx.drawImage(layerPlayed,
        0, 0, cursorX * ratio, h * ratio,
        0, 0, cursorX * ratio, h * ratio);
    ctx.scale(ratio, ratio);

    // Marges hors de la plage : voile de la couleur du fond.
    const range = displayedRange(axis);
    const x0 = range.from / axis.span * w;
    const x1 = (range.to + 1) / axis.span * w;
    ctx.fillStyle = colors.veil;
    if (x0 > 0) ctx.fillRect(0, 0, x0, h);
    if (x1 < w) ctx.fillRect(x1, 0, w - x1, h);

    // Années par-dessus les barres, sous le curseur : seuls les repères
    // qui laissent la place au texte (glouton, cf. yearLabelOffsets), et
    // jamais au-delà du bord droit de la piste.
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colors.label;
    for (const yearOffset of yearLabelOffsets(yearStartOffsets(axis.start, axis.span), axis.span, w)) {
        const x = Math.round(yearOffset / axis.span * w) + 0.5;
        const label = String(dateOfOffset(axis.start, yearOffset).getFullYear());
        if (x + 3 + ctx.measureText(label).width > w - 2) continue;
        ctx.fillText(label, x + 3, h - 1);
    }

    const marks = marksFor(axis, series);
    drawMarks(ctx, marks, axis, w, colors);
    if (!state.recording) drawHandles(ctx, x0, x1, h, colors);

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
    if (hoverOffset !== null && hoverOffset !== cursorAxis && !gesture && !rangeDrag) {
        ctx.globalAlpha = 0.45;
        const x = Math.round(dayEndX(hoverOffset, axis, w)) + 0.5;
        ctx.fillRect(x - 0.5, 0, 1, h);
        ctx.globalAlpha = 1;
    }

    syncTip(axis, series, w, { cursorAxis, marks });
}

// Repères en haut de la piste : losange vert pour une trouvaille ronde (creux
// pour un palier d'une cache, page Mes poses), rond bleu pour la première
// trouvaille d'une cache, rond foncé pour un jour de DNF, étoile pour une
// étape de poseur (pleine : la pose ; creuse : maintenance, désactivation,
// réactivation, archivage), triangle ambré pour une image (plein :
// apparition ; creux : disparition).
function drawMarks(ctx, marks, axis, w, colors) {
    // L'étoile suit la couleur de contour posée du thème, comme la pastille
    // de la légende — relue à chaque dessin : le réglage change sans
    // theme:applied (options, pas CSS).
    const ownerColor = ownerPointOptions(pkg.options?.point?.owner).borderColor;
    for (const mark of marks) {
        const x = dayEndX(mark.offset, axis, w);
        ctx.beginPath();
        if (mark.kind === 'ftf') {
            ctx.arc(x, 4.5, 2.75, 0, Math.PI * 2);
            ctx.fillStyle = colors.ftf;
            ctx.fill();
        } else if (mark.kind === 'dnf') {
            ctx.arc(x, 4.5, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = colors.dnf;
            ctx.fill();
        } else if (mark.kind === 'owner-place' || mark.kind === 'owner-event') {
            starPath(ctx, x, 4.5, 4);
            if (mark.kind === 'owner-place') {
                ctx.fillStyle = ownerColor;
                ctx.fill();
            } else {
                ctx.lineWidth = 1.25;
                ctx.strokeStyle = ownerColor;
                ctx.stroke();
            }
        } else if (mark.kind === 'milestone' || mark.kind === 'cacheRound') {
            ctx.moveTo(x, 1);
            ctx.lineTo(x + 3.5, 4.5);
            ctx.lineTo(x, 8);
            ctx.lineTo(x - 3.5, 4.5);
            ctx.closePath();
            if (mark.kind === 'cacheRound') {
                ctx.lineWidth = 1.25;
                ctx.strokeStyle = colors.milestone;
                ctx.stroke();
            } else {
                ctx.fillStyle = colors.milestone;
                ctx.fill();
            }
        } else {
            ctx.moveTo(x - 4, 1);
            ctx.lineTo(x + 4, 1);
            ctx.lineTo(x, 7);
            ctx.closePath();
            if (mark.kind === 'image-in') {
                ctx.fillStyle = colors.image;
                ctx.fill();
            } else {
                ctx.lineWidth = 1.25;
                ctx.strokeStyle = colors.image;
                ctx.stroke();
            }
        }
    }
}

// Étoile à 5 branches centrée en (cx, cy), rayon extérieur `r` — le symbole
// des caches posées (même lecture que la carte et la légende).
function starPath(ctx, cx, cy, r) {
    for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 === 0 ? r : r * 0.45;
        const px = cx + radius * Math.cos(angle);
        const py = cy + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

// Poignées des bornes : trait sur toute la hauteur, languette en haut,
// tournée vers l'intérieur de la plage.
function drawHandles(ctx, x0, x1, h, colors) {
    ctx.fillStyle = colors.handle;
    const left = Math.max(0, Math.min(x0, x1 - 1.5));
    const right = Math.max(left + 1.5, x1);
    ctx.globalAlpha = 0.55;
    ctx.fillRect(left, 0, 1.5, h);
    ctx.fillRect(right - 1.5, 0, 1.5, h);
    ctx.globalAlpha = 0.9;
    roundRect(ctx, left, 0, HANDLE_TAB_W, HANDLE_TAB_H, 2);
    ctx.fill();
    roundRect(ctx, right - HANDLE_TAB_W, 0, HANDLE_TAB_W, HANDLE_TAB_H, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
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
        // Échelle racine carrée : un jour exceptionnel (power trail,
        // méga-event) écrasait toutes les autres barres à 2 px en linéaire ;
        // la racine garde l'ordre et laisse les petits jours lisibles.
        const rootMax = Math.sqrt(max);
        const usableH = h - pad;
        for (let b = 0; b < main.length; b++) {
            const total = main[b] + (extra ? extra[b] : 0);
            if (!(total > 0)) continue;
            const x0 = b * bucketDays / span * w;
            const x1 = Math.min(span, (b + 1) * bucketDays) / span * w;
            const barW = Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0));
            // Hauteur de la pile sur l'échelle racine, partagée entre poses
            // et archivages au prorata. Au moins 2 px par part non nulle :
            // une tranche à une seule trouvaille reste visible.
            const totalH = Math.sqrt(total) / rootMax * usableH;
            const mainH = main[b] > 0 ? Math.max(2, totalH * main[b] / total) : 0;
            ctx.globalAlpha = 1;
            ctx.fillRect(x0, h - mainH, barW, mainH);
            if (extra && extra[b] > 0) {
                // Évolution : les archivages empilés, en teinte atténuée.
                const extraH = Math.max(2, totalH * extra[b] / total);
                ctx.globalAlpha = 0.45;
                ctx.fillRect(x0, h - mainH - extraH, barW, extraH);
            }
        }
        ctx.globalAlpha = 1;
        return;
    }
    // Courbe : valeur à la fin de chaque jour, sur l'écart min..max de l'axe
    // (un long passé avant la date de début écraserait la progression).
    const { min, max } = seriesExtent(series.level);
    const range = max - min || 1;
    const yOf = (v) => h - pad - (v - min) / range * (h - 2 * pad);
    const level = series.level;
    const columns = Math.max(1, Math.round(w));
    ctx.beginPath();
    ctx.moveTo(0, yOf(level[0] ?? min));
    if (span <= columns) {
        for (let k = 0; k < span; k++) ctx.lineTo((k + 1) / span * w, yOf(level[k]));
    } else {
        // Plus de jours que de pixels : chaque colonne trace le minimum et le
        // maximum de ses jours. Un échantillonnage (un jour sur N) sautait
        // les pics des caches actives en mode Évolution, qui montent et
        // descendent — la courbe en dépendait de la largeur de la piste.
        const { lo, hi, first, last } = columnExtremes(level, columns);
        for (let c = 0; c < columns; c++) {
            const x = (c + 1) / columns * w;
            const rising = last[c] >= first[c];
            ctx.lineTo(x, yOf(rising ? lo[c] : hi[c]));
            ctx.lineTo(x, yOf(rising ? hi[c] : lo[c]));
            ctx.lineTo(x, yOf(last[c]));
        }
    }
    ctx.lineTo(w, yOf(level[span - 1]));
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

// --- Textes ----------------------------------------------------------------------

// Valeur à la fin du jour : caches (cumul) ou actives (Évolution).
// Singulier/pluriel choisi sur le compte numérique (formatCount rend une
// chaîne localisée) — pas de ngettext côté JS, d'où deux msgids.
function levelText(level) {
    const count = formatCount(level);
    if (isEvolutionPage()) {
        return level > 1 ? pkg.t('${count} actives', { count }) : pkg.t('${count} active', { count });
    }
    if (isPosesPage()) {
        return level > 1
            ? pkg.t('${count} trouvailles reçues', { count })
            : pkg.t('${count} trouvaille reçue', { count });
    }
    return level > 1 ? pkg.t('${count} caches', { count }) : pkg.t('${count} cache', { count });
}

// Événements d'un jour ou d'une tranche : trouvailles, ou poses et
// archivages (Évolution).
function eventsText(main, extra) {
    if (isEvolutionPage()) {
        const placed = formatCount(main);
        const archived = formatCount(extra);
        const placedText = main > 1 ? pkg.t('${count} poses', { count: placed }) : pkg.t('${count} pose', { count: placed });
        const archivedText = extra > 1
            ? pkg.t('${count} archivages', { count: archived })
            : pkg.t('${count} archivage', { count: archived });
        return `${placedText}, ${archivedText}`;
    }
    if (isPosesPage()) {
        const finds = formatCount(main);
        const others = formatCount(extra);
        const findsText = main > 1 ? pkg.t('${count} trouvailles', { count: finds }) : pkg.t('${count} trouvaille', { count: finds });
        const othersText = extra > 1 ? pkg.t('${count} autres logs', { count: others }) : pkg.t('${count} autre log', { count: others });
        return `${findsText}, ${othersText}`;
    }
    if (!(main > 0)) return pkg.t('aucune trouvaille');
    const count = formatCount(main);
    return main > 1 ? pkg.t('${count} trouvailles', { count }) : pkg.t('${count} trouvaille', { count });
}

// Instant de la vidéo à la fin du jour `axisOffset`, ou '' hors de la plage
// (ces jours-là ne sont pas dans la vidéo). « ≈ » au repos quand le suivi de
// caméra ajoutera un pré-roll et des pauses (calculés au lancement).
function videoTimeText(axis, axisOffset) {
    const shown = axisOffset - axis.rangeOffset + 1;
    if (shown < 1 || shown > axis.rangeSpan) return '';
    const time = pkg.videoTimeAtDays?.(shown);
    if (!time || !Number.isFinite(time.ms)) return '';
    const text = formatVideoTime(time.ms);
    return time.exact ? text : `≈ ${text}`;
}

// Étiquette et ARIA : date, total à la fin du jour et instant de la vidéo.
function labelText(axis, series, axisOffset) {
    const parts = [formatDate(dateOfOffset(axis.start, axisOffset)), levelText(series.level[axisOffset] ?? 0)];
    const time = videoTimeText(axis, axisOffset);
    if (time) parts.push(time);
    return parts.join(' · ');
}

function syncLabels(state, axis, series, offset, usable) {
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
    // Les dates des bouts suivent l'axe (marges comprises) : elles nomment
    // les extrémités de la piste.
    const startText = formatDate(axis.start);
    const endText = formatDate(dateOfOffset(axis.start, axis.span - 1));
    if (startLabel && startLabel.textContent !== startText) startLabel.textContent = startText;
    if (endLabel && endLabel.textContent !== endText) endLabel.textContent = endText;
    // Le survol affiche la date visée, mais les attributs ARIA restent sur
    // le curseur réel : le fantôme n'est pas la valeur du slider.
    const cursorAxis = offset + axis.rangeOffset;
    const labelOffset = (hoverOffset !== null && !gesture && !rangeDrag) ? hoverOffset : cursorAxis;
    const text = labelText(axis, series, labelOffset);
    if (dateLabel && dateLabel.textContent !== text) dateLabel.textContent = text;
    setAttr(track, 'aria-valuemin', '0');
    setAttr(track, 'aria-valuemax', String(axis.rangeSpan - 1));
    setAttr(track, 'aria-valuenow', String(offset));
    setAttr(track, 'aria-valuetext', labelOffset === cursorAxis ? text : labelText(axis, series, cursorAxis));
}

// --- Bulle -----------------------------------------------------------------------

// Lignes de la bulle pour le jour `a` de l'axe : date (ou borne tirée),
// nombre du jour ou de la tranche de l'histogramme, total, instant de la
// vidéo, puis les repères posés à ce jour.
function tipLines(axis, series, a, w, { handle = null, marks = [] } = {}) {
    const lines = [];
    const date = formatDate(dateOfOffset(axis.start, a));
    const inRange = a >= axis.rangeOffset && a < axis.rangeOffset + axis.rangeSpan;
    if (handle === 'start') lines.push({ text: pkg.t('Début : ${date}', { date }), strong: true });
    else if (handle === 'end') lines.push({ text: pkg.t('Fin : ${date}', { date }), strong: true });
    else if (inRange) lines.push({ text: date, strong: true });
    else lines.push({ text: pkg.t('${date} — hors de l\'animation', { date }), strong: true });

    // Histogramme : la tranche sous le pointeur, alignée comme les barres
    // (bucketize part du premier jour de l'axe).
    const bucket = style === 'histogram' ? bucketDaysFor(axis.span, w) : 1;
    const from = Math.floor(a / bucket) * bucket;
    const to = Math.min(axis.span - 1, from + bucket - 1);
    let main = 0;
    let extra = 0;
    for (let k = from; k <= to; k++) {
        main += series.events[k] || 0;
        extra += series.secondary?.[k] || 0;
    }
    const text = eventsText(main, extra);
    lines.push({
        text: from === to
            ? pkg.t('Ce jour : ${text}', { text })
            : pkg.t('Du ${from} au ${to} : ${text}', {
                from: formatDate(dateOfOffset(axis.start, from)),
                to: formatDate(dateOfOffset(axis.start, to)),
                text,
            }),
    });
    lines.push({ text: pkg.t('Total : ${text}', { text: levelText(series.level[a] ?? 0) }) });
    const time = videoTimeText(axis, a);
    if (time) lines.push({ text: pkg.t('Vidéo : ${time}', { time }) });

    const x = dayEndX(a, axis, w);
    for (const mark of marks) {
        if (Math.abs(dayEndX(mark.offset, axis, w) - x) <= MARK_HIT_PX) {
            lines.push({ text: mark.label, mark: mark.kind });
        }
    }
    return lines;
}

function hideTip() {
    if (tip && !tip.hidden) tip.hidden = true;
}

// Bulle à jour pour le dessin courant : borne tirée, curseur glissé, ou jour
// survolé — rien sinon. DOM réécrit seulement quand le texte change.
function syncTip(axis, series, w, { cursorAxis = 0, marks = [] } = {}) {
    let target = null;
    if (axis && series) {
        if (rangeDrag) {
            target = { a: rangeDrag.which === 'start' ? rangeDrag.from : rangeDrag.to, handle: rangeDrag.which };
        } else if (gesture && gesture.pointerId !== null) {
            target = { a: cursorAxis, handle: null };
        } else if (hoverOffset !== null && !gesture) {
            target = { a: hoverOffset, handle: null };
        }
    }
    if (!target) {
        hideTip();
        return;
    }
    if (!tip) {
        tip = document.createElement('div');
        tip.className = 'timeline-bar-tip';
        // La valeur du slider (aria-valuetext) dit déjà l'essentiel ; la
        // bulle suit la souris, elle n'est pas lue.
        tip.setAttribute('aria-hidden', 'true');
        tip.hidden = true;
        document.body.appendChild(tip);
    }
    const lines = tipLines(axis, series, target.a, w, { handle: target.handle, marks });
    const text = lines.map((line) => `${line.mark || ''}|${line.text}`).join('\n');
    if (text !== tipText) {
        tipText = text;
        tip.replaceChildren(...lines.map((line) => {
            const row = document.createElement('div');
            row.className = 'timeline-bar-tip-line';
            if (line.strong) row.classList.add('is-strong');
            if (line.mark) row.dataset.mark = line.mark;
            row.textContent = line.text;
            return row;
        }));
    }
    if (tip.hidden) tip.hidden = false;
    // Au-dessus du jour visé, bridée dans le viewport ; dessous s'il n'y a
    // pas la place (barre collée en haut d'une petite fenêtre).
    const rect = track.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const x = rect.left + dayEndX(target.a, axis, w);
    const left = Math.max(4, Math.min(window.innerWidth - tipRect.width - 4, x - tipRect.width / 2));
    const above = rect.top - tipRect.height - 8;
    const top = above >= 4 ? above : rect.bottom + 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
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

// Axe relu à chaque événement : la plage peut changer en cours de geste
// (refreshTimingPlan), alors que lastAxis date du dernier dessin.
function currentAxis() {
    const state = pkg.getTimelineState?.();
    return (state && spanDays(state.start, state.end) > 0 ? axisFor(state) : null) || lastAxis;
}

// Jour de l'AXE sous le pointeur.
function axisOffsetFromPointer(event, axis = currentAxis()) {
    if (!axis) return 0;
    const rect = track.getBoundingClientRect();
    const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    return offsetAtFraction(Math.min(1, Math.max(0, fraction)), axis.span);
}

// Jour de la PLAGE visé par le pointeur : un clic dans une marge amène à la
// borne la plus proche.
function offsetFromPointer(event) {
    const axis = currentAxis();
    if (!axis) return 0;
    return clampOffset(axisOffsetFromPointer(event, axis) - axis.rangeOffset, axis.rangeSpan);
}

function currentOffset() {
    if (pendingOffset !== null) return pendingOffset;
    const state = pkg.getTimelineState?.();
    return state ? dayOffsetOf(state.position, state.start) : 0;
}

// Poignée sous le pointeur : bande du haut seulement, la plus proche des
// deux bornes à HANDLE_HIT_PX près.
function handleAt(event) {
    const axis = lastAxis;
    if (!axis || !lastState || lastState.recording) return null;
    const rect = track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y < 0 || y > HANDLE_ZONE_PX || rect.width <= 0) return null;
    const x0 = axis.rangeOffset / axis.span * rect.width;
    const x1 = (axis.rangeOffset + axis.rangeSpan) / axis.span * rect.width;
    const d0 = Math.abs(x - x0);
    const d1 = Math.abs(x - x1);
    if (Math.min(d0, d1) > HANDLE_HIT_PX) return null;
    // Plage d'un jour : les deux bornes se touchent, le côté décide.
    if (Math.abs(d0 - d1) < 0.5) return x < (x0 + x1) / 2 ? 'start' : 'end';
    return d0 < d1 ? 'start' : 'end';
}

function setHoverHandle(which) {
    if (which === hoverHandle) return;
    hoverHandle = which;
    bar.classList.toggle('is-over-handle', !!which);
}

function onPointerDown(event) {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    // Un deuxième pointeur en plein glissement ne doit pas détourner le drag.
    if ((gesture && gesture.pointerId !== null) || rangeDrag) return;
    draw(); // état frais : plage et données ont pu changer depuis le dernier dessin
    if (!lastState) return;
    const handle = handleAt(event);
    if (handle) {
        beginRangeDrag(handle, event);
        return;
    }
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
    if (rangeDrag) {
        if (rangeDrag.pointerId === event.pointerId) moveRangeDrag(event);
        return;
    }
    if (!gesture) {
        // Hors geste : simple survol. Le fantôme montre où un clic
        // amènerait le curseur — sans toucher la carte (lecteur vidéo).
        if (!lastState) draw(); // pas encore dessiné : plage inconnue
        if (!lastState || lastState.recording) {
            setHoverHandle(null);
            return;
        }
        setHoverHandle(handleAt(event));
        const offset = axisOffsetFromPointer(event);
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
    if (rangeDrag && rangeDrag.pointerId === event.pointerId) {
        // Annulé par le système (pointercancel) : rien n'est posé.
        endRangeDrag(event.type !== 'pointercancel');
        return;
    }
    // Avant le garde-fou : la classe doit être retirée même quand le geste
    // a déjà été terminé par ailleurs (minuteur clavier, blur, menu) et que
    // ce relâchement arrive en retard.
    bar.classList.remove('is-dragging');
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    endPointerGesture(event.pointerId);
    // Doigt levé : pas de survol pour reprendre la bulle.
    if (event.pointerType === 'touch') {
        hoverOffset = null;
        refreshTimelineBar();
    }
}

function endPointerGesture(pointerId) {
    bar.classList.remove('is-dragging');
    // Le geste se termine d'abord : le releasePointerCapture ci-dessous
    // réémet lostpointercapture, qui réentre dans onPointerUp — geste
    // déjà null, il sort au garde-fou.
    endGesture();
    try { track.releasePointerCapture(pointerId); } catch (_) {}
}

// --- Poignées des bornes -----------------------------------------------------------
//
// Tirer une poignée propose une nouvelle borne (voile et bulle suivent le
// pointeur) ; elle n'est posée qu'au relâchement, par setAnimationDates —
// comme le clic droit. Une borne ramenée sur l'étendue des données est
// posée à null (« Plage complète » pour ce côté). Échap annule.

function beginRangeDrag(which, event) {
    const axis = lastAxis;
    rangeDrag = {
        which,
        pointerId: event.pointerId,
        from: axis.rangeOffset,
        to: axis.rangeOffset + axis.rangeSpan - 1,
    };
    hoverOffset = null;
    try { track.setPointerCapture(event.pointerId); } catch (_) {}
    track.focus({ preventScroll: true });
    bar.classList.add('is-resizing');
    closeMenu();
    event.preventDefault();
    refreshTimelineBar();
}

function moveRangeDrag(event) {
    const offset = axisOffsetFromPointer(event, lastAxis);
    if (rangeDrag.which === 'start') rangeDrag.from = Math.min(offset, rangeDrag.to);
    else rangeDrag.to = Math.max(offset, rangeDrag.from);
    refreshTimelineBar();
}

function endRangeDrag(commit) {
    const drag = rangeDrag;
    const axis = lastAxis;
    rangeDrag = null;
    bar.classList.remove('is-resizing');
    try { track.releasePointerCapture(drag.pointerId); } catch (_) {}
    refreshTimelineBar();
    if (!commit || !axis) return;
    const defaults = pkg.getAnimationDateDefaults?.() || {};
    const sameDay = (a, b) => a instanceof Date && b instanceof Date && dayOffsetOf(a, b) === 0;
    if (drag.which === 'start') {
        if (drag.from === axis.rangeOffset) return;
        const date = dateOfOffset(axis.start, drag.from);
        pkg.setAnimationDates?.({ start: sameDay(date, defaults.start) ? null : date });
    } else {
        if (drag.to === axis.rangeOffset + axis.rangeSpan - 1) return;
        const date = dateOfOffset(axis.start, drag.to);
        pkg.setAnimationDates?.({ end: sameDay(date, defaults.end) ? null : date });
    }
}

// --- Clavier et molette ------------------------------------------------------------

// Espace : lecture/pause, comme sur un lecteur vidéo. Depuis le repos,
// l'aperçu se lance ; une série de frappes en cours est close d'abord, sans
// sa reprise automatique — Espace décide.
function togglePlayback() {
    if (gesture) {
        gesture.resume = false;
        endGesture();
    }
    const playback = pkg.previewPlaybackState?.();
    if (playback === 'playing') pkg.setPreviewPaused?.(true);
    else if (playback === 'paused') pkg.setPreviewPaused?.(false);
    else if (playback === 'idle') pkg.startPreviewPlayback?.();
    refreshTimelineBar();
}

// Ctrl+←/→ : jour avec trouvaille (ou pose/archivage) précédent ou suivant
// dans la plage ; null s'il n'y en a pas.
function eventDayFrom(offset, direction) {
    const axis = lastAxis;
    if (!axis) return null;
    const series = seriesFor(axis);
    const totals = series.secondary
        ? series.events.map((v, k) => v + series.secondary[k])
        : series.events;
    const found = nextEventOffset(totals, offset + axis.rangeOffset, direction,
        axis.rangeOffset, axis.rangeOffset + axis.rangeSpan - 1);
    return found === null ? null : found - axis.rangeOffset;
}

function onKeyDown(event) {
    if (rangeDrag) {
        if (event.key === 'Escape') {
            endRangeDrag(false);
            event.preventDefault();
        }
        return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); // ni défilement de la page, ni clic simulé
        // Touche maintenue : une seule bascule ; glissement en cours : le
        // pointeur garde la main.
        if (event.repeat || (gesture && gesture.pointerId !== null)) return;
        draw();
        if (!lastState || lastState.recording) return;
        togglePlayback();
        return;
    }
    if (event.altKey || event.metaKey) return;
    const jump = event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
    if (event.ctrlKey && !jump) return;
    draw();
    if (!lastState) return;
    const target = jump
        ? eventDayFrom(currentOffset(), event.key === 'ArrowLeft' ? -1 : 1)
        : offsetForKey(event.key, { shift: event.shiftKey }, currentOffset(), lastState.start, lastSpan);
    // Ctrl+flèche sans jour plus loin : la touche reste à la barre (pas de
    // saut de mot ailleurs), rien ne bouge.
    if (jump) event.preventDefault();
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
    if ((gesture && gesture.pointerId !== null) || rangeDrag) return;
    draw(); // état frais : plage et données ont pu changer depuis le dernier dessin
    // Barre inutilisable : la page reste libre de défiler (pas de
    // preventDefault).
    if (!lastState || lastState.recording) return;
    // Au repos, la molette n'agit que sur une piste qui a le focus (clic,
    // Tab) : la survoler en faisant défiler la page lançait l'aperçu.
    if (pkg.previewPlaybackState?.() === 'idle' && document.activeElement !== track) return;
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
// Le jour visé est celui de l'axe : un clic droit dans une marge étend la
// plage.

function closeMenu() {
    if (!menu) return;
    // Remis à null avant le retrait : retirer l'item focalisé peut émettre
    // focusout, qui rappelle closeMenu.
    const closing = menu;
    menu = null;
    closing.remove();
    document.removeEventListener('pointerdown', onMenuOutsidePointerDown, true);
    window.removeEventListener('resize', closeMenu);
}

function onMenuOutsidePointerDown(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
}

// Focus parti hors du menu (Alt+Tab, clic ailleurs sans pointerdown) : le
// menu ne reste pas ouvert, orphelin, derrière le focus. Le menu lui-même
// est focalisable (tabindex -1) : un clic sur un item désactivé y laisse le
// focus au lieu de fermer.
function onMenuFocusOut(event) {
    if (menu && !menu.contains(event.relatedTarget)) closeMenu();
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
    // Tab ferme le menu (pattern menu ARIA) et rend le focus à la piste
    // sans preventDefault : la tabulation continue depuis elle.
    if (event.key === 'Tab') {
        closeMenu();
        track.focus({ preventScroll: true });
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
    // Clic droit en plein glissement, ou appui long au doigt (qui a déjà
    // démarré un geste) : le geste se termine avant l'ouverture — sinon le
    // menu s'affichait par-dessus un glissement qui pilotait encore la carte.
    if (gesture && gesture.pointerId !== null) endPointerGesture(gesture.pointerId);
    if (rangeDrag) endRangeDrag(false);
    // Comme onPointerDown : plage et données ont pu changer depuis le dernier
    // dessin — le libellé des items affiche la date du jour visé.
    draw();
    const state = lastState;
    const axis = lastAxis;
    if (!state || !axis || state.recording) return;
    const axisDay = axisOffsetFromPointer(event, axis);
    const day = dateOfOffset(axis.start, axisDay);
    const date = formatDate(day);
    const rangeFrom = axis.rangeOffset;
    const rangeTo = axis.rangeOffset + axis.rangeSpan - 1;

    closeMenu(); // une nouvelle ouverture remplace l'ancien menu
    menu = document.createElement('div');
    menu.className = 'timeline-bar-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.addEventListener('keydown', onMenuKeyDown);
    menu.addEventListener('focusout', onMenuFocusOut);

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

    // Une borne qui croiserait l'autre (début après la fin) est désactivée :
    // la plage serait vide.
    addItem(pkg.t('Début de l\'animation ici (${date})', { date }),
        () => pkg.setAnimationDates({ start: day }), axisDay > rangeTo);
    addItem(pkg.t('Fin de l\'animation ici (${date})', { date }),
        () => pkg.setAnimationDates({ end: day }), axisDay < rangeFrom);
    addSeparator();
    // « Plage complète » = bornes aux valeurs par défaut des données. Sans
    // effet — désactivé — quand la plage affichée y est déjà.
    const defaults = pkg.getAnimationDateDefaults?.() || {};
    const extent = defaults.start instanceof Date && defaults.end instanceof Date
        ? defaults
        : (pkg.getSelectionDateExtent?.() || {});
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
    hideTip();
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) {
        menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
    }
    if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
    }

    document.addEventListener('pointerdown', onMenuOutsidePointerDown, true);
    // Position fixe calculée sur le viewport : un redimensionnement la rend
    // fausse (menu détaché de la piste, voire hors écran).
    window.addEventListener('resize', closeMenu);
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
    setHoverHandle(null);
    wheelAccum = 0; // une rafale de molette ne survit pas au masquage
    closeMenu(); // la piste masquée n'a plus de menu à afficher
    hideTip();
    if (rangeDrag) endRangeDrag(false);
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

// Tests : ce que la barre affiche, sans lire le canvas. `hover` est un jour
// de l'axe ; `axisSpan`/`rangeOffset` situent la plage sur la piste.
export function getTimelineBarSnapshot() {
    const state = pkg.getTimelineState?.() || null;
    const axis = state && spanDays(state.start, state.end) > 0 ? axisFor(state) : null;
    const series = axis ? seriesFor(axis) : null;
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
        axisStart: axis?.start ?? null,
        axisSpan: axis?.span ?? 0,
        rangeOffset: axis?.rangeOffset ?? 0,
        rangeDrag: rangeDrag ? { which: rangeDrag.which, from: rangeDrag.from, to: rangeDrag.to } : null,
        marks: axis ? marksFor(axis, series).map(({ offset, kind, label }) => ({ offset, kind, label })) : [],
        tip: tip && !tip.hidden ? [...tip.children].map((row) => row.textContent) : null,
    };
}

// Densité d'écran changée sans changement de taille CSS (fenêtre glissée sur
// un autre écran) : le ResizeObserver ne tire pas, la barre restait floue
// jusqu'au prochain dessin. La requête porte sur la densité courante : elle
// ne change qu'une fois, puis est reposée sur la nouvelle valeur. Les
// calques suivent seuls (le ratio fait partie de leur clé).
function watchPixelRatio() {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener?.('change', () => {
        watchPixelRatio();
        refreshTimelineBar();
    }, { once: true });
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
    // fantôme ni de bulle — le dessin suivant ne les cherche que hors geste.
    track.addEventListener('pointerleave', () => {
        hoverOffset = null;
        setHoverHandle(null);
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
    watchPixelRatio();
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
    // Planing des images modifié (onglet Images) : les repères suivent.
    document.addEventListener('mygcflow:images-data', refreshTimelineBar);

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
