// Page « Mes poses » : pseudos des visiteurs (points.poses_names du thème,
// préférence globale poses_names_privacy ; docs/mode-poses.md).
//
// Fixture tests/fixtures/gc_logs/logs-poses.json (visiteurs Alice, Bob,
// Chloé, Testeur), augmentée de trouvailles sur GCP0001. Les réglages du
// thème ne sont modifiés qu'en mémoire (thème jamais enregistré) ; la
// préférence de confidentialité et le rythme sont remis en sortie, les logs
// vidés en entrée et en sortie (AGENTS.md).
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'gc_logs', 'logs-poses.json');
const VISITORS = ['Alice', 'Bob', 'Chloé', 'Testeur'];

async function clearLogs(request) {
  const response = await request.post('/api/logs/clear');
  expect(response.ok()).toBeTruthy();
}

async function importPoses(request, { extraFinds = 0 } = {}) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (let n = 0; n < extraFinds; n++) {
    const date = new Date(Date.UTC(2019, 0, 7 + 7 * n)).toISOString().slice(0, 10);
    data.logs.push({
      log_id: 900099001 + n, gc_code: 'GCP0001', type_id: 2, date,
      author: { id: 3000001 + n, name: `Visiteur ${n + 1}` }, favorite: n % 3 === 0,
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

async function openNamesTab(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabNames"]').click();
  await expect(page.locator('#posesNamesEnabled')).toBeVisible();
}

function namesDebug(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getNameLabelsDebugState());
}

// Réglages posés en mémoire, comme une saisie de l'onglet.
function setNames(page, patch) {
  return page.evaluate(async (p) => {
    const app = await import('/static/js/index.js');
    const { normalizePosesNames } = await import('/static/js/poses_names.mjs');
    app.options.point.posesNames = normalizePosesNames(p, app.options.point.posesNames);
    app.syncPosesNamesUI();
  }, patch);
}

// Le moteur piloté jour par jour : étiquettes renvoyées par chaque lot.
function namesOverYears(page) {
  return page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { lifecycleEngine } = await import('/static/js/lifecycle_engine.mjs');
    const engine = lifecycleEngine();
    const start = new Date(2018, 2, 1);
    const end = new Date(2020, 11, 31);
    const out = [];
    engine.begin(start, end, performance.now(), {});
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ev = engine.step([new Date(d)], performance.now());
      for (const c of ev?.names || []) out.push({ text: c.text, kind: c.kind, code: c.code, hasFeature: !!c.feature });
    }
    engine.end();
    app.showLifecycleRestState();
    return out;
  });
}

