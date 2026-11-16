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
    KIND_BASE,
    KIND_PLACE,
    LOG_ORDER_REJECTED,
    LOG_ORDER_TRUSTED,
    REASON_BASE,
    REASON_GEO,
    REASON_INSERTED,
    REASON_INTRUDER,
    REASON_LATE_TYPE,
    REASON_LOG_ORDER,
    REASON_MANUAL,
    REASON_PHOTO,
    REASON_PINNED,
    REASON_TIME,
    isCountedStop,
    minutesToTime,
} from './parcours_reconstruct.mjs';
import {
    MATCH_GPS,
    MATCH_MANUAL,
    cameraOffsets,
    hasPosition,
    photoClock,
    reconstructWithPhotos,
} from './parcours_photos.mjs';
import { composeTransform } from './travel_trail.mjs';

const LAST_ID_KEY = 'parcours.lastId';
// Couleurs par nature d'étape : accent de l'app (trouvailles), ambre (Labs),
// gris (DNF, comme leur couche sur la page principale).
const KIND_COLORS = Object.freeze({
    find: '#0072c6', lab: '#f59f00', dnf: '#868e96', place: '#ae3ec9', base: '#343a40',
});
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
let inputs = null;            // entrées du parcours ouvert, ajustements compris
let ordered = null;           // reconstruction du parcours ouvert (photos comprises)
let photoMatches = new Map(); // rattachement de chaque photo (parcours_photos.mjs)
let photoByStop = new Map();  // clé d'étape → photos, dans l'ordre d'affichage
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

// Ajustements (lot 3).
let editKey = null;           // étape dont le panneau d'ajustement est ouvert
let dragged = null;           // { date, key } pendant un glisser-déposer
let picking = false;          // en attente d'un clic sur la carte (lieu)
let pickListener = null;
let placeDraft = null;        // { lon, lat } du lieu en cours de saisie
let adjustmentRevision = 0;

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
    bindAdjustments();
    bindPhotos();
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
        inputs = null;
        ordered = null;
        editKey = null;
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
    editKey = null;
    cancelPlacePicking();
    closePlaceForm();
    renderStops();
    try {
        inputs = await fetchJson(`/api/parcours/${id}/inputs`);
    } catch (error) {
        if (seq !== loadSeq) return;
        console.warn('[PARCOURS] Étapes indisponibles :', error);
        status = 'error';
        inputs = null;
        ordered = null;
        renderStops(error.message);
        applyTimeline();
        signalLoaded();
        return;
    }
    if (seq !== loadSeq) return;
    rebuild();
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
    timeline = ordered ? buildParcoursTimeline(ordered, { pace: playback.pace, photosByStop: photoByStop }) : null;
    const stops = timeline?.stops || [];
    projected = stops.map((stop) => ol.proj.fromLonLat([stop.lon, stop.lat]));
    // Une feature WebGL par étape comptée : lieux et bases sont dessinés par
    // le plan et les couches de lecture (`olFeatures` est creux).
    olFeatures = stops.map((stop, i) => (!isCountedStop(stop) ? null : new ol.Feature({
        geometry: new ol.geom.Point(projected[i]),
        cache_type: stop.kind === 'lab' ? 'Lab Cache' : (stop.type || ''),
        gc_code: stop.code || '',
        name: stop.name || '',
        placedDay: stop.q,
        archivedDay: EVO_NEVER_DAY,
        stagger: 0,
        stopIndex: i,
    })));
    const counted = stops.filter(isCountedStop).length;
    pkg.setExternalDatasetState(buildMeta(), { selected: counted, total: counted });
    pkg.setPickerDates?.(pkg.metadata);
    pkg.updateAnimationMenuAfterReadBdd?.(pkg.metadata);
    pkg.setLifecycleFeatures(olFeatures.filter(Boolean));
    pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    renderLayer({ fit });
    preloadPhotos();
    renderPhotos();
}

function buildMeta() {
    if (!timeline || timeline.stops.length === 0) {
        return { startDate: null, endDate: null, deltaDays: null, numberOfCaches: 0, tagMaxes: {} };
    }
    const lastDay = timeline.quanta - 1;
    const kinds = { find: 0, lab: 0 };
    for (const stop of timeline.stops) if (stop.kind in kinds) kinds[stop.kind]++;
    const counted = timeline.stops.filter(isCountedStop).length;
    const lastDayNumber = timeline.days[timeline.days.length - 1]?.dayNumber || 1;
    return {
        startDate: pkg.formatDateIso(QUANTUM_ORIGIN),
        endDate: pkg.formatDateIso(dateOfDayIndex(quantumBase, lastDay)),
        deltaDays: timeline.quanta,
        numberOfCaches: counted,
        // Réserve de largeur de la ligne d'infos (frames.js) : plus grandes
        // valeurs à venir.
        tagMaxes: {
            etapes: counted,
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
    const placed = stopsInRange(timeline, first, last).map((i) => olFeatures[i]).filter(Boolean);
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

// Le géocacheur, et sous lui les bases (toujours) et les lieux déjà atteints.
function drawPlayHead(event) {
    if (!clock.running || !timeline) return;
    const head = headAt(timeline, currentQ);
    if (!head) return;
    const context = ol.render.getVectorContext(event);
    timeline.stops.forEach((stop, i) => {
        if (stop.kind === KIND_BASE || (stop.kind === KIND_PLACE && stop.q <= currentQ)) {
            context.setStyle(placeStyle(stop.kind));
            context.drawGeometry(new ol.geom.Point(projected[i]));
        }
    });
    const { color } = trailOptions();
    context.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
            radius: 7,
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
        }),
    }));
    context.drawGeometry(new ol.geom.Point(ol.proj.fromLonLat([head.lon, head.lat])));
    // Après le géocacheur : la carte postale passe au-dessus.
    drawPhotoCards(event);
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

