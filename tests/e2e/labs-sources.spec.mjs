import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'labs');
const HISTORY = path.join(FIXTURES, 'lab-finds-valid.json');
const COORDS = path.join(FIXTURES, 'lab2gpx-stages.gpx');
const GPX_FINDS = path.join(HERE, 'fixtures', 'my-finds.gpx');
// Étape 1 de « Circuit des Moulins » (5/5 trouvées), avec image /logs.
const STAGE_1 = '57a9e000-0000-4000-8000-000000000101';

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


// Le placement automatique des étapes est activé par défaut et interroge le
// service public lab2gpx : aucun test ne doit le laisser partir sur le réseau
// avec les UUID de la fixture.
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings', { data: { labs_auto_fetch_coords: false } });
});


// Le sélecteur est une préférence serveur partagée par le runtime de test :
// toujours revenir à « geocaches » et vider la collection Labs pour ne pas
// influencer les autres specs.
test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ main_discovery_sources: 'geocaches',
                           labs_auto_fetch_coords: false }),
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
  // La période de pose reste utilisable : les Labs portent leur publication.
  await expect(page.locator('#publishedDatePickerStart')).toBeEnabled();
  await expect(page.locator('#publishedDatePickerEnd')).toBeEnabled();
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


test('des Labs seuls ne font pas croire qu\'un GPX géocache est déjà chargé', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // La carte « Mes Géocaches » reste en présentation détaillée : aucun GPX
  // n'a été importé, la commande compacte et le bouton de suppression ne
  // doivent pas apparaître.
  await expect(page.locator('#data')).not.toHaveClass(/has-geocaches/);
  await expect(page.locator('#data .data-empty-only')).toBeVisible();
  await expect(page.locator('#file-input-btn-compact')).toBeHidden();
  await expect(page.locator('#infosBDD')).toHaveText('Aucune géocache chargée');
  await expect(page.locator('#clearDatabaseBtn')).toBeHidden();
});


test('les filtres sont actifs avec des Labs seuls', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Les Labs comptent dans le jeu animable : le panneau de filtres n'est ni
  // inerte ni estompé.
  const panel = page.locator('#filterPanel');
  expect(await panel.evaluate(el => el.inert)).toBe(false);
  await expect(panel).not.toHaveClass(/data-disabled/);
});


test('la prochaine étape globale est visible avec des Labs seuls', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Le message concerne le jeu global : il vit sous les deux cartes de
  // sources, pas dans la carte « Mes Géocaches ».
  const nextStep = page.locator('#dataNextStep');
  await expect(nextStep).toBeVisible();
  await expect(nextStep).toContainText('Vos trouvailles sont prêtes');
  await expect(nextStep.locator('#btnGoStyleTab')).toBeVisible();
  await expect(nextStep.locator('#btnGoPreview')).toBeVisible();
  await expect(page.locator('#dataNoResults')).toBeHidden();
});


test('un import tout en attente ne bascule pas vers « labs » et met en avant les issues', async ({ page }) => {
  await openReadyApp(page);

  // Historique seul, sans coordonnées : 12 étapes importées, 0 affichable.
  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('aucune encore prête', { timeout: 60_000 });

  // Rien d'affichable : le sélecteur ne bouge pas…
  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('geocaches');
  expect((await readServerSettings(page)).main_discovery_sources).toBe('geocaches');

  // …et l'alerte met en avant les deux issues de résolution.
  await expect(page.locator('#labsPendingAlert')).toBeVisible();
  await expect(page.locator('#labsFetchBtn')).toBeVisible();
  await expect(page.locator('#labsPendingBtn')).toBeVisible();
});


test('un réimport Labs préserve un choix manuel « géocaches »', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  const select = page.locator('#selectDiscoverySources');
  await expect(select).toHaveValue('labs');

  // Choix volontaire : ne voir que les géocaches.
  await select.selectOption('geocaches');
  await expect(select).toHaveValue('geocaches');
  await expect(page.locator('#filtersCounter')).toContainText('0 / 8', { timeout: 20_000 });

  // Réimport du même lot : la collection comptait déjà 8 étapes prêtes —
  // le choix explicite ne doit pas être écrasé.
  await page.locator('#labs-file-input').setInputFiles([HISTORY, COORDS]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  // Fin réelle de l'import : le bloc d'activité apparaît puis disparaît ;
  // la suggestion, si elle rejouait, basculerait juste après.
  await expect(page.locator('#labsActivity')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsActivity')).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(1000);

  await expect(select).toHaveValue('geocaches');
  expect((await readServerSettings(page)).main_discovery_sources).toBe('geocaches');
});


test('après suppression complète, la suggestion de source est rejouée', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#selectDiscoverySources')).toHaveValue('labs');

  // Suppression complète : le mode revient à « geocaches » (reset).
  await page.locator('#clearLabsBtn').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  await expect(page.locator('#labsStatus')).toContainText('Aucun Lab Cache importé', { timeout: 30_000 });
  await expect(page.locator('#selectDiscoverySources')).toHaveValue('geocaches', { timeout: 30_000 });

  // Nouvel import sur collection redevenue vide : premier affichage de
  // Labs, la suggestion repart — la carte redevient visible.
  await importLabs(page);
  await expect(page.locator('#selectDiscoverySources')).toHaveValue('labs', { timeout: 30_000 });
  expect((await readServerSettings(page)).main_discovery_sources).toBe('labs');
});


