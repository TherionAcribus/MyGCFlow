import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CAMERA_PATH_MODES,
    centroid,
    clampToExtent,
    createCameraJourney,
    createCameraPacing,
    DEFAULT_RESPONSE_MS,
    easeInOutCubic,
    normalizeCameraDynamism,
    normalizeCameraPath,
    pacedDayMs,
    sampleCameraJourney,
    shouldMoveCamera,
    simulateCameraJourneys,
    smoothingFactor,
    stepCenter,
} from './static/js/camera_follow.mjs';

test('le lissage ne dépend pas de la cadence', () => {
    // Même durée totale, découpée en 1 pas ou en 10 : même chemin parcouru.
    const gros = smoothingFactor(1000, DEFAULT_RESPONSE_MS);
    let restant = 1;
    for (let i = 0; i < 10; i++) restant *= 1 - smoothingFactor(100, DEFAULT_RESPONSE_MS);
    assert.ok(Math.abs((1 - restant) - gros) < 1e-9);
});

test('la caméra dérive vers sa cible sans jamais la dépasser', () => {
    let center = [0, 0];
    const target = [1000, 0];
    for (let i = 0; i < 200; i++) {
        const step = stepCenter(center, target, 100, { resolution: 1, deadZonePx: 0 });
        assert.ok(step.center[0] >= center[0], 'la caméra ne recule pas');
        assert.ok(step.center[0] <= target[0], 'la caméra ne dépasse pas sa cible');
        center = step.center;
    }
    assert.ok(Math.abs(center[0] - 1000) < 1, 'la caméra finit par arriver');
});

test('la zone morte évite le frémissement permanent', () => {
    // 1,5 pixel d'écart avec une résolution de 10 unités par pixel.
    const step = stepCenter([0, 0], [15, 0], 100, { resolution: 10, deadZonePx: 2 });
    assert.equal(step.moved, false);
    assert.deepEqual(step.center, [0, 0]);

    const loin = stepCenter([0, 0], [100, 0], 100, { resolution: 10, deadZonePx: 2 });
    assert.equal(loin.moved, true);
});

test('un pas de durée nulle ne bouge pas la caméra', () => {
    const step = stepCenter([0, 0], [1000, 0], 0, { resolution: 1, deadZonePx: 0 });
    assert.equal(step.moved, false);
});

test('sans cible ou sans position, la caméra ne bouge pas', () => {
    assert.equal(stepCenter(null, [1, 1], 100).moved, false);
    assert.equal(stepCenter([0, 0], null, 100).moved, false);
});

test('la cible est ramenée dans l\'étendue des données', () => {
    const extent = [0, 0, 100, 100];
    assert.deepEqual(clampToExtent([500, 50], extent), [100, 50]);
    assert.deepEqual(clampToExtent([-20, 120], extent), [0, 100]);
    assert.deepEqual(clampToExtent([50, 50], extent), [50, 50]);
    // Étendue absente ou absurde : on ne touche à rien.
    assert.deepEqual(clampToExtent([500, 50], null), [500, 50]);
    assert.deepEqual(clampToExtent([500, 50], [10, 10, 0, 0]), [500, 50]);

    // Un point isolé hors zone ne peut donc pas emmener la caméra dans le vide.
    const step = stepCenter([0, 0], [10_000, 0], 5000, { resolution: 1, deadZonePx: 0, extent });
    assert.ok(step.center[0] <= 100);
});

test('le barycentre ignore les coordonnées invalides', () => {
    assert.deepEqual(centroid([[0, 0], [10, 20]]), [5, 10]);
    assert.deepEqual(centroid([[0, 0], [NaN, 5], null, [10, 10]]), [5, 5]);
    assert.equal(centroid([]), null);
    assert.equal(centroid(null), null);
    assert.equal(centroid([[NaN, NaN]]), null);
});

