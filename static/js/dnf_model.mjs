// Règles pures des points DNF (docs/logs-geocaching.md, lot C), sans DOM ni
// carte — testées par tests/js/dnf_model.test.mjs.
//
// Un point DNF apparaît à son premier DNF et disparaît le jour où une
// trouvaille le résout (la trouvaille prend alors sa place). Les jours sont
// des numéros de jour (dateToDayNumber) : `dayOf('2026-07-20')` → nombre.

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
