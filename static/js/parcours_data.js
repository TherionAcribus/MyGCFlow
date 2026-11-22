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
// Au repos, le plan (`parcoursLayer` : étapes reliées par jour) ; il est
// masqué pendant la lecture, où les mêmes étapes sont dessinées image par
// image. Un seul rendu dans les deux cas (`points.parcours_style.render`) :
// pastilles du parcours — les points WebGL du thème restent alors dans la
// source (flashs, compteurs) mais leur couche est masquée (moteur ›
// hidesPoints) — ou points du thème, numéro en petite pastille à côté.
// Les étapes qui se recouvrent forment des piles (parcours_stack.mjs), au
// repos comme en lecture ; au repos, une pile s'écarte en éventail au clic.
//
// Noms exportés uniques (parcoursXxx) : `export *` d'index.js écarte en
// silence un nom exporté par deux modules.

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showConfirmation, showToast, t } from './notifications.js';
import { FETCH_TIMEOUTS, fetchWithTimeout } from './fetch_with_timeout.mjs';
import { isParcoursPage } from './app_mode.mjs';
import { saveSettingsPatch } from './settings_api.mjs';
import { registerLifecycleEngine } from './lifecycle_engine.mjs';
import { DEFAULT_PARCOURS_TEMPLATE, PARCOURS_INFO_TAGS } from './infos_template.mjs';
import { EVO_NEVER_DAY } from './evolution_style.mjs';
import { buildParcoursGpx } from './parcours_gpx.mjs';
import {
    CATEGORY_ICONS,
    KIND_ICONS,
    formatDay,
    formatKm,
    formatRange,
    stopDetail,
    stopFacts,
    stopLabel,
    stopTime,
    stopsCountText,
    suggestionName,
    travelModeLabel,
} from './parcours_labels.mjs';
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
    buildParcoursTimeline,
    dayCardAt,
    endCardAt,
    formatClock,
    headAt,
    headModeAt,
    legPoints,
    nightLevelAt,
    normalizePlayback,
    stateAt,
    stopsInRange,
    trailAt,
} from './parcours_timeline.mjs';
import { createParcoursTimelineBar, slotLabels } from './parcours_tbar.mjs';
import { createParcoursAdjust } from './parcours_adjust.mjs';
import { createParcoursStyleUI } from './parcours_style_ui.mjs';
import { createPlaceForm } from './parcours_place_form.mjs';
import { createStopsPanel } from './parcours_stops_panel.mjs';
import { createTracksPanel } from './parcours_tracks_panel.mjs';
import { createPhotosPanel } from './parcours_photos_panel.mjs';
import { bindParcoursFileDrop, createParcoursUploads } from './parcours_upload.mjs';
import { cameraPoseAt } from './parcours_camera.mjs';
import { initParcoursCollect, parcoursCollectSnapshot, refreshParcoursCollect } from './parcours_collect.js';
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
    cameraOffsets,
    photoClock,
    photoTimeTrusted,
} from './parcours_photos.mjs';
import {
    PHOTO_FADE_Q,
    PHOTO_LAYOUT_NONE,
    normalizePhotoDisplay,
    photoAspect,
    photoCaptionText,
    photoCrop,
    photoFrameAt,
    photoSlots,
    photoTimelineOptions,
} from './parcours_photo_layout.mjs';
import { drawPhotoCard, drawPhotoLeader } from './parcours_photo_draw.mjs';
import { reconstructWithEvidence } from './parcours_tracks.mjs';
import { composeTransform } from './travel_trail.mjs';
import { cacheKey, pendingRuns, routeEffects, routeRuns } from './parcours_routing.mjs';
import { STACK_DISTANCE, fanOffsets, stackLabel, stackStops } from './parcours_stack.mjs';
import {
    FAVORITE_COLOR,
    currentRingRadius,
    dayColor,
    favoriteBadge,
    favoriteBurst,
    hexToRgba,
    normalizeParcoursStyle,
    numberFontPx,
    paintTextColor,
    playPhase,
    stopNumberLabels,
    stopPaint,
    stopPopScale,
    themeNumberBadge,
    trailColorFor,
} from './parcours_style.mjs';

const LAST_ID_KEY = 'parcours.lastId';
// Opacité de la ligne du plan, relative à celle du trait : elle reste sous
// les pastilles sans les concurrencer.
const PLAN_LINE_ALPHA = 0.55;
// Plan au repos au-dessus des points WebGL (zIndex 1001) : ses numéros
// restent lisibles. Masqué pendant la lecture.
const LAYER_Z_INDEX = 1060;
// Rendu des étapes (`points.parcours_style.render`), au repos comme en lecture.
const RENDER_STOPS = 'stops';
const RENDER_THEME = 'theme';
// Cadrage d'un parcours : une sortie tient souvent dans quelques kilomètres.
const FIT_MAX_ZOOM = 16;

let listing = [];             // parcours enregistrés (GET /api/parcours)
let suggestions = [];         // séjours et grosses journées proposés (lot 7)
let suggestionsSeq = 0;
let suggestionsTotal = 0;     // total côté serveur (la réponse est plafonnée)
let suggestionsExpanded = false;
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
let hoveredFeature = null;    // point du plan mis en évidence par la liste
let mapHoverRows = [];        // lignes de la liste mises en évidence par la carte
let hoverBound = false;

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


// Requêtes de la page bornées en durée (un fetch suspendu ne se résout
// jamais seul). `timeoutMs` dans les options le règle par appel : les
// itinéraires en ont besoin d'un long (le serveur chaîne des appels
// fournisseur temporisés).
async function fetchJson(url, options = {}) {
    const { timeoutMs, ...fetchOptions } = options;
    const response = await fetchWithTimeout(`${CONFIG.BASE_URL}${url}`, {
        ...fetchOptions,
        headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
    }, { timeoutMs: timeoutMs || FETCH_TIMEOUTS.control, t });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.message || `HTTP ${response.status}`);
        error.code = body.error;
        // Compteurs et détails joints à certaines erreurs ('out-of-range').
        error.detail = body;
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
    photosPanel.bind();
    tracksPanel.bind();
    bindRouting();
    bindParcoursStyle();
    bindParcoursFileDrop({
        getSelectedId: () => selectedId,
        uploadPhotos: photosPanel.upload,
        uploadTracks: tracksPanel.upload,
        showBsTab: (a) => pkg.showBsTab?.(a),
        dropMusicFile: (f) => pkg.dropMusicFile?.(f),
    });
    // Compléter depuis geocaching.com : rechargement des étapes après import.
    initParcoursCollect({ reload: () => (selectedId != null ? openParcours(selectedId) : Promise.resolve()) });
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
        stopsPanel.reset();
        adjust.resetHistory();
        photoImages.clear();
        photoThumbs.clear();
        renderStops();
        applyTimeline();
        status = 'idle';
        signalLoaded();
        refreshParcoursCollect(null);
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
    stopsPanel.reset();
    adjust.resetHistory();
    placeForm.dismiss();
    renderStops();
    // Itinéraires : toute suite en vol appartient au parcours quitté — le
    // numéro de séquence la tue, son état et son cache ne le suivent pas
    // (deux parcours peuvent partager les clés « place:n » de trajets).
    routeSeq++;
    routeState = { state: 'idle', message: '' };
    routeCache.clear();
    // Photos du parcours quitté : images pleine taille et vignettes sont
    // libérées, sinon elles s'accumulent d'un parcours à l'autre.
    photoImages.clear();
    photoThumbs.clear();
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
    refreshParcoursCollect(id);
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
        // Carton final de synthèse : temps d'écran ajouté avec les cartons.
        endCard: playback.day_cards,
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
    photosPanel.render();
    tracksPanel.render();
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
    let favorites = 0;
    for (const stop of timeline.stops) {
        if (stop.kind in kinds) kinds[stop.kind]++;
        if (stop.kind === 'find' && stop.favorite) favorites++;
    }
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
            pf: favorites,
            jour: lastDayNumber,
            jours: lastDayNumber,
            heure: '≈ 00:00',
            km: formatKm(timeline.totalKm),
        },
    };
}


// Compteurs animés de la ligne d'infos à la position `q` (quanta).
function countersAt(q) {
    const state = timeline ? stateAt(timeline, q) : null;
    return {
        etapes: state ? state.stopsReached : 0,
        caches: state ? state.finds : 0,
        labs: state ? state.labs : 0,
        pf: state ? state.favorites : 0,
    };
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
    playStopsDrawn = emptyPlayStops();
    pkg.hideMapPopup?.();
    closeFan();
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
    detail.textContent = [stopTime(stop), stopDetail(stop, photoByStop.get(stop.key)?.length || 0)].filter(Boolean).join(' · ');
    container.replaceChildren(title, detail);
}

// --- Barre de chronologie ---------------------------------------------------------
//
// timeline_bar.js compte en jours du moteur, donc ici en quanta : la
// fabrique de parcours_tbar.mjs lit l'état courant (timeline, lecture) à
// chaque appel.

const PARCOURS_TIMELINE_BAR = createParcoursTimelineBar({
    quantumBase,
    getState: () => ({ timeline, playback, timelineRevision }),
});

const PARCOURS_ENGINE = Object.freeze({
    timelineBar: PARCOURS_TIMELINE_BAR,
    id: 'parcours',
    counterKeys: Object.freeze(['etapes', 'caches', 'labs', 'pf']),
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
    styleChanged: parcoursStyleChanged,
    hidesPoints: () => stopStyle().render === RENDER_STOPS,
    popupAt: parcoursPopupAt,
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

// Trait de la lecture (thème, `points.parcours_style`) : `color` avec son
// opacité pour le trait, `solid` sans, pour le géocacheur. Aux couleurs des
// journées, celle de la journée `dayIndex`.
function trailOptions(dayIndex = 0) {
    const style = stopStyle();
    const solid = trailColorFor(style, dayIndex);
    return {
        color: hexToRgba(solid, style.trail_opacity / 100),
        solid,
        width: style.trail_width,
    };
}

// Journée d'un trajet : celle de son arrivée — la nuit prend la couleur du
// lendemain.
function legDayIndex(leg) {
    return dayIndexes().byKey.get(timeline?.stops[leg.to]?.key) ?? 0;
}

// Journée du géocacheur : celle du trajet en cours, sinon de la dernière
// étape atteinte.
function headDayIndex(current) {
    if (current) return legDayIndex(timeline.legs[current.leg]);
    let last = null;
    for (const stop of timeline.stops) {
        if (stop.q > currentQ) break;
        last = stop;
    }
    return dayIndexes().byKey.get(last?.key) ?? 0;
}

// Styles du trait d'une journée : trajet, nuit (pointillés fins), trajet
// estimé (option, pointillés).
const TRAIL_KINDS = ['night', 'estimated', 'day'];

function trailStyle(kind, dayIndex) {
    const { color, width } = trailOptions(dayIndex);
    return cachedStyle(`trail:${kind}:${color}`, () => {
        if (kind === 'night') {
            return new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: Math.max(1, width * 0.6), lineDash: [width * 2, width * 2] }) });
        }
        return new ol.style.Style({
            stroke: new ol.style.Stroke({
                color, width, lineCap: 'round', lineJoin: 'round',
                lineDash: kind === 'estimated' ? [width * 2.5, width * 2] : undefined,
            }),
        });
    });
}

