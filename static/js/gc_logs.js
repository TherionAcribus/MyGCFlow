// Interface « Mes logs » (onglet Données, mode Normal) : DNF, actions de
// poseur et logs reçus sur ses caches (docs/logs-geocaching.md, lot B).
//
// Import d'un fichier avec aperçu (ce qui change, ce qui sera retiré),
// validation en tâche de fond, statut, export et suppression. Rien n'est
// encore dessiné sur la carte : seul le statut reflète les données.
// Les éléments n'existent que sur la page principale : tout se replie en
// no-op en mode Évolution.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showConfirmation, showError, showSuccess, t } from './notifications.js';
import { hideBsModal, showBsModal } from './ui_bootstrap.js';
import { countLabel } from './utils.js';

const TASK_POLL_MS = 500;
const TASK_MAX_ERRORS = 10;

let bound = false;
let fileInput = null;
let importToken = null;   // jeton opaque de l'aperçu affiché
let busy = false;         // aperçu, import ou suppression en cours

function el(id) { return document.getElementById(id); }

// Catégories dans l'ordre d'affichage, avec leurs deux formes.
function categoryForms() {
    return [
        ['dnf', t('DNF'), t('DNF')],
        ['find', t('trouvaille'), t('trouvailles')],
        ['owner', t('action de poseur'), t('actions de poseur')],
        ['note', t('note'), t('notes')],
        ['alert', t('signalement'), t('signalements')],
        ['reviewer', t('log de relecteur'), t('logs de relecteur')],
        ['event', t("log d'événement"), t("logs d'événement")],
        ['other', t('autre'), t('autres')],
    ];
}

// { dnf: 477, find: 44 } → « 477 DNF, 44 trouvailles »
function categoryList(counts) {
    return categoryForms()
        .filter(([key]) => counts?.[key])
        .map(([key, one, many]) => countLabel(counts[key], one, many))
        .join(', ');
}

function categoryOfType(typeId) {
    const id = Number(typeId);
    if (id === 3) return t('DNF');
    if (id === 2 || id === 10 || id === 11) return t('trouvaille');
    if ([5, 12, 22, 23, 46, 47].includes(id)) return t('action de poseur');
    if (id === 4) return t('note');
    return t('log');
}

function moreLabel(n) {
    return n === 1 ? t('… et 1 autre') : t('… et ${n} autres', { n });
}

// .alert est un conteneur flex en ligne : un seul enfant porte le contenu,
// empilé (même règle que les alertes de la carte Lab Caches).
function alertBody(alertEl) {
    alertEl.textContent = '';
    const body = document.createElement('div');
    body.className = 'flex-fill';
    alertEl.appendChild(body);
    return body;
}

function li(text, className = '') {
    const item = document.createElement('li');
    if (className) item.className = className;
    item.textContent = text;
    return item;
}

// ---------------------------------------------------------------- statut

export async function refreshLogsStatus() {
    if (!el('gcLogsStatus')) return null;
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/status`);
        const status = await resp.json();
        if (resp.ok) renderStatus(status);
        return status;
    } catch (_) {
        return null;
    }
}

function renderStatus(st) {
    const statusEl = el('gcLogsStatus');
    const detail = el('gcLogsDetail');
    const has = !!(st && st.exists && st.logs > 0);
    el('gcLogsExportBtn').hidden = !has;
    el('gcLogsClearBtn').hidden = !has;
    detail.textContent = '';
    if (!has) {
        statusEl.textContent = t('Aucun log importé');
        detail.hidden = true;
        return;
    }
    const name = st.account?.username;
    statusEl.textContent = name
        ? t('${count} — compte ${name}', { count: countLabel(st.logs, t('log enregistré'), t('logs enregistrés')), name })
        : countLabel(st.logs, t('log enregistré'), t('logs enregistrés'));
    if (st.mine) {
        detail.appendChild(li(t('À vous : ${list}', { list: categoryList(st.mine_by_category) })));
    }
    const others = st.logs - (st.mine || 0);
    if (others > 0) {
        detail.appendChild(li(countLabel(others, t("log d'autres joueurs"), t("logs d'autres joueurs"))));
    }
    if (st.caches) {
        detail.appendChild(li(countLabel(st.caches, t('fiche de cache'), t('fiches de caches'))));
    }
    if (st.pending_coordinates) {
        detail.appendChild(li(countLabel(st.pending_coordinates,
            t('cache sans position connue'), t('caches sans position connue')), 'text-warning'));
    }
    detail.hidden = false;
}

// -------------------------------------------------------------- activité

function setBusy(title) {
    busy = !!title;
    const box = el('gcLogsActivity');
    el('gcLogsActivityTitle').textContent = title || '';
    box.hidden = !title;
    el('gc-logs-file-btn').disabled = busy;
    el('gcLogsClearBtn').disabled = busy;
}

// ---------------------------------------------------------------- aperçu

function onFileChosen() {
    const file = fileInput.files?.[0];
    fileInput.value = '';   // même fichier re-sélectionnable
    if (file) importLogFile(file);
}

// Point d'entrée commun au bouton et au glisser-déposer (bdd.js y route les
// fichiers `mygcflow-logs`). No-op sur une page sans carte « Mes logs ».
export async function importLogFile(file) {
    if (!file || !el('gcLogsPreviewModal')) return;
    if (busy) {
        showError(t('Un import est déjà en cours, veuillez patienter.'), t('Import de logs'));
        return;
    }
    setBusy(t('Analyse du fichier…'));
    try {
        const fd = new FormData();
        fd.append('file', file);
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/import/preview`, { method: 'POST', body: fd });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) throw new Error(data.message || t('Import impossible'));
        importToken = data.import_token;
        renderPreview(data);
        showBsModal(el('gcLogsPreviewModal'));
    } catch (e) {
        showError(e.message || t("Erreur lors de l'analyse"), t('Import de logs'));
    } finally {
        setBusy(null);
    }
}

