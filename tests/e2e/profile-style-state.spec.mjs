import { expect, test } from '@playwright/test';


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gcmapReady === true);

  // La base du runtime de test est vide : la modale de première utilisation
  // s'ouvre (de façon asynchrone) et intercepterait les clics sur les onglets.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}


// Profil complet côté style (points, animation, flash, infos), sans bloc carte :
// les tests de fond de carte vivent dans map-source-of-truth.spec.mjs.
const STYLE_PROFILE = {
  name: 'Style',
  points: {
    mode: 'icone',
    size: 7,
    color: '#112233',
    shape: 'triangle',
    halo: true,
    border_size: 4,
    border_color: '#445566',
    fill_color_type: 'fix',
    border_color_type: 'gc',
    icon_set: 'smiley',
    icon_size: 32,
  },
  animation: { enabled: true, speed: 2 },
  flash: { mode: 'star', duration: 1500, size: 60, color: '#00ff00', color_type: 'gc' },
  infos: {
    title: { display: true, text: 'Ma carte de test' },
    number_of_caches: false,
    current_date: true,
  },
};


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#style"]').click();
});


test('appliquer un profil écrit les options puis synchronise l\'interface', async ({ page }) => {
  // Aucun await entre applyProfile() et la lecture : l'application est
  // synchrone (plus de .click() ni de dispatchEvent), l'état doit être complet
  // immédiatement.
  const applied = await page.evaluate(async (profile) => {
    await window.profileManager.applyProfile(profile);

    const app = await import('/static/js/index.js');
    return {
      point: JSON.parse(JSON.stringify(app.options.point)),
      animation: JSON.parse(JSON.stringify(app.options.animation)),
      flash: JSON.parse(JSON.stringify(app.options.flash)),
      infos: JSON.parse(JSON.stringify(app.options.infos)),
      dom: {
        modeSwitch: document.getElementById('switchIconeVectoriel').checked,
        size: document.getElementById('inputSizePoint').value,
        sizeSlider: document.getElementById('sliderSizePoint').value,
        centerColor: document.getElementById('pointCenterColor').value,
        shape: document.getElementById('selectShape').value,
        borderSize: document.getElementById('inputSizeBorder').value,
        borderColor: document.getElementById('pointBorderColor').value,
        fillColorType: document.querySelector('input[name="fillColorPoint"]:checked').value,
        borderColorType: document.querySelector('input[name="borderColorPoint"]:checked').value,
        iconSet: document.getElementById('selectIconSet').value,
        iconSize: document.getElementById('inputSizeIcon').value,
        iconeOptionsVisible: document.getElementById('iconeOptions').style.display !== 'none',
        timePerDay: document.getElementById('inputTimePerDay').value,
        flashMode: document.getElementById('selectFlashMode').value,
        flashDuration: document.getElementById('inputTimeFlash').value,
        flashSize: document.getElementById('inputSizeFlash').value,
        flashColorType: document.querySelector('input[name="flashColor"]:checked').value,
        title: document.getElementById('inputTitle').value,
        titleChecked: document.getElementById('cbDisplayTitle').checked,
        cachesChecked: document.getElementById('cbDisplayNumberofCaches').checked,
        dateChecked: document.getElementById('cbDisplayCurrentDate').checked,
        titleFrame: document.getElementById('titleFrame')?.textContent,
      },
    };
  }, STYLE_PROFILE);

  // 1. L'état : pkg.options est la source de vérité.
  expect(applied.point).toMatchObject({
    mode: 'icone',
    shape: 'triangle',
    center: { size: 7, color: '#112233', mode: 'fix' },
    border: { size: 4, color: '#445566', mode: 'gc' },
    iconSet: 'smiley',
    iconSize: 32,
  });
  // La méta sprite du jeu d'icônes n'existe que dans les options : elle doit
  // être dérivée à l'application, sans passer par le sous-menu.
  expect(applied.point.sprite.map).toHaveProperty('found');
  // speed 2.0 => 500 ms par jour
  expect(Number(applied.animation.timePerDay)).toBe(500);
  expect(applied.flash).toMatchObject({
    mode: 'star', duration: 1500, size: 60, color: '#00ff00', color_type: 'gc',
  });
  expect(applied.infos.title).toMatchObject({ display: true, text: 'Ma carte de test' });
  expect(applied.infos.numberOfCaches.display).toBe(false);
  expect(applied.infos.currentDate.display).toBe(true);

  // 2. L'interface n'en est qu'un reflet.
  expect(applied.dom).toMatchObject({
    modeSwitch: false,
    size: '7',
    sizeSlider: '7',
    centerColor: '#112233',
    shape: 'triangle',
    borderSize: '4',
    borderColor: '#445566',
    fillColorType: 'fix',
    borderColorType: 'gc',
    iconSet: 'smiley',
    iconSize: '32',
    iconeOptionsVisible: true,
    timePerDay: '500',
    flashMode: 'star',
    flashDuration: '1500',
    flashSize: '60',
    flashColorType: 'gc',
    title: 'Ma carte de test',
    titleChecked: true,
    cachesChecked: false,
    dateChecked: true,
    titleFrame: 'Ma carte de test',
  });
});


