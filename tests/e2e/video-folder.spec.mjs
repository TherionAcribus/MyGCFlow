// Dossier des vidéos (onglet Export) : affichage du dossier en vigueur, choix
// d'un autre dossier et retour à celui par défaut. Le sélecteur de dossier du
// système n'est jamais ouvert ici : la route est interceptée pour simuler son
// indisponibilité, ce qui exerce la saisie manuelle du chemin.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { dismissFirstUseModal } from './first-use.mjs';

const RUNTIME = process.env.MYGCFLOW_E2E_RUNTIME;
const DEFAULT_FOLDER = path.join(RUNTIME, 'video');
const CUSTOM_FOLDER = path.join(RUNTIME, 'mes films');

async function openExportTab(page) {
  // Passage par une page vide : rappeler la même adresse (seul le fragment
  // diffère) ne recharge pas la page.
  await page.goto('about:blank');
  await page.goto('/#animation', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
}

test.afterEach(async ({ page }) => {
  // Le runtime est partagé entre specs : les exports suivants doivent
  // retrouver le dossier par défaut.
  await page.request.post('/api/video_folder/reset');
});

test('le dossier des vidéos se choisit, s\'affiche et se réinitialise', async ({ page }) => {
  // Sélecteur du système indisponible : l'interface doit proposer la saisie.
  await page.route('**/api/video_folder/choose', async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.path === undefined) {
      await route.fulfill({
        status: 501,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, picker_unavailable: true, message: 'indisponible' }),
      });
    } else {
      await route.continue();
    }
  });

  await openExportTab(page);
  const folder = page.locator('#videoFolderPath');
  const reset = page.locator('#btnVideoFolderReset');
  const manual = page.locator('#videoFolderManual');
  const error = page.locator('#videoFolderError');
  const summary = page.locator('#exportSummary');

  await expect(folder).toHaveText(DEFAULT_FOLDER);
  await expect(reset).toBeHidden();
  await expect(manual).toBeHidden();
  await expect(summary).toContainText('dossier Vidéos');

  await page.locator('#btnVideoFolderChoose').click();
  await expect(manual).toBeVisible();

  // Chemin relatif : refusé avec une explication, rien n'est modifié.
  await page.locator('#inputVideoFolderPath').fill('films');
  await page.locator('#btnVideoFolderApply').click();
  await expect(error).toBeVisible();
  await expect(error).toContainText('chemin complet');
  await expect(folder).toHaveText(DEFAULT_FOLDER);

  await page.locator('#inputVideoFolderPath').fill(CUSTOM_FOLDER);
  await page.locator('#btnVideoFolderApply').click();
  await expect(folder).toHaveText(CUSTOM_FOLDER);
  await expect(error).toBeHidden();
  await expect(manual).toBeHidden();
  await expect(reset).toBeVisible();
  await expect(summary).toContainText(CUSTOM_FOLDER);

  // Préférence globale : elle survit au rechargement.
  await openExportTab(page);
  await expect(folder).toHaveText(CUSTOM_FOLDER);
  await expect(summary).toContainText(CUSTOM_FOLDER);

  await reset.click();
  await expect(folder).toHaveText(DEFAULT_FOLDER);
  await expect(reset).toBeHidden();
  await expect(summary).toContainText('dossier Vidéos');
});

test('un dossier choisi devenu inaccessible est signalé', async ({ page }) => {
  const vanished = path.join(RUNTIME, 'disque-debranche');
  const chosen = await page.request.post('/api/video_folder/choose', { data: { path: vanished } });
  expect(chosen.ok()).toBe(true);
  const { rmdirSync } = await import('node:fs');
  rmdirSync(vanished);

  await openExportTab(page);
  await expect(page.locator('#videoFolderPath')).toHaveText(DEFAULT_FOLDER);
  await expect(page.locator('#videoFolderWarning')).toBeVisible();
  await expect(page.locator('#videoFolderWarning')).toContainText(vanished);
  await expect(page.locator('#btnVideoFolderReset')).toBeVisible();
});
