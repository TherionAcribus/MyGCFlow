// Chronologie du mode Évolution : qui apparaît et qui disparaît chaque jour,
// combien de caches sont actives à une date donnée, et horloge des variables
// de style qui animent les points (voir evolution_style.mjs).
//
// Les données arrivent du serveur en colonnes (voir evolution_store.
// load_payload) : un tableau par champ plutôt qu'un objet par cache, triées
// par date de placement. Tout reste en tableaux typés : 500 000 caches tiennent
// en quelques dizaines de Mo et chaque construction est en O(n + jours).
//
// Les jours sont des index entiers depuis `origin` (placement le plus ancien
// du jeu de données). Les dates de l'animation (objets Date à minuit local)
// sont converties par leur date calendaire, comme inclusiveDayCount : le
// changement d'heure ne décale jamais un jour.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

import { EVO_NEVER_DAY, staticEvolutionVariables } from './evolution_style.mjs';

const MS_PER_DAY = 86400000;

// --- Dates ------------------------------------------------------------------

// Numéro de jour (jours depuis 1970-01-01) d'une date ISO « AAAA-MM-JJ ».
export function isoToDayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY;
}

// Numéro de jour de la date calendaire LOCALE d'un objet Date.
export function dateToDayNumber(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return NaN;
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

// Date à minuit local correspondant à un numéro de jour.
export function dayNumberToDate(dayNumber) {
    const utc = new Date(dayNumber * MS_PER_DAY);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

// --- Jeu de données -----------------------------------------------------------

// Convertit la charge utile du serveur en tableaux typés. `archived` vaut
// EVO_NEVER_DAY pour une cache qui ne disparaît pas ; une date d'archivage
// antérieure au placement (donnée incohérente) est ramenée au placement.
export function buildEvolutionBase(payload) {
    const code = Array.isArray(payload?.code) ? payload.code : [];
    const count = code.length;
    const originDay = isoToDayNumber(payload?.origin);
    const lon = Float64Array.from(payload?.lon || [], Number);
    const lat = Float64Array.from(payload?.lat || [], Number);
    const placed = new Int32Array(count);
    const archived = new Int32Array(count);
    const status = new Uint8Array(count);
    let clampedArchives = 0;
    for (let i = 0; i < count; i++) {
        const p = Number(payload.placed?.[i]) || 0;
        const a = Number(payload.archived?.[i]);
        placed[i] = p;
        if (Number.isFinite(a) && a >= 0) {
            if (a < p) clampedArchives++;
            archived[i] = Math.max(a, p);
        } else {
            archived[i] = EVO_NEVER_DAY;
        }
        status[i] = Number(payload.status?.[i]) || 0;
    }
    return {
        count,
        dataset: payload?.dataset || null,
        origin: payload?.origin || null,
        originDay,
        code,
        lon,
        lat,
        placed,
        archived,
        status,
        type: Uint16Array.from(payload?.type || [], Number),
        types: Array.isArray(payload?.types) ? payload.types : [],
        size: Uint16Array.from(payload?.size || [], Number),
        sizes: Array.isArray(payload?.sizes) ? payload.sizes : [],
        difficulty: Uint16Array.from(payload?.difficulty || [], Number),
        difficulties: Array.isArray(payload?.difficulties) ? payload.difficulties : [],
        terrain: Uint16Array.from(payload?.terrain || [], Number),
        terrains: Array.isArray(payload?.terrains) ? payload.terrains : [],
        country: Uint16Array.from(payload?.country || [], Number),
        countries: Array.isArray(payload?.countries) ? payload.countries : [],
        region: Uint16Array.from(payload?.region || [], Number),
        regions: Array.isArray(payload?.regions) ? payload.regions : [],
        county: Uint16Array.from(payload?.county || [], Number),
        counties: Array.isArray(payload?.counties) ? payload.counties : [],
        meta: payload?.meta || {},
        clampedArchives,
    };
}

// Index de jour (depuis l'origin du jeu) d'une date de l'animation.
export function dayIndexOf(base, date) {
    return dateToDayNumber(date) - base.originDay;
}

export function dateOfDayIndex(base, dayIndex) {
    return dayNumberToDate(base.originDay + dayIndex);
}

// Arbre pays -> régions, au format de /api/country_state (listes triées). Les
// libellés vides (pays ou région inconnus) n'y figurent pas : ces caches ne
// peuvent pas être filtrées sur ce critère et restent toujours incluses.
export function buildCountryRegionTree(base) {
    const tree = new Map();
    for (let i = 0; i < base.count; i++) {
        const country = base.countries[base.country[i]] || '';
        if (!country) continue;
        let regions = tree.get(country);
        if (!regions) tree.set(country, regions = new Set());
        const region = base.regions[base.region[i]] || '';
        if (region) regions.add(region);
    }
    const out = {};
    for (const country of [...tree.keys()].sort((a, b) => a.localeCompare(b))) {
        out[country] = [...tree.get(country)].sort((a, b) => a.localeCompare(b));
    }
    return out;
}

// Arbre région -> départements, miroir de buildCountryRegionTree : les
// libellés vides n'y figurent ni en clé ni en valeur, mais une région connue
// reste une clé même quand aucune de ses caches n'a de département (liste
// vide — le select Département n'a alors rien à proposer pour elle).
export function buildRegionCountyTree(base) {
    const tree = new Map();
    for (let i = 0; i < base.count; i++) {
        const region = base.regions[base.region[i]] || '';
        if (!region) continue;
        let counties = tree.get(region);
        if (!counties) tree.set(region, counties = new Set());
        const county = base.counties[base.county[i]] || '';
        if (county) counties.add(county);
    }
    const out = {};
    for (const region of [...tree.keys()].sort((a, b) => a.localeCompare(b))) {
        out[region] = [...tree.get(region)].sort((a, b) => a.localeCompare(b));
    }
    return out;
}

// Lignes retenues par les filtres (pays, région, type, taille, difficulté,
// terrain, département), dans l'ordre du jeu — donc par date de placement.
// Chaque critère est la liste des libellés sélectionnés, ou null/undefined
// quand il est inactif (aucune option proposée). Une liste vide signifie
// « Aucun » et ne retient rien ; une ligne dont le libellé est vide (valeur
// inconnue, non filtrable) passe toujours le critère, comme les caches sans
// région pour le filtre Pays / Région.
export function filterRows(base, selection = {}) {
    // (libellés choisis, colonne d'index, table de libellés) par critère.
    const specs = [
        [selection.countries, base.country, base.countries],
        [selection.regions, base.region, base.regions],
        [selection.types, base.type, base.types],
        [selection.sizes, base.size, base.sizes],
        [selection.difficulties, base.difficulty, base.difficulties],
        [selection.terrains, base.terrain, base.terrains],
        [selection.counties, base.county, base.counties],
    ];
    // Un critère actif devient [ok, column] : ok[idx] vaut false seulement si
    // le libellé est connu et non choisi (index hors table = libellé vide).
    const checks = [];
    for (const [picked, column, labels] of specs) {
        if (!Array.isArray(picked)) continue;
        if (picked.length === 0) return new Int32Array(0);
        if (!column) continue;
        const set = new Set(picked.map(String));
        checks.push([(labels || []).map((label) => !label || set.has(label)), column]);
    }
    const rows = new Int32Array(base.count);
    let n = 0;
    for (let i = 0; i < base.count; i++) {
        let pass = true;
        for (const [ok, column] of checks) {
            if (ok[column[i]] === false) { pass = false; break; }
        }
        if (pass) rows[n++] = i;
    }
    return rows.slice(0, n);
}

// --- Chronologie --------------------------------------------------------------

// Événements par jour pour les lignes retenues. Les index produits (placed /
// archived) désignent la POSITION de la cache dans `rows`, c'est-à-dire dans
// le tableau de features construit dans le même ordre.
export function buildTimeline(base, rows) {
    const n = rows.length;
    let firstDay = Infinity;
    let lastDay = -Infinity;
    for (let k = 0; k < n; k++) {
        const i = rows[k];
        const p = base.placed[i];
        const a = base.archived[i];
        if (p < firstDay) firstDay = p;
        if (p > lastDay) lastDay = p;
        if (a !== EVO_NEVER_DAY && a > lastDay) lastDay = a;
    }
    if (n === 0) {
        firstDay = 0;
        lastDay = 0;
    }
    const span = lastDay - firstDay + 1;

    // Tri par comptage (O(n + jours)) : offsets de chaque jour dans *Order.
    const placedStart = new Int32Array(span + 1);
    const archivedStart = new Int32Array(span + 1);
    for (let k = 0; k < n; k++) {
        const i = rows[k];
        placedStart[base.placed[i] - firstDay + 1]++;
        const a = base.archived[i];
        if (a !== EVO_NEVER_DAY) archivedStart[a - firstDay + 1]++;
    }
    for (let d = 0; d < span; d++) {
        placedStart[d + 1] += placedStart[d];
        archivedStart[d + 1] += archivedStart[d];
    }
    const placedOrder = new Int32Array(placedStart[span]);
    const archivedOrder = new Int32Array(archivedStart[span]);
    const placedFill = placedStart.slice(0, span);
    const archivedFill = archivedStart.slice(0, span);
    for (let k = 0; k < n; k++) {
        const i = rows[k];
        placedOrder[placedFill[base.placed[i] - firstDay]++] = k;
        const a = base.archived[i];
        if (a !== EVO_NEVER_DAY) archivedOrder[archivedFill[a - firstDay]++] = k;
    }

    // Caches actives à la fin de chaque jour : placées ce jour-là ou avant, et
    // pas encore archivées (une cache archivée le jour J disparaît le jour J).
    const activeByDay = new Int32Array(span);
    let active = 0;
    let peakActive = 0;
    let maxEventsPerDay = 0;
    for (let d = 0; d < span; d++) {
        const placedToday = placedStart[d + 1] - placedStart[d];
        const archivedToday = archivedStart[d + 1] - archivedStart[d];
        active += placedToday - archivedToday;
        activeByDay[d] = active;
        if (active > peakActive) peakActive = active;
        if (placedToday + archivedToday > maxEventsPerDay) maxEventsPerDay = placedToday + archivedToday;
    }

    return {
        count: n,
        firstDay,
        lastDay,
        placedStart,
        placedOrder,
        archivedStart,
        archivedOrder,
        activeByDay,
        peakActive,
        maxEventsPerDay,
    };
}

// Caches actives à la fin du jour `day` (index depuis l'origin du jeu).
export function activeAt(timeline, day) {
    if (!timeline || timeline.count === 0 || !Number.isFinite(day)) return 0;
    if (day < timeline.firstDay) return 0;
    const d = Math.min(day, timeline.lastDay) - timeline.firstDay;
    return timeline.activeByDay[d];
}

// Caches placées et archivées pendant les jours [fromDay, toDay] (bornes
// comprises) : vues sur les tableaux de la chronologie, sans copie.
export function eventsInRange(timeline, fromDay, toDay) {
    const empty = new Int32Array(0);
    if (!timeline || timeline.count === 0) return { placed: empty, archived: empty };
    const from = Math.max(fromDay, timeline.firstDay) - timeline.firstDay;
    const to = Math.min(toDay, timeline.lastDay) - timeline.firstDay;
    if (!(to >= from)) return { placed: empty, archived: empty };
    return {
        placed: timeline.placedOrder.subarray(timeline.placedStart[from], timeline.placedStart[to + 1]),
        archived: timeline.archivedOrder.subarray(timeline.archivedStart[from], timeline.archivedStart[to + 1]),
    };
}

// Nombre maximal d'événements (apparitions + disparitions) sur une fenêtre
// glissante de `windowDays` jours : ordre de grandeur des flashs affichés en
// même temps quand un flash dure `windowDays` jours d'animation.
export function maxEventsInWindow(timeline, windowDays) {
    if (!timeline || timeline.count === 0) return 0;
    const span = timeline.lastDay - timeline.firstDay + 1;
    const w = Math.max(1, Math.min(span, Math.ceil(Number(windowDays) || 1)));
    const events = (d) => (timeline.placedStart[d + 1] - timeline.placedStart[d])
        + (timeline.archivedStart[d + 1] - timeline.archivedStart[d]);
    let sum = 0;
    let best = 0;
    for (let d = 0; d < span; d++) {
        sum += events(d);
        if (d >= w) sum -= events(d - w);
        if (sum > best) best = sum;
    }
    return best;
}

// --- Horloge des variables de style -------------------------------------------
//
// Pendant une animation, `day` est le dernier jour affiché et `stepAt` l'instant
// (horloge des points) où il l'a été. Le temps écoulé depuis est plafonné à la
// durée d'un jour tant que les dates défilent : une pause fige les effets en
// cours au lieu de les laisser se terminer puis se rejouer à la reprise, et un
// rendu lent ne fait jamais « vieillir » les points plus vite que l'animation.
// Après le dernier jour, le plafond est levé pour que les effets se terminent.

export function createEvolutionClock() {
    return {
        running: false,
        fromDay: 0,
        day: 0,
        stepAt: 0,
        lastReached: false,
        restDay: 0,
    };
}

export function beginEvolution(clock, startDay, at) {
    clock.running = true;
    clock.fromDay = startDay;
    clock.day = startDay - 1;
    clock.stepAt = at;
    clock.lastReached = false;
}

export function stepEvolution(clock, day, at, isLast = false) {
    clock.day = day;
    clock.stepAt = at;
    clock.lastReached = !!isLast;
}

export function endEvolution(clock) {
    clock.running = false;
}

export function evolutionFrameVariables(clock, { now = 0, msPerDay = 1, stagger = false } = {}) {
    if (!clock.running) return staticEvolutionVariables(clock.restDay);
    const perDay = Math.max(1e-3, Number(msPerDay) || 1);
    const elapsed = Math.max(0, (Number(now) || 0) - clock.stepAt);
    return {
        evoDay: clock.day,
        evoIntraMs: clock.lastReached ? elapsed : Math.min(elapsed, perDay),
        evoFrom: clock.fromDay,
        evoMsPerDay: perDay,
        evoStagger: stagger ? 1 : 0,
    };
}
