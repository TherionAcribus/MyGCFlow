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
import { isImageFile } from './images_model.mjs';
import { isAudioFile } from './music_track.mjs';
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
    CAMERA_FOLLOW,
    HEAD_PICTOGRAM,
    HOURS_NONE,
    HOURS_SLOTS,
    barSeries,
    barTicks,
    buildParcoursTimeline,
    dayCardAt,
    formatClock,
    headAt,
    headModeAt,
    legIndexAt,
    legPoints,
    legTravelMode,
    nightLevelAt,
    normalizePlayback,
    stateAt,
    stopsInRange,
    trailAt,
} from './parcours_timeline.mjs';
import { cameraPoseAt } from './parcours_camera.mjs';
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
    REASON_TRACK,
    isCountedStop,
    minutesToTime,
} from './parcours_reconstruct.mjs';
import {
    MATCH_GPS,
    MATCH_MANUAL,
    cameraOffsets,
    hasPosition,
    photoClock,
    photoTimeTrusted,
    suggestPhotoPlaces,
} from './parcours_photos.mjs';
import {
    PHOTO_LAYOUT_NONE,
    PHOTO_ZOOM_RANGE,
    isFullFrame,
    normalizePhotoDisplay,
    photoAspect,
    photoCaptionText,
    photoCrop,
    photoCropRect,
    photoFrameAt,
    photoSlots,
    photoTimelineOptions,
} from './parcours_photo_layout.mjs';
import { drawPhotoCard, drawPhotoLeader } from './parcours_photo_draw.mjs';
import {
    OFFSET_COMPUTER,
    OFFSET_EVIDENCE,
    OFFSET_MANUAL,
    OFFSET_PHOTOS,
    localClock,
    reconstructWithEvidence,
} from './parcours_tracks.mjs';
import { composeTransform } from './travel_trail.mjs';
import { cacheKey, legModeFor, pendingRuns, routeEffects, routeRuns } from './parcours_routing.mjs';

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
let suggestions = [];         // séjours et grosses journées proposés (lot 7)
let suggestionsSeq = 0;
let findsExtent = { first: null, last: null };
let homeCenter = null;        // centre habituel des trouvailles (GET /api/parcours)
let maxDays = 92;
let selectedId = null;
let inputs = null;            // entrées du parcours ouvert, ajustements compris
let ordered = null;           // reconstruction du parcours ouvert (photos comprises)
let photoMatches = new Map(); // rattachement de chaque photo (parcours_photos.mjs)
let photoByStop = new Map();  // clé d'étape → photos, dans l'ordre d'affichage
let trackMatches = new Map(); // clé d'étape → passage d'une trace (parcours_tracks.mjs)
let legPaths = new Map();     // « from>to » → vrai chemin [[lon, lat], ...]
let utcOffset = { minutes: 0, source: 'computer' };
let legProjected = [];        // chemin de chaque trajet, en coordonnées carte
// Itinéraires (lot 6).
const routeCache = new Map(); // cacheKey(profil, « from>to ») → réponse du serveur
let routeRunsNow = [];        // requêtes utiles au parcours ouvert (parcours_routing.mjs)
let routeEffectsNow = { hints: new Map(), paths: new Map(), missing: 0 };
let routeState = { state: 'idle', message: '' };
let routeSeq = 0;
let routeRevision = 0;
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
// Affichage des photos (lot 9) : préférence globale `parcours_photo_display`.
let photoDisplay = normalizePhotoDisplay(window.userSettings?.parcours_photo_display);
let infosTemplate = normalizeInfosTemplate(window.userSettings?.parcours_infos_template);
let timeline = null;          // buildParcoursTimeline(ordered) du parcours ouvert
let timelineRevision = 0;     // change à chaque `timeline` (barre de chronologie)
let projected = [];           // coordonnées carte des étapes de `timeline`
let olFeatures = [];          // une feature WebGL par étape de `timeline`
const clock = createEvolutionClock();
let endDay = 0;
let currentQ = 0;             // position du moteur, en quanta fractionnaires
let pendingOpenId = null;     // parcours ouvert pendant une lecture
let pendingTimeline = false;  // rythme changé pendant une lecture
let playTrailLayer = null;
let playHeadLayer = null;
// Caméra de la lecture (lot 7, parcours_camera.mjs) : vue d'avant la lecture,
// rendue à la fin ; suspendue dès que l'utilisateur déplace la carte.
let savedView = null;
let cameraSuspended = false;
let cameraBound = false;
let prefetchBucket = null;

// Ajustements (lot 3).
let editKey = null;           // étape dont le panneau d'ajustement est ouvert
let dragged = null;           // { date, key } pendant un glisser-déposer
let picking = false;          // en attente d'un clic sur la carte (lieu)
let pickListener = null;
let placeDraft = null;        // { lon, lat } du lieu en cours de saisie
let clickMutedUntil = 0;      // clic de pose/déplacement : ne pas l'ouvrir en étape
let hoveredFeature = null;    // point du plan mis en évidence par la liste
let mapHoverRows = [];        // lignes de la liste mises en évidence par la carte
let hoverBound = false;
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
    photoDisplay = normalizePhotoDisplay(window.userSettings?.parcours_photo_display);
    infosTemplate = normalizeInfosTemplate(window.userSettings?.parcours_infos_template);
    const inp = el('inputInfosTemplate');
    if (inp) inp.value = infosTemplate;
    bindForm();
    bindPlayback();
    bindAdjustments();
    bindPhotos();
    bindTracks();
    bindRouting();
    bindFileDrop();
    pkg.syncOverlayVisibility?.();
    await refreshParcoursList({ select: readLastId() });
}

export async function refreshParcoursList({ select = selectedId } = {}) {
    try {
        const body = await fetchJson('/api/parcours');
        listing = Array.isArray(body.parcours) ? body.parcours : [];
        findsExtent = body.finds || findsExtent;
        maxDays = Number(body.maxDays) || maxDays;
        homeCenter = Number.isFinite(body.home?.lon) ? body.home : null;
    } catch (error) {
        console.warn('[PARCOURS] Liste indisponible :', error);
        listing = [];
        renderListError();
        status = 'error';
        signalLoaded();
        return;
    }
    fillFormDefaults();
    loadSuggestions();
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
    // Itinéraires : toute suite en vol appartient au parcours quitté — le
    // numéro de séquence la tue, son état et son cache ne le suivent pas
    // (deux parcours peuvent partager les clés « place:n » de trajets).
    routeSeq++;
    routeState = { state: 'idle', message: '' };
    routeCache.clear();
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
    // Sans photos dans la vidéo, les étapes ne s'allongent pas pour elles.
    timeline = ordered ? buildParcoursTimeline(ordered, {
        pace: playback.pace,
        photosByStop: photoDisplay.layout === PHOTO_LAYOUT_NONE ? null : photoByStop,
        legPaths,
        options: photoTimelineOptions(photoDisplay),
    }) : null;
    const stops = timeline?.stops || [];
    projected = stops.map((stop) => ol.proj.fromLonLat([stop.lon, stop.lat]));
    legProjected = (timeline?.legs || []).map((leg) => (leg.path ? leg.path.map((p) => ol.proj.fromLonLat(p)) : null));
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
    timelineRevision++;
    pkg.setExternalDatasetState(buildMeta(), { selected: counted, total: counted });
    pkg.setPickerDates?.(pkg.metadata);
    pkg.updateAnimationMenuAfterReadBdd?.(pkg.metadata);
    pkg.setLifecycleFeatures(olFeatures.filter(Boolean));
    pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    renderLayer({ fit });
    preloadPhotos();
    renderPhotos();
    renderTracks();
    renderRouting();
    ensureRoutes();
    pkg.refreshTimelineBar?.();
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
    beginCamera();
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
    endCamera();
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
        rebuild();
        renderStops();
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

// --- Barre de chronologie ---------------------------------------------------------
//
// timeline_bar.js compte en jours du moteur, donc ici en quanta, sur des dates
// fictives : ce crochet lui donne la série, les repères et les textes en vraies
// dates et heures. `axisStart` est la date fictive du premier quantum de la
// piste, `offset` un quantum de la piste. La plage est le parcours entier.

function barFirstQ(axisStart) {
    return dayIndexOf(quantumBase, axisStart);
}

function barStateAt(axisStart, offset) {
    return timeline ? stateAt(timeline, barFirstQ(axisStart) + offset) : null;
}

// « Jour 2 · dim. 13 juil. » (la date seule pour une journée unique).
function barDayText(state) {
    if (!state?.date) return '';
    const date = formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
    if ((timeline?.days?.length || 0) < 2) return date;
    return t('Jour ${n}', { n: state.dayNumber }) + ' · ' + date;
}

function barClockText(state) {
    return state ? formatClock(state.minutes, state.estimated, playback.hours, slotLabels()) : '';
}

function stopsCountText(n) {
    return n > 1 ? t('${n} étapes', { n }) : t('${n} étape', { n });
}

function travelModeLabel(mode) {
    switch (mode) {
        case 'bike': return t('à vélo');
        case 'car': return t('en voiture');
        case 'plane': return t('en avion');
        default: return t('à pied');
    }
}

// Où en est le géocacheur au quantum `q` : avant le départ, à une étape, en
// route, la nuit, ou à la fin.
function barSituation(q, state) {
    const legIndex = legIndexAt(timeline, q);
    if (legIndex >= 0) {
        const leg = timeline.legs[legIndex];
        if (leg.night) return t('Nuit');
        const mode = travelModeLabel(legTravelMode(timeline, legIndex));
        const name = stopLabel(timeline.stops[leg.to]);
        return t('Trajet ${mode} vers ${name}', { mode, name }) + ' · ' + formatKm(leg.km);
    }
    if (state.reached < 0) return t('Avant la première étape');
    const stop = timeline.stops[state.reached];
    if (state.reached === timeline.stops.length - 1 && q >= stop.departQ) return t('Fin du parcours');
    if (!isCountedStop(stop)) return stopLabel(stop);
    return t('Étape ${n} : ${name}', { n: state.stopsReached, name: stopLabel(stop) });
}

function barEdgeText(axisStart, offset) {
    const state = barStateAt(axisStart, offset);
    if (!state?.date) return '';
    const date = formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
    return [date, barClockText(state)].filter(Boolean).join(' · ');
}

// Étiquette au curseur (et valeur du slider) : courte, sa largeur est fixe
// (ui_improvements.css) — le numéro du jour et la distance sont dans la bulle.
function barPositionText(axisStart, offset) {
    const state = barStateAt(axisStart, offset);
    if (!state?.date) return '';
    const date = formatDay(state.date, { weekday: 'short', day: 'numeric', month: 'short' });
    return [date, barClockText(state), stopsCountText(state.stopsReached)].filter(Boolean).join(' · ');
}

function barTipLines(axisStart, offset) {
    const q = barFirstQ(axisStart) + offset;
    const state = timeline ? stateAt(timeline, q) : null;
    if (!state) return [];
    const total = stopsCountText(state.stopsReached) + ' · ' + formatKm(state.km);
    return [
        { text: [barDayText(state), barClockText(state)].filter(Boolean).join(' · '), strong: true },
        { text: barSituation(q, state) },
        { text: t('Total : ${text}', { text: total }) },
    ];
}

// Nuits en bandes ; journées (plusieurs) ou heures pleines (une seule, quand
// des heures sont affichées) en traits et étiquettes.
function barTickMarks(axisStart, span) {
    const out = { bands: [], lines: [], labels: [] };
    if (!timeline) return out;
    const ticks = barTicks(timeline, barFirstQ(axisStart), span);
    out.bands = ticks.bands;
    for (const { offset, day } of ticks.days) {
        if (offset > 0) out.lines.push(offset);
        out.labels.push({ offset, text: t('Jour ${n}', { n: timeline.days[day].dayNumber }) });
    }
    if (playback.hours === HOURS_NONE || playback.hours === HOURS_SLOTS) return out;
    for (const { offset, hour } of ticks.hours) {
        out.lines.push(offset);
        out.labels.push({ offset, text: `${String(hour).padStart(2, '0')}:00` });
    }
    return out;
}

// Repères : DNF et photos de chaque étape (au début de la première).
function barMarks(axisStart, span) {
    if (!timeline) return [];
    const firstQ = barFirstQ(axisStart);
    const marks = [];
    const push = (q, kind, label) => {
        const offset = Math.ceil(q - 1e-6) - firstQ;
        if (offset >= 0 && offset < span) marks.push({ offset, kind, label });
    };
    for (const stop of timeline.stops) {
        if (stop.kind === 'dnf') push(stop.q, 'dnf', t('DNF : ${code}', { code: stop.code || stopLabel(stop) }));
    }
    const photosByStop = new Map();
    for (const slot of photoSlots(timeline)) {
        const entry = photosByStop.get(slot.stop);
        if (entry) entry.count++;
        else photosByStop.set(slot.stop, { fromQ: slot.fromQ, count: 1 });
    }
    for (const [index, { fromQ, count }] of photosByStop) {
        const photos = count === 1 ? t('1 photo') : t('${n} photos', { n: count });
        push(fromQ, 'photo', photos + ' · ' + stopLabel(timeline.stops[index]));
    }
    return marks;
}

// Pg.Préc/Pg.Suiv : arrivée à la première étape de la journée suivante
// (direction 1) ou de la journée en cours / précédente (-1).
function barDayOffset(rangeStart, offset, direction) {
    if (!timeline) return null;
    const firstQ = barFirstQ(rangeStart);
    const starts = timeline.days
        .map((day) => Math.ceil((timeline.stops[day.first]?.q ?? 0) - 1e-6) - firstQ)
        .filter((start) => start >= 0);
    if (direction > 0) return starts.find((start) => start > offset) ?? null;
    return starts.filter((start) => start < offset).pop() ?? null;
}

const PARCOURS_TIMELINE_BAR = Object.freeze({
    rangeEditable: false,
    // Un cran de molette : 5 quanta (½ s à la vitesse naturelle).
    wheelStep: 5,
    revision: () => `${timelineRevision}|${playback.hours}`,
    series: (axisStart, span) => barSeries(timeline, barFirstQ(axisStart), span),
    ticks: barTickMarks,
    marks: barMarks,
    edgeText: barEdgeText,
    positionText: barPositionText,
    tipLines: barTipLines,
    dayOffset: barDayOffset,
});

const PARCOURS_ENGINE = Object.freeze({
    timelineBar: PARCOURS_TIMELINE_BAR,
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
    camera: parcoursCamera,
    infosValues: parcoursInfosValues,
    end: parcoursEnd,
    restState: parcoursRestState,
    refreshRest: () => {},
    applySelection: () => {},
    maxEventsInWindow: maxStopsInWindow,
    renderPopup: renderParcoursPopup,
});

// --- Caméra de la lecture --------------------------------------------------------

function cameraFollowing() {
    return clock.running && playback.camera === CAMERA_FOLLOW && !cameraSuspended && !!timeline;
}

function beginCamera() {
    const view = pkg.getMap?.()?.getView();
    savedView = view ? { center: view.getCenter(), resolution: view.getResolution() } : null;
    cameraSuspended = false;
    prefetchBucket = null;
}

// Fin de lecture : la vue d'avant, sauf si l'utilisateur a repris la main.
function endCamera() {
    const view = pkg.getMap?.()?.getView();
    if (view && savedView && playback.camera === CAMERA_FOLLOW && !cameraSuspended) {
        view.setCenter(savedView.center);
        view.setResolution(savedView.resolution);
    }
    savedView = null;
}

// Carte déplacée ou zoomée à la main pendant la lecture : la caméra la laisse.
// Pendant une capture en revanche, un geste parasite ne doit pas figer la
// caméra pour tout le reste de la vidéo — la pose est reposée à l'image
// suivante, la suspension serait silencieuse et définitive.
function bindCameraSuspension(map) {
    if (cameraBound) return;
    cameraBound = true;
    const suspend = () => {
        if (pkg.isRecordingActive?.()) return;
        if (clock.running && playback.camera === CAMERA_FOLLOW) cameraSuspended = true;
    };
    map.on('pointerdrag', suspend);
    map.getViewport().addEventListener('wheel', suspend, { passive: true });
}

// Appelée par mapgl.js avant chaque rendu (updatePointAppearClock). La pose
// posée en pré-rendu s'applique à l'image suivante : en capture image par
// image, `leadMs` (une image) la fait tomber sur la bonne.
function parcoursCamera(leadMs = 0, msPerDay = 1) {
    if (!cameraFollowing()) return false;
    const map = pkg.getMap?.();
    const size = map?.getSize();
    const q = currentQ + Math.max(0, Number(leadMs) || 0) / Math.max(1e-3, Number(msPerDay) || 1);
    const pose = cameraPoseAt(timeline, q, size);
    if (!pose) return false;
    const view = map.getView();
    const center = view.getCenter();
    const moved = !center || center[0] !== pose.center[0] || center[1] !== pose.center[1]
        || view.getResolution() !== pose.resolution;
    if (moved) {
        view.setCenter(pose.center);
        view.setResolution(pose.resolution);
    }
    // Tuiles de la suite chargées d'avance (une demande par seconde d'écran).
    const bucket = Math.floor(q / 10);
    if (bucket !== prefetchBucket) {
        prefetchBucket = bucket;
        const ahead = cameraPoseAt(timeline, q + 15, size);
        if (ahead) pkg.prefetchBasemapTiles?.(ahead.center, ahead.zoom);
    }
    return moved;
}

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
    bindCameraSuspension(map);
    syncRouteAttribution();
}

