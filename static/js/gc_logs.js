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
import { showConfirmation, showError, showInfo, showSuccess, t } from './notifications.js';
import { hideBsModal, showBsModal } from './ui_bootstrap.js';
import { countLabel } from './utils.js';

const TASK_POLL_MS = 500;
const TASK_MAX_ERRORS = 10;
// Relevé du statut tant que l'onglet Données est affiché : un export déposé
// par le favori « Envoyer vers MyGCFlow » arrive hors de cette page, et
// l'onglet peut rester ouvert sans reprendre le focus.
const STATUS_POLL_MS = 4000;

let bound = false;
let fileInput = null;
let importToken = null;   // jeton opaque de l'aperçu affiché
let busy = false;         // aperçu, import ou suppression en cours
let guideOpen = false;    // parcours du favori rouvert via « Afficher les instructions »
let lastStatus = null;    // dernier statut rendu (pour le guide)
let pendingImport = null; // export reçu du favori, en attente de validation
let taskWasActive = false; // import lancé ailleurs (autre onglet) vu par le relevé
let statusPollTimer = null;

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
    lastStatus = st;
    const statusEl = el('gcLogsStatus');
    const detail = el('gcLogsDetail');
    const has = !!(st && st.exists && st.logs > 0);
    el('gcLogsExportBtn').hidden = !has;
    el('gcLogsClearBtn').hidden = !has;
    const updateBtn = el('gcLogsUpdateBtn');
    if (updateBtn) updateBtn.style.display = has ? '' : 'none';
    renderGuide(has);
    renderPending(st?.pending_import);
    const fullBtn = el('gcLogsFullNextBtn');
    if (fullBtn) {
        const planned = !!st?.full_collect_planned;
        fullBtn.disabled = planned;
        const label = planned
            ? t('Collecte complète prévue au prochain passage')
            : t('Forcer une collecte complète la prochaine fois');
        const icon = planned ? 'ti-check' : 'ti-zoom-scan';
        fullBtn.innerHTML = `<i class="ti ${icon} me-1" aria-hidden="true"></i>`;
        fullBtn.appendChild(document.createTextNode(label));
    }
    // Un import peut tourner hors de cette page (validation faite dans un
    // autre onglet) : le bloc d'activité reflète la tâche serveur, et sa fin
    // relance la lecture des points DNF.
    const taskActive = !!(st && st.active_task);
    if (!busy) {
        const box = el('gcLogsActivity');
        el('gcLogsActivityTitle').textContent =
            taskActive ? (st.active_task.message || t('Import de vos logs…')) : '';
        box.hidden = !taskActive;
        el('gc-logs-file-btn').disabled = taskActive;
        el('gcLogsClearBtn').disabled = taskActive;
    }
    if (taskWasActive && !taskActive) pkg.reloadDnfData?.();
    taskWasActive = taskActive;
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
        const item = li(countLabel(st.pending_coordinates,
            t('cache sans position connue'), t('caches sans position connue')), 'text-warning');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-link p-0 ms-1 align-baseline';
        btn.textContent = t('compléter');
        btn.addEventListener('click', openCoordsModal);
        item.appendChild(btn);
        detail.appendChild(item);
    }
    const lastLine = lastImportLine(st.last_import);
    if (lastLine) detail.appendChild(li(lastLine, 'text-muted'));
    detail.hidden = false;
}

// « Dernier import le 25/10/2026 09:22 : 5 nouveaux logs, 1 retiré — favori »
// — répond à « dois-je réimporter ? » sans ouvrir l'historique.
function lastImportLine(info) {
    if (!info?.at) return null;
    // `last_import_at` est stocké en UTC naïf : le suffixe Z évite une
    // lecture en heure locale par le navigateur.
    const d = new Date(/[zZ+]/.test(info.at) ? info.at : `${info.at}Z`);
    if (isNaN(d.getTime())) return null;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const when = `${pkg.formatDateDisplay?.(d) || ''} ${hh}:${mm}`.trim();
    const parts = [];
    const push = (n, one, many) => { if (n) parts.push(countLabel(n, one, many)); };
    push(info.added, t('nouveau log'), t('nouveaux logs'));
    push(info.updated, t('log mis à jour'), t('logs mis à jour'));
    push(info.removed, t('log retiré'), t('logs retirés'));
    const changes = parts.join(', ') || t('aucun changement');
    let origin = null;
    if (info.source === 'gpx-myfinds') origin = 'My Finds';
    else if (info.source === 'gpx') origin = t('fichier GPX');
    else if (info.source === 'mygcflow-logs') {
        origin = /bookmarklet/.test(info.generator || '')
            ? t('favori') : t('fichier mygcflow-logs');
    }
    const via = origin ? ` — ${origin}` : '';
    return t('Dernier import le ${date} : ${changes}${via}', { date: when, changes, via });
}

