import { expect, test } from '@playwright/test';


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // La base du runtime de test est vide : la modale de première utilisation
  // s'ouvre (de façon asynchrone) et intercepterait les clics sur les onglets.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}


// Profil complet côté style (points, flash, infos), sans bloc carte :
// les tests de fond de carte vivent dans map-source-of-truth.spec.mjs.
// Les clés legacy `animation` et `flash.duration` restent volontairement dans
// la fixture : un ancien thème doit rester chargeable, mais ces valeurs sont
// ignorées à l'application (le timing est une préférence globale).
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
    const app = await import('/static/js/index.js');
    // État temporel distinctif AVANT l'application : un thème ne doit jamais
    // modifier rythme, mode, dates, temps additionnel, suivi de caméra ou
    // durée de flash — ce sont des préférences globales, pas du style.
    app.options.animation.daysPerSecond = 7;
    app.options.animation.timePerDay = 1000 / 7;
    app.options.animation.rhythmMode = 'duration';
    app.options.animation.totalDurationSeconds = 42;
    app.options.animation.extraEndSeconds = 6;
    app.options.animation.cameraFollow = true;
    app.options.animation.dateStart = new Date(2026, 0, 5);
    app.options.animation.dateEnd = new Date(2026, 0, 20);
    app.options.flash.duration = 2600;

    const beforeTiming = {
      animation: JSON.parse(JSON.stringify(app.options.animation)),
      flashDuration: app.options.flash.duration,
      view: {
        center: app.getMap().getView().getCenter(),
        zoom: app.getMap().getView().getZoom(),
      },
    };

    await window.profileManager.applyProfile(profile);

    return {
      beforeTiming,
      point: JSON.parse(JSON.stringify(app.options.point)),
      animation: JSON.parse(JSON.stringify(app.options.animation)),
      flash: JSON.parse(JSON.stringify(app.options.flash)),
      infos: JSON.parse(JSON.stringify(app.options.infos)),
      view: {
        center: app.getMap().getView().getCenter(),
        zoom: app.getMap().getView().getZoom(),
      },
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
        flashMode: document.getElementById('selectFlashMode').value,
        // inputTimeFlash reflète la préférence globale, pas le 1500 du thème.
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

  // 0. Isolation : ni le timing ni la vue n'ont bougé, malgré les clés
  // legacy animation/flash.duration présentes dans le fichier.
  expect(applied.animation).toEqual(applied.beforeTiming.animation);
  expect(applied.flash.duration).toBe(2600);
  expect(applied.view).toEqual(applied.beforeTiming.view);

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
  expect(applied.flash).toMatchObject({
    mode: 'star', size: 60, color: '#00ff00', color_type: 'gc',
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
    flashMode: 'star',
    flashDuration: '2600',
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
  // Le flash relu ne porte plus de `duration` : c'est un réglage temporel,
  // sauvegardé dans les préférences globales et pas dans le thème.
  const { duration: _dropped, ...flashSansDuree } = STYLE_PROFILE.flash;
  expect(reread.flash).toMatchObject(flashSansDuree);
  expect(reread.flash).not.toHaveProperty('duration');
  // Aucun bloc `animation` dans un thème sauvegardé : le timing est global.
  expect(reread).not.toHaveProperty('animation');
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


test('les réglages pilotés par un bouton signalent aussi des modifications', async ({ page }) => {
  // Le fond de carte et la variante Toner se choisissent au clic sur un bouton,
  // pas dans un champ de formulaire : ils n'émettent ni 'input' ni 'change'.
  // Le suivi n'écoutait que ces deux événements, si bien qu'un changement de
  // carte partait bien dans le profil enregistré mais n'était jamais signalé
  // comme en attente — l'utilisateur pouvait le perdre sans avertissement.
  const indicator = page.locator('#current-profile-indicator');

  const initialProvider = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Suivi', uid: 'suivi', version: '1.0' };
    pm._markSaved();
    return app.options.map.default;
  });

  await expect(indicator).not.toHaveClass(/unsaved/);

  const other = initialProvider === 'OSM' ? 'watercolor' : 'OSM';
  await page.locator(`#tabMapOverlay #${other}`).click();
  await expect(indicator).toHaveClass(/unsaved/);

  // Comme pour les champs, revenir au fond enregistré doit éteindre l'indicateur.
  await page.locator(`#tabMapOverlay #${initialProvider}`).click();
  await expect(indicator).not.toHaveClass(/unsaved/);

  // Les clics du panneau Profils sont ignorés : ils ne touchent aucun réglage de
  // style et ne doivent pas programmer de recalcul concurrent d'une sauvegarde.
  await page.evaluate(() => {
    const pm = window.profileManager;
    window.__recomputes = 0;
    pm._recomputeDirtyState = () => { window.__recomputes += 1; };
    // La sauvegarde réelle écrirait un profil sur le disque : seul le clic nous
    // intéresse ici.
    pm.saveCurrentAsProfile = async () => true;
    document.getElementById('btn-save-profile').click();
  });
  await page.waitForTimeout(600); // au-delà du debounce de 300 ms
  expect(await page.evaluate(() => window.__recomputes)).toBe(0);
});


test('les modifications non enregistrées passent par une modale à trois issues', async ({ page }) => {
  // Un window.confirm() natif serait rejeté par Playwright (aucun handler de
  // dialogue) : ce test échouerait sur l'attente de la modale. On surveille tout
  // de même l'apparition d'un dialogue natif pour que la régression soit lisible.
  const nativeDialogs = [];
  page.on('dialog', (dialog) => { nativeDialogs.push(dialog.message()); dialog.dismiss(); });

  const modal = page.locator('#unsaved-changes-modal');

  // La sauvegarde est remplacée par un espion : les profils vivent dans
  // %APPDATA%\MyGCFlow, que le runtime isolé des tests ne couvre pas (un vrai
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
  // "profil par défaut" vivent dans %APPDATA%\MyGCFlow, que le runtime isolé des
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
  await expect(marker('Alpha', '.active-profile')).toHaveCount(0);
  await expect(marker('Beta', '.active-profile')).toHaveCount(1);
  await expect(marker('Beta', '.profile-default-star')).toHaveCount(0);
  // Le liseré de ligne est porté par l'élément de liste lui-même, posé dès le
  // rendu initial (et pas seulement lors d'un changement de profil actif).
  await expect(page.locator('#profiles-list .active-profile-item')).toHaveCount(1);
  await expect(page.locator('#profiles-list [data-profile-name="Beta"].active-profile-item')).toHaveCount(1);

  // Même profil : l'étoile doit coexister avec le marquage "actif".
  await render('Beta', 'Beta');
  await expect(marker('Beta', '.profile-default-star')).toHaveCount(1);
  await expect(marker('Beta', '.active-profile')).toHaveCount(1);
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

  // Déplacer le marquage "actif" ne doit pas emporter l'étoile : les deux
  // marquages sont indépendants et rafraîchis séparément.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.currentProfile = { name: 'Alpha', uid: 'Alpha' };
    pm._updateActiveProfileHighlight();
  });
  await expect(marker('Alpha', '.active-profile')).toHaveCount(1);
  await expect(marker('Alpha', '.profile-default-star')).toHaveCount(1);
  // Le liseré suit : une seule ligne marquée, et c'est la bonne.
  await expect(page.locator('#profiles-list [data-profile-name="Alpha"].active-profile-item')).toHaveCount(1);
  await expect(page.locator('#profiles-list .active-profile-item')).toHaveCount(1);
});


