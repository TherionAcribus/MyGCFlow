// Points DNF sur la carte (docs/logs-geocaching.md, lot C) : masqués par
// défaut, affichés à la demande, jamais comptés comme des trouvailles,
// apparus au premier échec puis remplacés par la trouvaille, et intégrés au
// trait de déplacement sauf choix contraire.
//
// Fixtures fictives : le My Finds (2 trouvailles : GC2PR3N le 08/01/2012,
// GC345J4 le 22/04/2012) porte un DNF sur GC2PR3N le 20/08/2011 ; le fichier
// de logs ajoute un DNF jamais résolu sur GC9ZZZZ (02/05/2021), placé par sa
// fiche.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'gc_logs');
const MY_FINDS = path.join(FIXTURES, 'my-finds-logs.gpx');
const CONTRACT = path.join(FIXTURES, 'logs-contract-valid.json');
// GC9ZZZZ avec DEUX DNF (02/05 et 15/08/2021), jamais résolu.
const REPEAT = path.join(FIXTURES, 'logs-dnf-repeat.json');
// GC8DAYX : DNF puis trouvaille le même jour (10/09/2021).
const SAMEDAY = path.join(FIXTURES, 'logs-dnf-same-day.json');
// GC9MARK : deux DNF DANS la fenêtre des trouvailles (10/02 et 15/03/2012) —
// l'axe de la chronologie ne couvre que l'étendue des trouvailles + marge.
const AXIS = path.join(FIXTURES, 'logs-dnf-axis.json');


async function openWithData(page, logsFile = CONTRACT) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(MY_FINDS);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2', { timeout: 30_000 });
  // Les filtres se réappliquent encore un peu après l'import, chacun par un
  // addVector() : attendre que l'index des jours ne bouge plus.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);

  await page.locator('#gc-logs-file-input').setInputFiles(logsFile);
  await expect(page.locator('#gcLogsPreviewModal')).toBeVisible({ timeout: 20_000 });
  await page.locator('#gcLogsPreviewConfirmBtn').click();
  await expect(page.locator('#gcLogsStatus')).toContainText('logs enregistrés', { timeout: 30_000 });
}


// Codes GC des points DNF présents sur la carte (leur couche, sous celle des
// trouvailles), et des trouvailles.
function mapCodes(page, kind) {
  return page.evaluate((wanted) => {
    const source = wanted === 'dnf' ? window.dnfVectorSource : window.vectorSource;
    return (source?.getFeatures() || []).map(f => f.get('gc_code')).sort();
  }, kind);
}


async function showDnf(page) {
  await page.locator('#checkDnfDisplay').check();
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC9ZZZZ']);
}


async function enableTrail(page) {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTrail"]').click();
  await expect(page.locator('#selectTrailRouting')).toBeEnabled();
  await page.locator('#switchTrail').check();
  await page.locator('a[href="#data"]').click();
}


async function trailStops(page) {
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2011, 7, 1);
  });
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await page.evaluate(async () =>
    (await import('/static/js/index.js')).getTravelTrailDebugState())).stops).toBeGreaterThan(0);
  const { stops } = await page.evaluate(async () =>
    (await import('/static/js/index.js')).getTravelTrailDebugState());
  await page.locator('#btnQuickStop').click();
  await expect(page.locator('#btnQuickPreview')).toBeVisible();
  return stops;
}


// dnf_display et dnf_in_trail sont des préférences globales, et les logs
// vivent dans la base partagée du runtime : tout remettre en sortant.
test.afterEach(async ({ request }) => {
  await request.put('/api/settings', {
    data: { dnf_display: false, dnf_in_trail: true, dnf_same_day_display: false },
  }).catch(() => {});
  await request.post('/api/logs/clear').catch(() => {});
  await request.post('/clear_database').catch(() => {});
});


