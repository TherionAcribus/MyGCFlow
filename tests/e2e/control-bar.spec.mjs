// Menu flottant de contrôle : visible par défaut, masquable via la
// préférence globale « show_control_bar » (Animation & vidéo), persistée
// entre rechargements — mais forcée en plein écran, où elle porte le seul
// bouton de sortie du mode.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

async function dismissFirstUseModal(page) {
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}

// Runtime partagé : la préférence est persistée côté serveur — la remettre
// explicitement rend chaque test indépendant de l'ordre d'exécution.
async function resetPref(request, value = true) {
  const res = await request.put('/api/settings', { data: { show_control_bar: value } });
  expect(res.ok()).toBeTruthy();
}

test('menu flottant : préférence visible par défaut, masquage persisté, forcée en plein écran', async ({ page, request }) => {
  await resetPref(request, true);
  await request.post('/clear_database');

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  // Visible par défaut, même sans base : seul le bouton plein écran est
  // proposé (Lecture/Enregistrement restent cachés sans données).
  const bar = page.locator('#controlBar');
  await expect(bar).toBeVisible();
  await expect(page.locator('#btnStartBar')).toBeHidden();
  await expect(page.locator('#btnRecordBar')).toBeHidden();
  await expect(page.locator('#btnToggleFullscreen')).toBeVisible();

  // Le bouton reflète la préférence (pressé par défaut).
  await page.locator('a[href="#animation"]').click();
  const toggle = page.locator('#btnToggleControlBar');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Désactiver masque la barre immédiatement.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(bar).toBeHidden();

  // La préférence survit au rechargement.
  await openReadyApp(page);
  await dismissFirstUseModal(page);
  await expect(bar).toBeHidden();
  await page.locator('a[href="#animation"]').click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // …mais le plein écran la force : sans elle, aucun bouton de sortie
  // n'est accessible (le panneau est masqué).
  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(bar).toBeVisible();
  await page.locator('#btnToggleFullscreen').click();
  await expect(page.locator('main')).not.toHaveClass(/fullscreen-mode/);
  await expect(bar).toBeHidden();

  // Réactiver la réaffiche.
  await toggle.click();
  await expect(bar).toBeVisible();
});

test('menu flottant : boutons Lecture/Enregistrement activés par les données', async ({ page, request }) => {
  await resetPref(request, true);
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);

  await expect(page.locator('#btnStartBar')).toBeHidden();
  await expect(page.locator('#btnRecordBar')).toBeHidden();

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await expect(page.locator('#btnStartBar')).toBeVisible();
  await expect(page.locator('#btnRecordBar')).toBeVisible();
  await expect(page.locator('#btnPauseBar')).toBeHidden();
  await expect(page.locator('#btnStopBar')).toBeHidden();
});
