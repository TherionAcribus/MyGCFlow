// Panneaux de statistiques — mise en page : piles de coin et marges
// communes, aimantation au glisser, position libre, contournement du titre
// et du cartouche d'infos, redimensionnement par les poignées, repère de
// sélection, « Réorganiser ».
// Helpers et fixture : stats-panels-helpers.mjs.
import { expect, test } from '@playwright/test';
import {
  openWithFixture, putStats, resetStats, savedStats,
} from './stats-panels-helpers.mjs';

test.beforeEach(async ({ page }) => {
  await resetStats(page);
});

test.afterEach(async ({ page }) => {
  await resetStats(page);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
});

test('les marges sont celles du coin : communes à la pile, reprises en la rejoignant', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'c0a10001', kind: 'counter', metric: 'summary', position: { anchor: 'top-right', dx: 16, dy: 16 } },
    { id: 'c0a10002', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left', dx: 40, dy: 30 } },
    { id: 'c0a10003', kind: 'bar', metric: 'container', position: { anchor: 'bottom-left', dx: 16, dy: 8 } },
  ] });
  const margins = async () => (await savedStats(page)).panels
    .map((p) => `${p.id}:${p.position.anchor}:${p.position.dx}/${p.position.dy}`);
  // Le serveur normalise : la pile bas-gauche prend les marges de son premier.
  expect(await margins()).toEqual([
    'c0a10001:top-right:16/16', 'c0a10002:bottom-left:40/30', 'c0a10003:bottom-left:40/30',
  ]);
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();

  // Modifier la marge d'un panneau de la pile l'applique à toute la pile.
  await page.locator('li[data-panel-id="c0a10003"] .stats-panel-name').click();
  await page.locator('#statsSectionPosition summary').click();
  const dy = page.locator('#inputStatsDy');
  await expect(dy).toHaveValue('30');
  await dy.fill('50');
  await dy.press('Tab');
  await expect.poll(margins).toEqual([
    'c0a10001:top-right:16/16', 'c0a10002:bottom-left:40/50', 'c0a10003:bottom-left:40/50',
  ]);

  // Le premier panneau de la liste rejoint le coin bas-gauche : il en prend
  // les marges au lieu d'imposer les siennes (16/16) à la pile.
  await page.locator('li[data-panel-id="c0a10001"] .stats-panel-name').click();
  await page.locator('label[for="statsAnchor-bottom-left"]').click();
  await expect.poll(margins).toEqual([
    'c0a10001:bottom-left:40/50', 'c0a10002:bottom-left:40/50', 'c0a10003:bottom-left:40/50',
  ]);
  // Il ouvre la pile à 40 px du bord gauche et 50 px du bas du cadre.
  const host = await page.locator('#mapWithFrames').boundingBox();
  await expect.poll(async () => {
    const box = await page.locator('canvas.stats-panel[data-panel-id="c0a10001"]').boundingBox();
    return [Math.round(box.x - host.x), Math.round(host.y + host.height - box.y - box.height)];
  }).toEqual([40, 50]);

  // Ligne médiane : la pile est centrée, la marge verticale est grisée.
  await page.locator('label[for="statsAnchor-middle-right"]').click();
  await expect(dy).toBeDisabled();
  await expect(page.locator('#inputStatsDx')).toBeEnabled();
});

test('aimantation : lâché près d’un coin, un panneau rejoint sa pile ; ailleurs ou avec Alt, il reste libre', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a1a90001', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left', width: 240 } },
    { id: 'a1a90002', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-right', dx: 30, dy: 24 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const panel = page.locator('canvas.stats-panel[data-panel-id="a1a90001"]');
  await expect(panel).toBeVisible();
  const ghost = page.locator('#mapWithFrames > .stats-snap-ghost');
  const host = await page.locator('#mapWithFrames').boundingBox();
  const snapTargets = () => page.evaluate(async () =>
    (await import('/static/js/index.js')).getStatsSnapTargets('a1a90001'));
  // Glisse le panneau (saisi en son centre) pour que son coin haut-gauche
  // arrive en (left, top), repère du conteneur.
  const dragTopLeftTo = async (left, top, { release = true } = {}) => {
    const box = await panel.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(host.x + left + box.width / 2, host.y + top + box.height / 2, { steps: 10 });
    if (release) await page.mouse.up();
  };

  // Coin bas-droit : le panneau, premier de la liste, ouvrira la pile ;
  // l'emplacement tient compte des marges de la pile (30/24).
  const target = (await snapTargets()).find((t) => t.anchor === 'bottom-right');
  expect(target).toBeTruthy();
  expect((await snapTargets()).some((t) => t.anchor === 'middle-center')).toBe(false);
  await dragTopLeftTo(target.x - 20, target.y - 10, { release: false });
  // Pendant le geste : le repère montre la destination exacte.
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-anchor', 'bottom-right');
  const ghostBox = await ghost.boundingBox();
  expect(Math.abs(ghostBox.x - (host.x + target.x))).toBeLessThan(2);
  expect(Math.abs(ghostBox.y - (host.y + target.y))).toBeLessThan(2);
  await page.mouse.up();
  await expect(ghost).toBeHidden();
  await expect.poll(async () => (await savedStats(page)).panels[0].position)
    .toMatchObject({ mode: 'anchor', anchor: 'bottom-right', dx: 30, dy: 24 });
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return Math.abs(box.x - host.x - target.x) < 1 && Math.abs(box.y - host.y - target.y) < 1;
  }).toBe(true);

  // Au centre de la carte (aucun coin proche) : position libre.
  const box = await panel.boundingBox();
  await dragTopLeftTo((host.width - box.width) / 2, (host.height - box.height) / 2, { release: false });
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');

  // Alt maintenue : pas d'aimantation, même tout près d'un coin.
  const again = (await snapTargets()).find((t) => t.anchor === 'bottom-right');
  await page.keyboard.down('Alt');
  await dragTopLeftTo(again.x - 10, again.y - 10, { release: false });
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
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
  // La section Position ne s'ouvre plus d'elle-même : son sous-libellé signale
  // la position libre, l'alerte se retrouve en dépliant.
  await expect(page.locator('#statsPositionHintFree')).toBeVisible();
  await page.locator('#statsSectionPosition summary').click();
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