// Trait parcouru : trajets terminés, puis la part faite du trajet en cours.
// La nuit (d'une journée à la suivante) en pointillés.
//
// Les trajets terminés sont regroupés par style en trois MultiLineString
// persistants, allongés à mesure que la lecture avance : une géométrie par
// style à l'image au lieu d'une LineString par trajet (des centaines de
// trajets routés recréés à chaque image sinon).
let trailGroups = null;
const currentLegGeom = new ol.geom.LineString([]);

function doneTrailGroups(done) {
    if (!trailGroups || trailGroups.timeline !== timeline || trailGroups.dashed !== playback.estimated_dashed) {
        trailGroups = {
            timeline,
            dashed: playback.estimated_dashed,
            done: 0,
            night: { coords: [], geom: new ol.geom.MultiLineString([]) },
            estimated: { coords: [], geom: new ol.geom.MultiLineString([]) },
            day: { coords: [], geom: new ol.geom.MultiLineString([]) },
        };
    }
    // Retour en arrière dans la lecture : tout se refait depuis le début.
    if (done < trailGroups.done) {
        trailGroups.done = 0;
        for (const g of [trailGroups.night, trailGroups.estimated, trailGroups.day]) {
            g.coords.length = 0;
            g.geom.setCoordinates(g.coords);
        }
    }
    for (let k = trailGroups.done; k < done; k++) {
        const leg = timeline.legs[k];
        // Trajet sur une trace GPS ou un itinéraire : le vrai chemin, sinon
        // la ligne droite.
        const coords = legProjected[k] || [projected[leg.from], projected[leg.to]];
        const g = leg.night ? trailGroups.night
            : (trailGroups.dashed && !leg.path ? trailGroups.estimated : trailGroups.day);
        g.coords.push(coords);
        g.geom.setCoordinates(g.coords);
    }
    trailGroups.done = done;
    return trailGroups;
}

function drawPlayTrail(event) {
    if (!clock.running || !timeline) return;
    const context = ol.render.getVectorContext(event);
    const { color, width } = trailOptions();
    const day = new ol.style.Style({ stroke: new ol.style.Stroke({ color, width, lineCap: 'round', lineJoin: 'round' }) });
    const night = new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: Math.max(1, width * 0.6), lineDash: [width * 2, width * 2] }) });
    // Option : un trajet estimé (ligne droite, sans trace ni itinéraire) en
    // pointillés, pour le distinguer d'un chemin réel.
    const estimated = new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width, lineCap: 'round', lineJoin: 'round', lineDash: [width * 2.5, width * 2] }),
    });
    const { done, current } = trailAt(timeline, currentQ);
    const groups = doneTrailGroups(done);
    for (const [style, g] of [[night, groups.night], [estimated, groups.estimated], [day, groups.day]]) {
        if (g.coords.length) {
            context.setStyle(style);
            context.drawGeometry(g.geom);
        }
    }
    if (current) {
        const leg = timeline.legs[current.leg];
        const coords = current.progress >= 1
            ? (legProjected[current.leg] || [projected[leg.from], projected[leg.to]])
            : legPoints(timeline, current.leg, current.progress).map((p) => ol.proj.fromLonLat(p));
        context.setStyle(leg.night ? night : (playback.estimated_dashed && !leg.path ? estimated : day));
        currentLegGeom.setCoordinates(coords);
        context.drawGeometry(currentLegGeom);
    }
}

