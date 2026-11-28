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
  createWeekend,
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
  // Outils des étapes (annuler, poser un lieu, exporter…) : rien sur quoi agir.
  await expect(page.locator('#parcoursStopsTools')).toBeHidden();
  // Aucun parcours : formulaire de création ouvert d'office, sans « Fermer »
  // ni « Nouveau parcours » ; pas de section d'enrichissement.
  await expect(page.locator('#parcoursFormSection')).toBeVisible();
  await expect(page.locator('#btnParcoursNew')).toBeHidden();
  await expect(page.locator('#btnParcoursEditCancel')).toBeHidden();
  await expect(page.locator('.parcours-area-enrich')).toBeHidden();
  // Date manquante (base sans trouvailles : rien de proposé ; ou saisie en
  // cours) : pas d'erreur de plage annoncée. La base du run peut garder les
  // trouvailles d'un spec précédent : la date est vidée ici.
  await page.locator('#parcoursEnd').fill('');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('');
  await expect(page.locator('#mainTabs a[href="#animation"]')).toBeVisible();
  await expect(page.locator('#mainTabs a[href="#stats"]')).toHaveCount(0);
  // Rien à jouer : lecture désactivée, état vide propre à la page.
  await expect(page.locator('#btnQuickPreview')).toBeDisabled();
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#emptyState')).toContainText('Créez un parcours');
  // Son bouton mène au formulaire, curseur dans le nom, même depuis un autre
  // onglet.
  await page.locator('#mainTabs a[href="#style"]').click();
  await page.locator('#btnParcoursEmptyCreate').click();
  await expect(page.locator('#parcoursName')).toBeFocused();
  await expect(page.locator('#mainTabs a[href="#data"]')).toHaveClass(/active/);
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
  // Liste des étapes : une étape atteinte est marquée « en cours ».
  expect(during.listPlaying).toMatch(/^GCPAR0\d$/);
  await expect(page.locator('#spanInfosTemplate')).toContainText('/ 5');
  await expect(page.locator('#spanInfosTemplate')).toContainText('km');

  // Fin : repos, plan revenu, compteurs au total.
  await expect.poll(async () => (await snapshot(page)).running, { timeout: 30_000 }).toBe(false);
  const after = await snapshot(page);
  expect(after.layer.visible).toBe(true);
  expect(after.playLayers).toBe(false);
  expect(after.listPlaying).toBeNull();
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
  // Chapitres attendus : la 2e journée commence avec sa nuit.
  const day2Q = (await snapshot(page)).timeline.dayStartQ[1];

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
  // Deux journées : chapitres intégrés, mais trop peu pour YouTube (3 au moins).
  await expect(page.locator('#videoReadyChapters')).toBeVisible();
  await expect(page.locator('#videoReadyChaptersTitle')).toHaveText('2 chapitres intégrés à la vidéo');
  await expect(page.locator('#videoReadyChaptersText')).toBeHidden();
  await expect(page.locator('#btnVideoReadyCopyChapters')).toBeHidden();
  await expect(page.locator('#videoReadyChaptersHint')).toContainText('trop courtes');
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
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
    const { duration_seconds: duration, chapters } = JSON.parse(probe.stdout);
    // Un quantum par 1/20 s, plus la pause automatique de fin (flash).
    expect(duration).toBeGreaterThan(quanta / 20 - 0.5);
    expect(duration).toBeLessThan(quanta / 20 + 4);
    // Une journée par chapitre, relevée pendant la capture.
    expect(chapters.map((c) => c.title)).toEqual(['Jour 1 — 12/07/2025', 'Jour 2 — 13/07/2025']);
    expect(chapters[0].start).toBe(0);
    expect(chapters[1].start).toBeGreaterThan(day2Q / 20 - 0.5);
    expect(chapters[1].start).toBeLessThan(day2Q / 20 + 0.5);
    expect(chapters[1].end).toBeCloseTo(duration, 0);
  } finally {
    rmSync(videoPath, { force: true });
  }
  expect((await snapshot(page)).running).toBe(false);
  expect(errors).toEqual([]);
});