test('masqués par défaut, affichés à la demande sans compter comme des trouvailles', async ({ page, request }) => {
  await openWithData(page);
  await expect(page.locator('#checkDnfDisplay')).not.toBeChecked();
  await expect(page.locator('#checkDnfInTrail')).toBeDisabled();
  // La case grisée explique pourquoi (bulle sur le label — celle d'un input
  // disabled n'apparaît pas partout).
  await expect(page.locator('label[for="checkDnfInTrail"]'))
    .toHaveAttribute('title', 'Actif quand les DNF sont affichés');
  expect(await mapCodes(page, 'dnf')).toEqual([]);

  // Carte au repos : GC2PR3N, trouvée dans la période, a laissé place à sa
  // trouvaille ; seul le DNF jamais résolu reste.
  await showDnf(page);
  await expect(page.locator('#filtersCounter')).toContainText('2 / 2');
  expect(await mapCodes(page, 'find')).toEqual(['GC2PR3N', 'GC345J4']);
  await expect(page.locator('#dnfDisplayHint')).toContainText('2 DNF dans la sélection');
  await expect(page.locator('#checkDnfInTrail')).toBeEnabled();
  await expect(page.locator('label[for="checkDnfInTrail"]')).not.toHaveAttribute('title', /.+/);
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).dnf_display).toBe(true);

  await page.locator('#checkDnfDisplay').uncheck();
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual([]);
  expect(await mapCodes(page, 'find')).toEqual(['GC2PR3N', 'GC345J4']);
});


test('dans le temps, un DNF apparaît au premier échec puis laisse place à la trouvaille', async ({ page }) => {
  await openWithData(page);
  await showDnf(page);
  const paused = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(2011, 7, 1);
    return app.startPausedPreview();
  });
  expect(paused).toBe(true);

  const seek = (y, m, d) => page.evaluate(async ([yy, mm, dd]) =>
    (await import('/static/js/index.js')).seekAnimationToDate(new Date(yy, mm, dd)), [y, m, d]);

  expect(await seek(2011, 7, 19)).toBe(true);       // veille du DNF
  expect(await mapCodes(page, 'dnf')).toEqual([]);
  await seek(2011, 8, 1);                           // après le DNF, avant la trouvaille
  expect(await mapCodes(page, 'dnf')).toEqual(['GC2PR3N']);
  expect(await mapCodes(page, 'find')).toEqual([]);
  await seek(2012, 1, 1);                           // trouvée le 08/01/2012
  expect(await mapCodes(page, 'dnf')).toEqual([]);
  expect(await mapCodes(page, 'find')).toEqual(['GC2PR3N']);
  await seek(2011, 8, 1);                           // retour en arrière
  expect(await mapCodes(page, 'dnf')).toEqual(['GC2PR3N']);
});


async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
  await page.locator('a[href="#data"]').click();
}


// Formes des flashs joués par des DNF pendant une lecture (par défaut depuis
// le 01/08/2011 : le DNF de GC2PR3N tombe le 20/08/2011). `expected` est le
// nombre de flashs à attendre avant d'arrêter la lecture.
async function dnfFlashesDuringPreview(page, { dateStart = '2011-08-01', dateEnd = null, expected = 1 } = {}) {
  const before = (await page.evaluate(async () =>
    (await import('/static/js/index.js')).getDnfDebugState())).flashes.length;
  await page.evaluate(async ([start, end]) => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(`${start}T00:00:00`);
    app.options.animation.dateEnd = end ? new Date(`${end}T00:00:00`) : null;
  }, [dateStart, dateEnd]);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => (await page.evaluate(async () =>
    (await import('/static/js/index.js')).getDnfDebugState())).flashes.length,
  { timeout: 20_000 }).toBeGreaterThanOrEqual(before + expected);
  await page.locator('#btnQuickStop').click();
  await expect(page.locator('#btnQuickPreview')).toBeVisible();
  return (await page.evaluate(async () =>
    (await import('/static/js/index.js')).getDnfDebugState())).flashes.slice(before);
}


