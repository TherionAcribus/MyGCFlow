import { expect, test } from '@playwright/test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


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
  await page.locator('#cbRecordUpload').uncheck();
  await page.locator('#cbRecordDownload').uncheck();
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
      uploadToServer: app.options.record.mediaRecorder.uploadToServer,
      downloadLocal: app.options.record.mediaRecorder.downloadLocal,
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
    uploadToServer: false,
    downloadLocal: false,
    normalize: false,
    timePerDay: 80,
    extraEndSeconds: 0,
  });

  await page.locator('#btnRecordAnimation').click({ force: true });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 75_000 });
  await expect.poll(latestCompletedMp4, { timeout: 15_000 }).not.toBeNull();

  const videoPath = latestCompletedMp4();
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

  await page.locator('#btnRecordAnimation').click({ force: true });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 120_000 });
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
  await page.locator('#cbRecordUpload').uncheck();
  await page.locator('#cbRecordDownload').uncheck();

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

  await page.locator('#btnRecordAnimation').click({ force: true });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 120_000 });
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
  await expect(warning).toContainText('Images + ffmpeg');
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
    await bitrate.fill('6');
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
    expect(expected).toBeGreaterThan(6);

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

  await page.locator('#btnRecordAnimation').click({ force: true });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 120_000 });
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

  const suivi = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const map = app.getMap();
    const view = map.getView();
    // Toutes les caches au même endroit, à l'est : la cible est sans ambiguïté.
    const cible = [-1.5, 47.4];
    for (const day of [...app.pointsByDate.keys()]) {
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [...cible];
    }
    view.setCenter(ol.proj.fromLonLat([-2.5, 47.4]));
    view.setZoom(6);
    const departX = view.getCenter()[0];
    app.options.animation.timePerDay = 400;
    app.startAnimation();

    const positions = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      positions.push(view.getCenter()[0]);
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
      positions,
      stabilise,
      figee,
      resteOuLUtilisateurLAMise: view.getCenter()[0] === apresDeplacement,
    };
  });

  // La caméra avance vers la cible, sans reculer ni la dépasser.
  for (let i = 1; i < suivi.positions.length; i++) {
    expect(suivi.positions[i]).toBeGreaterThanOrEqual(suivi.positions[i - 1] - 1);
    expect(suivi.positions[i]).toBeLessThanOrEqual(suivi.cibleX + 1);
  }
  expect(suivi.positions.at(-1)).toBeGreaterThan(suivi.departX);
  expect(suivi.figee, 'la caméra finit par s\'arrêter').toBe(true);
  expect(Math.abs(suivi.stabilise - suivi.cibleX)).toBeLessThan(10_000);
  expect(suivi.resteOuLUtilisateurLAMise).toBe(true);

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
    // Caches groupées à l'est, vue placée à l'ouest : la caméra a de quoi bouger.
    for (const day of [...app.pointsByDate.keys()]) {
      for (const feature of app.pointsByDate.get(day)) feature.geometry.coordinates = [-1.5, 47.4];
    }
    map.getView().setCenter(ol.proj.fromLonLat([-3.5, 47.4]));
    map.getView().setZoom(6);
    app.options.record.fps = 12;
    return map.getView().getCenter()[0];
  });

  await page.locator('#btnRecordAnimation').click({ force: true });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Vidéo prête' }).last()).toBeVisible({ timeout: 120_000 });
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

