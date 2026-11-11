// Couche de zones de la carte : options du thème, couleurs, fondus, légende
// (static/js/zone_layer_model.mjs). Lancer : npm run test:unit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
    ZONE_LAYER_DEFAULTS, classColors, compareClassColors, fadeProgress, legendEntries, legendOrigin,
    labelFits, legendSize, mixHex, normalizeHex, normalizeZoneLayerOptions, rgbaOf, zoneLabelColors, zoneLabelText,
    zoneLayerFromProfile, zoneLayerToProfile, zoneMeasureFor,
} from '../../static/js/zone_layer_model.mjs';
import { shareScaleThresholds, zoneScale } from '../../static/js/zone_model.mjs';
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
    assert.deepEqual(labels, ['< 12 %', '12–55 %', '≥ 55 %']);
    // Échelle fixe 0–100 % de la couche : seuils ronds, extrêmes ouvertes.
    const fixed = zoneScale([10, 30, 55, 90], { mode: 'fixed', classes: 4, thresholds: shareScaleThresholds(4) });
    const fixedLabels = legendEntries(fixed, o, { formatNumber: (v) => fmt.format(v), percent: true }).map((e) => e.label);
    assert.deepEqual(fixedLabels, ['< 25 %', '25–50 %', '50–75 %', '≥ 75 %']);
});

test('densité : option gardée, légende fractionnaire', () => {
    const o = normalizeZoneLayerOptions({ measure: 'count', perKm2: true });
    assert.equal(o.perKm2, true);
    // L'option est conservée quelle que soit la mesure (l'utilisateur la
    // retrouve en revenant à un décompte) ; la couche ne l'applique que
    // pour « count » et « distinct_types » (ZONE_LAYER_DENSITY_MEASURES).
    assert.equal(normalizeZoneLayerOptions({ measure: 'first_day', perKm2: true }).perKm2, true);
    assert.equal(normalizeZoneLayerOptions({ perKm2: 'oui' }).perKm2, false);
    const profile = zoneLayerToProfile(o);
    assert.equal(profile.per_km2, true);
    assert.deepEqual(zoneLayerFromProfile(profile), o);
    // Légende : bornes ouvertes comme la part trouvée, sans « % » (le
    // formatNumber de la couche affiche pour 1 000 km²).
    const fmt = new Intl.NumberFormat('fr', { maximumSignificantDigits: 2 });
    const scale = zoneScale([0.0001, 0.0003, 0.0004, 0.028], { mode: 'quantile', classes: 3 });
    const labels = legendEntries(scale, o, { formatNumber: (v) => fmt.format(v * 1000), float: true }).map((e) => e.label);
    assert.equal(labels[0][0], '<');
    assert.equal(labels[labels.length - 1][0], '≥');
    assert.ok(labels.every((label) => !label.includes('%')));
});

test('comparaison à une date : option, rampe divergente, libellés signés', () => {
    const o = normalizeZoneLayerOptions({ compareDate: '2026-01-03' });
    assert.equal(o.compareDate, '2026-01-03');
    assert.equal(normalizeZoneLayerOptions({ compareDate: 'hier' }).compareDate, '');
    assert.equal(normalizeZoneLayerOptions({ compareDate: 42 }).compareDate, '');
    const profile = zoneLayerToProfile(o);
    assert.equal(profile.compare_date, '2026-01-03');
    assert.deepEqual(zoneLayerFromProfile(profile), o);
    // Deltas [-5, -2, +1, +3, +4] en quantiles 4 : deux classes sous zéro
    // (rouge, plus foncé au plus fort recul), deux au-dessus (teinte).
    const scale = zoneScale([-5, -2, 1, 3, 4], { mode: 'quantile', classes: 4 });
    const colors = compareClassColors(scale, '#1E6FD9');
    assert.equal(colors[0], '#C0392B');
    assert.equal(colors[3], '#1E6FD9');
    assert.equal(colors[1], mixHex('#FFFFFF', '#C0392B', 0.4));
    assert.equal(colors[2], mixHex('#FFFFFF', '#1E6FD9', 0.4));
    const fmt = new Intl.NumberFormat('fr', { maximumFractionDigits: 0 });
    const labels = legendEntries(scale, o, { formatNumber: (v) => fmt.format(v), signed: true }).map((e) => e.label);
    assert.deepEqual(labels, ['< −2', '−2–+1', '+1–+3', '≥ +3']);
});

