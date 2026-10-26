// Points DNF de la carte (docs/logs-geocaching.md, lot C) et source « DNF »
// des panneaux Stats (docs/panneaux-stats.md).
//
// Chargés à part du jeu principal (/api/logs/dnf_features) et jamais mêlés à
// pointsByDate : compteurs, panneaux Stats et chronologie ne comptent que des
// trouvailles. Filtrés comme la sélection courante, puis dessinés par
// mapgl.js (syncDnfStatic / syncDnfToDay), qui les ajoute et les retire selon
// le jour affiché. Deux préférences globales : dnf_display (masqués par
// défaut) et dnf_in_trail (le trait passe par les DNF, par défaut).
// Rien ici sur la page Évolution.
//
// Proposés seulement quand les logs importés décrivent au moins un DNF :
// sans eux, la case de l'onglet Données et les réglages du thème restent
// masqués (même motif que les caches posées, owner_data.js).
//
// Les Stats comptent les DNF même masqués sur la carte (le panneau est le
// choix d'afficher) : les données sont toujours chargées sur la page
// principale, et l'index des Stats suit la même sélection que les points.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { t } from './notifications.js';
import { isMainPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { buildDnfEntries, dnfEventsByDate, dnfStatesAt } from './dnf_model.mjs';
import { isoToDayNumber } from './evolution_timeline.mjs';
import { countLabel } from './utils.js';

let loaded = [];      // features servies, avant filtrage
let pending = 0;      // caches en DNF sans position connue
let loadSeq = 0;      // une réponse ancienne ne doit pas écraser une plus récente
let entries = [];     // entrées filtrées (dnf_model.mjs), carte
let statsEntries = [];   // mêmes entrées, affichées ou non (tuiles Stats)
let statsIndex = null;   // { revision, byDate } — source « DNF » des Stats
let statsRevision = 0;
let statesMemo = null;   // { revision, day, states } — tuiles « au jour »
let bound = false;
// Change à chaque refiltrage : clé de mémoïsation du trait de déplacement.
export let dnfRevision = 0;

// Blocs proposés seulement quand des DNF existent.
const OFFER_IDS = ['dnfDisplayField', 'pointsDnf', 'flashDnf'];

function el(id) { return document.getElementById(id); }

// Au moins un DNF connu, placé ou non (`pending` compte les caches en DNF
// sans position connue — c'est de la donnée, l'option reste proposée).
function hasDnfRecords() {
    return loaded.length > 0 || pending > 0;
}

export function isDnfDisplayEnabled() {
    return window.userSettings?.dnf_display === true && hasDnfRecords();
}

export function isDnfInTrail() {
    return isDnfDisplayEnabled() && window.userSettings?.dnf_in_trail !== false;
}

// Un DNF trouvé le jour même : affiché un instant puis effacé pendant
// l'animation (mapgl.js, syncDnf). Opt-in : décoché par défaut.
export function isDnfSameDayDisplay() {
    return isDnfDisplayEnabled() && window.userSettings?.dnf_same_day_display === true;
}

export function getDnfEntries() {
    return entries;
}

export function hasDnfData() {
    return loaded.length > 0;
}

// Source « DNF » des panneaux Stats : un événement par DNF, par jour.
export function dnfStatsIndex() {
    return statsIndex;
}

// Tuiles « DNF en cours » / « DNF résolus » au jour `day` (numéro de jour,
// Infinity au repos). Mémoïsé par (révision, jour) : les tweens des
// compteurs l'appellent à chaque frame — un même jour est relu en O(1).
export function dnfStatsAtDay(day) {
    if (statesMemo && statesMemo.revision === statsRevision && statesMemo.day === day) {
        return statesMemo.states;
    }
    const states = dnfStatesAt(statsEntries, day);
    statesMemo = { revision: statsRevision, day, states };
    return states;
}

// Refiltre selon la sélection courante. Appelé à chaque reconstruction de
// l'index des trouvailles (bdd.js) : chargement, filtres, sources affichées.
// Les DNF suivent les géocaches : absents en « Lab Caches » seuls.
export function rebuildDnfIndex() {
    const kinds = pkg.getDiscoverySourceKinds?.() || ['geocache'];
    const features = kinds.includes('geocache') ? (pkg.filterLikeCurrentSelection?.(loaded) ?? loaded) : [];
    statsEntries = buildDnfEntries(features, isoToDayNumber);
    statsIndex = { revision: `dnf:${++statsRevision}`, byDate: dnfEventsByDate(features) };
    entries = isDnfDisplayEnabled() ? statsEntries : [];
    dnfRevision++;
    renderHint();
}

function applyChange() {
    rebuildDnfIndex();
    renderOffer();
    // Carte au repos : à jour tout de suite. En animation, au prochain jour
    // ou au prochain saut de la barre de chronologie.
    if (!pkg.isAnimationInProgress?.()) pkg.syncDnfStatic?.();
    // Panneaux Stats de source « DNF » (et galerie) : nouvel index.
    pkg.refreshStatsPanels?.();
    pkg.renderStatsTab?.();
    // Légende de la carte : la ligne DNF suit l'affichage effectif.
    pkg.syncMapLegend?.();
    // Chronologie : les repères des jours de DNF suivent l'affichage.
    pkg.refreshTimelineBar?.();
}

// (Re)charge les DNF du serveur, affichés ou non : les panneaux Stats les
// comptent aussi. Appelé au démarrage, et après tout import qui peut en
// changer (logs, My Finds) ou leur suppression.
export async function reloadDnfData() {
    if (!isMainPage()) return;
    const seq = ++loadSeq;
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/dnf_features`);
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data) throw new Error(data?.message || `HTTP ${resp.status}`);
        if (seq !== loadSeq) return;
        loaded = Array.isArray(data.features) ? data.features : [];
        pending = Number(data.pending) || 0;
    } catch (e) {
        if (seq !== loadSeq) return;
        console.warn('[DNF] chargement impossible :', e);
        // Sans ce toast, un panneau « source DNF » resterait dessiné à zéro
        // sans explication (la liste de l'onglet Stats le signale aussi).
        pkg.showToast?.(t('Impossible de charger vos DNF : ${message}', { message: e.message }), 'error', t('Erreur'));
        loaded = [];
        pending = 0;
    }
    applyChange();
}

function renderHint() {
    const hint = el('dnfDisplayHint');
    if (!hint) return;
    hint.textContent = '';
    if (!isDnfDisplayEnabled()) return;
    if (!loaded.length && !pending) {
        hint.textContent = t('Aucun DNF importé : voir la carte « Mes logs ».');
        return;
    }
    hint.append(t('${n} DNF dans la sélection', { n: entries.length }));
    // Compte cliquable : il ouvre la modale de complétion des positions.
    if (pending) {
        hint.append(' · ', pkg.pendingCoordsLink?.(pending)
            || countLabel(pending, t('cache sans position connue'), t('caches sans position connue')));
    }
}

// Case de l'onglet Données et réglages du thème : visibles seulement avec
// des DNF (attribut hidden, sans classe d-* — AGENTS.md).
function renderOffer() {
    const offered = hasDnfRecords();
    for (const id of OFFER_IDS) {
        const node = el(id);
        if (node) node.hidden = !offered;
    }
    syncBoxes();
}

// Case grisée tant que les points sont masqués : la raison va sur le label
// (la bulle `title` d'un input disabled n'apparaît pas partout, celle du
// label oui — et elle survit au survol même hors de la case).
function disabledHint(boxId, off, text) {
    for (const node of [el(boxId), document.querySelector(`label[for="${boxId}"]`)]) {
        if (!node) continue;
        if (off) node.title = text;
        else node.removeAttribute('title');
    }
}

function syncBoxes() {
    const display = el('checkDnfDisplay');
    if (display) display.checked = window.userSettings?.dnf_display === true;
    const off = !isDnfDisplayEnabled();
    const trail = el('checkDnfInTrail');
    if (trail) {
        trail.checked = window.userSettings?.dnf_in_trail !== false;
        trail.disabled = off;
    }
    const sameDay = el('checkDnfSameDay');
    if (sameDay) {
        sameDay.checked = window.userSettings?.dnf_same_day_display === true;
        sameDay.disabled = off;
    }
    disabledHint('checkDnfInTrail', off, t('Actif quand les DNF sont affichés'));
    disabledHint('checkDnfSameDay', off, t('Actif quand les DNF sont affichés'));
}

// Échec de l'enregistrement : la case et window.userSettings reviennent à
// la valeur du disque — sinon l'écran afficherait le contraire du serveur
// jusqu'au prochain rechargement (l'indicateur « Non enregistré » est déjà
// posé par reportSave). La garde `=== on` protège un clic plus récent.
async function revertSetting(key, on) {
    if (window.userSettings?.[key] !== on) return;
    window.userSettings[key] = !on;
    syncBoxes();
    applyChange();
}

async function onDisplayToggle(e) {
    const box = e.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.dnf_display = on;
    syncBoxes();
    applyChange();
    const ok = await reportSave(box, saveSettingsPatch({ dnf_display: on }));
    if (!ok) await revertSetting('dnf_display', on);
}

async function onTrailToggle(e) {
    const box = e.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.dnf_in_trail = on;
    // Le trajet est recalculé à la prochaine lecture (clé de mémoïsation).
    const ok = await reportSave(box, saveSettingsPatch({ dnf_in_trail: on }));
    if (!ok) await revertSetting('dnf_in_trail', on);
}

async function onSameDayToggle(e) {
    const box = e.currentTarget;
    const on = box.checked;
    if (window.userSettings) window.userSettings.dnf_same_day_display = on;
    // N'agit que pendant l'animation : rien à resynchroniser au repos.
    const ok = await reportSave(box, saveSettingsPatch({ dnf_same_day_display: on }));
    if (!ok) await revertSetting('dnf_same_day_display', on);
}

export function initDnfUI() {
    if (bound || !isMainPage()) return;
    const display = el('checkDnfDisplay');
    if (!display) return;
    bound = true;
    syncBoxes();
    display.addEventListener('change', onDisplayToggle);
    el('checkDnfInTrail')?.addEventListener('change', onTrailToggle);
    el('checkDnfSameDay')?.addEventListener('change', onSameDayToggle);
    reloadDnfData();
}

// Les préférences (window.userSettings) sont prêtes au jalon mygcflow:ready.
// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
if (window.mygcflowReady) {
    initDnfUI();
} else {
    window.addEventListener('mygcflow:ready', initDnfUI, { once: true });
}
