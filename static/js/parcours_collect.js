// Carte « Compléter depuis geocaching.com » de la page Parcours
// (MyGCFlow_Plan_Parcours.md § 15.3).
//
// La page pose une demande de collecte limitée aux caches du parcours
// ouvert (`/api/parcours/<id>/collect`) ; le favori « MyGCFlow — Mes
// logs » la lit avant de partir et ne relit que ces caches. Son export
// arrive comme un import en attente rattaché à la demande (`request_id`,
// `parcours_id` de `pending_import`) : la carte le propose à la validation
// sans passer par la page Mes Géocaches. L'export ne déclare aucune
// couverture — il ajoute et met à jour, ne retire rien —, d'où un bilan
// court plutôt que la fenêtre d'aperçu complète de « Mes logs ».
//
// Module feuille : parcours_data.js lui passe de quoi recharger les étapes
// (initParcoursCollect), puis le prévient à chaque ouverture de parcours
// (refreshParcoursCollect).

import { CONFIG } from './init.js';
import { showError, showToast, t } from './notifications.js';
import { FETCH_TIMEOUTS, fetchWithTimeout } from './fetch_with_timeout.mjs';

// Relevé de la collecte et de l'export reçu : même cadence que la carte
// « Mes logs », seulement onglet Données affiché.
const POLL_MS = 4000;
const TASK_POLL_MS = 500;
// Le favori lit fiche + carnet par cache, 800 ms entre deux requêtes.
const SECONDS_PER_CACHE = 1.6;

let reloadParcours = async () => {};
let parcoursId = null;
let collect = null;           // dernier état de /api/parcours/<id>/collect
let pending = null;           // export reçu pour ce parcours
let progress = null;          // collecte en cours pour sa demande
let lastRequestId = null;     // demande servie (disparaît au scellement)
let pollTimer = null;
let busy = false;
let bookmarkletLoaded = false;

function el(id) {
    return document.getElementById(id);
}