test('un saut intercontinental dézoome temporairement puis restaure le zoom', () => {
    const journey = createCameraJourney([0, 0], [5000, 0], 8, 1);
    assert.ok(journey.cruiseZoom < journey.startZoom);
    assert.ok(journey.cruiseZoom >= 2);

    const start = sampleCameraJourney(journey, 0);
    const cruise = sampleCameraJourney(journey, journey.zoomOutDurationMs);
    const arrival = sampleCameraJourney(journey, journey.totalDurationMs);
    assert.deepEqual(start.center, [0, 0]);
    assert.equal(cruise.zoom, journey.cruiseZoom);
    assert.deepEqual(arrival.center, [5000, 0]);
    assert.equal(arrival.zoom, 8);
    assert.equal(arrival.done, true);
});

test('un déplacement local conserve le niveau de zoom', () => {
    const journey = createCameraJourney([0, 0], [500, 0], 8, 1);
    assert.equal(journey.cruiseZoom, 8);
    assert.equal(journey.zoomOutDurationMs, 0);
    assert.equal(journey.zoomInDurationMs, 0);
});

test('le trajet est continu et borné', () => {
    const journey = createCameraJourney([10, 20], [5010, 1020], 9, 1);
    for (let elapsed = 0; elapsed <= journey.totalDurationMs; elapsed += 50) {
        const state = sampleCameraJourney(journey, elapsed);
        assert.ok(state.center[0] >= 10 && state.center[0] <= 5010);
        assert.ok(state.center[1] >= 20 && state.center[1] <= 1020);
        assert.ok(state.zoom >= journey.cruiseZoom && state.zoom <= 9);
    }
    assert.equal(easeInOutCubic(-1), 0);
    assert.equal(easeInOutCubic(2), 1);
});

test('les niveaux de dynamisme utilisent des zones de confort croissantes', () => {
    const center = [0, 0];
    const size = [1000, 800];
    const resolution = 1;
    const central = [-100, -100, 100, 100];
    const peripheral = [330, -20, 350, 20];
    const edge = [440, -20, 460, 20];
    const outside = [520, -20, 540, 20];

    assert.equal(shouldMoveCamera(center, resolution, size, central, 1), false);
    assert.equal(shouldMoveCamera(center, resolution, size, peripheral, 1), false);
    assert.equal(shouldMoveCamera(center, resolution, size, edge, 1), false);
    assert.equal(shouldMoveCamera(center, resolution, size, outside, 1), true);

    assert.equal(shouldMoveCamera(center, resolution, size, peripheral, 2), false);
    assert.equal(shouldMoveCamera(center, resolution, size, edge, 2), true);
    assert.equal(shouldMoveCamera(center, resolution, size, peripheral, 3), true);
    assert.equal(shouldMoveCamera(center, resolution, size, central, 3), false);
    assert.equal(shouldMoveCamera(center, resolution, size, central, 4), true);
});

test('la marge de la zone de confort déclenche près du bord', () => {
    // Niveau 1, viewport de 1000 px, résolution 1 : demi-zone de 500 px.
    // Une cache à 490 px du centre tient dans la zone nue, mais son marqueur
    // déborde : la marge par défaut (24 px) déclenche le mouvement.
    const extent = [480, -10, 490, 10];
    assert.equal(shouldMoveCamera([0, 0], 1, [1000, 800], extent, 1), true);
    assert.equal(shouldMoveCamera([0, 0], 1, [1000, 800], extent, 1, 0), false);
});

test('le niveau agressif peut produire une respiration de zoom sans translation', () => {
    const journey = createCameraJourney([0, 0], [0, 0], 8, 1, { extraZoomOut: 1.25 });
    assert.ok(journey);
    assert.equal(journey.panDurationMs, 0);
    assert.equal(journey.cruiseZoom, 6.75);
    assert.equal(sampleCameraJourney(journey, journey.totalDurationMs).zoom, 8);
});

test('un niveau de dynamisme invalide retombe sur le niveau discret', () => {
    assert.equal(normalizeCameraDynamism(1), 1);
    assert.equal(normalizeCameraDynamism(4), 4);
    assert.equal(normalizeCameraDynamism(99), 2);
    assert.equal(normalizeCameraDynamism('x'), 2);
});

// ---------- Durée des trajets connue d'avance ----------

