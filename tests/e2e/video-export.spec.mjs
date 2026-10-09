import { expect, test } from '@playwright/test';
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const RUNTIME = process.env.MYGCFLOW_E2E_RUNTIME;


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    try {
      const app = await import('/static/js/index.js');
      const scaleInput = document.querySelector('#inputRecordScaleFactor');
      return Boolean(
        window.mygcflowReady === true
        &&
        app.options?.record?.mediaRecorder
        && app.getMap?.()
        && document.querySelector('#selectType')?.tomselect
        && scaleInput?.value !== ''
        && Number.isFinite(Number(app.options.record.mediaRecorder.scaleFactor)),
      );
    } catch (_) {
      return false;
    }
  });
  // Sans ce renvoi, la spec ne passait qu'après une autre ayant peuplé la
  // base : lancée seule, la modale interceptait le premier clic.
  await dismissFirstUseModal(page);
}


async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await page.waitForFunction(async () => {
    const app = await import('/static/js/index.js');
    return app.metadata?.numberOfCaches === 6 && app.pointsByDate?.size === 6;
  });
}


async function selectTraditionalCaches(page) {
  await page.evaluate(() => {
    document.querySelector('#selectType').tomselect.setValue(['Traditional Cache']);
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 6');
}


function latestCompletedMp4() {
  const videoDir = path.join(RUNTIME, 'video');
  try {
    const candidates = readdirSync(videoDir)
      .filter((name) => name.endsWith('.mp4'))
      .map((name) => ({ path: path.join(videoDir, name), stat: statSync(path.join(videoDir, name)) }))
      .filter(({ stat }) => stat.size >= 1_000)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return candidates[0]?.path || null;
  } catch (_) {
    return null;
  }
}


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await importFixture(page);
});


test('l\'import GPX et le filtre Type alimentent la vraie timeline', async ({ page }) => {
  await selectTraditionalCaches(page);

  const state = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    // Les dates de métadonnées sont des minuits LOCAUX (même convention que
    // pointsByDate/toDateString et l'itération setDate de l'animation) :
    // toISOString() décalerait d'un jour dans les fuseaux UTC+.
    const localIso = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      selectedCaches: app.metadata.numberOfCaches,
      timelineDays: app.pointsByDate.size,
      timelineCaches: [...app.pointsByDate.values()].reduce((total, points) => total + points.length, 0),
      startDate: localIso(app.metadata.startDate),
      endDate: localIso(app.metadata.endDate),
    };
  });

  expect(state).toEqual({
    selectedCaches: 3,
    timelineDays: 3,
    timelineCaches: 3,
    startDate: '2026-01-01',
    endDate: '2026-01-05',
  });
});


test('les profils vidéo et les bornes corrigent les valeurs excessives', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('mediarecorder');

  const advanced = page.locator('#recordAdvancedSettings');
  if (!(await advanced.evaluate((element) => element.open))) {
    await advanced.locator('summary').click();
  }

  const fps = page.locator('#inputRecordFps');
  await fps.fill('300');
  await expect(fps).toHaveClass(/is-invalid/);
  await expect(page.locator('#recordFpsError')).toBeVisible();
  await fps.blur();
  await expect(fps).toHaveValue('60');
  await expect(fps).not.toHaveClass(/is-invalid/);

  const bitrate = page.locator('#inputRecordBitrate');
  await bitrate.fill('6000');
  await expect(bitrate).toHaveClass(/is-invalid/);
  await expect(page.locator('#recordBitrateError')).toBeVisible();
  await bitrate.blur();
  await expect(bitrate).toHaveValue('30');

  const slowdown = page.locator('#inputRecordSlowdown');
  await expect(page.locator('#recordSlowdownHelp')).toBeVisible();
  await slowdown.fill('0');
  await expect(slowdown).toHaveClass(/is-invalid/);
  await expect(page.locator('#recordSlowdownError')).toBeVisible();
  await slowdown.blur();
  await expect(slowdown).toHaveValue('1');
  await expect(slowdown).not.toHaveClass(/is-invalid/);

  const scaleFactor = page.locator('#inputRecordScaleFactor');
  await expect(page.locator('#recordScaleHelp')).toBeVisible();
  await scaleFactor.fill('4');
  await expect(scaleFactor).toHaveClass(/is-invalid/);
  await expect(page.locator('#recordScaleError')).toBeVisible();
  await scaleFactor.blur();
  await expect(scaleFactor).toHaveValue('3');
  await expect(scaleFactor).not.toHaveClass(/is-invalid/);

  const bounded = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return {
      fps: app.options.record.fps,
      bitrate: app.options.record.mediaRecorder.videoBitsPerSecond,
      slowdown: app.options.record.mediaRecorder.slowdownFactor,
      scaleFactor: app.options.record.mediaRecorder.scaleFactor,
    };
  });
  expect(bounded).toEqual({ fps: 60, bitrate: 30_000_000, slowdown: 1, scaleFactor: 3 });

  await page.locator('#selectRecordQualityProfile').selectOption('standard');
  await expect(fps).toHaveValue('30');
  await expect(bitrate).toHaveValue('6');
  await expect(advanced).not.toHaveAttribute('open', '');
});


