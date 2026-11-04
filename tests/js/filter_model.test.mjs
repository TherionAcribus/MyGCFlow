// Filtres inclusifs (attributs, propriétaire, recherche) du panneau Filtres —
// règles pures de static/js/filter_model.mjs. Sémantique inversée des listes
// exclusives : sélection vide = neutre.
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    attributeKey,
    attributePresent,
    featureAttributes,
    featureOwner,
    matchesAttributes,
    matchesSearch,
    normalizeSearchText,
} from '../../static/js/filter_model.mjs';

const props = (over = {}) => ({ gc_code: 'GC123', name: 'Café Crème', ...over });
const attr = (id, name, inc) => ({ id, name, inc });

test('featureAttributes : liste native, chaîne JSON, vides', () => {
    const list = [attr('13', 'Available at all times', '1')];
    assert.deepEqual(featureAttributes(props({ attributes: list })), list);
    assert.deepEqual(featureAttributes(props({ attributes: JSON.stringify(list) })), list);
    assert.deepEqual(featureAttributes(props({ attributes: null })), []);
    assert.deepEqual(featureAttributes(props({})), []);
    assert.deepEqual(featureAttributes(props({ attributes: '[cassé' })), []);
    assert.deepEqual(featureAttributes(props({ attributes: 42 })), []);
});

test('attributeKey : id prioritaire, nom en repli', () => {
    assert.equal(attributeKey(attr('13', 'Available', '1')), '13');
    assert.equal(attributeKey(attr('', 'No id', '1')), 'No id');
    assert.equal(attributeKey(attr(null, 'No id', '1')), 'No id');
    assert.equal(attributeKey(null), '');
});

test('attributePresent : inc "0" = absent explicite, le reste est présent', () => {
    assert.equal(attributePresent(attr('1', 'A', '1')), true);
    assert.equal(attributePresent(attr('1', 'A', '0')), false);
    assert.equal(attributePresent(attr('1', 'A', 1)), true);
    assert.equal(attributePresent(attr('1', 'A', null)), true);
    assert.equal(attributePresent(attr('1', 'A', undefined)), true);
    assert.equal(attributePresent(null), false);
});

test('matchesAttributes : vide = neutre, ET logique, inc "0" ne compte pas', () => {
    const p = props({
        attributes: [
            attr('13', 'Available at all times', '1'),
            attr('44', 'Flashlight required', '1'),
            attr('42', 'Needs maintenance', '0'),
        ],
    });
    assert.equal(matchesAttributes(p, []), true);
    assert.equal(matchesAttributes(p, new Set()), true);
    assert.equal(matchesAttributes(p, ['13']), true);
    assert.equal(matchesAttributes(p, new Set(['13', '44'])), true);
    // Attribut déclaré mais explicitement absent (inc '0') : ne matche pas.
    assert.equal(matchesAttributes(p, ['42']), false);
    // Attribut absent de la liste : ne matche pas.
    assert.equal(matchesAttributes(p, ['99']), false);
    // Combinaison exigeante : une condition manquante suffit à exclure.
    assert.equal(matchesAttributes(p, new Set(['13', '99'])), false);
    // Cache sans attributs : aucune sélection non vide ne matche.
    assert.equal(matchesAttributes(props({ attributes: null }), ['13']), false);
});

test('featureOwner : owner prioritaire, placed_by en repli', () => {
    assert.equal(featureOwner(props({ owner: 'Alice', placed_by: 'Bob' })), 'Alice');
    assert.equal(featureOwner(props({ owner: null, placed_by: 'Bob' })), 'Bob');
    assert.equal(featureOwner(props({ owner: '', placed_by: 'Bob' })), 'Bob');
    assert.equal(featureOwner(props({ owner: '   ', placed_by: null })), null);
    assert.equal(featureOwner(props({})), null);
});

test('normalizeSearchText : casse et diacritiques ignorés', () => {
    assert.equal(normalizeSearchText('  Café Été  '), '  cafe ete  ');
    assert.equal(normalizeSearchText('ÎLE-DE-FRANCE'), 'ile-de-france');
    assert.equal(normalizeSearchText(null), '');
    assert.equal(normalizeSearchText(123), '123');
});

test('matchesSearch : sous-chaîne sur code OU nom, normalisée', () => {
    const p = props({ gc_code: 'GCDIFF1', name: 'Café Crème' });
    assert.equal(matchesSearch(p, ''), true);            // vide = neutre
    assert.equal(matchesSearch(p, 'gcdiff'), true);      // code, casse
    assert.equal(matchesSearch(p, 'creme'), true);       // nom sans accent
    assert.equal(matchesSearch(p, normalizeSearchText('Crème')), true);
    assert.equal(matchesSearch(p, 'xyz'), false);
    // Lab-like : pas de gc_code, le nom suffit.
    assert.equal(matchesSearch(props({ gc_code: null, name: 'Étape finale' }), 'etape'), true);
    assert.equal(matchesSearch(props({ gc_code: null, name: 'Étape finale' }), 'gc'), false);
    // Code seul sans nom : le champ absent ne bloque pas le match.
    assert.equal(matchesSearch(props({ gc_code: 'GC9', name: null }), 'gc9'), true);
});