function legKind(leg, dashed) {
    return leg.night ? 'night' : (dashed && !leg.path ? 'estimated' : 'day');
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
// Les trajets terminés sont regroupés par style — nature du trajet et, aux
// couleurs des journées, journée — en MultiLineString persistants, allongés
// à mesure que la lecture avance : une géométrie par style à l'image au lieu
// d'une LineString par trajet (des centaines de trajets routés recréés à
// chaque image sinon).
let trailGroups = null;
const currentLegGeom = new ol.geom.LineString([]);

function doneTrailGroups(done) {
    const byDay = stopStyle().trail_by_day;
    if (!trailGroups || trailGroups.timeline !== timeline || trailGroups.dashed !== playback.estimated_dashed
            || trailGroups.byDay !== byDay) {
        trailGroups = { timeline, dashed: playback.estimated_dashed, byDay, done: 0, groups: new Map() };
    }
    // Retour en arrière dans la lecture : tout se refait depuis le début.
    if (done < trailGroups.done) {
        trailGroups.done = 0;
        trailGroups.groups.clear();
    }
    for (let k = trailGroups.done; k < done; k++) {
        const leg = timeline.legs[k];
        // Trajet sur une trace GPS ou un itinéraire : le vrai chemin, sinon
        // la ligne droite.
        const coords = legProjected[k] || [projected[leg.from], projected[leg.to]];
        const kind = legKind(leg, trailGroups.dashed);
        const dayIndex = byDay ? legDayIndex(leg) : 0;
        const key = `${kind}:${dayIndex}`;
        let g = trailGroups.groups.get(key);
        if (!g) {
            g = { kind, dayIndex, coords: [], geom: new ol.geom.MultiLineString([]) };
            trailGroups.groups.set(key, g);
        }
        g.coords.push(coords);
        g.geom.setCoordinates(g.coords);
    }
    trailGroups.done = done;
    return trailGroups;
}

function drawPlayTrail(event) {
    if (!clock.running || !timeline) return;
    const context = ol.render.getVectorContext(event);
    const { done, current } = trailAt(timeline, currentQ);
    const { groups } = doneTrailGroups(done);
    // Nuits sous les trajets estimés, eux-mêmes sous les trajets réels.
    for (const kind of TRAIL_KINDS) {
        for (const g of groups.values()) {
            if (g.kind !== kind || !g.coords.length) continue;
            context.setStyle(trailStyle(kind, g.dayIndex));
            context.drawGeometry(g.geom);
        }
    }
    if (current) {
        const leg = timeline.legs[current.leg];
        const coords = current.progress >= 1
            ? (legProjected[current.leg] || [projected[leg.from], projected[leg.to]])
            : legPoints(timeline, current.leg, current.progress).map((p) => ol.proj.fromLonLat(p));
        context.setStyle(trailStyle(legKind(leg, playback.estimated_dashed), legDayIndex(leg)));
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
    const context = ol.render.getVectorContext(event);
    drawPlayStops(context, event.frameState.viewState.resolution);
    const level = playback.day_cards ? nightLevelAt(timeline, currentQ) : 0;
    if (level > 0) {
        ctx.save();
        ctx.fillStyle = `rgba(10, 16, 38, ${(NIGHT_ALPHA * level).toFixed(3)})`;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
    }
    drawPlayPlaces(context);
    const { solid: color } = trailOptions(headDayIndex(trailAt(timeline, currentQ).current));
    playStopsDrawn.headColor = color;
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
    drawEndCard(ctx, ratio);
    drawRouteCredits(ctx, ratio);
}

const NIGHT_ALPHA = 0.5;
// Cœur des PF donnés (marque et effet à l'arrivée) : glyphe texte, sans
// attendre la police d'icônes.
const HEART = '\u2665';

// Étapes comptées déjà atteintes, dans le rendu du plan : pastilles, ou
// numéros à côté des points du thème (WebGL, qui apparaissent seuls), sous
// la nuit. Celles qui se recouvrent au zoom de l'image forment des piles,
// comme au repos (« 4–5 », puis « 4–6 »…), à la place de leur première
// étape. Dans l'ordre de la lecture ; une étape qui arrive fait grossir sa
// pastille — ou sa pile — de rien à sa taille (stopPopScale).
//
// Lecture plus lisible (`play_*` du thème) : l'étape en cours entourée d'un
// anneau qui pulse, les étapes passées atténuées, un aperçu pâle des étapes
// à venir de la journée — ces deux derniers en rendu « pastilles » : en
// points du thème, les points WebGL apparaissent seuls.
let playStopsDrawn = emptyPlayStops();

// Piles d'étapes atteintes de l'image précédente : `projected` est refait à
// chaque applyTimeline (invalidation), `fp` empreint les indices atteints.
let playStacksMemo = { projected: null, fp: -1, resolution: 0, distance: 0, stacks: [] };

function emptyPlayStops() {
    return {
        drawn: 0, popping: 0, headColor: null, piles: [], current: null, ring: null, dimmed: 0, preview: 0, places: 0,
        favorites: 0, bursts: 0,
    };
}

// Journée de la chronologie où est le géocacheur : celle du trajet en cours
// (la nuit : le lendemain), sinon de la dernière étape atteinte.
function playDay() {
    const { current } = trailAt(timeline, currentQ);
    if (current) return timeline.stops[timeline.legs[current.leg].to]?.day ?? 0;
    let day = 0;
    for (const stop of timeline.stops) {
        if (stop.q > currentQ) break;
        day = stop.day;
    }
    return day;
}

function drawPlayStops(context, resolution) {
    const style = stopStyle();
    const labels = currentStopLabels();
    const themed = style.render === RENDER_THEME;
    const past = themed ? 'normal' : style.play_past;
    const day = playDay();
    const point = new ol.geom.Point([0, 0]);
    playStopsDrawn = { ...playStopsDrawn, current: null, ring: null, dimmed: 0, preview: 0 };
    if (!themed && style.play_preview) drawPlayPreview(context, day, labels);
    const reached = [];
    let fp = 0;
    timeline.stops.forEach((stop, i) => {
        if (isCountedStop(stop) && stop.q <= currentQ) {
            reached.push(i);
            fp = ((fp * 31) + i) | 0;
        }
    });
    // Regroupement mémorisé : il ne dépend que des étapes atteintes
    // (empreinte), de la résolution et de la distance de pile — une image
    // sans nouvelle étape ni zoom le réutilise tel quel.
    const distance = style.size * STACK_DISTANCE;
    if (playStacksMemo.projected !== projected || playStacksMemo.fp !== fp
        || playStacksMemo.resolution !== resolution || playStacksMemo.distance !== distance) {
        playStacksMemo = {
            projected, fp, resolution, distance,
            stacks: stackStops(reached.map((i) => stackItem(projected[i], timeline.stops[i].key, resolution)), distance),
        };
    }
    const stacks = playStacksMemo.stacks;
    let drawn = 0;
    let popping = 0;
    let dimmed = 0;
    let favorites = 0;
    const piles = [];
    for (const { rep, members } of stacks) {
        const head = timeline.stops[reached[rep]];
        const newest = timeline.stops[reached[members[members.length - 1]]];
        const pile = members.length > 1;
        const phases = members.map((m) => playPhase(timeline.stops[reached[m]], currentQ, { day, past }));
        const currentIndex = phases.indexOf('current');
        const dim = phases.every((phase) => phase === 'past');
        const label = pile
            ? stackLabel(members.map((m) => labels.get(timeline.stops[reached[m]].key) || ''))
            : labels.get(head.key) || '';
        if (pile) piles.push(label);
        const paint = paintOfStop(head);
        const styles = themed ? [themeNumberStyle(paint, label)]
            : [...(pile ? [pileShadowStyle(paint)] : []), numberedStyleFor(paint, label, { pile })];
        const scale = stopPopScale(currentQ - newest.q);
        if (scale <= 0.01) continue;
        if (scale !== 1) popping++;
        point.setCoordinates(projected[reached[rep]]);
        if (currentIndex >= 0) {
            const current = timeline.stops[reached[members[currentIndex]]];
            playStopsDrawn.current = current.key;
            if (style.play_current) {
                playStopsDrawn.ring = current.key;
                const radius = themed ? themePointRadius() + 2 : (pile ? style.size + 2 : style.size);
                drawCurrentRing(context, point, paint.fill, radius * scale, currentQ - current.q);
            }
        }
        if (dim) dimmed++;
        if (style.favorite_mark && members.some((m) => timeline.stops[reached[m]].favorite)) {
            styles.push(favoriteMarkStyle(pile));
            favorites++;
        }
        for (const s of styles) {
            if (!s) continue;
            const shown = dim ? dimmedStyle(s, DIM_PAST) : s;
            context.setStyle(scale === 1 ? shown : scaledStyle(shown, scale));
            context.drawGeometry(point);
        }
        drawn += members.length;
    }
    const bursts = style.favorite_burst ? drawFavoriteBursts(context, reached) : 0;
    playStopsDrawn = { ...playStopsDrawn, drawn, popping, piles, dimmed, favorites, bursts };
}

// Effet à l'arrivée sur une étape où un PF a été donné (favoriteBurst :
// cœurs qui s'envolent), par-dessus les pastilles. Renvoie le nombre
// d'effets en cours.
function drawFavoriteBursts(context, reached) {
    const radius = favoriteBaseRadius(false);
    const point = new ol.geom.Point([0, 0]);
    let bursts = 0;
    for (const i of reached) {
        const stop = timeline.stops[i];
        if (!stop.favorite) continue;
        const hearts = favoriteBurst(currentQ - stop.q, radius);
        if (!hearts.length) continue;
        bursts++;
        point.setCoordinates(projected[i]);
        for (const heart of hearts) {
            context.setStyle(new ol.style.Style({
                text: new ol.style.Text({
                    text: HEART,
                    font: '16px system-ui, sans-serif',
                    scale: heart.scale,
                    offsetX: heart.dx,
                    offsetY: heart.dy,
                    fill: new ol.style.Fill({ color: hexToRgba(FAVORITE_COLOR, heart.alpha) }),
                    stroke: new ol.style.Stroke({ color: `rgba(255, 255, 255, ${heart.alpha})`, width: 2 }),
                }),
            }));
            context.drawGeometry(point);
        }
    }
    return bursts;
}

// Anneau de l'étape en cours (currentRingRadius : pulse d'une seconde
// d'écran), de la couleur de l'étape, sur un voile blanc léger.
function drawCurrentRing(context, point, color, radius, elapsedQ) {
    context.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
            radius: currentRingRadius(radius, elapsedQ),
            fill: new ol.style.Fill({ color: 'rgba(255, 255, 255, 0.35)' }),
            stroke: new ol.style.Stroke({ color, width: 3 }),
        }),
    }));
    context.drawGeometry(point);
}

// Étapes passées : plus transparentes et un peu plus petites ; aperçu de la
// suite : à peine visibles. Variantes d'un style, gardées tant qu'il vit.
const DIM_PAST = { opacity: 0.4, scale: 0.85 };
const DIM_PREVIEW = { opacity: 0.3, scale: 0.8 };
const dimmedStyles = new WeakMap();

