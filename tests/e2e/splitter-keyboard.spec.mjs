// Séparateur carte/panneau : focusable clavier (role="separator"), flèches
// haut/bas, PageUp/PageDown, Home/End — avec aria-valuenow synchronisé.
import { expect, test } from '@playwright/test';

const mapHeight = page => page.locator('#mapWithFrames').evaluate(el => el.getBoundingClientRect().height);
const ariaNow = page => page.locator('#mapTabsResizer').getAttribute('aria-valuenow');

test('séparateur carte/panneau : navigation clavier', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  const resizer = page.locator('#mapTabsResizer');
  await expect(resizer).toHaveAttribute('role', 'separator');
  await expect(resizer).toHaveAttribute('aria-orientation', 'horizontal');
  // aria-valuenow est renseigné par applyMapHeightPx dès l'init.
  await expect(resizer).toHaveAttribute('aria-valuenow', /^\d+$/);

  // Tab doit atteindre la barre.
  await resizer.focus();
  await expect(resizer).toBeFocused();

  // ArrowDown agrandit la carte, ArrowUp la réduit, aria-valuenow suit.
  const h0 = await mapHeight(page);
  await page.keyboard.press('ArrowDown');
  expect(await mapHeight(page)).toBeGreaterThan(h0);
  const nowAfterDown = parseInt(await ariaNow(page), 10);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => mapHeight(page)).toBe(h0);
  expect(parseInt(await ariaNow(page), 10)).toBeLessThan(nowAfterDown);

  // Home/End : extrêmes (carte minimale / maximale).
  await page.keyboard.press('End');
  const hMax = await mapHeight(page);
  await page.keyboard.press('Home');
  const hMin = await mapHeight(page);
  expect(hMax).toBeGreaterThan(hMin + 50);
  expect(parseInt(await ariaNow(page), 10)).toBeLessThan(30);
});
