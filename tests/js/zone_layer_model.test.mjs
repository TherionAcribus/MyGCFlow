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

test('part trouvée : jeu, base, légende en pourcentage', () => {
    const o = normalizeZoneLayerOptions({ measure: 'found_share', shareDataset: '4', shareBase: 'all' });
    assert.equal(o.measure, 'found_share');
    assert.equal(o.shareDataset, 4);
    assert.equal(o.shareBase, 'all');
    assert.equal(normalizeZoneLayerOptions({ shareDataset: true, shareBase: 'x' }).shareDataset, 0);
    assert.equal(normalizeZoneLayerOptions({ shareBase: 'x' }).shareBase, 'active');
    const profile = zoneLayerToProfile(o);
    assert.deepEqual([profile.share_dataset, profile.share_base], [4, 'all']);
    assert.deepEqual(zoneLayerFromProfile(profile), o);
    const scale = zoneScale([0, 10, 12.4, 30.9, 55, 100], { mode: 'quantile', classes: 3 });
    const fmt = new Intl.NumberFormat('fr', { maximumFractionDigits: 0 });
    const labels = legendEntries(scale, o, { formatNumber: (v) => fmt.format(v), percent: true }).map((e) => e.label);
    assert.deepEqual(labels, ['0–12 %', '12–55 %', '55–100 %']);
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