test('créer un profil y enregistre les réglages affichés', async ({ page }) => {
  // Le bug d'origine : POST /api/profiles écrit un profil aux VALEURS PAR
  // DÉFAUT. Sans le PUT qui suit, le profil créé était vide alors que l'écran
  // affichait toujours les réglages de l'utilisateur, présentés comme
  // enregistrés — le travail était perdu au rechargement suivant.
  // Serveur simulé : les profils vivent dans %APPDATA%\MyGCFlow, hors du runtime
  // isolé des tests.
  let savedBody = null;
  const settingsPatches = [];
  await page.route('**/api/profiles', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: route.request().method() === 'POST'
      ? JSON.stringify({ success: true, name: 'Nouveau', uid: 'uid-nouveau', version: 2 })
      : JSON.stringify(['Nouveau']),
  }));
  await page.route('**/api/profiles/Nouveau', route => {
    savedBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'PUT') settingsPatches.push(route.request().postDataJSON());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  const state = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    // Deux réglages reconnaissables, l'un de points l'autre de flash, pour que
    // le contenu envoyé ne puisse pas être confondu avec des valeurs par défaut.
    app.options.point.center.size = 9;
    app.options.flash.color = '#123456';

    const pm = window.profileManager;
    pm.profilesList = [];
    pm.currentProfile = null;

    const created = await pm.createProfile('Nouveau');
    return { created, currentProfile: pm.currentProfile, dirty: pm.hasUnsavedChanges };
  });

  expect(state.created).toBe(true);
  // L'uid vient du serveur : sans lui, le profil créé ne peut ni être mémorisé
  // comme dernier profil actif ni être rechargé.
  expect(state.currentProfile).toMatchObject({ name: 'Nouveau', uid: 'uid-nouveau', version: 2 });

  expect(savedBody).not.toBeNull();
  expect(savedBody.points.size).toBe(9);
  expect(savedBody.flash.color).toBe('#123456');

  // Le profil est à jour : aucune modification en attente ne doit être signalée.
  expect(state.dirty).toBe(false);

  // ...et c'est lui que le prochain démarrage restaurera.
  expect(settingsPatches).toContainEqual({ last_profile_uid: 'uid-nouveau' });

  await expect(page.locator('.gcm-toast-message', { hasText: 'Profil "Nouveau" créé' })).toHaveCount(1);
});