test('un panneau se redimensionne par son bord droit', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00001', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  // Mode édition : le tactile glisse/redimensionne au lieu de défiler.
  await expect(canvas).toHaveCSS('touch-action', 'none');

  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;
  // Survol du bord droit : curseur de redimensionnement.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  // Glisser depuis le bord droit élargit le panneau (~80 px).
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4 + 80, midY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
      .toBeGreaterThanOrEqual(355);  // 280 par défaut + ~80, marges de clamp
});

test('un panneau s\'étire en hauteur : champ, bord bas ; les grilles l\'ignorent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00002', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left', height: 400 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);

  // Hauteur imposée au chargement : le canvas fait ~400 px CSS de haut.
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeGreaterThan(396);
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeLessThan(404);

  // Le champ « Hauteur » reflète la valeur ; le modifier étire le panneau.
  await page.locator('#statsSectionPosition summary').click();
  const heightInput = page.locator('#inputStatsHeight');
  await expect(heightInput).toHaveValue('400');
  await heightInput.fill('500');
  await heightInput.press('Tab');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height).toBe(500);
  await expect.poll(async () => (await canvas.boundingBox()).height)
    .toBeGreaterThan(496);

  // Champ vidé : retour à la hauteur automatique (position.height = null).
  await heightInput.fill('');
  await heightInput.press('Tab');
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height).toBeNull();
  const naturalHeight = (await canvas.boundingBox()).height;
  expect(naturalHeight).toBeLessThan(300);

  // Bord bas : curseur ns-resize au survol, glisser qui impose la hauteur.
  const box = await canvas.boundingBox();
  const midX = box.x + box.width / 2;
  await page.mouse.move(midX, box.y + box.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'ns-resize');
  await page.mouse.down();
  await page.mouse.move(midX, box.y + box.height - 4 + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height)
    .toBeGreaterThanOrEqual(Math.round(box.height) + 60);

  // Coin bas-droit : les deux axes d'un coup (nwse-resize).
  const corner = await canvas.boundingBox();
  await page.mouse.move(corner.x + corner.width - 4, corner.y + corner.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'nwse-resize');
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width - 4 + 40, corner.y + corner.height - 4 + 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => {
    const p = (await savedStats(page)).panels[0].position;
    return p.width >= Math.round(corner.width) + 30 && p.height >= Math.round(corner.height) + 50;
  }).toBe(true);

  // Grille : champ masqué et hauteur stockée ignorée (cases carrées).
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00005', kind: 'grid', metric: 'dt',
      position: { anchor: 'top-left', height: 700 } },
  ] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await expect(canvas).toHaveCount(1);
  await page.locator('#statsSectionPosition summary').click();
  await expect(heightInput).toBeHidden();
  const gridBox = await canvas.boundingBox();
  expect(Math.abs(gridBox.height - 700)).toBeGreaterThan(50);
  // Ni curseur ns-resize, ni poignée basse sur une grille.
  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height - 4);
  await expect(canvas).toHaveCSS('cursor', 'grab');
});