// La nuit (assombrissement), les bases (toujours) et les lieux déjà
// atteints, le géocacheur, puis la carte postale, le carton du jour et les
// crédits des itinéraires (vidéo).
function drawPlayHead(event) {
    if (!clock.running || !timeline) return;
    const head = headAt(timeline, currentQ);
    if (!head) return;
    const ctx = event.context;
    const ratio = event.frameState.pixelRatio || 1;
    const level = playback.day_cards ? nightLevelAt(timeline, currentQ) : 0;
    if (level > 0) {
        ctx.save();
        ctx.fillStyle = `rgba(10, 16, 38, ${(NIGHT_ALPHA * level).toFixed(3)})`;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
    }
    const context = ol.render.getVectorContext(event);
    timeline.stops.forEach((stop, i) => {
        if (stop.kind === KIND_BASE || (stop.kind === KIND_PLACE && stop.q <= currentQ)) {
            context.setStyle(placeStyle(stop.kind));
            context.drawGeometry(new ol.geom.Point(projected[i]));
        }
    });
    const { color } = trailOptions();
    const position = ol.proj.fromLonLat([head.lon, head.lat]);
    const glyph = playback.head === HEAD_PICTOGRAM ? headGlyph(headModeAt(timeline, currentQ)) : null;
    if (glyph) {
        const m = composeTransform(event.inversePixelTransform, event.frameState.coordinateToPixelTransform);
        const x = m[0] * position[0] + m[2] * position[1] + m[4];
        const y = m[1] * position[0] + m[3] * position[1] + m[5];
        drawHeadPictogram(ctx, x, y, ratio, color, glyph);
    } else {
        context.setStyle(new ol.style.Style({
            image: new ol.style.Circle({
                radius: 7,
                fill: new ol.style.Fill({ color }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
            }),
        }));
        context.drawGeometry(new ol.geom.Point(position));
    }
    // Après le géocacheur : la carte postale passe au-dessus.
    drawPhotoCards(event);
    drawDayCard(ctx, ratio);
    drawRouteCredits(ctx, ratio);
}

const NIGHT_ALPHA = 0.5;

// Pictogrammes de la tête : glyphes de Tabler Icons lus dans la feuille de
// style (le sous-ensemble ne garde que les icônes citées dans le code).
const HEAD_ICON_CLASSES = Object.freeze({
    walk: 'ti-walk',
    bike: 'ti-bike',
    car: 'ti-car',
    plane: 'ti-plane',
    night: 'ti-moon',
});
let headGlyphs = null;

function headGlyph(mode) {
    if (!document.fonts?.check?.('16px "tabler-icons"')) return null;
    if (!headGlyphs) {
        headGlyphs = {};
        for (const [key, className] of Object.entries(HEAD_ICON_CLASSES)) {
            const probe = document.createElement('i');
            probe.className = `ti ${className}`;
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            document.body.appendChild(probe);
            const content = getComputedStyle(probe, '::before').content || '';
            probe.remove();
            const match = /^["'](.+)["']$/.exec(content);
            if (match) headGlyphs[key] = match[1];
        }
    }
    return headGlyphs[mode] || null;
}

function drawHeadPictogram(ctx, x, y, ratio, color, glyph) {
    const radius = 14 * ratio;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6 * ratio;
    ctx.shadowOffsetY = 1.5 * ratio;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2.5 * ratio;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.font = `${Math.round(17 * ratio)}px "tabler-icons"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(glyph, x, y + 0.5 * ratio);
    ctx.restore();
}

let pageFont = null;
function pageFontFamily() {
    if (!pageFont) pageFont = getComputedStyle(document.body).fontFamily || 'sans-serif';
    return pageFont;
}

// Carton « Jour 2 · dimanche 13 juillet 2025 » d'un parcours de plusieurs
// journées, au tiers haut de la carte.
function dayCardText(dayIndex) {
    const day = timeline?.days?.[dayIndex];
    if (!day) return null;
    return { title: t('Jour ${n}', { n: day.dayNumber }), subtitle: formatDay(day.date) };
}

function drawDayCard(ctx, ratio) {
    const card = playback.day_cards ? dayCardAt(timeline, currentQ) : null;
    const text = card && card.alpha > 0 ? dayCardText(card.day) : null;
    if (!text) return;
    const font = pageFontFamily();
    const titleSize = 30 * ratio;
    const subtitleSize = 17 * ratio;
    const gap = 8 * ratio;
    const padX = 28 * ratio;
    const padY = 18 * ratio;
    ctx.save();
    ctx.globalAlpha = card.alpha;
    ctx.font = `700 ${titleSize}px ${font}`;
    const titleW = ctx.measureText(text.title).width;
    ctx.font = `400 ${subtitleSize}px ${font}`;
    const subtitleW = ctx.measureText(text.subtitle).width;
    const boxW = Math.max(titleW, subtitleW) + padX * 2;
    const boxH = titleSize + gap + subtitleSize + padY * 2;
    const cx = ctx.canvas.width / 2;
    const top = ctx.canvas.height * 0.36 - boxH / 2;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - boxW / 2, top, boxW, boxH, 14 * ratio);
    else ctx.rect(cx - boxW / 2, top, boxW, boxH);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${titleSize}px ${font}`;
    ctx.fillText(text.title, cx, top + padY);
    ctx.font = `400 ${subtitleSize}px ${font}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(text.subtitle, cx, top + padY + titleSize + gap);
    ctx.restore();
}

// Crédits des itinéraires (CGU des fournisseurs) : à l'écran, dans
// l'attribution de la carte ; dans la vidéo, peints en bas à droite (la vidéo
// ne compose que les canevas de la carte).
function routeCreditText() {
    if (!routingConfig().enabled || routeEffectsNow.paths.size === 0) return '';
    return routingConfig().provider === 'ors'
        ? t('Itinéraires © contributeurs OpenStreetMap, openrouteservice')
        : t('Itinéraires © contributeurs OpenStreetMap, FOSSGIS');
}

function syncRouteAttribution() {
    const text = routeCreditText() || null;
    for (const layer of [parcoursLayer, playTrailLayer]) {
        const source = layer?.getSource();
        if (source && (source.get('routeCredit') ?? null) !== text) {
            source.set('routeCredit', text);
            source.setAttributions(text);
        }
    }
}

function drawRouteCredits(ctx, ratio) {
    if (!pkg.isRecordingActive?.()) return;
    const text = routeCreditText();
    if (!text) return;
    ctx.save();
    ctx.font = `${Math.round(11 * ratio)}px ${pageFontFamily()}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * ratio;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    const x = ctx.canvas.width - 8 * ratio;
    const y = ctx.canvas.height - 6 * ratio;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText(text, x, y);
    ctx.restore();
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
    // saveSettingsPatch remplace la clé entière dans window.userSettings par le
    // patch envoyé : la valeur complète y est remise une fois l'écriture faite.
    const save = (patch) => {
        playback = normalizePlayback({ ...playback, ...patch });
        const full = { ...playback };
        saveSettingsPatch({ parcours_playback: patch }).then(() => {
            if (window.userSettings) window.userSettings.parcours_playback = full;
        });
        if (window.userSettings) window.userSettings.parcours_playback = full;
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
        pkg.refreshTimelineBar?.();
    });
    // Lot 7 : lus à chaque image, ils s'appliquent aussi en pleine lecture.
    const camera = el('parcoursCamera');
    const head = el('parcoursHead');
    const dayCards = el('parcoursDayCards');
    const dashed = el('parcoursEstimatedDashed');
    if (camera) camera.value = playback.camera;
    if (head) head.value = playback.head;
    if (dayCards) dayCards.checked = playback.day_cards;
    if (dashed) dashed.checked = playback.estimated_dashed;
    const redraw = () => pkg.getMap?.()?.render();
    camera?.addEventListener('change', () => {
        save({ camera: camera.value });
        cameraSuspended = false;
        redraw();
    });
    head?.addEventListener('change', () => {
        save({ head: head.value });
        redraw();
    });
    dayCards?.addEventListener('change', () => {
        save({ day_cards: dayCards.checked });
        redraw();
    });
    dashed?.addEventListener('change', () => {
        save({ estimated_dashed: dashed.checked });
        redraw();
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

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn btn-sm btn-ghost-secondary parcours-edit';
        edit.setAttribute('aria-label', t('Modifier le parcours'));
        edit.title = t('Modifier le parcours');
        edit.innerHTML = '<i class="ti ti-pencil" aria-hidden="true"></i>';
        edit.addEventListener('click', () => startEditParcours(item));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-ghost-danger parcours-delete';
        remove.setAttribute('aria-label', t('Supprimer le parcours'));
        remove.title = t('Supprimer le parcours');
        remove.innerHTML = '<i class="ti ti-trash" aria-hidden="true"></i>';
        remove.addEventListener('click', () => confirmDelete(item));

        row.append(open, edit, remove);
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

// --- Création et modification ------------------------------------------------------

// Le formulaire sert aux deux : le crayon d'un parcours le remplit et son
// envoi devient un PATCH — modifier ne perd ni ajustements, ni photos, ni
// traces (contrairement à supprimer puis recréer).
let editingParcoursId = null;

function startEditParcours(item) {
    editingParcoursId = item.id;
    el('parcoursName').value = item.name;
    el('parcoursStart').value = item.date_start;
    el('parcoursEnd').value = item.date_end;
    el('parcoursIncludeLabs').checked = item.include_labs !== false;
    el('parcoursIncludeDnf').checked = item.include_dnf !== false;
    updateRangeHint();
    syncParcoursForm();
    el('parcoursName')?.focus();
}

function cancelEditParcours() {
    if (editingParcoursId === null) return;
    editingParcoursId = null;
    syncParcoursForm();
}

// Libellés du formulaire selon le mode : création ou modification.
function syncParcoursForm() {
    const editing = editingParcoursId !== null;
    const title = el('parcoursFormTitle');
    if (title) title.textContent = editing ? t('Modifier le parcours') : t('Nouveau parcours');
    const submit = el('btnParcoursCreate');
    if (submit) {
        submit.innerHTML = `<i class="ti ${editing ? 'ti-check' : 'ti-plus'} me-1" aria-hidden="true"></i>`
            + (editing ? t('Enregistrer') : t('Créer le parcours'));
    }
    const cancel = el('btnParcoursEditCancel');
    if (cancel) cancel.hidden = !editing;
}

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
    el('btnParcoursEditCancel')?.addEventListener('click', cancelEditParcours);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = el('btnParcoursCreate');
        if (submit) submit.disabled = true;
        const payload = {
            name: el('parcoursName')?.value || '',
            date_start: start?.value || '',
            date_end: end?.value || '',
            include_labs: el('parcoursIncludeLabs')?.checked !== false,
            include_dnf: el('parcoursIncludeDnf')?.checked !== false,
        };
        try {
            if (editingParcoursId !== null) {
                const id = editingParcoursId;
                const body = await fetchJson(`/api/parcours/${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                });
                cancelEditParcours();
                // Rechargement complet : dates, Labs et DNF changent les
                // entrées du parcours.
                await refreshParcoursList({ select: body.parcours.id });
            } else {
                const body = await fetchJson('/api/parcours', {
                    method: 'POST',
                    body: JSON.stringify(payload),
                });
                el('parcoursName').value = '';
                await refreshParcoursList({ select: body.parcours.id });
            }
        } catch (error) {
            showToast(error.message, 'error');
        } finally {
            if (submit) submit.disabled = false;
        }
    });
}

// --- Parcours suggérés (lot 7) -----------------------------------------------------

// Séjours loin de chez soi et grosses journées (parcours_suggest.py), hors
// plages déjà enregistrées. Un clic remplit le formulaire de création.
async function loadSuggestions() {
    const seq = ++suggestionsSeq;
    let next = [];
    try {
        const body = await fetchJson('/api/parcours/suggestions');
        next = Array.isArray(body.suggestions) ? body.suggestions : [];
    } catch (error) {
        console.warn('[PARCOURS] Suggestions indisponibles :', error);
    }
    if (seq !== suggestionsSeq) return;
    suggestions = next;
    renderSuggestions();
}

function suggestionName(item) {
    const range = formatRange(item.start, item.end);
    const name = item.place ? `${item.place}, ${range}` : range;
    return name.slice(0, 80);
}

function renderSuggestions() {
    const box = el('parcoursSuggestions');
    const list = el('parcoursSuggestionList');
    if (!box || !list) return;
    box.hidden = suggestions.length === 0;
    list.replaceChildren(...suggestions.map((item) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'btn btn-sm btn-outline-secondary parcours-suggestion';
        chip.dataset.start = item.start;
        chip.dataset.end = item.end;
        const icon = document.createElement('i');
        icon.className = `ti ${item.kind === 'trip' ? 'ti-plane' : 'ti-walk'} me-1`;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = suggestionName(item);
        const detail = document.createElement('span');
        detail.className = 'text-muted ms-1';
        const finds = t('${n} trouvailles', { n: item.finds });
        detail.textContent = `· ${finds}`;
        chip.append(icon, label, detail);
        chip.addEventListener('click', () => applySuggestion(item));
        return chip;
    }));
}

function applySuggestion(item) {
    // Une suggestion remplit le formulaire de création, pas une modification.
    cancelEditParcours();
    const name = el('parcoursName');
    const start = el('parcoursStart');
    const end = el('parcoursEnd');
    if (name) name.value = suggestionName(item);
    if (start) start.value = item.start;
    if (end) end.value = item.end;
    updateRangeHint();
    el('btnParcoursCreate')?.focus();
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
        case REASON_TRACK: return t('heure de la trace');
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
    if (d.clockBacktrack) parts.push(t('ordre contraire aux heures sûres : l’heure recule'));
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

// Repère ce qui avait le focus avant la reconstruction de la liste : la
// ligne (étape ou panneau d'ajustement) et le contrôle qui le portait —
// après « Monter », le bouton de l'étape déplacée le récupère.
const FOCUSABLE_CLASSES = [
    'parcours-stop-up', 'parcours-stop-down', 'parcours-stop-text', 'parcours-stop-restore',
    'parcours-edit-time', 'parcours-edit-pin', 'parcours-edit-unpin', 'parcours-edit-leg',
    'parcours-edit-day', 'parcours-edit-exclude', 'parcours-edit-delete-place',
    'parcours-edit-place-name', 'parcours-edit-place-rename', 'parcours-edit-place-kind',
    'parcours-edit-place-day', 'parcours-edit-place-move', 'parcours-edit-locate',
];

function focusMarkerOf(el) {
    const row = el?.closest?.('[data-stop-key], [data-edit-key]');
    if (!row) return null;
    const key = row.dataset.stopKey || row.dataset.editKey;
    const cls = FOCUSABLE_CLASSES.find((c) => el.classList.contains(c));
    return cls ? { key, cls } : null;
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
    const focus = box.contains(document.activeElement) ? focusMarkerOf(document.activeElement) : null;
    box.replaceChildren(...ordered.days.map(renderDay));
    mapHoverRows = mapHoverRows.filter((row) => row.isConnected);
    if (focus) {
        const node = box.querySelector(
            `[data-stop-key="${focus.key}"] .${focus.cls}, [data-edit-key="${focus.key}"] .${focus.cls}`)
            || box.querySelector(`[data-stop-key="${focus.key}"] .parcours-stop-text`);
        node?.focus();
    }
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
    // Déposer sur la journée elle-même (jour vide ou creux de la liste) :
    // l'étape la rejoint à la fin ; sur sa propre journée, elle finit en
    // dernier. Une ligne sous la souris traite le dépôt et le stoppe.
    section.addEventListener('dragenter', () => {
        if (dragged) section.classList.add('is-drop-target');
    });
    section.addEventListener('dragleave', (event) => {
        if (!section.contains(event.relatedTarget)) section.classList.remove('is-drop-target');
    });
    section.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    });
    section.addEventListener('drop', (event) => {
        if (!dragged) return;
        event.preventDefault();
        section.classList.remove('is-drop-target');
        const { key, date } = dragged;
        dragged = null;
        if (date === day.date) {
            const keys = day.stops.filter((s) => s.kind !== KIND_BASE).map((s) => s.key);
            keys.push(...keys.splice(keys.indexOf(key), 1));
            reorderDay(keys);
        } else {
            moveStopToDay(day, key, Number.MAX_SAFE_INTEGER);
        }
    });
    return section;
}

function renderStopRow(stop, day, movable) {
    const item = document.createElement('li');
    item.className = 'parcours-stop d-flex align-items-start gap-2 py-1';
    item.dataset.stopKey = stop.key;
    item.dataset.kind = stop.kind;
    item.dataset.confidence = stop.confidence;
    item.dataset.reason = stop.reason;
    if (stop.placeId != null) item.dataset.placeId = stop.placeId;
    // Survol ou focus clavier : le point correspondant du plan s'entoure
    // d'un halo (lien liste ↔ carte).
    item.addEventListener('mouseenter', () => setHoveredStop(stop));
    item.addEventListener('mouseleave', () => setHoveredStop(null));
    item.addEventListener('focusin', () => setHoveredStop(stop));
    item.addEventListener('focusout', (event) => {
        if (!item.contains(event.relatedTarget)) setHoveredStop(null);
    });
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
            if (!dragged || dragged.key === stop.key) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        });
        item.addEventListener('drop', (event) => {
            if (!dragged) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = item.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            const { key, date } = dragged;
            dragged = null;
            if (date === day.date) {
                const keys = movable.map((s) => s.key).filter((k) => k !== key);
                keys.splice(keys.indexOf(stop.key) + (after ? 1 : 0), 0, key);
                reorderDay(keys);
            } else {
                // Autre journée : insérée au rang où elle est lâchée.
                moveStopToDay(day, key, movable.indexOf(stop) + (after ? 1 : 0));
            }
        });
    }
    return editKey === stop.key ? [item, renderEditPanel(stop, day)] : [item];
}

function renderExcludedRow(stop) {
    const item = document.createElement('li');
    item.className = 'parcours-stop is-excluded d-flex align-items-center gap-2 py-1';
    item.dataset.stopKey = stop.key;
    if (stop.placeId != null) item.dataset.placeId = stop.placeId;
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
    // Le halo suit le focus ou la souris jusque dans le panneau.
    panel.addEventListener('mouseenter', () => setHoveredStop(stop));
    panel.addEventListener('mouseleave', () => setHoveredStop(null));
    panel.addEventListener('focusin', () => setHoveredStop(stop));
    panel.addEventListener('focusout', (event) => {
        if (!panel.contains(event.relatedTarget)) setHoveredStop(null);
    });
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

    const next = day.stops[day.stops.indexOf(stop) + 1];
    if (next && stop.kind !== KIND_BASE) {
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const label = document.createElement('label');
        label.className = 'small';
        label.textContent = t('Trajet vers l’étape suivante');
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm w-auto parcours-edit-leg';
        label.htmlFor = select.id = `parcoursEditLeg-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const leg = day.legs.find((l) => l.from === stop.key);
        const auto = legModeFor(leg?.km ?? 0);
        const labels = { walk: t('à pied'), bike: t('à vélo'), car: t('en voiture'), straight: t('en ligne droite') };
        const options = [['', t('Automatique (${mode})', { mode: labels[auto] })],
            ['walk', labels.walk], ['bike', labels.bike], ['car', labels.car], ['straight', labels.straight]];
        for (const [value, text] of options) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            select.append(opt);
        }
        select.value = overrideOf(stop.key)?.legMode || '';
        select.addEventListener('change', () => saveOverrides([{ key: stop.key, legMode: select.value || null }]));
        row.append(label, select);
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

    if (place) {
        // Nom : enregistré à l'Entrée ou au bouton.
        const nameRow = document.createElement('div');
        nameRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const nameLabel = document.createElement('label');
        nameLabel.className = 'small';
        nameLabel.textContent = t('Nom');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 80;
        nameInput.className = 'form-control form-control-sm w-auto parcours-edit-place-name';
        nameInput.value = place.name || '';
        nameLabel.htmlFor = nameInput.id = `parcoursEditPlaceName-${place.id}`;
        const saveName = () => {
            const name = nameInput.value.trim();
            if (name !== (place.name || '')) updatePlace(place.id, { name });
        };
        nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveName(); });
        const rename = button('btn btn-sm btn-outline-primary parcours-edit-place-rename', 'ti-check',
            t('Renommer'), { text: t('Renommer') });
        rename.addEventListener('click', saveName);
        nameRow.append(nameLabel, nameInput, rename);
        panel.append(nameRow);

        // Type et journée : un lieu est rattaché à une journée, une base peut
        // valoir pour toutes.
        const metaRow = document.createElement('div');
        metaRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const kindLabel = document.createElement('label');
        kindLabel.className = 'small';
        kindLabel.textContent = t('Type');
        const kindSelect = document.createElement('select');
        kindSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-kind';
        kindLabel.htmlFor = kindSelect.id = `parcoursEditPlaceKind-${place.id}`;
        for (const [value, text] of [[KIND_PLACE, t('Lieu')], [KIND_BASE, t('Base')]]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            kindSelect.append(opt);
        }
        kindSelect.value = place.kind;
        kindSelect.addEventListener('change', () => {
            const patch = { kind: kindSelect.value };
            // Une base de toutes les journées n'a pas de date : un lieu en
            // exige une — celle du jour où elle s'affichait.
            if (patch.kind === KIND_PLACE && !place.date) patch.date = day.date;
            updatePlace(place.id, patch);
        });
        const dayLabel = document.createElement('label');
        dayLabel.className = 'small';
        dayLabel.textContent = t('Journée');
        const daySelect = document.createElement('select');
        daySelect.className = 'form-select form-select-sm w-auto parcours-edit-place-day';
        dayLabel.htmlFor = daySelect.id = `parcoursEditPlaceDay-${place.id}`;
        const all = document.createElement('option');
        all.value = '';
        all.textContent = t('Toutes les journées');
        all.disabled = place.kind !== KIND_BASE;
        all.hidden = place.kind !== KIND_BASE;
        daySelect.append(all);
        for (const option of ordered.days) {
            const opt = document.createElement('option');
            opt.value = option.date;
            opt.textContent = formatDay(option.date, { weekday: 'short', day: 'numeric', month: 'short' });
            daySelect.append(opt);
        }
        daySelect.value = place.date || '';
        daySelect.addEventListener('change', () => updatePlace(place.id, { date: daySelect.value || null }));
        metaRow.append(kindLabel, kindSelect, dayLabel, daySelect);
        panel.append(metaRow);
    }

    const actions = document.createElement('div');
    actions.className = 'd-flex gap-2 flex-wrap';
    const locate = button('btn btn-sm btn-outline-secondary parcours-edit-locate', 'ti-focus-2',
        t('Voir sur la carte'), { text: t('Voir sur la carte') });
    locate.addEventListener('click', () => {
        const map = pkg.getMap?.();
        if (!map) return;
        map.getView().animate({
            center: ol.proj.fromLonLat([stop.lon, stop.lat]),
            zoom: Math.max(map.getView().getZoom() || 0, 15),
            duration: 300,
        });
    });
    actions.append(locate);
    if (place) {
        const move = button('btn btn-sm btn-outline-secondary parcours-edit-place-move', 'ti-map-pin',
            t('Déplacer sur la carte'), { text: t('Déplacer sur la carte') });
        move.addEventListener('click', () => startPlaceMove(place));
        actions.append(move);
    }
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

// Reconstruction complète : ordre et heures, traces GPS (heures de passage,
// vrai chemin) et photos (rattachement, heures) comme ancres
// (parcours_tracks.mjs).
function rebuild() {
    let result = reconstructWithEvidence(inputs);
    routeRunsNow = [];
    routeEffectsNow = { hints: new Map(), paths: new Map(), missing: 0 };
    if (routingConfig().enabled) {
        // Itinéraires déjà connus : leurs durées entrent dans l'horaire, leurs
        // chemins dans le tracé. Les trajets sur une trace n'en ont pas besoin.
        const overrides = new Map((inputs?.overrides || []).map((o) => [o.key, o]));
        routeRunsNow = routeRuns(result.ordered, overrides, { skip: new Set(result.legPaths.keys()) });
        routeEffectsNow = routeEffects(routeRunsNow, routeCache);
        if (routeEffectsNow.hints.size > 0) {
            result = reconstructWithEvidence(inputs, null, { legHints: routeEffectsNow.hints });
        }
    }
    ordered = result.ordered;
    photoMatches = result.matches;
    photoByStop = result.byStop;
    trackMatches = result.trackMatches;
    // Trace GPS d'abord, itinéraire ensuite.
    legPaths = new Map([...routeEffectsNow.paths, ...result.legPaths]);
    utcOffset = result.utcOffset;
}

// Les ajustements renvoyés par le serveur remplacent ceux en mémoire, puis le
// parcours est reconstruit (pur, donc immédiat) et rejoué tel quel.
// `forId` : parcours à qui vient la réponse — arrivée après l'ouverture d'un
// autre parcours, elle est ignorée plutôt qu'appliquée à ses entrées.
function receiveAdjustments(payload, forId = selectedId) {
    if (!inputs || forId !== selectedId) return;
    // Des écritures d'ajustements locales sont en avance sur le serveur :
    // ne pas les écraser par une vue datée — le dernier envoi refera foi.
    if (Array.isArray(payload?.overrides) && overridesQueued === 0) inputs.overrides = payload.overrides;
    if (Array.isArray(payload?.places)) inputs.places = payload.places;
    if (Array.isArray(payload?.photos)) inputs.photos = payload.photos;
    if (Array.isArray(payload?.cameras)) inputs.cameras = payload.cameras;
    if (Array.isArray(payload?.tracks)) inputs.tracks = payload.tracks;
    rebuild();
    renderStops();
    applyTimeline();
    adjustmentRevision++;
}

// Écritures d'ajustements mises en file : elles partent dans l'ordre des
// gestes. La fusion locale fait qu'un second clic (descendre deux fois de
// suite, par exemple) compose sur l'état à jour au lieu de repartir de
// l'état d'avant le premier — sans elle, les deux envois porteraient le
// même déplacement et l'un serait perdu.
let overridesChain = Promise.resolve();
let overridesQueued = 0;

// Fusion identique au serveur (parcours_store.patch_overrides) : champ
// présent → remplacé (null l'efface), absent → gardé ; ligne vidée → retirée.
function mergeOverrides(patches) {
    const rows = new Map((inputs.overrides || []).map((o) => [o.key, { ...o }]));
    for (const patch of patches) {
        const row = rows.get(patch.key) || {
            key: patch.key, rank: null, pinnedTime: null, day: null, excluded: false, legMode: null,
        };
        for (const field of ['rank', 'pinnedTime', 'day', 'excluded', 'legMode']) {
            if (field in patch) row[field] = patch[field];
        }
        if (row.rank === null && row.pinnedTime === null && row.day === null && !row.excluded && row.legMode === null) {
            rows.delete(patch.key);
        } else {
            rows.set(patch.key, row);
        }
    }
    inputs.overrides = [...rows.values()];
}

function saveOverrides(patches) {
    if (!selectedId || adjustmentsLocked() || !inputs) return;
    const pid = selectedId;
    mergeOverrides(patches);
    rebuild();
    renderStops();
    applyTimeline();
    overridesQueued++;
    overridesChain = overridesChain.then(async () => {
        overridesQueued--;
        try {
            const payload = await fetchJson(`/api/parcours/${pid}/overrides`, {
                method: 'PATCH',
                body: JSON.stringify({ overrides: patches }),
            });
            // Une écriture plus récente attend encore : l'état local la
            // précède déjà, et le serveur renvoie toujours l'ensemble — la
            // réponse du dernier envoi refera foi.
            if (overridesQueued === 0) receiveAdjustments(payload, pid);
        } catch (error) {
            showToast(error.message, 'error');
            // Resynchronisation une fois la file écoulée.
            overridesChain = overridesChain.then(() => reloadAdjustments(pid));
        }
    });
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

// Déplacer une étape vers une autre journée, au rang où elle est lâchée :
// sa clé rejoint les rangs de la journée cible ; revenue à sa journée
// d'origine, l'ajustement « journée » disparaît (comme le panneau).
function moveStopToDay(day, key, index) {
    const sourceDay = ordered?.days.find((d) => d.stops.some((s) => s.key === key));
    const source = sourceDay?.stops.find((s) => s.key === key);
    const original = source?.movedFrom || sourceDay?.date;
    const keys = day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => stop.key);
    keys.splice(Math.min(index, keys.length), 0, key);
    saveOverrides(keys.map((k, rank) => (k === key
        ? { key: k, day: day.date === original ? null : day.date, rank }
        : { key: k, rank })));
}

function resetDayOrder(day) {
    saveOverrides(day.stops.filter((stop) => stop.kind !== KIND_BASE).map((stop) => ({ key: stop.key, rank: null })));
}

function resetAllAdjustments() {
    if (!selectedId || adjustmentsLocked() || !inputs) return;
    const pid = selectedId;
    // Même file que les PATCH : un déplacement encore en vol doit être
    // écrit AVANT la remise à zéro, sinon il ressusciterait ses ajustements.
    inputs.overrides = [];
    rebuild();
    renderStops();
    applyTimeline();
    overridesQueued++;
    overridesChain = overridesChain.then(async () => {
        overridesQueued--;
        try {
            const payload = await fetchJson(`/api/parcours/${pid}/overrides`, { method: 'DELETE' });
            if (overridesQueued === 0) receiveAdjustments(payload, pid);
        } catch (error) {
            showToast(error.message, 'error');
            overridesChain = overridesChain.then(() => reloadAdjustments(pid));
        }
    });
}

async function reloadAdjustments(forId = selectedId) {
    // Le parcours a changé pendant la requête : rien à appliquer.
    if (forId !== selectedId) return;
    const fresh = await fetchJson(`/api/parcours/${forId}/inputs`);
    receiveAdjustments({
        overrides: fresh.overrides, places: fresh.places, photos: fresh.photos, cameras: fresh.cameras, tracks: fresh.tracks,
    }, forId);
}

async function createPlace(data) {
    if (!selectedId || adjustmentsLocked()) return false;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/places`, { method: 'POST', body: JSON.stringify(data) });
        await reloadAdjustments(pid);
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

async function updatePlace(id, data) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/places/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
        await reloadAdjustments(pid);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deletePlace(id) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/places/${id}`, { method: 'DELETE' });
        await reloadAdjustments(pid);
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
        clickMutedUntil = performance.now() + 400;
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
    placeMoveId = null;
    if (pickListener) {
        ol.Observable.unByKey(pickListener);
        pickListener = null;
    }
    stopPicking();
}

// Déplacer un lieu ou une base posée : même mécanique que la pose d'un
// lieu — un clic sur la carte envoie les nouvelles coordonnées.
let placeMoveId = null;

function startPlaceMove(place) {
    if (!ordered || adjustmentsLocked()) return;
    const map = pkg.getMap?.();
    if (!map) return;
    cancelPlacePicking();
    picking = true;
    placeMoveId = place.id;
    map.getTargetElement()?.classList.add('parcours-picking');
    const hint = el('parcoursPlaceHint');
    if (hint) hint.hidden = false;
    pickListener = map.once('singleclick', (event) => {
        pickListener = null;
        clickMutedUntil = performance.now() + 400;
        stopPicking();
        const id = placeMoveId;
        placeMoveId = null;
        const [lon, lat] = ol.proj.toLonLat(event.coordinate);
        updatePlace(id, { lat, lon });
    });
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
const photoThumbs = new Map();   // id → HTMLImageElement (vignettes laissées sur la carte)
let photoDetailId = null;        // photo dont le panneau est ouvert

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
// qu'une fois l'image décodée. Les miniatures servent aux vignettes laissées
// sur la carte : des dizaines à chaque image, réduites depuis 320 px plutôt
// que depuis la photo entière.
function preloadPhotos() {
    const wanted = new Set();
    for (const ids of photoByStop.values()) for (const id of ids) wanted.add(id);
    for (const id of wanted) {
        const photo = photoById(id);
        if (!photo) continue;
        for (const [cache, thumb] of [[photoImages, false], [photoThumbs, true]]) {
            if (cache.has(id)) continue;
            const img = new Image();
            img.decoding = 'async';
            img.src = photoUrl(photo, thumb);
            cache.set(id, img);
        }
    }
}

const imageReady = (img) => !!img?.complete && img.naturalWidth > 0;

// Photos de la lecture (lot 9) : mises en page à `currentQ` selon les
// réglages (parcours_photo_layout.mjs), peintes dans le canevas de la couche
// de la tête (parcours_photo_draw.mjs), donc filmées. Une photo encore en
// chargement n'est pas dessinée.
let lastPhotoCards = [];          // cartes peintes à la dernière image (relevé e2e)
let lastPhotoView = null;         // taille du canevas de cette image

function photoLayoutView(event) {
    const frameState = event.frameState;
    const m = composeTransform(event.inversePixelTransform, frameState.coordinateToPixelTransform);
    const canvas = event.context.canvas;
    return {
        width: canvas.width,
        height: canvas.height,
        ratio: frameState.pixelRatio || 1,
        stopPixel: (i) => {
            const [px, py] = projected[i] || [];
            return Number.isFinite(px) ? [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]] : null;
        },
        aspectOf: (id) => photoAspect(photoById(id)),
        captionOf: photoCaptionFor,
    };
}

// Légende d'une photo selon le gabarit des réglages. L'heure est celle de
// la photo quand elle est de confiance (téléphone, appareil recalé), sinon
// celle de l'étape — dans le format choisi pour {heure}.
function photoCaptionFor(slot) {
    if (!photoDisplay.caption || !timeline) return '';
    const photo = photoById(slot.photoId);
    const stop = timeline.stops[slot.stop];
    const day = timeline.days[stop?.day];
    const offsets = cameraOffsets(inputs?.cameras);
    const clockValue = photo && photoTimeTrusted(photo, offsets) ? photoClock(photo, offsets) : null;
    const heure = clockValue
        ? formatClock(clockValue.minutes, false, playback.hours, slotLabels())
        : formatClock(stop?.arrivalMin, stop?.confidence !== CONFIDENCE_ANCHORED, playback.hours, slotLabels());
    return photoCaptionText(photoDisplay.caption, {
        legende: photo?.caption || '',
        etape: stop ? stopLabel(stop) : '',
        heure,
        jour: day ? String(day.dayNumber) : '',
        date: day ? formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '',
    });
}

function drawPhotoCards(event) {
    lastPhotoCards = [];
    if (!timeline) return;
    const view = photoLayoutView(event);
    lastPhotoView = { width: view.width, height: view.height, ratio: view.ratio };
    const { cards } = photoFrameAt(timeline, currentQ, photoDisplay, view);
    const ctx = event.context;
    const font = pageFontFamily();
    for (const card of cards) {
        const thumb = card.pinned ? photoThumbs.get(card.photoId) : null;
        const img = imageReady(thumb) ? thumb : photoImages.get(card.photoId);
        if (!imageReady(img)) continue;
        drawPhotoLeader(ctx, card, view.ratio);
        drawPhotoCard(ctx, card, img, photoById(card.photoId), { font, ratio: view.ratio });
        lastPhotoCards.push(card);
    }
}

// Aperçu en pause calé sur une photo : la lecture s'ouvre en pause (si elle
// ne tourne pas) et saute au milieu du premier temps de la photo.
function previewPhoto(photoId) {
    if (!timeline) return false;
    const slot = photoSlots(timeline).find((s) => s.photoId === photoId);
    if (!slot) return false;
    if (pkg.previewPlaybackState?.() === 'idle' && !pkg.startPausedPreview?.()) return false;
    if (pkg.previewPlaybackState?.() !== 'paused') return false;
    const q = Math.floor(slot.fromQ + Math.min(5, (slot.toQ - slot.fromQ) / 2));
    return pkg.seekAnimationToDate?.(dateOfDayIndex(quantumBase, q)) !== false;
}

// --- Réglages d'affichage des photos (lot 9) ---------------------------------------

const PHOTO_DISPLAY_FIELDS = Object.freeze({
    layout: 'parcoursPhotoLayout',
    side: 'parcoursPhotoSide',
    anchor: 'parcoursPhotoAnchor',
    strip_edge: 'parcoursPhotoStripEdge',
    frame: 'parcoursPhotoFrame',
    effect: 'parcoursPhotoEffect',
});
const PHOTO_DISPLAY_FLAGS = Object.freeze({
    leader: 'parcoursPhotoLeader',
    strip_reset: 'parcoursPhotoStripReset',
    stack: 'parcoursPhotoStack',
    pin: 'parcoursPhotoPin',
    tilt: 'parcoursPhotoTilt',
    ken_burns: 'parcoursPhotoKenBurns',
});

function renderPhotoDisplay() {
    for (const [key, id] of Object.entries(PHOTO_DISPLAY_FIELDS)) {
        const field = el(id);
        if (field) field.value = photoDisplay[key];
    }
    for (const [key, id] of Object.entries(PHOTO_DISPLAY_FLAGS)) {
        const field = el(id);
        if (field) field.checked = photoDisplay[key];
    }
    const size = el('parcoursPhotoSize');
    if (size) size.value = String(photoDisplay.size);
    const sizeValue = el('parcoursPhotoSizeValue');
    if (sizeValue) sizeValue.textContent = `${photoDisplay.size} px`;
    const pinSize = el('parcoursPhotoPinSize');
    if (pinSize) pinSize.value = String(photoDisplay.pin_size);
    const pinSizeValue = el('parcoursPhotoPinSizeValue');
    if (pinSizeValue) pinSizeValue.textContent = `${photoDisplay.pin_size} px`;
    const duration = el('parcoursPhotoDuration');
    if (duration && document.activeElement !== duration) duration.value = String(photoDisplay.duration);
    const max = el('parcoursPhotoMaxPerStop');
    if (max && document.activeElement !== max) max.value = String(photoDisplay.max_per_stop);
    const caption = el('parcoursPhotoCaptionTemplate');
    if (caption && document.activeElement !== caption) caption.value = photoDisplay.caption;
    // Réglages propres à chaque placement.
    const layout = photoDisplay.layout;
    const show = (id, visible) => {
        const row = el(id);
        if (row) row.hidden = !visible;
    };
    show('parcoursPhotoSideRow', layout === 'stop');
    show('parcoursPhotoAnchorRow', layout === 'fixed');
    show('parcoursPhotoStripEdgeRow', layout === 'strip');
    show('parcoursPhotoStripResetRow', layout === 'strip');
    show('parcoursPhotoLeaderRow', layout === 'stop' || layout === 'fixed');
    show('parcoursPhotoStackRow', layout === 'stop' || layout === 'fixed');
    show('parcoursPhotoPinRow', layout === 'stop' || layout === 'fixed');
    show('parcoursPhotoPinSizeRow', (layout === 'stop' || layout === 'fixed') && photoDisplay.pin);
    const fields = el('parcoursPhotoDisplayFields');
    if (fields) fields.disabled = layout === PHOTO_LAYOUT_NONE;
    const preview = el('btnParcoursPhotoPreview');
    if (preview) preview.disabled = layout === PHOTO_LAYOUT_NONE || !timeline || photoSlots(timeline).length === 0;
}

function bindPhotoDisplay() {
    renderPhotoDisplay();
    // Valeur complète envoyée (comme parcours_playback, cf. bindPlayback) ;
    // la durée, le plafond et « aucune photo » changent la chronologie.
    const save = (patch) => {
        const before = photoDisplay;
        photoDisplay = normalizePhotoDisplay({ ...photoDisplay, ...patch });
        const full = { ...photoDisplay };
        saveSettingsPatch({ parcours_photo_display: full }).then(() => {
            if (window.userSettings) window.userSettings.parcours_photo_display = full;
        });
        if (window.userSettings) window.userSettings.parcours_photo_display = full;
        renderPhotoDisplay();
        const timing = before.duration !== photoDisplay.duration
            || before.max_per_stop !== photoDisplay.max_per_stop
            || (before.layout === PHOTO_LAYOUT_NONE) !== (photoDisplay.layout === PHOTO_LAYOUT_NONE);
        if (timing) {
            if (clock.running) {
                pendingTimeline = true;
                showToast(t("Le réglage s'appliquera à la fin de l'animation."), 'info', t('Parcours'));
            } else {
                applyTimeline();
            }
        }
        pkg.getMap?.()?.render();
    };
    for (const [key, id] of Object.entries(PHOTO_DISPLAY_FIELDS)) {
        el(id)?.addEventListener('change', (event) => save({ [key]: event.target.value }));
    }
    for (const [key, id] of Object.entries(PHOTO_DISPLAY_FLAGS)) {
        el(id)?.addEventListener('change', (event) => save({ [key]: event.target.checked }));
    }
    const size = el('parcoursPhotoSize');
    size?.addEventListener('input', () => {
        // Glisser : aperçu immédiat, enregistré au relâchement.
        photoDisplay = normalizePhotoDisplay({ ...photoDisplay, size: Number(size.value) });
        const sizeValue = el('parcoursPhotoSizeValue');
        if (sizeValue) sizeValue.textContent = `${photoDisplay.size} px`;
        pkg.getMap?.()?.render();
    });
    size?.addEventListener('change', () => save({ size: Number(size.value) }));
    const pinSize = el('parcoursPhotoPinSize');
    pinSize?.addEventListener('input', () => {
        photoDisplay = normalizePhotoDisplay({ ...photoDisplay, pin_size: Number(pinSize.value) });
        const value = el('parcoursPhotoPinSizeValue');
        if (value) value.textContent = `${photoDisplay.pin_size} px`;
        pkg.getMap?.()?.render();
    });
    pinSize?.addEventListener('change', () => save({ pin_size: Number(pinSize.value) }));
    el('parcoursPhotoDuration')?.addEventListener('change', (event) => save({ duration: Number(event.target.value) }));
    el('parcoursPhotoMaxPerStop')?.addEventListener('change', (event) => save({ max_per_stop: Number(event.target.value) }));
    el('parcoursPhotoCaptionTemplate')?.addEventListener('change', (event) => save({ caption: event.target.value }));
    el('btnParcoursPhotoPreview')?.addEventListener('click', () => {
        const first = timeline ? photoSlots(timeline)[0] : null;
        if (first) previewPhoto(first.photoId);
    });
}

// Refus d'envoi regroupés par cause : « a.jpg, b.jpg et 12 autres : même
// message » plutôt qu'une ligne par fichier quand des centaines sont
// refusés pour la même raison (plafond atteint, par exemple).
function refuseSummary(refused) {
    const byMessage = new Map();
    for (const { name, message } of refused) {
        if (!byMessage.has(message)) byMessage.set(message, []);
        byMessage.get(message).push(name);
    }
    const lines = [];
    for (const [message, names] of byMessage) {
        const shown = names.slice(0, 3).join(', ');
        const more = names.length > 3 ? t(' et ${n} autres', { n: names.length - 3 }) : '';
        lines.push(`${shown}${more} : ${message}`);
    }
    return lines.join('\n');
}

async function uploadPhotos(files) {
    if (!selectedId || adjustmentsLocked() || files.length === 0) return;
    // Tout part dans le parcours ouvert au début de l'envoi : en ouvrir un
    // autre en cours de route ne déroute pas la suite.
    const targetId = selectedId;
    const status = el('parcoursPhotoStatus');
    let done = 0;
    const refused = [];
    for (const file of files) {
        if (status) status.textContent = t('Envoi des photos : ${done} / ${total}', { done, total: files.length });
        const body = new FormData();
        body.append('photo', file, file.name);
        try {
            const response = await fetch(`${CONFIG.BASE_URL}/api/parcours/${targetId}/photos`, { method: 'POST', body });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                refused.push({ name: file.name, message: payload.message || `HTTP ${response.status}` });
                if (payload.error === 'photos-full') {
                    // Le plafond ne bougera pas d'ici la fin de l'envoi :
                    // les suivants seraient refusés de la même façon.
                    for (const rest of files.slice(done + 1)) {
                        refused.push({ name: rest.name, message: payload.message });
                    }
                    done = files.length;
                    break;
                }
            }
        } catch (error) {
            refused.push({ name: file.name, message: error.message });
        }
        done++;
    }
    if (status) status.textContent = '';
    if (refused.length) showToast(refuseSummary(refused), 'warning', t('Photos refusées'));
    // Autre parcours ouvert entre-temps : ses entrées sont déjà fraîches.
    await reloadAdjustments(targetId);
}

async function linkPhoto(id, stopKey) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/photos/${id}`, {
            method: 'PATCH', body: JSON.stringify({ stopKey }),
        });
        await reloadAdjustments(pid);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Réglages d'affichage d'une photo (lot 8). Masquer ou montrer change le
// temps d'écran : reconstruction complète, refusée pendant une lecture.
// Légende et cadrage ne touchent que le dessin : la photo est remplacée en
// mémoire, la carte redessinée.
async function patchPhoto(id, patch) {
    if (!selectedId) return;
    const pid = selectedId;
    const rebuilds = 'hidden' in patch;
    if (rebuilds && adjustmentsLocked()) {
        renderPhotoDetail();
        return;
    }
    try {
        const { photo } = await fetchJson(`/api/parcours/${pid}/photos/${id}`, {
            method: 'PATCH', body: JSON.stringify(patch),
        });
        if (!inputs || !photo || pid !== selectedId) return;
        const photos = (inputs.photos || []).map((p) => (p.id === photo.id ? photo : p));
        if (rebuilds) {
            receiveAdjustments({ photos }, pid);
        } else {
            inputs.photos = photos;
            renderPhotos();
            pkg.getMap?.()?.render();
        }
    } catch (error) {
        showToast(error.message, 'error');
        renderPhotoDetail();
    }
}

async function deletePhoto(id) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/photos/${id}`, { method: 'DELETE' });
        photoImages.delete(id);
        photoThumbs.delete(id);
        if (photoDetailId === id) photoDetailId = null;
        await reloadAdjustments(pid);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function setCameraOffset(camera, offsetMinutes) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        receiveAdjustments(await fetchJson(`/api/parcours/${pid}/cameras`, {
            method: 'PUT', body: JSON.stringify({ camera, offsetMinutes }),
        }), pid);
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
    const empty = el('parcoursPhotosEmpty');
    if (empty) empty.hidden = !!inputs;
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
            cell.classList.toggle('is-hidden', !!photo.hidden);
            cell.dataset.photoId = String(photo.id);
            const hiddenNote = t('masquée dans la vidéo');
            cell.title = photo.hidden ? `${photo.name} — ${matchLabel(match)} — ${hiddenNote}` : `${photo.name} — ${matchLabel(match)}`;
            const img = document.createElement('img');
            img.src = photoUrl(photo, true);
            img.alt = photo.name || '';
            img.loading = 'lazy';
            cell.append(img);
            if (photo.hidden) {
                const badge = document.createElement('i');
                badge.className = 'ti ti-eye-off parcours-photo-hidden-badge';
                badge.setAttribute('aria-hidden', 'true');
                cell.append(badge);
            }
            cell.addEventListener('click', () => {
                photoDetailId = photoDetailId === photo.id ? null : photo.id;
                renderPhotos();
            });
            return cell;
        }));
    }
    renderPhotoPlaces();
    renderPhotoDetail();
    renderPhotoDisplay();
}

