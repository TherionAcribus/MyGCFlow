// Panneaux de statistiques posés sur la carte : cycle de vie.
//
// Relie le modèle (stats_model.mjs) et le dessin (stats_render.mjs) à
// l'application :
//   - un <canvas class="stats-panel"> par panneau dans #mapWithFrames (aperçu) ;
//   - addStatsPanelsToCanvas() pour les deux pipelines vidéo, avec la même
//     fonction de dessin et la même géométrie que l'aperçu ;
//   - un accumulateur alimenté par mapgl.js jour après jour.
//
// Branchements côté mapgl.js, volontairement minces : les jours ajoutés
// suffisent, les caches sont relues ici dans l'index par jour (bdd.js).
//   resetStatsForAnimation({ startDate, endDate, highlightMs })  — 3 démarrages
//   accumulateStatsForDates(dates, now)                          — chaque lot de jours
//   showStatsTotals()                                            — retour au repos
//   tickStatsPanels(now) → surbrillance encore active ?          — avant chaque rendu
//
// Au repos, les panneaux montrent les totaux de la sélection ; pendant
// l'animation, l'état courant, mis à l'échelle de la RÉFÉRENCE (comptes à la
// date de fin) pour que rien ne se redimensionne ni ne change de rang.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import {
    DT_LABELS,
    OTHERS_KEY,
    STATS_DEFAULTS,
    UNKNOWN_KEY,
    barModel,
    countFeatures,
    createStatsAccumulator,
    featuresUpTo,
    gridModel,
    hasActiveHighlights,
    layoutPanels,
    metricsForPanels,
    normalizeStatsSettings,
    rectsOverlap,
} from './stats_model.mjs';
import { STATS_RENDERERS, drawStatsPanel, measureStatsPanel } from './stats_render.mjs';

const DEFAULT_HIGHLIGHT_MS = 600;

let settings = normalizeStatsSettings(STATS_DEFAULTS);
let metrics = new Set();
let metricsKey = '';

// 'rest' : totaux de la sélection ; 'animating' : accumulateur courant.
let mode = 'rest';
let current = createStatsAccumulator();
let animation = null;   // { startDate, endDate, lastDate, highlightMs }
let lastNow = Number.NaN;
let highlightWasActive = false;

let totalsMemo = null;      // { key, acc }
let referenceMemo = null;   // { key, acc }

// Révision : tout ce qui change ce que dessinent les panneaux (comptes,
// réglages, mise en page, surbrillance qui s'estompe). Entre dans la signature
// des frames MediaRecorder : une matrice qui se remplit sur une carte immobile
// doit quand même produire des frames.
let revision = 0;

const panelNodes = new Map();   // id → { canvas, layout, cssWidth, drawnKey }
let layoutDirty = true;
let drawDirty = true;
let frameRequest = 0;
let containerSize = { width: 0, height: 0 };
let layoutWarnings = [];
let overlayRectsCache = [];
let resizeObserver = null;
let fontFamilyCache = null;

const videoCache = new Map();   // id → { canvas, key }
let videoDrawCount = 0;

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

export function getStatsSettings() {
    return settings;
}

// Applique des réglages (chargement, onglet Stats). L'aperçu suit aussitôt ;
// la persistance est l'affaire de stats_ui.js.
export function applyStatsSettings(raw) {
    settings = normalizeStatsSettings(raw, STATS_DEFAULTS);
    const nextMetrics = metricsForPanels(settings);
    const nextKey = [...nextMetrics].sort().join(',');
    if (nextKey !== metricsKey) {
        metrics = nextMetrics;
        metricsKey = nextKey;
        totalsMemo = null;
        referenceMemo = null;
        // Métrique ajoutée en pleine animation : l'accumulateur est reconstruit
        // jusqu'au dernier jour affiché, sans relancer l'animation.
        if (mode === 'animating') rebuildCurrent();
        else current = createStatsAccumulator(metrics);
    }
    videoCache.clear();
    fontFamilyCache = null;
    invalidateStatsLayout();
    return settings;
}

