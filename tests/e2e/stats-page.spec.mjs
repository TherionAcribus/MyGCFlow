// Page « Statistiques » (/stats) — lot 0 (MyGCFlow_Plan_Statistiques.md) :
// page sans carte, en-tête partagé avec les pages carte, ECharts servi en
// local avec ses libellés français.
//
// Le thème est une préférence globale du runtime partagé : le test qui le
// change le remet et attend la persistance (AGENTS.md, même famille que
// animation.camera_follow_mode).
import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

async function openStats(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/stats', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  return errors;
}

test('le lien de l\'en-tête mène à la page Statistiques, sans carte', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  await page.locator('#linkStatsMode').click();
  await expect(page).toHaveURL(/\/stats$/);
  await page.waitForFunction(() => window.mygcflowStatsReady === true);

  await expect(page.locator('#linkStatsMode')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#linkMainMode')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#statsEmptyState')).toBeVisible();
  await expect(page.locator('#map')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.ol)).toBe('undefined');

  // Retour à une page carte par le même en-tête.
  await page.locator('#linkPosesMode').click();
  await expect(page).toHaveURL(/\/poses$/);
});

test('ECharts est servi en local et dessine avec la locale de l\'interface', async ({ page }) => {
  const errors = await openStats(page);

  const snapshot = await page.evaluate(() => window.getStatsPageSnapshot());
  expect(snapshot.echartsVersion).toBe('6.1.0');
  const lang = await page.evaluate(() => document.documentElement.lang);
  expect(snapshot.locale).toBe(lang.startsWith('fr') ? 'FR' : 'EN');

  // Un graphique jetable : la bibliothèque et la locale enregistrée
  // fonctionnent hors de toute donnée.
  const drawn = await page.evaluate((locale) => {
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:300px';
    document.body.appendChild(host);
    const chart = window.echarts.init(host, null, { locale });
    chart.setOption({
      xAxis: { type: 'category', data: ['janv.', 'févr.'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [3, 5] }],
    });
    const option = chart.getOption();
    const canvas = host.querySelector('canvas');
    chart.dispose();
    host.remove();
    return { series: option.series.length, data: option.series[0].data, canvas: !!canvas };
  }, snapshot.locale);
  expect(drawn).toEqual({ series: 1, data: [3, 5], canvas: true });
  expect(errors).toEqual([]);
});

test('le sélecteur d\'apparence de l\'en-tête fonctionne sur la page', async ({ page, request }) => {
  await openStats(page);
  const select = page.locator('#appHeaderTheme');
  const original = await select.inputValue();

  try {
    await select.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expect(page.locator('#appHeaderThemeIcon')).toHaveClass(/ti-moon/);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).theme).toBe('dark');

    await select.selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  } finally {
    await select.selectOption(original);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).theme).toBe(original);
  }
});

test('« Quitter » demande confirmation puis remplace la page (app_quit.js)', async ({ page }) => {
  // Le bouton n'est rendu que sous launcher.py : on appelle le module
  // directement, et /api/quit est intercepté pour ne pas arrêter le serveur.
  let quitBody = null;
  await page.route('**/api/quit', async (route) => {
    quitBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await openStats(page);

  await page.evaluate(async () => (await import('/static/js/app_quit.js')).quitApp());
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toBeVisible();
  await modal.locator('[data-gcm-role="confirm"]').click();

  await expect(page.locator('body h2')).toHaveText(/^(MyGCFlow est fermé|MyGCFlow is closed)$/);
  expect(quitBody).toEqual({ force: false });
});

test('le lien Statistiques garde un nom accessible en fenêtre étroite', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await openStats(page);
  const link = page.locator('#linkStatsMode');
  await expect(link.locator('.app-mode-label')).toBeHidden();
  await expect(link).toHaveAttribute('aria-label', /^(Statistiques|Statistics)$/);
});