test('durationScale change la durée d\'un trajet, pas son tracé', () => {
    const normal = createCameraJourney([0, 0], [5000, 0], 8, 1);
    const rapide = createCameraJourney([0, 0], [5000, 0], 8, 1, { durationScale: 0.5 });
    assert.equal(rapide.totalDurationMs, normal.totalDurationMs / 2);
    assert.equal(rapide.cruiseZoom, normal.cruiseZoom);
    assert.deepEqual(
        sampleCameraJourney(rapide, rapide.totalDurationMs / 2).center,
        sampleCameraJourney(normal, normal.totalDurationMs / 2).center,
    );
    // Durée nulle : la caméra est immédiatement arrivée.
    const instantane = createCameraJourney([0, 0], [5000, 0], 8, 1, { durationScale: 0 });
    assert.equal(instantane.totalDurationMs, 0);
    assert.deepEqual(sampleCameraJourney(instantane, 0), { center: [5000, 0], zoom: 8, done: true });
});

const vue = { center: [0, 0], zoom: 8, resolution: 1, viewportSize: [1000, 800] };
const jour = (x, y) => ({ center: [x, y], extent: [x - 10, y - 10, x + 10, y + 10] });

test('la simulation rejoue les décisions de l\'animation', () => {
    const days = [
        null,               // aucun cache : pas de trajet
        jour(100, 0),       // dans la zone de confort : la vue reste
        jour(3000, 0),      // hors champ : trajet
        jour(3050, 20),     // tout près de la nouvelle vue : la vue reste
        jour(0, 0),         // retour : trajet
    ];
    const sim = simulateCameraJourneys(days, { ...vue, dynamism: 2 });
    assert.equal(sim.dayCount, 5);
    assert.equal(sim.journeyCount, 2);
    assert.deepEqual(sim.travelMsByDay.map((ms) => ms > 0), [false, false, true, false, true]);
    // Chaque durée est celle du trajet réellement créé depuis la vue d'alors.
    assert.equal(sim.travelMsByDay[2], createCameraJourney([0, 0], [3000, 0], 8, 1).totalDurationMs);
    assert.equal(sim.travelMsByDay[4], createCameraJourney([3000, 0], [0, 0], 8, 1).totalDurationMs);
    assert.equal(sim.totalMs, sim.travelMsByDay[2] + sim.travelMsByDay[4]);
});

test('la simulation respecte le dynamisme et l\'étendue des données', () => {
    const days = [jour(100, 0), jour(120, 0)];
    assert.equal(simulateCameraJourneys(days, { ...vue, dynamism: 1 }).journeyCount, 0);
    // Niveau 4 : recentrage et respiration de zoom à chaque journée.
    const intense = simulateCameraJourneys(days, { ...vue, dynamism: 4 });
    assert.equal(intense.journeyCount, 2);
    assert.ok(intense.totalMs > 0);

    // La cible est ramenée dans l'étendue : le trajet simulé est plus court.
    const loin = [jour(9000, 0)];
    const libre = simulateCameraJourneys(loin, { ...vue, dynamism: 2 });
    const borne = simulateCameraJourneys(loin, { ...vue, dynamism: 2, extent: [-500, -500, 1500, 500] });
    assert.ok(borne.totalMs < libre.totalMs);
    assert.equal(simulateCameraJourneys(null, vue).totalMs, 0);
});

test('le temps des dates se déduit du budget et des trajets à venir', () => {
    // 10 jours, 10 s de budget, deux trajets d'1 s (jours 2 et 7).
    const travelMsByDay = [0, 0, 1000, 0, 0, 0, 0, 1000, 0, 0];
    const pacing = createCameraPacing({ budgetMs: 10000, travelMsByDay });
    assert.equal(pacedDayMs(pacing, { dayIndex: 0, spentMs: 0 }), 800);
    // Après deux dates à l'heure, rien ne change.
    assert.equal(pacedDayMs(pacing, { dayIndex: 2, spentMs: 1600 }), 800);
    // Le trajet du jour 2 a coûté 1,7 s au lieu d'1 s (attente des tuiles) :
    // le surcoût est réparti et anticipé pour le trajet restant.
    const apres = pacedDayMs(pacing, { dayIndex: 3, spentMs: 2400 + 1700, travelSpentMs: 1700 });
    assert.ok(Math.abs(apres - (10000 - 4100 - 1000 - 700) / 7) < 1e-9);
    // Budget épuisé : le plancher s'applique, jamais de durée négative.
    assert.equal(pacedDayMs(pacing, { dayIndex: 9, spentMs: 20000, minMs: 33 }), 33);
});

