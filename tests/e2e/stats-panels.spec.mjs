// Panneaux de statistiques posés sur la carte (onglet Stats).
//
// Le dessin (canvas) n'est pas comparé au pixel près : on observe l'état
// exposé par getStatsSnapshot() — mode, comptes, panneaux visibles, nombre de
// passes vidéo — et la géométrie des <canvas class="stats-panel">.
//
// Fixture : 6 caches, une par jour du 01 au 06/01/2026, D/T toutes distinctes
// (1/1 → 3,5/3,5), 3 Traditional, 2 Multi, 1 Event.
//
// `stats` est une préférence globale partagée par tous les specs d'un run :
// chaque test repart de la liste vide et la remet en place en sortant.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');
const GAP_FIXTURE = path.join(HERE, 'fixtures', 'my-finds-gap.gpx');
const DEFAULT_STATS = { enabled: true, panels: [] };

async function putStats(page, stats) {
  const response = await page.request.put('/api/settings', { data: { stats } });
  expect(response.ok()).toBe(true);
}

async function savedStats(page) {
  return (await (await page.request.get('/api/settings')).json()).stats;
}

async function openWithFixture(page, hash = '', fixture = FIXTURE, expectedCount = '6 / 6') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Fichier chargé avec succès' }).last())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.gcm-toast').filter({ hasText: 'Chargement et affichage des points' }).first())
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#filtersCounter')).toContainText(expectedCount);
  // Les filtres se réappliquent encore un peu après l'import, chacun par une
  // reconstruction de l'index : attendre qu'il ne bouge plus.
  let previous = -1;
  await expect.poll(async () => {
    const revision = await page.evaluate(async () => (await import('/static/js/index.js')).pointsByDateRevision);
    const stable = revision === previous;
    previous = revision;
    return stable;
  }, { intervals: [700], timeout: 15_000 }).toBe(true);
}

function snapshot(page) {
  return page.evaluate(async () => (await import('/static/js/index.js')).getStatsSnapshot());
}

const sum = (counts) => Object.values(counts || {}).reduce((s, n) => s + n, 0);

async function setRhythm(page, daysPerSecond) {
  await page.locator('a[href="#animation"]').click();
  await page.locator('#animationConfigTab').click();
  await page.locator('#inputDaysPerSecond').fill(String(daysPerSecond));
  await page.locator('#inputExtraEndTime').fill('0');
}

test.beforeEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
});

test.afterEach(async ({ page }) => {
  await putStats(page, DEFAULT_STATS);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
});

test('un modèle pose la matrice D/T, ancrée, empilée et retrouvée au redémarrage', async ({ page }) => {
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsEmpty')).toBeVisible();

  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="dt"]').click();

  const matrix = page.locator('canvas.stats-panel');
  await expect(matrix).toHaveCount(1);
  await expect(matrix).toBeVisible();
  // Ancre « en bas à gauche » : position exprimée depuis ce coin, convention
  // relue pour la vidéo.
  await expect(matrix).toHaveCSS('left', '16px');
  await expect(matrix).toHaveCSS('bottom', '16px');

  // Au repos : totaux de la sélection, toutes les caches dans la matrice.
  let state = await snapshot(page);
  expect(state.mode).toBe('rest');
  expect(state.total).toBe(6);
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(Object.keys(state.counts.dt)).toHaveLength(6);

  // Deux histogrammes sur le même coin : empilés, sans chevauchement.
  await page.locator('#btnStatsAdd').click();
  await page.locator('[data-stats-preset="types-sizes"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);
  const types = await page.locator('canvas.stats-panel').nth(1).boundingBox();
  const sizes = await page.locator('canvas.stats-panel').nth(2).boundingBox();
  expect(types && sizes).toBeTruthy();
  const [upper, lower] = [types, sizes].sort((a, b) => a.y - b.y);
  expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);

  state = await snapshot(page);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  expect(state.counts.cache_type['Multi-cache']).toBe(2);

  // Persistance (debounce 500 ms), puis restauration au rechargement.
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.metric))
    .toEqual(['dt', 'cache_type', 'container']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3, { timeout: 15_000 });
});

