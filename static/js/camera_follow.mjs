// Suivi de caméra : la vue glisse vers l'endroit où les caches apparaissent.
//
// Trois précautions qui font toute la différence entre « cinématographique » et
// « donne le mal de mer » :
//
// 1. Les déplacements locaux gardent le zoom courant. Les grands sauts prennent
//    temporairement de la hauteur pour réduire la durée et le coût en tuiles.
// 2. Chaque phase utilise une accélération/freinage doux et reproductible.
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

// Au-delà d'environ une largeur d'écran, un simple panoramique à zoom constant
// devient long et charge beaucoup de tuiles détaillées. La caméra prend alors
// temporairement de la hauteur, sans descendre sous une vue continentale.
export const LONG_TRAVEL_THRESHOLD_PX = 900;
export const CRUISE_DISTANCE_PX = 640;
export const MIN_CRUISE_ZOOM = 2;

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

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export function easeInOutCubic(progress) {
    const value = clamp01(progress);
    return value < 0.5
        ? 4 * value * value * value
        : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

// Prépare un trajet déterministe en trois temps : dézoom éventuel, translation,
// puis retour au zoom initial. La distance est mesurée dans le viewport courant,
// ce qui rend le seuil stable quelle que soit la projection ou la latitude.
export function createCameraJourney(current, target, startZoom, resolution, {
    longTravelThresholdPx = LONG_TRAVEL_THRESHOLD_PX,
    cruiseDistancePx = CRUISE_DISTANCE_PX,
    minCruiseZoom = MIN_CRUISE_ZOOM,
} = {}) {
    if (!current || !target) return null;
    const zoom = Number(startZoom);
    const unitsPerPixel = Number(resolution);
    if (!Number.isFinite(zoom) || !(unitsPerPixel > 0)) return null;

    const distanceMapUnits = Math.hypot(target[0] - current[0], target[1] - current[1]);
    const distancePx = distanceMapUnits / unitsPerPixel;
    if (!(distancePx > DEFAULT_DEAD_ZONE_PX)) return null;

    let cruiseZoom = zoom;
    if (distancePx > longTravelThresholdPx) {
        const zoomDelta = Math.max(0, Math.log2(distancePx / Math.max(1, cruiseDistancePx)));
        cruiseZoom = Math.max(Number(minCruiseZoom) || 0, zoom - zoomDelta);
        // Éviter un très léger changement d'échelle qui coûte un niveau de tuiles
        // sans apporter de gain visuel perceptible.
        if (zoom - cruiseZoom < 0.25) cruiseZoom = zoom;
    }

    const zoomDelta = Math.max(0, zoom - cruiseZoom);
    const zoomDurationMs = zoomDelta > 0 ? Math.min(1200, 600 + zoomDelta * 150) : 0;
    const cruiseDistance = distancePx / Math.pow(2, zoomDelta);
    const panDurationMs = Math.min(2800, 700 + cruiseDistance * 2.5);

    return {
        startCenter: [...current],
        targetCenter: [...target],
        startZoom: zoom,
        cruiseZoom,
        zoomOutDurationMs: zoomDurationMs,
        panDurationMs,
        zoomInDurationMs: zoomDurationMs,
        totalDurationMs: zoomDurationMs * 2 + panDurationMs,
        distancePx,
    };
}

export function sampleCameraJourney(journey, elapsedMs) {
    if (!journey) return null;
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const zoomOutEnd = journey.zoomOutDurationMs;
    const panEnd = zoomOutEnd + journey.panDurationMs;
    const total = Math.max(0, journey.totalDurationMs);

    if (elapsed < zoomOutEnd) {
        const progress = easeInOutCubic(elapsed / Math.max(1, journey.zoomOutDurationMs));
        return {
            center: [...journey.startCenter],
            zoom: journey.startZoom + (journey.cruiseZoom - journey.startZoom) * progress,
            done: false,
        };
    }
    if (elapsed < panEnd) {
        const progress = easeInOutCubic((elapsed - zoomOutEnd) / Math.max(1, journey.panDurationMs));
        return {
            center: [
                journey.startCenter[0] + (journey.targetCenter[0] - journey.startCenter[0]) * progress,
                journey.startCenter[1] + (journey.targetCenter[1] - journey.startCenter[1]) * progress,
            ],
            zoom: journey.cruiseZoom,
            done: false,
        };
    }
    if (elapsed < total) {
        const progress = easeInOutCubic((elapsed - panEnd) / Math.max(1, journey.zoomInDurationMs));
        return {
            center: [...journey.targetCenter],
            zoom: journey.cruiseZoom + (journey.startZoom - journey.cruiseZoom) * progress,
            done: false,
        };
    }
    return {
        center: [...journey.targetCenter],
        zoom: journey.startZoom,
        done: true,
    };
}
