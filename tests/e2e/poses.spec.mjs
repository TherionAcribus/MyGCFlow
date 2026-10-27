// Page « Mes poses » (/poses, docs/mode-poses.md) : vie des caches posées,
// tirée des logs importés.
//
// Fixture fictive tests/fixtures/gc_logs/logs-poses.json (compte 1234567) :
// 8 caches posées, dont une sans position (7 placées) ; GCP0004 désactivée du
// 01/09/2019 au 10/09/2019 ; GCP0005 archivée le 01/10/2019, désarchivée le
// 20/10/2019, archivée le 01/03/2020 ; GCP0006 archivée d'après son statut à
// l'export (31/12/2020) ; 12 trouvailles reçues, 3 favoris.
//
// Les logs vivent hors de /clear_database : chaque test les vide en entrée et
// en sortie (AGENTS.md), et remet les préférences poses_* qu'il touche.
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

async function importPoses(request) {
  const preview = await request.post('/api/logs/import/preview', {
    multipart: {
      file: { name: 'logs-poses.json', mimeType: 'application/json', buffer: fs.readFileSync(FIXTURE) },
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

async function putSettings(request, patch) {
  const response = await request.put('/api/settings', { data: patch });
  expect(response.ok()).toBeTruthy();
}

async function openPoses(page) {
  await page.goto('/poses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.waitForFunction(() => window.mygcflowPosesLoaded === true, null, { timeout: 30_000 });
}

function debugState(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getPosesDebugState());
}

const NEVER = 1e6;

test.beforeEach(async ({ request }) => {
  await clearLogs(request);
});

test.afterEach(async ({ request }) => {
  await clearLogs(request);
  await putSettings(request, {
    poses_archived_display: 'grey',
    poses_infos_template: '{date} · {actives} · {trouvailles}',
    poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 60 },
  });
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).poses_archived_display)
    .toBe('grey');
});

test('sans logs : état vide et lien vers « Mes logs »', async ({ page }) => {
  await openPoses(page);
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#posesEmptyLogsLink')).toHaveAttribute('href', '/#data');
  await expect(page.locator('#posesStatus')).toContainText('Aucun log importé');
  await expect(page.locator('#linkPosesMode')).toHaveAttribute('aria-current', 'page');
  expect((await debugState(page)).selected).toBe(0);
});

test('caches posées : compteurs, états au repos et date de fin', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importPoses(request);
  await openPoses(page);

  await expect(page.locator('#emptyState')).toBeHidden();
  await expect(page.locator('#filtersCounter')).toContainText('7 / 7');
  await expect(page.locator('#posesStatus')).toContainText('7 caches posées');
  await expect(page.locator('#posesStatus')).toContainText('12 trouvailles');

  // Au repos (31/12/2020, export) : GCP0005 archivée par le relecteur,
  // GCP0006 archivée d'après le statut ; aucune désactivée.
  const state = await debugState(page);
  expect(state.selected).toBe(7);
  expect(state.states).toEqual({ active: 5, disabled: 0, archived: 2 });
  expect(state.counters).toMatchObject({ posees: 7, actives: 5, archivees: 2, trouvailles: 12, favoris: 3 });
  // Grisées par défaut : présentes jusqu'à la fin.
  expect(state.features.every((f) => f.archivedDay === NEVER)).toBe(true);
  await expect(page.locator('#spanInfosTemplate')).toContainText('· 5 · 12');

  // Date de fin au 05/09/2019 : GCP0004 désactivée, GCP0005 pas encore
  // archivée (le relevé compte aussi GCP0008, pas encore apparue).
  const early = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateEnd = new Date(2019, 8, 5);
    app.showLifecycleRestState();
    return app.getPosesDebugState();
  });
  expect(early.states).toEqual({ active: 6, disabled: 1, archived: 0 });
  expect(early.features.find((f) => f.code === 'GCP0004').pstate).toBe(1);
  expect(errors).toEqual([]);
});

