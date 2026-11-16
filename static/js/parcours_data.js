// Page Parcours (/parcours) : une journée ou des vacances rejouées cache par
// cache (MyGCFlow_Plan_Parcours.md).
//
// Parcours enregistrés (liste, création, suppression) et étapes du parcours
// ouvert — liste par jour dans l'onglet Données, plan numéroté sur la carte —
// dans l'ordre et aux heures RECONSTRUITS (parcours_reconstruct.mjs).
//
// Lecture et vidéo (lot 2) : la page passe par le moteur « cycle de vie »
// (lifecycle_engine.mjs), dont un « jour » est ici un QUANTUM de temps écran
// (parcours_timeline.mjs). Chaque étape est une feature WebGL dont
// `placedDay` est le quantum de son arrivée : le shader la fait apparaître,
// mapgl.js joue le flash. La tête (le géocacheur) et le trait sont dessinés
// à chaque image par deux couches dédiées, à la position fractionnaire du
// moteur. Les dates du moteur partent d'une origine fictive (QUANTUM_ORIGIN) :
// la vraie date et l'heure passent par `infosValues`.
//
// Au repos, le plan (points numérotés reliés par jour, `parcoursLayer`) se
// superpose aux étapes ; il est masqué pendant la lecture.
//
// Noms exportés uniques (parcoursXxx) : `export *` d'index.js écarte en
// silence un nom exporté par deux modules.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showConfirmation, showToast, t } from './notifications.js';
import { isParcoursPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { registerLifecycleEngine } from './lifecycle_engine.mjs';
import { DEFAULT_PARCOURS_TEMPLATE, PARCOURS_INFO_TAGS } from './infos_template.mjs';
import { EVO_NEVER_DAY } from './evolution_style.mjs';
import {
    beginEvolution,
    createEvolutionClock,
    dateOfDayIndex,
    dateToDayNumber,
    dayIndexOf,
    endEvolution,
    evolutionFrameVariables,
    stepEvolution,
} from './evolution_timeline.mjs';
import {
    buildParcoursTimeline,
    formatClock,
    headAt,
    normalizePlayback,
    stateAt,
    stopsInRange,
    trailAt,
} from './parcours_timeline.mjs';
import { parcoursExtent, parcoursStops, rangeDayCount } from './parcours_model.mjs';
import {
    CONFIDENCE_ANCHORED,
    LOG_ORDER_REJECTED,
    LOG_ORDER_TRUSTED,
    REASON_GEO,
    REASON_INSERTED,
    REASON_INTRUDER,
    REASON_LATE_TYPE,
    REASON_LOG_ORDER,
    REASON_TIME,
    minutesToTime,
    reconstructParcours,
} from './parcours_reconstruct.mjs';

const LAST_ID_KEY = 'parcours.lastId';
// Couleurs par nature d'étape : accent de l'app (trouvailles), ambre (Labs),
// gris (DNF, comme leur couche sur la page principale).
const KIND_COLORS = Object.freeze({ find: '#0072c6', lab: '#f59f00', dnf: '#868e96' });
const LINE_COLOR = 'rgba(0, 114, 198, 0.55)';
// Plan au repos au-dessus des points WebGL (zIndex 1001) : ses numéros
// restent lisibles. Masqué pendant la lecture.
const LAYER_Z_INDEX = 1060;
// Cadrage d'un parcours : une sortie tient souvent dans quelques kilomètres.
const FIT_MAX_ZOOM = 16;

let listing = [];             // parcours enregistrés (GET /api/parcours)
let findsExtent = { first: null, last: null };
let maxDays = 92;
let selectedId = null;
let ordered = null;           // reconstructParcours(inputs) du parcours ouvert
let counts = null;
let logsAvailable = false;
let status = 'idle';          // idle | loading | ready | error
let loadSeq = 0;
let parcoursLayer = null;

// Lecture (lot 2).
// Origine fictive des dates du moteur : le quantum k est le jour
// QUANTUM_ORIGIN + k. Jamais affichée (infosValues donne la vraie date).
const QUANTUM_ORIGIN = new Date(2000, 0, 1);
const quantumBase = { originDay: dateToDayNumber(QUANTUM_ORIGIN) };
const PLAY_TRAIL_Z_INDEX = 1000;
const PLAY_HEAD_Z_INDEX = 1050;
let playback = normalizePlayback(window.userSettings?.parcours_playback);
let infosTemplate = normalizeInfosTemplate(window.userSettings?.parcours_infos_template);
let timeline = null;          // buildParcoursTimeline(ordered) du parcours ouvert
let projected = [];           // coordonnées carte des étapes de `timeline`
let olFeatures = [];          // une feature WebGL par étape de `timeline`
const clock = createEvolutionClock();
let endDay = 0;
let currentQ = 0;             // position du moteur, en quanta fractionnaires
let pendingOpenId = null;     // parcours ouvert pendant une lecture
let pendingTimeline = false;  // rythme changé pendant une lecture
let playTrailLayer = null;
let playHeadLayer = null;

function normalizeInfosTemplate(value) {
    return typeof value === 'string' ? value : DEFAULT_PARCOURS_TEMPLATE;
}

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
    // Les préférences arrivent après l'évaluation du module : relues ici.
    playback = normalizePlayback(window.userSettings?.parcours_playback);
    infosTemplate = normalizeInfosTemplate(window.userSettings?.parcours_infos_template);
    const inp = el('inputInfosTemplate');
    if (inp) inp.value = infosTemplate;
    bindForm();
    bindPlayback();
    pkg.syncOverlayVisibility?.();
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
        applyTimeline();
        status = 'idle';
        signalLoaded();
    }
}