test('« Supprimer mes Lab Caches » vide la collection Labs uniquement', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // La confirmation passe par la modale applicative (showConfirmation,
  // .gcm-confirm-modal) : cliquer son bouton danger.
  await page.locator('#clearLabsBtn').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();

  await expect(page.locator('#labsStatus')).toContainText('Aucun Lab Cache importé', { timeout: 30_000 });
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
    let timed = 0;
    for (const features of app.pointsByDate.values()) {
      const labs = features.filter(f => f.properties?.source_kind === 'lab');
      labPoints += labs.length;
      // Heure de validation, qui ordonne la journée dans le trajet.
      timed += labs.filter(f => /^\d{2}:\d{2}:\d{2}$/.test(f.properties.found_local_time || '')).length;
    }
    return {
      days: app.pointsByDate.size,
      labPoints,
      timed,
      revision: app.pointsByDateRevision,
      total: app.metadata?.numberOfCaches,
    };
  });
  expect(index).toMatchObject({ days: 3, labPoints: 8, timed: 8, total: 8 });
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
  // Propriétaire et publication lus dans le GPX.
  await expect(popup).toContainText('Testeur_Fictif');
  await expect(popup).toContainText('Publié le');
  // Pas de ligne D/T/taille ni de code GC ; le lien de l'Adventure vient de
  // l'URL importée (hôte labs.geocaching.com uniquement).
  await expect(popup).not.toContainText('-/-');
  const link = popup.locator('a.gc-popup-link');
  await expect(link).toHaveCount(1);
  expect(await link.getAttribute('href')).toMatch(/^https:\/\/labs\.geocaching\.com\//);
  const linkText = await link.textContent();
  expect(point.adventures).toContain(linkText.trim());
});


// PNG 1×1 servi à la place des images de /logs : aucun accès réseau réel.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

test('le popup d\'une étape montre son rang, l\'avancement de l\'Adventure et son image', async ({ page }) => {
  const imageRequests = [];
  await page.route('https://gsmediadata.blob.core.windows.net/**', (route) => {
    imageRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG });
  });
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Zoom maximal sur l'étape 1 : ses voisines (~40 m) ne la recouvrent plus.
  const point = await page.evaluate(async (stageId) => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const feature = app.json_data.features.find(f => f.properties?.stage_id === stageId);
    const center = ol.proj.fromLonLat(feature.geometry.coordinates);
    map.getView().setCenter(center);
    map.getView().setZoom(19);
    map.renderSync();
    const px = map.getPixelFromCoordinate(center);
    const rect = map.getTargetElement().getBoundingClientRect();
    return { x: px[0] + rect.x, y: px[1] + rect.y };
  }, STAGE_1);

  await page.mouse.click(point.x, point.y);
  const popup = page.locator('#gcPopup.is-visible');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup.locator('.gc-popup-title')).toHaveText('Le Moulin Rouge');
  await expect(popup).toContainText('Étape 1/5 · Adventure complète');
  const image = popup.locator('img.gc-popup-image');
  await expect(image).toHaveAttribute('src', /^https:\/\/gsmediadata\.blob\.core\.windows\.net\/.*000000000101$/);
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth)).toBe(1);
  expect(imageRequests.length).toBeGreaterThan(0);
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


test('le favori « Envoyer vers MyGCFlow » porte origine locale et jeton', async ({ page }) => {
  await openReadyApp(page);

  const link = page.locator('#labsBookmarkletLink');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^javascript:/);
  // Le lien généré embarque l'endpoint de réception et un jeton local.
  expect(href).toContain('/api/labs/receive');
  expect(href).toContain('X-MyGCFlow-Token');
});


test('la case de récupération automatique persiste le réglage serveur', async ({ page }) => {
  await openReadyApp(page);

  // Réglage rangé dans les options avancées, repliées par défaut.
  const box = page.locator('#labsAutoFetch');
  await expect(box).toBeHidden();
  await page.locator('#labsAdvanced > summary').click();
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();

  await box.check();
  await expect.poll(async () =>
    (await readServerSettings(page)).labs_auto_fetch_coords,
  ).toBe(true);

  // Décocher revient au défaut — l'opt-in n'est pas collant.
  await box.uncheck();
  await expect.poll(async () =>
    (await readServerSettings(page)).labs_auto_fetch_coords,
  ).toBe(false);
});


test('le bouton de récupération est visible quand des étapes sont en attente', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // 4 étapes restent en attente : les deux issues de résolution coexistent.
  await expect(page.locator('#labsPendingAlert')).toBeVisible();
  await expect(page.locator('#labsFetchBtn')).toBeVisible();
  await expect(page.locator('#labsPendingBtn')).toBeVisible();
});


const STAGE_MOULIN = '57a9e000-0000-4000-8000-000000000101';
const STAGE_PORTE_NORD = '57a9e000-0000-4000-8000-000000000401';
// Adventure archivée de la fixture : absente du GPX, ses 2 étapes attendent.
const ADVENTURE_ARCHIVED = 'fa1e0000-0000-4000-8000-000000000003';
const ARCHIVED_STAGES = ['57a9e000-0000-4000-8000-000000000301',
                         '57a9e000-0000-4000-8000-000000000302'];

// GPX de la fixture avec une substitution unique (échec si le motif bouge).
function patchedCoords(search, replacement) {
  const text = readFileSync(COORDS, 'utf-8');
  expect(text.split(search).length - 1).toBe(1);
  return { name: 'lab2gpx-patched.gpx', mimeType: 'application/gpx+xml',
           buffer: Buffer.from(text.replace(search, replacement), 'utf-8') };
}

async function exportedStage(page, stageId) {
  return page.evaluate(async (id) => {
    const payload = await (await fetch('/api/labs/export')).json();
    return payload.discoveries.find(d => d.stage_id === id) || null;
  }, stageId);
}


test('un conflit de coordonnées se tranche dans l\'aperçu : garder par défaut, remplacer sur choix', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Même étape, position déplacée dans le GPX : conflit avec l'existant.
  const moved = patchedCoords('lat="47.21510"', 'lat="47.30000"');
  await page.locator('#labs-file-input').setInputFiles(moved);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });

  const conflicts = page.locator('#labsPreviewConflicts');
  await expect(conflicts).toBeVisible();
  await expect(conflicts).toContainText('Le Moulin Rouge');
  await expect(conflicts).toContainText('47.30000');
  await expect(conflicts.locator('input[value="keep"]')).toBeChecked();

  await conflicts.locator('input[value="replace"]').check();
  await page.locator('#labsPreviewConfirmBtn').click();

  await expect.poll(async () => (await exportedStage(page, STAGE_MOULIN))?.latitude,
                    { timeout: 30_000 }).toBeCloseTo(47.3, 5);
});