test('popup : libellé d\'apparition et comptes au jour affiché', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  const popupText = (code) => page.evaluate(async (gc) => {
    const app = await import('/static/js/index.js');
    const div = document.createElement('div');
    const feature = app.posesStatsIndex().features.find((f) => f.get('gc_code') === gc);
    app.renderPosesPopup(feature, div);
    return div.textContent;
  }, code);

  // GCP0001 (publication le 05/03/2018) : au repos, les comptes valent les
  // totaux de la cache — 2 trouvailles, 1 favori, 1 DNF, Alice première.
  const atRest = await popupText('GCP0001');
  expect(atRest).toContain('Publiée le');
  expect(atRest).toContain('Traditional Cache, Micro, 1.5/2');
  expect(atRest).toContain('2 trouvailles · 1 favoris · 1 DNF');
  expect(atRest).toContain('Premier trouveur : Alice');

  // Autres sources d'apparition : date de pose (GCP0002), bêta-trouvaille
  // (GCP0003, testée le 10/01/2019, publiée le 20/01/2019).
  expect(await popupText('GCP0002')).toContain('Posée le');
  expect(await popupText('GCP0003')).toContain('Trouvée avant sa publication le');

  // Date de fin avant la première trouvaille de GCP0001 : 0 trouvaille et
  // pas de ligne « Premier trouveur ».
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateEnd = new Date(2018, 2, 1);
    app.showLifecycleRestState();
  });
  const early = await popupText('GCP0001');
  expect(early).toContain('0 trouvailles · 0 favoris · 0 DNF');
  expect(early).not.toContain('Premier trouveur');

  // dateEnd vit en mémoire : remise sur la fin des données.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateEnd = null;
    app.showLifecycleRestState();
  });
});

test('archivées masquées : segment de présence et réglage persisté', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  await page.locator('#selectPosesArchivedDisplay').selectOption('hide');
  await expect.poll(async () => (await debugState(page)).archivedDisplay).toBe('hide');
  const state = await debugState(page);
  const byCode = Object.fromEntries(state.features.map((f) => [f.code, f]));
  expect(byCode.GCP0005.archivedDay).toBeLessThan(NEVER);
  expect(byCode.GCP0006.archivedDay).toBeLessThan(NEVER);
  expect(byCode.GCP0001.archivedDay).toBe(NEVER);
  // GCP0005 a été désarchivée : au repos, son segment est le dernier.
  expect(byCode.GCP0005.placedDay).toBeGreaterThan(0);
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).poses_archived_display)
    .toBe('hide');
});

test('filtres « État actuel » et « Trouvailles reçues »', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  await expect(page.locator('#filtersCounter')).toContainText('7 / 7');

  // Les selects passent par Tom Select : la sélection se change sur le select
  // natif, puis un 'change' déclenche le cycle de filtrage (debounce 200 ms).
  const selectOptions = (id, wanted) => page.evaluate(([selectId, values]) => {
    const select = document.getElementById(selectId);
    for (const option of select.options) {
      if (option.value) option.selected = values.includes(option.value);
    }
    select.dispatchEvent(new Event('change'));
  }, [id, wanted]);
  const selectedCodes = async () => (await debugState(page)).features.map((f) => f.code);

  // État actuel : seules GCP0005 et GCP0006 sont archivées à l'export.
  await selectOptions('selectPosesStatus', ['1']);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 7');
  expect((await debugState(page)).selected).toBe(2);
  expect((await selectedCodes()).sort()).toEqual(['GCP0005', 'GCP0006']);

  // Trouvailles reçues : seule GCP0004 n'a jamais été trouvée.
  await selectOptions('selectPosesStatus', ['0', '3', '1']);
  await selectOptions('selectPosesFinds', ['never']);
  await expect(page.locator('#filtersCounter')).toContainText('1 / 7');
  expect(await selectedCodes()).toEqual(['GCP0004']);
  await selectOptions('selectPosesFinds', ['found']);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 7');

  // « Aucun » sur l'état : sélection vide, plus aucune feature, l'avertissement
  // « aucun résultat » prend le relais de la suggestion « prochaine étape ».
  await page.evaluate(() => document.getElementById('btnNonePosesStatus').click());
  await expect(page.locator('#filtersCounter')).toContainText('0 / 7');
  const empty = await debugState(page);
  expect(empty.selected).toBe(0);
  expect(empty.features).toEqual([]);
  await expect(page.locator('#dataNoResults')).toBeVisible();
  await expect(page.locator('#dataNextStep')).toBeHidden();

  // « Réinitialiser tous les filtres » ramène les sept caches.
  await page.locator('#btnResetAllFilters').click();
  await expect(page.locator('#filtersCounter')).toContainText('7 / 7');
  expect((await debugState(page)).selected).toBe(7);
  await expect(page.locator('#dataNoResults')).toBeHidden();
  await expect(page.locator('#dataNextStep')).toBeVisible();
});