// Le parcours du favori s'affiche d'office tant que rien n'est importé ;
// ensuite il se replie derrière « Afficher les instructions d'import ».
function renderGuide(hasLogs) {
    const guide = el('gcLogsGuide');
    if (!guide) return;
    guide.hidden = !(!hasLogs || guideOpen);
    el('gcLogsUpdateBtn')?.setAttribute('aria-expanded', String(!guide.hidden));
}

// Export déposé par le favori : bandeau « à valider » → la même modale
// d'aperçu qu'un fichier choisi à la main.
function renderPending(pending) {
    pendingImport = pending || null;
    const alertEl = el('gcLogsPendingAlert');
    if (!alertEl) return;
    alertEl.classList.toggle('d-none', !pending);
    if (pending) {
        const count = pending.summary?.added ?? 0;
        el('gcLogsPendingText').textContent = t(
            'Un export a été reçu de votre favori (${count} nouveaux logs annoncés) — validez l\'aperçu avant l\'import.',
            { count });
    }
}

function onPendingView() {
    const pending = pendingImport;
    if (!pending || !el('gcLogsPreviewModal')) return;
    importToken = pending.import_token;
    renderPreview({ name: pending.name || t('export du favori'), summary: pending.summary || {} });
    showBsModal(el('gcLogsPreviewModal'));
}

// ------------------------------------------------- caches sans position
//
// Même patron que les « étapes en attente » des Labs : liste paginée,
// saisie par ligne au format du géocacheur, résolution immédiate. La
// position manuelle (`user_correction`) n'est jamais reprise par un
// import ultérieur.

const COORDS_PAGE_SIZE = 20;
let coordsOffset = 0;
let coordsTotal = 0;
let coordsLoadSeq = 0;

async function openCoordsModal() {
    const modal = el('gcLogsCoordsModal');
    if (!modal) return;
    coordsOffset = 0;
    showBsModal(modal);
    await loadCoordsPage(0);
}

async function loadCoordsPage(offset) {
    const listEl = el('gcLogsCoordsList');
    if (!listEl) return;
    // Numéro de requête : une page lente n'écrase pas une demande plus récente.
    const seq = ++coordsLoadSeq;
    const prev = el('gcLogsCoordsPrev');
    const next = el('gcLogsCoordsNext');
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    listEl.textContent = '';
    const spinner = document.createElement('div');
    spinner.className = 'd-flex justify-content-center align-items-center gap-2 py-3';
    spinner.setAttribute('role', 'status');
    const wheel = document.createElement('div');
    wheel.className = 'spinner-border spinner-border-sm';
    wheel.setAttribute('aria-hidden', 'true');
    spinner.appendChild(wheel);
    const label = document.createElement('span');
    label.className = 'small text-muted';
    label.textContent = t('Chargement');
    spinner.appendChild(label);
    listEl.appendChild(spinner);
    try {
        const r = await fetch(
            `${CONFIG.BASE_URL}/api/logs/pending_caches?limit=${COORDS_PAGE_SIZE}&offset=${Math.max(0, offset)}`);
        const data = await r.json();
        if (seq !== coordsLoadSeq) return;   // réponse périmée
        if (!data.success) throw new Error(data.message || 'erreur');
        coordsOffset = data.offset || 0;
        coordsTotal = data.total || 0;
        renderCoordsList(data.items || []);
        updateCoordsPager();
    } catch (e) {
        if (seq !== coordsLoadSeq) return;
        listEl.textContent = t('Chargement impossible');
        updateCoordsPager();
    }
}

function updateCoordsPager() {
    const prev = el('gcLogsCoordsPrev');
    const next = el('gcLogsCoordsNext');
    const page = el('gcLogsCoordsPage');
    const total = coordsTotal || 0;
    if (prev) prev.disabled = coordsOffset <= 0;
    if (next) next.disabled = coordsOffset + COORDS_PAGE_SIZE >= total;
    if (page) {
        const start = total === 0 ? 0 : coordsOffset + 1;
        const end = Math.min(coordsOffset + COORDS_PAGE_SIZE, total);
        page.textContent = `${start}–${end} / ${countLabel(total, t('cache'), t('caches'))}`;
    }
}

function renderCoordsList(items) {
    const listEl = el('gcLogsCoordsList');
    listEl.textContent = '';
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'form-hint text-muted';
        empty.textContent = t('Aucune cache sans position sur cette page.');
        listEl.appendChild(empty);
        return;
    }
    for (const item of items) listEl.appendChild(buildCoordsRow(item));
}