test('un modèle à deux panneaux se désactive quand il ne reste qu\'une place', async ({ page }) => {
  const five = ['f0000001', 'f0000002', 'f0000003', 'f0000004', 'f0000005']
    .map((id, i) => ({ id, kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right', dy: i * 8 } }));
  await putStats(page, { enabled: true, panels: five });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Une seule place sur six : les modèles à deux panneaux sont désactivés
  // avec la raison affichée ; les panneaux seuls restent proposés.
  await page.locator('#btnStatsAdd').click();
  const preset = page.locator('[data-stats-preset="types-sizes"]');
  await expect(preset).toBeDisabled();
  await expect(preset.locator('.stats-slots-hint')).toHaveText('2 places requises');
  await expect(page.locator('[data-stats-add="bar:year"]')).toBeEnabled();

  // Une suppression libère la place : le modèle redevient cliquable et pose
  // bien ses deux panneaux d'un coup. (Un second clic replie le menu, sinon
  // il intercepte les clics de la liste.)
  await page.locator('#btnStatsAdd').click();
  await page.locator('#statsPanelList [data-action="delete"]').first().click();
  await page.locator('#btnStatsAdd').click();
  await preset.click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(6);
});

test('la lecture remplit les panneaux jour après jour, l\'arrêt rend les totaux', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aaaaaa01', kind: 'grid', metric: 'dt' },
    { id: 'bbbbbb01', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right', dy: 64 } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await setRhythm(page, 2);

  await page.locator('#btnQuickPreview').click();
  // Au départ, aucune cache n'est antérieure à la date de début : l'état
  // courant repart de zéro puis grandit, il ne montre pas les totaux.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total > 0 && state.total < 6;
  }, { intervals: [50], timeout: 10_000 }).toBe(true);

  // Fin naturelle : état final conservé, cohérent avec le compteur.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  let state = await snapshot(page);
  expect(state.mode).toBe('animating');
  expect(sum(state.counts.dt) + state.excluded.dt).toBe(6);
  expect(state.counts.cache_type['Traditional Cache']).toBe(3);
  await expect(page.locator('#spanNbCaches')).toHaveText('6');

  // Nouveau filtre après la fin : totaux de la nouvelle sélection.
  await page.evaluate(() => {
    document.querySelector('#selectType').tomselect.setValue(['Traditional Cache']);
  });
  await expect(page.locator('#filtersCounter')).toContainText('3 / 6');
  await expect.poll(async () => {
    const s = await snapshot(page);
    return `${s.mode}:${s.total}`;
  }).toBe('rest:3');
  state = await snapshot(page);
  expect(state.counts.cache_type).toEqual({ 'Traditional Cache': 3 });
});

test('un export repart de zéro, même après un aperçu, et dessine les panneaux dans la vidéo', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page);
  await setRhythm(page, 6);

  // Aperçu complet : l'accumulateur finit à 6.
  await page.locator('#btnQuickPreview').click();
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  const drawsBefore = (await snapshot(page)).videoDrawCount;

  // Capture image par image (réglage en mémoire seulement : pas de
  // préférence globale modifiée pour les specs suivants).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.record.mode = 'images';
    app.options.record.fps = 12;
    app.options.flash.mode = 'none';
  });
  await page.locator('#btnQuickExport').click({ force: true });
  // Le démarrage de l'enregistrement remet l'accumulateur à l'état initial.
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.mode === 'animating' && state.total < 6;
  }, { intervals: [50], timeout: 30_000 }).toBe(true);

  const ready = page.locator('#modal_video_ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  const state = await snapshot(page);
  expect(state.total).toBe(6);
  expect(state.videoDrawCount).toBeGreaterThan(drawsBefore);
  await ready.locator('.modal-footer [data-bs-dismiss="modal"]').click();
});

test('l\'interrupteur général masque les panneaux sans perdre la liste', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  await page.locator('#switchStats').uncheck();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(false);
  expect((await savedStats(page)).panels).toHaveLength(1);

  await page.locator('#switchStats').check();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedStats(page)).enabled).toBe(true);
});

