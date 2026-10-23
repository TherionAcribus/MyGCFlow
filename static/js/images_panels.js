// Images posées sur la carte (onglet Images) : chargement, mise en page,
// aperçu et vidéo.
//
// - applyImagesSettings() : réglages normalisés (préférence globale
//   `images`), appliqués au chargement (init.js) puis par l'onglet ;
// - un <canvas class="image-panel"> par image dans #mapWithFrames, au-dessus
//   des panneaux de stats et sous le titre et les infos ;
// - addImagePanelsToCanvas() pour les deux pipelines vidéo, entre les stats
//   et les cartouches, à la géométrie de l'aperçu × échelle — l'ombre cuite
//   dans le canvas mis en cache, un drawImage nu par frame ;
// - getImagePanelRects() : rects des images, obstacles que les piles de
//   stats contournent (priorité Titre/Infos > Images > Stats) ;
// - imagesReady() : attendue avant le premier enregistrement d'une frame ;
// - le planing (schedule {start, end, fade}) : une image peut apparaître puis
//   disparaître à des dates de l'animation, en fondu — aperçu par transition
//   CSS sur le canvas, vidéo par globalAlpha.
//
// Mise en page : layoutPanels de stats_model.mjs (mêmes emplacements, piles,
// marges, position libre), titre et infos en obstacles. Aucun coût par
// frame d'animation hors fondu : la place des images est réservée que le
// planing les montre ou non, tout est recalculé sur invalidation seulement.

import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import { layoutPanels } from './stats_model.mjs';
import {
    IMAGE_ANCHORS,
    IMAGE_SIZE_RANGE,
    dayNumberToIso,
    dayOfNthFind,
    hasSchedule,
    imagesItemsKey,
    normalizeImagesSettings,
    SCHEDULE_UNREACHED,
    scheduleBounds,
} from './images_model.mjs';
import {
    IMAGE_EFFECT_EASINGS,
    IMAGE_SHADOW,
    cubicBezier,
    drawImagePanel,
    effectTimingCss,
    effectTransform,
    imagePanelHeight,
} from './images_render.mjs';
import { dateToDayNumber, isoToDayNumber } from './evolution_timeline.mjs';

let settings = normalizeImagesSettings(null);

// Chaque page a sa liste d'images (`items` sur « Mes Geocaches »,
// `evolution_items` sur /evolution), indépendante — comme stats.panels /
// stats.evolution_panels ; `enabled` reste commun aux deux pages.
const ITEMS_KEY = imagesItemsKey(isEvolutionPage());
const pageItems = () => settings[ITEMS_KEY] || [];
// Bumpé à chaque changement de réglage ou d'image chargée : signale aux
// frames MediaRecorder (overlayContentSignature) qu'une frame est à produire.
// Les dessins eux-mêmes sont invalidés par des clés par image (flush,
// addImagePanelsToCanvas).
let revision = 0;

// Fichier → { img, state: 'loading' | 'ready' | 'failed', promise }.
const sources = new Map();
// Id → { canvas, layout, cssKey, drawnKey }.
const nodes = new Map();
// Id → { canvas, shadowCanvas, shadowPad, key } : rendus hors écran de la
// vidéo (shadowCanvas : second canvas élargi qui porte l'ombre, sinon null).
const videoCache = new Map();

let layout = new Map();
let layoutDirty = true;
let layoutKey = '';
let containerSize = { width: 0, height: 0 };
let frameRequest = 0;
let resizeObserver = null;

// Planing d'apparition (schedule {start, end, fade}) : transitions par
// image, id → { from, to, at, dur }. L'alpha courante est interpolée de
// `from` vers `to` à l'horloge des points ; `at: null` = état instantané
// (saut, début d'animation, fondu nul).
const scheduleStates = new Map();
// Horloge du dernier composite vidéo : base des alphas de la signature des
// frames MediaRecorder (getImagesAlphaSignature).
let lastCompositeNow = null;

function host() {
    return document.getElementById('mapWithFrames');
}

export function imageUrl(file) {
    return `/api/images/${encodeURIComponent(file)}`;
}

// Nouvelles tentatives après un chargement raté : un incident passager
// (serveur de développement qui redémarre, réseau local occupé) ne doit pas
// faire déclarer « manquante » une image bien présente. Délais cumulés
// (2,5 s) sous le plafond de imagesReady (3 s).
const RETRY_DELAYS_MS = [500, 2000];

function loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Décodage d'un fichier, une seule fois par nom tant qu'il réussit (le
// contenu d'un nom ne change jamais). Un échec n'est retenu qu'après les
// nouvelles tentatives, et s'oublie (forgetFailedImageSources) : un envoi du
// même fichier ou l'ouverture de l'onglet Images le retentent. Chargée ou en
// échec, l'image relance la mise en page : sa hauteur dépend de ses
// proportions.
function ensureSource(file) {
    if (!file || sources.has(file)) return sources.get(file);
    const entry = { img: null, state: 'loading', promise: null };
    entry.promise = (async () => {
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
            // Paramètre de tentative : jamais une réponse d'échec resservie.
            const img = await loadImage(attempt ? `${imageUrl(file)}?retry=${attempt}` : imageUrl(file));
            if (img) {
                entry.img = img;
                return true;
            }
        }
        return false;
    })().then((ok) => {
        // Oubliée entre-temps (forgetFailedImageSources) : rien à signaler.
        if (sources.get(file) !== entry) return ok;
        entry.state = ok ? 'ready' : 'failed';
        revision += 1;
        invalidateImagesLayout();
        // L'onglet Images marque les images manquantes (images_ui.js).
        try {
            document.dispatchEvent(new CustomEvent('mygcflow:image-source', { detail: { file, ok } }));
        } catch (_) {}
        return ok;
    });
    sources.set(file, entry);
    return entry;
}

// Oublie les échecs mémorisés — tous, ou celui d'un fichier — puis relance
// le chargement des images de la liste. Appelé après un envoi réussi (le
// même contenu redonne le même nom : sans cela, l'échec d'avant serait
// resservi) et à l'ouverture de l'onglet Images.
export function forgetFailedImageSources(file = null) {
    let forgotten = false;
    for (const [name, entry] of sources) {
        if (entry.state !== 'failed' || (file && name !== file)) continue;
        sources.delete(name);
        forgotten = true;
    }
    if (!forgotten) return;
    for (const item of pageItems()) ensureSource(item.file);
    revision += 1;
    invalidateImagesLayout();
}

export function applyImagesSettings(raw) {
    settings = normalizeImagesSettings(raw, settings);
    for (const item of pageItems()) ensureSource(item.file);
    // Transitions devenues sans objet : image retirée ou planing effacé.
    for (const id of [...scheduleStates.keys()]) {
        const item = pageItems().find((i) => i.id === id);
        if (!item || !scheduleOf(item)) scheduleStates.delete(id);
    }
    revision += 1;
    invalidateImagesLayout();
    // Repères du planing sur la barre de chronologie.
    pkg.refreshTimelineBar?.();
    return settings;
}

export function getImagesSettings() {
    return settings;
}

export function getImagesRevision() {
    return revision;
}

// État de chargement d'une image (liste de l'onglet : « image manquante »).
export function imageSourceState(file) {
    if (!file) return 'missing';
    return sources.get(file)?.state || 'loading';
}

// Candidates à l'affichage : activées, avec un fichier lisible, base chargée
// (même règle que le titre et les infos, cf. frames.js › syncOverlayVisibility).
// Chargement en cours compris : imagesReady doit attendre ces sources.
function drawableItems() {
    if (!settings.enabled) return [];
    if (!(pkg.hasDatabase?.() ?? true)) return [];
    return pageItems().filter((item) => item.enabled && item.file
        && sources.get(item.file)?.state !== 'failed');
}

// Images réellement dessinées et posées : sources prêtes seulement. Une image
// en cours de chargement n'est pas placée — la mettre en carré provisoire
// ferait tout sauter (pile de stats comprise) à l'arrivée de ses proportions.
function visibleItems() {
    return drawableItems().filter((item) => sources.get(item.file)?.state === 'ready');
}

function naturalSize(item) {
    const entry = sources.get(item.file);
    if (entry?.state !== 'ready') return null;
    return { width: entry.img.naturalWidth, height: entry.img.naturalHeight };
}

// Titre et infos affichés, dans le repère du conteneur : obstacles des images.
function overlayRects(container) {
    const base = container.getBoundingClientRect();
    const rects = [];
    for (const id of ['titleFrame', 'infosFrame']) {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === 'none') continue;
        const r = el.getBoundingClientRect();
        rects.push({ id, x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height });
    }
    return rects;
}

function ensureResizeObserver(container) {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => invalidateImagesLayout());
    resizeObserver.observe(container);
    for (const id of ['titleFrame', 'infosFrame']) {
        const el = document.getElementById(id);
        if (el) resizeObserver.observe(el);
    }
}

export function invalidateImagesLayout() {
    layoutDirty = true;
    scheduleFlush();
}

// Base chargée ou vidée, page Évolution : appelé avec la visibilité du titre
// et des infos (frames.js › syncOverlayVisibility).
export function syncImagePanelsVisibility() {
    invalidateImagesLayout();
}