// Une ligne par cache : code (lien vers la fiche), nom et contexte connus,
// saisie de la position au format du géocacheur.
function buildCoordsRow(item) {
    const row = document.createElement('div');
    row.className = 'border rounded p-2 mb-2';
    row.dataset.gcCode = item.gc_code;
    row.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'small';
    const link = document.createElement('a');
    link.href = `https://www.geocaching.com/geocache/${item.gc_code}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'fw-medium';
    link.textContent = item.gc_code;
    head.appendChild(link);
    if (item.name) {
        const name = document.createElement('span');
        name.textContent = ` — ${item.name}`;
        head.appendChild(name);
    }
    row.appendChild(head);

    const parts = [];
    if (item.cache_type) parts.push(item.cache_type);
    if (item.owner_name) parts.push(t('de ${name}', { name: item.owner_name }));
    if (item.dnf) parts.push(countLabel(item.dnf, t('DNF à vous'), t('DNF à vous')));
    if (item.logs > (item.dnf || 0)) {
        parts.push(countLabel(item.logs - (item.dnf || 0), t('autre log'), t('autres logs')));
    }
    if (parts.length) {
        const meta = document.createElement('div');
        meta.className = 'form-hint text-muted mb-1';
        meta.textContent = parts.join(' · ');
        row.appendChild(meta);
    }

    const form = document.createElement('div');
    form.className = 'd-flex flex-wrap gap-2 align-items-center';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm flex-grow-1';
    input.placeholder = 'N 48° 51.504 E 002° 17.670';
    input.setAttribute('aria-label', t('Position de ${code}', { code: item.gc_code }));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = t('Placer');
    const feedback = document.createElement('span');
    feedback.className = 'small';
    feedback.setAttribute('role', 'status');
    btn.addEventListener('click', () => onResolveCoords(row, item, input, btn, feedback));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });
    form.appendChild(input);
    form.appendChild(btn);
    form.appendChild(feedback);
    row.appendChild(form);
    return row;
}

async function onResolveCoords(row, item, input, btn, feedback) {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    btn.disabled = true;
    try {
        const r = await fetch(
            `${CONFIG.BASE_URL}/api/logs/caches/${encodeURIComponent(item.gc_code)}/resolve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coordinates: text }),
            });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.success) throw new Error(data.message || t('Correction refusée'));
        // La ligne disparaît : la cache a sa position, et le point DNF
        // arrive avec le rechargement des données carte.
        row.remove();
        coordsTotal = Math.max(0, coordsTotal - 1);
        updateCoordsPager();
        if (el('gcLogsCoordsList') && !el('gcLogsCoordsList').children.length) {
            loadCoordsPage(coordsOffset > 0 ? coordsOffset - COORDS_PAGE_SIZE : 0);
        }
        refreshLogsStatus();
        pkg.reloadDnfData?.();
    } catch (e) {
        btn.disabled = false;
        feedback.className = 'small text-danger';
        feedback.textContent = e.message;
    }
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
    if (!s.exported_at) {
        // Un fichier sans date d'export gagne tout conflit de version :
        // il écrase les enregistrements plutôt que d'être ignoré.
        const undated = document.createElement('div');
        undated.className = 'text-warning mt-1';
        undated.textContent = t('Ce fichier n\'est pas daté : ses données écraseront les versions déjà enregistrées plutôt que d\'être ignorées.');
        changes.appendChild(undated);
    }
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

// ------------------------------------------------- favori « Envoyer vers MyGCFlow »
//
// Le favori est fait pour être glissé dans la barre de favoris : un clic
// dessus depuis l'app serait un no-op. Tant que le lien réel n'est pas
// chargé il est inerte (aria-disabled, non glissable, hors tabulation) ;
// en échec, l'import de fichiers prend le relais. « Copier le lien » rend
// le parcours possible au clavier. Même mécanique que labs.js.

function markBookmarkletReady(link, bookmarklet) {
    link.href = bookmarklet;
    link.draggable = true;
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
    const label = el('gcLogsBookmarkletLabel');
    if (label) label.textContent = t('Envoyer vers MyGCFlow');
    const copyBtn = el('gcLogsCopyLinkBtn');
    if (copyBtn) copyBtn.disabled = false;
    const errBox = el('gcLogsBookmarkletError');
    if (errBox) errBox.hidden = true;
}

