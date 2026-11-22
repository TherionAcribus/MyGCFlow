// Liste des étapes du parcours ouvert (onglet Données) : une journée par
// section pliable, lignes réordonnables (flèches et glisser-déposer), panneau
// d'ajustement de l'étape (heure épinglée, durée, trajet, journée, exclusion ;
// pour un lieu : nom, type, rôle, catégorie, déplacement, suppression) et
// parkings suggérés.
//
// L'état du parcours ouvert arrive par `getState()` ; l'état du panneau
// (étape ouverte, journées repliées, glisser-déposer) est interne. Toutes les
// écritures (ajustements, lieux) et ce qui touche la carte ou le style sont
// injectés — pas d'import de parcours_data.js.
import { t } from './notifications.js';
import {
    categoryOptionLabel,
    dayDiagnostic,
    formatDay,
    stopCategoryIcon,
    stopDetail,
    stopLabel,
    stopTime,
} from './parcours_labels.mjs';
import {
    CONFIDENCE_ANCHORED,
    KIND_BASE,
    KIND_PLACE,
    isCountedStop,
    minutesToTime,
    visitMinutes,
} from './parcours_reconstruct.mjs';
import { legModeFor } from './parcours_routing.mjs';
import { suggestParkings } from './parcours_parkings.mjs';
import { dayColor, paintTextColor } from './parcours_style.mjs';

const el = (id) => document.getElementById(id);

// Repère ce qui avait le focus avant la reconstruction de la liste : la
// ligne (étape ou panneau d'ajustement) et le contrôle qui le portait —
// après « Monter », le bouton de l'étape déplacée le récupère.
const FOCUSABLE_CLASSES = [
    'parcours-stop-up', 'parcours-stop-down', 'parcours-stop-text', 'parcours-stop-restore',
    'parcours-edit-time', 'parcours-edit-pin', 'parcours-edit-unpin', 'parcours-edit-leg', 'parcours-edit-visit',
    'parcours-edit-day', 'parcours-edit-exclude', 'parcours-edit-delete-place',
    'parcours-edit-place-name', 'parcours-edit-place-rename', 'parcours-edit-place-kind',
    'parcours-edit-place-day', 'parcours-edit-place-role', 'parcours-edit-place-move', 'parcours-edit-locate',
    'parcours-edit-place-category',
];