// Photos géolocalisées hors de toute étape (lot 10) : un lieu proposé par
// endroit, créé d'un clic (nom facultatif) ; ses photos s'y rattachent.
function renderPhotoPlaces() {
    const box = el('parcoursPhotoPlaces');
    const list = el('parcoursPhotoPlaceList');
    if (!box || !list) return;
    const dates = new Set((ordered?.days || []).map((day) => day.date));
    const places = suggestPhotoPlaces(inputs?.photos || [], photoMatches, cameraOffsets(inputs?.cameras), { dates });
    box.hidden = places.length === 0;
    const title = el('parcoursPhotoPlacesTitle');
    if (title) {
        const n = places.reduce((sum, place) => sum + place.photoIds.length, 0);
        title.textContent = n === 1 ? t('1 photo hors des étapes') : t('${n} photos hors des étapes', { n });
    }
    list.replaceChildren(...places.map((place) => {
        const row = document.createElement('div');
        row.className = 'parcours-photo-place d-flex align-items-center gap-2 flex-wrap';
        row.dataset.photoIds = place.photoIds.join(',');
        const thumbs = document.createElement('div');
        thumbs.className = 'parcours-photo-place-thumbs';
        for (const id of place.photoIds.slice(0, 3)) {
            const photo = photoById(id);
            if (!photo) continue;
            const img = document.createElement('img');
            img.src = photoUrl(photo, true);
            img.alt = photo.name || '';
            img.loading = 'lazy';
            thumbs.append(img);
        }
        const text = document.createElement('div');
        text.className = 'small flex-grow-1';
        const count = place.photoIds.length === 1 ? t('1 photo') : t('${n} photos', { n: place.photoIds.length });
        text.textContent = [
            count,
            formatDay(place.date, { weekday: 'short', day: 'numeric', month: 'short' }),
            minutesToTime(place.minutes),
        ].filter(Boolean).join(' · ');
        const name = document.createElement('input');
        name.type = 'text';
        name.maxLength = 80;
        name.className = 'form-control form-control-sm parcours-photo-place-name';
        name.placeholder = t('Nom du lieu (facultatif)');
        name.setAttribute('aria-label', t('Nom du lieu'));
        const create = button('btn btn-sm btn-outline-primary parcours-photo-place-create', 'ti-map-pin-plus',
            t('Créer ce lieu'), { text: t('Créer ce lieu') });
        create.addEventListener('click', async () => {
            create.disabled = true;
            const ok = await createPlace({
                kind: KIND_PLACE,
                name: name.value,
                lat: place.lat,
                lon: place.lon,
                date: place.date,
                time: minutesToTime(place.minutes) || null,
            });
            if (!ok) create.disabled = false;
        });
        row.append(thumbs, text, name, create);
        return row;
    }));
}