test('travelScale accélère les trajets comptés dans le budget', () => {
    const pacing = createCameraPacing({ budgetMs: 10000, travelMsByDay: [0, 4000, 0, 4000], travelScale: 0.5 });
    assert.equal(pacing.travelFrom[0], 4000);
    assert.equal(pacing.journeysFrom[0], 2);
    assert.equal(pacedDayMs(pacing, { dayIndex: 0, spentMs: 0 }), 1500);
});

// Rejoue la boucle de capture image par image de mapgl.js (captureNextFrame) :
// une date est affichée, son trajet est capturé dates en pause, puis elle
// reçoit ses images. `overheadFrames` : images imprévues par trajet, soit un
// nombre uniforme soit une fonction du rang du trajet.
function captureImages({ budgetMs, travelMsByDay, fps, overheadFrames }) {
    const frameMs = 1000 / fps;
    const overheadFor = typeof overheadFrames === 'function' ? overheadFrames : () => overheadFrames;
    const pacing = createCameraPacing({ budgetMs, travelMsByDay });
    let frames = 0;
    let travelFrames = 0;
    let journeyIndex = 0;
    const perDay = [];
    const target = (dayIndex, travelDone) => Math.max(1, Math.round(pacedDayMs(pacing, {
        dayIndex,
        spentMs: frames * frameMs,
        travelSpentMs: travelFrames * frameMs,
        travelDone,
        minMs: frameMs,
        defaultOverheadMs: 2 * frameMs,
    }) / frameMs));
    for (let day = 0; day < travelMsByDay.length; day++) {
        let dayFrames = target(day, false);
        if (travelMsByDay[day] > 0) {
            const cost = Math.ceil(travelMsByDay[day] / frameMs) + overheadFor(journeyIndex);
            journeyIndex += 1;
            frames += cost;
            travelFrames += cost;
            dayFrames = target(day, true);
        }
        frames += dayFrames;
        perDay.push(dayFrames);
    }
    return { frames, perDay };
}

test('capture image par image : la durée imposée est tenue malgré les trajets', () => {
    const fps = 30;
    // 400 jours, un trajet de 0,9 à 2,4 s tous les 5 jours : 132 s de trajets.
    const travelMsByDay = Array.from({ length: 400 }, (_, i) => (i % 5 === 2 ? 900 + (i % 7) * 250 : 0));
    const budgetMs = 240000;
    for (const overheadFrames of [0, 2, 5]) {
        const { frames, perDay } = captureImages({ budgetMs, travelMsByDay, fps, overheadFrames });
        const ecartMs = Math.abs(frames * 1000 / fps - budgetMs);
        assert.ok(ecartMs <= 500, `écart de ${ecartMs} ms avec ${overheadFrames} images de surcoût`);
        // Rythme régulier : passé les premiers trajets (le surcoût réel n'est
        // pas encore mesuré), les dates ont toutes la même durée à une image près.
        const regime = perDay.slice(50);
        assert.ok(Math.max(...regime) - Math.min(...regime) <= 2, 'rythme irrégulier');
    }
});

test('capture image par image : sans marge, les dates tombent à une image', () => {
    // Budget plus court que les trajets : rien à rattraper, une image par jour.
    const { perDay } = captureImages({
        budgetMs: 1000, travelMsByDay: [0, 3000, 0, 3000, 0], fps: 30, overheadFrames: 2,
    });
    assert.deepEqual(perDay, [1, 1, 1, 1, 1]);
});

