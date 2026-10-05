// Style > Points : le sélecteur « Choisir la couleur » n'a de sens qu'en mode
// « Couleur unique » (fix). En « Couleurs GC » ou « Transparent », la valeur
// serait ignorée — le picker doit être masqué (même règle que l'onglet Flash).
import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

const centerPicker = '#pointCenterColor';
const borderPicker = '#pointBorderColor';

test.beforeEach(async ({ page }) => {
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#tabPoints"]').click();
});

test('pickers masqués sauf en mode « Couleur unique »', async ({ page }) => {
  // Thème par défaut : centre en couleurs GC, bordure en couleur unique.
  await expect(page.locator(centerPicker)).toBeHidden();
  await expect(page.locator(borderPicker)).toBeVisible();

  await page.locator('#fillColorPointFixLabel').click();
  await expect(page.locator(centerPicker)).toBeVisible();

  await page.locator('#fillColorPointNoneLabel').click();
  await expect(page.locator(centerPicker)).toBeHidden();

  await page.locator('#borderColorPointGcLabel').click();
  await expect(page.locator(borderPicker)).toBeHidden();
});

test('l\'état du picker suit le thème chargé', async ({ page }) => {
  // Recharge avec un thème où le centre est en « Couleur unique » : le picker
  // doit être visible dès l'affichage, pas seulement après un clic radio.
  await page.locator('#fillColorPointFixLabel').click();
  await expect(page.locator(centerPicker)).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  // La modification est en mémoire (non enregistrée) : après rechargement on
  // retombe sur l'état du thème — le picker reflète le mode rechargé.
  const visible = await page.locator(centerPicker).isVisible();
  const mode = await page.locator('input[name="fillColorPoint"]:checked').getAttribute('value');
  expect(visible).toBe(mode === 'fix');
});
