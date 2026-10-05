import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

// Thèmes séparés par mode : chaque page (« Mes trouvailles » / « Évolution »)
// ne liste que ses thèmes, mémorise son propre thème actif, et un thème passe
// de l'une à l'autre par copie — tailles ramenées à la densité du mode visé.

// Le hash #style ouvre l'onglet Style et empêche le retour forcé sur l'onglet
// Données quand la base de test est vide (cf. AGENTS.md).
async function openMain(page) {
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function openEvolution(page) {
  await page.goto('/evolution#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
}

const listedThemes = (page) => page.evaluate(() => [...window.profileManager.profilesList]);

async function deleteThemes(page, names) {
  await page.evaluate(async (list) => {
    for (const name of list) {
      await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
  }, names);
}

test('chaque mode ne liste que ses thèmes et démarre sur l\'un des siens', async ({ page }) => {
  await openMain(page);
  const mainThemes = await listedThemes(page);
  expect(mainThemes).toContain('Default');
  expect(mainThemes).not.toContain('Évolution Classique');
  await expect(page.locator('#profile-select option', { hasText: 'Évolution Classique' })).toHaveCount(0);

  await openEvolution(page);
  const evolutionThemes = await listedThemes(page);
  expect(evolutionThemes).toContain('Évolution Classique');
  expect(evolutionThemes).not.toContain('Default');
  await expect(page.locator('#profile-select option', { hasText: 'Default' })).toHaveCount(0);

  // La page démarre sur SON thème par défaut, pas sur celui du mode principal.
  // Les références sont posées ici : une autre spec du même runtime peut avoir
  // réinitialisé les préférences (elles sont rétablies en fin de test).
  const previous = await page.evaluate(async () => {
    const settings = await (await fetch('/api/settings')).json();
    const theme = await (await fetch(`/api/profiles/${encodeURIComponent('Évolution Classique')}`)).json();
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evolution_default_profile_uid: theme.uid, evolution_last_profile_uid: null }),
    });
    return {
      evolution_default_profile_uid: settings.evolution_default_profile_uid,
      evolution_last_profile_uid: settings.evolution_last_profile_uid,
    };
  });

  // Rechargement explicite : un goto vers la même URL à hash ne recharge pas.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true && window.mygcflowEvolutionLoaded === true);
  expect(await page.evaluate(() => window.profileManager.currentProfile?.name)).toBe('Évolution Classique');
  expect(await page.evaluate(() => window.profileManager.currentProfile?.mode)).toBe('evolution');

  await page.evaluate((patch) => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }), previous);
});

test('un thème se copie vers l\'autre mode, et chaque mode garde son thème actif', async ({ page }) => {
  const source = 'Modes-Source';
  const copy = 'Modes-Source_Évolution';

  await openMain(page);
  const previousMain = await page.evaluate(() => window.profileManager.currentProfile?.name ?? null);
  // « Toujours démarrer sur ce thème » ferait passer le thème par défaut avant
  // le dernier actif : une autre spec du même runtime peut l'avoir laissé coché.
  const startOnDefault = await page.evaluate(async () => {
    const settings = await (await fetch('/api/settings')).json();
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startup_default_profile: false }),
    });
    return settings.startup_default_profile === true;
  });
  await page.evaluate(async (name) => {
    await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await window.profileManager.loadProfilesList();
    // Thème actif du mode principal : celui qu'il devra retrouver plus bas.
    await window.profileManager.loadProfile(name, { quiet: true });
  }, source);

  // --- Copie depuis le menu « … » de la ligne du thème ---
  await page.locator('#btn-manage-profiles').click();
  const row = page.locator(`#profiles-list [data-profile-name="${source}"]`);
  await row.locator('.dropdown-toggle').click();
  await row.locator('.dropdown-item:has(.ti-arrows-exchange)').click();

  const modal = page.locator('#profile-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#profile-name-input')).toHaveValue(copy);
  await page.locator('#btn-confirm-profile').click();
  await expect(modal).toBeHidden();

  // La copie est connue (son nom est pris) sans rejoindre la liste de la page.
  await page.waitForFunction((name) => window.profileManager._otherModeNames.includes(name), copy);
  expect(await listedThemes(page)).not.toContain(copy);

  // --- Côté Évolution : la copie est listée, à l'échelle du mode ---
  await openEvolution(page);
  const previousEvolution = await page.evaluate(() => window.profileManager.currentProfile?.name ?? null);
  expect(await listedThemes(page)).toContain(copy);
  expect(await listedThemes(page)).not.toContain(source);

  const pointSize = await page.evaluate(async (name) => {
    await window.profileManager.loadProfile(name, { quiet: true });
    const app = await import('/static/js/index.js');
    return app.options.point.center.size;
  }, copy);
  // 8 px (défaut du mode principal) ramenés à 2 px.
  expect(pointSize).toBe(2);

  // --- Chaque mode retrouve SON dernier thème actif ---
  await openMain(page);
  const mainActive = await page.evaluate(() => window.profileManager.currentProfile);
  expect(mainActive?.mode).toBe('main');
  expect(mainActive?.name).toBe(source);

  await openEvolution(page);
  expect(await page.evaluate(() => window.profileManager.currentProfile?.name)).toBe(copy);

  // --- Un nom pris dans l'autre mode est refusé à la création ---
  await page.locator('#btn-manage-profiles').click();
  await page.locator('#btn-new-profile').click();
  await expect(modal).toBeVisible();
  await page.locator('#profile-name-input').fill(source);
  await expect(page.locator('#btn-confirm-profile')).toBeDisabled();
  await expect(page.locator('#profile-name-feedback')).toBeVisible();
  await modal.locator('[data-bs-dismiss="modal"]').first().click();
  await expect(modal).toBeHidden();

  // Nettoyage : les autres specs partagent ce runtime.
  if (previousEvolution) {
    await page.evaluate((name) => window.profileManager.loadProfile(name, { quiet: true }), previousEvolution);
  }
  await deleteThemes(page, [source, copy]);
  await page.evaluate((value) => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startup_default_profile: value }),
  }), startOnDefault);
  if (previousMain) {
    await openMain(page);
    await page.evaluate((name) => window.profileManager.loadProfile(name, { quiet: true }), previousMain);
  }
});