function renderPhotoDetail() {
    const box = el('parcoursPhotoDetail');
    if (!box) return;
    const photo = photoById(photoDetailId);
    box.hidden = !photo;
    if (!photo) return;
    const match = photoMatches.get(photo.id);
    const clock = photoClock(photo, cameraOffsets(inputs.cameras));
    const info = el('parcoursPhotoInfo');
    if (info) {
        info.textContent = [
            photo.name,
            clock ? `${formatDay(clock.date, { day: 'numeric', month: 'short' })} ${minutesToTime(clock.minutes)}` : t('sans heure'),
            hasPosition(photo) ? t('géolocalisée') : t('sans position'),
            photo.camera || '',
        ].filter(Boolean).join(' · ');
    }

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
    el('parcoursPhotoLinkRow')?.replaceChildren(label, select);

    const shown = el('parcoursPhotoShown');
    if (shown) shown.checked = !photo.hidden;
    const caption = el('parcoursPhotoCaption');
    if (caption && document.activeElement !== caption) caption.value = photo.caption || '';
    const crop = photoCrop(photo);
    const aspect = el('parcoursPhotoAspect');
    if (aspect) aspect.value = crop.aspect;
    const zoom = el('parcoursPhotoZoom');
    if (zoom) zoom.value = String(crop.zoom);
    renderCropPicker(photo);

    const actions = [];
    const stop = match?.key ? stopByKey(match.key) : null;
    const offset = !hasPosition(photo) && photo.camera ? calibrationOffset(photo, stop) : null;
    if (offset !== null) {
        const calibrate = button('btn btn-sm btn-outline-primary parcours-photo-calibrate', 'ti-clock',
            t('Caler l’horloge de l’appareil sur cette étape'),
            { text: t('Caler l’horloge sur l’étape (${offset})', { offset: formatOffset(offset) }) });
        calibrate.addEventListener('click', () => setCameraOffset(photo.camera, offset));
        actions.push(calibrate);
    }
    if (timeline && photoSlots(timeline).some((slot) => slot.photoId === photo.id)) {
        const show = button('btn btn-sm btn-outline-secondary parcours-photo-preview', 'ti-eye',
            t('Ouvrir l’aperçu en pause sur cette photo'), { text: t('Voir sur la carte') });
        show.addEventListener('click', () => previewPhoto(photo.id));
        actions.push(show);
    }
    const remove = button('btn btn-sm btn-outline-danger parcours-photo-delete', 'ti-trash', t('Supprimer la photo'),
        { text: t('Supprimer la photo') });
    remove.addEventListener('click', () => deletePhoto(photo.id));
    actions.push(remove);
    el('parcoursPhotoActions')?.replaceChildren(...actions);
}

