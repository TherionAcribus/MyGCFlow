// Règles pures des caches posées sur la carte principale (« Mes caches
// posées », docs/logs-geocaching.md), sans DOM ni carte — testées par
// tests/js/owner_model.test.mjs.
//
// Une cache posée apparaît le jour de son apparition (mêmes règles que la
// page Mes poses, calculées par owner_geojson.py) et reste ensuite sur la
// carte : désactivée ou archivée, elle est grisée (attribut `pstate`, comme
// sur la page Mes poses). Les étapes du poseur (maintenance, désactivation,
// réactivation, archivage) jouent un flash et sont des étapes du trajet.
// Les jours sont des numéros de jour (dateToDayNumber).

import { ownerFlashKindOf, ownerFlashPriority } from './event_flash.mjs';

// États (poses_dataset.STATE_*), valeurs de l'attribut `pstate`.
export const OWNER_STATE_ACTIVE = 0;
export const OWNER_STATE_DISABLED = 1;
export const OWNER_STATE_ARCHIVED = 2;

// Réglages du thème (points.owner_* côté serveur, pkg.options.point.owner
// côté client) : forme en vectoriel (« same » = celle des trouvailles),
// couleur et épaisseur du contour (bordure en vectoriel, anneau autour de
// l'icône en mode icônes ; 0 = aucun). Mêmes valeurs que settings_manager
// (OWNER_POINT_SHAPES, OWNER_BORDER_WIDTH_RANGE).
export const OWNER_POINT_DEFAULTS = Object.freeze({ shape: 'star', borderColor: '#ffc107', borderWidth: 2 });
export const OWNER_SHAPES = Object.freeze(['star', 'square', 'diamond', 'triangle', 'circle', 'same']);
export const OWNER_BORDER_WIDTH_MAX = 6;

export function ownerPointOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const width = Number(src.borderWidth);
    return {
        shape: OWNER_SHAPES.includes(src.shape) ? src.shape : OWNER_POINT_DEFAULTS.shape,
        borderColor: /^#[0-9a-fA-F]{6}$/.test(src.borderColor || '') ? src.borderColor.toLowerCase() : OWNER_POINT_DEFAULTS.borderColor,
        borderWidth: Number.isFinite(width)
            ? Math.min(OWNER_BORDER_WIDTH_MAX, Math.max(0, Math.round(width)))
            : OWNER_POINT_DEFAULTS.borderWidth,
    };
}

// Entrées triées par jour d'apparition, une par feature exploitable.
// `ol` est l'objet carte, créé à la demande par mapgl.js.
export function buildOwnerEntries(features, dayOf) {
    const entries = [];
    for (const feature of features || []) {
        const p = feature?.properties || {};
        const appearDay = dayOf(p.date_find);
        if (!Number.isFinite(appearDay)) continue;
        const states = [];
        for (const pair of Array.isArray(p.owner_states) ? p.owner_states : []) {
            const day = dayOf(pair?.[0]);
            const state = Number(pair?.[1]);
            if (Number.isFinite(day) && Number.isInteger(state)) states.push({ day, state });
        }
        states.sort((a, b) => a.day - b.day);
        const events = [];
        for (const pair of Array.isArray(p.owner_events) ? p.owner_events : []) {
            const day = dayOf(pair?.[0]);
            const kind = ownerFlashKindOf(pair?.[1]);
            if (Number.isFinite(day) && kind) events.push({ day, kind });
        }
        events.sort((a, b) => a.day - b.day);
        // Un déplacement par jour : la pose, puis chaque jour d'étape.
        const visitDays = [...new Set([appearDay, ...events.map((e) => e.day)])].sort((a, b) => a - b);
        entries.push({ feature, appearDay, states, events, visitDays, ol: null });
    }
    entries.sort((a, b) => a.appearDay - b.appearDay);
    return entries;
}

// Présente à la fin du jour `day` : apparue (elle ne disparaît jamais, une
// archivée reste grisée).
export function ownerVisibleAt(entry, day) {
    return entry.appearDay <= day;
}

// État à la fin du jour `day` (0 active, 1 désactivée, 2 archivée).
export function ownerStateAt(entry, day) {
    let state = OWNER_STATE_ACTIVE;
    for (const change of entry.states) {
        if (change.day > day) break;
        state = change.state;
    }
    return state;
}

// Flash à jouer pour un lot de jours ]afterDay, upToDay] : la pose et les
// étapes du poseur du lot, le type le plus marquant l'emporte (ordre de
// OWNER_FLASH_KINDS) parmi ceux qui flashent (`isEnabled`). null : rien.
export function ownerFlashBetween(entry, afterDay, upToDay, isEnabled = () => true) {
    let best = null;
    const consider = (kind) => {
        if (!isEnabled(kind)) return;
        if (best === null || ownerFlashPriority(kind) < ownerFlashPriority(best)) best = kind;
    };
    if (entry.appearDay > afterDay && entry.appearDay <= upToDay) consider('place');
    for (const event of entry.events) {
        if (event.day <= afterDay) continue;
        if (event.day > upToDay) break;
        consider(event.kind);
    }
    return best;
}

// Événements comptés par les Stats (source « caches posées ») : une cache
// par jour d'apparition (date_find), Map clé Date.toDateString().
export function ownerEventsByDate(features) {
    const byDate = new Map();
    for (const feature of features || []) {
        const iso = feature?.properties?.date_find;
        const date = new Date(`${iso}T00:00:00`);
        if (!iso || Number.isNaN(date.getTime())) continue;
        const key = date.toDateString();
        const list = byDate.get(key) || [];
        list.push(feature);
        byDate.set(key, list);
    }
    return byDate;
}

// Tuiles d'état au jour `day` : caches apparues par état, et maintenances
// du poseur faites jusque-là.
export function ownerStatesAt(entries, day) {
    const out = { active: 0, disabled: 0, archived: 0, maintenances: 0 };
    for (const entry of entries || []) {
        if (entry.appearDay > day) continue;
        const state = ownerStateAt(entry, day);
        if (state === OWNER_STATE_ARCHIVED) out.archived += 1;
        else if (state === OWNER_STATE_DISABLED) out.disabled += 1;
        else out.active += 1;
        for (const event of entry.events) {
            if (event.day > day) break;
            if (event.kind === 'maintenance') out.maintenances += 1;
        }
    }
    return out;
}

// Passages du poseur pour le trait de déplacement : Map jour → [[lon, lat], …],
// jours au plus égaux à `endDay`.
export function ownerVisitsByDay(entries, endDay = Infinity) {
    const byDay = new Map();
    for (const entry of entries || []) {
        const coords = entry.feature?.geometry?.coordinates;
        if (!Array.isArray(coords)) continue;
        for (const day of entry.visitDays) {
            if (day > endDay) continue;
            const list = byDay.get(day) || [];
            list.push(coords);
            byDay.set(day, list);
        }
    }
    return byDay;
}