test('le démarrage restaure le dernier profil actif', async ({ page }) => {
  // Réponses serveur simulées (cf. ci-dessus). Le profil par défaut est un AUTRE
  // profil : c'est le dernier profil utilisé qui doit revenir, sans quoi le
  // travail enregistré juste avant la fermeture réapparaît sous les réglages
  // d'un profil sans rapport.
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      last_profile_uid: 'uid-dernier',
      last_profile_name: 'Dernier',
      default_profile_uid: 'uid-defaut',
      default_profile_name: 'Défaut',
    }),
  }));
  await page.route('**/api/profiles/uid/*', route => {
    const name = route.request().url().endsWith('uid-dernier') ? 'Dernier' : 'Défaut';
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...STYLE_PROFILE, name, uid: `uid-${name === 'Dernier' ? 'dernier' : 'defaut'}` }),
    });
  });

  const active = await page.evaluate(async () => {
    await window.profileManager.restoreStartupProfile();
    return window.profileManager.currentProfile?.name;
  });

  expect(active).toBe('Dernier');
});


test('le profil par défaut sert de repli quand le dernier profil actif est illisible', async ({ page }) => {
  const settingsPatches = [];
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'PUT') {
      settingsPatches.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        last_profile_uid: 'uid-fantome',
        default_profile_uid: 'uid-defaut',
        default_profile_name: 'Défaut',
      }),
    });
  });
  await page.route('**/api/profiles/uid/*', route => {
    if (route.request().url().endsWith('uid-fantome')) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Profile not found' }),
      });
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...STYLE_PROFILE, name: 'Défaut', uid: 'uid-defaut' }),
    });
  });

  const active = await page.evaluate(async () => {
    await window.profileManager.restoreStartupProfile();
    return window.profileManager.currentProfile?.name;
  });

  expect(active).toBe('Défaut');
  // Le repli est mémorisé : sans cela, chaque démarrage repasserait par la
  // lecture ratée du profil disparu.
  expect(settingsPatches).toContainEqual({ last_profile_uid: 'uid-defaut' });
});


test('un profil de démarrage illisible laisse l\'application sans profil actif', async ({ page }) => {
  // Réponses serveur simulées : les profils et le réglage "profil par défaut"
  // vivent dans %APPDATA%\MyGCFlow, hors du runtime isolé des tests.
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_profile_uid: 'uid-fantome', default_profile_name: 'Fantôme' }),
  }));
  // Le profil pointé par le réglage ne répond pas : c'est l'échec de démarrage
  // qui produisait auparavant un pseudo-profil "temp-<timestamp>", actif à
  // l'écran mais absent de la liste et impossible à enregistrer.
  await page.route('**/api/profiles/uid/*', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Profile not found' }),
  }));

  const state = await page.evaluate(async () => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha'];
    pm.currentProfile = { name: 'Alpha', uid: 'Alpha' };
    pm.renderProfilesList();

    const indicator = document.getElementById('current-profile-indicator');
    const before = { indicator: indicator.textContent, marked: document.querySelectorAll('#profiles-list .active-profile').length };

    await pm.restoreStartupProfile();

    return {
      before,
      currentProfile: pm.currentProfile,
      hasUnsavedChanges: pm.hasUnsavedChanges,
      indicator: indicator.textContent,
      marked: document.querySelectorAll('#profiles-list .active-profile').length,
    };
  });

  // Le point de départ : un profil bien actif, pour que l'état d'arrivée ne
  // puisse pas être confondu avec "rien n'a jamais été affiché".
  expect(state.before).toEqual({ indicator: 'Alpha', marked: 1 });

  // L'arrivée : aucun profil actif, ni réel ni inventé.
  expect(state.currentProfile).toBeNull();
  expect(state.hasUnsavedChanges).toBe(false);
  expect(state.indicator).toBe('');
  expect(state.marked).toBe(0);

  // ...et l'utilisateur le sait, par un seul message (le toast d'erreur générique
  // de loadProfileByUid est tu au profit de celui qui décrit l'état).
  await expect(page.locator('.gcm-toast-message', { hasText: 'aucun profil n\'est actif' })).toHaveCount(1);
  await expect(page.locator('.gcm-toast-message', { hasText: 'Erreur lors du chargement du profil' })).toHaveCount(0);
});


