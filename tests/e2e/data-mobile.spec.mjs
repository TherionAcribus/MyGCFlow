// Onglet Données sur petit écran (~390 px) : les rangées « boutons » et
// « Le favori collecte » s'empilent (flex-column) au lieu de se compresser
// — les contrôles restent dans la carte, le select passe pleine largeur
// sous son libellé. Le rendu au-delà de 576 px est inchangé.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { openDataSubTab } from './data-subtabs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GPX_FINDS = path.join(HERE, 'fixtures', 'my-finds.gpx');
const LABS_HISTORY = path.join(HERE, '..', 'fixtures', 'labs', 'lab-finds-valid.json');
const LABS_COORDS = path.join(HERE, '..', 'fixtures', 'labs', 'lab2gpx-stages.gpx');
const LOGS_CONTRACT = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-contract-valid.json');


// Placement automatique des étapes : jamais de réseau vers lab2gpx.
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings', { data: { labs_auto_fetch_coords: false } });
});


// Collections et préférences partagées par le runtime de test : remises.
test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ main_discovery_sources: 'geocaches',
                           labs_auto_fetch_coords: false }),
  })).catch(() => {});
  await request.post('/api/labs/clear').catch(() => {});
  await request.post('/api/logs/clear').catch(() => {});
  await request.post('/api/logs/bookmarklet/scope',
    { data: { scope: 'all' } }).catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


async function cardBox(locator) {
  return locator.evaluate((n) => {
    const r = n.closest('.card').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}


test('à 390 px, les rangées de l\'onglet Données s\'empilent sans dépasser', async ({ page, request }) => {
  await request.post('/clear_database');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  // Les trois sources sont chargées : les boutons des rangées testées ne
  // sont visibles qu'avec des données (display:none sinon).
  await page.locator('#file-input').setInputFiles(GPX_FINDS);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  await page.locator('#labs-file-input').setInputFiles([LABS_HISTORY, LABS_COORDS]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });

  await page.locator('#gc-logs-file-input').setInputFiles(LOGS_CONTRACT);
  await expect(page.locator('#gcLogsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#gcLogsPreviewConfirmBtn').click();
  await expect(page.locator('#gcLogsStatus')).toContainText('logs enregistrés', { timeout: 30_000 });

  // Aucun contrôle des rangées empilées ne déborde de sa carte.
  for (const selector of ['#gcLogsScopeSelect', '#labsUpdateBtn', '#gcLogsUpdateBtn']) {
    const locator = page.locator(selector);
    const box = await locator.boundingBox();
    expect(box, `${selector} doit avoir une boîte visible`).not.toBeNull();
    const card = await cardBox(locator);
    expect(box.x).toBeGreaterThanOrEqual(card.x - 0.5);
    expect(box.width).toBeLessThanOrEqual(card.width + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }

  // « Le favori collecte » : libellé au-dessus du select (empilés).
  const labelBox = await page.locator('label[for="gcLogsScopeSelect"]').boundingBox();
  const selectBox = await page.locator('#gcLogsScopeSelect').boundingBox();
  expect(selectBox.y).toBeGreaterThan(labelBox.y);
});


// Sous-onglets de l'onglet Données (lot « réorganisation Données ») :
// Sources actif par défaut, alternance effective, choix mémorisé au
// rechargement, et état d'accueil qui force Sources quand la base est vide —
// sans écraser le choix mémorisé (comme l'onglet principal, tab-memory).
test('les sous-onglets alternent, le choix survit au rechargement, la base vide force Sources', async ({ page, request }) => {
  await request.post('/clear_database');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);

  const sourcesTab = page.locator('#dataSourcesTab');
  const filtersTab = page.locator('#dataFiltersTab');
  const sourcesPane = page.locator('#dataSourcesPane');
  const filtersPane = page.locator('#dataFiltersPane');

  // Base vide : l'arrivée est forcée sur Données — Sources, l'état d'accueil.
  await expect(sourcesTab).toHaveClass(/active/);
  await expect(sourcesPane).toHaveClass(/active/);
  await expect(filtersPane).not.toHaveClass(/active/);

  // L'alternance ne se teste qu'avec des données : tant que la base est
  // vide, chaque résolution du statut ramène sur Sources (état d'accueil,
  // comme l'onglet principal forcé sur Données).
  await page.locator('#file-input').setInputFiles(GPX_FINDS);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });

  // L'alternance masque un pane et montre l'autre.
  await openDataSubTab(page, 'filters');
  await expect(filtersTab).toHaveClass(/active/);
  await expect(filtersPane).toHaveClass(/active/);
  await expect(sourcesPane).not.toHaveClass(/active/);
  await openDataSubTab(page, 'sources');
  await expect(sourcesPane).toHaveClass(/active/);
  await expect(filtersPane).not.toHaveClass(/active/);

  // Le dernier pane ouvert survit au rechargement.
  await openDataSubTab(page, 'filters');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(filtersPane).toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem('dataSubTab'))).toBe('filters');

  // Base vide à nouveau : l'état d'accueil force Sources à la résolution du
  // statut — SANS écraser le choix mémorisé (il servira à la prochaine
  // visite avec données, comme l'onglet principal).
  await request.post('/clear_database');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(sourcesPane).toHaveClass(/active/, { timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem('dataSubTab'))).toBe('filters');
});