test('les options MediaRecorder de l\'interface produisent un MP4 validé par ffprobe', async ({ page }, testInfo) => {
  await selectTraditionalCaches(page);

  // Piloter les contrôles visibles comme un utilisateur. Le filtre Type reste un
  // Tom Select (multi-sélection), mais les selects d'enregistrement sont des
  // <select> natifs depuis b724def : Playwright les pilote directement.
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();

  await page.locator('#selectRecordMode').selectOption('mediarecorder');

  // Le format vidéo vit dans « Réglages avancés », replié par défaut : il faut
  // déplier avant de le piloter, un <select> masqué n'étant pas actionnable.
  const advanced = page.locator('#recordAdvancedSettings');
  if (!(await advanced.evaluate((element) => element.open))) {
    await advanced.locator('summary').click();
  }
  await page.locator('#selectRecordMime').selectOption('video/webm;codecs=vp8');
  await page.locator('#inputRecordFps').fill('12');
  await page.locator('#inputRecordBitrate').fill('1');
  await page.locator('#inputRecordSlowdown').fill('2');
  await page.locator('#inputRecordScaleFactor').fill('1');
  // Nom de fichier saisi : le serveur le nettoie (ASCII sans espace) et
  // l'horodate ; l'aide sous le champ annonce le nom réel.
  await page.locator('#inputRecordFileName').fill('Été en Bretagne');
  await expect(page.locator('#recordFileNameHelp')).toContainText(/Ete_en_Bretagne_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}\.mp4/);
  await expect(page.locator('#cbRecordNormalize')).toBeEnabled();
  await page.locator('#cbRecordNormalize').uncheck();

  const configured = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    // Raccourcit uniquement le gel automatique de fin du banc d'essai. Cette
    // option n'a pas encore de contrôle visible dans l'interface.
    app.options.record.mediaRecorder.tailFreezeMs = 250;
    app.options.flash.mode = 'none';
    return {
      mode: app.options.record.mode,
      fps: Number(app.options.record.fps),
      mime: app.options.record.mediaRecorder.mimeType,
      bitrate: Number(app.options.record.mediaRecorder.videoBitsPerSecond),
      slowdown: Number(app.options.record.mediaRecorder.slowdownFactor),
      scaleFactor: Number(app.options.record.mediaRecorder.scaleFactor),
      fileName: app.options.record.fileName,
      normalize: app.options.record.mediaRecorder.offlineNormalization,
      timePerDay: Number(app.options.animation.timePerDay),
      extraEndSeconds: Number(app.options.animation.extraEndSeconds),
    };
  });
  expect(configured).toEqual({
    mode: 'mediarecorder',
    fps: 12,
    mime: 'video/webm;codecs=vp8',
    bitrate: 1_000_000,
    slowdown: 2,
    scaleFactor: 1,
    fileName: 'Été en Bretagne',
    normalize: false,
    timePerDay: 80,
    extraEndSeconds: 0,
  });

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 75_000 });
  await expect.poll(latestCompletedMp4, { timeout: 15_000 }).not.toBeNull();

  const videoPath = latestCompletedMp4();
  // Un seul horodatage, lisible ; -2, -3… si la minute est déjà prise.
  expect(path.basename(videoPath)).toMatch(/^Ete_en_Bretagne_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}(-\d+)?\.mp4$/);
  // Aucun fichier intermédiaire ne reste dans le dossier des vidéos.
  expect(readdirSync(path.dirname(videoPath)).filter((name) => name.endsWith('.webm'))).toEqual([]);

  // L'écran de fin présente le fichier réellement produit : son nom, son
  // dossier, sa taille, et un aperçu lisible dans la page.
  const ready = page.locator('#modal_video_ready');
  await expect(ready.locator('#videoReadyFile')).toHaveText(path.basename(videoPath));
  await expect(ready.locator('#videoReadyFolder')).toHaveText(path.dirname(videoPath));
  await expect(ready.locator('#videoReadyMeta')).toContainText('Mo');
  const player = ready.locator('#videoReadyPlayer');
  const previewUrl = await player.getAttribute('src');
  expect(previewUrl).toContain(`/download_video/${encodeURIComponent(path.basename(videoPath))}?inline=1`);
  const preview = await page.request.get(previewUrl);
  expect(preview.status()).toBe(200);
  expect(preview.headers()['content-disposition'] || '').not.toContain('attachment');
  // Fermée, la modale relâche le fichier : plus de lecture en cours dessus.
  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(ready).toBeHidden();
  await expect(player).not.toHaveAttribute('src', /.+/);

  // Champ vidé : le nom du thème actif reprend la main. Le réglage est
  // global, on le laisse vide pour les tests suivants.
  await page.locator('#inputRecordFileName').fill('');
  await expect(page.locator('#recordFileNameHelp')).toContainText('nom du thème actif');
  await expect.poll(async () => (
    await (await page.request.get('/api/settings')).json()
  ).recording.file_name).toBe('');
  const expectationPath = path.join(RUNTIME, 'browser-video-expectation.json');
  writeFileSync(expectationPath, JSON.stringify({
    duration_seconds: 1.3,
    duration_tolerance_seconds: 1.0,
    fps: 12,
    fps_tolerance: 1.0,
    has_audio: false,
    video_codec: 'h264',
    min_size_bytes: 1_000,
  }, null, 2));

  const python = process.env.MYGCFLOW_E2E_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const validation = spawnSync(
    python,
    [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectationPath, '--json'],
    { encoding: 'utf8' },
  );
  expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0);
  const report = JSON.parse(validation.stdout);
  expect(report.success).toBe(true);
  expect(report.duration_seconds).toBeGreaterThan(0.1);

  await testInfo.attach('mygcflow-browser-export.mp4', { path: videoPath, contentType: 'video/mp4' });
  await testInfo.attach('ffprobe-report.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });
});