test('pas d\'onglet ni de panneau en mode Évolution', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await page.goto('/evolution', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('a[href="#stats"]')).toHaveCount(0);
  await expect(page.locator('#stats')).toHaveCount(0);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
});

test('anneau, courbe et compteurs se remplissent pendant la lecture', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await putStats(page, { enabled: true, panels: [
    { id: 'cccccc01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' },
      options: { items: ['days', 'best_day', 'streak', 'types', 'countries', 'states'] } },
    { id: 'cccccc02', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
    { id: 'cccccc03', kind: 'donut', metric: 'cache_type', position: { anchor: 'top-right' } },
    { id: 'cccccc04', kind: 'bar', metric: 'country', position: { anchor: 'bottom-right' }, options: { sort: 'race' } },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(4);

  // Au repos : les métriques dont dépendent courbe et compteurs sont comptées.
  let state = await snapshot(page);
  expect(state.metrics.sort()).toEqual(['cache_type', 'country', 'day', 'state']);
  expect(Object.keys(state.counts.day)).toHaveLength(6);
  expect(state.counts.country).toEqual({ France: 6 });

  await setRhythm(page, 2);
  await page.locator('#btnQuickPreview').click();
  await expect.poll(async () => {
    const s = await snapshot(page);
    return s.mode === 'animating' && s.total > 0 && s.total < 6;
  }, { intervals: [50], timeout: 10_000 }).toBe(true);
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(6);
  state = await snapshot(page);
  expect(Object.keys(state.counts.day)).toHaveLength(6);
  expect(errors).toEqual([]);
});

test('la courbe avance pendant les jours sans trouvaille', async ({ page }) => {
  // Numéro de jour du 01/01/2026, convention dayNumber (jours depuis l'epoch).
  const DAY1 = Date.UTC(2026, 0, 1) / 86400000;
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee02', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
  ] });
  // Fixture : trouvailles les 1er et 6 janvier, quatre jours vides entre les deux.
  await openWithFixture(page, '', GAP_FIXTURE, '2 / 2');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  // 1 j/s : au-delà de la durée des tweens (~600 ms), aucun redessin ne
  // survit entre deux lots sans accumulateStatsForDates.
  await setRhythm(page, 1);

  await page.locator('#btnQuickPreview').click();
  // Pendant le trou (total bloqué à 1), la tête dessinée continue d'avancer
  // au lieu de rester sur la dernière trouvaille.
  await expect.poll(async () => {
    const s = await snapshot(page);
    return s.mode === 'animating' && s.total === 1 ? s.drawnHeads?.eeeeee02 : null;
  }, { intervals: [50], timeout: 10_000 }).toBeGreaterThan(DAY1 + 1);

  // Fin naturelle : les deux trouvailles comptées, tête sur le dernier jour.
  await expect(page.locator('#btnQuickPreview')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await snapshot(page)).total, { timeout: 10_000 }).toBe(2);
  await expect.poll(async () => (await snapshot(page)).drawnHeads?.eeeeee02,
    { timeout: 10_000 }).toBe(DAY1 + 5);
});

test('une suppression se signale, s\'enregistre aussitôt et s\'annule', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aa000001', kind: 'bar', metric: 'cache_type', title: 'Types test' },
    { id: 'aa000002', kind: 'grid', metric: 'dt' },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);

  await page.locator('#statsPanelList [data-action="delete"]').first().click();
  // Statut global : l'écriture structurelle est confirmée sous « Panneaux ».
  await expect(page.locator('#statsSaveStatus')).toHaveClass(/is-saved/, { timeout: 10_000 });
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  const undo = page.locator('.gcm-toast.show .gcm-toast-action').filter({ hasText: 'Annuler' });
  await expect(undo).toBeVisible();
  // Enregistrement immédiat : le serveur a déjà la liste à jour.
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['aa000002']);

  // « Annuler » : le panneau revient à sa place, sauvegarde repartie.
  await undo.click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['aa000001', 'aa000002']);
});

