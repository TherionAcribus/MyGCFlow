import test from 'node:test';
import assert from 'node:assert/strict';

import { INFOS_SEPARATOR, reservedInfosText } from './static/js/infos_reserve.mjs';

test('la réserve couvre le total final, pas la valeur du moment', () => {
    const text = reservedInfosText({ showCount: true, currentValue: 7, finalValue: 123456 });
    assert.equal(text, '123456');
});

test('un compteur déjà plus grand que le total reste couvert', () => {
    // Après un changement de filtre, le total peut redescendre sous l'affiché.
    assert.equal(reservedInfosText({ showCount: true, currentValue: 900, finalValue: 12 }), '900');
});

test('la date réserve la largeur de la plus large', () => {
    assert.equal(reservedInfosText({ showDate: true }), '88/88/8888');
});

test('les deux infos sont séparées comme dans la cartouche', () => {
    const text = reservedInfosText({ showCount: true, showDate: true, finalValue: 42 });
    assert.equal(text, `42${INFOS_SEPARATOR}88/88/8888`);
    assert.equal(INFOS_SEPARATOR, ' · ');
});

test('une info masquée ne réserve rien', () => {
    assert.equal(reservedInfosText({ showCount: false, showDate: false, finalValue: 999 }), '');
    assert.equal(reservedInfosText({ showDate: true, showCount: false, finalValue: 999 }), '88/88/8888');
});

test('une valeur illisible ou négative ne casse pas la réserve', () => {
    assert.equal(reservedInfosText({ showCount: true, currentValue: '12', finalValue: undefined }), '12');
    assert.equal(reservedInfosText({ showCount: true, currentValue: 'abc', finalValue: -5 }), '0');
    assert.equal(reservedInfosText(), '');
});
