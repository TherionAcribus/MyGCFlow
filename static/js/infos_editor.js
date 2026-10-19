// Mode « Simple / Avancé » de l'assistant « Titre et informations »
// (templates/menu_informations.html).
//
// Le formulaire de l'assistant (initCssAssistant dans ui.js) expose tous les
// champs CSS : couleurs, police, boîte, ombre et positionnement brut
// (top/right/bottom/left, z-index, position relative/absolute/fixed). Ce module
// ajoute un toggle qui se contente de masquer les champs marqués
// `.infos-advanced` via une classe sur #gcCssAssistant — les inputs restent
// dans le DOM, leurs handlers restent branchés et synchronisent toujours le
// même modèle (les textareas #inputTitleCss / #inputInfosCss appliqués aux
// frames par changeTitleCssValues / changeInfosCssValues).
//
// En mode simple, le panneau Position remplace les champs CSS bruts par la
// même grille d'emplacements et les mêmes marges que les panneaux de stats
// (overlay_anchor.mjs : lignes haute et basse), écrites dans le même modèle.
//
// Glisser-déposer : tant que le sous-onglet Style › Titres est ouvert et
// qu'aucune animation ne tourne, le titre et les infos se saisissent sur la
// carte, avec la même aimantation que les panneaux de stats.
//
// Le choix Simple/Avancé est une préférence d'interface persistée en
// localStorage (infosEditorMode) — pas une option de profil.

import * as pkg from './index.js';
import { changeTitleCssValues, changeInfosCssValues } from './frames.js';
import { createSnapGhost, nearestSnapTarget } from './panel_interactions.js';
import {
    OVERLAY_ANCHORS,
    OVERLAY_DEFAULT_MARGIN,
    detectOverlayAnchor,
    overlayAnchorPatch,
    overlayAnchorRect,
    overlayFreePatch,
} from './overlay_anchor.mjs';

const MODE_KEY = 'infosEditorMode';
const MODE_SIMPLE = 'simple';
const MODE_ADVANCED = 'advanced';

// Côtés fixés par la feuille par défaut quand le profil ne les redéfinit pas
// (static/css/titre.css → #titleFrame, static/css/infos.css → #infosFrame).
// Le style inline de la frame est remplacé en bloc par le CSS du profil, mais
// ces propriétés de la feuille restent effectives tant qu'elles ne sont pas
// surchargées — d'où la fusion (et les `auto` d'overlayAnchorPatch).
const STYLESHEET_SIDES = {
    title: { top: OVERLAY_DEFAULT_MARGIN, left: OVERLAY_DEFAULT_MARGIN },
    infos: { top: OVERLAY_DEFAULT_MARGIN, right: OVERLAY_DEFAULT_MARGIN },
};
// Propriétés lues pour reconnaître un emplacement.
const POSITION_PROPS = ['position', 'top', 'right', 'bottom', 'left', 'margin-left', 'margin-right', 'width'];
const FRAME_IDS = { title: 'titleFrame', infos: 'infosFrame' };

// En deçà, un appui n'est pas un glisser : rien n'est écrit.
const DRAG_THRESHOLD = 3;

function textareaFor(target) {
    return document.getElementById(target === 'infos' ? 'inputInfosCss' : 'inputTitleCss');
}

function probeFor(target) {
    const probe = document.createElement('div');
    probe.style.cssText = textareaFor(target)?.value || '';
    return probe;
}

function declarationsOf(probe) {
    const decl = {};
    for (const prop of POSITION_PROPS) decl[prop] = probe.style.getPropertyValue(prop);
    return decl;
}

// Emplacement et marges du CSS de la cible, ou null (CSS personnalisé).
export function overlayAnchorOf(target) {
    return detectOverlayAnchor(declarationsOf(probeFor(target)), STYLESHEET_SIDES[target] || {});
}

