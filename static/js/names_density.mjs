// Durée de vie et densité des pseudos de Mes poses (docs/mode-poses.md,
// « Pseudos des visiteurs ») :
//
// - durée de vie effective : fixe (`duration_ms`) ou selon le rythme de
//   l'animation (`duration_days` jours d'animation, bornés par
//   `duration_min_ms` / `duration_max_ms` pour rester lisible) ;
// - densité : nombre d'étiquettes qui voudraient s'afficher en même temps au
//   moment le plus chargé, et corrections proposées quand il dépasse le
//   plafond (`max_visible`).
//
// Module pur (aucun DOM) : testé par node --test.

// En dessous, un pseudo n'a pas le temps d'être lu : plancher des
// corrections « raccourcir ».
export const NAME_READABLE_MS = 1000;
const STEP_MS = 100;
const MAX_VISIBLE_HIGH = 60;
const DAYS_HIGH = 120;
const MIN_MS_LOW = 500;

const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

// Durée de vie (ms vidéo) d'une étiquette au rythme `msPerDay` (durée d'un
// jour d'animation). Rythme inconnu : la durée fixe, dans les bornes.
export function effectiveNameDurationMs(names, msPerDay) {
    if (names?.duration_mode !== 'rhythm') return names.duration_ms;
    const lo = Math.min(names.duration_min_ms, names.duration_max_ms);
    const hi = Math.max(names.duration_min_ms, names.duration_max_ms);
    const perDay = positive(msPerDay);
    const raw = perDay ? names.duration_days * perDay : names.duration_ms;
    return Math.round(Math.min(hi, Math.max(lo, raw)));
}

// Étiquettes vivantes au même instant, au plus. `dayCounts` : [[jour, n]]
// triés (étiquettes nées ce jour-là). Une étiquette née au jour d vit
// `durationMs`, soit W = durationMs / msPerDay jours : à un instant donné
// vivent celles nées dans les ⌈W⌉ derniers jours (fenêtre glissante).
export function peakConcurrentNames(dayCounts, durationMs, msPerDay) {
    if (!Array.isArray(dayCounts) || dayCounts.length === 0) return 0;
    const perDay = positive(msPerDay) || 1000;
    const span = Math.max(1, Math.ceil(durationMs / perDay - 1e-9));
    let peak = 0;
    let sum = 0;
    let left = 0;
    for (let right = 0; right < dayCounts.length; right++) {
        sum += dayCounts[right][1];
        while (dayCounts[left][0] <= dayCounts[right][0] - span) sum -= dayCounts[left++][1];
        if (sum > peak) peak = sum;
    }
    return peak;
}

// Réglages qui ramènent la durée de vie effective à `targetMs` (ou juste
// en dessous) : la durée fixe, ou en mode rythme le nombre de jours — et le
// plancher quand il retiendrait la durée au-dessus.
export function nameDurationPatch(names, targetMs, msPerDay) {
    const target = Math.round(targetMs);
    if (names.duration_mode !== 'rhythm') return { duration_ms: target };
    const patch = {};
    const perDay = positive(msPerDay);
    if (perDay) patch.duration_days = Math.min(DAYS_HIGH, Math.max(1, Math.floor(target / perDay)));
    if (effectiveNameDurationMs({ ...names, ...patch }, msPerDay) > target) {
        patch.duration_min_ms = Math.max(MIN_MS_LOW, target);
        if (names.duration_max_ms < patch.duration_min_ms) patch.duration_max_ms = patch.duration_min_ms;
    }
    return patch;
}

// Bilan de densité au rythme `msPerDay` :
//   dayCounts         étiquettes par jour avec les réglages courants
//   notableDayCounts  idem en ne gardant que les logs marquants (facultatif)
// → { durationMs, concurrent, over, fixes } ; chaque correction porte
//   `kind` (notable | shorten | cap), le `patch` à appliquer au bloc, la
//   valeur proposée et la densité qu'elle donnerait (`concurrent`).
export function nameDensityReport(names, { dayCounts, notableDayCounts = null, msPerDay }) {
    const durationMs = effectiveNameDurationMs(names, msPerDay);
    const concurrent = peakConcurrentNames(dayCounts, durationMs, msPerDay);
    const cap = names.max_visible;
    const report = { durationMs, concurrent, over: concurrent > cap, fixes: [] };
    if (!report.over) return report;

    if (!names.only_notable && notableDayCounts) {
        const n = peakConcurrentNames(notableDayCounts, durationMs, msPerDay);
        if (n < concurrent) report.fixes.push({ kind: 'notable', patch: { only_notable: true }, concurrent: n });
    }

    // La plus longue durée (pas de 100 ms, pas sous le seuil de lecture) qui
    // tient dans le plafond ; à défaut, le seuil de lecture.
    let best = null;
    for (let d = Math.floor((durationMs - 1) / STEP_MS) * STEP_MS; d >= NAME_READABLE_MS; d -= STEP_MS) {
        best = { d, n: peakConcurrentNames(dayCounts, d, msPerDay) };
        if (best.n <= cap) break;
    }
    if (best && best.n < concurrent) {
        report.fixes.push({
            kind: 'shorten', patch: nameDurationPatch(names, best.d, msPerDay), durationMs: best.d, concurrent: best.n,
        });
    }

    if (cap < MAX_VISIBLE_HIGH) {
        const value = Math.min(MAX_VISIBLE_HIGH, Math.ceil(concurrent));
        report.fixes.push({ kind: 'cap', patch: { max_visible: value }, value, concurrent });
    }
    return report;
}