test('écran de fin : la liste des chapitres YouTube se copie', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openParcoursPage(page);
  // Résultat d'export simulé (capture.py, _write_youtube_chapters) : trois
  // journées assez longues pour YouTube.
  const youtube = '0:00 Jour 1 — 12/07/2025\n0:12 Jour 3 — 14/07/2025\n0:30 Jour 4 — 15/07/2025\n';
  await page.evaluate(async (text) => {
    const app = await import('/static/js/index.js');
    app.showVideoReady({ file: 'vacances.mp4', chapters: { count: 3, youtube: text, file: 'vacances.youtube.txt' } });
  }, youtube);
  await expect(page.locator('#videoReadyChaptersTitle')).toHaveText('3 chapitres intégrés à la vidéo');
  await expect(page.locator('#videoReadyChaptersText')).toHaveValue(youtube);
  await expect(page.locator('#videoReadyChaptersHint')).toContainText('vacances.youtube.txt');
  await page.locator('#btnVideoReadyCopyChapters').click();
  // Le presse-papiers de Windows rend des fins de ligne CRLF.
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')))
    .toBe(youtube);

  // Vidéo sans chapitres (page principale, journée unique) : bloc masqué.
  await page.locator('#modal_video_ready .btn-close').click();
  await expect(page.locator('#modal_video_ready')).toBeHidden();
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.showVideoReady({ file: 'carte.mp4', chapters: { count: 0, youtube: null, file: null } });
  });
  await expect(page.locator('#modal_video_ready')).toBeVisible();
  await expect(page.locator('#videoReadyChapters')).toBeHidden();
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
  const hintColor = () => page.locator('#parcoursRangeHint').evaluate((node) => getComputedStyle(node).color);
  const normalColor = await hintColor();
  // Fin avant le début : message d'erreur, dans une autre couleur que l'aide.
  await page.locator('#parcoursEnd').fill('2025-07-11');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('La date de fin précède la date de début');
  expect(await hintColor()).not.toBe(normalColor);
  await page.locator('#parcoursEnd').fill('2025-07-13');
  await page.locator('#parcoursEnd').dispatchEvent('change');
  await expect(page.locator('#parcoursRangeHint')).toHaveText('2 jours');
  expect(await hintColor()).toBe(normalColor);
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
  // La provenance de l'heure n'est plus dans le détail de la ligne : elle
  // s'explique dans le panneau d'ajustement, ligne « Heure ».
  await expect(page.locator('.parcours-stop[data-stop-key="GCPAR04"]')).not.toContainText('souvent loguée après coup');
  await page.locator('.parcours-stop[data-stop-key="GCPAR04"] .parcours-stop-text').click();
  await expect(page.locator('.parcours-stop-edit[data-edit-key="GCPAR04"]')).toContainText('souvent loguée après coup');
  await page.locator('.parcours-stop[data-stop-key="GCPAR04"] .parcours-stop-text').click();
  await expect(page.locator('.parcours-stop-edit')).toHaveCount(0);
  await expect(page.locator('.parcours-stop-index').last()).toHaveText('5');

  // Un parcours existe : le formulaire se replie derrière « Nouveau
  // parcours », qui le rouvre ; « Fermer » le replie.
  await expect(page.locator('#parcoursFormSection')).toBeHidden();
  await page.locator('#btnParcoursNew').click();
  await expect(page.locator('#parcoursFormSection')).toBeVisible();
  await expect(page.locator('#parcoursName')).toBeFocused();
  await expect(page.locator('#btnParcoursNew')).toBeHidden();
  await page.locator('#btnParcoursEditCancel').click();
  await expect(page.locator('#parcoursFormSection')).toBeHidden();
  await expect(page.locator('#btnParcoursNew')).toBeVisible();

  // Disposition. Panneau latéral (défaut à 1280 px) : une colonne, enrichir
  // juste sous la liste (sections repliées compactes, toujours visibles),
  // étapes en dernier, bornées en hauteur avec défilement interne. Grands
  // réglages (panneau sous la carte, large) : étapes à droite de la liste.
  // Disposition retenue par le localStorage du test.
  const box = (selector) => page.locator(selector).evaluate((node) => {
    const { top, left } = node.getBoundingClientRect();
    return { top, left };
  });
  await expect(page.locator('#mapTabsContainer')).toHaveClass(/layout-sidebar/);
  const [list, stops, enrich] = await Promise.all(
    ['.parcours-area-list', '.parcours-area-stops', '.parcours-area-enrich'].map(box));
  expect(stops.left).toBe(list.left);
  expect(stops.top).toBeGreaterThan(list.top);
  expect(stops.top).toBeGreaterThan(enrich.top);
  await page.locator('#layoutPresets [data-layout="tabs"]').click();
  await page.evaluate(() => document.activeElement.blur());
  await expect.poll(async () => (await box('.parcours-area-stops')).left - (await box('.parcours-area-list')).left)
    .toBeGreaterThan(100);
  // Carte plus basse : le cadrage automatique (vue non touchée) est refait,
  // aucune étape ne reste coupée au bord.
  await expect.poll(async () => {
    const { stopPixels } = await snapshot(page);
    const [width, height] = await page.evaluate(async () => (await import('/static/js/index.js')).getMap().getSize());
    return Object.values(stopPixels).every(([x, y]) => x > 0 && y > 0 && x < width && y < height);
  }).toBe(true);
  await page.locator('#layoutPresets [data-layout="sidebar"]').click();
  await page.evaluate(() => document.activeElement.blur());

  // Liste des étapes bornée en hauteur, barre d'outils stable : « Enrichir »
  // garde sa place quelle que soit la longueur du parcours, et le titre comme
  // la barre d'outils restent visibles au-dessus de la liste qui défile.
  const stopsMetrics = await page.locator('#parcoursStops').evaluate((el) => {
    const style = getComputedStyle(el);
    return { overflowY: style.overflowY, maxHeight: style.maxHeight, clientHeight: el.clientHeight };
  });
  expect(stopsMetrics.overflowY).toBe('auto');
  expect(stopsMetrics.maxHeight).not.toBe('none');
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(stopsMetrics.clientHeight).toBeLessThanOrEqual(Math.ceil(innerHeight * 0.42) + 40);

  // Défilée tout en bas, la liste laisse la barre d'outils en place. Avec la
  // fixture, le contenu déborde réellement.
  const overflow = await page.locator('#parcoursStops').evaluate((el) => {
    const metrics = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    el.scrollTop = el.scrollHeight;
    return metrics;
  });
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  await expect(page.locator('#parcoursStopsTools')).toBeVisible();
  await page.locator('#parcoursStops').evaluate((el) => { el.scrollTop = 0; });

  // Synthèse du minutage : étapes et journées, pas les quanta du moteur
  // (« 178 jours · 10 jours/s » pour un week-end).
  await page.locator('#mainTabs a[href="#animation"]').click();
  await expect(page.locator('#timingSummary')).toContainText(/^5 étapes · 2 jours · animation \d+:\d\d/);
  await expect(page.locator('#timingSummary')).not.toContainText('jours/s');
  await page.locator('#mainTabs a[href="#data"]').click();

  // Rechargement : le dernier parcours ouvert revient.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  expect((await snapshot(page)).days[1].keys).toEqual(['GCPAR04', 'GCPAR05']);
  expect(errors).toEqual([]);
});

