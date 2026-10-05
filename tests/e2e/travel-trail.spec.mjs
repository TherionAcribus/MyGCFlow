// Traits de déplacement : le trajet du géocacheur dessiné pendant l'animation.
//
// Le dessin lui-même (canvas) n'est pas comparé au pixel près : on observe
// l'état exposé par getTravelTrailDebugState() — trajet calculé, stylo qui
// avance, sommets réellement tracés — comme les autres specs le font pour les
// options et les styles.
//
// Fixture : 6 caches à ~150 m d'intervalle, une par jour du 01 au 06/01/2026.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openWithFixture(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  // La base du runtime garde les caches du test précédent : au chargement de
  // la page, readBdd() affiche déjà « 6 / 6 ». Seule la fin de l'import compte,
  // sinon son addVector() tardif (qui retire le trait : nouvelles données)
  // tombe pendant la lecture ou l'enregistrement. Le toast « Affichage des
  // points » naît avec le message de succès et disparaît après cet addVector().
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
  // Les filtres (pays, régions) se réappliquent encore un peu après, chacun par
  // un addVector() : attendre que l'index des jours ne soit plus reconstruit.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDate.size)).toBe(6);
}

async function enableTrail(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTrail"]').click();
  // Les réglages de tracé restent modifiables trajet désactivé.
  await expect(page.locator('#selectTrailRouting')).toBeEnabled();
  await page.locator('#switchTrail').check();
}

async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
}

function trailState(page) {
  return page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.getTravelTrailDebugState();
  });
}

test('le trait suit les caches pendant la lecture et reste affiché à la fin', async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);

  const options = await page.evaluate(async () => (await import('/static/js/index.js')).options.trail);
  expect(options.enabled).toBe(true);
  expect(options.routing).toBe('clusters');

  await setRhythm(page, 4);
  await page.locator('#btnQuickPreview').click();

  // Le trajet est calculé au lancement : une étape par jour (caches isolées).
  await expect.poll(async () => (await trailState(page)).stops).toBe(6);
  let state = await trailState(page);
  expect(state.active).toBe(true);
  expect(state.layerVisible).toBe(true);
  expect(state.buildMs).not.toBeNull();

  // Le stylo avance et des segments sont réellement tracés.
  await expect.poll(async () => (await trailState(page)).drawnVertices, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await trailState(page)).penLength, { timeout: 10_000 }).toBeGreaterThan(0);

  // Fin naturelle : le stylo a parcouru tout le trajet, qui reste affiché.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    const s = await trailState(page);
    return s.penLength >= s.totalLength - 1e-6;
  }, { timeout: 5_000 }).toBe(true);
  state = await trailState(page);
  expect(state.active).toBe(true);
  expect(state.layerVisible).toBe(true);
});

test("la date de fin de l'animation borne le trajet", async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);
  await setRhythm(page, 6);
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2026, 0, 1);
    app.options.animation.dateEnd = new Date(2026, 0, 3);
    app.options.animation.extraEndSeconds = 0;
  });
  await page.locator('#btnQuickPreview').click();
  // Seuls les 3 premiers jours (01→03/01) font partie du trajet.
  await expect.poll(async () => (await trailState(page)).stops).toBe(3);
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  const state = await trailState(page);
  expect(state.penLength).toBeCloseTo(state.totalLength, 3);
});

test('la pause fige le trait, la reprise le reprend sans saut', async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);
  await setRhythm(page, 1);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await trailState(page)).penLength, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.locator('#btnQuickPause').click();
  const frozen = (await trailState(page)).penLength;
  await page.waitForTimeout(1200);
  expect((await trailState(page)).penLength).toBe(frozen);
  await page.locator('#btnQuickPause').click(); // Continuer
  await expect.poll(async () => (await trailState(page)).penLength, { timeout: 5_000 }).toBeGreaterThan(frozen);
  await page.locator('#btnQuickStop').click();
});

