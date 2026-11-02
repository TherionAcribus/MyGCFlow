// Onglet Style › Pseudos de la page Mes poses (templates/menu_names.html) :
// réglages du thème `points.poses_names` (pkg.options.point.posesNames,
// normalisé par poses_names.mjs) et préférence globale
// `poses_names_privacy` (sauvegarde automatique).
//
// Les réglages s'appliquent tout de suite : l'apparence des étiquettes est
// relue à chaque image (name_labels.mjs), l'aperçu en boucle suit donc la
// saisie. Le suivi « thème modifié » de profiles.js voit les changements
// (écoute de #style) ; rien à faire ici pour la sauvegarde du thème.
//
// S'initialise au jalon mygcflow:ready (cf. stats_ui.js) : ui.js appelle ses
// init pendant sa propre évaluation, avant celle de ce module.

import * as pkg from './index.js';
import { isPosesPage } from './app_mode.mjs';
import { reportSave } from './saved_indicator.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import {
    normalizeNamesPrivacy,
    normalizePosesNames,
    posesNamesPresetOf,
    withPosesNamesPreset,
} from './poses_names.mjs';

// [id du champ, chemin dans le bloc, nature]
function namesFields() {
    return [
        ['posesNamesEnabled', 'enabled', 'check'],
        ['posesNamesKindFind', 'kinds.find', 'check'],
        ['posesNamesKindDnf', 'kinds.dnf', 'check'],
        ['posesNamesKindNote', 'kinds.note', 'check'],
        ['posesNamesOnlyNotable', 'only_notable', 'check'],
        ['posesNamesLoyalMin', 'loyal_min', 'value'],
        ['posesNamesBadges', 'badges', 'check'],
        ['posesNamesTemplate', 'template', 'value'],
        ['posesNamesMaxVisible', 'max_visible', 'value'],
        ['posesNamesGrouping', 'grouping', 'value'],
        ['posesNamesStagger', 'stagger_ms', 'value'],
        ['posesNamesAvoidOverlap', 'avoid_overlap', 'check'],
        ['posesNamesEmphasis', 'emphasis', 'value'],
        ['posesNamesPath', 'path', 'value'],
        ['posesNamesDirection', 'direction', 'value'],
        ['posesNamesTrajectory', 'trajectory', 'value'],
        ['posesNamesEasing', 'easing', 'value'],
        ['posesNamesDistance', 'distance', 'value'],
        ['posesNamesEntrance', 'entrance', 'value'],
        ['posesNamesExit', 'exit', 'value'],
        ['posesNamesDuration', 'duration_ms', 'value'],
        ['posesNamesOffsetY', 'offset_y', 'value'],
        ['posesNamesWobble', 'wobble', 'value'],
        ['posesNamesTilt', 'tilt', 'value'],
        ['posesNamesConnector', 'connector', 'check'],
        ['posesNamesFont', 'font', 'value'],
        ['posesNamesSize', 'size', 'value'],
        ['posesNamesBold', 'bold', 'check'],
        ['posesNamesItalic', 'italic', 'check'],
        ['posesNamesUppercase', 'uppercase', 'check'],
        ['posesNamesOpacity', 'opacity', 'value'],
        ['posesNamesColorMode', 'color_mode', 'value'],
        ['posesNamesColor', 'color', 'value'],
        ['posesNamesColorFind', 'kind_colors.find', 'value'],
        ['posesNamesColorFtf', 'kind_colors.ftf', 'value'],
        ['posesNamesColorMilestone', 'kind_colors.milestone', 'value'],
        ['posesNamesColorFavorite', 'kind_colors.favorite', 'value'],
        ['posesNamesColorLoyal', 'kind_colors.loyal', 'value'],
        ['posesNamesColorDnf', 'kind_colors.dnf', 'value'],
        ['posesNamesColorNote', 'kind_colors.note', 'value'],
        ['posesNamesOutlineWidth', 'outline_width', 'value'],
        ['posesNamesOutlineColor', 'outline_color', 'value'],
        ['posesNamesGlow', 'glow', 'value'],
        ['posesNamesGlowColor', 'glow_color', 'value'],
        ['posesNamesBackground', 'background', 'value'],
        ['posesNamesBackgroundColor', 'background_color', 'value'],
        ['posesNamesBackgroundOpacity', 'background_opacity', 'value'],
    ];
}

const $ = (id) => document.getElementById(id);

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
        o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
}

function currentNames() {
    return normalizePosesNames(pkg.options?.point?.posesNames);
}

function readNamesUI() {
    const raw = {};
    for (const [id, path, kind] of namesFields()) {
        const el = $(id);
        if (!el) continue;
        setPath(raw, path, kind === 'check' ? el.checked === true : el.value);
    }
    return normalizePosesNames(raw, currentNames());
}

function commitNames(names) {
    if (!pkg.options?.point) return;
    pkg.options.point.posesNames = names;
    syncPosesNamesUI();
    pkg.refreshPosesNamesStyle?.();
}

