import test from 'node:test';
import assert from 'node:assert/strict';

import {
    fileKey,
    fileStem,
    matchKey,
    needsImportTargetChoice,
    suggestedImportTarget,
    unmatchedFilenames,
} from './static/js/evolution_import_target.mjs';

const slovenie = { id: 1, name: 'SlovnieCroatie', stats: { total: 9000 }, import_count: 2 };

test('fileStem retire extension et horodatage d\'export', () => {
    assert.equal(fileStem('SlovnieCroatie-20260930061930.csv'), 'SlovnieCroatie');
    assert.equal(fileStem('Zone_20260930.txt'), 'Zone');
    assert.equal(fileStem('evolution-a.csv'), 'evolution-a');
    assert.equal(fileStem(''), '');
});

test('matchKey ignore accents, casse, ponctuation et suffixe « (2) »', () => {
    assert.equal(matchKey('Slovénie et Croatie'), 'slovenieetcroatie');
    assert.equal(matchKey('evolution-a (2)'), 'evolutiona');
    assert.equal(fileKey('Evolution_A-20260110.csv'), 'evolutiona');
    assert.equal(matchKey('  '), '');
});

test('aucune question sans base ouverte ou avec une base vide', () => {
    assert.equal(needsImportTargetChoice({ dataset: null, filenames: ['x.csv'] }), false);
    const empty = { id: 2, name: 'Nouvelle', stats: { total: 0 }, import_count: 0 };
    assert.equal(needsImportTargetChoice({ dataset: empty, filenames: ['croatie.csv'] }), false);
});

test('aucune question quand le fichier correspond au nom de la base', () => {
    assert.equal(needsImportTargetChoice({
        dataset: slovenie, filenames: ['SlovnieCroatie-20261015080000.csv'],
    }), false);
    // Base créée avec un suffixe pour éviter un nom pris.
    assert.equal(needsImportTargetChoice({
        dataset: { ...slovenie, name: 'SlovnieCroatie (2)' }, filenames: ['slovniecroatie.csv'],
    }), false);
});

test('aucune question quand le fichier correspond à un export déjà reçu (base renommée)', () => {
    const renamed = { ...slovenie, name: 'Balkans' };
    assert.equal(needsImportTargetChoice({
        dataset: renamed,
        importedFilenames: ['SlovnieCroatie-20260930061559.csv'],
        filenames: ['SlovnieCroatie-20261101000000.csv'],
    }), false);
});

test('question dès qu\'un fichier ne correspond pas', () => {
    const args = {
        dataset: slovenie,
        importedFilenames: ['SlovnieCroatie-20260930061559.csv'],
        filenames: ['SlovnieCroatie-20261101.csv', 'Italie-20261101.csv'],
    };
    assert.equal(needsImportTargetChoice(args), true);
    assert.deepEqual(unmatchedFilenames(args), ['Italie-20261101.csv']);
    // Nom réduit à un horodatage : rien pour reconnaître la zone.
    assert.equal(needsImportTargetChoice({ dataset: slovenie, filenames: ['20261101.csv'] }), true);
});

test('suggestion : autre base de même nom, sinon nouvelle base', () => {
    const datasets = [slovenie, { id: 3, name: 'Italie', stats: { total: 10 } }];
    assert.deepEqual(
        suggestedImportTarget({ datasets, currentId: 1, filenames: ['italie-20261101.csv'] }),
        { kind: 'existing', id: 3 });
    assert.deepEqual(
        suggestedImportTarget({ datasets, currentId: 1, filenames: ['Autriche.csv'] }),
        { kind: 'new' });
    // Jamais la base ouverte elle-même.
    assert.deepEqual(
        suggestedImportTarget({ datasets, currentId: 3, filenames: ['italie.csv'] }),
        { kind: 'new' });
});