// Entrée de layoutPanels pour une image : sa position et sa taille à la
// largeur effective (bornée au conteneur).
function layoutItemOf(item) {
    const width = Math.min(item.position.width, containerSize.width);
    return {
        id: item.id,
        mode: item.position.mode,
        anchor: item.position.anchor,
        dx: item.position.dx,
        dy: item.position.dy,
        x: item.position.x,
        y: item.position.y,
        width,
        height: imagePanelHeight(item, naturalSize(item), width),
    };
}

// ---------------------------------------------------------------------------
// Glisser-déposer (images_ui.js › panel_interactions.js)
// ---------------------------------------------------------------------------

// Épingle du coin haut-gauche pendant le redimensionnement d'une image libre.
let resizePin = null;

function itemById(id) {
    return pageItems().find((item) => item.id === id) || null;
}

// Aperçus en direct : écrits en place dans les réglages, sans normalisation
// ni enregistrement (le commit au dépôt fait les deux), comme
// previewStatsPanelPosition. La mise en page — et celle des stats, qui
// contournent l'image — suit au prochain rafraîchissement.
export function previewImagePosition(id, x, y) {
    if (pkg.isAnimationInProgress?.()) return;
    const item = itemById(id);
    if (!item || !Number.isFinite(x) || !Number.isFinite(y)) return;
    item.position.mode = 'free';
    item.position.x = Math.max(0, Math.min(1, x));
    item.position.y = Math.max(0, Math.min(1, y));
    invalidateImagesLayout();
}

export function previewImageWidth(id, width) {
    if (pkg.isAnimationInProgress?.()) return;
    const item = itemById(id);
    const w = Number(width);
    if (!item || !Number.isFinite(w)) return;
    const [min, max] = IMAGE_SIZE_RANGE;
    item.position.width = Math.max(min, Math.min(max, Math.round(w)));
    invalidateImagesLayout();
}

export function previewImageHeight(id, height) {
    if (pkg.isAnimationInProgress?.()) return;
    const item = itemById(id);
    const h = Number(height);
    if (!item || !Number.isFinite(h)) return;
    const [min, max] = IMAGE_SIZE_RANGE;
    item.position.height = Math.max(min, Math.min(max, Math.round(h)));
    invalidateImagesLayout();
}

export function pinImageCorner(id) {
    ensureLayout();
    const rect = layout.get(id);
    resizePin = rect ? { id, left: rect.x, top: rect.y } : null;
}

// Le dernier aperçu peut attendre encore sa mise en page : appliquée tout de
// suite, sans quoi le commit reprendrait les x/y d'avant.
export function unpinImageCorner() {
    if (resizePin) ensureLayout();
    resizePin = null;
}

