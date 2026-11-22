// Pose d'un lieu ou d'une base du parcours ouvert : « Ajouter un lieu »
// arme un clic sur la carte (curseur `parcours-picking`, Échap annule), le
// formulaire recueille nom/journée/heure/type/rôle/catégorie — et l'icône
// libre de la catégorie « custom » — puis crée le lieu. Le point provisoire
// dessiné par le plan entre le clic et la validation lit `draft()`.
// Déplacer un lieu posé (`startMove`) reprend la même mécanique.
//
// L'état du parcours (journées, verrou de lecture) et les écritures de lieux
// sont injectés — pas d'import de parcours_data.js.
import { t } from './notifications.js';
import { formatDay } from './parcours_labels.mjs';
import { KIND_BASE, KIND_PLACE } from './parcours_reconstruct.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, adjustmentsLocked, createPlace, updatePlace, button,
//          renderLayer, getMap, customIcons }
// getState() → { ordered }
export function createPlaceForm(deps) {
    const s = () => deps.getState() || {};

    let picking = false;          // en attente d'un clic sur la carte (lieu)
    let pickListener = null;
    let placeDraft = null;        // { lon, lat } du lieu en cours de saisie
    let placeIconDraft = null;    // icône choisie pour la catégorie « custom »
    let placeMoveId = null;       // lieu déplacé par un clic (startMove)
    let clickMutedUntil = 0;      // clic de pose/déplacement : ne pas l'ouvrir en étape

    function startPicking() {
        if (!s().ordered || deps.adjustmentsLocked()) return;
        const map = deps.getMap();
        if (!map) return;
        cancel();
        picking = true;
        map.getTargetElement()?.classList.add('parcours-picking');
        const hint = el('parcoursPlaceHint');
        if (hint) hint.hidden = false;
        pickListener = map.once('singleclick', (event) => {
            pickListener = null;
            clickMutedUntil = performance.now() + 400;
            stopPicking();
            const [lon, lat] = ol.proj.toLonLat(event.coordinate);
            openForm({ lon, lat });
        });
    }

    function stopPicking() {
        picking = false;
        deps.getMap()?.getTargetElement()?.classList.remove('parcours-picking');
        const hint = el('parcoursPlaceHint');
        if (hint) hint.hidden = true;
    }

    function cancel() {
        placeMoveId = null;
        if (pickListener) {
            ol.Observable.unByKey(pickListener);
            pickListener = null;
        }
        stopPicking();
    }

    // Déplacer un lieu ou une base posée : même mécanique que la pose d'un
    // lieu — un clic sur la carte envoie les nouvelles coordonnées.
    function startMove(place) {
        if (!s().ordered || deps.adjustmentsLocked()) return;
        const map = deps.getMap();
        if (!map) return;
        cancel();
        picking = true;
        placeMoveId = place.id;
        map.getTargetElement()?.classList.add('parcours-picking');
        const hint = el('parcoursPlaceHint');
        if (hint) hint.hidden = false;
        pickListener = map.once('singleclick', (event) => {
            pickListener = null;
            clickMutedUntil = performance.now() + 400;
            stopPicking();
            const id = placeMoveId;
            placeMoveId = null;
            const [lon, lat] = ol.proj.toLonLat(event.coordinate);
            deps.updatePlace(id, { lat, lon });
        });
    }

    function openForm({ lon, lat }, { kind = KIND_PLACE } = {}) {
        const form = el('parcoursPlaceForm');
        if (!form) return;
        placeDraft = { lon, lat };
        const days = el('parcoursPlaceDay');
        if (days) {
            days.replaceChildren();
            const all = document.createElement('option');
            all.value = '';
            all.textContent = t('Toutes les journées');
            all.dataset.baseOnly = '1';
            days.append(all);
            for (const day of s().ordered?.days || []) {
                const opt = document.createElement('option');
                opt.value = day.date;
                opt.textContent = formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'short' });
                days.append(opt);
            }
            // Proposition : la première journée qui a des étapes.
            const first = (s().ordered?.days || []).find((day) => day.stops.length > 0);
            days.value = first?.date || '';
        }
        showDraftCoords();
        el('parcoursPlaceName').value = '';
        el('parcoursPlaceTime').value = '';
        el('parcoursPlaceKind').value = kind === KIND_BASE ? KIND_BASE : KIND_PLACE;
        el('parcoursPlaceRole').value = 'both';
        el('parcoursPlaceCategory').value = 'other';
        placeIconDraft = deps.customIcons[0];
        buildIconPicker(el('parcoursPlaceIcons'), placeIconDraft, (cls) => {
            placeIconDraft = cls;
            markIconPicker(el('parcoursPlaceIcons'), cls);
            deps.renderLayer();
        });
        syncForm();
        form.hidden = false;
        el('parcoursPlaceName')?.focus();
    }

    function showDraftCoords() {
        const coords = el('parcoursPlaceCoords');
        if (coords && placeDraft) coords.textContent = `${placeDraft.lat.toFixed(5)}, ${placeDraft.lon.toFixed(5)}`;
    }

    // Grille d'icônes Tabler de la catégorie « custom » : boutons `aria-pressed`,
    // `onPick(cls)` au choix.
    function buildIconPicker(container, selected, onPick) {
        if (!container) return;
        container.replaceChildren();
        for (const cls of deps.customIcons) {
            const btn = deps.button('parcours-icon-choice', cls, t('Icône ${icon}', { icon: cls.slice(3) }));
            btn.classList.toggle('is-selected', cls === selected);
            btn.setAttribute('aria-pressed', String(cls === selected));
            btn.addEventListener('click', () => onPick(cls));
            container.append(btn);
        }
    }

    function markIconPicker(container, selected) {
        for (const btn of container?.querySelectorAll('.parcours-icon-choice') || []) {
            const on = !!btn.querySelector('i')?.classList.contains(selected);
            btn.classList.toggle('is-selected', on);
            btn.setAttribute('aria-pressed', String(on));
        }
    }

    // Une base peut valoir pour toutes les journées et n'a pas d'heure ; un lieu
    // a toujours sa journée.
    function syncForm() {
        const base = el('parcoursPlaceKind')?.value === KIND_BASE;
        const days = el('parcoursPlaceDay');
        const all = days?.querySelector('option[data-base-only]');
        if (all) {
            all.hidden = !base;
            all.disabled = !base;
            if (!base && days.value === '') days.value = days.options[1]?.value || '';
        }
        const timeRow = el('parcoursPlaceTimeRow');
        if (timeRow) timeRow.hidden = base;
        const roleRow = el('parcoursPlaceRoleRow');
        if (roleRow) roleRow.hidden = !base;
        const iconRow = el('parcoursPlaceIconRow');
        if (iconRow) iconRow.hidden = el('parcoursPlaceCategory')?.value !== 'custom';
        // Le point provisoire prend la forme du type et de la catégorie choisis.
        deps.renderLayer();
    }

    function closeForm() {
        placeDraft = null;
        const form = el('parcoursPlaceForm');
        if (form) form.hidden = true;
        deps.renderLayer();
    }

    // Bouton « Ajouter un lieu », champs du formulaire et Échap.
    function bind() {
        el('btnParcoursAddPlace')?.addEventListener('click', () => {
            if (picking) cancel();
            else startPicking();
        });
        el('parcoursPlaceKind')?.addEventListener('change', syncForm);
        el('parcoursPlaceCategory')?.addEventListener('change', syncForm);
        el('btnParcoursPlaceCancel')?.addEventListener('click', closeForm);
        el('parcoursPlaceForm')?.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!placeDraft) return;
            const kind = el('parcoursPlaceKind').value;
            const category = el('parcoursPlaceCategory').value;
            const ok = await deps.createPlace({
                kind,
                name: el('parcoursPlaceName').value,
                lat: placeDraft.lat,
                lon: placeDraft.lon,
                date: el('parcoursPlaceDay').value || null,
                time: kind === KIND_PLACE ? (el('parcoursPlaceTime').value || null) : null,
                role: kind === KIND_BASE ? (el('parcoursPlaceRole').value || 'both') : 'both',
                category,
                icon: category === 'custom' ? placeIconDraft : null,
            });
            if (ok) closeForm();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && picking) cancel();
        });
    }

    return {
        bind,
        startPicking,
        startMove,
        openForm,
        closeForm,
        buildIconPicker,
        // Pose annulée et formulaire fermé (parcours quitté).
        dismiss: () => { cancel(); closeForm(); },
        setDraft: ({ lon, lat }) => { placeDraft = { lon, lat }; showDraftCoords(); },
        isPicking: () => picking,
        draft: () => placeDraft,
        draftIcon: () => placeIconDraft,
        isClickMuted: () => performance.now() < clickMutedUntil,
    };
}