const KIND_ICONS = Object.freeze({
    find: 'ti-map-pin', lab: 'ti-flask', dnf: 'ti-mood-sad', [KIND_PLACE]: 'ti-flag', [KIND_BASE]: 'ti-home',
});

function stopLabel(stop) {
    if (stop.kind === 'lab') return stop.adventure ? `${stop.adventure} — ${stop.name || ''}` : (stop.name || stop.key);
    if (stop.kind === KIND_BASE) return stop.name || t('Base');
    if (stop.kind === KIND_PLACE) return stop.name || t('Lieu');
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
        case REASON_PINNED: return t('heure épinglée');
        case REASON_MANUAL: return t('ordre manuel');
        case REASON_BASE: return t('base');
        case REASON_PHOTO: return t('heure d’une photo');
        default: return '';
    }
}

function stopDetail(stop) {
    const parts = [];
    if (stop.code) parts.push(stop.code);
    if (stop.kind === 'dnf') parts.push(t('DNF'));
    else if (stop.kind === KIND_PLACE) parts.push(t('lieu'));
    else if (stop.kind !== KIND_BASE && stop.type) parts.push(stop.type);
    const reason = reasonLabel(stop.reason);
    if (reason) parts.push(reason);
    if (stop.movedFrom) parts.push(t('déplacée du ${day}', { day: formatDay(stop.movedFrom, { day: 'numeric', month: 'short' }) }));
    const photos = photoByStop.get(stop.key)?.length || 0;
    if (photos) parts.push(photos === 1 ? t('1 photo') : t('${n} photos', { n: photos }));
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
    // Ordre manuel : le verdict sur l'ordre des logs ne décrit plus la journée.
    if (day.manual) {
        // rien
    } else if (d.logOrder === LOG_ORDER_TRUSTED) parts.push(t('ordre de saisie des logs retenu'));
    else if (d.logOrder === LOG_ORDER_REJECTED) {
        parts.push(t('logs saisis dans le désordre (trajet ×${ratio}) : ordre géographique',
            { ratio: d.logRatio.toLocaleString(pageLocale(), { maximumFractionDigits: 1 }) }));
    }
    if (d.anchors > 0) parts.push(t('${n} heures sûres', { n: d.anchors }));
    if (d.compressed) parts.push(t('horaire comprimé'));
    return parts.join(' · ');
}

function hasAdjustments() {
    return (inputs?.overrides?.length || 0) > 0;
}

function overrideOf(key) {
    return (inputs?.overrides || []).find((o) => o.key === key) || null;
}

function placeOf(stop) {
    return Number.isFinite(stop.placeId) ? (inputs?.places || []).find((p) => p.id === stop.placeId) || null : null;
}

