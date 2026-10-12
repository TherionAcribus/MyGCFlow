// Interface « Mes Lab Caches » (onglet Données, mode Normal) :
// import multi-fichiers avec aperçu, statut de la collection, complétion
// des étapes sans coordonnées/date, export et suppression dédiés.
// Les éléments n'existent que sur la page principale : toutes les
// fonctions se replient en no-op en mode Évolution.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showWarning, showInfo, showConfirmation, t } from './notifications.js';
import { showBsModal, hideBsModal } from './ui_bootstrap.js';

const PENDING_PAGE_SIZE = 50;

let elementsBound = false;
let labsFileInput = null;
let importToken = null;        // jeton opaque retourné par /import/preview
let previewConflicts = [];     // conflits tranchables de l'aperçu affiché
let pendingOffset = 0;
let pendingTotal = null;       // nombre d'étapes en attente (statut serveur)
let pendingDirty = false;      // une correction a été enregistrée → recharger

function el(id) { return document.getElementById(id); }

export function initLabsUI() {
    if (elementsBound) return;
    labsFileInput = el('labs-file-input');
    if (!labsFileInput) return;   // page sans carte Labs (Évolution)
    elementsBound = true;

    el('labs-file-btn')?.addEventListener('click', () => labsFileInput.click());
    labsFileInput.addEventListener('change', onLabsFilesChosen);
    el('labs-help-btn')?.addEventListener('click', () => showBsModal(el('labsHelpModal')));
    el('labsPreviewConfirmBtn')?.addEventListener('click', onPreviewConfirm);
    el('labsPendingBtn')?.addEventListener('click', openPendingModal);
    el('labsPendingPrev')?.addEventListener('click', () => loadPendingPage(pendingOffset - PENDING_PAGE_SIZE));
    el('labsPendingNext')?.addEventListener('click', () => loadPendingPage(pendingOffset + PENDING_PAGE_SIZE));
    el('clearLabsBtn')?.addEventListener('click', onClearLabs);
    el('labsExportBtn')?.addEventListener('click', onExportLabs);
    el('labsAutoFetch')?.addEventListener('change', onAutoFetchToggle);
    el('labsFetchBtn')?.addEventListener('click', onFetchNow);

    // Le favori « Envoyer vers MyGCFlow » est fait pour être glissé dans la
    // barre de favoris : un clic dessus depuis l'app serait un no-op.
    const bm = el('labsBookmarkletLink');
    if (bm) {
        bm.addEventListener('click', (e) => {
            e.preventDefault();
            showInfo(
                t('Glissez ce bouton dans la barre de favoris de votre navigateur, puis cliquez-le depuis la page de vos logs Adventure Lab.'),
                t('Envoyer vers MyGCFlow'));
        });
        loadBookmarklet(bm);
    }
    loadAutoFetchSetting();

    // Recharger la carte si des coordonnées ont été corrigées dans la modale.
    el('labsPendingModal')?.addEventListener('hidden.bs.modal', () => {
        if (!pendingDirty) return;
        pendingDirty = false;
        pkg.reloadMainDatasetAfterMutation?.();
    });

    // Un import peut démarrer hors de cet onglet (favori « Envoyer vers
    // MyGCFlow » → /api/labs/receive) : au retour sur l'onglet, le statut
    // expose la tâche active et watchActiveTask prend le relais — sinon le
    // favori importerait en silence, sans retour visuel.
    window.addEventListener('focus', refreshLabsStatus);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshLabsStatus();
    });

    refreshLabsStatus();
}

// ---------------------------------------------------------------- statut

