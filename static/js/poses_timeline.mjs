// Chronologie de la page Mes poses (docs/mode-poses.md) : caches posées par le
// joueur, leurs changements d'état et tous leurs logs, en tableaux typés.
//
// La charge utile (/api/poses/data, poses_dataset.py) reprend le format en
// colonnes du mode Évolution — buildEvolutionBase, filterRows, l'arbre
// pays/régions et l'horloge de evolution_timeline.mjs servent tels quels — et
// y ajoute :
//   st : changements d'état effectifs (cache, jour, état, déduit), triés par
//        (jour, cache) ;
//   ev : un log par ligne (cache, jour, type, favori, ramené, auteur), triés
//        par (jour, cache, log_id).
//
// Module pur (aucun DOM, aucune feature OpenLayers) : testé par node --test.

import { buildEvolutionBase } from './evolution_timeline.mjs';
import { EVO_NEVER_DAY } from './evolution_style.mjs';
import { flashKindOfLog, flashPriority } from './event_flash.mjs';

export const STATE_ACTIVE = 0;
export const STATE_DISABLED = 1;
export const STATE_ARCHIVED = 2;

// Source de la date d'apparition (colonne `appearSource`) : miroir de
// poses_dataset.APPEAR_*.
export const APPEAR_PUBLISH = 0;
export const APPEAR_PLACED = 1;
export const APPEAR_BETA_FIND = 2;
export const APPEAR_FIRST_LOG = 3;

// Grandeurs comptées jour après jour : balises de la ligne d'infos (la
// première alimente aussi le compteur de caches) et courbes Stats.
//   actives      caches visibles non archivées (désactivées comprises)
//   posees       caches apparues (cumul)
//   archivees    caches archivées à ce jour (une désarchivée en sort)
//   desactivees  caches désactivées à ce jour
//   trouvailles  trouvailles reçues (cumul) — favoris, DNF, logs : idem
//   trouveurs    joueurs distincts ayant trouvé au moins une cache
export const POSES_COUNTER_TAGS = Object.freeze([
    'actives', 'posees', 'archivees', 'desactivees', 'trouvailles', 'favoris', 'dnf', 'logs', 'trouveurs',
]);

export function buildPosesBase(payload) {
    const base = buildEvolutionBase(payload);
    const n = base.count;
    base.name = Array.isArray(payload?.name) ? payload.name : [];
    base.appearSource = Uint8Array.from(payload?.appearSource || [], Number);
    base.geoBorrowed = Uint8Array.from(payload?.geoBorrowed || [], Number);
    const st = payload?.st || {};
    base.st = {
        cache: Int32Array.from(st.cache || [], Number),
        day: Int32Array.from(st.day || [], Number),
        state: Uint8Array.from(st.state || [], Number),
        synthetic: Uint8Array.from(st.synthetic || [], Number),
    };
    const ev = payload?.ev || {};
    base.ev = {
        cache: Int32Array.from(ev.cache || [], Number),
        day: Int32Array.from(ev.day || [], Number),
        kind: Uint8Array.from(ev.kind || [], Number),
        fav: Uint8Array.from(ev.fav || [], Number),
        folded: Uint8Array.from(ev.folded || [], Number),
        author: Int32Array.from(ev.author || [], Number),
    };
    base.logKinds = Array.isArray(payload?.logKinds) ? payload.logKinds : [];
    base.authors = Array.isArray(payload?.authors) ? payload.authors : [];
    base.kindCode = Object.fromEntries(base.logKinds.map((kind, code) => [kind, code]));

    // Changements de chaque cache, dans l'ordre chronologique (CSR) : `st`
    // est trié par jour, le remplissage par cache conserve cet ordre.
    const chStart = new Int32Array(n + 1);
    for (let j = 0; j < base.st.cache.length; j++) chStart[base.st.cache[j] + 1]++;
    for (let i = 0; i < n; i++) chStart[i + 1] += chStart[i];
    const fill = chStart.slice(0, n);
    const chDay = new Int32Array(base.st.cache.length);
    const chState = new Uint8Array(base.st.cache.length);
    for (let j = 0; j < base.st.cache.length; j++) {
        const at = fill[base.st.cache[j]]++;
        chDay[at] = base.st.day[j];
        chState[at] = base.st.state[j];
    }
    base.chStart = chStart;
    base.chDay = chDay;
    base.chState = chState;
    return base;
}

