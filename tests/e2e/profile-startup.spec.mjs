import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';


async function openReadyApp(page) {
  // Le hash #style évite le retour forcé sur l'onglet Données quand la base de
  // test est vide (garde `!window.location.hash` d'updateDataAvailabilityUI).
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}


// mygcflowReady est posé après restoreStartupProfile() : au retour de
// goto(), le thème restauré est déjà celui du démarrage.
async function activeProfileName(page) {
  return page.evaluate(() => window.profileManager?.currentProfile?.name || null);
}


async function appSettings(page) {
  return page.evaluate(async () => (await fetch('/api/settings')).json());
}


// « Toujours démarrer sur ce thème » (onglet Paramètres) : décoché (défaut),
// le démarrage rouvre le dernier thème utilisé ; coché, le thème choisi dans
// le sélecteur passe d'abord. Coché sans thème choisi, c'est le thème actif
// qui devient le choix ; un choix déjà enregistré est réutilisé tel quel.
test('l\'option « Toujours démarrer sur ce thème » pilote la restauration au démarrage', async ({ page }) => {
  await openReadyApp(page);

  // Le runtime de test installe un thème « Default » déjà désigné par défaut :
  // pour observer la branche « aucun thème choisi », on le désaffecte d'abord.
  await page.evaluate(async () => {
    const post = (name) => fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await post('Startup-Fixe');
    await post('Startup-Dernier');

    const pm = window.profileManager;
    await pm.loadProfilesList();
    await pm.saveAppSettings({ default_profile_uid: null });
    pm._defaultProfileName = ''; // cache local à l'unisson du serveur
    await pm.loadProfile('Startup-Fixe');
  });
  expect(await activeProfileName(page)).toBe('Startup-Fixe');

  // --- 1. Coché sans thème sélectionné : le thème actif devient le choix ---
  // (même route qu'un clic : le handler écoute 'change').
  await page.evaluate(() => {
    const sw = document.getElementById('switchStartupDefaultProfile');
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
  });

  // La sauvegarde est silencieuse (indicateur inline) : le flag serveur et
  // l'uid du thème choisi confirment que l'écriture a abouti.
  await page.waitForFunction(async () => {
    const s = await (await fetch('/api/settings')).json();
    return s.startup_default_profile === true && !!s.default_profile_uid;
  });
  expect((await appSettings(page)).default_profile_name).toBe('Startup-Fixe');
  // Le sélecteur reflète le thème retenu, pas « Aucun ».
  expect(await page.evaluate(() => document.getElementById('selectDefaultProfile').value)).toBe('Startup-Fixe');

  // Basculer sur un autre thème : le dernier utilisé devient Startup-Dernier,
  // mais l'option impose le choix fixe au prochain démarrage.
  await page.evaluate(() => window.profileManager.loadProfile('Startup-Dernier'));
  expect(await activeProfileName(page)).toBe('Startup-Dernier');

  await openReadyApp(page);
  expect(await activeProfileName(page)).toBe('Startup-Fixe');
  // L'interrupteur est relu coché au démarrage.
  expect(await page.evaluate(() => document.getElementById('switchStartupDefaultProfile').checked)).toBe(true);

  // --- 2. Décoché : le dernier thème utilisé reprend la main ---
  await page.evaluate(() => {
    const sw = document.getElementById('switchStartupDefaultProfile');
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(async () =>
    (await fetch('/api/settings')).json().then(s => s.startup_default_profile === false));

  // Le choix de thème n'est pas effacé : il resservira si l'option est recochée.
  expect((await appSettings(page)).default_profile_name).toBe('Startup-Fixe');

  // Le dernier thème utilisé est Startup-Fixe (restauré au chargement
  // précédent) : décochée, l'option laisse le démarrage sur ce même thème.
  // Charger Startup-Dernier rend la distinction lisible au rechargement.
  await page.evaluate(() => window.profileManager.loadProfile('Startup-Dernier'));

  await openReadyApp(page);
  expect(await activeProfileName(page)).toBe('Startup-Dernier');
  expect(await page.evaluate(() => document.getElementById('switchStartupDefaultProfile').checked)).toBe(false);

  // --- 3. Recoché avec un choix déjà enregistré : celui-ci est réutilisé,
  //        le thème actif (Startup-Dernier) ne l'écrase pas ---
  await page.evaluate(() => {
    const sw = document.getElementById('switchStartupDefaultProfile');
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(async () =>
    (await fetch('/api/settings')).json().then(s => s.startup_default_profile === true));
  expect((await appSettings(page)).default_profile_name).toBe('Startup-Fixe');

  await openReadyApp(page);
  expect(await activeProfileName(page)).toBe('Startup-Fixe');
});
