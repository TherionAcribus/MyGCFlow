// Interface « Mes Lab Caches » (onglet Données, mode Normal).
//
// La carte montre l'essentiel : l'état de la collection, le parcours en un
// clic (favori « Envoyer vers MyGCFlow ») et, pendant toute opération, un
// bloc d'activité qui nomme l'étape en cours. Le reste — import de fichiers
// avec aperçu, réglage du placement automatique, export — vit dans « Options
// avancées ». Complétion des étapes sans position/date et suppression
// gardent leurs boutons.
// Les éléments n'existent que sur la page principale : toutes les
// fonctions se replient en no-op en mode Évolution.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import {
    showSuccess, showError, showWarning, showInfo, t,
    showLoadingToast, updateToastMessage, updateToastProgress, setIndeterminateProgress, hideToast,
} from './notifications.js';
import { showBsModal, hideBsModal } from './ui_bootstrap.js';

// Adventures (groupes d'étapes en attente) par page de la modale.
const PENDING_PAGE_SIZE = 20;

let elementsBound = false;
let labsFileInput = null;
let importToken = null;        // jeton opaque retourné par /import/preview
let previewConflicts = [];     // conflits tranchables de l'aperçu affiché
let pendingOffset = 0;
let pendingGroupTotal = 0;     // Adventures ayant des étapes en attente
let fetchableAdventures = 0;   // Adventures qu'une récupération peut encore servir
let pendingDirty = false;      // une correction a été enregistrée → recharger
let guideOpen = false;         // parcours du favori rouvert via « Mettre à jour »
let knownCounts = null;        // derniers compteurs affichés ({ total, ready })
let watchingTaskId = null;     // tâche serveur suivie par le bloc d'activité
let activityToast = null;

// Relevé périodique du statut : un import lancé par le favori démarre hors de
// cette page, et l'onglet peut rester affiché sans jamais reprendre le focus.
// Seulement sur l'onglet Données, jamais pendant une animation ou une capture.
const STATUS_POLL_MS = 4000;
// Suivi d'une tâche serveur pendant une animation ou une capture : plus espacé.
const TASK_POLL_BUSY_MS = 2000;
// Attente du repos de la carte avant d'y appliquer un changement Labs.
const IDLE_CHECK_MS = 1000;

let deferredMapUpdate = null;  // { source } en attente du repos de la carte
let idleWaitTimer = null;

function el(id) { return document.getElementById(id); }

// Animation en lecture ou en pause, ou capture vidéo : la carte n'affiche
// qu'une partie des points et ne doit être ni vidée ni refiltrée.
function mapBusy() {
    return !!(pkg.isAnimationInProgress?.() || pkg.isRecordingActive?.());
}

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
    el('labsRetryFetchBtn')?.addEventListener('click', onFetchNow);
    el('labsUpdateBtn')?.addEventListener('click', () => {
        guideOpen = !guideOpen;
        renderGuide();
    });

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
        updateMapAfterLabsChange();
    });

    // Un import peut démarrer hors de cet onglet (favori « Envoyer vers
    // MyGCFlow » → /api/labs/receive) : le statut expose la tâche active et
    // le bloc d'activité prend le relais — sinon le favori importerait en
    // silence. Relevé au retour sur la fenêtre ou sur l'onglet Données, et
    // périodiquement tant que celui-ci est affiché. Rien pendant une
    // opération de cette page (elle suit déjà sa tâche : un second suivi
    // doublerait bilans et rechargements) ni pendant une animation ou une
    // capture.
    const checkOutside = () => {
        if (document.hidden || watchingTaskId || activityRunning() || mapBusy()) return;
        refreshLabsStatus({ detectOutside: true });
    };
    window.addEventListener('focus', checkOutside);
    document.addEventListener('visibilitychange', checkOutside);
    document.querySelector('a[href="#data"]')?.addEventListener('shown.bs.tab', checkOutside);
    setInterval(() => {
        if (el('data')?.classList.contains('active')) checkOutside();
    }, STATUS_POLL_MS);

    refreshLabsStatus();
}

// ---------------------------------------------------------------- statut