function button(className, iconClass, label, { title = label, text = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    const icon = document.createElement('i');
    icon.className = `ti ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    btn.append(icon);
    if (text) {
        icon.classList.add('me-1');
        btn.append(text);
    }
    return btn;
}

function renderStops(errorMessage = '') {
    const box = el('parcoursStops');
    const summary = el('parcoursSummary');
    const tools = el('parcoursStopsTools');
    if (!box) return;
    if (tools) tools.hidden = !ordered;
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
    const reset = el('btnParcoursResetAdjustments');
    if (reset) reset.hidden = !hasAdjustments();
    const note = el('parcoursOrderNote');
    if (note) {
        note.textContent = logsAvailable
            ? t('Ordre et heures reconstruits d’après l’ordre de saisie de vos logs, l’heure de vos Labs et la géographie. « ≈ » : heure estimée.')
            : t('Sans identifiants de logs, l’ordre vient de vos Labs et de la géographie : réimportez votre fichier My Finds pour en profiter. « ≈ » : heure estimée.');
    }
    box.replaceChildren(...ordered.days.map(renderDay));
}

function renderDay(day) {
    const section = document.createElement('section');
    section.className = 'parcours-day mb-3';
    section.dataset.date = day.date;
    const header = document.createElement('div');
    header.className = 'd-flex align-items-center gap-2 flex-wrap';
    const title = document.createElement('h6');
    title.className = 'parcours-day-title mb-1';
    title.textContent = formatDay(day.date);
    header.append(title);
    if (day.manual) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-azure-lt parcours-day-manual';
        badge.textContent = t('ordre manuel');
        const auto = button('btn btn-link btn-sm p-0 parcours-day-auto', 'ti-arrow-back-up',
            t('Revenir à l’ordre automatique'), { text: t('Ordre automatique') });
        auto.addEventListener('click', () => resetDayOrder(day));
        header.append(badge, auto);
    }
    section.append(header);
    if (day.stops.length > 0) {
        const diagnostic = document.createElement('div');
        diagnostic.className = 'small text-muted mb-1 parcours-day-diagnostic';
        diagnostic.textContent = dayDiagnostic(day);
        section.append(diagnostic);
    } else {
        const empty = document.createElement('div');
        empty.className = 'small text-muted';
        empty.textContent = t('Aucune étape ce jour-là');
        section.append(empty);
    }
    if (day.stops.length > 0 || day.excluded.length > 0) {
        const list = document.createElement('ol');
        list.className = 'list-unstyled mb-0 parcours-stop-list';
        const movable = day.stops.filter((stop) => stop.kind !== KIND_BASE);
        for (const stop of day.stops) list.append(...renderStopRow(stop, day, movable));
        for (const stop of day.excluded) list.append(...renderExcludedRow(stop));
        section.append(list);
    }
    return section;
}

function renderStopRow(stop, day, movable) {
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
    if (Number.isFinite(stop.index)) {
        badge.textContent = String(stop.index);
    } else {
        const icon = document.createElement('i');
        icon.className = `ti ${KIND_ICONS[stop.kind]}`;
        icon.setAttribute('aria-hidden', 'true');
        badge.append(icon);
    }
    const icon = document.createElement('i');
    icon.className = `ti ${KIND_ICONS[stop.kind] || KIND_ICONS.find} text-muted mt-1`;
    icon.setAttribute('aria-hidden', 'true');
    // Le texte ouvre le panneau d'ajustement de l'étape.
    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'btn btn-link p-0 text-start flex-grow-1 min-w-0 parcours-stop-text';
    text.setAttribute('aria-expanded', String(editKey === stop.key));
    const name = document.createElement('div');
    name.className = 'text-truncate';
    name.textContent = stopLabel(stop);
    const detail = document.createElement('div');
    detail.className = 'small text-muted';
    detail.textContent = stopDetail(stop);
    text.append(name, detail);
    text.addEventListener('click', () => {
        editKey = editKey === stop.key ? null : stop.key;
        renderStops();
    });
    item.append(time, badge, icon, text);

    const position = movable.indexOf(stop);
    if (position >= 0) {
        const up = button('btn btn-sm btn-ghost-secondary parcours-stop-up', 'ti-arrow-up', t('Monter'));
        up.disabled = position === 0;
        up.addEventListener('click', () => moveStop(day, stop.key, -1));
        const down = button('btn btn-sm btn-ghost-secondary parcours-stop-down', 'ti-arrow-down', t('Descendre'));
        down.disabled = position === movable.length - 1;
        down.addEventListener('click', () => moveStop(day, stop.key, 1));
        item.append(up, down);
        // Glisser-déposer dans la journée (les boutons font la même chose au
        // clavier).
        item.draggable = true;
        item.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData('text/plain', stop.key);
            event.dataTransfer.effectAllowed = 'move';
            dragged = { date: day.date, key: stop.key };
            item.classList.add('is-dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('is-dragging');
            dragged = null;
        });
        item.addEventListener('dragover', (event) => {
            if (dragged?.date !== day.date || dragged.key === stop.key) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        });
        item.addEventListener('drop', (event) => {
            if (dragged?.date !== day.date) return;
            event.preventDefault();
            const keys = movable.map((s) => s.key).filter((key) => key !== dragged.key);
            const rect = item.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            keys.splice(keys.indexOf(stop.key) + (after ? 1 : 0), 0, dragged.key);
            dragged = null;
            reorderDay(keys);
        });
    }
    return editKey === stop.key ? [item, renderEditPanel(stop, day)] : [item];
}

function renderExcludedRow(stop) {
    const item = document.createElement('li');
    item.className = 'parcours-stop is-excluded d-flex align-items-center gap-2 py-1';
    item.dataset.stopKey = stop.key;
    const label = document.createElement('div');
    label.className = 'flex-grow-1 min-w-0 text-muted';
    const name = document.createElement('div');
    name.className = 'text-truncate text-decoration-line-through';
    name.textContent = stopLabel(stop);
    const detail = document.createElement('div');
    detail.className = 'small';
    detail.textContent = t('exclue du parcours');
    label.append(name, detail);
    const restore = button('btn btn-sm btn-outline-secondary parcours-stop-restore', 'ti-arrow-back-up',
        t('Réintégrer'), { text: t('Réintégrer') });
    restore.addEventListener('click', () => saveOverrides([{ key: stop.key, excluded: false }]));
    item.append(label, restore);
    return [item];
}

// Panneau d'ajustement d'une étape : heure épinglée, journée, exclusion ;
// pour un lieu ou une base, son heure et sa suppression.
function renderEditPanel(stop, day) {
    const panel = document.createElement('li');
    panel.className = 'parcours-stop-edit card card-body py-2 px-3 mb-2';
    panel.dataset.editKey = stop.key;
    const place = placeOf(stop);

    if (stop.kind !== KIND_BASE) {
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const label = document.createElement('label');
        label.className = 'small';
        label.textContent = t('Heure');
        const input = document.createElement('input');
        input.type = 'time';
        input.className = 'form-control form-control-sm w-auto parcours-edit-time';
        const pinned = stop.kind === KIND_PLACE ? place?.time : overrideOf(stop.key)?.pinnedTime;
        input.value = pinned || minutesToTime(stop.arrivalMin);
        label.htmlFor = input.id = `parcoursEditTime-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const pin = button('btn btn-sm btn-outline-primary parcours-edit-pin', 'ti-pin', t('Épingler cette heure'),
            { text: t('Épingler') });
        pin.addEventListener('click', () => {
            if (!input.value) return;
            if (stop.kind === KIND_PLACE) updatePlace(stop.placeId, { time: input.value });
            else saveOverrides([{ key: stop.key, pinnedTime: input.value }]);
        });
        row.append(label, input, pin);
        if (pinned) {
            const unpin = button('btn btn-sm btn-link parcours-edit-unpin', 'ti-x', t('Retirer l’heure épinglée'),
                { text: t('Retirer') });
            unpin.addEventListener('click', () => {
                if (stop.kind === KIND_PLACE) updatePlace(stop.placeId, { time: null });
                else saveOverrides([{ key: stop.key, pinnedTime: null }]);
            });
            row.append(unpin);
        }
        panel.append(row);
    }

    if (isCountedStop(stop) && ordered.days.length > 1) {
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const label = document.createElement('label');
        label.className = 'small';
        label.textContent = t('Journée');
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm w-auto parcours-edit-day';
        label.htmlFor = select.id = `parcoursEditDay-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        for (const option of ordered.days) {
            const opt = document.createElement('option');
            opt.value = option.date;
            opt.textContent = formatDay(option.date, { weekday: 'short', day: 'numeric', month: 'short' });
            opt.selected = option.date === day.date;
            select.append(opt);
        }
        select.addEventListener('change', () => {
            // Retour à la journée d'origine : l'ajustement disparaît.
            const original = stop.movedFrom || day.date;
            saveOverrides([{ key: stop.key, day: select.value === original ? null : select.value, rank: null }]);
        });
        row.append(label, select);
        panel.append(row);
    }

    const actions = document.createElement('div');
    actions.className = 'd-flex gap-2 flex-wrap';
    if (isCountedStop(stop)) {
        const exclude = button('btn btn-sm btn-outline-danger parcours-edit-exclude', 'ti-eye-off',
            t('Exclure du parcours'), { text: t('Exclure du parcours') });
        exclude.addEventListener('click', () => {
            editKey = null;
            saveOverrides([{ key: stop.key, excluded: true, rank: null }]);
        });
        actions.append(exclude);
    } else if (place) {
        const remove = button('btn btn-sm btn-outline-danger parcours-edit-delete-place', 'ti-trash',
            place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu'),
            { text: place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu') });
        remove.addEventListener('click', () => {
            editKey = null;
            deletePlace(place.id);
        });
        actions.append(remove);
    }
    panel.append(actions);
    return panel;
}

// --- Ajustements : écriture puis reconstruction ---------------------------------

function adjustmentsLocked() {
    if (!clock.running) return false;
    showToast(t('Arrêtez la lecture avant d’ajuster le parcours.'), 'info', t('Parcours'));
    return true;
}

// Reconstruction complète : ordre et heures, rattachement des photos, heures
// des photos comme ancres (deux passes, parcours_photos.mjs).
function rebuild() {
    const result = reconstructWithPhotos(inputs);
    ordered = result.ordered;
    photoMatches = result.matches;
    photoByStop = result.byStop;
}

// Les ajustements renvoyés par le serveur remplacent ceux en mémoire, puis le
// parcours est reconstruit (pur, donc immédiat) et rejoué tel quel.
function receiveAdjustments(payload) {
    if (!inputs) return;
    if (Array.isArray(payload?.overrides)) inputs.overrides = payload.overrides;
    if (Array.isArray(payload?.places)) inputs.places = payload.places;
    if (Array.isArray(payload?.photos)) inputs.photos = payload.photos;
    if (Array.isArray(payload?.cameras)) inputs.cameras = payload.cameras;
    rebuild();
    renderStops();
    applyTimeline();
    adjustmentRevision++;
}

async function saveOverrides(patches) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        receiveAdjustments(await fetchJson(`/api/parcours/${selectedId}/overrides`, {
            method: 'PATCH',
            body: JSON.stringify({ overrides: patches }),
        }));
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Nouvel ordre d'une journée : un rang pour chacune de ses étapes.
function reorderDay(keys) {
    saveOverrides(keys.map((key, rank) => ({ key, rank })));
}

function moveStop(day, key, delta) {
    const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key);
    const from = keys.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= keys.length) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    reorderDay(keys);
}

function resetDayOrder(day) {
    saveOverrides(day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => ({ key: stop.key, rank: null })));
}

async function resetAllAdjustments() {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        receiveAdjustments(await fetchJson(`/api/parcours/${selectedId}/overrides`, { method: 'DELETE' }));
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function reloadAdjustments() {
    const fresh = await fetchJson(`/api/parcours/${selectedId}/inputs`);
    receiveAdjustments({ overrides: fresh.overrides, places: fresh.places, photos: fresh.photos, cameras: fresh.cameras });
}

async function createPlace(data) {
    if (!selectedId || adjustmentsLocked()) return false;
    try {
        await fetchJson(`/api/parcours/${selectedId}/places`, { method: 'POST', body: JSON.stringify(data) });
        await reloadAdjustments();
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

async function updatePlace(id, data) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        await fetchJson(`/api/parcours/${selectedId}/places/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
        await reloadAdjustments();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deletePlace(id) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        await fetchJson(`/api/parcours/${selectedId}/places/${id}`, { method: 'DELETE' });
        await reloadAdjustments();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// --- Poser un lieu d'un clic sur la carte ------------------------------------------

function startPlacePicking() {
    if (!ordered || adjustmentsLocked()) return;
    const map = pkg.getMap?.();
    if (!map) return;
    cancelPlacePicking();
    picking = true;
    map.getTargetElement()?.classList.add('parcours-picking');
    const hint = el('parcoursPlaceHint');
    if (hint) hint.hidden = false;
    pickListener = map.once('singleclick', (event) => {
        pickListener = null;
        stopPicking();
        const [lon, lat] = ol.proj.toLonLat(event.coordinate);
        openPlaceForm({ lon, lat });
    });
}

function stopPicking() {
    picking = false;
    pkg.getMap?.()?.getTargetElement()?.classList.remove('parcours-picking');
    const hint = el('parcoursPlaceHint');
    if (hint) hint.hidden = true;
}

function cancelPlacePicking() {
    if (pickListener) {
        ol.Observable.unByKey(pickListener);
        pickListener = null;
    }
    stopPicking();
}

function openPlaceForm({ lon, lat }) {
    const form = el('parcoursPlaceForm');
    if (!form) return;
    placeDraft = { lon, lat };
    const days = el('parcoursPlaceDay');
    if (days) {
        days.replaceChildren();
        const all = document.createElement('option');
        all.value = '';
        all.textContent = t('Toutes les journées');
        all.dataset.baseOnly = '1';
        days.append(all);
        for (const day of ordered?.days || []) {
            const opt = document.createElement('option');
            opt.value = day.date;
            opt.textContent = formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'short' });
            days.append(opt);
        }
        // Proposition : la première journée qui a des étapes.
        const first = (ordered?.days || []).find((day) => day.stops.length > 0);
        days.value = first?.date || '';
    }
    const coords = el('parcoursPlaceCoords');
    if (coords) coords.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    el('parcoursPlaceName').value = '';
    el('parcoursPlaceTime').value = '';
    el('parcoursPlaceKind').value = KIND_PLACE;
    syncPlaceForm();
    form.hidden = false;
    el('parcoursPlaceName')?.focus();
}

