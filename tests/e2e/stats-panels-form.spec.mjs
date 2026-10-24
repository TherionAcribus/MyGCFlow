// Panneaux de statistiques — formulaire et accessibilité : options
// conditionnelles par forme et métrique, « Appliquer à tous », préréglages
// d'apparence, sections repliables, aperçu du panneau, équivalent textuel
// accessible, exports PNG/CSV/JSON et export vidéo.
// Helpers et fixture : stats-panels-helpers.mjs.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  GAP_FIXTURE, HERE, openWithFixture, putStats, resetStats, savedStats,
  setRhythm, snapshot,
} from './stats-panels-helpers.mjs';

test.beforeEach(async ({ page }) => {
  await resetStats(page);
});

test.afterEach(async ({ page }) => {
  await resetStats(page);
  await expect.poll(async () => (await savedStats(page)).panels.length).toBe(0);
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

test('« Appliquer cette apparence à tous » copie le style, palette exceptée, et s\'annule', async ({ page }) => {
  const look = { background: '#112233', background_opacity: 60, text_color: '#eeeeee',
    accent_color: '#ff8800', font_size: 14, radius: 4, inherit_font: false };
  await putStats(page, { enabled: true, panels: [
    { id: 'a9e00001', kind: 'bar', metric: 'cache_type', style: { ...look, palette: 'multi' } },
    { id: 'a9e00002', kind: 'bar', metric: 'difficulty', position: { anchor: 'top-right' } },
    // Masqué : fait partie de la liste, il suit aussi.
    { id: 'a9e00003', kind: 'grid', metric: 'dt', enabled: false },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const before = (await savedStats(page)).panels;
  const button = page.locator('#btnStatsStyleToAll');
  // Le premier panneau est sélectionné ; le bouton vit dans la section Apparence.
  await page.locator('#statsSectionAppearance > summary').click();
  await expect(button).toBeEnabled();
  await button.click();

  const pick = (style) => Object.fromEntries(Object.keys(look).map((key) => [key, style[key]]));
  await expect.poll(async () => (await savedStats(page)).panels.slice(1).map((p) => pick(p.style)))
    .toEqual([look, look]);
  const after = (await savedStats(page)).panels;
  // La palette reste celle de chaque panneau (dégradé pour la difficulté).
  expect(after[1].style.palette).toBe(before[1].style.palette);
  expect(after[0].style.palette).toBe('multi');
  const undo = page.locator('.gcm-toast.show').filter({ hasText: 'Apparence appliquée à 2 autres panneaux' })
    .locator('.gcm-toast-action').filter({ hasText: 'Annuler' });
  await expect(undo).toBeVisible();

  // « Annuler » : le style d'avant revient sur les deux autres.
  await undo.click();
  await expect.poll(async () => (await savedStats(page)).panels.slice(1).map((p) => p.style))
    .toEqual(before.slice(1).map((p) => p.style));

  // Seul dans la liste : rien à quoi l'appliquer.
  await page.locator('#statsPanelList [data-action="delete"]').nth(2).click();
  await page.locator('#statsPanelList [data-action="delete"]').nth(1).click();
  await expect(page.locator('#statsPanelList li')).toHaveCount(1);
  await expect(button).toBeDisabled();
});

test('un préréglage d\'apparence habille le panneau, s\'enfonce et s\'annule', async ({ page }) => {
  // Taille du texte retouchée : hors habillage, elle ne dématch pas « Sombre ».
  await putStats(page, { enabled: true, panels: [
    { id: 'a9f00001', kind: 'bar', metric: 'year', style: { font_size: 18 } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Le premier panneau est sélectionné ; les cartes vivent dans la section Apparence.
  await page.locator('#statsSectionAppearance > summary').click();

  const button = (name) => page.locator(`[data-stats-style-preset="${name}"]`);
  await expect(button('sombre')).toHaveAttribute('aria-pressed', 'true');
  // Chaque carte montre le panneau dessiné dans son style (vrai pipeline,
  // stats_panels.js › drawStatsStylePresetPreview) : canvas visible, icône
  // de repli masquée.
  for (const name of ['sombre', 'clair', 'verre', 'sans_fond']) {
    await expect(button(name).locator('canvas')).toBeVisible();
    await expect(button(name).locator('.ti')).toBeHidden();
  }

  await button('clair').click();
  await expect(button('clair')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('sombre')).toHaveAttribute('aria-pressed', 'false');
  // Seuls les champs du préréglage changent : la taille du texte survit.
  await expect.poll(async () => (await savedStats(page)).panels[0].style)
    .toMatchObject({ background: '#f8f9fa', text_color: '#1a2b3c', font_size: 18 });

  const undo = page.locator('.gcm-toast.show').filter({ hasText: 'Préréglage « Clair » appliqué' })
    .locator('.gcm-toast-action').filter({ hasText: 'Annuler' });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(button('sombre')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await savedStats(page)).panels[0].style)
    .toMatchObject({ background: '#0b1a2b', font_size: 18 });
});

test('le glisser d\'un panneau ne reconstruit pas son équivalent textuel', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'd0a97001', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const canvas = page.locator('canvas.stats-panel');
  await expect(canvas).toHaveCount(1);

  // Chaque mutation du texte alternatif est comptée : pendant le glisser, la
  // position est appliquée en place (previewStatsPanelPosition), sans
  // renormalisation — sinon settingsRev changerait à chaque pointermove et
  // toutes les <li> de l'équivalent seraient recréées par mouvement.
  await page.evaluate(() => {
    const alt = document.querySelector('.stats-panel-alt');
    window.__altMutations = 0;
    window.__altObserver = new MutationObserver(() => { window.__altMutations += 1; });
    window.__altObserver.observe(alt, { childList: true, subtree: true });
  });
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 });
  // Pendant le glisser : zéro reconstruction — la position n'entre pas dans
  // la clé a11y. (La reconstruction unique au dépôt, via le commit
  // renormalisé, est voulue : elle est mesurée avant le mouse.up.)
  expect(await page.evaluate(() => window.__altMutations)).toBe(0);
  await page.mouse.up();
  // Le dépôt a bien persisté la position libre (commit renormalisé).
  await expect.poll(async () => (await savedStats(page)).panels[0].position.mode).toBe('free');
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

test('en lecture, le texte accessible d\'une grille suit au plus une fois par seconde, puis rattrape', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'ca1e0001', kind: 'grid', metric: 'calendar', position: { anchor: 'bottom-left', width: 440 } },
  ] });
  await openWithFixture(page);
  const alt = page.locator('.stats-panel-alt');
  // Au repos : les six jours de la fixture, tout de suite.
  await expect(alt).toContainText('6 janv. : 1');

  // Rafale : début d'animation puis trois jours de trouvailles, en moins
  // d'une seconde. Sans limite, quatre reconstructions ; ici une au plus.
  const burst = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const day = (n) => new Date(2026, 0, n);
    const before = app.getStatsSnapshot().a11yRebuilds;
    app.resetStatsForAnimation({ startDate: day(1), endDate: day(6) });
    app.tickStatsPanels(0);
    for (let n = 1; n <= 3; n++) {
      app.accumulateStatsForDates([day(n)], n * 1000);
      app.tickStatsPanels(n * 1000);
    }
    return app.getStatsSnapshot().a11yRebuilds - before;
  });
  expect(burst).toBeLessThanOrEqual(1);

  // Rattrapage : le texte finit sur les comptes affichés (trois jours).
  await expect(alt).toContainText('3 janv. : 1', { timeout: 3_000 });
  await expect(alt).not.toContainText('4 janv.');

  // Retour au repos : totaux de la sélection, sans attendre.
  await page.evaluate(async () => (await import('/static/js/index.js')).showStatsTotals());
  await expect(alt).toContainText('6 janv. : 1', { timeout: 500 });
});