test('traitement ffmpeg en échec : le repli navigateur livre quand même la vidéo', async ({ page }) => {
  // Le traitement serveur refuse : le navigateur récupère l'enregistrement brut
  // dans le dossier de travail du serveur (/recorded_video), le finalise et le
  // dépose dans le dossier des vidéos. Le brut, lui, n'y apparaît jamais.
  await selectTraditionalCaches(page);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('mediarecorder');
  await page.locator('#selectRecordResolution').selectOption('window');
  const advanced = page.locator('#recordAdvancedSettings');
  if (!(await advanced.evaluate((element) => element.open))) {
    await advanced.locator('summary').click();
  }
  await page.locator('#selectRecordMime').selectOption('video/webm;codecs=vp8');
  await page.locator('#inputRecordFps').fill('12');
  await page.locator('#inputRecordBitrate').fill('1');
  await page.locator('#inputRecordSlowdown').fill('1');
  await page.locator('#inputRecordFileName').fill('Repli');
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.mediaRecorder.tailFreezeMs = 250;
    app.options.flash.mode = 'none';
  });

  let processingRequests = 0;
  await page.route('**/process_recorded_video', async (route) => {
    processingRequests += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'ffmpeg indisponible (test)' }),
    });
  });
  const rawDownload = page.waitForResponse((response) => response.url().includes('/recorded_video/raw_'));

  await page.locator('#btnQuickExport').click({ force: true });
  expect((await rawDownload).status()).toBe(200);

  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  expect(processingRequests).toBe(1);
  const delivered = await ready.locator('#videoReadyFile').textContent();
  expect(delivered).toMatch(/^Repli_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}(-\d+)?\.webm$/);

  const videoDir = path.join(RUNTIME, 'video');
  expect(statSync(path.join(videoDir, delivered)).size).toBeGreaterThan(1_000);
  // Seule la vidéo livrée est un .webm du dossier : aucun brut n'y traîne.
  expect(readdirSync(videoDir).filter((name) => name.endsWith('.webm'))).toEqual([delivered]);

  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await page.locator('#inputRecordFileName').fill('');
  await expect.poll(async () => (
    await (await page.request.get('/api/settings')).json()
  ).recording.file_name).toBe('');
  // Le .webm livré fausserait le contrôle « aucun .webm » des autres tests.
  // Retiré ici plutôt que par l'application, qui l'enverrait à la Corbeille.
  rmSync(path.join(videoDir, delivered));
});

test('le mode images rend la carte à la résolution demandée', async ({ page }, testInfo) => {
  // Le pipeline images capturait à la taille de la fenêtre : une résolution plus
  // haute doit faire RENDRE la carte plus finement (cf. capture_resolution.mjs),
  // pas agrandir l'image. On vérifie donc la taille du MP4 produit.
  await selectTraditionalCaches(page);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('images');

  // Le sélecteur de résolution n'existe qu'en mode images.
  const resolution = page.locator('#selectRecordResolution');
  await expect(resolution).toBeVisible();
  await resolution.selectOption('1080p');

  const plan = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { captureRatioFor } = await import('/static/js/capture_resolution.mjs');
    app.options.record.fps = 12;
    const rect = app.getMap().getViewport().getBoundingClientRect();
    return {
      setting: app.options.record.captureResolution,
      ...captureRatioFor({
        cssWidth: rect.width,
        cssHeight: rect.height,
        devicePixelRatio: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
        resolution: app.options.record.captureResolution,
      }),
    };
  });
  expect(plan.setting).toBe('1080p');
  expect(plan.ratio).toBeGreaterThan(1);

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  await expect.poll(latestCompletedMp4, { timeout: 30_000 }).not.toBeNull();

  const videoPath = latestCompletedMp4();
  const expectationPath = path.join(RUNTIME, 'images-resolution-expectation.json');
  // ffmpeg rogne au multiple de 2 inférieur (yuv420p).
  const even = (value) => Math.floor(value / 2) * 2;
  writeFileSync(expectationPath, JSON.stringify({
    width: even(plan.width),
    height: even(plan.height),
    video_codec: 'h264',
    min_size_bytes: 1_000,
  }, null, 2));

  const python = process.env.MYGCFLOW_E2E_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const validation = spawnSync(
    python,
    [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectationPath, '--json'],
    { encoding: 'utf8' },
  );
  expect(validation.status, `${validation.stdout}
${validation.stderr}`).toBe(0);
  const report = JSON.parse(validation.stdout);
  expect(report.success).toBe(true);
  expect(report.height).toBe(even(plan.height));

  // La carte doit être revenue à la densité de l'écran après la capture.
  const restored = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.getMap().pixelRatio_;
  });
  expect(restored).toBeLessThanOrEqual(Math.max(1, Math.min(3, 3)));
  expect(restored).toBeLessThan(plan.ratio);

  await testInfo.attach('images-export.mp4', { path: videoPath, contentType: 'video/mp4' });
});

test('le mode MediaRecorder rend aussi la carte à la résolution demandée', async ({ page }, testInfo) => {
  // Harmonisation : le « facteur d'échelle » étirait la carte vers un canvas plus
  // grand. Les deux pipelines passent désormais par le même calcul et font RENDRE
  // la carte à la densité de sortie.
  await selectTraditionalCaches(page);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('mediarecorder');

  // Le sélecteur de résolution vaut pour les deux modes.
  const resolution = page.locator('#selectRecordResolution');
  await expect(resolution).toBeVisible();
  await resolution.selectOption('1080p');

  const advanced = page.locator('#recordAdvancedSettings');
  if (!(await advanced.evaluate((element) => element.open))) {
    await advanced.locator('summary').click();
  }
  await page.locator('#selectRecordMime').selectOption('video/webm;codecs=vp8');
  await page.locator('#inputRecordFps').fill('12');
  await page.locator('#inputRecordBitrate').fill('2');
  await page.locator('#inputRecordSlowdown').fill('1');
  await page.locator('#inputRecordScaleFactor').fill('1');

  const plan = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { captureRatioFor } = await import('/static/js/capture_resolution.mjs');
    app.options.record.mediaRecorder.tailFreezeMs = 250;
    app.options.flash.mode = 'none';
    const rect = app.getMap().getViewport().getBoundingClientRect();
    return captureRatioFor({
      cssWidth: rect.width,
      cssHeight: rect.height,
      devicePixelRatio: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
      resolution: app.options.record.captureResolution,
      multiplier: app.options.record.mediaRecorder.scaleFactor,
    });
  });
  expect(plan.ratio).toBeGreaterThan(1);

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  await expect.poll(latestCompletedMp4, { timeout: 30_000 }).not.toBeNull();

  const videoPath = latestCompletedMp4();
  const expectationPath = path.join(RUNTIME, 'mr-resolution-expectation.json');
  const even = (value) => Math.floor(value / 2) * 2;
  writeFileSync(expectationPath, JSON.stringify({
    width: even(plan.width),
    height: even(plan.height),
    video_codec: 'h264',
    min_size_bytes: 1_000,
  }, null, 2));

  const python = process.env.MYGCFLOW_E2E_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const validation = spawnSync(
    python,
    [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectationPath, '--json'],
    { encoding: 'utf8' },
  );
  expect(validation.status, `${validation.stdout}
${validation.stderr}`).toBe(0);
  const report = JSON.parse(validation.stdout);
  expect(report.success).toBe(true);
  expect(report.height).toBe(even(plan.height));

  // Densité de rendu restaurée après l'enregistrement.
  const restored = await page.evaluate(async () => (await import('/static/js/index.js')).getMap().pixelRatio_);
  expect(restored).toBeLessThan(plan.ratio);

  await testInfo.attach('mediarecorder-hires.mp4', { path: videoPath, contentType: 'video/mp4' });
});

