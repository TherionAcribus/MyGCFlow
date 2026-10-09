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

// Tracés de trajet disponibles : 'phases' (dézoom, translation, rezoom
// raccordés) et 'fly' (van Wijk & Nuij : zoom et translation simultanés le
// long d'une parabole continue). 'phases' reste le repli de toute valeur
// inconnue : c'est le chemin historique, éprouvé.
export const CAMERA_PATH_MODES = Object.freeze(['phases', 'fly']);

export function normalizeCameraPath(value) {
    return value === 'fly' ? 'fly' : 'phases';
}

// ρ du modèle de van Wijk & Nuij (2003), même valeur que d3.interpolateZoom et
// le flyTo de MapLibre : compromis entre un panoramique presque direct (grand
// ρ, peu de dézoom) et un arc ample (petit ρ, trajet plus long).
const FLY_RHO = Math.SQRT2;
const FLY_RHO2 = FLY_RHO * FLY_RHO;

// Millisecondes par unité de durée adimensionnelle S. Pour ~1 000 px
// (u1 ≈ 1,56 → S ≈ 1,74), un trajet dure ~2,8 s, dans la fourchette 2,5-3 s
// visée. d3 utilise S·1000 : trop nerveux pour un suivi qui doit rester
// cinématographique.
const CAMERA_FLY_MS_PER_UNIT = 1600;

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

// Zoom auquel l'étendue [minX, minY, maxX, maxY] (coordonnées carte) tient
// entièrement dans le viewport réduit de `paddingPx` de chaque côté. Sert à
// choisir le zoom d'arrivée d'un trajet : montrer toutes les caches du jour,
// pas seulement leur barycentre. `resolution` est la résolution courante
// (unités carte/px au zoom `currentZoom`) ; la résolution divisant par 2 à
// chaque niveau, le zoom cherché est currentZoom + log2(resolution / resFit)
// où resFit est la résolution qui ferrait l'étendue dans le cadre utile.
//
// Entrées invalides ou étendue ponctuelle (resFit nul, infini ou négatif) :
// retourner currentZoom — « pas assez renseigné » vaut « pas de changement »,
// jamais un saut de zoom arbitraire.
export function zoomForExtent(extent, viewportSize, resolution, currentZoom, paddingPx = 48) {
    const zoom = Number(currentZoom);
    if (!Number.isFinite(zoom)) return zoom;
    const res = Number(resolution);
    if (!Array.isArray(extent) || extent.length !== 4
        || !Array.isArray(viewportSize) || viewportSize.length < 2
        || !(res > 0)) return zoom;
    const pad = Math.max(0, Number(paddingPx) || 0);
    const width = Number(viewportSize[0]) - 2 * pad;
    const height = Number(viewportSize[1]) - 2 * pad;
    const extentW = Number(extent[2]) - Number(extent[0]);
    const extentH = Number(extent[3]) - Number(extent[1]);
    if (!(width > 0) || !(height > 0) || !(extentW >= 0) || !(extentH >= 0)) return zoom;
    const resFit = Math.max(extentW / width, extentH / height);
    if (!(resFit > 0) || !Number.isFinite(resFit)) return zoom;
    return zoom + Math.log2(res / resFit);
}

