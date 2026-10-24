// Panneaux de statistiques — cycle de vie : galerie « Ajouter », modèles,
// interrupteur général, suppression/duplication/réordonnancement, patch
// partiel, configurations nommées, touche Suppr.
// Helpers et fixture : stats-panels-helpers.mjs.
import { expect, test } from '@playwright/test';
import {
  openWithFixture, putStats, resetStats, savedStats, savedStatsWhen,
  snapshot, sum,
} from './stats-panels-helpers.mjs';

test.beforeEach(async ({ page }) => {
  await resetStats(page);
});

test.afterEach(async ({ page }) => {
  await resetStats(page);
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

test('la galerie « Ajouter » montre des vignettes, se filtre et pose le panneau choisi', async ({ page }) => {
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#btnStatsAdd').click();
  const gallery = page.locator('#statsGalleryModal');
  await expect(gallery).toBeVisible();
  await expect(page.locator('#inputStatsGallerySearch')).toBeFocused();
  await expect(page.locator('#statsGallerySlots')).toHaveText('Places libres : 6 sur 6');

  // Vignettes dessinées avec les données : un canvas par panneau posé.
  const card = (selector) => gallery.locator(selector);
  await expect(card('[data-stats-preset="dt"] .stats-gallery-thumb canvas')).toHaveCount(1);
  await expect(card('[data-stats-preset="types-sizes"] .stats-gallery-thumb canvas')).toHaveCount(2);
  await expect(card('[data-stats-preset="dt"] .stats-gallery-thumb')).toHaveClass(/has-preview/);
  // Dessiner la galerie ne pose rien et ne touche pas aux comptes des panneaux.
  expect((await snapshot(page)).visible).toEqual([]);

  // Recherche : sans accents ni casse, sur le titre, la description et la forme.
  const search = page.locator('#inputStatsGallerySearch');
  await search.fill('anneau');
  await expect(card('[data-stats-add="donut:cache_type"]')).toBeVisible();
  await expect(card('[data-stats-add="bar:cache_type"]')).toBeHidden();
  await expect(card('[data-stats-preset="dt"]')).toBeHidden();
  await search.fill('EXTREME');
  await expect(card('[data-stats-preset="extremes"]')).toBeVisible();
  await expect(card('[data-stats-add="donut:cache_type"]')).toBeHidden();
  await search.fill('zzz introuvable');
  await expect(page.locator('#statsGalleryEmpty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('#statsGalleryEmpty')).toBeHidden();
  await expect(card('[data-stats-add="bar:year"]')).toBeVisible();

  // Un clic pose le panneau, referme la galerie et le sélectionne.
  await card('[data-stats-add="donut:country"]').click();
  await expect(gallery).toBeHidden();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect(page.locator('#statsPanelList li.is-selected')).toHaveCount(1);
  await expect(page.locator('#selectStatsKind')).toHaveValue('donut');
});

test('un panneau apparaît en fondu à sa création', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }] });
  await openWithFixture(page);
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  // Le nom d'animation reste posé après la fin du fondu : pas de chronométrage
  // d'opacité (flaky).
  await expect(canvas).toHaveCSS('animation-name', 'stats-panel-in');
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
  await expect(page.locator('#statsGallerySlots')).toHaveText('Places libres : 1 sur 6');

  // Une suppression libère la place : le modèle redevient cliquable et pose
  // bien ses deux panneaux d'un coup. (Échap ferme la galerie, sinon elle
  // recouvre la liste — une fois ouverte : pendant son fondu d'entrée, la
  // touche serait ignorée.)
  await expect(page.locator('#inputStatsGallerySearch')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#statsGalleryModal')).toBeHidden();
  await page.locator('#statsPanelList [data-action="delete"]').first().click();
  await page.locator('#btnStatsAdd').click();
  await preset.click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(6);
  // Le clic referme la galerie ; complète, elle le dit.
  await expect(page.locator('#statsGalleryModal')).toBeHidden();
  await page.locator('#btnStatsAdd').click();
  await expect(page.locator('#statsGallerySlots')).toContainText('Plus de place');
  await expect(page.locator('[data-stats-add="bar:year"]')).toBeDisabled();
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

test('onglet Stats en mode Évolution : listes indépendantes, panneau étranger masqué', async ({ page }) => {
  // Deux listes séparées : un panneau du mode principal n'apparaît pas en
  // Évolution ; un panneau à métrique étrangère dans `evolution_panels`
  // reste listé, marqué « (Trouvailles) », mais n'est pas dessiné.
  await putStats(page, { enabled: true,
    panels: [{ id: 'aaaaaa01', kind: 'grid', metric: 'dt' }],
    evolution_panels: [{ id: 'bbbbbb02', kind: 'grid', metric: 'dt' }] });
  await page.goto('/evolution#stats', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('a[href="#stats"]')).toHaveCount(1);
  await expect(page.locator('#stats')).toHaveCount(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  const list = page.locator('#statsPanelList li');
  await expect(list).toHaveCount(1);
  await expect(list).toContainText('(Trouvailles)');
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

test('la liste des panneaux se réordonne à la souris', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'aa000001', kind: 'grid', metric: 'dt', position: { anchor: 'top-left' } },
    { id: 'aa000002', kind: 'counter', metric: 'summary', position: { anchor: 'top-right' } },
    { id: 'aa000003', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const items = page.locator('#statsPanelList li');
  // Premier item déposé dans la moitié basse du troisième → après lui.
  const target = items.nth(2);
  const box = await target.boundingBox();
  await items.nth(0).dragTo(target, { targetPosition: { x: 20, y: box.height - 4 } });
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id).join(','))
      .toBe('aa000002,aa000003,aa000001');
});

test('« Dupliquer » décale la copie d\'un panneau libre, empile celle d\'un panneau ancré', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0b1e001', kind: 'bar', metric: 'cache_type', position: { mode: 'free', x: 0.5, y: 0.5, width: 240 } },
    { id: 'c0b1e002', kind: 'bar', metric: 'container', position: { anchor: 'top-left', width: 240 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = (id) => page.locator(`canvas.stats-panel[data-panel-id="${id}"]`);
  const duplicate = (id) => page.locator(`#statsPanelList [data-panel-id="${id}"] [data-action="duplicate"]`);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Libre : la copie, posée juste après l'original, est décalée de 24 px.
  const original = await canvas('c0b1e001').boundingBox();
  await duplicate('c0b1e001').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(3);
  const ids = (await savedStatsWhen(page, (s) => s.panels.length === 3)).panels.map((p) => p.id);
  const copyId = ids[1];
  expect(ids[0]).toBe('c0b1e001');
  const copy = await canvas(copyId).boundingBox();
  expect(Math.abs(copy.x - original.x - 24)).toBeLessThanOrEqual(1);
  expect(Math.abs(copy.y - original.y - 24)).toBeLessThanOrEqual(1);
  expect((await savedStats(page)).panels[1].position.mode).toBe('free');

  // Ancré : la copie rejoint la pile du coin, sous l'original, sans le recouvrir.
  const anchored = await canvas('c0b1e002').boundingBox();
  await duplicate('c0b1e002').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(4);
  const saved = await savedStatsWhen(page, (s) => s.panels.length === 4);
  const stacked = saved.panels[3];
  expect(saved.panels[2].id).toBe('c0b1e002');
  expect(stacked.position.mode).toBe('anchor');
  expect(stacked.position.anchor).toBe('top-left');
  const below = await canvas(stacked.id).boundingBox();
  expect(below.y).toBeGreaterThanOrEqual(anchored.y + anchored.height);
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

test('touche Suppr : le panneau sélectionné est supprimé (même effet que le bouton)', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'de1e7001', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: 'de1e7002', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('#mapWithFrames')).toHaveClass(/stats-editing/);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  // Le clic sur l'onglet laisse le focus sur son lien : Suppr viserait
  // l'élément de la page, pas un contrôle du panneau — on s'en affranchit.
  await page.evaluate(() => document.activeElement?.blur?.());

  // Sélection dans la liste puis Suppr : le panneau part (liste, carte,
  // réglages) et le toast « Annuler » s'affiche — comme le bouton.
  await page.locator('#statsPanelList li[data-panel-id="de1e7001"] [data-action="select"]').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['de1e7002']);
  const undo = page.locator('.gcm-toast.show .gcm-toast-actions button', { hasText: 'Annuler' });
  await expect(undo).toBeVisible();

  // « Annuler » : le panneau revient à sa place.
  await undo.click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['de1e7001', 'de1e7002']);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Dans un champ, Suppr garde son rôle natif (pas de suppression).
  await page.locator('#statsPanelList li[data-panel-id="de1e7001"] [data-action="select"]').click();
  await page.locator('#inputStatsTitle').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#statsPanelList li')).toHaveCount(2);
});