test('capture image par image : un premier trajet froid n\'affame pas les dates', () => {
    const fps = 30;
    // Même plan que ci-dessus, mais le premier trajet attend les tuiles
    // jusqu'à ~2 s (60 images de surcoût) avant de retrouver le rythme normal.
    const travelMsByDay = Array.from({ length: 400 }, (_, i) => (i % 5 === 2 ? 900 + (i % 7) * 250 : 0));
    const budgetMs = 240000;
    const { frames, perDay } = captureImages({
        budgetMs, travelMsByDay, fps,
        overheadFrames: (journey) => (journey === 0 ? 60 : 2),
    });
    // Le surcoût mesuré (~2 s) est plafonné à 1 s par trajet à venir : les
    // dates retrouvent un rythme régulier au lieu d'être compressées durablement.
    const regime = perDay.slice(50);
    assert.ok(Math.max(...regime) - Math.min(...regime) <= 2, 'rythme irrégulier');
    // Le dépassement reste borné : le plafond ne rogne que la provision des
    // trajets à venir (maxOverheadMs = 1 s chacun), le surcoût réel débite
    // déjà spentMs. Écart mesuré : 0 — la borne garde la marge du plafond.
    const ecartMs = frames * 1000 / fps - budgetMs;
    assert.ok(ecartMs < 1000, `dépassement de ${ecartMs} ms`);
});

// ---------- Tracé 'fly' (van Wijk & Nuij) ----------

test('normalizeCameraPath retombe sur phases pour toute valeur inconnue', () => {
    assert.deepEqual([...CAMERA_PATH_MODES], ['phases', 'fly']);
    assert.equal(normalizeCameraPath('fly'), 'fly');
    assert.equal(normalizeCameraPath('phases'), 'phases');
    assert.equal(normalizeCameraPath('x'), 'phases');
    assert.equal(normalizeCameraPath(undefined), 'phases');
    // Le défaut fonction reste 'phases' : les tests existants sont inchangés.
    assert.equal(createCameraJourney([0, 0], [5000, 0], 8, 1).path, 'phases');
});

test('fly : le trajet joint exactement le départ et l\'arrivée', () => {
    const journey = createCameraJourney([0, 0], [5000, 0], 8, 1, { path: 'fly' });
    assert.equal(journey.path, 'fly');
    assert.equal(journey.endZoom, 8);

    const start = sampleCameraJourney(journey, 0);
    assert.deepEqual(start.center, [0, 0]);
    assert.equal(start.zoom, 8);
    assert.equal(start.done, false);

    const arrival = sampleCameraJourney(journey, journey.totalDurationMs);
    assert.ok(Math.abs(arrival.center[0] - 5000) < 1e-6);
    assert.ok(Math.abs(arrival.center[1]) < 1e-6);
    assert.equal(arrival.zoom, 8);
    assert.equal(arrival.done, true);
});

test('fly : le mouvement est continu à la cadence vidéo', () => {
    const journey = createCameraJourney([0, 0], [8000, 3000], 8, 1, { path: 'fly' });
    let prev = sampleCameraJourney(journey, 0);
    for (let t = 16; t <= journey.totalDurationMs; t += 16) {
        const cur = sampleCameraJourney(journey, t);
        assert.ok(Math.abs(cur.zoom - prev.zoom) < 0.5, `saut de zoom à ${t} ms`);
        // Centre monotone vers la cible sur les deux axes.
        assert.ok(cur.center[0] >= prev.center[0] - 1e-9, `recul en x à ${t} ms`);
        assert.ok(cur.center[1] >= prev.center[1] - 1e-9, `recul en y à ${t} ms`);
        assert.ok(cur.zoom <= 8 + 1e-9, 'le zoom ne dépasse jamais le zoom de départ');
        prev = cur;
    }
});

test('fly : durationScale change la durée, pas le tracé', () => {
    const normal = createCameraJourney([0, 0], [5000, 0], 8, 1, { path: 'fly' });
    const rapide = createCameraJourney([0, 0], [5000, 0], 8, 1, { path: 'fly', durationScale: 0.5 });
    assert.equal(rapide.totalDurationMs, normal.totalDurationMs / 2);
    const a = sampleCameraJourney(rapide, rapide.totalDurationMs / 2);
    const b = sampleCameraJourney(normal, normal.totalDurationMs / 2);
    assert.ok(Math.abs(a.center[0] - b.center[0]) < 1e-9);
    assert.ok(Math.abs(a.zoom - b.zoom) < 1e-9);
    // Durée nulle : la caméra est immédiatement arrivée.
    const instantane = createCameraJourney([0, 0], [5000, 0], 8, 1, { path: 'fly', durationScale: 0 });
    assert.equal(instantane.totalDurationMs, 0);
    assert.deepEqual(sampleCameraJourney(instantane, 0), { center: [5000, 0], zoom: 8, done: true });
});