function renderPreview(data) {
    const s = data.summary || {};

    const changes = alertBody(el('gcLogsPreviewChanges'));
    const head = document.createElement('div');
    head.className = 'fw-bold mb-1';
    head.textContent = s.account?.username
        ? t('${file} — compte ${name}', { file: data.name, name: s.account.username })
        : data.name;
    changes.appendChild(head);
    const lines = [];
    const push = (n, one, many) => { if (n) lines.push(countLabel(n, one, many)); };
    push(s.added, t('nouveau log'), t('nouveaux logs'));
    push(s.updated, t('log mis à jour'), t('logs mis à jour'));
    push(s.unchanged, t('log déjà connu'), t('logs déjà connus'));
    push(s.stale, t('log plus ancien que la version enregistrée, ignoré'),
        t('logs plus anciens que la version enregistrée, ignorés'));
    push(s.caches_added, t('nouvelle fiche de cache'), t('nouvelles fiches de caches'));
    push(s.caches_updated, t('fiche de cache mise à jour'), t('fiches de caches mises à jour'));
    if (!lines.length) lines.push(t('Rien de nouveau dans ce fichier.'));
    for (const line of lines) {
        const div = document.createElement('div');
        div.textContent = line;
        changes.appendChild(div);
    }

    // Retraits : visibles avant validation — un fichier déclaré « complet »
    // à tort ne doit pas effacer un historique en silence.
    const removalsEl = el('gcLogsPreviewRemovals');
    const removals = alertBody(removalsEl);
    removalsEl.hidden = !s.removed;
    if (s.removed) {
        const title = document.createElement('div');
        title.className = 'fw-bold mb-1';
        title.textContent = countLabel(s.removed, t('log sera retiré'), t('logs seront retirés'));
        removals.appendChild(title);
        const why = document.createElement('div');
        why.textContent = t("Le fichier déclare contenir tous ces logs : ceux qu'il n'a plus ont été supprimés sur le site.");
        removals.appendChild(why);
        const list = document.createElement('ul');
        list.className = 'mb-0 mt-1';
        for (const item of (s.removed_sample || [])) {
            list.appendChild(li(`${item.gc_code} — ${item.date} — ${categoryOfType(item.type_id)}`));
        }
        const hidden = s.removed - (s.removed_sample || []).length;
        if (hidden > 0) list.appendChild(li(moreLabel(hidden)));
        removals.appendChild(list);
    }

    const content = el('gcLogsPreviewContent');
    content.textContent = '';
    const mine = categoryList(s.categories?.mine);
    const others = categoryList(s.categories?.others);
    for (const line of [
        mine && t('À vous : ${list}', { list: mine }),
        others && t("D'autres joueurs : ${list}", { list: others }),
    ]) {
        if (!line) continue;
        const div = document.createElement('div');
        div.textContent = line;
        content.appendChild(div);
    }

    const issues = el('gcLogsPreviewIssues');
    const issueList = issues.querySelector('ul');
    issueList.textContent = '';
    for (const item of [...(s.rejected_reasons || []), ...(s.warnings || [])]) {
        if (item.truncated) issueList.appendChild(li(moreLabel(item.truncated)));
        else issueList.appendChild(li(`${item.reason} (${item.count})`));
    }
    if (s.duplicates) {
        issueList.appendChild(li(countLabel(s.duplicates, t('doublon ignoré'), t('doublons ignorés'))));
    }
    if (s.pending_coordinates) {
        issueList.appendChild(li(countLabel(s.pending_coordinates,
            t('cache sans position connue'), t('caches sans position connue'))));
    }
    issues.hidden = !issueList.children.length;
}