test.beforeEach(async ({ request }) => {
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await clearLogs(request);
  const response = await request.put('/api/settings', {
    data: {
      poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 60 },
      poses_names_privacy: { mode: 'show', exclude: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
});

test('onglet Pseudos : désactivé par défaut, styles prêts à l’emploi, champs liés', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importPoses(request);
  await openPoses(page);
  await openNamesTab(page);

  // Thème antérieur aux pseudos : désactivés, style « Envol ».
  await expect(page.locator('#posesNamesEnabled')).not.toBeChecked();
  await expect(page.locator('#selectPosesNamesPreset')).toHaveValue('rise');
  expect(await namesOverYears(page)).toEqual([]);

  // Un style règle mouvement et texte ; la couleur par visiteur masque le
  // nuancier fixe comme les couleurs par événement.
  await page.locator('#selectPosesNamesPreset').selectOption('burst');
  await expect(page.locator('#posesNamesDirection')).toHaveValue('radial');
  await expect(page.locator('#posesNamesExit')).toHaveValue('scatter');
  await expect(page.locator('#posesNamesStagger')).toBeEnabled();
  await expect(page.locator('#posesNamesColorRow')).toBeHidden();
  await expect(page.locator('#posesNamesKindColors')).toBeHidden();
  await page.locator('#posesNamesColorMode').selectOption('event');
  await expect(page.locator('#posesNamesKindColors')).toBeVisible();
  await expect(page.locator('#selectPosesNamesPreset')).toHaveValue('');
  await page.locator('#posesNamesColorMode').selectOption('fixed');
  await expect(page.locator('#posesNamesKindColors')).toBeHidden();
  await expect(page.locator('#posesNamesColorRow')).toBeVisible();

  // Champs → réglages en mémoire.
  await page.locator('#posesNamesEnabled').check();
  await page.locator('#posesNamesTemplate').fill('{pseudo} · {n}');
  await page.locator('#posesNamesSize').fill('22');
  await page.locator('#posesNamesSize').dispatchEvent('change');
  const names = await page.evaluate(async () => (await import('/static/js/index.js')).options.point.posesNames);
  expect(names.enabled).toBe(true);
  expect(names.template).toBe('{pseudo} · {n}');
  expect(names.size).toBe(22);
  expect(names.direction).toBe('radial');
  if (process.env.VISUAL_OUT) await page.locator('#tabNames').screenshot({ path: `${process.env.VISUAL_OUT}/poses-names-tab.png` });
  expect(errors).toEqual([]);
});

test('lots de jours : une étiquette par visiteur, logs marquants, confidentialité', async ({ page, request }) => {
  await importPoses(request, { extraFinds: 10 });
  await openPoses(page);
  await setNames(page, { enabled: true, grouping: 'separate', badges: false, max_visible: 60 });
  let labels = await namesOverYears(page);
  expect(labels.length).toBeGreaterThan(10);
  expect(labels.every((l) => l.hasFeature)).toBe(true);
  const shown = new Set(labels.map((l) => l.text));
  for (const name of ['Alice', 'Bob', 'Visiteur 1']) expect(shown.has(name), name).toBe(true);
  expect(labels.some((l) => l.kind === 'ftf')).toBe(true);
  // Le poseur et le relecteur ne sont jamais des visiteurs.
  expect(shown.has('Joueur_Fictif')).toBe(false);
  expect(shown.has('Relecteur')).toBe(false);

  // Seulement les logs marquants : plus aucune trouvaille ordinaire.
  await setNames(page, { only_notable: true });
  labels = await namesOverYears(page);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.every((l) => ['ftf', 'milestone', 'favorite', 'loyal'].includes(l.kind))).toBe(true);

  // Confidentialité (préférence globale, relue au rechargement).
  const response = await request.put('/api/settings', {
    data: { poses_names_privacy: { mode: 'initials', exclude: ['bob'] } },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true, null, { timeout: 30_000 });
  await setNames(page, { enabled: true, grouping: 'separate', badges: false, only_notable: false, max_visible: 60 });
  labels = await namesOverYears(page);
  const texts = new Set(labels.map((l) => l.text));
  expect(texts.has('A.')).toBe(true);
  expect(texts.has('B.')).toBe(false);   // Bob exclu
  for (const name of VISITORS) expect(texts.has(name), name).toBe(false);
  await openNamesTab(page);
  await expect(page.locator('#selectPosesNamesPrivacy')).toHaveValue('initials');
  await expect(page.locator('#textareaPosesNamesExclude')).toHaveValue('bob');
});

test('aperçu au repos puis lecture complète : étiquettes dessinées, sans erreur', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await importPoses(request, { extraFinds: 10 });
  const response = await request.put('/api/settings', {
    data: { poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 4 } },
  });
  expect(response.ok()).toBeTruthy();
  await openPoses(page);
  await openNamesTab(page);

  // Aperçu : des pseudos réels en boucle, sans lancer l'animation.
  await page.locator('#btnPosesNamesPreview').click();
  await expect(page.locator('#btnPosesNamesPreview')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await namesDebug(page)).active).toBeGreaterThan(0);
  let debug = await namesDebug(page);
  expect(debug.preview).toBe(true);
  expect(debug.layer).toBe(true);
  expect(debug.history.some((h) => VISITORS.some((v) => h.text.includes(v)) || /Visiteur/.test(h.text))).toBe(true);
  // Chaque réglage s'y voit aussitôt : la vague suivante suit le style.
  await page.locator('#selectPosesNamesPreset').selectOption('bubbles');
  if (process.env.VISUAL_OUT) {
    await page.waitForTimeout(1200);
    await page.locator('#map').screenshot({ path: `${process.env.VISUAL_OUT}/poses-names-preview.png` });
  }
  await page.locator('#btnPosesNamesPreview').click();
  await expect(page.locator('#btnPosesNamesPreview')).toHaveAttribute('aria-pressed', 'false');
  expect((await namesDebug(page)).preview).toBe(false);

  // Lecture : les lots de jours font naître des étiquettes à l'écran ; un
  // arrêt sur image les fige, la fin les laisse s'éteindre.
  await setNames(page, { enabled: true, grouping: 'separate', duration_ms: 2500, max_visible: 30 });
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await namesDebug(page)).spawned, { timeout: 30_000 }).toBeGreaterThan(0);
  debug = await namesDebug(page);
  expect(debug.preview).toBe(false);
  // Pause : horloge des étiquettes figée.
  await page.locator('#btnQuickPause').click();
  if (process.env.VISUAL_OUT) await page.locator('#map').screenshot({ path: `${process.env.VISUAL_OUT}/poses-names-playing.png` });
  const frozen = await namesDebug(page);
  await page.waitForTimeout(400);
  const later = await namesDebug(page);
  expect(later.now).toBe(frozen.now);
  expect(later.labels.map((l) => l.pose)).toEqual(frozen.labels.map((l) => l.pose));
  await page.locator('#btnQuickPause').click(); // Continuer
  await expect.poll(async () => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 60_000 }).toBe('idle');
  debug = await namesDebug(page);
  expect(debug.spawned).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});
