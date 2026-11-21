// Page Parcours : apparence des étapes et du trait (static/js/parcours_style.mjs),
// copie de parcours_style.py comparée via tests/fixtures/parcours/parcours_style.json
// (écrite par tests/test_parcours_style.py).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    PARCOURS_DAY_PALETTE,
    PARCOURS_PALETTE_SIZE,
    PARCOURS_STYLE_CHOICES,
    PARCOURS_STYLE_KINDS,
    PARCOURS_STYLE_RANGES,
    STOP_POP_QUANTA,
    CURRENT_RING_PERIOD,
    contrastTextColor,
    currentRingRadius,
    dayColor,
    hexToRgba,
    nextPaletteColor,
    normalizeParcoursStyle,
    numberFontPx,
    paintTextColor,
    parcoursStyleDefaults,
    playPhase,
    stopNumberLabels,
    stopPaint,
    stopPopScale,
    themeNumberBadge,
    trailColorFor,
} from '../../static/js/parcours_style.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/parcours/parcours_style.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('mêmes défauts, choix et bornes que le serveur', () => {
    assert.deepEqual(parcoursStyleDefaults(), table.defaults);
    assert.deepEqual([...PARCOURS_STYLE_KINDS], table.kinds);
    assert.deepEqual(plain(PARCOURS_STYLE_CHOICES), table.choices);
    assert.deepEqual(plain(PARCOURS_STYLE_RANGES), table.ranges);
    assert.deepEqual([...PARCOURS_DAY_PALETTE], table.day_palette);
    assert.deepEqual([...PARCOURS_PALETTE_SIZE], table.palette_size);
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

test('couleur par journée : palette reprise au-delà de huit jours, numéro lisible', () => {
    assert.equal(dayColor(0), PARCOURS_DAY_PALETTE[0]);
    assert.equal(dayColor(9), PARCOURS_DAY_PALETTE[1]);
    assert.equal(dayColor(undefined), PARCOURS_DAY_PALETTE[0]);
    // Numéro blanc sur chaque couleur pleine, la couleur elle-même en creux.
    for (const fill of PARCOURS_DAY_PALETTE) {
        assert.equal(contrastTextColor(fill), '#ffffff', fill);
        assert.equal(paintTextColor({ fill, hollow: true }), fill);
    }
    assert.equal(paintTextColor({ fill: '#ffeb3b', hollow: true }), '#212529');
});

test('peinture d’une étape : par nature, par journée, par type ; lieux et bases inchangés', () => {
    const byKind = parcoursStyleDefaults();
    const byDay = normalizeParcoursStyle({ color_by: 'day' });
    const byType = normalizeParcoursStyle({ color_by: 'type' });
    const types = { 'Traditional Cache': '#008000', 'Adventure Lab': '#00C5A1' };
    const find = { kind: 'find', type: 'Traditional Cache' };
    assert.deepEqual(stopPaint(find, byKind, { dayIndex: 2 }), { fill: '#0072c6', hollow: false });
    assert.deepEqual(stopPaint(find, byDay, { dayIndex: 2 }), { fill: PARCOURS_DAY_PALETTE[2], hollow: false });
    assert.deepEqual(stopPaint(find, byType, { typeColors: types }), { fill: '#008000', hollow: false });
    assert.equal(stopPaint({ kind: 'lab' }, byType, { typeColors: types }).fill, '#00c5a1');
    // Type sans couleur connue : celle de la nature.
    assert.equal(stopPaint({ kind: 'find', type: 'Inconnu' }, byType, { typeColors: types }).fill, '#0072c6');
    // DNF : sa couleur par nature ; en creux sinon.
    assert.deepEqual(stopPaint({ kind: 'dnf' }, byKind), { fill: '#868e96', hollow: false });
    assert.deepEqual(stopPaint({ kind: 'dnf' }, byDay, { dayIndex: 1 }), { fill: PARCOURS_DAY_PALETTE[1], hollow: true });
    for (const kind of ['place', 'base']) {
        assert.deepEqual(stopPaint({ kind }, byDay, { dayIndex: 3 }), { fill: byKind.colors[kind], hollow: false });
    }
});