// ------------------------------------------------------------ validation

function pollTask(taskId) {
    return new Promise((resolve, reject) => {
        let errors = 0;
        const tick = () => {
            fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`)
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then(status => {
                    errors = 0;
                    if (status?.state === 'finished') return resolve(status.result || {});
                    if (status?.state === 'failed') return reject(new Error(status.error || t('Import échoué')));
                    setTimeout(tick, TASK_POLL_MS);
                })
                .catch(() => {
                    errors++;
                    if (errors >= TASK_MAX_ERRORS) {
                        reject(new Error(t('Le serveur ne répond plus — vérifiez sa disponibilité.')));
                        return;
                    }
                    setTimeout(tick, TASK_POLL_MS);
                });
        };
        tick();
    });
}

function resultMessage(r) {
    const parts = [];
    const push = (n, one, many) => { if (n) parts.push(countLabel(n, one, many)); };
    push(r.added, t('nouveau log'), t('nouveaux logs'));
    push(r.updated, t('log mis à jour'), t('logs mis à jour'));
    push(r.removed, t('log retiré'), t('logs retirés'));
    return parts.join(', ') || t('Aucun changement : vos logs étaient déjà à jour.');
}

async function onPreviewConfirm() {
    // Jeton pris avant la fermeture : `hidden.bs.modal` l'efface.
    const token = importToken;
    importToken = null;
    hideBsModal(el('gcLogsPreviewModal'));
    if (!token) return;
    setBusy(t('Import de vos logs…'));
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/import/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ import_token: token }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success || !data.task_id) throw new Error(data.message || t('Import refusé'));
        const result = await pollTask(data.task_id);
        if (result.status) renderStatus(result.status);
        pkg.reloadDnfData?.();
        showSuccess(resultMessage(result), t('Logs importés'));
    } catch (e) {
        showError(e.message || t("Erreur lors de l'import"), t('Import de logs'));
    } finally {
        setBusy(null);
        refreshLogsStatus();
    }
}

// ------------------------------------------------------ export / vidage

function onExport() {
    // Téléchargement direct : la route pose Content-Disposition=attachment.
    window.location.href = `${CONFIG.BASE_URL}/api/logs/export`;
}

async function onClear() {
    const confirmed = await new Promise(resolve => {
        showConfirmation(
            t('Supprimer tous vos logs importés ? Vos géocaches et vos Lab Caches sont conservés. Cette action est irréversible.'),
            t('Confirmation de suppression'),
            () => resolve(true),
            () => resolve(false),
            { danger: true, confirmText: t('Supprimer mes logs') });
    });
    if (!confirmed) return;
    setBusy(t('Suppression de vos logs…'));
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/logs/clear`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) throw new Error(data.message || t('Erreur inconnue'));
        pkg.reloadDnfData?.();
        showSuccess(t('Logs supprimés'), t('Suppression réussie'));
    } catch (e) {
        showError(e.message || t('Erreur lors de la suppression'), t('Erreur'));
    } finally {
        setBusy(null);
        refreshLogsStatus();
    }
}

// ---------------------------------------------------------------- init

export function initLogsUI() {
    if (bound) return;
    fileInput = el('gc-logs-file-input');
    if (!fileInput) return;   // page sans carte « Mes logs » (Évolution)
    bound = true;
    el('gc-logs-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', onFileChosen);
    el('gcLogsPreviewConfirmBtn').addEventListener('click', onPreviewConfirm);
    el('gcLogsExportBtn').addEventListener('click', onExport);
    el('gcLogsClearBtn').addEventListener('click', onClear);
    // Aperçu abandonné : le jeton expire seul côté serveur.
    el('gcLogsPreviewModal').addEventListener('hidden.bs.modal', () => { importToken = null; });
    refreshLogsStatus();
}

// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogsUI);
} else {
    initLogsUI();
}