// Une base peut valoir pour toutes les journées et n'a pas d'heure ; un lieu
// a toujours sa journée.
function syncPlaceForm() {
    const base = el('parcoursPlaceKind')?.value === KIND_BASE;
    const days = el('parcoursPlaceDay');
    const all = days?.querySelector('option[data-base-only]');
    if (all) {
        all.hidden = !base;
        all.disabled = !base;
        if (!base && days.value === '') days.value = days.options[1]?.value || '';
    }
    const timeRow = el('parcoursPlaceTimeRow');
    if (timeRow) timeRow.hidden = base;
}

function closePlaceForm() {
    placeDraft = null;
    const form = el('parcoursPlaceForm');
    if (form) form.hidden = true;
}

function bindAdjustments() {
    el('btnParcoursResetAdjustments')?.addEventListener('click', () => {
        showConfirmation(
            t('Annuler tous les ajustements de ce parcours (ordre, heures, journées, exclusions) ? Les lieux posés sont gardés.'),
            t('Annuler les ajustements'),
            () => resetAllAdjustments(),
            null,
            { danger: true, confirmText: t('Tout annuler') },
        );
    });
    el('btnParcoursAddPlace')?.addEventListener('click', () => {
        if (picking) cancelPlacePicking();
        else startPlacePicking();
    });
    el('parcoursPlaceKind')?.addEventListener('change', syncPlaceForm);
    el('btnParcoursPlaceCancel')?.addEventListener('click', closePlaceForm);
    el('parcoursPlaceForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!placeDraft) return;
        const kind = el('parcoursPlaceKind').value;
        const ok = await createPlace({
            kind,
            name: el('parcoursPlaceName').value,
            lat: placeDraft.lat,
            lon: placeDraft.lon,
            date: el('parcoursPlaceDay').value || null,
            time: kind === KIND_PLACE ? (el('parcoursPlaceTime').value || null) : null,
        });
        if (ok) closePlaceForm();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && picking) cancelPlacePicking();
    });
}