// Sélecteur du cadrage : la photo entière, la fenêtre gardée par-dessus
// (le reste assombri). `draft` : cadrage en cours de geste, pas encore
// enregistré.
function renderCropPicker(photo, draft = null) {
    const picker = el('parcoursPhotoCropPicker');
    const img = el('parcoursPhotoCropImage');
    const frame = el('parcoursPhotoCropWindow');
    if (!picker || !img || !frame) return;
    const url = photoUrl(photo, true);
    if (img.dataset.src !== url) {
        img.dataset.src = url;
        const known = photo.width > 0 && photo.height > 0;
        picker.style.aspectRatio = known ? `${photo.width} / ${photo.height}` : '';
        // Portrait : plafonné en hauteur, comme le paysage l'est en largeur.
        picker.style.maxWidth = known && photo.height > photo.width ? `${Math.round((240 * photo.width) / photo.height)}px` : '';
        img.src = url;
    }
    const crop = { ...photoCrop(photo), ...(draft || {}) };
    const natural = { width: photo.width || 1, height: photo.height || 1 };
    const rect = photoCropRect(natural, crop);
    frame.style.left = `${(rect.x / natural.width) * 100}%`;
    frame.style.top = `${(rect.y / natural.height) * 100}%`;
    frame.style.width = `${(rect.width / natural.width) * 100}%`;
    frame.style.height = `${(rect.height / natural.height) * 100}%`;
    const full = isFullFrame(crop);
    picker.classList.toggle('is-full', full);
    const hint = el('parcoursPhotoCropHint');
    if (hint) {
        hint.textContent = full
            ? t('Photo entière : choisissez un cadrage ou un zoom pour n’en garder qu’une partie.')
            : t('Glissez sur la photo pour choisir la partie gardée.');
    }
    const zoomValue = el('parcoursPhotoZoomValue');
    if (zoomValue) zoomValue.textContent = `${Math.round(crop.zoom)} %`;
}

function bindPhotoDetail() {
    const current = () => photoById(photoDetailId);
    el('parcoursPhotoShown')?.addEventListener('change', (event) => {
        const photo = current();
        if (photo) patchPhoto(photo.id, { hidden: !event.target.checked });
    });
    el('parcoursPhotoCaption')?.addEventListener('change', (event) => {
        const photo = current();
        const value = event.target.value.trim();
        if (photo && value !== (photo.caption || '')) patchPhoto(photo.id, { caption: value });
    });
    el('parcoursPhotoAspect')?.addEventListener('change', (event) => {
        const photo = current();
        if (photo) patchPhoto(photo.id, { aspect: event.target.value });
    });
    const zoom = el('parcoursPhotoZoom');
    zoom?.addEventListener('input', () => {
        const photo = current();
        if (photo) renderCropPicker(photo, { zoom: Number(zoom.value) });
    });
    zoom?.addEventListener('change', () => {
        const photo = current();
        const value = Math.round(Number(zoom.value));
        if (photo && value >= PHOTO_ZOOM_RANGE[0] && value <= PHOTO_ZOOM_RANGE[1]) patchPhoto(photo.id, { zoom: value });
    });

    // Point focal : glisser (enregistré au relâchement), ou les flèches
    // (1 %, Maj = 10 %), comme le sélecteur de l'onglet Images.
    const picker = el('parcoursPhotoCropPicker');
    if (!picker) return;
    const focusAt = (event) => {
        const rect = picker.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        return {
            focusX: Math.round(clamp01((event.clientX - rect.left) / rect.width) * 100),
            focusY: Math.round(clamp01((event.clientY - rect.top) / rect.height) * 100),
        };
    };
    picker.addEventListener('pointerdown', (event) => {
        const photo = current();
        if (event.button !== 0 || !photo) return;
        picker.setPointerCapture?.(event.pointerId);
        let draft = focusAt(event);
        renderCropPicker(photo, draft);
        const move = (e) => {
            if (e.pointerId !== event.pointerId) return;
            draft = focusAt(e) || draft;
            renderCropPicker(photo, draft);
        };
        const up = (e) => {
            if (e.pointerId !== event.pointerId) return;
            picker.removeEventListener('pointermove', move);
            picker.removeEventListener('pointerup', up);
            picker.removeEventListener('pointercancel', up);
            if (draft) patchPhoto(photo.id, draft);
        };
        picker.addEventListener('pointermove', move);
        picker.addEventListener('pointerup', up);
        picker.addEventListener('pointercancel', up);
        event.preventDefault();
    });
    picker.addEventListener('keydown', (event) => {
        const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const photo = current();
        if (!dir || !photo) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const crop = photoCrop(photo);
        const clamp = (v) => Math.max(0, Math.min(100, v));
        patchPhoto(photo.id, { focusX: clamp(crop.focusX + dir[0] * step), focusY: clamp(crop.focusY + dir[1] * step) });
    });
}

