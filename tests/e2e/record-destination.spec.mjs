// Destination de la capture rapide : au moins une des deux cases (« Copier
// dans le dossier Vidéos », « Télécharger une copie ») doit rester cochée,
// sinon la vidéo serait produite puis perdue. L'erreur #recordDestinationError
// s'affiche près des cases et l'export est bloqué tant qu'aucune destination
// n'est choisie. Le mode images n'est pas concerné : la vidéo y est toujours
// assemblée dans le dossier Vidéos.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

// Les cases sont masquées en mode images (.mediarecorder-only) : un clic
// Playwright échouerait sur l'actionabilité. On pose la valeur et on émet le
// 'change' qu'écoute changeRecordValues, comme le ferait un vrai clic.
async function setRecordCheckbox(page, id, checked) {
  await page.evaluate(([elementId, value]) => {
    const cb = document.getElementById(elementId);
    cb.checked = value;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, checked]);
}

test('capture rapide : sans destination, erreur affichée et export bloqué', async ({ page }) => {
  await openReadyApp(page);

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('mediarecorder');

  const exportBtn = page.locator('#btnRecordAnimation');
  const quickExportBtn = page.locator('#btnQuickExport');
  const destinationError = page.locator('#recordDestinationError');
  const cbUpload = page.locator('#cbRecordUpload');
  const cbDownload = page.locator('#cbRecordDownload');

  // État de départ rendu déterministe (le runtime est partagé entre specs) :
  // les deux destinations cochées → pas d'erreur, export possible.
  await cbUpload.check();
  await cbDownload.check();
  await expect(exportBtn).toBeEnabled();
  await expect(quickExportBtn).toBeEnabled();
  await expect(destinationError).toBeHidden();

  // Les deux décochées : erreur persistante et boutons bloqués.
  await cbUpload.uncheck();
  await cbDownload.uncheck();
  await expect(destinationError).toBeVisible();
  await expect(destinationError).toContainText('nulle part');
  await expect(exportBtn).toBeDisabled();
  await expect(quickExportBtn).toBeDisabled();

  // Une seule destination suffit à débloquer.
  await cbDownload.check();
  await expect(destinationError).toBeHidden();
  await expect(exportBtn).toBeEnabled();
  await expect(quickExportBtn).toBeEnabled();

  // Mode images : la vidéo est toujours assemblée dans le dossier Vidéos, la
  // contrainte ne s'applique pas — même les deux cases décochées.
  await page.locator('#selectRecordMode').selectOption('images');
  await setRecordCheckbox(page, 'cbRecordUpload', false);
  await setRecordCheckbox(page, 'cbRecordDownload', false);
  await expect(destinationError).toBeHidden();
  await expect(exportBtn).toBeEnabled();
  await expect(quickExportBtn).toBeEnabled();

  // Les specs partagent le runtime : on laisse des réglages sains.
  await page.locator('#selectRecordMode').selectOption('mediarecorder');
  await setRecordCheckbox(page, 'cbRecordUpload', true);
  await expect(exportBtn).toBeEnabled();
});