test('un DNF qui apparaît joue le flash des trouvailles, ou son flash propre', async ({ page }) => {
  await openWithData(page);
  await showDnf(page);
  await setRhythm(page, 20);
  await page.evaluate(async () => { (await import('/static/js/index.js')).options.flash.mode = 'circle'; });

  // Thème par défaut : « Comme les trouvailles », réglages propres masqués.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  await expect(page.locator('#selectDnfFlashMode')).toHaveValue('same');
  await expect(page.locator('#dnfFlashOwnFields')).toBeHidden();
  await page.locator('a[href="#data"]').click();
  expect(await dnfFlashesDuringPreview(page)).toEqual(['circle']);

  // Flash propre : ses réglages apparaissent, et c'est lui qui joue.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  await page.evaluate(() => {
    const select = document.getElementById('selectDnfFlashMode');
    select.value = 'star';
    select.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#dnfFlashOwnFields')).toBeVisible();
  await page.locator('a[href="#data"]').click();
  expect(await dnfFlashesDuringPreview(page)).toEqual(['star']);
});


// Deux DNF sur GC9ZZZZ (logs-dnf-repeat.json) : la seconde tentative doit
// rejouer le flash sur le point déjà affiché, pas seulement avancer le trait.
test('un DNF répété rejoue le flash sur une cache déjà affichée', async ({ page }) => {
  await openWithData(page, REPEAT);
  await showDnf(page);
  await setRhythm(page, 60);
  await page.evaluate(async () => { (await import('/static/js/index.js')).options.flash.mode = 'circle'; });
  // Fenêtre 2021 : apparition le 02/05, seconde tentative le 15/08.
  expect(await dnfFlashesDuringPreview(page, { dateStart: '2021-04-01', dateEnd: '2021-12-31', expected: 2 }))
    .toEqual(['circle', 'circle']);
});


function dnfDebug(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getDnfDebugState());
}


// Lecture complète (par défaut depuis le 01/08/2011 : le DNF de GC2PR3N
// apparaît le 20/08/2011 et la trouvaille le résout le 08/01/2012).
async function playToEnd(page, { dateStart = '2011-08-01', dateEnd = null } = {}) {
  await page.evaluate(async ([start, end]) => {
    const app = await import('/static/js/index.js');
    app.options.animation.dateStart = new Date(`${start}T00:00:00`);
    app.options.animation.dateEnd = end ? new Date(`${end}T00:00:00`) : null;
  }, [dateStart, dateEnd]);
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPause')).toBeVisible();
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 40_000 });
}


