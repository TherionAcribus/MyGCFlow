// Page Parcours : apparence des étapes et du trait (static/js/parcours_style.mjs),
// copie de parcours_style.py comparée via tests/fixtures/parcours/parcours_style.json
// (écrite par tests/test_parcours_style.py).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    PARCOURS_STYLE_CHOICES,
    PARCOURS_STYLE_KINDS,
    PARCOURS_STYLE_RANGES,
    STOP_POP_QUANTA,
    contrastTextColor,
    hexToRgba,
    normalizeParcoursStyle,
    numberFontPx,
    parcoursStyleDefaults,
    stopNumberLabels,
    stopPopScale,
    themeNumberBadge,
} from '../../static/js/parcours_style.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/parcours/parcours_style.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('mêmes défauts, choix et bornes que le serveur', () => {
    assert.deepEqual(parcoursStyleDefaults(), table.defaults);
    assert.deepEqual([...PARCOURS_STYLE_KINDS], table.kinds);
    assert.deepEqual(plain(PARCOURS_STYLE_CHOICES), table.choices);
    assert.deepEqual(plain(PARCOURS_STYLE_RANGES), table.ranges);
});

test('normalisation : bornes, choix, couleurs, comme coerce_parcours_style', () => {
    assert.deepEqual(normalizeParcoursStyle(undefined), parcoursStyleDefaults());
    const out = normalizeParcoursStyle({
        size: 40, numbers: 'everywhere', plan_line: 'solid',
        trail_color: '#ABCDEF', trail_width: 0, trail_opacity: '55',
        colors: { lab: '#FFFFFF', dnf: 'red', unknown: '#000000' },
    });
    assert.equal(out.size, 18);
    assert.equal(out.numbers, 'trip');
    assert.equal(out.render, 'stops');
    assert.equal(normalizeParcoursStyle({ render: 'theme' }).render, 'theme');
    assert.equal(out.plan_line, 'solid');
    assert.equal(out.trail_color, '#abcdef');
    assert.equal(out.trail_width, 1);
    assert.equal(out.trail_opacity, 55);
    assert.equal(out.colors.lab, '#ffffff');
    assert.equal(out.colors.dnf, '#868e96');
    assert.ok(!('unknown' in out.colors));
    assert.equal(normalizeParcoursStyle({ size: true }).size, 11);
    assert.equal(normalizeParcoursStyle({ size: '' }).size, 11);
});

test('champ absent : valeur courante', () => {
    const current = normalizeParcoursStyle({ numbers: 'day', colors: { find: '#112233' } });
    const out = normalizeParcoursStyle({ size: 9 }, current);
    assert.equal(out.numbers, 'day');
    assert.equal(out.colors.find, '#112233');
    assert.equal(out.size, 9);
    assert.equal(normalizeParcoursStyle({}, { size: 8 }).trail_width, 3);
});

test('numéros : sur tout le parcours, par journée, aucun ; jamais pour lieux et bases', () => {
    const ordered = {
        days: [
            { stops: [{ key: 'base:s', index: null }, { key: 'a', index: 1 }, { key: 'b', index: 2 }] },
            { stops: [] },
            { stops: [{ key: 'c', index: 3 }, { key: 'lieu', index: null }, { key: 'd', index: 4 }] },
        ],
    };
    assert.deepEqual([...stopNumberLabels(ordered, 'trip')], [['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']]);
    assert.deepEqual([...stopNumberLabels(ordered, 'day')], [['a', '1'], ['b', '2'], ['c', '1'], ['d', '2']]);
    assert.equal(stopNumberLabels(ordered, 'none').size, 0);
    assert.equal(stopNumberLabels(null, 'trip').size, 0);
});

test('police réduite à partir de trois chiffres', () => {
    assert.equal(numberFontPx(11, '7'), 11);
    assert.equal(numberFontPx(11, '42'), 11);
    assert.ok(numberFontPx(11, '128') < 11);
    assert.ok(numberFontPx(11, '1024') < numberFontPx(11, '128'));
    assert.ok(numberFontPx(7, '1024') >= 6);
});

test('texte des numéros lisible sur la couleur de la pastille', () => {
    assert.equal(contrastTextColor('#0072c6'), '#ffffff');
    assert.equal(contrastTextColor('#343a40'), '#ffffff');
    assert.equal(contrastTextColor('#868e96'), '#ffffff');
    assert.equal(contrastTextColor('#f59f00'), '#212529');
    assert.equal(contrastTextColor('#ffffff'), '#212529');
    assert.equal(contrastTextColor('pas une couleur'), '#ffffff');
});

test('couleur et opacité en rgba', () => {
    assert.equal(hexToRgba('#00b8d4', 0.5), 'rgba(0, 184, 212, 0.5)');
    assert.equal(hexToRgba('#00B8D4'), 'rgba(0, 184, 212, 1)');
    assert.equal(hexToRgba('#ffffff', 3), 'rgba(255, 255, 255, 1)');
});

test('apparition en lecture : de rien à la taille, léger dépassement, posée ensuite', () => {
    assert.equal(stopPopScale(-1), 0);
    assert.equal(stopPopScale(0), 0);
    assert.equal(stopPopScale(Number.NaN), 0);
    assert.equal(stopPopScale(STOP_POP_QUANTA), 1);
    assert.equal(stopPopScale(50), 1);
    const samples = Array.from({ length: 30 }, (_, i) => stopPopScale((i + 1) * STOP_POP_QUANTA / 31));
    const peak = Math.max(...samples);
    assert.ok(peak > 1 && peak < 1.15, `dépassement ${peak}`);
    assert.ok(samples[0] > 0 && samples[0] < 0.3);
});

test('numéro à côté d’un point du thème : en haut à droite, hors du point', () => {
    const { radius, offset } = themeNumberBadge(11, 8);
    assert.equal(radius, 8);
    assert.deepEqual(offset, [8, 8]);
    // Centre de la pastille à au moins le rayon du point : elle ne le couvre
    // qu'à moitié au plus.
    assert.ok(Math.hypot(...offset) >= 8);
    assert.equal(themeNumberBadge(7, 0).radius, 6);
    assert.deepEqual(themeNumberBadge(18, 20).offset, [18, 18]);
});
