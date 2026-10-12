import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');


test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('20');
});


// Le mode de rythme et la durée totale sont des préférences globales : on
// rend le mode jours/seconde et la durée par défaut aux specs suivants.
test.afterEach(async ({ page }) => {
  await page.locator('#inputTotalDuration').fill('01:00');
  await page.locator('#inputDaysPerSecond').fill('20');
  await expect.poll(async () => page.evaluate(async () => {
    const { animation } = await (await fetch('/api/settings')).json();
    return [animation.rhythm_mode, animation.total_duration_seconds, animation.days_per_second];
  })).toEqual(['rate', 60, 20]);
});


test('saisir dans un champ de tempo sélectionne son mode', async ({ page }) => {
  const rate = page.locator('#inputDaysPerSecond');
  const duration = page.locator('#inputTotalDuration');
  const rateField = page.locator('.rhythm-field:has(#inputDaysPerSecond)');
  const durationField = page.locator('.rhythm-field:has(#inputTotalDuration)');

  await expect(page.locator('#rhythmModeRate')).toBeChecked();
  await expect(rateField).toHaveClass(/is-driving/);
  await expect(durationField).toHaveClass(/is-computed/);
  // Le champ calculé reste saisissable : y écrire bascule en « Par durée ».
  await expect(duration).toBeEditable();

  await duration.fill('00:30');
  await expect(page.locator('#rhythmModeDuration')).toBeChecked();
  await expect(durationField).toHaveClass(/is-driving/);
  await expect(rateField).toHaveClass(/is-computed/);
  await expect(rate).not.toHaveValue('20');
  // Le rythme calculé ne correspond à aucun préréglage.
  await expect(page.locator('#selectRhythmPreset')).toHaveValue('custom');

  await expect(rate).toBeEditable();
  await rate.fill('10');
  await expect(page.locator('#rhythmModeRate')).toBeChecked();
  await expect(rateField).toHaveClass(/is-driving/);
  await expect(page.locator('#selectRhythmPreset')).toHaveValue('slow');
  await expect(duration).not.toHaveValue('00:30');
});


test('cliquer un bouton de rythme place le curseur dans son champ', async ({ page }) => {
  await page.locator('label:has(#rhythmModeDuration)').click();
  await expect(page.locator('#rhythmModeDuration')).toBeChecked();
  await expect(page.locator('#inputTotalDuration')).toBeFocused();

  await page.locator('label:has(#rhythmModeRate)').click();
  await expect(page.locator('#rhythmModeRate')).toBeChecked();
  await expect(page.locator('#inputDaysPerSecond')).toBeFocused();
});


test('« Sur la musique » verrouille les deux champs', async ({ page }) => {
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.rhythmMode = 'music';
    app.refreshTimingPlan({ save: false });
  });
  await expect(page.locator('#inputDaysPerSecond')).not.toBeEditable();
  await expect(page.locator('#inputTotalDuration')).not.toBeEditable();

  // Sortie explicite par un bouton : les champs redeviennent saisissables.
  await page.evaluate(() => document.getElementById('rhythmModeRate').click());
  await expect(page.locator('#rhythmModeRate')).toBeChecked();
  await expect(page.locator('#inputTotalDuration')).toBeEditable();
});