// Prépare un trajet déterministe. Deux tracés : 'phases' (dézoom éventuel,
// translation, puis retour au zoom initial) ou 'fly' (trajectoire continue de
// van Wijk & Nuij, cf. createFlyJourney). La distance est mesurée dans le
// viewport courant, ce qui rend les seuils stables quelle que soit la
// projection ou la latitude.
//
// `endZoom` : zoom d'arrivée différent du zoom de départ (par ex. celui qui
// cadre toutes les caches du jour, cf. zoomForExtent). Un trajet n'est créé
// que si l'écart dépasse ~1/20 de niveau : en dessous, le changement
// d'échelle est indiscernable mais coûte quand même un rechargement de tuiles.
// null/absent : retour au zoom de départ, comportement historique inchangé.
export function createCameraJourney(current, target, startZoom, resolution, {
    longTravelThresholdPx = LONG_TRAVEL_THRESHOLD_PX,
    cruiseDistancePx = CRUISE_DISTANCE_PX,
    minCruiseZoom = MIN_CRUISE_ZOOM,
    extraZoomOut = 0,
    path = 'phases',
    // Facteur appliqué aux durées, sans toucher au tracé : < 1 quand les trajets
    // doivent tenir dans une durée de vidéo imposée, > 1 quand toute la timeline
    // est ralentie (capture rapide avec ralentissement).
    durationScale = 1,
    endZoom = null,
} = {}) {
    if (!current || !target) return null;
    const zoom = Number(startZoom);
    const unitsPerPixel = Number(resolution);
    if (!Number.isFinite(zoom) || !(unitsPerPixel > 0)) return null;

    const distanceMapUnits = Math.hypot(target[0] - current[0], target[1] - current[1]);
    const distancePx = distanceMapUnits / unitsPerPixel;
    const addedZoom = Math.max(0, Number(extraZoomOut) || 0);
    // Zoom d'arrivée effectif : toute valeur absente, invalide ou trop proche
    // du zoom de départ retombe sur « retour au zoom initial ». Attention :
    // Number(null) vaut 0, pas NaN — le test sur la valeur fournie est donc
    // indispensable avant la conversion.
    const end = Number(endZoom);
    const endZoomEffective = endZoom != null && Number.isFinite(end) && Math.abs(end - zoom) > 0.05
        ? end : zoom;
    // Ni déplacement, ni changement d'échelle, ni respiration : rien à jouer.
    if (!(distancePx > DEFAULT_DEAD_ZONE_PX) && endZoomEffective === zoom && addedZoom === 0) return null;

    const scale = Number(durationScale);
    const timeScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;

    const zoomOnly = !(distancePx > DEFAULT_DEAD_ZONE_PX);
    // La parabole de van Wijk ne sait pas exprimer un zoom aller-retour à centre
    // fixe : la « respiration » du niveau 4 (extraZoomOut sans déplacement)
    // garde le trajet en phases. En revanche un zoom monotone vers endZoom,
    // même à centre quasi fixe, est le cas dégénéré u1 = 0 de van Wijk, géré
    // dans createFlyJourney.
    if (normalizeCameraPath(path) === 'fly' && !(zoomOnly && addedZoom > 0)
        && (!zoomOnly || endZoomEffective !== zoom)) {
        return createFlyJourney(current, target, zoom, endZoomEffective, distancePx,
            cruiseDistancePx, minCruiseZoom, addedZoom, timeScale);
    }

    let cruiseZoom = zoom;
    if (distancePx > longTravelThresholdPx) {
        const zoomDelta = Math.max(0, Math.log2(distancePx / Math.max(1, cruiseDistancePx)));
        cruiseZoom = Math.max(Number(minCruiseZoom) || 0, zoom - zoomDelta);
        // Éviter un très léger changement d'échelle qui coûte un niveau de tuiles
        // sans apporter de gain visuel perceptible.
        if (zoom - cruiseZoom < 0.25) cruiseZoom = zoom;
    }

    cruiseZoom = Math.max(Number(minCruiseZoom) || 0, cruiseZoom - addedZoom);
    const zoomOutDelta = Math.max(0, zoom - cruiseZoom);
    const zoomOutDurationMs = (zoomOutDelta > 0 ? Math.min(1200, 600 + zoomOutDelta * 150) : 0) * timeScale;
    const cruiseDistance = distancePx / Math.pow(2, zoomOutDelta);
    const panDurationMs = (distancePx > DEFAULT_DEAD_ZONE_PX
        ? Math.min(2800, 700 + cruiseDistance * 2.5)
        : 0) * timeScale;
    // Phase 3 : convergence vers le zoom d'arrivée — endZoom, qui peut être
    // plus bas (jour à grande étendue) ou plus haut (retour vers le zoom de
    // départ après un jour « large »). Même formule de durée que le dézoom.
    const zoomInDelta = Math.abs(endZoomEffective - cruiseZoom);
    const zoomInDurationMs = (zoomInDelta > 0 ? Math.min(1200, 600 + zoomInDelta * 150) : 0) * timeScale;

    return {
        path: 'phases',
        startCenter: [...current],
        targetCenter: [...target],
        startZoom: zoom,
        endZoom: endZoomEffective,
        cruiseZoom,
        zoomOutDurationMs,
        panDurationMs,
        zoomInDurationMs,
        totalDurationMs: zoomOutDurationMs + panDurationMs + zoomInDurationMs,
        distancePx,
    };
}

