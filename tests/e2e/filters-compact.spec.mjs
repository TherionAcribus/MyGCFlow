// Filtres compacts : le contrôle fermé n'affiche que le résumé
// (« Tout (n) », « n / total », « Aucun ») ; les actions Tout/Aucun vivent dans
// le menu déroulant ; la liste des noms sélectionnés reste accessible en
// tooltip sur le contrôle fermé pour une sélection partielle.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');

// Les prédicats de waitForFunction doivent rester SYNCHRONES : une fonction
// async retourne une Promise, que Playwright interprète comme une valeur
// truthy — le wait résoudrait immédiatement, sans attendre la condition.
async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
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
  // Nombre de types proposés (16 caches + « Adventure Lab » en mode
  // Normal) : lu dans le DOM pour ne pas casser à chaque ajout.
  const typeCount = await page.locator('#selectType option:not([disabled]):not([value=""])').count();
  expect((await typeControl(page)).summary).toBe(`Tout (${typeCount})`);

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
  expect((await typeControl(page)).summary).toBe(`Tout (${typeCount})`);
  await expect(dropdown.locator('#btnAllType')).toHaveClass(/filter-btn-disabled/);

  // Sélection partielle : le résumé passe au compteur et le tooltip liste
  // les noms des options restantes. La mise à jour passe par le debounce de
  // sélection (~250 ms) : on poll jusqu'à ce que le résumé bascule.
  await page.locator('#selectType').evaluate(el => {
    const ts = el.tomselect;
    ts.removeItem(ts.getValue()[0]);
  });
  await expect.poll(async () => (await typeControl(page)).summary).toBe(`${typeCount - 1} / ${typeCount}`);
  const partial = await typeControl(page);
  expect(partial.summary).toBe(`${typeCount - 1} / ${typeCount}`);
  expect(partial.title).toContain('Multi-cache');
  expect(partial.title.split(',').length).toBe(typeCount - 1);
});

test('les options des filtres affichent leur nombre de découvertes', async ({ page, request }) => {
  // Runtime partagé : repartir d'une base vide puis importer le fixture rend
  // le test indépendant de l'ordre d'exécution des specs.
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();

  await openReadyApp(page);
  await dismissFirstUseModal(page);
  await importFixture(page);

  // Répartition réelle de my-finds.gpx : Traditional Cache ×3, Multi-cache ×2,
  // Event Cache ×1 ; côté tailles Other ×2 et une de chaque autre.
  await page.locator('#selectType').evaluate(el => el.tomselect.open());
  const typeDropdown = page.locator('.filter-field:has(#selectType) .ts-dropdown');
  const typeOption = value => typeDropdown.locator(`.option[data-value="${value}"]`);
  await expect(typeOption('Traditional Cache')).toContainText('Traditional Cache (3)');
  await expect(typeOption('Multi-cache')).toContainText('Multi-cache (2)');
  await expect(typeOption('Event Cache')).toContainText('Event Cache (1)');

  // Option absente des données : « (0) » avec le libellé estompé, mais jamais
  // désactivée — ni côté DOM natif ni côté option du menu (elle reste cochée
  // et décochable).
  const letterbox = typeOption('Letterbox Hybrid');
  await expect(letterbox).toContainText('Letterbox Hybrid (0)');
  await expect(letterbox.locator('span.text-muted').filter({ hasText: 'Letterbox Hybrid' })).toHaveCount(1);
  await expect(page.locator('#selectType option[value="Letterbox Hybrid"]')).not.toBeDisabled();

  // Sélection partielle : les compteurs restent ceux de l'univers affichable,
  // pas recalculés sur la sélection — « Traditional Cache (3) » survit à la
  // décochage de Letterbox Hybrid (le menu reste ouvert, closeAfterSelect).
  const typeCount = await page.locator('#selectType option:not([disabled]):not([value=""])').count();
  await letterbox.click();
  await expect.poll(async () => (await typeControl(page)).summary).toBe(`${typeCount - 1} / ${typeCount}`);
  await expect(typeOption('Traditional Cache')).toContainText('Traditional Cache (3)');
  await expect(letterbox).toContainText('Letterbox Hybrid (0)');

  // L'option à 0 est bien re-cochable : le clic la ré-intègre à la sélection.
  await letterbox.click();
  await expect.poll(async () => (await typeControl(page)).summary).toBe(`Tout (${typeCount})`);

  // Même rendu sur un autre select à options fixes (#selectContainer).
  await page.locator('#selectContainer').evaluate(el => el.tomselect.open());
  const containerDropdown = page.locator('.filter-field:has(#selectContainer) .ts-dropdown');
  await expect(containerDropdown.locator('.option[data-value="Other"]')).toContainText('Other (2)');
  await expect(containerDropdown.locator('.option[data-value="Regular"]')).toContainText('Regular (1)');
  await expect(containerDropdown.locator('.option[data-value="Not chosen"]')).toContainText('Not chosen (0)');
});