test('une étape remaniée reçoit une suggestion à valider dans « Étapes en attente »', async ({ page }) => {
  await openReadyApp(page);

  // L'étape du GPX porte le titre de l'étape trouvée, sous un autre UUID :
  // proposition mémorisée, jamais appliquée seule.
  const renamed = patchedCoords('<desc>Point 1</desc>', '<desc>La Porte Nord</desc>');
  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('12', { timeout: 60_000 });

  await page.locator('#labs-file-input').setInputFiles(renamed);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
  expect((await exportedStage(page, STAGE_PORTE_NORD)).latitude).toBeNull();

  await page.locator('#labsPendingBtn').click();
  const row = page.locator(`#labsPendingList [data-local-uid="${STAGE_PORTE_NORD}"]`);
  await expect(row).toContainText('47.23010');

  await row.locator('[data-action="use-suggestion"]').click();
  await expect(row.locator('input[data-field="coords"]')).toHaveValue('47.2301, -1.5702');
  await row.getByRole('button', { name: 'Enregistrer' }).click();

  await expect.poll(async () => (await exportedStage(page, STAGE_PORTE_NORD))?.latitude,
                    { timeout: 30_000 }).toBeCloseTo(47.2301, 5);
});


test('« Étapes en attente » groupe par Adventure et place toutes ses étapes en une saisie', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  await page.locator('#labsPendingBtn').click();
  // 4 étapes en attente dans 3 Adventures ; l'archivée en compte 2.
  await expect(page.locator('#labsPendingList [data-adventure-key]')).toHaveCount(3);
  const card = page.locator(`#labsPendingList [data-adventure-key="${ADVENTURE_ARCHIVED}"]`);
  await expect(card).toContainText('Labyrinthe du Port');

  // Saisie au format geocaching.com, lue et confirmée en décimal.
  await card.locator('input[data-field="adventure-coords"]').fill('N 47° 12.000 W 001° 33.000');
  await card.locator('[data-action="place-adventure"]').click();
  await expect(card).toContainText('47.20000, -1.55000');
  await expect(page.locator('#labsStatus')).toContainText('10 sur la carte');

  // Les deux étapes sont placées à la même position, signalée approximative.
  for (const stageId of ARCHIVED_STAGES) {
    const stage = await exportedStage(page, stageId);
    expect(stage.latitude).toBeCloseTo(47.2, 5);
    expect(stage.longitude).toBeCloseTo(-1.55, 5);
    expect(stage.coordinate_scope).toBe('adventure');
  }

  // Une saisie illisible est refusée avec un message, sans rien placer.
  const single = page.locator(`#labsPendingList [data-local-uid="${STAGE_PORTE_NORD}"]`);
  await single.locator('input[data-field="coords"]').fill('48,85,2,29');
  await single.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(single).toContainText('format de coordonnées non reconnu');
  expect((await exportedStage(page, STAGE_PORTE_NORD)).latitude).toBeNull();
});


test('la période de pose filtre les Labs sur leur date de publication', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Fixture : 5 des 8 étapes affichables sont d'Adventures publiées en 2020,
  // les 3 autres plus tard. « 01/01/2021 » se lit pareil en jj/mm et mm/jj.
  await page.evaluate(() => {
    const start = document.getElementById('publishedDatePickerStart');
    start.value = '01/01/2021';
    start.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 8', { timeout: 30_000 });
});


// Dépôt de fichiers sur la fenêtre, comme un glisser-déposer depuis le bureau.
async function dropFiles(page, files) {
  await page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      transfer.items.add(new File([item.text], item.name, { type: item.type || '' }));
    }
    window.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer, bubbles: true, cancelable: true,
    }));
  }, files);
}


test('un export Lab Caches déposé sur la fenêtre part vers l\'import Labs', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Le parcours signalé : exporter, vider, puis redéposer le fichier.
  const exported = await page.evaluate(async () => (await fetch('/api/labs/export')).text());
  await page.evaluate(() => fetch('/api/labs/clear', { method: 'POST' }));
  await page.evaluate(async () => (await import('/static/js/index.js')).refreshLabsStatus());
  await expect(page.locator('#labsStatus')).not.toContainText('12');

  await dropFiles(page, [{ name: 'mygcflow-lab-finds-export.json', text: exported,
                           type: 'application/json' }]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('mygcflow-lab-finds-export.json');
  await page.locator('#labsPreviewConfirmBtn').click();

  // L'export porte les coordonnées : les 8 étapes sont de nouveau affichables.
  await expect(page.locator('#labsStatus')).toContainText('12', { timeout: 60_000 });
  await expect(page.locator('#labsStatus')).toContainText('8');
});


test('historique et GPX Lab2Gpx déposés ensemble forment un seul lot Labs', async ({ page }) => {
  await openReadyApp(page);

  await dropFiles(page, [
    { name: 'lab2gpx.gpx', text: readFileSync(COORDS, 'utf-8') },
    { name: 'historique.json', text: readFileSync(HISTORY, 'utf-8') },
  ]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('lab2gpx.gpx');
  await expect(page.locator('#labsPreviewFiles')).toContainText('historique.json');
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
});


test('un GPX Lab2Gpx choisi par le sélecteur des géocaches part vers l\'import Labs', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#file-input').setInputFiles(COORDS);
  // Plus de « Fichier invalide » : l'aperçu Labs s'ouvre (le GPX seul ne
  // crée aucune découverte, ses étapes sont comptées « ignorées »).
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#labsPreviewFiles')).toContainText('lab2gpx-stages.gpx');
});


test('la carte montre le parcours du favori, puis le replie une fois des Labs importés', async ({ page }) => {
  await openReadyApp(page);

  // Rien d'importé : état en clair, parcours en deux étapes, pas d'options
  // avancées dépliées.
  await expect(page.locator('#labsStatus')).toHaveText('Aucun Lab Cache importé');
  await expect(page.locator('#labsGuide')).toBeVisible();
  await expect(page.locator('#labsBookmarkletLink')).toBeVisible();
  await expect(page.locator('#labs-file-btn')).toBeHidden();
  await expect(page.locator('#labsUpdateBtn')).toBeHidden();

  await importLabs(page);

  await expect(page.locator('#labsStatus')).toHaveText('12 étapes · 8 sur la carte · 4 à compléter');
  await expect(page.locator('#labsGuide')).toBeHidden();
  const update = page.locator('#labsUpdateBtn');
  await expect(update).toBeVisible();
  await update.click();
  await expect(page.locator('#labsGuide')).toBeVisible();
  await expect(update).toHaveAttribute('aria-expanded', 'true');
});