test('la résolution élevée prévient de son coût, selon le mode', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();

  const warning = page.locator('#recordResolutionWarning');
  const resolution = page.locator('#selectRecordResolution');

  // À la taille de la fenêtre, rien à signaler.
  await page.locator('#selectRecordMode').selectOption('mediarecorder');
  await resolution.selectOption('window');
  await expect(warning).toBeHidden();

  // MediaRecorder enregistre en temps réel : saccades possibles.
  await resolution.selectOption('1440p');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('temps réel');
  await expect(warning).toContainText('Rendu image par image');
  // La taille de sortie annoncée est celle que produira la capture.
  const expected = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { captureRatioFor } = await import('/static/js/capture_resolution.mjs');
    const rect = app.getMap().getViewport().getBoundingClientRect();
    const plan = captureRatioFor({
      cssWidth: rect.width,
      cssHeight: rect.height,
      devicePixelRatio: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
      resolution: '1440p',
      multiplier: app.options.record.mediaRecorder.scaleFactor,
    });
    return `${plan.width}×${plan.height}`;
  });
  await expect(warning).toContainText(expected);

  // Mode images : c'est la lenteur de la capture qu'il faut annoncer.
  await page.locator('#selectRecordMode').selectOption('images');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('plus lent');
  await expect(warning).not.toContainText('saccade');

  await resolution.selectOption('window');
  await expect(warning).toBeHidden();
});

test('le débit MediaRecorder suit la résolution, sans jamais redescendre', async ({ page }) => {
    // Un débit de 6 Mbit/s convient en 1080p mais rendrait une image en blocs en
    // 1440p : le détail gagné au rendu serait reperdu à l'encodage.
    await page.locator('a[href="#animation"]').click();
    await page.locator('#recordingConfigTab').click();
    await expect(page.locator('#recordingConfigPane')).toBeVisible();
    await page.locator('#selectRecordMode').selectOption('mediarecorder');

    const advanced = page.locator('#recordAdvancedSettings');
    if (!(await advanced.evaluate((element) => element.open))) {
        await advanced.locator('summary').click();
    }
    const bitrate = page.locator('#inputRecordBitrate');
    const resolution = page.locator('#selectRecordResolution');
    const warning = page.locator('#recordResolutionWarning');

    await resolution.selectOption('window');
    // Le débit conseillé dépend aussi des images par seconde : on fixe les deux
    // plutôt que d'hériter des réglages d'un test précédent.
    await page.locator('#inputRecordFps').fill('30');
    await page.locator('#inputRecordFps').blur();
    // 5 plutôt que 6 : l'en-tête d'application a raccourci la carte, le débit
    // conseillé du plan 1440p retombe pile sur 6 — saisir en dessous garde la
    // marge qui rend l'assertion suivante significative.
    await bitrate.fill('5');
    await bitrate.blur();

    // Le débit conseillé pour la sortie 1440p, calculé comme l'interface le fait.
    const expected = await page.evaluate(async () => {
        const app = await import('/static/js/index.js');
        const { captureRatioFor } = await import('/static/js/capture_resolution.mjs');
        const { recommendedBitrateMbps } = await import('/static/js/recording_settings.mjs');
        const rect = app.getMap().getViewport().getBoundingClientRect();
        const plan = captureRatioFor({
            cssWidth: rect.width,
            cssHeight: rect.height,
            devicePixelRatio: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
            resolution: '1440p',
            multiplier: app.options.record.mediaRecorder.scaleFactor,
        });
        return recommendedBitrateMbps({ width: plan.width, height: plan.height, fps: app.options.record.fps });
    });
    expect(expected).toBeGreaterThan(5);

    await resolution.selectOption('1440p');
    await expect(bitrate).toHaveValue(String(expected));
    await expect(warning).toContainText(`${expected} Mbit/s`);
    const stored = await page.evaluate(async () => {
        const app = await import('/static/js/index.js');
        return app.options.record.mediaRecorder.videoBitsPerSecond;
    });
    expect(stored).toBe(expected * 1_000_000);

    // Retour à la taille de la fenêtre : le débit relevé est conservé.
    await resolution.selectOption('window');
    await expect(bitrate).toHaveValue(String(expected));

    // Un débit déjà généreux n'est pas touché non plus.
    await bitrate.fill('30');
    await bitrate.blur();
    await resolution.selectOption('1440p');
    await expect(bitrate).toHaveValue('30');

    await resolution.selectOption('window');
});

