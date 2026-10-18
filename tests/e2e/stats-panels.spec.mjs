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
import fs from 'node:fs';
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

test('chaque panneau expose un équivalent textuel accessible', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a11ce001', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: 'a11ce002', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'a11ce003', kind: 'line', metric: 'cumulative', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '', GAP_FIXTURE, '2 / 2');
  const canvases = page.locator('canvas.stats-panel');
  await expect(canvases).toHaveCount(3);
  // Le canvas reste muet ; son double hors écran porte les mêmes chiffres.
  await expect(canvases.first()).toHaveAttribute('aria-hidden', 'true');
  const alts = page.locator('.stats-panel-alt');
  await expect(alts).toHaveCount(3);
  await expect(alts.first()).toHaveClass(/visually-hidden/);

  // Le titre est le premier nœud : ^… évite que « Types de caches » matche
  // aussi la tuile « Types de caches différents » du compteur.
  const counter = alts.filter({ hasText: /^Chiffres clés/ });
  await expect(counter).toContainText('Jours avec trouvaille : 2');
  const types = alts.filter({ hasText: /^Types de caches/ });
  await expect(types).toContainText('Traditional Cache : 2');
  const line = alts.filter({ hasText: /^Progression des trouvailles/ });
  await expect(line).toContainText('2 trouvailles au');

  // Le texte suit les comptes, jour par jour : rejouer l'animation met la
  // liste à jour (tête de courbe comprise pendant les jours vides).
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.resetStatsForAnimation({ startDate: new Date(2026, 0, 1) });
    app.accumulateStatsForDates([new Date(2026, 0, 1)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(types).toContainText('Traditional Cache : 1');
  await expect(line).toContainText('1 trouvailles au 1 janv.');

  // Jours vides : les comptes ne bougent pas mais la tête de la courbe, oui.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.accumulateStatsForDates([new Date(2026, 0, 2), new Date(2026, 0, 3)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(line).toContainText('1 trouvailles au 3 janv.');

  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.accumulateStatsForDates(
      [new Date(2026, 0, 4), new Date(2026, 0, 5), new Date(2026, 0, 6)], performance.now());
    app.tickStatsPanels(performance.now());
  });
  await expect(line).toContainText('2 trouvailles au 6 janv.');
  await expect(types).toContainText('Traditional Cache : 2');
});

test('le panneau choisi dans la liste porte le repère de sélection sur la carte', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e100001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: '5e100002', kind: 'bar', metric: 'container', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  const first = page.locator('canvas.stats-panel[data-panel-id="5e100001"]');
  const second = page.locator('canvas.stats-panel[data-panel-id="5e100002"]');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  // Sans choix explicite, le premier panneau est sélectionné.
  await expect(first).toHaveClass(/is-selected/);
  await expect(second).not.toHaveClass(/is-selected/);

  // Choisir l'autre panneau dans la liste déplace le repère sur son canvas.
  await page.locator('li[data-panel-id="5e100002"] .stats-panel-name').click();
  await expect(second).toHaveClass(/is-selected/);
  await expect(first).not.toHaveClass(/is-selected/);

  // Le liseré n'est visible qu'en mode édition : il disparaît quand on quitte
  // l'onglet, sans perdre la sélection.
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  await page.locator('a[href="#style"]').click();
  await expect(page.locator('#mapWithFrames')).not.toHaveClass(/stats-editing/);
  await expect(second).toHaveClass(/is-selected/);
});

