// Périodes de la page Statistiques : description (chart_spec.mjs) → intervalles
// de jours concrets. Module pur, testé par tests/js/chart_query.test.mjs.
//
// Bornes en numéros de jour, incluses des deux côtés. « Aujourd'hui » est
// passé par l'appelant (jour local) : rien ici ne lit l'horloge.
//
// Chaque entrée déployée :
//   { index, from, to, fullTo, period, as, step, ongoing }
//   period   la description d'origine (libellé personnalisé compris)
//   as       ce que l'entrée est concrètement, pour la nommer :
//            { kind: 'year', year } / { kind: 'month', year, month } /
//            { kind: 'range' } / { kind: 'all' } / { kind: 'rolling', unit, count }
//   step     pas d'un décalage « période précédente » : { months } ou { days }
//   ongoing  la période contient aujourd'hui et n'est pas finie
//   fullTo   fin d'origine (`to` peut être raccourci par la comparaison « à
//            date », chart_query.mjs)

import { dayNumber, parseYmd, ymdOfDay } from './stats_model.mjs';
import { MAX_SERIES } from './chart_spec.mjs';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
export const daysInMonth = (y, m) => (m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]);

// Jour local courant → numéro de jour.
export function todayDay(now = new Date()) {
    return dayNumber({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

function yearEntry(y) {
    return {
        from: dayNumber({ y, m: 1, d: 1 }),
        to: dayNumber({ y, m: 12, d: 31 }),
        as: { kind: 'year', year: y },
        step: { months: 12 },
    };
}

function monthEntry(y, m) {
    return {
        from: dayNumber({ y, m, d: 1 }),
        to: dayNumber({ y, m, d: daysInMonth(y, m) }),
        as: { kind: 'month', year: y, month: m },
        step: { months: 1 },
    };
}

// Le même jour `count` mois plus tôt (rabattu sur la fin d'un mois plus court).
export function monthsBefore(day, count) {
    const { y, m, d } = ymdOfDay(day);
    const index = y * 12 + (m - 1) - count;
    const ty = Math.floor(index / 12);
    const tm = (index % 12) + 1;
    return dayNumber({ y: ty, m: tm, d: Math.min(d, daysInMonth(ty, tm)) });
}

// Période glissante : les `count` derniers jours / mois / ans, aujourd'hui
// compris (12 derniers mois au 8 novembre = du 9 novembre au 8 novembre).
function rollingEntry(period, today) {
    const { unit, count } = period;
    const as = { kind: 'rolling', unit, count };
    if (unit === 'day') return { from: today - count + 1, to: today, as, step: { days: count } };
    const months = unit === 'year' ? count * 12 : count;
    return { from: monthsBefore(today, months) + 1, to: today, as, step: { months } };
}

// Période juste avant `base` : même pas, se terminant la veille de son début.
// 2025 → 2024, mars → février, les 12 derniers mois → les 12 d'avant, une
// plage de 10 jours → les 10 jours d'avant. Nommée comme sa base quand elle
// tombe sur une année ou un mois entier.
function previousEntry(base) {
    if (!base?.step) return null;
    const to = base.from - 1;
    // Avant « les 12 derniers mois » : « les 12 mois précédents ».
    const rolling = base.as?.kind === 'rolling' ? { kind: 'previous_rolling', unit: base.as.unit, count: base.as.count } : null;
    if (base.step.days) {
        return { from: base.from - base.step.days, to, as: rolling || { kind: 'range' }, step: base.step };
    }
    const from = monthsBefore(base.from, base.step.months);
    const start = ymdOfDay(from);
    const end = ymdOfDay(to);
    const wholeMonths = start.d === 1 && end.d === daysInMonth(end.y, end.m);
    let as = rolling || { kind: 'range' };
    if (wholeMonths && base.step.months === 12 && start.m === 1) as = { kind: 'year', year: start.y };
    else if (wholeMonths && base.step.months === 1) as = { kind: 'month', year: start.y, month: start.m };
    return { from, to, as, step: base.step };
}

// Une période → zéro, une ou plusieurs entrées concrètes. `previous` est
// l'entrée qui la précède dans la liste (pour « la période précédente »).
function expandOne(period, extent, today, previous) {
    switch (period.kind) {
        case 'all':
        // Période du tableau de bord non résolue par l'appelant : tout.
        case 'dashboard': {
            const all = extent ? { from: extent.first, to: extent.last } : { from: today, to: today };
            return [{ ...all, as: { kind: 'all' }, step: null }];
        }
        case 'year':
            return [yearEntry(period.year)];
        case 'month':
            return [monthEntry(period.year, period.month)];
        case 'current': {
            const { y, m } = ymdOfDay(today);
            return [period.unit === 'month' ? monthEntry(y, m) : yearEntry(y)];
        }
        case 'previous': {
            const entry = previousEntry(previous);
            return entry ? [entry] : [];
        }
        case 'range': {
            const from = dayNumber(parseYmd(period.from));
            const to = dayNumber(parseYmd(period.to));
            return [{ from, to, as: { kind: 'range' }, step: { days: to - from + 1 } }];
        }
        case 'rolling':
            return [rollingEntry(period, today)];
        case 'each': {
            // Une entrée par année (ou mois) des données, dans les bornes.
            if (!extent) return [];
            const lo = Math.max(extent.first, period.from ? dayNumber(parseYmd(period.from)) : -Infinity);
            const hi = Math.min(extent.last, period.to ? dayNumber(parseYmd(period.to)) : Infinity);
            if (lo > hi) return [];
            const start = ymdOfDay(lo);
            const end = ymdOfDay(hi);
            const out = [];
            if (period.unit === 'month') {
                for (let i = start.y * 12 + start.m - 1; i <= end.y * 12 + end.m - 1; i++) {
                    out.push(monthEntry(Math.floor(i / 12), (i % 12) + 1));
                }
            } else {
                for (let y = start.y; y <= end.y; y++) out.push(yearEntry(y));
            }
            return out;
        }
        default:
            return [];
    }
}

// Liste de périodes → entrées concrètes, dans l'ordre de la liste. Au-delà
// de MAX_SERIES entrées (« chaque mois » sur dix ans), seules les plus
// récentes restent et `truncated` le signale.
export function expandPeriods(periods, { extent = null, today }) {
    const out = [];
    for (const period of periods || []) {
        const previous = out.length ? out[out.length - 1] : null;
        for (const entry of expandOne(period, extent, today, previous)) {
            out.push({ ...entry, period, fullTo: entry.to, ongoing: entry.from <= today && today < entry.to });
        }
    }
    const truncated = out.length > MAX_SERIES;
    const kept = truncated ? out.slice(out.length - MAX_SERIES) : out;
    return { periods: kept.map((entry, index) => ({ ...entry, index })), truncated };
}

// Nombre de jours d'une entrée (bornes incluses).
export function periodLength(entry) {
    return entry.to - entry.from + 1;
}

// Jour de coupe « à date » d'une entrée comparée à la période en cours :
// même jour du calendrier quand les deux commencent un 1ᵉʳ janvier (même
// jour et même mois) ou un 1ᵉʳ du mois (même quantième), sinon même nombre
// de jours écoulés. Le 29 février d'une année ordinaire devient le 28.
export function toDateCut(entry, current, today) {
    const a = ymdOfDay(entry.from);
    const c = ymdOfDay(current.from);
    const t = ymdOfDay(today);
    if (a.d === 1 && c.d === 1 && a.m === 1 && c.m === 1) {
        // Même mois et même jour, l'année de l'entrée (+ les années d'écart
        // si la période en cours en couvre plusieurs).
        const y = a.y + (t.y - c.y);
        return dayNumber({ y, m: t.m, d: Math.min(t.d, daysInMonth(y, t.m)) });
    }
    if (a.d === 1 && c.d === 1) {
        const months = (t.y * 12 + t.m) - (c.y * 12 + c.m);
        const index = a.y * 12 + (a.m - 1) + months;
        const y = Math.floor(index / 12);
        const m = (index % 12) + 1;
        return dayNumber({ y, m, d: Math.min(t.d, daysInMonth(y, m)) });
    }
    return entry.from + (today - current.from);
}
