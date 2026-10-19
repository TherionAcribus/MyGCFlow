// Interactions à la souris des éléments posés sur la carte : déplacement,
// aimantation aux emplacements, poignées de redimensionnement.
//
// Partagé par les panneaux de stats (stats_ui.js) et les images
// (images_ui.js) ; le titre et les infos (infos_editor.js) en reprennent
// l'aimantation et le repère. Le module ne connaît ni les réglages ni leur
// enregistrement : chaque onglet lui fournit des rappels (rect affiché,
// emplacements d'aimantation, aperçu en direct, enregistrement au dépôt).
//
// Comportement commun :
// - glisser = position libre, sauf lâché à moins de SNAP_DISTANCE px de
//   l'emplacement qu'il occuperait dans la pile d'un coin : il y est ancré
//   (repère en pointillés pendant le geste ; Alt maintenue désactive) ;
// - poignées sur les bords QUI BOUGENT quand la taille change (resizeEdges),
//   pour rester sous le pointeur ; en position libre, le coin haut-gauche
//   est épinglé pendant le redimensionnement (pinCorner).

// Largeur des poignées, mesurée depuis les bords de l'élément.
export const RESIZE_GRIP = 14;
// Distance d'aimantation (coin haut-gauche contre coin haut-gauche).
export const SNAP_DISTANCE = 48;

// Bords qui portent les poignées : ceux qui bougent quand la taille change.
// Ancré à droite (en bas), l'élément grandit vers la gauche (le haut) :
// poignée sur ce bord, delta du pointeur inversé. Centré (colonne centrale,
// ligne médiane), il grandit des deux côtés : poignée à droite (en bas),
// delta doublé. Libre : bords droit et bas, le coin haut-gauche épinglé.
export function resizeEdges(rect) {
    const [vertical, horizontal] = rect.mode === 'free'
        ? ['top', 'left']
        : String(rect.anchor || 'top-left').split('-');
    return {
        h: horizontal === 'right'
            ? { side: 'left', factor: -1 }
            : { side: 'right', factor: horizontal === 'center' ? 2 : 1 },
        v: vertical === 'bottom'
            ? { side: 'top', factor: -1 }
            : { side: 'bottom', factor: vertical === 'middle' ? 2 : 1 },
    };
}

// Emplacement le plus proche à moins de SNAP_DISTANCE px, ou null.
export function nearestSnapTarget(targets, left, top) {
    let best = null;
    let bestDistance = SNAP_DISTANCE;
    for (const target of targets || []) {
        const distance = Math.hypot(target.x - left, target.y - top);
        if (distance <= bestDistance) {
            best = target;
            bestDistance = distance;
        }
    }
    return best;
}

// Repère de destination : contour à l'emplacement exact que prendra
// l'élément s'il est lâché là. Un nœud par appelant, créé à la demande.
// `className` : classes CSS (« panel-snap-ghost » + une classe propre).
export function createSnapGhost(host, className) {
    let ghost = null;
    return {
        show(target) {
            if (!target) {
                if (ghost) ghost.hidden = true;
                return;
            }
            if (!ghost) {
                ghost = document.createElement('div');
                ghost.className = className;
                ghost.setAttribute('aria-hidden', 'true');
                host.appendChild(ghost);
            }
            ghost.dataset.anchor = target.anchor;
            Object.assign(ghost.style, {
                left: `${Math.round(target.x)}px`,
                top: `${Math.round(target.y)}px`,
                width: `${Math.round(target.width)}px`,
                height: `${Math.round(target.height)}px`,
            });
            ghost.hidden = false;
        },
        hide() {
            if (ghost) ghost.hidden = true;
        },
    };
}

// Axes redimensionnables au point (x, y) : 'resize-w' sur la poignée de
// largeur, 'resize-h' sur celle de hauteur (si l'élément l'offre),
// 'resize-both' au coin qu'elles partagent, 'move' partout ailleurs.
function dragModeFor(box, edges, resizableHeight, x, y) {
    const nearH = edges.h.side === 'right'
        ? x >= box.right - RESIZE_GRIP
        : x <= box.left + RESIZE_GRIP;
    const nearV = resizableHeight && (edges.v.side === 'bottom'
        ? y >= box.bottom - RESIZE_GRIP
        : y <= box.top + RESIZE_GRIP);
    if (nearH && nearV) return 'resize-both';
    if (nearH) return 'resize-w';
    if (nearV) return 'resize-h';
    return 'move';
}

// Coin haut-gauche ou bas-droit : nwse ; les deux autres : nesw.
const diagonalNesw = (edges) => (edges.h.side === 'right') !== (edges.v.side === 'bottom');

const cursorFor = (mode, edges) => ({
    move: 'grab',
    'resize-w': 'ew-resize',
    'resize-h': 'ns-resize',
    'resize-both': diagonalNesw(edges) ? 'nesw-resize' : 'nwse-resize',
})[mode];

const STATE_CLASSES = ['is-dragging', 'is-resizing', 'is-resizing-h', 'is-resizing-both', 'is-resizing-nesw'];