function visiblePanels() {
    if (!settings.enabled || isEvolutionPage()) return [];
    if (!(pkg.hasDatabase?.() ?? false)) return [];
    return settings.panels.filter((panel) => panel.enabled && STATS_RENDERERS[panel.kind]);
}

// ---------------------------------------------------------------------------
// Comptage
// ---------------------------------------------------------------------------

function indexFeaturesUpTo(until) {
    const visible = featuresUpTo(pkg.pointsByDate, until);
    const hidden = featuresUpTo(pkg.hiddenPointsByDate, until);
    for (const feature of hidden) visible.push(feature);
    return visible;
}

function indexRevision() {
    return Number(pkg.pointsByDateRevision) || 0;
}

// Totaux de la sélection filtrée (locationless masquées comprises, comme le
// compteur de caches), recalculés une fois par changement de sélection.
function selectionTotals() {
    const key = `${indexRevision()}|${metricsKey}`;
    if (totalsMemo?.key !== key) {
        totalsMemo = { key, acc: countFeatures(indexFeaturesUpTo(null), metrics) };
    }
    return totalsMemo.acc;
}

// Comptes à la date de fin de l'animation : l'échelle, l'ordre et les bornes
// des graphes. Égaux aux totaux sans date de fin imposée.
function animationReference() {
    const end = animation?.endDate instanceof Date ? animation.endDate : null;
    const lastFind = pkg.metadata?.endDate instanceof Date ? pkg.metadata.endDate : null;
    if (!end || (lastFind && end.getTime() >= lastFind.getTime())) return selectionTotals();
    const key = `${indexRevision()}|${metricsKey}|${end.getTime()}`;
    if (referenceMemo?.key !== key) {
        referenceMemo = { key, acc: countFeatures(indexFeaturesUpTo(end), metrics) };
    }
    return referenceMemo.acc;
}

function rebuildCurrent() {
    current = createStatsAccumulator(metrics);
    if (!animation) return;
    const until = animation.lastDate
        || new Date(animation.startDate.getTime() - 1);
    current.add(indexFeaturesUpTo(until));
}

function featuresOfDates(dates) {
    const out = [];
    for (const date of dates) {
        const key = date.toDateString();
        const visible = pkg.pointsByDate?.get(key);
        if (visible) for (const feature of visible) out.push(feature);
        const hidden = pkg.hiddenPointsByDate?.get(key);
        if (hidden) for (const feature of hidden) out.push(feature);
    }
    return out;
}

function touch() {
    revision += 1;
    drawDirty = true;
    scheduleFlush();
}

// Début d'une animation (aperçu, capture image par image, MediaRecorder) :
// l'accumulateur repart des caches antérieures à la date de début, déjà
// affichées sur la carte. Une reprise de pause ne passe pas par ici.
export function resetStatsForAnimation({ startDate, endDate, highlightMs } = {}) {
    if (!(startDate instanceof Date)) return;
    animation = {
        startDate,
        endDate: endDate instanceof Date ? endDate : null,
        lastDate: null,
        highlightMs: Number.isFinite(highlightMs) && highlightMs > 0
            ? Math.min(DEFAULT_HIGHLIGHT_MS, highlightMs)
            : DEFAULT_HIGHLIGHT_MS,
    };
    mode = 'animating';
    rebuildCurrent();
    layoutDirty = true;
    touch();
}

// Lot de jours affichés par l'animation (un ou plusieurs jours rattrapés par
// la même frame) : leurs caches, locationless masquées comprises.
export function accumulateStatsForDates(dates, now) {
    if (mode !== 'animating' || !dates?.length || metrics.size === 0) {
        if (dates?.length && animation) animation.lastDate = dates[dates.length - 1];
        return;
    }
    animation.lastDate = dates[dates.length - 1];
    const features = featuresOfDates(dates);
    if (features.length === 0) return;
    if (Number.isFinite(now)) lastNow = now;
    current.add(features, Number.isFinite(now) ? now : null);
    touch();
}

