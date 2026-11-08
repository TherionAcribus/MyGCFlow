// Page « Statistiques » (/stats, docs/page-statistiques.md) : page sans
// carte, en-tête partagé, tableaux de bord de graphiques (lot 1 :
// trouvailles, période globale, galerie de questions, éditeur en phrase).
//
// Fixture tests/e2e/fixtures/my-finds.gpx : 6 trouvailles du 1ᵉʳ au
// 6 janvier 2026 (3 traditionnelles, 2 multis, 1 événement), toutes en
// France.
//
// Préférences globales partagées par tous les specs du run (AGENTS.md) :
// les tableaux de bord (`dashboards.json`) sont effacés avant chaque test et
// en sortie ; le thème est remis à sa valeur et sa persistance attendue.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

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
const savedDoc = async (request) => (await (await request.get('/api/dashboards')).json()).document;
const card = (page, id) => page.locator(`.stats-card[data-chart-id="${id}"]`);

async function cardAction(page, id, action) {
  await card(page, id).locator('.stats-card-menu [data-bs-toggle="dropdown"]').click();
  await card(page, id).locator(`[data-action="${action}"]`).click();
}

// ---------------------------------------------------------------------------
// Page et en-tête
// ---------------------------------------------------------------------------

test('le lien de l\'en-tête mène à la page Statistiques, sans carte', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  await page.locator('#linkStatsMode').click();
  await expect(page).toHaveURL(/\/stats$/);
  await page.waitForFunction(() => window.mygcflowStatsReady === true);

  await expect(page.locator('#linkStatsMode')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#linkMainMode')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#statsDashboard')).toBeVisible();
  await expect(page.locator('#map')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.ol)).toBe('undefined');

  await page.locator('#linkPosesMode').click();
  await expect(page).toHaveURL(/\/poses$/);
});

test('ECharts est servi en local et dessine avec la locale de l\'interface', async ({ page }) => {
  const errors = await openStats(page);
  const snap = await snapshot(page);
  expect(snap.echartsVersion).toBe('6.1.0');
  const lang = await page.evaluate(() => document.documentElement.lang);
  expect(snap.locale).toBe(lang.startsWith('fr') ? 'FR' : 'EN');
  expect(errors).toEqual([]);
});

test('le sélecteur d\'apparence de l\'en-tête fonctionne sur la page', async ({ page, request }) => {
  const errors = await openStats(page);
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
  // Les graphiques ont été redessinés aux couleurs de chaque thème sans erreur.
  expect(errors).toEqual([]);
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

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

test('première visite : un tableau de bord prêt à lire, enregistré', async ({ page, request }) => {
  const errors = await openStats(page);
  await expect(page.locator('#statsDashboard')).toBeVisible();
  const snap = await snapshot(page);
  expect(snap.rows).toBe(6);
  expect(snap.cards.map((c) => c.chart)).toEqual(['number', 'number', 'number', 'bar', 'area', 'line', 'donut', 'bar']);
  expect(snap.cards.every((c) => c.rendered)).toBe(true);
  await expect(page.locator('.stats-card')).toHaveCount(8);
  await expect(page.locator('.stats-number-value').first()).toHaveText('6');

  const byYear = snap.cards[3];
  expect(byYear.keys).toEqual([2026]);
  expect(byYear.series).toEqual([[6]]);
  const types = snap.cards[6];
  expect(types.keys).toEqual(['Traditional Cache', 'Multi-cache', 'Event Cache']);
  expect(types.series).toEqual([[3, 2, 1]]);
  await expect(page.locator('#statsDataNote')).toContainText('6');

  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.length).toBe(8);
  expect(errors).toEqual([]);
});

test('période globale : les graphiques suivent, sauf ceux qui ont la leur', async ({ page, request }) => {
  await openStats(page);
  // Le menu propose tout, les 12 derniers mois, l'année en cours et les
  // années des données.
  const labels = await page.locator('#statsGlobalPeriod option').allTextContents();
  expect(labels).toEqual(expect.arrayContaining(['Cette année', 'Ce mois-ci', 'Les 12 derniers mois']));
  await page.locator('#statsGlobalPeriod').selectOption({ label: 'Cette année' });
  await expect(page.locator('.stats-card').first().locator('.stats-number-caption')).toHaveText('Cette année');
  await expect(page.locator('.stats-number-value').first()).toHaveText('6');
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.period).toEqual({ kind: 'current', unit: 'year' });

  // Une année sans trouvaille (posée dans le document : le menu ne propose
  // que les années des données) : zéro et une note, sauf pour « Ma
  // meilleure année », qui porte sa propre période (tout l'historique).
  const doc = await savedDoc(request);
  doc.dashboards[0].period = { kind: 'year', year: 2025 };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  await expect(page.locator('#statsGlobalPeriod')).toHaveValue('{"kind":"year","year":2025}');
  await expect(page.locator('.stats-number-value').first()).toHaveText('0');
  await expect(page.locator('.stats-card').first().locator('.stats-card-note')).toBeVisible();
  const snap = await snapshot(page);
  expect(snap.cards[3].series).toEqual([[6]]);
  await expect(card(page, snap.cards[3].id).locator('.stats-card-period')).toBeVisible();
});

