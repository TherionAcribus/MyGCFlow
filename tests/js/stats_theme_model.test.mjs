// Thèmes de couleurs de la page Statistiques (static/js/stats_theme_model.mjs).
// Lancer : npm run test:unit (node --test, aucune dépendance).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    BUILTIN_THEMES,
    DEFAULT_LOOK,
    lookTokens,
    normalizeLook,
    readableOn,
    themeLook,
    DEFAULT_THEME_ID,
    MAX_THEMES,
    SURFACES,
    THEME_CSS_VARS,
    adoptTheme,
    builtinTheme,
    colorDistance,
    contrastRatio,
    duplicateTheme,
    effectiveThemeId,
    exportTheme,
    findTheme,
    heatRamp,
    isThemeRef,
    mixColors,
    normalizeHex,
    normalizeTheme,
    normalizeThemes,
    resolveTheme,
    themeCssVars,
    themeTypeColors,
    themeWarnings,
    uniqueThemeName,
} from '../../static/js/stats_theme_model.mjs';

let counter = 0;
const seqId = () => `abc${String(counter++).padStart(4, '0')}`;

const custom = (over = {}) => normalizeTheme({
    id: 'aaaaaa01',
    name: 'Mon thème',
    series: ['#112233', '#ff0000', '#00aa00', '#0000ff', '#aa00aa', '#00aaaa', '#888800', '#444444'],
    heat: { color: '#3366cc' },
    up: '#0000ff',
    down: '#ff0000',
    ...over,
});

test('couleurs : #rgb étendu, minuscules, refus du reste', () => {
    assert.equal(normalizeHex('#ABC'), '#aabbcc');
    assert.equal(normalizeHex(' #12AB34 '), '#12ab34');
    assert.equal(normalizeHex('red'), null);
    assert.equal(normalizeHex('#12345'), null);
    assert.equal(normalizeHex(42), null);
});

test('mélange OKLab : bornes exactes, milieu entre les deux', () => {
    assert.equal(mixColors('#ff0000', '#0000ff', 0), '#ff0000');
    assert.equal(mixColors('#ff0000', '#0000ff', 1), '#0000ff');
    const mid = mixColors('#000000', '#ffffff', 0.5);
    assert.ok(colorDistance(mid, '#000000') > 0.4 && colorDistance(mid, '#ffffff') > 0.4);
});

test('le thème Défaut reprend exactement stats_page.css (clair et sombre)', () => {
    const css = readFileSync(new URL('../../static/css/stats_page.css', import.meta.url), 'utf8');
    const block = (selector) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
    const value = (text, name) => text.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1].toLowerCase();
    for (const [mode, selector] of [['light', ':root {'], ['dark', '[data-bs-theme="dark"] {']]) {
        const text = block(selector);
        const colors = resolveTheme(builtinTheme('default'), mode);
        colors.series.forEach((c, i) => assert.equal(c, value(text, `--chart-series-${i + 1}`), `${mode} série ${i + 1}`));
        colors.heat.forEach((c, i) => assert.equal(c, value(text, `--chart-heat-${i + 1}`), `${mode} dégradé ${i + 1}`));
        assert.equal(colors.up, value(text, '--chart-up'));
        assert.equal(colors.down, value(text, '--chart-down'));
    }
});

test('thèmes fournis : 8 teintes, lisibles sur leur fond, assez distinctes', () => {
    assert.equal(BUILTIN_THEMES[0].id, DEFAULT_THEME_ID);
    for (const theme of BUILTIN_THEMES) {
        for (const mode of ['light', 'dark']) {
            const colors = resolveTheme(theme, mode);
            assert.equal(colors.series.length, 8);
            assert.equal(colors.heat.length, 5);
            for (const c of colors.series) {
                assert.ok(contrastRatio(c, SURFACES[mode]) >= 1.5, `${theme.id} ${mode} ${c} peu visible`);
            }
            for (let i = 0; i < 8; i++) {
                for (let j = i + 1; j < 8; j++) {
                    assert.ok(colorDistance(colors.series[i], colors.series[j]) >= 0.06,
                        `${theme.id} ${mode} : séries ${i + 1} et ${j + 1} trop proches`);
                }
            }
            assert.deepEqual(themeWarnings(theme).filter((w) => w.mode === mode), [], `${theme.id} ${mode}`);
        }
    }
});