// Aimantation : pour chaque emplacement, le rect que prendrait l'image si
// elle y était ancrée — marges de la pile reprises, titre et infos
// contournés, place dans la pile fixée par l'ordre de la liste. Les
// emplacements où elle déborderait du cadre ne sont pas proposés (même
// calcul que getStatsSnapTargets).
export function getImageSnapTargets(id) {
    ensureLayout();
    const container = host();
    const items = visibleItems();
    const index = items.findIndex((item) => item.id === id);
    if (!container || index < 0) return [];
    const entries = items.map(layoutItemOf);
    const obstacles = overlayRects(container);
    const own = items[index];
    const targets = [];
    for (const anchor of IMAGE_ANCHORS) {
        const mate = pageItems().find((item) => item.id !== id
            && item.position.mode === 'anchor' && item.position.anchor === anchor);
        const candidate = {
            ...entries[index],
            mode: 'anchor',
            anchor,
            dx: mate ? mate.position.dx : own.position.dx,
            dy: mate ? mate.position.dy : own.position.dy,
        };
        const trial = entries.map((entry, i) => (i === index ? candidate : entry));
        const rect = layoutPanels(trial, containerSize, obstacles).get(id);
        if (!rect || rect.overflow) continue;
        targets.push({ anchor, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return targets;
}

// Recalcule la mise en page si besoin. Si elle a changé, les piles de stats,
// qui contournent les images, sont invalidées à leur tour.
function ensureLayout() {
    if (!layoutDirty) return;
    layoutDirty = false;
    const container = host();
    if (!container) {
        layout = new Map();
        return;
    }
    ensureResizeObserver(container);
    containerSize = { width: container.clientWidth, height: container.clientHeight };
    const items = visibleItems().map((item) => {
        const entry = layoutItemOf(item);
        // Redimensionnement à la souris d'une image libre : son coin
        // haut-gauche reste fixe, x/y (fractions de l'espace restant) sont
        // recalculés en place après la mesure — comme pinStatsPanelCorner.
        if (resizePin?.id === item.id && item.position.mode === 'free') {
            const fraction = (offset, room) => (room > 0 ? Math.max(0, Math.min(1, offset / room)) : 0);
            entry.x = item.position.x = fraction(resizePin.left, containerSize.width - entry.width);
            entry.y = item.position.y = fraction(resizePin.top, containerSize.height - entry.height);
        }
        return entry;
    });
    layout = layoutPanels(items, containerSize, items.length ? overlayRects(container) : []);
    const key = JSON.stringify([...layout].map(([id, r]) => [id, r.x, r.y, r.width, r.height]));
    if (key !== layoutKey) {
        layoutKey = key;
        try { pkg.invalidateStatsLayout?.(); } catch (_) {}
    }
}

// Rects des images affichées (repère du conteneur, px CSS) : obstacles des
// piles de stats (stats_panels.js › overlayRects).
export function getImagePanelRects() {
    ensureLayout();
    return [...layout].map(([id, r]) => ({ id: `image:${id}`, x: r.x, y: r.y, width: r.width, height: r.height }));
}

// Rect logique d'une image affichée et taille du conteneur (glisser-déposer,
// lot 5), comme getStatsPanelRect.
export function getImagePanelRect(id) {
    ensureLayout();
    const rect = layout.get(id);
    if (!rect) return null;
    const item = pageItems().find((i) => i.id === id);
    return {
        ...rect,
        mode: item?.position.mode || 'anchor',
        anchor: item?.position.anchor || 'bottom-right',
        container: { ...containerSize },
    };
}

// Image choisie dans l'onglet : son canvas prend `is-selected` (liseré,
// visible en mode édition seulement). Pur repère de l'aperçu — la vidéo ne
// lit jamais les classes DOM.
let selectedImageId = null;

export function setImagePanelSelection(id) {
    selectedImageId = id || null;
    for (const [imageId, node] of nodes) {
        node.canvas.classList.toggle('is-selected', imageId === selectedImageId);
    }
}

function scheduleFlush() {
    if (frameRequest || typeof requestAnimationFrame === 'undefined') return;
    frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        flush();
    });
}

function nodeFor(item, container) {
    let node = nodes.get(item.id);
    if (!node) {
        const canvas = document.createElement('canvas');
        canvas.className = 'image-panel';
        canvas.classList.toggle('is-selected', item.id === selectedImageId);
        canvas.dataset.imageId = item.id;
        canvas.setAttribute('role', 'img');
        const map = document.getElementById('map');
        container.insertBefore(canvas, map ? map.nextSibling : container.firstChild);
        node = { canvas, layout: null, cssKey: '', drawnKey: '' };
        nodes.set(item.id, node);
    }
    return node;
}

function flush() {
    const container = host();
    if (!container) return;
    ensureLayout();
    const items = visibleItems().filter((item) => layout.has(item.id));
    const keep = new Set(items.map((item) => item.id));
    for (const [id, node] of nodes) {
        if (keep.has(id)) continue;
        node.canvas.remove();
        nodes.delete(id);
        videoCache.delete(id);
    }
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    for (const item of items) {
        const rect = layout.get(item.id);
        const node = nodeFor(item, container);
        node.layout = rect;
        // Nom accessible : le nom d'origine du fichier, à défaut « Image ».
        node.canvas.setAttribute('aria-label', item.name || pkg.t('Image'));
        node.canvas.classList.toggle('has-shadow', item.style.shadow);
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
        const entry = sources.get(item.file);
        // Clé par image : tout ce qui influence drawImagePanel — fichier,
        // état de la source, taille réelle, style. La révision globale ne
        // suffit pas : elle re-dessinerait les quatre images pour un
        // changement de nom (cf. addImagePanelsToCanvas, même clé).
        const key = `${item.file}|${entry?.state === 'ready'}|${bw}|${bh}|${JSON.stringify(item.style)}`;
        if (node.drawnKey !== key) {
            node.canvas.width = bw;
            node.canvas.height = bh;
            const ctx = node.canvas.getContext('2d');
            ctx.clearRect(0, 0, bw, bh);
            drawImagePanel(ctx, bw, bh, item, entry?.state === 'ready' ? entry.img : null, dpr);
            node.drawnKey = key;
        }
        // Le canvas a pu être recréé (ou ses styles perdus) : le planing
        // repose son opacité — ou l'efface au repos.
        applyScheduleOpacity(item);
    }
}

// Vignette du formulaire de l'onglet : l'image dessinée avec son style, à
// l'échelle qui la fait tenir dans `box` (px CSS) — jamais agrandie, rayon,
// marge et bordure réduits d'autant. Ombre par la classe `has-shadow` (CSS).
// false tant que la source n'est pas décodée : son arrivée
// (mygcflow:image-source) relance le formulaire.
export function drawImageFormPreview(canvas, item, box) {
    const entry = ensureSource(item?.file);
    if (entry?.state !== 'ready') return false;
    const natural = { width: entry.img.naturalWidth, height: entry.img.naturalHeight };
    const width = item.position.width;
    const height = imagePanelHeight(item, natural, width);
    const fit = Math.min(1, box.width / width, box.height / height);
    const cssWidth = Math.max(1, Math.round(width * fit));
    const cssHeight = Math.max(1, Math.round(height * fit));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawImagePanel(ctx, canvas.width, canvas.height, item, entry.img, fit * dpr);
    canvas.classList.toggle('has-shadow', !!item.style.shadow);
    return true;
}

// Dessine les images sur le canvas d'enregistrement, APRÈS les panneaux de
// stats et AVANT le titre et les infos (même empilement que l'aperçu).
// Géométrie de l'aperçu × scaleFactor, ancrée comme dans le DOM. Chaque image
// est rendue dans un canvas hors écran gardé tant que la révision et la
// taille ne changent pas : une image immobile coûte un drawImage nu, l'ombre
// portée étant cuite dans un second canvas du cache (ci-dessous).
// `now` : horloge des points — le planing d'apparition est composé en
// globalAlpha (fondu en cours, image masquée non dessinée).
export function addImagePanelsToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1, now = null) {
    if (Number.isFinite(now)) lastCompositeNow = now;
    ensureLayout();
    for (const item of visibleItems()) {
        const rect = layout.get(item.id);
        const entry = sources.get(item.file);
        // Pas encore décodée : rien plutôt qu'une forme vide (imagesReady est
        // attendue avant l'enregistrement, ce cas reste exceptionnel).
        if (!rect || entry?.state !== 'ready') continue;
        // Planing : fondu sortant/entrant en cours, ou hors dates (rien).
        const alpha = scheduleAlpha(item, now);
        if (alpha <= 0) continue;
        const w = Math.max(1, Math.round(rect.width * scaleFactor));
        const h = Math.max(1, Math.round(rect.height * scaleFactor));
        const x = rect.css.right != null
            ? canvasWidth - Math.round(rect.css.right * scaleFactor) - w
            : Math.round(rect.css.left * scaleFactor);
        const y = rect.css.bottom != null
            ? canvasHeight - Math.round(rect.css.bottom * scaleFactor) - h
            : Math.round(rect.css.top * scaleFactor);
        const key = `${item.file}|${w}|${h}|${JSON.stringify(item.style)}`;
        let cached = videoCache.get(item.id);
        if (!cached) {
            cached = { canvas: document.createElement('canvas'), shadowCanvas: null, shadowPad: 0, key: '' };
            videoCache.set(item.id, cached);
        }
        if (cached.key !== key) {
            cached.canvas.width = w;
            cached.canvas.height = h;
            const offCtx = cached.canvas.getContext('2d');
            offCtx.clearRect(0, 0, w, h);
            drawImagePanel(offCtx, w, h, item, entry.img, scaleFactor);
            if (item.style.shadow) {
                // Ombre cuite dans un second canvas élargi, sur le contexte
                // duquel les shadow* sont posés : l'ombre est alors celle du
                // composite complet (forme + fond + image), comme le
                // drop-shadow CSS de l'aperçu. Posées dans drawImagePanel, les
                // shadow* s'appliqueraient à chaque opération de dessin —
                // ombres superposées au lieu d'une seule. Marge sur tous les
                // côtés : le spread réel d'un shadowBlur dépasse sa valeur,
                // et l'offsetY doit rentrer dans la marge du bas.
                const pad = Math.ceil((IMAGE_SHADOW.blur * 2 + IMAGE_SHADOW.offsetY) * scaleFactor);
                if (!cached.shadowCanvas) cached.shadowCanvas = document.createElement('canvas');
                cached.shadowCanvas.width = w + 2 * pad;
                cached.shadowCanvas.height = h + 2 * pad;
                const shadowCtx = cached.shadowCanvas.getContext('2d');
                shadowCtx.clearRect(0, 0, cached.shadowCanvas.width, cached.shadowCanvas.height);
                shadowCtx.shadowColor = IMAGE_SHADOW.color;
                shadowCtx.shadowBlur = IMAGE_SHADOW.blur * scaleFactor;
                shadowCtx.shadowOffsetY = IMAGE_SHADOW.offsetY * scaleFactor;
                shadowCtx.drawImage(cached.canvas, pad, pad);
                cached.shadowPad = pad;
            } else {
                cached.shadowCanvas = null;
            }
            cached.key = key;
        }
        const blit = cached.shadowCanvas
            ? () => ctx.drawImage(cached.shadowCanvas, x - cached.shadowPad, y - cached.shadowPad)
            : () => ctx.drawImage(cached.canvas, x, y);
        // Effet d'entrée/sortie en cours : décalage et échelle autour du
        // centre de l'image, calculés en px CSS (mêmes valeurs que l'aperçu)
        // puis mis à l'échelle de la vidéo.
        const motion = scheduleMotion(item, now);
        const tf = motion < 1 ? effectTransform(item.schedule.effect, motion, rect, containerSize) : null;
        const moving = !!tf && (tf.dx !== 0 || tf.dy !== 0 || tf.scale !== 1);
        if (alpha < 1 || moving) {
            ctx.save();
            ctx.globalAlpha = alpha;
            if (moving) {
                const cx = x + w / 2;
                const cy = y + h / 2;
                ctx.translate(cx + tf.dx * scaleFactor, cy + tf.dy * scaleFactor);
                ctx.scale(tf.scale, tf.scale);
                ctx.translate(-cx, -cy);
            }
            blit();
            ctx.restore();
        } else {
            blit();
        }
    }
}

