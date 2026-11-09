// Objectif et projection de la page Statistiques. Module pur, testé par
// tests/js/chart_goal.test.mjs.
//
// Le rythme est celui de la période, sur sa partie écoulée (jusqu'à
// aujourd'hui compris) : simple à expliquer (« à ce rythme »), sans
// paramètre. « Toute la période » finit à la dernière trouvaille : elle se
// prolonge jusqu'à aujourd'hui pour le rythme, et n'a pas de fin à
// projeter (seulement la date d'un objectif).

import { ABSENT, cyclicBounds, timeKeyBounds } from './chart_query.mjs';
import { ymdOfDay } from './stats_model.mjs';

// Caps ronds : le prochain au-dessus du total (« Mon prochain cap »).
const MILESTONES = [10, 25, 50, 100, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000];
export function nextMilestone(total) {
    const n = Math.max(0, Math.floor(Number(total) || 0));
    const fixed = MILESTONES.find((m) => m > n);
    if (fixed) return fixed;
    return (Math.floor(n / 5000) + 1) * 5000;
}

const isOpen = (entry) => entry?.as?.kind === 'all';

// Gain par jour sur la partie écoulée d'une période, 0 si rien n'est écoulé.
export function periodPace(gain, entry, today) {
    if (!entry) return 0;
    const last = isOpen(entry) ? today : Math.min(entry.to, today);
    const elapsed = last - entry.from + 1;
    return elapsed > 0 && gain > 0 ? gain / elapsed : 0;
}

// Période en cours : commencée, pas finie (« Toute la période » l'est
// toujours — elle court jusqu'à aujourd'hui).
export function periodOngoing(entry, today) {
    if (!entry) return false;
    return isOpen(entry) || (entry.from <= today && today < entry.to);
}

// Chiffre clé : où en est la valeur de la période.
//   ratio / reached     part de l'objectif (bornée à 1), atteint ou non ;
//   reachedDay          jour où il l'a été (comptage seulement) ;
//   projected           valeur à la fin de la période, à ce rythme (null :
//                       période finie, ou « toute la période ») ;
//   eta                 jour où l'objectif serait atteint, à ce rythme ;
//   short               ce qui manquerait à la fin de la période.
export function numberOutlook({ value, goal = null, entry, today, goalDay = null }) {
    const v = Number.isFinite(value) ? value : 0;
    const out = {
        value: v, goal, ratio: null, reached: false, reachedDay: null,
        projected: null, eta: null, short: null,
    };
    if (goal) {
        out.ratio = Math.min(1, v / goal);
        out.reached = v >= goal;
        if (out.reached) out.reachedDay = goalDay;
    }
    if (!periodOngoing(entry, today)) return out;
    const rate = periodPace(v, entry, today);
    if (!isOpen(entry)) out.projected = Math.round(v + rate * (entry.to - today));
    if (goal && !out.reached && rate > 0) {
        out.eta = today + Math.ceil((goal - v) / rate);
        if (!isOpen(entry) && out.eta > entry.to) {
            out.short = Math.max(0, goal - out.projected);
            out.eta = null;
        }
    }
    return out;
}

// Borne haute « ronde » d'un axe qui doit contenir `value` : un multiple
// d'un pas 1, 2 ou 5 × 10ⁿ (environ cinq graduations).
export function niceAxisMax(value) {
    if (!(value > 0)) return 1;
    const raw = value / 5;
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw);
    return Math.ceil(value / step - 1e-9) * step;
}

// Dernier jour de la case i d'un résultat, null si inconnu.
function bucketEnd(result, s, i, entry) {
    const key = result.keys[i];
    if (result.align === 'elapsed') {
        const start = s.dates?.[i + 1];
        if (start !== null && start !== undefined) return start - 1;
        return s.dates?.[i] !== null && s.dates?.[i] !== undefined ? entry.to : null;
    }
    if (result.kind === 'time') return timeKeyBounds(result.dim, key)[1];
    if (result.kind === 'cyclic') {
        const bounds = cyclicBounds(result.dim, key, ymdOfDay(entry.from).y);
        return bounds && bounds !== ABSENT ? bounds[1] : null;
    }
    return null;
}

// Cumul prolongé à ce rythme jusqu'à la fin de la période : une valeur par
// case (null avant aujourd'hui), ou null (période finie ou pas commencée,
// pas de case du jour, valeurs mises à l'échelle).
export function projectionValues(result, s, today) {
    if (result.normalize && result.normalize !== 'none') return null;
    const entry = result.periods[s.periodIndex];
    if (!entry || isOpen(entry) || !periodOngoing(entry, today)) return null;
    // Case d'aujourd'hui : la première qui finit aujourd'hui ou après
    // (`partial` vaut -1 le dernier jour d'une case ; un 29 février d'année
    // ordinaire garde une valeur de cumul même à venir).
    const ref = Math.min(today, entry.to);
    let k = -1;
    for (let i = 0; i < s.values.length; i++) {
        const end = bucketEnd(result, s, i, entry);
        if (end !== null && end >= ref) {
            k = i;
            break;
        }
    }
    if (k < 0 || s.values[k] === null || s.values[k] === undefined) return null;
    const now = s.values[k];
    const rate = periodPace(now - (s.base || 0), entry, today);
    return s.values.map((_, i) => {
        if (i < k) return null;
        if (i === k) return now;
        const end = bucketEnd(result, s, i, entry);
        if (end === null) return null;
        return now + rate * (Math.min(end, entry.to) - today);
    });
}
