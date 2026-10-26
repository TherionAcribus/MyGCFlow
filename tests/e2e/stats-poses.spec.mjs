// Panneaux Stats de la page Mes poses (/poses) : ils comptent les
// trouvailles REÇUES (logs « Found it » des autres joueurs sur les caches
// posées), les DNF reçus ou les favoris reçus — source `options.source`
// par panneau, liste propre `stats.poses_panels`.
//
// Fixture : tests/fixtures/gc_logs/logs-poses.json — 12 trouvailles reçues
// sur les caches placées (GCP0003 : 4, GCP0001, GCP0005, GCP0006 : 2,
// GCP0002, GCP0008 : 1), 1 DNF reçu (Chloé sur GCP0001 le 12/03/2018),
// 3 favoris (Alice ×2 sur GCP0001/GCP0003, Bob sur GCP0006), 4 trouveurs
// (Alice, Bob, Chloé, Testeur). Le « favori » du poseur sur sa propre cache
// (GCQ0001) est une note du poseur : ni trouvaille ni favori reçu.
// Préférences globales et logs remis à zéro en sortie (AGENTS.md).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-poses.json');

async function importPoses(request) {
  const preview = await request.post('/api/logs/import/preview', {
    multipart: { file: { name: 'logs-poses.json', mimeType: 'application/json', buffer: fs.readFileSync(FIXTURE) } },
  });
  expect(preview.ok()).toBeTruthy();
  const commit = await request.post('/api/logs/import/commit', { data: { import_token: (await preview.json()).import_token } });
  const { task_id: taskId } = await commit.json();
  await expect.poll(async () => (await (await request.get(`/tasks/${taskId}`)).json()).state,
    { timeout: 30_000 }).toBe('finished');
}

const CACHE_BAR = { id: 'a0c0de01', kind: 'bar', metric: 'cache', enabled: true };
const SUMMARY = {
  id: 'a0c0de02', kind: 'counter', metric: 'summary', enabled: true,
  options: { items: ['total', 'finders', 'favorites', 'caches'] },
};

async function snapshot(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

function altText(page, id) {
  return page.locator(`canvas.stats-panel[data-panel-id="${id}"] + .stats-panel-alt`);
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/logs/clear');
});

test.afterEach(async ({ request }) => {
  await request.post('/api/logs/clear');
  await request.put('/api/settings', { data: {
    stats: { enabled: true, poses_panels: [] },
    poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 60 },
  } });
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).stats.poses_panels.length).toBe(0);
});

test('les panneaux de Mes poses comptent les trouvailles reçues', async ({ page, request }) => {
  await importPoses(request);
  await request.put('/api/settings', { data: { stats: { enabled: true, poses_panels: [CACHE_BAR, SUMMARY] } } });
  // La liste du mode principal reste vide : chaque page a la sienne.
  expect((await (await request.get('/api/settings')).json()).stats.panels).toEqual([]);

  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true);

  await expect.poll(async () => (await snapshot(page)).visible.sort()).toEqual(['a0c0de01', 'a0c0de02']);
  const rest = await snapshot(page);
  expect(rest.total).toBe(12);
  expect(rest.counts.cache['GCP0003 · Testée avant publication']).toBe(4);
  expect(Object.keys(rest.counts.finder).sort()).toEqual(['Alice', 'Bob', 'Chloé', 'Testeur']);
  expect(rest.counts.favorite).toEqual({ 1: 3 });
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Animation courte : les comptes repartent de zéro puis reviennent aux totaux.
  await request.put('/api/settings', { data: { poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 3 } } });
  await page.reload();
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).mode, { timeout: 15_000 }).toBe('animating');
  await expect.poll(async () => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 60_000 }).toBe('idle');
  const end = await snapshot(page);
  expect(end.total).toBe(12);
});

// Tuiles « poseur » du compteur « Chiffres clés » : part de favoris et
// trouveurs fidèles (accumulateur), délai moyen avant la première trouvaille
// et cache la plus délaissée (chronologie de la page, au jour affiché). Sur
// la fixture : 3 favoris / 12 trouvailles ; Alice (5) et Bob (4) sont les
// seuls fidèles (≥ 3) ; délais de première trouvaille 0, 14, 0, 1, 19 et
// 1 j (moyenne 35/6 ≈ 5,8 → « 6 jours ») ; GCP0004 jamais trouvée.
test('les tuiles « poseur » du compteur', async ({ page, request }) => {
  await importPoses(request);
  await request.put('/api/settings', { data: { stats: { enabled: true, poses_panels: [
    { id: 'a0c0de03', kind: 'counter', metric: 'summary', enabled: true,
      options: { items: ['fav_ratio', 'loyal', 'ftf_delay', 'neglected'] } },
  ] } } });

  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true);

  await expect.poll(async () => (await snapshot(page)).visible).toEqual(['a0c0de03']);
  const alt = page.locator('.stats-panel-alt');
  await expect(alt).toContainText(/Part de favoris : 25\s*%/);
  await expect(alt).toContainText('Trouveurs fidèles : 2 (Alice · 5)');
  await expect(alt).toContainText('Délai moyen avant la première trouvaille : 6 jours');
  await expect(alt).toContainText('GCP0004 · jamais trouvée');
});

