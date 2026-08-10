/* =====================================================================
   ui_bootstrap.js — Couche d'abstraction pour les APIs Bootstrap/Tabler
   ---------------------------------------------------------------------
   Centralise l'initialisation des composants UI Tabler/Bootstrap.

   Exporte des fonctions prêtes à l'emploi :
     - initBsTabs(selector?)
     - initBsModals(selector?)
     - initBsTooltips(selector?)
     - initBsDropdowns(selector?)
     - initTomSelect(selector, options?)
     - destroyTomSelect(instance)
     - initTempusDominus(selector, options?)
     - destroyTempusDominus(instance)
     - getBsModal(element)
     - getBsTab(element)
     - showBsModal(idOrElement)
     - hideBsModal(idOrElement)
     - showBsTab(idOrElement)
     - icon(name) — helper Tabler Icons

   Les APIs Bootstrap 5 sont exposées via window.bootstrap (fourni par
   le bundle tabler.min.js qui inclut Bootstrap 5).
   ===================================================================== */

/* --- Helper pour récupérer l'objet bootstrap (servi depuis static/vendor/) ---
   Tabler Core 1.4.0 embarque le bundle Bootstrap 5 mais ne l'expose PAS
   sous window.bootstrap : il le publie sous window.tabler (dont les clés
   sont directement Modal/Tooltip/Dropdown/Tab...) et window.tabler.bootstrap.
   Sans ce repli, tous les appels programmatiques (showBsModal, initBsTabs...)
   tombaient sur null et ne faisaient rien — d'où les modales (ex: "Nouveau
   profil") qui ne s'ouvraient pas alors que les composants déclaratifs
   (data-bs-toggle) fonctionnaient via la data-api interne de Tabler. */
function bs() {
    const candidate = window.bootstrap
        || (window.tabler && window.tabler.bootstrap)
        || (window.tabler && window.tabler.Modal ? window.tabler : null);
    if (!candidate) {
        console.warn('[ui_bootstrap] Bootstrap indisponible — tabler.min.js est-il chargé ?');
        return null;
    }
    return candidate;
}

/* --- Helper pour récupérer Tom Select (servi depuis static/vendor/) --- */
function tsLib() {
    if (typeof window.TomSelect === 'undefined') {
        console.warn('[ui_bootstrap] window.TomSelect indisponible — tom-select.complete.min.js est-il chargé ?');
        return null;
    }
    return window.TomSelect;
}

/* --- Helper pour récupérer Tempus Dominus (servi depuis static/vendor/) --- */
function tdLib() {
    // Tempus Dominus expose tempusDominus sur window
    if (typeof window.tempusDominus === 'undefined') {
        console.warn('[ui_bootstrap] window.tempusDominus indisponible — tempus-dominus.min.js est-il chargé ?');
        return null;
    }
    return window.tempusDominus;
}

/* =====================================================================
   Tabs Bootstrap 5
   ===================================================================== */

/**
 * Initialise les tabs Bootstrap 5.
 * @param {string} selector - sélecteur CSS des .nav-tabs (défaut: '.nav-tabs')
 */
export function initBsTabs(selector = '.nav-tabs') {
    const b = bs();
    if (!b) return;
    document.querySelectorAll(selector).forEach(tablist => {
        tablist.querySelectorAll('[data-bs-toggle="tab"], [data-bs-toggle="pill"]').forEach(el => {
            try { b.Tab.getOrCreateInstance(el); } catch (e) { /* déjà init */ }
        });
    });
}

/**
 * Récupère ou crée l'instance Tab Bootstrap d'un élément.
 * @param {Element|string} el - élément ou sélecteur
 * @returns {bootstrap.Tab|null}
 */
export function getBsTab(el) {
    const b = bs();
    if (!b) return null;
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) return null;
    return b.Tab.getOrCreateInstance(node);
}

/**
 * Active un tab par son id ou élément.
 * @param {Element|string} el - élément <a> du tab ou sélecteur
 */
export function showBsTab(el) {
    const tab = getBsTab(el);
    if (tab) tab.show();
}

