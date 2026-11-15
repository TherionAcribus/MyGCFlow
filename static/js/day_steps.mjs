// Pas de timeline : regroupement des jours sans trouvaille quand la durée
// imposée (« Par durée », « Sur la musique ») ne laisse pas une image par jour.
//
// Un jour qui a des trouvailles garde toujours son propre pas — au moins une
// image, sa durée n'est jamais rognée. Les jours vides, eux, peuvent partager
// un pas : les plus longues périodes sans trouvaille sont raccourcies d'abord
// (au plus `emptyRunCap` pas chacune), les courtes gardent leur rythme. Un pas
// est affiché en une fois, comme un lot de jours rattrapés par une frame.
//
// Le moteur raisonne ensuite en pas comme il raisonnait en jours : rythme
// constant par pas, trajets et pauses de la caméra indexés par pas. Les pas
// sont décrits par `stepEnds` : indice (dans la plage, 0 = premier jour) du
// dernier jour de chaque pas, strictement croissant, le dernier valant
// dayCount − 1.
//
// Aucune dépendance au DOM : logique pure, testée par tests/js/day_steps.test.mjs.

// Découpe la plage pour qu'elle tienne en `maxSteps` pas au plus.
// `hasEvents[i]` : le jour i a des trouvailles (il garde son pas).
// Retourne null quand aucun regroupement n'est nécessaire (maxSteps ≥ nombre de
// jours), sinon { stepEnds, stepCount, eventDays, emptyRunCap, fits } — `fits`
// faux quand même un pas par jour de trouvailles dépasse maxSteps : tous les
// jours vides sont alors fusionnés, c'est le plus court possible.
export function buildDaySteps(hasEvents, maxSteps) {
    const flags = Array.from(hasEvents || [], Boolean);
    const dayCount = flags.length;
    const limit = Math.floor(Number(maxSteps));
    if (dayCount === 0 || !(limit < dayCount)) return null;

    // Périodes de jours vides consécutifs : [début, longueur].
    const runs = [];
    let eventDays = 0;
    for (let i = 0; i < dayCount; i++) {
        if (flags[i]) { eventDays++; continue; }
        if (i > 0 && !flags[i - 1]) runs[runs.length - 1][1]++;
        else runs.push([i, 1]);
    }
    // Plus grand plafond L tel que jours de trouvailles + Σ min(longueur, L)
    // tienne dans la limite (la somme croît avec L : dichotomie).
    const stepsWith = (cap) => runs.reduce((sum, [, length]) => sum + Math.min(length, cap), eventDays);
    const longest = runs.reduce((max, [, length]) => Math.max(max, length), 0);
    let cap = 0;
    let lo = 0;
    let hi = longest;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (stepsWith(mid) <= limit) { cap = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const fits = stepsWith(cap) <= limit;
    // Sans aucun jour de trouvaille, au moins un pas pour toute la plage.
    if (eventDays === 0 && cap === 0) cap = 1;

    // Fin de pas de chaque jour : un jour de trouvaille clôt le sien ; une
    // période vide est répartie en min(longueur, L) pas de tailles voisines.
    // Avec L = 0, ses jours rejoignent le pas du jour de trouvaille suivant
    // (ou le dernier pas, en fin de plage).
    const isEnd = new Array(dayCount).fill(false);
    for (let i = 0; i < dayCount; i++) if (flags[i]) isEnd[i] = true;
    for (const [start, length] of runs) {
        const parts = Math.min(length, cap);
        for (let k = 1; k <= parts; k++) isEnd[start + Math.round(k * length / parts) - 1] = true;
    }
    if (!isEnd[dayCount - 1]) {
        // Période vide finale sans pas propre (L = 0) : elle prolonge le
        // dernier pas au lieu d'en ajouter un.
        const last = isEnd.lastIndexOf(true);
        if (last >= 0) isEnd[last] = false;
        isEnd[dayCount - 1] = true;
    }
    const stepEnds = [];
    for (let i = 0; i < dayCount; i++) if (isEnd[i]) stepEnds.push(i);
    return { stepEnds, stepCount: stepEnds.length, eventDays, emptyRunCap: cap, fits };
}

// Indice du pas qui contient le jour dayIndex (borné à la plage).
export function stepIndexOfDay(stepEnds, dayIndex) {
    const ends = stepEnds || [];
    if (ends.length === 0) return 0;
    const day = Math.max(0, Math.min(ends[ends.length - 1], Math.floor(Number(dayIndex) || 0)));
    let lo = 0;
    let hi = ends.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] >= day) hi = mid; else lo = mid + 1;
    }
    return lo;
}

// Nombre de pas entièrement affichés quand les `shownDays` premiers jours de
// la plage le sont (le pas en cours ne compte pas tant que son dernier jour
// n'est pas atteint).
export function stepsShownForDays(stepEnds, shownDays) {
    const ends = stepEnds || [];
    const shown = Math.max(0, Math.floor(Number(shownDays) || 0));
    if (shown === 0 || ends.length === 0) return 0;
    if (shown > ends[ends.length - 1]) return ends.length;
    const step = stepIndexOfDay(ends, shown - 1);
    return ends[step] === shown - 1 ? step + 1 : step;
}

// Valeurs par jour ramenées à une valeur par pas : `pick(values)` reçoit les
// valeurs des jours du pas, dans l'ordre. Par défaut, la dernière non nulle —
// un pas ne contient jamais plus d'un jour de trouvailles.
export function compactBySteps(perDay, stepEnds, pick = lastPresent) {
    const values = Array.isArray(perDay) ? perDay : [];
    const out = [];
    let first = 0;
    for (const end of stepEnds || []) {
        out.push(pick(values.slice(first, end + 1)));
        first = end + 1;
    }
    return out;
}

function lastPresent(values) {
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] !== null && values[i] !== undefined) return values[i];
    }
    return null;
}
