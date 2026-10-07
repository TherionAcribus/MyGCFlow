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
export const DEFAULT_CAMERA_DYNAMISM = 2;
// Dézoom ajouté à chaque trajet au niveau 4 : la « respiration » systématique.
export const INTENSE_EXTRA_ZOOM_OUT = 1.25;

const CAMERA_COMFORT_RATIOS = Object.freeze({
    1: 1,
    2: 0.8,
    3: 0.55,
    4: 0,
});

export function normalizeCameraDynamism(value) {
    const level = Math.round(Number(value));
    return level >= 1 && level <= 4 ? level : DEFAULT_CAMERA_DYNAMISM;
}

// Une journée ne déclenche un mouvement que si au moins une de ses caches sort
// de la zone de confort choisie. Le niveau 4 assume volontairement un mouvement
// systématique, même si le barycentre est déjà centré.
export function shouldMoveCamera(viewCenter, resolution, viewportSize, targetExtent, dynamism, marginPx = 24) {
    const level = normalizeCameraDynamism(dynamism);
    if (level === 4) return true;
    if (!viewCenter || !Array.isArray(viewportSize) || viewportSize.length < 2) return true;
    if (!Array.isArray(targetExtent) || targetExtent.length !== 4) return true;
    const unitsPerPixel = Number(resolution);
    const width = Number(viewportSize[0]);
    const height = Number(viewportSize[1]);
    if (!(unitsPerPixel > 0) || !(width > 0) || !(height > 0)) return true;

    const ratio = CAMERA_COMFORT_RATIOS[level];
    // Le marqueur déborde du point projeté : une cache juste à l'intérieur du
    // bord de la zone apparaît déjà tronquée à l'écran. La marge réduit
    // d'autant la zone de confort, convertie en unités de carte.
    const margin = Math.max(0, Number(marginPx) || 0) * unitsPerPixel;
    const halfWidth = Math.max(0, width * unitsPerPixel * ratio / 2 - margin);
    const halfHeight = Math.max(0, height * unitsPerPixel * ratio / 2 - margin);
    return targetExtent[0] < viewCenter[0] - halfWidth
        || targetExtent[2] > viewCenter[0] + halfWidth
        || targetExtent[1] < viewCenter[1] - halfHeight
        || targetExtent[3] > viewCenter[1] + halfHeight;
}

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
    extraZoomOut = 0,
    // Facteur appliqué aux durées, sans toucher au tracé : < 1 quand les trajets
    // doivent tenir dans une durée de vidéo imposée, > 1 quand toute la timeline
    // est ralentie (capture rapide avec ralentissement).
    durationScale = 1,
} = {}) {
    if (!current || !target) return null;
    const zoom = Number(startZoom);
    const unitsPerPixel = Number(resolution);
    if (!Number.isFinite(zoom) || !(unitsPerPixel > 0)) return null;

    const distanceMapUnits = Math.hypot(target[0] - current[0], target[1] - current[1]);
    const distancePx = distanceMapUnits / unitsPerPixel;
    const addedZoom = Math.max(0, Number(extraZoomOut) || 0);
    if (!(distancePx > DEFAULT_DEAD_ZONE_PX) && addedZoom === 0) return null;

    let cruiseZoom = zoom;
    if (distancePx > longTravelThresholdPx) {
        const zoomDelta = Math.max(0, Math.log2(distancePx / Math.max(1, cruiseDistancePx)));
        cruiseZoom = Math.max(Number(minCruiseZoom) || 0, zoom - zoomDelta);
        // Éviter un très léger changement d'échelle qui coûte un niveau de tuiles
        // sans apporter de gain visuel perceptible.
        if (zoom - cruiseZoom < 0.25) cruiseZoom = zoom;
    }

    cruiseZoom = Math.max(Number(minCruiseZoom) || 0, cruiseZoom - addedZoom);
    const zoomDelta = Math.max(0, zoom - cruiseZoom);
    const scale = Number(durationScale);
    const timeScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
    const zoomDurationMs = (zoomDelta > 0 ? Math.min(1200, 600 + zoomDelta * 150) : 0) * timeScale;
    const cruiseDistance = distancePx / Math.pow(2, zoomDelta);
    const panDurationMs = (distancePx > DEFAULT_DEAD_ZONE_PX
        ? Math.min(2800, 700 + cruiseDistance * 2.5)
        : 0) * timeScale;

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

// ---------- Durée des trajets connue d'avance ----------
//
// Les trajets sont déterministes : ils ne dépendent que de la vue de départ et
// des caches de chaque jour. On peut donc les dérouler à blanc avant de lancer
// l'animation, connaître le temps qu'ils prendront, et le retrancher du temps
// d'affichage des dates quand la vidéo doit durer un temps précis (musique).

// En capture image par image, un trajet coûte ~1 image de plus que sa durée :
// celle qui attend le rendu final (rendercomplete) avant de reprendre les
// dates. L'image de départ redondante n'entre pas en compte, elle est supprimée
// côté capture. Source unique de ce surcoût « images de raccord », partagée
// entre la provision des trajets et le plan de timing annoncé à l'UI.
export const CAMERA_JOURNEY_EXTRA_FRAMES = 1;

// Rejoue la suite des décisions prises pendant l'animation, sans rien afficher.
// `days` : une entrée par jour animé, null sans cache ce jour-là, sinon
// { center, extent } en coordonnées de carte. Retourne la durée de trajet de
// chaque jour (0 si la caméra ne bouge pas), leur somme et leur nombre.
export function simulateCameraJourneys(days, {
    center,
    zoom,
    resolution,
    viewportSize,
    dynamism,
    extent = null,
} = {}) {
    const list = Array.isArray(days) ? days : [];
    const level = normalizeCameraDynamism(dynamism);
    const travelMsByDay = new Array(list.length).fill(0);
    let totalMs = 0;
    let journeyCount = 0;
    let current = Array.isArray(center) ? [...center] : null;
    for (let i = 0; i < list.length; i++) {
        const day = list[i];
        if (!day || !day.center) continue;
        if (!shouldMoveCamera(current, resolution, viewportSize, day.extent, level)) continue;
        const journey = createCameraJourney(
            current,
            clampToExtent(day.center, extent),
            zoom,
            resolution,
            { extraZoomOut: level === 4 ? INTENSE_EXTRA_ZOOM_OUT : 0 },
        );
        if (!journey) continue;
        travelMsByDay[i] = journey.totalDurationMs;
        totalMs += journey.totalDurationMs;
        journeyCount += 1;
        // Le zoom revient toujours à sa valeur de départ : seul le centre change.
        current = journey.targetCenter;
    }
    return { dayCount: list.length, travelMsByDay, totalMs, journeyCount };
}

// Prépare le suivi d'un budget de temps : `budgetMs` couvre l'affichage de
// toutes les dates ET tous les trajets. Les cumuls « à partir du jour i »
// évitent de reparcourir la liste à chaque date.
export function createCameraPacing({ budgetMs, travelMsByDay, travelScale = 1 } = {}) {
    const list = Array.isArray(travelMsByDay) ? travelMsByDay : [];
    const scale = Math.max(0, Number(travelScale) || 0);
    const travelFrom = new Float64Array(list.length + 1);
    const journeysFrom = new Uint32Array(list.length + 1);
    for (let i = list.length - 1; i >= 0; i--) {
        const travel = Math.max(0, Number(list[i]) || 0);
        travelFrom[i] = travelFrom[i + 1] + travel * scale;
        journeysFrom[i] = journeysFrom[i + 1] + (travel > 0 ? 1 : 0);
    }
    return {
        budgetMs: Math.max(0, Number(budgetMs) || 0),
        dayCount: list.length,
        travelFrom,
        journeysFrom,
    };
}

// Temps d'affichage à accorder à la date `dayIndex` pour que la fin de
// l'animation tombe sur le budget : ce qui reste, moins les trajets encore à
// venir, réparti entre les dates restantes. Recalculé à chaque date, il absorbe
// de lui-même ce que la simulation ne peut pas prévoir (attente des tuiles en
// fin de trajet, images de raccord en capture image par image) :
//  - spentMs : temps déjà écoulé depuis le début de l'animation ;
//  - travelSpentMs : part de ce temps passée dates en pause. L'écart avec les
//    trajets simulés donne le surcoût moyen d'un trajet, reporté sur ceux qui
//    restent — le rythme reste ainsi régulier au lieu d'accélérer vers la fin ;
//  - travelDone : le trajet du jour `dayIndex` est déjà effectué ;
//  - maxOverheadMs : plafond du surcoût provisionné par trajet à venir. Un
//    premier trajet « froid » (attente des tuiles jusqu'au timeout) ne doit
//    pas affamer toutes les dates restantes : le temps réellement dépensé
//    rentre déjà via spentMs, seule la provision est bornée.
export function pacedDayMs(pacing, {
    dayIndex = 0,
    spentMs = 0,
    travelSpentMs = 0,
    travelDone = false,
    minMs = 1,
    defaultOverheadMs = 0,
    maxOverheadMs = 1000,
} = {}) {
    const floor = Math.max(0, Number(minMs) || 0);
    if (!pacing || !(pacing.dayCount > 0)) return floor;
    const index = Math.max(0, Math.min(pacing.dayCount - 1, Math.round(Number(dayIndex) || 0)));
    const from = travelDone ? index + 1 : index;
    const doneJourneys = pacing.journeysFrom[0] - pacing.journeysFrom[from];
    const overheadMs = doneJourneys > 0
        ? Math.min(
            Math.max(0, Number(maxOverheadMs) || 0),
            Math.max(0, ((Number(travelSpentMs) || 0) - (pacing.travelFrom[0] - pacing.travelFrom[from])) / doneJourneys))
        : Math.max(0, Number(defaultOverheadMs) || 0);
    const remainingMs = pacing.budgetMs
        - Math.max(0, Number(spentMs) || 0)
        - pacing.travelFrom[from]
        - overheadMs * pacing.journeysFrom[from];
    return Math.max(floor, remainingMs / (pacing.dayCount - index));
}
