// Filtres de la page Statistiques (static/js/chart_filters.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findsTable } from '../../static/js/chart_sources.mjs';
import {
    FILTER_FORM_FIELDS,
    FILTER_FORM_GROUPS,
    activeFilterCount,
    cleanFilters,
    describeFilters,
    filterChoices,
    filterFacets,
    matchingCount,
} from '../../static/js/chart_filters.mjs';
import { FILTER_FIELDS } from '../../static/js/chart_spec.mjs';

const table = findsTable({
    count: 5,
    date: ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'],
    published: ['2010-01-01', '2012-01-01', null, '2012-05-05', '2010-02-02'],
    kind: [0, 0, 0, 1, 0],
    code: ['A', 'B', 'C', 'D', 'E'],
    difficulty: [2, 1.5, 2, null, 5],
    terrain: [1, 1, 1, null, 3.5],
    cache_type: [0, 1, 0, 2, 0],
    container: [1, 0, 2, -1, 1],
    country: [0, 0, 1, 0, -1],
    state: [-1, -1, -1, -1, -1],
    owner: [0, 1, 0, 0, 2],
    attributes: [[0], [0, 1], [], [], [1]],
    dicts: {
        cache_type: ['Traditional Cache', 'Multi-cache', 'Adventure Lab'],
        container: ['Small', 'Micro', 'Large'],
        country: ['France', 'Belgique'],
        state: [],
        owner: ['Alice', 'Bob', 'Chloé'],
        attribute: [{ key: '6', name: 'Kids' }, { key: '8', name: 'Scenic' }],
    },
});

test('les champs du formulaire sont des champs filtrables', () => {
    assert.deepEqual([...FILTER_FORM_FIELDS].sort(), [...FILTER_FIELDS].sort());
});

test('chaque champ du formulaire est dans une seule rubrique', () => {
    const grouped = FILTER_FORM_GROUPS.flatMap((group) => group.fields);
    assert.deepEqual([...grouped].sort(), [...FILTER_FORM_FIELDS].sort());
});

test('valeurs proposées : présentes seulement, avec leur nombre, dans un ordre utile', () => {
    assert.deepEqual(filterChoices(table, 'cache_type'), [
        { value: 'Traditional Cache', count: 3 },
        { value: 'Adventure Lab', count: 1 },
        { value: 'Multi-cache', count: 1 },
    ]);
    assert.deepEqual(filterChoices(table, 'source_kind'), [
        { value: 'geocache', count: 4 },
        { value: 'lab', count: 1 },
    ]);
    // Contenants du plus petit au plus grand ; D/T croissants ; années
    // de publication décroissantes.
    assert.deepEqual(filterChoices(table, 'container').map((c) => c.value), ['Micro', 'Small', 'Large']);
    assert.deepEqual(filterChoices(table, 'difficulty'), [
        { value: '1.5', count: 1 }, { value: '2', count: 2 }, { value: '5', count: 1 },
    ]);
    assert.deepEqual(filterChoices(table, 'published_year').map((c) => c.value), ['2012', '2010']);
    assert.deepEqual(filterChoices(table, 'attribute'), [{ value: '6', count: 2 }, { value: '8', count: 2 }]);
    assert.deepEqual(filterChoices(table, 'state'), []);
});

test('filtres actifs : compte et résumé dans l\'ordre du formulaire', () => {
    const filters = { country: ['France'], cache_type: ['Traditional Cache', 'Multi-cache'], owner: [] };
    assert.equal(activeFilterCount(filters), 2);
    assert.equal(activeFilterCount(null), 0);
    assert.equal(activeFilterCount({}), 0);
    assert.deepEqual(describeFilters(filters, (field, value) => `${field}:${value}`), [
        { field: 'cache_type', values: ['cache_type:Traditional Cache', 'cache_type:Multi-cache'] },
        { field: 'country', values: ['country:France'] },
    ]);
    assert.deepEqual(describeFilters(null), []);
});

test('filtres lus d\'un formulaire : listes vides retirées, valeurs canoniques', () => {
    assert.deepEqual(cleanFilters({ country: [], difficulty: ['2.0', '1.5'], bogus: ['x'] }), { difficulty: ['2', '1.5'] });
    assert.deepEqual(cleanFilters(null), {});
});

test('valeurs proposées sur plusieurs tables : comptes additionnés', () => {
    const merged = filterChoices([table, table], 'cache_type');
    assert.deepEqual(merged[0], { value: 'Traditional Cache', count: 6 });
    assert.deepEqual(filterChoices([table, null], 'country').map((c) => c.count), [3, 1]);
});

test('comptes à facettes : chaque champ compté sous les filtres des autres', () => {
    // Sans filtre : les comptes de filterChoices.
    const none = filterFacets(table, {});
    assert.deepEqual(Object.fromEntries(none.get('cache_type')),
        Object.fromEntries(filterChoices(table, 'cache_type').map((c) => [c.value, c.count])));

    const facets = filterFacets(table, { country: ['France'], cache_type: ['Traditional Cache'] });
    // Type de cache sous « France » seule (lignes A, B, D) : son propre
    // filtre ne retire pas les autres types, qui s'ajouteraient.
    assert.deepEqual(Object.fromEntries(facets.get('cache_type')), { 'Traditional Cache': 1, 'Multi-cache': 1, 'Adventure Lab': 1 });
    // Pays sous « Traditional Cache » seul (lignes A, C, E ; E sans pays).
    assert.deepEqual(Object.fromEntries(facets.get('country')), { France: 1, Belgique: 1 });
    // Propriétaire sous les deux filtres : la seule ligne A.
    assert.deepEqual(Object.fromEntries(facets.get('owner')), { Alice: 1 });
});

test('comptes à facettes des attributs : tous requis, les leurs compris', () => {
    const facets = filterFacets(table, { attribute: ['6'] });
    // Lignes avec l'attribut 6 : A [6], B [6, 8] → 8 n'y reste qu'une fois.
    assert.deepEqual(Object.fromEntries(facets.get('attribute')), { 6: 2, 8: 1 });
    assert.deepEqual(Object.fromEntries(facets.get('owner')), { Alice: 1, Bob: 1 });
});

test('comptes à facettes sur plusieurs tables : additionnés', () => {
    const facets = filterFacets([table, null, table], { country: ['Belgique'] });
    assert.deepEqual(Object.fromEntries(facets.get('cache_type')), { 'Traditional Cache': 2 });
});

test('lignes retenues par les filtres', () => {
    assert.equal(matchingCount(table, {}), 5);
    assert.equal(matchingCount(table, null), 5);
    assert.equal(matchingCount(table, { country: ['France'] }), 3);
    assert.equal(matchingCount(table, { country: ['France'], attribute: ['6', '8'] }), 1);
    assert.equal(matchingCount(null, {}), 0);
});