test('barre de chronologie : repères FTF par cache, aucun palier rond', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  await page.locator('#btnTimelineBar').click();
  await expect(page.locator('#timelineBar')).toBeVisible();

  const snap = await page.evaluate(async () => (await import('/static/js/index.js')).getTimelineBarSnapshot());
  // Jours de l'axe en heure locale (minuit local), comme le modèle de la barre.
  const dayOf = (m) => {
    const d = new Date(snap.axisStart.getTime() + m.offset * 86_400_000);
    const p2 = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  // Une FTF par cache trouvée de la sélection : GCP0004 jamais trouvée (et
  // GCP0007 sans position n'apparaît pas) → six repères, aux dates des
  // premières trouvailles reçues.
  const ftf = snap.marks.filter((m) => m.kind === 'ftf').map((m) => [dayOf(m), m.label]);
  expect(ftf).toEqual([
    ['2018-03-05', 'Première trouvaille : GCP0001'],
    ['2018-06-15', 'Première trouvaille : GCP0002'],
    ['2019-01-10', 'Première trouvaille : GCP0003'],
    ['2019-02-02', 'Première trouvaille : GCP0005'],
    ['2019-04-20', 'Première trouvaille : GCP0006'],
    ['2020-02-11', 'Première trouvaille : GCP0008'],
  ]);
  // 4 trouvailles au plus par cache dans la fixture (< 10) : aucun palier.
  expect(snap.marks.filter((m) => m.kind === 'cacheRound')).toEqual([]);
});

test('le moteur joue un flash par cache, agrandi les jours chargés', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  const { log, logNoFtf, days } = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { lifecycleEngine } = await import('/static/js/lifecycle_engine.mjs');
    const start = new Date(2018, 2, 1);
    const end = new Date(2020, 11, 31);
    const run = () => {
      const engine = lifecycleEngine();
      app.clearPosesFlashLog();
      engine.begin(start, end, performance.now(), {});
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        engine.step([new Date(d)], performance.now());
      }
      engine.end();
      return app.getPosesDebugState().flashLog;
    };
    const log = run();
    // Deuxième passage avec le flash « ftf » coupé (« Pas de flash », en
    // mémoire seulement) : le type mappé du log concourt à sa place.
    app.options.flash.events.ftf.mode = 'none';
    const logNoFtf = run();
    app.showLifecycleRestState();
    const dayOf = app.posesStatsIndex().dayOf;
    return {
      log,
      logNoFtf,
      days: {
        gcp0001: dayOf(new Date(2018, 2, 5)),
        gcp0002: dayOf(new Date(2018, 5, 15)),
        gcp0003: dayOf(new Date(2019, 0, 10)),
        gcp0005: dayOf(new Date(2019, 1, 2)),
        gcp0006: dayOf(new Date(2019, 3, 20)),
        gcp0008: dayOf(new Date(2020, 1, 11)),
      },
    };
  });
  const kinds = new Set(log.map((f) => f.kind));
  // (La seule maintenance tombe le jour d'une réactivation, qui l'emporte ;
  // « favorite » n'apparaît pas : tous les favoris de la fixture arrivent sur
  // une première trouvaille — « ftf », plus prioritaire — ou un jour de
  // publication.)
  for (const kind of ['publish', 'disable', 'enable', 'archive', 'find', 'alert', 'dnf', 'ftf']) {
    expect(kinds, kind).toContain(kind);
  }
  expect(kinds).not.toContain('favorite');
  // « Première trouvaille » : le jour du premier find reçu de chaque cache,
  // sauf quand la cache apparaît ce jour-là — la publication l'emporte alors
  // (GCP0001 trouvée le 05/03/2018, jour de sa publication ; GCP0003 le
  // 10/01/2019, jour de son apparition par bêta-trouvaille).
  for (const code of ['GCP0002', 'GCP0005', 'GCP0006', 'GCP0008']) {
    const ftf = log.filter((f) => f.code === code && f.kind === 'ftf');
    expect(ftf.length, code).toBe(1);
    expect(ftf[0].day, code).toBe(days[code.toLowerCase()]);
  }
  expect(log.some((f) => f.code === 'GCP0001' && f.kind === 'ftf')).toBe(false);
  expect(log.some((f) => f.code === 'GCP0003' && f.kind === 'ftf')).toBe(false);
  expect(log.some((f) => f.code === 'GCP0001' && f.kind === 'publish' && f.day === days.gcp0001)).toBe(true);
  // Flash « ftf » coupé : plus aucun, et le favori du premier find de GCP0006
  // (20/04/2019) reprend la main.
  expect(logNoFtf.some((f) => f.kind === 'ftf')).toBe(false);
  expect(logNoFtf.some((f) => f.code === 'GCP0006' && f.kind === 'favorite' && f.day === days.gcp0006)).toBe(true);
  // Publication de GCP0003 le 20/01/2019 avec trois trouvailles (dont un
  // favori) : un seul flash, la publication, agrandi.
  const published = log.filter((f) => f.code === 'GCP0003' && f.kind === 'publish');
  expect(published.some((f) => f.count === 4 && f.scale > 1)).toBe(true);
  // Notes (« aucun » par défaut) : jamais de flash propre.
  expect(kinds).not.toContain('note');
  // GCP0004, 10/09/2019 : maintenance + réactivation → la réactivation gagne.
  expect(log.some((f) => f.code === 'GCP0004' && f.kind === 'enable' && f.count === 2)).toBe(true);
});

