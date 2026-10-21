// Barre de chronologie : calculs purs (aucun accès au DOM ni à l'application).
//
// La plage de l'animation compte `span` jours, indexés de 0 (date de début) à
// span - 1 (date de fin). Le curseur désigne « l'état à la fin du jour k » :
// il se dessine au bord droit du jour k, à x = (k + 1) / span — la partie
// jouée de la barre couvre ainsi exactement les jours déjà affichés, barres
// de l'histogramme comprises.
import { dateToDayNumber, dayNumberToDate } from './evolution_timeline.mjs';

export const TIMELINE_STYLES = Object.freeze(['simple', 'histogram', 'curve']);
export const TIMELINE_DEFAULT_STYLE = 'histogram';

// Tailles de tranche de l'histogramme (en jours), de la plus fine à la plus
// grossière : la première qui laisse au moins `minBarPx` par barre.
const BUCKET_DAYS = [1, 2, 7, 14, 30, 61, 91, 182, 365];

export function normalizeTimelineStyle(value) {
    return TIMELINE_STYLES.includes(value) ? value : TIMELINE_DEFAULT_STYLE;
}

export function spanDays(start, end) {
    const a = dateToDayNumber(start);
    const b = dateToDayNumber(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return b - a + 1;
}

export function dayOffsetOf(date, start) {
    return dateToDayNumber(date) - dateToDayNumber(start);
}

export function dateOfOffset(start, offset) {
    return dayNumberToDate(dateToDayNumber(start) + offset);
}

export function clampOffset(offset, span) {
    if (!(span > 0) || !Number.isFinite(offset)) return 0;
    return Math.max(0, Math.min(span - 1, Math.round(offset)));
}

// Abscisse relative (0..1) du curseur à la fin du jour `offset`.
export function cursorFraction(offset, span) {
    if (!(span > 0)) return 0;
    return (clampOffset(offset, span) + 1) / span;
}

// Jour désigné par une abscisse relative : celui dont la case contient x.
export function offsetAtFraction(fraction, span) {
    if (!(span > 0)) return 0;
    return clampOffset(Math.floor((Number(fraction) || 0) * span), span);
}

// Jour visé par une touche, ou null si la touche n'est pas pour le curseur.
// ←/→ un jour, Maj+←/→ une semaine, PgPréc/PgSuiv un mois (calendaire),
// Début/Fin les bornes de la plage. ↑/↓ suivent ←/→ (pattern ARIA slider).
export function offsetForKey(key, { shift = false } = {}, offset, start, span) {
    if (!(span > 0)) return null;
    const step = shift ? 7 : 1;
    switch (key) {
        case 'ArrowLeft':
        case 'ArrowDown':
            return clampOffset(offset - step, span);
        case 'ArrowRight':
        case 'ArrowUp':
            return clampOffset(offset + step, span);
        case 'PageUp':
        case 'PageDown': {
            const date = dateOfOffset(start, clampOffset(offset, span));
            const day = date.getDate();
            const target = new Date(date.getFullYear(), date.getMonth() + (key === 'PageUp' ? 1 : -1), 1);
            // Même quantième, ramené au dernier jour d'un mois plus court.
            const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
            target.setDate(Math.min(day, last));
            return clampOffset(dayOffsetOf(target, start), span);
        }
        case 'Home':
            return 0;
        case 'End':
            return span - 1;
        default:
            return null;
    }
}

export function bucketDaysFor(span, widthPx, minBarPx = 3) {
    const width = Math.max(1, Number(widthPx) || 1);
    for (const days of BUCKET_DAYS) {
        if (Math.ceil(span / days) * minBarPx <= width) return days;
    }
    return Math.ceil(span * minBarPx / width);
}

// Sommes par tranche de `bucketDays` jours, alignées sur la date de début.
export function bucketize(perDay, bucketDays) {
    const size = Math.max(1, Math.floor(bucketDays) || 1);
    const out = new Float64Array(Math.ceil(perDay.length / size));
    for (let i = 0; i < perDay.length; i++) out[Math.floor(i / size)] += perDay[i];
    return out;
}

// Valeur à la fin de chaque jour : `base` (ce qui précède la plage) puis le
// cumul des événements du jour.
export function cumulative(perDay, base = 0) {
    const out = new Float64Array(perDay.length);
    let total = Number(base) || 0;
    for (let i = 0; i < perDay.length; i++) {
        total += perDay[i];
        out[i] = total;
    }
    return out;
}

// Part de la plage ajoutée en marge de chaque côté de l'axe.
export const TIMELINE_MARGIN_FRACTION = 0.25;

// Axe de la piste : la plage de l'animation, plus une marge de chaque côté
// (une fraction de la plage, dans la limite de l'étendue des données) où
// l'on peut tirer les poignées pour l'étendre. Toute l'étendue réduirait
// une plage courte à une tranche trop fine pour viser un jour ; la marge
// se recalcule après chaque extension. `rangeOffset` : place du premier
// jour de l'animation sur l'axe. Sans étendue connue : la plage seule.
export function timelineAxis(rangeStart, rangeEnd, extentStart = null, extentEnd = null,
    marginFraction = TIMELINE_MARGIN_FRACTION) {
    const span = spanDays(rangeStart, rangeEnd);
    if (!(span > 0)) return null;
    const first = dateToDayNumber(rangeStart);
    const last = dateToDayNumber(rangeEnd);
    let before = 0;
    let after = 0;
    if (spanDays(extentStart, extentEnd) > 0) {
        const margin = Math.ceil(span * Math.max(0, Number(marginFraction) || 0));
        before = Math.max(0, Math.min(margin, first - dateToDayNumber(extentStart)));
        after = Math.max(0, Math.min(margin, dateToDayNumber(extentEnd) - last));
    }
    return {
        start: dayNumberToDate(first - before),
        span: span + before + after,
        rangeOffset: before,
        rangeSpan: span,
    };
}

// Jour suivant (direction 1) ou précédent (-1) dont `totals` est non nul,
// entre `lo` et `hi` inclus ; null s'il n'y en a pas.
export function nextEventOffset(totals, offset, direction, lo = 0, hi = (totals?.length || 0) - 1) {
    const step = direction < 0 ? -1 : 1;
    for (let k = Math.round(offset) + step; k >= lo && k <= hi; k += step) {
        if (totals[k] > 0) return k;
    }
    return null;
}

// Pas « ronds » des trouvailles marquantes, du plus fin au plus large.
const MILESTONE_STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

// Trouvailles marquantes franchies sur l'axe : multiples d'un pas rond, le
// plus fin qui n'en place pas plus de `maxCount`. `level` est le cumul à la
// fin de chaque jour, `before` celui de la veille du premier jour. Renvoie
// [{ offset, value }] : le jour où le cumul atteint `value`.
export function milestoneMarks(level, before = 0, maxCount = 12) {
    const n = level?.length || 0;
    if (!n) return [];
    const from = Math.max(0, Number(before) || 0);
    const total = level[n - 1];
    const step = MILESTONE_STEPS.find((s) => Math.floor(total / s) - Math.floor(from / s) <= maxCount);
    if (!step) return [];
    const out = [];
    let k = 0;
    for (let value = (Math.floor(from / step) + 1) * step; value <= total; value += step) {
        // Le cumul ne décroît pas : la recherche reprend où la précédente
        // s'est arrêtée.
        while (k < n && level[k] < value) k++;
        if (k >= n) break;
        out.push({ offset: k, value });
    }
    return out;
}

// Instant vidéo lisible : « 0:42 », « 12:05 », « 1:02:03 ».
export function formatVideoTime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Nombre d'entrées de `sortedDays` (croissant) inférieures ou égales à
// `day` — recherche dichotomique. Sert au saut incrémental (mapgl.js) :
// les jours affichés sont toujours un préfixe de la liste triée.
export function countDaysUpTo(sortedDays, day) {
    let lo = 0;
    let hi = sortedDays?.length || 0;
    if (Number.isNaN(day)) return 0;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedDays[mid] <= day) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Valeurs regroupées en `columns` colonnes consécutives (la colonne c couvre
// les indices [⌊c·n/columns⌋, ⌊(c+1)·n/columns⌋), jamais vide) : minimum,
// maximum, première et dernière valeur de chacune. La courbe de la barre
// trace ainsi les pics d'une série plus longue que la piste n'a de pixels.
export function columnExtremes(values, columns) {
    const n = values?.length || 0;
    const count = Math.max(0, Math.min(n, Math.floor(columns) || 0));
    const lo = new Float64Array(count);
    const hi = new Float64Array(count);
    const first = new Float64Array(count);
    const last = new Float64Array(count);
    for (let c = 0; c < count; c++) {
        const k0 = Math.floor(c * n / count);
        const k1 = Math.max(k0 + 1, Math.floor((c + 1) * n / count));
        let min = Infinity;
        let max = -Infinity;
        for (let k = k0; k < k1; k++) {
            const v = values[k];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        lo[c] = min;
        hi[c] = max;
        first[c] = values[k0];
        last[c] = values[k1 - 1];
    }
    return { lo, hi, first, last };
}

export function seriesExtent(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

// Décalages des 1ᵉʳ janvier compris dans la plage (repères verticaux).
export function yearStartOffsets(start, span) {
    const out = [];
    if (!(span > 0)) return out;
    const first = dateOfOffset(start, 0);
    for (let year = first.getFullYear() + 1; ; year++) {
        const offset = dayOffsetOf(new Date(year, 0, 1), start);
        if (offset >= span) break;
        out.push(offset);
    }
    return out;
}

// Sous-ensemble des repères dont l'étiquette d'année tient sur la piste.
// Toutes les afficher les ferait se chevaucher dès que la plage compte
// plus d'années que la piste n'a de « cases » de minLabelPx. Glouton
// depuis la gauche : le premier repère — le plus proche du début de la
// plage, donc le plus significatif — est toujours gardé, puis chacun
// assez loin du dernier retenu (mesuré sur le retenu, pas sur le vu :
// un repère écarté ne bloque pas le suivant).
export function yearLabelOffsets(offsets, span, widthPx, minLabelPx = 46) {
    const out = [];
    if (!(span > 0) || !(widthPx > 0)) return out;
    let lastX = -Infinity;
    for (const offset of offsets) {
        const x = offset / span * widthPx;
        if (x - lastX < minLabelPx) continue;
        out.push(offset);
        lastX = x;
    }
    return out;
}