// --- Photos (lot 4) -------------------------------------------------------------

// Image chargée de chaque photo, pour la carte postale de la lecture et de la
// vidéo : même origine que la page, le canevas reste exportable.
const photoImages = new Map();   // id → HTMLImageElement
let photoDetailId = null;        // photo dont le panneau est ouvert
let photoUploads = 0;            // envois en cours

function photoUrl(photo, thumb = false) {
    return `${CONFIG.BASE_URL}/api/parcours/${selectedId}/photos/${photo.id}/${thumb ? 'thumb' : 'file'}`;
}

function photoById(id) {
    return (inputs?.photos || []).find((photo) => photo.id === id) || null;
}

function stopByKey(key) {
    for (const day of ordered?.days || []) {
        const stop = day.stops.find((s) => s.key === key);
        if (stop) return stop;
    }
    return null;
}

// Charge (une fois) les photos rattachées : la carte postale n'est dessinée
// qu'une fois l'image décodée.
function preloadPhotos() {
    const wanted = new Set();
    for (const ids of photoByStop.values()) for (const id of ids) wanted.add(id);
    for (const id of wanted) {
        if (photoImages.has(id)) continue;
        const photo = photoById(id);
        if (!photo) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = photoUrl(photo);
        photoImages.set(id, img);
    }
}

