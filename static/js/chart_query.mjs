// Moteur de la page Statistiques : description d'un graphique + table
// d'événements → jeu de séries. Module pur (ni DOM ni ECharts), testé par
// tests/js/chart_query.test.mjs.
//
//   runChartQuery(spec, table, { periods, filters, today, labelOf })
//     spec     description normalisée (chart_spec.mjs)
//     table    table d'événements (chart_sources.mjs)
//     periods  périodes effectives (héritage du tableau de bord résolu) ;
//              non passées → celles du graphique ; null → toutes les données
//     filters  filtres effectifs (même règle ; null → aucun)
//     today    numéro du jour courant (chart_periods.mjs › todayDay)
//     labelOf  (dim, key) → libellé, pour le tri « par libellé »
//
// Résultat :
//   { dim, kind, align, elapsedUnit, keys,
//     series: [{ id, periodIndex, split, values, partial, dates }],
//     periods, truncated, toDate, delta, normalize,
//     meta: { rows, undated, noAttribute } }
// `values[i]` correspond à `keys[i]` ; null = pas de valeur (moyenne sans
// donnée, jour futur, hors de la période ou de sa coupe « à date »).
// `partial` : case encore incomplète (période en cours ou coupée), -1 sinon.
//
// Comparer plusieurs périodes (spec.compare) :
//   align     calendar  même axe (catégories, mois de l'année…) ;
//             absolute  vraies dates sur un axe de temps ;
//             elapsed   rang depuis le début de chaque période (jour 1, 2…) ;
//   toDate    les autres périodes coupées au même point que celle en cours ;
//   normalize pourcentage du total de chaque série, ou par jour ;
//   layout    delta : `delta.values` = première − seconde, `delta.ratios`
//             en proportion de la seconde. Côte à côte : affaire du rendu.

import { CONTAINER_ORDER, OTHERS_KEY, UNKNOWN_KEY, dayNumber, ymdOfDay } from './stats_model.mjs';
import { MAX_SERIES, dimensionKind } from './chart_spec.mjs';
import { daysInMonth, expandPeriods, toDateCut } from './chart_periods.mjs';
import { DICT_FIELDS, SOURCE_KIND_VALUES, weekStart } from './chart_sources.mjs';

export { OTHERS_KEY, UNKNOWN_KEY };

// Catégories plafonnées par `view.top` (les autres ont un domaine fixe).
const TOP_DIMENSIONS = new Set(['cache_type', 'container', 'country', 'state', 'owner', 'attribute', 'dt']);
const DT_VALUES = Array.from({ length: 9 }, (_, i) => String(1 + i / 2));
// Garde-fou : un axe « jour » sur 25 ans compte ~9 000 cases.
export const MAX_AXIS_KEYS = 20000;

// ---------------------------------------------------------------------------
// Clés
// ---------------------------------------------------------------------------

const quarterOf = (m) => Math.floor((m - 1) / 3) + 1;

// Clé(s) d'une ligne pour une dimension : nombre (temps, cycliques, âge,
// année de publication), chaîne (catégories), tableau (attributs, multi-
// valués), UNKNOWN_KEY si la valeur manque.
export function keyAccessor(dim, table) {
    const dict = (field) => {
        const values = table.dicts[field] || [];
        const column = table[field];
        return (r) => (column[r] >= 0 ? values[column[r]] : UNKNOWN_KEY);
    };
    const halfStep = (column) => (r) => (Number.isNaN(column[r]) ? UNKNOWN_KEY : String(column[r]));
    switch (dim) {
        case 'none': return () => 'total';
        case 'year': return (r) => table.y[r];
        case 'quarter': return (r) => table.y[r] * 10 + quarterOf(table.m[r]);
        case 'month': return (r) => table.y[r] * 100 + table.m[r];
        case 'week': return (r) => weekStart(table.day[r]);
        case 'day': return (r) => table.day[r];
        case 'month_of_year': return (r) => table.m[r];
        case 'week_of_year': return (r) => table.week[r];
        case 'day_of_year': return (r) => table.doy[r];
        case 'weekday': return (r) => table.weekday[r];
        case 'difficulty': return halfStep(table.difficulty);
        case 'terrain': return halfStep(table.terrain);
        case 'dt': return (r) => (Number.isNaN(table.difficulty[r]) || Number.isNaN(table.terrain[r])
            ? UNKNOWN_KEY : `${table.difficulty[r]}|${table.terrain[r]}`);
        case 'age': return (r) => (table.age[r] < 0 ? UNKNOWN_KEY : table.age[r]);
        case 'published_year': return (r) => (table.publishedYear[r] ? table.publishedYear[r] : UNKNOWN_KEY);
        case 'attribute': {
            const attrs = table.dicts.attribute || [];
            return (r) => table.attributes[r].map((i) => attrs[i]?.key).filter((k) => k !== undefined);
        }
        default:
            if (DICT_FIELDS.includes(dim)) return dict(dim);
            return () => UNKNOWN_KEY;
    }
}