export async function openParcours(id) {
    if (clock.running) {
        // Les étapes de la lecture en cours restent à l'écran jusqu'à sa fin.
        pendingOpenId = id;
        showToast(t('Le parcours s’ouvrira à la fin de l’animation.'), 'info', t('Parcours'));
        return;
    }
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
        applyTimeline();
        signalLoaded();
        return;
    }
    if (seq !== loadSeq) return;
    ordered = reconstructParcours(inputs);
    counts = inputs.counts || null;
    logsAvailable = inputs.logsAvailable === true;
    status = 'ready';
    renderStops();
    applyTimeline({ fit: true });
    signalLoaded();
}

// --- Chronologie et moteur ------------------------------------------------------

// (Re)construit la chronologie écran du parcours ouvert et la donne au moteur :
// métadonnées (dates fictives des quanta), features WebGL, plan au repos.
function applyTimeline({ fit = false } = {}) {
    timeline = ordered ? buildParcoursTimeline(ordered, { pace: playback.pace }) : null;
    const stops = timeline?.stops || [];
    projected = stops.map((stop) => ol.proj.fromLonLat([stop.lon, stop.lat]));
    olFeatures = stops.map((stop, i) => new ol.Feature({
        geometry: new ol.geom.Point(projected[i]),
        cache_type: stop.kind === 'lab' ? 'Lab Cache' : (stop.type || ''),
        gc_code: stop.code || '',
        name: stop.name || '',
        placedDay: stop.q,
        archivedDay: EVO_NEVER_DAY,
        stagger: 0,
        stopIndex: i,
    }));
    pkg.setExternalDatasetState(buildMeta(), { selected: stops.length, total: stops.length });
    pkg.setPickerDates?.(pkg.metadata);
    pkg.updateAnimationMenuAfterReadBdd?.(pkg.metadata);
    pkg.setLifecycleFeatures(olFeatures);
    pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    renderLayer({ fit });
}