// ---------------------------------------------------------------------------
// Apparition planifiée (schedule {start, end, fade})
// ---------------------------------------------------------------------------
//
// Une image qui a un planing apparaît au jour « Apparaît le » (fondu entrant
// commencé ce jour-là) et disparaît au jour « Disparaît le » (fondu sortant
// commencé ce jour-là, inclus donc exclus). `end <= start` : jamais visible —
// l'UI borne end ≥ start, le modèle ne force pas. Sa place dans la pile est
// toujours réservée (visibleItems inchangé) : rien ne saute quand elle
// apparaît, et les piles de stats gardent le contournement.

// Planing posé sur l'image, ou null (aucune borne dans son mode : toujours
// visible).
function scheduleOf(item) {
    const schedule = item?.schedule;
    if (!hasSchedule(schedule)) return null;
    // Page Évolution : pas de compteur de trouvailles — un planing par
    // jalons (venu d'une configuration de l'autre page) y est ignoré plutôt
    // que de cacher l'image pour toujours.
    if (schedule.by === 'find' && isEvolutionPage()) return null;
    return schedule;
}

// Jalons de trouvailles (`schedule.by === 'find'`) : trouvailles par jour,
// triées — le compteur de la carte, locationless masquées comprises
// (hiddenPointsByDate), trouvailles antérieures au début de l'animation
// comprises. Recalculé quand l'index des points change (révision).
let findDays = { revision: null, dayCounts: [] };

