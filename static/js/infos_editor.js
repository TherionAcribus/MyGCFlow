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
// En mode simple, le panneau Position remplace les champs CSS bruts par un
// sélecteur d'ancrage par coin (#gcCssAnchor, `.infos-simple-only`) qui écrit
// position:absolute + les deux propriétés du coin choisi dans le même modèle.
//
// Le choix est une préférence d'interface persistée en localStorage
// (infosEditorMode) — pas une option de profil.

import { changeTitleCssValues, changeInfosCssValues } from './frames.js';

const MODE_KEY = 'infosEditorMode';
const MODE_SIMPLE = 'simple';
const MODE_ADVANCED = 'advanced';

// Coin → propriétés CSS écrites (verticale puis horizontale).
const ANCHOR_PROPS = {
    'top-left': ['top', 'left'],
    'top-right': ['top', 'right'],
    'bottom-left': ['bottom', 'left'],
    'bottom-right': ['bottom', 'right'],
};
const BOX_PROPS = ['top', 'right', 'bottom', 'left'];

// Ancrage fourni par la feuille par défaut quand le profil ne le redéfinit pas
// (static/css/titre.css → #titleFrame, static/css/infos.css → #infosFrame) :
// position:absolute + les deux côtés à 10px. Le style inline de la frame est
// remplacé en bloc par le CSS du profil, mais ces propriétés de la feuille
// restent effectives tant qu'elles ne sont pas surchargées — d'où la fusion.
const STYLESHEET_SIDES = {
    title: { top: true, left: true },
    infos: { top: true, right: true },
};
const STYLESHEET_MARGIN = '10';

function pxNumber(value) {
    const m = (value || '').match(/(-?\d+(?:\.\d+)?)\s*px/i);
    return m ? m[1] : null;
}

export function initInfosEditor() {
    const root = document.getElementById('gcCssAssistant');
    const btnSimple = document.getElementById('infosModeSimple');
    const btnAdvanced = document.getElementById('infosModeAdvanced');
    // Page sans l'assistant (ou gabarit partiel) : rien à faire.
    if (!root || !btnSimple || !btnAdvanced) return;

    const cbCssRaw = document.getElementById('gcCssAdvancedMode');
    const anchorSelect = document.getElementById('gcCssAnchor');

    // Cible active de l'assistant : déduite de l'onglet (initCssAssistant
    // garde sa variable activeTarget privée, le DOM reflète le même état).
    function activeTarget() {
        return document.getElementById('gcCssTargetInfos')?.classList.contains('active')
            ? 'infos'
            : 'title';
    }
    function cssTextarea() {
        return document.getElementById(activeTarget() === 'infos' ? 'inputInfosCss' : 'inputTitleCss');
    }
    function cssProbe() {
        const probe = document.createElement('div');
        probe.style.cssText = cssTextarea()?.value || '';
        return probe;
    }

    // Coin d'ancrage effectif : CSS du profil (textarea) fusionné avec les
    // côtés posés par la feuille par défaut. Le style calculé n'est pas
    // exploitable — il résout 'auto' en pixels dès que la frame est affichée.
    // '' si le réglage n'est pas un ancrage simple (position non absolue/fixe,
    // combinaison de côtés hors coin).
    function detectAnchor() {
        const s = cssProbe().style;
        const defaults = STYLESHEET_SIDES[activeTarget()] || {};
        const pos = s.getPropertyValue('position') || 'absolute'; // feuille par défaut
        if (pos !== 'absolute' && pos !== 'fixed') return '';
        const has = (p) => {
            const v = s.getPropertyValue(p);
            return v ? v.trim() !== 'auto' : defaults[p] === true;
        };
        const t = has('top'), r = has('right'), b = has('bottom'), l = has('left');
        if (t && l && !r && !b) return 'top-left';
        if (t && r && !l && !b) return 'top-right';
        if (b && l && !t && !r) return 'bottom-left';
        if (b && r && !t && !l) return 'bottom-right';
        return '';
    }

    function syncAnchorSelect() {
        if (anchorSelect) anchorSelect.value = detectAnchor();
    }

    // Écrit l'ancrage dans le CSS de la cible active, en conservant les marges
    // effectives (un déplacement Haut gauche → Bas droite garde les 10px
    // actuels — feuille par défaut ou profil — au lieu d'une valeur arbitraire).
    function applyAnchor(anchor) {
        const props = ANCHOR_PROPS[anchor];
        const textarea = cssTextarea();
        if (!props || !textarea) return; // '' = « Personnalisé » : lecture seule
        const style = cssProbe().style;
        const defaults = STYLESHEET_SIDES[activeTarget()] || {};
        const margin = (prop) => pxNumber(style.getPropertyValue(prop))
            ?? (defaults[prop] ? STYLESHEET_MARGIN : null);
        const vMargin = margin('top') ?? margin('bottom') ?? STYLESHEET_MARGIN;
        const hMargin = margin('left') ?? margin('right') ?? STYLESHEET_MARGIN;
        style.setProperty('position', 'absolute');
        BOX_PROPS.forEach((p) => style.removeProperty(p));
        style.setProperty(props[0], `${vMargin}px`);
        style.setProperty(props[1], `${hMargin}px`);
        // change*CssValues applique à la frame, nettoie (sanitizeOverlayCss) et
        // réécrit le textarea — le même pipeline que les champs du formulaire.
        const apply = activeTarget() === 'infos' ? changeInfosCssValues : changeTitleCssValues;
        const applied = apply(style.cssText);
        textarea.value = typeof applied === 'string' ? applied : style.cssText;
        // Resynchronise les champs visibles (top/right/… en mode avancé).
        window.gcCssAssistantSyncFromTextareas?.();
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
        if (simple) syncAnchorSelect();
    }

    btnSimple.addEventListener('click', () => setMode(MODE_SIMPLE));
    btnAdvanced.addEventListener('click', () => setMode(MODE_ADVANCED));
    anchorSelect?.addEventListener('change', () => applyAnchor(anchorSelect.value));

    // L'assistant resynchronise ses champs sans passer par le hook window sur
    // les changements d'onglet : recalculer l'ancrage après chaque bascule de
    // cible et à chaque ouverture du panneau Position. Les listeners de
    // l'assistant sont attachés avant ce module (ordre des imports de
    // index.js), donc leur handler s'exécute d'abord et le textarea est à jour.
    ['gcCssTargetTitle', 'gcCssTargetInfos', 'gcCssTabPosition'].forEach((id) => {
        document.getElementById(id)?.addEventListener('click', () => {
            requestAnimationFrame(syncAnchorSelect);
        });
    });

    // Chargement de profil / CSS par défaut : l'assistant prévient via ce hook
    // (cf. profiles.js applyInfosCss, ui.js beginOverlayCssDefaultsLoad). On
    // l'enveloppe plutôt que de le remplacer pour rester compatible avec un
    // éventuel autre consommateur.
    const previousSync = window.gcCssAssistantSyncFromTextareas;
    window.gcCssAssistantSyncFromTextareas = function () {
        previousSync?.();
        syncAnchorSelect();
    };

    let saved = MODE_SIMPLE;
    try {
        if (localStorage.getItem(MODE_KEY) === MODE_ADVANCED) saved = MODE_ADVANCED;
    } catch (_) {}
    setMode(saved, { persist: false });
}

// Les modules sont différés : le DOM est prêt à l'évaluation, comme pour
// initUIElements dans ui.js. Le garde-fou reste pour un éventuel usage hors
// bundle.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInfosEditor);
} else {
    initInfosEditor();
}
