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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { importGpx } from './gpx-import.mjs';
import { openDataSubTab } from './data-subtabs.mjs';
import { wavFile } from './wav.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
// Logs fictifs de Mes poses (compte 1234567) : 7 caches posées, 12
// trouvailles reçues dont 3 avec un favori.
const LOGS_FIXTURE = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-poses.json');
// Jeu Évolution : 6 caches publiées, archivées le 6/1/2020 (GC1A02) et le
// 8/1/2020 (GC1A05), une archivée sans date (GC1A03) → 3 actives.
const EVOLUTION_FIXTURE = path.join(HERE, 'fixtures', 'evolution-a.csv');

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
  // Questions de la famille « Mes données » seulement (pas celles d'Évolution).
  await expect(gallery.locator('[data-question]')).toHaveCount(50);
  await expect(gallery.locator('.stats-gallery-heading')).toHaveCount(12);
  await expect(gallery.locator('[data-question^="evo_"]')).toHaveCount(0);
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

// ---------------------------------------------------------------------------
// Graphisme et filtres (lot 3)
// ---------------------------------------------------------------------------

// Menu Tom Select ouvert hors de la modale (rattaché à <body>) : on l'ouvre
// par son API, on clique l'option par sa valeur, on le referme.
async function pickFilter(page, selectId, value) {
  await page.locator(`#${selectId}`).evaluate((el) => el.tomselect.open());
  await page.locator(`.ts-dropdown:visible .option[data-value="${value}"]`).click();
  await page.locator(`#${selectId}`).evaluate((el) => el.tomselect.close());
}

test('filtres du tableau de bord : appliqués partout, résumés en pastilles, retirables', async ({ page, request }) => {
  const errors = await openStats(page);
  await page.locator('#btnStatsFilters').click();
  await expect(page.locator('#statsFiltersModal')).toBeVisible();
  // Champs à une seule valeur (pays, source…) masqués ; types proposés avec leur nombre.
  await expect(page.locator('#statsFilter-country')).toHaveCount(0);
  await expect(page.locator('#statsFilter-cache_type option[value="Traditional Cache"]')).toHaveText('Traditional Cache (3)');
  await pickFilter(page, 'statsFilter-cache_type', 'Traditional Cache');
  await page.locator('#btnStatsFiltersApply').click();
  await expect(page.locator('#statsFiltersModal')).toBeHidden();

  await expect(page.locator('.stats-number-value').first()).toHaveText('3');
  await expect(page.locator('#statsFiltersCount')).toHaveText('1');
  await expect(page.locator('.stats-filter-chip')).toHaveText(/Type de cache : Traditional Cache/);
  await expect(page.locator('#statsDataNote')).toContainText('3 avec les filtres');
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.filters)
    .toEqual({ cache_type: ['Traditional Cache'] });

  await page.locator('.stats-filter-chip [data-remove-filter="cache_type"]').click();
  await expect(page.locator('.stats-number-value').first()).toHaveText('6');
  await expect(page.locator('#statsFiltersSummary')).toBeHidden();
  expect(errors).toEqual([]);
});