function dimmedStyle(style, { opacity, scale }) {
    let variants = dimmedStyles.get(style);
    if (!variants) dimmedStyles.set(style, (variants = new Map()));
    const key = `${opacity}:${scale}`;
    if (!variants.has(key)) {
        const copy = style.clone();
        const image = copy.getImage();
        if (image) {
            image.setOpacity(opacity);
            image.setScale(scale);
            const shift = image.getDisplacement();
            if (shift[0] || shift[1]) image.setDisplacement([shift[0] * scale, shift[1] * scale]);
        }
        const text = copy.getText();
        if (text) {
            text.setScale(scale);
            text.setOffsetX(text.getOffsetX() * scale);
            text.setOffsetY(text.getOffsetY() * scale);
            const fill = text.getFill()?.getColor();
            if (typeof fill === 'string' && fill.startsWith('#')) text.setFill(new ol.style.Fill({ color: hexToRgba(fill, opacity) }));
        }
        variants.set(key, copy);
    }
    return variants.get(key);
}

// Aperçu de la suite : étapes comptées de la journée pas encore atteintes,
// pâles, reliées depuis le géocacheur par un fil pointillé dans l'ordre du
// parcours (la nuit : celles du lendemain).
function drawPlayPreview(context, day, labels) {
    const upcoming = [];
    timeline.stops.forEach((stop, i) => {
        if (isCountedStop(stop) && stop.day === day && stop.q > currentQ) upcoming.push(i);
    });
    if (!upcoming.length) return;
    const head = headAt(timeline, currentQ);
    const coords = upcoming.map((i) => projected[i]);
    if (head) coords.unshift(ol.proj.fromLonLat([head.lon, head.lat]));
    const width = stopStyle().trail_width;
    context.setStyle(cachedStyle(`preview:line:${trailOptions(day).solid}`, () => new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: hexToRgba(trailOptions(day).solid, 0.5),
            width: Math.max(1, width * 0.5),
            lineDash: [3, 5],
        }),
    })));
    if (coords.length > 1) context.drawGeometry(new ol.geom.LineString(coords));
    const point = new ol.geom.Point([0, 0]);
    for (const i of upcoming) {
        const stop = timeline.stops[i];
        context.setStyle(dimmedStyle(numberedStyleFor(paintOfStop(stop), labels.get(stop.key) || ''), DIM_PREVIEW));
        point.setCoordinates(projected[i]);
        context.drawGeometry(point);
    }
    playStopsDrawn.preview = upcoming.length;
}

// Lieux et bases pendant la lecture, avec leur pastille de catégorie, par
// dessus la nuit : un lieu apparaît à son arrivée, une base à sa première
// journée (une seule fois, quelles que soient ses occurrences), les deux en
// grossissant. Un lieu où se trouve le géocacheur est entouré, un lieu
// quitté suit le réglage des étapes passées.
let baseFirstMemo = { timeline: null, firstQ: new Map() };

function baseFirstQ() {
    if (baseFirstMemo.timeline !== timeline) {
        const firstQ = new Map();
        for (const stop of timeline?.stops || []) {
            if (stop.kind === KIND_BASE && !(firstQ.get(stop.placeId) <= stop.q)) firstQ.set(stop.placeId, stop.q);
        }
        baseFirstMemo = { timeline, firstQ };
    }
    return baseFirstMemo.firstQ;
}

function drawPlayPlaces(context) {
    const style = stopStyle();
    const past = style.render === RENDER_THEME ? 'normal' : style.play_past;
    const day = playDay();
    const firstQ = baseFirstQ();
    const bases = new Set();
    const point = new ol.geom.Point([0, 0]);
    let places = 0;
    timeline.stops.forEach((stop, i) => {
        if (stop.kind !== KIND_BASE && stop.kind !== KIND_PLACE) return;
        const base = stop.kind === KIND_BASE;
        if (base && bases.has(stop.placeId)) return;
        const from = base ? (firstQ.get(stop.placeId) ?? stop.q) : stop.q;
        if (from > currentQ) return;
        if (base) bases.add(stop.placeId);
        const scale = stopPopScale(currentQ - from);
        if (scale <= 0.01) return;
        point.setCoordinates(projected[i]);
        const phase = base ? 'normal' : playPhase(stop, currentQ, { day, past });
        if (phase === 'current') {
            playStopsDrawn.current = stop.key;
            if (style.play_current) {
                playStopsDrawn.ring = stop.key;
                drawCurrentRing(context, point, kindColor(stop.kind), style.size * scale, currentQ - stop.q);
            }
        }
        const s = placeStyle(stop.kind, stopIconClass(stop.category, stop.icon));
        const shown = phase === 'past' ? dimmedStyle(s, DIM_PAST) : s;
        context.setStyle(scale === 1 ? shown : scaledStyle(shown, scale));
        context.drawGeometry(point);
        places++;
    });
    playStopsDrawn.places = places;
}

// Position écran (px, y vers le bas) d'une étape pour le calcul des piles ;
// `group` : sa journée.
function stackItem(coordinate, key, resolution) {
    const res = resolution || 1;
    return { x: coordinate[0] / res, y: -coordinate[1] / res, group: dayIndexes().byKey.get(key) ?? 0 };
}

// Copie d'un style à l'échelle `scale`, décalages compris (numéro posé à
// côté d'un point du thème).
function scaledStyle(style, scale) {
    const copy = style.clone();
    const image = copy.getImage();
    if (image) {
        image.setScale(scale);
        const shift = image.getDisplacement();
        if (shift[0] || shift[1]) image.setDisplacement([shift[0] * scale, shift[1] * scale]);
    }
    const text = copy.getText();
    if (text) {
        text.setScale(scale);
        text.setOffsetX(text.getOffsetX() * scale);
        text.setOffsetY(text.getOffsetY() * scale);
    }
    return copy;
}

// Pictogrammes de la tête : glyphes de Tabler Icons lus dans la feuille de
// style (le sous-ensemble ne garde que les icônes citées dans le code).
const HEAD_ICON_CLASSES = Object.freeze({
    walk: 'ti-walk',
    bike: 'ti-bike',
    car: 'ti-car',
    plane: 'ti-plane',
    night: 'ti-moon',
});
// Glyphe d'une classe Tabler lu dans la feuille de style, pour le canevas et
// les marqueurs de la carte ; null sans la police chargée.
const tablerGlyphs = new Map();

function tablerGlyph(className) {
    // Appelé à chaque rendu des lieux : un glyphe déjà lu évite la sonde.
    const known = tablerGlyphs.get(className);
    if (known) return known;
    if (!document.fonts?.check?.('16px "tabler-icons"')) return null;
    if (!tablerGlyphs.has(className)) {
        const probe = document.createElement('i');
        probe.className = `ti ${className}`;
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        document.body.appendChild(probe);
        const content = getComputedStyle(probe, '::before').content || '';
        probe.remove();
        const match = /^["'](.+)["']$/.exec(content);
        tablerGlyphs.set(className, match ? match[1] : null);
    }
    return tablerGlyphs.get(className);
}

function headGlyph(mode) {
    const className = HEAD_ICON_CLASSES[mode];
    return className ? tablerGlyph(className) : null;
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

// Carton final de synthèse : nom du parcours, puis « 5 étapes · 7,9 km »
// et les journées quand il y en a plusieurs.
function endCardText() {
    const item = listing.find((p) => p.id === selectedId);
    const counted = timeline?.stops?.filter(isCountedStop).length || 0;
    const parts = [stopsCountText(counted), formatKm(timeline?.totalKm || 0)];
    if ((timeline?.days?.length || 0) > 1) parts.push(t('${n} journées', { n: timeline.days.length }));
    return { title: item?.name || t('Fin du parcours'), subtitle: parts.join(' · ') };
}

// Dessin commun d'un carton {title, subtitle} centré au tiers haut.
function drawCard(ctx, ratio, text, alpha) {
    const font = pageFontFamily();
    const titleSize = 30 * ratio;
    const subtitleSize = 17 * ratio;
    const gap = 8 * ratio;
    const padX = 28 * ratio;
    const padY = 18 * ratio;
    ctx.save();
    ctx.globalAlpha = alpha;
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

function drawDayCard(ctx, ratio) {
    const card = playback.day_cards ? dayCardAt(timeline, currentQ) : null;
    const text = card && card.alpha > 0 ? dayCardText(card.day) : null;
    if (text) drawCard(ctx, ratio, text, card.alpha);
}

function drawEndCard(ctx, ratio) {
    const card = playback.day_cards ? endCardAt(timeline, currentQ) : null;
    if (card && card.alpha > 0) drawCard(ctx, ratio, endCardText(), card.alpha);
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
        // Le carton final allonge la chronologie : reconstruite en fin de
        // lecture, tout de suite au repos.
        if (clock.running) pendingTimeline = true;
        else applyTimeline();
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

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-sm btn-ghost-secondary parcours-duplicate';
        copy.setAttribute('aria-label', t('Dupliquer le parcours'));
        copy.title = t('Dupliquer le parcours');
        copy.innerHTML = '<i class="ti ti-copy" aria-hidden="true"></i>';
        copy.addEventListener('click', () => duplicateParcours(item.id));

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-sm btn-ghost-secondary parcours-export';
        save.setAttribute('aria-label', t('Exporter le parcours'));
        save.title = t('Exporter le parcours (sélection, ajustements, lieux)');
        save.innerHTML = '<i class="ti ti-download" aria-hidden="true"></i>';
        save.addEventListener('click', () => exportParcours(item));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-ghost-danger parcours-delete';
        remove.setAttribute('aria-label', t('Supprimer le parcours'));
        remove.title = t('Supprimer le parcours');
        remove.innerHTML = '<i class="ti ti-trash" aria-hidden="true"></i>';
        remove.addEventListener('click', () => confirmDelete(item));

        row.append(open, edit, copy, save, remove);
        return row;
    }));
}

