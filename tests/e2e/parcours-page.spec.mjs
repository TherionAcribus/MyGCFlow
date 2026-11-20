// Page Parcours (/parcours, MyGCFlow_Plan_Parcours.md) : parcours enregistrés,
// étapes dans l'ordre et aux heures reconstruits (lot 1), lecture et vidéo
// (lot 2). Fixture et règles de nettoyage : parcours-helpers.mjs.
import { expect, test } from '@playwright/test';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cleanUp,
  clearLogs,
  collectErrors,
  deleteAllParcours,
  importFixture,
  openParcoursPage,
  snapshot,
} from './parcours-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RUNTIME = process.env.MYGCFLOW_E2E_RUNTIME;

function mp4Names() {
  try {
    return readdirSync(path.join(RUNTIME, 'video')).filter((name) => name.endsWith('.mp4'));
  } catch (_) {
    return [];
  }
}

test.beforeEach(async ({ request }) => {
  await deleteAllParcours(request);
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await cleanUp(request);
});

test('page sans parcours : mode actif, état vide, aucune erreur', async ({ page }) => {
  const errors = collectErrors(page);
  // La page ne doit réécrire ni le rythme ni le dernier thème de la page
  // principale (`animation`, `last_profile_uid`) : le repli de perPage le
  // faisait — suivi de caméra remis à false au chargement.
  const settingsWrites = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith('/api/settings')) settingsWrites.push(req.postDataJSON());
  });
  await openParcoursPage(page);
  await expect(page.locator('#linkParcoursMode')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  await expect(page.locator('#parcoursSummary')).toContainText('Ouvrez ou créez un parcours');
  await expect(page.locator('#mainTabs a[href="#animation"]')).toBeVisible();
  await expect(page.locator('#mainTabs a[href="#stats"]')).toHaveCount(0);
  // Rien à jouer : lecture désactivée, état vide propre à la page.
  await expect(page.locator('#btnQuickPreview')).toBeDisabled();
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#emptyState')).toContainText('Créez un parcours');
  expect((await snapshot(page)).status).toBe('idle');
  // Au-delà du délai d'écriture différée (500 ms) des réglages d'animation.
  await page.waitForTimeout(1200);
  expect(settingsWrites.filter((patch) => 'animation' in patch || 'last_profile_uid' in patch)).toEqual([]);
  expect(errors).toEqual([]);
});

test('lecture : étapes qui apparaissent, géocacheur, heure et distance, puis repos', async ({ page, request }) => {
  await importFixture(page, request);
  expect((await request.put('/api/settings', { data: { parcours_animation: { rhythm_mode: 'rate', days_per_second: 20 } } })).ok())
    .toBeTruthy();
  expect((await request.post('/api/parcours',
    { data: { name: 'Week-end', date_start: '2025-07-12', date_end: '2025-07-13' } })).status()).toBe(201);
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const before = await snapshot(page);
  expect(before.timeline.stopQ).toHaveLength(5);
  expect(before.timeline.nightLegs).toBe(1);
  expect(before.layer.visible).toBe(true);
  // Rythme de la page lu dans sa propre clé : 20 quanta par seconde.
  await expect(page.locator('#btnQuickPreview')).toBeEnabled();

  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await snapshot(page)).running).toBe(true);
  // En cours : plan masqué, tête et trait dessinés, ligne d'infos du parcours.
  await expect.poll(async () => (await snapshot(page)).currentQ, { timeout: 10_000 })
    .toBeGreaterThan(before.timeline.stopQ[1]);
  const during = await snapshot(page);
  expect(during.layer.visible).toBe(false);
  expect(during.playLayers).toBe(true);
  expect(during.head).not.toBeNull();
  expect(during.infos.date).toMatch(/2025/);
  expect(during.infos.heure).toMatch(/^≈ \d\d:\d\d$/);
  await expect(page.locator('#spanInfosTemplate')).toContainText('/ 5');
  await expect(page.locator('#spanInfosTemplate')).toContainText('km');

  // Fin : repos, plan revenu, compteurs au total.
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 30_000 }).toBe(false);
  const after = await snapshot(page);
  expect(after.layer.visible).toBe(true);
  expect(after.playLayers).toBe(false);
  expect(after.infos.date).toMatch(/13/);
  await expect(page.locator('#spanInfosTemplate')).toContainText('5 / 5');
  expect(errors).toEqual([]);
});