test('import puis placement des étapes s\'affichent comme une seule activité suivie', async ({ page }) => {
  await openReadyApp(page);

  // Tâches serveur simulées : seule la séquence d'affichage est testée, sans
  // import réel ni appel au service lab2gpx.
  let importPolls = 0;
  let fetchPolls = 0;
  let releaseFetch = false;
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import*', route => {
    importPolls += 1;
    route.fulfill({ json: importPolls < 3
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running', progress: 40,
          message: 'Import Labs : historique.json' }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 12, updated: 0, total: 12, ready_total: 0,
                    unresolved: 12, fetch_task_id: 'fake-fetch' } } });
  });
  await page.route('**/tasks/fake-fetch*', route => {
    fetchPolls += 1;
    route.fulfill({ json: !releaseFetch
      ? { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'running', progress: 50,
          message: 'Coordonnées Labs : 2/4 Adventures' }
      : { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'finished', progress: 100,
          result: { success: true, resolved: 8, unresolved: 4, failed_uuids: [] } } });
  });

  const activity = page.locator('#labsActivity');
  await expect(activity).toBeHidden();

  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();

  // Étape 1 : import, avec le message de progression du serveur.
  await expect(activity).toBeVisible();
  await expect(activity.locator('.labs-activity-title')).toHaveText('Import de vos Lab Caches…');
  await expect(activity.locator('.labs-activity-detail')).toHaveText('Import Labs : historique.json');

  // Étape 2 : enchaînée sans que le bloc disparaisse.
  await expect(activity.locator('.labs-activity-title'))
    .toHaveText('Placement de vos étapes sur la carte…', { timeout: 15_000 });
  await expect(activity.locator('.labs-activity-detail')).toHaveText('Coordonnées Labs : 2/4 Adventures');
  await expect(activity.locator('.labs-activity-bar')).toHaveAttribute('aria-valuenow', '50');
  await expect(activity).toBeVisible();
  // Pas d'appel à l'action concurrent pendant l'opération.
  await expect(page.locator('#labsPendingAlert')).toBeHidden();

  releaseFetch = true;
  await expect(activity).toBeHidden({ timeout: 15_000 });
  expect(fetchPolls).toBeGreaterThan(0);
});


test('la récupération n\'est plus proposée quand il ne reste que des étapes déjà tentées', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#labsFetchBtn')).toBeVisible();

  // Statut tel que le serveur le rend après une récupération restée sans
  // résultat pour les 4 étapes restantes.
  await page.route('**/api/labs/status', async (route) => {
    // Le client envoie If-None-Match : sans son retrait, un 304 (corps vide)
    // rendrait le payload illisible — ce test veut toujours le JSON complet.
    const headers = { ...route.request().headers() };
    delete headers['if-none-match'];
    const response = await route.fetch({ headers });
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, fetchable_adventures: 0 } });
  });
  await page.evaluate(async () => (await import('/static/js/index.js')).refreshLabsStatus());

  await expect(page.locator('#labsPendingAlert')).toBeVisible();
  await expect(page.locator('#labsPendingText')).toContainText('introuvable');
  await expect(page.locator('#labsFetchBtn')).toBeHidden();
  await expect(page.locator('#labsPendingBtn')).toBeVisible();

  // La relance reste possible, mais rangée dans les options avancées.
  const retry = page.locator('#labsRetryFetchBtn');
  await expect(retry).toBeHidden();
  await page.locator('#labsAdvanced > summary').click();
  await expect(retry).toBeVisible();
});


// ---------------------------------------------------------------- révision
//
// Détection des mutations externes (favori, autre onglet) par la révision de
// la collection : compteurs identiques ≠ « rien n'a changé ».

const STATUS_POLL_MS = 4000;   // labs.js : intervalle du relevé de surveillance

const readPointsRevision = (page) => page.evaluate(async () =>
  (await import('/static/js/index.js')).pointsByDateRevision);
const refreshStatusOutside = (page) => page.evaluate(async () =>
  (await import('/static/js/index.js')).refreshLabsStatus({ detectOutside: true }));


test('une mutation à compteurs identiques est détectée par la révision', async ({ page, request }) => {
  await openReadyApp(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Lectures répétées sans changement de révision : la carte ne recharge pas.
  const rev0 = await readPointsRevision(page);
  await refreshStatusOutside(page);
  await refreshStatusOutside(page);
  expect(await readPointsRevision(page)).toBe(rev0);

  // Mutation externe à compteurs identiques : une date corrigée sur une
  // étape sans position — total/ready figés (12/8), révision +1.
  const uid = await request.get('/api/labs/unresolved')
    .then(r => r.json()).then(d => d.items[0].local_uid);
  expect(uid).toBeTruthy();
  const res = await request.post(`/api/labs/discoveries/${uid}/resolve`,
    { data: { found_date: '2024-07-01' } });
  expect(res.ok()).toBeTruthy();
  const status = await request.get('/api/labs/status').then(r => r.json());
  expect([status.total, status.ready]).toEqual([12, 8]);

  // Le relevé de surveillance suivant voit la révision bouger → rechargement.
  await refreshStatusOutside(page);
  await expect.poll(() => readPointsRevision(page), { timeout: 20_000 }).toBeGreaterThan(rev0);
});


test('une correction initiée depuis l\'interface ne recharge la carte qu\'une fois', async ({ page }) => {
  await openReadyApp(page);
  // Un rechargement du jeu = exactement un POST /get_geojson_points
  // (loadAndDisplayPoints) — le compteur de rechargements réel.
  let geojsonPosts = 0;
  await page.route('**/get_geojson_points', route => { geojsonPosts += 1; route.continue(); });
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });
  const posts0 = geojsonPosts;

  // Correction via la modale « Étapes en attente » : date seule sur une
  // étape sans position — la ligne reste en attente, la modale reste ouverte.
  await page.locator('#labsPendingBtn').click();
  const row = page.locator(`#labsPendingList [data-local-uid="${STAGE_PORTE_NORD}"]`);
  await row.locator('input[data-field="date"]').fill('2024-07-01');

  // Geler le relevé périodique pendant la mesure : sans onglet Données
  // actif, aucun poll ne peut intercepter la mutation entre le commit et la
  // relecture post-commit de l'action (ce qui compterait un rechargement de
  // détection externe en plus). La modale est rattachée à <body> lors de son
  // ouverture (getBsModal) : elle reste visible hors de l'onglet.
  await page.evaluate(() => document.getElementById('data').classList.remove('active'));
  await row.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(row).toContainText('Enregistré', { timeout: 20_000 });

  // Fermeture de la modale → un rechargement (correction en attente).
  await page.locator('#labsPendingModal .btn-close').click();
  await expect.poll(() => geojsonPosts, { timeout: 20_000 }).toBe(posts0 + 1);

  // L'action a relu le statut postérieur à son commit : le relevé périodique
  // suivant (4 s) ne voit plus de mutation — aucun second rechargement.
  await page.evaluate(() => document.getElementById('data').classList.add('active'));
  await page.waitForTimeout(STATUS_POLL_MS + 1500);
  expect(geojsonPosts).toBe(posts0 + 1);
  await page.unroute('**/get_geojson_points');
});