/* =====================================================================
   Modals Bootstrap 5
   ===================================================================== */

/**
 * Initialise les modals Bootstrap 5.
 * @param {string} selector - sélecteur CSS des .modal (défaut: '.modal')
 */
export function initBsModals(selector = '.modal.bs-modal') {
    const b = bs();
    if (!b) return;
    document.querySelectorAll(selector).forEach(node => {
        try { b.Modal.getOrCreateInstance(node); } catch (e) { /* déjà init */ }
    });
}

/**
 * Récupère ou crée l'instance Modal Bootstrap d'un élément.
 * @param {Element|string} el - élément .modal ou sélecteur ou id
 * @returns {bootstrap.Modal|null}
 */
export function getBsModal(el) {
    const b = bs();
    if (!b) return null;
    const node = typeof el === 'string'
        ? (el.startsWith('#') ? document.querySelector(el) : document.getElementById(el))
        : el;
    if (!node) return null;
    // Une modale doit être au niveau <body>. Si elle est imbriquée dans un
    // ancêtre qui crée un contexte d'empilement (position:sticky/fixed,
    // transform, filter, opacity<1...), la modale (z-index ~1055) se retrouve
    // peinte SOUS le backdrop (z-index 1050) : elle apparaît alors "grisée
    // comme le fond". C'est le cas des modales de profil, imbriquées dans
    // .sticky-panel. On les déplace donc en enfant direct de <body> avant de
    // créer l'instance (idempotent : ne fait rien si déjà rattachée au body).
    if (node.parentElement !== document.body) {
        document.body.appendChild(node);
    }
    return b.Modal.getOrCreateInstance(node);
}

/**
 * Ouvre une modal Bootstrap.
 * @param {Element|string} el - élément .modal, id, ou sélecteur
 */
export function showBsModal(el) {
    const modal = getBsModal(el);
    if (modal) modal.show();
}

/**
 * Ferme une modal Bootstrap.
 * @param {Element|string} el - élément .modal, id, ou sélecteur
 */
export function hideBsModal(el) {
    const modal = getBsModal(el);
    if (modal) modal.hide();
}

/* =====================================================================
   Tooltips Bootstrap 5
   ===================================================================== */

/**
 * Initialise les tooltips Bootstrap 5.
 * @param {string} selector - sélecteur (défaut: '[data-bs-toggle="tooltip"]')
 */
export function initBsTooltips(selector = '[data-bs-toggle="tooltip"]') {
    const b = bs();
    if (!b) return;
    document.querySelectorAll(selector).forEach(node => {
        try { b.Tooltip.getOrCreateInstance(node); } catch (e) { /* déjà init */ }
    });
}

/* =====================================================================
   Dropdowns Bootstrap 5
   ===================================================================== */

/**
 * Initialise les dropdowns Bootstrap 5.
 * @param {string} selector - sélecteur (défaut: '[data-bs-toggle="dropdown"]')
 */
export function initBsDropdowns(selector = '[data-bs-toggle="dropdown"]') {
    const b = bs();
    if (!b) return;
    document.querySelectorAll(selector).forEach(node => {
        try { b.Dropdown.getOrCreateInstance(node); } catch (e) { /* déjà init */ }
    });
}

/* =====================================================================
   Tom Select (multi-selects)
   ===================================================================== */

/**
 * Initialise un Tom Select sur un <select>.
 * @param {Element|string} el - élément <select> ou sélecteur
 * @param {object} options - options Tom Select (mergées avec les valeurs par défaut)
 * @returns {TomSelect|null}
 */