test('un panneau glissé passe en position libre, choisir un coin l’y ramène', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'dddddd01', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left', width: 240 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Onglet ouvert, au repos : les panneaux se saisissent à la souris.
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  const panel = page.locator('canvas.stats-panel');
  const box = await panel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 - 120, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
  const { position } = (await savedStats(page)).panels[0];
  expect(position.x).toBeGreaterThan(0);
  expect(position.x).toBeLessThan(1);
  expect(position.y).toBeGreaterThan(0);
  expect(position.y).toBeLessThan(1);
  const moved = await panel.boundingBox();
  expect(Math.abs(moved.x - (box.x + 150))).toBeLessThan(4);
  expect(Math.abs(moved.y - (box.y - 120))).toBeLessThan(4);
  await expect(page.locator('#statsFreePosition')).toBeVisible();

  // Un coin choisi dans le formulaire remet le panneau dans sa pile.
  await page.locator('label[for="statsAnchor-top-right"]').click();
  await expect.poll(async () => (await savedStats(page)).panels[0].position)
    .toMatchObject({ mode: 'anchor', anchor: 'top-right' });
  await expect(page.locator('#statsFreePosition')).toBeHidden();
});

test('une pile de coin démarre sous le titre au lieu de le recouvrir', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left', dx: 16, dy: 16 } },
  ] });
  await openWithFixture(page);
  const title = page.locator('#titleFrame');
  test.skip(!(await title.isVisible()), 'Le thème courant ne montre pas de titre.');
  const titleBox = await title.boundingBox();
  const panelBox = await page.locator('canvas.stats-panel').boundingBox();
  const overlapsHorizontally = panelBox.x < titleBox.x + titleBox.width && titleBox.x < panelBox.x + panelBox.width;
  expect(overlapsHorizontally).toBe(true);
  expect(panelBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
});

test('la pile de coin se replace quand le cartouche d’infos grandit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee02', kind: 'counter', metric: 'summary', position: { anchor: 'top-right', dx: 16, dy: 16 } },
  ] });
  await openWithFixture(page);
  const infos = page.locator('#infosFrame');
  const panel = page.locator('canvas.stats-panel');
  test.skip(!(await infos.isVisible()), 'Le profil courant ne montre pas la boîte d’infos.');
  await expect(panel).toBeVisible();

  // La pile démarre sous la boîte (coin haut-droit = celui des infos).
  const startsBelow = async () => {
    const infosBox = await infos.boundingBox();
    const panelBox = await panel.boundingBox();
    return panelBox.y >= infosBox.y + infosBox.height;
  };
  await expect.poll(startsBelow).toBe(true);

  // Le cartouche peut grandir sans que la carte bouge (compteur plus long,
  // modèle d'infos, style appliqué) : la pile doit se replier sous la boîte
  // élargie, pas rester à la hauteur mesurée avant.
  await page.evaluate(() => { document.getElementById('infosFrame').style.fontSize = '64px'; });
  await expect.poll(startsBelow).toBe(true);
});

test('un patch partiel conserve les panneaux courants', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'eeeeee03', kind: 'counter', metric: 'summary' },
  ] });
  await openWithFixture(page);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);

  // Le serveur traite `stats` comme un patch de premier niveau : une clé
  // absente garde sa valeur. Le client doit tenir le même contrat — sinon
  // { enabled: false } viderait localement la liste gardée côté serveur.
  const applied = await page.evaluate(async () =>
    (await import('/static/js/index.js')).applyStatsSettings({ enabled: false }));
  expect(applied.enabled).toBe(false);
  expect(applied.panels).toHaveLength(1);
  expect(applied.panels[0].id).toBe('eeeeee03');
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);

  // Réactivation symétrique : la liste a survécu, le panneau réapparaît.
  const restored = await page.evaluate(async () =>
    (await import('/static/js/index.js')).applyStatsSettings({ enabled: true }));
  expect(restored.panels).toHaveLength(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
});