test('galerie : une question ajoute son graphique, qui survit au rechargement', async ({ page }) => {
  const errors = await openStats(page);
  await page.locator('#btnStatsAddChart').click();
  const gallery = page.locator('#statsGalleryModal');
  await expect(gallery).toBeVisible();
  await expect(gallery.locator('[data-question]')).toHaveCount(23);
  await expect(gallery.locator('.stats-gallery-heading')).toHaveCount(6);
  await gallery.locator('[data-question="weekdays"]').click();
  await expect(gallery).toBeHidden();

  await expect(page.locator('.stats-card')).toHaveCount(9);
  let snap = await snapshot(page);
  const added = snap.cards.at(-1);
  expect(added.groupBy).toBe('weekday');
  expect(added.keys).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(added.series[0].reduce((a, b) => a + b, 0)).toBe(6);

  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  snap = await snapshot(page);
  expect(snap.cards.length).toBe(9);
  expect(snap.cards.at(-1).id).toBe(added.id);
  expect(errors).toEqual([]);
});

test('éditeur : la phrase se recale, l\'aperçu suit, l\'enregistrement remplace le graphique', async ({ page, request }) => {
  const errors = await openStats(page);
  const first = (await snapshot(page)).cards[0];
  await cardAction(page, first.id, 'edit');
  const editor = page.locator('#statsEditorModal');
  await expect(editor).toBeVisible();

  // Jours de cache, au total : chiffre clé.
  await expect(page.locator('#statsEdTitle')).toHaveValue('Nombre de trouvailles');
  await page.locator('#statsEdMeasure').selectOption('distinct:days');
  await expect(page.locator('#statsEdPreviewNumber .stats-number-value')).toHaveText('6');
  // Le titre de la question ne décrit plus le graphique : il redevient
  // automatique (vide, le titre par défaut en indication).
  await expect(page.locator('#statsEdTitle')).toHaveValue('');
  await expect(page.locator('#statsEdPreviewTitle')).toHaveText('Jours de cache');

  // Un cumul n'accepte que des regroupements dans le temps.
  await page.locator('#statsEdMeasure').selectOption('cumulative:all');
  await expect(page.locator('#statsEdGroupBy option[value="cache_type"]')).toBeDisabled();
  await expect(page.locator('#statsEdGroupBy')).toHaveValue('month');

  // Par jour de la semaine, en barres.
  await page.locator('#statsEdMeasure').selectOption('count');
  await page.locator('#statsEdGroupBy').selectOption('weekday');
  await expect(page.locator('#statsEdChart option[value="number"]')).toHaveCount(0);
  await expect(page.locator('#statsEdChart')).toHaveValue('bar');
  await expect(page.locator('#statsEdPreview canvas')).toHaveCount(1);
  // Le chiffre clé devenu graphique quitte la petite taille.
  await expect(page.locator('#statsEdSize')).toHaveValue('M');
  await page.locator('#statsEdTitle').fill('Mes jours');
  await page.locator('#statsEdSize').selectOption('L');
  await page.locator('#btnStatsEdSave').click();
  await expect(editor).toBeHidden();

  const edited = (await snapshot(page)).cards[0];
  expect(edited.id).toBe(first.id);
  expect(edited).toMatchObject({ chart: 'bar', groupBy: 'weekday', measure: 'count', title: 'Mes jours', size: 'L' });
  await expect(card(page, first.id).locator('.stats-card-title')).toHaveText('Mes jours');
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.[0]?.spec?.groupBy).toBe('weekday');
  expect(errors).toEqual([]);
});