test('dégradé généré : part du fond, la couleur au milieu, s\'en éloigne', () => {
    for (const mode of ['light', 'dark']) {
        const ramp = heatRamp('#3987e5', mode);
        assert.equal(ramp.length, 5);
        assert.equal(ramp[2], '#3987e5');
        const contrast = ramp.map((c) => contrastRatio(c, SURFACES[mode]));
        // Contraste croissant avec le fond, du plus faible au plus fort.
        for (let i = 1; i < 5; i++) assert.ok(contrast[i] > contrast[i - 1], `${mode} pas ${i + 1}`);
    }
    // Clair : le fort est plus sombre ; sombre : plus lumineux.
    assert.ok(contrastRatio(heatRamp('#3987e5', 'light')[4], '#000000') < contrastRatio('#3987e5', '#000000'));
    assert.ok(contrastRatio(heatRamp('#3987e5', 'dark')[4], '#ffffff') < contrastRatio('#3987e5', '#ffffff'));
});

test('thème personnel : couleurs illisibles remplacées, dégradé libre ou généré', () => {
    const theme = normalizeTheme({ id: 'abcdef12', name: '  A\tB ', series: ['#123', 'nope'], heat: { colors: ['#111', '#222', '#333', '#444', '#555'] }, up: 'x', types: { 'Traditional Cache': '#0F0', Bad: 'red' } });
    assert.equal(theme.name, 'A B');
    assert.equal(theme.series[0], '#112233');
    assert.equal(theme.series[1], builtinTheme('default').light.series[1]);
    assert.deepEqual(theme.heat, { colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] });
    assert.equal(theme.up, builtinTheme('default').light.up);
    assert.deepEqual(theme.types, { 'Traditional Cache': '#00ff00' });
    // Dégradé incomplet : généré depuis la couleur centrale du Défaut.
    assert.deepEqual(normalizeTheme({ id: 'abcdef12', heat: { colors: ['#111'] } }).heat, { color: '#3987e5' });
    assert.equal(normalizeTheme({ id: 'x' }), null);
    assert.equal(normalizeTheme({ id: 'x' }, { newId: () => 'abcdef99' }).id, 'abcdef99');
    assert.equal(normalizeTheme('nope'), null);
});

test('liste : doublons d\'identifiant renumérotés, plafond', () => {
    const list = normalizeThemes([custom(), custom(), null, ...Array.from({ length: 40 }, () => ({}))], { newId: seqId });
    assert.equal(list.length, MAX_THEMES);
    assert.equal(new Set(list.map((t) => t.id)).size, MAX_THEMES);
});

test('références : thème fourni ou identifiant hexadécimal', () => {
    assert.ok(isThemeRef('pastel'));
    assert.ok(isThemeRef('abcdef12'));
    assert.ok(!isThemeRef('Pastel'));
    assert.ok(!isThemeRef(null));
});

test('thème effectif : celui du tableau, sinon de la page, sinon Défaut', () => {
    const doc = { themes: [custom()], theme: 'pastel' };
    assert.equal(effectiveThemeId(doc, { theme: 'aaaaaa01' }), 'aaaaaa01');
    assert.equal(effectiveThemeId(doc, { theme: null }), 'pastel');
    assert.equal(effectiveThemeId(doc, { theme: 'bbbbbb02' }), 'pastel');
    assert.equal(effectiveThemeId({ themes: [], theme: 'bbbbbb02' }, {}), DEFAULT_THEME_ID);
    assert.equal(findTheme(doc.themes, 'aaaaaa01').name, 'Mon thème');
    assert.equal(findTheme(doc.themes, 'nope'), null);
});

test('variables CSS : aucune pour Défaut, toutes sinon, même jeu dans les deux modes', () => {
    assert.equal(themeCssVars(builtinTheme('default'), 'dark'), null);
    const vars = themeCssVars(custom(), 'light');
    // Allure de Défaut, pas de couleur de repères : seulement les couleurs.
    assert.deepEqual(Object.keys(vars).sort(), THEME_CSS_VARS.filter((name) => name.startsWith('--chart-')).sort());
    assert.equal(vars['--chart-series-1'], '#112233');
    assert.equal(themeCssVars(custom(), 'dark')['--chart-series-1'], '#112233');
    // Dégradé généré : propre à chaque fond.
    assert.notEqual(vars['--chart-heat-1'], themeCssVars(custom(), 'dark')['--chart-heat-1']);
    // Dégradé libre : identique.
    const fixed = custom({ heat: { colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] } });
    assert.equal(themeCssVars(fixed, 'dark')['--chart-heat-5'], '#555555');
    assert.notEqual(themeCssVars(builtinTheme('pastel'), 'light')['--chart-series-1'],
        themeCssVars(builtinTheme('pastel'), 'dark')['--chart-series-1']);
});

