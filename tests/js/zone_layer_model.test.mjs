// Couche de zones de la carte : options du thème, couleurs, fondus, légende
// (static/js/zone_layer_model.mjs). Lancer : npm run test:unit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
    ZONE_LAYER_DEFAULTS, classColors, fadeProgress, legendEntries, legendOrigin, legendSize, mixHex,
    normalizeHex, normalizeZoneLayerOptions, rgbaOf, zoneLayerFromProfile, zoneLayerToProfile, zoneMeasureFor,
} from '../../static/js/zone_layer_model.mjs';
import { zoneScale } from '../../static/js/zone_model.mjs';
import { dayNumber } from '../../static/js/stats_model.mjs';

test('défauts identiques à defaultValues.json', () => {
    const json = JSON.parse(readFileSync(new URL('../../static/json/defaultValues.json', import.meta.url), 'utf8'));
    assert.deepEqual(normalizeZoneLayerOptions(json.zones), ZONE_LAYER_DEFAULTS);
    assert.deepEqual(normalizeZoneLayerOptions(undefined), ZONE_LAYER_DEFAULTS);
});

test('options : valeurs invalides rejetées, bornes', () => {
    const o = normalizeZoneLayerOptions({
        level: 'planet', measure: 'count', classes: 12, opacity: true, color: '#abc', outline: 'oui', legendPosition: 'top-right',
    });
    assert.equal(o.level, 'subregion');
    assert.equal(o.classes, 7);
    assert.equal(o.opacity, ZONE_LAYER_DEFAULTS.opacity);
    assert.equal(o.color, '#AABBCC');
    assert.equal(o.outline, true);
    assert.equal(o.legendPosition, 'top-right');
    assert.equal(normalizeHex('nope', '#000000'), '#000000');
});

test('thème (snake_case) ↔ options', () => {
    const profile = zoneLayerToProfile({ ...ZONE_LAYER_DEFAULTS, legendPosition: 'top-left', measure: 'first_day' });
    assert.equal(profile.legend_position, 'top-left');
    assert.equal(profile.legendPosition, undefined);
    assert.deepEqual(zoneLayerFromProfile(profile), { ...ZONE_LAYER_DEFAULTS, legendPosition: 'top-left', measure: 'first_day' });
});

test('mesures de zone_model', () => {
    assert.deepEqual(zoneMeasureFor('distinct_types'), { op: 'distinct', field: 'cache_type' });
    assert.deepEqual(zoneMeasureFor('first_day'), { op: 'first_day' });
    assert.deepEqual(zoneMeasureFor('??'), { op: 'count' });
});

test('couleurs : rampe vers la teinte choisie, fondu, rgba', () => {
    const colors = classColors('#1E6FD9', 5);
    assert.equal(colors.length, 5);
    assert.equal(colors[4], '#1E6FD9');
    assert.notEqual(colors[0], '#FFFFFF');
    assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080');
    assert.equal(rgbaOf('#1E6FD9', 0.5), 'rgba(30,111,217,0.5)');
    assert.equal(fadeProgress(1000, 1300, 600), 0.5);
    assert.equal(fadeProgress(1000, 5000, 600), 1);
    assert.equal(fadeProgress(NaN, 5000), 1);
});

test('légende : classes entières, années, taille et coin', () => {
    const scale = zoneScale([1, 1, 3, 3, 8], { classes: 3 });
    const entries = legendEntries(scale, ZONE_LAYER_DEFAULTS);
    assert.deepEqual(entries.map((e) => e.label), ['1–2', '3–8']);   // quantiles : 2 classes
    const linear = legendEntries(zoneScale([1, 1, 3, 3, 8], { mode: 'linear', classes: 3 }), ZONE_LAYER_DEFAULTS);
    assert.deepEqual(linear.map((e) => e.label), ['1–3', '4–5', '6–8']);
    const day = (y) => dayNumber({ y, m: 6, d: 1 });
    const years = legendEntries(zoneScale([day(2015), day(2018), day(2024)], { mode: 'year', classes: 3 }), ZONE_LAYER_DEFAULTS);
    assert.deepEqual(years.map((e) => e.label), ['2015–2018', '2019–2022', '2023–2024']);
    assert.deepEqual(legendEntries(zoneScale([]), ZONE_LAYER_DEFAULTS), []);
    const size = legendSize(entries, 'Trouvailles', (text) => text.length * 6);
    assert.ok(size.width > 0 && size.height > 0);
    assert.deepEqual(legendOrigin('bottom-left', size, 800, 600), { x: 12, y: 600 - 12 - size.height });
    assert.deepEqual(legendOrigin('top-right', size, 800, 600), { x: 800 - 12 - size.width, y: 12 });
});