test("l'arrêt efface le trait ; désactivé, aucun trajet n'est tracé", async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);
  await setRhythm(page, 1);

  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await trailState(page)).active).toBe(true);
  await page.locator('#btnQuickStop').click();
  await expect.poll(async () => (await trailState(page)).active).toBe(false);
  expect((await trailState(page)).layerVisible).toBe(false);

  // Interrupteur coupé : la lecture suivante ne crée aucun trait.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTrail"]').click();
  await page.locator('#switchTrail').uncheck();
  // Réglages modifiables et aperçu ouvrable, trajet désactivé.
  await expect(page.locator('#selectTrailRouting')).toBeEnabled();
  const btn = page.locator('#btnTrailPreview');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(async () => (await trailState(page)).preview).toBe(true);
  await btn.click();
  await expect.poll(async () => (await trailState(page)).preview).toBe(false);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPause')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await trailState(page)).active).toBe(false);
  await page.locator('#btnQuickStop').click();
});

test('la durée du tracé est une préférence globale enregistrée', async ({ page }) => {
  await openWithFixture(page);
  await page.locator('a[href="#animation"]').click();
  const input = page.locator('#inputTimeTrail');
  await expect(input).toHaveValue('800');

  await input.fill('1500');
  await expect.poll(async () => page.evaluate(async () => {
    const settings = await (await fetch('/api/settings')).json();
    return settings.animation?.trail_duration_ms;
  }), { timeout: 5_000 }).toBe(1500);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).options.trail.duration)).toBe(1500);

  // Hors bornes : champ signalé invalide, valeur en vigueur inchangée.
  await input.fill('50');
  await expect(input).toHaveClass(/is-invalid/);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).options.trail.duration)).toBe(1500);

  // Remise à la valeur par défaut pour les autres specs (runtime partagé).
  await input.fill('800');
  await expect.poll(async () => page.evaluate(async () => {
    const settings = await (await fetch('/api/settings')).json();
    return settings.animation?.trail_duration_ms;
  }), { timeout: 5_000 }).toBe(800);
});

for (const mode of ['images', 'mediarecorder']) {
  test(`le trait est tracé pendant un enregistrement (${mode})`, async ({ page }) => {
    test.setTimeout(180_000);
    await openWithFixture(page);
    // Le runtime est partagé entre les specs : les réglages vidéo modifiés
    // ici (préférences globales) sont restaurés à la fin.
    const savedRecording = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).recording);

    await enableTrail(page);
    await setRhythm(page, 6);
    await page.locator('#recordingConfigTab').click();
    await expect(page.locator('#recordingConfigPane')).toBeVisible();
    await page.locator('#selectRecordMode').selectOption(mode);
    if (mode === 'mediarecorder') {
      const advanced = page.locator('#recordAdvancedSettings');
      if (!(await advanced.evaluate((element) => element.open))) {
        await advanced.locator('summary').click();
      }
      await page.locator('#inputRecordSlowdown').fill('2');
      await page.locator('#cbRecordUpload').uncheck();
      await page.locator('#cbRecordDownload').uncheck();
      await page.locator('#cbRecordNormalize').uncheck();
    }

    // Durée de tracé en vigueur pendant la capture (ralentie en MediaRecorder).
    // 6000 ms × ralentissement 2 = 12000 ms : au-delà de la borne de saisie
    // (10000), pour vérifier que la durée exécutée n'est pas écrêtée.
    await page.evaluate(async () => {
      const app = await import('/static/js/index.js');
      app.options.trail.duration = 6000;
      app.options.record.fps = 12;
      if (app.options.record.mediaRecorder) app.options.record.mediaRecorder.tailFreezeMs = 250;
      window.__trailDurations = [];
      const tick = () => {
        const duration = app.options.trail.duration;
        if (app.getTravelTrailDebugState().active && !window.__trailDurations.includes(duration)) {
          window.__trailDurations.push(duration);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.locator('#btnQuickExport').click({ force: true });
    await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 150_000 });

    // Relevé du moteur (conservé après l'arrêt) : le trajet a été tracé en
    // entier pendant la capture, jusqu'à la dernière étape.
    const state = await trailState(page);
    expect(state.maxDrawnVertices).toBeGreaterThan(0);
    expect(state.maxDrawnLength).toBeCloseTo(state.totalLength, 3);
    expect(await page.evaluate(async () => (await import('/static/js/index.js')).options.trail.duration)).toBe(6000);
    // Durée réellement appliquée au tracé : ralentie en MediaRecorder, sans
    // écrêtage à la borne de saisie (10000 ms).
    expect(state.strokeDurationMs).toBe(mode === 'mediarecorder' ? 12000 : 6000);
    const durations = await page.evaluate(() => window.__trailDurations);
    expect(durations).toContain(mode === 'mediarecorder' ? 12000 : 6000);

    await page.evaluate((recording) => fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording }),
    }), savedRecording);
    // Remettre la préférence en mémoire pour les specs suivantes (page partagée).
    await page.evaluate(() => import('/static/js/index.js').then(a => { a.options.trail.duration = 800; }));
  });
}