function findDayCounts() {
    const revision = pkg.pointsByDateRevision ?? 0;
    if (findDays.revision === revision) return findDays.dayCounts;
    const counts = new Map();
    for (const index of [pkg.pointsByDate, pkg.hiddenPointsByDate]) {
        if (!index) continue;
        for (const [key, points] of index) {
            const day = dateToDayNumber(new Date(key));
            if (Number.isFinite(day)) counts.set(day, (counts.get(day) || 0) + (points?.length || 0));
        }
    }
    findDays = { revision, dayCounts: [...counts].sort((a, b) => a[0] - b[0]) };
    return findDays.dayCounts;
}

// Date « AAAA-MM-JJ » de la Ne trouvaille de la sélection, null si le total
// ne l'atteint pas. Page Évolution : pas de trouvailles, toujours null.
export function imageFindDate(n) {
    return dayNumberToIso(dayOfNthFind(findDayCounts(), n));
}

// Index des points reconstruit (import, filtre, vidage — bdd.js) : les jalons
// de trouvailles changent de date. Le calcul se refait seul (révision) ;
// l'onglet Images, lui, doit redessiner les dates affichées sous les jalons
// et l'avertissement du planing.
export function refreshImagesForData() {
    try {
        document.dispatchEvent(new CustomEvent('mygcflow:images-data'));
    } catch (_) {}
}

// Nombre total de trouvailles de la sélection (onglet : jalon jamais atteint).
export function imageFindTotal() {
    return findDayCounts().reduce((total, [, count]) => total + count, 0);
}

// Barre de chronologie : jours où une image planifiée de la page apparaît
// ('in') ou disparaît ('out') — jalons de trouvailles convertis en dates,
// jalon jamais atteint omis. [{ day (dateToDayNumber), kind, name }].
export function getImageScheduleMarks() {
    const marks = [];
    for (const item of drawableItems()) {
        const schedule = scheduleOf(item);
        if (!schedule) continue;
        const bounds = scheduleBounds(schedule, imageFindDate);
        // Sans nom : « Image N » comme la liste de l'onglet (images_ui.js).
        const name = item.name || pkg.t('Image ${n}', { n: pageItems().indexOf(item) + 1 });
        for (const [kind, iso] of [['in', bounds.start], ['out', bounds.end]]) {
            if (!iso || iso === SCHEDULE_UNREACHED) continue;
            const day = isoToDayNumber(iso);
            if (Number.isFinite(day)) marks.push({ day, kind, name });
        }
    }
    return marks;
}