test('les sections Position et Apparence sont repliées par défaut et mémorisent leur état', async ({ page }) => {
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

  // Un panneau glissé sur la carte (position libre) n'ouvre plus la section :
  // c'est le sous-libellé du summary qui signale le mode courant.
  await page.locator('li[data-panel-id="5ec70002"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', false);
  await expect(page.locator('#statsFreePosition')).toBeHidden();
  await expect(page.locator('#statsPositionHintFree')).toBeVisible();
  await expect(page.locator('#statsPositionHintAnchored')).toBeHidden();
  await position.locator('summary').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(page.locator('#statsFreePosition')).toBeVisible();

  // L'état ouvert/fermé est mémorisé en localStorage et restauré au rechargement.
  await appearance.locator('summary').click();
  await expect(appearance).toHaveJSProperty('open', true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await page.locator('li[data-panel-id="5ec70001"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(appearance).toHaveJSProperty('open', true);

  await appearance.locator('summary').click();
  await expect(appearance).toHaveJSProperty('open', false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await page.locator('a[href="#stats"]').click();
  await page.locator('li[data-panel-id="5ec70001"] .stats-panel-name').click();
  await expect(position).toHaveJSProperty('open', true);
  await expect(appearance).toHaveJSProperty('open', false);
});

test('le panneau sélectionné s\'exporte en PNG et en CSV', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '5e0a0001', kind: 'bar', metric: 'cache_type', title: 'Mes types', position: { anchor: 'top-left' } },
    { id: '5e0a0002', kind: 'counter', metric: 'summary', position: { anchor: 'top-right' },
      options: { items: ['days', 'types'] } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Nom de fichier : le titre du panneau en slug ASCII (« Mes types » →
  // « stats-mes-types ») ; sans titre, le titre par défaut est slugué.
  // Image redessinée à l'échelle choisie (2× par défaut, suffixe « @2x ») :
  // dimensions = taille du panneau sur la carte × échelle (en-tête IHDR).
  const box = await page.locator('canvas.stats-panel[data-panel-id="5e0a0001"]').evaluate(
    (el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) }));
  const exportPng = async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btnStatsExportPng').click(),
    ]);
    const bytes = fs.readFileSync(await download.path());
    return { name: download.suggestedFilename(), bytes,
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  const scale = page.locator('#selectStatsPngScale');
  await expect(scale).toHaveValue('2');
  await expect(scale.locator('option[value="2"]'))
    .toHaveText(`2× — ${Math.round(box.width * 2)} × ${Math.round(box.height * 2)} px`);
  const png = await exportPng();
  expect(png.name).toBe('stats-mes-types@2x.png');
  expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  expect([png.width, png.height]).toEqual([Math.round(box.width * 2), Math.round(box.height * 2)]);
  await scale.selectOption('4');
  const png4 = await exportPng();
  expect(png4.name).toBe('stats-mes-types@4x.png');
  expect([png4.width, png4.height]).toEqual([Math.round(box.width * 4), Math.round(box.height * 4)]);
  await scale.selectOption('1');
  const png1 = await exportPng();
  expect(png1.name).toBe('stats-mes-types.png');
  expect([png1.width, png1.height]).toEqual([Math.round(box.width), Math.round(box.height)]);
  // Choix retenu par le navigateur.
  expect(await page.evaluate(() => localStorage.getItem('statsPngScale'))).toBe('1');

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv.suggestedFilename()).toBe('stats-mes-types.csv');
  const content = fs.readFileSync(await csv.path(), 'utf8');
  expect(content.charCodeAt(0)).toBe(0xFEFF);
  expect(content).toContain('Catégorie;Nombre;Pourcentage');
  expect(content).toContain('Traditional Cache;3');

  // L'export suit le panneau sélectionné dans la liste ; sans titre propre
  // c'est le titre par défaut (« Chiffres clés » → « stats-chiffres-cles »).
  await page.locator('#statsPanelList').getByText('Chiffres clés').click();
  const [csv2] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnStatsExportCsv').click(),
  ]);
  expect(csv2.suggestedFilename()).toBe('stats-chiffres-cles.csv');
  const content2 = fs.readFileSync(await csv2.path(), 'utf8');
  expect(content2).toContain('Chiffre;Valeur;Détail');
  expect(content2).toContain('Jours avec trouvaille;6');
  expect(content2).toContain('Types de caches différents;3');

  // Masqué, il n'a plus de canvas sur la carte mais s'exporte encore,
  // redessiné à sa largeur réglée (280 px par défaut).
  await page.locator('#statsPanelList li', { hasText: 'Chiffres clés' }).locator('[data-action="toggle"]').uncheck();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(1);
  await expect(page.locator('#btnStatsExportPng')).toBeEnabled();
  const hidden = await exportPng();
  expect(hidden.name).toBe('stats-chiffres-cles.png');
  expect(hidden.width).toBe(280);
});