test("l'aperçu affiche le trajet calculé et l'inspecte au clic", async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);

  // Zoomer sur la zone des caches pour espacer les étapes à l'écran.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const view = app.olMap.getView();
    view.setCenter(ol.proj.fromLonLat([2.353, 48.853]));
    view.setZoom(15);
  });

  const btn = page.locator('#btnTrailPreview');
  await expect(btn).toBeEnabled();
  await btn.click();
  // Aperçu actif, aucune animation : le trajet est mémoïsé (6 étapes) et
  // réellement dessiné par le postrender de la couche.
  await expect.poll(async () => (await trailState(page)).preview).toBe(true);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await trailState(page)).stops).toBe(6);
  await expect.poll(async () => (await trailState(page)).drawnVertices).toBeGreaterThan(0);
  expect((await trailState(page)).active).toBe(false);

  // Clic à ~10 px d'une étape : hors du point de la cache (la popup cache
  // primerait), dans le rayon de capture de l'étape.
  const px = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const key = [...app.pointsByDate.keys()].sort()[2];
    const [lon, lat] = app.pointsByDate.get(key)[0].geometry.coordinates;
    return app.olMap.getPixelFromCoordinate(ol.proj.fromLonLat([lon, lat]));
  });
  // getPixelFromCoordinate donne des pixels relatifs au viewport de la carte ;
  // page.mouse attend des coordonnées de page — ajouter l'offset de la carte
  // (l'en-tête d'application la décale sous le haut du document).
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + px[0] + 10, mapBox.y + px[1]);
  await expect(page.locator('#gcPopup')).toHaveClass(/is-visible/);
  await expect(page.locator('#gcPopup .gc-popup-content')).toContainText('Étape');
  await expect(page.locator('#gcPopup .gc-popup-content')).toContainText('1 cache');
  // Clic hors de toute étape : la popup se referme.
  await page.mouse.click(mapBox.x + px[0] + 150, mapBox.y + px[1] + 100);
  await expect(page.locator('#gcPopup')).not.toHaveClass(/is-visible/);

  // Re-clic sur le bouton : l'aperçu se ferme.
  await btn.click();
  await expect.poll(async () => (await trailState(page)).preview).toBe(false);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

test("les préréglages remplissent les réglages d'apparence", async ({ page }) => {
  await openWithFixture(page);
  await enableTrail(page);

  // « Parcours complet » : tout le parcours, tête pulsante, lueur — sans
  // toucher aux réglages de tracé.
  await page.locator('#trailPresetFull').click();
  await expect(page.locator('#selectTrailPersist')).toHaveValue('0');
  await expect(page.locator('#selectTrailHead')).toHaveValue('pulse');
  await expect(page.locator('#selectTrailEffect')).toHaveValue('glow');
  await expect(page.locator('#inputTrailOpacity')).toHaveValue('60');
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).options.trail.persistDays)).toBe(0);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).options.trail.routing)).toBe('clusters');

  // « Voyage » restaure les défauts (runtime partagé entre les specs).
  await page.locator('#trailPresetTravel').click();
  await expect(page.locator('#selectTrailPersist')).toHaveValue('30');
  await expect(page.locator('#selectTrailHead')).toHaveValue('dot');
  await expect(page.locator('#selectTrailEffect')).toHaveValue('none');
});

test("le mode Évolution ne propose pas les traits", async ({ page }) => {
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('a[href="#tabTrail"]')).toHaveCount(0);
  await expect(page.locator('#inputTimeTrail')).toHaveCount(0);
  await expect(page.locator('#switchTrail')).toHaveCount(0);
});