// Même filtre « Données » dans la galerie de Mes poses : les vignettes des
// cartes libres suivent la source — le registre de la page est commun aux
// trois, rien n'est masqué — et le panneau posé la porte.
test('la galerie de Mes poses pose sur la source choisie', async ({ page, request }) => {
  await importPoses(request);
  await request.put('/api/settings', { data: { stats: { enabled: true, poses_panels: [] } } });
  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true);

  await page.locator('a[href="#stats"]').click();
  await page.locator('#btnStatsAdd').click();
  const modal = page.locator('#statsGalleryModal');
  await expect(modal).toBeVisible();

  const select = page.locator('#selectStatsGallerySource');
  await expect(select).toBeVisible();
  const options = select.locator('option');
  await expect(options).toHaveCount(3);
  await select.selectOption('favorites');

  await modal.locator('[data-stats-add="bar:cache"]').click();
  await expect.poll(async () => {
    const panel = (await (await request.get('/api/settings')).json()).stats.poses_panels[0];
    return [panel?.metric, panel?.options?.source];
  }).toEqual(['cache', 'favorites']);
});

// Sources de Mes poses : « dnf » compte les DNF REÇUS (autre sens que sur la
// page principale) et « favorites » les trouvailles reçues portant un point
// favori ; les deux partagent le registre de métriques des trouvailles
// reçues, avec des tuiles d'accumulateur seulement (pas d'état « au jour »).
test('les panneaux comptent DNF et favoris reçus', async ({ page, request }) => {
  await importPoses(request);
  const panels = [
    { id: 'a0c0de10', kind: 'counter', metric: 'summary', enabled: true,
      options: { source: 'dnf', items: ['total', 'finders', 'caches'] } },
    { id: 'a0c0de11', kind: 'bar', metric: 'cache', enabled: true,
      options: { source: 'dnf' } },
    { id: 'a0c0de12', kind: 'counter', metric: 'summary', enabled: true,
      options: { source: 'favorites', items: ['total', 'finders', 'caches'] } },
    { id: 'a0c0de13', kind: 'donut', metric: 'cache', enabled: true,
      options: { source: 'favorites' } },
  ];
  const put = await request.put('/api/settings', { data: { stats: { enabled: true, poses_panels: panels } } });
  expect(put.ok()).toBeTruthy();
  // Le serveur accepte « favorites » et le relit dans poses_panels.
  const stored = (await (await request.get('/api/settings')).json()).stats.poses_panels;
  expect(stored.find((p) => p.id === 'a0c0de12')?.options?.source).toBe('favorites');
  expect(stored.find((p) => p.id === 'a0c0de10')?.options?.source).toBe('dnf');

  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true);

  await expect.poll(async () => (await snapshot(page)).sources?.dnf?.total).toBe(1);
  const snap = await snapshot(page);
  expect(snap.sources.favorites.total).toBe(3);
  expect(snap.sources.finds.total).toBe(12);
  // Un seul DNF reçu : Chloé sur GCP0001.
  expect(snap.sources.dnf.counts.cache['GCP0001 · Publication et premier trouveur']).toBe(1);
  // Trois favoris reçus sur trois caches, deux joueurs.
  expect(snap.sources.favorites.counts.finder).toEqual({ Alice: 2, Bob: 1 });
  await expect(page.locator('canvas.stats-panel')).toHaveCount(4);

  const dnf = altText(page, 'a0c0de10');
  await expect(dnf).toContainText('Chiffres clés des DNF reçus');
  await expect(dnf).toContainText('DNF : 1');
  await expect(dnf).toContainText('Chercheurs distincts : 1');
  await expect(dnf).toContainText('Caches en échec : 1');

  const fav = altText(page, 'a0c0de12');
  await expect(fav).toContainText('Chiffres clés des favoris reçus');
  await expect(fav).toContainText('Favoris reçus : 3');
  await expect(fav).toContainText('Joueurs favorisants : 2');
  await expect(fav).toContainText('Caches favorisées : 3');

  const dnfBar = altText(page, 'a0c0de11');
  await expect(dnfBar).toContainText('GCP0001 · Publication et premier trouveur : 1');

  // Onglet Stats : le champ « Données comptées » propose les trois sources
  // de la page (reçues), jamais celles de la page principale.
  await page.locator('a[href="#stats"]').click();
  await page.locator('#statsPanelList li .stats-panel-name').first().click();
  await expect(page.locator('#statsSourceField')).toBeVisible();
  const options = page.locator('#selectStatsSource option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveText('Trouvailles reçues');
  await expect(options.nth(1)).toHaveText('DNF reçus');
  await expect(options.nth(2)).toHaveText('Favoris reçus');
});