test('le sélecteur compact charge le profil choisi et « Gérer » ouvre la liste', async ({ page }) => {
  // La barre de profil remplace l'ancien panneau latéral : sélecteur compact,
  // Sauvegarder et « Gérer les profils » — la liste complète vit dans la modale.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha', 'Beta'];
    pm.currentProfile = { name: 'Alpha', uid: 'a', version: '1.0' };
    pm._defaultProfileName = 'Beta';
    pm.renderProfilesList();
    pm.updateCurrentProfileIndicator();
  });

  const select = page.locator('#profile-select');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('Alpha');
  // L'étoile du profil par défaut figure dans les options du sélecteur.
  await expect(select.locator('option[value="Beta"]')).toHaveText('★ Beta');

  // Choisir un profil dans le sélecteur passe par loadProfile() — la garde
  // « modifications non enregistrées » s'applique donc aussi ici.
  await page.evaluate(() => {
    window.__loads = [];
    window.profileManager.loadProfile = async (name) => { window.__loads.push(name); return true; };
  });
  await select.selectOption('Beta');
  expect(await page.evaluate(() => window.__loads)).toEqual(['Beta']);

  // « • » accolé au nom du profil actif quand des modifications attendent,
  // et un chargement refusé (choix « Annuler » sur la modale) rétablit
  // l'option du profil toujours actif.
  await page.evaluate(() => {
    const pm = window.profileManager;
    delete pm.loadProfile;  // l'espion rend la place à la méthode réelle
    pm.hasUnsavedChanges = true;
    pm.updateCurrentProfileIndicator();
  });
  await expect(select.locator('option[value="Alpha"]')).toHaveText('Alpha •');

  await select.selectOption('Beta');
  const unsaved = page.locator('#unsaved-changes-modal');
  await expect(unsaved).toBeVisible();
  await unsaved.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(unsaved).toBeHidden();
  await expect(select).toHaveValue('Alpha');

  // « Gérer les thèmes » déplie le tiroir qui héberge la liste complète, et
  // le replie au second clic.
  const toggle = page.locator('#btn-manage-profiles');
  const manager = page.locator('#profiles-manager');
  await toggle.click();
  await expect(manager).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#profiles-manager #profiles-list [data-profile-name="Beta"]')).toBeVisible();
  await toggle.click();
  await expect(manager).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Échap et la croix le replient aussi.
  await toggle.click();
  await page.locator('#btn-close-profiles-manager').press('Escape');
  await expect(manager).toBeHidden();
  await toggle.click();
  await page.locator('#btn-close-profiles-manager').click();
  await expect(manager).toBeHidden();
});


test('une sous-modale ouverte depuis la gestion laisse le tiroir ouvert', async ({ page }) => {
  // Le tiroir n'est pas une modale : les sous-modales s'ouvrent par-dessus
  // et, refermées, l'utilisateur retrouve la liste là où il l'avait laissée.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha', 'Beta'];
    pm.currentProfile = { name: 'Alpha', uid: 'a', version: '1.0' };
    pm.hasUnsavedChanges = true;
    pm.saveCurrentAsProfile = async () => true;
    pm.renderProfilesList();
    pm.updateCurrentProfileIndicator();
  });

  const manager = page.locator('#profiles-manager');
  await page.locator('#btn-manage-profiles').click();
  await expect(manager).toBeVisible();

  // Charger « Beta » depuis la liste avec des modifications en attente : la
  // modale à trois issues prend le premier plan.
  const unsaved = page.locator('#unsaved-changes-modal');
  await page.locator('#profiles-list [data-profile-name="Beta"] .profile-name-wrap').click();
  await expect(unsaved).toBeVisible();

  // Annuler ramène sur le tiroir, toujours ouvert.
  await unsaved.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(unsaved).toBeHidden();
  await expect(manager).toBeVisible();
});