test('le réglage Couleurs choisit le format de pixels du fichier final', async ({ page }, testInfo) => {
  // Le 4:2:0 divise par deux la résolution de couleur : c'est ce qui fait baver
  // les points colorés sur fond sombre. Le 4:4:4 le corrige, au prix de la
  // compatibilité — d'où un réglage, et ce test qui vérifie le fichier produit.
  await selectTraditionalCaches(page);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('images');
  await page.locator('#selectRecordResolution').selectOption('window');

  // Avertissement de compatibilité : seulement quand le 4:4:4 est choisi.
  const warning = page.locator('#recordColorFidelityWarning');
  const fidelity = page.locator('#selectRecordColorFidelity');
  await fidelity.selectOption('compatible');
  await expect(warning).toBeHidden();
  await fidelity.selectOption('fidele');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('pas lu par tous les appareils');

  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.fps = 12;
  });

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  await expect.poll(latestCompletedMp4, { timeout: 30_000 }).not.toBeNull();

  const videoPath = latestCompletedMp4();
  const expectationPath = path.join(RUNTIME, 'color-fidelity-expectation.json');
  writeFileSync(expectationPath, JSON.stringify({
    pix_fmt: 'yuv444p',
    video_codec: 'h264',
    min_size_bytes: 1_000,
  }, null, 2));

  const python = process.env.MYGCFLOW_E2E_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const validation = spawnSync(
    python,
    [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectationPath, '--json'],
    { encoding: 'utf8' },
  );
  expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0);
  const report = JSON.parse(validation.stdout);
  expect(report.success).toBe(true);
  expect(report.pix_fmt).toBe('yuv444p');

  await testInfo.attach('color-fidelity.mp4', { path: videoPath, contentType: 'video/mp4' });

  // Le réglage est global : on le remet par défaut pour les tests suivants.
  await page.locator('#selectRecordColorFidelity').selectOption('compatible');
});

test('le suivi de caméra glisse vers les caches, se stabilise et rend la main', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#switchCameraFollow').check();
  await page.locator('#selectCameraDynamism').selectOption('2');
  // Caches dans le champ : aucun trajet prévu, donc rien à signaler.
  await expect(page.locator('#timingWarnings')).not.toContainText('dates en pause');
  // Caches à New York, vue sur Paris : le trajet est simulé dès que la carte
  // est recadrée, et annoncé dans la durée de la vidéo.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const day of [...app.pointsByDate.keys()]) {
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [-74.006, 40.7128];
    }
    // Mutation en place : invalider les mémoïsations indexées sur la révision.
    app.bumpPointsByDateRevision();
    const view = app.getMap().getView();
    view.setCenter(ol.proj.fromLonLat([2.3522, 48.8566]));
    view.setZoom(6);
  });
  // Mode piste (défaut) : les trajets se jouent pendant l'affichage des dates —
  // les dates ne sont jamais en pause, l'avertissement ne s'affiche plus.
  await expect(page.locator('#timingWarnings')).not.toContainText('dates en pause');
  await expect(page.locator('#timingSummary')).toContainText('trajets de caméra');
  await expect.poll(() => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const layer = app.getMap().getLayers().getArray().find((item) => (
      item.getVisible?.() && typeof item.getPreload === 'function'
    ));
    return layer?.getPreload?.() ?? 0;
  })).toBe(1);

  const suivi = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const view = map.getView();
    // Jours 0-4 dans la zone de confort (Est de la France), dernier jour à
    // New York : le seul trajet est celui du jour 5, joué pendant que les
    // jours précédents s'affichent — c'est ce recouvrement qu'on vérifie.
    // (Avec toutes les caches à New York, le trajet serait celui du jour 0,
    // joué pendant le pré-roll avant toute date : rien à observer.)
    const cible = [-74.006, 40.7128];
    const jours = [...app.pointsByDate.keys()];
    for (const day of jours) {
      const coords = day === jours[jours.length - 1] ? cible : [6.0, 48.0];
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [...coords];
    }
    app.bumpPointsByDateRevision();
    view.setCenter(ol.proj.fromLonLat([2.3522, 48.8566]));
    view.setZoom(6);
    const departX = view.getCenter()[0];
    const zoomInitial = view.getZoom();
    app.options.animation.timePerDay = 400;
    app.startAnimation();

    const positions = [];
    const zooms = [];
    const featureCounts = [];
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 300));
      positions.push(view.getCenter()[0]);
      zooms.push(view.getZoom());
      featureCounts.push(window.vectorSource?.getFeatures().length || 0);
      const proche = Math.abs(view.getCenter()[0] - ol.proj.fromLonLat(cible)[0]) < 10_000;
      if (proche && Math.abs(view.getZoom() - zoomInitial) < 0.02 && i >= 6) break;
    }
    app.stopAnimation();

    // Elle finit son glissement après l'animation, puis s'arrête d'elle-même
    // (zone morte) : sans cela elle se figerait en plein mouvement.
    let stabilise = view.getCenter()[0];
    let figee = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const maintenant = view.getCenter()[0];
      if (maintenant === stabilise) { figee = true; break; }
      stabilise = maintenant;
    }

    // Une interaction rend la main : la vue déplacée ne doit pas revenir.
    view.setCenter(ol.proj.fromLonLat([-4, 47.4]));
    map.dispatchEvent({ type: 'pointerdown' });
    const apresDeplacement = view.getCenter()[0];
    await new Promise((r) => setTimeout(r, 1500));

    return {
      departX,
      cibleX: ol.proj.fromLonLat(cible)[0],
      zoomInitial,
      positions,
      zooms,
      featureCounts,
      stabilise,
      figee,
      resteOuLUtilisateurLAMise: view.getCenter()[0] === apresDeplacement,
    };
  });

  // La distance à la cible diminue sans repartir dans l'autre sens.
  for (let i = 1; i < suivi.positions.length; i++) {
    expect(Math.abs(suivi.positions[i] - suivi.cibleX))
      .toBeLessThanOrEqual(Math.abs(suivi.positions[i - 1] - suivi.cibleX) + 1);
  }
  expect(suivi.positions.at(-1)).toBeLessThan(suivi.departX);
  expect(Math.min(...suivi.zooms)).toBeLessThan(suivi.zoomInitial - 1);
  expect(Math.abs(suivi.zooms.at(-1) - suivi.zoomInitial)).toBeLessThan(0.02);
  const countsWhileMoving = suivi.featureCounts.filter((_, index) => (
    Math.abs(suivi.positions[index] - suivi.cibleX) >= 10_000
  ));
  expect(countsWhileMoving.length).toBeGreaterThan(2);
  const firstDisplayedCount = countsWhileMoving.find((count) => count > 0);
  expect(firstDisplayedCount).toBeGreaterThan(0);
  // Relevé joint au message : sans lui, un échec ne dit pas à quel moment du
  // trajet une date est passée.
  const releve = suivi.positions.map((x, i) => (
    `${Math.round(Math.abs(x - suivi.cibleX) / 1000)}km z${suivi.zooms[i].toFixed(2)} n${suivi.featureCounts[i]}`
  )).join(' | ');
  // Mode piste : les dates ne sont JAMAIS en pause — le nombre de caches
  // affichées continue de croître pendant le déplacement de la caméra.
  expect(new Set(countsWhileMoving).size,
    `les dates continuent de s'afficher pendant le déplacement — ${releve}`).toBeGreaterThan(1);
  expect(suivi.figee, 'la caméra finit par s\'arrêter').toBe(true);
  expect(Math.abs(suivi.stabilise - suivi.cibleX)).toBeLessThan(10_000);
  expect(suivi.resteOuLUtilisateurLAMise).toBe(true);

  await page.locator('#switchCameraFollow').uncheck();
  await expect.poll(() => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const layer = app.getMap().getLayers().getArray().find((item) => (
      item.getVisible?.() && typeof item.getPreload === 'function'
    ));
    return layer?.getPreload?.() ?? 0;
  })).toBe(0);
});


