// Page Parcours : modèle pur des étapes (MyGCFlow_Plan_Parcours.md).
//
// Les entrées viennent de /api/parcours/<id>/inputs (parcours_dataset.py) :
// un jour par date de la plage, chacun avec ses étapes (trouvailles, étapes
// Lab, DNF) et leurs indices — `logId` (ordre de SAISIE des logs) et
// `localTime` (heure réelle des Labs).
//
// L'ordre de passage et les heures viennent de parcours_reconstruct.mjs ;
// ce module garde les utilitaires communs à la page et à la carte.
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_model.test.mjs).

function isValidStop(stop) {
    return stop && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)
        && stop.lon >= -180 && stop.lon <= 180 && stop.lat >= -90 && stop.lat <= 90;
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