test('le profil relu juste après application est identique (aucun état transitoire)', async ({ page }) => {
  const reread = await page.evaluate(async (profile) => {
    await window.profileManager.applyProfile(profile);
    // Pas d'attente : loadCurrentSettings() doit déjà voir l'état complet.
    window.profileManager.loadCurrentSettings();
    return JSON.parse(JSON.stringify(window.profileManager.currentSettings));
  }, STYLE_PROFILE);

  expect(reread.points).toMatchObject(STYLE_PROFILE.points);
  expect(reread.flash).toMatchObject(STYLE_PROFILE.flash);
  expect(reread.animation.speed).toBeCloseTo(2, 5);
  expect(reread.infos.title).toMatchObject(STYLE_PROFILE.infos.title);
  expect(reread.infos.number_of_caches).toBe(false);
  expect(reread.infos.current_date).toBe(true);
});


test('l\'indicateur "modifications non enregistrées" suit l\'état, pas les événements', async ({ page }) => {
  const indicator = page.locator('#current-profile-indicator');

  // Les contrôles de points vivent dans le sous-onglet "Points & Flash".
  await page.locator('a[href="#tabPointsFlash"]').click();
  await expect(page.locator('#inputSizePoint')).toBeVisible();

  // Un profil courant est nécessaire : sans lui l'indicateur reste vide et le
  // suivi ne calcule rien.
  const initialSize = await page.evaluate(async () => {
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Suivi', uid: 'suivi', version: '1.0' };
    pm._markSaved();
    return document.getElementById('inputSizePoint').value;
  });

  await expect(indicator).not.toHaveClass(/unsaved/);

  // La taille du point n'est appliquée qu'à l'événement 'change' : fill() seul
  // ne produit qu'un 'input', il faut quitter le champ comme le ferait un
  // utilisateur.
  const setSize = async (value) => {
    await page.locator('#inputSizePoint').fill(String(value));
    await page.locator('#inputSizePoint').blur();
  };

  await setSize(Number(initialSize) + 1);
  await expect(indicator).toHaveClass(/unsaved/);

  // Revenir à la valeur enregistrée doit éteindre l'indicateur : c'est ce qu'un
  // simple drapeau `dirty = true` posé sur chaque événement ne saurait pas faire.
  await setSize(initialSize);
  await expect(indicator).not.toHaveClass(/unsaved/);

  // Déplacer la carte n'est pas un réglage de style : le centre et le zoom
  // courants sont exclus de la comparaison.
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.getMap().getView().setCenter(ol.proj.fromLonLat([-4.4860, 48.3905]));
  });
  await setSize(initialSize);
  await page.waitForTimeout(600); // au-delà du debounce de 300 ms
  await expect(indicator).not.toHaveClass(/unsaved/);
});