test('les panneaux s\'exportent en JSON et se ré-importent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'e9e00101', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'e9e00102', kind: 'grid', metric: 'dt', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);

  // Export de la liste du mode courant depuis le menu « Configurations ».
  await page.locator('#btnStatsConfigs').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-stats-panels-export]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('stats-panneaux-finds.json');
  const jsonPath = await download.path();
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  expect(json.mode).toBe('finds');
  expect(json.panels).toHaveLength(2);

  // Liste vidée par l'UI : l'import la restaure depuis le fichier.
  const deletes = page.locator('#statsPanelList [data-action="delete"]');
  while (await deletes.count()) await deletes.first().click();
  await expect(page.locator('canvas.stats-panel')).toHaveCount(0);
  await page.setInputFiles('#statsPanelsImportFile', jsonPath);
  await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  await expect.poll(async () => (await savedStats(page)).panels.map((p) => p.id))
    .toEqual(['e9e00101', 'e9e00102']);
  await expect(page.locator('.gcm-toast.show').filter({ hasText: 'importé' })).toHaveCount(1);

  // Un fichier illisible est refusé proprement.
  const badPath = path.join(HERE, 'fixtures', '_bad-panels.json');
  fs.writeFileSync(badPath, '{ invalide');
  try {
    await page.setInputFiles('#statsPanelsImportFile', badPath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' })).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
  } finally {
    fs.unlinkSync(badPath);
  }

  // Un fichier lisible mais sans panneau exploitable est refusé AVANT tout
  // commit : la liste courante (2 panneaux) n'est pas vidée par l'import.
  const emptyPath = path.join(HERE, 'fixtures', '_empty-panels.json');
  const nopePath = path.join(HERE, 'fixtures', '_nope-panels.json');
  fs.writeFileSync(emptyPath, JSON.stringify({ mode: 'finds', panels: [] }));
  fs.writeFileSync(nopePath, JSON.stringify([{ kind: 'nope' }]));
  try {
    await page.setInputFiles('#statsPanelsImportFile', emptyPath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' })).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
    await expect.poll(async () => (await savedStats(page)).panels).toHaveLength(2);

    await page.setInputFiles('#statsPanelsImportFile', nopePath);
    await expect(page.locator('.gcm-toast.show').filter({ hasText: 'Import impossible' }).last()).toHaveCount(1);
    await expect(page.locator('canvas.stats-panel')).toHaveCount(2);
    await expect.poll(async () => (await savedStats(page)).panels).toHaveLength(2);
  } finally {
    fs.unlinkSync(emptyPath);
    fs.unlinkSync(nopePath);
  }
});