for (const mode of ['images', 'mediarecorder']) test(`export vidéo (${mode}) : la durée suit la chronologie du parcours`, async ({ page, request }) => {
  test.setTimeout(180_000);
  await importFixture(page, request);
  expect((await request.put('/api/settings', { data: { parcours_animation: { rhythm_mode: 'rate', days_per_second: 20, extra_end_seconds: 0 } } })).ok())
    .toBeTruthy();
  expect((await request.post('/api/parcours',
    { data: { name: 'Week-end', date_start: '2025-07-12', date_end: '2025-07-13' } })).status()).toBe(201);
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const { quanta } = (await snapshot(page)).timeline;

  await page.locator('a[href="#animation"]').click();
  await page.locator('#recordingConfigTab').click();
  await page.locator('#selectRecordMode').selectOption(mode);
  await page.locator('#selectRecordResolution').selectOption('window');
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.fps = 12;
    // Mêmes réglages que prepareSlowRecording (video-export.spec.mjs).
    app.options.record.mediaRecorder.tailFreezeMs = 250;
    app.options.record.mediaRecorder.slowdownFactor = 1;
    app.options.record.mediaRecorder.mimeType = 'video/webm;codecs=vp8';
  });
  const existing = new Set(mp4Names());
  await page.locator('#btnQuickExport').click({ force: true });
  // Pendant la capture : le géocacheur et le trait sont dessinés.
  await expect.poll(async () => (await snapshot(page)).playLayers, { timeout: 30_000 }).toBe(true);
  await expect(page.locator('#modal_video_ready')).toBeVisible({ timeout: 120_000 });
  let created = [];
  await expect.poll(() => (created = mp4Names().filter((name) => !existing.has(name))).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const videoPath = path.join(RUNTIME, 'video', created[0]);
  try {
    const python = process.env.MYGCFLOW_E2E_PYTHON || process.env.PYTHON
      || (process.platform === 'win32' ? 'python' : 'python3');
    const expectation = path.join(RUNTIME, 'parcours-video-expectation.json');
    writeFileSync(expectation, JSON.stringify({ video_codec: 'h264', min_size_bytes: 1_000 }));
    const probe = spawnSync(python, [path.join(ROOT, 'video_validator.py'), videoPath, '--expect', expectation, '--json'],
      { encoding: 'utf8' });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
    const { duration_seconds: duration } = JSON.parse(probe.stdout);
    // Un quantum par 1/20 s, plus la pause automatique de fin (flash).
    expect(duration).toBeGreaterThan(quanta / 20 - 0.5);
    expect(duration).toBeLessThan(quanta / 20 + 4);
  } finally {
    rmSync(videoPath, { force: true });
  }
  expect((await snapshot(page)).running).toBe(false);
  expect(errors).toEqual([]);
});

