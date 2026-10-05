import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';


async function openReadyApp(page) {
  // Le hash #style sert deux fois : initTabMemory ouvre directement l'onglet
  // Style, et la garde `!window.location.hash` d'updateDataAvailabilityUI
  // empêche le retour forcé sur l'onglet Données quand la base de test est
  // vide (comportement voulu : l'import se fait sur Données).
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // La base du runtime de test est vide : la modale de première utilisation
  // s'ouvre (de façon asynchrone) et intercepterait les clics sur les onglets.
  await dismissFirstUseModal(page);
}


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#style"]').click();
});


// « Enregistrer sous… » : les réglages affichés peuvent être enregistrés dans
// un thème nouveau (créé au passage) ou dans un thème existant — écrasement
// soumis à confirmation. Dans les deux cas la destination devient le thème
// actif (convention « Save As ») et la marque « modifications en attente »
// s'éteint.
test('"Enregistrer sous…" crée un thème ou remplace un existant après confirmation', async ({ page }) => {
  const saveAsModal = page.locator('#save-as-modal');
  const overwriteModal = page.locator('#overwrite-profile-modal');

  // Deux thèmes créés côté serveur (le runtime de test isole la
  // configuration, ces écritures ne touchent pas %APPDATA%\MyGCFlow) :
  // « SaveAs-Source » devient le thème actif, « SaveAs-Cible » la victime.
  await page.evaluate(async () => {
    const post = (name) => fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await post('SaveAs-Source');
    await post('SaveAs-Cible');

    const pm = window.profileManager;
    await pm.loadProfilesList();
    await pm.loadProfile('SaveAs-Source');

    // Modification distinctive : c'est elle qu'on relira dans le thème cible.
    const app = await import('/static/js/index.js');
    app.options.point.center.color = '#123456';
    pm.hasUnsavedChanges = true;
    pm.updateCurrentProfileIndicator();
  });

  const openSaveAs = async () => {
    await page.locator('#btn-save-profile-more').click();
    await page.locator('#btn-save-as-profile').click();
    await expect(saveAsModal).toBeVisible();
  };
  const tsInput = () => saveAsModal.locator('.ts-control input');

  // --- 1. Nom libre : un nouveau thème est créé avec les réglages affichés ---
  await openSaveAs();
  await tsInput().click();
  await tsInput().fill('SaveAs-Nouveau');
  await saveAsModal.locator('.ts-dropdown .create').click();
  await page.locator('#btn-confirm-save-as').click();
  await expect(saveAsModal).toBeHidden();

  // La modale se ferme avant la fin du PUT : hasUnsavedChanges ne s'éteint
  // qu'une fois les réglages réellement écrits (cf. _markSaved). Attendre ce
  // bascule rend l'attente sur l'écriture serveur implicite.
  await page.waitForFunction(() => window.profileManager?.hasUnsavedChanges === false);

  let state = await page.evaluate(async () => {
    const pm = window.profileManager;
    const resp = await fetch('/api/profiles/SaveAs-Nouveau');
    const prof = resp.ok ? await resp.json() : null;
    return {
      active: pm.currentProfile?.name,
      dirty: pm.hasUnsavedChanges,
      color: prof?.points?.color,
    };
  });
  expect(state.active).toBe('SaveAs-Nouveau');
  expect(state.dirty).toBe(false);
  expect(state.color).toBe('#123456');

  // --- 2. Nom déjà pris : l'écrasement est demandé, annulable ---
  await openSaveAs();
  await tsInput().click();
  await tsInput().fill('SaveAs-Cible');
  await saveAsModal.locator('.ts-dropdown .option', { hasText: 'SaveAs-Cible' }).first().click();
  // Le diagnostic annonce le remplacement dès la sélection.
  await expect(page.locator('#save-as-feedback')).toContainText('remplacés');
  await page.locator('#btn-confirm-save-as').click();

  await expect(overwriteModal).toBeVisible();
  await expect(page.locator('#overwrite-profile-message')).toContainText('SaveAs-Cible');

  // Annuler : rien n'est écrit, la modale de destination rouvre avec le choix
  // intact pour permettre de changer de nom.
  await overwriteModal.locator('.modal-footer [data-bs-dismiss="modal"]').click();
  await expect(overwriteModal).toBeHidden();
  await expect(saveAsModal).toBeVisible();
  expect(await page.evaluate(async () => {
    const resp = await fetch('/api/profiles/SaveAs-Cible');
    return (await resp.json()).points.color;
  })).not.toBe('#123456');

  // --- 3. Confirmation : le thème cible est remplacé et devient actif ---
  await page.locator('#btn-confirm-save-as').click();
  await expect(overwriteModal).toBeVisible();
  await overwriteModal.locator('#btn-confirm-overwrite').click();
  await expect(overwriteModal).toBeHidden();
  await expect(saveAsModal).toBeHidden();
  await page.waitForFunction(() => window.profileManager?.hasUnsavedChanges === false);

  state = await page.evaluate(async () => {
    const pm = window.profileManager;
    const resp = await fetch('/api/profiles/SaveAs-Cible');
    const prof = await resp.json();
    return {
      active: pm.currentProfile?.name,
      dirty: pm.hasUnsavedChanges,
      color: prof.points.color,
    };
  });
  expect(state.active).toBe('SaveAs-Cible');
  expect(state.dirty).toBe(false);
  expect(state.color).toBe('#123456');
});


test('"Enregistrer sous…" sur le thème actif équivaut à « Sauvegarder »', async ({ page }) => {
  const saveAsModal = page.locator('#save-as-modal');
  const overwriteModal = page.locator('#overwrite-profile-modal');

  await page.evaluate(async () => {
    await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SaveAs-Actif' }),
    });
    const pm = window.profileManager;
    await pm.loadProfilesList();
    await pm.loadProfile('SaveAs-Actif');
    const app = await import('/static/js/index.js');
    app.options.point.center.color = '#654321';
    pm.hasUnsavedChanges = true;
    pm.updateCurrentProfileIndicator();
  });

  await page.locator('#btn-save-profile-more').click();
  await page.locator('#btn-save-as-profile').click();
  await expect(saveAsModal).toBeVisible();

  await saveAsModal.locator('.ts-control input').click();
  await saveAsModal.locator('.ts-control input').fill('SaveAs-Actif');
  await saveAsModal.locator('.ts-dropdown .option', { hasText: 'SaveAs-Actif' }).first().click();
  await page.locator('#btn-confirm-save-as').click();

  // Sauvegarder sur soi-même n'est pas un écrasement : aucune confirmation.
  await expect(saveAsModal).toBeHidden();
  await page.waitForFunction(() => window.profileManager?.hasUnsavedChanges === false);
  await expect(overwriteModal).toBeHidden();

  const state = await page.evaluate(async () => {
    const pm = window.profileManager;
    const resp = await fetch('/api/profiles/SaveAs-Actif');
    const prof = await resp.json();
    return { active: pm.currentProfile?.name, dirty: pm.hasUnsavedChanges, color: prof.points.color };
  });
  expect(state.active).toBe('SaveAs-Actif');
  expect(state.dirty).toBe(false);
  expect(state.color).toBe('#654321');
});