function buildMeta() {
    if (!timeline || timeline.stops.length === 0) {
        return { startDate: null, endDate: null, deltaDays: null, numberOfCaches: 0, tagMaxes: {} };
    }
    const lastDay = timeline.quanta - 1;
    const kinds = { find: 0, lab: 0 };
    for (const stop of timeline.stops) if (stop.kind in kinds) kinds[stop.kind]++;
    const lastDayNumber = timeline.days[timeline.days.length - 1]?.dayNumber || 1;
    return {
        startDate: pkg.formatDateIso(QUANTUM_ORIGIN),
        endDate: pkg.formatDateIso(dateOfDayIndex(quantumBase, lastDay)),
        deltaDays: timeline.quanta,
        numberOfCaches: timeline.stops.length,
        // Réserve de largeur de la ligne d'infos (frames.js) : plus grandes
        // valeurs à venir.
        tagMaxes: {
            etapes: timeline.stops.length,
            caches: kinds.find,
            labs: kinds.lab,
            jour: lastDayNumber,
            jours: lastDayNumber,
            heure: '≈ 00:00',
            km: formatKm(timeline.totalKm),
        },
    };
}

function formatKm(km) {
    const value = Math.max(0, Number(km) || 0);
    return t('${km} km', {
        km: value.toLocaleString(pageLocale(), { maximumFractionDigits: value < 10 ? 1 : 0 }),
    });
}

// Compteurs animés de la ligne d'infos à la position `q` (quanta).
function countersAt(q) {
    const state = timeline ? stateAt(timeline, q) : null;
    return {
        etapes: state ? state.stopsReached : 0,
        caches: state ? state.finds : 0,
        labs: state ? state.labs : 0,
    };
}

function slotLabels() {
    return { morning: t('matin'), noon: t('midi'), afternoon: t('après-midi'), evening: t('soir') };
}

// Valeurs texte de la ligne d'infos (priment sur la date fictive du moteur).
function parcoursInfosValues() {
    const state = timeline ? stateAt(timeline, currentQ) : null;
    if (!state) return {};
    const lastDayNumber = timeline.days[timeline.days.length - 1]?.dayNumber || 1;
    const date = state.date ? pkg.parseLocalDate?.(state.date) : null;
    return {
        date: date ? (pkg.formatDateDisplay?.(date) || state.date) : '',
        heure: formatClock(state.minutes, state.estimated, playback.hours, slotLabels()),
        jour: String(state.dayNumber),
        jours: String(lastDayNumber),
        km: formatKm(state.km),
    };
}

function parcoursBegin(startDate, endDate, at) {
    const startDay = Math.max(0, dayIndexOf(quantumBase, startDate));
    endDay = endDate instanceof Date ? dayIndexOf(quantumBase, endDate) : (timeline?.quanta || 1) - 1;
    beginEvolution(clock, startDay, at);
    currentQ = startDay;
    setPlanVisible(false);
    ensurePlayLayers();
    return countersAt(startDay - 1);
}

function parcoursStep(dates, at) {
    if (!timeline || !dates || dates.length === 0) return null;
    const first = dayIndexOf(quantumBase, dates[0]);
    const last = dayIndexOf(quantumBase, dates[dates.length - 1]);
    const placed = stopsInRange(timeline, first, last).map((i) => olFeatures[i]);
    stepEvolution(clock, last, at, last >= endDay);
    return { placed, archived: [], values: countersAt(last) };
}

function parcoursFrameVars(now, msPerDay) {
    const vars = evolutionFrameVariables(clock, { now, msPerDay });
    if (clock.running) {
        // Position continue : le dernier quantum joué, plus la part écoulée
        // du suivant. Elle reste calée sur les apparitions même quand le
        // moteur rattrape plusieurs quanta dans une image.
        const perDay = Math.max(1e-3, Number(msPerDay) || 1);
        const elapsed = Math.max(0, (Number(now) || 0) - clock.stepAt);
        currentQ = Math.max(0, clock.day + Math.min(1, elapsed / perDay));
    }
    return vars;
}

function parcoursEnd() {
    endEvolution(clock);
    setPlanVisible(true);
    playTrailLayer?.setVisible(false);
    playHeadLayer?.setVisible(false);
    applyPending();
}

