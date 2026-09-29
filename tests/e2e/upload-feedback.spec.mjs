// Retour visuel à l'import GPX : une toast de chargement doit apparaître
// immédiatement à la sélection/dépôt du fichier (la validation lit l'en-tête
// sur disque, ce qui peut prendre plusieurs secondes), et un indicateur
// inline reflète la progression là où l'utilisateur a déposé le fichier —
// dans la carte « état vide » ou dans la modale de première utilisation.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

// La toast de chargement est créée dans handleGpxFile AVANT l'appel réseau :
// elle doit déjà exister pendant l'upload/polling, pas seulement au succès.
// Le toast de chargement initial (« Chargement de l'application... », posé par
// readBdd au démarrage) porte lui aussi une barre de progression et peut être
// encore affiché quand le fichier est déposé tôt : il est exclu, sinon le
// locator désigne deux toasts.
function loadingToast(page) {
  return page.locator('.gcm-toast', { has: page.locator('.gcm-progress-fill') })
    .filter({ hasNotText: "Chargement de l'application" });
}

test('import via état vide : toast immédiate et indicateur inline pendant le traitement', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  const indicator = page.locator('#emptyStateUploadProgress');
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(indicator).toBeHidden();

  // Sélection directe sur l'input (le bouton de l'état vide lui délègue le
  // clic) : toast + indicateur doivent être visibles pendant l'import.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(loadingToast(page)).toBeVisible();
  await expect(indicator).toBeVisible();
  await expect(page.locator('#btnEmptyStateImport')).toBeDisabled();

  // Fin d'import : indicateur refermé, toast de chargement remplacée par le
  // succès, commandes débloquées.
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await expect(indicator).toBeHidden();
});

test('import via modale première utilisation : indicateur interne visible pendant le traitement', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);

  // Base vide au démarrage : la modale s'ouvre automatiquement.
  // Attendue ENTIÈREMENT ouverte (cf. tests/e2e/first-use.mjs).
  const modal = page.locator('#modal_first_use');
  await page.waitForFunction(() => window.mygcflowFirstUseSettled === true);
  await expect(modal).toBeVisible();

  const indicator = page.locator('#modalUploadProgress');
  await expect(indicator).toBeHidden();

  await page.locator('#file-input-modal').setInputFiles(FIXTURE);
  await expect(loadingToast(page)).toBeVisible();
  await expect(indicator).toBeVisible();
  await expect(indicator.locator('.upload-progress-text')).not.toBeEmpty();

  // Au succès la modale se ferme et l'indicateur est réinitialisé.
  await expect(modal).toBeHidden({ timeout: 45_000 });
  await expect(indicator).toBeHidden();
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6');
});
