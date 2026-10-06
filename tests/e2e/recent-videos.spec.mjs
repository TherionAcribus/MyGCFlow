// « Dernières vidéos » (onglet Export) : la liste montre les vidéos du dossier,
// rouvre l'écran de fin d'export et supprime en deux clics. La suppression
// réelle enverrait le fichier dans la Corbeille de la machine : la route est
// interceptée et le fichier retiré ici.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'my-finds.gpx');
const RUNTIME = process.env.MYGCFLOW_E2E_RUNTIME;
// Dossier propre à cette spec : celui par défaut est partagé avec les exports
// des autres specs, dont le nombre et les dates ne sont pas maîtrisés.
const FOLDER = path.join(RUNTIME, 'videos-recentes');

function addVideo(name, ageSeconds, bytes = 2 * 1024 * 1024) {
  const file = path.join(FOLDER, name);
  writeFileSync(file, Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, when, when);
  return file;
}

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

test.beforeEach(async ({ page }) => {
  rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(FOLDER, { recursive: true });
  const chosen = await page.request.post('/api/video_folder/choose', { data: { path: FOLDER } });
  expect(chosen.ok()).toBe(true);
});

test.afterEach(async ({ page }) => {
  await page.request.post('/api/video_folder/reset');
});

test('la liste présente les vidéos du dossier, de la plus récente à la plus ancienne', async ({ page }) => {
  await openExportTab(page);
  const rows = page.locator('#recentVideosList > li');
  await expect(page.locator('#recentVideosEmpty')).toBeVisible();
  await expect(rows).toHaveCount(0);

  addVideo('Bretagne_2026-10-01_10h00.mp4', 3600);
  addVideo('Alpes_2026-10-05_18h30.mp4', 60);
  addVideo('mygcflow_raw_20261006-101010.webm', 10); // enregistrement en cours : masqué
  for (let index = 0; index < 8; index += 1) addVideo(`ancienne_${index}.mp4`, 86_400 + index);

  await openExportTab(page);
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(0)).toContainText('Alpes_2026-10-05_18h30.mp4');
  await expect(rows.nth(0)).toContainText('2 Mo');
  await expect(rows.nth(1)).toContainText('Bretagne_2026-10-01_10h00.mp4');
  await expect(page.locator('#recentVideosList')).not.toContainText('mygcflow_raw');
  await expect(page.locator('#recentVideosEmpty')).toBeHidden();
  await expect(page.locator('#recentVideosMore')).toContainText('2 autres vidéos');

  // Un clic rouvre l'écran de fin d'export sur cette vidéo.
  await rows.nth(1).locator('.recent-video-open').click();
  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible();
  await expect(ready.locator('#videoReadyFile')).toHaveText('Bretagne_2026-10-01_10h00.mp4');
  await expect(ready.locator('#videoReadyFolder')).toHaveText(FOLDER);
});

test('la suppression demande un second clic, puis retire la vidéo de la liste', async ({ page }) => {
  const kept = addVideo('a_garder.mp4', 120);
  const removed = addVideo('a_supprimer.mp4', 60);

  let deleteRequests = 0;
  await page.route('**/api/videos/delete', async (route) => {
    deleteRequests += 1;
    const { file } = route.request().postDataJSON();
    rmSync(path.join(FOLDER, file));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, file, recoverable: true }),
    });
  });

  await openExportTab(page);
  const rows = page.locator('#recentVideosList > li');
  await expect(rows).toHaveCount(2);
  const target = rows.filter({ hasText: 'a_supprimer.mp4' });
  const button = target.locator('.recent-video-delete');

  // Premier clic : le bouton s'arme, rien n'est supprimé.
  await button.click();
  await expect(button).toContainText('Supprimer ?');
  expect(deleteRequests).toBe(0);
  expect(existsSync(removed)).toBe(true);

  await button.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('a_garder.mp4');
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Corbeille' }).last()).toBeVisible();
  expect(deleteRequests).toBe(1);
  expect(existsSync(removed)).toBe(false);
  expect(existsSync(kept)).toBe(true);
});

test('un nouvel export apparaît dans la liste sans recharger la page', async ({ page }) => {
  await openExportTab(page);
  const rows = page.locator('#recentVideosList > li');
  await expect(rows).toHaveCount(0);

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await page.locator('#selectRecordMode').selectOption('images');
  await page.locator('#selectRecordResolution').selectOption('window');
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.fps = 12;
  });

  await page.locator('#btnQuickExport').click({ force: true });
  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  const exported = await ready.locator('#videoReadyFile').textContent();
  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(exported);
});
