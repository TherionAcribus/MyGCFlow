// Périodes de la page Statistiques : description (chart_spec.mjs) → intervalles
// de jours concrets. Module pur, testé par tests/js/chart_query.test.mjs.
//
// Bornes en numéros de jour, incluses des deux côtés. « Aujourd'hui » est
// passé par l'appelant (jour local) : rien ici ne lit l'horloge.

import { dayNumber, parseYmd, ymdOfDay } from './stats_model.mjs';
import { MAX_SERIES } from './chart_spec.mjs';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y, m) => (m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]);

// Jour local courant → numéro de jour.
export function todayDay(now = new Date()) {
    return dayNumber({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

function yearBounds(y) {
    return { from: dayNumber({ y, m: 1, d: 1 }), to: dayNumber({ y, m: 12, d: 31 }) };
}

function monthBounds(y, m) {
    return { from: dayNumber({ y, m, d: 1 }), to: dayNumber({ y, m, d: daysInMonth(y, m) }) };
}

// Le même jour `count` mois plus tôt (rabattu sur la fin d'un mois plus court).
function monthsBefore(day, count) {
    const { y, m, d } = ymdOfDay(day);
    const index = y * 12 + (m - 1) - count;
    const ty = Math.floor(index / 12);
    const tm = (index % 12) + 1;
    return dayNumber({ y: ty, m: tm, d: Math.min(d, daysInMonth(ty, tm)) });
}

// Période glissante : les `count` derniers jours / mois / ans, aujourd'hui
// compris (12 derniers mois au 8 novembre = du 9 novembre au 8 novembre).
function rollingBounds({ unit, count }, today) {
    if (unit === 'day') return { from: today - count + 1, to: today };
    const months = unit === 'year' ? count * 12 : count;
    return { from: monthsBefore(today, months) + 1, to: today };
}

// Une période → zéro, une ou plusieurs entrées concrètes
// { from, to, period, year?, month? }.
function expandOne(period, extent, today) {
    switch (period.kind) {
        case 'all':
            return [extent ? { from: extent.first, to: extent.last } : { from: today, to: today }];
        case 'year':
            return [{ ...yearBounds(period.year), year: period.year }];
        case 'month':
            return [{ ...monthBounds(period.year, period.month), year: period.year, month: period.month }];
        case 'range':
            return [{ from: dayNumber(parseYmd(period.from)), to: dayNumber(parseYmd(period.to)) }];
        case 'rolling':
            return [rollingBounds(period, today)];
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
                    const y = Math.floor(i / 12);
                    const m = (i % 12) + 1;
                    out.push({ ...monthBounds(y, m), year: y, month: m });
                }
            } else {
                for (let y = start.y; y <= end.y; y++) out.push({ ...yearBounds(y), year: y });
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
        for (const entry of expandOne(period, extent, today)) {
            out.push({ ...entry, period });
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