// Carte postale de la photo affichée à `currentQ`, près de son étape. Une
// étape montre ses photos l'une après l'autre ; chacune apparaît et
// s'efface en PHOTO_FADE_Q quanta.
const PHOTO_FADE_Q = 2;
const PHOTO_CARD_SIDE = 220;      // grand côté, en px CSS
function drawPhotoCards(event) {
    if (!timeline) return;
    const frameState = event.frameState;
    const ratio = frameState.pixelRatio || 1;
    const m = composeTransform(event.inversePixelTransform, frameState.coordinateToPixelTransform);
    const ctx = event.context;
    timeline.stops.forEach((stop, i) => {
        if (!stop.photos?.length || currentQ < stop.q || currentQ > stop.departQ + PHOTO_FADE_Q) return;
        const start = stop.q + 2;
        const k = Math.min(stop.photos.length - 1, Math.max(0, Math.floor((currentQ - start) / stop.photoQ)));
        const from = start + k * stop.photoQ;
        const to = from + stop.photoQ;
        const alpha = Math.max(0, Math.min(1, (currentQ - from) / PHOTO_FADE_Q, (to + PHOTO_FADE_Q - currentQ) / PHOTO_FADE_Q));
        const img = photoImages.get(stop.photos[k]);
        if (alpha <= 0 || !img?.complete || !img.naturalWidth) return;
        const [px, py] = projected[i];
        const x = m[0] * px + m[2] * py + m[4];
        const y = m[1] * px + m[3] * py + m[5];
        const scale = (PHOTO_CARD_SIDE * ratio) / Math.max(img.naturalWidth, img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const border = 7 * ratio;
        const cardW = w + border * 2;
        const cardH = h + border * 2;
        // Au-dessus à droite de l'étape, gardée dans l'écran.
        const cx = Math.min(ctx.canvas.width - cardW / 2 - 8 * ratio, Math.max(cardW / 2 + 8 * ratio, x + 18 * ratio + cardW / 2));
        const cy = Math.min(ctx.canvas.height - cardH / 2 - 8 * ratio, Math.max(cardH / 2 + 8 * ratio, y - 18 * ratio - cardH / 2));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx, cy);
        ctx.rotate((k % 2 === 0 ? -2.5 : 2) * Math.PI / 180);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 10 * ratio;
        ctx.shadowOffsetY = 3 * ratio;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
        ctx.shadowColor = 'transparent';
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
    });
}

async function uploadPhotos(files) {
    if (!selectedId || adjustmentsLocked() || files.length === 0) return;
    const status = el('parcoursPhotoStatus');
    let done = 0;
    const refused = [];
    photoUploads += files.length;
    for (const file of files) {
        if (status) status.textContent = t('Envoi des photos : ${done} / ${total}', { done, total: files.length });
        const body = new FormData();
        body.append('photo', file, file.name);
        try {
            const response = await fetch(`${CONFIG.BASE_URL}/api/parcours/${selectedId}/photos`, { method: 'POST', body });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                refused.push(`${file.name} : ${payload.message || response.status}`);
            }
        } catch (error) {
            refused.push(`${file.name} : ${error.message}`);
        }
        done++;
    }
    photoUploads -= files.length;
    if (status) status.textContent = '';
    if (refused.length) showToast(refused.join('\n'), 'warning', t('Photos refusées'));
    await reloadAdjustments();
}

