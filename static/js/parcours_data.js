// Page Parcours (/parcours) : une journée ou des vacances rejouées cache par
// cache (MyGCFlow_Plan_Parcours.md).
//
// Lot 0 : parcours enregistrés (liste, création, suppression) et affichage
// statique des étapes du parcours ouvert — liste par jour dans l'onglet
// Données, points numérotés reliés par jour sur la carte, dans l'ordre
// PROVISOIRE de saisie des logs (parcours_model.mjs). Ni animation, ni
// reconstruction : elles arrivent aux lots 1 et 2.
//
// Les étapes vivent dans leur propre couche vectorielle (`parcoursLayer`),
// hors des sources de la page principale : rien n'entre dans pointsByDate.
//
// Noms exportés uniques (parcoursXxx) : `export *` d'index.js écarte en
// silence un nom exporté par deux modules.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showConfirmation, showToast, t } from './notifications.js';
import { isParcoursPage } from './app_mode.mjs';
import { orderParcours, parcoursExtent, parcoursStops, rangeDayCount } from './parcours_model.mjs';

const LAST_ID_KEY = 'parcours.lastId';
// Couleurs par nature d'étape : accent de l'app (trouvailles), ambre (Labs),
// gris (DNF, comme leur couche sur la page principale).
const KIND_COLORS = Object.freeze({ find: '#0072c6', lab: '#f59f00', dnf: '#868e96' });
const LINE_COLOR = 'rgba(0, 114, 198, 0.55)';
const LAYER_Z_INDEX = 1000;

let listing = [];             // parcours enregistrés (GET /api/parcours)
let findsExtent = { first: null, last: null };
let maxDays = 92;
let selectedId = null;
let ordered = null;           // orderParcours(inputs) du parcours ouvert
let counts = null;
let logsAvailable = false;
let status = 'idle';          // idle | loading | ready | error
let loadSeq = 0;
let parcoursLayer = null;

function el(id) {
    return document.getElementById(id);
}

function readLastId() {
    try {
        const value = Number(localStorage.getItem(LAST_ID_KEY));
        return Number.isInteger(value) && value > 0 ? value : null;
    } catch (_) {
        return null;
    }
}

function writeLastId(id) {
    try {
        if (id) localStorage.setItem(LAST_ID_KEY, String(id));
        else localStorage.removeItem(LAST_ID_KEY);
    } catch (_) { /* stockage indisponible : simple confort perdu */ }
}

function pageLocale() {
    return document.documentElement.lang || undefined;
}

// « AAAA-MM-JJ » → date civile affichée (sans fuseau : midi local évite tout
// glissement de jour).
function formatDay(iso, options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return String(iso);
    return new Date(y, m - 1, d, 12).toLocaleDateString(pageLocale(), options);
}

