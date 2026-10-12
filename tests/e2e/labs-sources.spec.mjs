import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'labs');
const HISTORY = path.join(FIXTURES, 'lab-finds-valid.json');
const COORDS = path.join(FIXTURES, 'lab2gpx-stages.gpx');

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
