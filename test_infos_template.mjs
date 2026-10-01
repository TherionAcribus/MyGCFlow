import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_EVOLUTION_TEMPLATE,
    EVOLUTION_INFO_TAGS,
    renderInfosTemplate,
    reservedInfosTemplateText,
} from './static/js/infos_template.mjs';
import { WIDEST_DATE } from './static/js/infos_reserve.mjs';

const VALUES = {
    date: '10/02/2026',
    actives: 5,
    placees: 9,
    archivees: 4,
    total: 9,
};

test('les cinq balises sont remplacées par les valeurs courantes', () => {
    const text = renderInfosTemplate('{date} | {actives} | {placees} | {archivees} | {total}', VALUES);
    assert.equal(text, '10/02/2026 | 5 | 9 | 4 | 9');
});

test('le modèle par défaut est la ligne historique date · actives', () => {
    assert.equal(DEFAULT_EVOLUTION_TEMPLATE, '{date} · {actives}');
    assert.equal(renderInfosTemplate(DEFAULT_EVOLUTION_TEMPLATE, VALUES), '10/02/2026 · 5');
    assert.deepEqual(EVOLUTION_INFO_TAGS, ['date', 'actives', 'placees', 'archivees', 'total']);
});

test('la casse et les espaces autour du nom sont tolérés', () => {
    assert.equal(renderInfosTemplate('{ ACTIVES }', VALUES), '5');
    assert.equal(renderInfosTemplate('{Date}', VALUES), '10/02/2026');
    assert.equal(renderInfosTemplate('{  placees}', VALUES), '9');
});

test('balises inconnues et texte libre restent littéraux', () => {
    // Une faute de frappe reste visible plutôt qu'un trou dans la ligne.
    assert.equal(renderInfosTemplate('{nom} {archive} caches', VALUES), '{nom} {archive} caches');
    assert.equal(renderInfosTemplate('Caches : {actives} !', VALUES), 'Caches : 5 !');
    assert.equal(renderInfosTemplate('libre', VALUES), 'libre');
});

test('un modèle vide ou absent produit une ligne vide', () => {
    assert.equal(renderInfosTemplate('', VALUES), '');
    assert.equal(renderInfosTemplate(null, VALUES), '');
    assert.equal(renderInfosTemplate(undefined), '');
});

test('une balise sans valeur est remplacée par du vide', () => {
    assert.equal(renderInfosTemplate('{actives}', {}), '');
    assert.equal(renderInfosTemplate('{date}/{total}', { date: 'x' }), 'x/');
});

test('la réserve prend la plus large date et les maxima des compteurs', () => {
    const text = reservedInfosTemplateText('{date} · {actives} / {total}', {
        actives: 12345,
        placees: 99999,
        archivees: 7,
        total: 99999,
    });
    assert.equal(text, `${WIDEST_DATE} · 12345 / 99999`);
    assert.equal(WIDEST_DATE, '88/88/8888');
});

test('la réserve conserve le texte libre et les balises inconnues', () => {
    assert.equal(
        reservedInfosTemplateText('Placées : {placees} ({nom})', { placees: 42 }),
        'Placées : 42 ({nom})');
});

test('la réserve d\'une balise sans maximum vaut 0', () => {
    assert.equal(reservedInfosTemplateText('{actives}'), '0');
    assert.equal(reservedInfosTemplateText(''), '');
});