// Retour au repos (arrêt, abandon d'enregistrement) : totaux de la sélection.
// La fin naturelle de l'animation n'y passe pas — l'état final reste affiché,
// comme le compteur de caches.
export function showStatsTotals() {
    mode = 'rest';
    animation = null;
    current = createStatsAccumulator(metrics);
    layoutDirty = true;
    touch();
}

// Index reconstruit (filtre, import, vidage) : les mémos se périment seuls via
// pointsByDateRevision, il suffit de redessiner.
export function refreshStatsPanels() {
    // Fin naturelle puis nouveau filtre : l'état final de l'ancienne
    // sélection ne veut plus rien dire, place aux totaux de la nouvelle.
    if (mode === 'animating' && !(pkg.isAnimationInProgress?.() ?? false)) {
        mode = 'rest';
        animation = null;
        current = createStatsAccumulator(metrics);
    }
    layoutDirty = true;
    touch();
}

// Avant chaque rendu de la carte, avec l'horloge des points. Renvoie true tant
// qu'une surbrillance s'estompe : l'appelant entretient alors le rendu.
export function tickStatsPanels(now) {
    if (Number.isFinite(now)) lastNow = now;
    if (mode !== 'animating' || !animation) {
        if (drawDirty) flush();
        return false;
    }
    const panels = visiblePanels();
    const active = panels.length > 0
        && hasActiveHighlights(current, panels, lastNow, animation.highlightMs);
    // Une surbrillance qui vient de s'éteindre demande une dernière frame.
    if (active || highlightWasActive) {
        revision += 1;
        drawDirty = true;
    }
    highlightWasActive = active;
    if (drawDirty) flush();
    return active;
}

export function getStatsRevision() {
    return revision;
}

// ---------------------------------------------------------------------------
// Vues : modèle + libellés traduits, prêtes à dessiner
// ---------------------------------------------------------------------------

function locale() {
    return document.documentElement?.lang || 'fr';
}

let numberFormat = null;
let percentFormat = null;
function formatters() {
    const lang = locale();
    if (!numberFormat || numberFormat.lang !== lang) {
        numberFormat = { lang, fmt: new Intl.NumberFormat(lang) };
        percentFormat = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
    }
    return { number: (n) => numberFormat.fmt.format(n), percent: (r) => percentFormat.format(r) };
}

const monthNamesCache = new Map();
function monthNames(style) {
    const key = `${locale()}|${style}`;
    if (!monthNamesCache.has(key)) {
        const fmt = new Intl.DateTimeFormat(locale(), { month: style, timeZone: 'UTC' });
        monthNamesCache.set(key, Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2021, i, 1)))));
    }
    return monthNamesCache.get(key);
}

// Titre par défaut d'un panneau, d'après sa métrique — aussi le nom affiché
// dans la liste de l'onglet Stats.
export function defaultStatsPanelTitle(panel) {
    switch (panel.metric) {
        case 'dt': return pkg.t('Matrice D/T');
        case 'jasmer': return pkg.t('Grille Jasmer');
        case 'calendar': return pkg.t('Calendrier 366');
        case 'cache_type': return pkg.t('Types de caches');
        case 'container': return pkg.t('Tailles');
        case 'difficulty': return pkg.t('Difficulté');
        case 'terrain': return pkg.t('Terrain');
        case 'year': return pkg.t('Trouvailles par année');
        default: return '';
    }
}

function categoryLabel(key) {
    if (key === OTHERS_KEY) return pkg.t('Autres');
    if (key === UNKNOWN_KEY) return pkg.t('Inconnu');
    return pkg.t(String(key));
}

function labelFor(metric, number) {
    if (metric === 'difficulty' || metric === 'terrain') {
        return (key) => (key === OTHERS_KEY ? pkg.t('Autres') : number(DT_LABELS[key]));
    }
    if (metric === 'year') return (key) => String(key);
    return categoryLabel;
}

