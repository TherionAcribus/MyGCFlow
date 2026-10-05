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


// Ouvre le tiroir « Gérer les thèmes » et attend que les dicts des thèmes
// soient relus et les vignettes peintes : /api/profiles ne donne que les
// noms, chaque monture .theme-thumb-mount est remplie ensuite (img raster OU
// svg de la scène vectorielle).
async function openManagerWithThumbs(page) {
  await page.locator('#btn-manage-profiles').click();
  await expect(page.locator('#profiles-manager')).toBeVisible();
  // La monture est peinte dès que le dict du thème est relu : la vignette
  // porte alors data-thumb-provider (le placeholder neutre ne l'a pas).
  await page.waitForFunction(() => {
    const mounts = document.querySelectorAll('#profiles-list .theme-thumb-mount');
    return mounts.length > 0
      && [...mounts].every(m => m.querySelector('.theme-thumb[data-thumb-provider]'));
  });
}


// Échappe une valeur pour un sélecteur d'attribut [data-profile-name="…"]
// (CSS.escape est un global navigateur, indisponible côté Node).
const cssAttrValue = (s) => String(s).replace(/["\\]/g, '\\$&');


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
  await page.locator('a[href="#style"]').click();
});


// Tiroir « Gérer les thèmes » : chaque ligne porte une vignette large (le
// tiroir est le lieu de choix visuel d'un thème), avec un fond (tuile raster
// ou scène vectorielle) — le réseau tuiles peut être coupé : on exige
// l'élément, pas son chargement.
test('la liste « Gérer les thèmes » montre une vignette large par ligne', async ({ page }) => {
  await openManagerWithThumbs(page);

  const count = await page.evaluate(() => window.profileManager.profilesList.length);
  const rows = page.locator('#profiles-list .list-group-item');
  await expect(rows).toHaveCount(count);
  await expect(rows.locator('.profile-thumb > .theme-thumb')).toHaveCount(count);

  const thumbs = await page.locator('#profiles-list .profile-thumb .theme-thumb').evaluateAll(els =>
    els.map(t => ({
      width: t.getBoundingClientRect().width,
      img: !!t.querySelector('img.theme-thumb-basemap'),
      svg: !!t.querySelector('svg.theme-thumb-vectorscene'),
      overlay: !!t.querySelector('svg.theme-thumb-overlay'),
    })));
  expect(thumbs.length).toBe(count);
  for (const t of thumbs) {
    expect(t.width).toBeGreaterThanOrEqual(90);
    expect(t.img || t.svg).toBe(true);
    expect(t.overlay).toBe(true);
  }
});


// Clic sur la vignette d'un thème non actif : le thème se charge (sélecteur +
// toast) et le liseré actif se déplace sur sa ligne.
test('clic sur la vignette charge le thème et déplace le marquage actif', async ({ page }) => {
  await openManagerWithThumbs(page);

  const target = await page.evaluate(async () => {
    const pm = window.profileManager;
    if (pm.profilesList.length < 2) {
      await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Thumb-Second' }),
      });
      await pm.loadProfilesList();
      await pm._refreshThumbs();
    }
    const name = pm.profilesList.find(n => n !== pm.currentProfile?.name) || null;
    return name && { name };
  });
  test.skip(!target, 'Un seul thème disponible et sa création a échoué');

  const row = page.locator(`#profiles-list .list-group-item[data-profile-name="${cssAttrValue(target.name)}"]`);
  await expect(row).not.toHaveClass(/active-profile-item/);
  await row.locator('.profile-thumb').click();

  // Le thème chargé devient la valeur du sélecteur compact, le toast confirme.
  await expect(page.locator('#profile-select')).toHaveValue(target.name);
  await expect(page.locator('.gcm-toast-message', { hasText: 'chargé' })).toHaveCount(1);
  await expect(row).toHaveClass(/active-profile-item/);
});


// La ligne du thème actif porte .active-profile-item (liseré d'accent).
test('la ligne du thème actif porte le marquage actif', async ({ page }) => {
  await openManagerWithThumbs(page);
  const activeName = await page.evaluate(() => window.profileManager.currentProfile?.name || null);
  test.skip(!activeName, 'Aucun thème actif dans le runtime de test');

  const row = page.locator(`#profiles-list .list-group-item[data-profile-name="${cssAttrValue(activeName)}"]`);
  await expect(row).toHaveClass(/active-profile-item/);
  await expect(row.locator('.profile-name-wrap')).toHaveAttribute('aria-current', 'true');
});


// Tuiles injoignables (réseau coupé) : l'img tombe en erreur et laisse un
// fond neutre — la vignette et sa surcouche restent correctes.
test('tuiles bloquées : repli couleur sans casser la vignette', async ({ page }) => {
  await page.route('**://tile.openstreetmap.org/**', r => r.abort());
  await page.route('**://tiles.stadiamaps.com/**', r => r.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#style"]').click();
  await page.locator('#btn-manage-profiles').click();

  // Au moins un thème raster existe dans le runtime (Default = OSM) : son
  // image échoue et le marqueur de repli est posé.
  await page.waitForFunction(() => {
    const thumbs = document.querySelectorAll('#profiles-list .theme-thumb--fallback');
    return thumbs.length >= 1;
  });
  // La surcouche reste présente sur les vignettes en repli.
  const overlays = await page.locator('#profiles-list .theme-thumb--fallback svg.theme-thumb-overlay').count();
  expect(overlays).toBeGreaterThan(0);
});
