// Images sur la carte : règles du bloc « Apparence » (static/js/images_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    IMAGE_STYLE_PRESETS,
    imageItemDefaults,
    imageStyleFieldStates,
    imageStylePreset,
    matchingStylePreset,
    withBackgroundColor,
} from '../../static/js/images_model.mjs';

function itemWith(style = {}, position = {}) {
    const item = imageItemDefaults();
    return { ...item, style: { ...item.style, ...style }, position: { ...item.position, ...position } };
}

test('matchingStylePreset : chaque préréglage appliqué est reconnu', () => {
    for (const name of Object.keys(IMAGE_STYLE_PRESETS)) {
        const { style } = imageStylePreset(itemWith(), name);
        assert.equal(matchingStylePreset(style), name);
    }
});

test('matchingStylePreset : un réglage modifié ou le style par défaut ne correspondent à rien', () => {
    const { style } = imageStylePreset(itemWith(), 'avatar');
    assert.equal(matchingStylePreset({ ...style, border_width: 4 }), null);
    assert.equal(matchingStylePreset(imageItemDefaults().style), null);
    assert.equal(matchingStylePreset(null), null);
});

test('matchingStylePreset : couleurs comparées sans la casse', () => {
    const { style } = imageStylePreset(itemWith(), 'avatar');
    assert.equal(matchingStylePreset({ ...style, border_color: '#FFFFFF' }), 'avatar');
});

test('imageStyleFieldStates : rayon seulement pour les coins arrondis', () => {
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'rounded' })).radius, true);
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'rect' })).radius, false);
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'circle' })).radius, false);
});

test('imageStyleFieldStates : couleur de bordure seulement avec une bordure', () => {
    assert.equal(imageStyleFieldStates(itemWith({ border_width: 0 })).borderColor, false);
    assert.equal(imageStyleFieldStates(itemWith({ border_width: 2 })).borderColor, true);
});

test('imageStyleFieldStates : ajustement utile si rond ou hauteur imposée', () => {
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'rounded' })).fit, false);
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'circle' })).fit, true);
    assert.equal(imageStyleFieldStates(itemWith({ shape: 'rect' }, { height: 90 })).fit, true);
});

test('withBackgroundColor : fond transparent rendu opaque, opacité réglée gardée', () => {
    const base = imageItemDefaults().style;
    assert.deepEqual(withBackgroundColor(base, '#123456'),
        { ...base, background: '#123456', background_opacity: 100 });
    assert.equal(withBackgroundColor({ ...base, background_opacity: 40 }, '#123456').background_opacity, 40);
    assert.equal(base.background_opacity, 0, 'le style d’origine n’est pas modifié');
});