// deps : { getState, button, pruneHoverRows, updateUndoButtons,
//          setHoveredStop, saveOverrides, createPlace, updatePlace,
//          deletePlace, adjustmentsLocked, reorderDay, moveStop,
//          moveStopToDay, resetDayOrder, overrideOf, placeOf, pinnedTimeOf,
//          pinStopTime, excludeStop, startPlaceMove, buildIconPicker,
//          stopStyle, dayIndexes, paintOfStop, currentStopLabels,
//          placeCategories, customIcons, getMap, showDataTab }
// getState() → { status, ordered, inputs, counts, logsAvailable, photoByStop }
export function createStopsPanel(deps) {
    const s = () => deps.getState() || {};
    const button = deps.button;

    let editKey = null;            // étape dont le panneau d'ajustement est ouvert
    let collapsedDays = new Set(); // journées repliées dans la liste (dates ISO)

    // Glisser-déposer par Pointer Events depuis la poignée de la ligne :
    // un seul chemin pour souris, tactile et stylet (le drag & drop HTML5 ne
    // fonctionne pas au tactile). La poignée porte `touch-action: none` pour
    // que le geste ne soit pas avalé par le défilement de la liste ; le reste
    // de la ligne reste scrollable et le clavier garde les flèches.
    let drag = null;          // { key, date, pointerId, startX, startY, moved }
    let dropMark = null;      // { kind: 'row', row, after } | { kind: 'day', section }
    let scrollParent = null;  // ancêtre défilant, pour l'auto-défilement
    let dndBound = false;

    function hasAdjustments() {
        return (s().inputs?.overrides?.length || 0) > 0;
    }

    function focusMarkerOf(el) {
        const row = el?.closest?.('[data-stop-key], [data-edit-key]');
        if (!row) return null;
        const key = row.dataset.stopKey || row.dataset.editKey;
        const cls = FOCUSABLE_CLASSES.find((c) => el.classList.contains(c));
        return cls ? { key, cls } : null;
    }

    function render(errorMessage = '') {
        const { status, ordered, counts, logsAvailable } = s();
        const box = el('parcoursStops');
        const summary = el('parcoursSummary');
        const tools = el('parcoursStopsTools');
        if (!box) return;
        bindDrag(box);
        if (tools) tools.hidden = !ordered;
        if (status === 'loading') {
            if (summary) summary.textContent = t('Chargement…');
            box.replaceChildren();
            return;
        }
        if (!ordered) {
            if (summary) {
                summary.textContent = status === 'error'
                    ? (errorMessage || t('Impossible de charger les étapes'))
                    : t('Ouvrez ou créez un parcours pour voir ses étapes.');
            }
            box.replaceChildren();
            return;
        }
        if (summary) {
            const parts = [t('${n} étapes', { n: ordered.stopCount }), t('${n} jours', { n: ordered.days.length })];
            if (counts?.missing_position) parts.push(t('${n} sans position', { n: counts.missing_position }));
            summary.textContent = parts.join(' · ');
        }
        const reset = el('btnParcoursResetAdjustments');
        if (reset) reset.hidden = !hasAdjustments();
        const note = el('parcoursOrderNote');
        if (note) {
            note.textContent = logsAvailable
                ? t('Ordre et heures reconstruits d’après l’ordre de saisie de vos logs, l’heure de vos Labs et la géographie. « ≈ » : heure estimée.')
                : t('Sans identifiants de logs, l’ordre vient de vos Labs et de la géographie : réimportez votre fichier My Finds pour en profiter. « ≈ » : heure estimée.');
        }
        const focus = box.contains(document.activeElement) ? focusMarkerOf(document.activeElement) : null;
        box.replaceChildren(...ordered.days.map(renderDay));
        deps.pruneHoverRows();
        if (focus) {
            const node = box.querySelector(
                `[data-stop-key="${focus.key}"] .${focus.cls}, [data-edit-key="${focus.key}"] .${focus.cls}`)
                || box.querySelector(`[data-stop-key="${focus.key}"] .parcours-stop-text`);
            node?.focus();
        }
        updateCollapseAll();
        deps.updateUndoButtons();
    }

    // « Tout plier / Tout déplier » : libellé et état selon les journées repliées.
    function updateCollapseAll() {
        const btn = el('btnParcoursCollapseDays');
        if (!btn) return;
        const days = s().ordered?.days || [];
        const allCollapsed = days.length > 0 && days.every((d) => collapsedDays.has(d.date));
        btn.querySelector('span').textContent = allCollapsed ? t('Tout déplier') : t('Tout plier');
    }

    // Déplie la journée qui contient l'étape — sinon son panneau d'ajustement
    // s'ouvrirait sur une ligne masquée.
    function expandDayOf(key) {
        const day = s().ordered?.days.find((d) => d.stops.some((stop) => stop.key === key));
        if (day) collapsedDays.delete(day.date);
    }

    function renderDay(day) {
        const section = document.createElement('section');
        const collapsed = collapsedDays.has(day.date);
        section.className = 'parcours-day mb-3';
        if (collapsed) section.classList.add('is-collapsed');
        section.dataset.date = day.date;
        const header = document.createElement('div');
        header.className = 'd-flex align-items-center gap-2 flex-wrap';
        const body = document.createElement('div');
        body.id = `parcoursDay-${day.date}`;
        body.className = 'parcours-day-body';
        body.hidden = collapsed;
        const toggle = button('btn btn-link btn-sm p-0 parcours-day-toggle', 'ti-chevron-down',
            collapsed ? t('Déplier la journée') : t('Replier la journée'));
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-controls', body.id);
        toggle.addEventListener('click', () => {
            // Bascule en place, sans reconstruire la liste : le focus et les
            // poignées de glisser-déposer restent tels quels.
            const open = collapsedDays.delete(day.date);
            if (!open) collapsedDays.add(day.date);
            section.classList.toggle('is-collapsed', !open);
            body.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
            toggle.setAttribute('aria-label', open ? t('Replier la journée') : t('Déplier la journée'));
            toggle.title = toggle.getAttribute('aria-label');
            updateCollapseAll();
        });
        const title = document.createElement('h6');
        title.className = 'parcours-day-title mb-1';
        title.textContent = formatDay(day.date);
        // Couleur de la journée, quand les étapes ou le trait la prennent.
        const { color_by: colorBy, trail_by_day: trailByDay } = deps.stopStyle();
        if (colorBy === 'day' || trailByDay) {
            const dot = document.createElement('span');
            dot.className = 'parcours-day-dot';
            dot.setAttribute('aria-hidden', 'true');
            dot.style.backgroundColor = dayColor(deps.dayIndexes().byDate.get(day.date) ?? 0, deps.stopStyle().day_palette);
            title.prepend(dot);
        }
        // Le nombre d'étapes reste lisible quand la journée est repliée.
        const count = document.createElement('span');
        count.className = 'small text-muted parcours-day-count';
        count.textContent = t('${n} étapes', { n: day.stops.length });
        header.append(toggle, title, count);
        if (deps.playFromDay && day.stops.length > 0) {
            const play = button('btn btn-link btn-sm p-0 parcours-day-play', 'ti-player-play',
                t('Lire depuis cette journée'));
            play.addEventListener('click', () => deps.playFromDay(day));
            header.append(play);
        }
        if (day.manual) {
            const badge = document.createElement('span');
            badge.className = 'badge bg-azure-lt parcours-day-manual';
            badge.textContent = t('ordre manuel');
            const auto = button('btn btn-link btn-sm p-0 parcours-day-auto', 'ti-arrow-back-up',
                t('Revenir à l’ordre automatique'), { text: t('Ordre automatique') });
            auto.addEventListener('click', () => deps.resetDayOrder(day));
            header.append(badge, auto);
        }
        section.append(header, body);
        if (day.stops.length > 0) {
            const diagnostic = document.createElement('div');
            diagnostic.className = 'small text-muted mb-1 parcours-day-diagnostic';
            diagnostic.textContent = dayDiagnostic(day);
            body.append(diagnostic);
            const parkings = dayParkings().get(day.date);
            if (parkings) body.append(renderDayParkings(day, parkings));
        } else {
            const empty = document.createElement('div');
            empty.className = 'small text-muted';
            empty.textContent = t('Aucune étape ce jour-là');
            body.append(empty);
        }
        if (day.stops.length > 0 || day.excluded.length > 0) {
            const list = document.createElement('ol');
            list.className = 'list-unstyled mb-0 parcours-stop-list';
            const movable = day.stops.filter((stop) => stop.kind !== KIND_BASE);
            for (const stop of day.stops) list.append(...renderStopRow(stop, day, movable));
            for (const stop of day.excluded) list.append(...renderExcludedRow(stop));
            body.append(list);
        }
        return section;
    }

    // Écouteurs du glisser-déposer, délégués à la liste : elle est
    // reconstruite à chaque geste, mais l'élément conteneur survit.
    function bindDrag(box) {
        if (dndBound) return;
        dndBound = true;
        box.addEventListener('pointerdown', onDragStart);
        box.addEventListener('pointermove', onDragMove);
        box.addEventListener('pointerup', onDragEnd);
        box.addEventListener('pointercancel', cancelDrag);
    }

    function onDragStart(event) {
        const grip = event.target.closest?.('.parcours-stop-grip');
        const row = grip?.closest('.parcours-stop');
        const section = row?.closest('.parcours-day');
        if (!row || !section) return;
        event.preventDefault(); // souris : pas de sélection de texte
        drag = {
            key: row.dataset.stopKey,
            date: section.dataset.date,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };
        try {
            grip.setPointerCapture(event.pointerId);
        } catch { /* pointeur déjà inactif : le drag suit quand même */ }
        // Ancêtre défilant de la liste, pour l'auto-défilement en bordure.
        scrollParent = null;
        let node = el('parcoursStops')?.parentElement;
        while (node) {
            if (node.scrollHeight > node.clientHeight
                && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
                scrollParent = node;
                break;
            }
            node = node.parentElement;
        }
    }

    function onDragMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.moved
            && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
            return;
        }
        if (!drag.moved) {
            drag.moved = true;
            const box = el('parcoursStops');
            box?.querySelector(`.parcours-stop[data-stop-key="${CSS.escape(drag.key)}"]`)
                ?.classList.add('is-dragging');
        }
        event.preventDefault();
        clearDropMark();
        const box = el('parcoursStops');
        const under = document.elementFromPoint(event.clientX, event.clientY);
        const row = under?.closest?.('.parcours-stop');
        // Une ligne déplaçable (poignée présente) reçoit l'insertion ;
        // lignes exclues/base et vide → la journée entière (dépôt en fin).
        if (row && box?.contains(row) && row.querySelector('.parcours-stop-grip')
            && row.dataset.stopKey !== drag.key) {
            const rect = row.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            dropMark = { kind: 'row', row, after };
            row.classList.add(after ? 'is-drop-below' : 'is-drop-above');
        } else {
            const section = under?.closest?.('.parcours-day');
            if (section && box?.contains(section)) {
                dropMark = { kind: 'day', section };
                section.classList.add('is-drop-target');
            }
        }
        // Auto-défilement en approchant les bords de la liste.
        if (scrollParent) {
            const rect = scrollParent.getBoundingClientRect();
            if (event.clientY < rect.top + 40) scrollParent.scrollTop -= 12;
            else if (event.clientY > rect.bottom - 40) scrollParent.scrollTop += 12;
        }
    }

    function onDragEnd(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const { key, date, moved } = drag;
        const mark = dropMark;
        cancelDrag();
        if (!moved || !mark) return;
        const days = s().ordered?.days || [];
        if (mark.kind === 'day') {
            // Déposé sur la journée (jour vide ou creux de la liste) : l'étape
            // la rejoint à la fin ; sur sa propre journée, elle finit en
            // dernier. La journée de dépôt se déplie pour montrer le résultat.
            const day = days.find((d) => d.date === mark.section.dataset.date);
            if (!day) return;
            collapsedDays.delete(day.date);
            if (day.date === date) {
                const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key);
                keys.push(...keys.splice(keys.indexOf(key), 1));
                deps.reorderDay(keys);
            } else {
                deps.moveStopToDay(day, key, Number.MAX_SAFE_INTEGER);
            }
            return;
        }
        const section = mark.row.closest('.parcours-day');
        const day = days.find((d) => d.date === section?.dataset.date);
        const target = mark.row.dataset.stopKey;
        if (!day || !target) return;
        if (day.date === date) {
            const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key)
                .filter((k) => k !== key);
            keys.splice(keys.indexOf(target) + (mark.after ? 1 : 0), 0, key);
            deps.reorderDay(keys);
        } else {
            // Autre journée : insérée au rang où elle est lâchée.
            const rank = day.stops.filter((stop) => stop.kind !== KIND_BASE)
                .findIndex((stop) => stop.key === target);
            if (rank >= 0) deps.moveStopToDay(day, key, rank + (mark.after ? 1 : 0));
        }
    }

    function cancelDrag() {
        clearDropMark();
        el('parcoursStops')?.querySelector('.parcours-stop.is-dragging')
            ?.classList.remove('is-dragging');
        drag = null;
        scrollParent = null;
    }

    function clearDropMark() {
        if (!dropMark) return;
        if (dropMark.kind === 'row') dropMark.row.classList.remove('is-drop-above', 'is-drop-below');
        else dropMark.section.classList.remove('is-drop-target');
        dropMark = null;
    }

    // Parkings connus des caches de chaque journée (lot 14, parcours_parkings.mjs),
    // recalculés quand la reconstruction ou les lieux changent.
    let parkingMemo = { ordered: null, places: null, parkings: null, byDate: new Map() };

    function dayParkings() {
        const { ordered, inputs } = s();
        const places = inputs?.places || null;
        const parkings = inputs?.parkings || null;
        if (parkingMemo.ordered !== ordered || parkingMemo.places !== places || parkingMemo.parkings !== parkings) {
            parkingMemo = { ordered, places, parkings, byDate: suggestParkings(ordered?.days, parkings, places) };
        }
        return parkingMemo.byDate;
    }

    // Bloc replié sous le bilan de la journée : un parking par ligne, avec les
    // caches qui le citent ; « Créer le lieu » pose un lieu de catégorie
    // parking à cette journée, sans heure (la reconstruction le place).
    const openParkingDays = new Set();

    function renderDayParkings(day, parkings) {
        const box = document.createElement('details');
        box.className = 'parcours-day-parkings small mb-1';
        box.open = openParkingDays.has(day.date);
        box.addEventListener('toggle', () => {
            if (box.open) openParkingDays.add(day.date);
            else openParkingDays.delete(day.date);
        });
        const summary = document.createElement('summary');
        summary.className = 'text-muted';
        const icon = document.createElement('i');
        icon.className = 'ti ti-parking me-1';
        icon.setAttribute('aria-hidden', 'true');
        summary.append(icon, parkings.length === 1 ? t('1 parking connu pour cette journée')
            : t('${n} parkings connus pour cette journée', { n: parkings.length }));
        const list = document.createElement('ul');
        list.className = 'list-unstyled mb-0 mt-1';
        for (const parking of parkings) {
            const item = document.createElement('li');
            item.className = 'parcours-parking d-flex align-items-center gap-2 py-1';
            const text = document.createElement('span');
            text.className = 'flex-grow-1';
            const caches = parking.codes.map((code) => {
                const stop = day.stops.find((s) => s.code === code);
                return stop ? stopLabel(stop) : code;
            }).join(', ');
            const name = parking.name || t('Parking');
            const forCaches = t('pour ${caches}', { caches });
            text.textContent = `${name} · ${forCaches}`;
            const create = button('btn btn-sm btn-outline-primary py-0 parcours-parking-create', 'ti-map-pin-plus',
                t('Créer ce lieu'), { text: t('Créer ce lieu') });
            create.disabled = deps.adjustmentsLocked();
            create.addEventListener('click', async () => {
                create.disabled = true;
                const ok = await deps.createPlace({
                    kind: KIND_PLACE,
                    name: name.slice(0, 80),
                    lat: parking.lat,
                    lon: parking.lon,
                    date: day.date,
                    time: null,
                    category: 'parking',
                });
                if (!ok) create.disabled = false;
            });
            item.append(text, create);
            list.append(item);
        }
        box.append(summary, list);
        return box;
    }

    function renderStopRow(stop, day, movable) {
        const item = document.createElement('li');
        item.className = 'parcours-stop d-flex align-items-start gap-2 py-1';
        item.dataset.stopKey = stop.key;
        item.dataset.kind = stop.kind;
        item.dataset.confidence = stop.confidence;
        item.dataset.reason = stop.reason;
        if (stop.posSource) item.dataset.posSource = stop.posSource;
        if (stop.placeId != null) item.dataset.placeId = stop.placeId;
        // Survol ou focus clavier : le point correspondant du plan s'entoure
        // d'un halo (lien liste ↔ carte).
        item.addEventListener('mouseenter', () => deps.setHoveredStop(stop));
        item.addEventListener('mouseleave', () => deps.setHoveredStop(null));
        item.addEventListener('focusin', () => deps.setHoveredStop(stop));
        item.addEventListener('focusout', (event) => {
            if (!item.contains(event.relatedTarget)) deps.setHoveredStop(null);
        });
        const time = document.createElement('span');
        time.className = 'parcours-stop-time small mt-1';
        time.classList.toggle('text-muted', stop.confidence !== CONFIDENCE_ANCHORED);
        time.textContent = stopTime(stop);
        const badge = document.createElement('span');
        badge.className = 'parcours-stop-index';
        // Même peinture que le plan ; creuse : fond blanc cerclé de la couleur.
        const paint = deps.paintOfStop(stop);
        badge.style.backgroundColor = paint.hollow ? '#ffffff' : paint.fill;
        badge.style.color = paintTextColor(paint);
        if (paint.hollow) badge.style.boxShadow = `inset 0 0 0 2px ${paint.fill}`;
        if (Number.isFinite(stop.index)) {
            // Même numéro que le plan ; sans numéros sur la carte, la liste
            // garde le rang sur tout le parcours.
            badge.textContent = deps.currentStopLabels().get(stop.key) || String(stop.index);
        } else {
            const icon = document.createElement('i');
            icon.className = `ti ${stopCategoryIcon(stop)}`;
            icon.setAttribute('aria-hidden', 'true');
            badge.append(icon);
        }
        const icon = document.createElement('i');
        icon.className = `ti ${stopCategoryIcon(stop)} text-muted mt-1`;
        icon.setAttribute('aria-hidden', 'true');
        // Le texte ouvre le panneau d'ajustement de l'étape.
        const text = document.createElement('button');
        text.type = 'button';
        text.className = 'btn btn-link p-0 text-start flex-grow-1 min-w-0 parcours-stop-text';
        text.setAttribute('aria-expanded', String(editKey === stop.key));
        const name = document.createElement('div');
        name.className = 'text-truncate';
        name.textContent = stopLabel(stop);
        const detail = document.createElement('div');
        detail.className = 'small text-muted';
        detail.textContent = stopDetail(stop, s().photoByStop?.get(stop.key)?.length || 0);
        text.append(name, detail);
        text.addEventListener('click', () => {
            editKey = editKey === stop.key ? null : stop.key;
            render();
        });
        item.append(time, badge, icon, text);
        if (deps.playFromStop) {
            const play = button('btn btn-sm btn-ghost-secondary parcours-stop-play', 'ti-player-play',
                t('Lire depuis ici'));
            play.addEventListener('click', () => deps.playFromStop(stop));
            item.append(play);
        }

        const position = movable.indexOf(stop);
        if (position >= 0) {
            const up = button('btn btn-sm btn-ghost-secondary parcours-stop-up', 'ti-arrow-up', t('Monter'));
            up.disabled = position === 0;
            up.addEventListener('click', () => deps.moveStop(day, stop.key, -1));
            const down = button('btn btn-sm btn-ghost-secondary parcours-stop-down', 'ti-arrow-down', t('Descendre'));
            down.disabled = position === movable.length - 1;
            down.addEventListener('click', () => deps.moveStop(day, stop.key, 1));
            item.append(up, down);
            // Poignée de glisser-déposer (Pointer Events, cf. bindDrag) :
            // décorative — le clavier réordonne par les flèches et la liste
            // déroulante « Journée » du panneau d'ajustement.
            const grip = document.createElement('span');
            grip.className = 'parcours-stop-grip';
            grip.setAttribute('aria-hidden', 'true');
            grip.title = t('Glisser pour réordonner');
            const gripIcon = document.createElement('i');
            gripIcon.className = 'ti ti-grip-vertical';
            grip.append(gripIcon);
            item.append(grip);
        }
        return editKey === stop.key ? [item, renderEditPanel(stop, day)] : [item];
    }

    function renderExcludedRow(stop) {
        const item = document.createElement('li');
        item.className = 'parcours-stop is-excluded d-flex align-items-center gap-2 py-1';
        item.dataset.stopKey = stop.key;
        if (stop.placeId != null) item.dataset.placeId = stop.placeId;
        const label = document.createElement('div');
        label.className = 'flex-grow-1 min-w-0 text-muted';
        const name = document.createElement('div');
        name.className = 'text-truncate text-decoration-line-through';
        name.textContent = stopLabel(stop);
        const detail = document.createElement('div');
        detail.className = 'small';
        detail.textContent = t('exclue du parcours');
        label.append(name, detail);
        const restore = button('btn btn-sm btn-outline-secondary parcours-stop-restore', 'ti-arrow-back-up',
            t('Réintégrer'), { text: t('Réintégrer') });
        restore.addEventListener('click', () => deps.saveOverrides([{ key: stop.key, excluded: false }]));
        item.append(label, restore);
        return [item];
    }

    // Panneau d'ajustement d'une étape : heure épinglée, journée, exclusion ;
    // pour un lieu ou une base, son heure et sa suppression.
    function renderEditPanel(stop, day) {
        const { ordered } = s();
        const panel = document.createElement('li');
        panel.className = 'parcours-stop-edit card card-body py-2 px-3 mb-2';
        panel.dataset.editKey = stop.key;
        // Le halo suit le focus ou la souris jusque dans le panneau.
        panel.addEventListener('mouseenter', () => deps.setHoveredStop(stop));
        panel.addEventListener('mouseleave', () => deps.setHoveredStop(null));
        panel.addEventListener('focusin', () => deps.setHoveredStop(stop));
        panel.addEventListener('focusout', (event) => {
            if (!panel.contains(event.relatedTarget)) deps.setHoveredStop(null);
        });
        const place = deps.placeOf(stop);

        if (stop.kind !== KIND_BASE) {
            const row = document.createElement('div');
            row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const label = document.createElement('label');
            label.className = 'small';
            label.textContent = t('Heure');
            const input = document.createElement('input');
            input.type = 'time';
            input.className = 'form-control form-control-sm w-auto parcours-edit-time';
            const pinned = deps.pinnedTimeOf(stop);
            input.value = pinned || minutesToTime(stop.arrivalMin);
            label.htmlFor = input.id = `parcoursEditTime-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const pin = button('btn btn-sm btn-outline-primary parcours-edit-pin', 'ti-pin', t('Épingler cette heure'),
                { text: t('Épingler') });
            pin.addEventListener('click', () => deps.pinStopTime(stop, input.value));
            row.append(label, input, pin);
            if (pinned) {
                const unpin = button('btn btn-sm btn-link parcours-edit-unpin', 'ti-x', t('Retirer l’heure épinglée'),
                    { text: t('Retirer') });
                unpin.addEventListener('click', () => deps.pinStopTime(stop, null));
                row.append(unpin);
            }
            panel.append(row);

            // Durée de visite : vide = durée estimée du type de l'étape ; les
            // heures des étapes suivantes suivent la durée imposée.
            const visitRow = document.createElement('div');
            visitRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const visitLabel = document.createElement('label');
            visitLabel.className = 'small';
            visitLabel.textContent = t('Durée de visite');
            const visitInput = document.createElement('input');
            visitInput.type = 'number';
            visitInput.min = '0';
            visitInput.max = '720';
            visitInput.step = '5';
            visitInput.placeholder = t('${n} min', { n: visitMinutes(stop) });
            visitInput.className = 'form-control form-control-sm parcours-edit-visit';
            visitInput.style.width = '5.5rem';
            const visitOverride = deps.overrideOf(stop.key)?.visitMin;
            visitInput.value = Number.isFinite(visitOverride) ? visitOverride : '';
            visitLabel.htmlFor = visitInput.id = `parcoursEditVisit-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const visitHint = document.createElement('span');
            visitHint.className = 'small text-muted';
            visitHint.textContent = t('min');
            visitInput.addEventListener('change', () => {
                const value = visitInput.value === '' ? null : Math.max(0, Math.min(720, Math.round(Number(visitInput.value) || 0)));
                // La suppression de l'input pendant le re-rendu relance change
                // sur blur : ignorer la valeur déjà appliquée.
                if (value === (deps.overrideOf(stop.key)?.visitMin ?? null)) return;
                deps.saveOverrides([{ key: stop.key, visitMin: value }]);
            });
            visitRow.append(visitLabel, visitInput, visitHint);
            panel.append(visitRow);
        }

        const next = day.stops[day.stops.indexOf(stop) + 1];
        if (next && stop.kind !== KIND_BASE) {
            const row = document.createElement('div');
            row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const label = document.createElement('label');
            label.className = 'small';
            label.textContent = t('Trajet vers l’étape suivante');
            const select = document.createElement('select');
            select.className = 'form-select form-select-sm w-auto parcours-edit-leg';
            label.htmlFor = select.id = `parcoursEditLeg-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            const leg = day.legs.find((l) => l.from === stop.key);
            const auto = legModeFor(leg?.km ?? 0);
            const labels = { walk: t('à pied'), bike: t('à vélo'), car: t('en voiture'), straight: t('en ligne droite') };
            const options = [['', t('Automatique (${mode})', { mode: labels[auto] })],
                ['walk', labels.walk], ['bike', labels.bike], ['car', labels.car], ['straight', labels.straight]];
            for (const [value, text] of options) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = text;
                select.append(opt);
            }
            select.value = deps.overrideOf(stop.key)?.legMode || '';
            select.addEventListener('change', () => deps.saveOverrides([{ key: stop.key, legMode: select.value || null }]));
            row.append(label, select);
            panel.append(row);
        }

        if (isCountedStop(stop) && ordered.days.length > 1) {
            const row = document.createElement('div');
            row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const label = document.createElement('label');
            label.className = 'small';
            label.textContent = t('Journée');
            const select = document.createElement('select');
            select.className = 'form-select form-select-sm w-auto parcours-edit-day';
            label.htmlFor = select.id = `parcoursEditDay-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            for (const option of ordered.days) {
                const opt = document.createElement('option');
                opt.value = option.date;
                opt.textContent = formatDay(option.date, { weekday: 'short', day: 'numeric', month: 'short' });
                opt.selected = option.date === day.date;
                select.append(opt);
            }
            select.addEventListener('change', () => {
                // Retour à la journée d'origine : l'ajustement disparaît.
                const original = stop.movedFrom || day.date;
                deps.saveOverrides([{ key: stop.key, day: select.value === original ? null : select.value, rank: null }]);
            });
            row.append(label, select);
            panel.append(row);
        }

        if (place) {
            // Nom : enregistré à l'Entrée, à la sortie du champ ou au bouton.
            const nameRow = document.createElement('div');
            nameRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const nameLabel = document.createElement('label');
            nameLabel.className = 'small';
            nameLabel.textContent = t('Nom');
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.maxLength = 80;
            nameInput.className = 'form-control form-control-sm w-auto parcours-edit-place-name';
            nameInput.value = place.name || '';
            nameLabel.htmlFor = nameInput.id = `parcoursEditPlaceName-${place.id}`;
            let applied = place.name || '';
            const saveName = () => {
                const name = nameInput.value.trim();
                // La suppression de l'input pendant le re-rendu relance
                // change sur blur : ignorer la valeur déjà appliquée.
                if (name === applied) return;
                applied = name;
                deps.updatePlace(place.id, { name });
            };
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveName(); });
            nameInput.addEventListener('change', saveName);
            const rename = button('btn btn-sm btn-outline-primary parcours-edit-place-rename', 'ti-check',
                t('Renommer'), { text: t('Renommer') });
            rename.addEventListener('click', saveName);
            nameRow.append(nameLabel, nameInput, rename);
            panel.append(nameRow);

            // Type et journée : un lieu est rattaché à une journée, une base peut
            // valoir pour toutes.
            const metaRow = document.createElement('div');
            metaRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
            const kindLabel = document.createElement('label');
            kindLabel.className = 'small';
            kindLabel.textContent = t('Type');
            const kindSelect = document.createElement('select');
            kindSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-kind';
            kindLabel.htmlFor = kindSelect.id = `parcoursEditPlaceKind-${place.id}`;
            for (const [value, text] of [[KIND_PLACE, t('Lieu')], [KIND_BASE, t('Base')]]) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = text;
                kindSelect.append(opt);
            }
            kindSelect.value = place.kind;
            kindSelect.addEventListener('change', () => {
                const patch = { kind: kindSelect.value };
                // Une base de toutes les journées n'a pas de date : un lieu en
                // exige une — celle du jour où elle s'affichait.
                if (patch.kind === KIND_PLACE && !place.date) patch.date = day.date;
                deps.updatePlace(place.id, patch);
            });
            const dayLabel = document.createElement('label');
            dayLabel.className = 'small';
            dayLabel.textContent = t('Journée');
            const daySelect = document.createElement('select');
            daySelect.className = 'form-select form-select-sm w-auto parcours-edit-place-day';
            dayLabel.htmlFor = daySelect.id = `parcoursEditPlaceDay-${place.id}`;
            const all = document.createElement('option');
            all.value = '';
            all.textContent = t('Toutes les journées');
            all.disabled = place.kind !== KIND_BASE;
            all.hidden = place.kind !== KIND_BASE;
            daySelect.append(all);
            for (const option of ordered.days) {
                const opt = document.createElement('option');
                opt.value = option.date;
                opt.textContent = formatDay(option.date, { weekday: 'short', day: 'numeric', month: 'short' });
                daySelect.append(opt);
            }
            daySelect.value = place.date || '';
            daySelect.addEventListener('change', () => deps.updatePlace(place.id, { date: daySelect.value || null }));
            metaRow.append(kindLabel, kindSelect, dayLabel, daySelect);
            // Rôle d'une base : départ et retour, ou une seule extrémité — partir
            // d'un hôtel, dormir ailleurs.
            if (place.kind === KIND_BASE) {
                const roleLabel = document.createElement('label');
                roleLabel.className = 'small';
                roleLabel.textContent = t('Rôle');
                const roleSelect = document.createElement('select');
                roleSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-role';
                roleLabel.htmlFor = roleSelect.id = `parcoursEditPlaceRole-${place.id}`;
                for (const [value, text] of [['both', t('Départ et retour')],
                        ['start', t('Départ seulement')], ['end', t('Arrivée seulement')]]) {
                    const opt = document.createElement('option');
                    opt.value = value;
                    opt.textContent = text;
                    roleSelect.append(opt);
                }
                roleSelect.value = ['start', 'end'].includes(place.role) ? place.role : 'both';
                roleSelect.addEventListener('change', () => deps.updatePlace(place.id, { role: roleSelect.value }));
                metaRow.append(roleLabel, roleSelect);
            }
            // Catégorie d'affichage : icône dans la liste et sur la carte ; le
            // comportement reste celui du type.
            const catLabel = document.createElement('label');
            catLabel.className = 'small';
            catLabel.textContent = t('Catégorie');
            const catSelect = document.createElement('select');
            catSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-category';
            catLabel.htmlFor = catSelect.id = `parcoursEditPlaceCategory-${place.id}`;
            for (const value of deps.placeCategories) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = categoryOptionLabel(value);
                catSelect.append(opt);
            }
            catSelect.value = deps.placeCategories.includes(place.category) ? place.category : 'other';
            catSelect.addEventListener('change', () => deps.updatePlace(place.id, { category: catSelect.value }));
            metaRow.append(catLabel, catSelect);
            panel.append(metaRow);
            // Icône libre pour la catégorie « custom ».
            if (place.category === 'custom') {
                const picker = document.createElement('div');
                picker.className = 'parcours-icon-picker mb-2';
                const selected = /^ti-[a-z0-9-]+$/.test(place.icon || '') ? place.icon : deps.customIcons[0];
                deps.buildIconPicker(picker, selected, (cls) => deps.updatePlace(place.id, { icon: cls }));
                panel.append(picker);
            }
        }

        const actions = document.createElement('div');
        actions.className = 'd-flex gap-2 flex-wrap';
        const locate = button('btn btn-sm btn-outline-secondary parcours-edit-locate', 'ti-focus-2',
            t('Voir sur la carte'), { text: t('Voir sur la carte') });
        locate.addEventListener('click', () => {
            const map = deps.getMap();
            if (!map) return;
            map.getView().animate({
                center: ol.proj.fromLonLat([stop.lon, stop.lat]),
                zoom: Math.max(map.getView().getZoom() || 0, 15),
                duration: 300,
            });
        });
        actions.append(locate);
        if (place) {
            const move = button('btn btn-sm btn-outline-secondary parcours-edit-place-move', 'ti-map-pin',
                t('Déplacer sur la carte'), { text: t('Déplacer sur la carte') });
            move.addEventListener('click', () => deps.startPlaceMove(place));
            actions.append(move);
        }
        if (isCountedStop(stop)) {
            const exclude = button('btn btn-sm btn-outline-danger parcours-edit-exclude', 'ti-eye-off',
                t('Exclure du parcours'), { text: t('Exclure du parcours') });
            exclude.addEventListener('click', () => deps.excludeStop(stop));
            actions.append(exclude);
        } else if (place) {
            const remove = button('btn btn-sm btn-outline-danger parcours-edit-delete-place', 'ti-trash',
                place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu'),
                { text: place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu') });
            remove.addEventListener('click', () => {
                editKey = null;
                deps.deletePlace(place.id);
            });
            actions.append(remove);
        }
        panel.append(actions);
        return panel;
    }

    // Panneau d'ajustement d'une étape ouvert dans la liste (onglet Données).
    function openDetails(key) {
        editKey = key;
        expandDayOf(key);
        render();
        deps.showDataTab();
        el('parcoursStops')?.querySelector(`[data-edit-key="${CSS.escape(key)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    // Parcours changé ou fermé : rien de la liste précédente ne se reporte.
    function reset() {
        editKey = null;
        collapsedDays.clear();
        cancelDrag();
    }

    // « Tout plier / Tout déplier » : bascule puis reconstruction de la liste.
    function toggleCollapseAll() {
        const days = s().ordered?.days || [];
        const allCollapsed = days.length > 0 && days.every((d) => collapsedDays.has(d.date));
        collapsedDays = allCollapsed ? new Set() : new Set(days.map((d) => d.date));
        render();
    }

    return {
        render,
        openDetails,
        reset,
        toggleCollapseAll,
        setEditKey: (key) => { editKey = key; },
        getEditKey: () => editKey,
        parkingsByDate: dayParkings,
    };
}