test('la caméra franchit l’antiméridien sans faire le tour du monde', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#switchCameraFollow').check();
  await page.locator('#selectCameraTarget').selectOption('days');
  await page.locator('#selectCameraDynamism').selectOption('4');

  const longitudes = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const days = [...app.pointsByDate.keys()];
    for (const day of days) {
      const lon = day === days[days.length - 1] ? -179 : 179;
      for (const feature of app.pointsByDate.get(day)) {
        feature.geometry.coordinates = [lon, 0];
      }
    }
    app.bumpPointsByDateRevision();
    const view = app.getMap().getView();
    view.setCenter(ol.proj.fromLonLat([179, 0]));
    view.setZoom(6);
    app.options.animation.timePerDay = 400;
    app.startAnimation();

    const samples = [];
    for (let i = 0; i < 24; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      samples.push(ol.proj.toLonLat(view.getCenter())[0]);
    }
    app.stopAnimation();
    return samples;
  });

  // Le changement de signe à la couture est normal. En revanche, passer près
  // de Greenwich révélerait l'ancien trajet long de 358°.
  expect(longitudes.some((lon) => lon < -170), longitudes.join(' → ')).toBe(true);
  expect(longitudes.every((lon) => Math.abs(lon) > 150), longitudes.join(' → ')).toBe(true);

  await page.locator('#switchCameraFollow').uncheck();
});


test('une interaction suspend le suivi par jour jusqu\'au prochain lancement', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#switchCameraFollow').check();
  await page.locator('#selectCameraTarget').selectOption('days');

  const result = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const view = map.getView();
    const days = [...app.pointsByDate.keys()];

    // Pas de pré-roll : les deux premiers jours restent près de la vue de
    // départ. Les jours suivants alternent entre des destinations lointaines :
    // après l'interaction, l'ancien code recréait alors une cible réactive.
    const destinations = [
      [2.35, 48.86], [2.6, 48.8], [-74.006, 40.7128],
      [139.6917, 35.6895], [-122.4194, 37.7749], [151.2093, -33.8688],
    ];
    days.forEach((day, index) => {
      for (const feature of app.pointsByDate.get(day)) {
        feature.geometry.coordinates = [...destinations[index % destinations.length]];
      }
    });
    app.bumpPointsByDateRevision();
    view.setCenter(ol.proj.fromLonLat([2.3522, 48.8566]));
    view.setZoom(6);
    app.options.animation.timePerDay = 400;
    app.startAnimation();

    // Suspendre avant l'affichage des destinations lointaines, puis laisser
    // plusieurs jours s'afficher : ils ne doivent jamais reprendre la caméra.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const manualCenter = ol.proj.fromLonLat([-4, 47.4]);
    map.dispatchEvent({ type: 'pointerdown' });
    view.setCenter(manualCenter);
    const countAtInteraction = window.vectorSource?.getFeatures().length || 0;
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const finalCenter = view.getCenter();
    const finalCount = window.vectorSource?.getFeatures().length || 0;
    app.stopAnimation();

    // Un nouveau lancement lève la suspension : le suivi doit repartir sans
    // obliger l'utilisateur à décocher/recocher son réglage global.
    view.setCenter(manualCenter);
    app.startAnimation();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const restartedCenter = view.getCenter();
    app.stopAnimation();

    return {
      delta: Math.hypot(finalCenter[0] - manualCenter[0], finalCenter[1] - manualCenter[1]),
      restartedDelta: Math.hypot(
        restartedCenter[0] - manualCenter[0],
        restartedCenter[1] - manualCenter[1],
      ),
      countAtInteraction,
      finalCount,
    };
  });

  expect(result.finalCount, 'les jours suivants ont bien continué à s\'afficher')
    .toBeGreaterThan(result.countAtInteraction);
  expect(result.delta, 'la caméra reste au centre choisi par l\'utilisateur').toBeLessThan(1);
  expect(result.restartedDelta, 'un nouveau lancement réactive le suivi').toBeGreaterThan(1);

  await page.locator('#switchCameraFollow').uncheck();
});