// Changements reçus pendant la lecture : appliqués à la fin, une fois
// l'enregistrement éventuel terminé.
function applyPending() {
    if (clock.running) return;
    if (pkg.isRecordingActive?.()) {
        setTimeout(applyPending, 250);
        return;
    }
    if (pendingOpenId !== null) {
        const id = pendingOpenId;
        pendingOpenId = null;
        pendingTimeline = false;
        openParcours(id);
        return;
    }
    if (pendingTimeline) {
        pendingTimeline = false;
        applyTimeline();
    }
}

function parcoursRestState() {
    if (!timeline || timeline.stops.length === 0) return null;
    const day = timeline.quanta - 1;
    clock.restDay = day;
    currentQ = timeline.quanta;
    return { day, date: dateOfDayIndex(quantumBase, day), values: countersAt(day) };
}

function setParcoursInfosTemplate(value) {
    const next = normalizeInfosTemplate(value);
    if (next === infosTemplate) return;
    infosTemplate = next;
    pkg.updateInfosReserve?.();
    pkg.invalidateOverlayCache?.();
    pkg.syncOverlayVisibility?.();
    if (!clock.running) pkg.showLifecycleRestState?.();
}

// Pic d'apparitions sur une fenêtre de `windowDays` quanta (estimation de
// charge des flashs, mapgl.js).
function maxStopsInWindow(windowDays) {
    const qs = (timeline?.stops || []).map((stop) => stop.q);
    let best = 0;
    for (let i = 0, j = 0; i < qs.length; i++) {
        while (qs[i] - qs[j] >= windowDays) j++;
        best = Math.max(best, i - j + 1);
    }
    return best;
}

function renderParcoursPopup(feature, container) {
    const stop = timeline?.stops?.[feature.get('stopIndex')];
    if (!stop) return;
    const title = document.createElement('div');
    title.className = 'fw-medium';
    title.textContent = stopLabel(stop);
    const detail = document.createElement('div');
    detail.className = 'small text-muted';
    detail.textContent = [stopTime(stop), stopDetail(stop)].filter(Boolean).join(' · ');
    container.replaceChildren(title, detail);
}

const PARCOURS_ENGINE = Object.freeze({
    id: 'parcours',
    counterKeys: Object.freeze(['etapes', 'caches', 'labs']),
    infosTags: PARCOURS_INFO_TAGS,
    hasData: () => !!(timeline && timeline.stops.length > 0),
    infosTemplate: () => infosTemplate,
    infosTemplateKey: 'parcours_infos_template',
    setInfosTemplate: setParcoursInfosTemplate,
    begin: parcoursBegin,
    step: parcoursStep,
    frameVars: parcoursFrameVars,
    frameActive: () => clock.running,
    infosValues: parcoursInfosValues,
    end: parcoursEnd,
    restState: parcoursRestState,
    refreshRest: () => {},
    applySelection: () => {},
    maxEventsInWindow: maxStopsInWindow,
    renderPopup: renderParcoursPopup,
});

// --- Tête et trait pendant la lecture ------------------------------------------

function trailOptions() {
    const trail = pkg.options?.trail || {};
    return {
        color: typeof trail.color === 'string' ? trail.color : '#00B8D4',
        width: Number(trail.width) > 0 ? Number(trail.width) : 3,
    };
}

function ensurePlayLayers() {
    const map = pkg.getMap?.();
    if (!map) return;
    if (!playTrailLayer) {
        playTrailLayer = new ol.layer.Vector({ source: new ol.source.Vector(), zIndex: PLAY_TRAIL_Z_INDEX });
        playTrailLayer.set('name', 'parcours-trail');
        playTrailLayer.on('postrender', drawPlayTrail);
        playHeadLayer = new ol.layer.Vector({ source: new ol.source.Vector(), zIndex: PLAY_HEAD_Z_INDEX });
        playHeadLayer.set('name', 'parcours-head');
        playHeadLayer.on('postrender', drawPlayHead);
    }
    const layers = map.getLayers().getArray();
    if (!layers.includes(playTrailLayer)) map.addLayer(playTrailLayer);
    if (!layers.includes(playHeadLayer)) map.addLayer(playHeadLayer);
    playTrailLayer.setVisible(true);
    playHeadLayer.setVisible(true);
}