test('les relevés simultanés partagent une seule requête de statut en vol', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  // Mesure déterministe : le relevé périodique (4 s) est gelé en désactivant
  // l'onglet Données — seuls les déclencheurs explicites comptent.
  await page.evaluate(() => document.getElementById('data').classList.remove('active'));

  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;
  let release;
  let gate = new Promise(r => { release = r; });
  await page.route('**/api/labs/status', async (route) => {
    total += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight -= 1;
    await route.continue();
  });

  // focus + retour de visibilité + relevé périodique peuvent se produire en
  // même temps : une seule requête part, les appelants partagent la promesse
  // (la première étant « dehors », la détection est faite pour tous).
  const joined = page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return Promise.all([
      app.refreshLabsStatus({ detectOutside: true }),
      app.refreshLabsStatus(),
      app.refreshLabsStatus({ detectOutside: true }),
    ]);
  });
  await expect.poll(() => total).toBe(1);
  release();
  await joined;
  expect(maxInFlight).toBe(1);
  expect(total).toBe(1);

  // `fresh` (fin d'une action de cette page) enchaîne une relecture APRÈS la
  // requête en vol — séquentielle, jamais parallèle : des réponses HTTP ne
  // peuvent donc pas revenir dans le désordre.
  total = 0;
  gate = new Promise(r => { release = r; });
  const chained = page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return Promise.all([
      app.refreshLabsStatus({ fresh: true }),
      app.refreshLabsStatus({ fresh: true }),
    ]);
  });
  await expect.poll(() => total).toBe(1);
  release();
  await expect.poll(() => total).toBe(2);
  await chained;
  expect(maxInFlight).toBe(1);
  await page.unroute('**/api/labs/status');
  await page.evaluate(() => document.getElementById('data').classList.add('active'));
});


// --------------------------------------------------- activité / toasts
//
// Lot 2.1 : une séquence = un seul indicateur. Pendant l'opération, le bloc
// #labsActivity suffit (toast seulement hors onglet Données) ; le bilan
// n'arrive qu'après le rechargement, fusionné avec la bascule de source.

// Surveillant : mémorise le maximum de toasts visibles simultanément.
async function watchToastCount(page) {
  await page.evaluate(() => {
    window.__labsToastMax = 0;
    const count = () => document.querySelectorAll('.gcm-toast.show').length;
    window.__labsToastObs = new MutationObserver(() => {
      window.__labsToastMax = Math.max(window.__labsToastMax, count());
    });
    window.__labsToastObs.observe(document.body,
      { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
}
const maxToastsSeen = (page) => page.evaluate(() => window.__labsToastMax || 0);


test('un import produit au plus un toast à la fois et un seul bilan final', async ({ page }) => {
  await openReadyApp(page);
  await watchToastCount(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  // Pendant toute la séquence : jamais plus d'un toast visible.
  expect(await maxToastsSeen(page)).toBeLessThanOrEqual(1);

  // Bilan unique après rechargement : import + bascule de source fusionnés.
  const toast = page.locator('.gcm-toast.show');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('12 étape(s) importée(s)');
  await expect(toast).toContainText('affichable');
  await expect(toast).toContainText('maintenant affichés');
});


test('le même parcours à 390 px n\'empile pas les toasts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReadyApp(page);
  await watchToastCount(page);
  await importLabs(page);
  await expect(page.locator('#filtersCounter')).toContainText('8 / 8', { timeout: 60_000 });

  expect(await maxToastsSeen(page)).toBeLessThanOrEqual(1);
  const toast = page.locator('.gcm-toast.show');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('importée');
});


test('un import suivi d\'un placement produit un seul bilan final', async ({ page }) => {
  await openReadyApp(page);
  await watchToastCount(page);

  // Tâches simulées : import puis placement enchaîné, placement tenu jusqu'à
  // relâche — la fenêtre de vérification est maîtrisée.
  let importPolls = 0;
  let releaseFetch = false;
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import*', route => {
    importPolls += 1;
    route.fulfill({ json: importPolls < 2
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running', progress: 40,
          message: 'Import Labs : historique.json' }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 12, updated: 0, total: 12, ready_total: 0,
                    unresolved: 12, fetch_task_id: 'fake-fetch' } } });
  });
  await page.route('**/tasks/fake-fetch*', route => {
    route.fulfill({ json: !releaseFetch
      ? { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'running', progress: 50,
          message: 'Coordonnées Labs : 2/4 Adventures' }
      : { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'finished', progress: 100,
          result: { success: true, resolved: 8, unresolved: 4, failed_uuids: [] } } });
  });

  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();

  // Le placement automatique tourne : aucun bilan tant qu'il n'est pas fini.
  const activity = page.locator('#labsActivity');
  await expect(activity).toContainText('Placement de vos étapes', { timeout: 15_000 });
  expect(await page.locator('.gcm-toast.show').count()).toBe(0);

  releaseFetch = true;
  await expect(activity).toBeHidden({ timeout: 15_000 });

  // Un seul toast, portant l'import ET le placement.
  const toast = page.locator('.gcm-toast.show');
  await expect(toast).toHaveCount(1, { timeout: 20_000 });
  await expect(toast).toContainText('12 étape(s) importée(s)');
  await expect(toast).toContainText('8 étape(s) placée(s)');
  await expect(toast).toContainText('4 étape(s) restent à compléter');
  expect(await maxToastsSeen(page)).toBeLessThanOrEqual(1);
});