// Copie côté serveur : sélection, ajustements, lieux et bases — jamais les
// photos ni les traces (fichiers lourds, ré-envoyables).
export async function duplicateParcours(id) {
    try {
        await fetchJson(`/api/parcours/${id}/duplicate`, { method: 'POST' });
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    await refreshParcoursList({ select: selectedId });
    showToast(t('Parcours dupliqué — les photos et traces ne sont pas copiées'), 'info');
}

function parcoursSlug(name) {
    return (name || '').toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parcours';
}

function downloadText(filename, mime, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: mime }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

// Export JSON réimportable : sélection, ajustements, lieux et bases.
export async function exportParcours(item) {
    let payload;
    try {
        payload = await fetchJson(`/api/parcours/${item.id}/export`);
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    downloadText(`parcours-${parcoursSlug(item.name)}.json`,
        'application/json', JSON.stringify(payload, null, 2));
}

// Export GPX pour le GPS : l'itinéraire reconstruit (étapes dans l'ordre,
// heures d'arrivée prévues), une route par journée.
function exportGpx() {
    if (!ordered || !inputs?.parcours) return;
    downloadText(`parcours-${parcoursSlug(inputs.parcours.name)}.gpx`,
        'application/gpx+xml',
        buildParcoursGpx({ name: inputs.parcours.name, days: ordered.days, utcOffsetMinutes: utcOffset.minutes }));
}

// Import d'un export JSON : le serveur valide le format, la plage, les
// ajustements et les lieux — tout ou rien.
async function importParcoursFile(file) {
    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch {
        showToast(t('Ce fichier n\'est pas un JSON lisible'), 'error');
        return;
    }
    try {
        await fetchJson('/api/parcours/import', { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    await refreshParcoursList({ select: selectedId });
    showToast(t('Parcours importé'), 'success');
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
    el('btnParcoursImport')?.addEventListener('click', () => el('parcoursImportInput')?.click());
    el('parcoursImportInput')?.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';           // ré-import du même fichier possible
        if (file) importParcoursFile(file);
    });
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
        const updateParcours = async (id, extra = {}) => {
            const body = await fetchJson(`/api/parcours/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ ...payload, ...extra }),
            });
            cancelEditParcours();
            // Rechargement complet : dates, Labs et DNF changent les
            // entrées du parcours.
            await refreshParcoursList({ select: body.parcours.id });
        };
        let editedId = null;
        try {
            if (editingParcoursId !== null) {
                editedId = editingParcoursId;
                await updateParcours(editedId);
            } else {
                const body = await fetchJson('/api/parcours', {
                    method: 'POST',
                    body: JSON.stringify(payload),
                });
                el('parcoursName').value = '';
                await refreshParcoursList({ select: body.parcours.id });
            }
        } catch (error) {
            // 'out-of-range' : le rétrécissement laisserait des lieux ou des
            // ajustements dehors — confirmation puis renvoi avec drop_orphans.
            if (error.code === 'out-of-range' && editedId !== null) {
                const detail = error.detail || {};
                const parts = [];
                if (detail.places) parts.push(t('${n} lieux ou bases seront supprimés', { n: detail.places }));
                if (detail.days) parts.push(t('${n} étapes retrouveront leur journée d’origine', { n: detail.days }));
                const id = editedId;
                showConfirmation(
                    t('La nouvelle plage laisse des éléments dehors : ${items}.', { items: parts.join(' ; ') }),
                    t('Raccourcir le parcours'),
                    () => updateParcours(id, { drop_orphans: true })
                        .catch((err) => showToast(err.message, 'error')),
                    null,
                    { danger: true, confirmText: t('Raccourcir quand même') },
                );
            } else {
                showToast(error.message, 'error');
            }
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
    let total = 0;
    try {
        const body = await fetchJson('/api/parcours/suggestions');
        next = Array.isArray(body.suggestions) ? body.suggestions : [];
        total = typeof body.total === 'number' ? body.total : next.length;
    } catch (error) {
        console.warn('[PARCOURS] Suggestions indisponibles :', error);
    }
    if (seq !== suggestionsSeq) return;
    suggestions = next;
    suggestionsTotal = total;
    suggestionsExpanded = false;
    renderSuggestions();
}

// « … et N autres » : le serveur a plafonné la réponse, on la redemande
// entière (limit=0) pour tout afficher.
async function expandSuggestions() {
    const seq = ++suggestionsSeq;
    try {
        const body = await fetchJson('/api/parcours/suggestions?limit=0');
        if (seq !== suggestionsSeq) return;
        suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
        suggestionsTotal = suggestions.length;
        suggestionsExpanded = true;
        renderSuggestions();
    } catch (error) {
        console.warn('[PARCOURS] Suggestions complètes indisponibles :', error);
    }
}


function renderSuggestions() {
    const box = el('parcoursSuggestions');
    const list = el('parcoursSuggestionList');
    if (!box || !list) return;
    box.hidden = suggestions.length === 0;
    const children = suggestions.map((item) => {
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
    });
    const remaining = suggestionsTotal - suggestions.length;
    if (!suggestionsExpanded && remaining > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.id = 'btnParcoursSuggestionsMore';
        more.className = 'btn btn-sm btn-link parcours-suggestion-more';
        more.textContent = t('… et ${n} autres', { n: remaining });
        more.addEventListener('click', () => expandSuggestions());
        children.push(more);
    }
    list.replaceChildren(...children);
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


// Catégories d'affichage des lieux et bases (parcours_store.PLACE_CATEGORIES) :
// icône et libellé — le comportement reste celui du `kind`.
const PLACE_CATEGORIES = Object.freeze(['other', 'parking', 'meal', 'viewpoint', 'lodging', 'supply', 'custom']);
// Icônes proposées pour la catégorie « custom » (toutes présentes dans la
// fonte embarquée).
const CUSTOM_ICONS = Object.freeze([
    'ti-flag', 'ti-tent', 'ti-car', 'ti-bus', 'ti-sailboat', 'ti-anchor', 'ti-horse',
    'ti-bike', 'ti-swimming', 'ti-fish', 'ti-tree', 'ti-mountain', 'ti-building-castle',
    'ti-building-arch', 'ti-building-pavilion', 'ti-tower', 'ti-coffee', 'ti-beer',
    'ti-ice-cream', 'ti-campfire',
]);


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


// Gestes communs au panneau d'ajustement et à la bulle de la carte. Heure
// épinglée : celle du lieu pour un lieu posé, un ajustement pour une étape
// comptée ; `null` la retire.
function pinnedTimeOf(stop) {
    return stop.kind === KIND_PLACE ? placeOf(stop)?.time || null : overrideOf(stop.key)?.pinnedTime || null;
}

function pinStopTime(stop, time) {
    if (time === '') return;
    if (stop.kind === KIND_PLACE) updatePlace(stop.placeId, { time });
    else saveOverrides([{ key: stop.key, pinnedTime: time }]);
}

function excludeStop(stop) {
    if (stopsPanel.getEditKey() === stop.key) stopsPanel.setEditKey(null);
    saveOverrides([{ key: stop.key, excluded: true, rank: null }]);
}

// Panneau d'ajustement d'une étape ouvert dans la liste (onglet Données).
function openStopDetails(key) {
    stopsPanel.openDetails(key);
}

// --- Ajustements : écriture puis reconstruction ---------------------------------

// Moteur des ajustements (parcours_adjust.mjs) : file d'écritures, fusion
// locale, historique Annuler/Rétablir, gestes de rang/journée, CRUD des
// lieux. Les fonctions ci-dessous ne font que déléguer — les panneaux, la
// bulle de la carte et les déplacements carte les utilisent.
const adjust = createParcoursAdjust({
    getState: () => ({ selectedId, inputs, ordered }),
    fetchJson,
    rebuild,
    renderStops,
    applyTimeline,
    renderLayer,
    linkPhoto: (id, key) => photosPanel.linkPhoto(id, key),
    clockRunning: () => clock.running,
});

function adjustmentsLocked() { return adjust.locked(); }
function receiveAdjustments(payload, forId = selectedId) { adjust.receive(payload, forId); }
async function reloadAdjustments(forId = selectedId, options = {}) { return adjust.reload(forId, options); }
function saveOverrides(patches) { adjust.save(patches); }
function updateUndoButtons() { adjust.updateButtons(); }
function reorderDay(keys) { adjust.reorderDay(keys); }
function moveStop(day, key, delta) { adjust.moveStop(day, key, delta); }
function moveStopToDay(day, key, index) { adjust.moveStopToDay(day, key, index); }
function resetDayOrder(day) { adjust.resetDayOrder(day); }
function resetAllAdjustments() { adjust.resetAll(); }
function undoAdjustment() { adjust.undo(); }
function redoAdjustment() { adjust.redo(); }
function pushHistory(entry) { adjust.push(entry); }
function placeById(id) { return adjust.placeById(id); }
async function createPlace(data, options) { return adjust.createPlace(data, options); }
async function updatePlace(id, data) { return adjust.updatePlace(id, data); }
async function deletePlace(id, options) { return adjust.deletePlace(id, options); }

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
    el('btnParcoursUndo')?.addEventListener('click', undoAdjustment);
    el('btnParcoursRedo')?.addEventListener('click', redoAdjustment);
    // Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z) sur la page, hors champs de saisie.
    document.addEventListener('keydown', (event) => {
        if (!selectedId || !(event.ctrlKey || event.metaKey)) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                || document.activeElement?.isContentEditable) return;
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) {
            event.preventDefault();
            undoAdjustment();
        } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
            event.preventDefault();
            redoAdjustment();
        }
    });
    el('btnParcoursCollapseDays')?.addEventListener('click', () => stopsPanel.toggleCollapseAll());
    el('btnParcoursExportGpx')?.addEventListener('click', exportGpx);
    placeForm.bind();
}

// --- Photos (lot 4) -------------------------------------------------------------

// Image chargée de chaque photo, pour la carte postale de la lecture et de la
// vidéo : même origine que la page, le canevas reste exportable.
const photoImages = new Map();   // id → HTMLImageElement
const photoThumbs = new Map();   // id → HTMLImageElement (vignettes laissées sur la carte)
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

function loadPhotoImage(id, thumb) {
    const cache = thumb ? photoThumbs : photoImages;
    if (cache.has(id)) return;
    const img = new Image();
    img.decoding = 'async';
    // En pause ou au repos, la prochaine image peinte attendrait un geste :
    // invalider la couche pour que la carte apparaisse dès l'image reçue.
    img.onload = () => playHeadLayer?.changed();
    img.src = photoUrl({ id }, thumb);
    cache.set(id, img);
}

// Pleine taille préchargée dans une fenêtre autour de la position de
// lecture : assez d'avance pour finir le téléchargement avant que la
// carte n'apparaisse, et une marge derrière pour l'effacement et un petit
// retour en arrière. Les créneaux lointains ne sont pas chargés — sur un
// long parcours très illustré, l'ouverture ne télécharge plus des
// centaines de photos 2048 px.
const PHOTO_AHEAD_Q = 40;     // ~4 jours devant la tête
const PHOTO_BEHIND_Q = 8;     // effacement + petit retour en arrière

// Pleines tailles des créneaux proches de `currentQ`. Relancée à chaque
// image de la lecture : le `break` sur les créneaux triés la rend quasi
// gratuite, seuls les entrants dans la fenêtre déclenchent un chargement.
function ensurePhotosNear() {
    if (!timeline) return;
    for (const slot of photoSlots(timeline)) {
        if (slot.toQ + PHOTO_FADE_Q < currentQ - PHOTO_BEHIND_Q) continue;
        if (slot.fromQ > currentQ + PHOTO_AHEAD_Q) break;
        loadPhotoImage(slot.photoId, false);
    }
}

// Charge (une fois) les photos rattachées : la carte postale n'est dessinée
// qu'une fois l'image décodée. Les miniatures servent aux vignettes laissées
// sur la carte : des dizaines à chaque image, réduites depuis 320 px plutôt
// que depuis la photo entière — elles sont toutes chargées, épinglables à
// n'importe quel moment de la lecture. Les pleines tailles ne le sont que
// près de la tête, sauf `all` (enregistrement : toute la chronologie est
// filmée, tout doit être prêt).
function preloadPhotos(all = false) {
    const byId = new Map();
    for (const photo of inputs?.photos || []) byId.set(photo.id, photo);
    for (const ids of photoByStop.values()) {
        for (const id of ids) if (byId.has(id)) loadPhotoImage(id, true);
    }
    if (all) {
        for (const ids of photoByStop.values()) {
            for (const id of ids) if (byId.has(id)) loadPhotoImage(id, false);
        }
    } else {
        ensurePhotosNear();
    }
}

const imageReady = (img) => !!img?.complete && img.naturalWidth > 0;

// Résolue quand toutes les photos chargées sont décodées (ou en échec), au
// plus tard après `timeoutMs` — comme `imagesReady` de l'onglet Images :
// attendue avant la première frame d'un enregistrement pour qu'une photo
// encore en vol ne manque pas dans la vidéo. Hors de la page, ou sans photo,
// résout immédiatement.
export function parcoursPhotosReady(timeoutMs = 3000) {
    preloadPhotos(true);
    const pending = [];
    for (const cache of [photoImages, photoThumbs]) {
        for (const img of cache.values()) {
            if (!imageReady(img)) pending.push(img.decode().catch(() => {}));
        }
    }
    if (!pending.length) return Promise.resolve(true);
    return Promise.race([
        Promise.all(pending).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
}

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
    ensurePhotosNear();
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
    const ok = pkg.seekAnimationToDate?.(dateOfDayIndex(quantumBase, q)) !== false;
    if (ok) ensurePhotosNear();
    return ok;
}

// --- Photos : panneau, envois et glisser-déposer -----------------------------
// parcours_photos_panel.mjs / parcours_upload.mjs : l'état du parcours ouvert
// arrive par getState(), les opérations transverses sont injectées.

const uploads = createParcoursUploads({
    getSelectedId: () => selectedId,
    reloadAdjustments,
});

const photosPanel = createPhotosPanel({
    getState: () => ({ inputs, ordered, photoMatches, timeline, selectedId }),
    uploads,
    button,
    fetchJson,
    reloadAdjustments,
    receiveAdjustments,
    adjustmentsLocked,
    stopByKey,
    createPlace,
    previewPhoto,
    evictPhotoImages: (id) => { photoImages.delete(id); photoThumbs.delete(id); },
    getMap: () => pkg.getMap?.(),
    getPhotoDisplay: () => photoDisplay,
    setPhotoDisplay: (next) => { photoDisplay = next; },
    clockRunning: () => clock.running,
    deferTimeline: () => { pendingTimeline = true; },
    applyTimeline: () => applyTimeline(),
});

// --- Traces GPS (lot 5) ---------------------------------------------------------

const tracksPanel = createTracksPanel({
    getState: () => ({ inputs, ordered, utcOffset, homeCenter, trackMatches, selectedId }),
    button,
    fetchJson,
    adjustmentsLocked,
    runUpload: uploads.run,
    reloadAdjustments,
    receiveAdjustments,
    cancelUploads: uploads.cancel,
});

// --- Pose d'un lieu et liste des étapes ------------------------------------------

const placeForm = createPlaceForm({
    getState: () => ({ ordered }),
    adjustmentsLocked,
    createPlace,
    updatePlace,
    button,
    renderLayer,
    getMap: () => pkg.getMap?.(),
    customIcons: CUSTOM_ICONS,
});

const stopsPanel = createStopsPanel({
    getState: () => ({ status, ordered, inputs, counts, logsAvailable, photoByStop }),
    button,
    pruneHoverRows: () => { mapHoverRows = mapHoverRows.filter((row) => row.isConnected); },
    updateUndoButtons,
    setHoveredStop,
    saveOverrides,
    createPlace,
    updatePlace,
    deletePlace,
    adjustmentsLocked,
    reorderDay,
    moveStop,
    moveStopToDay,
    resetDayOrder,
    overrideOf,
    placeOf,
    pinnedTimeOf,
    pinStopTime,
    excludeStop,
    startPlaceMove: (place) => placeForm.startMove(place),
    buildIconPicker: (container, selected, onPick) => placeForm.buildIconPicker(container, selected, onPick),
    stopStyle,
    dayIndexes,
    paintOfStop,
    currentStopLabels,
    placeCategories: PLACE_CATEGORIES,
    customIcons: CUSTOM_ICONS,
    getMap: () => pkg.getMap?.(),
    showDataTab: () => pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]')),
});

function renderStops(errorMessage = '') {
    stopsPanel.render(errorMessage);
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
    // Erreur ou annulation : suspendues jusqu'à une action de l'utilisateur.
    if ((routeState.state === 'error' || routeState.state === 'cancelled') && !force) return;
    const runs = force ? routeRunsNow : pendingRuns(routeRunsNow, routeCache);
    if (runs.length === 0) {
        renderRouting();
        return;
    }
    const seq = ++routeSeq;
    const total = runs.reduce((n, run) => n + run.keys.length, 0);
    let done = 0;
    routeState = { state: 'loading', message: '', done, total };
    renderRouting();
    let message = '';
    let failed = false;
    for (const run of runs) {
        let body;
        try {
            body = await fetchJson('/api/parcours/routes', {
                method: 'POST',
                body: JSON.stringify({ profile: run.profile, waypoints: run.waypoints, force }),
                // Le serveur chaîne des appels fournisseur temporisés
                // (throttle + découverte des trajets sans route).
                timeoutMs: 300_000,
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
        done += run.keys.length;
        routeState = { state: 'loading', message: '', done, total };
        renderRouting();
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
    const loading = config.enabled && routeState.state === 'loading';
    const cancel = el('btnParcoursRoutesCancel');
    if (cancel) cancel.hidden = !loading;
    // « Réessayer » : proposé après un échec ou une annulation — reprend le
    // calcul sans ignorer le cache, là où « Recalculer » redemande tout.
    const retry = el('btnParcoursRoutesRetry');
    if (retry) retry.hidden = !(config.enabled && (routeState.state === 'error' || routeState.state === 'cancelled'));
    const progress = el('parcoursRoutesProgress');
    if (progress) {
        progress.hidden = !loading;
        progress.max = routeState.total || 1;
        progress.value = routeState.done || 0;
    }
    const routed = routeEffectsNow.paths.size;
    const legs = routeRunsNow.reduce((total, run) => total + run.keys.length, 0);
    if (!config.enabled) status.textContent = '';
    else if (routeState.state === 'loading') {
        status.textContent = t('Calcul des itinéraires : ${done} / ${total} trajets…',
            { done: routeState.done || 0, total: routeState.total || '?' });
    }
    else if (routeState.state === 'error') status.textContent = routeState.message || t('Itinéraires indisponibles : trajets en ligne droite.');
    else if (routeState.state === 'cancelled') {
        status.textContent = t('Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.', { routed, legs });
    }
    else {
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
    el('btnParcoursRoutesRetry')?.addEventListener('click', () => {
        if (adjustmentsLocked()) return;
        routeState = { state: 'idle', message: '' };
        ensureRoutes();
    });
    el('btnParcoursRoutesCancel')?.addEventListener('click', () => {
        // La boucle meurt après sa requête en cours ; les itinéraires déjà
        // reçus restent en cache et s'affichent tout de suite. Comme une
        // erreur, l'annulation suspend les relances automatiques — une
        // reconstruction ne repartirait pas sans « Recalculer ».
        routeSeq++;
        routeState = { state: 'cancelled', message: '' };
        rebuild();
        renderStops();
        applyTimeline();
        renderRouting();
    });
}

// --- Onglet Style : étapes et trait (points.parcours_style) -------------------------
//
// Carte « Étapes du parcours » (menu_points.html) et sous-onglet Trajet de la
// page (menu_trail_parcours.html). Réglages du thème : le suivi « modifié » du
// thème les voit passer (profiles.js écoute l'onglet Style), sans
// enregistrement ici.


// Panneau « Style du parcours » : contrôles de la carte Étapes
// (parcours_style_ui.mjs). L'écriture dans le thème et le rafraîchissement
// restent ici.
const styleUI = createParcoursStyleUI({
    getStyle: stopStyle,
    commitStyle: commitParcoursStyle,
    renderTheme: RENDER_THEME,
});

function commitParcoursStyle(style) {
    if (!pkg.options?.point) return;
    pkg.options.point.parcoursStyle = style;
    styleUI.sync();
    parcoursStyleChanged();
}

// Le plan et la liste suivent tout de suite ; la lecture relit le style à
// chaque image. Aussi appelé par mapgl.js quand la couche de points est
// recréée (chargement d'un thème : moteur › styleChanged).
function parcoursStyleChanged() {
    pkg.syncSoloLayers?.();
    renderLayer();
    renderStops();
}

// Reflète le thème dans les contrôles (même contrat que syncPointOptionsUI,
// qui l'appelle au chargement d'un thème).
export function syncParcoursStyleUI() {
    styleUI.sync();
}

function bindParcoursStyle() {
    styleUI.bind();
}

// --- Carte ----------------------------------------------------------------------

// Apparence des étapes et du trait : bloc du thème `points.parcours_style`
// (parcours_style.mjs). Normalisé une fois par objet de réglages — l'onglet
// Style et le chargement d'un thème le REMPLACENT, ils ne le modifient pas
// en place — avec les styles OpenLayers qui en découlent (`cache`), refaits
// au changement.
let styleMemo = { raw: undefined, value: null, cache: new Map() };

function stopStyle() {
    const raw = pkg.options?.point?.parcoursStyle;
    if (styleMemo.raw !== raw || !styleMemo.value) {
        styleMemo = { raw, value: normalizeParcoursStyle(raw), cache: new Map() };
    }
    return styleMemo.value;
}

function cachedStyle(key, build) {
    stopStyle();
    if (!styleMemo.cache.has(key)) styleMemo.cache.set(key, build(styleMemo.value));
    return styleMemo.cache.get(key);
}

function kindColor(kind) {
    const colors = stopStyle().colors;
    return colors[kind] || colors.find;
}

// Rang de la journée de chaque étape (clé) et de chaque date, dans la plage
// du parcours (jours vides compris) : index de la couleur par journée.
let dayMemo = { ordered: null, byKey: new Map(), byDate: new Map() };

function dayIndexes() {
    if (dayMemo.ordered !== ordered) {
        const byKey = new Map();
        const byDate = new Map();
        (ordered?.days || []).forEach((day, i) => {
            byDate.set(day.date, i);
            for (const stop of day.stops) byKey.set(stop.key, i);
            for (const stop of day.excluded || []) byKey.set(stop.key, i);
        });
        dayMemo = { ordered, byKey, byDate };
    }
    return dayMemo;
}

// Peinture d'une étape (`{ key, kind, type }`) selon « Couleur des étapes » :
// par nature, par journée, par type de cache (couleurs Geocaching).
function paintOfStop(stop) {
    return stopPaint(stop, stopStyle(), {
        dayIndex: dayIndexes().byKey.get(stop.key) ?? 0,
        typeColors: pkg.defaultGcColors || null,
    });
}

function featurePaint(feature) {
    return paintOfStop({ key: feature.get('key'), kind: feature.get('kind'), type: feature.get('type') });
}

// Numéro affiché de chaque étape (clé → texte), selon le réglage « Numéros
// des étapes » : recalculé quand la reconstruction ou le réglage change.
let labelMemo = { ordered: null, numbers: null, labels: new Map() };

function currentStopLabels() {
    const { numbers } = stopStyle();
    if (labelMemo.ordered !== ordered || labelMemo.numbers !== numbers) {
        labelMemo = { ordered, numbers, labels: stopNumberLabels(ordered, numbers) };
    }
    return labelMemo.labels;
}

// Halo dessiné sous l'étape dont la ligne est survolée (et réciproquement).
// Anneau en pointillés : point provisoire, posé au clic, en attente de la
// validation du formulaire. Rayon : 6 px de plus que la pastille.
function haloStyle(draft = false) {
    return cachedStyle(draft ? 'halo:draft' : 'halo', ({ size }) => new ol.style.Style({
        image: new ol.style.Circle({
            radius: size + 6,
            fill: new ol.style.Fill({ color: `rgba(32, 107, 196, ${draft ? 0.10 : 0.18})` }),
            stroke: new ol.style.Stroke({ color: 'rgba(32, 107, 196, 0.9)', width: 2, lineDash: draft ? [5, 4] : undefined }),
        }),
    }));
}

// Classe d'icône de catégorie portée par une feature du plan (lieu, base ou
// brouillon de pose) : « custom » lit l'icône libre.
function featureIconClass(feature) {
    return stopIconClass(feature.get('category'), feature.get('icon'));
}

function stopIconClass(category, icon) {
    if (category === 'custom') return /^ti-[a-z0-9-]+$/.test(icon || '') ? icon : null;
    return CATEGORY_ICONS[category] || null;
}

function pointStyle(feature) {
    const kind = feature.get('kind');
    // Étape cachée dans une pile, ou pile ouverte en éventail : rien (ni
    // dessin ni clic) — la pile ou l'éventail la représente.
    if (feature.get('stacked') || (fan && fan.repKey === feature.get('key'))) return null;
    const pile = (feature.get('stackKeys')?.length || 0) > 1;
    let normal;
    if (kind === KIND_BASE || kind === KIND_PLACE) {
        normal = placeStyle(kind, featureIconClass(feature));
    } else if (stopStyle().render === RENDER_THEME) {
        normal = themeNumberStyle(featurePaint(feature), featureLabel(feature), { hit: true });
    } else {
        normal = pile ? [pileShadowStyle(featurePaint(feature)), numberedStyle(feature)] : numberedStyle(feature);
    }
    if (featureShowsFavorite(feature)) normal = [...(Array.isArray(normal) ? normal : [normal]), favoriteMarkStyle(pile)];
    const styles = Array.isArray(normal) ? normal : [normal];
    return feature.get('hovered') ? [haloStyle(), ...styles] : normal;
}

// Cœur d'un PF donné sur une étape du plan (une pile : si l'une de ses
// étapes en a un), selon « Marquer les PF donnés » du thème.
function featureShowsFavorite(feature) {
    const kind = feature.get('kind');
    if (kind === KIND_BASE || kind === KIND_PLACE || !stopStyle().favorite_mark) return false;
    return (feature.get('stackKeys')?.length || 0) > 1 ? !!feature.get('stackFavorite') : !!feature.get('favorite');
}

// Rayon du marqueur auquel le cœur s'accroche : la pastille (une pile : un
// peu plus grande), ou le point du thème.
function favoriteBaseRadius(pile) {
    const style = stopStyle();
    if (style.render === RENDER_THEME) return themePointRadius();
    return pile ? style.size + 2 : style.size;
}

// Cœur sur un rond blanc, en haut à gauche de l'étape (favoriteBadge).
function favoriteMarkStyle(pile = false) {
    const base = favoriteBaseRadius(pile);
    return cachedStyle(`fav:${base}`, () => {
        const { radius, offset } = favoriteBadge(base);
        return new ol.style.Style({
            image: new ol.style.Circle({
                radius,
                displacement: offset,
                fill: new ol.style.Fill({ color: '#ffffff' }),
                stroke: new ol.style.Stroke({ color: FAVORITE_COLOR, width: 1.5 }),
            }),
            text: new ol.style.Text({
                text: HEART,
                font: `${Math.max(8, Math.round(radius * 1.4))}px system-ui, sans-serif`,
                fill: new ol.style.Fill({ color: FAVORITE_COLOR }),
                // Texte : y vers le bas, à l'inverse de `displacement`.
                offsetX: offset[0],
                offsetY: -offset[1] + 0.5,
            }),
        });
    });
}

// Pastille d'une étape comptée, avec son numéro (aucun : pastille seule).
// Le texte passe en sombre sur une couleur claire ; trois chiffres et plus
// sont écrits plus petit pour tenir dans la pastille. Pastille creuse (DNF
// hors couleur par nature) : fond blanc, contour et numéro de la couleur.
function numberedStyle(feature) {
    return numberedStyleFor(featurePaint(feature), featureLabel(feature),
        { pile: (feature.get('stackKeys')?.length || 0) > 1 });
}

// Numéro affiché par une feature d'étape : celui de sa pile si elle en est
// la tête.
function featureLabel(feature) {
    return feature.get('stackLabel') || feature.get('label') || '';
}

function paintedCircle(paint, radius, width, extra = {}) {
    return new ol.style.Circle({
        radius,
        fill: new ol.style.Fill({ color: paint.hollow ? '#ffffff' : paint.fill }),
        stroke: new ol.style.Stroke({ color: paint.hollow ? paint.fill : '#ffffff', width: paint.hollow ? width + 0.5 : width }),
        ...extra,
    });
}

// Pile : pastille un peu plus grande, posée sur une seconde (pileShadowStyle).
function numberedStyleFor(paint, label, { pile = false } = {}) {
    return cachedStyle(`stop:${paint.fill}:${paint.hollow ? 1 : 0}:${label}:${pile ? 1 : 0}`, ({ size }) => new ol.style.Style({
        image: paintedCircle(paint, pile ? size + 2 : size, 2),
        text: label ? new ol.style.Text({
            text: label,
            font: `600 ${numberFontPx(pile ? size + 2 : size, label)}px system-ui, sans-serif`,
            fill: new ol.style.Fill({ color: paintTextColor(paint) }),
        }) : undefined,
    }));
}

// Seconde pastille d'une pile, décalée en haut à droite derrière la
// première : on voit qu'il y en a plusieurs.
function pileShadowStyle(paint) {
    return cachedStyle(`pile:${paint.fill}:${paint.hollow ? 1 : 0}`, ({ size }) => new ol.style.Style({
        image: paintedCircle(paint, size + 2, 2, { displacement: [4, 4] }),
    }));
}

// Éventail d'une pile ouverte : les étapes à leur place autour du centre,
// reliées à lui par un fil, au-dessus du reste du plan (zIndex).
const FAN_Z = 20;

function fanStopStyle(feature) {
    const base = numberedStyleFor(featurePaint(feature), feature.get('label') || '');
    const style = cachedStyle(`fan:${featurePaint(feature).fill}:${featurePaint(feature).hollow ? 1 : 0}:${feature.get('label') || ''}`,
        () => {
            const copy = base.clone();
            copy.setZIndex(FAN_Z + 2);
            return copy;
        });
    const styles = [style];
    if (stopStyle().favorite_mark && feature.get('favorite')) {
        styles.push(cachedStyle('fan:fav', () => {
            const copy = favoriteMarkStyle(false).clone();
            copy.setZIndex(FAN_Z + 3);
            return copy;
        }));
    }
    return feature.get('hovered') ? [haloStyle(), ...styles] : styles;
}

function fanLineStyle() {
    return cachedStyle('fan:line', () => new ol.style.Style({
        stroke: new ol.style.Stroke({ color: 'rgba(33, 37, 41, 0.55)', width: 1.5 }),
        zIndex: FAN_Z,
    }));
}

function fanCenterStyle() {
    return cachedStyle('fan:center', () => new ol.style.Style({
        image: new ol.style.Circle({
            radius: 4,
            fill: new ol.style.Fill({ color: 'rgba(33, 37, 41, 0.75)' }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 }),
        }),
        zIndex: FAN_Z + 1,
    }));
}

// Rendu « points du thème » : le point est celui du thème (couche WebGL) ;
// le plan n'y ajoute que le numéro, dans une petite pastille en haut à
// droite (rien sans numéro). Au repos (`hit`), un disque invisible de la
// taille d'une pastille garde l'étape survolable et cliquable.
const HIT_FILL = 'rgba(255, 255, 255, 0.01)';

// Rayon approché du point du thème (centre + contour), pour poser le numéro
// à côté.
function themePointRadius() {
    const point = pkg.options?.point || {};
    const center = Math.max(1, parseInt(point.center?.size, 10) || 3);
    const border = point.border?.mode === 'none' ? 0 : Math.max(0, parseInt(point.border?.size, 10) || 0) / 5;
    return center + border;
}

function themeNumberStyle(paint, label, { hit = false } = {}) {
    const themeRadius = themePointRadius();
    const key = `theme:${paint.fill}:${paint.hollow ? 1 : 0}:${label}:${hit ? 1 : 0}:${themeRadius}`;
    return cachedStyle(key, ({ size }) => {
        const styles = [];
        if (hit) {
            styles.push(new ol.style.Style({
                image: new ol.style.Circle({ radius: Math.max(size, themeRadius), fill: new ol.style.Fill({ color: HIT_FILL }) }),
            }));
        }
        if (label) {
            const { radius, offset } = themeNumberBadge(size, themeRadius);
            styles.push(new ol.style.Style({
                image: paintedCircle(paint, radius, 1.5, { displacement: offset }),
                text: new ol.style.Text({
                    text: label,
                    font: `600 ${numberFontPx(radius, label)}px system-ui, sans-serif`,
                    fill: new ol.style.Fill({ color: paintTextColor(paint) }),
                    // Texte : y vers le bas, à l'inverse de `displacement`.
                    offsetX: offset[0],
                    offsetY: -offset[1],
                }),
            }));
        }
        return hit ? styles : (styles[0] || null);
    });
}

// Lieu : rond ; base : carré — à la couleur du type (thème, violet et
// anthracite par défaut), avec au centre, en blanc, le pictogramme de la
// catégorie (à défaut, celui du type : drapeau, maison). Un seul symbole,
// lisible d'un coup d'œil. Sans la police chargée : la forme seule (la clé
// change quand elle arrive). Communs au plan et à la lecture, à l'échelle
// des pastilles.
function placeStyle(kind, iconClass = null) {
    const glyph = tablerGlyph(iconClass || KIND_ICONS[kind]);
    return cachedStyle(`place:${kind}:${glyph || ''}`, ({ size }) => {
        const fill = new ol.style.Fill({ color: kindColor(kind) });
        const stroke = new ol.style.Stroke({ color: '#ffffff', width: 2 });
        // Carré posé sur sa base : rayon = demi-diagonale, côté ≈ diamètre
        // du rond.
        const image = kind === KIND_BASE
            ? new ol.style.RegularShape({ points: 4, radius: Math.round((size + 2) * 1.35), angle: Math.PI / 4, fill, stroke })
            : new ol.style.Circle({ radius: size + 2, fill, stroke });
        return new ol.style.Style({
            image,
            text: glyph ? new ol.style.Text({
                text: glyph,
                font: `${Math.max(11, Math.round(size * 1.45))}px "tabler-icons"`,
                fill: new ol.style.Fill({ color: '#ffffff' }),
            }) : undefined,
        });
    });
}

// Ligne d'une journée au repos : couleur (aux couleurs des journées, celle
// de la journée) et épaisseur du trait, plus transparente ; pointillés,
// pleine, ou aucune (null).
function lineStyle(dayIndex = 0) {
    const color = trailColorFor(stopStyle(), dayIndex);
    return cachedStyle(`line:${color}`, (style) => {
        if (style.plan_line === 'none') return null;
        const width = style.trail_width;
        const dashed = style.plan_line === 'dashed';
        return new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: hexToRgba(color, PLAN_LINE_ALPHA * style.trail_opacity / 100),
                width,
                // Bouts ronds : ils allongeraient les tirets.
                lineCap: dashed ? 'butt' : 'round',
                lineJoin: 'round',
                lineDash: dashed ? [2 * width, 2 * width] : undefined,
            }),
        });
    });
}

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
                if (role === 'line') return lineStyle(dayIndexes().byDate.get(feature.get('date')) ?? 0);
                if (role === 'fan') return fanStopStyle(feature);
                if (role === 'fanline') return fanLineStyle();
                if (role === 'fancenter') return fanCenterStyle();
                if (role === 'draft') {
                    const kind = feature.get('kind');
                    return [haloStyle(true), placeStyle(kind, featureIconClass(feature))];
                }
                return pointStyle(feature);
            },
        });
        parcoursLayer.set('name', 'parcours');
    }
    if (!map.getLayers().getArray().includes(parcoursLayer)) map.addLayer(parcoursLayer);
    bindMapLink(map);
    return parcoursLayer;
}

// Lien liste ↔ carte : survoler un point du plan surligne sa ligne dans la
// liste ; le survol d'une ligne met le point en évidence (halo) via
// `setHoveredStop`. Agir depuis la carte, au repos :
// - clic sur une étape : bulle d'actions (moteur › popupAt, bulle de
//   mapgl.js), sa ligne amenée dans la liste ;
// - glisser un lieu, une base ou le point provisoire de la pose ;
// - clic droit : la bulle de l'étape, ou « Poser un lieu / une base ici ».
let dragging = false;         // un repère est en train d'être glissé

function planFeatureAt(map, pixel, roles = ['stop']) {
    return map.forEachFeatureAtPixel(pixel,
        (f) => (roles.includes(f.get('role')) ? f : null),
        { layerFilter: (layer) => layer === parcoursLayer, hitTolerance: 5 });
}

function isDraggable(feature) {
    const role = feature.get('role');
    if (role === 'draft') return true;
    // Étape comptée (lot 15) : seule, ou sortie de sa pile par l'éventail.
    if (role === 'fan') return true;
    if (role !== 'stop') return false;
    const kind = feature.get('kind');
    if (kind === KIND_PLACE || kind === KIND_BASE) return feature.get('placeId') != null;
    return (feature.get('stackKeys')?.length || 0) < 2;
}

function bindMapLink(map) {
    if (hoverBound) return;
    hoverBound = true;
    map.on('pointermove', (event) => {
        if (event.dragging || dragging) return;
        const feature = planFeatureAt(map, event.pixel, ['stop', 'draft', 'fan']);
        highlightRowsFor(feature?.get('role') === 'draft' ? null : feature);
        const target = map.getTargetElement();
        if (target && !placeForm.isPicking()) target.style.cursor = feature ? (isDraggable(feature) ? 'grab' : 'pointer') : '';
    });
    bindPlanDrag(map);
    map.getViewport().addEventListener('contextmenu', (event) => onMapContextMenu(map, event));
    // Piles recalculées à chaque changement de zoom (éventail refermé).
    map.on('moveend', () => {
        if (map.getView().getResolution() === stackResolution) return;
        closeFan();
        updateStacks();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeFan();
    });
}

// --- Étapes empilées --------------------------------------------------------------
//
// Au repos, les étapes comptées d'une même journée qui se recouvrent au zoom
// courant forment une pile (parcours_stack.mjs) : la première étape en
// porte le libellé (`stackKeys`, `stackLabel`), les autres sont cachées
// (`stacked`). Un clic l'écarte en éventail (`fan`) : features `fan`
// (une par étape, cliquables : bulle), `fanline`, `fancenter`, retirées à la
// fermeture (clic ailleurs, Échap, zoom, plan refait).
let stackResolution = null;
let fan = null;               // { repKey, keys } de la pile ouverte

function stackableFeatures(source) {
    return source.getFeatures()
        .filter((f) => f.get('role') === 'stop' && f.get('kind') !== KIND_PLACE && f.get('kind') !== KIND_BASE)
        .sort((a, b) => (a.get('index') ?? 0) - (b.get('index') ?? 0));
}

function updateStacks() {
    const map = pkg.getMap?.();
    const source = parcoursLayer?.getSource();
    if (!map || !source) return;
    const resolution = map.getView().getResolution();
    stackResolution = resolution;
    const stops = stackableFeatures(source);
    for (const f of stops) f.setProperties({ stacked: false, stackKeys: null, stackLabel: null, stackFavorite: false }, true);
    if (resolution) {
        const stacks = stackStops(stops.map((f) => stackItem(f.getGeometry().getCoordinates(), f.get('key'), resolution)),
            stopStyle().size * STACK_DISTANCE);
        for (const { rep, members } of stacks) {
            if (members.length < 2) continue;
            stops[rep].setProperties({
                stackKeys: members.map((m) => stops[m].get('key')),
                stackLabel: stackLabel(members.map((m) => stops[m].get('label') || '')),
                stackFavorite: members.some((m) => stops[m].get('favorite')),
            }, true);
            for (const m of members.slice(1)) stops[m].set('stacked', true, true);
        }
    }
    parcoursLayer.changed();
}

function openFan(feature) {
    const map = pkg.getMap?.();
    const source = parcoursLayer?.getSource();
    const keys = feature.get('stackKeys') || [];
    if (!map || !source || keys.length < 2) return;
    closeFan();
    pkg.hideMapPopup?.();
    const center = feature.getGeometry().getCoordinates();
    const resolution = map.getView().getResolution();
    const offsets = fanOffsets(keys.length, stopStyle().size);
    const byKey = new Map(stackableFeatures(source).map((f) => [f.get('key'), f]));
    const features = [new ol.Feature({ role: 'fancenter', geometry: new ol.geom.Point(center) })];
    keys.forEach((key, i) => {
        const stop = byKey.get(key);
        if (!stop) return;
        const position = [center[0] + offsets[i][0] * resolution, center[1] - offsets[i][1] * resolution];
        features.push(new ol.Feature({ role: 'fanline', geometry: new ol.geom.LineString([center, position]) }));
        features.push(new ol.Feature({
            role: 'fan',
            key,
            kind: stop.get('kind'),
            type: stop.get('type'),
            label: stop.get('label'),
            favorite: stop.get('favorite'),
            geometry: new ol.geom.Point(position),
        }));
    });
    fan = { repKey: feature.get('key'), keys };
    source.addFeatures(features);
    parcoursLayer.changed();
}

function closeFan() {
    if (!fan) return;
    fan = null;
    const source = parcoursLayer?.getSource();
    for (const f of source?.getFeatures() || []) {
        if (['fan', 'fanline', 'fancenter'].includes(f.get('role'))) source.removeFeature(f);
    }
    if (hoveredFeature && !source?.hasFeature(hoveredFeature)) hoveredFeature = null;
    parcoursLayer?.changed();
}

// Glisser un repère : la pose est enregistrée au lâcher (un lieu ou une
// base), ou reportée dans le formulaire (point provisoire). Un appui sans
// mouvement reste un clic (bulle).
function bindPlanDrag(map) {
    const translate = new ol.interaction.Translate({
        layers: [parcoursLayer],
        filter: (feature) => isDraggable(feature) && !clock.running && !placeForm.isPicking(),
        hitTolerance: 5,
    });
    translate.on('translatestart', () => {
        dragging = true;
        pkg.hideMapPopup?.();
        const target = map.getTargetElement();
        if (target) target.style.cursor = 'grabbing';
    });
    translate.on('translateend', (event) => {
        dragging = false;
        const target = map.getTargetElement();
        if (target) target.style.cursor = 'grab';
        const feature = event.features.item(0);
        const [sx, sy] = event.startCoordinate || [];
        const [ex, ey] = event.coordinate || [];
        if (!feature || (sx === ex && sy === ey)) return;
        const [lon, lat] = ol.proj.toLonLat(feature.getGeometry().getCoordinates());
        if (feature.get('role') === 'draft') {
            placeForm.setDraft({ lon, lat });
            return;
        }
        if (feature.get('placeId') == null) {
            moveStopTo(feature.get('key'), lon, lat);
            return;
        }
        movePlaceTo(feature.get('placeId'), lon, lat);
    });
    map.addInteraction(translate);
}

// Étape glissée (lot 15) : sa position devient un ajustement, qui prime sur
// toute autre et passe par l'historique comme les autres. Ajustements
// verrouillés : le plan est redessiné, l'étape revient à sa place.
function moveStopTo(key, lon, lat) {
    closeFan();
    if (!selectedId || adjustmentsLocked() || !inputs || !key) {
        renderLayer();
        return;
    }
    const round = (value) => Math.round(value * 1e6) / 1e6;
    saveOverrides([{ key, position: { lat: round(lat), lon: round(lon) } }]);
}

// Refus (lecture en cours, erreur du serveur) : le repère revient à sa place.
// Accepté : le déplacement entre dans l'historique (Ctrl+Z le défait).
async function movePlaceTo(id, lon, lat) {
    const place = placeById(id);
    const before = place && { place: id, lat: place.lat, lon: place.lon };
    if (!(await updatePlace(id, { lat, lon }))) renderLayer();
    else if (before) pushHistory(before);
}

// Bulle d'une étape du plan (moteur › popupAt, appelé par le clic de
// mapgl.js) : rien pendant une pose, une lecture ou juste après un glisser.
function parcoursPopupAt(pixel) {
    if (placeForm.isPicking() || clock.running || placeForm.isClickMuted()) return null;
    const map = pkg.getMap?.();
    if (!map || !parcoursLayer?.getVisible()) return null;
    const feature = planFeatureAt(map, pixel, ['stop', 'fan']);
    // Clic hors de l'éventail ouvert : il se referme.
    if (fan && feature?.get('role') !== 'fan') closeFan();
    // Une pile s'écarte en éventail, sans bulle.
    if (feature?.get('role') === 'stop' && (feature.get('stackKeys')?.length || 0) > 1) {
        openFan(feature);
        return { handled: true };
    }
    const stop = feature ? stopByKey(feature.get('key')) : null;
    if (!stop) return null;
    el('parcoursStops')?.querySelector(`[data-stop-key="${CSS.escape(stop.key)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    return { coordinate: feature.getGeometry().getCoordinates(), render: (box) => fillStopBubble(box, stop) };
}

// Bulle : nom, heure et raison de la place, puis les gestes courants —
// épingler l'heure, exclure l'étape (supprimer un lieu), ouvrir le panneau
// complet. Chaque geste ferme la bulle.
function fillStopBubble(box, stop) {
    const wrap = document.createElement('div');
    wrap.className = 'parcours-bubble';
    wrap.dataset.stopKey = stop.key;
    const title = document.createElement('div');
    title.className = 'gc-popup-title';
    const number = currentStopLabels().get(stop.key);
    title.textContent = number ? `${number} · ${stopLabel(stop)}` : stopLabel(stop);
    const detail = document.createElement('div');
    detail.className = 'gc-popup-note';
    detail.textContent = [stopTime(stop), stopDetail(stop, photoByStop.get(stop.key)?.length || 0)].filter(Boolean).join(' · ');
    wrap.append(title, detail);
    const facts = stopFacts(stop);
    if (facts) {
        const line = document.createElement('div');
        line.className = 'gc-popup-note parcours-bubble-facts';
        line.textContent = facts;
        wrap.append(line);
    }
    const done = (action) => () => {
        pkg.hideMapPopup?.();
        action();
    };
    const place = placeOf(stop);

    if (stop.kind !== KIND_BASE) {
        const row = document.createElement('div');
        row.className = 'parcours-bubble-row';
        const input = document.createElement('input');
        input.type = 'time';
        input.className = 'form-control form-control-sm parcours-bubble-time';
        input.setAttribute('aria-label', t('Heure'));
        const pinned = pinnedTimeOf(stop);
        input.value = pinned || minutesToTime(stop.arrivalMin);
        const pin = button('btn btn-sm btn-light parcours-bubble-pin', 'ti-pin', t('Épingler cette heure'),
            { text: t('Épingler') });
        pin.addEventListener('click', done(() => pinStopTime(stop, input.value)));
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') pin.click();
        });
        row.append(input, pin);
        if (pinned) {
            const unpin = button('btn btn-sm btn-outline-light parcours-bubble-unpin', 'ti-pinned-off',
                t('Retirer l’heure épinglée'));
            unpin.addEventListener('click', done(() => pinStopTime(stop, null)));
            row.append(unpin);
        }
        wrap.append(row);
    }

    const actions = document.createElement('div');
    actions.className = 'parcours-bubble-row';
    if (isCountedStop(stop)) {
        const exclude = button('btn btn-sm btn-outline-light parcours-bubble-exclude', 'ti-eye-off',
            t('Exclure du parcours'), { text: t('Exclure') });
        exclude.addEventListener('click', done(() => excludeStop(stop)));
        actions.append(exclude);
        if (stop.positionMoved) {
            const reset = button('btn btn-sm btn-outline-light parcours-bubble-position', 'ti-map-pin-off',
                t('Revenir à la position de la cache'), { text: t('Position d’origine') });
            reset.addEventListener('click', done(() => saveOverrides([{ key: stop.key, position: null }])));
            actions.append(reset);
        }
    } else if (place) {
        const label = place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu');
        const remove = button('btn btn-sm btn-outline-light parcours-bubble-delete', 'ti-trash', label,
            { text: t('Supprimer') });
        remove.addEventListener('click', done(() => {
            showConfirmation(
                place.kind === KIND_BASE ? t('Supprimer cette base du parcours ?') : t('Supprimer ce lieu du parcours ?'),
                label,
                () => deletePlace(place.id),
                null,
                { danger: true, confirmText: t('Supprimer') },
            );
        }));
        actions.append(remove);
    }
    const more = button('btn btn-sm btn-outline-light parcours-bubble-details', 'ti-adjustments',
        t('Tous les réglages de l’étape'), { text: t('Détails') });
    more.addEventListener('click', done(() => openStopDetails(stop.key)));
    actions.append(more);
    wrap.append(actions);
    if (place || isCountedStop(stop)) {
        const hint = document.createElement('div');
        hint.className = 'gc-popup-note';
        hint.textContent = place ? t('Glissez le repère sur la carte pour le déplacer.')
            : t('Glissez l’étape sur la carte pour corriger sa position.');
        wrap.append(hint);
    }
    box.append(wrap);
}

// Clic droit au repos : la bulle de l'étape visée, sinon un menu pour poser
// un lieu ou une base à cet endroit (formulaire de l'onglet Données, type
// choisi d'avance). Sans parcours ouvert, le menu du navigateur.
function onMapContextMenu(map, event) {
    if (!ordered || !selectedId) return;
    event.preventDefault();
    if (placeForm.isPicking() || clock.running) return;
    const pixel = map.getEventPixel(event);
    const own = parcoursPopupAt(pixel);
    if (own) {
        if (own.coordinate) pkg.showMapPopup?.(own.coordinate, own.render);
        return;
    }
    const coordinate = map.getCoordinateFromPixel(pixel);
    if (!coordinate) return;
    const [lon, lat] = ol.proj.toLonLat(coordinate);
    pkg.showMapPopup?.(coordinate, (box) => {
        const wrap = document.createElement('div');
        wrap.className = 'parcours-bubble parcours-bubble-menu';
        for (const [kind, icon, text] of [[KIND_PLACE, 'ti-map-pin-plus', t('Poser un lieu ici')],
            [KIND_BASE, 'ti-home-plus', t('Poser une base ici')]]) {
            const item = button(`btn btn-sm btn-light parcours-bubble-add-${kind}`, icon, text, { text });
            item.addEventListener('click', () => {
                pkg.hideMapPopup?.();
                placeForm.cancel();
                pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]'));
                placeForm.openForm({ lon, lat }, { kind });
                el('parcoursPlaceForm')?.scrollIntoView({ block: 'nearest' });
            });
            wrap.append(item);
        }
        box.append(wrap);
    });
}

// Feature du plan correspondant à une étape : la clé pour un point donné,
// le lieu pour une base dessinée une seule fois quelles que soient ses
// occurrences dans les journées.
// Étape d'une pile : la pile (ou, éventail ouvert, sa place dans l'éventail).
function stopFeatureFor(stop) {
    const source = parcoursLayer?.getSource();
    if (!source || !stop) return null;
    const features = source.getFeatures();
    const fanned = features.find((f) => f.get('role') === 'fan' && f.get('key') === stop.key);
    if (fanned) return fanned;
    const feature = features.find((f) => f.get('role') === 'stop'
        && (f.get('key') === stop.key || (stop.placeId != null && f.get('placeId') === stop.placeId))) || null;
    if (!feature?.get('stacked')) return feature;
    return features.find((f) => f.get('role') === 'stop' && f.get('stackKeys')?.includes(stop.key)) || feature;
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
        // Une pile : les lignes de toutes ses étapes.
        const keys = feature.get('stackKeys') || [feature.get('key')];
        const placeId = feature.get('placeId');
        for (const row of box.querySelectorAll('.parcours-stop')) {
            if (keys.includes(row.dataset.stopKey) || (placeId != null && row.dataset.placeId === String(placeId))) {
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
    // Plan refait : une bulle ouverte décrirait l'état d'avant.
    pkg.hideMapPopup?.();
    const source = layer.getSource();
    source.clear();
    hoveredFeature = null;
    fan = null;
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
    const labels = currentStopLabels();
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
            type: stop.type || '',
            index: stop.index,
            label: labels.get(stop.key) || '',
            favorite: !!stop.favorite,
            category: stop.category || 'other',
            icon: stop.icon || null,
            geometry: new ol.geom.Point(ol.proj.fromLonLat([stop.lon, stop.lat])),
        }));
    }
    // Point provisoire du formulaire de pose : du clic sur la carte à la
    // validation (ou l'annulation), pour que le clic ne semble pas perdu.
    const draft = placeForm.draft();
    if (draft) {
        const draftCategory = el('parcoursPlaceCategory')?.value || 'other';
        features.push(new ol.Feature({
            role: 'draft',
            kind: el('parcoursPlaceKind')?.value || KIND_PLACE,
            category: draftCategory,
            icon: draftCategory === 'custom' ? placeForm.draftIcon() : null,
            geometry: new ol.geom.Point(ol.proj.fromLonLat([draft.lon, draft.lat])),
        }));
    }
    source.addFeatures(features);
    if (fit) {
        const extent = parcoursExtent(parcoursStops(ordered));
        if (extent) fitParcours(extent);
    }
    updateStacks();
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
        suggestionsTotal,
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
        // Parkings proposés par journée (date → [{ name, lat, lon, codes }]).
        parkings: Object.fromEntries([...stopsPanel.parkingsByDate()].map(([date, list]) => [date, list.map((p) => ({ ...p }))])),
        adjustmentRevision: adjust.revision(),
        overridesQueued: adjust.queued(),
        undoDepth: adjust.depths().undo,
        redoDepth: adjust.depths().redo,
        editKey: stopsPanel.getEditKey(),
        picking: placeForm.isPicking(),
        placeDraft: placeForm.draft() ? { ...placeForm.draft() } : null,
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
        photosThumbs: [...photoThumbs.values()].filter((img) => img.complete && img.naturalWidth > 0).length,
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
        utcOffsetSuspect: tracksPanel.offsetSuspect(),
        trackLegs: (timeline?.legs || []).filter((leg) => leg.mode === 'track').length,
        routing: {
            ...routingConfig(),
            state: routeState.state,
            message: routeState.message,
            done: routeState.done || 0,
            total: routeState.total || 0,
            revision: routeRevision,
            requests: routeRunsNow.length,
            routed: routeEffectsNow.paths.size,
            modes: (timeline?.legs || []).filter((leg) => !leg.night).map((leg) => leg.mode),
        },
        // Apparence des étapes et du trait (thème, points.parcours_style) et
        // ce que le plan en fait : numéro et couleur de chaque pastille (rendu
        // thème : de la pastille du numéro, `offset` = son décalage), style
        // de la ligne (null : aucune). `themePoints` : couche WebGL des points
        // du thème affichée ; `playStops` : étapes peintes à la dernière image
        // de la lecture (dont en train d'apparaître).
        style: stopStyle(),
        stopStyles: Object.fromEntries((source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'stop')
            .map((f) => {
                const kind = f.get('kind');
                const place = kind === KIND_BASE || kind === KIND_PLACE;
                const paint = place ? { fill: kindColor(kind), hollow: false } : featurePaint(f);
                let main;
                if (place) main = placeStyle(kind, featureIconClass(f));
                else if (stopStyle().render === RENDER_THEME) main = themeNumberStyle(paint, f.get('label') || '');
                else main = numberedStyle(f);
                const image = main?.getImage();
                return [f.get('key'), {
                    // Lieu, base : le texte est le pictogramme, pas un numéro.
                    label: place ? '' : main?.getText()?.getText() || '',
                    color: paint.fill,
                    hollow: paint.hollow,
                    textColor: main?.getText()?.getFill()?.getColor() || null,
                    radius: image?.getRadius?.() ?? null,
                    offset: image?.getDisplacement?.() || null,
                    favorite: featureShowsFavorite(f),
                }];
            })),
        themePoints: !!pkg.mainPointsLayerVisible?.(),
        // Piles du plan (tête, étapes, libellé), éventail ouvert et position
        // écran de ses étapes.
        stacks: (source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'stop' && (f.get('stackKeys')?.length || 0) > 1)
            .map((f) => ({ key: f.get('key'), keys: [...f.get('stackKeys')], label: f.get('stackLabel') }))
            .sort((a, b) => a.keys.length - b.keys.length || a.key.localeCompare(b.key)),
        stacked: (source?.getFeatures() || []).filter((f) => f.get('stacked')).map((f) => f.get('key')),
        fan: fan ? { key: fan.repKey, keys: [...fan.keys] } : null,
        fanPixels: Object.fromEntries((source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'fan')
            .map((f) => [f.get('key'), pkg.getMap?.()?.getPixelFromCoordinate(f.getGeometry().getCoordinates())])),
        playStops: { ...playStopsDrawn },
        planLine: (() => {
            const style = lineStyle();
            const stroke = style?.getStroke();
            return stroke ? { color: stroke.getColor(), width: stroke.getWidth(), dash: stroke.getLineDash() || null } : null;
        })(),
        // Couleur de la ligne de chaque journée (date → couleur), et de chaque
        // journée de la palette (date → couleur).
        planLineColors: Object.fromEntries((source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'line')
            .map((f) => [f.get('date'), lineStyle(dayIndexes().byDate.get(f.get('date')) ?? 0)?.getStroke().getColor() ?? null])),
        dayColors: Object.fromEntries((ordered?.days || []).map((day, i) => [day.date, dayColor(i, stopStyle().day_palette)])),
        trail: trailOptions(),
        layer: source ? {
            stops: source.getFeatures().filter((f) => f.get('role') === 'stop').length,
            lines: source.getFeatures().filter((f) => f.get('role') === 'line').length,
            draft: source.getFeatures().filter((f) => f.get('role') === 'draft').length,
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
            endCard: playback.day_cards ? endCardAt(timeline, currentQ) : null,
            endCardText: (() => {
                const card = playback.day_cards ? endCardAt(timeline, currentQ) : null;
                return card ? endCardText() : null;
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
    window.getParcoursCollectSnapshot = parcoursCollectSnapshot;
    window.parcoursPhotosReady = parcoursPhotosReady;
}