export function initTomSelect(el, options = {}) {
    const TS = tsLib();
    if (!TS) return null;
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) return null;

    const defaults = {
        plugins: ['remove_button'],
        maxItems: null,
        hideSelected: false,
        hidePlaceholder: true,
        closeAfterSelect: false,
        placeholder: node.dataset.placeholder || '',
        searchField: ['text'],
        render: {
            option: (data, escape) => `<div class="option">${escape(data.text)}</div>`,
            item: (data, escape) => `<div class="item">${escape(data.text)}</div>`,
        },
    };

    // Pour les selects multiples avec optgroups, on active le plugin
    // checkbox_options si demandé explicitement
    if (options.plugins && options.plugins.includes('checkbox_options')) {
        // Tom Select complete inclut ce plugin
    }

    const merged = { ...defaults, ...options };

    // Tom Select lève une exception si on l'instancie deux fois sur le même
    // <select> (ex: initializeIconOptions() ré-appelé à chaque bascule vers
    // le mode icône, ou un profil rechargé plusieurs fois). Détruire toute
    // instance existante avant de recréer rend l'appel idempotent, quel que
    // soit l'appelant.
    if (node.tomselect) {
        try { node.tomselect.destroy(); } catch (e) { /* noop */ }
    }

    try {
        return new TS(node, merged);
    } catch (e) {
        console.error('[ui_bootstrap] initTomSelect error:', e);
        return null;
    }
}

/**
 * Détruit une instance Tom Select.
 * @param {TomSelect} instance
 */
export function destroyTomSelect(instance) {
    if (instance && typeof instance.destroy === 'function') {
        try { instance.destroy(); } catch (e) { /* noop */ }
    }
}

/**
 * Récupère l'instance Tom Select attachée à un <select>.
 * Tom Select stocke l'instance sur l'élément via .tomselect.
 * @param {Element|string} el
 * @returns {TomSelect|null}
 */
export function getTomSelect(el) {
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) return null;
    return node.tomselect || null;
}

/**
 * Synchronise l'UI Tom Select après modification du <select> natif.
 * Utile après avoir modifié option.selected directement sur le DOM.
 * @param {Element|string} el
 */
export function refreshTomSelect(el) {
    const ts = getTomSelect(el);
    if (ts) {
        try { ts.sync(); } catch (e) { /* noop */ }
    }
}

/* =====================================================================
   Tempus Dominus (datepickers)
   ===================================================================== */

/**
 * Initialise un datepicker Tempus Dominus sur un input.
 * L'instance est stockée sur l'élément via ._tdInstance pour récupération ultérieure.
 * @param {Element|string} el - élément input ou sélecteur
 * @param {object} options - options (mergées avec les valeurs par défaut)
 * @returns {tempusDominus.TempusDominus|null}
 */
export function initTempusDominus(el, options = {}) {
    const td = tdLib();
    if (!td) return null;
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) return null;

    // Détruire l'instance existante si présente
    if (node._tdInstance) {
        try { node._tdInstance.dispose(); } catch (e) { /* noop */ }
        node._tdInstance = null;
    }

    const defaults = {
        display: {
            components: {
                clock: false, // pas de sélection d'heure par défaut
            },
        },
        localization: {
            format: 'yyyy-MM-dd',
        },
    };

    const merged = { ...defaults, ...options };
    try {
        const instance = new td.TempusDominus(node, merged);
        node._tdInstance = instance;
        return instance;
    } catch (e) {
        console.error('[ui_bootstrap] initTempusDominus error:', e);
        return null;
    }
}

/**
 * Récupère l'instance Tempus Dominus attachée à un élément.
 * @param {Element|string} el
 * @returns {tempusDominus.TempusDominus|null}
 */
export function getTempusDominus(el) {
    const node = typeof el === 'string'
        ? (el.startsWith('#') ? document.querySelector(el) : document.getElementById(el))
        : el;
    if (!node) return null;
    return node._tdInstance || null;
}

/**
 * Détruit une instance Tempus Dominus.
 * @param {tempusDominus.TempusDominus} instance
 */
export function destroyTempusDominus(instance) {
    if (instance && typeof instance.dispose === 'function') {
        try { instance.dispose(); } catch (e) { /* noop */ }
    }
}

/**
 * Définit la date d'un datepicker Tempus Dominus.
 * @param {Element|string} el - élément input
 * @param {Date|string} date - date à définir (objet Date ou string yyyy-MM-dd)
 */
