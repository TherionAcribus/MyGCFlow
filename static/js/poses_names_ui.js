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
import { lifecycleEngine } from './lifecycle_engine.mjs';
import { isPosesPage } from './app_mode.mjs';
import { reportSave } from './saved_indicator.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import {
    normalizeNamesPrivacy,
    normalizePosesNames,
    posesNamesNearestPreset,
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

// Case sans objet : grisée, la raison va aussi sur le label (la bulle d'un
// input disabled n'apparaît pas partout — motif disabledHint de dnf_data.js).
function disabledHint(boxId, off, text) {
    const box = $(boxId);
    if (box) box.disabled = off;
    for (const node of [box, box && document.querySelector(`label[for="${boxId}"]`)]) {
        if (!node) continue;
        if (off) node.title = text;
        else node.removeAttribute('title');
    }
}

// Avertissement de densité : au rythme courant, le jour le plus chargé peut
// produire plus d'étiquettes simultanées que le plafond — les moins
// marquantes seront écourtées ou écartées. Estimation haute : chaque log du
// lot vit duration_ms, et msPerDay sépare deux jours (les DNF et notes
// cochés s'ajoutent aux trouvailles comptées par findDayCounts). Recalculé
// à chaque changement de réglage ; pas quand seul le rythme change.
function syncDensityHint(names) {
    const el = $('posesNamesDensityHint');
    if (!el) return;
    el.hidden = true;
    if (!names?.enabled) return;
    const counts = lifecycleEngine()?.findDayCounts?.() || [];
    const peak = counts.reduce((m, [, n]) => Math.max(m, n), 0);
    const msPerDay = Math.max(1, Number(pkg.options?.animation?.timePerDay) || 1000);
    const concurrent = peak * (names.duration_ms / msPerDay);
    if (peak > 0 && concurrent > names.max_visible) {
        el.textContent = pkg.t('Au rythme actuel, le jour le plus chargé peut produire ~${n} étiquettes simultanées, au-delà du plafond de ${m} : les moins marquantes seront écourtées ou écartées.', { n: Math.ceil(concurrent), m: names.max_visible });
        el.hidden = false;
    }
}

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
    syncPresetButtons(names);
    // Réglages sans objet masqués ou grisés.
    const mode = names.color_mode;
    const colorRow = $('posesNamesColorRow');
    if (colorRow) colorRow.hidden = mode === 'event' || mode === 'finder';
    const kindColors = $('posesNamesKindColors');
    if (kindColors) kindColors.hidden = mode !== 'event';
    const colorHelp = $('helpPosesNamesColorMode');
    if (colorHelp) colorHelp.hidden = mode !== 'finder';
    const bgColor = $('posesNamesBackgroundColor');
    if (bgColor) bgColor.disabled = names.background === 'none';
    const bgOpacity = $('posesNamesBackgroundOpacityRow');
    if (bgOpacity) bgOpacity.hidden = names.background === 'none';
    const stagger = $('posesNamesStagger');
    if (stagger) stagger.disabled = names.grouping !== 'separate';
    const staggerRow = $('posesNamesStaggerRow');
    if (staggerRow) staggerRow.hidden = names.grouping !== 'separate';
    // Sur place : ni direction, ni trajectoire, ni allure, ni distance.
    for (const node of document.querySelectorAll('#posesNames [data-names-travel]')) {
        node.hidden = names.path === 'still';
    }
    const glowColor = $('posesNamesGlowColor');
    if (glowColor) glowColor.disabled = names.glow <= 0;
    const outlineColor = $('posesNamesOutlineColor');
    if (outlineColor) outlineColor.disabled = names.outline_width <= 0;
    // DNF et notes ne sont jamais « marquants » : cases sans objet tant que
    // le filtre est coché.
    const onlyNotable = names.only_notable === true;
    for (const id of ['posesNamesKindDnf', 'posesNamesKindNote']) {
        disabledHint(id, onlyNotable, pkg.t('Sans objet : un DNF ou une note n’est jamais un log marquant.'));
    }
    // Rappel quand l'interrupteur est éteint (l'aperçu reste utilisable).
    const disabledHintEl = $('posesNamesDisabledHint');
    if (disabledHintEl) disabledHintEl.hidden = names.enabled === true;
    syncDensityHint(names);
    for (const span of document.querySelectorAll('[data-names-value]')) {
        const field = $(span.dataset.namesValue);
        if (!field) continue;
        span.textContent = span.dataset.namesFormat === 'seconds'
            ? formatSeconds(field.value)
            : `${field.value}${span.dataset.namesUnit || ''}`;
    }
    syncSummaries(names);
    syncPrivacyUI();
    syncPreviewButton();
}

