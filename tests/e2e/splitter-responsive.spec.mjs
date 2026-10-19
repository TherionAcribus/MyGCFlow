// Repli responsive du mode latéral : sous ~1100 px de fenêtre le panneau
// latéral devient inutilisable (barre d'onglets réduite à ~50 px). Le
// layout retombe en bandeau — sans écraser le choix persisté, qui reprend
// le dessus au réélargissement (SIDEBAR_MIN_VIEWPORT_PX dans ui.js).
import { expect, test } from '@playwright/test';

const container = page => page.locator('#mapTabsContainer');
const resizer = page => page.locator('#mapTabsResizer');
const sidebarPreset = page => page.locator('#layoutPresets [data-layout="sidebar"]');
const modeKey = page => page.evaluate(() => localStorage.getItem('mapTabsLayoutMode'));

test('mode latéral : repli automatique en bandeau sous 1100 px', async ({ page }) => {
  // Un choix « sidebar » persisté simule un usage antérieur : c'est le cas
  // critique (le mode latéral se restaurait quelle que soit la largeur).
  await page.addInitScript(() => localStorage.setItem('mapTabsLayoutMode', 'sidebar'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // Fenêtre large : le mode latéral mémorisé est actif.
  await expect(container(page)).toHaveClass(/layout-sidebar/);
  await expect(resizer(page)).toHaveAttribute('aria-orientation', 'vertical');

  // 1024 px : repli en bandeau, le préréglage latéral disparaît, mais le
  // choix persisté reste « sidebar » (il reprendra au réélargissement).
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect(container(page)).not.toHaveClass(/layout-sidebar/);
  await expect(resizer(page)).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(sidebarPreset(page)).toBeHidden();
  expect(await modeKey(page)).toBe('sidebar');

  // 760 px : toujours en bandeau, la barre d'onglets reste entièrement
  // visible (plus de bande de ~50 px à défilement invisible).
  await page.setViewportSize({ width: 760, height: 700 });
  await expect(container(page)).not.toHaveClass(/layout-sidebar/);
  // Tous les onglets, quel qu'en soit le nombre (le compte en dur, 4, était
  // resté d'avant l'onglet Stats) : chacun visible et dans la barre.
  const tabs = page.locator('#mainTabs');
  const links = tabs.locator('.nav-link');
  expect(await links.count()).toBeGreaterThanOrEqual(4);
  const bar = await tabs.boundingBox();
  for (const link of await links.all()) {
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
  }

  // Réélargissement : le mode latéral mémorisé revient tout seul.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(container(page)).toHaveClass(/layout-sidebar/);
  await expect(resizer(page)).toHaveAttribute('aria-orientation', 'vertical');
  await expect(sidebarPreset(page)).toBeVisible();
});

test('mode latéral non mémorisé : le rétrécissement ne le restaure pas', async ({ page }) => {
  // Un utilisateur en bandeau explicite (« rows ») qui rétrécit puis
  // réélargit ne doit pas se retrouver propulsé en latéral.
  await page.addInitScript(() => localStorage.setItem('mapTabsLayoutMode', 'rows'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(container(page)).not.toHaveClass(/layout-sidebar/);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect(container(page)).not.toHaveClass(/layout-sidebar/);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(container(page)).not.toHaveClass(/layout-sidebar/);
});
