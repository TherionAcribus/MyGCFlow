// Règles pures des points DNF (docs/logs-geocaching.md, lot C), sans DOM ni
// carte — testées par tests/js/dnf_model.test.mjs.
//
// Un point DNF apparaît à son premier DNF et disparaît le jour où une
// trouvaille le résout (la trouvaille prend alors sa place). Les jours sont
// des numéros de jour (dateToDayNumber) : `dayOf('2026-07-20')` → nombre.

// Réglages du thème (points.dnf_* côté serveur, pkg.options.point.dnf côté
// client) : forme, couleur de point et contour en vectoriel (« same » =
// forme des trouvailles ; une épaisseur nulle retire le contour — bordure
// de la forme en vectoriel, anneau autour de l'icône en mode icônes) et
// choix de l'icône (« dnf » = celle des échecs, « type » = celle du type de
// cache, marquée de l'anneau). Mêmes formes que settings_manager
// (OWNER_POINT_SHAPES, DNF_BORDER_WIDTH_RANGE).
export const DNF_POINT_DEFAULTS = Object.freeze({
    shape: 'circle', color: '#000000', borderColor: '#ffffff', borderWidth: 2, icon: 'dnf',
});
export const DNF_SHAPES = Object.freeze(['circle', 'square', 'diamond', 'triangle', 'star', 'same']);
export const DNF_ICONS = Object.freeze(['dnf', 'type']);
export const DNF_BORDER_WIDTH_MAX = 6;

export function dnfPointOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const width = Number(src.borderWidth);
    const hex = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(value || '') ? value.toLowerCase() : fallback);
    return {
        shape: DNF_SHAPES.includes(src.shape) ? src.shape : DNF_POINT_DEFAULTS.shape,
        color: hex(src.color, DNF_POINT_DEFAULTS.color),
        borderColor: hex(src.borderColor, DNF_POINT_DEFAULTS.borderColor),
        borderWidth: Number.isFinite(width)
            ? Math.min(DNF_BORDER_WIDTH_MAX, Math.max(0, Math.round(width)))
            : DNF_POINT_DEFAULTS.borderWidth,
        icon: DNF_ICONS.includes(src.icon) ? src.icon : DNF_POINT_DEFAULTS.icon,
    };
}

// Entrées triées par jour d'apparition, une par feature exploitable.
// `ol` est l'objet carte, créé à la demande par mapgl.js.
export function buildDnfEntries(features, dayOf) {
    const entries = [];
    for (const feature of features || []) {
        const p = feature?.properties || {};
        const appearDay = dayOf(p.date_find);
        if (!Number.isFinite(appearDay)) continue;
        const resolved = p.resolved_date ? dayOf(p.resolved_date) : null;
        const visits = (Array.isArray(p.dnf_dates) && p.dnf_dates.length ? p.dnf_dates : [p.date_find])
            .map(dayOf).filter(Number.isFinite);
        entries.push({
            feature,
            appearDay,
            resolveDay: Number.isFinite(resolved) ? resolved : null,
            visitDays: visits,
            ol: null,
        });
    }
    entries.sort((a, b) => a.appearDay - b.appearDay);
    return entries;
}

// Visible à la fin du jour `day` : apparu, pas encore résolu. Un DNF résolu
// le jour même de son apparition ne se voit donc jamais.
export function dnfVisibleAt(entry, day) {
    return entry.appearDay <= day && (entry.resolveDay === null || day < entry.resolveDay);
}

// Carte statique (hors animation) : l'état à la fin de la sélection. Un DNF
// résolu dans la période est remplacé par sa trouvaille ; `endDay` vaut
// Infinity sans borne de dates.
export function dnfVisibleStatic(entry, endDay) {
    return entry.resolveDay === null || entry.resolveDay > endDay;
}