// Cible binaire au jour `day` (numéro de jour, dateToDayNumber) : 1 si
// l'image est dedans, 0 sinon. Les jalons sont convertis en dates.
function scheduleTargetAt(item, day) {
    const schedule = scheduleOf(item);
    if (!schedule || !Number.isFinite(day)) return 1;
    const bounds = scheduleBounds(schedule, imageFindDate);
    if (bounds.start && day < isoToDayNumber(bounds.start)) return 0;
    if (bounds.end && day >= isoToDayNumber(bounds.end)) return 0;
    return 1;
}

// Alpha courante d'une image à l'horloge `now` : interpolation linéaire de
// la transition en cours, bornée ; état instantané (at: null) ou horloge
// absente = la cible déjà atteinte. Sans transition connue : pleine.
function alphaAt(item, now) {
    const state = scheduleStates.get(item.id);
    if (!state) return 1;
    if (state.at == null || !Number.isFinite(now)) return state.to;
    const dur = Math.max(0, Number(state.dur) || 0);
    if (dur <= 0) return state.to;
    const t = Math.max(0, Math.min(1, (now - state.at) / dur));
    return state.from + (state.to - state.from) * t;
}

// Alpha pour le composite vidéo : 1 sans planing ; la transition sinon.
function scheduleAlpha(item, now) {
    return scheduleOf(item) ? alphaAt(item, now) : 1;
}

// Courbes des effets, résolues une fois (cubic-bezier évaluée en JS).
const EFFECT_CURVES = Object.fromEntries(
    Object.entries(IMAGE_EFFECT_EASINGS).map(([effect, points]) => [effect, cubicBezier(...points)]));

// Avancement de l'effet d'entrée/sortie (1 : en place, 0 : caché, au-delà
// pendant un rebond) : la même transition que l'alpha, mais le temps passe
// par la courbe de l'effet — celle de la transition CSS de l'aperçu. Fondu
// seul ou sans planing : 1 (aucune transformation).
function scheduleMotion(item, now) {
    const curve = scheduleOf(item) ? EFFECT_CURVES[item.schedule.effect] : null;
    const state = curve ? scheduleStates.get(item.id) : null;
    if (!state) return 1;
    if (state.at == null || !Number.isFinite(now)) return state.to;
    const dur = Math.max(0, Number(state.dur) || 0);
    if (dur <= 0) return state.to;
    const t = Math.max(0, Math.min(1, (now - state.at) / dur));
    return state.from + (state.to - state.from) * curve(t);
}

// Aperçu : l'opacité CSS du canvas porte le planing — une transition linéaire
// de `dur` ms pendant un fondu, 'none' aux états instantanés. En mode
// édition (onglet Images ouvert au repos, classe posée par syncDragMode) le
// plancher est 30 % : une image masquée reste repérable et déplaçable. Sans
// planing ni état (repos), rien n'est posé : opacité par défaut.
function applyScheduleOpacity(item) {
    const node = nodes.get(item.id);
    if (!node) return;
    const el = node.canvas;
    const state = scheduleOf(item) ? scheduleStates.get(item.id) : null;
    if (!state) {
        if (el.style.transition) el.style.transition = '';
        if (el.style.opacity) el.style.opacity = '';
        if (el.style.transform) el.style.transform = '';
        return;
    }
    const dur = state.at != null ? Math.max(0, Number(state.dur) || 0) : 0;
    const effect = item.schedule.effect;
    el.style.transition = dur > 0
        ? `opacity ${dur}ms linear, transform ${dur}ms ${effectTimingCss(effect)}`
        : 'none';
    // Plancher d'édition seulement au repos : la classe `images-editing`
    // survit au départ de l'animation le temps du MutationObserver — sans la
    // garde, une image masquée par son planing resterait figée à 30 %.
    const editing = host()?.classList.contains('images-editing') === true
        && !(pkg.isAnimationInProgress?.() ?? false);
    el.style.opacity = String(editing ? Math.max(0.3, state.to) : state.to);
    // Effet : l'image cachée attend hors de sa place (bord, échelle) ; la
    // transition CSS la ramène avec la courbe de l'effet. En édition, elle
    // reste à sa place pour être saisie.
    const rect = nodes.get(item.id)?.layout;
    const tf = editing ? null : effectTransform(effect, state.to, rect, containerSize);
    const transform = tf && (tf.dx !== 0 || tf.dy !== 0 || tf.scale !== 1)
        ? `translate(${tf.dx}px, ${tf.dy}px) scale(${tf.scale})`
        : '';
    if (el.style.transform !== transform) el.style.transform = transform;
}

