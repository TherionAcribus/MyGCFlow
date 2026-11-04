// Filtres inclusifs Attributs / Propriétaire / Recherche (panneau Filtres de
// l'onglet Données, mode principal) : sémantique inversée des listes
// exclusives — sélection vide = critère neutre.
// - Attributs (properties.attributes du GPX, [{id, name, inc}]) : ET logique,
//   la cache doit porter chaque attribut choisi avec inc ≠ '0' ;
// - Propriétaire (owner, placed_by en repli) : OU, owner ∈ sélection ;
// - Recherche : sous-chaîne sur gc_code OU name, casse et accents ignorés,
//   Labs compris (non couvert ici : le GPX généré ne porte que des géocaches).
// Le GPX est généré en mémoire : la fixture my-finds.gpx ne porte ni
// <groundspeak:attributes> ni <groundspeak:owner>.
import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';

const GPX_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Groundspeak Pocket Query"
     xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
  <name>My Finds Pocket Query - MyGCFlow E2E</name>
  <desc>Groundspeak deterministic browser test fixture</desc>
  <author>Groundspeak</author>`;

// attrs : [[id, inc, nom], …] ; absent → pas d'élément <groundspeak:attributes>
// (colonne NULL en base, properties.attributes = null dans le GeoJSON).
const gpxWpt = (code, name, day, owner, attrs) => `<wpt lat="48.86${day}" lon="2.36${day}"><time>2025-01-0${day}T00:00:00Z</time><name>${code}</name><urlname>${name}</urlname><groundspeak:cache><groundspeak:name>${name}</groundspeak:name><groundspeak:owner>${owner}</groundspeak:owner><groundspeak:placed_by>${owner}</groundspeak:placed_by><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Micro</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:country>France</groundspeak:country><groundspeak:state>Île-de-France</groundspeak:state>${attrs ? `<groundspeak:attributes>${attrs.map(([id, inc, label]) => `<groundspeak:attribute id="${id}" inc="${inc}">${label}</groundspeak:attribute>`).join('')}</groundspeak:attributes>` : ''}<groundspeak:logs><groundspeak:log><groundspeak:date>2026-01-0${day}T10:00:00Z</groundspeak:date><groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs></groundspeak:cache></wpt>`;

// GCAA01 : attributs 13 et 44 présents, 42 explicitement absent (inc="0") —
// le cas inc='0' ne doit ni compter ni matcher.
// GCCC03 : attribut 13 déclaré mais absent (inc="0") — il ne matche pas « 13 ».
const FIXTURE_GPX = GPX_HEAD + [
  gpxWpt('GCAA01', 'Tour Eiffel', 1, 'Alice Poseuse', [['13', '1', 'Available at all times'], ['44', '1', 'Flashlight required'], ['42', '0', 'Needs maintenance']]),
  gpxWpt('GCBB02', 'Banc public', 2, 'Alice Poseuse', [['13', '1', 'Available at all times']]),
  gpxWpt('GCCC03', 'Forêt dense', 3, 'Bob Builder', [['44', '1', 'Flashlight required'], ['13', '0', 'Available at all times']]),
  gpxWpt('GCDD04', 'Café crème', 4, 'Bob Builder', null),
].join('') + '</gpx>';

async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
}

async function importGpx(page) {
  await page.locator('#file-input').setInputFiles({
    name: 'my-finds-attrs.gpx', mimeType: 'application/gpx+xml',
    buffer: Buffer.from(FIXTURE_GPX, 'utf-8'),
  });
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 45_000 });
}

async function clearDb(request) {
  const res = await request.post('/clear_database');
  expect(res.ok()).toBeTruthy();
}

// Ouvre le menu Tom Select d'un select puis clique une option par sa valeur.
async function pickOption(page, selectId, value) {
  await page.locator(`#${selectId}`).evaluate(el => el.tomselect.open());
  await page.locator(`.filter-field:has(#${selectId}) .ts-dropdown .option[data-value="${value}"]`).click();
}

const controlSummary = (page, selectId) => page.locator(`#${selectId}`)
  .evaluate(el => el.tomselect.control.dataset.summary);


test('propriétaire : options peuplées depuis les données, sélection filtre (ANY)', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);

  // Deux propriétaires distincts, compteurs « (n) » sur l'univers affichable.
  const ownerValues = await page.locator('#selectOwners option:not([disabled]):not([value=""])')
    .evaluateAll(opts => opts.map(o => o.value));
  expect(ownerValues.sort()).toEqual(['Alice Poseuse', 'Bob Builder']);

  // Sélection vide = neutre : le résumé du contrôle fermé montre le
  // placeholder, pas « Aucun » (filtres inclusifs).
  expect(await controlSummary(page, 'selectOwners')).toBe('Filtrer par propriétaire');

  await page.locator('#selectOwners').evaluate(el => el.tomselect.open());
  const dropdown = page.locator('.filter-field:has(#selectOwners) .ts-dropdown');
  await expect(dropdown.locator('.option[data-value="Alice Poseuse"]')).toContainText('Alice Poseuse (2)');
  await expect(dropdown.locator('.option[data-value="Bob Builder"]')).toContainText('Bob Builder (2)');

  // ANY : un seul owner → ses deux caches ; les deux owners → tout.
  await pickOption(page, 'selectOwners', 'Alice Poseuse');
  await expect(page.locator('#filtersCounter')).toContainText('2 / 4', { timeout: 15_000 });
  expect(await controlSummary(page, 'selectOwners')).toBe('1 / 2');

  await pickOption(page, 'selectOwners', 'Bob Builder');
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });

  // Tout décocher = neutre, pas « aucune cache ».
  await pickOption(page, 'selectOwners', 'Alice Poseuse');
  await pickOption(page, 'selectOwners', 'Bob Builder');
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });
});


