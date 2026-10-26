// Panneaux Stats de la page principale par source : trouvailles, DNF, caches
// posées (docs/panneaux-stats.md, § Sources). Les DNF et les caches posées
// sont comptés même s'ils ne sont pas affichés sur la carte.
//
// Fixtures fictives : my-finds-poses.gpx (trouvailles GC5AAA1 le 01/05/2019
// et GC5AAA2 le 31/03/2020, compte 1234567), logs-poses.json (8 caches
// posées, voir poses.spec.mjs) et un document de logs écrit ici : trois DNF —
// GC5AAA2 le 10/06/2019 et le 02/11/2019 (résolus par sa trouvaille du
// 31/03/2020), GCD0001 le 15/09/2019 (jamais trouvée).
//
// `stats` est une préférence globale, les logs et la collection Labs
// vivent hors de /clear_database, le sélecteur de sources est un réglage
// partagé : tout remettre en sortant (AGENTS.md).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATS, openWithFixture, putStats, snapshot } from './stats-panels-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'gc_logs');
const MY_FINDS = path.join(FIXTURES, 'my-finds-poses.gpx');
const POSES = path.join(FIXTURES, 'logs-poses.json');
const LABS = path.join(HERE, '..', 'fixtures', 'labs');
const LABS_HISTORY = path.join(LABS, 'lab-finds-valid.json');
const LABS_COORDS = path.join(LABS, 'lab2gpx-stages.gpx');

const ME = { id: 1234567, name: 'Joueur_Fictif' };
const DNF_DOC = {
  format: 'mygcflow-logs',
  schema_version: 1,
  exported_at: '2026-10-26T08:00:00Z',
  account: { user_id: ME.id, username: ME.name },
  caches: [{
    gc_code: 'GCD0001', name: 'Échec fictif', type: 'Traditional Cache',
    latitude: 49.25, longitude: 6.0, difficulty: 3, terrain: 2, container: 'Small',
    country: 'France', owner: { id: 7000002, name: 'Poseur_Tiers' },
  }],
  logs: [
    { log_id: 910000001, gc_code: 'GC5AAA2', type_id: 3, date: '2019-06-10', author: ME },
    { log_id: 910000002, gc_code: 'GCD0001', type_id: 3, date: '2019-09-15', author: ME },
    { log_id: 910000003, gc_code: 'GC5AAA2', type_id: 3, date: '2019-11-02', author: ME },
  ],
};

async function importLogs(request, name, buffer) {
  const preview = await request.post('/api/logs/import/preview', {
    multipart: { file: { name, mimeType: 'application/json', buffer } },
  });
  expect(preview.ok()).toBeTruthy();
  const { import_token: token } = await preview.json();
  const commit = await request.post('/api/logs/import/commit', { data: { import_token: token } });
  expect(commit.status()).toBe(202);
  const { task_id: taskId } = await commit.json();
  await expect.poll(async () => (await (await request.get(`/tasks/${taskId}`)).json()).state,
    { timeout: 30_000 }).toBe('finished');
}

const PANELS = [
  { id: 'abc00001', kind: 'counter', metric: 'summary',
    options: { source: 'dnf', items: ['total', 'caches', 'dnf_open', 'dnf_resolved', 'dnf_ratio'] } },
  { id: 'abc00002', kind: 'bar', metric: 'difficulty', options: { source: 'dnf' } },
  { id: 'abc00003', kind: 'counter', metric: 'summary',
    options: { source: 'owned', items: ['total', 'owned_active', 'owned_disabled', 'owned_archived', 'maintenances'] } },
  { id: 'abc00004', kind: 'bar', metric: 'year', options: { source: 'owned' } },
];

function altText(page, id) {
  return page.locator(`canvas.stats-panel[data-panel-id="${id}"] + .stats-panel-alt`);
}

// My Finds par l'interface, logs par l'API, panneaux posés, puis rechargement
// de la page : les DNF et les caches posées sont lus au démarrage.
async function openWithSources(page, request, panels = PANELS) {
  await openWithFixture(page, '', MY_FINDS, '2 / 2');
  await importLogs(request, 'logs-poses.json', fs.readFileSync(POSES));
  await importLogs(request, 'dnf.json', Buffer.from(JSON.stringify(DNF_DOC)));
  await putStats(page, { enabled: true, panels, evolution_panels: [] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.hasDnfData() && app.hasOwnedCaches();
  }), { timeout: 15_000 }).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/logs/clear').catch(() => {});
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings', { data: { stats: DEFAULT_STATS } }).catch(() => {});
  await request.post('/api/logs/clear').catch(() => {});
  await request.put('/api/settings', { data: { main_discovery_sources: 'geocaches', labs_auto_fetch_coords: false } }).catch(() => {});
  await request.post('/api/labs/clear').catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