test('le jour « grappe + isolée » est cadré sur son étendue, pas son barycentre', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#switchCameraFollow').check();
  await page.locator('#inputDaysPerSecond').fill('2');
  await page.locator('#inputExtraEndTime').fill('0');

  const releve = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const view = app.getMap().getView();
    // Dernier jour : 3 caches groupées à New York + 1 isolée à Saint-Louis.
    // Barycentre ≈ -78°, centre de l'étendue = -82° : fitDay doit viser le
    // second, sinon l'isolée reste hors du cadre calculé pour elle.
    const jours = [...app.pointsByDate.keys()];
    const dernier = app.pointsByDate.get(jours[jours.length - 1]);
    for (const key of jours.slice(0, 3)) {
      for (const f of app.pointsByDate.get(key)) {
        f.geometry.coordinates = [-74.006, 40.7128];
        dernier.push(f);
      }
      app.pointsByDate.delete(key);
    }
    for (const key of jours.slice(3, -1)) {
      for (const f of app.pointsByDate.get(key)) f.geometry.coordinates = [-74.006, 40.7128];
    }
    dernier[0].geometry.coordinates = [-74.006, 40.7128];
    dernier[dernier.length - 1].geometry.coordinates = [-90.2, 38.63];
    app.bumpPointsByDateRevision();
    view.setCenter(ol.proj.fromLonLat([2.3522, 48.8566]));
    view.setZoom(6);

    const centreEtendueX = ol.proj.fromLonLat([-82.103, 39.671])[0];
    const barycentreX = ol.proj.fromLonLat([-78.0545, 40.192])[0];

    app.startAnimation();
    const positions = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      positions.push(view.getCenter()[0]);
      if (positions.length >= 3 && positions.at(-1) === positions.at(-2)
          && positions.at(-2) === positions.at(-3)) break;
    }
    app.stopAnimation();
    return { positions, centreEtendueX, barycentreX };
  });

  // La caméra finit sur le centre de l'étendue du dernier jour, nettement à
  // l'ouest de son barycentre (~445 km d'écart entre les deux).
  const final = releve.positions.at(-1);
  expect(Math.abs(final - releve.centreEtendueX),
    `positions: ${releve.positions.map((x) => Math.round(x / 1000)).join(' | ')}`)
    .toBeLessThan(150_000);
  expect(Math.abs(final - releve.barycentreX)).toBeGreaterThan(250_000);

  await page.locator('#switchCameraFollow').uncheck();
});


test('un enregistrement avec suivi de caméra produit une vidéo et déplace la vue', async ({ page }) => {
  // Le mode images attend le chargement des tuiles à chaque frame : c'est le mode
  // recommandé avec le suivi, et celui qu'on vérifie de bout en bout.
  await selectTraditionalCaches(page);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputDaysPerSecond').fill('12.5');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#switchCameraFollow').check();
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('images');
  await page.locator('#selectRecordResolution').selectOption('window');

  const departX = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const view = map.getView();
    view.setCenter(ol.proj.fromLonLat([-3.5, 47.4]));
    view.setZoom(6);
    // Caches groupées à l'est, HORS de la zone de confort : la caméra ne bouge
    // que si une cache du jour en sort (shouldMoveCamera, camera_follow.mjs),
    // et au dynamisme par défaut cette zone couvre 80 % de la vue. Un décalage
    // fixe en degrés (2° à l'origine) retombait dedans : la vue restait
    // immobile, comme prévu. Il est donc exprimé en largeurs de carte.
    const [width] = map.getSize();
    const [centerX, centerY] = view.getCenter();
    const cible = ol.proj.toLonLat([centerX + width * 0.6 * view.getResolution(), centerY]);
    for (const day of [...app.pointsByDate.keys()]) {
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [...cible];
    }
    app.bumpPointsByDateRevision();
    app.options.record.fps = 12;
    return map.getView().getCenter()[0];
  });

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  await expect.poll(latestCompletedMp4, { timeout: 30_000 }).not.toBeNull();

  const arriveeX = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.getMap().getView().getCenter()[0];
  });
  expect(arriveeX).toBeGreaterThan(departX);

  // Nettoyage sans passer par l'interface : la modale de fin d'enregistrement
  // intercepte encore les clics à cet instant.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.cameraFollow = false;
    const switchCameraFollow = document.getElementById('switchCameraFollow');
    if (switchCameraFollow) switchCameraFollow.checked = false;
  });
});


// Rythme « Par durée » avec suivi de caméra : les caches alternent d'un bord à
// l'autre de la vue, si bien que chaque jour de trouvailles impose un trajet.
// Sans prise en compte de ces trajets, la vidéo durerait ~10 s de plus.
// La base du runtime garde les caches du test précédent : « 6 / 6 » s'affiche
// avant la fin de l'import, dont le rechargement tardif reconstruit l'index des
// jours (cf. travel-trail.spec.mjs). On attend qu'il ne bouge plus.
async function waitForStableTimeline(page) {
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

async function setUpCameraRoundTrips(page, duration) {
  // Les caches sont déplacées plus bas : un rechargement tardif leur rendrait
  // leurs coordonnées d'origine, et les trajets attendus n'auraient pas lieu.
  await waitForStableTimeline(page);
  await selectTraditionalCaches(page);
  await waitForStableTimeline(page);
  expect(await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDate.size)).toBe(3);

  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#rhythmModeDuration').check({ force: true });
  await page.locator('#inputTotalDuration').fill(duration);
  await page.locator('#switchCameraFollow').check();

  return page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const view = map.getView();
    view.setCenter(ol.proj.fromLonLat([-3.5, 47.4]));
    view.setZoom(6);
    const [width] = map.getSize();
    const [centerX, centerY] = view.getCenter();
    const days = [...app.pointsByDate.keys()].sort((a, b) => new Date(a) - new Date(b));
    let side = 1;
    for (const day of days) {
      const cible = ol.proj.toLonLat([centerX + side * width * 0.7 * view.getResolution(), centerY]);
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [...cible];
      side = -side;
    }
    app.bumpPointsByDateRevision();
    app.refreshTimingPlan({ save: false });
    const travel = app.estimateCameraTravel();
    return {
      journeys: travel.journeyCount,
      travelMs: travel.totalMs,
      budgetMs: app.options.animation.cameraTimeBudgetMs,
      summary: document.getElementById('timingSummary').textContent,
      warnings: document.getElementById('timingWarnings').textContent,
    };
  });
}