test('titre affiché : le nom du parcours, ou le titre du thème laissé intact', async ({ page, request }) => {
  await importFixture(page, request);
  expect((await request.post('/api/parcours',
    { data: { name: 'Week-end à Annecy', date_start: '2025-07-12', date_end: '2025-07-13' } })).status()).toBe(201);
  const errors = collectErrors(page);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const themeTitle = () => page.evaluate(async () => (await import('/static/js/index.js')).options.infos.title.text);
  const before = await themeTitle();
  expect(before).not.toBe('Week-end à Annecy');

  // Par défaut : le nom du parcours, sur la carte (et donc dans la vidéo,
  // qui peint #titleFrame) ; le titre du thème, partagé, est grisé.
  await expect(page.locator('#titleFrame')).toHaveText('Week-end à Annecy');
  await page.locator('#mainTabs a[href="#style"]').click();
  await page.locator('#style .nav-link[href="#tabTitles"]').click();
  await expect(page.locator('#parcoursTitleSource')).toHaveValue('name');
  await expect(page.locator('#inputTitle')).toBeDisabled();

  // Titre du thème : affiché tel quel, jamais réécrit ; gardé par le parcours.
  await page.locator('#parcoursTitleSource').selectOption('theme');
  await expect(page.locator('#titleFrame')).toHaveText(before);
  await expect(page.locator('#inputTitle')).toBeEnabled();
  expect(await themeTitle()).toBe(before);
  await expect.poll(async () => (await (await request.get('/api/parcours')).json()).parcours[0].playback.title)
    .toBe('theme');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowParcoursLoaded === true, null, { timeout: 30_000 });
  await expect(page.locator('#titleFrame')).toHaveText(before);
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
  // Les suggestions arrivent avec la liste : injection plafonnée à 6 dans
  // GET /api/parcours ; « et N autres » redemande tout (limit=0).
  await page.route('**/api/parcours', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    body.suggestions = trips.slice(0, 6);
    body.suggestionsTotal = 8;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/parcours/suggestions**', (route) => {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ suggestions: trips, total: 8 }),
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
  const pid = (await created.json()).parcours.id;
  // Un ajustement : la confirmation l'annonce dans ce qui part avec le
  // parcours.
  await request.patch(`/api/parcours/${pid}/overrides`,
    { data: { overrides: [{ key: 'GCPAR01', rank: 1 }] } });
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).layer?.stops).toBe(3);

  // Suppression pendant la modification : le formulaire repasse en création.
  await page.locator('.parcours-edit').click();
  await expect(page.locator('#parcoursFormTitle')).toHaveText('Modifier le parcours');
  await page.locator('.parcours-menu').click();
  await page.locator('.parcours-delete').click();
  const modal = page.locator('.gcm-confirm-modal.show');
  await expect(modal).toContainText('1 ajustements');
  await expect(modal).toContainText('trouvailles ne sont pas touchées');
  await modal.locator('[data-gcm-role="confirm"]').click();
  await expect(page.locator('#parcoursListEmpty')).toBeVisible();
  await expect(page.locator('#parcoursFormTitle')).toHaveText('Nouveau parcours');
  await expect(page.locator('#btnParcoursEditCancel')).toBeHidden();
  const state = await snapshot(page);
  expect(state.ids).toEqual([]);
  expect(state.layer.stops).toBe(0);
});