test('les poignées suivent le pointeur : bords gauche/haut d’une ancre bas-droite', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00010', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;

  // Le bord droit est fixe (ancre) : pas de poignée là, elle est à gauche.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'grab');
  await page.mouse.move(box.x + 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  // Tirer le bord gauche vers la gauche élargit le panneau ; le bord droit
  // ne bouge pas, le bord gauche suit le pointeur.
  await page.mouse.down();
  await page.mouse.move(box.x + 4 - 80, midY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
    .toBeGreaterThanOrEqual(355);
  const wide = await canvas.boundingBox();
  expect(Math.abs((wide.x + wide.width) - (box.x + box.width))).toBeLessThan(2);
  expect(Math.abs(wide.x - (box.x - 80))).toBeLessThan(4);

  // Même logique en hauteur : poignée sur le bord haut, bord bas immobile.
  const midX = wide.x + wide.width / 2;
  await page.mouse.move(midX, wide.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'ns-resize');
  await page.mouse.down();
  await page.mouse.move(midX, wide.y + 4 - 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await savedStats(page)).panels[0].position.height)
    .toBeGreaterThanOrEqual(Math.round(wide.height) + 50);
  const tall = await canvas.boundingBox();
  expect(Math.abs((tall.y + tall.height) - (wide.y + wide.height))).toBeLessThan(2);

  // Coin haut-gauche : les deux axes, diagonale nwse.
  await page.mouse.move(tall.x + 4, tall.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'nwse-resize');

  // Ancre bas-gauche : le coin des poignées est en haut à droite (nesw).
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00011', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await expect(canvas).toHaveCount(1);
  const left = await canvas.boundingBox();
  await page.mouse.move(left.x + left.width - 4, left.y + 4);
  await expect(canvas).toHaveCSS('cursor', 'nesw-resize');
});

test('un panneau libre redimensionné garde son coin haut-gauche', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e5e00012', kind: 'bar', metric: 'cache_type',
      position: { mode: 'free', x: 0.5, y: 0.5 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  const midY = box.y + box.height / 2;

  // Sans épingle, x = 0,5 de l'espace restant aurait déplacé le bord gauche
  // de la moitié de l'élargissement : la poignée aurait fui le pointeur.
  await page.mouse.move(box.x + box.width - 4, midY);
  await expect(canvas).toHaveCSS('cursor', 'ew-resize');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4 + 80, midY, { steps: 4 });
  // Pendant le glisser (aperçu appliqué au rAF suivant) : bord gauche
  // immobile, bord droit sous le pointeur.
  await expect.poll(async () => {
    const during = await canvas.boundingBox();
    return Math.abs((during.x + during.width) - (box.x + box.width + 80)) < 4;
  }).toBe(true);
  expect(Math.abs((await canvas.boundingBox()).x - box.x)).toBeLessThan(2);
  await page.mouse.up();

  // Persisté : largeur élargie ET x/y recalculés pour ce coin.
  await expect.poll(async () => (await savedStats(page)).panels[0].position.width)
    .toBeGreaterThanOrEqual(355);
  const saved = (await savedStats(page)).panels[0].position;
  expect(saved.mode).toBe('free');
  expect(saved.x).toBeGreaterThan(0.5);
  // Après rechargement (positions relues du serveur), même coin haut-gauche.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(canvas).toHaveCount(1);
  const reloaded = await canvas.boundingBox();
  expect(Math.abs(reloaded.x - box.x)).toBeLessThan(2);
  expect(Math.abs(reloaded.y - box.y)).toBeLessThan(2);
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

test('« Réorganiser » ne déplace que les panneaux en conflit', async ({ page }) => {
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

  // Le premier panneau, qui ne gêne personne, reste libre ; le second part
  // au premier coin où il tient sans rien chevaucher. Plus d'avertissement.
  await expect(warnings).toBeHidden();
  const second = page.locator('canvas.stats-panel[data-panel-id="5e080002"]');
  await expect(second).toHaveCSS('left', '16px');
  await expect(second).toHaveCSS('bottom', '16px');
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.mode))
    .toEqual(['free', 'anchor']);
  expect((await savedStats(page)).panels[1].position.anchor).toBe('bottom-left');

  // Réversible : le toast « Annuler » restaure les positions libres d'avant.
  const toast = page.locator('.gcm-toast.show').filter({ hasText: 'Panneaux réorganisés' });
  await expect(toast).toBeVisible();
  await toast.locator('.gcm-toast-action').filter({ hasText: 'Annuler' }).click();
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.position.mode))
    .toEqual(['free', 'free']);
});

test('« Réorganiser » prévient quand la place manque pour tous les panneaux', async ({ page }) => {
  // Trois panneaux plus grands que la carte : aucun emplacement ne les
  // sépare, le toast le dit au lieu d'annoncer un succès.
  const huge = (id, metric) => ({ id, kind: 'bar', metric,
    position: { anchor: 'top-left', width: 1200, height: 1200 } });
  await putStats(page, { enabled: true, panels: [
    huge('5e090001', 'cache_type'), huge('5e090002', 'container'), huge('5e090003', 'difficulty'),
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const warnings = page.locator('#statsLayoutWarnings');
  await expect(warnings).toBeVisible();
  await warnings.getByRole('button', { name: 'Réorganiser automatiquement' }).click();
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'la place manque' })).toBeVisible();
  // Les avertissements restent : le problème n'est pas réglé.
  await expect(warnings).toBeVisible();
});