// Rythme et suivi de caméra sont des préférences globales, enregistrées côté
// serveur : on les remet par défaut pour les tests suivants. Sans passer par
// des clics Playwright — la modale de fin d'export les intercepte encore.
async function restoreAnimationDefaults(page) {
  await page.evaluate(() => {
    document.getElementById('rhythmModeRate')?.click();
    const switchCameraFollow = document.getElementById('switchCameraFollow');
    if (switchCameraFollow?.checked) switchCameraFollow.click();
  });
  await expect.poll(async () => {
    const { animation } = await (await page.request.get('/api/settings')).json();
    return `${animation?.rhythm_mode}/${animation?.camera_follow}`;
  }).toBe('rate/false');
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('« Par durée »')) await restoreAnimationDefaults(page);
});


test('avec le suivi de caméra, un export « Par durée » garde la durée demandée', async ({ page }, testInfo) => {
  const prevu = await setUpCameraRoundTrips(page, '0:24');
  // Trois jours de trouvailles, trois trajets : ils sont annoncés et comptés
  // dans les 24 s, au lieu de s'y ajouter.
  expect(prevu.journeys).toBe(3);
  expect(prevu.travelMs).toBeGreaterThan(5_000);
  expect(prevu.budgetMs).toBe(21_000);
  expect(prevu.summary).toContain('vidéo 0:24');
  expect(prevu.summary).toContain('trajets de caméra');
  expect(prevu.warnings).not.toContain('minimums');

  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();
  await page.locator('#selectRecordMode').selectOption('images');
  await page.locator('#selectRecordResolution').selectOption('window');

  await page.locator('#btnQuickExport').click({ force: true });
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 180_000 });
  await expect.poll(latestCompletedMp4, { timeout: 30_000 }).not.toBeNull();
  const videoPath = latestCompletedMp4();

  const expectationPath = path.join(RUNTIME, 'camera-duration-expectation.json');
  writeFileSync(expectationPath, JSON.stringify({
    duration_seconds: 24,
    duration_tolerance_seconds: 0.75,
    min_size_bytes: 1_000,
  }, null, 2));
  const python = process.env.MYGCFLOW_E2E_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const validation = spawnSync(
    python,
    [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectationPath, '--json'],
    { encoding: 'utf8' },
  );
  expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0);
  await testInfo.attach('camera-duration.mp4', { path: videoPath, contentType: 'video/mp4' });
});


test('avec le suivi de caméra, la lecture « Par durée » finit à l\'heure', async ({ page }) => {
  const prevu = await setUpCameraRoundTrips(page, '0:15');
  expect(prevu.journeys).toBe(3);
  // 15 s demandées dont 3 s de pause finale (propre à l'export) : la lecture
  // déroule dates et trajets en 12 s.
  expect(prevu.budgetMs).toBe(12_000);

  const lecture = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const view = app.getMap().getView();
    const departX = view.getCenter()[0];
    let ecartMax = 0;
    const debut = performance.now();
    app.startAnimation();
    while (app.isAnimationInProgress() && performance.now() - debut < 40_000) {
      await new Promise((r) => setTimeout(r, 50));
      ecartMax = Math.max(ecartMax, Math.abs(view.getCenter()[0] - departX));
    }
    return {
      dureeMs: performance.now() - debut,
      terminee: !app.isAnimationInProgress(),
      ecartMax,
      caches: window.vectorSource?.getFeatures().length || 0,
    };
  });
  await page.evaluate(async () => (await import('/static/js/index.js')).stopAnimation());

  expect(lecture.terminee).toBe(true);
  expect(lecture.ecartMax, 'la caméra s\'est bien déplacée').toBeGreaterThan(1_000);
  expect(lecture.caches).toBe(3);
  // Mode piste (défaut) : les trajets (~10 s) sont joués pendant l'affichage
  // des jours précédents — les 12 s sont entièrement dévolues aux dates.
  expect(Math.abs(lecture.dureeMs - 12_000)).toBeLessThan(1_500);
});


test('le plan signale les trajets en retard quand le rythme est trop rapide', async ({ page }) => {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#switchCameraFollow').check();
  // Caches alternant New York / Paris chaque jour : chaque jour impose un
  // trajet transatlantique (~4 s) qui ne peut pas tenir dans 50 ms/jour —
  // chaque trajet arrivera en retard sur son jour, et le plan doit le dire.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const jours = [...app.pointsByDate.keys()];
    jours.forEach((day, index) => {
      const coords = index % 2 === 0 ? [-74.006, 40.7128] : [2.3522, 48.8566];
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [...coords];
    });
    // Mutation en place : invalider les mémoïsations indexées sur la révision.
    app.bumpPointsByDateRevision();
    const view = app.getMap().getView();
    view.setCenter(ol.proj.fromLonLat([2.3522, 48.8566]));
    view.setZoom(6);
  });
  await page.locator('#inputDaysPerSecond').fill('20');
  await expect(page.locator('#timingWarnings')).toContainText('en retard');

  // Réglages caméra globaux et persistés : on les rend comme les autres tests.
  await page.locator('#switchCameraFollow').uncheck();
});