// Trait parcouru : trajets terminés, puis la part faite du trajet en cours.
// La nuit (d'une journée à la suivante) en pointillés.
function drawPlayTrail(event) {
    if (!clock.running || !timeline) return;
    const context = ol.render.getVectorContext(event);
    const { color, width } = trailOptions();
    const day = new ol.style.Style({ stroke: new ol.style.Stroke({ color, width, lineCap: 'round', lineJoin: 'round' }) });
    const night = new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: Math.max(1, width * 0.6), lineDash: [width * 2, width * 2] }) });
    const { done, current } = trailAt(timeline, currentQ);
    const draw = (k, progress) => {
        const leg = timeline.legs[k];
        const a = projected[leg.from];
        const b = projected[leg.to];
        const end = progress >= 1 ? b : [a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress];
        context.setStyle(leg.night ? night : day);
        context.drawGeometry(new ol.geom.LineString([a, end]));
    };
    for (let k = 0; k < done; k++) draw(k, 1);
    if (current) draw(current.leg, current.progress);
}

// Le géocacheur.
function drawPlayHead(event) {
    if (!clock.running || !timeline) return;
    const head = headAt(timeline, currentQ);
    if (!head) return;
    const context = ol.render.getVectorContext(event);
    const { color } = trailOptions();
    context.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
            radius: 7,
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
        }),
    }));
    context.drawGeometry(new ol.geom.Point(ol.proj.fromLonLat([head.lon, head.lat])));
}

function setPlanVisible(visible) {
    parcoursLayer?.setVisible(visible);
}

// --- Réglages de lecture --------------------------------------------------------

function bindPlayback() {
    const pace = el('parcoursPace');
    const hours = el('parcoursHours');
    if (pace) pace.value = playback.pace;
    if (hours) hours.value = playback.hours;
    const save = (patch) => {
        playback = normalizePlayback({ ...playback, ...patch });
        if (window.userSettings) window.userSettings.parcours_playback = { ...playback };
        try { saveSettingsPatch({ parcours_playback: patch }); } catch (_) { /* hors ligne : réglage de session */ }
    };
    pace?.addEventListener('change', () => {
        save({ pace: pace.value });
        if (clock.running) {
            pendingTimeline = true;
            showToast(t("Le réglage s'appliquera à la fin de l'animation."), 'info', t('Parcours'));
            return;
        }
        applyTimeline();
    });
    hours?.addEventListener('change', () => {
        save({ hours: hours.value });
        pkg.showLifecycleRestState?.();
    });
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

// Pourquoi l'étape est à cette place (parcours_reconstruct.mjs, REASON_*).
function reasonLabel(reason) {
    switch (reason) {
        case REASON_TIME: return t('heure sûre');
        case REASON_LOG_ORDER: return t('ordre des logs');
        case REASON_LATE_TYPE: return t('souvent loguée après coup');
        case REASON_INTRUDER: return t('log tardif');
        case REASON_GEO: return t('géographie');
        case REASON_INSERTED: return t('au plus court');
        default: return '';
    }
}

function stopDetail(stop) {
    const parts = [];
    if (stop.code) parts.push(stop.code);
    if (stop.kind === 'dnf') parts.push(t('DNF'));
    else if (stop.type) parts.push(stop.type);
    const reason = reasonLabel(stop.reason);
    if (reason) parts.push(reason);
    return parts.join(' · ');
}

// Heure d'arrivée : exacte pour une ancre, « ≈ » sinon.
function stopTime(stop) {
    const time = minutesToTime(stop.arrivalMin);
    if (!time) return '';
    return stop.confidence === CONFIDENCE_ANCHORED ? time : `≈ ${time}`;
}

// Ligne de bilan d'une journée : distance, verdict sur l'ordre des logs,
// heures sûres, journée comprimée.
function dayDiagnostic(day) {
    const km = day.legs.reduce((total, leg) => total + leg.km, 0);
    const parts = [t('${km} km', { km: km.toLocaleString(pageLocale(), { maximumFractionDigits: 1 }) })];
    const d = day.diagnostics;
    if (d.logOrder === LOG_ORDER_TRUSTED) parts.push(t('ordre de saisie des logs retenu'));
    else if (d.logOrder === LOG_ORDER_REJECTED) {
        parts.push(t('logs saisis dans le désordre (trajet ×${ratio}) : ordre géographique',
            { ratio: d.logRatio.toLocaleString(pageLocale(), { maximumFractionDigits: 1 }) }));
    }
    if (d.anchors > 0) parts.push(t('${n} heures sûres', { n: d.anchors }));
    if (d.compressed) parts.push(t('horaire comprimé'));
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
            ? t('Ordre et heures reconstruits d’après l’ordre de saisie de vos logs, l’heure de vos Labs et la géographie. « ≈ » : heure estimée.')
            : t('Sans identifiants de logs, l’ordre vient de vos Labs et de la géographie : réimportez votre fichier My Finds pour en profiter. « ≈ » : heure estimée.');
    }
    box.replaceChildren(...ordered.days.map((day) => {
        const section = document.createElement('section');
        section.className = 'parcours-day mb-3';
        section.dataset.date = day.date;
        const title = document.createElement('h6');
        title.className = 'parcours-day-title mb-1';
        title.textContent = formatDay(day.date);
        section.append(title);
        if (day.stops.length > 0) {
            const diagnostic = document.createElement('div');
            diagnostic.className = 'small text-muted mb-1 parcours-day-diagnostic';
            diagnostic.textContent = dayDiagnostic(day);
            section.append(diagnostic);
        }
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
            item.dataset.confidence = stop.confidence;
            item.dataset.reason = stop.reason;
            const time = document.createElement('span');
            time.className = 'parcours-stop-time small mt-1';
            time.classList.toggle('text-muted', stop.confidence !== CONFIDENCE_ANCHORED);
            time.textContent = stopTime(stop);
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
            item.append(time, badge, icon, text);
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
        if (extent) fitParcours(extent);
    }
}

function fitParcours(lonLatExtent) {
    const map = pkg.getMap?.();
    if (!map) return;
    const extent = ol.proj.transformExtent(lonLatExtent, 'EPSG:4326', 'EPSG:3857');
    map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: FIT_MAX_ZOOM, size: map.getSize() });
}