export async function refreshLabsStatus() {
    const statusEl = el('labsStatus');
    if (!statusEl) return;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/labs/status`);
        const data = await r.json();
        if (!data.success) throw new Error(data.message || 'statut indisponible');
        renderLabsStatus(data);
        watchActiveTask(data.active_task);
    } catch (e) {
        console.warn('[LABS] statut indisponible:', e);
        statusEl.textContent = t('Statut indisponible');
    }
}

function renderLabsStatus(st) {
    const statusEl = el('labsStatus');
    const pendingAlert = el('labsPendingAlert');
    const pendingText = el('labsPendingText');
    const clearBtn = el('clearLabsBtn');
    const exportBtn = el('labsExportBtn');
    const total = st?.total || 0;
    const ready = st?.ready || 0;
    const unresolved = st?.unresolved || 0;
    pendingTotal = unresolved;

    if (statusEl) {
        if (total === 0) {
            statusEl.textContent = t('Aucune étape importée');
        } else {
            // Libellés résolus hors template literal pour l'extracteur Babel.
            const stepLabel = total > 1 ? t('étapes importées') : t('étape importée');
            const readyLabel = ready > 1 ? t('affichables') : t('affichable');
            const parts = [`${total} ${stepLabel}`, `${ready} ${readyLabel}`];
            if (unresolved > 0) parts.push(`${unresolved} ${t('en attente')}`);
            statusEl.textContent = parts.join(' · ');
        }
    }
    if (pendingAlert && pendingText) {
        pendingAlert.classList.toggle('d-none', unresolved === 0);
        if (unresolved > 0) {
            pendingText.textContent = t('${count} étape(s) sans coordonnées ni date exploitables — conservées mais non affichées.', { count: unresolved });
        }
    }
    if (clearBtn) clearBtn.style.display = total > 0 ? '' : 'none';
    if (exportBtn) exportBtn.style.display = total > 0 ? '' : 'none';
}

// Suit une tâche Labs lancée hors de cet onglet (favori bookmarklet →
// /api/labs/receive) : même polling et même bilan que si l'UI l'avait
// démarrée — progression affichée, puis statut rafraîchi + carte rechargée.
let watchingTaskId = null;
function watchActiveTask(active) {
    if (!active || !active.task_id || watchingTaskId === active.task_id) return;
    watchingTaskId = active.task_id;
    const isFetch = active.type === 'lab_fetch_coords';
    pollLabTask(active.task_id, {
        onFinished: isFetch ? onFetchFinished : onImportFinished,
        onProgress: isFetch
            ? (p) => setFetchProgress(`${t('Récupération des coordonnées…')} ${p}%`)
            : null,   // défaut de pollLabTask : « Import en cours… »
    }).catch(e => {
        showError(e.message || t('Erreur de récupération'), t('Lab Caches'));
    }).finally(() => { watchingTaskId = null; });
}

// ---------------------------------------------------------------- import

async function onLabsFilesChosen() {
    const files = Array.from(labsFileInput?.files || []);
    labsFileInput.value = '';   // même fichier re-sélectionnable
    if (!files.length) return;

    setImportProgress(t('Analyse des fichiers…'));
    try {
        const fd = new FormData();
        files.forEach(f => fd.append('files', f));
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/import/preview`, { method: 'POST', body: fd });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            throw new Error(previewErrorMessage(data));
        }
        importToken = data.import_token;
        renderPreviewModal(data);
        showBsModal(el('labsPreviewModal'));
    } catch (e) {
        showError(e.message || t("Erreur lors de l'analyse"), t('Import Lab Caches'));
    } finally {
        setImportProgress('');
    }
}

function setImportProgress(text) {
    const progress = el('labsImportProgress');
    if (progress) progress.textContent = text || '';
}

// Message d'échec complet de l'aperçu (ex. aucun fichier exploitable) :
// chaque erreur est attribuée à son fichier, pas seulement résumée.
const PREVIEW_ERRORS_SHOWN = 3;
function previewErrorMessage(data) {
    const base = data?.message || t('Import impossible');
    const errors = (data?.files || [])
        .filter(rep => rep.status === 'error' && rep.error)
        .map(rep => `${rep.name} : ${rep.error}`);
    if (!errors.length) return base;
    const shown = errors.slice(0, PREVIEW_ERRORS_SHOWN);
    if (errors.length > shown.length) {
        shown.push(t('… et ${n} autre(s)', { n: errors.length - shown.length }));
    }
    return `${base} — ${shown.join(' ; ')}`;
}

