// Indicateur inline « Enregistré ✓ » pour les préférences à sauvegarde automatique.
//
// Motivation : jusqu'ici certains champs auto-sauvegardés affichaient un toast
// (centre de carte), d'autres rien du tout (langue, thème, enregistrement
// vidéo). Rien ne permettait de savoir si une valeur était partie sur le disque.
// Un seul retour, discret et posé à côté du champ concerné, remplace les deux :
// il désigne le champ sans masquer la carte et disparaît de lui-même.
//
// Cet indicateur ne concerne QUE les préférences globales. Les réglages de
// profil (style de carte, points, flash, infos) ne sont pas auto-sauvegardés :
// leur état non enregistré est signalé par le « • » de l'indicateur de profil.

const INDICATOR_CLASS = 'gc-saved-indicator';
const STATE_CLASSES = ['is-saving', 'is-saved', 'is-error'];
const HIDE_DELAY_MS = 2200;

// Nommée `t` comme partout ailleurs : c'est le mot-clé passé à pybabel
// (cf. babel.cfg), donc le seul sous lequel les chaînes sont extraites.
function t(msgid) {
    try {
        if (typeof window !== 'undefined' && typeof window.t === 'function') return window.t(msgid);
    } catch (_) {}
    return msgid;
}

function resolveField(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.getElementById(target);
    return target.nodeType === 1 ? target : null;
}

// Emplacement de l'indicateur : de préférence dans le <label> du champ, où il
// se pose en bout de ligne sans déplacer le contrôle ni casser la grille. Les
// cases à cocher (label placé après l'input) fonctionnent de la même façon.
function hostFor(field) {
    const group = field.closest('.mb-3, .form-check, .col-12, .col-6') || field.parentElement;
    if (!group) return null;
    if (field.id) {
        const label = group.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) return label;
    }
    const anyLabel = group.querySelector('label');
    return anyLabel || group;
}

function indicatorFor(field) {
    const host = hostFor(field);
    if (!host) return null;
    let indicator = host.querySelector(`:scope > .${INDICATOR_CLASS}`);
    if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = INDICATOR_CLASS;
        // aria-live : le retour est purement visuel pour les voyants ; sans
        // annonce, un lecteur d'écran ne saurait pas que la valeur est partie.
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        host.appendChild(indicator);
    }
    return indicator;
}

function render(field, { state, icon, text, transient }) {
    const el = resolveField(field);
    if (!el) return;
    const indicator = indicatorFor(el);
    if (!indicator) return;

    clearTimeout(indicator._gcHideTimer);
    indicator.classList.remove(...STATE_CLASSES);
    indicator.classList.add(state, 'is-visible');
    indicator.innerHTML = '';
    if (icon) {
        const i = document.createElement('i');
        i.className = `ti ${icon}`;
        i.setAttribute('aria-hidden', 'true');
        indicator.appendChild(i);
    }
    indicator.appendChild(document.createTextNode(text));

    if (transient) {
        indicator._gcHideTimer = setTimeout(() => {
            indicator.classList.remove('is-visible');
        }, HIDE_DELAY_MS);
    }
}

// Écriture en cours. Optionnel : n'a d'intérêt que si la sauvegarde peut durer
// (réseau lent) — sur un enregistrement local elle est invisible.
export function markSaving(field) {
    render(field, { state: 'is-saving', icon: 'ti-dots', text: t('Enregistrement…'), transient: false });
}

export function markSaved(field) {
    render(field, { state: 'is-saved', icon: 'ti-check', text: t('Enregistré'), transient: true });
}

// L'échec reste affiché : contrairement au succès, l'utilisateur doit pouvoir
// le retrouver après coup (sa valeur n'est PAS sur le disque).
export function markSaveError(field) {
    render(field, { state: 'is-error', icon: 'ti-alert-triangle', text: t('Non enregistré'), transient: false });
}

export function clearSavedIndicator(field) {
    const el = resolveField(field);
    if (!el) return;
    const host = hostFor(el);
    const indicator = host && host.querySelector(`:scope > .${INDICATOR_CLASS}`);
    if (!indicator) return;
    clearTimeout(indicator._gcHideTimer);
    indicator.classList.remove('is-visible');
}

// Enveloppe une promesse de sauvegarde : affiche « Enregistré » ou
// « Non enregistré » selon son résultat. `field` accepte un id, un élément, ou
// un tableau des deux (plusieurs champs sauvegardés par la même requête).
export async function reportSave(field, savePromise) {
    const fields = Array.isArray(field) ? field : [field];
    let ok = false;
    try {
        ok = (await savePromise) !== false;
    } catch (_) {
        ok = false;
    }
    fields.forEach(f => (ok ? markSaved(f) : markSaveError(f)));
    return ok;
}