test('« Lignes au maximum » est proposé pour les métriques à catégories', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '7ab1e501', kind: 'bar', metric: 'attribute', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  // Le panneau unique est sélectionné par défaut ; attributs = catégoriel.
  const maxItems = page.locator('#inputStatsMaxItems');
  await expect(maxItems).toBeVisible();
  // Passage à une métrique ordonnée : plus de top-N, le champ se masque.
  await page.locator('#selectStatsMetric').selectOption('year');
  await expect(maxItems).toBeHidden();
});

test('« Les nouveautés » n\'est proposé qu\'aux types qui la distinguent', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: '9h1ghl01', kind: 'counter', metric: 'summary', position: { anchor: 'top-left' } },
    { id: '9h1ghl02', kind: 'bar', metric: 'cache_type', position: { anchor: 'bottom-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const newOption = page.locator('#selectStatsHighlight option[value="new"]');
  // Compteurs : « new » indisponible ; barres : proposée.
  await list.locator('li', { hasText: 'Chiffres clés' }).locator('[data-action="select"]').click();
  await expect(newOption).toBeDisabled();
  await list.locator('li', { hasText: 'Types de caches' }).locator('[data-action="select"]').click();
  await expect(newOption).toBeEnabled();
});

test('la palette « types de caches » n\'est proposée qu\'à la métrique type', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'a11ce001', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
    { id: 'a11ce002', kind: 'donut', metric: 'country', position: { anchor: 'top-right' },
      style: { palette: 'gc' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const gcOption = page.locator('#selectStatsPalette option[value="gc"]');
  // Type de cache : palette Groundspeak proposée.
  await list.locator('li', { hasText: 'Types de caches' }).locator('[data-action="select"]').click();
  await expect(gcOption).toBeEnabled();
  // Pays : sans objet — retirée ; un « gc » stocké s'affiche « accent »,
  // le rendu effectif (le réglage n'est pas réécrit).
  await list.locator('li', { hasText: 'Pays' }).locator('[data-action="select"]').click();
  await expect(gcOption).toBeDisabled();
  await expect(page.locator('#selectStatsPalette')).toHaveValue('accent');
});

test('la forme d\'un panneau catégoriel se change sans perdre ses réglages', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'f0be0001', kind: 'bar', metric: 'cache_type', title: 'Mes types',
      position: { mode: 'free', x: 0.4, y: 0.5 } },
    { id: 'f0be0002', kind: 'bar', metric: 'year', position: { anchor: 'top-right' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  const list = page.locator('#statsPanelList');
  const kindSelect = page.locator('#selectStatsKind');

  // Métrique unique au type « bar » : pas de select de forme.
  await list.locator('li', { hasText: 'Trouvailles par année' }).locator('[data-action="select"]').click();
  await expect(page.locator('#statsKindField')).toBeHidden();

  // Types de caches : barres ou anneau.
  await list.locator('li', { hasText: 'Mes types' }).locator('[data-action="select"]').click();
  await expect(kindSelect).toBeVisible();
  await kindSelect.selectOption('donut');
  // Même panneau (id, titre, position libre), options d'anneau (trou).
  await expect.poll(async () => {
    const s = await savedStats(page);
    const p = s.panels.find((x) => x.id === 'f0be0001');
    return p && `${p.kind}|${p.title}|${p.position.mode}|${typeof p.options.hole}`;
  }).toBe('donut|Mes types|free|number');
});

test('le panneau sélectionné a un aperçu dans l\'onglet', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'b0a1e001', kind: 'bar', metric: 'cache_type',
      position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#statsPanelList li').locator('[data-action="select"]').click();
  const preview = page.locator('#statsPanelPreview');
  await expect(preview).toBeVisible();
  // Bitmap à la largeur réelle du panneau (280 par défaut), non vide.
  const { width, painted } = await preview.evaluate((c) => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { painted = true; break; }
    }
    return { width: c.width, painted };
  });
  expect(width).toBe(280);
  expect(painted).toBe(true);
  // L'aperçu suit la largeur quand le champ change : la section Position est
  // repliée par défaut, et le réaffichage part de l'événement « change ».
  await page.locator('#statsSectionPosition summary').click();
  await page.locator('#inputStatsWidth').fill('400');
  await page.locator('#inputStatsWidth').press('Tab');
  await expect.poll(() => preview.evaluate((c) => c.width)).toBe(400);
});