test('attributs : ET logique, inc="0" ne compte ni ne matche', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);

  // Trois attributs distincts ; « Needs maintenance » n'existe qu'en
  // inc="0" → option présente mais compteur (0).
  const attrOptions = await page.locator('#selectAttributes option:not([disabled]):not([value=""])')
    .evaluateAll(opts => opts.map(o => ({ value: o.value, text: o.textContent })));
  expect(attrOptions.map(o => o.value).sort()).toEqual(['13', '42', '44']);

  await page.locator('#selectAttributes').evaluate(el => el.tomselect.open());
  const dropdown = page.locator('.filter-field:has(#selectAttributes) .ts-dropdown');
  await expect(dropdown.locator('.option[data-value="13"]')).toContainText('Available at all times (2)');
  await expect(dropdown.locator('.option[data-value="44"]')).toContainText('Flashlight required (2)');
  await expect(dropdown.locator('.option[data-value="42"]')).toContainText('Needs maintenance (0)');

  // « Available at all times » présent sur GCAA01 + GCBB02 (GCCC03 l'a en
  // inc="0" → exclu) : 2 caches.
  await pickOption(page, 'selectAttributes', '13');
  await expect(page.locator('#filtersCounter')).toContainText('2 / 4', { timeout: 15_000 });

  // ET logique : 13 + 44 → seule GCAA01 porte les deux avec inc ≠ '0'.
  await pickOption(page, 'selectAttributes', '44');
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 15_000 });

  // Attribut jamais présent (inc="0" partout) : sélectionné, aucune cache.
  await pickOption(page, 'selectAttributes', '13');
  await pickOption(page, 'selectAttributes', '44');
  await pickOption(page, 'selectAttributes', '42');
  await expect(page.locator('#filtersCounter')).toContainText('0 / 4', { timeout: 15_000 });
});


test('recherche : sous-chaîne sur code ou nom, accents ignorés ; reset efface les trois champs', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);

  const search = page.locator('#inputFilterSearch');

  // Nom, casse et accents ignorés (« Café crème » via « creme »).
  await search.fill('creme');
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 15_000 });

  // Code GC : « GCDD » ne matche que GCDD04.
  await search.fill('gcdd');
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 15_000 });

  // « foret » matche « Forêt dense » malgré l'accent circonflexe.
  await search.fill('foret');
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 15_000 });

  // Champ vide = neutre.
  await search.fill('');
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });

  // Le panneau marque un filtre actif dès qu'un champ inclusif est renseigné.
  await search.fill('tour');
  await expect(page.locator('#filterPanel')).toHaveAttribute('data-filters-active', '', { timeout: 15_000 });
  await pickOption(page, 'selectOwners', 'Alice Poseuse');
  await pickOption(page, 'selectAttributes', '13');

  // « Réinitialiser tous les filtres » : les trois champs inclusifs repassent
  // à l'état neutre (sélections VIDES — pas « tout sélectionné »).
  await page.locator('#btnResetAllFilters').click();
  await expect(page.locator('#filtersCounter')).toContainText('4 / 4', { timeout: 15_000 });
  await expect(search).toHaveValue('');
  expect(await page.locator('#selectOwners').evaluate(el => el.selectedOptions.length)).toBe(0);
  expect(await page.locator('#selectAttributes').evaluate(el => el.selectedOptions.length)).toBe(0);
  await expect(page.locator('#filterPanel')).not.toHaveAttribute('data-filters-active', '');
});


test('persistance : les trois clés de filtersSelection survivent au rechargement', async ({ page, request }) => {
  await clearDb(request);
  await openReadyApp(page);
  await importGpx(page);

  await pickOption(page, 'selectOwners', 'Alice Poseuse');
  await pickOption(page, 'selectAttributes', '13');
  await page.locator('#inputFilterSearch').fill('eiffel');
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 15_000 });

  // La persistance est debouncée (applySelectionChange) : attendre les clés.
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('filtersSelection') || '{}'));
    return { owners: saved.owners, attributes: saved.attributes, search: saved.search };
  }, { timeout: 15_000 }).toEqual({ owners: ['Alice Poseuse'], attributes: ['13'], search: 'eiffel' });

  // Rechargement : les options dynamiques sont repeuplées AVANT que la
  // sélection restaurée ne soit collectée (populate au chargement des
  // données) — le filtre reste appliqué.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await expect(page.locator('#filtersCounter')).toContainText('1 / 4', { timeout: 45_000 });
  await expect(page.locator('#inputFilterSearch')).toHaveValue('eiffel');
  expect(await page.locator('#selectOwners').evaluate(el =>
    Array.from(el.selectedOptions).map(o => o.value))).toEqual(['Alice Poseuse']);
  expect(await page.locator('#selectAttributes').evaluate(el =>
    Array.from(el.selectedOptions).map(o => o.value))).toEqual(['13']);
});