test('zones seules : option booléenne, aller-retour thème', () => {
    const o = normalizeZoneLayerOptions({ solo: true });
    assert.equal(o.solo, true);
    assert.equal(normalizeZoneLayerOptions({}).solo, false);
    assert.equal(normalizeZoneLayerOptions({ solo: 'oui' }).solo, false);
    const profile = zoneLayerToProfile(o);
    assert.equal(profile.solo, true);
    assert.deepEqual(zoneLayerFromProfile(profile), o);
});

test('valeurs sur les zones : option, texte, couleurs, place', () => {
    // Option du thème, décochée par défaut, aller-retour.
    assert.equal(normalizeZoneLayerOptions({}).labels, false);
    assert.equal(normalizeZoneLayerOptions({ labels: 'oui' }).labels, false);
    const o = normalizeZoneLayerOptions({ labels: true });
    assert.equal(zoneLayerToProfile(o).labels, true);
    assert.deepEqual(zoneLayerFromProfile(zoneLayerToProfile(o)), o);

    // Texte : court, l'unité est dans la légende.
    const nbsp = (s) => s.replace(/[  ]/g, ' ');
    assert.equal(zoneLabelText(7), '7');
    assert.equal(nbsp(zoneLabelText(1234)), '1 234');
    assert.match(nbsp(zoneLabelText(12345)), /^12,3 k/);
    assert.equal(zoneLabelText(42.4, { measure: 'found_share' }), '42');
    assert.equal(zoneLabelText(dayNumber({ y: 2019, m: 5, d: 3 }), { measure: 'first_day' }), '2019');
    assert.equal(zoneLabelText(0.0286, { density: true }), '29');      // pour 1 000 km²
    assert.equal(zoneLabelText(0.00044, { density: true }), '0,44');
    assert.equal(zoneLabelText(3, { signed: true }), '+3');
    assert.equal(zoneLabelText(-2, { signed: true }), '−2');
    assert.equal(zoneLabelText(null), '');
    assert.equal(zoneLabelText(5, { locale: 'en' }), '5');

    // Couleurs : texte foncé sur une teinte claire, blanc sur une foncée ;
    // une teinte foncée très transparente reste claire à l'œil.
    assert.equal(zoneLabelColors('#E8F1FC', 0.6).fill, '#1F2B38');
    assert.equal(zoneLabelColors('#0B2E5C', 0.85).fill, '#FFFFFF');
    assert.equal(zoneLabelColors('#0B2E5C', 0.2).fill, '#1F2B38');
    assert.match(zoneLabelColors('#0B2E5C', 0.85).stroke, /^rgba\(0,0,0/);

    // Place : 30 px de texte dans une zone de 40 × 20 px, pas de 30 × 20.
    assert.equal(labelFits(30, 12, 40, 20), true);
    assert.equal(labelFits(30, 12, 30, 20), false);
    assert.equal(labelFits(10, 12, 40, 12), false);
});

test('mesures de zone_model', () => {
    assert.deepEqual(zoneMeasureFor('distinct_types'), { op: 'distinct', field: 'cache_type' });
    assert.deepEqual(zoneMeasureFor('dt_missing'), { op: 'dt_missing' });
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
    // Bornes extrêmes ouvertes : l'échelle est celle de l'état final, des
    // valeurs plus faibles ou plus fortes tombent dedans pendant l'animation.
    assert.deepEqual(entries.map((e) => e.label), ['≤ 2', '≥ 3']);   // quantiles : 2 classes
    const linear = legendEntries(zoneScale([1, 1, 3, 3, 8], { mode: 'linear', classes: 3 }), ZONE_LAYER_DEFAULTS);
    assert.deepEqual(linear.map((e) => e.label), ['≤ 3', '4–5', '≥ 6']);
    // Une seule classe : la valeur observée reste la seule borne affichable.
    assert.deepEqual(legendEntries(zoneScale([5, 5], { classes: 3 }), ZONE_LAYER_DEFAULTS).map((e) => e.label), ['5']);
    const day = (y) => dayNumber({ y, m: 6, d: 1 });
    const years = legendEntries(zoneScale([day(2015), day(2018), day(2024)], { mode: 'year', classes: 3 }), ZONE_LAYER_DEFAULTS);
    assert.deepEqual(years.map((e) => e.label), ['2015–2018', '2019–2022', '2023–2024']);
    assert.deepEqual(legendEntries(zoneScale([]), ZONE_LAYER_DEFAULTS), []);
    const size = legendSize(entries, 'Trouvailles', (text) => text.length * 6);
    assert.ok(size.width > 0 && size.height > 0);
    assert.deepEqual(legendOrigin('bottom-left', size, 800, 600), { x: 12, y: 600 - 12 - size.height });
    assert.deepEqual(legendOrigin('top-right', size, 800, 600), { x: 800 - 12 - size.width, y: 12 });
});