function formatRange(start, end) {
    const short = { day: 'numeric', month: 'short', year: 'numeric' };
    return start === end ? formatDay(start, short) : `${formatDay(start, short)} → ${formatDay(end, short)}`;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(`${CONFIG.BASE_URL}${url}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.message || `HTTP ${response.status}`);
        error.code = body.error;
        throw error;
    }
    return body;
}

function signalLoaded() {
    window.mygcflowParcoursLoaded = true;
    window.dispatchEvent(new CustomEvent('mygcflow:parcours-loaded'));
}

// --- Démarrage ------------------------------------------------------------------

export async function initParcoursPage() {
    if (!isParcoursPage()) return;
    bindForm();
    await refreshParcoursList({ select: readLastId() });
}

export async function refreshParcoursList({ select = selectedId } = {}) {
    try {
        const body = await fetchJson('/api/parcours');
        listing = Array.isArray(body.parcours) ? body.parcours : [];
        findsExtent = body.finds || findsExtent;
        maxDays = Number(body.maxDays) || maxDays;
    } catch (error) {
        console.warn('[PARCOURS] Liste indisponible :', error);
        listing = [];
        renderListError();
        status = 'error';
        signalLoaded();
        return;
    }
    fillFormDefaults();
    const target = listing.find((item) => item.id === select) || listing[0] || null;
    renderList(target?.id ?? null);
    if (target) {
        await openParcours(target.id);
    } else {
        selectedId = null;
        ordered = null;
        renderStops();
        renderLayer();
        status = 'idle';
        signalLoaded();
    }
}

export async function openParcours(id) {
    const seq = ++loadSeq;
    selectedId = id;
    writeLastId(id);
    renderList(id);
    status = 'loading';
    renderStops();
    let inputs;
    try {
        inputs = await fetchJson(`/api/parcours/${id}/inputs`);
    } catch (error) {
        if (seq !== loadSeq) return;
        console.warn('[PARCOURS] Étapes indisponibles :', error);
        status = 'error';
        ordered = null;
        renderStops(error.message);
        renderLayer();
        signalLoaded();
        return;
    }
    if (seq !== loadSeq) return;
    ordered = orderParcours(inputs);
    counts = inputs.counts || null;
    logsAvailable = inputs.logsAvailable === true;
    status = 'ready';
    renderStops();
    renderLayer({ fit: true });
    signalLoaded();
}

// --- Liste des parcours ---------------------------------------------------------

function renderListError() {
    const list = el('parcoursList');
    if (!list) return;
    const item = document.createElement('div');
    item.className = 'text-danger small';
    item.textContent = t('Impossible de charger les parcours');
    list.replaceChildren(item);
}

function renderList(activeId) {
    const list = el('parcoursList');
    if (!list) return;
    if (listing.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-muted small';
        empty.id = 'parcoursListEmpty';
        empty.textContent = t('Aucun parcours pour l’instant : créez-en un ci-dessous.');
        list.replaceChildren(empty);
        return;
    }
    list.replaceChildren(...listing.map((item) => {
        const row = document.createElement('div');
        row.className = 'list-group-item d-flex align-items-center gap-2 parcours-list-item';
        row.classList.toggle('active', item.id === activeId);
        row.dataset.parcoursId = String(item.id);

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'btn btn-link p-0 text-start flex-grow-1 parcours-open';
        open.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');
        const name = document.createElement('div');
        name.className = 'fw-medium';
        name.textContent = item.name;
        const range = document.createElement('div');
        range.className = 'small text-muted';
        range.textContent = formatRange(item.date_start, item.date_end);
        open.append(name, range);
        open.addEventListener('click', () => {
            if (item.id !== selectedId) openParcours(item.id);
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-ghost-danger parcours-delete';
        remove.setAttribute('aria-label', t('Supprimer le parcours'));
        remove.title = t('Supprimer le parcours');
        remove.innerHTML = '<i class="ti ti-trash" aria-hidden="true"></i>';
        remove.addEventListener('click', () => confirmDelete(item));

        row.append(open, remove);
        return row;
    }));
}

function confirmDelete(item) {
    showConfirmation(
        t('Supprimer le parcours « ${name} » ? Les trouvailles ne sont pas touchées.', { name: item.name }),
        t('Supprimer le parcours'),
        () => deleteParcours(item.id),
        null,
        { danger: true, confirmText: t('Supprimer') },
    );
}

export async function deleteParcours(id) {
    try {
        await fetchJson(`/api/parcours/${id}`, { method: 'DELETE' });
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    if (id === selectedId) {
        selectedId = null;
        writeLastId(null);
    }
    await refreshParcoursList({ select: selectedId });
}

// --- Création -------------------------------------------------------------------

function fillFormDefaults() {
    const start = el('parcoursStart');
    const end = el('parcoursEnd');
    if (!start || !end) return;
    for (const input of [start, end]) {
        if (findsExtent.first) input.min = findsExtent.first;
        if (findsExtent.last) input.max = findsExtent.last;
    }
    // Proposition : le dernier jour de trouvailles (la sortie la plus récente).
    if (!start.value && findsExtent.last) start.value = findsExtent.last;
    if (!end.value && findsExtent.last) end.value = findsExtent.last;
    updateRangeHint();
}

function updateRangeHint() {
    const hint = el('parcoursRangeHint');
    if (!hint) return;
    const days = rangeDayCount(el('parcoursStart')?.value, el('parcoursEnd')?.value);
    hint.classList.toggle('text-danger', days === 0 || days > maxDays);
    if (days === 0) hint.textContent = t('La date de fin précède la date de début');
    else if (days > maxDays) hint.textContent = t('Un parcours couvre ${max} jours au plus', { max: maxDays });
    else hint.textContent = days === 1 ? t('Une journée') : t('${n} jours', { n: days });
}

function bindForm() {
    const form = el('parcoursCreateForm');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    const start = el('parcoursStart');
    const end = el('parcoursEnd');
    start?.addEventListener('change', () => {
        // Une journée par défaut : la fin suit le début tant qu'elle le précède.
        if (end && (!end.value || end.value < start.value)) end.value = start.value;
        updateRangeHint();
    });
    end?.addEventListener('change', updateRangeHint);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = el('btnParcoursCreate');
        if (submit) submit.disabled = true;
        try {
            const body = await fetchJson('/api/parcours', {
                method: 'POST',
                body: JSON.stringify({
                    name: el('parcoursName')?.value || '',
                    date_start: start?.value || '',
                    date_end: end?.value || '',
                    include_labs: el('parcoursIncludeLabs')?.checked !== false,
                    include_dnf: el('parcoursIncludeDnf')?.checked !== false,
                }),
            });
            el('parcoursName').value = '';
            await refreshParcoursList({ select: body.parcours.id });
        } catch (error) {
            showToast(error.message, 'error');
        } finally {
            if (submit) submit.disabled = false;
        }
    });
}

// --- Étapes ---------------------------------------------------------------------

const KIND_ICONS = Object.freeze({ find: 'ti-map-pin', lab: 'ti-flask', dnf: 'ti-mood-sad' });

function stopLabel(stop) {
    if (stop.kind === 'lab') return stop.adventure ? `${stop.adventure} — ${stop.name || ''}` : (stop.name || stop.key);
    return stop.name || stop.code || stop.key;
}

function stopDetail(stop) {
    const parts = [];
    if (stop.code) parts.push(stop.code);
    if (stop.kind === 'dnf') parts.push(t('DNF'));
    else if (stop.type) parts.push(stop.type);
    if (stop.localTime) parts.push(stop.localTime.slice(0, 5));
    return parts.join(' · ');
}

function renderStops(errorMessage = '') {
    const box = el('parcoursStops');
    const summary = el('parcoursSummary');
    if (!box) return;
    if (status === 'loading') {
        if (summary) summary.textContent = t('Chargement…');
        box.replaceChildren();
        return;
    }
    if (!ordered) {
        if (summary) {
            summary.textContent = status === 'error'
                ? (errorMessage || t('Impossible de charger les étapes'))
                : t('Ouvrez ou créez un parcours pour voir ses étapes.');
        }
        box.replaceChildren();
        return;
    }
    if (summary) {
        const parts = [t('${n} étapes', { n: ordered.stopCount }), t('${n} jours', { n: ordered.days.length })];
        if (counts?.missing_position) parts.push(t('${n} sans position', { n: counts.missing_position }));
        summary.textContent = parts.join(' · ');
    }
    const note = el('parcoursOrderNote');
    if (note) {
        note.textContent = logsAvailable
            ? t('Ordre provisoire : celui de la saisie de vos logs. La reconstruction du parcours viendra ensuite.')
            : t('Ordre provisoire : sans logs importés, les caches d’une journée restent dans un ordre arbitraire. Importez « Mes logs » sur la page Mes Géocaches.');
    }
    box.replaceChildren(...ordered.days.map((day) => {
        const section = document.createElement('section');
        section.className = 'parcours-day mb-3';
        section.dataset.date = day.date;
        const title = document.createElement('h6');
        title.className = 'parcours-day-title mb-1';
        title.textContent = formatDay(day.date);
        section.append(title);
        if (day.stops.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'small text-muted';
            empty.textContent = t('Aucune étape ce jour-là');
            section.append(empty);
            return section;
        }
        const list = document.createElement('ol');
        list.className = 'list-unstyled mb-0 parcours-stop-list';
        for (const stop of day.stops) {
            const item = document.createElement('li');
            item.className = 'parcours-stop d-flex align-items-start gap-2 py-1';
            item.dataset.stopKey = stop.key;
            item.dataset.kind = stop.kind;
            const badge = document.createElement('span');
            badge.className = 'parcours-stop-index';
            badge.style.backgroundColor = KIND_COLORS[stop.kind] || KIND_COLORS.find;
            badge.textContent = String(stop.index);
            const icon = document.createElement('i');
            icon.className = `ti ${KIND_ICONS[stop.kind] || KIND_ICONS.find} text-muted mt-1`;
            icon.setAttribute('aria-hidden', 'true');
            const text = document.createElement('div');
            text.className = 'flex-grow-1 min-w-0';
            const name = document.createElement('div');
            name.className = 'text-truncate';
            name.textContent = stopLabel(stop);
            const detail = document.createElement('div');
            detail.className = 'small text-muted';
            detail.textContent = stopDetail(stop);
            text.append(name, detail);
            item.append(badge, icon, text);
            list.append(item);
        }
        section.append(list);
        return section;
    }));
}

// --- Carte ----------------------------------------------------------------------

function pointStyle(feature) {
    return new ol.style.Style({
        image: new ol.style.Circle({
            radius: 11,
            fill: new ol.style.Fill({ color: KIND_COLORS[feature.get('kind')] || KIND_COLORS.find }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }),
        }),
        text: new ol.style.Text({
            text: String(feature.get('index')),
            font: '600 11px system-ui, sans-serif',
            fill: new ol.style.Fill({ color: '#ffffff' }),
        }),
    });
}

const lineStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: LINE_COLOR, width: 3, lineDash: [6, 6] }),
});

function ensureLayer() {
    const map = pkg.getMap?.();
    if (!map) return null;
    if (!parcoursLayer) {
        parcoursLayer = new ol.layer.Vector({
            source: new ol.source.Vector(),
            zIndex: LAYER_Z_INDEX,
            style: (feature) => (feature.get('role') === 'line' ? lineStyle : pointStyle(feature)),
        });
        parcoursLayer.set('name', 'parcours');
    }
    if (!map.getLayers().getArray().includes(parcoursLayer)) map.addLayer(parcoursLayer);
    return parcoursLayer;
}

function renderLayer({ fit = false } = {}) {
    const layer = ensureLayer();
    if (!layer) return;
    const source = layer.getSource();
    source.clear();
    if (!ordered) return;
    const features = [];
    for (const day of ordered.days) {
        // Une ligne par jour : la nuit n'est pas un trajet.
        if (day.stops.length > 1) {
            features.push(new ol.Feature({
                role: 'line',
                date: day.date,
                geometry: new ol.geom.LineString(day.stops.map((stop) => ol.proj.fromLonLat([stop.lon, stop.lat]))),
            }));
        }
    }
    // Points ensuite, du dernier au premier : le n° 1 est dessiné au-dessus
    // quand deux étapes se recouvrent.
    for (const stop of [...parcoursStops(ordered)].reverse()) {
        features.push(new ol.Feature({
            role: 'stop',
            key: stop.key,
            kind: stop.kind,
            index: stop.index,
            geometry: new ol.geom.Point(ol.proj.fromLonLat([stop.lon, stop.lat])),
        }));
    }
    source.addFeatures(features);
    if (fit) {
        const extent = parcoursExtent(parcoursStops(ordered));
        if (extent) pkg.fitMapView?.(extent);
    }
}

// --- Relevé (tests) ---------------------------------------------------------------

export function getParcoursSnapshot() {
    const source = parcoursLayer?.getSource();
    return {
        status,
        ids: listing.map((item) => item.id),
        selectedId,
        logsAvailable,
        days: (ordered?.days || []).map((day) => ({ date: day.date, keys: day.stops.map((stop) => stop.key) })),
        layer: source ? {
            stops: source.getFeatures().filter((f) => f.get('role') === 'stop').length,
            lines: source.getFeatures().filter((f) => f.get('role') === 'line').length,
            onMap: !!pkg.getMap?.()?.getLayers().getArray().includes(parcoursLayer),
        } : null,
    };
}

if (isParcoursPage()) window.getParcoursSnapshot = getParcoursSnapshot;