test('éditeur : annuler ne change rien', async ({ page }) => {
  await openStats(page);
  const before = (await snapshot(page)).cards[3];
  await cardAction(page, before.id, 'edit');
  await page.locator('#statsEdGroupBy').selectOption('weekday');
  await page.locator('#statsEditorModal [data-bs-dismiss="modal"]').last().click();
  await expect(page.locator('#statsEditorModal')).toBeHidden();
  const after = (await snapshot(page)).cards[3];
  expect(after.groupBy).toBe(before.groupBy);
});

test('graphique personnalisé depuis la galerie', async ({ page }) => {
  await openStats(page);
  await page.locator('#btnStatsAddChart').click();
  await page.locator('#statsGalleryModal [data-question="custom"]').click();
  await expect(page.locator('#statsEditorModal')).toBeVisible();
  await expect(page.locator('#statsEditorTitle')).toHaveText(/Nouveau graphique|New chart/);
  await page.locator('#statsEdGroupBy').selectOption('cache_type');
  await page.locator('#statsEdChart').selectOption('donut');
  await page.locator('#btnStatsEdSave').click();
  const added = (await snapshot(page)).cards.at(-1);
  expect(added).toMatchObject({ chart: 'donut', groupBy: 'cache_type' });
  expect(added.series).toEqual([[3, 2, 1]]);
});

test('supprimer, déplacer, dupliquer un graphique', async ({ page, request }) => {
  await openStats(page);
  let cards = (await snapshot(page)).cards;

  await cardAction(page, cards[1].id, 'before');
  let now = (await snapshot(page)).cards;
  expect(now.slice(0, 2).map((c) => c.id)).toEqual([cards[1].id, cards[0].id]);

  await cardAction(page, now[0].id, 'duplicate');
  now = (await snapshot(page)).cards;
  expect(now.length).toBe(9);
  expect(now[1].groupBy).toBe(now[0].groupBy);
  expect(now[1].id).not.toBe(now[0].id);

  const victim = now[2].id;
  await cardAction(page, victim, 'delete');
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect(card(page, victim)).toHaveCount(0);
  cards = (await snapshot(page)).cards;
  expect(cards.length).toBe(8);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.length).toBe(8);
});

test('exporter un graphique en image', async ({ page }) => {
  await openStats(page);
  const target = (await snapshot(page)).cards[3];
  const download = page.waitForEvent('download');
  await cardAction(page, target.id, 'export');
  expect((await download).suggestedFilename()).toBe(`${target.title}.png`);
});

test('renommer le tableau de bord', async ({ page, request }) => {
  await openStats(page);
  await page.locator('#btnStatsRename').click();
  await page.locator('#statsRenameInput').fill('  Mes années\nde cache ');
  await page.locator('#statsRenameForm button[type="submit"]').click();
  await expect(page.locator('#statsDashboardName')).toHaveText('Mes années de cache');
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.name).toBe('Mes années de cache');
});

// ---------------------------------------------------------------------------
// Comparer (lot 2)
// ---------------------------------------------------------------------------

// Pose un tableau de bord d'un seul graphique et ouvre la page.
async function openWithChart(page, request, spec, size = 'L') {
  const doc = { v: 1, active: 'aaaaaa', dashboards: [{ id: 'aaaaaa', name: 'Test', period: { kind: 'all' }, items: [{ size, spec: { id: 'c0ffee', ...spec } }] }] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  const errors = await openStats(page);
  return { errors, card: (await snapshot(page)).cards[0] };
}

test('« Suis-je en avance sur l\'an dernier ? » : deux cumuls superposés jour après jour', async ({ page }) => {
  const errors = await openStats(page);
  const ahead = (await snapshot(page)).cards[5];
  expect(ahead).toMatchObject({ chart: 'line', groupBy: 'day_of_year', measure: 'cumulative', align: 'calendar', toDate: false });
  expect(ahead.keys.length).toBe(366);
  expect(ahead.periods).toEqual(['2026 (en cours)', '2025']);
  // 2026 : 1 trouvaille le 1er janvier… 6 le 6 ; rien en 2025.
  expect(ahead.series[0].slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 6]);
  expect(ahead.series[1][0]).toBe(0);
  // Après aujourd'hui : pas de valeur pour l'année en cours.
  expect(ahead.series[0][365]).toBeNull();
  await expect(card(page, ahead.id).locator('.stats-card-period')).toHaveText('Cette année · La période précédente');
  expect(errors).toEqual([]);
});