test('un aperçu complet se joue sans erreur', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importPoses(request);
  await putSettings(request, { poses_animation: { rhythm_mode: 'duration', total_duration_seconds: 3 } });
  await openPoses(page);
  await page.evaluate(async () => (await import('/static/js/index.js')).clearPosesFlashLog());
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 30_000 }).toBe('playing');
  await expect.poll(async () => page.evaluate(async () =>
    (await import('/static/js/index.js')).previewPlaybackState()), { timeout: 60_000 }).toBe('idle');
  const state = await debugState(page);
  expect(state.flashLog.length).toBeGreaterThan(0);
  expect(state.states).toEqual({ active: 5, disabled: 0, archived: 2 });
  expect(errors).toEqual([]);
});

test('les flashs par événement se règlent dans le thème', async ({ page, request }) => {
  await importPoses(request);
  await openPoses(page);
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  const rows = page.locator('#flashEvents [data-event-flash-kind]');
  await expect(rows).toHaveCount(13);
  const ftf = page.locator('#flashEvents [data-event-flash-kind="ftf"]');
  await expect(ftf.locator('[data-event-flash-field="mode"]')).toHaveValue('fireworks');
  const favorite = page.locator('#flashEvents [data-event-flash-kind="favorite"]');
  await expect(favorite.locator('[data-event-flash-field="mode"]')).toHaveValue('star');
  if (process.env.VISUAL_OUT) await page.locator('#flashEvents').screenshot({ path: `${process.env.VISUAL_OUT}/flash-events.png` });
  // « Pas de flash » : les réglages propres se masquent, le type ne concourt plus.
  await favorite.locator('[data-event-flash-field="mode"]').selectOption('none');
  await expect(favorite.locator('.event-flash-own')).toBeHidden();
  const kinds = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const { lifecycleEngine } = await import('/static/js/lifecycle_engine.mjs');
    const engine = lifecycleEngine();
    app.clearPosesFlashLog();
    engine.begin(new Date(2018, 2, 1), new Date(2020, 11, 31), performance.now(), {});
    for (let d = new Date(2018, 2, 1); d <= new Date(2020, 11, 31); d.setDate(d.getDate() + 1)) {
      engine.step([new Date(d)], performance.now());
    }
    engine.end();
    app.showLifecycleRestState();
    return [...new Set(app.getPosesDebugState().flashLog.map((f) => f.kind))];
  });
  expect(kinds).not.toContain('favorite');
  expect(kinds).toContain('find');
});