// État de la cache `i` (ligne de la base) à la fin du jour `day`.
export function stateAt(base, i, day) {
    let lo = base.chStart[i];
    let hi = base.chStart[i + 1] - 1;
    let state = STATE_ACTIVE;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (base.chDay[mid] <= day) {
            state = base.chState[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return state;
}

// Segments de présence d'une cache quand les archivées disparaissent :
// [début, fin[ ; un archivage termine le segment, un désarchivage en ouvre un.
function visibleSegments(base, i) {
    const segments = [];
    let start = base.placed[i];
    let previous = STATE_ACTIVE;
    for (let j = base.chStart[i]; j < base.chStart[i + 1]; j++) {
        const day = base.chDay[j];
        const state = base.chState[j];
        if (state === STATE_ARCHIVED && previous !== STATE_ARCHIVED) {
            segments.push([start, day]);
            start = null;
        } else if (previous === STATE_ARCHIVED && state !== STATE_ARCHIVED) {
            start = day;
        }
        previous = state;
    }
    if (start !== null) segments.push([start, EVO_NEVER_DAY]);
    return segments;
}

// { placedDay, archivedDay } d'une cache pour le shader au jour `day`.
// - 'grey' : présente de l'apparition à la fin (l'archivage la grise) ;
// - 'hide' : segment de présence en cours — le dernier commencé au plus tard
//   ce jour-là, sinon le premier. Il n'est remplacé qu'au désarchivage, pour
//   que la disparition de l'archivage ait le temps de se jouer.
export function visibleSegment(base, i, day, display = 'grey') {
    if (display !== 'hide') return { placedDay: base.placed[i], archivedDay: EVO_NEVER_DAY };
    const segments = visibleSegments(base, i);
    let pick = segments[0];
    for (const segment of segments) {
        if (segment[0] <= day) pick = segment;
    }
    return { placedDay: pick[0], archivedDay: pick[1] };
}

// Index par jour (tri par comptage) des valeurs `days[idx]` pour `indices`.
function indexByDay(indices, days, firstDay, span) {
    const start = new Int32Array(span + 1);
    for (const idx of indices) start[days[idx] - firstDay + 1]++;
    for (let d = 0; d < span; d++) start[d + 1] += start[d];
    const order = new Int32Array(start[span]);
    const fill = start.slice(0, span);
    for (const idx of indices) order[fill[days[idx] - firstDay]++] = idx;
    return { start, order };
}

// Chronologie des lignes retenues par les filtres (`rows`, ordre des
// features). Les index d'événements restent ceux de la base (base.ev, base.st).
export function buildPosesTimeline(base, rows, { archivedDisplay = 'grey' } = {}) {
    const n = rows.length;
    const featureOf = new Int32Array(base.count).fill(-1);
    for (let k = 0; k < n; k++) featureOf[rows[k]] = k;

    const evIdx = [];
    for (let j = 0; j < base.ev.cache.length; j++) if (featureOf[base.ev.cache[j]] >= 0) evIdx.push(j);
    const stIdx = [];
    for (let j = 0; j < base.st.cache.length; j++) if (featureOf[base.st.cache[j]] >= 0) stIdx.push(j);

    let firstDay = Infinity;
    let lastDay = -Infinity;
    for (let k = 0; k < n; k++) {
        const p = base.placed[rows[k]];
        if (p < firstDay) firstDay = p;
        if (p > lastDay) lastDay = p;
    }
    for (const j of evIdx) if (base.ev.day[j] > lastDay) lastDay = base.ev.day[j];
    for (const j of stIdx) if (base.st.day[j] > lastDay) lastDay = base.st.day[j];
    if (n === 0) {
        firstDay = 0;
        lastDay = 0;
    }
    const span = lastDay - firstDay + 1;

    const ev = indexByDay(evIdx, base.ev.day, firstDay, span);
    const st = indexByDay(stIdx, base.st.day, firstDay, span);
    const appear = indexByDay(Array.from(rows.keys()), Int32Array.from(rows, (i) => base.placed[i]), firstDay, span);

    // Cumuls à la fin de chaque jour.
    const cum = {};
    for (const tag of POSES_COUNTER_TAGS) cum[tag] = new Int32Array(span);
    const state = new Uint8Array(n);
    const findCode = base.kindCode.find;
    const dnfCode = base.kindCode.dnf;
    const seenFinder = new Uint8Array(base.authors.length + 1);
    const groupsPerDay = new Int32Array(span);
    const touched = new Int32Array(n).fill(-1);
    let posees = 0, archivees = 0, desactivees = 0, trouvailles = 0, favoris = 0, dnf = 0, logs = 0, trouveurs = 0;
    for (let d = 0; d < span; d++) {
        let groups = 0;
        for (let a = appear.start[d]; a < appear.start[d + 1]; a++) {
            posees++;
            const k = appear.order[a];
            if (touched[k] !== d) { touched[k] = d; groups++; }
        }
        for (let s = st.start[d]; s < st.start[d + 1]; s++) {
            const j = st.order[s];
            const k = featureOf[base.st.cache[j]];
            const next = base.st.state[j];
            const prev = state[k];
            if (prev === STATE_ARCHIVED) archivees--;
            if (prev === STATE_DISABLED) desactivees--;
            if (next === STATE_ARCHIVED) archivees++;
            if (next === STATE_DISABLED) desactivees++;
            state[k] = next;
        }
        for (let e = ev.start[d]; e < ev.start[d + 1]; e++) {
            const j = ev.order[e];
            logs++;
            const kind = base.ev.kind[j];
            if (kind === findCode) {
                trouvailles++;
                if (base.ev.fav[j]) favoris++;
                const author = base.ev.author[j];
                if (author >= 0 && !seenFinder[author]) {
                    seenFinder[author] = 1;
                    trouveurs++;
                }
            } else if (kind === dnfCode) {
                dnf++;
            }
            const k = featureOf[base.ev.cache[j]];
            if (!base.ev.folded[j] && touched[k] !== d) { touched[k] = d; groups++; }
        }
        groupsPerDay[d] = groups;
        cum.posees[d] = posees;
        cum.archivees[d] = archivees;
        cum.desactivees[d] = desactivees;
        cum.actives[d] = posees - archivees;
        cum.trouvailles[d] = trouvailles;
        cum.favoris[d] = favoris;
        cum.dnf[d] = dnf;
        cum.logs[d] = logs;
        cum.trouveurs[d] = trouveurs;
    }

    return {
        count: n,
        firstDay,
        lastDay,
        span,
        rows,
        featureOf,
        archivedDisplay: archivedDisplay === 'hide' ? 'hide' : 'grey',
        evStart: ev.start,
        evOrder: ev.order,
        stStart: st.start,
        stOrder: st.order,
        appearStart: appear.start,
        appearOrder: appear.order,
        cum,
        groupsPerDay,
    };
}

// Valeur d'une grandeur à la fin du jour `day` (index depuis l'origine).
export function posesCounterAt(timeline, tag, day) {
    const values = timeline?.cum?.[tag];
    if (!values || timeline.count === 0) return 0;
    const d = day - timeline.firstDay;
    if (d < 0) return 0;
    return values[Math.min(d, timeline.span - 1)];
}

export function posesCountersAt(timeline, day) {
    const out = {};
    for (const tag of POSES_COUNTER_TAGS) out[tag] = posesCounterAt(timeline, tag, day);
    return out;
}

export function posesCounterMaxes(timeline) {
    const out = {};
    for (const tag of POSES_COUNTER_TAGS) {
        let max = 0;
        for (const value of timeline?.cum?.[tag] || []) if (value > max) max = value;
        out[tag] = max;
    }
    return out;
}

// Bornes [a, b[ d'un index par jour pour les jours [fromDay, toDay].
function dayRange(timeline, start, fromDay, toDay) {
    const a = Math.max(0, fromDay - timeline.firstDay);
    const b = Math.min(timeline.span - 1, toDay - timeline.firstDay);
    if (timeline.count === 0 || b < a) return [0, 0];
    return [start[a], start[b + 1]];
}

// Positions (dans `rows`) des caches apparues entre fromDay et toDay inclus.
export function appearancesInRange(timeline, fromDay, toDay) {
    const [a, b] = dayRange(timeline, timeline.appearStart, fromDay, toDay);
    return Array.from(timeline.appearOrder.subarray(a, b));
}

// Index (dans base.ev) des logs des jours fromDay..toDay inclus.
export function logsInRange(timeline, fromDay, toDay) {
    const [a, b] = dayRange(timeline, timeline.evStart, fromDay, toDay);
    return timeline.evOrder.subarray(a, b);
}

// Positions des caches dont l'état change entre fromDay et toDay inclus, et
// celles qui y sont archivées (changement vers l'état archivé, déduit ou non).
export function stateChangesInRange(timeline, base, fromDay, toDay) {
    const [a, b] = dayRange(timeline, timeline.stStart, fromDay, toDay);
    const changed = new Set();
    const archived = new Set();
    for (let s = a; s < b; s++) {
        const j = timeline.stOrder[s];
        const k = timeline.featureOf[base.st.cache[j]];
        changed.add(k);
        if (base.st.state[j] === STATE_ARCHIVED) archived.add(k);
    }
    return { changed: [...changed], archived: [...archived] };
}

// Un flash par cache sur les jours fromDay..toDay : le type le plus marquant
// parmi l'apparition et les logs de la cache, et le nombre de logs (taille).
// `canFlash(kind)` dit si un type a un flash (réglage du thème) : seuls ceux-
// là concourent. Les logs ramenés au jour d'apparition ne sont ni dessinés ni
// comptés ; quand les archivées disparaissent, une cache archivée ne flashe
// plus (sauf l'archivage lui-même, qui ouvre sa disparition).
// → [{ k, kind, count }]
export function flashesInRange(timeline, base, fromDay, toDay, canFlash = () => true) {
    const best = new Map();
    const entry = (k) => {
        let e = best.get(k);
        if (!e) best.set(k, (e = { k, kind: null, rank: Infinity, count: 0 }));
        return e;
    };
    const offer = (e, kind) => {
        const rank = flashPriority(kind);
        if (rank < e.rank && canFlash(kind)) {
            e.kind = kind;
            e.rank = rank;
        }
    };
    for (const k of appearancesInRange(timeline, fromDay, toDay)) offer(entry(k), 'publish');
    const hide = timeline.archivedDisplay === 'hide';
    for (const j of logsInRange(timeline, fromDay, toDay)) {
        if (base.ev.folded[j]) continue;
        const i = base.ev.cache[j];
        const logKind = base.logKinds[base.ev.kind[j]];
        if (hide && logKind !== 'archive' && stateAt(base, i, base.ev.day[j]) === STATE_ARCHIVED) continue;
        const e = entry(timeline.featureOf[i]);
        e.count++;
        offer(e, flashKindOfLog(logKind, !!base.ev.fav[j]));
    }
    const out = [];
    for (const e of best.values()) {
        if (e.kind) out.push({ k: e.k, kind: e.kind, count: Math.max(1, e.count) });
    }
    return out;
}

// Trouvailles reçues par jour, [[jour absolu (dateToDayNumber), nombre]]
// triés : jalons « Ne trouvaille reçue » des images planifiées.
export function findDayCounts(timeline, base) {
    const out = [];
    if (!timeline || timeline.count === 0) return out;
    let previous = 0;
    for (let d = 0; d < timeline.span; d++) {
        const value = timeline.cum.trouvailles[d];
        if (value !== previous) out.push([base.originDay + timeline.firstDay + d, value - previous]);
        previous = value;
    }
    return out;
}

// Pic de flashs simultanés sur une fenêtre de `windowDays` jours (estimation
// de charge de l'onglet Animation) : au plus un flash par cache et par jour.
export function maxFlashesInWindow(timeline, windowDays) {
    const values = timeline?.groupsPerDay;
    if (!values || values.length === 0) return 0;
    const w = Math.max(1, Math.ceil(Number(windowDays) || 1));
    let sum = 0;
    let max = 0;
    for (let d = 0; d < values.length; d++) {
        sum += values[d];
        if (d >= w) sum -= values[d - w];
        if (sum > max) max = sum;
    }
    return max;
}