function excludedLine(metric, n) {
    switch (metric) {
        case 'dt': return pkg.t('Sans D/T : ${n}', { n });
        case 'difficulty': return pkg.t('Sans difficulté : ${n}', { n });
        case 'terrain': return pkg.t('Sans terrain : ${n}', { n });
        case 'jasmer': return pkg.t('Sans date de publication : ${n}', { n });
        default: return pkg.t('Sans date : ${n}', { n });
    }
}

function coverageLine(metric, filled, available) {
    if (metric === 'dt') return pkg.t('Combinaisons : ${filled}/${available}', { filled, available });
    if (metric === 'jasmer') return pkg.t('Mois : ${filled}/${available}', { filled, available });
    return pkg.t('Jours : ${filled}/${available}', { filled, available });
}

function resolveFontFamily(panel) {
    if (!fontFamilyCache) {
        const infos = document.getElementById('infosFrame');
        fontFamilyCache = {
            infos: (infos && getComputedStyle(infos).fontFamily) || '',
            app: getComputedStyle(document.body).fontFamily || 'sans-serif',
        };
    }
    return (panel.style.inherit_font && fontFamilyCache.infos) || fontFamilyCache.app;
}

// Fin de la grille Jasmer : on ne peut pas avoir trouvé une cache publiée
// après sa dernière trouvaille.
function jasmerEnd() {
    const end = (mode === 'animating' && animation?.endDate) || pkg.metadata?.endDate;
    const date = end instanceof Date && !Number.isNaN(end.getTime()) ? end : new Date();
    return { y: date.getFullYear(), m: date.getMonth() + 1 };
}

function buildView(panel) {
    const reference = mode === 'animating' ? animationReference() : selectionTotals();
    const state = mode === 'animating' ? current : reference;
    const { number, percent } = formatters();
    const metric = panel.metric;
    const view = {
        kind: panel.kind,
        metric,
        title: panel.show_title ? (panel.title || defaultStatsPanelTitle(panel)) : '',
        fontFamily: resolveFontFamily(panel),
        formatNumber: number,
        formatPercent: percent,
        showValues: panel.options.show_values,
        showPercent: panel.options.show_percent,
        footer: [],
        highlight: mode === 'animating' && animation
            ? { mode: panel.options.highlight, durationMs: animation.highlightMs, hits: current.lastHit.get(metric) }
            : null,
    };
    // Présence des lignes de pied décidée sur la référence : la hauteur du
    // panneau ne change pas au premier Lab rencontré.
    const refExcluded = reference.excluded.get(metric) || 0;

    if (panel.kind === 'grid') {
        const model = gridModel(metric, state, reference, { end: jasmerEnd() });
        view.model = model;
        view.cellMode = panel.options.cell_mode;
        if (metric === 'dt') {
            view.rowLabels = DT_LABELS.map(number);
            view.colLabels = DT_LABELS.map(number);
            // Lignes D, colonnes T : abréviations communes au français et à l'anglais.
            view.corner = 'D/T';
        } else if (metric === 'jasmer') {
            const narrow = monthNames('narrow');
            view.rowLabels = model.rowKeys.map(String);
            view.colLabels = narrow;
            view.corner = '';
        } else {
            view.rowLabels = monthNames('short');
            view.colLabels = model.colKeys.map(String);
            view.corner = '';
        }
        if (panel.options.show_coverage) view.footer.push(coverageLine(metric, model.filled, model.available));
        if (refExcluded > 0) view.footer.push(excludedLine(metric, model.excluded));
        return view;
    }

    const labelOf = labelFor(metric, number);
    const model = barModel(metric, state, reference, panel.options, labelOf);
    view.model = model;
    view.orientation = panel.options.orientation;
    view.palette = panel.style.palette;
    view.labelOf = labelOf;
    view.colorOf = (key) => pkg.defaultGcColors?.[key] || null;
    view.sum = model.rows.reduce((s, row) => s + row.count, 0);
    if (refExcluded > 0 && metric !== 'cache_type' && metric !== 'container') {
        view.footer.push(excludedLine(metric, model.excluded));
    }
    return view;
}

