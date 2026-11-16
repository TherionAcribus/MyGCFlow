// Page Parcours : modèle pur des étapes (MyGCFlow_Plan_Parcours.md).
//
// Les entrées viennent de /api/parcours/<id>/inputs (parcours_dataset.py) :
// un jour par date de la plage, chacun avec ses étapes (trouvailles, étapes
// Lab, DNF) et leurs indices — `logId` (ordre de SAISIE des logs) et
// `localTime` (heure réelle des Labs).
//
// Lot 0 : ordre PROVISOIRE, celui de la saisie des logs. La reconstruction
// (ancres, logs tardifs, géographie, horaire) arrive au lot 1 et remplacera
// `provisionalDayOrder` sans changer la forme de `orderParcours`.
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_model.test.mjs).

export const STOP_KINDS = Object.freeze(['find', 'lab', 'dnf']);

function isValidStop(stop) {
    return stop && typeof stop.key === 'string' && stop.key !== ''
        && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)
        && stop.lon >= -180 && stop.lon <= 180 && stop.lat >= -90 && stop.lat <= 90;
}

function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// Ordre provisoire d'une journée : les étapes à log (trouvailles, DNF) dans
// l'ordre de saisie, puis les étapes Lab à l'heure de leur validation, puis
// le reste ; la clé départage (ordre stable d'un chargement à l'autre).
export function provisionalDayOrder(stops) {
    const rank = (stop) => (Number.isFinite(stop.logId) ? 0 : stop.localTime ? 1 : 2);
    return [...(Array.isArray(stops) ? stops : [])].filter(isValidStop).sort((a, b) =>
        rank(a) - rank(b)
        || (rank(a) === 0 ? a.logId - b.logId : 0)
        || compareText(a.localTime || '', b.localTime || '')
        || compareText(a.key, b.key));
}

// Parcours ordonné : jours dans l'ordre des dates, étapes numérotées de 1 à n
// sur tout le parcours (`index`) et dans leur journée (`dayIndex`). Les
// étapes sans position valide sont écartées et comptées (`dropped`).
export function orderParcours(inputs) {
    const days = [];
    let index = 0;
    let dropped = 0;
    const rawDays = Array.isArray(inputs?.days) ? inputs.days : [];
    for (const rawDay of [...rawDays].sort((a, b) => compareText(String(a?.date), String(b?.date)))) {
        const rawStops = Array.isArray(rawDay?.stops) ? rawDay.stops : [];
        const ordered = provisionalDayOrder(rawStops);
        dropped += rawStops.length - ordered.length;
        days.push({
            date: rawDay.date,
            stops: ordered.map((stop, dayIndex) => ({ ...stop, index: ++index, dayIndex: dayIndex + 1 })),
        });
    }
    return { days, stopCount: index, dropped };
}

// Toutes les étapes, dans l'ordre du parcours.
export function parcoursStops(ordered) {
    return (ordered?.days || []).flatMap((day) => day.stops);
}

// Emprise [ouest, sud, est, nord] des étapes (null sans étape). Longitudes
// prises telles quelles : un parcours court ne franchit pas l'antiméridien
// assez souvent pour justifier le dépliage du trajet ici.
export function parcoursExtent(stops) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const stop of stops || []) {
        if (!isValidStop(stop)) continue;
        west = Math.min(west, stop.lon);
        east = Math.max(east, stop.lon);
        south = Math.min(south, stop.lat);
        north = Math.max(north, stop.lat);
    }
    return Number.isFinite(west) ? [west, south, east, north] : null;
}

// Nombre de jours de la plage [début, fin] (dates « AAAA-MM-JJ »), bornes
// comprises ; 0 si une date est invalide ou la plage inversée.
export function rangeDayCount(start, end) {
    const parse = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))
        : NaN);
    const a = parse(start);
    const b = parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return Math.round((b - a) / 86400000) + 1;
}
