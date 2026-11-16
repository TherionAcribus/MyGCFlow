// Thèmes de couleurs de la page Statistiques (MyGCFlow_Plan_Themes_Statistiques.md) :
// panneau « Couleurs », thème de la page et exception d'un tableau, thème
// personnel modifié avec aperçu, clair / sombre, types, partage.
//
// Préférences globales partagées (AGENTS.md) : tableaux de bord — et donc
// thèmes — effacés avant chaque test et en sortie.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Premières teintes des thèmes fournis (stats_theme_model.mjs).
const DEFAULT_LIGHT = '#2a78d6';
const PASTEL_LIGHT = '#6f9fd8';
const PASTEL_DARK = '#9cc3f0';
const VIVID_LIGHT = '#0062ff';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await importGpx(page, FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await context.close();
});

test.beforeEach(async ({ request }) => {
  expect((await request.delete('/api/dashboards')).ok()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.delete('/api/dashboards');
});

async function openStats(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/stats', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  return errors;
}

const snapshot = (page) => page.evaluate(() => window.getStatsPageSnapshot());
const colors = async (page) => (await snapshot(page)).colors;
const savedDoc = async (request) => (await (await request.get('/api/dashboards')).json()).document;

async function openPanel(page) {
  await page.locator('#btnStatsColors').click();
  await expect(page.locator('#statsColorsPanel')).toBeVisible();
  await expect.poll(async () => (await colors(page)).open).toBe(true);
}

// Une couleur est réellement dessinée : présente dans l'option ECharts
// d'un graphique du tableau.
async function chartUses(page, color) {
  return page.evaluate((wanted) => [...document.querySelectorAll('#statsGrid .stats-chart')].some((host) => {
    const chart = window.echarts.getInstanceByDom(host);
    return chart && JSON.stringify(chart.getOption()).toLowerCase().includes(wanted);
  }), color);
}

test('thème de la page, exception d\'un tableau, enregistrés et rechargés', async ({ page, request }) => {
  const errors = await openStats(page);
  expect((await colors(page)).series[0]).toBe(DEFAULT_LIGHT);
  await openPanel(page);
  // Toute la page en Pastel.
  await page.locator('#statsThemePage').selectOption('pastel');
  await expect.poll(async () => (await colors(page)).series[0]).toBe(PASTEL_LIGHT);
  await expect.poll(() => chartUses(page, PASTEL_LIGHT)).toBe(true);
  // Les chiffres clés lisent les variables CSS.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chart-series-1').trim()))
    .toBe(PASTEL_LIGHT);
  await expect.poll(async () => (await savedDoc(request)).theme).toBe('pastel');
  await expect(page.locator('#statsThemeList [data-theme-id="pastel"]')).toHaveClass(/is-shown/);

  // Ce tableau en Vives ; un second tableau suit la page.
  await page.locator('#statsThemeDashboard').selectOption('vivid');
  await expect.poll(async () => (await colors(page)).series[0]).toBe(VIVID_LIGHT);
  await expect.poll(async () => (await savedDoc(request)).dashboards[0].theme).toBe('vivid');
  await page.keyboard.press('Escape');
  await page.locator('#btnStatsDashboards').click();
  await page.locator('#statsDashboardMenu [data-action="duplicate-dashboard"]').click();
  // La copie garde l'exception de son modèle ; la remettre sur la page.
  await openPanel(page);
  await expect(page.locator('#statsThemeDashboard')).toHaveValue('vivid');
  await page.locator('#statsThemeDashboard').selectOption('');
  await expect.poll(async () => (await colors(page)).series[0]).toBe(PASTEL_LIGHT);
  await page.keyboard.press('Escape');

  // Retour au premier tableau : ses propres couleurs.
  const first = (await snapshot(page)).dashboards[0].id;
  await page.locator('#btnStatsDashboards').click();
  await page.locator(`#statsDashboardMenu [data-dashboard-id="${first}"]`).click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(VIVID_LIGHT);

  // Rechargement : tout est relu.
  await expect.poll(async () => (await snapshot(page)).save.dirty).toBe(false);
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  const after = await colors(page);
  expect(after.page).toBe('pastel');
  expect(after.dashboard).toBe('vivid');
  expect(after.series[0]).toBe(VIVID_LIGHT);
  expect(errors).toEqual([]);
});

test('clair / sombre : un thème fourni change de variante', async ({ page }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await page.locator('#statsThemePage').selectOption('pastel');
  await expect.poll(async () => (await colors(page)).series[0]).toBe(PASTEL_LIGHT);
  const lightHeat = (await colors(page)).heat;
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await expect.poll(async () => (await colors(page)).series[0]).toBe(PASTEL_DARK);
  expect((await colors(page)).heat).not.toEqual(lightHeat);
  await expect.poll(() => chartUses(page, PASTEL_DARK)).toBe(true);
  // Retour au Défaut en sombre : les valeurs de la feuille de style.
  await page.locator('#statsThemePage').selectOption('default');
  await expect.poll(async () => (await colors(page)).series[0]).toBe('#3987e5');
  expect(errors).toEqual([]);
});

test('thème personnel : modifié avec aperçu, avertissements, annulé, supprimé', async ({ page, request }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await page.locator('#btnStatsThemeNew').click();
  await expect(page.locator('#statsThemeEditor')).toBeVisible();
  const created = await colors(page);
  expect(created.themes).toHaveLength(1);
  expect(created.editing).toBe(created.themes[0].id);
  // Copie du thème affiché (Défaut), appliquée à la page.
  expect(created.page).toBe(created.themes[0].id);
  expect(created.series[0]).toBe(DEFAULT_LIGHT);
  await expect(page.locator('#statsThemeName')).toHaveValue('Mon thème');
  await expect(page.locator('#statsThemeApply')).toBeHidden();

  await page.locator('#statsThemeName').fill('Mes couleurs');
  await page.locator('#statsThemeSeries input[data-index="0"]').fill('#b03a2e');
  await expect.poll(async () => (await colors(page)).series[0]).toBe('#b03a2e');
  await expect.poll(() => chartUses(page, '#b03a2e')).toBe(true);
  await expect.poll(async () => (await savedDoc(request)).themes[0]).toMatchObject({ name: 'Mes couleurs', series: expect.arrayContaining(['#b03a2e']) });

  // Une teinte invisible sur fond clair est signalée.
  await expect(page.locator('#statsThemeWarnings')).toBeHidden();
  await page.locator('#statsThemeSeries input[data-index="1"]').fill('#ffffff');
  await expect(page.locator('#statsThemeWarnings')).toBeVisible();
  await expect(page.locator('#statsThemeWarnings')).toContainText('Teinte 2');

  // Dégradé : cinq couleurs libres.
  await page.locator('#statsThemeHeatCustom').check();
  await expect(page.locator('#statsThemeHeat input')).toHaveCount(5);
  await page.locator('#statsThemeHeat input[data-index="4"]').fill('#ff0000');
  await expect.poll(async () => (await colors(page)).heat[4]).toBe('#ff0000');

  // « Annuler les modifications » : retour à l'ouverture de l'éditeur.
  await page.locator('#btnStatsThemeRevert').click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(DEFAULT_LIGHT);
  await expect(page.locator('#statsThemeName')).toHaveValue('Mon thème');
  await expect(page.locator('#btnStatsThemeRevert')).toBeDisabled();

  // Fermer l'éditeur, puis supprimer : la page reprend le Défaut.
  await page.locator('#statsThemeSeries input[data-index="0"]').fill('#654321');
  await page.locator('#btnStatsThemeBack').click();
  await expect(page.locator('#statsThemeList')).toBeVisible();
  expect((await colors(page)).series[0]).toBe('#654321');
  const id = (await colors(page)).themes[0].id;
  await page.locator(`#statsThemeList [data-theme-id="${id}"] [data-theme-action="delete"]`).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(DEFAULT_LIGHT);
  await expect.poll(async () => (await savedDoc(request)).themes).toEqual([]);
  expect((await savedDoc(request)).theme).toBeNull();
  expect(errors).toEqual([]);
});

test('dupliquer un thème non appliqué : aperçu, puis « À ce tableau seulement »', async ({ page, request }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await page.locator('#statsThemeList [data-theme-id="ocean"] [data-theme-action="duplicate"]').click();
  await expect(page.locator('#statsThemeEditor')).toBeVisible();
  await expect(page.locator('#statsThemeName')).toHaveValue('Océan (copie)');
  // Aperçu : le tableau montre le thème modifié, sans l'adopter.
  const preview = await colors(page);
  expect(preview.series[0]).toBe('#005f99');
  expect(preview.page).toBeNull();
  await expect(page.locator('#statsThemeApply')).toBeVisible();
  // Sortie sans appliquer : retour au Défaut.
  await page.locator('#btnStatsThemeBack').click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(DEFAULT_LIGHT);
  // Réouverture, puis application au tableau seul.
  const id = (await colors(page)).themes[0].id;
  await page.locator(`#statsThemeList [data-theme-id="${id}"] [data-theme-action="edit"]`).click();
  await page.locator('#statsThemeApply [data-apply="dashboard"]').click();
  await expect(page.locator('#statsThemeApply')).toBeHidden();
  await page.locator('#btnStatsThemeBack').click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe('#005f99');
  await expect.poll(async () => (await savedDoc(request)).dashboards[0].theme).toBe(id);
  expect((await savedDoc(request)).theme).toBeNull();
  expect(errors).toEqual([]);
});

test('types de caches : une couleur choisie dans le thème', async ({ page }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await page.locator('#btnStatsThemeNew').click();
  expect((await colors(page)).typeColors).toBeNull();
  await page.locator('#statsThemeTypesCustom').check();
  await expect(page.locator('#statsThemeTypes')).toBeVisible();
  await page.locator('#statsThemeTypes input[data-index="Traditional Cache"]').fill('#aa5500');
  await expect.poll(async () => (await colors(page)).typeColors?.['Traditional Cache']).toBe('#aa5500');
  // Le graphique par type de la fixture (Traditional) prend la couleur.
  await expect.poll(() => chartUses(page, '#aa5500')).toBe(true);
  await page.locator('#statsThemeTypesCustom').uncheck();
  await expect.poll(async () => (await colors(page)).typeColors).toBeNull();
  expect(errors).toEqual([]);
});

test('un tableau exporté emporte son thème personnel', async ({ page, request }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await page.locator('#btnStatsThemeNew').click();
  await page.locator('#statsThemeName').fill('Partagé');
  await page.locator('#statsThemeSeries input[data-index="0"]').fill('#0a0b0c');
  await page.locator('#btnStatsThemeBack').click();
  // Nouveau thème = thème de la page ; seule l'exception d'un tableau
  // voyage avec lui : la poser.
  await page.locator('#statsThemeDashboard').selectOption((await colors(page)).themes[0].id);
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await page.locator('#btnStatsDashboards').click();
  await page.locator('#statsDashboardMenu [data-action="export-dashboard"]').click();
  const file = await (await download).path();
  const fs = await import('node:fs');
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(content.dashboard.theme).toMatchObject({ name: 'Partagé', series: expect.arrayContaining(['#0a0b0c']) });
  expect(content.dashboard.theme.id).toBeUndefined();

  // Autre installation : document vide, import du fichier.
  expect((await request.delete('/api/dashboards')).ok()).toBeTruthy();
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  expect((await colors(page)).themes).toEqual([]);
  await page.locator('#statsImportInput').setInputFiles(file);
  await expect.poll(async () => (await colors(page)).series[0]).toBe('#0a0b0c');
  const after = await colors(page);
  expect(after.themes).toEqual([{ id: after.dashboard, name: 'Partagé' }]);
  expect(errors).toEqual([]);
});
