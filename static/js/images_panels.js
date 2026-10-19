// Images posées sur la carte (onglet Images) : chargement, mise en page,
// aperçu et vidéo.
//
// - applyImagesSettings() : réglages normalisés (préférence globale
//   `images`), appliqués au chargement (init.js) puis par l'onglet ;
// - un <canvas class="image-panel"> par image dans #mapWithFrames, au-dessus
//   des panneaux de stats et sous le titre et les infos ;
// - addImagePanelsToCanvas() pour les deux pipelines vidéo, entre les stats
//   et les cartouches, à la géométrie de l'aperçu × échelle ;
// - getImagePanelRects() : rects des images, obstacles que les piles de
//   stats contournent (priorité Titre/Infos > Images > Stats) ;
// - imagesReady() : attendue avant le premier enregistrement d'une frame.
//
// Mise en page : layoutPanels de stats_model.mjs (mêmes emplacements, piles,
// marges, position libre), titre et infos en obstacles. Aucun coût par
// frame d'animation : les images ne changent pas pendant la lecture, tout
// est recalculé sur invalidation seulement.

import * as pkg from './index.js';
import { layoutPanels } from './stats_model.mjs';
import { normalizeImagesSettings } from './images_model.mjs';
import { IMAGE_SHADOW, drawImagePanel, imagePanelHeight } from './images_render.mjs';

let settings = normalizeImagesSettings(null);
// Bumpé à chaque changement de réglage ou d'image chargée : clé des dessins.
let revision = 0;

// Fichier → { img, state: 'loading' | 'ready' | 'failed', promise }.
const sources = new Map();
// Id → { canvas, layout, cssKey, drawnKey }.
const nodes = new Map();
// Id → { canvas, key } : rendus hors écran de la vidéo.
const videoCache = new Map();

let layout = new Map();
let layoutDirty = true;
let layoutKey = '';
let containerSize = { width: 0, height: 0 };
let frameRequest = 0;
let resizeObserver = null;

function host() {
    return document.getElementById('mapWithFrames');
}

export function imageUrl(file) {
    return `/api/images/${encodeURIComponent(file)}`;
}

// Décodage d'un fichier, une seule fois par nom (le contenu d'un nom ne
// change jamais). Chargée ou en échec, l'image relance la mise en page : sa
// hauteur dépend de ses proportions.
function ensureSource(file) {
    if (!file || sources.has(file)) return sources.get(file);
    const img = new Image();
    img.decoding = 'async';
    const entry = { img, state: 'loading', promise: null };
    entry.promise = new Promise((resolve) => {
        img.onload = () => {
            entry.state = 'ready';
            resolve(true);
        };
        img.onerror = () => {
            entry.state = 'failed';
            resolve(false);
        };
    }).then((ok) => {
        revision += 1;
        invalidateImagesLayout();
        return ok;
    });
    img.src = imageUrl(file);
    sources.set(file, entry);
    return entry;
}

export function applyImagesSettings(raw) {
    settings = normalizeImagesSettings(raw, settings);
    for (const item of settings.items) ensureSource(item.file);
    revision += 1;
    invalidateImagesLayout();
    return settings;
}

export function getImagesSettings() {
    return settings;
}

// État de chargement d'une image (liste de l'onglet : « image manquante »).
export function imageSourceState(file) {
    if (!file) return 'missing';
    return sources.get(file)?.state || 'loading';
}

// Images dessinées : activées, avec un fichier lisible, base chargée (même
// règle que le titre et les infos, cf. frames.js › syncOverlayVisibility).
function visibleItems() {
    if (!settings.enabled) return [];
    if (!(pkg.hasDatabase?.() ?? true)) return [];
    return settings.items.filter((item) => item.enabled && item.file
        && sources.get(item.file)?.state !== 'failed');
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
    const item = settings.items.find((i) => i.id === id);
    return {
        ...rect,
        mode: item?.position.mode || 'anchor',
        anchor: item?.position.anchor || 'bottom-right',
        container: { ...containerSize },
    };
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
        const key = `${revision}|${bw}|${bh}`;
        if (node.drawnKey !== key) {
            node.canvas.width = bw;
            node.canvas.height = bh;
            const ctx = node.canvas.getContext('2d');
            ctx.clearRect(0, 0, bw, bh);
            drawImagePanel(ctx, bw, bh, item, entry?.state === 'ready' ? entry.img : null, dpr);
            node.drawnKey = key;
        }
    }
}

// Dessine les images sur le canvas d'enregistrement, APRÈS les panneaux de
// stats et AVANT le titre et les infos (même empilement que l'aperçu).
// Géométrie de l'aperçu × scaleFactor, ancrée comme dans le DOM. Chaque image
// est rendue dans un canvas hors écran gardé tant que la révision et la
// taille ne changent pas : une image immobile coûte un drawImage.
export function addImagePanelsToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    ensureLayout();
    for (const item of visibleItems()) {
        const rect = layout.get(item.id);
        const entry = sources.get(item.file);
        // Pas encore décodée : rien plutôt qu'une forme vide (imagesReady est
        // attendue avant l'enregistrement, ce cas reste exceptionnel).
        if (!rect || entry?.state !== 'ready') continue;
        const w = Math.max(1, Math.round(rect.width * scaleFactor));
        const h = Math.max(1, Math.round(rect.height * scaleFactor));
        const x = rect.css.right != null
            ? canvasWidth - Math.round(rect.css.right * scaleFactor) - w
            : Math.round(rect.css.left * scaleFactor);
        const y = rect.css.bottom != null
            ? canvasHeight - Math.round(rect.css.bottom * scaleFactor) - h
            : Math.round(rect.css.top * scaleFactor);
        const key = `${revision}|${w}|${h}`;
        let cached = videoCache.get(item.id);
        if (!cached) {
            cached = { canvas: document.createElement('canvas'), key: '' };
            videoCache.set(item.id, cached);
        }
        if (cached.key !== key) {
            cached.canvas.width = w;
            cached.canvas.height = h;
            const offCtx = cached.canvas.getContext('2d');
            offCtx.clearRect(0, 0, w, h);
            drawImagePanel(offCtx, w, h, item, entry.img, scaleFactor);
            cached.key = key;
        }
        ctx.save();
        if (item.style.shadow) {
            ctx.shadowColor = IMAGE_SHADOW.color;
            ctx.shadowBlur = IMAGE_SHADOW.blur * scaleFactor;
            ctx.shadowOffsetY = IMAGE_SHADOW.offsetY * scaleFactor;
        }
        ctx.drawImage(cached.canvas, x, y);
        ctx.restore();
    }
}

// Résolue quand toutes les images affichées sont décodées (ou en échec),
// au plus tard après `timeoutMs` : une image injoignable ne bloque pas un
// enregistrement. Appelée avant la première frame (mapgl.js).
export function imagesReady(timeoutMs = 3000) {
    const pending = settings.items
        .filter((item) => item.enabled && item.file)
        .map((item) => ensureSource(item.file).promise);
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
        items: settings.items.map((item) => ({
            id: item.id,
            file: item.file,
            state: imageSourceState(item.file),
            rect: layout.get(item.id) || null,
        })),
    };
}