// Fenêtre « Période de découverte » déplacée (filterLikeCurrentSelection,
// bdd.js) : un DNF n'a pas la sémantique « événement » d'une trouvaille —
// il dure. Il est retenu s'il est en échec à un moment de la fenêtre :
// apparu au plus tard à sa fin, résolu strictement après son début ou
// jamais. `startIso`/`endIso` sont des bornes 'YYYY-MM-DD', null = aucune.
export function dnfAliveInWindow(props, startIso, endIso) {
    const appear = props?.date_find;
    const resolved = props?.resolved_date || null;
    if (endIso && (!appear || appear > endIso)) return false;
    if (startIso && resolved && resolved <= startIso) return false;
    return true;
}

// Vrai si la cache a reçu un autre DNF dans ]afterDay, upToDay] : le point
// est déjà sur la carte (il y est resté depuis son apparition), la tentative
// rejoue son flash — chaque DNF est un déplacement, comme pour le trait.
// L'apparition (`appearDay`) n'y compte pas : elle joue le flash d'ajout.
export function dnfRevisitBetween(entry, afterDay, upToDay) {
    for (const visit of entry.visitDays || []) {
        if (visit !== entry.appearDay && visit > afterDay && visit <= upToDay) return true;
    }
    return false;
}

// DNF trouvé le jour même (option dnf_same_day_display, mapgl.js) : le
// point n'est jamais visible (il disparaît le jour où il apparaît). Vrai
// quand cette résolution intra-journée survient dans ]afterDay, upToDay] —
// l'animation l'affiche alors un instant puis l'efface, comme tout DNF
// résolu, avec la célébration « DNF trouvé » si elle est réglée.
export function dnfSameDayResolved(entry, afterDay, upToDay) {
    return entry.resolveDay !== null
        && entry.resolveDay === entry.appearDay
        && entry.appearDay > afterDay
        && entry.appearDay <= upToDay;
}

// Événements comptés par les Stats (source « DNF ») : un par log « Didn't
// find it », avec les propriétés de la cache et `date_find` = date du DNF —
// les métriques des trouvailles s'y appliquent telles quelles. Map
// clé `Date.toDateString()` → événements, comme pointsByDate (bdd.js).
export function dnfEventsByDate(features) {
    const byDate = new Map();
    for (const feature of features || []) {
        const p = feature?.properties || {};
        const dates = Array.isArray(p.dnf_dates) && p.dnf_dates.length ? p.dnf_dates : [p.date_find];
        for (const iso of dates) {
            const date = new Date(`${iso}T00:00:00`);
            if (!iso || Number.isNaN(date.getTime())) continue;
            const key = date.toDateString();
            const list = byDate.get(key) || [];
            list.push({ type: 'Feature', geometry: feature.geometry, properties: { ...p, date_find: iso } });
            byDate.set(key, list);
        }
    }
    return byDate;
}

// Tuiles d'état au jour `day` : caches en échec non résolues (« DNF en
// cours ») et résolues par une trouvaille, somme des durées avant résolution
// (le délai moyen en découle : resolveDays / resolved) et record de passages
// DNF sur une même cache (`visitsCode` = code GC du record).
export function dnfStatesAt(entries, day) {
    let open = 0;
    let resolved = 0;
    let resolveDays = 0;
    let visits = 0;
    let visitsCode = '';
    for (const entry of entries || []) {
        if (entry.appearDay > day) continue;
        if (entry.resolveDay !== null && entry.resolveDay <= day) {
            resolved += 1;
            resolveDays += entry.resolveDay - entry.appearDay;
        } else open += 1;
        // Record de passages « au jour » : seuls les DNF survenus comptent,
        // pas ceux à venir de cette cache.
        let visitsSoFar = 0;
        for (const visit of entry.visitDays) if (visit <= day) visitsSoFar += 1;
        if (visitsSoFar > visits) {
            visits = visitsSoFar;
            visitsCode = entry.feature?.properties?.gc_code || '';
        }
    }
    return { open, resolved, resolveDays, visits, visitsCode };
}

// Passages DNF pour le trait de déplacement : chaque DNF est un déplacement,
// même plusieurs sur la même cache. Map jour → [[lon, lat], …], jours au plus
// égaux à `endDay`.
export function dnfVisitsByDay(entries, endDay = Infinity) {
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