// Trajectoire de « Smooth and efficient zooming and panning » (van Wijk &
// Nuij, 2003) : le centre avance pendant que la largeur de vue suit une
// parabole en cosinus hyperbolique — un seul mouvement continu, sans les trois
// accélérations/freinages du tracé en phases.
//
// Cas général w0 ≠ w1 (formules du §6 du papier, identiques à d3) : w0 = 1 et
// w1 = 2^(startZoom − endZoom) — w croît quand le zoom baisse. Le cas
// symétrique historique est w1 = 1, qui redonne b1 = −b0, r1 = −r0 et
// S = 2|r0|/ρ. La distance u1 est ramenée à une échelle fixe
// (cruiseDistancePx, en px) plutôt qu'à la largeur réelle du viewport : la
// descente de zoom vaut alors ≈ log2(u1), proche de l'ancien zoomDelta, et ne
// dépend pas de la taille de la fenêtre.
function createFlyJourney(current, target, zoom, end, distancePx, cruiseDistancePx, minCruiseZoom, addedZoom, timeScale) {
    // extraZoomOut creuse la parabole : multiplier u1 par 2^extraZoomOut ajoute
    // ~extraZoomOut niveaux de descente, la courbe étant logarithmique.
    const u1 = distancePx / Math.max(1, Number(cruiseDistancePx) || CRUISE_DISTANCE_PX)
        * Math.pow(2, addedZoom);
    const floor = Number(minCruiseZoom);
    const w1 = Math.pow(2, zoom - end);

    // Zoom pur à centre (quasi) fixe : u1 ≈ 0 rend b0 et b1 infinis, mais la
    // limite est propre — la largeur suit w0·exp(ρ·s) et le centre avance
    // linéairement. S est signé : négatif quand le zoom monte (w1 < w0).
    if (!(distancePx > DEFAULT_DEAD_ZONE_PX) || !(u1 > 0)) {
        const S = Math.log(w1) / FLY_RHO;
        return {
            path: 'fly',
            startCenter: [...current],
            targetCenter: [...target],
            startZoom: zoom,
            endZoom: end,
            totalDurationMs: Math.min(4000, Math.max(300, Math.abs(S) * CAMERA_FLY_MS_PER_UNIT)) * timeScale,
            distancePx,
            flyU1: u1,
            flyR0: 0,
            flyR1: 0,
            flyW1: w1,
            flyIsZoomOnly: true,
            flyS: S,
            flyMinZoom: Number.isFinite(floor) ? floor : null,
        };
    }

    const rho4u1sq = FLY_RHO2 * FLY_RHO2 * u1 * u1;
    const b0 = (w1 * w1 - 1 + rho4u1sq) / (2 * FLY_RHO2 * u1);
    const b1 = (w1 * w1 - 1 - rho4u1sq) / (2 * w1 * FLY_RHO2 * u1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    // r1 − r0 nul n'arrive qu'en u1 = 0 (exclu) ; le repli de d3 sur
    // ln(w1/w0)/ρ évite par prudence un trajet de longueur nulle.
    const dr = r1 - r0;
    const S = (dr || Math.log(w1)) / FLY_RHO;
    return {
        path: 'fly',
        startCenter: [...current],
        targetCenter: [...target],
        startZoom: zoom,
        endZoom: end,
        // S croît en log(distance) : le plafond ne sert qu'aux trajets
        // transcontinentaux, le plancher évite les trajets « déjà finis ».
        totalDurationMs: Math.min(4000, Math.max(300, Math.abs(S) * CAMERA_FLY_MS_PER_UNIT)) * timeScale,
        distancePx,
        flyU1: u1,
        flyR0: r0,
        flyR1: r1,
        flyW1: w1,
        flyIsZoomOnly: false,
        flyS: S,
        flyMinZoom: Number.isFinite(floor) ? floor : null,
    };
}

// Échantillonne un trajet 'fly' à l'instant elapsed (ms depuis le départ).
// Le temps est linéaire : la courbe w(s) = w0·cosh(r0)/cosh(ρs + r0) produit
// déjà un départ et une arrivée en douceur, aucune easing supplémentaire.
function sampleFlyJourney(journey, elapsed) {
    const total = Math.max(0, journey.totalDurationMs);
    if (elapsed >= total) {
        return { center: [...journey.targetCenter], zoom: journey.endZoom, done: true };
    }
    const s = journey.flyS * (total > 0 ? elapsed / total : 1);
    let w;
    let fraction;
    if (journey.flyIsZoomOnly) {
        // Cas dégénéré u1 = 0 : la largeur évolue en exponentielle pure et le
        // centre avance linéairement. S et s partagent le même signe : la
        // fraction monte monotone de 0 à 1 dans les deux sens de zoom.
        w = Math.exp(FLY_RHO * s);
        fraction = journey.flyS !== 0 ? s / journey.flyS : 1;
    } else {
        const r0 = journey.flyR0;
        const coshR0 = Math.cosh(r0);
        w = coshR0 / Math.cosh(FLY_RHO * s + r0);
        // u(s) projeté en fraction du segment départ→cible. La construction de
        // b0/b1 garantit u(S) = u1 : la fraction vaut 0 en s = 0 et 1 en s = S.
        fraction = (coshR0 * Math.tanh(FLY_RHO * s + r0) - Math.sinh(r0))
            / (FLY_RHO2 * journey.flyU1);
    }
    let zoom = journey.startZoom - Math.log2(w);
    // Plancher imposé par la contrainte multiWorld d'OpenLayers : sans lui OL
    // relèverait le zoom et contraindrait le centre en plein vol. Le plateau
    // qui en résulte est assumé — la contrainte l'aurait imposé de toute façon.
    if (journey.flyMinZoom != null) zoom = Math.max(journey.flyMinZoom, zoom);
    return {
        center: [
            journey.startCenter[0] + (journey.targetCenter[0] - journey.startCenter[0]) * fraction,
            journey.startCenter[1] + (journey.targetCenter[1] - journey.startCenter[1]) * fraction,
        ],
        zoom,
        done: false,
    };
}

export function sampleCameraJourney(journey, elapsedMs) {
    if (!journey) return null;
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    if (journey.path === 'fly') return sampleFlyJourney(journey, elapsed);
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
            zoom: journey.cruiseZoom + (journey.endZoom - journey.cruiseZoom) * progress,
            done: false,
        };
    }
    return {
        center: [...journey.targetCenter],
        zoom: journey.endZoom,
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
// `path` et `minCruiseZoom` sont forwardés tels quels à createCameraJourney :
// la simulation doit prendre exactement les mêmes décisions que la lecture
// réelle, qui lit ces options depuis les préférences.
//
// `fitDay` : chaque trajet vise le zoom qui cadre l'étendue du jour, borné par
// le zoom de lancement (homeZoom) — la caméra ne se rapproche jamais plus que
// la vue choisie, et s'éloigne si l'étendue dépasse le viewport. Le zoom alors
// atteint se propage aux jours suivants : leurs distances en pixels et leurs
// décisions (shouldMoveCamera, zooms de croisière) dépendent du zoom courant.
export function simulateCameraJourneys(days, {
    center,
    zoom,
    resolution,
    viewportSize,
    dynamism,
    extent = null,
    path,
    minCruiseZoom,
    fitDay = false,
    paddingPx = 48,
} = {}) {
    const list = Array.isArray(days) ? days : [];
    const level = normalizeCameraDynamism(dynamism);
    const travelMsByDay = new Array(list.length).fill(0);
    // Les trajets eux-mêmes, pas seulement leurs durées : le mode « piste » les
    // rejoue tels quels à la lecture (buildCameraTrack) — aucune recréation,
    // donc aucune dérive entre la simulation et l'exécution.
    const journeysByDay = new Array(list.length).fill(null);
    let totalMs = 0;
    let journeyCount = 0;
    let current = Array.isArray(center) ? [...center] : null;
    // Zoom de référence de toute l'animation : la vue au lancement.
    const homeZoom = Number(zoom);
    let currentZoom = homeZoom;
    const baseResolution = Number(resolution);
    const floor = Number(minCruiseZoom);
    for (let i = 0; i < list.length; i++) {
        const day = list[i];
        if (!day || !day.center) continue;
        // Résolution au zoom simulé courant : elle convertit les distances en
        // pixels pour shouldMoveCamera comme pour createCameraJourney.
        const currentResolution = baseResolution * Math.pow(2, homeZoom - currentZoom);
        if (!shouldMoveCamera(current, currentResolution, viewportSize, day.extent, level)) continue;
        const options = {
            extraZoomOut: level === 4 ? INTENSE_EXTRA_ZOOM_OUT : 0,
            path,
            minCruiseZoom,
        };
        if (fitDay) {
            // Jamais plus près que la vue de lancement ; le plancher de zoom
            // de la lecture réelle borne aussi l'éloignement.
            const fit = zoomForExtent(day.extent, viewportSize, currentResolution, currentZoom, paddingPx);
            options.endZoom = Number.isFinite(floor)
                ? Math.max(floor, Math.min(homeZoom, fit))
                : Math.min(homeZoom, fit);
        }
        // fitDay cadre l'étendue du jour : le zoom calculé par zoomForExtent
        // suppose la vue centrée sur cette étendue — viser le barycentre
        // laisserait une cache isolée hors cadre (jour « grappe + isolée »).
        const aim = fitDay && Array.isArray(day.extent) && day.extent.length === 4
            ? [(day.extent[0] + day.extent[2]) / 2, (day.extent[1] + day.extent[3]) / 2]
            : day.center;
        const journey = createCameraJourney(
            current,
            clampToExtent(aim, extent),
            currentZoom,
            currentResolution,
            options,
        );
        if (!journey) continue;
        travelMsByDay[i] = journey.totalDurationMs;
        journeysByDay[i] = journey;
        totalMs += journey.totalDurationMs;
        journeyCount += 1;
        // Seul le centre changeait auparavant ; avec fitDay, le zoom d'arrivée
        // devient le zoom de départ du jour suivant (sans fitDay, endZoom vaut
        // toujours le zoom de départ : la propagation reste un no-op).
        current = journey.targetCenter;
        currentZoom = journey.endZoom;
    }
    // leadMs : durée vidéo du « pré-roll » — le trajet du jour 0 tel quel
    // (hors timeScale), que le mode piste joue en tête de timeline avant la
    // première date. 0 quand le jour 0 n'a pas de trajet : pas de marge à
    // prévoir, le comportement historique est conservé.
    const leadMs = journeysByDay[0] ? journeysByDay[0].totalDurationMs : 0;
    return { dayCount: list.length, travelMsByDay, journeysByDay, totalMs, journeyCount, leadMs };
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

// ---------- Piste de caméra précalculée (mode par défaut) ----------
//
// Au lieu de déclencher chaque trajet quand son jour s'affiche (mode réactif,
// dates en pause pendant le déplacement), tous les trajets simulés sont
// planifiés sur la timeline : le trajet du jour i se termine pile quand le
// jour s'affiche et s'exécute pendant l'affichage des jours précédents.
// L'anticipation est possible parce que le trajet i part de la cible du trajet
// précédent (la simulation chaîne déjà les positions via
// current = journey.targetCenter) : démarrer plus tôt ne produit aucun saut.
//
// Conséquences : les dates ne sont jamais en pause, tout le budget d'animation
// leur revient, et l'avancement est entièrement connu à l'avance — la durée
// annoncée est exacte, quels que soient les trajets.

// Retard toléré avant de compter un trajet comme « arrivé après l'affichage de
// son jour » : sous ~une image d'écart, le décalage est invisible à l'écran.
export const TRACK_LATE_EPSILON_MS = 50;

// Planifie les trajets simulés sur la timeline. `journeysByDay` : une entrée
// par jour animé (journey ou null), telle que simulateCameraJourneys la
// retourne. `dayMs` : durée d'affichage d'un jour sur la timeline réelle
// (étirement compris). `timeScale` : facteur appliqué aux durées des trajets
// (ralentissement de la capture rapide) — le tracé est inchangé, seule la
// vitesse de lecture l'est.
//
// `leadMs` : marge d'anticipation du premier trajet (le « pré-roll »). Sans
// elle, le trajet du jour 0 a une fenêtre nulle — rien ne pouvant commencer
// avant t=0, il est compressé ou instantané. Avec leadMs, toutes les arrivées
// sont décalées d'autant (endMs = leadMs + i × dayMs) sans changer la
// structure : le trajet 0 joue de t=0 à t=leadMs, avant la première date. Avec
// leadMs = durée naturelle du trajet 0 (étirement compris), il joue donc à
// vitesse réelle. leadMs = 0 : comportement historique strictement inchangé.
//
// Retourne { events: [{ dayIndex, journey, startMs, endMs, durationMs, rate }],
// timeScale, totalMs, leadMs, lateCount, worstLateMs } : pour chaque jour doté
// d'un trajet, endMs = leadMs + i × dayMs (le trajet finit pile quand son jour
// s'affiche) et startMs = max(endMs − durée × timeScale, fin réelle du trajet
// précédent). Jamais de recouvrement : si la durée dépasse la fenêtre libre,
// le trajet démarre où le précédent finit et arrive en retard sur son jour —
// accepté (la date n'est pas retardée).
//
// lateCount et worstLateMs forment le diagnostic de congestion : nombre de
// trajets arrivés plus de TRACK_LATE_EPSILON_MS après l'affichage de leur
// jour (le retard s'accumule — chaque trajet en retard retarde le départ du
// suivant) et le plus grand retard observé, celui du dernier trajet concerné.
// Tous deux nuls quand chaque trajet tient dans sa fenêtre.
//
// En revanche aucun trajet ne peut dépasser la fin de la timeline (totalMs =
// leadMs + dayCount × dayMs) : en capture le nombre d'images est figé d'avance,
// en lecture l'animation s'arrête — un trajet tronqué figerait la caméra en
// plein vol. Le trajet concerné est donc accéléré : durationMs < durée
// naturelle et rate = durée naturelle / durationMs accélère l'échantillonnage.
// Fenêtre nulle (startMs ≥ totalMs) : durationMs 0, la caméra saute
// directement à la cible.
export function buildCameraTrack(journeysByDay, { dayMs, timeScale = 1, leadMs = 0 } = {}) {
    const list = Array.isArray(journeysByDay) ? journeysByDay : [];
    const step = Math.max(0, Number(dayMs) || 0);
    const scale = Number.isFinite(Number(timeScale)) && Number(timeScale) >= 0
        ? Number(timeScale) : 1;
    const lead = Math.max(0, Number(leadMs) || 0);
    const totalMs = lead + list.length * step;
    const events = [];
    let previousFinishMs = 0;
    let lateCount = 0;
    let worstLateMs = 0;
    for (let i = 0; i < list.length; i++) {
        const journey = list[i];
        if (!journey) continue;
        const journeyMs = Math.max(0, Number(journey.totalDurationMs) || 0);
        const naturalMs = journeyMs * scale;
        const endMs = lead + i * step;
        const startMs = Math.max(endMs - naturalMs, previousFinishMs);
        const durationMs = Math.max(0, Math.min(naturalMs, totalMs - startMs));
        // rate convertit le temps timeline en temps trajet pour
        // sampleCameraJourney : timeScale quand le trajet tient dans sa
        // fenêtre, davantage quand il est accéléré pour finir avec l'animation.
        events.push({
            dayIndex: i,
            journey,
            startMs,
            endMs,
            durationMs,
            rate: durationMs > 0 ? journeyMs / durationMs : 1,
        });
        previousFinishMs = startMs + durationMs;
        // Diagnostic de congestion : fin réelle après l'instant où le jour
        // s'affiche — le trajet arrive en retard et retarde d'autant le
        // départ du suivant (d'où un retard qui croît le long de la piste).
        const lateMs = previousFinishMs - endMs;
        if (lateMs > TRACK_LATE_EPSILON_MS) lateCount += 1;
        if (lateMs > worstLateMs) worstLateMs = lateMs;
    }
    return { events, timeScale: scale, totalMs, leadMs: lead, lateCount, worstLateMs };
}

// Pose de la caméra à l'instant `nowMs` de la timeline de la piste :
//  - trajet actif (startMs ≤ nowMs < startMs + durationMs) → position
//    échantillonnée sur le trajet, moving: true (rate > 1 quand le trajet a
//    été accéléré pour rester dans la timeline) ;
//  - entre deux trajets ou après le dernier → dernière cible atteinte,
//    moving: false ;
//  - avant le premier trajet ou piste vide → null (la vue courante est
//    conservée telle quelle).
// Les appels arrivent par frames successives ; la recherche dichotomique sur
// startMs reste exacte quel que soit le pas de temps (saut d'onglet masqué,
// capture image par image).
export function cameraTrackStateAt(track, nowMs) {
    const events = track?.events;
    if (!Array.isArray(events) || events.length === 0) return null;
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return null;
    // Dernier événement dont le départ est déjà passé : les startMs sont
    // croissants par construction (jamais de recouvrement).
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].startMs <= now) lo = mid + 1; else hi = mid;
    }
    const index = lo - 1;
    if (index < 0) return null;
    const event = events[index];
    const durationMs = Math.max(0, Number(event.durationMs) || 0);
    if (now < event.startMs + durationMs) {
        const state = sampleCameraJourney(
            event.journey,
            (now - event.startMs) * (event.rate > 0 ? event.rate : 1),
        );
        if (state) return { center: state.center, zoom: state.zoom, moving: true };
    }
    return {
        center: [...event.journey.targetCenter],
        zoom: event.journey.endZoom,
        moving: false,
    };
}