// Applique un patch d'overlay_anchor.mjs au CSS de la cible : même pipeline
// que les champs du formulaire (change*CssValues nettoie, applique à la frame
// et réécrit le textarea), puis l'assistant se resynchronise. `change` sur le
// textarea : il est dans l'onglet Style, le suivi des modifications du thème
// (profiles.js) le voit — un dépôt sur la carte n'émet sinon aucun événement
// de formulaire.
function applyPatch(target, patch) {
    const textarea = textareaFor(target);
    if (!patch || !textarea) return;
    const probe = probeFor(target);
    for (const prop of patch.remove) probe.style.removeProperty(prop);
    for (const [prop, value] of Object.entries(patch.set)) probe.style.setProperty(prop, value);
    const apply = target === 'infos' ? changeInfosCssValues : changeTitleCssValues;
    const applied = apply(probe.style.cssText);
    textarea.value = typeof applied === 'string' ? applied : probe.style.cssText;
    window.gcCssAssistantSyncFromTextareas?.();
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

export function initInfosEditor() {
    const root = document.getElementById('gcCssAssistant');
    const btnSimple = document.getElementById('infosModeSimple');
    const btnAdvanced = document.getElementById('infosModeAdvanced');
    // Page sans l'assistant (ou gabarit partiel) : rien à faire.
    if (!root || !btnSimple || !btnAdvanced) return;

    const cbCssRaw = document.getElementById('gcCssAdvancedMode');
    const anchorRadios = [...document.querySelectorAll('input[name="overlayAnchor"]')];
    const marginX = document.getElementById('gcCssMarginX');
    const marginY = document.getElementById('gcCssMarginY');
    const customHint = document.getElementById('gcCssAnchorCustom');

    // Cible active de l'assistant : déduite de l'onglet (initCssAssistant
    // garde sa variable activeTarget privée, le DOM reflète le même état).
    function activeTarget() {
        return document.getElementById('gcCssTargetInfos')?.classList.contains('active')
            ? 'infos'
            : 'title';
    }

    // Grille et marges reflètent le CSS de la cible. Aucun emplacement coché
    // si le CSS n'en décrit aucun : les marges sont alors grisées.
    function syncAnchorControls() {
        const found = overlayAnchorOf(activeTarget());
        for (const radio of anchorRadios) radio.checked = !!found && radio.value === found.anchor;
        const setMargin = (input, value, disabled) => {
            if (!input) return;
            input.disabled = disabled;
            if (document.activeElement !== input) input.value = value ?? '';
        };
        setMargin(marginX, found && !found.anchor.endsWith('-center') ? found.dx : '', !found || found.anchor.endsWith('-center'));
        setMargin(marginY, found?.dy, !found);
        if (customHint) customHint.hidden = !!found;
    }

    // Change d'emplacement en gardant les marges effectives (un passage Haut
    // gauche → Bas droite garde les 10 px actuels au lieu d'une valeur
    // arbitraire) ; un CSS personnalisé repart des marges par défaut.
    function applyAnchor(anchor, margins = null) {
        const target = activeTarget();
        const current = overlayAnchorOf(target);
        const dx = margins?.dx ?? current?.dx ?? OVERLAY_DEFAULT_MARGIN;
        const dy = margins?.dy ?? current?.dy ?? OVERLAY_DEFAULT_MARGIN;
        applyPatch(target, overlayAnchorPatch(anchor, { dx, dy }, declarationsOf(probeFor(target))));
        syncAnchorControls();
    }

    function onMarginInput() {
        const current = overlayAnchorOf(activeTarget());
        if (!current) return;
        const read = (input, fallback) => {
            const value = Number(input?.value);
            return input?.value !== '' && Number.isFinite(value) ? Math.max(0, Math.min(2000, value)) : fallback;
        };
        applyAnchor(current.anchor, { dx: read(marginX, current.dx), dy: read(marginY, current.dy) });
    }

    function setMode(mode, { persist = true } = {}) {
        const simple = mode !== MODE_ADVANCED;
        root.classList.toggle('editor-simple', simple);
        root.classList.toggle('editor-advanced', !simple);
        btnSimple.classList.toggle('active', simple);
        btnAdvanced.classList.toggle('active', !simple);
        btnSimple.setAttribute('aria-pressed', String(simple));
        btnAdvanced.setAttribute('aria-pressed', String(!simple));
        // L'éditeur CSS brut est un réglage avancé : revenir en simple avec le
        // CSS ouvert laisserait un panneau vide de champs — on le referme
        // proprement via son propre handler (restaure onglets et panes).
        if (simple && cbCssRaw?.checked) {
            cbCssRaw.checked = false;
            cbCssRaw.dispatchEvent(new Event('change'));
        }
        if (persist) {
            try { localStorage.setItem(MODE_KEY, simple ? MODE_SIMPLE : MODE_ADVANCED); } catch (_) {}
        }
        if (simple) syncAnchorControls();
    }

    btnSimple.addEventListener('click', () => setMode(MODE_SIMPLE));
    btnAdvanced.addEventListener('click', () => setMode(MODE_ADVANCED));
    for (const radio of anchorRadios) {
        radio.addEventListener('change', () => {
            if (radio.checked) applyAnchor(radio.value);
        });
    }
    marginX?.addEventListener('input', onMarginInput);
    marginY?.addEventListener('input', onMarginInput);

    // L'assistant resynchronise ses champs sans passer par le hook window sur
    // les changements d'onglet : recalculer l'ancrage après chaque bascule de
    // cible et à chaque ouverture du panneau Position. Les listeners de
    // l'assistant sont attachés avant ce module (ordre des imports de
    // index.js), donc leur handler s'exécute d'abord et le textarea est à jour.
    ['gcCssTargetTitle', 'gcCssTargetInfos', 'gcCssTabPosition'].forEach((id) => {
        document.getElementById(id)?.addEventListener('click', () => {
            requestAnimationFrame(syncAnchorControls);
        });
    });

    // Chargement de profil / CSS par défaut : l'assistant prévient via ce hook
    // (cf. profiles.js applyInfosCss, ui.js beginOverlayCssDefaultsLoad). On
    // l'enveloppe plutôt que de le remplacer pour rester compatible avec un
    // éventuel autre consommateur.
    const previousSync = window.gcCssAssistantSyncFromTextareas;
    window.gcCssAssistantSyncFromTextareas = function () {
        previousSync?.();
        syncAnchorControls();
    };

    let saved = MODE_SIMPLE;
    try {
        if (localStorage.getItem(MODE_KEY) === MODE_ADVANCED) saved = MODE_ADVANCED;
    } catch (_) {}
    setMode(saved, { persist: false });

    bindOverlayDrag();
}

// ---------------------------------------------------------------------------
// Glisser-déposer du titre et des infos sur la carte
// ---------------------------------------------------------------------------

// Mode édition : sous-onglet Style › Titres ouvert, aucune animation. La
// classe rend les cartouches saisissables (ui_improvements.css), comme
// `stats-editing` pour les panneaux.
function syncOverlayDragMode() {
    const host = document.getElementById('mapWithFrames');
    if (!host) return;
    const open = !!document.getElementById('style')?.classList.contains('active')
        && !!document.getElementById('tabTitles')?.classList.contains('active');
    const idle = !(pkg.isAnimationInProgress?.() ?? false);
    host.classList.toggle('overlay-editing', open && idle);
}

function containerRelativeRect(el, base) {
    const r = el.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
}

function overlaps(a, b) {
    return !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Emplacements d'aimantation : chaque emplacement de la grille, aux marges
// actuelles du cartouche, sauf ceux qui recouvriraient l'autre cartouche.
function snapTargetsFor(target, size, container, base) {
    const current = overlayAnchorOf(target);
    const margins = { dx: current?.dx ?? OVERLAY_DEFAULT_MARGIN, dy: current?.dy ?? OVERLAY_DEFAULT_MARGIN };
    const otherEl = document.getElementById(FRAME_IDS[target === 'title' ? 'infos' : 'title']);
    const other = otherEl && getComputedStyle(otherEl).display !== 'none'
        ? containerRelativeRect(otherEl, base)
        : null;
    return OVERLAY_ANCHORS
        .map((anchor) => ({ ...overlayAnchorRect(anchor, margins, size, container), margins }))
        .filter((rect) => !overlaps(rect, other));
}

// La géométrie des cartouches a bougé : les piles de stats qui les
// contournent et le cache des overlays vidéo se recalculent.
function overlayGeometryChanged() {
    try { pkg.invalidateStatsLayout?.(); } catch (_) {}
    try { pkg.invalidateImagesLayout?.(); } catch (_) {}
    try { pkg.invalidateOverlayCache?.(); } catch (_) {}
}

function bindOverlayDrag() {
    const host = document.getElementById('mapWithFrames');
    if (!host) return;
    let drag = null;
    // Repère de destination, même rendu que celui des panneaux et des images.
    const ghost = createSnapGhost(host, 'panel-snap-ghost overlay-snap-ghost');

    host.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !host.classList.contains('overlay-editing')) return;
        if (pkg.isAnimationInProgress?.()) return;
        const el = event.target.closest?.('#titleFrame, #infosFrame');
        if (!el || el.parentElement !== host) return;
        const target = el.id === 'infosFrame' ? 'infos' : 'title';
        // Le formulaire suit le cartouche saisi.
        const tab = document.getElementById(target === 'infos' ? 'gcCssTargetInfos' : 'gcCssTargetTitle');
        if (tab && !tab.classList.contains('active')) tab.click();
        const base = host.getBoundingClientRect();
        const rect = containerRelativeRect(el, base);
        const container = { width: base.width, height: base.height };
        drag = {
            el,
            target,
            pointerId: event.pointerId,
            base,
            container,
            size: { width: rect.width, height: rect.height },
            offsetX: event.clientX - base.left - rect.x,
            offsetY: event.clientY - base.top - rect.y,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            left: rect.x,
            top: rect.y,
            snap: null,
            targets: snapTargetsFor(target, { width: rect.width, height: rect.height }, container, base),
        };
        el.setPointerCapture?.(event.pointerId);
        el.classList.add('is-dragging');
        event.preventDefault();
    });

    host.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.moved = true;
        const { container, size } = drag;
        drag.left = Math.max(0, Math.min(container.width - size.width, event.clientX - drag.base.left - drag.offsetX));
        drag.top = Math.max(0, Math.min(container.height - size.height, event.clientY - drag.base.top - drag.offsetY));
        // Aperçu en direct, en ligne sur la frame : le CSS du thème n'est
        // réécrit qu'au dépôt (un seul passage dans l'assistant).
        Object.assign(drag.el.style, {
            position: 'absolute',
            left: `${Math.round(drag.left)}px`,
            top: `${Math.round(drag.top)}px`,
            right: 'auto',
            bottom: 'auto',
            marginLeft: '0px',
            marginRight: '0px',
        });
        drag.snap = event.altKey ? null : nearestSnapTarget(drag.targets, drag.left, drag.top);
        ghost.show(drag.snap);
        overlayGeometryChanged();
    });

    const end = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const { el, target, moved, snap, left, top, size, container } = drag;
        drag = null;
        el.classList.remove('is-dragging');
        ghost.hide();
        if (!moved) return;
        const decl = declarationsOf(probeFor(target));
        applyPatch(target, snap
            ? overlayAnchorPatch(snap.anchor, snap.margins, decl)
            : overlayFreePatch(left, top, size, container, decl));
        overlayGeometryChanged();
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);

    document.addEventListener('shown.bs.tab', syncOverlayDragMode);
    document.addEventListener('hidden.bs.tab', syncOverlayDragMode);
    const controlBar = document.getElementById('controlBar');
    if (controlBar && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncOverlayDragMode)
            .observe(controlBar, { attributes: true, attributeFilter: ['data-playback-state'] });
    }
    syncOverlayDragMode();
}

// Les modules sont différés : le DOM est prêt à l'évaluation, comme pour
// initUIElements dans ui.js. Le garde-fou reste pour un éventuel usage hors
// bundle.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInfosEditor);
} else {
    initInfosEditor();
}