test('types : couleurs de la carte, complétées par celles du thème', () => {
    const defaults = { 'Traditional Cache': '#008000', 'Multi-cache': '#FFA500' };
    assert.equal(themeTypeColors(custom(), defaults), defaults);
    assert.equal(themeTypeColors(builtinTheme('vivid'), defaults), defaults);
    assert.deepEqual(themeTypeColors(custom({ types: { 'Multi-cache': '#123456' } }), defaults),
        { 'Traditional Cache': '#008000', 'Multi-cache': '#123456' });
});

test('avertissements : teinte invisible sur un fond, teintes confondues', () => {
    const theme = custom({ series: ['#ffffff', '#1b2635', '#ff0000', '#ff0101', '#00aa00', '#0000ff', '#aa00aa', '#00aaaa'] });
    const warnings = themeWarnings(theme);
    assert.ok(warnings.some((w) => w.kind === 'faint' && w.index === 0 && w.mode === 'light'));
    assert.ok(warnings.some((w) => w.kind === 'faint' && w.index === 1 && w.mode === 'dark'));
    assert.ok(warnings.some((w) => w.kind === 'close' && w.index === 2 && w.other === 3));
    assert.ok(!warnings.some((w) => w.kind === 'faint' && w.index === 0 && w.mode === 'dark'));
});

test('dupliquer : variante du mode affiché, dégradé généré, nom donné', () => {
    const fromBuiltin = duplicateTheme(builtinTheme('default'), { mode: 'dark', newId: () => 'abcdef01', name: 'Copie' });
    assert.equal(fromBuiltin.id, 'abcdef01');
    assert.equal(fromBuiltin.name, 'Copie');
    assert.deepEqual(fromBuiltin.series, builtinTheme('default').dark.series);
    assert.deepEqual(fromBuiltin.heat, { color: '#2a78d6' });
    assert.equal(fromBuiltin.types, null);
    const source = custom({ types: { 'Traditional Cache': '#00ff00' } });
    const copy = duplicateTheme(source, { newId: () => 'abcdef02', name: 'Bis' });
    assert.equal(copy.id, 'abcdef02');
    assert.deepEqual(copy.types, source.types);
    copy.types['Traditional Cache'] = '#000000';
    assert.equal(source.types['Traditional Cache'], '#00ff00');
});

test('nom libre : suffixe numéroté, longueur bornée', () => {
    const themes = [{ name: 'A' }, { name: 'A (2)' }];
    assert.equal(uniqueThemeName(themes, 'B'), 'B');
    assert.equal(uniqueThemeName(themes, 'A'), 'A (3)');
    assert.equal(uniqueThemeName([{ name: 'x'.repeat(40) }], 'x'.repeat(40)).length, 40);
});

test('partage : export sans identifiant, import réutilise un thème identique', () => {
    const theme = custom();
    const file = exportTheme(theme);
    assert.equal(file.id, undefined);
    const reused = adoptTheme([theme], file, { newId: seqId });
    assert.equal(reused.id, theme.id);
    assert.equal(reused.themes.length, 1);
    const added = adoptTheme([theme], { ...file, up: '#00ff00' }, { newId: () => 'abcdef77' });
    assert.equal(added.id, 'abcdef77');
    assert.equal(added.themes.length, 2);
    assert.equal(added.themes[1].name, 'Mon thème (2)');
    assert.equal(adoptTheme([theme], 'x', { newId: seqId }).id, null);
    const full = Array.from({ length: MAX_THEMES }, (_, i) => custom({ id: `cccc${String(i).padStart(4, '0')}`, up: '#00000' + (i % 10) }));
    assert.equal(adoptTheme(full, { ...file, down: '#00ff00' }, { newId: seqId }).id, null);
});

test('allure : choix bornés, Défaut pour ce qui manque, réglages de dessin', () => {
    assert.deepEqual(normalizeLook({ bars: 'pill', lines: 'nope' }), { ...DEFAULT_LOOK, bars: 'pill' });
    assert.deepEqual(themeLook(null), DEFAULT_LOOK);
    // Défaut : les valeurs historiques de chart_echarts.mjs.
    assert.deepEqual(lookTokens(DEFAULT_LOOK), {
        barRadius: 4, barMaxWidth: 24, lineWidth: 2, symbol: 'circle', symbolSize: 8,
        areaOpacity: 0.1, donutInner: 0.66, sliceRadius: 4,
    });
    const ocean = lookTokens(themeLook(builtinTheme('ocean')));
    assert.equal(ocean.symbol, 'none');
    assert.ok(ocean.barMaxWidth < 24 && ocean.lineWidth < 2 && ocean.donutInner > 0.66);
    // Ancien thème personnel (sans allure) : Défaut.
    assert.deepEqual(custom().look, DEFAULT_LOOK);
    assert.equal(custom().accent, null);
});