test('dupliquer passe par la modale de nom pré-remplie', async ({ page }) => {
  // Liste posée en mémoire et duplication espionnée : les profils vivent dans
  // %APPDATA%\MyGCFlow, hors du runtime isolé des tests (cf. l'étoile "par défaut").
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.profilesList = ['Alpha', 'Alpha_copy', 'Beta'];
    pm.currentProfile = null;
    window.__duplicated = [];
    pm.duplicateProfile = async (original, newName) => { window.__duplicated.push([original, newName]); };
    pm.renderProfilesList();
  });

  // La liste vit dans le tiroir de gestion : il doit être déplié pour que les
  // menus « … » de ses lignes soient cliquables. Les sous-modales (ici celle
  // du nom de la copie) s'ouvrent par-dessus sans le refermer.
  const manager = page.locator('#profiles-manager');
  await page.locator('#btn-manage-profiles').click();
  await expect(manager).toBeVisible();

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

  // 2. Annuler ne duplique rien. La sous-modale refermée, la gestion revient.
  await modal.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(modal).toBeHidden();
  await expect(manager).toBeVisible();
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
  await expect(manager).toBeVisible();
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


test('la modale de nom valide la saisie avant l\'envoi au serveur', async ({ page }) => {
  // Liste posée en mémoire et actions espionnées : les profils vivent dans
  // %APPDATA%\MyGCFlow, hors du runtime isolé des tests.
  await page.evaluate(() => {
    const pm = window.profileManager;
    pm.profilesList = ['Mon Profil', 'Beta'];
    pm.currentProfile = null;
    window.__created = [];
    pm.createProfile = async (name) => { window.__created.push(name); };
    pm.duplicateProfile = async () => {};
    pm.renameProfileProperly = async () => {};
  });

  const modal = page.locator('#profile-modal');
  const input = page.locator('#profile-name-input');
  const feedback = page.locator('#profile-name-feedback');
  const confirmBtn = page.locator('#btn-confirm-profile');

  await page.evaluate(() => window.profileManager.showNewProfileModal());
  await expect(modal).toBeVisible();

  // Champ vide : rien à reprocher, mais rien à créer non plus.
  await expect(confirmBtn).toBeDisabled();
  await expect(feedback).toBeHidden();

  // 1. Collision invisible : "MonProfil" et "Mon Profil" partagent le fichier
  // "MonProfil.json". C'est le cas que le serveur ne signalait qu'en 409.
  await input.fill('MonProfil');
  await expect(confirmBtn).toBeDisabled();
  await expect(input).toHaveClass(/is-invalid/);
  await expect(feedback).toContainText('Mon Profil');

  // 2. Collision franche : le message nomme simplement le doublon.
  await input.fill('Beta');
  await expect(confirmBtn).toBeDisabled();
  await expect(feedback).toContainText('Beta');

  // 3. Nom qui ne laisse aucun caractère utilisable : refusé côté client aussi,
  // sinon il retomberait sur le fichier générique du serveur.
  await input.fill('!!! ???');
  await expect(confirmBtn).toBeDisabled();
  await expect(feedback).toContainText('lettre');

  // 4. Caractères ignorés sans collision : simple avertissement, la création
  // reste possible et le nom de fichier retenu est annoncé.
  await input.fill('Été 2026 !');
  await expect(confirmBtn).toBeEnabled();
  await expect(input).not.toHaveClass(/is-invalid/);
  await expect(feedback).toContainText('Été2026');

  // 5. Nom sain : aucun message, création transmise telle quelle.
  await input.fill('Gamma');
  await expect(confirmBtn).toBeEnabled();
  await expect(feedback).toBeHidden();
  await confirmBtn.click();
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => window.__created)).toEqual(['Gamma']);

  // 6. Renommer vers un nom qui retombe sur le fichier du profil lui-même est un
  // renommage cosmétique légitime : la collision ne doit pas être signalée.
  await page.evaluate(() => window.profileManager.renameProfile('Mon Profil'));
  await expect(modal).toBeVisible();
  await input.fill('MonProfil');
  await expect(confirmBtn).toBeEnabled();
  await expect(feedback).toBeHidden();
  await modal.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(modal).toBeHidden();

  // 7. Dupliquer : le serveur résout seul la collision en suffixant, on annonce
  // le nom retenu plutôt que de bloquer la saisie.
  await page.evaluate(() => window.profileManager.showDuplicateProfileModal('Beta'));
  await expect(modal).toBeVisible();
  await input.fill('Mon Profil');
  await expect(confirmBtn).toBeEnabled();
  await expect(feedback).toContainText('Mon Profil (1)');
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