test('filtres propres à un graphique : partent de ceux du tableau, ignorent les suivants', async ({ page, request }) => {
  const errors = await openStats(page);
  const target = (await snapshot(page)).cards[0];
  await cardAction(page, target.id, 'edit');
  await page.locator('#statsEdFiltersSection summary').click();
  await page.locator('#statsEdFilterMode').selectOption('own');
  await expect(page.locator('#statsEdFilter-cache_type')).toBeAttached();
  await pickFilter(page, 'statsEdFilter-cache_type', 'Multi-cache');
  await expect(page.locator('#statsEdPreviewNumber .stats-number-value')).toHaveText('2');
  await expect(page.locator('#statsEdFiltersBadge')).toHaveText('1');
  await page.locator('#btnStatsEdSave').click();
  await expect(page.locator('#statsEditorModal')).toBeHidden();

  const saved = (await snapshot(page)).cards[0];
  expect(saved.filters).toEqual({ cache_type: ['Multi-cache'] });
  expect(saved.series).toEqual([[2]]);
  await expect(card(page, target.id).locator('.stats-card-filter')).toBeVisible();

  // Un filtre du tableau de bord ne le touche pas.
  const doc = await savedDoc(request);
  doc.dashboards[0].filters = { cache_type: ['Event Cache'] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  await page.reload();
  await page.waitForFunction(() => window.mygcflowStatsReady === true);
  const cards = (await snapshot(page)).cards;
  expect(cards[0].series).toEqual([[2]]);
  expect(cards[1].series).toEqual([[1]]);
  expect(errors).toEqual([]);
});

test('2ᵉ dimension : par année découpé par type, empilé', async ({ page }) => {
  const errors = await openStats(page);
  const target = (await snapshot(page)).cards[3];
  await cardAction(page, target.id, 'edit');
  await expect(page.locator('#statsEdSplitRow')).toBeVisible();
  await page.locator('#statsEdSplitBy').selectOption('cache_type');
  await page.locator('#statsEdOptions summary').click();
  await expect(page.locator('#statsEdStackRow')).toBeVisible();
  await page.locator('#statsEdStack').check();
  await page.locator('#btnStatsEdSave').click();
  const saved = (await snapshot(page)).cards[3];
  expect(saved.splitBy).toBe('cache_type');
  expect(saved.series).toEqual([[3], [2], [1]]);
  expect(errors).toEqual([]);
});

test('grille D/T, calendrier et radar se dessinent', async ({ page, request }) => {
  let { errors, card: grid } = await openWithChart(page, request, { groupBy: 'dt', view: { chart: 'heatmap' } });
  expect(grid.chart).toBe('heatmap');
  expect(grid.rendered).toBe(true);
  expect(grid.keys.length).toBe(6);
  expect(errors).toEqual([]);

  ({ errors, card: grid } = await openWithChart(page, request, {
    groupBy: 'day', periods: [{ kind: 'current', unit: 'year' }], view: { chart: 'calendar' },
  }));
  expect(grid.chart).toBe('calendar');
  // Une année : un bandeau de 7 cases carrées, la hauteur suit
  // (40 + 7 × case + 38, case entre 8 et 18 px selon la largeur).
  const cell = (Math.round(grid.height) - 78) / 7;
  expect(Number.isInteger(cell) && cell >= 8 && cell <= 18).toBe(true);
  expect(errors).toEqual([]);

  ({ errors, card: grid } = await openWithChart(page, request, { groupBy: 'weekday', view: { chart: 'radar' } }));
  expect(grid.chart).toBe('radar');
  expect(grid.keys.length).toBe(7);
  expect(errors).toEqual([]);
});

test('éditeur : la palette se choisit pour des barres d\'une série', async ({ page, request }) => {
  const { card: target } = await openWithChart(page, request, { groupBy: 'container', view: { chart: 'bar' } }, 'M');
  await cardAction(page, target.id, 'edit');
  await page.locator('#statsEdOptions summary').click();
  await expect(page.locator('#statsEdPaletteRow')).toBeVisible();
  await expect(page.locator('#statsEdPalette option')).toHaveCount(4);
  await page.locator('#statsEdPalette').selectOption('heat');
  await page.locator('#btnStatsEdSave').click();
  const doc = await savedDoc(request);
  expect(doc.dashboards[0].items[0].spec.view.palette).toBe('heat');
});

// ---------------------------------------------------------------------------
// Toutes les sources (lot 4)
// ---------------------------------------------------------------------------

async function waitTask(request, taskId) {
  await expect.poll(async () => (await (await request.get(`/tasks/${taskId}`)).json()).state,
    { timeout: 30_000 }).toBe('finished');
}

// Les logs vivent hors de /clear_database : vidés en entrée et en sortie.
async function clearLogs(request) {
  expect((await request.post('/api/logs/clear')).ok()).toBeTruthy();
}

async function importPosesLogs(request) {
  await clearLogs(request);
  const preview = await request.post('/api/logs/import/preview', {
    multipart: { file: { name: 'logs-poses.json', mimeType: 'application/json', buffer: fs.readFileSync(LOGS_FIXTURE) } },
  });
  expect(preview.ok()).toBeTruthy();
  const { import_token: token } = await preview.json();
  const commit = await request.post('/api/logs/import/commit', { data: { import_token: token } });
  expect(commit.status()).toBe(202);
  await waitTask(request, (await commit.json()).task_id);
}

async function deleteAllDatasets(request) {
  const res = await request.get('/api/evolution/datasets');
  for (const dataset of (await res.json()).datasets) {
    expect((await request.delete(`/api/evolution/datasets/${dataset.id}`)).ok()).toBeTruthy();
  }
}

async function createDataset(request, name) {
  const created = await request.post('/api/evolution/datasets', { data: { name } });
  expect(created.status()).toBe(201);
  const { dataset } = await created.json();
  const imported = await request.post(`/api/evolution/datasets/${dataset.id}/import`, {
    multipart: { files: { name: 'evolution-a.csv', mimeType: 'text/csv', buffer: fs.readFileSync(EVOLUTION_FIXTURE) } },
  });
  expect(imported.status()).toBe(202);
  await waitTask(request, (await imported.json()).task_id);
  return dataset.id;
}

test('Mes poses : trouvailles et favoris reçus, comparés à mes trouvailles', async ({ page, request }) => {
  await importPosesLogs(request);
  try {
    let { errors, card: received } = await openWithChart(page, request, {
      source: 'poses.received', groupBy: 'none', view: { chart: 'number' },
    }, 'M');
    const snap = await snapshot(page);
    expect(snap.sources['poses.received']).toBe(12);
    expect(snap.sources['poses.favorites']).toBe(3);
    expect(received.series).toEqual([[12]]);
    await expect(card(page, received.id).locator('.stats-card-title')).toHaveText('Trouvailles reçues');
    await expect(page.locator('#statsDataNote')).toContainText('12 trouvailles reçues');

    // Éditeur : six sources personnelles, aucune source Évolution ; une 2ᵉ
    // source s'ajoute (mes trouvailles).
    await cardAction(page, received.id, 'edit');
    await expect(page.locator('#statsEdSource option')).toHaveCount(6);
    await expect(page.locator('#statsEdSource option[value^="evolution"]')).toHaveCount(0);
    await page.locator('#statsEdSource').selectOption('poses.favorites');
    await expect(page.locator('#statsEdPreviewNumber .stats-number-value')).toHaveText('3');
    await page.locator('#statsEdSource').selectOption('finds');
    await page.locator('#btnStatsEdAddSource').click();
    await page.locator('#statsEdExtraSource0').selectOption('poses.received');
    await expect(page.locator('#statsEdPreviewNumber .stats-number-block')).toHaveCount(2);
    await expect(page.locator('#statsEdPreviewNumber .stats-number-delta')).toHaveText(/−6 \(-50\s?%\) par rapport aux trouvailles reçues/);
    await page.locator('#btnStatsEdSave').click();
    const saved = (await snapshot(page)).cards[0];
    expect(saved.extraSources).toEqual(['poses.received']);
    expect(saved.seriesSources).toEqual(['finds', 'poses.received']);
    expect(saved.series).toEqual([[6], [12]]);

    // Mes visiteurs : une dimension propre à Mes poses.
    ({ card: received } = await openWithChart(page, request, {
      source: 'poses.received', groupBy: 'finder', view: { chart: 'bar', orientation: 'horizontal' },
    }));
    expect(received.keys.length).toBeGreaterThan(1);
    expect(received.series[0].reduce((a, b) => a + b, 0)).toBe(12);
    expect(errors).toEqual([]);
  } finally {
    await clearLogs(request);
  }
});

test('Évolution : un tableau à part, lié à son jeu, sans sources personnelles', async ({ page, request }) => {
  await deleteAllDatasets(request);
  const datasetId = await createDataset(request, 'Zone de test');
  try {
    const errors = await openStats(page);
    await page.locator('#btnStatsDashboards').click();
    await page.locator('#statsDashboardMenu [data-action="new-dashboard"]').click();
    const modal = page.locator('#statsNewDashboardModal');
    await expect(modal).toBeVisible();
    await page.locator('#statsNewKindEvolution').check();
    await expect(page.locator('#statsNewDataset')).toHaveValue(String(datasetId));
    await expect(page.locator('#statsNewName')).toHaveValue('Zone de test');
    await page.locator('#btnStatsNewDashboardCreate').click();
    await expect(modal).toBeHidden();

    let snap = await snapshot(page);
    expect(snap.dashboard).toMatchObject({ kind: 'evolution', dataset: datasetId, name: 'Zone de test' });
    expect(snap.cards.length).toBe(5);
    expect(snap.cards.every((c) => c.source.startsWith(`evolution:${datasetId}`))).toBe(true);
    // Caches actives : 3 ; publications et archivages datés par année (2020).
    expect(snap.cards[0].series).toEqual([[3]]);
    expect(snap.cards[2].seriesSources).toEqual([`evolution:${datasetId}`, `evolution:${datasetId}:archived`]);
    expect(snap.cards[2].series).toEqual([[6], [2]]);
    await expect(page.locator('#statsDashboardKind')).toHaveText('Évolution · Zone de test');
    await expect(page.locator('#statsDataNote')).toContainText('6 caches publiées');

    // Galerie et éditeur : seulement ce qui concerne la zone.
    await page.locator('#btnStatsAddChart').click();
    await expect(page.locator('#statsGalleryModal [data-question^="evo_"]')).toHaveCount(11);
    await expect(page.locator('#statsGalleryModal [data-question="total"]')).toHaveCount(0);
    await page.locator('#statsGalleryModal [data-question="custom"]').click();
    await expect(page.locator('#statsEdSource option')).toHaveCount(2);
    await expect(page.locator('#statsEdSource option[value="finds"]')).toHaveCount(0);
    await page.locator('#statsEditorModal [data-bs-dismiss="modal"]').last().click();

    // Retour au tableau personnel par le menu.
    await page.locator('#btnStatsDashboards').click();
    await page.locator(`#statsDashboardMenu [data-dashboard-id="${snap.dashboards[0].id}"]`).click();
    await expect.poll(async () => (await snapshot(page)).dashboard.kind).toBe('personal');

    // Barrière à la lecture : un graphique Évolution posé dans un tableau
    // personnel est écarté.
    const doc = await savedDoc(request);
    doc.dashboards[0].items.push({ size: 'M', spec: { source: `evolution:${datasetId}`, groupBy: 'year' } });
    expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => window.mygcflowStatsReady === true);
    snap = await snapshot(page);
    expect(snap.cards.every((c) => !c.source.startsWith('evolution'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await deleteAllDatasets(request);
  }
});

// ---------------------------------------------------------------------------
// Sources indisponibles : expliquer, relancer (jamais un faux zéro)
// ---------------------------------------------------------------------------

test('une source en échec : la carte explique et « Réessayer » recharge', async ({ page, request }) => {
  let fail = true;
  await page.route('**/api/stats/dnf', async (route) => {
    if (fail) return route.abort();
    return route.fulfill({ json: { features: [{ type: 'Feature', geometry: null, properties: {
      source_kind: 'dnf', record_uid: 'dnf:GC1ABCD', gc_code: 'GC1ABCD', name: 'Sans issue',
      cache_type: 'Traditional Cache', date_find: '2024-03-05', dnf_dates: ['2024-03-05'],
      found: false } }], logs: 1 } });
  });
  const { errors, card: target } = await openWithChart(page, request, { source: 'dnf', groupBy: 'year' });
  const me = card(page, target.id);
  await expect(me.locator('.stats-card-unavailable')).toBeVisible();
  await expect(me.locator('.stats-card-unavailable')).toContainText('Mes DNF');
  await expect(page.locator('#statsDataNote')).toContainText('données indisponibles');
  let snap = await snapshot(page);
  expect(snap.sourceErrors).toEqual(['dnf']);
  expect(snap.cards[0].unavailable).toEqual(['dnf']);
  expect(snap.cards[0].series).toBeNull();

  fail = false;
  await me.locator('.stats-card-retry').click();
  await expect(me.locator('.stats-chart')).toBeVisible();
  snap = await snapshot(page);
  expect(snap.sourceErrors).toEqual([]);
  expect(snap.cards[0].unavailable).toBeNull();
  expect(snap.cards[0].series).toEqual([[1]]);
  await expect(page.locator('#statsDataNote')).toContainText('1 DNF');
  expect(errors).toEqual([]);
});

test('un jeu Évolution en erreur (≠ 404) est relançable', async ({ page, request }) => {
  await deleteAllDatasets(request);
  const datasetId = await createDataset(request, 'Zone de test');
  try {
    let fail = true;
    await page.route(`**/api/evolution/datasets/${datasetId}/data`, async (route) => {
      if (fail) return route.fulfill({ status: 500, json: { error: 'x' } });
      return route.continue();
    });
    const doc = { v: 1, active: 'e1', dashboards: [{ id: 'e1', name: 'Zone', kind: 'evolution',
      dataset: datasetId, period: { kind: 'all' }, items: [
        { size: 'M', spec: { id: 'c0ff01', source: `evolution:${datasetId}`, groupBy: 'year' } }] }] };
    expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
    const errors = await openStats(page);
    const snap = await snapshot(page);
    expect(snap.sourceErrors).toContain(`evolution:${datasetId}`);
    expect(snap.cards[0].unavailable).toContain(`evolution:${datasetId}`);
    // Erreur temporaire : pas « n'existe plus », pas de comptes nuls.
    await expect(page.locator('#statsDataNote')).toContainText('indisponibles');
    await expect(page.locator('#statsDataNote')).not.toContainText("n'existe plus");

    fail = false;
    await card(page, snap.cards[0].id).locator('.stats-card-retry').click();
    await expect.poll(async () => (await snapshot(page)).sourceErrors).toEqual([]);
    expect((await snapshot(page)).cards[0].series).not.toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await deleteAllDatasets(request);
  }
});

test('un jeu supprimé (404) dit « n\'existe plus », sans bloc de relance', async ({ page, request }) => {
  await deleteAllDatasets(request);
  const datasetId = await createDataset(request, 'Zone de test');
  try {
    await page.route(`**/api/evolution/datasets/${datasetId}/data`,
      (route) => route.fulfill({ status: 404, json: { error: 'x' } }));
    const doc = { v: 1, active: 'e1', dashboards: [{ id: 'e1', name: 'Zone', kind: 'evolution',
      dataset: datasetId, period: { kind: 'all' }, items: [
        { size: 'M', spec: { id: 'c0ff01', source: `evolution:${datasetId}`, groupBy: 'year' } }] }] };
    expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
    await openStats(page);
    const snap = await snapshot(page);
    expect(snap.sourceErrors).toEqual([]);
    expect(snap.cards[0].unavailable).toBeNull();
    await expect(page.locator('#statsDataNote')).toContainText("n'existe plus");
    await expect(card(page, snap.cards[0].id).locator('.stats-card-retry')).toHaveCount(0);
  } finally {
    await deleteAllDatasets(request);
  }
});

// ---------------------------------------------------------------------------
// Performance : cache de résultats, cartes réutilisées, dessin différé
// ---------------------------------------------------------------------------

test('grand tableau : les cartes lointaines se dessinent au défilement', async ({ page, request }) => {
  const items = Array.from({ length: 15 }, (_, i) => ({ size: 'S',
    spec: { id: 'df00' + String(i).padStart(2, '0'), source: 'finds', groupBy: 'year' } }));
  const doc = { v: 1, active: 'aaaaaa', dashboards: [{ id: 'aaaaaa', name: 'Grand', period: { kind: 'all' }, items }] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  const errors = await openStats(page);
  const snap = await snapshot(page);
  // Tous les résultats sont calculés, seul le dessin est différé.
  expect(snap.cards.every((c) => c.series)).toBeTruthy();
  expect(snap.cards[0].rendered).toBe(true);
  expect(snap.cards.some((c) => c.deferred)).toBe(true);
  expect(snap.cards.filter((c) => c.deferred).every((c) => !c.rendered)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(async () => (await snapshot(page)).cards.every((c) => c.rendered)).toBe(true);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Confort : périmètre visible, valeurs + CSV, Annuler, animations réduites
// ---------------------------------------------------------------------------

test('les filtres propres sont lisibles sur la carte, sans infobulle', async ({ page, request }) => {
  const { errors, card: target } = await openWithChart(page, request,
    { groupBy: 'cache_type', filters: { cache_type: ['Multi-cache'] } });
  const scope = card(page, target.id).locator('.stats-card-scope');
  await expect(scope).toBeVisible();
  await expect(scope).toContainText('Filtres propres');
  await expect(scope).toContainText('Multi-cache');
  expect(errors).toEqual([]);
});

test('« Voir les valeurs » : tableau fidèle au graphique, export CSV', async ({ page, request }) => {
  const { errors, card: target } = await openWithChart(page, request, { groupBy: 'cache_type' });
  const shown = (await snapshot(page)).cards[0];
  await cardAction(page, target.id, 'values');
  await expect(page.locator('#statsValuesModal')).toBeVisible();
  const rows = page.locator('#statsValuesTable tbody tr');
  await expect(rows).toHaveCount(shown.keys.length);
  await expect(page.locator('#statsValuesTable')).toContainText('Multi-cache');
  const download = page.waitForEvent('download');
  await page.locator('#btnStatsValuesCsv').click();
  expect((await download).suggestedFilename()).toBe(`${shown.title}.csv`);
  expect(errors).toEqual([]);
});

test('« Annuler » restaure la carte supprimée', async ({ page, request }) => {
  const errors = await openStats(page);
  const before = (await snapshot(page)).cards;
  const victim = before[0];
  await cardAction(page, victim.id, 'delete');
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect(card(page, victim.id)).toHaveCount(0);
  const undo = page.locator('.gcm-toast.show .gcm-toast-action');
  await expect(undo).toHaveText('Annuler');
  await undo.click();
  const restored = (await snapshot(page)).cards;
  expect(restored.length).toBe(before.length);
  expect(restored[0].id).toBe(victim.id);
  await expect(card(page, victim.id)).toHaveCount(1);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.length).toBe(before.length);
  expect(errors).toEqual([]);
});

test('« réduire les animations » est respecté par les graphiques', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await openStats(page);
  expect((await snapshot(page)).reduceMotion).toBe(true);
  const durations = await page.evaluate(() => {
    const chart = window.echarts.getInstanceByDom(document.querySelector('.stats-chart'));
    const option = chart.getOption();
    return [option.animationDuration, option.animationDurationUpdate];
  });
  expect(durations).toEqual([0, 0]);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Organisation (lot 5)
// ---------------------------------------------------------------------------

async function dashboardAction(page, action) {
  await page.locator('#btnStatsDashboards').click();
  await page.locator(`#statsDashboardMenu [data-action="${action}"]`).click();
}

test('glisser une carte par sa poignée la déplace', async ({ page, request }) => {
  const errors = await openStats(page);
  const before = (await snapshot(page)).cards.map((c) => c.id);
  // La 3ᵉ carte déposée sur la moitié gauche de la 1ʳᵉ : elle passe devant.
  await card(page, before[2]).locator('.stats-card-grip')
    .dragTo(card(page, before[0]), { targetPosition: { x: 12, y: 60 } });
  await expect.poll(async () => (await snapshot(page)).cards.map((c) => c.id).slice(0, 3))
    .toEqual([before[2], before[0], before[1]]);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.[0]?.spec?.id).toBe(before[2]);
  // Plus rien de « glissable » ni de repère d'insertion après le dépôt.
  await expect(page.locator('.stats-card[draggable="true"], .drop-before, .drop-after')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('le coin de la carte change sa largeur et sa hauteur', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const errors = await openStats(page);
  const target = (await snapshot(page)).cards[3];
  expect(target).toMatchObject({ size: 'M', heightKey: 'M' });
  const corner = card(page, target.id).locator('.stats-card-resize');
  await corner.scrollIntoViewIfNeeded();
  const box = await corner.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  // Environ deux colonnes et demie de plus, et vers le bas.
  await page.mouse.move(box.x + 8 + 270, box.y + 8 + 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).cards[3]).toMatchObject({ size: 'L', heightKey: 'L' });
  expect(Math.round((await snapshot(page)).cards[3].height)).toBe(460);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.[3]?.height).toBe('L');
  expect(errors).toEqual([]);
});

test('éditeur : la hauteur se choisit, sauf pour un chiffre clé', async ({ page }) => {
  await openStats(page);
  const cards = (await snapshot(page)).cards;
  await cardAction(page, cards[0].id, 'edit');
  await expect(page.locator('#statsEdHeightCol')).toBeHidden();
  await page.locator('#statsEditorModal [data-bs-dismiss="modal"]').last().click();
  await cardAction(page, cards[3].id, 'edit');
  await page.locator('#statsEdHeight').selectOption('L');
  await page.locator('#btnStatsEdSave').click();
  expect((await snapshot(page)).cards[3].height).toBe(460);
});

test('exporter un graphique en image vectorielle', async ({ page }) => {
  await openStats(page);
  const target = (await snapshot(page)).cards[3];
  const download = page.waitForEvent('download');
  await cardAction(page, target.id, 'export-svg');
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${target.title}.svg`);
  const svg = fs.readFileSync(await file.path(), 'utf-8');
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('2026');
});

test('partager un tableau de bord : export, import, duplication', async ({ page, request }) => {
  const errors = await openStats(page);
  const original = await snapshot(page);

  const download = page.waitForEvent('download');
  await dashboardAction(page, 'export-dashboard');
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mon tableau de bord.json');
  const content = JSON.parse(fs.readFileSync(await file.path(), 'utf-8'));
  expect(content.format).toBe('mygcflow-dashboard');
  expect(content.dashboard.items.length).toBe(original.cards.length);

  // Réimport : un 2ᵉ tableau, identique, devenu actif.
  await page.locator('#statsImportInput').setInputFiles({
    name: 'partage.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)),
  });
  await expect.poll(async () => (await snapshot(page)).dashboards.length).toBe(2);
  let snap = await snapshot(page);
  expect(snap.dashboard.id).not.toBe(original.dashboard.id);
  expect(snap.cards.map((c) => c.groupBy)).toEqual(original.cards.map((c) => c.groupBy));
  expect(snap.cards[0].id).not.toBe(original.cards[0].id);

  // Un fichier qui n'est pas un tableau de bord : refusé, rien n'est ajouté.
  await page.locator('#statsImportInput').setInputFiles({
    name: 'autre.json', mimeType: 'application/json', buffer: Buffer.from('{"bonjour": 1}'),
  });
  await expect(page.locator('.modal.show, .gcm-toast.show').filter({ hasText: "n'est pas un tableau de bord" }).first()).toBeVisible();
  expect((await snapshot(page)).dashboards.length).toBe(2);

  // Duplication : une copie nommée « (copie) ».
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal.show')).toHaveCount(0);
  await dashboardAction(page, 'duplicate-dashboard');
  await expect.poll(async () => (await snapshot(page)).dashboards.length).toBe(3);
  snap = await snapshot(page);
  expect(snap.dashboard.name).toBe('Mon tableau de bord (copie)');
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.length).toBe(3);
  expect(errors).toEqual([]);
});

test('impression : sans les commandes, et toujours sur fond clair', async ({ page, request }) => {
  await openStats(page);
  const select = page.locator('#appHeaderTheme');
  const original = await select.inputValue();
  try {
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#btnStatsAddChart')).toBeHidden();
    await expect(page.locator('.stats-card-menu').first()).toBeHidden();
    await expect(page.locator('.stats-card').first()).toBeVisible();
    await page.emulateMedia({ media: 'screen' });

    await select.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  } finally {
    await select.selectOption(original);
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).theme).toBe(original);
  }
});

// ---------------------------------------------------------------------------
// Retour à la carte (lot 6)
// ---------------------------------------------------------------------------

// Position à l'écran d'une valeur (barre ou point) d'un graphique ECharts.
async function markPosition(page, chartId, seriesIndex, key) {
  return page.evaluate(({ chartId, seriesIndex, key }) => {
    const host = document.querySelector(`.stats-card[data-chart-id="${chartId}"] .stats-chart`);
    const chart = window.echarts.getInstanceByDom(host);
    const card = window.getStatsPageSnapshot().cards.find((c) => c.id === chartId);
    const k = card.keys.indexOf(key);
    const value = card.series[seriesIndex][k];
    const [x, y] = chart.convertToPixel({ seriesIndex }, [k, value / 2]);
    const rect = host.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  }, { chartId, seriesIndex, key });
}

test('un clic sur une barre ouvre la carte filtrée sur ces trouvailles', async ({ page, request }) => {
  const { errors, card: target } = await openWithChart(page, request, {
    groupBy: 'cache_type', view: { chart: 'bar', orientation: 'vertical' },
  });
  expect(target.linksToMap).toBe(true);
  const { x, y } = await markPosition(page, target.id, 0, 'Multi-cache');
  await page.mouse.click(x, y);
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Multi-cache');
  await modal.locator('[data-gcm-role="confirm"]').click();

  await expect(page).toHaveURL(/\/$/);
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 6', { timeout: 30_000 });
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('filtersSelection')));
  expect(selection.type).toEqual(['Multi-cache']);
  expect(errors).toEqual([]);
});

test("une valeur sans équivalent sur la carte : pas de lien", async ({ page, request }) => {
  const { errors, card: target } = await openWithChart(page, request, { groupBy: 'weekday', view: { chart: 'bar' } });
  expect(target.linksToMap).toBe(false);
  const k = target.series[0].findIndex((v) => v > 0);
  const { x, y } = await markPosition(page, target.id, 0, target.keys[k]);
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
  await expect(page.locator('.gcm-confirm-modal')).toHaveCount(0);
  await expect(page).toHaveURL(/\/stats$/);
  expect(errors).toEqual([]);
});

test('envoyer un graphique en panneau vidéo de la carte', async ({ page, request }) => {
  const reset = () => request.put('/api/settings', { data: { stats: { enabled: true, panels: [] } } });
  await reset();
  try {
    const { errors, card: target } = await openWithChart(page, request, {
      groupBy: 'cache_type', view: { chart: 'donut' }, periods: [{ kind: 'year', year: 2026 }],
    });
    // Un anneau ne s'anime pas : la vidéo est grisée.
    await card(page, target.id).locator('.stats-card-menu [data-bs-toggle="dropdown"]').click();
    await expect(card(page, target.id).locator('[data-action="video"]')).toBeDisabled();
    await card(page, target.id).locator('.stats-card-menu [data-bs-toggle="dropdown"]').click();

    await cardAction(page, target.id, 'to-panel');
    const modal = page.locator('.gcm-confirm-modal');
    // La période du graphique ne suit pas : c'est dit.
    await expect(modal).toContainText(/période/);
    await modal.locator('[data-gcm-role="confirm"]').click();
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Mes Géocaches' })).toBeVisible();
    const panels = (await (await request.get('/api/settings')).json()).stats.panels;
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ kind: 'donut', metric: 'cache_type', title: target.title });
    expect(errors).toEqual([]);
  } finally {
    await reset();
  }
});

test('un graphique sans panneau équivalent ne peut pas être envoyé', async ({ page, request }) => {
  const { card: target } = await openWithChart(page, request, { groupBy: 'published_year', view: { chart: 'bar' } });
  await card(page, target.id).locator('.stats-card-menu [data-bs-toggle="dropdown"]').click();
  await expect(card(page, target.id).locator('[data-action="to-panel"]')).toBeDisabled();
});

test('créer une vidéo animée d\'une comparaison', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { errors, card: target } = await openWithChart(page, request, {
    groupBy: 'month_of_year', measure: { op: 'cumulative' }, view: { chart: 'line' },
    periods: [{ kind: 'year', year: 2026 }, { kind: 'year', year: 2025 }],
  });
  await cardAction(page, target.id, 'video');
  await expect(page.locator('#statsVideoModal')).toBeVisible();
  await page.locator('#statsVideoSize').selectOption('hd');
  await page.locator('#statsVideoDuration').selectOption('6');
  await page.locator('#btnStatsVideoStart').click();
  await expect(page.locator('#statsVideoStage canvas')).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).video?.phase, { timeout: 90_000 }).toBe('done');
  const video = (await snapshot(page)).video;
  try {
    // Converti par le serveur : un MP4 dans le dossier des vidéos.
    expect(video.file).toMatch(/\.mp4$/);
    await expect(page.locator('#btnStatsVideoDownload')).toHaveAttribute('href', `/download_video/${encodeURIComponent(video.file)}`);
    await expect(page.locator('#btnStatsVideoReveal')).toBeVisible();
    const head = await request.get(`/download_video/${encodeURIComponent(video.file)}`);
    expect(head.ok()).toBeTruthy();
    expect((await head.body()).length).toBeGreaterThan(1000);
    await page.locator('#btnStatsVideoCancel').click();
    await expect(page.locator('#statsVideoModal')).toBeHidden();
    expect((await snapshot(page)).video).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    if (video?.file && video.folder) fs.rmSync(path.join(video.folder, video.file), { force: true });
  }
});

// Image du tableau entier : la disposition affichée, redessinée dans un PNG
// (en-tête, cartes, graphiques ECharts à la netteté ×2).
const IMAGE_ITEMS = [
  { size: 'S', spec: { id: 'eeee01', groupBy: 'none', view: { chart: 'number' }, goal: { value: 10 } } },
  { size: 'S', spec: { id: 'eeee02', groupBy: 'none', measure: { op: 'max_per_day' }, view: { chart: 'number', record: true } } },
  { size: 'M', spec: { id: 'eeee03', groupBy: 'month_of_year', view: { chart: 'bar' } } },
  { size: 'M', spec: { id: 'eeee04', groupBy: 'cache_type', view: { chart: 'donut' }, filters: { cache_type: ['Multi-cache'] } } },
  { size: 'L', spec: { id: 'eeee05', groupBy: 'dt', view: { chart: 'challenge' } } },
];

test('image du tableau entier : un PNG avec toutes les cartes', async ({ page, request }, testInfo) => {
  const doc = { v: 1, active: 'aaaaaa', dashboards: [{ id: 'aaaaaa', name: 'Mon bilan', period: { kind: 'all' }, items: IMAGE_ITEMS }] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  const errors = await openStats(page);

  const downloading = page.waitForEvent('download');
  await dashboardAction(page, 'image-dashboard');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Mon bilan.png');
  const file = testInfo.outputPath('tableau.png');
  await download.saveAs(file);
  const png = fs.readFileSync(file);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  // Cinq cartes, dont trois graphiques ECharts (les chiffres clés sont du texte).
  expect((await snapshot(page)).image).toMatchObject({ width, height, ratio: 2, cards: 5, charts: 3 });
  // Largeur : celle de la grille affichée, plus les marges, ×2.
  const gridWidth = await page.locator('#statsGrid').evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBe(Math.ceil(gridWidth + 48) * 2);
  expect(errors).toEqual([]);
});

test("copier l'image du tableau la met dans le presse-papiers", async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const doc = { v: 1, active: 'aaaaaa', dashboards: [{ id: 'aaaaaa', name: 'Mon bilan', period: { kind: 'all' }, items: IMAGE_ITEMS.slice(0, 3) }] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  const errors = await openStats(page);
  await dashboardAction(page, 'copy-image-dashboard');
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Image du tableau copiée' })).toBeVisible();
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const blob = await item.getType('image/png');
    return { types: item.types, size: blob.size };
  });
  expect(copied.types).toContain('image/png');
  expect(copied.size).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('vidéo du tableau entier : ouverture, chaque graphique, musique choisie', async ({ page, request }) => {
  test.setTimeout(150_000);
  // Trois graphiques : un chiffre clé (compte), des barres (révélées), un
  // anneau (entier) — 3 s d'ouverture + 3 × 4 s.
  const items = [
    { size: 'S', spec: { id: 'dddd01', groupBy: 'none', view: { chart: 'number' } } },
    { size: 'M', spec: { id: 'dddd02', groupBy: 'month_of_year', view: { chart: 'bar' } } },
    { size: 'M', spec: { id: 'dddd03', groupBy: 'cache_type', view: { chart: 'donut' } } },
  ];
  const doc = { v: 1, active: 'aaaaaa', dashboards: [{ id: 'aaaaaa', name: 'Mon bilan', period: { kind: 'all' }, items }] };
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  const errors = await openStats(page);

  await dashboardAction(page, 'video-dashboard');
  await expect(page.locator('#statsVideoModal')).toBeVisible();
  await expect(page.locator('#statsVideoTitle')).toHaveText('Vidéo du tableau de bord');
  await expect(page.locator('#statsVideoDurationLabel')).toHaveText('Durée de chaque graphique');
  await page.locator('#statsVideoDuration').selectOption('4');
  await expect(page.locator('#statsVideoTotal')).toContainText('3 graphiques, 15 secondes en tout');
  // Musique : un fichier de l'ordinateur (2 s, bouclé par le serveur).
  await page.locator('#statsVideoMusicFile').setInputFiles(wavFile('fond.wav', 2, 0));
  await expect(page.locator('#statsVideoMusic')).toHaveValue('upload');
  expect((await snapshot(page)).video).toMatchObject({ mode: 'dashboard', slides: 3, music: { kind: 'upload', file: 'fond.wav' } });

  await page.locator('#statsVideoSize').selectOption('hd');
  await page.locator('#btnStatsVideoStart').click();
  await expect(page.locator('#statsVideoStage canvas')).toBeVisible();
  await expect(page.locator('#statsVideoStatus')).toContainText('graphique', { timeout: 10_000 });
  await expect.poll(async () => (await snapshot(page)).video?.phase, { timeout: 120_000 }).toBe('done');
  const video = (await snapshot(page)).video;
  try {
    expect(video.file).toMatch(/^Mon_bilan.*\.mp4$/);
    const body = await (await request.get(`/download_video/${encodeURIComponent(video.file)}`)).body();
    // Piste audio AAC présente : la musique a bien été posée.
    expect(body.includes(Buffer.from('mp4a'))).toBe(true);
    await page.locator('#btnStatsVideoCancel').click();
    await expect(page.locator('#statsVideoModal')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    if (video?.file && video.folder) fs.rmSync(path.join(video.folder, video.file), { force: true });
  }
});

// ---------------------------------------------------------------------------
// Sauvegarde : conflit entre onglets, échec et relance
// ---------------------------------------------------------------------------

async function renameDashboard(page, name) {
  await page.locator('#btnStatsRename').click();
  await page.locator('#statsRenameInput').fill(name);
  await page.locator('#statsRenameForm button[type="submit"]').click();
  await expect(page.locator('#statsRenameModal')).toBeHidden();
}

test('un enregistrement concurrent ouvre le dialogue de conflit', async ({ page, request }) => {
  await openStats(page);
  const doc = await savedDoc(request);
  // « Autre onglet » : écrit directement, la révision du fichier bouge.
  doc.dashboards[0].name = 'Version de l’autre onglet';
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  // Notre écriture part sur l'ancienne révision : refusée (409), dialogue.
  await renameDashboard(page, 'Ma version');
  await expect(page.locator('.gcm-confirm-modal')).toBeVisible();
  // « Reprendre l'autre version » : le tableau affiche son contenu.
  await page.locator('.gcm-confirm-modal [data-gcm-role="cancel"]').click();
  await expect(page.locator('#statsDashboardName')).toHaveText('Version de l’autre onglet');
  const snap = await snapshot(page);
  expect(snap.save.dirty).toBe(false);
  expect(snap.dashboard.name).toBe('Version de l’autre onglet');
});

test('conflit : « Écraser » impose notre version au fichier', async ({ page, request }) => {
  await openStats(page);
  const doc = await savedDoc(request);
  doc.dashboards[0].name = 'Version de l’autre onglet';
  expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();
  await renameDashboard(page, 'Ma version');
  await expect(page.locator('.gcm-confirm-modal')).toBeVisible();
  await page.locator('.gcm-confirm-modal [data-gcm-role="confirm"]').click();
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.name).toBe('Ma version');
});

test('un échec d\'enregistrement reste affiché et le clic relance', async ({ page, request }) => {
  await openStats(page);
  let fail = true;
  await page.route('**/api/dashboards', async (route) => {
    if (fail && route.request().method() === 'PUT') return route.abort();
    return route.continue();
  });
  await renameDashboard(page, 'Perdu ?');
  await expect(page.locator('#statsSaveStatus')).toContainText('Non enregistré');
  expect((await snapshot(page)).save.dirty).toBe(true);
  fail = false;
  await page.locator('#statsSaveStatus').click();
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.name).toBe('Perdu ?');
  await page.unroute('**/api/dashboards');
});

// ---------------------------------------------------------------------------
// Fiabilité : date du jour, calendrier redimensionné, sauvegarde de secours
// ---------------------------------------------------------------------------

test('passage à une nouvelle année : la page suit la date du jour sans rechargement', async ({ page, request }) => {
  // Horloge figée (les minuteurs tournent normalement) : la veille du nouvel an.
  await page.clock.setFixedTime(new Date(2026, 11, 31, 23, 59));
  const { errors, card: before } = await openWithChart(page, request, {
    groupBy: 'none', periods: [{ kind: 'current', unit: 'year' }], view: { chart: 'number' },
  }, 'S');
  expect(before.series).toEqual([[6]]);
  // Le 31 décembre, l'année n'a plus de case à venir : pas « en cours ».
  expect(before.periods).toEqual(['2026']);
  const day = (await snapshot(page)).today;

  // Minuit passe pendant que la page est ouverte ; retour sur l'onglet.
  await page.clock.setFixedTime(new Date(2027, 0, 1, 0, 1));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => (await snapshot(page)).today).toBe(day + 1);
  const after = (await snapshot(page)).cards[0];
  expect(after.series).toEqual([[0]]);
  expect(after.periods).toEqual(['2027 (en cours)']);
  // Le menu global propose la nouvelle année en cours.
  await expect(page.locator('#statsGlobalPeriod option', { hasText: '2026' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('calendrier : la taille des cases suit la largeur de la fenêtre', async ({ page, request }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const { errors, card: wide } = await openWithChart(page, request, {
    groupBy: 'day', periods: [{ kind: 'current', unit: 'year' }], view: { chart: 'calendar' },
  }, 'XL');
  expect(wide.calendarCell).toBeGreaterThan(12);
  expect(Math.round(wide.height)).toBe(78 + 7 * wide.calendarCell);

  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(async () => (await snapshot(page)).cards[0].calendarCell).toBeLessThan(wide.calendarCell);
  const narrow = (await snapshot(page)).cards[0];
  // Redessiné (pas seulement étiré) : la hauteur suit la nouvelle case et le
  // calendrier tient dans la carte.
  expect(Math.round(narrow.height)).toBe(78 + 7 * narrow.calendarCell);
  const fits = await page.evaluate(() => {
    const host = document.querySelector('.stats-card .stats-chart');
    return host.scrollWidth <= host.clientWidth + 1;
  });
  expect(fits).toBe(true);
  expect(errors).toEqual([]);
});

test('fermeture : un document de plus de 64 Ko enregistre quand même le tableau affiché', async ({ page, request }) => {
  // Un tableau affiché d'un graphique + 7 tableaux de 24 graphiques : le
  // document normalisé par la page (~550 octets par graphique, titres de
  // 80 caractères) dépasse la limite d'un envoi keepalive.
  const hex = (n) => n.toString(16).padStart(6, '0');
  const dashboards = [{ id: 'aaaaaa', name: 'Affiché', period: { kind: 'all' },
    items: [{ size: 'S', spec: { id: 'c0ffee', groupBy: 'none', view: { chart: 'number' } } }] }];
  for (let d = 1; d <= 7; d++) {
    dashboards.push({ id: hex(0xb00000 + d), name: 'Autre ' + d, period: { kind: 'all' },
      items: Array.from({ length: 24 }, (_, i) => ({ size: 'M', spec: {
        id: hex(0xd00000 + d * 100 + i), groupBy: 'year', title: ('Graphique ' + i + ' ').padEnd(80, '·') } })) });
  }
  expect((await request.put('/api/dashboards', { data: { v: 1, active: 'aaaaaa', dashboards } })).ok()).toBeTruthy();
  const errors = await openStats(page);

  // La période globale s'enregistre après 500 ms : on quitte avant. L'envoi
  // de secours prend la route du tableau seul (le document est trop gros).
  const closingPut = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/dashboards/aaaaaa'));
  await page.locator('#statsGlobalPeriod').selectOption({ label: 'Cette année' });
  await page.goto('about:blank');
  await closingPut;
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.period).toEqual({ kind: 'current', unit: 'year' });
  const saved = await savedDoc(request);
  // Les autres tableaux sont intacts.
  expect(saved.dashboards).toHaveLength(8);
  expect(saved.dashboards[7].items).toHaveLength(24);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Ergonomie : aperçus de la galerie, « Annuler », « Actualiser », attente
// ---------------------------------------------------------------------------

test('galerie : chaque question montre un aperçu sur mes données, l\'ajout s\'annule', async ({ page, request }) => {
  const errors = await openStats(page);
  await page.locator('#btnStatsAddChart').click();
  const gallery = page.locator('#statsGalleryModal');
  await expect(gallery).toBeVisible();
  // « Partir de zéro » n'a pas d'aperçu ; les 49 questions en ont un.
  await expect(gallery.locator('[data-preview]')).toHaveCount(49);
  await expect(gallery.locator('[data-question="custom"] [data-preview]')).toHaveCount(0);
  const preview = async (id) => (await snapshot(page)).gallery.find((g) => g.id === id);
  // Haut de la galerie : dessiné dès l'ouverture.
  await expect.poll(async () => (await preview('total'))?.state).toBe('number');
  expect((await preview('total')).text).toBe('6');
  await expect.poll(async () => (await preview('by_year'))?.drawn).toBe(true);
  expect((await preview('by_year')).state).toBe('chart');
  // Bas de la galerie : dessiné à l'approche. Sans logs Mes poses, la
  // question le dit au lieu d'un graphique vide.
  await gallery.locator('[data-question="received_by_month"]').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await preview('received_by_month'))?.state).toBe('empty');
  expect((await preview('received_by_month')).text).toBe('Aucune donnée pour l’instant');
  await expect(gallery.locator('[data-question="received_by_month"]')).toHaveClass(/is-empty/);
  // Les questions sautées par le défilement ne sont pas dessinées (pas de
  // calcul inutile) ; la dernière l'est en y arrivant.
  expect((await snapshot(page)).gallery.some((g) => g.state === 'pending')).toBe(true);
  await gallery.locator('[data-question="finds_vs_dnf"]').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await preview('finds_vs_dnf'))?.drawn).toBe(true);

  // L'ajout reprend le résultat de l'aperçu, et s'annule par le toast.
  const before = (await snapshot(page)).cards.length;
  await gallery.locator('[data-question="weekdays"]').click();
  await expect(gallery).toBeHidden();
  await expect(page.locator('.stats-card')).toHaveCount(before + 1);
  const added = (await snapshot(page)).cards.at(-1);
  // Modale fermée : les instances ECharts des aperçus sont libérées.
  // (à l'événement hidden.bs.modal, après le fondu du fond).
  await expect.poll(async () => (await snapshot(page)).gallery.some((g) => g.drawn)).toBe(false);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.length).toBe(before + 1);
  const undo = page.locator('.gcm-toast.show', { hasText: 'Graphique ajouté' })
    .locator('.gcm-toast-action');
  await expect(undo).toHaveText('Annuler');
  await undo.click();
  await expect(page.locator('.stats-card')).toHaveCount(before);
  await expect.poll(async () => (await savedDoc(request))?.dashboards?.[0]?.items?.length).toBe(before);

  // Rouverte, la galerie garde ses éléments (aperçus repris du cache), sauf
  // celui déjà ajouté : le même choix donne une nouvelle carte.
  const firstId = added.id;
  await page.locator('#btnStatsAddChart').click();
  await expect.poll(async () => (await preview('total'))?.state).toBe('number');
  await gallery.locator('[data-question="weekdays"]').click();
  await expect(page.locator('.stats-card')).toHaveCount(before + 1);
  const again = (await snapshot(page)).cards.at(-1);
  expect(again.groupBy).toBe('weekday');
  expect(again.id).not.toBe(firstId);
  expect(errors).toEqual([]);
});

// Trouvailles servies sans les `keep` dernières : simule un import fait
// ailleurs pendant que la page est ouverte.
async function serveFinds(page, { keep = null, delay = 0, fail = false } = {}) {
  await page.unroute('**/api/stats/finds');
  await page.route('**/api/stats/finds', async (route) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (fail) return route.abort();
    const response = await route.fetch({ headers: { ...route.request().headers(), 'if-none-match': '' } });
    const payload = await response.json();
    if (keep !== null) {
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value) && value.length === payload.count) payload[key] = value.slice(0, keep);
      }
      payload.count = keep;
    }
    return route.fulfill({ json: payload });
  });
}

test('« Actualiser » relit les données sans recharger la page', async ({ page }) => {
  const errors = await openStats(page);
  const total = (await snapshot(page)).cards.find((c) => c.chart === 'number' && c.measure === 'count');
  expect(total.series).toEqual([[6]]);

  // Les données ont changé côté serveur : la page les relit, en montrant
  // qu'elle travaille tant que la réponse n'est pas là.
  await serveFinds(page, { keep: 4, delay: 800 });
  await page.locator('#btnStatsRefresh').click();
  await expect(page.locator('#statsBusy')).toBeVisible();
  await expect(page.locator('#statsBusyText')).toHaveText('Actualisation des données…');
  await expect(page.locator('#statsGrid')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#btnStatsRefresh')).toBeDisabled();
  await expect(page.locator('.gcm-toast.show', { hasText: 'Données actualisées.' })).toBeVisible();
  await expect(page.locator('#statsBusy')).toBeHidden();
  await expect(page.locator('#statsGrid')).not.toHaveAttribute('aria-busy', /.*/);
  let snap = await snapshot(page);
  expect(snap.rows).toBe(4);
  expect(snap.cards.find((c) => c.id === total.id).series).toEqual([[4]]);
  await expect(page.locator('#statsDataNote')).toContainText('4 trouvailles');

  // Échec : les données affichées restent, l'erreur est dite.
  await serveFinds(page, { fail: true });
  await page.locator('#btnStatsRefresh').click();
  await expect(page.locator('.gcm-toast.show', { hasText: 'les précédentes restent affichées' })).toBeVisible();
  snap = await snapshot(page);
  expect(snap.rows).toBe(4);
  expect(snap.sourceErrors).toEqual([]);
  await expect(page.locator('#btnStatsRefresh')).toBeEnabled();

  // Retour aux vraies données.
  await page.unroute('**/api/stats/finds');
  await page.locator('#btnStatsRefresh').click();
  await expect.poll(async () => (await snapshot(page)).rows).toBe(6);
  expect(errors).toEqual([]);
});

test('jeu Évolution long à charger : l\'attente est dite, au démarrage comme au changement de tableau', async ({ page, request }) => {
  await deleteAllDatasets(request);
  const datasetId = await createDataset(request, 'Zone lente');
  try {
    // Un tableau personnel (actif) et un tableau Évolution.
    await openStats(page);
    const doc = await savedDoc(request);
    doc.dashboards.push({ id: 'e1e1e1', name: 'Zone lente', kind: 'evolution', dataset: datasetId, items: [] });
    expect((await request.put('/api/dashboards', { data: doc })).ok()).toBeTruthy();

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/evolution/datasets/*/data', async (route) => {
      await held;
      return route.continue();
    });
    await page.reload();
    await page.waitForFunction(() => window.mygcflowStatsReady === true);
    await page.locator('#btnStatsDashboards').click();
    await page.locator('#statsDashboardMenu [data-dashboard-id="e1e1e1"]').click();
    await expect(page.locator('#statsBusy')).toBeVisible();
    await expect(page.locator('#statsBusyText')).toHaveText('Chargement du jeu Évolution « Zone lente »…');
    await expect(page.locator('#statsGrid')).toHaveClass(/is-busy/);
    release();
    await expect.poll(async () => (await snapshot(page)).dashboard.kind).toBe('evolution');
    await expect(page.locator('#statsBusy')).toBeHidden();
    await expect(page.locator('#statsGrid')).not.toHaveClass(/is-busy/);

    // Démarrage sur ce tableau : l'écran de chargement nomme le jeu.
    let releaseAgain;
    const heldAgain = new Promise((resolve) => { releaseAgain = resolve; });
    await page.unroute('**/api/evolution/datasets/*/data');
    await page.route('**/api/evolution/datasets/*/data', async (route) => {
      await heldAgain;
      return route.continue();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#statsLoadingText')).toHaveText('Chargement du jeu Évolution « Zone lente »…');
    releaseAgain();
    await page.waitForFunction(() => window.mygcflowStatsReady === true);
    await expect(page.locator('#statsDashboard')).toBeVisible();
    expect((await snapshot(page)).dashboard.kind).toBe('evolution');
  } finally {
    await page.unroute('**/api/evolution/datasets/*/data');
    await deleteAllDatasets(request);
  }
});

// « Reprendre les filtres de la carte » : la sélection réellement écrite par
// la carte (localStorage filtersSelection, propre au contexte du test — rien
// à remettre) remplit la fenêtre Filtres ; ses dates deviennent la période.
test('« Reprendre les filtres de la carte » : aller-retour carte → Statistiques', async ({ page }) => {
  // Contexte neuf : la carte n'a encore rien enregistré.
  let errors = await openStats(page);
  await page.locator('#btnStatsFilters').click();
  const report = page.locator('#statsMapFiltersReport');
  await expect(report).toBeHidden();
  await page.locator('#btnStatsFiltersFromMap').click();
  await expect(report).toHaveAttribute('data-state', 'none');
  await expect(report).toContainText('aucun filtre à reprendre');
  await page.locator('#statsFiltersModal [data-bs-dismiss="modal"]').last().click();
  await expect(page.locator('#statsFiltersModal')).toBeHidden();
  expect(errors).toEqual([]);

  // Sur la carte : l'événement décoché, par l'interface.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await openDataSubTab(page, 'filters');
  await page.locator('#selectType').evaluate((el) => el.tomselect.open());
  await page.locator('.filter-field:has(#selectType) .ts-dropdown .option[data-value="Event Cache"]').click();
  await expect(page.locator('#filtersCounter')).toContainText('5 / 6', { timeout: 15_000 });
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('filtersSelection') || '{}'));
    return Array.isArray(saved.type) && !saved.type.includes('Event Cache');
  }, { timeout: 15_000 }).toBe(true);

  // Retour aux Statistiques : seul le type est repris — les dates et les
  // dates de pose, au défaut sur la carte, ne retirent rien.
  errors = await openStats(page);
  await page.locator('#btnStatsFilters').click();
  await page.locator('#btnStatsFiltersFromMap').click();
  await expect(report).toHaveAttribute('data-state', 'taken');
  await expect(report).toContainText('5 trouvailles');
  await expect(page.locator('#statsMapPeriod')).toHaveCount(0);
  await expect(report).not.toContainText('Sans équivalent');
  const selected = () => page.locator('#statsFilter-cache_type').evaluate((el) => [...el.selectedOptions].map((o) => o.value));
  expect((await selected()).sort()).toEqual(['Multi-cache', 'Traditional Cache']);

  // Dates de trouvaille et recherche posées sur la carte : période proposée,
  // recherche signalée.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('filtersSelection'));
    saved.dates = { startDate: '2026-01-02', endDate: '2026-01-04' };
    saved.search = 'multi';
    localStorage.setItem('filtersSelection', JSON.stringify(saved));
  });
  await page.locator('#btnStatsFiltersFromMap').click();
  await expect(report).toContainText('3 trouvailles');
  await expect(page.locator('#statsMapPeriod')).toBeChecked();
  await expect(report).toContainText('dates de trouvaille de la carte');
  await expect(report.locator('li')).toHaveText(['la recherche « multi »']);
  // « Tout effacer » retire aussi la période proposée.
  await page.locator('#btnStatsFiltersClear').click();
  await expect(report).toBeHidden();
  await page.locator('#btnStatsFiltersFromMap').click();
  await page.locator('#btnStatsFiltersApply').click();
  await expect(page.locator('#statsFiltersModal')).toBeHidden();

  await expect(page.locator('.stats-number-value').first()).toHaveText('3');
  let dashboard = (await snapshot(page)).dashboard;
  expect(dashboard.filters).toEqual({ cache_type: ['Traditional Cache', 'Multi-cache'] });
  expect(dashboard.period).toEqual({ kind: 'range', from: '2026-01-02', to: '2026-01-04' });

  // « Annuler » rend les filtres et la période d'avant.
  const toast = page.locator('.gcm-toast.show', { hasText: 'Filtres de la carte appliqués.' });
  await toast.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.locator('.stats-number-value').first()).toHaveText('6');
  dashboard = (await snapshot(page)).dashboard;
  expect(dashboard.filters).toEqual({});
  expect(dashboard.period.kind).not.toBe('range');
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Grilles de défis : D/T 81, Calendrier 366, Jasmer, mois de trouvaille
// ---------------------------------------------------------------------------

// Fixture : D/T 1/1 et 1,5/1,5 → 3,5/3,5 (6 combinaisons), trouvées du 1ᵉʳ au
// 6 janvier 2026, publiées en janvier 2025.
test('grilles de défis : ajoutées depuis la galerie, bilan et cases qui manquent', async ({ page }) => {
  const errors = await openStats(page);
  const add = async (id) => {
    await page.locator('#btnStatsAddChart').click();
    await expect(page.locator('#statsGalleryModal')).toBeVisible();
    await page.locator(`#statsGalleryModal [data-question="${id}"]`).click();
    await expect(page.locator('#statsGalleryModal')).toBeHidden();
  };
  // Le groupe « Mes défis » existe, avec ses aperçus.
  await page.locator('#btnStatsAddChart').click();
  const gallery = page.locator('#statsGalleryModal');
  await expect(gallery).toContainText('Mes défis');
  await gallery.locator('[data-question="challenge_jasmer"]').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await snapshot(page)).gallery.find((g) => g.id === 'challenge_jasmer')?.drawn).toBe(true);
  await gallery.locator('[data-bs-dismiss="modal"]').first().click();
  await expect(gallery).toBeHidden();

  for (const id of ['challenge_dt', 'challenge_calendar', 'challenge_jasmer', 'challenge_months']) await add(id);
  const cards = async () => (await snapshot(page)).cards.filter((c) => c.chart === 'challenge');
  await expect.poll(async () => (await cards()).length).toBe(4);
  await expect.poll(async () => (await cards()).every((c) => c.rendered)).toBe(true);
  const byMetric = Object.fromEntries((await cards()).map((c) => [c.challenge.metric, c.challenge]));

  expect(byMetric.dt).toMatchObject({ filled: 6, available: 81, loops: 0, next: 75 });
  expect(byMetric.dt.missing).toBe('Il manque 75 cases');
  expect(byMetric.calendar).toMatchObject({ filled: 6, available: 366, loops: 0 });
  // Jasmer : mai 2000 → janvier 2026 (dernière trouvaille), un mois rempli.
  expect(byMetric.jasmer).toMatchObject({ filled: 1, available: 8 + 25 * 12 + 1, loops: 0 });
  // Un seul mois de trouvaille, six trouvailles : grille pleine, six tours.
  expect(byMetric.finds_ym).toMatchObject({ filled: 1, available: 1, loops: 6 });
  expect(byMetric.finds_ym.tours).toBe('Tours année × mois : 6');

  // La grille D/T s'allonge en cases carrées ; son bilan est dessiné.
  const dtCard = (await cards()).find((c) => c.challenge.metric === 'dt');
  expect(dtCard.height).toBeGreaterThan(300);
  const title = await page.evaluate((id) => {
    const host = document.querySelector(`.stats-card[data-chart-id="${id}"] .stats-chart`);
    return window.echarts.getInstanceByDom(host).getOption().title[0].text;
  }, dtCard.id);
  expect(title).toContain('Combinaisons : 6/81');
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Séries et records
// ---------------------------------------------------------------------------

// Fixture : une trouvaille par jour du 1ᵉʳ au 6 janvier 2026. Le 7 janvier,
// la série court encore (la journée n'est pas finie).
test('séries et records : jours datés, série en cours, record épinglé, carte de la série', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-07T10:00:00'));
  const errors = await openStats(page);
  const add = async (id) => {
    await page.locator('#btnStatsAddChart').click();
    await expect(page.locator('#statsGalleryModal')).toBeVisible();
    await page.locator(`#statsGalleryModal [data-question="${id}"]`).click();
    await expect(page.locator('#statsGalleryModal')).toBeHidden();
  };
  for (const id of ['best_day', 'streak_longest', 'streak_current', 'gap_longest', 'best_month']) await add(id);
  const cards = async () => (await snapshot(page)).cards.slice(-5);
  await expect.poll(async () => (await cards()).every((c) => c.rendered)).toBe(true);
  const [best, longest, current, gap, month] = await cards();

  expect(best.measure).toBe('max_per_day');
  expect(best.recordText).toBe('le 1 janv. 2026');
  expect(longest.series[0]).toEqual([6]);
  expect(longest.recordText).toBe('du 1 janv. 2026 au 6 janv. 2026');
  expect(current.series[0]).toEqual([6]);
  // Aucune pause entre deux trouvailles : zéro, sans date.
  expect(gap.series[0]).toEqual([0]);
  expect(gap.recordText).toBeNull();
  await expect(card(page, longest.id).locator('.stats-number-value')).toHaveText('6 j');

  // Meilleur mois : l'épingle sur janvier 2026.
  const pin = await page.evaluate((id) => {
    const host = document.querySelector(`.stats-card[data-chart-id="${id}"] .stats-chart`);
    return window.echarts.getInstanceByDom(host).getOption().series[0].markPoint?.data;
  }, month.id);
  expect(pin).toHaveLength(1);
  expect(pin[0].value).toBe(6);

  // La série sur la carte : ses jours, et seulement eux.
  await expect(card(page, gap.id).locator('.stats-number-map')).toHaveCount(0);
  await card(page, longest.id).locator('.stats-number-map').click();
  const modal = page.locator('.gcm-confirm-modal');
  await expect(modal).toContainText('du 1 janvier 2026 au 6 janvier 2026');
  // (Erreurs relevées avant la carte : son sélecteur de dates n'aime pas
  // l'horloge figée du test.)
  expect(errors).toEqual([]);
  await modal.locator('[data-gcm-role="confirm"]').click();
  await expect(page).toHaveURL(/\/$/);
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('filtersSelection')));
  expect(selection.dates).toEqual({ startDate: '2026-01-01', endDate: '2026-01-06' });
});

// ---------------------------------------------------------------------------
// Objectifs et projections
// ---------------------------------------------------------------------------

// Fixture : 6 trouvailles du 1ᵉʳ au 6 janvier 2026 ; on est le 11 janvier
// (11 jours écoulés, 6/11 trouvaille par jour).
test('objectifs et projections : prochain cap, année à ce rythme, courbe prolongée', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-11T10:00:00'));
  const errors = await openStats(page);
  const add = async (id) => {
    await page.locator('#btnStatsAddChart').click();
    await expect(page.locator('#statsGalleryModal')).toBeVisible();
    await page.locator(`#statsGalleryModal [data-question="${id}"]`).click();
    await expect(page.locator('#statsGalleryModal')).toBeHidden();
  };
  for (const id of ['next_milestone', 'year_pace', 'year_curve']) await add(id);
  const cards = async () => (await snapshot(page)).cards.slice(-3);
  await expect.poll(async () => (await cards()).every((c) => c.rendered)).toBe(true);
  const [milestone, pace, curve] = await cards();

  // Prochain cap : 10, atteint à ce rythme le 19 janvier.
  const cap = card(page, milestone.id);
  await expect(cap.locator('.stats-goal')).toHaveAttribute('aria-valuenow', '6');
  await expect(cap.locator('.stats-goal')).toHaveAttribute('aria-valuemax', '10');
  await expect(cap.locator('.stats-goal-text')).toHaveText(/^6 \/ 10 · 60\s%$/);
  await expect(cap.locator('.stats-goal-line')).toHaveText('À ce rythme : 10 le 19 janv. 2026');
  // Année : 6 + 6/11 × 354 jours restants.
  await expect(card(page, pace.id).locator('.stats-goal-line')).toHaveText('À ce rythme : 199 en fin de période');

  // Courbe de l'année : prolongée en tirets jusqu'au 31 décembre.
  const option = async () => page.evaluate((id) => {
    const host = document.querySelector(`.stats-card[data-chart-id="${id}"] .stats-chart`);
    const o = window.echarts.getInstanceByDom(host).getOption();
    return { count: o.series.length, dashed: o.series[1]?.lineStyle?.type, last: o.series[1]?.data.at(-1), goal: o.series[0].markLine?.data?.[0]?.yAxis };
  }, curve.id);
  let drawn = await option();
  expect(drawn.count).toBe(2);
  expect(drawn.dashed).toBe('dashed');
  expect(Math.round(drawn.last)).toBe(199);

  // Un objectif posé dans l'éditeur : la ligne apparaît.
  await cardAction(page, curve.id, 'edit');
  await expect(page.locator('#statsEditorModal')).toBeVisible();
  await page.locator('#statsEdOptions').evaluate((el) => { el.open = true; });
  await expect(page.locator('#statsEdGoalRow')).toBeVisible();
  await expect(page.locator('#statsEdProjection')).toBeChecked();
  await page.locator('#statsEdGoal').fill('300');
  await page.locator('#statsEdGoal').dispatchEvent('change');
  await page.locator('#btnStatsEdSave').click();
  await expect(page.locator('#statsEditorModal')).toBeHidden();
  await expect.poll(async () => (await option()).goal).toBe(300);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Mode présentation
// ---------------------------------------------------------------------------

test('présentation : un graphique par écran, clavier, défilement automatique, sortie', async ({ page }) => {
  const errors = await openStats(page);
  const cards = (await snapshot(page)).cards;
  const present = async () => (await snapshot(page)).presentation;

  await page.locator('#btnStatsPresent').click();
  const screen = page.locator('#statsPresent');
  await expect(screen).toBeVisible();
  await expect.poll(async () => (await present())?.drawn).toBe(true);
  let state = await present();
  expect(state).toMatchObject({ index: 0, count: cards.length, chartId: cards[0].id, auto: false });
  await expect(page.locator('#statsPresentTitle')).toHaveText(cards[0].title);
  await expect(page.locator('#statsPresentCount')).toHaveText(`1 / ${cards.length}`);
  await expect(page.locator('#btnStatsPresentPrev')).toBeDisabled();
  // Chiffre clé en grand.
  await expect(page.locator('#statsPresentBody .stats-number-value')).toHaveText('6');

  // Clavier : suivant, dernier, précédent.
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await present()).index).toBe(1);
  await page.keyboard.press('End');
  await expect.poll(async () => (await present()).index).toBe(cards.length - 1);
  await expect(page.locator('#btnStatsPresentNext')).toBeDisabled();
  await expect(page.locator('#statsPresentBody .stats-chart')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await present()).index).toBe(cards.length - 2);

  // Défilement automatique (5 s), en boucle ; commandes masquées sans
  // mouvement de souris.
  await page.locator('#statsPresentDelay').selectOption('5');
  await page.locator('#btnStatsPresentPlay').click();
  await expect(page.locator('#btnStatsPresentPlay')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await present()).index, { timeout: 8_000 }).toBe(cards.length - 1);
  await expect.poll(async () => (await present()).idle).toBe(true);
  await expect.poll(async () => (await present()).index, { timeout: 8_000 }).toBe(0);
  await page.mouse.move(200, 200);
  await expect.poll(async () => (await present()).idle).toBe(false);

  // Échap : la page revient telle quelle.
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  expect(await present()).toBeNull();
  await expect(page.locator('.stats-card')).toHaveCount(cards.length);

  // Depuis le menu d'une carte : la présentation commence par elle.
  await cardAction(page, cards[3].id, 'present');
  await expect(screen).toBeVisible();
  await expect.poll(async () => (await present())?.chartId).toBe(cards[3].id);
  await page.locator('#btnStatsPresentExit').click();
  await expect(screen).toBeHidden();
  expect(errors).toEqual([]);
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