test('les modifications non enregistrées passent par une modale à trois issues', async ({ page }) => {
  // Un window.confirm() natif serait rejeté par Playwright (aucun handler de
  // dialogue) : ce test échouerait sur l'attente de la modale. On surveille tout
  // de même l'apparition d'un dialogue natif pour que la régression soit lisible.
  const nativeDialogs = [];
  page.on('dialog', (dialog) => { nativeDialogs.push(dialog.message()); dialog.dismiss(); });

  const modal = page.locator('#unsaved-changes-modal');

  // La sauvegarde est remplacée par un espion : les profils vivent dans
  // %APPDATA%\GCMap, que le runtime isolé des tests ne couvre pas (un vrai
  // PUT /api/profiles écrirait dans la configuration réelle de l'utilisateur).
  const ask = () => page.evaluate(() => {
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Suivi', uid: 'suivi', version: '1.0' };
    pm.hasUnsavedChanges = true;
    window.__saveCalls = 0;
    pm.saveCurrentAsProfile = async () => { window.__saveCalls += 1; return true; };
    // La promesse n'est résolue qu'à la fermeture de la modale : on la garde
    // pour la relire après le clic.
    window.__choice = pm._confirmDiscardChangesIfNeeded();
  });
  const outcome = () => page.evaluate(async () => ({
    canContinue: await window.__choice,
    saveCalls: window.__saveCalls,
  }));

  // 1. Annuler : l'action appelante ne doit pas continuer, rien n'est enregistré.
  await ask();
  await expect(modal).toBeVisible();
  // Le nom du profil concerné est repris dans le message (impossible avec confirm()).
  await expect(page.locator('#unsaved-changes-message')).toContainText('Suivi');
  await modal.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(modal).toBeHidden();
  expect(await outcome()).toEqual({ canContinue: false, saveCalls: 0 });

  // 2. Abandonner : on continue sans enregistrer.
  await ask();
  await expect(modal).toBeVisible();
  await modal.locator('#btn-unsaved-discard').click();
  await expect(modal).toBeHidden();
  expect(await outcome()).toEqual({ canContinue: true, saveCalls: 0 });

  // 3. Enregistrer et charger : on enregistre, puis on continue.
  await ask();
  await expect(modal).toBeVisible();
  await modal.locator('#btn-unsaved-save').click();
  await expect(modal).toBeHidden();
  expect(await outcome()).toEqual({ canContinue: true, saveCalls: 1 });

  // 4. Échec de la sauvegarde : les modifications ne doivent pas être perdues.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.saveCurrentAsProfile = async () => false;
    window.__choice = pm._confirmDiscardChangesIfNeeded();
  });
  await expect(modal).toBeVisible();
  await modal.locator('#btn-unsaved-save').click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => window.__choice)).toBe(false);

  // 5. Sans modification en attente, aucune modale : l'action part directement.
  const direct = await page.evaluate(() => {
    window.profileManager.hasUnsavedChanges = false;
    return window.profileManager._confirmDiscardChangesIfNeeded();
  });
  expect(direct).toBe(true);
  await expect(modal).toBeHidden();

  expect(nativeDialogs).toEqual([]);
});


test('fermer l\'onglet avec des modifications non enregistrées déclenche la garde', async ({ page }) => {
  // On dispatche un 'beforeunload' synthétique : la vraie boîte du navigateur
  // n'apparaît que sur fermeture réelle, mais c'est bien preventDefault() qui la
  // déclenche, donc `defaultPrevented` mesure exactement la garde.
  const guard = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

  // Profil courant sans modification : la fermeture ne doit rien demander.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Test', uid: 'test' };
    pm._markSaved();
  });
  expect(await guard()).toBe(false);

  // Modification de dernière seconde : le recalcul débouncé (300 ms) n'a pas
  // encore eu lieu au moment où l'onglet se ferme, la garde doit le forcer.
  const lastSecond = await page.evaluate(() => {
    const input = document.getElementById('inputSizePoint');
    input.value = String((parseInt(input.value, 10) || 3) + 3);
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const beforeFlush = window.profileManager.hasUnsavedChanges;
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return { beforeFlush, prevented: event.defaultPrevented, dirty: window.profileManager.hasUnsavedChanges };
  });
  expect(lastSecond).toEqual({ beforeFlush: false, prevented: true, dirty: true });

  // Une fois enregistré, plus rien à protéger.
  await page.evaluate(() => window.profileManager._markSaved());
  expect(await guard()).toBe(false);
});