// Relit le statut serveur et l'affiche. `detectOutside` : relevé de
// surveillance — si les compteurs ont bougé sans tâche en cours ni action de
// cette page (import du favori déjà terminé), la carte est rechargée.
export async function refreshLabsStatus({ detectOutside = false } = {}) {
    const statusEl = el('labsStatus');
    if (!statusEl) return null;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/labs/status`);
        const data = await r.json();
        if (!data.success) throw new Error(data.message || 'statut indisponible');
        const total = data.total || 0;
        const ready = data.ready || 0;
        const moved = knownCounts !== null
            && (knownCounts.total !== total || knownCounts.ready !== ready);
        knownCounts = { total, ready };
        renderLabsStatus(data);
        if (data.active_task) {
            watchActiveTask(data.active_task);
        } else if (detectOutside && moved && !watchingTaskId) {
            showInfo(t('Vos Lab Caches ont été mis à jour.'), t('Lab Caches'));
            await updateMapAfterLabsChange('suggest');
        }
        return data;
    } catch (e) {
        console.warn('[LABS] statut indisponible:', e);
        statusEl.textContent = t('Statut indisponible');
        return null;
    }
}

function renderLabsStatus(st) {
    const statusEl = el('labsStatus');
    const pendingAlert = el('labsPendingAlert');
    const pendingText = el('labsPendingText');
    const total = st?.total || 0;
    const ready = st?.ready || 0;
    const unresolved = st?.unresolved || 0;
    fetchableAdventures = st?.fetchable_adventures || 0;
    // Proposer la récupération seulement si elle peut encore aboutir : quand
    // il ne reste que des étapes déjà tentées sans résultat, le bouton
    // inviterait à cliquer sans fin pour rien.
    const canFetch = fetchableAdventures > 0;

    if (statusEl) {
        if (total === 0) {
            statusEl.textContent = t('Aucun Lab Cache importé');
        } else {
            // Libellés résolus hors template literal pour l'extracteur Babel.
            const stepLabel = total > 1 ? t('étapes') : t('étape');
            const readyLabel = t('sur la carte');
            const pendingLabel = t('à compléter');
            const parts = [`${total} ${stepLabel}`, `${ready} ${readyLabel}`];
            if (unresolved > 0) parts.push(`${unresolved} ${pendingLabel}`);
            statusEl.textContent = parts.join(' · ');
        }
    }
    if (pendingAlert && pendingText) {
        // Pendant une opération, le bloc d'activité dit déjà ce qui se
        // passe : pas d'appel à l'action concurrent.
        pendingAlert.classList.toggle('d-none', unresolved === 0 || activityRunning());
        if (unresolved > 0) {
            pendingText.textContent = canFetch
                ? t('${count} étape(s) ne sont pas encore sur la carte : position ou date manquante.', { count: unresolved })
                : t("${count} étape(s) n'ont pas pu être placées automatiquement : leur position est introuvable. Vous pouvez les compléter à la main.", { count: unresolved });
        }
    }
    const fetchBtn = el('labsFetchBtn');
    if (fetchBtn) fetchBtn.style.display = canFetch ? '' : 'none';
    const retryBtn = el('labsRetryFetchBtn');
    if (retryBtn) retryBtn.style.display = (unresolved > 0 && !canFetch) ? '' : 'none';
    for (const id of ['clearLabsBtn', 'labsExportBtn', 'labsUpdateBtn']) {
        const btn = el(id);
        if (btn) btn.style.display = total > 0 ? '' : 'none';
    }
    renderGuide();
}

// Le parcours du favori s'affiche d'office tant que rien n'est importé ;
// ensuite il se replie derrière « Mettre à jour ».
function renderGuide() {
    const guide = el('labsGuide');
    if (!guide) return;
    const empty = (knownCounts?.total || 0) === 0;
    guide.hidden = !(empty || guideOpen);
    el('labsUpdateBtn')?.setAttribute('aria-expanded', String(!guide.hidden));
}

// ---------------------------------------------------------------- activité
//
// Un seul endroit dit qu'un travail est en cours : le bloc #labsActivity de
// la carte, doublé d'un toast visible depuis les autres onglets. Titre =
// étape en clair ; détail = message de progression du serveur.

function activityRunning() {
    const box = el('labsActivity');
    return !!box && !box.hidden;
}

function showActivity(title, { pct = null, detail = '' } = {}) {
    const box = el('labsActivity');
    if (box) {
        box.hidden = false;
        const titleEl = box.querySelector('.labs-activity-title');
        const detailEl = box.querySelector('.labs-activity-detail');
        const bar = box.querySelector('.labs-activity-bar');
        if (titleEl) titleEl.textContent = title;
        if (detailEl) detailEl.textContent = detail || '';
        if (bar) {
            const known = typeof pct === 'number' && isFinite(pct) && pct > 0;
            const value = known ? Math.min(100, Math.max(0, pct)) : 0;
            bar.classList.toggle('progress-bar-indeterminate', !known);
            bar.style.width = known ? `${value}%` : '100%';
            bar.setAttribute('aria-valuenow', String(value));
        }
    }
    el('labsPendingAlert')?.classList.add('d-none');
    for (const id of ['labs-file-btn', 'labsFetchBtn', 'labsRetryFetchBtn']) {
        const btn = el(id);
        if (btn) btn.disabled = true;
    }
    try {
        if (!activityToast) activityToast = showLoadingToast(title, t('Lab Caches'));
        else updateToastMessage(activityToast, detail ? `${title} ${detail}` : title);
        if (typeof pct === 'number' && pct > 0) updateToastProgress(activityToast, pct);
        else setIndeterminateProgress(activityToast);
    } catch (_) { /* le bloc de la carte suffit */ }
}

function hideActivity() {
    const box = el('labsActivity');
    if (box) box.hidden = true;
    for (const id of ['labs-file-btn', 'labsFetchBtn', 'labsRetryFetchBtn']) {
        const btn = el(id);
        if (btn) btn.disabled = false;
    }
    try { if (activityToast) hideToast(activityToast); } catch (_) {}
    activityToast = null;
}

// Tâche Labs trouvée en cours au relevé du statut (lancée par le favori ou
// par un autre onglet) : même suivi que si cette page l'avait démarrée.
function watchActiveTask(active) {
    if (!active || !active.task_id || watchingTaskId) return;
    if (active.type === 'lab_fetch_coords') followFetch(active.task_id);
    else followImport(active.task_id);
}

// ---------------------------------------------------------------- import

function onLabsFilesChosen() {
    const files = Array.from(labsFileInput?.files || []);
    labsFileInput.value = '';   // même fichier re-sélectionnable
    return importLabFiles(files);
}

// Aperçu puis import d'un lot de fichiers Lab Caches. Point d'entrée commun
// au bouton « Importer des fichiers… » et au glisser-déposer sur la fenêtre
// (bdd.js y route les fichiers Labs reconnus). No-op sur une page sans carte
// Labs (Évolution).
export async function importLabFiles(files) {
    files = Array.from(files || []);
    if (!files.length || !el('labsPreviewModal')) return;

    showActivity(t('Analyse de vos fichiers…'));
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
        hideActivity();
        refreshLabsStatus();
    }
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

    showActivity(t('Import de vos Lab Caches…'));
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
        await followImport(data.task_id);
    } catch (e) {
        hideActivity();
        refreshLabsStatus();
        showError(e.message || t("Erreur lors de l'import"), t('Import Lab Caches'));
    }
}

// Interroge une tâche serveur jusqu'à son terme : résout avec son résultat,
// rejette si elle échoue ou si le serveur ne répond plus. `onProgress` reçoit
// le pourcentage et le message de progression de la tâche.
function pollLabTask(taskId, onProgress, { intervalMs = 500, stallTimeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        let lastActivityAt = Date.now();
        let consecutiveErrors = 0;
        const nextDelay = () => (mapBusy() ? Math.max(intervalMs, TASK_POLL_BUSY_MS) : intervalMs);
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
                        resolve(status.result || {});
                        return;
                    }
                    if (status?.state === 'failed') {
                        reject(new Error(status?.error || t('Import échoué')));
                        return;
                    }
                    onProgress?.(status?.progress, status?.message || '');
                    setTimeout(tick, nextDelay());
                })
                .catch(err => {
                    consecutiveErrors++;
                    if (consecutiveErrors >= 10) { reject(err); return; }
                    setTimeout(tick, nextDelay());
                });
        };
        tick();
    });
}

// Suit une tâche en alimentant le bloc d'activité sous le titre donné.
function followTask(taskId, title) {
    watchingTaskId = taskId;
    showActivity(title);
    return pollLabTask(taskId, (pct, detail) => showActivity(title, { pct, detail }));
}

// Fin commune d'une séquence suivie : bloc retiré, compteurs relus, carte
// rechargée si des données ont changé.
async function settleActivity(changed) {
    watchingTaskId = null;
    hideActivity();
    const status = await refreshLabsStatus();
    if (!changed) return;
    await updateMapAfterLabsChange(status ? 'suggest' : null);
}

// Report des changements Labs sur la carte : choix des sources affichées
// (`source` : 'suggest' après un import, 'reset' après un vidage) puis
// rechargement du jeu principal. Pendant une animation ou une capture —
// un placement d'étapes dure plusieurs minutes et peut s'achever en plein
// enregistrement — vider la carte casserait la vidéo : la mise à jour attend
// le retour au repos. Une seule mise à jour en attente suffit, elle relit
// l'état courant du serveur ; la dernière source demandée l'emporte.
function updateMapAfterLabsChange(source = null) {
    if (!mapBusy()) return applyMapUpdate(source);
    deferredMapUpdate = { source: source || deferredMapUpdate?.source || null };
    if (!idleWaitTimer) {
        idleWaitTimer = setInterval(() => {
            if (mapBusy()) return;
            clearInterval(idleWaitTimer);
            idleWaitTimer = null;
            const pending = deferredMapUpdate;
            deferredMapUpdate = null;
            if (pending) applyMapUpdate(pending.source);
        }, IDLE_CHECK_MS);
    }
    return Promise.resolve();
}

async function applyMapUpdate(source) {
    if (source === 'suggest' && knownCounts) {
        await suggestSourceAfterImport(knownCounts.ready, knownCounts.total);
    } else if (source === 'reset') {
        // Plus de Labs : revenir aux géocaches AVANT le rechargement pour
        // que l'affichage applique directement le nouveau mode.
        const mode = pkg.getDiscoverySourcesMode?.();
        if (mode === 'labs' || mode === 'both') {
            try { await pkg.setDiscoverySourcesMode?.('geocaches'); } catch (_) {}
        }
    }
    pkg.reloadMainDatasetAfterMutation?.();
}

// Import, puis placement des étapes si le serveur l'enchaîne (son bilan porte
// alors `fetch_task_id`) : une seule séquence, bloc d'activité continu — c'est
// entre ces deux tâches que l'application semblait ne plus rien faire.
async function followImport(taskId) {
    let changed = false;
    try {
        const result = await followTask(taskId, t('Import de vos Lab Caches…'));
        if (result.success === false) throw new Error(t("L'import a échoué"));
        changed = true;
        reportImport(result);
        if (result.fetch_task_id) {
            reportFetch(await followTask(result.fetch_task_id, t('Placement de vos étapes sur la carte…')));
        }
    } catch (e) {
        showError(e.message || t("Erreur lors de l'import"), t('Import Lab Caches'));
    } finally {
        await settleActivity(changed);
    }
}

async function followFetch(taskId) {
    let changed = false;
    try {
        const result = await followTask(taskId, t('Placement de vos étapes sur la carte…'));
        changed = true;
        reportFetch(result);
    } catch (e) {
        showError(e.message || t('Erreur de récupération'), t('Lab Caches'));
    } finally {
        await settleActivity(changed);
    }
}

function reportImport(result) {
    const added = (result.added || 0) + (result.updated || 0);
    let msg = result.fetch_task_id
        // Les compteurs « sur la carte » n'ont pas encore de sens : le
        // placement démarre tout juste.
        ? t('${added} étape(s) importée(s). Placement sur la carte en cours…', { added })
        : t('${added} étape(s) importée(s) — ${ready} affichable(s), ${pending} en attente.',
            { added, ready: result.ready_total || 0, pending: result.unresolved || 0 });
    if ((result.conflicts || 0) > 0) {
        // Import sans aperçu (favori) ou conflits laissés tels quels.
        msg += ' ' + t('${n} conflit(s) — valeurs existantes conservées.', { n: result.conflicts });
    }
    showSuccess(msg, t('Import Lab Caches'));
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

// ------------------------------------- placement automatique des étapes
//
// Les UUID d'Adventures sont envoyés au service public lab2gpx (aucun
// identifiant de compte) — activé par défaut, annoncé dans la carte et
// réglable dans les options avancées. Le serveur fait les appels, parse les
// GPX retournés et enrichit les étapes par le même chemin que l'import.

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
        if (wanted && fetchableAdventures > 0) onFetchNow();
    } catch (e) {
        box.checked = !wanted;
        showError(t('Réglage non enregistré'), t('Lab Caches'));
    }
}

async function onFetchNow() {
    showActivity(t('Placement de vos étapes sur la carte…'));
    try {
        const resp = await fetch(`${CONFIG.BASE_URL}/api/labs/fetch-coordinates`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success || !data.task_id) {
            throw new Error(data.message || t('Récupération refusée'));
        }
        await followFetch(data.task_id);
    } catch (e) {
        hideActivity();
        refreshLabsStatus();
        showError(e.message || t('Erreur de récupération'), t('Lab Caches'));
    }
}

function reportFetch(result) {
    if (!result || result.success === false) {
        showError(t('La récupération a échoué'), t('Lab Caches'));
        return;
    }
    const resolved = result.resolved || 0;
    const failed = (result.failed_uuids || []).length;
    const pending = result.unresolved || 0;
    let msg = t('${n} étape(s) placée(s) sur la carte.', { n: resolved });
    if (failed > 0) {
        msg += ' ' + t('${n} Adventure(s) introuvable(s) par le service.', { n: failed });
    }
    if (pending > 0) {
        msg += ' ' + t('${n} étape(s) restent à compléter.', { n: pending });
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
}

// ------------------------------------------------- étapes en attente
//
// Une carte par Adventure : les étapes d'une Adventure archivée attendent
// ensemble, et une seule position (saisie au format du géocacheur) peut toutes
// les placer. Le détail des étapes reste disponible pour une position ou une
// date propre à chacune.

async function openPendingModal() {
    pendingOffset = 0;
    showBsModal(el('labsPendingModal'));
    await loadPendingPage(0);
}

async function loadPendingPage(offset) {
    const listEl = el('labsPendingList');
    if (!listEl) return;
    try {
        const r = await fetch(`${CONFIG.BASE_URL}/api/labs/unresolved/adventures?limit=${PENDING_PAGE_SIZE}&offset=${Math.max(0, offset)}`);
        const data = await r.json();
        if (!data.success) throw new Error(data.message || 'erreur');
        pendingOffset = data.offset || 0;
        pendingGroupTotal = data.total || 0;
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
    const total = pendingGroupTotal || 0;
    if (prev) prev.disabled = pendingOffset <= 0;
    if (next) next.disabled = pendingOffset + PENDING_PAGE_SIZE >= total;
    if (page) {
        const start = total === 0 ? 0 : pendingOffset + 1;
        const end = Math.min(pendingOffset + PENDING_PAGE_SIZE, total);
        const unit = t('Adventure(s)');
        page.textContent = `${start}–${end} / ${total} ${unit}`;
    }
}

function renderPendingList(groups) {
    const listEl = el('labsPendingList');
    listEl.textContent = '';
    if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'form-hint text-muted';
        empty.textContent = t('Aucune étape en attente sur cette page.');
        listEl.appendChild(empty);
        return;
    }
    for (const group of groups) {
        listEl.appendChild(buildPendingGroup(group));
    }
}

function fmtCoord(value) {
    return Number(value).toFixed(5);
}

// Carte d'une Adventure : titre (textContent — données importées), état,
// position commune quand plusieurs étapes en manquent, détail des étapes.
function buildPendingGroup(group) {
    const stages = group.stages || [];
    const card = document.createElement('div');
    card.className = 'border rounded p-2 mb-2';
    card.dataset.adventureKey = group.key;

    const head = document.createElement('div');
    head.className = 'small';
    const title = document.createElement('strong');
    title.textContent = group.adventure_title || t('Adventure inconnue');
    head.appendChild(title);
    if (group.is_archived) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-secondary-lt ms-1';
        badge.textContent = t('archivée');
        head.appendChild(badge);
    }
    const count = document.createElement('span');
    count.className = 'text-muted';
    const countLabel = t('${n} étape(s) en attente', { n: stages.length });
    count.textContent = ` — ${countLabel}`;
    head.appendChild(count);
    card.appendChild(head);

    const placeAll = !!group.adventure_uuid && (group.missing_coordinates || 0) > 1;
    if (placeAll) card.appendChild(buildPlaceAdventureRow(card, group));

    if (stages.length === 1) {
        card.appendChild(buildPendingRow(stages[0]));
        return card;
    }
    const details = document.createElement('details');
    details.className = 'mt-2';
    // Ouvert d'office quand une position commune ne suffit pas : pas de
    // placement groupé, suggestion à valider ou date à compléter.
    details.open = !placeAll || stages.some(s =>
        s.suggestion || (s.reasons || []).includes('missing_date'));
    const summary = document.createElement('summary');
    summary.className = 'small';
    summary.textContent = t('Détail des étapes');
    details.appendChild(summary);
    for (const stage of stages) details.appendChild(buildPendingRow(stage));
    card.appendChild(details);
    return card;
}

// Position commune : toutes les étapes sans position de l'Adventure, portée
// « adventure » (le popup la dit approximative).
function buildPlaceAdventureRow(card, group) {
    const wrap = document.createElement('div');
    wrap.className = 'mt-2';
    const form = document.createElement('div');
    form.className = 'd-flex flex-wrap gap-2 align-items-end';
    const field = makePendingInput('adventure-coords', t("Position de l'Adventure"), '', 'N 48° 51.504 E 002° 17.670');
    field.classList.add('flex-grow-1');
    form.appendChild(field);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-primary';
    btn.dataset.action = 'place-adventure';
    btn.textContent = t('Placer les ${n} étapes ici', { n: group.missing_coordinates });
    btn.addEventListener('click', () => onPlaceAdventure(card, wrap, group));
    form.appendChild(btn);
    submitOnEnter(form, btn);
    wrap.appendChild(form);

    const hint = document.createElement('div');
    hint.className = 'form-hint text-muted';
    hint.textContent = t('Toutes ses étapes sans position y seront placées, signalées comme approximatives.');
    wrap.appendChild(hint);
    const feedback = document.createElement('div');
    feedback.className = 'small';
    feedback.dataset.role = 'feedback';
    wrap.appendChild(feedback);
    return wrap;
}

// Une ligne par étape : titre, motifs de l'attente, position (un seul champ,
// formats du géocacheur), date et enregistrement individuel.
function buildPendingRow(item) {
    const row = document.createElement('div');
    row.className = 'border-top pt-2 mt-2';
    row.dataset.localUid = item.local_uid;

    const head = document.createElement('div');
    head.className = 'small';
    const stage = document.createElement('span');
    stage.className = 'fw-medium';
    stage.textContent = item.stage_title || t('(étape sans titre)');
    head.appendChild(stage);
    row.appendChild(head);

    const reasons = document.createElement('div');
    reasons.className = 'form-hint text-muted mb-1';
    const reasonLabels = (item.reasons || []).map(r =>
        r === 'missing_date' ? t('date manquante')
        : r === 'missing_coordinates' ? t('coordonnées manquantes')
        : r === 'coordinates_unavailable' ? t('introuvables par le service lab2gpx')
        : r);
    reasons.textContent = reasonLabels.join(' · ');
    row.appendChild(reasons);

    const form = document.createElement('div');
    form.className = 'd-flex flex-wrap gap-2 align-items-end';
    const coordsField = makePendingInput('coords', t('Position'), '', 'N 48° 51.504 E 002° 17.670');
    coordsField.classList.add('flex-grow-1');
    form.appendChild(coordsField);

    // Proposition (même titre dans l'Adventure, étape remaniée) : elle ne
    // fait que préremplir le champ — « Enregistrer » reste la validation.
    const suggestion = item.suggestion;
    if (suggestion) {
        const hint = document.createElement('div');
        hint.className = 'small mb-1';
        const text = document.createElement('span');
        text.textContent = t("Suggestion : ${lat}, ${lon} — même titre dans l'Adventure", {
            lat: fmtCoord(suggestion.latitude),
            lon: fmtCoord(suggestion.longitude),
        }) + ' ';
        hint.appendChild(text);
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'btn btn-sm btn-outline-primary';
        useBtn.dataset.action = 'use-suggestion';
        useBtn.textContent = t('Utiliser la suggestion');
        useBtn.addEventListener('click', () => {
            coordsField.querySelector('input').value = `${suggestion.latitude}, ${suggestion.longitude}`;
        });
        hint.appendChild(useBtn);
        row.appendChild(hint);
    }

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
    submitOnEnter(form, saveBtn);
    row.appendChild(form);

    const feedback = document.createElement('div');
    feedback.className = 'small';
    feedback.dataset.role = 'feedback';
    row.appendChild(feedback);
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

// Entrée dans un champ = clic sur le bouton de sa ligne.
function submitOnEnter(form, button) {
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            button.click();
        }
    });
}

function setFeedback(container, kind, text) {
    const fb = container.querySelector(':scope > [data-role="feedback"]');
    if (!fb) return;
    fb.className = `small text-${kind}`;
    fb.textContent = text;
}

// Après une correction : compteurs relus, carte rechargée à la fermeture de
// la modale, modale fermée s'il ne reste rien.
function afterPendingCorrection(data) {
    pendingDirty = true;
    if (typeof data.unresolved === 'number' && data.unresolved <= 0) {
        hideBsModal(el('labsPendingModal'));
    }
    refreshLabsStatus();
}

async function postCorrection(url, body) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) throw new Error(data.message || t('Correction refusée'));
    return data;
}

async function onPlaceAdventure(card, wrap, group) {
    const text = wrap.querySelector('input[data-field="adventure-coords"]')?.value?.trim() || '';
    if (!text) {
        setFeedback(wrap, 'warning', t('Rien à enregistrer'));
        return;
    }
    try {
        const data = await postCorrection(
            `${CONFIG.BASE_URL}/api/labs/adventures/${encodeURIComponent(group.adventure_uuid)}/place`,
            { coordinates: text });
        card.classList.add('border-success');
        wrap.querySelector('[data-action="place-adventure"]')?.setAttribute('disabled', '');
        setFeedback(wrap, 'success', t('${n} étape(s) placée(s) en ${lat}, ${lon}.', {
            n: data.placed, lat: fmtCoord(data.latitude), lon: fmtCoord(data.longitude),
        }));
        afterPendingCorrection(data);
    } catch (e) {
        setFeedback(wrap, 'danger', e.message || t('Erreur'));
    }
}

async function onResolveRow(row, localUid) {
    const val = (key) => row.querySelector(`input[data-field="${key}"]`)?.value?.trim() || '';
    const body = {};
    if (val('coords')) body.coordinates = val('coords');
    if (val('date')) body.found_date = val('date');
    if (!Object.keys(body).length) {
        setFeedback(row, 'warning', t('Rien à enregistrer'));
        return;
    }
    try {
        const data = await postCorrection(
            `${CONFIG.BASE_URL}/api/labs/discoveries/${encodeURIComponent(localUid)}/resolve`, body);
        row.classList.add('text-success');
        // La position retenue, en décimal : l'utilisateur voit comment sa
        // saisie a été lue.
        const d = data.discovery || {};
        const saved = t('Enregistré');
        setFeedback(row, 'success', body.coordinates && d.latitude != null
            ? `${saved} : ${fmtCoord(d.latitude)}, ${fmtCoord(d.longitude)}`
            : saved);
        afterPendingCorrection(data);
    } catch (e) {
        setFeedback(row, 'danger', e.message || t('Erreur'));
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
        // Les géocaches peuvent subsister : le rechargement affiche la
        // source restante au lieu de laisser un écran vide.
        await updateMapAfterLabsChange('reset');
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