test('les sections Position et Apparence du formulaire sont repliées', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5ec70001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: '5ec70002', kind: 'bar', metric: 'container', position: { mode: 'free', x: 0.3, y: 0.4 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  const position = page.locator('#statsSectionPosition');
  const appearance = page.locator('#statsSectionAppearance');
  // Repliées par défaut : leurs contrôles sont hors de vue.
  await expect(position).toHaveJSProperty('open', false);
  await expect(appearance).toHaveJSProperty('open', false);
  await expect(page.locator('#inputStatsWidth')).toBeHidden();
  await expect(page.locator('#inputStatsBackground')).toBeHidden();

  // Le résumé déplie la section au clic.
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(page.locator('#inputStatsWidth')).toBeVisible();
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', false);

  // Un panneau glissé sur la carte (position libre) l'ouvre d'elle-même :
  // l'alerte « Revenir au coin d'ancrage » doit rester trouvable.
  await page.locator('li[data-panel-id="5ec70002"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(page.locator('#statsFreePosition')).toBeVisible();
  await expect(appearance).toHaveJSProperty('open', false);
});

test('« Réorganiser » répartit les panneaux en conflit sur des coins distincts', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e080001', kind: 'bar', metric: 'cache_type', position: { mode: 'free', x: 0.1, y: 0.1 } },
    { id: '5e080002', kind: 'bar', metric: 'container', position: { mode: 'free', x: 0.1, y: 0.1 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Les deux panneaux libres se recouvrent : l'alerte propose la réorganisation.
  const warnings = page.locator('#statsLayoutWarnings');
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText('chevauche');
  await warnings.getByRole('button', { name: 'Réorganiser automatiquement' }).click();

  // Chaque panneau repart sur un coin distinct : plus aucun avertissement.
  await expect(warnings).toBeHidden();
  const first = page.locator('canvas.stats-panel[data-panel-id="5e080001"]');
  await expect(first).toHaveCSS('left', '16px');
  await expect(first).toHaveCSS('bottom', '16px');
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.anchor))
    .toEqual(['bottom-left', 'bottom-right']);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.mode))
    .toEqual(['anchor', 'anchor']);
});

test('le panneau sélectionné s\'exporte en PNG et en CSV', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e0a0001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: '5e0a0002', kind: 'counter', metric: 'summary', position: { anchor: 'top-right' },
      options: { items: ['days', 'types'] } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportPng').click(),
  ]);
  expect(png.suggestedFilename()).toBe('stats-bar-cache_type.png');
  const signature = fs.readFileSync(await png.path()).subarray(0, 8);
  expect([...signature]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv.suggestedFilename()).toBe('stats-bar-cache_type.csv');
  const content = fs.readFileSync(await csv.path(), 'utf8');
  expect(content.charCodeAt(0)).toBe(0xFEFF);
  expect(content).toContain('Catégorie;Nombre;Pourcentage');
  expect(content).toContain('Traditional Cache;3');

  // L'export suit le panneau sélectionné dans la liste.
  await page.locator('#statsPanelList').getByText('Chiffres clés').click();
  const [csv2] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv2.suggestedFilename()).toBe('stats-counter-summary.csv');
  const content2 = fs.readFileSync(await csv2.path(), 'utf8');
  expect(content2).toContain('Chiffre;Valeur;Détail');
  expect(content2).toContain('Jours avec trouvaille;6');
  expect(content2).toContain('Types de caches différents;3');
});

test('une configuration nommée enregistre et ré-applique la liste de panneaux', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0f60001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'c0f60002', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Enregistrer la configuration actuelle sous un nom.
  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-stats-config-save]').click();
  await page.locator('#inputStatsConfigName').fill('Ma config');
  await page.locator('#btnStatsConfigSaveOk').click();
  await expect.poll(async () => (await savedStats(page)).configs?.map((c) => c.name))
    .toEqual(['Ma config']);

  // Liste vidée par l'UI, puis la configuration ré-applique tout.
  const deletes = page.locator('#statsPanelList [data-action="delete"]');
  while (await deletes.count()) await deletes.first().click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);

  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-config-apply="Ma config"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['c0f60001', 'c0f60002']);

  // La configuration peut ensuite être supprimée du menu.
  await page.locator('#btnStatsConfigs').click();
  await page.locator('[data-config-delete="Ma config"]').click();
  await expect.poll(async () => (await savedStats(page)).configs).toEqual([]);
});