test('au repos : DNF et caches posées comptés même masqués sur la carte', async ({ page, request }) => {
  await openWithSources(page, request);
  // Affichage carte coupé (défaut) : rien sur la carte, tout dans les Stats.
  const map = await page.evaluate(() => ({
    dnf: window.dnfVectorSource?.getFeatures().length ?? 0,
    owned: window.ownerVectorSource?.getFeatures().length ?? 0,
  }));
  expect(map).toEqual({ dnf: 0, owned: 0 });

  const snap = await snapshot(page);
  // Difficulté (index 0 = 1, 2 = 2, 4 = 3) : deux DNF sur GC5AAA2, un sur GCD0001.
  expect(snap.sources.dnf.counts.difficulty).toEqual({ 2: 2, 4: 1 });
  expect(snap.sources.owned.counts.year).toEqual({ 2018: 2, 2019: 4, 2020: 1 });
  expect(snap.sources.owned.total).toBe(7);
  expect(snap.sources.dnf.total).toBe(3);
  // Les trouvailles gardent leur propre compte.
  expect(snap.total).toBe(2);

  const dnf = altText(page, 'abc00001');
  await expect(dnf).toContainText('Chiffres clés des DNF');
  await expect(dnf).toContainText('DNF : 3');
  await expect(dnf).toContainText('Caches en échec : 2');
  await expect(dnf).toContainText('DNF en cours : 1');
  await expect(dnf).toContainText('DNF résolus : 1');
  // 3 DNF pour 2 trouvailles.
  await expect(dnf).toContainText(/Taux d'échec : 60/);

  const owned = altText(page, 'abc00003');
  await expect(owned).toContainText('Caches posées : 7');
  await expect(owned).toContainText('Caches actives : 5');
  await expect(owned).toContainText('Caches désactivées : 0');
  await expect(owned).toContainText('Caches archivées : 2');
  await expect(owned).toContainText('Maintenances : 1');
});


test('dans le temps : tuiles d\'état et comptes au jour affiché', async ({ page, request }) => {
  await openWithSources(page, request);
  expect(await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2019, 0, 1);
    return app.startPausedPreview();
  })).toBe(true);
  const seek = (y, m, d) => page.evaluate(async ([yy, mm, dd]) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(yy, mm, dd)), [y, m, d]);

  // 05/09/2019 : GCP0004 désactivée ; un seul DNF (10/06).
  await seek(2019, 8, 5);
  await expect.poll(async () => (await snapshot(page)).sources.dnf.total).toBe(1);
  await expect(altText(page, 'abc00003')).toContainText('Caches désactivées : 1');
  await expect(altText(page, 'abc00001')).toContainText('DNF en cours : 1');

  // 05/10/2019 : GCP0005 archivée par son poseur, maintenance du 10/09 faite ;
  // deux DNF en cours pour une trouvaille (2 / 3 tentatives).
  await seek(2019, 9, 5);
  await expect.poll(async () => (await snapshot(page)).sources.dnf.total).toBe(2);
  const owned = altText(page, 'abc00003');
  await expect(owned).toContainText('Caches posées : 6');
  await expect(owned).toContainText('Caches archivées : 1');
  await expect(owned).toContainText('Caches désactivées : 0');
  await expect(owned).toContainText('Maintenances : 1');
  const dnf = altText(page, 'abc00001');
  await expect(dnf).toContainText('DNF en cours : 2');
  await expect(dnf).toContainText('DNF résolus : 0');
  await expect(dnf).toContainText(/Taux d'échec : 67/);

  // Retour en arrière : les comptes redescendent.
  await seek(2019, 4, 2);
  await expect.poll(async () => (await snapshot(page)).sources.dnf.total).toBe(0);
  await page.locator('#btnQuickStop').click();
});


// Non-régression : un DNF ne peut exister que sur une géocache. Quand la
// sélection affiche aussi des Lab Caches, le dénominateur du « taux
// d'échec » ne doit retenir que les trouvailles de géocaches — sinon les
// 8 étapes Labs dilueraient le taux à 3 / (3 + 2 + 8) ≈ 23 % au lieu de
// 3 / (3 + 2) = 60 %.
test('le taux d\'échec ignore les Lab Caches de la sélection', async ({ page, request }) => {
  // Le service lab2gpx ne doit jamais être appelé en test.
  await request.put('/api/settings', { data: { labs_auto_fetch_coords: false } });
  await openWithSources(page, request, [PANELS[0]]);

  // Import Labs par l'interface (8 étapes affichables, comme
  // labs-sources.spec.mjs) : l'import bascule le sélecteur de sources sur
  // « labs », le remettre sur « both » — 2 géocaches + 8 étapes.
  await page.locator('#labs-file-input').setInputFiles([LABS_HISTORY, LABS_COORDS]);
  await expect(page.locator('#labsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#labsPreviewConfirmBtn').click();
  await expect(page.locator('#labsStatus')).toContainText('8', { timeout: 60_000 });
  await page.locator('#selectDiscoverySources').selectOption('both');
  await expect(page.locator('#filtersCounter')).toContainText('10', { timeout: 60_000 });

  // 3 DNF pour 2 trouvailles de géocaches : toujours 60 %, pas ~23 %.
  await expect(altText(page, 'abc00001')).toContainText(/Taux d'échec : 60/);
});


// « État de mes caches » (métrique status de la source owned) se lit au jour
// affiché dans ownerStatsAtDay, pas dans l'accumulateur : le panneau doit se
// redessiner même les jours sans log (un archivage n'est pas un événement de
// pose) — comme les tuiles d'état du compteur.
test('le graphe d\'état des caches posées suit le jour affiché', async ({ page, request }) => {
  await openWithSources(page, request, [
    { id: 'abc00005', kind: 'donut', metric: 'status', options: { source: 'owned' } },
  ]);

  // Au repos : état actuel des fixtures (5 actives, 2 archivées).
  const alt = altText(page, 'abc00005');
  await expect(alt).toContainText('État de mes caches');
  await expect(alt).toContainText('Caches actives : 5');
  await expect(alt).toContainText('Caches archivées : 2');

  // 05/09/2019 : GCP0004 est désactivée ce jour-là (poses.spec.mjs).
  expect(await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2019, 0, 1);
    return app.startPausedPreview();
  })).toBe(true);
  await page.evaluate(async () =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(2019, 8, 5)));
  await expect(alt).toContainText('Caches désactivées : 1');
  await page.locator('#btnQuickStop').click();
});


