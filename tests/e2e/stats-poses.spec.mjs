// Panneaux Stats de la page Mes poses (/poses) : ils comptent les
// trouvailles REÇUES (logs « Found it » des autres joueurs sur les caches
// posées), liste propre `stats.poses_panels`.
//
// Fixture : tests/fixtures/gc_logs/logs-poses.json — 12 trouvailles reçues
// sur les caches placées (GCP0003 : 4, GCP0001, GCP0005, GCP0006 : 2,
// GCP0002, GCP0008 : 1), 3 favoris, 4 trouveurs (Alice, Bob, Chloé, Testeur).
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
// trouveurs fidèles (accumulateur), délai moyen avant la FTF et cache la
// plus délaissée (chronologie de la page, au jour affiché). Sur la fixture :
// 3 favoris / 12 trouvailles ; Alice (5) et Bob (4) sont les seuls fidèles
// (≥ 3) ; délais FTF 0, 14, 0, 1, 19 et 1 j (moyenne 35/6 ≈ 5,8 →
// « 6 jours ») ; GCP0004 jamais trouvée.
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
  await expect(alt).toContainText('Délai moyen avant la FTF : 6 jours');
  await expect(alt).toContainText('GCP0004 · jamais trouvée');
});
