import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'labs');
const HISTORY = path.join(FIXTURES, 'lab-finds-valid.json');
const COORDS = path.join(FIXTURES, 'lab2gpx-stages.gpx');
const GPX_FINDS = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Sélecteur « Découvertes affichées » + panneau « Mes Lab Caches » (mode
// Normal) : la fixture couvre 12 découvertes dont 8 résolues par UUID — soit
// 8 étapes affichables et 4 en attente après l'import du lot complet.


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  await dismissFirstUseModal(page);
}


async function importLabs(page) {
  await page.locator('#labs-file-input').setInputFiles([HISTORY, COORDS]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  // Import terminé quand le statut affiche les compteurs (8 affichables /
  // 4 en attente) — l'appli bascule alors aussi le sélecteur sur « labs ».
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
}


async function readServerSettings(page) {
  return page.evaluate(async () => (await fetch('/api/settings')).json());
}


// Le sélecteur est une préférence serveur partagée par le runtime de test :
// toujours revenir à « geocaches » et vider la collection Labs pour ne pas
// influencer les autres specs.
test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ main_discovery_sources: 'geocaches' }),
  })).catch(() => {});
  await request.post('/api/labs/clear').catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


test('le sélecteur de sources existe avec les trois choix et le défaut géocaches', async ({ page }) => {
  await openReadyApp(page);

  const select = page.locator('#selectDiscoverySources');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('geocaches');
  await expect(select.locator('option')).toHaveCount(3);
});


test('l\'import Labs met à jour le statut et bascule l\'affichage sur les Labs', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Statut : 12 étapes, 8 affichables, 4 en attente.
  await expect(page.locator('#labsStatus')).toContainText('12');
  await expect(page.locator('#labsPendingAlert')).toBeVisible();

  // Sans géocaches, l'appli a basculé sur « labs » pour rendre l'import visible.
  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('labs');
  expect((await readServerSettings(page)).main_discovery_sources).toBe('labs');

  // Les 8 étapes résolues sont affichées.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });
});


test('le mode « labs » désactive les filtres non applicables', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  await expect(page.locator('#selectDiscoverySources')).toHaveValue('labs');

  // D/T/taille désactivés, « Adventure Lab » resté sélectionné dans les types.
  await expect(page.locator('#filterPanel')).toHaveAttribute('data-labs-only', '');
  const adventureSelected = await page.evaluate(() =>
    Array.from(document.getElementById('selectType').selectedOptions)
      .some(o => o.value === 'Adventure Lab'));
  expect(adventureSelected).toBe(true);
});


test('« géocaches » masque les Labs ; « both » les réaffiche', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  const select = page.locator('#selectDiscoverySources');
  await select.selectOption('geocaches');
  await expect(page.locator('#filtersCounter')).toContainText('0 / 8', { timeout: 20_000 });
  expect((await readServerSettings(page)).main_discovery_sources).toBe('geocaches');

  await select.selectOption('both');
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 20_000 });
});


test('« Supprimer mes Lab Caches » vide la collection Labs uniquement', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // La confirmation passe par la modale applicative (showConfirmation,
  // .gcm-confirm-modal) : cliquer son bouton danger.
  await page.locator('#clearLabsBtn').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();

  await expect(page.locator('#labsStatus')).toContainText('Aucune étape', { timeout: 30_000 });
});


test('les étapes Labs alimentent l\'index d\'animation et la lecture les joue', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // L'index par jour (aliment de l'animation, du trajet et de la vidéo)
  // contient les 8 étapes résolues, réparties sur 3 jours. La recharge
  // post-import est asynchrone : le compteur « 8 / 8 » est posé en fin de
  // séquence, quand json_data et pointsByDate sont reconstruits.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });
  const index = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    let labPoints = 0;
    for (const features of app.pointsByDate.values()) {
      labPoints += features.filter(f => f.properties?.source_kind === 'lab').length;
    }
    return {
      days: app.pointsByDate.size,
      labPoints,
      revision: app.pointsByDateRevision,
      total: app.metadata?.numberOfCaches,
    };
  });
  expect(index).toMatchObject({ days: 3, labPoints: 8, total: 8 });
  expect(index.revision).toBeGreaterThan(0);

  // Lecture complète : le compteur atteint le total de la sélection et la
  // date affichée rejoint le dernier jour Labs (2024-06-09).
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('20');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#spanNbCaches')).toHaveText('8', { timeout: 30_000 });
  await expect(page.locator('#spanCurrentDate')).toContainText('09/06/2024');
});