export function setTdDate(el, date) {
    const picker = getTempusDominus(el);
    if (!picker) return;
    try {
        if (typeof date === 'string' && date) {
            // Parser yyyy-MM-dd
            const parts = date.split('-');
            if (parts.length === 3) {
                const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                picker.dates.setValue(d);
            }
        } else if (date instanceof Date) {
            picker.dates.setValue(date);
        }
    } catch (e) {
        console.warn('[ui_bootstrap] setTdDate error:', e);
    }
}

/**
 * Récupère la date d'un datepicker Tempus Dominus au format yyyy-MM-dd.
 * @param {Element|string} el
 * @returns {string|null} date au format yyyy-MM-dd, ou null si vide
 */
export function getTdDate(el) {
    // L'input texte contient déjà la valeur formatée
    const node = typeof el === 'string'
        ? (el.startsWith('#') ? document.querySelector(el) : document.getElementById(el))
        : el;
    if (!node) return null;
    return node.value || null;
}

/* =====================================================================
   Helper Tabler Icons
   ===================================================================== */

/**
 * Génère le markup d'une icône Tabler (webfont).
 * @param {string} name - nom de l'icône (ex: 'player-play', 'video', 'pause')
 * @param {string} extraClass - classes supplémentaires
 * @returns {string} <i class="ti ti-player-play"></i>
 */
export function icon(name, extraClass = '') {
    const cls = `ti ti-${name} ${extraClass}`.trim();
    return `<i class="${cls}"></i>`;
}

/* =====================================================================
   Mapping Material Icons → Tabler Icons
   Utilisé pendant la migration pour remplacer les <i class="material-icons">
   ===================================================================== */
export const ICON_MAP = {
    'play_arrow': 'player-play',
    'videocam': 'video',
    'pause': 'player-pause',
    'stop': 'player-stop',
    'fullscreen': 'maximize',
    'fullscreen_exit': 'minimize',
    'cloud_upload': 'cloud-upload',
    'help_outline': 'help',
    'info': 'info-circle',
    'link': 'link',
    'my_location': 'current-location',
    'place': 'map-pin',
    'clear': 'x',
    'refresh': 'refresh',
    'home': 'home',
    'system_update': 'device-desktop-analytics',
    'brightness_high': 'sun-high',
    'brightness_low': 'moon',
    'settings': 'settings',
    'delete': 'trash',
    'edit': 'edit',
    'save': 'device-floppy',
    'add': 'plus',
    'close': 'x',
    'check': 'check',
    'arrow_back': 'arrow-left',
    'arrow_forward': 'arrow-right',
    'expand_more': 'chevron-down',
    'expand_less': 'chevron-up',
    'menu': 'menu-2',
    'search': 'search',
    'warning': 'alert-triangle',
    'error': 'alert-circle',
    'star': 'star',
    'favorite': 'heart',
    'download': 'download',
    'upload': 'upload',
    'file_upload': 'file-upload',
    'folder': 'folder',
    'folder_open': 'folder-open',
    'visibility': 'eye',
    'visibility_off': 'eye-off',
    'lock': 'lock',
    'lock_open': 'lock-open',
    'tune': 'adjustments',
    'filter_list': 'filter',
    'sort': 'sort-ascending',
    'more_vert': 'dots-vertical',
    'more_horiz': 'dots-horizontal',
    'person': 'user',
    'people': 'users',
    'share': 'share',
    'copy': 'copy',
    'content_copy': 'copy',
    'timer': 'clock',
    'schedule': 'clock',
    'today': 'calendar',
    'date_range': 'calendar',
    'event': 'calendar-event',
    'layers': 'stack',
    'map': 'map',
    'gps_fixed': 'current-location',
    'zoom_in': 'zoom-in',
    'zoom_out': 'zoom-out',
    'north': 'compass',
    'south': 'compass',
    'east': 'compass',
    'west': 'compass',
};

/**
 * Retourne le nom d'icône Tabler correspondant à une icône Material.
 * @param {string} materialName
 * @returns {string} nom Tabler (ou le nom original si pas de mapping)
 */
export function materialToTabler(materialName) {
    return ICON_MAP[materialName] || materialName;
}