async function linkPhoto(id, stopKey) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        await fetchJson(`/api/parcours/${selectedId}/photos/${id}`, {
            method: 'PATCH', body: JSON.stringify({ stopKey }),
        });
        await reloadAdjustments();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deletePhoto(id) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        await fetchJson(`/api/parcours/${selectedId}/photos/${id}`, { method: 'DELETE' });
        photoImages.delete(id);
        if (photoDetailId === id) photoDetailId = null;
        await reloadAdjustments();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function setCameraOffset(camera, offsetMinutes) {
    if (!selectedId || adjustmentsLocked()) return;
    try {
        receiveAdjustments(await fetchJson(`/api/parcours/${selectedId}/cameras`, {
            method: 'PUT', body: JSON.stringify({ camera, offsetMinutes }),
        }));
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Décalage qui met l'heure de la photo sur celle de son étape (minutes,
// arrondi), ou null si l'étape n'a pas d'heure sûre indépendante des photos.
function calibrationOffset(photo, stop) {
    if (!stop || stop.confidence !== CONFIDENCE_ANCHORED || stop.reason === REASON_PHOTO) return null;
    const raw = photoClock(photo);
    const day = ordered?.days.find((d) => d.stops.includes(stop))?.date;
    if (!raw || !day) return null;
    const dayShift = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${raw.date}T00:00:00Z`)) / 60000);
    return Math.round(stop.arrivalMin - raw.minutes + dayShift);
}

function formatOffset(minutes) {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(minutes);
    return `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')}`;
}

function matchLabel(match) {
    if (!match?.key) return t('non rattachée');
    const stop = stopByKey(match.key);
    const name = stop ? stopLabel(stop) : match.key;
    if (match.source === MATCH_MANUAL) return t('${name} (à la main)', { name });
    if (match.source === MATCH_GPS) return t('${name} (position)', { name });
    return t('${name} (heure)', { name });
}

function renderPhotos() {
    const card = el('parcoursPhotosCard');
    if (!card) return;
    card.hidden = !inputs;
    if (!inputs) return;
    const photos = inputs.photos || [];
    const offsets = cameraOffsets(inputs.cameras);
    const summary = el('parcoursPhotoSummary');
    if (summary) {
        const linked = photos.filter((photo) => photoMatches.get(photo.id)?.key).length;
        summary.textContent = photos.length
            ? t('${n} photos, ${linked} rattachées à une étape', { n: photos.length, linked })
            : t('Aucune photo pour ce parcours.');
    }

    // Appareils : décalage d'horloge (téléphones géolocalisés : à l'heure).
    const cameras = el('parcoursCameras');
    if (cameras) {
        const names = [...new Set(photos.filter((p) => p.camera && !hasPosition(p)).map((p) => p.camera))].sort();
        cameras.replaceChildren(...names.map((name) => {
            const row = document.createElement('div');
            row.className = 'mb-2 parcours-camera';
            row.dataset.camera = name;
            const label = document.createElement('div');
            label.className = 'small mb-1';
            label.textContent = offsets.has(name)
                ? t('${camera} : horloge recalée (${offset})', { camera: name, offset: formatOffset(offsets.get(name)) })
                : t('${camera} : horloge non recalée, heures ignorées', { camera: name });
            const controls = document.createElement('div');
            controls.className = 'd-flex align-items-center gap-2 flex-wrap';
            const input = document.createElement('input');
            input.type = 'number';
            input.step = '1';
            input.className = 'form-control form-control-sm parcours-camera-offset';
            input.value = offsets.has(name) ? String(offsets.get(name)) : '0';
            input.setAttribute('aria-label', t('Décalage en minutes'));
            const unit = document.createElement('span');
            unit.className = 'small text-muted';
            unit.textContent = t('min');
            const apply = button('btn btn-sm btn-outline-primary parcours-camera-apply', 'ti-clock',
                t('Recaler l’horloge'), { text: t('Recaler l’horloge') });
            apply.addEventListener('click', () => {
                const value = Math.round(Number(input.value));
                if (Number.isFinite(value)) setCameraOffset(name, value);
            });
            controls.append(input, unit, apply);
            if (offsets.has(name)) {
                const clear = button('btn btn-sm btn-link parcours-camera-clear', 'ti-x', t('Oublier ce recalage'));
                clear.addEventListener('click', () => setCameraOffset(name, null));
                controls.append(clear);
            }
            row.append(label, controls);
            return row;
        }));
    }

    const grid = el('parcoursPhotos');
    if (grid) {
        grid.replaceChildren(...photos.map((photo) => {
            const match = photoMatches.get(photo.id);
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'parcours-photo-thumb';
            cell.classList.toggle('is-linked', !!match?.key);
            cell.classList.toggle('is-active', photoDetailId === photo.id);
            cell.dataset.photoId = String(photo.id);
            cell.title = `${photo.name} — ${matchLabel(match)}`;
            const img = document.createElement('img');
            img.src = photoUrl(photo, true);
            img.alt = photo.name || '';
            img.loading = 'lazy';
            cell.append(img);
            cell.addEventListener('click', () => {
                photoDetailId = photoDetailId === photo.id ? null : photo.id;
                renderPhotos();
            });
            return cell;
        }));
    }
    renderPhotoDetail();
}

function renderPhotoDetail() {
    const box = el('parcoursPhotoDetail');
    if (!box) return;
    const photo = photoById(photoDetailId);
    box.hidden = !photo;
    if (!photo) {
        box.replaceChildren();
        return;
    }
    const match = photoMatches.get(photo.id);
    const clock = photoClock(photo, cameraOffsets(inputs.cameras));
    const info = document.createElement('div');
    info.className = 'small text-muted mb-2';
    info.textContent = [
        photo.name,
        clock ? `${formatDay(clock.date, { day: 'numeric', month: 'short' })} ${minutesToTime(clock.minutes)}` : t('sans heure'),
        hasPosition(photo) ? t('géolocalisée') : t('sans position'),
        photo.camera || '',
    ].filter(Boolean).join(' · ');
    const linkRow = document.createElement('div');
    linkRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
    const label = document.createElement('label');
    label.className = 'small';
    label.textContent = t('Étape');
    const select = document.createElement('select');
    select.className = 'form-select form-select-sm w-auto parcours-photo-stop';
    label.htmlFor = select.id = 'parcoursPhotoStop';
    const auto = document.createElement('option');
    auto.value = '';
    const autoMatch = photo.stopKey ? null : match;
    auto.textContent = autoMatch?.key ? t('Automatique : ${label}', { label: matchLabel(autoMatch) }) : t('Automatique');
    select.append(auto);
    for (const day of ordered?.days || []) {
        const group = document.createElement('optgroup');
        group.label = formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'short' });
        for (const stop of day.stops) {
            if (stop.kind === KIND_BASE) continue;
            const opt = document.createElement('option');
            opt.value = stop.key;
            opt.textContent = `${Number.isFinite(stop.index) ? `${stop.index}. ` : ''}${stopLabel(stop)}`;
            group.append(opt);
        }
        if (group.children.length) select.append(group);
    }
    select.value = photo.stopKey || '';
    select.addEventListener('change', () => linkPhoto(photo.id, select.value || null));
    linkRow.append(label, select);
    const actions = document.createElement('div');
    actions.className = 'd-flex gap-2 flex-wrap';
    const stop = match?.key ? stopByKey(match.key) : null;
    const offset = !hasPosition(photo) && photo.camera ? calibrationOffset(photo, stop) : null;
    if (offset !== null) {
        const calibrate = button('btn btn-sm btn-outline-primary parcours-photo-calibrate', 'ti-clock',
            t('Caler l’horloge de l’appareil sur cette étape'),
            { text: t('Caler l’horloge sur l’étape (${offset})', { offset: formatOffset(offset) }) });
        calibrate.addEventListener('click', () => setCameraOffset(photo.camera, offset));
        actions.append(calibrate);
    }
    const remove = button('btn btn-sm btn-outline-danger parcours-photo-delete', 'ti-trash', t('Supprimer la photo'),
        { text: t('Supprimer la photo') });
    remove.addEventListener('click', () => deletePhoto(photo.id));
    actions.append(remove);
    box.replaceChildren(info, linkRow, actions);
}