test('le popup d\'une étape Labs affiche étape, Adventure, lien et date', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // La recharge post-import est asynchrone : le compteur « 8 / 8 » est posé
  // en fin de séquence, quand json_data et pointsByDate sont reconstruits.
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  const point = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const labs = app.json_data.features.filter(f => f.properties?.source_kind === 'lab');
    const feature = labs[0];
    const [lon, lat] = feature.geometry.coordinates;
    const px = map.getPixelFromCoordinate(ol.proj.fromLonLat([lon, lat]));
    const rect = map.getTargetElement().getBoundingClientRect();
    return {
      x: px[0] + rect.x, y: px[1] + rect.y,
      // Des étapes proches peuvent se recouvrir : le clic peut retourner
      // n'importe quelle étape au premier plan sous le pixel.
      stages: labs.map(f => f.properties.name),
      adventures: labs.map(f => f.properties.adventure_title),
    };
  });

  await page.mouse.click(point.x, point.y);
  const popup = page.locator('#gcPopup.is-visible');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup.locator('.gc-popup-title')).toHaveText(new RegExp(`^(${point.stages.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`));
  await expect(popup).toContainText('Trouvé');
  // Pas de ligne D/T/taille ni de code GC ; le lien de l'Adventure vient de
  // l'URL importée (hôte labs.geocaching.com uniquement).
  await expect(popup).not.toContainText('-/-');
  const link = popup.locator('a.gc-popup-link');
  await expect(link).toHaveCount(1);
  expect(await link.getAttribute('href')).toMatch(/^https:\/\/labs\.geocaching\.com\//);
  const linkText = await link.textContent();
  expect(point.adventures).toContain(linkText.trim());
});


// Critère final du plan : en mixte, chaque choix de source affiche et
// compte son propre jeu (ici 6 géocaches + 8 étapes Labs).
test('en mixte, chaque source affiche et compte son propre jeu', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#file-input').setInputFiles(GPX_FINDS);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await importLabs(page);
  // Des géocaches existent : l'import bascule sur « both ».
  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('both');
  await expect(page.locator('#filtersCounter')).toContainText('14 / 14', { timeout: 60_000 });

  // Les deux sources sont dans l'index d'animation.
  const counts = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    let labs = 0, geocaches = 0;
    for (const features of app.pointsByDate.values()) {
      for (const f of features) {
        (f.properties?.source_kind === 'lab' ? labs++ : geocaches++);
      }
    }
    return { labs, geocaches };
  });
  expect(counts).toEqual({ labs: 8, geocaches: 6 });

  await select.selectOption('geocaches');
  await expect(page.locator('#filtersCounter')).toContainText('6 / 14', { timeout: 20_000 });
  await select.selectOption('labs');
  await expect(page.locator('#filtersCounter')).toContainText('8 / 14', { timeout: 20_000 });
  await select.selectOption('both');
  await expect(page.locator('#filtersCounter')).toContainText('14 / 14', { timeout: 20_000 });
});


test('couleur et icône dédiées Adventure Lab sont déclarées', async ({ page }) => {
  await openReadyApp(page);

  const style = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.setPointIconSet('geocaching');
    return {
      color: app.defaultGcColors?.['Adventure Lab'],
      flat: app.gcColorsFlat || [],
      sprite: app.options?.point?.sprite?.map?.adventurelab || null,
    };
  });

  expect(style.color).toBe('#00C5A1');
  const idx = style.flat.indexOf('Adventure Lab');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(style.flat[idx + 1]).toBe('#00C5A1');
  expect(style.sprite).toMatchObject({ x: 1800, y: 0, w: 50, h: 50 });
});