function fmtLabel(format) {
    return format === 'mygcflow-lab-finds' ? t('historique')
        : format === 'lab2gpx-gpx' ? t('coordonnées')
        : format || '?';
}

function summaryBits(summary) {
    if (!summary) return [];
    const bits = [];
    if (summary.added) bits.push(t('${n} nouvelle(s)', { n: summary.added }));
    if (summary.updated) bits.push(t('${n} mise(s) à jour', { n: summary.updated }));
    if (summary.unchanged) bits.push(t('${n} identique(s)', { n: summary.unchanged }));
    if (summary.resolved) bits.push(t('${n} résolue(s)', { n: summary.resolved }));
    if (summary.ignored) bits.push(t('${n} ignorée(s)', { n: summary.ignored }));
    if (summary.rejected) bits.push(t('${n} rejetée(s)', { n: summary.rejected }));
    if (summary.conflicts) bits.push(t('${n} conflit(s)', { n: summary.conflicts }));
    return bits;
}

function renderPreviewModal(data) {
    const filesEl = el('labsPreviewFiles');
    const summaryEl = el('labsPreviewSummary');
    const projectedEl = el('labsPreviewProjected');
    if (!filesEl) return;

    filesEl.textContent = '';
    const list = document.createElement('ul');
    list.className = 'list-unstyled mb-0 small';
    for (const rep of (data.files || [])) {
        const li = document.createElement('li');
        li.className = 'mb-1';
        const name = document.createElement('strong');
        name.textContent = rep.name;
        li.appendChild(name);
        const tail = document.createElement('span');
        if (rep.status === 'error') {
            tail.className = 'text-danger';
            tail.textContent = ` — ${rep.error || t('illisible')}`;
        } else {
            const bits = summaryBits(rep.summary);
            tail.textContent = ` (${fmtLabel(rep.format)}) : ${bits.join(', ') || t('rien de nouveau')}`;
        }
        li.appendChild(tail);
        list.appendChild(li);
    }
    filesEl.appendChild(list);

    if (summaryEl) {
        const totals = data.totals || {};
        const bits = summaryBits(totals);
        summaryEl.textContent = `${t('Total')} : ${bits.join(', ') || t('aucun changement')}`;
    }

    renderPreviewConflicts(data.conflicts_detail || []);
    renderPreviewWarnings(data.warnings || []);

    if (projectedEl) {
        const p = data.projected;
        if (p && typeof p.total === 'number') {
            projectedEl.classList.remove('d-none');
            projectedEl.textContent = t('Après import : ${total} étape(s), dont ${ready} affichable(s) et ${pending} en attente.',
                { total: p.total, ready: p.ready, pending: p.unresolved });
        } else {
            projectedEl.classList.add('d-none');
        }
    }
}

// Les listes de diagnostics sont bornées côté serveur : la dernière entrée
// `{truncated: n}` dit combien manquent.
function splitTruncated(items) {
    const last = items[items.length - 1];
    return typeof last?.truncated === 'number'
        ? { shown: items.slice(0, -1), hidden: last.truncated }
        : { shown: items, hidden: 0 };
}

function conflictValue(field, value) {
    if (field === 'coordinates' && Array.isArray(value)) {
        return value.map(v => Number(v).toFixed(5)).join(', ');
    }
    return value == null ? '—' : String(value);
}

function conflictFieldLabel(field) {
    return field === 'coordinates' ? t('coordonnées')
        : field === 'found_date' ? t('date')
        : field === 'adventure_uuid' ? t("identifiant d'Adventure")
        : field === 'stage_uuid' ? t("identifiant d'étape")
        : field;
}

