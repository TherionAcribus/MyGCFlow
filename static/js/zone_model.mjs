// Cartes par zones : valeur de chaque zone à une date, échelle de couleurs,
// moments clés. Module pur (ni DOM, ni OpenLayers, ni ECharts), partagé par
// la page Statistiques (mini-cartes) et la carte (couche animée) : les deux
// affichent donc les mêmes chiffres. Testé par tests/js/zone_model.test.mjs.
// Plan : MyGCFlow_Plan_Carte_Zones.md ; doc : docs/carte-zones.md.
//
// Entrée : une table de chart_sources.mjs (une ligne = un événement daté :
// `day`, `endDay`, colonnes codées par dictionnaire) qui porte les colonnes
// de zones `zone_country`, `zone_region`, `zone_subregion` (ids de zones.py).
//
// L'état est toujours le résultat des événements jusqu'à la fin d'un jour :
// un saut en avant applique les suivants, un saut en arrière défait les
// derniers (ou repart de zéro si c'est plus court). Coût proportionnel à la
// distance parcourue, pas à la taille de la table.

import { dayNumber, dtIndex, ymdOfDay } from './stats_model.mjs';

// `grid` : cases hexagonales (zone_grid.mjs › withGridColumn ajoute la
// colonne à la table).
export const ZONE_LEVELS = Object.freeze(['country', 'region', 'subregion', 'grid']);
export const ZONE_COLUMNS = Object.freeze({
    country: 'zone_country', region: 'zone_region', subregion: 'zone_subregion', grid: 'zone_grid',
});

// Mesures (§ 5.1 du plan). `mode` : `cumulative` (tout ce qui s'est passé
// jusqu'au jour) ou `active` (lignes vivantes ce jour-là : Évolution, caches
// posées — la valeur monte ET descend).
export const ZONE_OPS = Object.freeze(['count', 'distinct', 'dt_coverage', 'mean', 'first_day']);
// `code` : caches différentes ; `day` : jours différents.
export const ZONE_DISTINCT_FIELDS = Object.freeze(['cache_type', 'container', 'owner', 'code', 'day']);
export const ZONE_MEAN_FIELDS = Object.freeze(['difficulty', 'terrain']);
export const ZONE_MODES = Object.freeze(['cumulative', 'active']);
export const DT_CELLS = 81;

// Densité (valeur par km²) : seulement pour ce qui se compte.
const PER_KM2_OPS = new Set(['count', 'distinct']);

export function normalizeZoneMeasure(raw) {
    const op = ZONE_OPS.includes(raw?.op) ? raw.op : 'count';
    const out = { op, mode: 'cumulative', per: null };
    if (op === 'distinct') out.field = ZONE_DISTINCT_FIELDS.includes(raw?.field) ? raw.field : 'cache_type';
    if (op === 'mean') out.field = ZONE_MEAN_FIELDS.includes(raw?.field) ? raw.field : 'difficulty';
    // « Première trouvaille » n'a pas de sens pour des lignes qui disparaissent.
    if (raw?.mode === 'active' && op !== 'first_day') out.mode = 'active';
    if (raw?.per === 'km2' && PER_KM2_OPS.has(op)) out.per = 'km2';
    return out;
}

// ---------------------------------------------------------------------------
// Événements

// Lignes retenues → événements triés par jour (tri par comptage : quelques
// milliers de jours distincts pour des centaines de milliers de lignes).
// Code d'un événement : r + 1 pour une apparition, -(r + 1) pour une
// disparition (fin d'activité, mode `active`).
function buildEvents(table, rows, active) {
    const n = rows ? rows.length : (table?.n || 0);
    const rowAt = rows ? (i) => rows[i] : (i) => i;
    let count = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
        const r = rowAt(i);
        const day = table.day[r];
        count++;
        if (day < lo) lo = day;
        if (day > hi) hi = day;
        if (active) {
            const end = table.endDay[r];
            if (end === end) {   // NaN : jamais de fin
                count++;
                if (end < lo) lo = end;
                if (end > hi) hi = end;
            }
        }
    }
    const day = new Int32Array(count);
    const code = new Int32Array(count);
    if (!count) return { day, code };
    const span = hi - lo + 1;
    const offsets = new Int32Array(span + 1);
    for (let i = 0; i < n; i++) {
        const r = rowAt(i);
        offsets[table.day[r] - lo + 1]++;
        if (active && table.endDay[r] === table.endDay[r]) offsets[table.endDay[r] - lo + 1]++;
    }
    for (let k = 1; k <= span; k++) offsets[k] += offsets[k - 1];
    // Dans un même jour : apparitions d'abord, dans l'ordre des lignes.
    for (let i = 0; i < n; i++) {
        const r = rowAt(i);
        const at = offsets[table.day[r] - lo]++;
        day[at] = table.day[r];
        code[at] = r + 1;
    }
    if (active) {
        for (let i = 0; i < n; i++) {
            const r = rowAt(i);
            const end = table.endDay[r];
            if (end !== end) continue;
            const at = offsets[end - lo]++;
            day[at] = end;
            code[at] = -(r + 1);
        }
    }
    return { day, code };
}