test('l\'étoile marque le profil par défaut, indépendamment du profil actif', async ({ page }) => {
  // Liste et profil par défaut posés en mémoire : les profils et le réglage
  // "profil par défaut" vivent dans %APPDATA%\GCMap, que le runtime isolé des
  // tests ne couvre PAS. Créer un profil ou appeler setProfileAsDefault ici
  // écrirait dans la configuration réelle de l'utilisateur.
  const render = (defaultName, activeName) => page.evaluate(({ defaultName, activeName }) => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha', 'Beta'];
    pm._defaultProfileName = defaultName;
    pm.currentProfile = activeName ? { name: activeName, uid: activeName } : null;
    pm.renderProfilesList();
  }, { defaultName, activeName });

  const marker = (name, cls) => page.locator(`#profiles-list [data-profile-name="${name}"] ${cls}`);

  // Défaut et actif distincts : c'est le cas que l'étoile rend lisible.
  await render('Alpha', 'Beta');
  await expect(marker('Alpha', '.profile-default-star')).toHaveCount(1);
  await expect(marker('Alpha', '.active-badge')).toHaveCount(0);
  await expect(marker('Beta', '.active-badge')).toHaveCount(1);
  await expect(marker('Beta', '.profile-default-star')).toHaveCount(0);

  // Même profil : l'étoile doit coexister avec le badge ACTIF.
  await render('Beta', 'Beta');
  await expect(marker('Beta', '.profile-default-star')).toHaveCount(1);
  await expect(marker('Beta', '.active-badge')).toHaveCount(1);
  await expect(marker('Alpha', '.profile-default-star')).toHaveCount(0);

  // Aucun profil par défaut ('' côté serveur) : aucune étoile.
  await render('', 'Beta');
  await expect(page.locator('#profiles-list .profile-default-star')).toHaveCount(0);

  // Réglages pas encore lus au rendu (null) : l'étoile est posée après coup sur
  // la liste déjà affichée, sans reconstruction.
  await render(null, 'Beta');
  await expect(page.locator('#profiles-list .profile-default-star')).toHaveCount(0);
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm._defaultProfileName = 'Alpha';
    pm._updateDefaultProfileHighlight();
  });
  await expect(marker('Alpha', '.profile-default-star')).toHaveCount(1);

  // Déplacer le badge ACTIF ne doit pas emporter l'étoile : les deux marquages
  // sont indépendants et rafraîchis séparément.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Alpha', uid: 'Alpha' };
    pm._updateActiveProfileHighlight();
  });
  await expect(marker('Alpha', '.active-badge')).toHaveCount(1);
  await expect(marker('Alpha', '.profile-default-star')).toHaveCount(1);
});