// Conflits : la valeur existante est conservée par défaut. Date et
// coordonnées se tranchent ici (radios) ; un identifiant contradictoire est
// seulement signalé. Titres en textContent — données importées.
function renderPreviewConflicts(items) {
    const box = el('labsPreviewConflicts');
    if (!box) return;
    const { shown, hidden } = splitTruncated(items);
    previewConflicts = shown;
    box.textContent = '';
    box.classList.toggle('d-none', shown.length === 0);
    if (!shown.length) return;

    const title = document.createElement('div');
    title.className = 'fw-bold small mb-1';
    title.textContent = t('Conflits (${n}) — sans choix de votre part, la valeur existante est conservée',
        { n: shown.length + hidden });
    box.appendChild(title);

    shown.forEach((c, i) => {
        const item = document.createElement('div');
        item.className = 'border rounded p-2 mb-1 small';
        item.dataset.conflictIndex = String(i);

        const head = document.createElement('div');
        const stage = document.createElement('strong');
        stage.textContent = c.stage_title || t('(étape sans titre)');
        head.appendChild(stage);
        const what = document.createElement('span');
        what.className = 'text-muted';
        const adventure = c.adventure_title ? ` — ${c.adventure_title}` : '';
        what.textContent = `${adventure} · ${conflictFieldLabel(c.field)}`;
        head.appendChild(what);
        item.appendChild(head);

        const values = document.createElement('div');
        // Libellés résolus hors template literal pour l'extracteur Babel.
        const keptLabel = t('conservé');
        const receivedLabel = t('reçu');
        const manualLabel = t('(correction manuelle)');
        const manual = c.protected === 'user_correction' ? ` ${manualLabel}` : '';
        values.textContent = `${keptLabel} : ${conflictValue(c.field, c.existing)}${manual} · `
            + `${receivedLabel} : ${conflictValue(c.field, c.incoming)}`;
        item.appendChild(values);

        if (c.field === 'coordinates' || c.field === 'found_date') {
            const choices = document.createElement('div');
            choices.className = 'mt-1';
            for (const [value, label] of [['keep', t('Garder')], ['replace', t('Remplacer')]]) {
                const wrap = document.createElement('label');
                wrap.className = 'form-check form-check-inline mb-0';
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.className = 'form-check-input';
                radio.name = `lab-conflict-${i}`;
                radio.value = value;
                radio.checked = value === 'keep';
                const text = document.createElement('span');
                text.className = 'form-check-label';
                text.textContent = label;
                wrap.appendChild(radio);
                wrap.appendChild(text);
                choices.appendChild(wrap);
            }
            item.appendChild(choices);
        }
        box.appendChild(item);
    });

    if (hidden > 0) {
        const more = document.createElement('div');
        more.className = 'form-hint text-muted';
        more.textContent = t('… et ${n} autre(s)', { n: hidden });
        box.appendChild(more);
    }
}

// Conflits que l'utilisateur tranche pour la valeur reçue : la valeur fait
// partie du choix, le serveur ne l'applique qu'à ce conflit précis.
function collectOverrides() {
    const box = el('labsPreviewConflicts');
    if (!box) return [];
    const overrides = [];
    previewConflicts.forEach((c, i) => {
        const picked = box.querySelector(`input[name="lab-conflict-${i}"]:checked`);
        if (picked?.value === 'replace') {
            overrides.push({ local_uid: c.local_uid, field: c.field, incoming: c.incoming });
        }
    });
    return overrides;
}

function renderPreviewWarnings(items) {
    const box = el('labsPreviewWarnings');
    if (!box) return;
    const { shown, hidden } = splitTruncated(items);
    box.textContent = '';
    box.open = false;
    box.classList.toggle('d-none', shown.length === 0);
    if (!shown.length) return;

    const summary = document.createElement('summary');
    summary.textContent = t('Avertissements (${n})', { n: shown.length + hidden });
    box.appendChild(summary);
    const list = document.createElement('ul');
    list.className = 'mb-0 ps-3';
    for (const w of shown) {
        const li = document.createElement('li');
        li.textContent = w.count > 1 ? `${w.reason} (×${w.count})` : (w.reason || '');
        list.appendChild(li);
    }
    if (hidden > 0) {
        const li = document.createElement('li');
        li.textContent = t('… et ${n} autre(s)', { n: hidden });
        list.appendChild(li);
    }
    box.appendChild(list);
}

