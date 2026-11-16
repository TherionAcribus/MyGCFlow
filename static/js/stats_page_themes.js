// Page Statistiques : thèmes de couleurs — application au tableau affiché
// (variables --chart-* posées sur <html>, jetons relus, couleurs des types)
// et panneau « Couleurs » (choix pour la page et pour le tableau, thèmes
// personnels, éditeur avec aperçu en direct). Modèle pur :
// stats_theme_model.mjs ; plan : MyGCFlow_Plan_Themes_Statistiques.md.

import { showConfirmation, t } from './notifications.js';
import { newChartId } from './chart_spec.mjs';
import {
    BUILTIN_THEMES, DEFAULT_THEME_ID, LOOK_CHOICES, MAX_THEMES, THEME_CSS_VARS, THEME_HEAT,
    duplicateTheme, effectiveThemeId, findTheme, heatRamp, lookTokens, normalizeHex, resolveTheme, themeCssVars,
    themeLook, themeTypeColors, themeWarnings, uniqueThemeName,
} from './stats_theme_model.mjs';
import { renderAllCharts } from './stats_page_cards.js';
import { renderPreview } from './stats_page_editor.js';
import { showSlide } from './stats_page_present.js';
import { scheduleSave } from './stats_page_save.js';
import { $, readTokens, state } from './stats_page_state.js';
import { getBsOffcanvas } from './ui_bootstrap.js';

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export const colorMode = () => (document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light');

const activeOf = (doc) => doc.dashboards.find((d) => d.id === doc.active) || doc.dashboards[0];

// Thème montré : celui en cours de modification (aperçu), sinon celui du
// tableau affiché.
export function shownTheme() {
    if (state.themeEdit) return state.themeEdit.theme;
    if (!state.doc) return findTheme([], DEFAULT_THEME_ID);
    return findTheme(state.doc.themes, effectiveThemeId(state.doc, activeOf(state.doc)));
}

// Pose les couleurs du thème montré et relit les jetons. Renvoie true quand
// quelque chose a changé (les graphiques sont alors à redessiner :
// tokensRev avance). Mode clair / sombre compris : un thème fourni a ses
// deux variantes, un dégradé généré dépend du fond.
export function applyChartTheme() {
    const theme = shownTheme();
    const mode = colorMode();
    const vars = themeCssVars(theme, mode, { appAccent: appAccent() });
    const types = themeTypeColors(theme, state.typeColors, mode);
    const look = themeLook(theme);
    const key = JSON.stringify([mode, vars, look, theme?.types || null, Object.keys(state.typeColors).length]);
    if (key === state.themeKey && state.tokens) return false;
    const style = document.documentElement.style;
    for (const name of THEME_CSS_VARS) {
        if (vars?.[name]) style.setProperty(name, vars[name]);
        else style.removeProperty(name);
    }
    // Même objet tant que les couleurs des types ne changent pas :
    // distinctTypeColors mémorise ses nuances par objet.
    if (JSON.stringify(types) !== JSON.stringify(state.chartTypeColors)) state.chartTypeColors = types;
    state.themeKey = key;
    // Allure : réglages du dessin (chart_echarts.mjs › lookOf).
    state.tokens = { ...readTokens(), look: lookTokens(look) };
    state.tokensRev += 1;
    return true;
}

// Couleur de repères de l'app (bandeau d'un thème qui n'en choisit pas),
// lue sans les variables d'un thème : --color-accent n'en dépend pas.
function appAccent() {
    return getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || null;
}

// Thème appliqué puis tout ce qui est dessiné redessiné.
export function refreshChartTheme() {
    if (!applyChartTheme()) return;
    if (state.ready) renderAllCharts();
    if (state.editor) renderPreview();
    if (state.present) showSlide(state.present.index, { animate: false });
}

// Redessin pendant un glissement dans le sélecteur de couleur : une fois
// par image au plus.
let refreshFrame = 0;
function refreshSoon() {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(refreshChartTheme);
}

// ---------------------------------------------------------------------------
// Noms
// ---------------------------------------------------------------------------

const BUILTIN_NAMES = {
    default: () => t('Défaut'),
    pastel: () => t('Pastel'),
    vivid: () => t('Vives'),
    earth: () => t('Terre'),
    ocean: () => t('Océan'),
    colorblind: () => t('Daltonisme'),
};

export function themeName(theme) {
    if (!theme) return '';
    if (theme.builtin) return BUILTIN_NAMES[theme.id]?.() || theme.id;
    return theme.name || t('Mon thème');
}

// Allure : intitulé de chaque réglage et de chacun de ses choix
// (stats_theme_model.mjs › LOOK_CHOICES).
const LOOK_LABELS = {
    bars: () => [t('Barres'), { rounded: t('Arrondies'), square: t('Carrées'), pill: t('En pilule') }],
    barWidth: () => [t('Largeur des barres'), { normal: t('Normales'), thin: t('Fines'), wide: t('Larges') }],
    lines: () => [t('Courbes'), { normal: t('Normales'), thin: t('Fines'), bold: t('Épaisses') }],
    points: () => [t('Points des courbes'), { circle: t('Ronds'), square: t('Carrés'), diamond: t('Losanges'), none: t('Aucun') }],
    area: () => [t('Aires'), { light: t('Légères'), medium: t('Moyennes'), strong: t('Marquées') }],
    donut: () => [t('Anneaux'), { normal: t('Normaux'), thin: t('Fins'), thick: t('Épais') }],
    cards: () => [t('Cartes du tableau'), { plain: t('Simples'), tinted: t('Teintées'), band: t('Bandeau de couleur'), outline: t('Contour coloré') }],
    corners: () => [t('Coins des cartes'), { soft: t('Arrondis'), square: t('Carrés'), round: t('Très arrondis') }],
    types: () => [t('Couleurs des types'), { map: t('Couleurs de la carte'), soft: t('Adoucies'), muted: t('Atténuées') }],
};

// ---------------------------------------------------------------------------
// Panneau : choix et liste
// ---------------------------------------------------------------------------

function themeOptions(select, value, { inherit = null } = {}) {
    select.replaceChildren();
    if (inherit) select.append(new Option(inherit, ''));
    const fixed = document.createElement('optgroup');
    fixed.label = t('Thèmes fournis');
    for (const theme of BUILTIN_THEMES) fixed.append(new Option(themeName(theme), theme.id));
    select.append(fixed);
    if (state.doc.themes.length) {
        const mine = document.createElement('optgroup');
        mine.label = t('Mes thèmes');
        for (const theme of state.doc.themes) mine.append(new Option(themeName(theme), theme.id));
        select.append(mine);
    }
    select.value = value;
}

// Bande de couleurs d'un thème (variante du mode affiché) : les séries,
// puis le dégradé.
function swatchStrip(theme) {
    const colors = resolveTheme(theme, colorMode());
    const strip = document.createElement('span');
    strip.className = 'stats-theme-strip';
    strip.setAttribute('aria-hidden', 'true');
    for (const color of colors.series) {
        const cell = document.createElement('span');
        cell.style.background = color;
        strip.append(cell);
    }
    const ramp = document.createElement('span');
    ramp.className = 'stats-theme-strip-ramp';
    ramp.style.background = `linear-gradient(90deg, ${colors.heat.join(', ')})`;
    strip.append(ramp);
    return strip;
}

function iconButton(action, icon, label, { danger = false, disabled = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost-secondary btn-icon btn-sm' + (danger ? ' text-danger' : '');
    button.dataset.themeAction = action;
    button.disabled = disabled;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>`;
    return button;
}

// Où va un thème cliqué dans la liste : là où le choix actuel est posé —
// le tableau s'il a ses propres couleurs, sinon toute la page.
const pickTarget = (dashboard) => (dashboard.theme ? 'dashboard' : 'page');

function pickTheme(theme) {
    const dashboard = activeOf(state.doc);
    if (pickTarget(dashboard) === 'dashboard') dashboard.theme = theme.id;
    else state.doc.theme = theme.id === DEFAULT_THEME_ID ? null : theme.id;
    scheduleSave({ immediate: true });
    refreshChartTheme();
    renderColorsPanel();
}

function renderThemeList() {
    const list = $('statsThemeList');
    list.replaceChildren();
    const dashboard = activeOf(state.doc);
    const shownId = effectiveThemeId(state.doc, dashboard);
    const full = state.doc.themes.length >= MAX_THEMES;
    for (const theme of [...BUILTIN_THEMES, ...state.doc.themes]) {
        const li = document.createElement('li');
        li.className = 'stats-theme-item' + (theme.id === shownId ? ' is-shown' : '');
        li.dataset.themeId = theme.id;
        const name = document.createElement('span');
        name.className = 'stats-theme-name';
        name.textContent = themeName(theme);
        const badges = document.createElement('span');
        badges.className = 'stats-theme-badges';
        const badge = (text) => {
            const b = document.createElement('span');
            b.className = 'badge bg-secondary-lt';
            b.textContent = text;
            badges.append(b);
        };
        if (theme.id === (state.doc.theme || DEFAULT_THEME_ID)) badge(t('Page'));
        if (theme.id === dashboard.theme) badge(t('Ce tableau'));
        const head = document.createElement('span');
        head.className = 'stats-theme-head';
        head.append(name, badges);
        // Nom et bande de couleurs : un bouton qui applique le thème.
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'stats-theme-pick';
        pick.dataset.themeAction = 'pick';
        pick.setAttribute('aria-pressed', String(theme.id === shownId));
        pick.title = pickTarget(dashboard) === 'dashboard'
            ? t('Appliquer « ${name} » à ce tableau de bord', { name: themeName(theme) })
            : t('Appliquer « ${name} » à toute la page', { name: themeName(theme) });
        pick.append(head, swatchStrip(theme));
        const actions = document.createElement('span');
        actions.className = 'stats-theme-actions';
        if (!theme.builtin) actions.append(iconButton('edit', 'ti-pencil', t('Modifier « ${name} »', { name: themeName(theme) })));
        actions.append(iconButton('duplicate', 'ti-copy', t('Dupliquer « ${name} »', { name: themeName(theme) }), { disabled: full }));
        if (!theme.builtin) actions.append(iconButton('delete', 'ti-trash', t('Supprimer « ${name} »', { name: themeName(theme) }), { danger: true }));
        li.append(pick, actions);
        list.append(li);
    }
    $('statsThemeListHint').textContent = pickTarget(dashboard) === 'dashboard'
        ? t("Cliquez un thème pour l'appliquer à ce tableau de bord.")
        : t("Cliquez un thème pour l'appliquer à toute la page.");
    $('btnStatsThemeNew').disabled = full;
    $('btnStatsThemeNew').title = full ? t('${n} thèmes au plus.', { n: MAX_THEMES }) : '';
}

export function renderColorsPanel() {
    if (!state.doc || !state.colorsOpen) return;
    const dashboard = activeOf(state.doc);
    themeOptions($('statsThemePage'), state.doc.theme || DEFAULT_THEME_ID);
    const pageTheme = findTheme(state.doc.themes, state.doc.theme || DEFAULT_THEME_ID);
    themeOptions($('statsThemeDashboard'), dashboard.theme || '', {
        inherit: t('Comme la page (${name})', { name: themeName(pageTheme) }),
    });
    $('statsThemeDashboardLabel').textContent = t('Ce tableau de bord : ${name}', { name: dashboard.name || t('Mon tableau de bord') });
    if (state.themeEdit) renderEditor();
    else renderThemeList();
}

export function openColorsPanel() {
    const panel = getBsOffcanvas('statsColorsPanel');
    if (!panel) return;
    panel.show();
}

function onPageThemeChange() {
    const id = $('statsThemePage').value;
    state.doc.theme = id === DEFAULT_THEME_ID ? null : id;
    scheduleSave({ immediate: true });
    refreshChartTheme();
    renderColorsPanel();
}

function onDashboardThemeChange() {
    activeOf(state.doc).theme = $('statsThemeDashboard').value || null;
    scheduleSave({ immediate: true });
    refreshChartTheme();
    renderColorsPanel();
}

// Nouveau thème : copie du thème affiché, qui le remplace là où il était
// choisi (tableau, sinon page) — on part de ce qu'on voit.
function newTheme() {
    if (state.doc.themes.length >= MAX_THEMES) return;
    const dashboard = activeOf(state.doc);
    const theme = createCopy(shownTheme(), t('Mon thème'));
    if (dashboard.theme) dashboard.theme = theme.id;
    else state.doc.theme = theme.id;
    scheduleSave({ immediate: true });
    openEditor(theme);
}

function createCopy(source, name) {
    const theme = duplicateTheme(source, {
        mode: colorMode(),
        newId: newChartId,
        name: uniqueThemeName(state.doc.themes, name),
    });
    state.doc.themes.push(theme);
    return theme;
}

function deleteTheme(theme) {
    showConfirmation(
        t('Supprimer le thème « ${name} » ? Les tableaux qui l\'utilisent reprendront les couleurs de la page.', { name: themeName(theme) }),
        t('Supprimer le thème'),
        () => {
            state.doc.themes = state.doc.themes.filter((other) => other.id !== theme.id);
            if (state.doc.theme === theme.id) state.doc.theme = null;
            for (const dashboard of state.doc.dashboards) {
                if (dashboard.theme === theme.id) dashboard.theme = null;
            }
            scheduleSave({ immediate: true });
            refreshChartTheme();
            renderColorsPanel();
        },
        null,
        { danger: true, confirmText: t('Supprimer') },
    );
}

function onThemeListClick(event) {
    const button = event.target.closest('[data-theme-action]');
    if (!button) return;
    const theme = findTheme(state.doc.themes, button.closest('[data-theme-id]').dataset.themeId);
    if (!theme) return;
    const action = button.dataset.themeAction;
    if (action === 'pick') pickTheme(theme);
    if (action === 'edit') openEditor(theme);
    if (action === 'delete') deleteTheme(theme);
    if (action === 'duplicate' && state.doc.themes.length < MAX_THEMES) {
        const copy = createCopy(theme, t('${name} (copie)', { name: themeName(theme) }));
        scheduleSave({ immediate: true });
        openEditor(copy);
    }
}

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------

// state.themeEdit = { theme, snapshot } : `theme` est l'objet du document,
// modifié en place ; `snapshot` sert à « Annuler les modifications ».
function openEditor(theme) {
    state.themeEdit = { theme, snapshot: structuredClone(theme) };
    $('statsColorsChoice').hidden = true;
    $('statsThemeEditor').hidden = false;
    renderEditor();
    refreshChartTheme();
    $('statsThemeName').focus();
}

export function closeEditor() {
    if (!state.themeEdit) return;
    state.themeEdit = null;
    $('statsThemeEditor').hidden = true;
    $('statsColorsChoice').hidden = false;
    refreshChartTheme();
    renderColorsPanel();
}

function colorField(slot, index, color, label) {
    const wrap = document.createElement('label');
    wrap.className = 'stats-theme-swatch';
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'form-control form-control-color';
    input.value = color;
    input.dataset.slot = slot;
    input.dataset.index = String(index);
    input.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(input, text);
    return wrap;
}

function renderEditor() {
    const { theme } = state.themeEdit;
    const name = $('statsThemeName');
    if (document.activeElement !== name) name.value = theme.name;
    const dashboard = activeOf(state.doc);
    $('statsThemeApply').hidden = effectiveThemeId(state.doc, dashboard) === theme.id;

    $('statsThemeSeries').replaceChildren(...theme.series.map((color, i) =>
        colorField('series', i, color, t('Teinte ${n}', { n: i + 1 }))));

    const auto = !theme.heat.colors;
    $('statsThemeHeatAuto').checked = auto;
    $('statsThemeHeatCustom').checked = !auto;
    $('statsThemeHeat').replaceChildren(...(auto
        ? [colorField('heat-color', 0, theme.heat.color, t('Couleur du dégradé'))]
        : theme.heat.colors.map((color, i) => colorField('heat', i, color, t('Pas ${n}', { n: i + 1 })))));
    $('statsThemeRamp').style.background = `linear-gradient(90deg, ${resolveTheme(theme, colorMode()).heat.join(', ')})`;

    $('statsThemeDelta').replaceChildren(
        colorField('up', 0, theme.up, t('Hausse')),
        colorField('down', 0, theme.down, t('Baisse')));

    renderLook(theme);

    const custom = Boolean(theme.types);
    $('statsThemeTypesCustom').checked = custom;
    $('statsThemeTypes').hidden = !custom;
    $('statsThemeTypes').replaceChildren(...(custom
        ? Object.keys(state.typeColors).map((type) => colorField('type', type,
            theme.types[type] || normalizeHex(state.typeColors[type]) || '#808080',
            state.labels.filterValue('cache_type', type)))
        : []));

    renderWarnings(theme);
    $('btnStatsThemeRevert').disabled = JSON.stringify(theme) === JSON.stringify(state.themeEdit.snapshot);
}

function renderLook(theme) {
    const look = themeLook(theme);
    $('statsThemeLook').replaceChildren(...Object.entries(LOOK_CHOICES).map(([key, choices]) => {
        const [label, names] = LOOK_LABELS[key]();
        const row = document.createElement('label');
        row.className = 'stats-theme-look-row';
        const text = document.createElement('span');
        text.textContent = label;
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm';
        select.dataset.look = key;
        for (const choice of choices) select.append(new Option(names[choice], choice));
        select.value = look[key];
        row.append(text, select);
        return row;
    }));
    const accent = Boolean(theme.accent);
    $('statsThemeAccentCustom').checked = accent;
    $('statsThemeAccent').hidden = !accent;
    $('statsThemeAccent').replaceChildren(...(accent ? [colorField('accent', 0, theme.accent, t('Repères'))] : []));
}

function renderWarnings(theme) {
    const box = $('statsThemeWarnings');
    const modeName = (mode) => (mode === 'dark' ? t('sur fond sombre') : t('sur fond clair'));
    const slotName = (w) => (w.slot === 'up' ? t('Hausse') : w.slot === 'down' ? t('Baisse') : t('Teinte ${n}', { n: w.index + 1 }));
    const lines = themeWarnings(theme).map((w) => (w.kind === 'faint'
        ? t('${slot} : peu visible ${mode}.', { slot: slotName(w), mode: modeName(w.mode) })
        : t('Teintes ${a} et ${b} : presque identiques.', { a: w.index + 1, b: w.other + 1 })));
    box.hidden = !lines.length;
    box.replaceChildren(...lines.map((text) => {
        const p = document.createElement('p');
        p.className = 'mb-1';
        p.innerHTML = '<i class="ti ti-alert-triangle me-1" aria-hidden="true"></i>';
        p.append(document.createTextNode(text));
        return p;
    }));
}

// Une modification : le thème du document change en place, l'aperçu suit,
// l'écriture part débouncée (glissement dans un sélecteur de couleur).
function changed({ rerender = false } = {}) {
    scheduleSave();
    refreshSoon();
    if (rerender) renderEditor();
    else {
        renderWarnings(state.themeEdit.theme);
        $('statsThemeRamp').style.background = `linear-gradient(90deg, ${resolveTheme(state.themeEdit.theme, colorMode()).heat.join(', ')})`;
        $('btnStatsThemeRevert').disabled = JSON.stringify(state.themeEdit.theme) === JSON.stringify(state.themeEdit.snapshot);
    }
}

function onEditorInput(event) {
    if (!state.themeEdit) return;
    const { theme } = state.themeEdit;
    const input = event.target;
    if (input.id === 'statsThemeName') {
        theme.name = Array.from(input.value.replace(/[\r\n\t]+/g, ' ')).slice(0, 40).join('');
        changed();
        return;
    }
    if (input.type !== 'color') return;
    const color = normalizeHex(input.value);
    if (!color) return;
    const index = Number(input.dataset.index);
    switch (input.dataset.slot) {
        case 'series': theme.series[index] = color; break;
        case 'heat': theme.heat.colors[index] = color; break;
        case 'heat-color': theme.heat.color = color; break;
        case 'up': theme.up = color; break;
        case 'accent': theme.accent = color; break;
        case 'down': theme.down = color; break;
        // Type : son nom en guise de rang (clé du thème).
        case 'type': theme.types[input.dataset.index] = color; break;
        default: return;
    }
    changed();
}

function onEditorChange(event) {
    if (!state.themeEdit) return;
    const { theme } = state.themeEdit;
    const input = event.target;
    if (input.name === 'statsThemeHeatMode') {
        // Passage d'un mode à l'autre : on part du dégradé affiché.
        theme.heat = input.value === 'custom'
            ? { colors: resolveTheme(theme, colorMode()).heat.slice(0, THEME_HEAT) }
            : { color: theme.heat.colors?.[2] || heatRamp('#3987e5')[2] };
        changed({ rerender: true });
    } else if (input.dataset.look) {
        theme.look = { ...themeLook(theme), [input.dataset.look]: input.value };
        changed();
    } else if (input.id === 'statsThemeAccentCustom') {
        // Point de départ : la première teinte des séries.
        theme.accent = input.checked ? theme.series[0] : null;
        changed({ rerender: true });
    } else if (input.id === 'statsThemeTypesCustom') {
        // Point de départ : les couleurs affichées (ton de l'allure compris).
        const shown = themeTypeColors({ ...theme, types: null }, state.typeColors, colorMode());
        theme.types = input.checked
            ? Object.fromEntries(Object.entries(shown).map(([type, c]) => [type, normalizeHex(c) || '#808080']))
            : null;
        changed({ rerender: true });
    } else if (input.id === 'statsThemeName' && !theme.name.trim()) {
        theme.name = uniqueThemeName(state.doc.themes.filter((other) => other !== theme), t('Mon thème'));
        input.value = theme.name;
        changed();
    }
}

function revertTheme() {
    if (!state.themeEdit) return;
    const { theme, snapshot } = state.themeEdit;
    Object.assign(theme, structuredClone(snapshot));
    scheduleSave({ immediate: true });
    renderEditor();
    refreshChartTheme();
}

function onApplyClick(event) {
    const target = event.target.closest('[data-apply]')?.dataset.apply;
    if (!target || !state.themeEdit) return;
    const { id } = state.themeEdit.theme;
    if (target === 'page') {
        state.doc.theme = id;
        // « Toute la page » : le tableau affiché la suit.
        activeOf(state.doc).theme = null;
    } else {
        activeOf(state.doc).theme = id;
    }
    scheduleSave({ immediate: true });
    renderEditor();
}

// ---------------------------------------------------------------------------
// Câblage
// ---------------------------------------------------------------------------

export function bindColorsPanel() {
    $('btnStatsColors').addEventListener('click', openColorsPanel);
    const panel = $('statsColorsPanel');
    panel.addEventListener('show.bs.offcanvas', () => {
        state.colorsOpen = true;
        document.body.classList.add('stats-colors-open');
        renderColorsPanel();
    });
    panel.addEventListener('hidden.bs.offcanvas', () => {
        state.colorsOpen = false;
        document.body.classList.remove('stats-colors-open');
        closeEditor();
    });
    $('statsThemePage').addEventListener('change', onPageThemeChange);
    $('statsThemeDashboard').addEventListener('change', onDashboardThemeChange);
    $('btnStatsThemeNew').addEventListener('click', newTheme);
    $('statsThemeList').addEventListener('click', onThemeListClick);
    $('btnStatsThemeBack').addEventListener('click', closeEditor);
    $('btnStatsThemeRevert').addEventListener('click', revertTheme);
    $('statsThemeApply').addEventListener('click', onApplyClick);
    const editor = $('statsThemeEditor');
    editor.addEventListener('input', onEditorInput);
    editor.addEventListener('change', onEditorChange);
    editor.addEventListener('submit', (event) => event.preventDefault());
}

// ---------------------------------------------------------------------------
// Fond des exports (image du tableau, PNG / SVG d'un graphique, vidéo)
// ---------------------------------------------------------------------------

// « Comme l'écran », clair ou sombre, quel que soit le mode affiché.
// Préférence locale au navigateur, comme les réglages de la vidéo.
export const EXPORT_BACKGROUNDS = Object.freeze(['screen', 'light', 'dark']);
const EXPORT_BACKGROUND_KEY = 'statsExportBackground';

export function exportBackground() {
    try {
        const value = localStorage.getItem(EXPORT_BACKGROUND_KEY);
        return EXPORT_BACKGROUNDS.includes(value) ? value : 'screen';
    } catch (_) {
        return 'screen';
    }
}

export function setExportBackground(value) {
    if (!EXPORT_BACKGROUNDS.includes(value)) return;
    try { localStorage.setItem(EXPORT_BACKGROUND_KEY, value); } catch (_) { /* quota, navigation privée */ }
}

// Mode d'un export ; null = celui de l'écran, rien à basculer.
export function exportMode() {
    const value = exportBackground();
    return value === 'screen' || value === colorMode() ? null : value;
}

// Pose un mode sur <html> (attribut, variables du thème) et ses jetons ;
// renvoie de quoi revenir. `state.exportMode` fait ignorer la bascule au
// suivi du mode (stats_page.js › watchTheme) : rien n'est redessiné.
function enterMode(mode) {
    const root = document.documentElement;
    const saved = {
        attr: root.getAttribute('data-bs-theme'),
        vars: THEME_CSS_VARS.map((name) => [name, root.style.getPropertyValue(name)]),
        tokens: state.tokens,
        types: state.chartTypeColors,
    };
    state.exportMode = mode;
    root.setAttribute('data-bs-theme', mode);
    const theme = shownTheme();
    const vars = themeCssVars(theme, mode, { appAccent: appAccent() });
    for (const name of THEME_CSS_VARS) {
        if (vars?.[name]) root.style.setProperty(name, vars[name]);
        else root.style.removeProperty(name);
    }
    state.tokens = { ...readTokens(), look: lookTokens(themeLook(theme)) };
    state.chartTypeColors = themeTypeColors(theme, state.typeColors, mode);
    return saved;
}

function leaveMode(saved) {
    const root = document.documentElement;
    if (saved.attr === null) root.removeAttribute('data-bs-theme');
    else root.setAttribute('data-bs-theme', saved.attr);
    for (const [name, value] of saved.vars) {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
    }
    state.tokens = saved.tokens;
    state.chartTypeColors = saved.types;
    state.exportMode = null;
}

// Jetons et couleurs des types d'un mode (vidéo : figés au lancement). Lus
// par une bascule aller-retour dans la même tâche : le navigateur ne
// repeint rien entre les deux.
export function colorsForMode(mode) {
    if (!mode) return { tokens: state.tokens || readTokens(), typeColors: state.chartTypeColors || state.typeColors };
    const saved = enterMode(mode);
    const colors = { tokens: state.tokens, typeColors: state.chartTypeColors };
    leaveMode(saved);
    return colors;
}

// Travail fait dans le mode de l'export (image du tableau : styles du DOM
// relus). `work` ne doit attendre que des promesses déjà résolues — pas
// de tâche entre la bascule et le retour, donc pas de clignotement : les
// polices sont attendues avant.
export async function inExportMode(work) {
    const mode = exportMode();
    if (!mode) return work();
    await document.fonts?.ready;
    const saved = enterMode(mode);
    try {
        return await work();
    } finally {
        leaveMode(saved);
    }
}

// Relevé E2E : thèmes du document, thème montré, couleurs lues.
export function themeSnapshot() {
    if (!state.doc) return null;
    const dashboard = activeOf(state.doc);
    return {
        page: state.doc.theme,
        dashboard: dashboard.theme,
        shown: shownTheme()?.id ?? null,
        editing: state.themeEdit?.theme.id ?? null,
        mode: colorMode(),
        themes: state.doc.themes.map((theme) => ({ id: theme.id, name: theme.name })),
        series: state.tokens ? [...state.tokens.series] : null,
        heat: state.tokens ? [...state.tokens.heat] : null,
        up: state.tokens?.up ?? null,
        down: state.tokens?.down ?? null,
        typeColors: state.chartTypeColors && state.chartTypeColors !== state.typeColors ? { ...state.chartTypeColors } : null,
        open: Boolean(state.colorsOpen),
        // Fond des exports : 'screen' | 'light' | 'dark'.
        exportBackground: exportBackground(),
    };
}