test('créer un parcours : étapes reconstruites par jour, heures, sur la carte', async ({ page, request }) => {
  await importFixture(page, request);
  const errors = collectErrors(page);
  await openParcoursPage(page);

  // Dates proposées : le dernier jour de trouvailles.
  await expect(page.locator('#parcoursStart')).toHaveValue('2025-07-13');
  await page.locator('#parcoursName').fill('Week-end à Annecy');
  await page.locator('#parcoursStart').fill('2025-07-12');
  await page.locator('#parcoursStart').dispatchEvent('change');
  await page.locator('#parcoursEnd').fill('2025-07-13');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('2 jours');
  await page.locator('#btnParcoursCreate').click();

  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const state = await snapshot(page);
  expect(state.logsAvailable).toBe(true);
  expect(state.days.map((d) => [d.date, d.keys, d.reasons, d.logOrder])).toEqual([
    ['2025-07-12', ['GCPAR03', 'GCPAR01', 'GCPAR02'], ['log-order', 'log-order', 'log-order'], 'trusted'],
    ['2025-07-13', ['GCPAR04', 'GCPAR05'], ['late-type', 'geo'], 'none'],
  ]);
  // Sans ancre, la journée commence à 9 h ; heures croissantes.
  expect(state.days[0].times[0]).toBe('09:00');
  expect(state.days[0].times).toEqual([...state.days[0].times].sort());
  expect(state.layer).toEqual({ stops: 5, lines: 2, draft: 0, onMap: true, visible: true });
  await expect(page.locator('.parcours-list-item.active')).toContainText('Week-end à Annecy');
  await expect(page.locator('#parcoursSummary')).toContainText('5 étapes');
  await expect(page.locator('.parcours-stop').first()).toContainText('Départ du sentier');
  await expect(page.locator('.parcours-stop-time').first()).toHaveText('≈ 09:00');
  await expect(page.locator('.parcours-day-diagnostic').first()).toContainText('ordre de saisie des logs retenu');
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR04"]')).toContainText('souvent loguée après coup');
  await expect(page.locator('.parcours-stop-index').last()).toHaveText('5');

  // Rechargement : le dernier parcours ouvert revient.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  expect((await snapshot(page)).days[1].keys).toEqual(['GCPAR04', 'GCPAR05']);
  expect(errors).toEqual([]);
});

test('modifier un parcours : nom et dates, sans perdre les ajustements', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Week-end', date_start: '2025-07-12', date_end: '2025-07-13' } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()).parcours;
  // Un ajustement à préserver : heure épinglée.
  await request.patch(`/api/parcours/${id}/overrides`, { data: { overrides: [{ key: 'GCPAR01', pinnedTime: '14:05' }] } });
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  expect((await snapshot(page)).days).toHaveLength(2);

  // Le crayon remplit le formulaire ; son envoi devient un enregistrement.
  await page.locator(`.parcours-list-item[data-parcours-id="${id}"] .parcours-edit`).click();
  await expect(page.locator('#parcoursFormTitle')).toHaveText('Modifier le parcours');
  await expect(page.locator('#parcoursName')).toHaveValue('Week-end');
  await expect(page.locator('#btnParcoursEditCancel')).toBeVisible();
  await page.locator('#parcoursName').fill('Ascension');
  await page.locator('#parcoursEnd').fill('2025-07-12');
  await page.locator('#parcoursIncludeDnf').uncheck();
  await page.locator('#btnParcoursCreate').click();

  await expect(page.locator(`.parcours-list-item[data-parcours-id="${id}"]`)).toContainText('Ascension');
  await expect(page.locator('#parcoursFormTitle')).toHaveText('Nouveau parcours');
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const state = await snapshot(page);
  expect(state.days).toHaveLength(1);
  // L'ajustement a survécu à la modification.
  expect(state.overrides.map((o) => o.key)).toContain('GCPAR01');
  const item = (await (await request.get(`/api/parcours/${id}`)).json()).parcours;
  expect(item.name).toBe('Ascension');
  expect(item.date_end).toBe('2025-07-12');
  expect(item.include_dnf).toBe(false);
  expect(errors).toEqual([]);
});

test('lien liste ↔ carte : halo au survol, bulle puis panneau au clic sur la carte', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).layer?.stops).toBe(3);

  // Survol d'une ligne : le point du plan s'entoure d'un halo.
  await page.locator('.parcours-stop[data-stop-key="GCPAR02"]').hover();
  expect((await snapshot(page)).hovered).toBe('GCPAR02');

  // Survol du point sur la carte : la ligne se surligne à son tour.
  const pixel = (await snapshot(page)).stopPixels.GCPAR02;
  const box = await page.locator('.ol-viewport').boundingBox();
  await page.mouse.move(box.x + pixel[0], box.y + pixel[1]);
  await expect.poll(async () => (await snapshot(page)).mapHover).toContain('GCPAR02');

  // Clic sur le point : sa bulle (parcours-map-actions.spec.mjs), dont
  // « Détails » ouvre le panneau d'ajustement de l'étape.
  await page.mouse.click(box.x + pixel[0], box.y + pixel[1]);
  await page.locator('#gcPopup.is-visible .parcours-bubble[data-stop-key="GCPAR02"] .parcours-bubble-details').click();
  await expect(page.locator('.parcours-stop-edit[data-edit-key="GCPAR02"]')).toBeVisible();
  await expect(page.locator('.parcours-edit-locate')).toBeVisible();
  expect(errors).toEqual([]);
});