async function loadBookmarklet(link) {
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/logs/bookmarklet`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success || !d.bookmarklet) throw new Error('indisponible');
        markBookmarkletReady(link, d.bookmarklet);
    } catch (e) {
        console.warn('[LOGS] bookmarklet indisponible:', e);
        // Le bouton reste inerte ; le message visible propose le repli
        // « importer un fichier » plutôt qu'un favori muet.
        const label = el('gcLogsBookmarkletLabel');
        if (label) label.textContent = t('Favori indisponible');
        const errBox = el('gcLogsBookmarkletError');
        if (errBox) errBox.hidden = false;
    }
}

// Copie du lien javascript: dans le presse-papiers — alternative clavier au
// glisser-déposer (un favori peut être créé à la main avec ce contenu).
async function onCopyBookmarklet() {
    const link = el('gcLogsBookmarkletLink');
    const statusEl = el('gcLogsBookmarkletStatus');
    const href = link?.getAttribute('href');
    if (!href || href === '#') return;
    try {
        await navigator.clipboard.writeText(href);
        if (statusEl) statusEl.textContent = t('Lien copié');
    } catch (_) {
        if (statusEl) statusEl.textContent = t('Copie impossible — glissez le bouton à la place.');
    }
}

// « La prochaine collecte sera complète » : drapeau consommé par le
// favori à son prochain passage — l'incrémental ne revoit pas les vieux
// logs supprimés.
async function onFullNextCollect() {
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/logs/bookmarklet/full-next`,
            { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success) throw new Error('refusé');
        refreshLogsStatus();
    } catch (e) {
        showError(t('La collecte complète n\'a pas pu être prévue'), t('Mes logs'));
    }
}

// Régénération du jeton : explicite sur l'invalidation de l'ancien favori
// (confirmation) puis le lien est rechargé avec le nouveau jeton.
function onRegenBookmarkletToken() {
    showConfirmation(
        t('Régénérer le jeton ? Le favori actuel cessera de fonctionner : il faudra glisser à nouveau le bouton « Envoyer vers MyGCFlow » dans vos favoris.'),
        t('Jeton du favori'),
        async () => {
            try {
                const r = await fetch(`${CONFIG.BASE_URL}/api/logs/bookmarklet/regenerate`,
                    { method: 'POST' });
                const d = await r.json().catch(() => ({}));
                if (!r.ok || !d.success || !d.bookmarklet) throw new Error('refusé');
                const link = el('gcLogsBookmarkletLink');
                if (link) markBookmarkletReady(link, d.bookmarklet);
                const statusEl = el('gcLogsBookmarkletStatus');
                if (statusEl) statusEl.textContent =
                    t('Nouveau favori prêt — remplacez l\'ancien dans vos favoris.');
            } catch (e) {
                showError(t('Jeton non régénéré'), t('Mes logs'));
            }
        });
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

    el('gcLogsPendingViewBtn').addEventListener('click', onPendingView);
    el('gcLogsUpdateBtn').addEventListener('click', () => {
        guideOpen = !guideOpen;
        renderGuide(!!(lastStatus && lastStatus.exists && lastStatus.logs > 0));
    });
    const bm = el('gcLogsBookmarkletLink');
    if (bm) {
        bm.addEventListener('click', (e) => {
            e.preventDefault();
            if (bm.getAttribute('aria-disabled') === 'true') return;
            showInfo(
                t('Glissez ce bouton dans la barre de favoris de votre navigateur, puis cliquez-le depuis une page de geocaching.com.'),
                t('Envoyer vers MyGCFlow'));
        });
        loadBookmarklet(bm);
    }
    el('gcLogsCopyLinkBtn').addEventListener('click', onCopyBookmarklet);
    el('gcLogsBookmarkletFallbackBtn').addEventListener('click', () => fileInput.click());
    el('gcLogsRegenTokenBtn').addEventListener('click', onRegenBookmarkletToken);
    el('gcLogsFullNextBtn').addEventListener('click', onFullNextCollect);
    el('gcLogsCoordsPrev')?.addEventListener('click',
        () => loadCoordsPage(coordsOffset - COORDS_PAGE_SIZE));
    el('gcLogsCoordsNext')?.addEventListener('click',
        () => loadCoordsPage(coordsOffset + COORDS_PAGE_SIZE));

    // Un export déposé par le favori ou un import validé ailleurs arrivent
    // hors de cette page : relevé tant que l'onglet Données est affiché,
    // plus au retour de focus. Chaîné (jamais de requêtes qui se chevauchent)
    // et muet quand une action de cette page est en cours ou que la carte
    // joue (le rechargement des DNF en fin d'import attendrait son tour).
    const checkOutside = () => {
        if (document.hidden || busy) return;
        if (pkg.isAnimationInProgress?.() || pkg.isRecordingActive?.()) return;
        refreshLogsStatus();
    };
    const scheduleStatusPoll = () => {
        if (statusPollTimer) return;
        statusPollTimer = setTimeout(() => {
            statusPollTimer = null;
            if (el('data')?.classList.contains('active')) checkOutside();
            scheduleStatusPoll();
        }, STATUS_POLL_MS);
    };
    window.addEventListener('focus', checkOutside);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkOutside(); });
    scheduleStatusPoll();

    refreshLogsStatus();
}

// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogsUI);
} else {
    initLogsUI();
}
