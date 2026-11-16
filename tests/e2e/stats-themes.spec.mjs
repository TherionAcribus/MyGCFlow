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

test('clic sur un thème de la liste : appliqué à la page, ou au tableau s\'il a le sien', async ({ page, request }) => {
  const errors = await openStats(page);
  await openPanel(page);
  await expect(page.locator('#statsThemeListHint')).toContainText('toute la page');
  await page.locator('#statsThemeList [data-theme-id="pastel"] [data-theme-action="pick"]').click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(PASTEL_LIGHT);
  await expect(page.locator('#statsThemePage')).toHaveValue('pastel');
  await expect(page.locator('#statsThemeList [data-theme-id="pastel"] [data-theme-action="pick"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await savedDoc(request)).theme).toBe('pastel');
  // Le tableau a ses propres couleurs : le clic les remplace, la page garde les siennes.
  await page.locator('#statsThemeDashboard').selectOption('vivid');
  await expect(page.locator('#statsThemeListHint')).toContainText('ce tableau de bord');
  await page.locator('#statsThemeList [data-theme-id="ocean"] [data-theme-action="pick"]').click();
  await expect.poll(async () => (await colors(page)).series[0]).toBe('#005f99');
  await expect(page.locator('#statsThemeDashboard')).toHaveValue('ocean');
  await expect.poll(async () => (await savedDoc(request)).dashboards[0].theme).toBe('ocean');
  expect((await savedDoc(request)).theme).toBe('pastel');
  // Défaut cliqué pour la page : rien n'est posé (null).
  await page.locator('#statsThemeDashboard').selectOption('');
  await page.locator('#statsThemeList [data-theme-id="default"] [data-theme-action="pick"]').click();
  await expect.poll(async () => (await savedDoc(request)).theme).toBeNull();
  await expect.poll(async () => (await colors(page)).series[0]).toBe(DEFAULT_LIGHT);
  expect(errors).toEqual([]);
});

test('allure : barres, cartes et pastilles des périodes changent avec le thème', async ({ page }) => {
  const errors = await openStats(page);
  const look = () => page.evaluate(() => {
    const card = document.querySelector('#statsGrid .stats-card');
    const style = getComputedStyle(card);
    const badge = document.querySelector('#statsGrid .stats-card-period');
    const bars = [...document.querySelectorAll('#statsGrid .stats-chart')]
      .map((host) => window.echarts.getInstanceByDom(host)?.getOption().series?.find((s) => s.type === 'bar'))
      .find(Boolean);
    return {
      bandWidth: style.borderTopWidth,
      radius: style.borderTopLeftRadius,
      badge: badge ? getComputedStyle(badge).backgroundColor : null,
      barWidth: bars?.barMaxWidth ?? null,
      barRadius: bars?.itemStyle?.borderRadius ?? null,
    };
  });
  const before = await look();
  expect(before).toMatchObject({ bandWidth: '1px', radius: '12px', barWidth: 24 });
  await openPanel(page);
  await page.locator('#statsThemeList [data-theme-id="vivid"] [data-theme-action="pick"]').click();
  await expect.poll(async () => (await look()).bandWidth).toBe('4px');
  const vivid = await look();
  expect(vivid.radius).toBe('4px');
  expect(vivid.barWidth).toBe(40);
  expect(vivid.barRadius).toEqual([0, 0, 0, 0]);
  expect(vivid.badge).not.toBe(before.badge);
  // Pastel : barres en pilule, cartes teintées (fond des graphiques compris).
  await page.locator('#statsThemeList [data-theme-id="pastel"] [data-theme-action="pick"]').click();
  await expect.poll(async () => (await look()).radius).toBe('20px');
  expect((await look()).barRadius).toEqual([100, 100, 0, 0]);
  const surface = (await snapshot(page)).colors;
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--stats-card-bg').trim())).not.toBe('');
  expect(surface.series[0]).toBe(PASTEL_LIGHT);
  // Retour au Défaut : tout revient.
  await page.locator('#statsThemeList [data-theme-id="default"] [data-theme-action="pick"]').click();
  await expect.poll(look).toEqual(before);

  // Thème personnel : l'allure se règle dans l'éditeur.
  await page.locator('#btnStatsThemeNew').click();
  await page.locator('#statsThemeLook select[data-look="cards"]').selectOption('band');
  await page.locator('#statsThemeLook select[data-look="bars"]').selectOption('pill');
  await expect.poll(async () => (await look()).bandWidth).toBe('4px');
  expect((await look()).barRadius).toEqual([100, 100, 0, 0]);
  await page.locator('#statsThemeAccentCustom').check();
  await page.locator('#statsThemeAccent input').fill('#c2185b');
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.querySelector('#statsGrid .stats-card')).borderTopColor))
    .toBe('rgb(194, 24, 91)');
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Fond des exports : comme l'écran, clair ou sombre (préférence locale)
// ---------------------------------------------------------------------------

const DARK_SURFACE = '#1b2635';

async function pickExportBackground(page, value) {
  await page.locator('#btnStatsShare').click();
  await page.locator(`#statsShareMenu [data-action="export-background"][data-value="${value}"]`).click();
  await expect.poll(async () => (await colors(page)).exportBackground).toBe(value);
}

test('fond des exports : l\'image du tableau sort en sombre sans toucher l\'écran', async ({ page }) => {
  const errors = await openStats(page);
  expect((await colors(page)).exportBackground).toBe('screen');
  await pickExportBackground(page, 'dark');
  // Le choix coché dans le menu.
  await page.locator('#btnStatsShare').click();
  await expect(page.locator('#statsShareMenu [data-value="dark"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#statsShareMenu [data-value="screen"]')).toHaveAttribute('aria-checked', 'false');
  // Mutations de <html> pendant l'export : la bascule et le retour seulement.
  await page.evaluate(() => {
    window.__modeSwitches = [];
    new MutationObserver((records) => records.forEach(() => window.__modeSwitches.push(document.documentElement.getAttribute('data-bs-theme'))))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
  });
  const download = page.waitForEvent('download');
  await page.locator('#statsShareMenu [data-action="image-dashboard"]').click();
  await download;
  const image = (await snapshot(page)).image;
  // Fond de page sombre de l'app.
  expect(image.background).not.toBe('rgb(255, 255, 255)');
  expect(image.background).not.toBe('rgb(245, 247, 251)');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  // L'écran reste clair, ses graphiques n'ont pas été redessinés en sombre.
  const after = await colors(page);
  expect(after.mode).toBe('light');
  expect(after.series[0]).toBe(DEFAULT_LIGHT);
  expect(await page.evaluate(() => window.__modeSwitches)).toEqual(['dark', 'light']);

  // « Clair » depuis un écran sombre : fond blanc des cartes.
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await pickExportBackground(page, 'light');
  const second = page.waitForEvent('download');
  await page.locator('#btnStatsShare').click();
  await page.locator('#statsShareMenu [data-action="image-dashboard"]').click();
  await second;
  expect((await snapshot(page)).image.background).not.toBe(image.background);
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  // Préférence gardée au rechargement (navigateur).
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  expect((await colors(page)).exportBackground).toBe('light');
  expect(errors).toEqual([]);
});

test('fond des exports : PNG d\'un graphique et vidéo dans le mode choisi', async ({ page }) => {
  const errors = await openStats(page);
  await pickExportBackground(page, 'dark');
  // PNG d'une carte : coin de l'image au fond sombre des cartes.
  const target = (await snapshot(page)).cards.find((c) => c.chart === 'bar');
  const download = page.waitForEvent('download');
  const menu = page.locator(`.stats-card[data-chart-id="${target.id}"] .stats-card-menu`);
  await menu.locator('[data-bs-toggle="dropdown"]').click();
  await menu.locator('.dropdown-submenu > .dropdown-item').click();
  await menu.locator('[data-action="export"]').click();
  const file = await (await download).path();
  const fs = await import('node:fs');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const corner = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    return [...g.getImageData(2, 2, 1, 1).data.slice(0, 3)];
  }, dataUrl);
  expect(corner).toEqual([0x1b, 0x26, 0x35]);
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');

  // Vidéo du tableau : le menu « Fond » de la fenêtre reprend le réglage.
  await page.locator('#btnStatsShare').click();
  await page.locator('#statsShareMenu [data-action="video-dashboard"]').click();
  await expect(page.locator('#statsVideoModal')).toBeVisible();
  await expect(page.locator('#statsVideoBackground')).toHaveValue('dark');
  await page.locator('#btnStatsVideoPreview').click();
  await expect.poll(async () => (await snapshot(page)).video.surface).toBe(DARK_SURFACE);
  await page.locator('#btnStatsVideoStopPreview').click();
  // Changé dans la fenêtre : vaut aussi pour les images.
  await page.locator('#statsVideoBackground').selectOption('screen');
  expect((await colors(page)).exportBackground).toBe('screen');
  await page.locator('#btnStatsVideoPreview').click();
  await expect.poll(async () => (await snapshot(page)).video.surface).toBe('#ffffff');
  await page.locator('#btnStatsVideoStopPreview').click();
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  expect(errors).toEqual([]);
});