async function onPreviewConfirm() {
    const overrides = collectOverrides();
    hideBsModal(el('labsPreviewModal'));
    if (!importToken) return;
    const token = importToken;
    importToken = null;

    setImportProgress(t('Import en cours…'));
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/import/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ import_token: token, overrides }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success || !data.task_id) {
            throw new Error(data.message || t('Import refusé'));
        }
        // Marque la tâche comme suivie pour que watchActiveTask ne démarre
        // pas un second poller sur un focus/visibilitychange.
        watchingTaskId = data.task_id;
        await pollLabTask(data.task_id);
        watchingTaskId = null;
    } catch (e) {
        setImportProgress('');
        showError(e.message || t("Erreur lors de l'import"), t('Import Lab Caches'));
    }
}

// Suivi de la tâche d'import : même mécanique que pollGeojsonTask (bdd.js)
// mais locale — le résultat est un résumé, pas un GeoJSON. `onFinished` et
// `onProgress` sont injectables : la tâche de récupération de coordonnées
// réutilise le même polling avec ses propres rendus.
function pollLabTask(taskId, { intervalMs = 500, stallTimeoutMs = 120000,
                               onFinished = onImportFinished, onProgress = null } = {}) {
    return new Promise((resolve, reject) => {
        let lastActivityAt = Date.now();
        let consecutiveErrors = 0;
        const tick = () => {
            if (Date.now() - lastActivityAt > stallTimeoutMs) {
                reject(new Error(t("Délai d'attente dépassé")));
                return;
            }
            fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`)
                .then(r => r.json())
                .then(status => {
                    lastActivityAt = Date.now();
                    consecutiveErrors = 0;
                    if (status?.state === 'finished') {
                        onFinished(status.result || {});
                        resolve(status.result);
                        return;
                    }
                    if (status?.state === 'failed') {
                        reject(new Error(status?.error || t('Import échoué')));
                        return;
                    }
                    if (typeof status?.progress === 'number') {
                        if (onProgress) onProgress(status.progress);
                        else setImportProgress(`${t('Import en cours…')} ${status.progress}%`);
                    }
                    setTimeout(tick, intervalMs);
                })
                .catch(err => {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 10) { reject(err); return; }
                    setTimeout(tick, intervalMs);
                });
        };
        tick();
    });
}

async function onImportFinished(result) {
    setImportProgress('');
    if (!result || result.success === false) {
        showError(t("L'import a échoué"), t('Import Lab Caches'));
        return;
    }
    const total = result.total || 0;
    const ready = result.ready_total || 0;
    const unresolved = result.unresolved || 0;
    let msg = t('${added} étape(s) importée(s) — ${ready} affichable(s), ${pending} en attente.',
        { added: (result.added || 0) + (result.updated || 0), ready, pending: unresolved });
    if ((result.conflicts || 0) > 0) {
        // Import sans aperçu (favori) ou conflits laissés tels quels.
        msg += ' ' + t('${n} conflit(s) — valeurs existantes conservées.', { n: result.conflicts });
    }
    showSuccess(msg, t('Import Lab Caches'));
    refreshLabsStatus();
    await suggestSourceAfterImport(ready, total);
    pkg.reloadMainDatasetAfterMutation?.();
}

// Après un premier import Labs visible : les proposer à l'affichage.
// « geocaches » seul les masquerait — « both » si des géocaches existent,
// « labs » sinon (données immédiatement visibles).
async function suggestSourceAfterImport(readyCount, totalCount) {
    if (readyCount <= 0 && totalCount <= 0) return;
    try {
        const mode = pkg.getDiscoverySourcesMode?.() || 'geocaches';
        if (mode !== 'geocaches') return;   // Labs déjà affichés
        let hasGeocaches = false;
        try {
            const r = await fetch(`${CONFIG.BASE_URL}/db_status`);
            const s = await r.json();
            hasGeocaches = (s?.sources?.geocaches || 0) > 0;
        } catch (_) { /* repli : afficher les deux */ }
        await pkg.setDiscoverySourcesMode?.(hasGeocaches ? 'both' : 'labs');
        showInfo(t('Les Lab Caches sont maintenant affichés (réglable via « Découvertes affichées »).'), t('Lab Caches'));
    } catch (e) {
        console.warn('[LABS] bascule des sources après import:', e);
    }
}

// --------------------------------------- récupération auto des coordonnées
//
// Opt-in documenté : les UUID d'Adventures sont envoyés au service public
// lab2gpx (aucun identifiant de compte). Le serveur fait les appels, parse
// les GPX retournés et enrichit les étapes par le même chemin que l'import.

async function loadBookmarklet(link) {
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/labs/bookmarklet`);
        const d = await r.json();
        if (d.success && d.bookmarklet) link.href = d.bookmarklet;
    } catch (e) {
        console.warn('[LABS] bookmarklet indisponible:', e);
    }
}

async function loadAutoFetchSetting() {
    const box = el('labsAutoFetch');
    if (!box) return;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/settings`);
        const d = await r.json();
        box.checked = !!d.labs_auto_fetch_coords;
    } catch (e) {
        console.warn('[LABS] réglage auto-fetch illisible:', e);
    }
}

async function onAutoFetchToggle() {
    const box = el('labsAutoFetch');
    if (!box) return;
    const wanted = box.checked;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labs_auto_fetch_coords: wanted }),
        });
        if (!r.ok) throw new Error('refusé');
        // Cocher avec des étapes déjà en attente déclenche tout de suite —
        // c'est l'effet attendu du réglage, pas seulement pour les imports futurs.
        if (wanted && (pendingTotal || 0) > 0) onFetchNow();
    } catch (e) {
        box.checked = !wanted;
        showError(t('Réglage non enregistré'), t('Lab Caches'));
    }
}

function setFetchProgress(text) {
    const progressEl = el('labsFetchProgress');
    if (progressEl) progressEl.textContent = text || '';
}

async function onFetchNow() {
    const btn = el('labsFetchBtn');
    if (btn) btn.disabled = true;
    setFetchProgress(t('Récupération des coordonnées…'));
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/fetch-coordinates`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success || !data.task_id) {
            throw new Error(data.message || t('Récupération refusée'));
        }
        watchingTaskId = data.task_id;   // déjà suivi — voir watchActiveTask
        await pollLabTask(data.task_id, {
            onFinished: onFetchFinished,
            onProgress: (p) => setFetchProgress(`${t('Récupération des coordonnées…')} ${p}%`),
        });
    } catch (e) {
        setFetchProgress('');
        showError(e.message || t('Erreur de récupération'), t('Lab Caches'));
    } finally {
        watchingTaskId = null;
        if (btn) btn.disabled = false;
    }
}

