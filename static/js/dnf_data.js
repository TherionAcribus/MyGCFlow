// Points DNF de la carte (docs/logs-geocaching.md, lot C).
//
// Chargés à part du jeu principal (/api/logs/dnf_features) et jamais mêlés à
// pointsByDate : compteurs, panneaux Stats et chronologie ne comptent que des
// trouvailles. Filtrés comme la sélection courante, puis dessinés par
// mapgl.js (syncDnfStatic / syncDnfToDay), qui les ajoute et les retire selon
// le jour affiché. Deux préférences globales : dnf_display (masqués par
// défaut) et dnf_in_trail (le trait passe par les DNF, par défaut).
// Rien ici sur la page Évolution.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { t } from './notifications.js';
import { isEvolutionPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { markSaveError, reportSave } from './saved_indicator.mjs';
import { buildDnfEntries } from './dnf_model.mjs';
import { isoToDayNumber } from './evolution_timeline.mjs';
import { countLabel } from './utils.js';

let loaded = [];      // features servies, avant filtrage
let pending = 0;      // caches en DNF sans position connue
let loadSeq = 0;      // une réponse ancienne ne doit pas écraser une plus récente
let entries = [];     // entrées filtrées (dnf_model.mjs)
let bound = false;
// Change à chaque refiltrage : clé de mémoïsation du trait de déplacement.
export let dnfRevision = 0;

function el(id) { return document.getElementById(id); }

export function isDnfDisplayEnabled() {
    return window.userSettings?.dnf_display === true;
}

export function isDnfInTrail() {
    return isDnfDisplayEnabled() && window.userSettings?.dnf_in_trail !== false;
}

export function getDnfEntries() {
    return entries;
}

// Refiltre selon la sélection courante. Appelé à chaque reconstruction de
// l'index des trouvailles (bdd.js) : chargement, filtres, sources affichées.
// Les DNF suivent les géocaches : absents en « Lab Caches » seuls.
export function rebuildDnfIndex() {
    const kinds = pkg.getDiscoverySourceKinds?.() || ['geocache'];
    const usable = isDnfDisplayEnabled() && kinds.includes('geocache');
    const features = usable ? (pkg.filterLikeCurrentSelection?.(loaded) ?? loaded) : [];
    entries = buildDnfEntries(features, isoToDayNumber);
    dnfRevision++;
    renderHint();
}

function applyChange() {
    rebuildDnfIndex();
    // Carte au repos : à jour tout de suite. En animation, au prochain jour
    // ou au prochain saut de la barre de chronologie.
    if (!pkg.isAnimationInProgress?.()) pkg.syncDnfStatic?.();
}

// (Re)charge les DNF du serveur — seulement si l'affichage est activé.
// Appelé au démarrage, à la bascule, et après tout import qui peut en
// changer (logs, My Finds) ou leur suppression.
export async function reloadDnfData() {
    if (isEvolutionPage()) return;
    const seq = ++loadSeq;
    if (!isDnfDisplayEnabled()) {
        loaded = [];
        pending = 0;
        applyChange();
        return;
    }
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/dnf_features`);
        const data = await resp.json();
        if (seq !== loadSeq) return;
        loaded = Array.isArray(data.features) ? data.features : [];
        pending = Number(data.pending) || 0;
    } catch (e) {
        if (seq !== loadSeq) return;
        console.warn('[DNF] chargement impossible :', e);
        loaded = [];
        pending = 0;
    }
    applyChange();
}

function renderHint() {
    const hint = el('dnfDisplayHint');
    if (!hint) return;
    if (!isDnfDisplayEnabled()) {
        hint.textContent = '';
        return;
    }
    if (!loaded.length && !pending) {
        hint.textContent = t('Aucun DNF importé : voir la carte « Mes logs ».');
        return;
    }
    const parts = [t('${n} DNF dans la sélection', { n: entries.length })];
    if (pending) {
        parts.push(countLabel(pending, t('cache sans position connue'), t('caches sans position connue')));
    }
    hint.textContent = parts.join(' · ');
}

function syncTrailBox() {
    const trail = el('checkDnfInTrail');
    if (!trail) return;
    trail.checked = window.userSettings?.dnf_in_trail !== false;
    trail.disabled = !isDnfDisplayEnabled();
}

async function onDisplayToggle(e) {
    const box = e.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.dnf_display = on;
    syncTrailBox();
    reloadDnfData();
    try {
        await reportSave(box, saveSettingsPatch({ dnf_display: on }));
    } catch (_) {
        markSaveError(box);
    }
}

async function onTrailToggle(e) {
    const box = e.currentTarget;
    if (window.userSettings) window.userSettings.dnf_in_trail = box.checked;
    // Le trajet est recalculé à la prochaine lecture (clé de mémoïsation).
    try {
        await reportSave(box, saveSettingsPatch({ dnf_in_trail: box.checked }));
    } catch (_) {
        markSaveError(box);
    }
}

export function initDnfUI() {
    if (bound || isEvolutionPage()) return;
    const display = el('checkDnfDisplay');
    if (!display) return;
    bound = true;
    display.checked = isDnfDisplayEnabled();
    syncTrailBox();
    display.addEventListener('change', onDisplayToggle);
    el('checkDnfInTrail')?.addEventListener('change', onTrailToggle);
    reloadDnfData();
}

// Les préférences (window.userSettings) sont prêtes au jalon mygcflow:ready.
// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
if (window.mygcflowReady) {
    initDnfUI();
} else {
    window.addEventListener('mygcflow:ready', initDnfUI, { once: true });
}
