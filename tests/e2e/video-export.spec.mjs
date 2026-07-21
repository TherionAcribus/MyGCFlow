import { expect, test } from '@playwright/test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const RUNTIME = process.env.GCMAP_E2E_RUNTIME;


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    try {
      const app = await import('/static/js/index.js');
      const scaleInput = document.querySelector('#inputRecordScaleFactor');
      return Boolean(
        window.gcmapReady === true
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
    return {
      selectedCaches: app.metadata.numberOfCaches,
      timelineDays: app.pointsByDate.size,
      timelineCaches: [...app.pointsByDate.values()].reduce((total, points) => total + points.length, 0),
      startDate: app.metadata.startDate.toISOString().slice(0, 10),
      endDate: app.metadata.endDate.toISOString().slice(0, 10),
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
  await page.evaluate(() => {
    document.querySelector('#selectRecordMode').tomselect.setValue('mediarecorder');
  });

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

  const bounded = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return {
      fps: app.options.record.fps,
      bitrate: app.options.record.mediaRecorder.videoBitsPerSecond,
    };
  });
  expect(bounded).toEqual({ fps: 60, bitrate: 30_000_000 });

  await page.locator('#selectRecordQualityProfile').selectOption('standard');
  await expect(fps).toHaveValue('30');
  await expect(bitrate).toHaveValue('6');
  await expect(advanced).not.toHaveAttribute('open', '');
  await expect(page.locator('#recordEstimatedSize')).not.toHaveText('—');
});


test('les options MediaRecorder de l\'interface produisent un MP4 validé par ffprobe', async ({ page }, testInfo) => {
  await selectTraditionalCaches(page);

  // Piloter les contrôles visibles comme un utilisateur. Les deux selects sont
  // gérés par Tom Select, les autres champs par Playwright directement.
  await page.locator('a[href="#animation"]').click();
  await page.locator('#inputTimePerDay').fill('80');
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('#recordingConfigTab').click();
  await expect(page.locator('#recordingConfigPane')).toBeVisible();

  await page.evaluate(() => {
    document.querySelector('#selectRecordMode').tomselect.setValue('mediarecorder');
    document.querySelector('#selectRecordMime').tomselect.setValue('video/webm;codecs=vp8');
  });
  const advanced = page.locator('#recordAdvancedSettings');
  if (!(await advanced.evaluate((element) => element.open))) {
    await advanced.locator('summary').click();
  }
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

  const python = process.env.GCMAP_E2E_PYTHON
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

  await testInfo.attach('gcmap-browser-export.mp4', { path: videoPath, contentType: 'video/mp4' });
  await testInfo.attach('ffprobe-report.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });
});