test('une saisie invalide est refusée avec un message', async ({ page, request }) => {
  await importFixture(page, request);
  await openParcoursPage(page);
  await page.locator('#parcoursName').fill('Trop long');
  await page.locator('#parcoursStart').fill('2025-01-01');
  await page.locator('#parcoursEnd').fill('2025-07-13');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('Un parcours couvre 92 jours au plus');
  await page.locator('#btnParcoursCreate').click();
  await expect(page.locator('.gcm-toast.show')).toContainText('92 jours au plus');
  expect((await snapshot(page)).ids).toEqual([]);
});

test('suggestions : six visibles, « et N autres » déplie le reste', async ({ page }) => {
  const errors = collectErrors(page);
  const trips = Array.from({ length: 8 }, (_, i) => ({
    kind: 'trip', start: `2025-0${i + 1}-10`, end: `2025-0${i + 1}-14`,
    days: 5, findDays: 4, finds: 20, place: `Lieu ${i + 1}`,
  }));
  // La réponse plafonnée à 6, puis entière sur limit=0.
  await page.route('**/api/parcours/suggestions**', (route) => {
    const all = route.request().url().includes('limit=0');
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ suggestions: all ? trips : trips.slice(0, 6), total: 8 }),
    });
  });
  await openParcoursPage(page);
  const chips = page.locator('.parcours-suggestion');
  await expect(chips).toHaveCount(6);
  const more = page.locator('#btnParcoursSuggestionsMore');
  await expect(more).toContainText('et 2 autres');
  await more.click();
  await expect(chips).toHaveCount(8);
  await expect(more).toBeHidden();
  expect(errors).toEqual([]);
});

test('supprimer un parcours après confirmation', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).layer?.stops).toBe(3);

  await page.locator('.parcours-delete').click();
  await page.locator('.gcm-confirm-modal.show [data-gcm-role="confirm"]').click();
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  const state = await snapshot(page);
  expect(state.ids).toEqual([]);
  expect(state.layer.stops).toBe(0);
});

test('dupliquer, exporter et importer un parcours', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Week-end', date_start: '2025-07-12', date_end: '2025-07-13' } });
  const pid = (await created.json()).parcours.id;
  // Un ajustement à faire suivre dans la copie et l'export.
  await request.patch(`/api/parcours/${pid}/overrides`,
    { data: { overrides: [{ key: 'GCPAR01', rank: 1 }] } });
  const errors = collectErrors(page);
  await openParcoursPage(page);
  const items = page.locator('.parcours-list-item');
  await expect(items).toHaveCount(1);

  // Dupliquer : la copie apparaît et garde les ajustements.
  await items.first().locator('.parcours-duplicate').click();
  await expect(items).toHaveCount(2);
  const copy = items.filter({ hasText: '(copie)' });
  await expect(copy).toHaveCount(1);
  await copy.locator('.parcours-open').click();
  await expect.poll(async () => (await snapshot(page)).overrides?.length).toBe(1);

  // Exporter : un fichier JSON téléchargé.
  const download = page.waitForEvent('download');
  await copy.locator('.parcours-export').click();
  expect((await download).suggestedFilename()).toMatch(/^parcours-.*\.json$/);

  // Importer : le document recrée un parcours complet.
  const exported = await (await request.get(`/api/parcours/${pid}/export`)).json();
  exported.parcours.name = 'Réimporté';
  await page.setInputFiles('#parcoursImportInput', {
    name: 'parcours-week-end.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'Réimporté' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