// ---------------------------------------------------------------------------
// Aperçu : canvas DOM
// ---------------------------------------------------------------------------

function container() {
    return document.getElementById('mapWithFrames');
}

function ensureResizeObserver(host) {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => invalidateStatsLayout());
    resizeObserver.observe(host);
}

export function invalidateStatsLayout() {
    layoutDirty = true;
    touch();
}

function scheduleFlush() {
    if (frameRequest || typeof requestAnimationFrame === 'undefined') return;
    frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        flush();
    });
}

function nodeFor(panel, host) {
    let node = panelNodes.get(panel.id);
    if (!node) {
        const canvas = document.createElement('canvas');
        canvas.className = 'stats-panel';
        canvas.dataset.panelId = panel.id;
        canvas.setAttribute('aria-hidden', 'true');
        // Sous le titre et les infos (z-index 100), comme dans la vidéo où ils
        // sont dessinés après les panneaux.
        const map = document.getElementById('map');
        host.insertBefore(canvas, map ? map.nextSibling : host.firstChild);
        node = { canvas, layout: null, cssWidth: 0, drawnKey: '', cssKey: '' };
        panelNodes.set(panel.id, node);
    }
    return node;
}

function removeStalePanels(keep) {
    for (const [id, node] of panelNodes) {
        if (keep.has(id)) continue;
        node.canvas.remove();
        panelNodes.delete(id);
        videoCache.delete(id);
    }
}

// Rects de #titleFrame et #infosFrame dans le repère du conteneur, pour
// signaler un chevauchement (pas de déplacement automatique).
function overlayRects(host) {
    const base = host.getBoundingClientRect();
    const rects = [];
    for (const id of ['titleFrame', 'infosFrame']) {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === 'none') continue;
        const r = el.getBoundingClientRect();
        rects.push({ id, x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height });
    }
    return rects;
}

function flush() {
    drawDirty = false;
    const host = container();
    if (!host) return;
    ensureResizeObserver(host);
    const panels = visiblePanels();
    const views = new Map(panels.map((panel) => [panel.id, buildView(panel)]));
    removeStalePanels(new Set(panels.map((panel) => panel.id)));

    // Lectures de géométrie DOM seulement sur invalidation (resize, réglages,
    // changement de mode) : jamais à chaque frame d'animation.
    if (layoutDirty) {
        layoutDirty = false;
        containerSize = { width: host.clientWidth, height: host.clientHeight };
        overlayRectsCache = panels.length ? overlayRects(host) : [];
    }
    const items = panels.map((panel) => {
        const width = Math.min(panel.position.width, containerSize.width);
        return {
            id: panel.id,
            anchor: panel.position.anchor,
            dx: panel.position.dx,
            dy: panel.position.dy,
            width,
            height: measureStatsPanel(views.get(panel.id), panel.style, Math.max(1, width)),
        };
    });
    const layout = layoutPanels(items, containerSize);
    const warnings = [];

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    for (const panel of panels) {
        const rect = layout.get(panel.id);
        const node = nodeFor(panel, host);
        node.layout = rect;
        node.cssWidth = rect.width;
        const css = rect.css;
        const cssKey = `${css.left}|${css.right}|${css.top}|${css.bottom}|${rect.width}|${rect.height}`;
        if (node.cssKey !== cssKey) {
            const style = node.canvas.style;
            style.left = css.left != null ? `${css.left}px` : '';
            style.right = css.right != null ? `${css.right}px` : '';
            style.top = css.top != null ? `${css.top}px` : '';
            style.bottom = css.bottom != null ? `${css.bottom}px` : '';
            style.width = `${rect.width}px`;
            style.height = `${rect.height}px`;
            node.cssKey = cssKey;
        }
        const bw = Math.max(1, Math.round(rect.width * dpr));
        const bh = Math.max(1, Math.round(rect.height * dpr));
        const key = `${revision}|${bw}|${bh}`;
        if (node.drawnKey !== key) {
            if (node.canvas.width !== bw || node.canvas.height !== bh) {
                node.canvas.width = bw;
                node.canvas.height = bh;
            }
            const ctx = node.canvas.getContext('2d');
            ctx.clearRect(0, 0, bw, bh);
            drawStatsPanel(ctx, { x: 0, y: 0, width: bw, height: bh },
                views.get(panel.id), panel.style, lastNow, rect.width);
            node.drawnKey = key;
        }
        if (rect.overflow) warnings.push({ id: panel.id, kind: 'overflow' });
        for (const overlay of overlayRectsCache) {
            if (rectsOverlap(rect, overlay)) warnings.push({ id: panel.id, kind: 'overlap', with: overlay.id });
        }
    }
    if (JSON.stringify(warnings) !== JSON.stringify(layoutWarnings)) {
        layoutWarnings = warnings;
        try {
            document.dispatchEvent(new CustomEvent('mygcflow:stats-layout', { detail: { warnings } }));
        } catch (_) {}
    }
}