function bindPhotos() {
    bindPhotoDetail();
    bindPhotoDisplay();
    const input = el('parcoursPhotoInput');
    el('btnParcoursAddPhotos')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        uploadPhotos(files);
    });
}

// --- Glisser-déposer ---------------------------------------------------------------

const isGpxFile = (file) => /\.gpx$/i.test(file?.name || '');

// Fichiers déposés n'importe où sur la page : les photos rejoignent le
// parcours ouvert (onglet Photos, pour les voir arriver), les .gpx ses traces
// (onglet Données), une musique Animation > Musique. Sans ce gestionnaire, le
// navigateur ouvrirait le fichier à la place de l'application.
function routeDroppedFiles(files) {
    const music = files.find(isAudioFile);
    if (music) pkg.dropMusicFile?.(music);
    const photos = files.filter(isImageFile);
    const tracks = files.filter(isGpxFile);
    const ignored = files.filter((f) => f !== music && !isImageFile(f) && !isGpxFile(f));
    if (ignored.length) {
        const shown = ignored.slice(0, 3).map((f) => f.name).join(', ');
        const more = ignored.length > 3 ? t(' et ${n} autres', { n: ignored.length - 3 }) : '';
        showToast(shown + more, 'warning', t('Fichiers non pris en charge'));
    }
    if (!photos.length && !tracks.length) return;
    if (!selectedId) {
        showToast(t('Ouvrez un parcours avant d’y déposer des photos ou des traces.'), 'info', t('Parcours'));
        return;
    }
    if (photos.length) {
        pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#photos"]'));
        uploadPhotos(photos);
    } else {
        pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]'));
    }
    if (tracks.length) uploadTracks(tracks);
}

function bindFileDrop() {
    const overlay = document.createElement('div');
    overlay.id = 'parcoursDropOverlay';
    overlay.className = 'gpx-drop-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'gpx-drop-overlay__inner';
    const icon = document.createElement('i');
    icon.className = 'ti ti-file-upload';
    const text = document.createElement('div');
    text.className = 'gpx-drop-overlay__text';
    text.textContent = t('Déposez vos photos ou traces (.gpx) pour les ajouter au parcours, ou une musique');
    inner.append(icon, text);
    overlay.append(inner);
    document.body.append(overlay);

    // Compteur de profondeur : dragenter/dragleave se déclenchent aussi d'un
    // élément enfant à l'autre.
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const hide = () => { depth = 0; overlay.classList.remove('is-visible'); };
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth++;
        overlay.classList.add('is-visible');
    });
    window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) hide();
    });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        hide();
        routeDroppedFiles([...(e.dataTransfer.files || [])]);
    });
    window.addEventListener('dragend', hide);
}

// --- Traces GPS (lot 5) ---------------------------------------------------------

// Décalages proposés pour l'heure locale des traces : de −12 h à +14 h, au
// quart d'heure (fuseaux à 30 et 45 minutes compris).
const UTC_OFFSET_CHOICES = Array.from({ length: (26 * 60) / 15 + 1 }, (_, i) => -12 * 60 + i * 15);

function formatUtcOffset(minutes) {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function offsetSourceLabel(source) {
    switch (source) {
        case OFFSET_MANUAL: return t('réglé à la main');
        case OFFSET_PHOTOS: return t('déduit des photos');
        case OFFSET_EVIDENCE: return t('déduit des Labs et photos situés sur la trace');
        default: return t('fuseau de cet ordinateur');
    }
}

function trackRange(track) {
    const start = Date.parse(track.start || '') / 1000;
    const end = Date.parse(track.end || '') / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    const a = localClock(start, utcOffset.minutes);
    const b = localClock(end, utcOffset.minutes);
    const day = formatDay(a.date, { weekday: 'short', day: 'numeric', month: 'short' });
    return a.date === b.date
        ? `${day} ${minutesToTime(a.minutes)} → ${minutesToTime(b.minutes)}`
        : `${day} ${minutesToTime(a.minutes)} → ${formatDay(b.date, { day: 'numeric', month: 'short' })} ${minutesToTime(b.minutes)}`;
}

// « Fuseau de cet ordinateur » : suspect quand le parcours se passe loin du
// centre habituel des trouvailles — l'ordinateur peut avoir gardé le fuseau
// de la maison. Longitude : ≈ un fuseau par 10° d'écart.
const UTC_SUSPECT_LON_DEG = 10;

function computerOffsetSuspect() {
    if (utcOffset.source !== OFFSET_COMPUTER || !(inputs?.tracks || []).length) return false;
    if (!homeCenter || !ordered) return false;
    return parcoursStops(ordered).some((stop) => {
        const d = Math.abs(stop.lon - homeCenter.lon);
        return Math.min(d, 360 - d) > UTC_SUSPECT_LON_DEG;
    });
}

function renderTracks() {
    const card = el('parcoursTracksCard');
    if (!card) return;
    card.hidden = !inputs;
    if (!inputs) return;
    const tracks = inputs.tracks || [];
    const summary = el('parcoursTrackSummary');
    if (summary) {
        const count = tracks.length === 1 ? t('1 trace') : t('${n} traces', { n: tracks.length });
        const matched = trackMatches.size === 1
            ? t('1 étape calée sur une trace')
            : t('${n} étapes calées sur une trace', { n: trackMatches.size });
        summary.textContent = tracks.length ? `${count}, ${matched}` : t('Aucune trace pour ce parcours.');
    }
    const offset = el('parcoursUtcOffset');
    if (offset) {
        if (!offset.options.length) {
            const auto = document.createElement('option');
            auto.value = '';
            offset.append(auto);
            for (const minutes of UTC_OFFSET_CHOICES) {
                const opt = document.createElement('option');
                opt.value = String(minutes);
                opt.textContent = formatUtcOffset(minutes);
                offset.append(opt);
            }
        }
        const manual = inputs.parcours?.utc_offset_minutes;
        offset.options[0].textContent = Number.isFinite(manual)
            ? t('Automatique')
            : t('Automatique : ${offset} (${source})', { offset: formatUtcOffset(utcOffset.minutes), source: offsetSourceLabel(utcOffset.source) });
        offset.value = Number.isFinite(manual) ? String(manual) : '';
    }
    const warn = el('parcoursUtcOffsetWarn');
    if (warn) {
        warn.hidden = !computerOffsetSuspect();
        const warnText = el('parcoursUtcOffsetWarnText');
        if (!warn.hidden && warnText) {
            warnText.textContent = t('Heures des traces calées sur le fuseau de cet ordinateur (${offset}) — vérifiez-le pour un parcours loin de chez vous.', { offset: formatUtcOffset(utcOffset.minutes) });
        }
    }
    const list = el('parcoursTracks');
    if (list) {
        list.replaceChildren(...tracks.map((track) => {
            const item = document.createElement('div');
            item.className = 'd-flex align-items-center gap-2 py-1 parcours-track';
            item.dataset.trackId = String(track.id);
            const text = document.createElement('div');
            text.className = 'flex-grow-1 min-w-0';
            const name = document.createElement('div');
            name.className = 'text-truncate';
            name.textContent = track.name || t('Trace');
            const detail = document.createElement('div');
            detail.className = 'small text-muted';
            const matched = [...trackMatches.values()].filter((m) => m.trackId === track.id).length;
            detail.textContent = [
                trackRange(track),
                t('${n} points', { n: track.pointCount }),
                matched === 1 ? t('1 étape calée') : t('${n} étapes calées', { n: matched }),
            ].filter(Boolean).join(' · ');
            text.append(name, detail);
            const remove = button('btn btn-sm btn-ghost-danger parcours-track-delete', 'ti-trash', t('Supprimer la trace'));
            remove.addEventListener('click', () => deleteTrack(track.id));
            item.append(text, remove);
            return item;
        }));
    }
}

async function uploadTracks(files) {
    if (!selectedId || adjustmentsLocked() || files.length === 0) return;
    // Même garde que les photos : la destination est le parcours ouvert au
    // début de l'envoi.
    const targetId = selectedId;
    const status = el('parcoursTrackStatus');
    const refused = [];
    let done = 0;
    for (const file of files) {
        if (status) status.textContent = t('Envoi des traces : ${done} / ${total}', { done, total: files.length });
        const body = new FormData();
        body.append('track', file, file.name);
        try {
            const response = await fetch(`${CONFIG.BASE_URL}/api/parcours/${targetId}/tracks`, { method: 'POST', body });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                refused.push({ name: file.name, message: payload.message || `HTTP ${response.status}` });
                if (payload.error === 'tracks-full') {
                    for (const rest of files.slice(done + 1)) {
                        refused.push({ name: rest.name, message: payload.message });
                    }
                    done = files.length;
                    break;
                }
            }
        } catch (error) {
            refused.push({ name: file.name, message: error.message });
        }
        done++;
    }
    if (status) status.textContent = '';
    if (refused.length) showToast(refuseSummary(refused), 'warning', t('Traces refusées'));
    await reloadAdjustments(targetId);
}