test('liste : jours, étapes et compteurs sur la ligne', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Week-end', date_start: '2025-07-12', date_end: '2025-07-13' } });
  const pid = (await created.json()).parcours.id;
  await request.patch(`/api/parcours/${pid}/overrides`,
    { data: { overrides: [{ key: 'GCPAR01', rank: 1 }] } });
  expect((await request.post(`/api/parcours/${pid}/places`,
    { data: { kind: 'place', name: 'Mont', lat: 45.9, lon: 6.1, date: '2025-07-12' } })).status())
    .toBe(201);
  await openParcoursPage(page);

  const item = page.locator('.parcours-list-item');
  await expect(item).toContainText('2 jours');
  // Libellés en clair et accordés (l'icône et un nombre seul se lisaient
  // mal, et « 1 ajustements » était attendu ici).
  await expect(item.locator('.parcours-count-stops')).toHaveText('5 étapes');
  await expect(item.locator('.parcours-count-overrides')).toHaveText('1 ajustement');
  await expect(item.locator('.parcours-count-places')).toHaveText('1 lieu ou base');
  // Comptes nuls masqués.
  await expect(item.locator('.parcours-count-photos')).toHaveCount(0);
  await expect(item.locator('.parcours-count-tracks')).toHaveCount(0);
});

test('recherche dans les étapes : nom, code GC, aucun résultat', async ({ page, request }) => {
  const errors = collectErrors(page);
  await importFixture(page, request);
  await createWeekend(request);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const stops = page.locator('.parcours-stop');
  await expect(stops).toHaveCount(5);
  const search = page.locator('#parcoursStopsSearch');

  // Casse et accents ignorés : « belvedere » trouve « Belvédère » ; la
  // journée sans résultat disparaît, celle du résultat est dépliée.
  await search.fill('belvedere');
  await expect(stops).toHaveCount(1);
  await expect(stops.first()).toContainText('Belvédère');
  await expect(page.locator('.parcours-day')).toHaveCount(1);
  await expect(page.locator('#parcoursSummary')).toContainText('1 étapes sur 5');
  // Liste tronquée : poignées de glisser-déposer et repli masqués.
  await expect(page.locator('.parcours-stop-grip')).toHaveCount(0);
  await expect(page.locator('.parcours-day-toggle')).toBeHidden();

  // Recherche par code GC (casse ignorée).
  await search.fill('gcpar04');
  await expect(stops).toHaveCount(1);
  await expect(stops.first()).toContainText('GCPAR04');

  // Aucun résultat : message dédié.
  await search.fill('zzz');
  await expect(stops).toHaveCount(0);
  await expect(page.locator('#parcoursStops')).toContainText('Aucune étape ne correspond');

  // Champ vidé : la liste complète revient.
  await search.fill('');
  await expect(stops).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('filtre « à vérifier » : étapes à heure déduite de la géographie', async ({ page, request }) => {
  const errors = collectErrors(page);
  await importFixture(page, request);
  await createWeekend(request);
  await openParcoursPage(page);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const stops = page.locator('.parcours-stop');
  await expect(stops).toHaveCount(5);
  const review = page.locator('#parcoursStopsReview');

  // Journée 1 : ordre des logs retenu (confiance « logged ») ; journée 2 :
  // une seule cache à log et une earthcache loguée après coup — heures
  // déduites de la géographie seule (confiance « geo »).
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await expect(stops).toHaveCount(2);
  for (const stop of await stops.all()) {
    await expect(stop).toHaveAttribute('data-confidence', 'geo');
  }
  // La journée sans étape à vérifier disparaît, le résumé compte le filtre.
  await expect(page.locator('.parcours-day')).toHaveCount(1);
  await expect(page.locator('#parcoursSummary')).toContainText('2 étapes sur 5');
  // Vue filtrée : poignées et repli masqués, comme pour la recherche.
  await expect(page.locator('.parcours-stop-grip')).toHaveCount(0);
  await expect(page.locator('.parcours-day-toggle')).toBeHidden();

  // Combiné avec la recherche : « gcpar04 » dans les étapes à vérifier.
  await page.locator('#parcoursStopsSearch').fill('gcpar04');
  await expect(stops).toHaveCount(1);
  await expect(stops.first()).toContainText('GCPAR04');
  await page.locator('#parcoursStopsSearch').fill('');

  // Re-clic : la liste complète revient.
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'false');
  await expect(stops).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('liste indisponible : « Réessayer » recharge la liste', async ({ page, request }) => {
  await importFixture(page, request);
  const created = await request.post('/api/parcours',
    { data: { name: 'Journée', date_start: '2025-07-12', date_end: '2025-07-12' } });
  expect(created.status()).toBe(201);
  let failList = true;
  await page.route('**/api/parcours', (route) => {
    if (failList) return route.abort();
    return route.continue();
  });
  await openParcoursPage(page);
  await expect(page.locator('#parcoursList')).toContainText('Impossible de charger les parcours');
  await expect(page.locator('.parcours-retry')).toBeVisible();

  // Serveur de nouveau joignable : la liste se remplit sans rechargement.
  failList = false;
  await page.locator('.parcours-retry').click();
  await expect(page.locator('.parcours-list-item')).toHaveCount(1);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
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
  await items.first().locator('.parcours-menu').click();
  await items.first().locator('.parcours-duplicate').click();
  await expect(items).toHaveCount(2);
  const copy = items.filter({ hasText: '(copie)' });
  await expect(copy).toHaveCount(1);
  await copy.locator('.parcours-open').click();
  await expect.poll(async () => (await snapshot(page)).overrides?.length).toBe(1);

  // Exporter : un fichier JSON téléchargé.
  const download = page.waitForEvent('download');
  await copy.locator('.parcours-menu').click();
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