test('l\'activité se transforme en un toast unique hors de l\'onglet Données', async ({ page }) => {
  await openReadyApp(page);

  // Import tenu en cours par une tâche simulée : la fenêtre de bascule
  // d'onglet est maîtrisée.
  let release = false;
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import*', route => {
    route.fulfill({ json: !release
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running', progress: 40,
          message: 'Import Labs : historique.json' }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 1, total: 1, ready_total: 0, unresolved: 1 } } });
  });

  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  const activity = page.locator('#labsActivity');
  await expect(activity).toBeVisible({ timeout: 15_000 });

  // Sur l'onglet Données : le bloc seul, aucun toast Labs.
  expect(await page.locator('.gcm-toast.show', { hasText: 'Lab Caches' }).count()).toBe(0);

  // Quitter l'onglet : l'activité devient un toast global unique.
  await page.locator('a[href="#animation"]').click();
  const toast = page.locator('.gcm-toast.show', { hasText: 'Lab Caches' });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('Import de vos Lab Caches');
  await expect(activity).toBeHidden();

  // Retour : le bloc reprend le relais, le toast disparaît.
  await page.locator('a[href="#data"]').click();
  await expect(toast).toHaveCount(0);
  await expect(activity).toBeVisible();

  release = true;
  await expect(activity).toBeHidden({ timeout: 15_000 });
});


// ------------------------------------------------- suivi de tâche (délais)
//
// Lot 2.2 : le suivi abandonne une tâche figée (signature
// état|progression|message inchangée) et des erreurs HTTP répétées ; une
// tâche qui progresse, aussi longue soit-elle, n'est jamais interrompue.

async function setShortTaskLimits(page) {
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.setLabTaskPollLimits({ stallMs: 2000, httpMs: 1500 });
  });
}

async function startFakeImport(page, { taskBody }) {
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import*', taskBody);
  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
}


test('une tâche figée running/50 % finit signalée comme bloquée', async ({ page }) => {
  await openReadyApp(page);
  await setShortTaskLimits(page);
  // running/50 % éternel : la signature ne change jamais.
  await startFakeImport(page, { taskBody: route => route.fulfill({ json: {
    task_id: 'fake-import', type: 'lab_import', state: 'running',
    progress: 50, message: 'Import Labs : historique.json' } }) });
  const activity = page.locator('#labsActivity');
  await expect(activity).toBeVisible({ timeout: 15_000 });

  // Blocage signalé (~2 s), bloc retiré, un seul toast d'erreur.
  await expect(page.locator('.gcm-toast.show', { hasText: 'bloquée' }))
    .toHaveCount(1, { timeout: 15_000 });
  await expect(activity).toBeHidden();
});


test('une tâche longue qui progresse n\'est jamais interrompue', async ({ page }) => {
  await openReadyApp(page);
  await setShortTaskLimits(page);
  // Dix relevés à ~500 ms = ~5 s > 2 s de délai figé : chaque relevé fait
  // évoluer la signature (progression + message), le délai est repoussé.
  let polls = 0;
  await startFakeImport(page, { taskBody: route => {
    polls += 1;
    route.fulfill({ json: polls < 10
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running',
          progress: polls * 10, message: `Import Labs : ${polls}/10` }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 2, total: 2, ready_total: 0, unresolved: 2 } } });
  } });
  const activity = page.locator('#labsActivity');
  await expect(activity).toBeVisible({ timeout: 15_000 });

  // Aucun toast de blocage : la tâche va à son terme et le bilan arrive.
  await expect(activity).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('.gcm-toast.show', { hasText: 'bloquée' })).toHaveCount(0);
  await expect(page.locator('.gcm-toast.show', { hasText: 'importée' }))
    .toHaveCount(1, { timeout: 15_000 });
});


test('des erreurs HTTP répétées abandonnent le suivi sans boucler', async ({ page }) => {
  await openReadyApp(page);
  let polls = 0;
  await startFakeImport(page, { taskBody: route => {
    polls += 1;
    route.fulfill({ status: 500, json: { error: 'boom' } });
  } });
  await expect(page.locator('#labsActivity')).toBeVisible({ timeout: 15_000 });

  // Dix erreurs consécutives (~5 s) : abandon, message clair, bloc retiré.
  await expect(page.locator('.gcm-toast.show', { hasText: 'ne répond plus' }))
    .toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#labsActivity')).toBeHidden();

  // Le suivi est vraiment arrêté : plus de requêtes ensuite.
  const atStop = polls;
  await page.waitForTimeout(2000);
  expect(polls).toBeLessThanOrEqual(atStop + 1);
});


