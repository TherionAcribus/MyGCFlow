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
import { MAX_SERIES, chartSources, dimensionKind } from './chart_spec.mjs';
import { daysInMonth, expandPeriods, toDateCut } from './chart_periods.mjs';
import { DICT_FIELDS, SOURCE_KIND_VALUES, weekStart } from './chart_sources.mjs';
import { challengeGrid } from './chart_challenge.mjs';

export { OTHERS_KEY, UNKNOWN_KEY };

// Catégories plafonnées par `view.top` (les autres ont un domaine fixe).
const TOP_DIMENSIONS = new Set(['cache_type', 'container', 'country', 'state', 'owner', 'attribute', 'dt', 'cache', 'finder', 'county']);
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
        // Année × 100 + mois ; avant mai 2000 : date corrompue (JASMER_START).
        case 'published_month': return (r) => {
            const day = table.published[r];
            if (Number.isNaN(day)) return UNKNOWN_KEY;
            const { y, m } = ymdOfDay(day);
            const key = y * 100 + m;
            return key < 200005 ? UNKNOWN_KEY : key;
        };
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
export const ABSENT = 'absent';

// Jours couverts par une clé cyclique dans l'année `y`.
export function cyclicBounds(dim, key, y) {
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
    if (BY_DAY_OPS.includes(op)) return new Map();
    return 0;
}

// Jour où un compte atteint `goal` (null : pas atteint).
function goalDayOf(tally, goal) {
    let running = 0;
    for (const day of [...tally.keys()].sort((a, b) => a - b)) {
        running += tally.get(day);
        if (running >= goal) return day;
    }
    return null;
}

// Mesures calculées sur les jours d'une case (jour → nombre de lignes).
const BY_DAY_OPS = ['max_per_day', 'streak', 'gap'];