test('éditeur : comparer à la période précédente, puis présenter en écart', async ({ page, request }) => {
  const { errors, card: target } = await openWithChart(page, request, { groupBy: 'month_of_year', view: { chart: 'bar' } });
  await cardAction(page, target.id, 'edit');
  await expect(page.locator('#statsEditorModal')).toBeVisible();
  await expect(page.locator('#statsEdCompareBlock')).toBeHidden();

  await page.locator('#statsEdPeriod').selectOption({ label: 'Cette année' });
  await page.locator('#btnStatsEdAddCompare').click();
  await expect(page.locator('#statsEdCompare0')).toHaveValue('{"kind":"previous"}');
  await expect(page.locator('#statsEdCompareBlock')).toBeVisible();
  await expect(page.locator('#statsEdLayout option')).toHaveCount(3);

  await page.locator('#statsEdToDate').uncheck();
  await page.locator('#statsEdLayout').selectOption('delta');
  await expect(page.locator('#statsEdPreview canvas')).toHaveCount(1);
  await page.locator('#btnStatsEdSave').click();

  const saved = (await snapshot(page)).cards[0];
  expect(saved.layout).toBe('delta');
  expect(saved.periods).toEqual(['2026 (en cours)', '2025']);
  // Janvier : 6 en 2026, 0 en 2025 → +6.
  expect(saved.delta[0]).toBe(6);
  expect(saved.delta[1]).toBe(0);
  // Mois à venir : pas d'écart.
  expect(saved.delta[11]).toBeNull();
  expect(errors).toEqual([]);
});

test('éditeur : retirer une comparaison revient à une seule période', async ({ page, request }) => {
  const { card: target } = await openWithChart(page, request, {
    groupBy: 'cache_type', periods: [{ kind: 'dashboard' }, { kind: 'previous' }], view: { chart: 'bar' },
  });
  expect(target.periods.length).toBe(1);   // « tout » n'a pas de période précédente
  await cardAction(page, target.id, 'edit');
  await expect(page.locator('#statsEdPeriod')).toHaveValue('');
  await expect(page.locator('#statsEdCompare0')).toBeVisible();
  await page.locator('[data-remove-compare="0"]').click();
  await expect(page.locator('#statsEdCompare0')).toHaveCount(0);
  await expect(page.locator('#statsEdCompareBlock')).toBeHidden();
  expect((await snapshot(page)).editor.spec.periods).toBeNull();
});

test('côte à côte : un repère par période, et chaque année en courbes', async ({ page, request }) => {
  const { errors, card: side } = await openWithChart(page, request, {
    groupBy: 'cache_type',
    periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }],
    compare: { layout: 'side' },
    view: { chart: 'bar' },
  });
  expect(side.grids).toBe(2);
  expect(side.series).toEqual([[3, 2, 1], [0, 0, 0]]);
  expect(side.toDate).toBe(true);
  await expect(card(page, side.id).locator('.stats-card-note')).toContainText('Comparaison à date');
  expect(errors).toEqual([]);
});

test('chiffre clé comparé : valeur, période précédente et écart', async ({ page, request }) => {
  const { card: number } = await openWithChart(page, request, {
    groupBy: 'none',
    periods: [{ kind: 'current', unit: 'year' }, { kind: 'previous' }],
    compare: { toDate: false },
    view: { chart: 'number' },
  }, 'M');
  expect(number.series).toEqual([[6], [0]]);
  const blocks = card(page, number.id).locator('.stats-number-block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first().locator('.stats-number-value')).toHaveText('6');
  await expect(blocks.first().locator('.stats-number-caption')).toHaveText('2026 (en cours)');
  await expect(blocks.first().locator('.stats-number-delta')).toHaveText(/\+6 par rapport à 2025/);
  await expect(blocks.first().locator('.stats-number-delta')).toHaveClass(/is-up/);
});

test('base vide : la page invite à importer ses trouvailles', async ({ page, request }) => {
  // Dernier test du fichier : vide la base (les specs suivants importent la
  // leur avec importGpx, qui gère la base vide).
  expect((await request.post('/clear_database')).ok()).toBeTruthy();
  const errors = await openStats(page);
  await expect(page.locator('#statsEmptyState')).toBeVisible();
  await expect(page.locator('#statsDashboard')).toBeHidden();
  await expect(page.locator('#statsEmptyState a[href="/"]')).toBeVisible();
  expect(errors).toEqual([]);
});