test('la récupération est annulable et le bilan le dit', async ({ page }) => {
  await openReadyApp(page);

  // Import simulé qui enchaîne un placement tenu jusqu'à annulation.
  let importPolls = 0;
  let releaseFetch = false;
  let cancelCalls = 0;
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-import' } }));
  await page.route('**/tasks/fake-import?*', route => {
    importPolls += 1;
    route.fulfill({ json: importPolls < 2
      ? { task_id: 'fake-import', type: 'lab_import', state: 'running', progress: 40,
          message: 'Import Labs : historique.json' }
      : { task_id: 'fake-import', type: 'lab_import', state: 'finished', progress: 100,
          result: { success: true, added: 12, total: 12, ready_total: 0,
                    unresolved: 12, fetch_task_id: 'fake-fetch' } } });
  });
  await page.route('**/tasks/fake-fetch/cancel', route => {
    cancelCalls += 1;
    route.fulfill({ json: { success: true } });
  });
  await page.route('**/tasks/fake-fetch?*', route => {
    route.fulfill({ json: !releaseFetch
      ? { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'running', progress: 50,
          message: 'Coordonnées Labs : 2/4 Adventures' }
      : { task_id: 'fake-fetch', type: 'lab_fetch_coords', state: 'finished', progress: 100,
          result: { success: true, cancelled: true, resolved: 6, unresolved: 4,
                    failed_uuids: [] } } });
  });

  await page.locator('#labs-file-input').setInputFiles([HISTORY]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();

  // Pendant l'import atomique : pas de bouton Annuler.
  const activity = page.locator('#labsActivity');
  const cancelBtn = page.locator('#labsActivityCancelBtn');
  await expect(activity).toContainText('Import de vos Lab Caches', { timeout: 15_000 });
  await expect(cancelBtn).toBeHidden();

  // Placement : Annuler apparaît, un clic appelle /cancel une fois.
  await expect(activity).toContainText('Placement de vos étapes', { timeout: 15_000 });
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();
  await expect(cancelBtn).toBeDisabled();
  await expect(activity).toContainText('Annulation en cours');
  await expect.poll(() => cancelCalls).toBe(1);

  // La tâche finit son lot puis rend un bilan annulé — un seul toast.
  releaseFetch = true;
  await expect(activity).toBeHidden({ timeout: 15_000 });
  await expect(cancelBtn).toBeHidden();
  const toast = page.locator('.gcm-toast.show');
  await expect(toast).toHaveCount(1, { timeout: 20_000 });
  await expect(toast).toContainText('6 étape(s) placée(s) sur la carte.');
  await expect(toast).toContainText('Récupération interrompue');
  await expect(toast).toContainText('déjà obtenues sont conservées');
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


// --- Lot 3.2 — favori accessible ----------------------------------------------

test('le favori est inerte tant que son lien charge, puis devient glissable', async ({ page }) => {
  let releaseBookmarklet;
  const hold = new Promise(resolve => { releaseBookmarklet = resolve; });
  await page.route('**/api/labs/bookmarklet', async route => {
    await hold;
    await route.fulfill({ json: { success: true,
      bookmarklet: 'javascript:void(console.log("bm"))' } });
  });
  await openReadyApp(page);

  const link = page.locator('#labsBookmarkletLink');
  // Pendant le chargement : texte de préparation, pas glissable, désactivé
  // pour les lecteurs d'écran et retiré de la navigation clavier — aucun
  // « # » ne peut être glissé.
  await expect(link).toContainText('Préparation du favori');
  await expect(link).toHaveAttribute('aria-disabled', 'true');
  await expect(link).toHaveAttribute('tabindex', '-1');
  expect(await link.getAttribute('draggable')).not.toBe('true');
  expect(await link.getAttribute('href')).toBe('#');
  // Rien à copier tant que le vrai lien n'existe pas.
  await expect(page.locator('#labsCopyLinkBtn')).toBeDisabled();

  releaseBookmarklet();
  // Prêt : vrai javascript:, glissable, de nouveau accessible au clavier.
  await expect(link).toContainText('Envoyer vers MyGCFlow');
  await expect(link).toHaveAttribute('draggable', 'true');
  expect(await link.getAttribute('aria-disabled')).toBeNull();
  expect(await link.getAttribute('tabindex')).toBeNull();
  expect(await link.getAttribute('href')).toMatch(/^javascript:/);
  await expect(page.locator('#labsCopyLinkBtn')).toBeEnabled();
});


test('un favori impossible à préparer propose l\'import de fichiers', async ({ page }) => {
  await page.route('**/api/labs/bookmarklet', route =>
    route.fulfill({ status: 500, json: { success: false } }));
  await openReadyApp(page);

  // Échec visible : message explicite + bouton resté inerte et non glissable.
  const errBox = page.locator('#labsBookmarkletError');
  await expect(errBox).toBeVisible();
  await expect(errBox).toContainText('pas pu être préparé');
  const link = page.locator('#labsBookmarkletLink');
  await expect(link).toContainText('Favori indisponible');
  expect(await link.getAttribute('draggable')).not.toBe('true');
  await expect(link).toHaveAttribute('aria-disabled', 'true');

  // Le repli proposé déclenche bien le sélecteur de fichiers du panneau.
  await page.evaluate(() => {
    window.__labsFileOpened = false;
    document.getElementById('labs-file-input')
      .addEventListener('click', () => { window.__labsFileOpened = true; });
  });
  await page.locator('#labsBookmarkletFallbackBtn').click();
  expect(await page.evaluate(() => window.__labsFileOpened)).toBe(true);
});


test('« Copier le lien » copie le favori au clavier et l\'annonce en aria-live', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openReadyApp(page);

  const copyBtn = page.locator('#labsCopyLinkBtn');
  await expect(copyBtn).toBeEnabled();
  // Parcours clavier : focus + Entrée sur un vrai <button> déclenche la copie.
  await copyBtn.focus();
  await page.keyboard.press('Enter');

  const status = page.locator('#labsBookmarkletStatus');
  await expect(status).toHaveText('Lien copié');
  expect(await status.getAttribute('aria-live')).toBe('polite');
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^javascript:/);
});


test('le bouton du guide est « Afficher les instructions d\'import »', async ({ page }) => {
  await openReadyApp(page);
  await importLabs(page);

  const update = page.locator('#labsUpdateBtn');
  await expect(update).toBeVisible();
  await expect(update).toContainText("Afficher les instructions d'import");
  await update.click();
  await expect(page.locator('#labsGuide')).toBeVisible();
});


test('sur petit écran, l\'import de fichiers précède le favori', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openReadyApp(page);

  const mobile = page.locator('.labs-mobile-import');
  await expect(mobile).toBeVisible();
  await expect(page.locator('#labs-file-btn-guide')).toBeVisible();
  // Le raccourci est placé avant les instructions du favori dans le DOM.
  const order = await page.evaluate(() => {
    const guide = document.getElementById('labsGuide');
    const first = guide.querySelector('.labs-mobile-import');
    const list = guide.querySelector('ol');
    return Boolean(
      first.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  // Et il ouvre bien le sélecteur de fichiers.
  await page.evaluate(() => {
    window.__labsFileOpened = false;
    document.getElementById('labs-file-input')
      .addEventListener('click', () => { window.__labsFileOpened = true; });
  });
  await page.locator('#labs-file-btn-guide').click();
  expect(await page.evaluate(() => window.__labsFileOpened)).toBe(true);

  // Grand écran sans tactile : le raccourci disparaît, le parcours favori
  // reste en tête (l'entrée fichier reste dans les options avancées).
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(mobile).toBeHidden();
});


test('la régénération du jeton invalide l\'ancien favori', async ({ page }) => {
  await openReadyApp(page);

  const link = page.locator('#labsBookmarkletLink');
  await expect(link).toHaveAttribute('draggable', 'true');
  const oldHref = await link.getAttribute('href');
  const oldToken = (await readServerSettings(page)).labs_receive_token;
  expect(oldToken).toBeTruthy();
  expect(oldHref).toContain(oldToken);

  // Action destructive dans les options avancées : la confirmation dit
  // clairement que l'ancien favori sera invalidé.
  await page.locator('#labsAdvanced').evaluate(el => { el.open = true; });
  const regenBtn = page.locator('#labsRegenTokenBtn');
  await expect(regenBtn).toBeVisible();
  await regenBtn.click();
  const confirm = page.locator('.gcm-confirm-modal');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('cessera de fonctionner');

  await confirm.locator('[data-gcm-role="confirm"]').click();
  await expect(page.locator('#labsBookmarkletStatus'))
    .toContainText('Nouveau favori prêt');

  const newToken = (await readServerSettings(page)).labs_receive_token;
  const newHref = await link.getAttribute('href');
  expect(newToken).toBeTruthy();
  expect(newToken).not.toBe(oldToken);
  expect(newHref).toContain(newToken);
  expect(newHref).not.toBe(oldHref);

  // Côté serveur : l'ancien jeton est refusé (403), le nouveau passe la
  // porte jeton (400 = payload non reconnu, authentification réussie).
  const results = await page.evaluate(async ([oldT, newT]) => {
    const probe = token => fetch('/api/labs/receive', {
      method: 'POST',
      headers: { 'X-MyGCFlow-Token': token, 'Content-Type': 'application/json' },
      body: '<html>page</html>',
    }).then(r => r.status);
    return [await probe(oldT), await probe(newT)];
  }, [oldToken, newToken]);
  expect(results).toEqual([403, 400]);
});


// --- Lot 5.2 — sondages réduits ------------------------------------------------

test('le statut est sondé en cadence adaptative et 304 quand rien n\'a bougé', async ({ page }) => {
  // Réponses /api/labs/status observées au fil du réseau : le premier relevé
  // n'a pas de tag (200) ; les suivants le renvoient en If-None-Match → 304
  // tant que la révision est inchangée.
  const hits = [];
  page.on('response', r => {
    if (r.url().includes('/api/labs/status')) {
      hits.push({ status: r.status(),
                  inm: r.request().headers()['if-none-match'] || null });
    }
  });
  await openReadyApp(page);

  // ~9 s de fenêtre dense → init + ~2 relevés à 4 s, pas plus.
  await page.waitForTimeout(9000);
  expect(hits.length).toBeGreaterThanOrEqual(2);
  expect(hits.length).toBeLessThanOrEqual(5);
  expect(hits[0].status).toBe(200);
  expect(hits[0].inm).toBeNull();
  for (const h of hits.slice(1)) {
    expect(h.inm).toBeTruthy();
    expect(h.status).toBe(304);
  }
});


test('le relevé de statut est suspendu hors de l\'onglet Données', async ({ page }) => {
  const polls = [];
  page.on('request', r => {
    if (r.url().includes('/api/labs/status')) polls.push(Date.now());
  });
  // Base vide → l'app force l'onglet Données sauf si l'URL porte un hash :
  // /#style maintient l'onglet Style actif sans que le statut ne re-bascule.
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect(page.locator('#data')).not.toHaveClass(/active/);

  // Le relevé d'init peut encore partir ; après, plus rien pendant 6 s —
  // même dans la fenêtre dense de 30 s.
  await page.waitForTimeout(6000);
  const active = await page.evaluate(() =>
    document.getElementById('data').classList.contains('active'));
  expect(active).toBe(false);
  // Au plus le relevé d'init : rien ensuite hors de l'onglet Données.
  expect(polls.length).toBeLessThanOrEqual(1);
});


test('le suivi de tâche monte en palier : 500 ms, 1 s, puis 2 s', async ({ page }) => {
  // Tâche bloquée à « running » : les relevés mesurent la cadence réelle.
  const hits = [];
  await page.route('**/tasks/fake-slow*', route => {
    hits.push(Date.now());
    route.fulfill({ json: { task_id: 'fake-slow', type: 'lab_import',
      state: 'running', progress: 50, message: 'Import Labs : historique.json' } });
  });
  await page.route('**/api/labs/import/commit', route => route.fulfill({
    status: 202, json: { success: true, task_id: 'fake-slow' } }));
  await openReadyApp(page);

  await page.locator('#labs-file-input').setInputFiles(HISTORY);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();

  // Palier dense : ≥ 5 relevés dans les ~3 premières secondes.
  await page.waitForTimeout(3200);
  expect(hits.length).toBeGreaterThanOrEqual(5);
  // Après 10 s écoulés : les relevés passent à ~1 s (palier intermédiaire).
  await page.waitForTimeout(9200);
  const t0 = hits[0];
  const late = hits.filter(t => t - t0 >= 10800);
  const lateGaps = late.slice(1).map((t, i) => t - late[i]);
  expect(lateGaps.length).toBeGreaterThanOrEqual(1);
  expect(Math.min(...lateGaps)).toBeGreaterThanOrEqual(900);
});


test('le palier de sondage respecte ses bornes', async ({ page }) => {
  await openReadyApp(page);
  const delays = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return {
      tiers: [0, 5000, 9999, 10000, 30000, 59999, 60000, 120000]
        .map(t => app.taskPollDelay(t)),
      busy: app.taskPollDelay(0, true),
    };
  });
  expect(delays.tiers).toEqual([500, 500, 500, 1000, 1000, 1000, 2000, 2000]);
  // Animation en cours : jamais sous 2 s, même dans le palier dense.
  expect(delays.busy).toBe(2000);
});