test('trait : couleur choisie, ou celle de la journée', () => {
    assert.equal(trailColorFor(parcoursStyleDefaults(), 3), '#00b8d4');
    assert.equal(trailColorFor(normalizeParcoursStyle({ trail_by_day: true }), 3), PARCOURS_DAY_PALETTE[3]);
    assert.equal(normalizeParcoursStyle({ trail_by_day: 'oui' }).trail_by_day, false);
    assert.equal(normalizeParcoursStyle({}, { trail_by_day: true }).trail_by_day, true);
});

test('palette des journées modifiable : normalisée comme le serveur, suivie par les couleurs', () => {
    assert.deepEqual(normalizeParcoursStyle({ day_palette: ['#ABCDEF', 'red', '#000000'] }).day_palette,
        ['#abcdef', '#000000']);
    assert.deepEqual(normalizeParcoursStyle({ day_palette: ['#abcdef'] }).day_palette, [...PARCOURS_DAY_PALETTE]);
    assert.equal(normalizeParcoursStyle({ day_palette: Array(20).fill('#111111') }).day_palette.length, 12);
    assert.deepEqual(normalizeParcoursStyle({}, { day_palette: ['#111111', '#222222'] }).day_palette,
        ['#111111', '#222222']);
    const style = normalizeParcoursStyle({ color_by: 'day', trail_by_day: true, day_palette: ['#111111', '#222222', '#333333'] });
    assert.equal(stopPaint({ kind: 'find' }, style, { dayIndex: 4 }).fill, '#222222');
    assert.equal(trailColorFor(style, 2), '#333333');
    assert.equal(dayColor(3, style.day_palette), '#111111');
});

test('case ajoutée à la palette : couleur par défaut absente, sinon une teinte nouvelle', () => {
    assert.equal(nextPaletteColor(PARCOURS_DAY_PALETTE.slice(0, 3)), PARCOURS_DAY_PALETTE[3]);
    assert.equal(nextPaletteColor(['#e8590c', '#123456']), PARCOURS_DAY_PALETTE[0]);
    const extra = nextPaletteColor([...PARCOURS_DAY_PALETTE]);
    assert.match(extra, /^#[0-9a-f]{6}$/);
    assert.ok(!PARCOURS_DAY_PALETTE.includes(extra));
    // Assez foncée pour un numéro blanc.
    assert.equal(contrastTextColor(extra), '#ffffff');
    assert.notEqual(nextPaletteColor([...PARCOURS_DAY_PALETTE, extra]), extra);
    // Loin des teintes déjà prises : rien à moins de 15° de la palette.
    const hue = (hex) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
        const h = max === r ? ((g - b) / d) % 6 : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
        return (h * 60 + 360) % 360;
    };
    for (const c of PARCOURS_DAY_PALETTE) {
        const gap = Math.abs(hue(c) - hue(extra));
        assert.ok(Math.min(gap, 360 - gap) >= 15, `${c} / ${extra}`);
    }
});

test('lecture : réglages, phase d’une étape, anneau de l’étape en cours', () => {
    const d = parcoursStyleDefaults();
    assert.deepEqual([d.play_current, d.play_past, d.play_preview], [true, 'normal', false]);
    const out = normalizeParcoursStyle({ play_current: 0, play_past: 'fade', play_preview: 'yes' });
    assert.deepEqual([out.play_current, out.play_past, out.play_preview], [true, 'normal', false]);
    assert.equal(normalizeParcoursStyle({}, { play_past: 'dim' }).play_past, 'dim');

    const stop = { q: 10, departQ: 22, day: 0 };
    assert.equal(playPhase(stop, 5), 'upcoming');
    assert.equal(playPhase(stop, 10), 'current');
    assert.equal(playPhase(stop, 21.9), 'current');
    assert.equal(playPhase(stop, 22), 'normal');
    assert.equal(playPhase(stop, 30, { past: 'dim' }), 'past');
    // Journées précédentes seulement.
    assert.equal(playPhase(stop, 30, { past: 'dim_days', day: 0 }), 'normal');
    assert.equal(playPhase(stop, 30, { past: 'dim_days', day: 1 }), 'past');
    // Sans durée (départ = arrivée) : jamais « en cours ».
    assert.equal(playPhase({ q: 10 }, 10), 'normal');

    assert.equal(currentRingRadius(11, 0), 17);
    assert.equal(currentRingRadius(11, CURRENT_RING_PERIOD / 2), 23);
    assert.equal(currentRingRadius(11, CURRENT_RING_PERIOD), 17);
});
