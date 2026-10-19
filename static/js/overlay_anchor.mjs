// Ancrage des cartouches Titre et Infos (#titleFrame, #infosFrame), même
// vocabulaire que les panneaux de stats : un emplacement de la grille et deux
// marges. Pur (aucun DOM) : le CSS y est un objet { propriété: valeur }, que
// infos_editor.js lit et écrit dans le CSS du thème.
//
// Seules les lignes haute et basse sont proposées : un cartouche au milieu du
// bord de la carte n'a pas d'usage, et les piles de stats ne contournent que
// les boîtes posées en haut ou en bas (layoutPanels).
//
// Centré, le cartouche est posé par `left: 0; right: 0; margin: 0 auto;
// width: fit-content` plutôt que `left: 50%` + `transform` : sa largeur
// disponible reste celle de la carte (un long titre ne passe pas à la ligne à
// mi-largeur), et overlay_canvas.js reprend tel quel le rect du DOM.

export const OVERLAY_ANCHORS = Object.freeze([
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
]);

export const OVERLAY_DEFAULT_MARGIN = 10;

// Propriétés qu'un ancrage pose ou retire. `width` n'est retirée que si elle
// vaut fit-content (posée par le centrage) : une largeur fixe choisie par
// l'utilisateur survit au changement d'emplacement.
const SIDES = ['top', 'right', 'bottom', 'left'];

const isSet = (value) => value != null && String(value).trim() !== '' && String(value).trim() !== 'auto';

function pxValue(value) {
    const m = String(value ?? '').match(/^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/i);
    return m ? Number(m[1]) : null;
}

// Emplacement et marges décrits par un CSS, ou null s'il ne correspond à
// aucun emplacement de la grille (CSS personnalisé : position relative,
// trois côtés, pourcentages…). `defaults` : côtés posés par la feuille par
// défaut quand le CSS du thème ne les redéfinit pas ({ top: 10, left: 10 }).
export function detectOverlayAnchor(decl, defaults = {}) {
    const get = (prop) => decl[prop];
    const position = get('position') || 'absolute';
    if (position !== 'absolute' && position !== 'fixed') return null;
    const side = (prop) => (isSet(get(prop)) ? pxValue(get(prop)) : (get(prop) ? null : defaults[prop] ?? null));
    const has = (prop) => (get(prop) ? isSet(get(prop)) : defaults[prop] != null);
    const t = has('top'), r = has('right'), b = has('bottom'), l = has('left');
    if (t === b) return null;
    const vertical = t ? 'top' : 'bottom';
    const dy = side(vertical);
    if (dy == null) return null;

    const centered = l && r && pxValue(get('left')) === 0 && pxValue(get('right')) === 0
        && get('margin-left') === 'auto' && get('margin-right') === 'auto';
    if (centered) return { anchor: `${vertical}-center`, dx: OVERLAY_DEFAULT_MARGIN, dy };
    if (l === r) return null;
    const horizontal = l ? 'left' : 'right';
    const dx = side(horizontal);
    if (dx == null) return null;
    return { anchor: `${vertical}-${horizontal}`, dx, dy };
}

// Modifications CSS d'un ancrage : { set: { prop: valeur }, remove: [props] }.
// Centré, `dx` ne sert pas (comme la colonne centrale des stats).
//
// Les côtés inutilisés sont posés à `auto`, pas retirés : titre.css et
// infos.css sont chargées comme feuilles de style et y fixent top/left (ou
// top/right) — retirés du CSS en ligne, ils resteraient effectifs, et un
// titre « en bas à droite » garderait son top: 10px.
export function overlayAnchorPatch(anchor, { dx = OVERLAY_DEFAULT_MARGIN, dy = OVERLAY_DEFAULT_MARGIN } = {}, decl = {}) {
    if (!OVERLAY_ANCHORS.includes(anchor)) return null;
    const [vertical, horizontal] = anchor.split('-');
    const set = { position: 'absolute' };
    for (const side of SIDES) set[side] = 'auto';
    set[vertical] = `${Math.round(dy)}px`;
    const remove = [];
    if (horizontal === 'center') {
        Object.assign(set, { left: '0px', right: '0px', 'margin-left': 'auto', 'margin-right': 'auto' });
        if (!isSet(decl.width)) set.width = 'fit-content';
        return { set, remove };
    }
    set[horizontal] = `${Math.round(dx)}px`;
    remove.push('margin-left', 'margin-right');
    if (String(decl.width || '').trim() === 'fit-content') remove.push('width');
    return { set, remove };
}

// Rect qu'occuperait une boîte `size` ancrée là, dans un conteneur
// `{ width, height }` — cible d'aimantation du glisser-déposer.
export function overlayAnchorRect(anchor, { dx = OVERLAY_DEFAULT_MARGIN, dy = OVERLAY_DEFAULT_MARGIN } = {}, size, container) {
    const [vertical, horizontal] = anchor.split('-');
    const width = Math.min(size.width, container.width);
    const height = Math.min(size.height, container.height);
    let x;
    if (horizontal === 'left') x = dx;
    else if (horizontal === 'right') x = container.width - dx - width;
    else x = (container.width - width) / 2;
    const y = vertical === 'top' ? dy : container.height - dy - height;
    return { anchor, x, y, width, height };
}

// Position libre après un glisser hors de tout emplacement : coin haut-gauche
// en POURCENTAGES du cadre (au dixième), borné au cadre. En px, elle serait
// indiscernable d'un ancrage en haut à gauche à grandes marges ; en %, elle
// n'en décrit aucun (detectOverlayAnchor → null) et suit la taille de
// l'aperçu, comme la position libre des panneaux de stats. Même forme que
// overlayAnchorPatch.
export function overlayFreePatch(left, top, size, container, decl = {}) {
    const x = Math.max(0, Math.min(container.width - size.width, left));
    const y = Math.max(0, Math.min(container.height - size.height, top));
    const percent = (value, total) => `${total > 0 ? Math.round((value / total) * 1000) / 10 : 0}%`;
    const remove = ['margin-left', 'margin-right'];
    if (String(decl.width || '').trim() === 'fit-content') remove.push('width');
    return {
        set: {
            position: 'absolute',
            left: percent(x, container.width),
            top: percent(y, container.height),
            right: 'auto',
            bottom: 'auto',
        },
        remove,
    };
}
