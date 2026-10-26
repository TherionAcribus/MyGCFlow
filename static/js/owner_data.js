// Caches posées par le joueur sur la carte principale (« Mes caches posées »,
// docs/logs-geocaching.md).
//
// Même mécanique que les points DNF (dnf_data.js) : chargées à part du jeu
// principal (/api/logs/owner_features), jamais mêlées à pointsByDate —
// compteurs, panneaux Stats et chronologie ne comptent que des trouvailles.
// Filtrées comme la sélection courante, puis dessinées par mapgl.js
// (syncOwnerStatic / syncOwnerToDay) dans leur propre couche, avec la forme,
// le contour et les flashs propres du thème (points.owner_*, flash.owner).
//
// Proposées seulement quand les logs importés décrivent au moins une cache
// posée : sans elles, la case de l'onglet Données et les réglages du thème
// restent masqués. Deux préférences globales : owner_display (masquées par
// défaut) et owner_in_trail (étapes du trajet, par défaut).

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { t } from './notifications.js';
import { isMainPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { markSaveError, reportSave } from './saved_indicator.mjs';
import { buildOwnerEntries, ownerEventsByDate, ownerStatesAt } from './owner_model.mjs';
import { isoToDayNumber } from './evolution_timeline.mjs';
import { countLabel } from './utils.js';

let loaded = [];          // features servies, avant filtrage
let ownedTotal = 0;       // caches posées reconnues (placées ou non)
let pending = 0;          // sans position connue
let undatable = 0;        // sans aucune date
let loadSeq = 0;          // une réponse ancienne ne doit pas écraser une plus récente
let entries = [];         // entrées filtrées (owner_model.mjs), carte
let statsEntries = [];    // mêmes entrées, affichées ou non (tuiles Stats)
let statsIndex = null;    // { revision, byDate } — source « caches posées » des Stats
let statsRevision = 0;
let statesMemo = null;    // { revision, day, states } — tuiles « au jour »
let bound = false;
// Change à chaque refiltrage : clé de mémoïsation du trait de déplacement.
export let ownerRevision = 0;

// Blocs proposés seulement quand des caches posées existent.
const OFFER_IDS = ['ownerDisplayField', 'pointsOwner', 'flashOwner'];

function el(id) { return document.getElementById(id); }

export function hasOwnedCaches() {
    return ownedTotal > 0;
}

export function isOwnerDisplayEnabled() {
    return window.userSettings?.owner_display === true && hasOwnedCaches();
}

export function isOwnerInTrail() {
    return isOwnerDisplayEnabled() && window.userSettings?.owner_in_trail !== false;
}

export function getOwnerEntries() {
    return entries;
}

// Source « caches posées » des panneaux Stats (comptées même masquées sur la
// carte) : une cache par jour d'apparition.
export function ownerStatsIndex() {
    return statsIndex;
}

// Tuiles d'état au jour `day` (numéro de jour, Infinity au repos) : actives,
// désactivées, archivées, maintenances faites. Mémoïsé par (révision, jour) :
// les tweens des compteurs l'appellent à chaque frame — un même jour est
// relu en O(1).
export function ownerStatsAtDay(day) {
    if (statesMemo && statesMemo.revision === statsRevision && statesMemo.day === day) {
        return statesMemo.states;
    }
    const states = ownerStatesAt(statsEntries, day);
    statesMemo = { revision: statsRevision, day, states };
    return states;
}

// Relevé pour les tests : caches servies, filtrées, comptes du serveur.
export function getOwnerSummary() {
    return { loaded: loaded.length, shown: entries.length, ownedTotal, pending, undatable };
}

// Refiltre selon la sélection courante. Appelé à chaque reconstruction de
// l'index des trouvailles (bdd.js) : chargement, filtres, sources affichées.
// Les caches posées suivent les géocaches : absentes en « Lab Caches » seuls.
export function rebuildOwnerIndex() {
    const kinds = pkg.getDiscoverySourceKinds?.() || ['geocache'];
    const features = kinds.includes('geocache') ? (pkg.filterLikeCurrentSelection?.(loaded) ?? loaded) : [];
    statsEntries = buildOwnerEntries(features, isoToDayNumber);
    statsIndex = { revision: `owned:${++statsRevision}`, byDate: ownerEventsByDate(features) };
    entries = isOwnerDisplayEnabled() ? statsEntries : [];
    ownerRevision++;
    renderHint();
}

function applyChange() {
    rebuildOwnerIndex();
    renderOffer();
    // Carte au repos : à jour tout de suite. En animation, au prochain jour
    // ou au prochain saut de la barre de chronologie.
    if (!pkg.isAnimationInProgress?.()) pkg.syncOwnerStatic?.();
    // Panneaux Stats de source « caches posées » (et galerie) : nouvel index.
    pkg.refreshStatsPanels?.();
    pkg.renderStatsTab?.();
}

// (Re)charge les caches posées du serveur. Toujours lues sur la page
// principale (quelques dizaines de caches, sans coût notable) : c'est leur
// présence qui décide de proposer l'affichage. Appelé au démarrage, à la
// bascule, et après tout import ou suppression de logs.
export async function reloadOwnerData() {
    if (!isMainPage()) return;
    const seq = ++loadSeq;
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/owner_features`);
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data) throw new Error(data?.message || `HTTP ${resp.status}`);
        if (seq !== loadSeq) return;
        loaded = Array.isArray(data.features) ? data.features : [];
        ownedTotal = Number(data.ownedTotal) || 0;
        pending = Number(data.pending) || 0;
        undatable = Number(data.undatable) || 0;
    } catch (e) {
        if (seq !== loadSeq) return;
        console.warn('[Caches posées] chargement impossible :', e);
        // Sans ce toast, un panneau « source caches posées » resterait
        // dessiné à zéro sans explication (idem poses_data.js).
        pkg.showToast?.(t('Impossible de charger vos caches posées : ${message}', { message: e.message }), 'error', t('Erreur'));
        loaded = [];
        ownedTotal = pending = undatable = 0;
    }
    applyChange();
}

// Case de l'onglet Données et réglages du thème : visibles seulement avec
// des caches posées (attribut hidden, sans classe d-* — AGENTS.md).
function renderOffer() {
    const offered = hasOwnedCaches();
    for (const id of OFFER_IDS) {
        const node = el(id);
        if (node) node.hidden = !offered;
    }
    syncBoxes();
}

function renderHint() {
    const hint = el('ownerDisplayHint');
    if (!hint) return;
    if (!isOwnerDisplayEnabled()) {
        hint.textContent = '';
        return;
    }
    const parts = [countLabel(entries.length, t('cache posée dans la sélection'), t('caches posées dans la sélection'))];
    if (pending) {
        parts.push(countLabel(pending, t('cache sans position connue'), t('caches sans position connue')));
    }
    if (undatable) {
        parts.push(countLabel(undatable, t('cache sans date'), t('caches sans date')));
    }
    hint.textContent = parts.join(' · ');
}

function syncBoxes() {
    const display = el('checkOwnerDisplay');
    if (display) display.checked = window.userSettings?.owner_display === true;
    const trail = el('checkOwnerInTrail');
    if (trail) {
        trail.checked = window.userSettings?.owner_in_trail !== false;
        trail.disabled = !isOwnerDisplayEnabled();
    }
}

async function onDisplayToggle(e) {
    const box = e.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.owner_display = on;
    syncBoxes();
    applyChange();
    try {
        await reportSave(box, saveSettingsPatch({ owner_display: on }));
    } catch (_) {
        markSaveError(box);
    }
}

async function onTrailToggle(e) {
    const box = e.currentTarget;
    if (window.userSettings) window.userSettings.owner_in_trail = box.checked;
    // Le trajet est recalculé à la prochaine lecture (clé de mémoïsation).
    try {
        await reportSave(box, saveSettingsPatch({ owner_in_trail: box.checked }));
    } catch (_) {
        markSaveError(box);
    }
}

export function initOwnerUI() {
    if (bound || !isMainPage()) return;
    const display = el('checkOwnerDisplay');
    if (!display) return;
    bound = true;
    syncBoxes();
    display.addEventListener('change', onDisplayToggle);
    el('checkOwnerInTrail')?.addEventListener('change', onTrailToggle);
    reloadOwnerData();
}

// Les préférences (window.userSettings) sont prêtes au jalon mygcflow:ready.
// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
if (window.mygcflowReady) {
    initOwnerUI();
} else {
    window.addEventListener('mygcflow:ready', initOwnerUI, { once: true });
}