test('un DNF trouvé s\'efface pendant la lecture, avec une célébration facultative', async ({ page }) => {
  await openWithData(page);
  await showDnf(page);
  await setRhythm(page, 60);
  await page.evaluate(async () => { (await import('/static/js/index.js')).options.flash.mode = 'none'; });

  // Par défaut : le point DNF s'efface, sans célébration.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  await expect(page.locator('#selectDnfFoundFlashMode')).toHaveValue('none');
  await expect(page.locator('#dnfFoundFlashOwnFields')).toBeHidden();
  await page.locator('a[href="#data"]').click();
  let before = await dnfDebug(page);
  await playToEnd(page);
  let after = await dnfDebug(page);
  expect(after.vanished).toBe(before.vanished + 1);
  expect(after.celebrations.length).toBe(before.celebrations.length);
  // Effacement terminé : le DNF a quitté la carte, la trouvaille l'a remplacé.
  expect(after.vanishing).toBe(0);
  expect(await mapCodes(page, 'dnf')).toEqual([]);
  expect(await mapCodes(page, 'find')).toContain('GC2PR3N');

  // Feu d'artifice : ses réglages apparaissent, et il joue à la trouvaille.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabFlash"]').click();
  await page.evaluate(() => {
    const select = document.getElementById('selectDnfFoundFlashMode');
    select.value = 'fireworks';
    select.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#dnfFoundFlashOwnFields')).toBeVisible();
  await page.locator('a[href="#data"]').click();
  before = await dnfDebug(page);
  await playToEnd(page);
  after = await dnfDebug(page);
  expect(after.celebrations.slice(before.celebrations.length)).toEqual(['fireworks']);
});


// Option dnf_same_day_display (décochée par défaut) : GC8DAYX, DNF puis
// trouvée le 10/09/2021, n'est jamais affichée au repos ; pendant la lecture
// le point apparaît un instant, s'efface et joue la célébration réglée.
test('option : un DNF trouvé le jour même s\'affiche un instant puis s\'efface', async ({ page, request }) => {
  await openWithData(page, SAMEDAY);
  await page.locator('#checkDnfDisplay').check();
  await expect(page.locator('#checkDnfSameDay')).not.toBeChecked();
  // Au repos, la cache est affichée : sa résolution (2021) tombe après la
  // fin de la période des trouvailles (2012) — même règle que GC9ZZZZ. Seule
  // l'animation la masque, elle disparaît le jour où elle apparaît.
  // La case est déjà proposée par le DNF du My Finds : le rechargement des
  // DNF qui suit l'import du fichier peut encore être en vol — attendre
  // GC8DAYX plutôt que lire la carte trop tôt.
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC8DAYX']);

  // Sans l'option : aucun effacement ce jour-là.
  await setRhythm(page, 60);
  await page.evaluate(async () => { (await import('/static/js/index.js')).options.flash.mode = 'none'; });
  let before = await dnfDebug(page);
  await playToEnd(page, { dateStart: '2021-08-01', dateEnd: '2021-12-31' });
  let after = await dnfDebug(page);
  expect(after.vanished).toBe(before.vanished);

  // Avec l'option : le point apparaît, s'efface et célèbre la trouvaille.
  await page.locator('#checkDnfSameDay').check();
  await expect.poll(async () =>
    (await (await request.get('/api/settings')).json()).dnf_same_day_display).toBe(true);
  await page.evaluate(async () => {
    (await import('/static/js/index.js')).options.flash.dnf_found.mode = 'fireworks';
  });
  before = after;
  await playToEnd(page, { dateStart: '2021-08-01', dateEnd: '2021-12-31' });
  after = await dnfDebug(page);
  expect(after.vanished).toBe(before.vanished + 1);
  expect(after.celebrations.slice(before.celebrations.length)).toEqual(['fireworks']);
  // La carte garde l'état de fin de lecture : le point effacé reste absent.
  expect(await mapCodes(page, 'dnf')).toEqual([]);
});


// Sans DNF connus, la case « Mes DNF » et les réglages du thème restent
// masqués (OFFER_IDS de dnf_data.js) ; un import les révèle.
test('la case « Mes DNF » et ses réglages n\'apparaissent qu\'avec des DNF', async ({ page, request }) => {
  await request.post('/api/logs/clear').catch(() => {});
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await expect(page.locator('#dnfDisplayField')).toBeHidden();
  // Sous-onglet Flash de l'onglet Style : hors onglet actif, seul
  // l'attribut hidden est fiable (le panneau masque sinon à tort).
  await expect(page.locator('#flashDnf')).toHaveJSProperty('hidden', true);

  await openWithData(page);
  await expect(page.locator('#dnfDisplayField')).toBeVisible();
  await expect(page.locator('#flashDnf')).toHaveJSProperty('hidden', false);
});


// « Période de découverte » déplacée : un point à durée de vie est retenu
// s'il est en échec dans la fenêtre, pas filtré sur son premier jour
// (aliveInWindow, bdd.js — sinon un début reculé vidait tout).
test('période de découverte : un DNF vivant dans la fenêtre reste affiché', async ({ page }) => {
  const setBound = (selector, value) => page.locator(selector).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await openWithData(page);
  await showDnf(page);
  const start0 = await page.locator('#datePickerStart').inputValue();

  // Début reculé après tous les DNF (2021) : GC9ZZZZ, jamais résolue, vit
  // encore dans la fenêtre ; GC2PR3N, résolue en 2012, n'y est plus.
  await setBound('#datePickerStart', '08/01/2022');
  await expect(page.locator('#dnfDisplayHint')).toContainText('1 DNF dans la sélection');
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC9ZZZZ']);

  // Fin reculée avant la résolution de GC2PR3N (08/01/2012) : alors en
  // échec, son point est affiché ; GC9ZZZZ n'est pas encore apparue.
  await setBound('#datePickerStart', start0);
  await setBound('#datePickerEnd', '31/12/2011');
  await expect(page.locator('#dnfDisplayHint')).toContainText('1 DNF dans la sélection');
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC2PR3N']);
});


// Légende optionnelle (#mapLegend, options.infos.legend.display — décochée
// par défaut) : une ligne par famille hors trouvailles affichée, masquée
// sans la case. La vidéo la repeint via overlay_canvas.js (mêmes ids DOM).
test('la légende optionnelle suit les familles hors trouvailles affichées', async ({ page }) => {
  await openWithData(page);
  await showDnf(page);
  // Masquée par défaut même avec un DNF affiché.
  await expect(page.locator('#mapLegend')).toBeHidden();

  // Onglet Style → Titres → cible « Infos » → « Afficher la légende ».
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.locator('#gcCssTargetInfos').click();
  await expect(page.locator('#cbDisplayLegend')).not.toBeChecked();
  await page.locator('#cbDisplayLegend').check();
  await expect(page.locator('#mapLegend')).toBeVisible();
  await expect(page.locator('#legendDnfRow')).toBeVisible();
  await expect(page.locator('#legendDnfLabel')).toHaveText('DNF (échec)');
  // Pas de caches posées dans la fixture : la ligne owner reste masquée.
  await expect(page.locator('#legendOwnerRow')).toBeHidden();

  await page.locator('#cbDisplayLegend').uncheck();
  await expect(page.locator('#mapLegend')).toBeHidden();
});


// Barre de chronologie : un repère par jour de DNF, seulement quand la
// couche est affichée (getTimelineBarSnapshot().marks, timeline_bar.js).
test('la chronologie marque les jours de DNF affichés', async ({ page }) => {
  await openWithData(page, AXIS);
  const dnfMarks = async () => {
    const snap = await page.evaluate(async () =>
      (await import('/static/js/index.js')).getTimelineBarSnapshot());
    return snap.marks.filter((m) => m.kind === 'dnf').map((m) => m.label);
  };
  // Couche masquée : aucun repère DNF.
  expect(await dnfMarks()).toEqual([]);

  await page.locator('#checkDnfDisplay').check();
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC9MARK']);
  // Un repère par tentative : la seconde est numérotée.
  await expect.poll(dnfMarks).toEqual(['DNF : GC9MARK', 'DNF n°2 : GC9MARK']);
});


// Échec du PUT /api/settings : la case et window.userSettings reviennent à
// l'état du disque (revertSetting) — l'écran ne doit pas afficher le
// contraire du serveur.
test('un échec de sauvegarde remet la case et la préférence', async ({ page }) => {
  await openWithData(page);
  await showDnf(page);
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'PUT') route.fulfill({ status: 500 });
    else route.continue();
  });

  // Décochage refusé côté serveur : la case recoche, la préférence reste
  // vraie et les points reviennent sur la carte. click() et non uncheck() :
  // ce dernier vérifie l'état final, que le rollback recoche déjà — le
  // refus s'affirme ensuite, pas pendant l'action.
  await page.locator('#checkDnfDisplay').click();
  await expect(page.locator('.gc-saved-indicator.is-error').first()).toBeVisible();
  await expect(page.locator('#checkDnfDisplay')).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.userSettings?.dnf_display)).toBe(true);
  await expect.poll(() => mapCodes(page, 'dnf')).toEqual(['GC9ZZZZ']);
});


test('le trait de déplacement passe par les DNF, sauf si on les en retire', async ({ page }) => {
  await openWithData(page);
  await enableTrail(page);
  await showDnf(page);

  const withDnf = await trailStops(page);
  await page.locator('#checkDnfInTrail').uncheck();
  const withoutDnf = await trailStops(page);
  // Le DNF du 20/08/2011 est une étape de plus (celui de 2021 est après la
  // fin de l'animation).
  expect(withDnf).toBe(withoutDnf + 1);
});
