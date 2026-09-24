// Suivi de caméra : la vue glisse vers l'endroit où les caches apparaissent.
//
// Trois précautions qui font toute la différence entre « cinématographique » et
// « donne le mal de mer » :
//
// 1. Translation seulement, jamais de zoom. Changer d'échelle en cours
//    d'animation change le niveau de tuiles, la taille apparente des points et
//    la lisibilité : c'est le mouvement le plus coûteux et le plus agressif.
// 2. Un lissage exponentiel avec une longue constante de temps : la caméra
//    n'atteint jamais sa cible d'un coup, elle dérive vers elle.
// 3. Une zone morte : sous quelques pixels d'écart, on ne bouge pas du tout,
//    sinon la vue tremblerait en permanence autour du barycentre.
//
// L'avancement est dicté par l'appelant (dtMs), pris sur l'horloge des points :
// temps réel en lecture, temps vidéo en capture image par image. Un
// enregistrement reste donc reproductible à l'identique.
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

// Constante de temps du suivi, en ms d'animation. ~63 % du chemin parcouru en
// 2,5 s : assez lent pour être doux, assez rapide pour suivre une activité qui
// se déplace d'une région à l'autre.
export const DEFAULT_RESPONSE_MS = 2500;

// En deçà, on considère la caméra arrivée : évite le frémissement permanent et
// les rendus inutiles.
export const DEFAULT_DEAD_ZONE_PX = 2;

// Part du chemin à parcourir pendant dtMs. Exponentielle : indépendante de la
// cadence, donc un enregistrement à 12 ou 60 images/s donne le même mouvement.
export function smoothingFactor(dtMs, responseMs = DEFAULT_RESPONSE_MS) {
    const dt = Math.max(0, Number(dtMs) || 0);
    const response = Math.max(1, Number(responseMs) || DEFAULT_RESPONSE_MS);
    return 1 - Math.exp(-dt / response);
}

// Barycentre d'un lot de coordonnées projetées ([x, y]). null si le lot est vide.
export function centroid(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
    let x = 0;
    let y = 0;
    let count = 0;
    for (const point of coordinates) {
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
        x += point[0];
        y += point[1];
        count += 1;
    }
    return count > 0 ? [x / count, y / count] : null;
}

// Ramène un centre dans l'étendue des données : la caméra ne part jamais
// regarder une zone vide parce qu'un point isolé a tiré le barycentre.
export function clampToExtent(center, extent) {
    if (!center) return center;
    if (!Array.isArray(extent) || extent.length !== 4) return center;
    const [minX, minY, maxX, maxY] = extent;
    if (!(minX <= maxX) || !(minY <= maxY)) return center;
    return [
        Math.min(maxX, Math.max(minX, center[0])),
        Math.min(maxY, Math.max(minY, center[1])),
    ];
}

// Nouveau centre de vue après dtMs. `resolution` (unités de carte par pixel)
// convertit la zone morte en distance réelle.
export function stepCenter(current, target, dtMs, {
    responseMs = DEFAULT_RESPONSE_MS,
    resolution = 1,
    deadZonePx = DEFAULT_DEAD_ZONE_PX,
    extent = null,
} = {}) {
    if (!current || !target) return { center: current, moved: false };

    const goal = clampToExtent(target, extent);
    const dx = goal[0] - current[0];
    const dy = goal[1] - current[1];
    const deadZone = Math.max(0, deadZonePx) * Math.max(0, Number(resolution) || 0);
    if (Math.hypot(dx, dy) <= deadZone) return { center: current, moved: false };

    const factor = smoothingFactor(dtMs, responseMs);
    if (factor <= 0) return { center: current, moved: false };
    return {
        center: [current[0] + dx * factor, current[1] + dy * factor],
        moved: true,
    };
}