// Champs ← réglages du thème (thème appliqué, préréglage, normalisation).
export function syncPosesNamesUI() {
    if (!$('posesNamesEnabled')) return;
    const names = currentNames();
    for (const [id, path, kind] of namesFields()) {
        const el = $(id);
        if (!el) continue;
        const value = getPath(names, path);
        if (kind === 'check') el.checked = value === true;
        // Ne pas réécrire le champ texte en cours de saisie (curseur).
        else if (!(el === document.activeElement && el.type === 'text')) el.value = String(value);
    }
    const preset = $('selectPosesNamesPreset');
    if (preset) preset.value = posesNamesPresetOf(names) || '';
    // Réglages sans objet masqués ou grisés.
    const mode = names.color_mode;
    const colorRow = $('posesNamesColorRow');
    if (colorRow) colorRow.hidden = mode === 'event' || mode === 'finder';
    const kindColors = $('posesNamesKindColors');
    if (kindColors) kindColors.hidden = mode !== 'event';
    const bgColor = $('posesNamesBackgroundColor');
    if (bgColor) bgColor.disabled = names.background === 'none';
    const bgOpacity = $('posesNamesBackgroundOpacityRow');
    if (bgOpacity) bgOpacity.hidden = names.background === 'none';
    const stagger = $('posesNamesStagger');
    if (stagger) stagger.disabled = names.grouping !== 'separate';
    const glowColor = $('posesNamesGlowColor');
    if (glowColor) glowColor.disabled = names.glow <= 0;
    const outlineColor = $('posesNamesOutlineColor');
    if (outlineColor) outlineColor.disabled = names.outline_width <= 0;
    for (const span of document.querySelectorAll('[data-names-value]')) {
        const field = $(span.dataset.namesValue);
        if (field) span.textContent = `${field.value}${span.dataset.namesUnit || ''}`;
    }
    syncPrivacyUI();
    syncPreviewButton();
}

// --- Aperçu -------------------------------------------------------------------

let previewTimer = null;

function syncPreviewButton() {
    const btn = $('btnPosesNamesPreview');
    if (!btn) return;
    const on = pkg.isPosesNamesPreviewActive?.() === true;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('btn-primary', on);
    const icon = btn.querySelector('i');
    if (icon) icon.className = `ti ${on ? 'ti-player-stop' : 'ti-player-play'} me-1`;
    // L'aperçu s'arrête de lui-même au lancement d'une lecture : le bouton
    // se resynchronise tant qu'il est allumé.
    if (on && !previewTimer) {
        previewTimer = setInterval(() => {
            if (pkg.isPosesNamesPreviewActive?.() !== true) {
                clearInterval(previewTimer);
                previewTimer = null;
                syncPreviewButton();
            }
        }, 500);
    }
}

// --- Confidentialité (préférence globale) ----------------------------------------

function currentPrivacy() {
    return normalizeNamesPrivacy(window.userSettings?.poses_names_privacy);
}

function syncPrivacyUI() {
    const privacy = currentPrivacy();
    const select = $('selectPosesNamesPrivacy');
    if (select) select.value = privacy.mode;
    const area = $('textareaPosesNamesExclude');
    if (area && area !== document.activeElement) area.value = privacy.exclude.join('\n');
}

async function savePrivacy(patch, field) {
    const before = currentPrivacy();
    const next = normalizeNamesPrivacy(patch, before);
    if (window.userSettings) window.userSettings.poses_names_privacy = next;
    syncPrivacyUI();
    pkg.refreshPosesNamesStyle?.();
    const ok = await reportSave(field, saveSettingsPatch({ poses_names_privacy: next }));
    if (!ok) {
        if (window.userSettings) window.userSettings.poses_names_privacy = before;
        syncPrivacyUI();
    }
}

// --- Liaison ------------------------------------------------------------------------

export function initPosesNamesUI() {
    if (!isPosesPage() || !$('posesNamesEnabled')) return;
    for (const [id, , kind] of namesFields()) {
        const el = $(id);
        if (!el) continue;
        el.addEventListener('change', () => commitNames(readNamesUI()));
        // Curseurs, couleurs et texte : rendu en direct pendant la saisie.
        if (kind === 'value' && (el.type === 'range' || el.type === 'color' || el.type === 'text')) {
            el.addEventListener('input', () => commitNames(readNamesUI()));
        }
    }
    $('selectPosesNamesPreset')?.addEventListener('change', (e) => {
        if (e.target.value) commitNames(withPosesNamesPreset(currentNames(), e.target.value));
    });
    $('btnPosesNamesPreview')?.addEventListener('click', () => {
        pkg.togglePosesNamesPreview?.();
        syncPreviewButton();
    });
    $('selectPosesNamesPrivacy')?.addEventListener('change', (e) => {
        savePrivacy({ mode: e.target.value }, e.target);
    });
    $('textareaPosesNamesExclude')?.addEventListener('change', (e) => {
        savePrivacy({ exclude: e.target.value }, e.target);
    });
    syncPosesNamesUI();
}

if (typeof window !== 'undefined') {
    if (window.mygcflowReady) initPosesNamesUI();
    else window.addEventListener('mygcflow:ready', initPosesNamesUI, { once: true });
}
