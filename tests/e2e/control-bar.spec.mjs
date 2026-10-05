// Menu flottant de contrôle : réservé au plein écran. Hors de ce mode il
// reste masqué (la barre collante #quickActions porte les mêmes commandes) ;
// en plein écran il s'affiche toujours, car c'est lui qui porte le seul
// bouton de sortie du mode.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

test('menu flottant : masqué hors plein écran, visible en plein écran', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  // Masqué en affichage normal, qu'il y ait des données ou non.
  const bar = page.locator('#controlBar');
  await expect(bar).toBeHidden();

  // Le plein écran l'affiche : sans lui, aucun bouton de sortie n'est
  // accessible (le panneau est masqué). Le bouton d'entrée vit dans la
  // barre collante #panelToolbar, visible depuis n'importe quel onglet.
  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(bar).toBeVisible();
  await expect(page.locator('#btnToggleFullscreen')).toBeVisible();

  // Le bouton du menu flottant ramène à l'affichage normal, qui le masque.
  await page.locator('#btnToggleFullscreen').click();
  await expect(page.locator('main')).not.toHaveClass(/fullscreen-mode/);
  await expect(bar).toBeHidden();
});

test('menu flottant : boutons Lecture/Enregistrement activés par les données', async ({ page, request }) => {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  // Sans données, Lecture/Enregistrement restent masqués dans le menu.
  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(page.locator('#btnStartBar')).toBeHidden();
  await expect(page.locator('#btnRecordBar')).toBeHidden();
  await page.locator('#btnToggleFullscreen').click();
  await expect(page.locator('main')).not.toHaveClass(/fullscreen-mode/);

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(page.locator('#btnStartBar')).toBeVisible();
  await expect(page.locator('#btnRecordBar')).toBeVisible();
  await expect(page.locator('#btnPauseBar')).toBeHidden();
  await expect(page.locator('#btnStopBar')).toBeHidden();
});