async function deleteTrack(id) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/tracks/${id}`, { method: 'DELETE' });
        await reloadAdjustments(pid);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function setUtcOffset(value) {
    if (!selectedId || adjustmentsLocked()) return;
    const pid = selectedId;
    try {
        const body = await fetchJson(`/api/parcours/${pid}`, {
            method: 'PATCH', body: JSON.stringify({ utc_offset_minutes: value }),
        });
        if (pid !== selectedId) return;
        inputs.parcours = body.parcours;
        receiveAdjustments({}, pid);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function bindTracks() {
    const input = el('parcoursTrackInput');
    el('btnParcoursAddTracks')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        uploadTracks(files);
    });
    const offset = el('parcoursUtcOffset');
    offset?.addEventListener('change', () => setUtcOffset(offset.value === '' ? null : Number(offset.value)));
}

// --- Itinéraires (lot 6) --------------------------------------------------------

function routingConfig() {
    const raw = window.userSettings?.parcours_routing || {};
    return {
        enabled: raw.enabled === true,
        provider: raw.provider === 'ors' ? 'ors' : 'fossgis',
        orsKeySet: raw.ors_key_set === true,
    };
}

// Écrit le patch puis remet la valeur complète dans window.userSettings
// (saveSettingsPatch y remplace la clé par le seul patch). Attendre cette
// promesse avant de demander un itinéraire : le serveur lit `enabled`.
async function saveRouting(patch) {
    const current = window.userSettings?.parcours_routing || {};
    const next = { ...current, ...patch };
    if ('ors_key' in patch) {
        next.ors_key_set = !!patch.ors_key;
        delete next.ors_key;
    }
    if (window.userSettings) window.userSettings.parcours_routing = next;
    const ok = await saveSettingsPatch({ parcours_routing: patch });
    if (window.userSettings) window.userSettings.parcours_routing = next;
    return ok;
}

// Calcule (côté serveur, cache compris) les itinéraires des trajets qui en
// manquent, puis rejoue le parcours. Une erreur suspend les nouvelles
// tentatives jusqu'à une action de l'utilisateur (« Recalculer », réglage) :
// sinon chaque reconstruction relancerait un fournisseur en panne.
async function ensureRoutes({ force = false } = {}) {
    if (!routingConfig().enabled || !selectedId || !ordered) {
        renderRouting();
        return;
    }
    if (routeState.state === 'error' && !force) return;
    const runs = force ? routeRunsNow : pendingRuns(routeRunsNow, routeCache);
    if (runs.length === 0) {
        renderRouting();
        return;
    }
    const seq = ++routeSeq;
    routeState = { state: 'loading', message: '' };
    renderRouting();
    let message = '';
    let failed = false;
    for (const run of runs) {
        let body;
        try {
            body = await fetchJson('/api/parcours/routes', {
                method: 'POST',
                body: JSON.stringify({ profile: run.profile, waypoints: run.waypoints, force }),
            });
        } catch (error) {
            message = error.message;
            failed = true;
            break;
        }
        if (seq !== routeSeq) return;
        body.legs.forEach((leg, i) => {
            if (leg) routeCache.set(cacheKey(run.profile, run.keys[i]), leg);
        });
        if (body.error) {
            message = body.message || '';
            failed = true;
            break;
        }
    }
    if (seq !== routeSeq) return;
    routeState = failed ? { state: 'error', message } : { state: 'ready', message: '' };
    routeRevision++;
    if (clock.running) {
        pendingTimeline = true;
        renderRouting();
        return;
    }
    rebuild();
    renderStops();
    applyTimeline();
}

function renderRouting() {
    syncRouteAttribution();
    const card = el('parcoursRoutingCard');
    if (!card) return;
    card.hidden = !inputs;
    const config = routingConfig();
    const enabled = el('parcoursRoutingEnabled');
    if (enabled) enabled.checked = config.enabled;
    const provider = el('parcoursRoutingProvider');
    if (provider) provider.value = config.provider;
    const keyRow = el('parcoursOrsKeyRow');
    if (keyRow) keyRow.hidden = config.provider !== 'ors';
    const key = el('parcoursOrsKey');
    if (key) key.placeholder = config.orsKeySet ? t('Clé enregistrée (la remplacer)') : t('Clé openrouteservice');
    const details = el('parcoursRoutingDetails');
    if (details) details.hidden = !config.enabled;
    const status = el('parcoursRoutingStatus');
    if (!status) return;
    status.classList.toggle('text-danger', routeState.state === 'error');
    if (!config.enabled) status.textContent = '';
    else if (routeState.state === 'loading') status.textContent = t('Calcul des itinéraires…');
    else if (routeState.state === 'error') status.textContent = routeState.message || t('Itinéraires indisponibles : trajets en ligne droite.');
    else {
        const routed = routeEffectsNow.paths.size;
        const legs = routeRunsNow.reduce((total, run) => total + run.keys.length, 0);
        status.textContent = legs === 0
            ? t('Aucun trajet à calculer (trajets sur une trace ou en ligne droite).')
            : t('${routed} trajets sur ${legs} suivent les routes et chemins.', { routed, legs });
    }
}

function bindRouting() {
    const enabled = el('parcoursRoutingEnabled');
    enabled?.addEventListener('change', async () => {
        const pid = selectedId;
        await saveRouting({ enabled: enabled.checked });
        routeState = { state: 'idle', message: '' };
        receiveAdjustments({}, pid);
    });
    const provider = el('parcoursRoutingProvider');
    provider?.addEventListener('change', async () => {
        const pid = selectedId;
        await saveRouting({ provider: provider.value });
        // Autre fournisseur, autres itinéraires : le cache de la page repart.
        routeCache.clear();
        routeState = { state: 'idle', message: '' };
        receiveAdjustments({}, pid);
    });
    el('btnParcoursOrsKeySave')?.addEventListener('click', async () => {
        const input = el('parcoursOrsKey');
        const value = (input?.value || '').trim();
        const pid = selectedId;
        await saveRouting({ ors_key: value });
        if (input) input.value = '';
        routeState = { state: 'idle', message: '' };
        receiveAdjustments({}, pid);
    });
    el('btnParcoursRoutesRecompute')?.addEventListener('click', () => {
        if (adjustmentsLocked()) return;
        routeState = { state: 'idle', message: '' };
        ensureRoutes({ force: true });
    });
}

// --- Carte ----------------------------------------------------------------------

// Halo dessiné sous l'étape dont la ligne est survolée (et réciproquement).
const haloStyle = new ol.style.Style({
    image: new ol.style.Circle({
        radius: 17,
        fill: new ol.style.Fill({ color: 'rgba(32, 107, 196, 0.18)' }),
        stroke: new ol.style.Stroke({ color: 'rgba(32, 107, 196, 0.9)', width: 2 }),
    }),
});

function pointStyle(feature) {
    const kind = feature.get('kind');
    const normal = (kind === KIND_BASE || kind === KIND_PLACE) ? placeStyle(kind) : numberedStyle(feature);
    return feature.get('hovered') ? [haloStyle, normal] : normal;
}

function numberedStyle(feature) {
    const kind = feature.get('kind');
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

// Traces GPS importées, sous le plan.
const trackStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: 'rgba(52, 58, 64, 0.45)', width: 2 }),
});

function ensureLayer() {
    const map = pkg.getMap?.();
    if (!map) return null;
    if (!parcoursLayer) {
        parcoursLayer = new ol.layer.Vector({
            source: new ol.source.Vector(),
            zIndex: LAYER_Z_INDEX,
            style: (feature) => {
                const role = feature.get('role');
                if (role === 'track') return trackStyle;
                return role === 'line' ? lineStyle : pointStyle(feature);
            },
        });
        parcoursLayer.set('name', 'parcours');
    }
    if (!map.getLayers().getArray().includes(parcoursLayer)) map.addLayer(parcoursLayer);
    bindMapLink(map);
    return parcoursLayer;
}

// Lien liste ↔ carte : survoler un point du plan surligne sa ligne dans la
// liste ; cliquer un point ouvre son panneau d'ajustement. Le survol d'une
// ligne met le point en évidence (halo) via `setHoveredStop`.
function bindMapLink(map) {
    if (hoverBound) return;
    hoverBound = true;
    map.on('pointermove', (event) => {
        if (event.dragging) return;
        const feature = map.forEachFeatureAtPixel(event.pixel,
            (f) => (f.get('role') === 'stop' ? f : null),
            { layerFilter: (layer) => layer === parcoursLayer, hitTolerance: 5 });
        highlightRowsFor(feature || null);
        const target = map.getTargetElement();
        if (target && !picking) target.style.cursor = feature ? 'pointer' : '';
    });
    map.on('singleclick', (event) => {
        // Un clic de pose ou de déplacement de lieu travaille pour le
        // formulaire, pas pour l'étape qui serait sous la souris.
        if (picking || performance.now() < clickMutedUntil) return;
        const feature = map.forEachFeatureAtPixel(event.pixel,
            (f) => (f.get('role') === 'stop' ? f : null),
            { layerFilter: (layer) => layer === parcoursLayer, hitTolerance: 5 });
        if (!feature) return;
        editKey = feature.get('key') === editKey ? null : feature.get('key');
        renderStops();
        el('parcoursStops')?.querySelector(`[data-stop-key="${feature.get('key')}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    });
}

// Feature du plan correspondant à une étape : la clé pour un point donné,
// le lieu pour une base dessinée une seule fois quelles que soient ses
// occurrences dans les journées.
function stopFeatureFor(stop) {
    const source = parcoursLayer?.getSource();
    if (!source || !stop) return null;
    return source.getFeatures().find((f) => f.get('role') === 'stop'
        && (f.get('key') === stop.key || (stop.placeId != null && f.get('placeId') === stop.placeId))) || null;
}

function setHoveredStop(stop) {
    const feature = stopFeatureFor(stop);
    if (feature === hoveredFeature) return;
    hoveredFeature?.set('hovered', false);
    hoveredFeature = feature;
    hoveredFeature?.set('hovered', true);
}

// Lignes de la liste correspondant à un point du plan (toutes celles d'une
// base : elle n'est dessinée qu'une fois).
function highlightRowsFor(feature) {
    const rows = [];
    const box = el('parcoursStops');
    if (feature && box) {
        const key = feature.get('key');
        const placeId = feature.get('placeId');
        for (const row of box.querySelectorAll('.parcours-stop')) {
            if (row.dataset.stopKey === key || (placeId != null && row.dataset.placeId === String(placeId))) {
                rows.push(row);
            }
        }
    }
    for (const row of mapHoverRows) if (!rows.includes(row)) row.classList.remove('is-map-hover');
    for (const row of rows) row.classList.add('is-map-hover');
    mapHoverRows = rows;
}

function renderLayer({ fit = false } = {}) {
    const layer = ensureLayer();
    if (!layer) return;
    const source = layer.getSource();
    source.clear();
    hoveredFeature = null;
    if (!ordered) return;
    const features = [];
    for (const track of inputs?.tracks || []) {
        for (const segment of track.segments || []) {
            if (segment.length < 2) continue;
            features.push(new ol.Feature({
                role: 'track',
                geometry: new ol.geom.LineString(segment.map((p) => ol.proj.fromLonLat([p[0], p[1]]))),
            }));
        }
    }
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
            placeId: stop.placeId ?? null,
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
        suggestions: suggestions.map((item) => ({ ...item, name: suggestionName(item) })),
        selectedId,
        logsAvailable,
        days: (ordered?.days || []).map((day) => ({
            date: day.date,
            keys: day.stops.map((stop) => stop.key),
            times: day.stops.map((stop) => minutesToTime(stop.arrivalMin)),
            reasons: day.stops.map((stop) => stop.reason),
            logOrder: day.diagnostics.logOrder,
            clockBacktrack: day.diagnostics.clockBacktrack,
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
            hidden: !!photo.hidden,
            caption: photo.caption || '',
            crop: photoCrop(photo),
        })),
        cameras: (inputs?.cameras || []).map((c) => ({ ...c })),
        photoStops: Object.fromEntries([...photoByStop].map(([key, ids]) => [key, [...ids]])),
        photosLoaded: [...photoImages.values()].filter((img) => img.complete && img.naturalWidth > 0).length,
        // Lot 9 : réglages d'affichage, créneaux et cartes peintes à la
        // dernière image (centre, taille et cadre en px du canevas).
        photoDisplay: { ...photoDisplay },
        photoSlots: timeline ? photoSlots(timeline).map((slot) => ({ ...slot })) : [],
        photoView: lastPhotoView ? { ...lastPhotoView } : null,
        photoCards: lastPhotoCards.map((card) => ({
            photoId: card.photoId,
            x: card.x + card.dx,
            y: card.y + card.dy,
            width: (card.w + 2 * card.frame.side) * card.scale * card.effectScale,
            height: (card.h + card.frame.top + card.frame.bottom) * card.scale * card.effectScale,
            frame: card.frame.kind,
            scale: card.scale,
            alpha: card.alpha,
            rotation: card.rotation,
            caption: card.captionAlpha > 0 ? card.caption : '',
            leader: !!card.leader,
            pinned: !!card.pinned,
        })),
        tracks: (inputs?.tracks || []).map((track) => ({ id: track.id, name: track.name, pointCount: track.pointCount })),
        trackTimes: Object.fromEntries([...trackMatches].map(([key, m]) => [key, minutesToTime(m.minutes)])),
        utcOffset: { ...utcOffset },
        utcOffsetSuspect: computerOffsetSuspect(),
        trackLegs: (timeline?.legs || []).filter((leg) => leg.mode === 'track').length,
        routing: {
            ...routingConfig(),
            state: routeState.state,
            message: routeState.message,
            revision: routeRevision,
            requests: routeRunsNow.length,
            routed: routeEffectsNow.paths.size,
            modes: (timeline?.legs || []).filter((leg) => !leg.night).map((leg) => leg.mode),
        },
        layer: source ? {
            stops: source.getFeatures().filter((f) => f.get('role') === 'stop').length,
            lines: source.getFeatures().filter((f) => f.get('role') === 'line').length,
            onMap: !!pkg.getMap?.()?.getLayers().getArray().includes(parcoursLayer),
            visible: parcoursLayer.getVisible(),
        } : null,
        // Lien liste ↔ carte : point entouré d'un halo, lignes surlignées.
        hovered: hoveredFeature?.get('key') || null,
        mapHover: mapHoverRows.filter((row) => row.isConnected).map((row) => row.dataset.stopKey),
        stopPixels: Object.fromEntries((source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'stop')
            .map((f) => [f.get('key'), pkg.getMap?.()?.getPixelFromCoordinate(f.getGeometry().getCoordinates())])
            .filter(([, px]) => !!px)),
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
        // Lot 7 : caméra, nuit, carton, pictogramme, crédits.
        camera: (() => {
            const view = pkg.getMap?.()?.getView();
            return {
                following: cameraFollowing(),
                suspended: cameraSuspended,
                center: view?.getCenter() ? ol.proj.toLonLat(view.getCenter()) : null,
                zoom: view?.getZoom() ?? null,
            };
        })(),
        scene: timeline ? {
            night: playback.day_cards ? nightLevelAt(timeline, currentQ) : 0,
            card: playback.day_cards ? dayCardAt(timeline, currentQ) : null,
            cardText: (() => {
                const card = playback.day_cards ? dayCardAt(timeline, currentQ) : null;
                return card ? dayCardText(card.day) : null;
            })(),
            headMode: headModeAt(timeline, currentQ),
            headGlyph: playback.head === HEAD_PICTOGRAM && !!headGlyph(headModeAt(timeline, currentQ)),
        } : null,
        routeCredit: routeCreditText(),
    };
}

if (isParcoursPage()) {
    registerLifecycleEngine(PARCOURS_ENGINE);
    window.getParcoursSnapshot = getParcoursSnapshot;
}