async function onFetchFinished(result) {
    setFetchProgress('');
    if (!result || result.success === false) {
        showError(t('La récupération a échoué'), t('Lab Caches'));
        return;
    }
    const resolved = result.resolved || 0;
    const failed = (result.failed_uuids || []).length;
    const pending = result.unresolved || 0;
    let msg = t('${n} étape(s) ont reçu des coordonnées.', { n: resolved });
    if (failed > 0) {
        msg += ' ' + t('${n} Adventure(s) introuvable(s) par le service.', { n: failed });
    }
    if (pending > 0) {
        msg += ' ' + t('${n} étape(s) restent en attente.', { n: pending });
    }
    if (result.interrupted) {
        // Bilan partiel : les lots déjà reçus sont enregistrés, le reste
        // attend une relance.
        console.warn('[LABS] récupération interrompue:', result.error);
        msg += ' ' + t('Le service a cessé de répondre avant la fin — relancez la récupération pour terminer.');
        showWarning(msg, t('Lab Caches'));
    } else {
        showSuccess(msg, t('Lab Caches'));
    }
    refreshLabsStatus();
    pkg.reloadMainDatasetAfterMutation?.();
}

// ------------------------------------------------- étapes en attente

async function openPendingModal() {
    pendingOffset = 0;
    showBsModal(el('labsPendingModal'));
    await loadPendingPage(0);
}