// Valeur d'une ligne pour une mesure « distinct » (null = ne compte pas).
function distinctAccessor(field, table) {
    switch (field) {
        case 'caches': return (r) => table.code[r] ?? `#${r}`;
        case 'days': return (r) => table.day[r];
        default: {
            const column = table[field];
            return column ? (r) => (column[r] >= 0 ? column[r] : null) : () => null;
        }
    }
}

// Valeur d'une ligne pour une moyenne (NaN = ignorée).
function meanAccessor(field, table) {
    if (field === 'age') return (r) => table.ageDays[r];
    const column = table[field];
    return column ? (r) => column[r] : () => NaN;
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

// Masque des lignes retenues. Sélection vide = neutre ; plusieurs valeurs
// d'un même champ = « l'une ou l'autre », sauf les attributs : tous requis
// (même règle que la carte, filter_model.mjs › matchesAttributes).
export function filterMask(table, filters) {
    const mask = new Uint8Array(table.n).fill(1);
    if (!filters) return mask;
    const tests = [];
    for (const [field, values] of Object.entries(filters)) {
        if (!Array.isArray(values) || !values.length) continue;
        if (field === 'source_kind') {
            const kinds = new Set(values.map((v) => SOURCE_KIND_VALUES.indexOf(v)).filter((i) => i >= 0));
            tests.push((r) => kinds.has(table.kind[r]));
        } else if (DICT_FIELDS.includes(field)) {
            const dict = table.dicts[field] || [];
            const wanted = new Set(values.map((v) => dict.indexOf(v)).filter((i) => i >= 0));
            tests.push((r) => wanted.has(table[field][r]));
        } else if (field === 'difficulty' || field === 'terrain') {
            const wanted = new Set(values.map(Number));
            tests.push((r) => wanted.has(table[field][r]));
        } else if (field === 'published_year') {
            const wanted = new Set(values.map(Number));
            tests.push((r) => wanted.has(table.publishedYear[r]));
        } else if (field === 'attribute') {
            const attrs = table.dicts.attribute || [];
            const wanted = values.map((v) => attrs.findIndex((a) => a.key === v));
            tests.push((r) => wanted.every((i) => i >= 0 && table.attributes[r].includes(i)));
        }
    }
    if (!tests.length) return mask;
    for (let r = 0; r < table.n; r++) {
        if (!tests.every((test) => test(r))) mask[r] = 0;
    }
    return mask;
}

// ---------------------------------------------------------------------------
// Axe
// ---------------------------------------------------------------------------

function timeKeys(dim, from, to) {
    const keys = [];
    const start = new Date(from * 86400000);
    const end = new Date(to * 86400000);
    const [y0, m0] = [start.getUTCFullYear(), start.getUTCMonth() + 1];
    const [y1, m1] = [end.getUTCFullYear(), end.getUTCMonth() + 1];
    if (dim === 'year') {
        for (let y = y0; y <= y1; y++) keys.push(y);
    } else if (dim === 'quarter') {
        for (let i = y0 * 4 + quarterOf(m0) - 1; i <= y1 * 4 + quarterOf(m1) - 1; i++) {
            keys.push(Math.floor(i / 4) * 10 + (i % 4) + 1);
        }
    } else if (dim === 'month') {
        for (let i = y0 * 12 + m0 - 1; i <= y1 * 12 + m1 - 1; i++) keys.push(Math.floor(i / 12) * 100 + (i % 12) + 1);
    } else if (dim === 'week') {
        for (let day = weekStart(from); day <= to && keys.length < MAX_AXIS_KEYS; day += 7) keys.push(day);
    } else {
        for (let day = from; day <= to && keys.length < MAX_AXIS_KEYS; day++) keys.push(day);
    }
    return keys;
}

// Premier et dernier jour couverts par une clé de temps.
export function timeKeyBounds(dim, key) {
    const utc = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
    switch (dim) {
        case 'year': return [utc(key, 1, 1), utc(key, 12, 31)];
        case 'quarter': {
            const y = Math.floor(key / 10);
            const q = key % 10;
            return [utc(y, q * 3 - 2, 1), utc(y, q * 3 + 1, 1) - 1];
        }
        case 'month': {
            const y = Math.floor(key / 100);
            const m = key % 100;
            return [utc(y, m, 1), utc(y, m + 1, 1) - 1];
        }
        case 'week': return [key, key + 6];
        default: return [key, key];
    }
}

const CYCLIC_DOMAINS = {
    month_of_year: 12,
    week_of_year: 53,
    day_of_year: 366,
    weekday: 7,
};

function rangeKeys(count) {
    return Array.from({ length: count }, (_, i) => i + 1);
}

function containerRank(key) {
    const i = CONTAINER_ORDER.findIndex((v) => v.toLowerCase() === String(key).toLowerCase());
    return i < 0 ? CONTAINER_ORDER.length : i;
}

// Rejette « Autres » puis « Inconnu » en fin d'axe.
function tailRank(key) {
    if (key === UNKNOWN_KEY) return 2;
    if (key === OTHERS_KEY) return 1;
    return 0;
}

// ---------------------------------------------------------------------------
// Alignement des périodes
// ---------------------------------------------------------------------------

// Unité de l'alignement « depuis le début de chaque période » : l'axe compte
// des jours, semaines, mois… écoulés depuis le début de chaque période.
export const ELAPSED_UNITS = Object.freeze({
    year: 'year', quarter: 'quarter', month: 'month', week: 'week', day: 'day',
    month_of_year: 'month', week_of_year: 'week', day_of_year: 'day',
});

// Lundi de référence : le 05/01/1970 (jour 4) — la semaine n vaut
// (lundi − 4) / 7.
const MONDAY_ZERO = 4;

// Rang d'un jour dans une unité (jours, semaines, mois… depuis une origine
// commune) : deux jours d'une même unité ont le même rang.
export function unitIndexOfDay(unit, day) {
    if (unit === 'day') return day;
    if (unit === 'week') return (weekStart(day) - MONDAY_ZERO) / 7;
    const { y, m } = ymdOfDay(day);
    if (unit === 'month') return y * 12 + m - 1;
    if (unit === 'quarter') return y * 4 + quarterOf(m) - 1;
    return y;
}

// Premier jour d'un rang (inverse de unitIndexOfDay).
export function unitStartDay(unit, index) {
    if (unit === 'day') return index;
    if (unit === 'week') return index * 7 + MONDAY_ZERO;
    if (unit === 'month') return dayNumber({ y: Math.floor(index / 12), m: (index % 12) + 1, d: 1 });
    if (unit === 'quarter') return dayNumber({ y: Math.floor(index / 4), m: (index % 4) * 3 + 1, d: 1 });
    return dayNumber({ y: index, m: 1, d: 1 });
}

function rowUnitIndex(unit, table, r) {
    if (unit === 'day') return table.day[r];
    if (unit === 'week') return (weekStart(table.day[r]) - MONDAY_ZERO) / 7;
    if (unit === 'month') return table.y[r] * 12 + table.m[r] - 1;
    if (unit === 'quarter') return table.y[r] * 4 + quarterOf(table.m[r]) - 1;
    return table.y[r];
}

// Case inexistante cette année-là (29 février d'une année ordinaire).
const ABSENT = 'absent';

// Jours couverts par une clé cyclique dans l'année `y`.
function cyclicBounds(dim, key, y) {
    const jan1 = dayNumber({ y, m: 1, d: 1 });
    if (dim === 'month_of_year') {
        return [dayNumber({ y, m: key, d: 1 }), dayNumber({ y, m: key, d: daysInMonth(y, key) })];
    }
    if (dim === 'day_of_year') {
        const leap = daysInMonth(y, 2) === 29;
        if (leap || key < 60) return [jan1 + key - 1, jan1 + key - 1];
        if (key === 60) return ABSENT;
        return [jan1 + key - 2, jan1 + key - 2];
    }
    if (dim === 'week_of_year') {
        // Semaine ISO 1 : celle du 4 janvier.
        const start = weekStart(dayNumber({ y, m: 1, d: 4 })) + (key - 1) * 7;
        return [start, start + 6];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------

function newCell(op) {
    if (op === 'distinct') return new Set();
    if (op === 'mean') return { sum: 0, n: 0 };
    if (op === 'max_per_day') return new Map();
    return 0;
}

// Liste des clés d'une ligne (une dimension multi-valuée en donne plusieurs).
const asList = (key) => (Array.isArray(key) ? key : [key]);

// Comparaison « à date » : avec plusieurs périodes dont une en cours, les
// autres sont coupées au même point (au 8 novembre pour des années) — sans
// cela l'année en cours perd toujours. Renvoie le jour de référence, ou null.
function applyToDate(entries, spec, today) {
    if (entries.length < 2 || !spec.compare.toDate) return null;
    const current = entries.find((e) => e.ongoing);
    if (!current) return null;
    for (const entry of entries) {
        if (entry === current) continue;
        const cut = toDateCut(entry, current, today);
        if (cut < entry.to) {
            entry.to = Math.max(entry.from, cut);
            entry.cut = true;
        }
    }
    return { day: today };
}

export function runChartQuery(spec, table, options = {}) {
    const { today, labelOf = null } = options;
    // Périodes et filtres : ceux passés par l'appelant (héritage du tableau
    // de bord résolu, dashboard_model.mjs), sinon ceux du graphique.
    const periods = options.periods !== undefined ? options.periods : spec.periods;
    const filters = options.filters !== undefined ? options.filters : spec.filters;
    const dim = spec.groupBy;
    const kind = dimensionKind(dim);
    const op = spec.measure.op;
    const { periods: entries, truncated } = expandPeriods(periods || [{ kind: 'all' }], {
        extent: table.extent, today,
    });
    const toDate = applyToDate(entries, spec, today);

    // Alignement « depuis le début de chaque période » : la clé d'une ligne
    // devient son rang depuis le début de SA période.
    const elapsedUnit = entries.length > 1 && spec.compare.align === 'elapsed' ? ELAPSED_UNITS[dim] : null;
    if (elapsedUnit) {
        for (const entry of entries) {
            entry.startIndex = unitIndexOfDay(elapsedUnit, entry.from);
            entry.units = unitIndexOfDay(elapsedUnit, entry.fullTo) - entry.startIndex + 1;
        }
    }
    const align = elapsedUnit ? 'elapsed' : (kind === 'time' ? 'absolute' : 'calendar');

    const mask = filterMask(table, filters);
    const groupKey = keyAccessor(dim, table);
    const splitKey = spec.splitBy ? keyAccessor(spec.splitBy, table) : null;

    // Lignes de chaque période (une ligne peut appartenir à plusieurs).
    const inPeriod = entries.map(() => []);
    let rows = 0;
    let noAttribute = 0;
    for (let r = 0; r < table.n; r++) {
        if (!mask[r]) continue;
        let hit = false;
        for (const entry of entries) {
            if (table.day[r] >= entry.from && table.day[r] <= entry.to) {
                inPeriod[entry.index].push(r);
                hit = true;
            }
        }
        if (!hit) continue;
        rows++;
        if (dim === 'attribute' && groupKey(r).length === 0) noAttribute++;
    }

    // Plafonds de cardinalité : top N de l'axe, et des valeurs de la 2ᵉ
    // dimension pour tenir dans MAX_SERIES séries. Rang = nombre de lignes,
    // toutes périodes confondues.
    const rank = (accessor) => {
        const counts = new Map();
        for (const list of inPeriod) {
            for (const r of list) {
                for (const key of asList(accessor(r))) counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
        return counts;
    };
    const capped = (counts, limit) => {
        const ordered = [...counts.keys()].sort((a, b) => tailRank(a) - tailRank(b)
            || counts.get(b) - counts.get(a) || String(a).localeCompare(String(b)));
        const named = ordered.filter((k) => k !== UNKNOWN_KEY);
        if (named.length <= limit) return { keys: ordered, remap: null };
        const kept = new Set(named.slice(0, limit));
        const keys = [...kept, OTHERS_KEY];
        if (counts.has(UNKNOWN_KEY)) keys.push(UNKNOWN_KEY);
        return { keys, remap: (key) => (key === UNKNOWN_KEY || kept.has(key) ? key : OTHERS_KEY) };
    };

    let axisKeys;
    let remapGroup = null;
    if (kind === 'none') {
        axisKeys = ['total'];
    } else if (elapsedUnit) {
        const longest = Math.max(0, ...entries.map((e) => e.units));
        axisKeys = rangeKeys(Math.min(longest, MAX_AXIS_KEYS)).map((i) => i - 1);
    } else if (kind === 'time') {
        const from = Math.min(...entries.map((e) => e.from));
        const to = Math.max(...entries.map((e) => e.fullTo));
        axisKeys = entries.length ? timeKeys(dim, from, to) : [];
    } else if (kind === 'cyclic') {
        axisKeys = rangeKeys(CYCLIC_DOMAINS[dim]);
    } else {
        const counts = rank(groupKey);
        if (dim === 'difficulty' || dim === 'terrain') {
            axisKeys = [...DT_VALUES];
        } else if (dim === 'age') {
            axisKeys = Array.from({ length: 10 }, (_, i) => i);
        } else if (dim === 'published_year') {
            const years = [...counts.keys()].filter((k) => k !== UNKNOWN_KEY);
            axisKeys = years.length ? rangeKeys(Math.max(...years) - Math.min(...years) + 1)
                .map((i) => Math.min(...years) + i - 1) : [];
        } else {
            // Un anneau ou un radar colore chaque part : pas plus de parts que
            // de teintes (MAX_SERIES), « Autres » compris.
            const parts = spec.view.chart === 'donut' || spec.view.chart === 'radar';
            const top = !TOP_DIMENSIONS.has(dim) ? Infinity
                : parts ? Math.min(spec.view.top, MAX_SERIES - 1) : spec.view.top;
            const result = capped(counts, top);
            axisKeys = result.keys.filter((k) => k !== UNKNOWN_KEY);
            remapGroup = result.remap;
            if (dim === 'container') {
                axisKeys.sort((a, b) => tailRank(a) - tailRank(b) || containerRank(a) - containerRank(b)
                    || String(a).localeCompare(String(b)));
            }
        }
        if (counts.has(UNKNOWN_KEY)) axisKeys.push(UNKNOWN_KEY);
    }

    // Séries : période × valeur de la 2ᵉ dimension.
    let splitValues = [null];
    let remapSplit = null;
    if (splitKey) {
        const perPeriod = Math.max(1, Math.floor(MAX_SERIES / Math.max(1, entries.length)));
        const result = capped(rank(splitKey), perPeriod - 1);
        splitValues = result.keys;
        remapSplit = result.remap;
    }

    const index = new Map(axisKeys.map((key, i) => [key, i]));
    const series = [];
    const distinctOf = op === 'distinct' ? distinctAccessor(spec.measure.field, table) : null;
    const meanOf = op === 'mean' ? meanAccessor(spec.measure.field, table) : null;

    // Jours couverts par la case i pour une période (null : pas de dates —
    // catégories, cycliques sur plusieurs années, jour de la semaine).
    const boundsOf = (i, entry) => {
        const key = axisKeys[i];
        if (elapsedUnit) {
            const unitIndex = entry.startIndex + key;
            return [unitStartDay(elapsedUnit, unitIndex), unitStartDay(elapsedUnit, unitIndex + 1) - 1];
        }
        if (kind === 'time') return timeKeyBounds(dim, key);
        if (kind === 'cyclic') {
            const y = ymdOfDay(entry.from).y;
            if (ymdOfDay(entry.fullTo).y !== y) return null;
            return cyclicBounds(dim, key, y);
        }
        return null;
    };

    for (const entry of entries) {
        const keyOf = elapsedUnit ? (r) => rowUnitIndex(elapsedUnit, table, r) - entry.startIndex : groupKey;
        const cells = new Map(splitValues.map((s) => [s, axisKeys.map(() => newCell(op))]));
        for (const r of inPeriod[entry.index]) {
            const split = splitKey ? asList(splitKey(r)).map((k) => (remapSplit ? remapSplit(k) : k)) : [null];
            for (let key of asList(keyOf(r))) {
                if (remapGroup) key = remapGroup(key);
                const i = index.get(key);
                if (i === undefined) continue;
                for (const s of split) {
                    const row = cells.get(s);
                    if (!row) continue;
                    if (op === 'distinct') {
                        const value = distinctOf(r);
                        if (value !== null) row[i].add(value);
                    } else if (op === 'mean') {
                        const value = meanOf(r);
                        if (!Number.isNaN(value)) { row[i].sum += value; row[i].n++; }
                    } else if (op === 'max_per_day') {
                        row[i].set(table.day[r], (row[i].get(table.day[r]) || 0) + 1);
                    } else {
                        row[i] += 1;
                    }
                }
            }
        }

        const bounds = axisKeys.map((_, i) => boundsOf(i, entry));
        // Fin effective : la coupe « à date », ou aujourd'hui.
        const end = Math.min(entry.to, today);
        let partial = -1;
        if (entry.ongoing || entry.cut) {
            partial = bounds.findIndex((b) => Array.isArray(b) && b[0] <= end && end < b[1]);
        }

        for (const s of splitValues) {
            const row = cells.get(s);
            let values = row.map((cell) => {
                if (op === 'distinct') return cell.size;
                if (op === 'mean') return cell.n ? cell.sum / cell.n : null;
                if (op === 'max_per_day') return cell.size ? Math.max(...cell.values()) : 0;
                return cell;
            });

            if (op === 'cumulative') {
                // Cumul depuis le début de la période, ou depuis toujours
                // (lignes filtrées antérieures à la période ajoutées au départ).
                let running = 0;
                if (spec.measure.from === 'all') {
                    for (let r = 0; r < table.n; r++) {
                        if (!mask[r] || table.day[r] >= entry.from) continue;
                        if (splitKey && !asList(splitKey(r)).map((k) => (remapSplit ? remapSplit(k) : k)).includes(s)) continue;
                        running++;
                    }
                }
                values = values.map((v) => (running += v));
            }

            // Hors de la période (ou de sa coupe), ou à venir : pas de valeur.
            // Le 29 février d'une année ordinaire n'existe pas — sauf pour un
            // cumul, qui garde la valeur de la veille.
            values = values.map((v, i) => {
                const b = bounds[i];
                if (b === ABSENT) return op === 'cumulative' ? v : null;
                if (!b) return v;
                if (b[1] < entry.from || b[0] > entry.to || b[0] > today) return null;
                return v;
            });

            values = scaleValues(values, spec, op, entry, today);

            series.push({
                id: s === null ? `p${entry.index}` : `p${entry.index}:${s}`,
                periodIndex: entry.index,
                split: s,
                values,
                partial,
                // Premier jour de chaque case (alignement « depuis le début » :
                // l'infobulle rappelle la vraie date de chaque série).
                dates: elapsedUnit ? bounds.map((b) => (Array.isArray(b) ? b[0] : null)) : null,
            });
        }
    }

    // Tri de l'axe (catégories seulement : un axe de temps ou cyclique garde
    // son ordre).
    if (kind === 'category' && spec.view.sort !== 'natural' && axisKeys.length > 1) {
        const total = (i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0);
        const label = (key) => String(labelOf ? labelOf(dim, key) : key);
        const order = axisKeys.map((key, i) => i).sort((a, b) => tailRank(axisKeys[a]) - tailRank(axisKeys[b])
            || (spec.view.sort === 'value'
                ? total(b) - total(a)
                : label(axisKeys[a]).localeCompare(label(axisKeys[b]))));
        axisKeys = order.map((i) => axisKeys[i]);
        for (const s of series) s.values = order.map((i) => s.values[i]);
    }

    // Écart entre deux périodes : première − seconde, et en proportion de la
    // seconde (« +18 % par rapport à 2025 »).
    let delta = null;
    if (spec.compare.layout === 'delta' && entries.length === 2 && !splitKey) {
        const [a, b] = [series[0].values, series[1].values];
        delta = {
            values: a.map((v, i) => (v === null || b[i] === null ? null : v - b[i])),
            ratios: a.map((v, i) => (v === null || b[i] === null || b[i] === 0 ? null : (v - b[i]) / b[i])),
        };
    }

    return {
        dim,
        kind,
        align,
        elapsedUnit,
        keys: axisKeys,
        series,
        periods: entries,
        truncated,
        toDate,
        delta,
        normalize: spec.compare.normalize,
        meta: { rows, undated: table.undated, noAttribute },
    };
}

// Mise à l'échelle d'une série : en pourcentage de son total (d'un cumul :
// de sa valeur finale), ou par jour de période écoulé.
function scaleValues(values, spec, op, entry, today) {
    const mode = spec.compare.normalize;
    if (mode === 'percent') {
        const present = values.filter((v) => v !== null);
        const total = op === 'cumulative' ? (present.at(-1) ?? 0) : present.reduce((a, b) => a + b, 0);
        return values.map((v) => (v === null ? null : (total ? (v * 100) / total : 0)));
    }
    if (mode === 'per_day') {
        const days = Math.max(1, Math.min(entry.to, today) - entry.from + 1);
        return values.map((v) => (v === null ? null : v / days));
    }
    return values;
}