// Branche le glisser-déposer sur `host` (#mapWithFrames) pour les éléments
// `selector`, actifs tant que `host` porte `editingClass`.
//
// Rappels (id = identifiant de l'élément, lu par `idOf`) :
// - getRect(id) → { x, y, width, height, mode, anchor, container,
//   resizableHeight } (px CSS, repère du conteneur), ou null ;
// - getSnapTargets(id) → [{ anchor, x, y, width, height }] ;
// - previewPosition(id, x, y) / previewWidth(id, w) / previewHeight(id, h) :
//   aperçu en direct, sans enregistrement ;
// - pinCorner(id) / unpinCorner() : épingle du coin haut-gauche (libre) ;
// - onGrab(id) : sélection de l'élément saisi ;
// - commitFree(id, x, y), commitSnap(id, anchor), commitResize(id, patch) :
//   enregistrement au dépôt ;
// - onRelease() : fin de geste (formulaire à resynchroniser) ;
// - isBusy() : vrai pendant une animation (aucune saisie).
export function bindPanelDrag(options) {
    const {
        host, selector, idOf, editingClass, ghostClass,
        getRect, getSnapTargets = () => [],
        previewPosition, previewWidth, previewHeight,
        pinCorner = () => {}, unpinCorner = () => {},
        onGrab = () => {}, onRelease = () => {},
        commitFree, commitSnap, commitResize,
        isBusy = () => false,
    } = options;
    if (!host) return;
    const ghost = createSnapGhost(host, ghostClass);
    let drag = null;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    // Position libre : fraction de l'espace restant du cadre.
    const positionFor = (event) => {
        const left = event.clientX - drag.base.left - drag.offsetX;
        const top = event.clientY - drag.base.top - drag.offsetY;
        const freeW = drag.container.width - drag.width;
        const freeH = drag.container.height - drag.height;
        return {
            x: freeW > 0 ? clamp01(left / freeW) : 0,
            y: freeH > 0 ? clamp01(top / freeH) : 0,
        };
    };

    host.addEventListener('pointerdown', (event) => {
        const el = event.target.closest?.(selector);
        if (!el || el.parentElement !== host || event.button !== 0 || !host.classList.contains(editingClass)) return;
        if (isBusy()) return;
        const id = idOf(el);
        const rect = getRect(id);
        if (!rect) return;
        const base = host.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const edges = resizeEdges(rect);
        const mode = dragModeFor(box, edges, rect.resizableHeight !== false, event.clientX, event.clientY);
        drag = {
            id,
            el,
            pointerId: event.pointerId,
            base,
            mode,
            edges,
            offsetX: mode === 'move' ? event.clientX - base.left - rect.x : 0,
            offsetY: mode === 'move' ? event.clientY - base.top - rect.y : 0,
            startClientX: event.clientX,
            startClientY: event.clientY,
            // Taille de départ : celle affichée, automatique ou imposée.
            startWidth: box.width,
            startHeight: box.height,
            width: rect.width,
            height: rect.height,
            container: rect.container,
            last: null,
            lastWidth: null,
            lastHeight: null,
            // Emplacements d'aimantation, calculés une fois pour le geste.
            targets: mode === 'move' ? (getSnapTargets(id) || []) : [],
            snap: null,
        };
        el.setPointerCapture?.(event.pointerId);
        // Le curseur en ligne posé au survol cède la place à la classe.
        el.style.cursor = '';
        el.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing');
        if (mode === 'resize-h') el.classList.add('is-resizing-h');
        else if (mode === 'resize-both') {
            el.classList.add('is-resizing-both');
            if (diagonalNesw(edges)) el.classList.add('is-resizing-nesw');
        }
        if (mode !== 'move' && rect.mode === 'free') pinCorner(id);
        event.preventDefault();
        onGrab(id);
    });

    host.addEventListener('pointermove', (event) => {
        if (!drag) {
            // Survol hors glisser : le curseur annonce les poignées (curseur
            // en ligne — le CSS ne connaît pas la position du pointeur).
            const el = event.target?.closest?.(selector);
            if (el && el.parentElement === host && host.classList.contains(editingClass)) {
                const rect = getRect(idOf(el));
                if (rect) {
                    const edges = resizeEdges(rect);
                    el.style.cursor = cursorFor(dragModeFor(el.getBoundingClientRect(), edges,
                        rect.resizableHeight !== false, event.clientX, event.clientY), edges);
                } else {
                    el.style.cursor = 'grab';
                }
            }
            return;
        }
        if (event.pointerId !== drag.pointerId) return;
        if (drag.mode !== 'move') {
            // Aperçu en direct de la taille : le delta suit le bord saisi
            // (inversé à gauche/en haut, doublé si centré sur cet axe).
            if (drag.mode !== 'resize-h') {
                drag.lastWidth = drag.startWidth + (event.clientX - drag.startClientX) * drag.edges.h.factor;
                previewWidth(drag.id, drag.lastWidth);
            }
            if (drag.mode !== 'resize-w') {
                drag.lastHeight = drag.startHeight + (event.clientY - drag.startClientY) * drag.edges.v.factor;
                previewHeight(drag.id, drag.lastHeight);
            }
            return;
        }
        drag.last = positionFor(event);
        previewPosition(drag.id, drag.last.x, drag.last.y);
        // L'élément suit le pointeur ; le repère montre où il se rangera.
        const left = drag.last.x * Math.max(0, drag.container.width - drag.width);
        const top = drag.last.y * Math.max(0, drag.container.height - drag.height);
        drag.snap = event.altKey ? null : nearestSnapTarget(drag.targets, left, top);
        ghost.show(drag.snap);
    });

    const end = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const done = drag;
        drag = null;
        done.el.classList.remove(...STATE_CLASSES);
        // Les x/y recalculés pendant un redimensionnement libre sont déjà
        // dans les réglages (écrits en place) : le commit les reprend.
        unpinCorner();
        if (done.mode !== 'move') {
            const patch = {};
            if (done.lastWidth != null) patch.width = done.lastWidth;
            if (done.lastHeight != null) patch.height = done.lastHeight;
            if (Object.keys(patch).length) commitResize(done.id, patch);
        } else if (done.snap) {
            commitSnap(done.id, done.snap.anchor);
        } else if (done.last) {
            commitFree(done.id, done.last.x, done.last.y);
        }
        ghost.hide();
        onRelease();
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
}
