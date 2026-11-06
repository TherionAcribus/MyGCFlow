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
import { createNameLabels, drawNameLabels, nameFont, spawnNameLabels } from './name_labels.mjs';
import { THUMB_WAVE_GAP_MS, thumbCandidates, thumbLayout, thumbWaveMs } from './names_thumbs.mjs';

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
    renderPresetThumbs();
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

// --- Vignettes des styles ---------------------------------------------------------
// Chaque carte de style dessine un pseudo fictif dans ce style, avec le vrai
// moteur (names_thumbs.mjs) : image figée au repos, boucle au survol ou au
// focus clavier. Les réglages hors style (couleurs par événement, opacité…)
// sont ceux du thème : la vignette montre ce que donnerait le clic.

const thumbEntries = new WeakMap();
let thumbAnimating = null;
let thumbRaf = 0;
const thumbStats = { stills: 0, frames: 0 };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Prépare le canvas d'une carte : null tant qu'il n'a pas de taille (onglet
// masqué) — le ResizeObserver redessine à l'affichage.
function thumbFrame(btn) {
    const canvas = btn.querySelector('canvas');
    if (!canvas) return null;
    const box = canvas.parentElement;
    const width = box?.clientWidth || 0;
    const height = box?.clientHeight || 0;
    if (!width || !height) return null;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const names = withPosesNamesPreset(currentNames(), btn.dataset.namesPreset);
    // Cadrage mis en cache : recalculé seulement quand le style ou la taille
    // changent (les mesures de texte coûtent plus que le dessin).
    let entry = thumbEntries.get(btn);
    const key = `${JSON.stringify(names)}|${width}x${height}`;
    if (!entry || entry.key !== key) {
        const measure = (text, size) => {
            ctx.font = nameFont({ ...names, size });
            return ctx.measureText(text).width;
        };
        entry = { ...entry, key, layout: thumbLayout(names, { width, height, measure }) };
        thumbEntries.set(btn, entry);
    }
    return { canvas, ctx, dpr, entry };
}

function paintThumb(frame, state, now) {
    const { canvas, ctx, dpr, entry } = frame;
    const { k, anchor, opts } = entry.layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // La cache : un point sous l'étiquette, pour lire le trajet.
    const ax = anchor[0] * dpr;
    const ay = anchor[1] * dpr;
    ctx.beginPath();
    ctx.arc(ax, ay, 2.6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd54f';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = dpr;
    ctx.fill();
    ctx.stroke();
    drawNameLabels(ctx, state, { now, opts, ratio: k * dpr, toPixel: () => [ax, ay] });
    canvas.hidden = false;
    const icon = canvas.parentElement?.querySelector('.ti');
    if (icon) icon.hidden = true;
}

// Image figée : la première vague à mi-vie — en approche pour les pseudos
// qui arrivent sur la cache (posés, ils la masqueraient).
function drawThumbStill(btn) {
    const frame = thumbFrame(btn);
    if (!frame) return;
    const { opts } = frame.entry.layout;
    const state = createNameLabels();
    state.previewing = true;
    spawnNameLabels(state, thumbCandidates(opts, 0), { at: 0, opts, anchorOf: () => 'thumb' });
    paintThumb(frame, state, opts.duration_ms * (opts.path === 'toward' ? 0.3 : 0.5));
    thumbStats.stills++;
}

function renderPresetThumbs() {
    for (const btn of document.querySelectorAll('#posesNames [data-names-preset]')) {
        if (btn !== thumbAnimating) drawThumbStill(btn);
    }
}

function thumbTick(now) {
    thumbRaf = 0;
    const btn = thumbAnimating;
    if (!btn) return;
    const frame = thumbFrame(btn);
    if (!frame) {
        stopThumbAnimation();
        return;
    }
    const { entry } = frame;
    const { opts } = entry.layout;
    if (!entry.state) {
        entry.state = createNameLabels();
        entry.state.previewing = true;
        entry.wave = 0;
        entry.nextWave = now;
    }
    if (now >= entry.nextWave) {
        spawnNameLabels(entry.state, thumbCandidates(opts, entry.wave), { at: now, opts, anchorOf: () => 'thumb' });
        entry.wave++;
        entry.nextWave = now + thumbWaveMs(opts) + THUMB_WAVE_GAP_MS;
    }
    paintThumb(frame, entry.state, now);
    thumbStats.frames++;
    thumbRaf = requestAnimationFrame(thumbTick);
}

function startThumbAnimation(btn) {
    if (reducedMotion() || thumbAnimating === btn) return;
    stopThumbAnimation();
    thumbAnimating = btn;
    const entry = thumbEntries.get(btn);
    if (entry) entry.state = null;
    thumbRaf = requestAnimationFrame(thumbTick);
}

function stopThumbAnimation() {
    if (thumbRaf) cancelAnimationFrame(thumbRaf);
    thumbRaf = 0;
    const btn = thumbAnimating;
    thumbAnimating = null;
    if (btn) {
        const entry = thumbEntries.get(btn);
        if (entry) entry.state = null;
        drawThumbStill(btn);
    }
}

function bindPresetThumbs() {
    const list = $('posesNamesPresets');
    if (!list) return;
    for (const btn of list.querySelectorAll('[data-names-preset]')) {
        btn.addEventListener('pointerenter', () => startThumbAnimation(btn));
        btn.addEventListener('pointerleave', () => { if (thumbAnimating === btn) stopThumbAnimation(); });
        btn.addEventListener('focus', () => startThumbAnimation(btn));
        btn.addEventListener('blur', () => { if (thumbAnimating === btn) stopThumbAnimation(); });
    }
    // Onglet masqué au démarrage (canvas sans taille), polices locales
    // chargées après coup : redessiner quand l'un ou l'autre change.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => renderPresetThumbs()).observe(list);
    document.fonts?.ready?.then(() => renderPresetThumbs());
    document.fonts?.addEventListener?.('loadingdone', () => renderPresetThumbs());
}

// Relevé pour les tests : vignettes dessinées, carte animée, étiquettes en vol.
export function posesNamesThumbsSnapshot() {
    const drawn = [...document.querySelectorAll('#posesNames [data-names-preset] canvas')]
        .filter((c) => !c.hidden).length;
    const entry = thumbAnimating ? thumbEntries.get(thumbAnimating) : null;
    return {
        drawn,
        animating: thumbAnimating?.dataset.namesPreset || null,
        active: entry?.state?.labels.length || 0,
        stills: thumbStats.stills,
        frames: thumbStats.frames,
    };
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
    bindPresetThumbs();
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