test('fly : la durée croît avec la distance puis plafonne', () => {
    let prev = 0;
    for (const px of [100, 500, 1000, 5000, 20000]) {
        const journey = createCameraJourney([0, 0], [px, 0], 8, 1, { path: 'fly' });
        assert.ok(journey.totalDurationMs >= prev, `${px} px`);
        assert.ok(journey.totalDurationMs <= 4000, `${px} px`);
        prev = journey.totalDurationMs;
    }
    // Croissance stricte tant que le plafond de 4 s n'est pas atteint.
    const court = createCameraJourney([0, 0], [100, 0], 8, 1, { path: 'fly' });
    const moyen = createCameraJourney([0, 0], [1000, 0], 8, 1, { path: 'fly' });
    assert.ok(moyen.totalDurationMs > court.totalDurationMs);
    // ~1 000 px → ~2,8 s : la calibration de CAMERA_FLY_MS_PER_UNIT.
    assert.ok(moyen.totalDurationMs > 2500 && moyen.totalDurationMs < 3000);
});

// Plus bas zoom atteint pendant un trajet 'fly'.
function flyMinZoom(journey) {
    let min = journey.startZoom;
    for (let t = 0; t <= journey.totalDurationMs; t += 10) {
        min = Math.min(min, sampleCameraJourney(journey, t).zoom);
    }
    return journey.startZoom - min;
}

test('fly : la descente de zoom vaut environ log2(u1) + 1', () => {
    // 6400 px → u1 = 10 → descente attendue ≈ log2(10) + 1 ≈ 4,32.
    // La descente réelle est log2(√(u1²+1)), asymptote de la borne par en
    // dessous : l'écart reste strictement inférieur à 1 niveau.
    const journey = createCameraJourney([0, 0], [6400, 0], 12, 1, { path: 'fly' });
    const expected = Math.log2(6400 / 640) + 1;
    assert.ok(Math.abs(flyMinZoom(journey) - expected) <= 1);
});

test('fly : extraZoomOut creuse la parabole d\'autant', () => {
    const creuse = (extraZoomOut) => flyMinZoom(
        createCameraJourney([0, 0], [5000, 0], 12, 1, { path: 'fly', extraZoomOut }),
    );
    assert.ok(creuse(1.25) > creuse(0));
    assert.ok(creuse(2.5) > creuse(1.25));
});

test('fly : le plancher minCruiseZoom produit un plateau', () => {
    const journey = createCameraJourney([0, 0], [6400, 0], 10, 1, { path: 'fly', minCruiseZoom: 9 });
    for (let t = 0; t <= journey.totalDurationMs; t += 8) {
        assert.ok(sampleCameraJourney(journey, t).zoom >= 9);
    }
    // La borne est réellement atteinte : la descente libre irait à ~6,7.
    assert.equal(flyMinZoom(journey), 1);
});

test('fly : centre fixe + extraZoomOut conserve la respiration en phases', () => {
    const journey = createCameraJourney([0, 0], [0, 0], 8, 1, { path: 'fly', extraZoomOut: 1.25 });
    assert.equal(journey.path, 'phases');
    assert.equal(journey.panDurationMs, 0);
    assert.equal(journey.cruiseZoom, 6.75);
    assert.equal(sampleCameraJourney(journey, journey.totalDurationMs).zoom, 8);
});

test('fly : la simulation rejoue les mêmes décisions que la lecture', () => {
    const days = [jour(100, 0), jour(3000, 0)];
    const sim = simulateCameraJourneys(days, {
        ...vue, dynamism: 2, path: 'fly', minCruiseZoom: 4,
    });
    assert.equal(sim.journeyCount, 1);
    assert.equal(
        sim.travelMsByDay[1],
        createCameraJourney([0, 0], [3000, 0], 8, 1, { path: 'fly', minCruiseZoom: 4 }).totalDurationMs,
    );
});
