// Page « Mes poses » : animation des points (points.poses_effects du thème,
// poses_effects.mjs, docs/mode-poses.md) — niveau et cases, attributs lus par
// le shader, couche de lueur, flash de palier, aperçu complet.
//
// Fixture tests/fixtures/gc_logs/logs-poses.json (voir poses.spec.mjs),
// augmentée ici de 10 trouvailles sur GCP0001 pour atteindre un palier rond.
// Les effets ne sont modifiés qu'en mémoire (thème jamais enregistré) ; les
// logs sont vidés en entrée et en sortie (AGENTS.md).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-poses.json');

async function clearLogs(request) {
  const response = await request.post('/api/logs/clear');
  expect(response.ok()).toBeTruthy();
}

// `extraFinds` : trouvailles ajoutées à GCP0001, une par semaine dès le
// 07/01/2019, par des joueurs distincts.
async function importPoses(request, { extraFinds = 0 } = {}) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (let n = 0; n < extraFinds; n++) {
    const date = new Date(Date.UTC(2019, 0, 7 + 7 * n)).toISOString().slice(0, 10);
    data.logs.push({
      log_id: 900099001 + n, gc_code: 'GCP0001', type_id: 2, date,
      author: { id: 3000001 + n, name: `Visiteur ${n + 1}` }, favorite: false,
    });
  }
  const preview = await request.post('/api/logs/import/preview', {
    multipart: {
      file: { name: 'logs-poses.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) },
    },
  });
  expect(preview.ok()).toBeTruthy();
  const { import_token: token } = await preview.json();
  const commit = await request.post('/api/logs/import/commit', { data: { import_token: token } });
  expect(commit.status()).toBe(202);
  const { task_id: taskId } = await commit.json();
  await expect.poll(async () => (await (await request.get(`/tasks/${taskId}`)).json()).state,
    { timeout: 30_000 }).toBe('finished');
}

async function openPoses(page) {
  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true, null, { timeout: 30_000 });
}

function debugState(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getPosesDebugState());
}

// Effets posés en mémoire (comme un réglage de l'onglet Points), puis
// redessin : le style est figé à la création de la couche.
function setEffects(page, patch) {
  return page.evaluate(async (p) => {
    const app = await import('/static/js/index.js');
    const { normalizePosesEffects } = await import('/static/js/poses_effects.mjs');
    app.options.point.posesEffects = normalizePosesEffects(p, app.options.point.posesEffects);
    app.refreshPoints(app.options);
  }, patch);
}

async function openPointsTab(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabPoints"]').click();
  await expect(page.locator('#posesEffectsCard')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await clearLogs(request);
  const response = await request.put('/api/settings', {
    data: { poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 60 } },
  });
  expect(response.ok()).toBeTruthy();
});