async function fetchJson(url, options = {}) {
    const response = await fetchWithTimeout(`${CONFIG.BASE_URL}${url}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    }, { timeoutMs: FETCH_TIMEOUTS.control, t });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
}

function minutesFor(count) {
    return Math.max(1, Math.ceil(count * SECONDS_PER_CACHE / 60));
}

function setStatus(text, error = false) {
    const box = el('parcoursCollectStatus');
    if (!box) return;
    box.textContent = text || '';
    box.classList.toggle('text-danger', !!error);
    box.classList.toggle('text-muted', !error);
}

function render() {
    const card = el('parcoursCollectCard');
    if (!card) return;
    card.hidden = parcoursId == null || !collect;
    if (card.hidden) return;
    const request = collect.request;
    const summaryText = collect.total
        ? t('${total} caches dans ce parcours, dont ${unread} jamais relues.',
            { total: collect.total, unread: collect.unread })
        : t('Aucune cache de geocaching.com dans ce parcours.');
    const summary = el('parcoursCollectSummary');
    if (summary) summary.textContent = summaryText;
    // Résumé lisible section repliée ; une demande en cours ou un export
    // reçu ouvrent la section — il y a quelque chose à faire.
    const hint = el('parcoursCollectHint');
    if (hint) hint.textContent = pending ? t('Export reçu : à valider') : summaryText;
    if (request || pending || progress) card.open = true;
    const choose = el('parcoursCollectChoose');
    if (choose) choose.hidden = !!request || !collect.total;
    const other = el('parcoursCollectOther');
    if (other) {
        other.hidden = !collect.otherRequest;
        other.textContent = collect.otherRequest
            ? t('Une demande attend déjà pour « ${label} » : elle sera remplacée.', { label: collect.otherRequest })
            : '';
    }
    const prepare = el('btnParcoursCollectPrepare');
    if (prepare) prepare.disabled = busy;
    const ready = el('parcoursCollectReady');
    if (ready) ready.hidden = !request;
    if (request) {
        const text = el('parcoursCollectReadyText');
        if (text) {
            text.textContent = t('Collecte prête : ${count} caches à relire (au moins ${minutes} min).',
                { count: request.count, minutes: minutesFor(request.count) });
        }
        loadBookmarklet();
    }
    const progressBox = el('parcoursCollectProgress');
    if (progressBox) {
        progressBox.hidden = !progress;
        progressBox.textContent = progress
            ? t('Collecte en cours — ${count} caches lues…', { count: progress.caches || 0 })
            : '';
    }
    const pendingBox = el('parcoursCollectPending');
    if (pendingBox) pendingBox.hidden = !pending;
    if (pending) {
        const s = pending.summary || {};
        const text = el('parcoursCollectPendingText');
        if (text) {
            text.textContent = t('Export reçu : ${caches} fiches de caches, dont ${corrected} aux coordonnées corrigées, et ${favorites} points favoris donnés.',
                { caches: s.caches_in_file || 0, corrected: s.caches_corrected || 0, favorites: s.favorites_mine || 0 });
        }
        const apply = el('btnParcoursCollectApply');
        if (apply) apply.disabled = busy;
    }
    const cancel = el('btnParcoursCollectCancel');
    if (cancel) cancel.disabled = busy;
    syncPolling();
}

// Le favori se glisse dans la barre : chargé une fois, à la première
// demande affichée (la route crée le jeton s'il n'existe pas encore).
async function loadBookmarklet() {
    if (bookmarkletLoaded) return;
    bookmarkletLoaded = true;
    const link = el('parcoursCollectBookmarklet');
    const label = el('parcoursCollectBookmarkletLabel');
    try {
        const body = await fetchJson('/api/logs/bookmarklet');
        if (!body.bookmarklet || !link) throw new Error('indisponible');
        link.href = body.bookmarklet;
        link.draggable = true;
        link.removeAttribute('aria-disabled');
        link.removeAttribute('tabindex');
        // Un clic depuis l'application ne ferait rien : il se glisse.
        link.addEventListener('click', (event) => event.preventDefault());
        if (label) label.textContent = t('MyGCFlow — Mes logs');
    } catch (error) {
        console.warn('[PARCOURS] Favori indisponible :', error);
        bookmarkletLoaded = false;
        if (label) label.textContent = t('Favori indisponible');
    }
}

function dataTabShown() {
    return !!el('data')?.classList.contains('active');
}

// Relevé seulement quand quelque chose est attendu : une demande posée,
// ou servie dont l'export n'est pas encore validé.
function syncPolling() {
    const watching = parcoursId != null && (!!collect?.request || !!lastRequestId || !!pending);
    if (watching && !pollTimer) {
        pollTimer = setInterval(() => {
            if (dataTabShown() && !busy) refreshLogsStatus();
        }, POLL_MS);
    } else if (!watching && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function refreshCollectState() {
    const id = parcoursId;
    try {
        const body = await fetchJson(`/api/parcours/${id}/collect`);
        if (id !== parcoursId) return;
        collect = body;
        if (body.request) lastRequestId = body.request.id;
    } catch (error) {
        if (id !== parcoursId) return;
        console.warn('[PARCOURS] État de la collecte indisponible :', error);
        collect = null;
    }
}

async function refreshLogsStatus() {
    const id = parcoursId;
    let body;
    try {
        body = await fetchJson('/api/logs/status');
    } catch (error) {
        console.warn('[PARCOURS] Statut des logs indisponible :', error);
        return;
    }
    if (id !== parcoursId) return;
    const received = body.pending_import;
    const ours = received && (received.parcours_id === id
        || (lastRequestId && received.request_id === lastRequestId));
    pending = ours ? received : null;
    const running = body.collection_in_progress;
    progress = running && lastRequestId && running.request_id === lastRequestId ? running : null;
    // Export arrivé : la demande a été retirée au scellement.
    if (collect?.request && pending) {
        await refreshCollectState();
        if (id !== parcoursId) return;
    }
    // Plus rien d'attendu (export validé ailleurs ou expiré) : fin du relevé.
    if (!collect?.request && !pending && !progress) lastRequestId = null;
    render();
}

async function onPrepare() {
    if (busy || parcoursId == null) return;
    const mode = document.querySelector('input[name="parcoursCollectMode"]:checked')?.value || 'unread';
    busy = true;
    setStatus('');
    render();
    try {
        collect = await fetchJson(`/api/parcours/${parcoursId}/collect`, {
            method: 'POST', body: JSON.stringify({ mode }),
        });
        lastRequestId = collect.request?.id || null;
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        busy = false;
        render();
    }
}

async function onCancel() {
    if (busy || parcoursId == null) return;
    busy = true;
    render();
    try {
        collect = await fetchJson(`/api/parcours/${parcoursId}/collect`, { method: 'DELETE' });
        lastRequestId = null;
        progress = null;
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        busy = false;
        render();
    }
}

async function waitTask(taskId) {
    for (;;) {
        const response = await fetchWithTimeout(
            `${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`,
            {}, { timeoutMs: FETCH_TIMEOUTS.status, t });
        const body = await response.json().catch(() => ({}));
        if (body?.state === 'finished') return body.result || {};
        if (body?.state === 'failed') throw new Error(body.error || t('Import échoué'));
        await new Promise((resolve) => setTimeout(resolve, TASK_POLL_MS));
    }
}

async function onApply() {
    if (busy || !pending) return;
    const token = pending.import_token;
    busy = true;
    setStatus(t('Import de vos logs…'));
    render();
    try {
        const body = await fetchJson('/api/logs/import/commit', {
            method: 'POST', body: JSON.stringify({ import_token: token }),
        });
        const result = await waitTask(body.task_id);
        pending = null;
        lastRequestId = null;
        setStatus('');
        showToast(t('${count} fiches de caches ajoutées ou mises à jour.',
            { count: (result.caches_added || 0) + (result.caches_updated || 0) }),
        'success', t('Compléter depuis geocaching.com'));
        await refreshCollectState();
        await reloadParcours();
    } catch (error) {
        setStatus('');
        showError(error.message || t("Erreur lors de l'import"), t('Compléter depuis geocaching.com'));
    } finally {
        busy = false;
        render();
    }
}

export function initParcoursCollect({ reload }) {
    reloadParcours = reload;
    el('btnParcoursCollectPrepare')?.addEventListener('click', onPrepare);
    el('btnParcoursCollectCancel')?.addEventListener('click', onCancel);
    el('btnParcoursCollectApply')?.addEventListener('click', onApply);
}

// Parcours ouvert (ou aucun) : état de la demande et export éventuel.
export async function refreshParcoursCollect(id) {
    if (id !== parcoursId) {
        pending = null;
        progress = null;
        lastRequestId = null;
        setStatus('');
    }
    parcoursId = id ?? null;
    if (parcoursId == null) {
        collect = null;
        render();
        return;
    }
    await refreshCollectState();
    if (parcoursId !== id) return;
    await refreshLogsStatus();
}

// Relevé pour les tests e2e.
export function parcoursCollectSnapshot() {
    return {
        parcoursId,
        collect,
        pending: pending ? { requestId: pending.request_id, parcoursId: pending.parcours_id } : null,
        progress: progress ? { caches: progress.caches } : null,
        lastRequestId,
        polling: !!pollTimer,
    };
}