async function loadPendingPage(offset) {
    const listEl = el('labsPendingList');
    if (!listEl) return;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/labs/unresolved?limit=${PENDING_PAGE_SIZE}&offset=${Math.max(0, offset)}`);
        const data = await r.json();
        if (!data.success) throw new Error(data.message || 'erreur');
        pendingOffset = data.offset || 0;
        renderPendingList(data.items || []);
        updatePendingPager();
    } catch (e) {
        listEl.textContent = t('Chargement impossible');
    }
}

function updatePendingPager() {
    const prev = el('labsPendingPrev');
    const next = el('labsPendingNext');
    const page = el('labsPendingPage');
    const total = pendingTotal || 0;
    if (prev) prev.disabled = pendingOffset <= 0;
    if (next) next.disabled = pendingOffset + PENDING_PAGE_SIZE >= total;
    if (page) {
        const start = total === 0 ? 0 : pendingOffset + 1;
        const end = Math.min(pendingOffset + PENDING_PAGE_SIZE, total);
        page.textContent = `${start}–${end} / ${total}`;
    }
}

function renderPendingList(items) {
    const listEl = el('labsPendingList');
    listEl.textContent = '';
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'form-hint text-muted';
        empty.textContent = t('Aucune étape en attente sur cette page.');
        listEl.appendChild(empty);
        return;
    }
    for (const item of items) {
        listEl.appendChild(buildPendingRow(item));
    }
}

// Une ligne par étape : titres (textContent — jamais innerHTML, données
// importées), motifs de l'attente, champs latitude/longitude/date et
// enregistrement individuel.
function buildPendingRow(item) {
    const row = document.createElement('div');
    row.className = 'border rounded p-2 mb-2';
    row.dataset.localUid = item.local_uid;

    const head = document.createElement('div');
    head.className = 'small mb-1';
    const stage = document.createElement('strong');
    stage.textContent = item.stage_title || t('(étape sans titre)');
    head.appendChild(stage);
    const adv = document.createElement('span');
    adv.className = 'text-muted';
    adv.textContent = ` — ${item.adventure_title || ''}`;
    head.appendChild(adv);
    if (item.is_archived) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-secondary-lt ms-1';
        badge.textContent = t('archivée');
        head.appendChild(badge);
    }
    row.appendChild(head);

    const reasons = document.createElement('div');
    reasons.className = 'form-hint text-muted mb-2';
    const reasonLabels = (item.reasons || []).map(r =>
        r === 'missing_date' ? t('date manquante')
        : r === 'missing_coordinates' ? t('coordonnées manquantes')
        : r === 'coordinates_unavailable' ? t('introuvables par le service lab2gpx')
        : r);
    reasons.textContent = reasonLabels.join(' · ');
    row.appendChild(reasons);

    // Proposition (même titre dans l'Adventure, étape remaniée) : elle ne
    // fait que préremplir les champs — « Enregistrer » reste la validation.
    const suggestion = item.suggestion;
    if (suggestion) {
        const hint = document.createElement('div');
        hint.className = 'small mb-2';
        const text = document.createElement('span');
        text.textContent = t("Suggestion : ${lat}, ${lon} — même titre dans l'Adventure", {
            lat: Number(suggestion.latitude).toFixed(5),
            lon: Number(suggestion.longitude).toFixed(5),
        }) + ' ';
        hint.appendChild(text);
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'btn btn-sm btn-outline-primary';
        useBtn.dataset.action = 'use-suggestion';
        useBtn.textContent = t('Utiliser la suggestion');
        useBtn.addEventListener('click', () => {
            row.querySelector('input[data-field="lat"]').value = String(suggestion.latitude);
            row.querySelector('input[data-field="lon"]').value = String(suggestion.longitude);
        });
        hint.appendChild(useBtn);
        row.appendChild(hint);
    }

    const form = document.createElement('div');
    form.className = 'd-flex flex-wrap gap-2 align-items-end';
    form.appendChild(makePendingInput('lat', t('Latitude'), item.latitude, '48.8584'));
    form.appendChild(makePendingInput('lon', t('Longitude'), item.longitude, '2.2945'));
    const dateWrap = makePendingInput('date', t('Date de découverte'), item.found_date || '', 'AAAA-MM-JJ');
    const dateInput = dateWrap.querySelector('input');
    if (dateInput) dateInput.setAttribute('type', 'date');
    form.appendChild(dateWrap);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = t('Enregistrer');
    saveBtn.addEventListener('click', () => onResolveRow(row, item.local_uid));
    form.appendChild(saveBtn);

    const feedback = document.createElement('span');
    feedback.className = 'small';
    form.appendChild(feedback);
    row.appendChild(form);
    return row;
}

function makePendingInput(key, label, value, placeholder) {
    const wrap = document.createElement('div');
    const lab = document.createElement('label');
    lab.className = 'form-label small mb-0';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm';
    input.dataset.field = key;
    input.placeholder = placeholder;
    if (value !== null && typeof value !== 'undefined') input.value = String(value);
    const id = `lab-pending-${key}-${Math.random().toString(36).slice(2, 8)}`;
    lab.setAttribute('for', id);
    input.id = id;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
}

async function onResolveRow(row, localUid) {
    const val = (key) => row.querySelector(`input[data-field="${key}"]`)?.value?.trim() || '';
    const feedback = row.querySelector('span.small');
    const body = {};
    if (val('lat') || val('lon')) {
        body.latitude = val('lat');
        body.longitude = val('lon');
    }
    if (val('date')) body.found_date = val('date');
    if (!Object.keys(body).length) {
        if (feedback) { feedback.className = 'small text-warning'; feedback.textContent = t('Rien à enregistrer'); }
        return;
    }
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/discoveries/${encodeURIComponent(localUid)}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) throw new Error(data.message || t('Correction refusée'));
        pendingDirty = true;
        pendingTotal = data.unresolved;
        if (typeof data.unresolved === 'number' && data.unresolved <= 0) {
            // Plus rien en attente : la ligne disparaît avec la modale.
            hideBsModal(el('labsPendingModal'));
        } else {
            row.classList.add('border-success');
            if (feedback) { feedback.className = 'small text-success'; feedback.textContent = t('Enregistré'); }
        }
        refreshLabsStatus();
    } catch (e) {
        if (feedback) { feedback.className = 'small text-danger'; feedback.textContent = e.message || t('Erreur'); }
    }
}

// ------------------------------------------------------ export / vidage

function onExportLabs() {
    // Téléchargement direct : la route pose Content-Disposition=attachment.
    window.location.href = `${CONFIG.BASE_URL}/api/labs/export`;
}

async function onClearLabs() {
    const confirmed = await new Promise(resolve => {
        pkg.showConfirmation?.(
            t('Supprimer toutes vos étapes Lab Caches ? Vos géocaches sont conservées. Cette action est irréversible.'),
            t('Confirmation de suppression'),
            () => resolve(true),
            () => resolve(false),
            { danger: true, confirmText: t('Supprimer mes Lab Caches') });
    });
    if (!confirmed) return;
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/clear`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) throw new Error(data.message || t('Erreur inconnue'));
        refreshLabsStatus();
        // Plus de Labs : revenir aux géocaches AVANT le rechargement pour
        // que l'affichage applique directement le nouveau mode.
        const mode = pkg.getDiscoverySourcesMode?.();
        if (mode === 'labs' || mode === 'both') {
            try { await pkg.setDiscoverySourcesMode?.('geocaches'); } catch (_) {}
        }
        // Les géocaches peuvent subsister : le rechargement affiche la
        // source restante au lieu de laisser un écran vide.
        pkg.reloadMainDatasetAfterMutation?.();
        showSuccess(t('Lab Caches supprimés'), t('Suppression réussie'));
    } catch (e) {
        showError(e.message || t('Erreur lors de la suppression'), t('Erreur'));
    }
}

// Initialisation au chargement du DOM (même pattern que ui.js).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLabsUI);
} else {
    initLabsUI();
}