// Record d'une case : { value, from, to } (numéros de jour), from / to null
// sans record.
//   max_per_day      la meilleure journée (la plus ancienne à égalité) ;
//   streak           la plus longue suite de jours consécutifs (la plus
//                    ancienne à égalité) ; `current` : celle qui court
//                    jusqu'à `end` ou la veille, sinon 0 ;
//   gap              la plus longue pause entre deux jours (jours sans).
export function dayRecord(op, counts, { current = false, end = null } = {}) {
    const none = { value: 0, from: null, to: null };
    if (!counts?.size) return none;
    if (op === 'max_per_day') {
        let best = none;
        for (const [day, n] of counts) {
            if (n > best.value || (n === best.value && day < best.from)) best = { value: n, from: day, to: day };
        }
        return best;
    }
    const days = [...counts.keys()].sort((a, b) => a - b);
    if (op === 'gap') {
        let best = none;
        for (let i = 1; i < days.length; i++) {
            const length = days[i] - days[i - 1] - 1;
            if (length > best.value) best = { value: length, from: days[i - 1] + 1, to: days[i] - 1 };
        }
        return best;
    }
    if (current) {
        const last = days.at(-1);
        if (end === null || last < end - 1 || last > end) return none;
        let start = last;
        for (let i = days.length - 2; i >= 0 && days[i] === start - 1; i--) start = days[i];
        return { value: last - start + 1, from: start, to: last };
    }
    let best = none;
    let start = days[0];
    for (let i = 0; i < days.length; i++) {
        if (i > 0 && days[i] !== days[i - 1] + 1) start = days[i];
        const length = days[i] - start + 1;
        if (length > best.value) best = { value: length, from: start, to: days[i] };
    }
    return best;
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

// Phase commune : périodes résolues (coupe « à date » comprise), masque de
// filtres et lignes de chaque période. Sert aussi à compter les catégories
// avant de choisir un top N commun à plusieurs sources (sharedAxisCaps).
function prepareQuery(spec, table, options = {}) {
    const { today } = options;
    // Périodes et filtres : ceux passés par l'appelant (héritage du tableau
    // de bord résolu, dashboard_model.mjs), sinon ceux du graphique.
    const periods = options.periods !== undefined ? options.periods : spec.periods;
    const filters = options.filters !== undefined ? options.filters : spec.filters;
    const dim = spec.groupBy;
    const kind = dimensionKind(dim);
    const op = spec.measure.op;
    // `extent` : étendue commune quand plusieurs sources partagent l'axe
    // (« toutes les données » = de la première à la dernière, toutes sources).
    const { periods: entries, truncated } = expandPeriods(periods || [{ kind: 'all' }], {
        extent: options.extent !== undefined ? options.extent : table.extent, today,
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
    // « Caches actives » : un stock — toutes les lignes comptent, la période
    // ne fixe que les dates où on le lit.
    const stock = op === 'active';
    for (let r = 0; r < table.n; r++) {
        if (!mask[r]) continue;
        let hit = false;
        for (const entry of entries) {
            if (stock || (table.day[r] >= entry.from && table.day[r] <= entry.to)) {
                inPeriod[entry.index].push(r);
                hit = true;
            }
        }
        if (!hit) continue;
        rows++;
        if (dim === 'attribute' && groupKey(r).length === 0) noAttribute++;
    }
    return { today, dim, kind, op, entries, truncated, toDate, elapsedUnit, align,
        mask, groupKey, splitKey, inPeriod, rows, noAttribute, stock };
}

// Plafonds de cardinalité : top N de l'axe, et des valeurs de la 2ᵉ
// dimension pour tenir dans MAX_SERIES séries. Rang = nombre de lignes,
// toutes périodes confondues.
function rankCounts(accessor, inPeriod) {
    const counts = new Map();
    for (const list of inPeriod) {
        for (const r of list) {
            for (const key of asList(accessor(r))) counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return counts;
}

function capCounts(counts, limit) {
    const ordered = [...counts.keys()].sort((a, b) => tailRank(a) - tailRank(b)
        || counts.get(b) - counts.get(a) || String(a).localeCompare(String(b)));
    const named = ordered.filter((k) => k !== UNKNOWN_KEY);
    if (named.length <= limit) return { keys: ordered, remap: null };
    const kept = new Set(named.slice(0, limit));
    const keys = [...kept, OTHERS_KEY];
    if (counts.has(UNKNOWN_KEY)) keys.push(UNKNOWN_KEY);
    return { keys, remap: (key) => (key === UNKNOWN_KEY || kept.has(key) ? key : OTHERS_KEY) };
}

// Domaine d'années de publication des comptages (min / max), null sans
// aucune année connue.
function yearDomainOf(counts) {
    const years = [...counts.keys()].filter((k) => k !== UNKNOWN_KEY);
    return years.length ? { min: Math.min(...years), max: Math.max(...years) } : null;
}

// Plafond « top N » de l'axe pour cette dimension et cette vue.
function axisTopLimit(spec, dim) {
    // Un anneau ou un radar colore chaque part : pas plus de parts que de
    // teintes (MAX_SERIES), « Autres » compris.
    const parts = spec.view.chart === 'donut' || spec.view.chart === 'radar';
    // La grille D/T montre toutes ses combinaisons : pas d'« Autres ».
    const fullGrid = dim === 'dt' && spec.view.chart === 'heatmap';
    return !TOP_DIMENSIONS.has(dim) || fullGrid ? Infinity
        : parts ? Math.min(spec.view.top, MAX_SERIES - 1) : spec.view.top;
}

export function runChartQuery(spec, table, options = {}) {
    const { labelOf = null } = options;
    const { today, dim, kind, op, entries, truncated, toDate, elapsedUnit, align,
        mask, groupKey, splitKey, inPeriod, rows, noAttribute, stock } = prepareQuery(spec, table, options);

    let axisKeys;
    let remapGroup = null;
    // Lignes de la période sans valeur pour une catégorie (sans D/T, sans
    // date de publication…) : signalées sous une grille de défi.
    let unknownRows = 0;
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
        const counts = rankCounts(groupKey, inPeriod);
        if (dim === 'difficulty' || dim === 'terrain') {
            axisKeys = [...DT_VALUES];
        } else if (dim === 'age') {
            axisKeys = Array.from({ length: 10 }, (_, i) => i);
        } else if (dim === 'published_year') {
            // Plusieurs sources : domaine commun passé par `yearDomain`.
            const domain = options.yearDomain || yearDomainOf(counts);
            axisKeys = domain ? rangeKeys(domain.max - domain.min + 1)
                .map((i) => domain.min + i - 1) : [];
        } else {
            // Plusieurs sources : top N commun passé par `axisCap`.
            const result = options.axisCap || capCounts(counts, axisTopLimit(spec, dim));
            axisKeys = result.keys.filter((k) => k !== UNKNOWN_KEY);
            remapGroup = result.remap;
            if (dim === 'container') {
                axisKeys.sort((a, b) => tailRank(a) - tailRank(b) || containerRank(a) - containerRank(b)
                    || String(a).localeCompare(String(b)));
            }
        }
        if (counts.has(UNKNOWN_KEY)) axisKeys.push(UNKNOWN_KEY);
        unknownRows = counts.get(UNKNOWN_KEY) || 0;
    }
    // Grille de défi : toutes les cases disponibles, trouvées ou non, dans
    // l'ordre de la grille (première période).
    let grid = null;
    if (spec.view.chart === 'challenge') {
        grid = challengeGrid(dim, entries[0], today);
        axisKeys = grid ? grid.cells.map((cell) => cell.key) : [];
        remapGroup = null;
    }

    // Séries : période × valeur de la 2ᵉ dimension.
    let splitValues = [null];
    let remapSplit = null;
    if (splitKey) {
        const perPeriod = Math.max(1, Math.floor(MAX_SERIES / Math.max(1, entries.length)));
        const result = options.splitCap || capCounts(rankCounts(splitKey, inPeriod), perPeriod - 1);
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
        // Objectif d'un comptage au total : jour par jour, pour dater le
        // moment où il a été atteint.
        const goalTally = spec.goal && kind === 'none' && op === 'count' && !splitKey ? new Map() : null;
        // Un stock ne compte pas les événements de la période.
        for (const r of stock ? [] : inPeriod[entry.index]) {
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
                    } else if (BY_DAY_OPS.includes(op)) {
                        row[i].set(table.day[r], (row[i].get(table.day[r]) || 0) + 1);
                    } else {
                        row[i] += 1;
                        if (goalTally) goalTally.set(table.day[r], (goalTally.get(table.day[r]) || 0) + 1);
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

        const actives = stock ? activeGroups(inPeriod[entry.index], {
            table, kind, groupKey, splitKey, remapGroup, remapSplit,
        }) : null;

        for (const s of splitValues) {
            const row = cells.get(s);
            if (stock) {
                // Caches actives à la fin de chaque case (temps) ou de la
                // période (total, catégories), sans dépasser aujourd'hui.
                const values = axisKeys.map((key, i) => {
                    const b = bounds[i];
                    if (b === ABSENT) return null;
                    let end = Math.min(entry.to, today);
                    if (Array.isArray(b)) {
                        if (b[1] < entry.from || b[0] > entry.to || b[0] > today) return null;
                        end = Math.min(b[1], end);
                    }
                    const group = actives.get(s)?.get(kind === 'category' ? key : null);
                    return group ? activeAt(group, end) : 0;
                });
                series.push({
                    id: s === null ? `p${entry.index}` : `p${entry.index}:${s}`,
                    periodIndex: entry.index,
                    split: s,
                    values,
                    partial,
                    dates: elapsedUnit ? bounds.map((b) => (Array.isArray(b) ? b[0] : null)) : null,
                });
                continue;
            }
            // Records datés : la valeur et ses jours.
            // « Toute la période » finit à la dernière trouvaille : une série
            // en cours se juge à aujourd'hui.
            const runEnd = entry.as?.kind === 'all' ? today : end;
            const records = BY_DAY_OPS.includes(op)
                ? row.map((cell) => dayRecord(op, cell, { current: spec.measure.current, end: runEnd }))
                : null;
            let base = 0;
            let values = row.map((cell, i) => {
                if (op === 'distinct') return cell.size;
                if (op === 'mean') return cell.n ? cell.sum / cell.n : null;
                if (records) return records[i].value;
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
                // Point de départ : le rythme d'une projection se compte
                // sur ce que la période ajoute.
                base = running;
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
                // Jours du record de chaque case ({ from, to }, null : pas de
                // record ou case hors période).
                records: records ? records.map((rec, i) => (values[i] === null || rec.from === null
                    ? null : { from: rec.from, to: rec.to })) : null,
                base,
                goalDay: goalTally ? goalDayOf(goalTally, spec.goal.value) : null,
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
        for (const s of series) {
            s.values = order.map((i) => s.values[i]);
            if (s.records) s.records = order.map((i) => s.records[i]);
        }
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
        grid,
        meta: { rows, undated: table.undated, noAttribute, unknown: unknownRows },
    };
}

// Groupes des lignes pour la mesure « actives » : par valeur de la 2ᵉ
// dimension puis par clé (catégories ; null sinon), chacun avec les jours de
// début et de fin triés (Float64Array : tri numérique natif).
//
// Chemin chaud sur un jeu Évolution national (460 000 caches) : aucune
// allocation par ligne dans le cas courant (une clé, pas de 2ᵉ dimension),
// et le dernier groupe servi est gardé sous la main — les lignes d'une même
// clé se suivent souvent.
function activeGroups(rows, { table, kind, groupKey, splitKey, remapGroup, remapSplit }) {
    const groups = new Map();
    let lastSplit;
    let lastKey;
    let lastGroup = null;
    const groupOf = (s, k) => {
        if (lastGroup && s === lastSplit && k === lastKey) return lastGroup;
        let bySplit = groups.get(s);
        if (!bySplit) groups.set(s, bySplit = new Map());
        let group = bySplit.get(k);
        if (!group) bySplit.set(k, group = { starts: [], ends: [] });
        lastSplit = s;
        lastKey = k;
        lastGroup = group;
        return group;
    };
    const add = (s, k, day, end) => {
        const group = groupOf(s, k);
        group.starts.push(day);
        if (end === end) group.ends.push(end); // NaN : pas de fin
    };
    const byCategory = kind === 'category';
    for (const r of rows) {
        const day = table.day[r];
        const end = table.endDay[r];
        const splitRaw = splitKey ? splitKey(r) : null;
        const keyRaw = byCategory ? groupKey(r) : null;
        const splitMany = Array.isArray(splitRaw);
        const keyMany = Array.isArray(keyRaw);
        if (!splitMany && !keyMany) {
            const s = splitKey && remapSplit ? remapSplit(splitRaw) : splitRaw;
            const k = byCategory && remapGroup ? remapGroup(keyRaw) : keyRaw;
            add(s, k, day, end);
            continue;
        }
        // Valeurs multiples (attributs) : chaque paire compte.
        for (const s0 of asList(splitRaw)) {
            const s = splitKey && remapSplit ? remapSplit(s0) : s0;
            for (const k0 of asList(keyRaw)) {
                add(s, byCategory && remapGroup ? remapGroup(k0) : k0, day, end);
            }
        }
    }
    for (const bySplit of groups.values()) {
        for (const group of bySplit.values()) {
            group.starts = Float64Array.from(group.starts).sort();
            group.ends = Float64Array.from(group.ends).sort();
        }
    }
    return groups;
}

// Nombre de valeurs ≤ x dans un tableau trié.
function countUpTo(sorted, x) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Actives au jour `day` : commencées ce jour ou avant, pas encore finies
// (une fin le jour même retire l'élément).
export function activeAt(group, day) {
    return countUpTo(group.starts, day) - countUpTo(group.ends, day);
}

// ---------------------------------------------------------------------------
// Plusieurs sources
// ---------------------------------------------------------------------------

function unionExtent(tables) {
    const extents = tables.map((t) => t?.extent).filter(Boolean);
    if (!extents.length) return null;
    return { first: Math.min(...extents.map((e) => e.first)), last: Math.max(...extents.map((e) => e.last)) };
}

// Somme des comptages de catégories sur toutes les sources.
function sumCounts(preps, accessorName) {
    const combined = new Map();
    for (const prep of preps) {
        for (const [key, n] of rankCounts(prep[accessorName], prep.inPeriod)) {
            combined.set(key, (combined.get(key) || 0) + n);
        }
    }
    return combined;
}

// Plafonds communs à plusieurs sources : top N de l'axe, top N de la 2ᵉ
// dimension, étendue des années de publication. Un plafond choisi source
// par source laisserait une valeur « Autres » ici et principale là — elle
// s'afficherait à zéro pour la première source alors qu'elle compte.
function sharedAxisCaps(spec, tables, options) {
    const dim = spec.groupBy;
    const fixed = dim === 'difficulty' || dim === 'terrain' || dim === 'age';
    const cappedGroup = dimensionKind(dim) === 'category' && !fixed;
    if (!cappedGroup && !spec.splitBy) return {};
    const preps = tables.map((table) => prepareQuery(spec, table, options));
    const shared = {};
    if (dim === 'published_year') {
        const domain = yearDomainOf(sumCounts(preps, 'groupKey'));
        if (domain) shared.yearDomain = domain;
    } else if (cappedGroup) {
        shared.axisCap = capCounts(sumCounts(preps, 'groupKey'), axisTopLimit(spec, dim));
    }
    if (spec.splitBy) {
        const perPeriod = Math.max(1, Math.floor(MAX_SERIES / Math.max(1, preps[0].entries.length)));
        shared.splitCap = capCounts(sumCounts(preps, 'splitKey'), perPeriod - 1);
    }
    return shared;
}

// Graphique sur une ou plusieurs sources (spec.source + spec.extraSources).
// `tableOf(source)` rend la table d'une source. Chaque source est calculée
// à part sur les mêmes périodes et la même étendue, puis les séries sont
// réunies sur un axe commun ; chaque série porte `source` et
// `sourceIndex`. Au plus MAX_SERIES séries.
export function runChartQueries(spec, tableOf, options = {}) {
    const sources = chartSources(spec);
    if (sources.length === 1) {
        const result = runChartQuery(spec, tableOf(spec.source), options);
        for (const s of result.series) {
            s.source = spec.source;
            s.sourceIndex = 0;
        }
        return { ...result, sources };
    }
    const tables = sources.map((source) => tableOf(source));
    const extent = unionExtent(tables);
    const single = { ...spec, extraSources: [], compare: { ...spec.compare, layout: spec.compare.layout === 'delta' ? 'overlay' : spec.compare.layout } };
    const shared = sharedAxisCaps(single, tables, { ...options, extent });
    const results = sources.map((source, i) => runChartQuery({ ...single, source }, tables[i], { ...options, extent, ...shared }));
    const base = results[0];

    // Axe commun : celui de la première source, complété des clés des
    // autres (catégories), « Autres » puis « Inconnu » en fin.
    let keys = base.keys;
    if (base.kind === 'category') {
        const seen = new Set(keys);
        const extra = [];
        for (const result of results.slice(1)) {
            for (const key of result.keys) {
                if (!seen.has(key)) {
                    seen.add(key);
                    extra.push(key);
                }
            }
        }
        keys = [...keys, ...extra].sort((a, b) => tailRank(a) - tailRank(b));
    }
    const series = [];
    results.forEach((result, sourceIndex) => {
        const index = new Map(result.keys.map((key, i) => [key, i]));
        for (const s of result.series) {
            const values = keys.map((key) => {
                const i = index.get(key);
                return i === undefined ? (base.kind === 'category' ? 0 : null) : s.values[i];
            });
            const dates = s.dates ? keys.map((key) => {
                const i = index.get(key);
                return i === undefined ? null : s.dates[i];
            }) : null;
            const records = s.records ? keys.map((key) => {
                const i = index.get(key);
                return i === undefined ? null : s.records[i];
            }) : null;
            series.push({ ...s, id: `s${sourceIndex}:${s.id}`, source: sources[sourceIndex], sourceIndex, values, dates, records });
        }
    });
    const cut = series.length > MAX_SERIES;
    const kept = cut ? series.slice(0, MAX_SERIES) : series;
    let delta = null;
    if (spec.compare.layout === 'delta' && kept.length === 2 && !spec.splitBy) {
        const [a, b] = [kept[0].values, kept[1].values];
        delta = {
            values: a.map((v, i) => (v === null || b[i] === null ? null : v - b[i])),
            ratios: a.map((v, i) => (v === null || b[i] === null || b[i] === 0 ? null : (v - b[i]) / b[i])),
        };
    }
    return {
        ...base,
        keys,
        series: kept,
        sources,
        truncated: base.truncated || cut,
        delta,
        meta: {
            rows: results.reduce((sum, r) => sum + r.meta.rows, 0),
            undated: results.reduce((sum, r) => sum + r.meta.undated, 0),
            noAttribute: results.reduce((sum, r) => sum + r.meta.noAttribute, 0),
        },
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