test('dupliquer passe par la modale de nom pré-remplie', async ({ page }) => {
  // Liste posée en mémoire et duplication espionnée : les profils vivent dans
  // %APPDATA%\GCMap, hors du runtime isolé des tests (cf. l'étoile "par défaut").
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha', 'Alpha_copy', 'Beta'];
    pm.currentProfile = null;
    window.__duplicated = [];
    pm.duplicateProfile = async (original, newName) => { window.__duplicated.push([original, newName]); };
    pm.renderProfilesList();
  });

  const modal = page.locator('#profile-modal');
  const input = page.locator('#profile-name-input');
  const duplicateItem = (name) => page.locator(
    `#profiles-list [data-profile-name="${name}"] .dropdown-menu .dropdown-item`,
    { hasText: 'Dupliquer' },
  );
  const openMenu = (name) => page.locator(`#profiles-list [data-profile-name="${name}"] .dropdown-toggle`).click();

  // 1. "Dupliquer" ouvre la modale au lieu de créer directement : rien n'est
  // dupliqué tant que l'utilisateur n'a pas validé.
  await openMenu('Alpha');
  await duplicateItem('Alpha').click();
  await expect(modal).toBeVisible();
  expect(await page.evaluate(() => window.__duplicated)).toEqual([]);

  // Le nom suggéré évite les noms déjà pris, comme le ferait le serveur.
  await expect(input).toHaveValue('Alpha_copy (1)');
  await expect(page.locator('#btn-confirm-profile')).toHaveText('Dupliquer');

  // 2. Annuler ne duplique rien.
  await modal.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => window.__duplicated)).toEqual([]);

  // 3. Un nom saisi remplace la suggestion, le profil source reste l'original.
  await openMenu('Beta');
  await duplicateItem('Beta').click();
  await expect(modal).toBeVisible();
  await expect(input).toHaveValue('Beta_copy');
  await input.fill('  Gamma  ');
  await page.locator('#btn-confirm-profile').click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => window.__duplicated)).toEqual([['Beta', 'Gamma']]);

  // 4. La modale est partagée avec "Nouveau profil" : le profil source de la
  // duplication précédente ne doit pas rester attaché au bouton.
  await page.evaluate(() => {
    window.__created = [];
    window.profileManager.createProfile = async (name) => { window.__created.push(name); };
    window.profileManager.showNewProfileModal();
  });
  await expect(modal).toBeVisible();
  await expect(input).toHaveValue('');
  expect(await page.locator('#btn-confirm-profile').getAttribute('data-original-name')).toBe('');
  await input.fill('Delta');
  await page.locator('#btn-confirm-profile').click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => ({ created: window.__created, duplicated: window.__duplicated })))
    .toEqual({ created: ['Delta'], duplicated: [['Beta', 'Gamma']] });
});


test('basculer manuellement en mode icône garde la méta sprite et un seul redraw', async ({ page }) => {
  const toggled = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const layers = app.getMap().getLayers();
    let adds = 0;
    const key = layers.on('add', () => { adds += 1; });

    const modeSwitch = document.getElementById('switchIconeVectoriel');
    modeSwitch.checked = false; // icône
    modeSwitch.dispatchEvent(new Event('change'));

    ol.Observable.unByKey(key);
    return {
      adds,
      mode: app.options.point.mode,
      hasSprite: !!app.options.point.sprite?.map,
      previewCount: document.querySelectorAll('#iconPreview .icon-item').length,
      iconeOptionsVisible: document.getElementById('iconeOptions').style.display !== 'none',
    };
  });

  expect(toggled.mode).toBe('icone');
  expect(toggled.hasSprite).toBe(true);
  expect(toggled.previewCount).toBeGreaterThan(0);
  expect(toggled.iconeOptionsVisible).toBe(true);
  // Le sous-menu ne redessine plus la carte de son côté : un seul redraw, celui
  // du changement de style lui-même.
  expect(toggled.adds).toBe(1);
});


test('appliquer un profil ne redessine les points qu\'une seule fois', async ({ page }) => {
  // Chaque rafraîchissement des points recrée la couche WebGL (clearMap puis
  // displayWebGLPoints) : compter les ajouts de couche mesure exactement le
  // nombre de redraws. L'ancienne version, qui déclenchait le handler de chaque
  // champ, en provoquait un par champ appliqué.
  const layerAdds = await page.evaluate(async (profile) => {
    const app = await import('/static/js/index.js');
    const layers = app.getMap().getLayers();
    let adds = 0;
    const key = layers.on('add', () => { adds += 1; });

    // Profil sans bloc carte : aucun changement de fond ne vient s'ajouter au compte.
    await window.profileManager.applyProfile(profile);

    ol.Observable.unByKey(key);
    return adds;
  }, STYLE_PROFILE);

  expect(layerAdds).toBe(1);
});