// Re-pose l'opacité du planing sur chaque image : appelée quand le mode
// édition bascule (syncDragMode) — le plancher de 30 % suit la bascule au
// lieu d'attendre la prochaine transition.
export function refreshImageScheduleOpacity() {
    for (const item of pageItems()) applyScheduleOpacity(item);
}

// Jour affiché par l'animation (Date du dernier jour, comme
// accumulateStatsForDates) : lance les fondus dont la cible a changé.
// `now` = horloge des points ; null = saut (aperçu en pause) : instantané.
export function syncImagesToDate(day, now) {
    const dayNumber = dateToDayNumber(day);
    if (!Number.isFinite(dayNumber)) return;
    let changed = false;
    for (const item of pageItems()) {
        const schedule = scheduleOf(item);
        if (!schedule) continue;
        const to = scheduleTargetAt(item, dayNumber);
        const state = scheduleStates.get(item.id);
        if ((state ? state.to : 1) === to) continue;
        const instant = !Number.isFinite(now) || !(schedule.fade > 0);
        scheduleStates.set(item.id, instant
            ? { from: to, to, at: null, dur: schedule.fade }
            : { from: alphaAt(item, now), to, at: now, dur: schedule.fade });
        applyScheduleOpacity(item);
        changed = true;
    }
    // Un basculement instantané (saut, fondu nul) produit une frame sur
    // carte immobile — les fondus en cours passent par la signature alpha.
    if (changed) revision += 1;
}

// Début d'une animation (aperçu, capture image par image, MediaRecorder) :
// état instantané au jour qui précède la date de début — une image qui
// « apparaît » le premier jour démarre son fondu ce jour-là, une image
// déjà dedans est pleine dès la première frame.
export function resetImagesForAnimation(startDate) {
    if (!(startDate instanceof Date)) return;
    const dayBefore = dateToDayNumber(startDate) - 1;
    let changed = false;
    for (const item of pageItems()) {
        const schedule = scheduleOf(item);
        if (!schedule) continue;
        const to = scheduleTargetAt(item, dayBefore);
        scheduleStates.set(item.id, { from: to, to, at: null, dur: schedule.fade });
        applyScheduleOpacity(item);
        changed = true;
    }
    if (changed) revision += 1;
}

// Retour au repos : le planing est ignoré — alphas à 1, transitions et
// opacité posée oubliées.
export function syncImagesToRest() {
    if (scheduleStates.size) {
        scheduleStates.clear();
        revision += 1;
    }
    for (const item of pageItems()) applyScheduleOpacity(item);
}

// Signature des alphas planifiés pour overlayContentSignature : '' quand
// aucune transition n'est en cours ; sinon les alphas quantifiés (16es) à
// l'horloge du dernier composite — suffit à faire dessiner les frames d'un
// fondu sur une carte immobile.
export function getImagesAlphaSignature() {
    const parts = [];
    for (const item of pageItems()) {
        const state = scheduleOf(item) ? scheduleStates.get(item.id) : null;
        if (!state || state.at == null) continue;
        const a = alphaAt(item, lastCompositeNow);
        if (a === state.to) continue;
        // Un effet qui bouge l'image demande des pas plus fins qu'un fondu.
        const motion = item.schedule.effect !== 'fade'
            ? `:${Math.round(scheduleMotion(item, lastCompositeNow) * 64)}` : '';
        parts.push(`${item.id}:${Math.round(a * 16)}${motion}`);
    }
    return parts.join('|');
}

// Résolue quand toutes les images affichées sont décodées (ou en échec),
// au plus tard après `timeoutMs` : une image injoignable ne bloque pas un
// enregistrement. Appelée avant la première frame (mapgl.js). Les images
// de drawableItems seulement (visibleItems exclut le chargement en cours,
// qu'il faut justement attendre) : interrupteur général éteint, base vide
// ou fichier déjà en échec n'attendent rien.
export function imagesReady(timeoutMs = 3000) {
    const pending = drawableItems().map((item) => ensureSource(item.file).promise);
    if (!pending.length) return Promise.resolve(true);
    return Promise.race([
        Promise.all(pending).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
}

// Pour les tests : état observable sans lire les pixels.
export function getImagesSnapshot() {
    ensureLayout();
    return {
        enabled: settings.enabled,
        items: pageItems().map((item) => ({
            id: item.id,
            file: item.file,
            state: imageSourceState(item.file),
            rect: layout.get(item.id) || null,
            schedule: item.schedule ? { ...item.schedule } : null,
            alpha: alphaAt(item, lastCompositeNow),
            motion: scheduleMotion(item, lastCompositeNow),
        })),
    };
}
