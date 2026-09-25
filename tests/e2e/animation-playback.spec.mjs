import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}


async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await page.waitForFunction(async () => {
    const app = await import('/static/js/index.js');
    return app.metadata?.numberOfCaches === 6 && app.pointsByDate?.size === 6;
  });
}


// « dd/mm/yyyy » → nombre de jours depuis une origine fixe, pour comparer
// les dates affichées sans souci de fuseau.
function dayIndex(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await importFixture(page);
  await page.locator('a[href="#animation"]').click();
  // 2 jours/s → 500 ms/jour : assez lent pour observer pause/reprise.
  await page.locator('#inputDaysPerSecond').fill('2');
  await page.locator('#inputExtraEndTime').fill('0');
});


test('pause, reprise et arrêt ne provoquent aucun rattrapage brutal', async ({ page }) => {
  const currentDate = page.locator('#spanCurrentDate');
  const btnStart = page.locator('#btnStartAnimation');
  const btnPause = page.locator('#btnPauseAnimation');
  const btnStop = page.locator('#btnStopAnimation');

  await btnStart.click();
  await expect(btnPause).toBeVisible();

  // Laisser tourner ~0,8 s (≈ 1-2 jours à 2 j/s ; la plage fait ~5 jours,
  // soit ~2,5 s au total — la pause doit intervenir avant la fin).
  // La date affichée initialement est la date de FIN de la plage (affichée
  // après l'import) ; le démarrage la ramène au début puis avance.
  await page.waitForTimeout(800);

  // Pause : la date affichée ne doit plus bouger.
  await expect(btnPause).toBeVisible();
  await btnPause.click();
  const dateAtPause = await currentDate.textContent();
  expect(dateAtPause).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  await page.waitForTimeout(1200);
  expect(await currentDate.textContent()).toBe(dateAtPause);

  // Reprise : un pas borné, pas un bond de dizaines de jours (le rattrapage
  // est plafonné par MAX_DAYS_PER_FRAME et l'accumulateur repart de zéro).
  await btnPause.click(); // « Continuer »
  await page.waitForTimeout(500);
  const dateAfterResume = await currentDate.textContent();
  expect(dateAfterResume).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);

  const paused = dayIndex(dateAtPause);
  const resumed = dayIndex(dateAfterResume);
  // 700 ms à 2 j/s ≈ 1-2 jours ; un rattrapage sauvage dépasserait 3-4 jours.
  expect(resumed - paused).toBeGreaterThanOrEqual(0);
  expect(resumed - paused).toBeLessThanOrEqual(4);

  // Arrêt : retour à l'état initial (boutons Lecture/Enregistrement visibles).
  // Si l'animation s'est terminée entre-temps, cet état est déjà atteint.
  if (await btnStop.isVisible()) {
    await btnStop.click();
  }
  await expect(btnStart).toBeVisible();
  await expect(btnPause).toBeHidden();
});