function bindPhotos() {
    const input = el('parcoursPhotoInput');
    el('btnParcoursAddPhotos')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        uploadPhotos(files);
    });
}

// --- Carte ----------------------------------------------------------------------

function pointStyle(feature) {
    const kind = feature.get('kind');
    if (kind === KIND_BASE || kind === KIND_PLACE) return placeStyle(kind);
    return new ol.style.Style({
        image: new ol.style.Circle({
            radius: 11,
            fill: new ol.style.Fill({ color: KIND_COLORS[kind] || KIND_COLORS.find }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }),
        }),
        text: new ol.style.Text({
            text: String(feature.get('index')),
            font: '600 11px system-ui, sans-serif',
            fill: new ol.style.Fill({ color: '#ffffff' }),
        }),
    });
}

// Base : carré sombre ; lieu : étoile violette. Communs au plan et à la
// lecture.
const placeStyles = new Map();
function placeStyle(kind) {
    if (!placeStyles.has(kind)) {
        const base = kind === KIND_BASE;
        placeStyles.set(kind, new ol.style.Style({
            image: new ol.style.RegularShape({
                points: base ? 4 : 5,
                radius: base ? 10 : 11,
                radius2: base ? undefined : 5,
                angle: base ? Math.PI / 4 : 0,
                fill: new ol.style.Fill({ color: KIND_COLORS[kind] }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }),
            }),
        }));
    }
    return placeStyles.get(kind);
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
    // quand deux étapes se recouvrent. Une base n'est dessinée qu'une fois.
    const seen = new Set();
    for (const stop of [...parcoursStops(ordered)].reverse()) {
        const id = stop.kind === KIND_BASE ? `base:${stop.placeId}` : stop.key;
        if (seen.has(id)) continue;
        seen.add(id);
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
            manual: day.manual,
            excluded: day.excluded.map((stop) => stop.key),
        })),
        overrides: (inputs?.overrides || []).map((o) => ({ ...o })),
        places: (inputs?.places || []).map((p) => ({ ...p })),
        adjustmentRevision,
        editKey,
        picking,
        photos: (inputs?.photos || []).map((photo) => ({
            id: photo.id,
            stopKey: photo.stopKey,
            match: photoMatches.get(photo.id) || null,
        })),
        cameras: (inputs?.cameras || []).map((c) => ({ ...c })),
        photoStops: Object.fromEntries([...photoByStop].map(([key, ids]) => [key, [...ids]])),
        photosLoaded: [...photoImages.values()].filter((img) => img.complete && img.naturalWidth > 0).length,
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