// Durée en secondes, une décimale, au format de la langue de la page.
function formatSeconds(ms) {
    const lang = document.documentElement.lang || undefined;
    const s = (Number(ms) || 0) / 1000;
    return `${s.toLocaleString(lang, { maximumFractionDigits: 1 })} s`;
}

// Libellé de l'option choisie d'un <select> (déjà traduit par le gabarit).
function optionText(id) {
    return $(id)?.selectedOptions?.[0]?.textContent.trim() || '';
}

function presetLabel(name) {
    return document.querySelector(`[data-names-preset="${name}"] .image-preset-label`)?.textContent.trim() || name;
}

// Cartes de style : celle que porte exactement le thème est enfoncée ; sinon
// le texte rappelle le style le plus proche.
function syncPresetButtons(names) {
    const exact = posesNamesPresetOf(names);
    for (const btn of document.querySelectorAll('#posesNames [data-names-preset]')) {
        const on = btn.dataset.namesPreset === exact;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const custom = $('posesNamesPresetCustom');
    if (!custom) return;
    custom.hidden = !!exact;
    if (!exact) {
        const nearest = posesNamesNearestPreset(names);
        const name = presetLabel(nearest?.name);
        custom.textContent = pkg.t('Style personnalisé, d’après « ${name} ». Cliquez un style pour repartir de lui.', { name });
    }
}

// Résumé des sections repliées : leurs valeurs courantes, pour juger d'un
// coup d'œil sans ouvrir (masqué à l'ouverture, cf. .stats-form-section).
function syncSummaries(names) {
    const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);
    const parts = {
        content: [names.template, names.badges ? pkg.t('symboles') : ''],
        density: [
            pkg.t('${n} au plus', { n: names.max_visible }),
            names.grouping === 'merge' ? pkg.t('regroupés') : pkg.t('un par visiteur'),
        ],
        motion: [
            names.path === 'still'
                ? optionText('posesNamesPath')
                : `${optionText('posesNamesPath')}, ${lower(optionText('posesNamesDirection'))}`,
            `${optionText('posesNamesEntrance')} / ${lower(optionText('posesNamesExit'))}`,
        ],
        look: [
            optionText('posesNamesFont'),
            optionText('posesNamesColorMode'),
            names.background === 'none' ? '' : optionText('posesNamesBackground'),
        ],
    };
    for (const span of document.querySelectorAll('#posesNames [data-names-summary]')) {
        span.textContent = (parts[span.dataset.namesSummary] || []).filter(Boolean).join(' · ');
    }
}

// Balise insérée au curseur du champ « Texte de l'étiquette ».
function insertTag(tag) {
    const field = $('posesNamesTemplate');
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.focus();
    field.setRangeText(tag, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
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
    for (const btn of document.querySelectorAll('#posesNames [data-names-preset]')) {
        btn.addEventListener('click', () => commitNames(withPosesNamesPreset(currentNames(), btn.dataset.namesPreset)));
    }
    for (const btn of document.querySelectorAll('#posesNames [data-names-tag]')) {
        btn.addEventListener('click', () => insertTag(btn.dataset.namesTag));
    }
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