export function getStatsLayoutWarnings() {
    return layoutWarnings;
}

// Base vidée, page Évolution, interrupteur : la visibilité se recalcule au
// prochain dessin (appelé par frames.js › syncOverlayVisibility).
export function syncStatsPanelsVisibility() {
    fontFamilyCache = null;
    invalidateStatsLayout();
}

// ---------------------------------------------------------------------------
// Vidéo
// ---------------------------------------------------------------------------

// Dessine les panneaux sur le canvas d'enregistrement, AVANT les overlays
// titre/infos (même empilement que l'aperçu). Géométrie : celle de l'aperçu
// × scaleFactor, ancrée comme dans le DOM (left/right, top/bottom). Chaque
// panneau est rendu dans un canvas hors écran gardé tant que la révision et
// l'échelle ne changent pas : un panneau immobile coûte un drawImage.
export function addStatsPanelsToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    if (drawDirty) flush();
    const panels = visiblePanels();
    if (panels.length === 0) return;
    videoDrawCount += 1;
    const views = new Map();
    for (const panel of panels) {
        const node = panelNodes.get(panel.id);
        const rect = node?.layout;
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
        const w = Math.max(1, Math.round(rect.width * scaleFactor));
        const h = Math.max(1, Math.round(rect.height * scaleFactor));
        const x = rect.css.right != null
            ? canvasWidth - Math.round(rect.css.right * scaleFactor) - w
            : Math.round(rect.css.left * scaleFactor);
        const y = rect.css.bottom != null
            ? canvasHeight - Math.round(rect.css.bottom * scaleFactor) - h
            : Math.round(rect.css.top * scaleFactor);
        const key = `${revision}|${w}|${h}`;
        let cached = videoCache.get(panel.id);
        if (!cached) {
            cached = { canvas: document.createElement('canvas'), key: '' };
            videoCache.set(panel.id, cached);
        }
        if (cached.key !== key) {
            if (cached.canvas.width !== w || cached.canvas.height !== h) {
                cached.canvas.width = w;
                cached.canvas.height = h;
            }
            const offCtx = cached.canvas.getContext('2d');
            offCtx.clearRect(0, 0, w, h);
            if (!views.has(panel.id)) views.set(panel.id, buildView(panel));
            drawStatsPanel(offCtx, { x: 0, y: 0, width: w, height: h },
                views.get(panel.id), panel.style, lastNow, rect.width);
            cached.key = key;
        }
        ctx.drawImage(cached.canvas, x, y);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// État courant, sérialisable : utilisé par les tests E2E pour comparer les
// comptes au compteur de caches affiché.
export function getStatsSnapshot() {
    const state = mode === 'animating' ? current : selectionTotals();
    const counts = {};
    const excluded = {};
    for (const metric of metrics) {
        counts[metric] = Object.fromEntries(state.counts.get(metric) || new Map());
        excluded[metric] = state.excluded.get(metric) || 0;
    }
    return {
        mode,
        total: state.total,
        metrics: [...metrics],
        counts,
        excluded,
        revision,
        videoDrawCount,
        visible: visiblePanels().map((panel) => panel.id),
    };
}