test('thèmes fournis : chacun a sa propre allure', () => {
    const looks = BUILTIN_THEMES.map((theme) => JSON.stringify(themeLook(theme)));
    assert.equal(new Set(looks).size, BUILTIN_THEMES.length);
    for (const theme of BUILTIN_THEMES.slice(1)) {
        assert.ok(theme.light.accent && theme.dark.accent, theme.id);
    }
});

test('cartes et pastilles : variables selon l\'allure, texte lisible sur la pastille', () => {
    for (const mode of ['light', 'dark']) {
        const vivid = themeCssVars(builtinTheme('vivid'), mode);
        assert.equal(vivid['--stats-card-band'], builtinTheme('vivid')[mode].accent);
        assert.equal(vivid['--stats-card-radius'], '4px');
        assert.ok(contrastRatio(vivid['--stats-badge-text'], vivid['--stats-badge-bg']) >= 4.5, mode);
        const pastel = themeCssVars(builtinTheme('pastel'), mode);
        assert.notEqual(pastel['--stats-card-bg'], SURFACES[mode]);
        assert.ok(contrastRatio(pastel['--stats-card-bg'], SURFACES[mode]) < 1.3, 'teinte discrète');
        assert.ok(themeCssVars(builtinTheme('ocean'), mode)['--stats-card-border-color']);
    }
    // Sans couleur de repères : bandeau à la couleur de l'app, pastilles inchangées.
    const band = themeCssVars(custom({ look: { cards: 'band' } }), 'light', { appAccent: '#0072c6' });
    assert.equal(band['--stats-card-band'], '#0072c6');
    assert.equal(band['--stats-badge-bg'], undefined);
    assert.ok(contrastRatio(readableOn('#f0e442', '#ffffff'), '#ffffff') >= 4.5);
});

test('dupliquer un thème fourni garde son allure et sa couleur de repères', () => {
    const copy = duplicateTheme(builtinTheme('vivid'), { mode: 'light', newId: () => 'abcdef03', name: 'V' });
    assert.deepEqual(copy.look, themeLook(builtinTheme('vivid')));
    assert.equal(copy.accent, builtinTheme('vivid').light.accent);
    // L'allure compte dans l'identité d'un thème importé.
    const reused = adoptTheme([copy], { ...exportTheme(copy), look: { ...copy.look, bars: 'pill' } }, { newId: () => 'abcdef04' });
    assert.equal(reused.id, 'abcdef04');
});

test('types : au ton du thème (adoucies, atténuées), Okabe-Ito pour Daltonisme', () => {
    const defaults = { 'Traditional Cache': '#008000', 'Event Cache': '#FF0000' };
    // Défaut et Vives : les couleurs de la carte, même objet.
    assert.equal(themeTypeColors(builtinTheme('vivid'), defaults), defaults);
    const soft = themeTypeColors(builtinTheme('pastel'), defaults, 'light');
    assert.ok(contrastRatio(soft['Traditional Cache'], '#ffffff') < contrastRatio('#008000', '#ffffff'));
    // Atténuées : moins saturées, même famille (le vert reste vert).
    const muted = themeTypeColors(builtinTheme('earth'), defaults);
    assert.notEqual(muted['Event Cache'], '#FF0000');
    assert.ok(colorDistance(muted['Traditional Cache'], '#008000') < colorDistance(muted['Traditional Cache'], '#ff0000'));
    const cvd = themeTypeColors(builtinTheme('colorblind'), defaults);
    assert.equal(cvd['Traditional Cache'], '#009e73');
    assert.equal(cvd['Event Cache'], '#d55e00');
    // Thème personnel : ses couleurs par type par-dessus le ton.
    const mine = themeTypeColors(custom({ look: { types: 'soft' }, types: { 'Event Cache': '#123456' } }), defaults);
    assert.equal(mine['Event Cache'], '#123456');
    assert.notEqual(mine['Traditional Cache'], '#008000');
    // Dupliquer Daltonisme garde ses types.
    const copy = duplicateTheme(builtinTheme('colorblind'), { newId: () => 'abcdef05', name: 'C' });
    assert.equal(copy.types['Traditional Cache'], '#009e73');
});