test('l\'aperçu du formulaire suit les données sans toucher au formulaire', async ({ page }) => {
  await putStats(page, { enabled: true, panels: [
    { id: 'b0a1e101', kind: 'bar', metric: 'cache_type', position: { anchor: 'top-left' } },
  ] });
  await openWithFixture(page, '#stats');
  await page.locator('a[href="#stats"]').click();
  await page.locator('#statsPanelList li').locator('[data-action="select"]').click();
  const preview = page.locator('#statsPanelPreview');
  await expect(preview).toBeVisible();
  // Même pipeline et même taille (DPR 1 en test) : l'aperçu et le panneau de
  // la carte doivent donner le même bitmap.
  const sameAsMap = () => page.evaluate(() => {
    const map = document.querySelector('canvas.stats-panel[data-panel-id="b0a1e101"]');
    const prev = document.getElementById('statsPanelPreview');
    return !!map && map.width === prev.width && map.height === prev.height
      && map.toDataURL() === prev.toDataURL();
  });
  await expect.poll(sameAsMap).toBe(true);

  // Les données changent sous le formulaire (nouveau type pour toutes les
  // caches) : l'aperçu se redessine avec la carte.
  const before = await preview.evaluate((c) => c.toDataURL());
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      for (const f of features) f.properties.cache_type = 'Mystery Cache';
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await expect.poll(() => preview.evaluate((c) => c.toDataURL())).not.toBe(before);
  await expect.poll(sameAsMap).toBe(true);

  // Onglet quitté pendant le changement : l'aperçu se rattrape au retour.
  await page.locator('a[href="#data"]').click();
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    for (const features of app.pointsByDate.values()) {
      for (const f of features) f.properties.cache_type = 'Traditional Cache';
    }
    app.bumpPointsByDateRevision();
    app.refreshStatsPanels();
  });
  await page.locator('a[href="#stats"]').click();
  await expect.poll(sameAsMap).toBe(true);
});