// --- Relevé (tests) ---------------------------------------------------------------

export function getParcoursSnapshot() {
    const source = parcoursLayer?.getSource();
    return {
        status,
        ids: listing.map((item) => item.id),
        selectedId,
        logsAvailable,
        days: (ordered?.days || []).map((day) => ({
            date: day.date,
            keys: day.stops.map((stop) => stop.key),
            times: day.stops.map((stop) => minutesToTime(stop.arrivalMin)),
            reasons: day.stops.map((stop) => stop.reason),
            logOrder: day.diagnostics.logOrder,
        })),
        layer: source ? {
            stops: source.getFeatures().filter((f) => f.get('role') === 'stop').length,
            lines: source.getFeatures().filter((f) => f.get('role') === 'line').length,
            onMap: !!pkg.getMap?.()?.getLayers().getArray().includes(parcoursLayer),
            visible: parcoursLayer.getVisible(),
        } : null,
        playback: { ...playback },
        // Lecture : chronologie écran, position du moteur, géocacheur.
        timeline: timeline ? {
            quanta: timeline.quanta,
            stopQ: timeline.stops.map((stop) => stop.q),
            nightLegs: timeline.legs.filter((leg) => leg.night).length,
            totalKm: timeline.totalKm,
        } : null,
        running: clock.running,
        currentQ,
        head: timeline ? headAt(timeline, currentQ) : null,
        infos: parcoursInfosValues(),
        playLayers: !!(playTrailLayer?.getVisible() && playHeadLayer?.getVisible()),
    };
}

if (isParcoursPage()) {
    registerLifecycleEngine(PARCOURS_ENGINE);
    window.getParcoursSnapshot = getParcoursSnapshot;
}
