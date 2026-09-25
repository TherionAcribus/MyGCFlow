// Filtres compacts : le contrôle fermé n'affiche que le résumé
// (« Tout (n) », « n / total », « Aucun ») ; les actions Tout/Aucun vivent dans
// le menu déroulant ; la liste des noms sélectionnés reste accessible en
// tooltip sur le contrôle fermé pour une sélection partielle.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
}

async function dismissFirstUseModal(page) {
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }
}

async function importFixture(page) {
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
}

const typeControl = page => page.locator('#selectType').evaluate(el => {
  const c = el.tomselect.control;
  return { summary: c.dataset.summary, title: c.title };
});

test('filtres compacts : résumé fermé, actions dans le dropdown, tooltip des noms', async ({ page, request }) => {
  // Runtime partagé : repartir d'une base vide puis importer le fixture rend
  // le test indépendant de l'ordre d'exécution des specs.
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);
  await importFixture(page);

  // Fermé : seul le résumé est visible — aucune ligne d'actions sous le champ,
  // aucune pastille d'information. Les actions ont été déplacées dans le
  // menu déroulant de chaque filtre.
  for (const sel of ['Type', 'Container', 'Difficulty', 'Terrain', 'Country', 'State']) {
    const field = page.locator(`.filter-field:has(#select${sel})`);
    await expect(field.locator(':scope > .filter-actions')).toBeHidden();
    await expect(field.locator('.ts-dropdown .filter-actions')).toBeAttached();
    await expect(field.locator('.filter-info-badge')).toHaveCount(0);
  }
  expect((await typeControl(page)).summary).toBe('Tout (16)');

  // Ouvert : les actions Tout/Aucun apparaissent dans la zone de recherche
  // du dropdown ; « Tout » est inerte puisque tout est déjà sélectionné.
  await page.locator('#selectType').evaluate(el => el.tomselect.open());
  const dropdown = page.locator('.filter-field:has(#selectType) .ts-dropdown');
  await expect(dropdown.locator('#btnAllType')).toBeVisible();
  await expect(dropdown.locator('#btnNoneType')).toBeVisible();
  await expect(dropdown.locator('#btnAllType')).toHaveClass(/filter-btn-disabled/);

  // « Aucun » vide la sélection ; le résumé reflète l'état et le bouton se grise.
  await dropdown.locator('#btnNoneType').click();
  expect((await typeControl(page)).summary).toBe('Aucun');
  await expect(dropdown.locator('#btnNoneType')).toHaveClass(/filter-btn-disabled/);
  await expect(page.locator('#filtersCounter')).toContainText('0 /', { timeout: 15_000 });

  // « Tout » resélectionne tout depuis le dropdown toujours ouvert.
  await dropdown.locator('#btnAllType').click();
  expect((await typeControl(page)).summary).toBe('Tout (16)');
  await expect(dropdown.locator('#btnAllType')).toHaveClass(/filter-btn-disabled/);

  // Sélection partielle : le résumé passe au compteur et le tooltip liste
  // les noms des options restantes. La mise à jour passe par le debounce de
  // sélection (~250 ms) : on poll jusqu'à ce que le résumé bascule.
  await page.locator('#selectType').evaluate(el => {
    const ts = el.tomselect;
    ts.removeItem(ts.getValue()[0]);
  });
  await expect.poll(async () => (await typeControl(page)).summary).toBe('15 / 16');
  const partial = await typeControl(page);
  expect(partial.summary).toBe('15 / 16');
  expect(partial.title).toContain('Multi-cache');
  expect(partial.title.split(',').length).toBe(15);
});