test('niveau d’animation : préréglages, cases et attributs des points', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importPoses(request);
  await openPoses(page);
  await openPointsTab(page);

  const level = page.locator('#selectPosesEffectsLevel');
  // Thème antérieur aux effets : sobre, rendu inchangé.
  await expect(level).toHaveValue('sober');
  await expect(page.locator('#posesFxPopularity')).not.toBeChecked();
  await expect(page.locator('#posesFxPopularityScale')).toBeDisabled();
  let state = await debugState(page);
  expect(state.activityLayer).toBe(false);
  expect(state.features.every((f) => f.popLevels === 0 && f.heatVal === 0)).toBe(true);

  // Riche : toutes les cases, couche de lueur, attributs écrits au repos.
  await level.selectOption('rich');
  for (const id of ['posesFxPopularity', 'posesFxActivity', 'posesFxFreshness', 'posesFxMilestone', 'posesFxPulse']) {
    await expect(page.locator(`#${id}`), id).toBeChecked();
  }
  await expect(page.locator('#posesFxActivityHalfLife')).toBeEnabled();
  await expect.poll(async () => (await debugState(page)).activityLayer).toBe(true);
  state = await debugState(page);
  expect(state.effects.level).toBe('rich');
  // GCP0004 n'a jamais été trouvée : taille du thème, fraîcheur depuis son
  // apparition. Les autres ont grandi et gardent une chaleur.
  const unfound = state.features.find((f) => f.code === 'GCP0004');
  expect(unfound.popLevels).toBe(0);
  expect(unfound.heatVal).toBe(0);
  expect(unfound.lastFind).toBe(unfound.placedDay);
  const found = state.features.filter((f) => f.code !== 'GCP0004');
  expect(found.length).toBe(6);
  expect(found.every((f) => f.heatVal > 0)).toBe(true);
  expect(found.every((f) => f.popLevels > 0)).toBe(true);

  // Une case touchée : « Personnalisé », la couche de lueur disparaît.
  await page.locator('#posesFxActivity').uncheck();
  await expect(level).toHaveValue('custom');
  await expect(page.locator('#posesFxActivityHalfLife')).toBeDisabled();
  await expect.poll(async () => (await debugState(page)).activityLayer).toBe(false);
  // Réglage d'intensité gardé d'un préréglage à l'autre.
  await page.locator('#posesFxFreshnessAfter').fill('120');
  await page.locator('#posesFxFreshnessAfter').dispatchEvent('change');
  await level.selectOption('sober');
  await expect(page.locator('#posesFxFreshness')).not.toBeChecked();
  await level.selectOption('balanced');
  await expect(page.locator('#posesFxFreshness')).toBeChecked();
  await expect(page.locator('#posesFxActivity')).not.toBeChecked();
  await expect(page.locator('#posesFxFreshnessAfter')).toHaveValue('120');
  if (process.env.VISUAL_OUT) await page.locator('#posesEffectsCard').screenshot({ path: `${process.env.VISUAL_OUT}/poses-effects-card.png` });
  expect(errors).toEqual([]);
});

test('flash de palier : seulement quand la case est cochée', async ({ page, request }) => {
  await importPoses(request, { extraFinds: 10 });
  await openPoses(page);
  const run = () => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { lifecycleEngine } = await import('/static/js/lifecycle_engine.mjs');
    const engine = lifecycleEngine();
    const start = new Date(2018, 2, 1);
    const end = new Date(2020, 11, 31);
    app.clearPosesFlashLog();
    engine.begin(start, end, performance.now(), {});
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      engine.step([new Date(d)], performance.now());
    }
    engine.end();
    app.showLifecycleRestState();
    return app.getPosesDebugState().flashLog.filter((f) => f.kind === 'milestone').map((f) => f.code);
  });
  expect(await run()).toEqual([]);
  await setEffects(page, { milestone_flash: true });
  expect(await run()).toEqual(['GCP0001']);
});

test('aperçu complet en « Riche », vectoriel puis icônes, sans erreur', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await importPoses(request, { extraFinds: 10 });
  const response = await request.put('/api/settings', {
    data: { poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 3 } },
  });
  expect(response.ok()).toBeTruthy();
  await openPoses(page);
  await setEffects(page, {
    popularity: { enabled: true }, activity: { enabled: true }, freshness: { enabled: true, after_days: 60 },
    milestone_flash: true, disabled_pulse: true, archived_style: 'ghost',
  });
  const playOnce = async () => {
    await page.locator('#btnQuickPreview').click();
    await expect.poll(async () => page.evaluate(async () =>
      (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 30_000 }).toBe('playing');
    await expect.poll(async () => page.evaluate(async () =>
      (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 60_000 }).toBe('idle');
  };
  await playOnce();
  let state = await debugState(page);
  expect(state.activityLayer).toBe(true);
  expect(state.states).toEqual({ active: 5, disabled: 0, archived: 2 });
  if (process.env.VISUAL_OUT) await page.locator('#map').screenshot({ path: `${process.env.VISUAL_OUT}/poses-effects-vector.png` });

  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.point.mode = 'icone';
    app.refreshPoints(app.options);
  });
  await playOnce();
  state = await debugState(page);
  expect(state.activityLayer).toBe(true);
  if (process.env.VISUAL_OUT) await page.locator('#map').screenshot({ path: `${process.env.VISUAL_OUT}/poses-effects-icons.png` });
  expect(errors).toEqual([]);
});