// Premier indice dont le jour dépasse `target` (fin du jour `target`).
function upperBound(days, target) {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (days[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// ---------------------------------------------------------------------------
// Accumulateurs par zone (indice = indice du dictionnaire de la colonne ; la
// dernière case reçoit les lignes « hors carte »).

function makeAccumulator(spec, table, slots) {
    const n = new Int32Array(slots);
    switch (spec.op) {
    case 'distinct': {
        const column = table[spec.field];
        const seen = Array.from({ length: slots }, () => new Map());
        return {
            n,
            add(z, r, sign) {
                n[z] += sign;
                const v = column ? column[r] : null;
                // -1 : valeur inconnue d'une colonne codée ; null : code absent.
                if (v === null || v === undefined || v === -1) return;
                const map = seen[z];
                const c = (map.get(v) || 0) + sign;
                if (c > 0) map.set(v, c);
                else map.delete(v);
            },
            value: (z) => seen[z].size,
            reset() { n.fill(0); for (const m of seen) m.clear(); },
        };
    }
    case 'dt_coverage': {
        const cells = new Int32Array(slots * DT_CELLS);
        const covered = new Int32Array(slots);
        return {
            n,
            add(z, r, sign) {
                n[z] += sign;
                const d = dtIndex(table.difficulty[r]);
                const t = dtIndex(table.terrain[r]);
                if (d < 0 || t < 0) return;   // Labs : D/T inconnus
                const k = z * DT_CELLS + d * 9 + t;
                const before = cells[k];
                cells[k] += sign;
                if (before === 0 && cells[k] > 0) covered[z]++;
                else if (before > 0 && cells[k] === 0) covered[z]--;
            },
            value: (z) => covered[z],
            reset() { n.fill(0); cells.fill(0); covered.fill(0); },
        };
    }
    case 'mean': {
        const column = table[spec.field];
        const sum = new Float64Array(slots);
        const cnt = new Int32Array(slots);
        return {
            n,
            add(z, r, sign) {
                n[z] += sign;
                const v = column ? column[r] : NaN;
                if (!Number.isFinite(v)) return;
                sum[z] += sign * v;
                cnt[z] += sign;
            },
            value: (z) => (cnt[z] > 0 ? sum[z] / cnt[z] : null),
            reset() { n.fill(0); sum.fill(0); cnt.fill(0); },
        };
    }
    case 'first_day': {
        // L'état étant toujours un préfixe chronologique, une ligne retirée
        // (saut en arrière) est la plus récente : le minimum ne change
        // que lorsque la zone se vide.
        const first = new Float64Array(slots).fill(Infinity);
        return {
            n,
            add(z, r, sign) {
                n[z] += sign;
                if (sign > 0) { if (table.day[r] < first[z]) first[z] = table.day[r]; }
                else if (n[z] === 0) first[z] = Infinity;
            },
            value: (z) => (first[z] === Infinity ? null : first[z]),
            reset() { n.fill(0); first.fill(Infinity); },
        };
    }
    default:
        return { n, add(z, r, sign) { n[z] += sign; }, value: (z) => n[z], reset() { n.fill(0); } };
    }
}

// ---------------------------------------------------------------------------
// État

// `table` : table de chart_sources.mjs ; `level` : niveau de zone ;
// `measure` : { op, field?, mode?, per? } ; `rows` : lignes retenues (filtres
// de la page), toutes par défaut ; `areas` : surface (km²) par id de zone,
// Map ou objet, pour la densité.
export function createZoneState({ table, level, measure, rows = null, areas = null }) {
    const spec = normalizeZoneMeasure(measure);
    const columnName = ZONE_COLUMNS[level];
    const column = columnName ? table?.[columnName] : null;
    const ids = (columnName && table?.dicts?.[columnName]) || [];
    const outside = ids.length;
    const slots = ids.length + 1;
    const indexOf = new Map(ids.map((id, i) => [id, i]));
    const area = (id) => (areas instanceof Map ? areas.get(id) : areas?.[id]);
    const events = table ? buildEvents(table, rows, spec.mode === 'active') : { day: new Int32Array(0), code: new Int32Array(0) };
    const acc = makeAccumulator(spec, table || {}, slots);
    const changed = new Set();
    let pos = 0;
    let currentDay = -Infinity;

    const zoneOf = (r) => {
        const z = column ? column[r] : -1;
        return z >= 0 && z < outside ? z : outside;
    };
    const apply = (k, sign) => {
        const c = events.code[k];
        const add = c > 0;
        const r = (add ? c : -c) - 1;
        const z = zoneOf(r);
        // Défaire une apparition = retirer ; défaire une disparition = remettre.
        acc.add(z, r, add === (sign > 0) ? 1 : -1);
        if (z !== outside) changed.add(z);
    };
    const valueAt = (z) => {
        if (acc.n[z] <= 0) return null;
        const v = acc.value(z);
        if (v === null || spec.per !== 'km2') return v;
        const km2 = area(ids[z]);
        return km2 > 0 ? v / km2 : null;
    };

    return {
        spec,
        level,
        ids,
        get day() { return currentDay; },
        get size() { return events.day.length; },
        // Premier et dernier jour où quelque chose se passe.
        get extent() {
            const d = events.day;
            return d.length ? { first: d[0], last: d[d.length - 1] } : null;
        },
        // État à la fin du jour `day` (numéro de jour ; -Infinity = rien).
        seek(day) {
            const target = upperBound(events.day, day);
            if (target < pos && pos - target > target) {
                for (let z = 0; z < outside; z++) if (acc.n[z] !== 0) changed.add(z);
                acc.reset();
                pos = 0;
            }
            while (pos < target) apply(pos++, 1);
            while (pos > target) apply(--pos, -1);
            currentDay = day;
            return this;
        },
        valueOf(id) {
            const z = indexOf.get(id);
            return z === undefined ? null : valueAt(z);
        },
        // Map id → valeur, zones sans ligne (ou sans ligne active) exclues.
        values() {
            const out = new Map();
            for (let z = 0; z < outside; z++) {
                const v = valueAt(z);
                if (v !== null) out.set(ids[z], v);
            }
            return out;
        },
        // Lignes « hors carte » prises en compte à ce jour.
        get outside() { return acc.n[outside]; },
        // Zones modifiées depuis l'appel précédent (pour ne redessiner qu'elles).
        drainChanged() {
            const out = [...changed].map((z) => ids[z]);
            changed.clear();
            return out;
        },
        // Valeurs à plusieurs jours (mini-cartes) : [{ day, values }], dans
        // l'ordre croissant. L'état reste au dernier jour demandé.
        snapshots(days) {
            return [...days].sort((a, b) => a - b).map((d) => ({ day: d, values: this.seek(d).values() }));
        },
    };
}

// ---------------------------------------------------------------------------
// Échelle de couleurs

// Classes discrètes (5 à 7 se lisent bien, surtout en vidéo). À calculer sur
// l'état FINAL (fin de l'animation, dernier moment affiché) : une teinte
// garde ainsi le même sens tout du long.
//   quantile  autant de zones par classe (défaut : une zone très forte
//             n'écrase pas les autres)
//   linear    intervalles égaux entre le minimum et le maximum
//   log       intervalles égaux sur log(1 + v)
//   fixed     seuils donnés (`thresholds`, bornes basses des classes 2…k)
//   year      années (valeurs = numéros de jour, mesure `first_day`)
export const SCALE_MODES = Object.freeze(['quantile', 'linear', 'log', 'fixed', 'year']);
export const SCALE_CLASSES_RANGE = Object.freeze([2, 9]);

// Part trouvée : échelle fixe 0–100 % (mode `fixed`), seuils ronds et
// symétriques autour de 50 selon le nombre de classes demandé. Carte
// (zone_layer) et mini-cartes (chart_zones) partagent ces seuils : une
// même part donne la même teinte, et la légende reste lisible
// (« < 20 % » … « ≥ 80 % ») quelles que soient les valeurs du moment.
export function shareScaleThresholds(classes) {
    const k = Math.min(Math.max(Math.round(classes) || 5, SCALE_CLASSES_RANGE[0]), SCALE_CLASSES_RANGE[1]);
    const fixed = {
        3: [25, 75],
        4: [25, 50, 75],
        5: [20, 40, 60, 80],
        6: [10, 25, 50, 75, 90],
        7: [10, 20, 35, 50, 65, 80],
    };
    return fixed[k] || Array.from({ length: k - 1 }, (_, j) => Math.round((100 * (j + 1)) / k));
}

export function zoneScale(values, { mode = 'quantile', classes = 6, thresholds = [] } = {}) {
    const list = [...(values instanceof Map ? values.values() : values)]
        .filter((v) => typeof v === 'number' && Number.isFinite(v))
        .sort((a, b) => a - b);
    const k = Math.min(Math.max(Math.round(classes) || 6, SCALE_CLASSES_RANGE[0]), SCALE_CLASSES_RANGE[1]);
    const min = list.length ? list[0] : null;
    const max = list.length ? list[list.length - 1] : null;
    const kind = SCALE_MODES.includes(mode) ? mode : 'quantile';
    let breaks = [];
    if (kind === 'fixed') {
        breaks = [...thresholds].filter(Number.isFinite).sort((a, b) => a - b);
    } else if (list.length && min < max) {
        if (kind === 'quantile') {
            for (let j = 1; j < k; j++) breaks.push(list[Math.floor((j * list.length) / k)]);
        } else if (kind === 'linear') {
            for (let j = 1; j < k; j++) breaks.push(min + ((max - min) * j) / k);
        } else if (kind === 'log') {
            const a = Math.log1p(Math.max(min, 0));
            const b = Math.log1p(Math.max(max, 0));
            for (let j = 1; j < k; j++) breaks.push(Math.expm1(a + ((b - a) * j) / k));
        } else if (kind === 'year') {
            const y0 = ymdOfDay(min).y;
            const y1 = ymdOfDay(max).y;
            const years = y1 - y0 + 1;
            const step = Math.ceil(years / k);
            for (let y = y0 + step; y <= y1; y += step) breaks.push(dayNumber({ y, m: 1, d: 1 }));
        }
    }
    // Bornes strictement croissantes, au-dessus du minimum : aucune classe
    // vide au début, et des valeurs toutes égales donnent une seule classe.
    const clean = [];
    for (const b of breaks) {
        if ((min === null || b > min || kind === 'fixed') && (!clean.length || b > clean[clean.length - 1])) clean.push(b);
    }
    return {
        mode: kind,
        breaks: clean,
        classes: clean.length + 1,
        min,
        max,
        // Classe d'une valeur : 0 … classes - 1 (null pour « pas de valeur »).
        classOf(v) {
            if (typeof v !== 'number' || !Number.isFinite(v)) return null;
            let lo = 0;
            let hi = clean.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (clean[mid] <= v) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        },
        // Bornes [basse, haute[ de chaque classe, pour la légende.
        ranges() {
            const out = [];
            for (let c = 0; c <= clean.length; c++) {
                out.push([c === 0 ? min : clean[c - 1], c === clean.length ? max : clean[c]]);
            }
            return out;
        },
    };
}

// ---------------------------------------------------------------------------
// Moments clés (vignettes des mini-cartes)

export const MOMENT_RULES = Object.freeze(['year_end', 'quarter_end', 'milestones', 'new_zone', 'custom']);
export const DEFAULT_MILESTONES = Object.freeze([
    100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000,
    30000, 40000, 50000, 75000, 100000,
]);
export const MOMENTS_MAX = 12;
// Deux moments plus proches que ça n'en font qu'un (un palier et une fin
// d'année le même mois) : le plus prioritaire garde la vignette.
export const MOMENTS_MIN_GAP_DAYS = 21;

// Priorité, de la plus forte à la plus faible : le dernier jour (toujours
// présent), les dates libres, les paliers, les nouvelles zones, les fins de
// période régulières.
const PRIORITY = ['last', 'custom', 'milestone', 'new_zone', 'year_end', 'quarter_end'];

// Données des moments, sans libellé (traduit par l'appelant) :
//   { day, kind: 'last' }
//   { day, kind: 'custom' }
//   { day, kind: 'milestone', value: 1000 }
//   { day, kind: 'new_zone', zones: ['FR-29', …] }
//   { day, kind: 'year_end', year } / { day, kind: 'quarter_end', year, quarter }
// `also` : moments fusionnés dans celui-ci (même période).
export function keyMoments(table, {
    rules = ['year_end'], custom = [], level = 'subregion', rows = null,
    max = MOMENTS_MAX, milestones = DEFAULT_MILESTONES, minGapDays = MOMENTS_MIN_GAP_DAYS,
} = {}) {
    const events = table ? buildEvents(table, rows, false) : { day: new Int32Array(0), code: new Int32Array(0) };
    const days = events.day;
    if (!days.length) return [];
    const first = days[0];
    const last = days[days.length - 1];
    const byKind = Object.fromEntries(PRIORITY.map((kind) => [kind, []]));
    byKind.last.push({ day: last, kind: 'last' });

    if (rules.includes('custom')) {
        for (const d of [...new Set(custom)].filter(Number.isFinite).sort((a, b) => a - b)) {
            if (d >= first) byKind.custom.push({ day: Math.min(d, last), kind: 'custom' });
        }
    }
    if (rules.includes('milestones')) {
        for (const value of milestones) {
            if (value >= 1 && value <= days.length) byKind.milestone.push({ day: days[value - 1], kind: 'milestone', value });
        }
    }
    if (rules.includes('new_zone')) {
        const column = table[ZONE_COLUMNS[level]];
        const ids = table.dicts?.[ZONE_COLUMNS[level]] || [];
        const seen = new Set();
        for (let k = 0; k < days.length; k++) {
            const z = column ? column[events.code[k] - 1] : -1;
            if (z < 0 || z >= ids.length || seen.has(z)) continue;
            seen.add(z);
            const prev = byKind.new_zone[byKind.new_zone.length - 1];
            if (prev && prev.day === days[k]) prev.zones.push(ids[z]);
            else byKind.new_zone.push({ day: days[k], kind: 'new_zone', zones: [ids[z]] });
        }
    }
    const y0 = ymdOfDay(first).y;
    const y1 = ymdOfDay(last).y;
    if (rules.includes('year_end')) {
        for (let y = y0; y <= y1; y++) {
            byKind.year_end.push({ day: Math.min(dayNumber({ y, m: 12, d: 31 }), last), kind: 'year_end', year: y });
        }
    }
    if (rules.includes('quarter_end')) {
        for (let y = y0; y <= y1; y++) {
            for (let q = 1; q <= 4; q++) {
                const end = dayNumber({ y: q === 4 ? y + 1 : y, m: q === 4 ? 1 : q * 3 + 1, d: 1 }) - 1;
                const start = dayNumber({ y, m: q * 3 - 2, d: 1 });
                if (end < first || start > last) continue;
                byKind.quarter_end.push({ day: Math.min(end, last), kind: 'quarter_end', year: y, quarter: q });
            }
        }
    }
    return pickMoments(PRIORITY.map((kind) => byKind[kind]), Math.max(1, max), minGapDays);
}

// k éléments répartis sur la liste, le dernier toujours compris.
function spread(list, k) {
    if (k <= 0) return [];
    if (k >= list.length) return list;
    if (k === 1) return [list[list.length - 1]];
    const out = [];
    for (let i = 0; i < k; i++) out.push(list[Math.round((i * (list.length - 1)) / (k - 1))]);
    return [...new Set(out)];
}

function pickMoments(classes, max, gap) {
    const chosen = [];
    const strip = ({ also, ...m }) => m;
    const merge = (into, m) => { (into.also ||= []).push(strip(m), ...(m.also || [])); };
    for (const list of classes) {
        // Dans une même classe, des moments trop proches se fondent dans le
        // plus récent (deux paliers la même semaine). Parcours du plus récent
        // au plus ancien, l'écart mesuré depuis le moment GARDÉ : une suite
        // régulière (tous les 14 jours) ne s'effondre pas en un seul moment.
        const local = [];
        for (let i = list.length - 1; i >= 0; i--) {
            const m = { ...list[i] };
            const kept = local[local.length - 1];
            if (kept && kept.day - m.day < gap) merge(kept, m);
            else local.push(m);
        }
        local.reverse();
        // Puis contre les moments déjà retenus, plus prioritaires.
        const free = [];
        for (const m of local) {
            const near = chosen.find((c) => Math.abs(c.day - m.day) < gap);
            if (near) merge(near, m);
            else free.push(m);
        }
        chosen.push(...spread(free, max - chosen.length));
    }
    return chosen.sort((a, b) => a.day - b.day);
}

// ---------------------------------------------------------------------------
// Part des caches trouvées (`found_share`) : croisement d'un jeu Évolution
// et de mes trouvailles (plan § 8).
//
// Événements agrégés par (jour, zone), triés par jour — le format que le
// serveur envoie à la carte (zone_share.py) et que shareEventsOfTable
// construit pour les mini-cartes :
//   placed    caches du jeu apparues ce jour-là ;
//   archived  caches disparues (archivage daté) ;
//   found     caches du jeu que j'ai trouvées, comptées à partir de ma
//             trouvaille (ou de leur apparition, si l'export la date après) ;
//   lost      caches trouvées qui disparaissent ce jour-là.
// `zone` : indice dans `ids`, -1 = hors carte.
//
// Base (dénominateur) :
//   active  caches actives à la date (défaut) — au numérateur, les trouvées
//           encore actives : la part ne dépasse jamais 100 % ;
//   all     toutes les caches apparues jusqu'à la date, archivées comprises.
export const SHARE_BASES = Object.freeze(['active', 'all']);

const EMPTY_SHARE_EVENTS = Object.freeze({
    day: new Int32Array(0), zone: new Int32Array(0), placed: new Int32Array(0),
    archived: new Int32Array(0), found: new Int32Array(0), lost: new Int32Array(0),
});

// Événements d'une table Évolution (chart_sources.mjs : `day` = placement,
// `endDay` = archivage, `code`) : `column` = colonne de zones lue (indices
// dans `ids`), `rows` = lignes retenues (toutes par défaut), `foundDay` =
// code → jour de ma première trouvaille (undefined si jamais trouvée).
export function shareEventsOfTable(table, { column, rows = null, foundDay }) {
    const n = rows ? rows.length : (table?.n || 0);
    if (!n) return EMPTY_SHARE_EVENTS;
    const rowAt = rows ? (i) => rows[i] : (i) => i;
    // Clé numérique jour × 2²¹ + zone : sous 2⁵³ jusqu'à l'an 6000 et
    // 2 millions de zones.
    const ZONE_SPAN = 2097152;
    const sums = new Map();
    const bump = (day, z, slot) => {
        const key = day * ZONE_SPAN + (z + 1);
        let entry = sums.get(key);
        if (!entry) {
            entry = [0, 0, 0, 0];
            sums.set(key, entry);
        }
        entry[slot]++;
    };
    for (let i = 0; i < n; i++) {
        const r = rowAt(i);
        const z = column && column[r] >= 0 ? column[r] : -1;
        const placed = table.day[r];
        const rawEnd = table.endDay[r];
        const end = rawEnd === rawEnd ? Math.max(rawEnd, placed) : NaN;
        bump(placed, z, 0);
        if (end === end) bump(end, z, 1);
        const f = foundDay(table.code?.[r]);
        if (f === undefined || f === null || f !== f) continue;
        const start = Math.max(f, placed);
        bump(start, z, 2);
        // Trouvée après l'archivage (dates d'export décalées) : jamais active
        // au numérateur — apparition et disparition le même jour.
        if (end === end) bump(Math.max(end, start), z, 3);
    }
    const keys = [...sums.keys()].sort((a, b) => a - b);
    const out = {
        day: new Int32Array(keys.length), zone: new Int32Array(keys.length),
        placed: new Int32Array(keys.length), archived: new Int32Array(keys.length),
        found: new Int32Array(keys.length), lost: new Int32Array(keys.length),
    };
    keys.forEach((key, k) => {
        const zone = (key % ZONE_SPAN) - 1;
        const [placed, archived, found, lost] = sums.get(key);
        out.day[k] = (key - zone - 1) / ZONE_SPAN;
        out.zone[k] = zone;
        out.placed[k] = placed;
        out.archived[k] = archived;
        out.found[k] = found;
        out.lost[k] = lost;
    });
    return out;
}

// État de la part trouvée, même interface que createZoneState (seek,
// values, valueOf, outside, drainChanged, snapshots, extent) ; `parts(id)`
// donne en plus [trouvées, base]. Valeurs en pourcentage (0 à 100) ; une
// zone dont la base est vide n'a pas de valeur, une zone sans trouvaille
// vaut 0 %.
export function createShareState({ ids, events = EMPTY_SHARE_EVENTS, base = 'active' }) {
    const active = base !== 'all';
    const outside = ids.length;
    const num = new Int32Array(outside + 1);
    const den = new Int32Array(outside + 1);
    const indexOf = new Map(ids.map((id, i) => [id, i]));
    const changed = new Set();
    const days = events.day;
    let pos = 0;
    let currentDay = -Infinity;

    const apply = (k, sign) => {
        const zk = events.zone[k];
        const z = zk >= 0 && zk < outside ? zk : outside;
        const dDen = events.placed[k] - (active ? events.archived[k] : 0);
        const dNum = events.found[k] - (active ? events.lost[k] : 0);
        if (!dDen && !dNum) return;
        den[z] += sign * dDen;
        num[z] += sign * dNum;
        if (z !== outside) changed.add(z);
    };
    const valueAt = (z) => (den[z] > 0 ? (100 * num[z]) / den[z] : null);

    return {
        spec: { op: 'found_share', mode: active ? 'active' : 'cumulative', per: null },
        base: active ? 'active' : 'all',
        ids,
        get day() { return currentDay; },
        get size() { return days.length; },
        get extent() {
            return days.length ? { first: days[0], last: days[days.length - 1] } : null;
        },
        seek(day) {
            const target = upperBound(days, day);
            if (target < pos && pos - target > target) {
                for (let z = 0; z < outside; z++) if (den[z] !== 0 || num[z] !== 0) changed.add(z);
                num.fill(0);
                den.fill(0);
                pos = 0;
            }
            while (pos < target) apply(pos++, 1);
            while (pos > target) apply(--pos, -1);
            currentDay = day;
            return this;
        },
        valueOf(id) {
            const z = indexOf.get(id);
            return z === undefined ? null : valueAt(z);
        },
        parts(id) {
            const z = indexOf.get(id);
            return z === undefined || den[z] <= 0 ? null : [num[z], den[z]];
        },
        values() {
            const out = new Map();
            for (let z = 0; z < outside; z++) {
                const v = valueAt(z);
                if (v !== null) out.set(ids[z], v);
            }
            return out;
        },
        // Caches du jeu hors carte comptées dans la base à ce jour.
        get outside() { return den[outside]; },
        // Total des zones (et hors carte) : [trouvées, base].
        totals() {
            let a = 0;
            let b = 0;
            for (let z = 0; z <= outside; z++) { a += num[z]; b += den[z]; }
            return [a, b];
        },
        drainChanged() {
            const out = [...changed].map((z) => ids[z]);
            changed.clear();
            return out;
        },
        snapshots(list) {
            return [...list].sort((a, b) => a - b).map((d) => ({ day: d, values: this.seek(d).values() }));
        },
    };
}

// Table des seules caches trouvées, datées de leur trouvaille (moments clés
// d'une carte de part trouvée : paliers, nouvelles zones, fins d'année à
// partir de ma première trouvaille dans le jeu). Nouvelle table : `day`
// remplacé, colonnes partagées.
export function foundRowsTable(table, { rows = null, foundDay }) {
    const n = rows ? rows.length : (table?.n || 0);
    const day = Int32Array.from(table?.day || []);
    const kept = [];
    for (let i = 0; i < n; i++) {
        const r = rows ? rows[i] : i;
        const f = foundDay(table.code?.[r]);
        if (f === undefined || f === null || f !== f) continue;
        day[r] = Math.max(f, table.day[r]);
        kept.push(r);
    }
    return { table: { ...table, day }, rows: Int32Array.from(kept) };
}