// La liste de l'onglet signale la source comptée — un titre personnalisé
// ne dit plus ce que le panneau compte — et une source sans données,
// faute de quoi son panneau resterait dessiné à zéro sans explication.
test('la liste signale la source comptée et les sources sans données', async ({ page, request }) => {
  const panels = [
    { ...PANELS[0], title: 'Compteur A' },
    { ...PANELS[2], title: 'Compteur B' },
  ];
  await openWithSources(page, request, panels);
  await page.locator('a[href="#stats"]').click();
  const rows = page.locator('#statsPanelList li');
  await expect(rows.nth(0)).toContainText('DNF');
  await expect(rows.nth(1)).toContainText('Caches posées');

  // Logs vidés : les deux sources perdent leurs données au rechargement.
  await request.post('/api/logs/clear');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await expect(rows.nth(0)).toContainText('aucune donnée');
  await expect(rows.nth(1)).toContainText('aucune donnée');
});


test('le formulaire propose la source et garde la statistique quand elle existe', async ({ page, request }) => {
  await openWithSources(page, request, [PANELS[1]]);
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsSourceField')).toBeVisible();
  await expect(page.locator('#selectStatsSource')).toHaveValue('dnf');
  await expect(page.locator('#selectStatsMetric option[value="attribute"]')).toHaveCount(0);

  // Réglages de la métrique : conservés quand la nouvelle source la garde.
  await page.locator('#selectStatsSort').selectOption('race');
  await page.locator('#selectStatsOrientation').selectOption('vertical');
  await expect.poll(async () =>
    (await (await request.get('/api/settings')).json()).stats.panels[0]?.options?.sort
  ).toBe('race');

  // Vers les caches posées : la difficulté existe aussi — métrique et
  // réglages gardés.
  await page.locator('#selectStatsSource').selectOption('owned');
  await expect.poll(async () => (await snapshot(page)).sources?.owned?.counts?.difficulty).toBeTruthy();
  await expect(page.locator('#selectStatsMetric')).toHaveValue('difficulty');
  await expect(page.locator('#selectStatsSort')).toHaveValue('race');
  await expect(page.locator('#selectStatsOrientation')).toHaveValue('vertical');
  // Vers les trouvailles : l'option `source` disparaît du réglage, les
  // réglages de la métrique restent.
  await page.locator('#selectStatsSource').selectOption('finds');
  await expect.poll(async () => {
    const stats = (await (await request.get('/api/settings')).json()).stats;
    return stats.panels[0]?.options?.source ?? 'finds';
  }).toBe('finds');
  await expect(page.locator('#selectStatsSort')).toHaveValue('race');

  // Métrique étrangère à la source (« Attributs », trouvailles seulement) :
  // repli sur la première du même type et options par défaut. (Relevé dans
  // les réglages : le champ garde la valeur tapée tant qu'il a le focus.)
  await page.locator('#selectStatsMetric').selectOption('attribute');
  await page.locator('#inputStatsMaxItems').fill('5');
  await page.locator('#selectStatsSource').selectOption('dnf');
  await expect(page.locator('#selectStatsMetric')).toHaveValue('cache_type');
  await expect.poll(async () => {
    const panel = (await (await request.get('/api/settings')).json()).stats.panels[0];
    return [panel?.options?.source, panel?.options?.max_items];
  }).toEqual(['dnf', 8]);

  // Galerie : sections DNF et caches posées proposées avec leurs données.
  await page.locator('#btnStatsAdd').click();
  await expect(page.locator('#statsGalleryModal')).toBeVisible();
  await expect(page.locator('[data-stats-preset="dnf-overview"]')).toBeVisible();
  await expect(page.locator('[data-stats-preset="owned-overview"]')).toBeVisible();
});
