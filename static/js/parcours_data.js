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
    endCardAt,
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
    visitMinutes,
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
import { STACK_DISTANCE, fanOffsets, stackLabel, stackStops } from './parcours_stack.mjs';
import {
    PARCOURS_PALETTE_SIZE,
    dayColor,
    hexToRgba,
    nextPaletteColor,
    normalizeParcoursStyle,
    numberFontPx,
    paintTextColor,
    parcoursStyleDefaults,
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
let editKey = null;           // étape dont le panneau d'ajustement est ouvert
let collapsedDays = new Set(); // journées repliées dans la liste (dates ISO)
let dragged = null;           // { date, key } pendant un glisser-déposer
let picking = false;          // en attente d'un clic sur la carte (lieu)
let pickListener = null;
let placeDraft = null;        // { lon, lat } du lieu en cours de saisie
let placeIconDraft = null;    // icône choisie pour la catégorie « custom »
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
    bindParcoursStyle();
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
        collapsedDays.clear();
        undoStack = [];
        redoStack = [];
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
    collapsedDays.clear();
    undoStack = [];
    redoStack = [];
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
    playStopsDrawn = { drawn: 0, popping: 0, headColor: null, piles: [] };
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
    timeline.stops.forEach((stop, i) => {
        if (stop.kind === KIND_BASE || (stop.kind === KIND_PLACE && stop.q <= currentQ)) {
            const badge = categoryBadgeStyle(stop.kind, stopIconClass(stop.category, stop.icon));
            for (const style of badge ? [placeStyle(stop.kind), badge] : [placeStyle(stop.kind)]) {
                context.setStyle(style);
                context.drawGeometry(new ol.geom.Point(projected[i]));
            }
        }
    });
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

// Étapes comptées déjà atteintes, dans le rendu du plan : pastilles, ou
// numéros à côté des points du thème (WebGL, qui apparaissent seuls), sous
// la nuit. Celles qui se recouvrent au zoom de l'image forment des piles,
// comme au repos (« 4–5 », puis « 4–6 »…), à la place de leur première
// étape. Dans l'ordre de la lecture ; une étape qui arrive fait grossir sa
// pastille — ou sa pile — de rien à sa taille (stopPopScale).
let playStopsDrawn = { drawn: 0, popping: 0, headColor: null, piles: [] };

function drawPlayStops(context, resolution) {
    const labels = currentStopLabels();
    const themed = stopStyle().render === RENDER_THEME;
    const point = new ol.geom.Point([0, 0]);
    const reached = [];
    timeline.stops.forEach((stop, i) => {
        if (isCountedStop(stop) && stop.q <= currentQ) reached.push(i);
    });
    const stacks = stackStops(reached.map((i) => stackItem(projected[i], timeline.stops[i].key, resolution)),
        stopStyle().size * STACK_DISTANCE);
    let drawn = 0;
    let popping = 0;
    const piles = [];
    for (const { rep, members } of stacks) {
        const head = timeline.stops[reached[rep]];
        const newest = timeline.stops[reached[members[members.length - 1]]];
        const pile = members.length > 1;
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
        for (const style of styles) {
            if (!style) continue;
            context.setStyle(scale === 1 ? style : scaledStyle(style, scale));
            context.drawGeometry(point);
        }
        drawn += members.length;
    }
    playStopsDrawn = { ...playStopsDrawn, drawn, popping, piles };
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

// Export JSON réimportable : sélection, ajustements, lieux et bases.
export async function exportParcours(item) {
    let payload;
    try {
        payload = await fetchJson(`/api/parcours/${item.id}/export`);
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    const slug = item.name.toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parcours';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)],
        { type: 'application/json' }));
    link.download = `parcours-${slug}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
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

const KIND_ICONS = Object.freeze({
    find: 'ti-map-pin', lab: 'ti-flask', dnf: 'ti-mood-sad', [KIND_PLACE]: 'ti-flag', [KIND_BASE]: 'ti-home',
});

// Catégories d'affichage des lieux et bases (parcours_store.PLACE_CATEGORIES) :
// icône et libellé — le comportement reste celui du `kind`.
const PLACE_CATEGORIES = Object.freeze(['other', 'parking', 'meal', 'viewpoint', 'lodging', 'supply', 'custom']);
const CATEGORY_ICONS = Object.freeze({
    parking: 'ti-parking', meal: 'ti-tools-kitchen-2', viewpoint: 'ti-binoculars',
    lodging: 'ti-bed', supply: 'ti-bottle',
});
// Icônes proposées pour la catégorie « custom » (toutes présentes dans la
// fonte embarquée).
const CUSTOM_ICONS = Object.freeze([
    'ti-flag', 'ti-tent', 'ti-car', 'ti-bus', 'ti-sailboat', 'ti-anchor', 'ti-horse',
    'ti-bike', 'ti-swimming', 'ti-fish', 'ti-tree', 'ti-mountain', 'ti-building-castle',
    'ti-building-arch', 'ti-building-pavilion', 'ti-tower', 'ti-coffee', 'ti-beer',
    'ti-ice-cream', 'ti-campfire',
]);

function categoryLabel(category) {
    switch (category) {
        case 'parking': return t('parking');
        case 'meal': return t('repas');
        case 'viewpoint': return t('point de vue');
        case 'lodging': return t('hébergement');
        case 'supply': return t('ravitaillement');
        case 'custom': return '';
        default: return '';
    }
}

// Libellé d'option (majuscule) pour les sélecteurs de catégorie.
function categoryOptionLabel(category) {
    switch (category) {
        case 'parking': return t('Parking');
        case 'meal': return t('Repas / pique-nique');
        case 'viewpoint': return t('Point de vue');
        case 'lodging': return t('Hébergement');
        case 'supply': return t('Ravitaillement / eau');
        case 'custom': return t('Personnalisée…');
        default: return t('Autre');
    }
}

// Classe d'icône d'une étape de lieu ou de base : la catégorie prime sur le
// type (« custom » utilise l'icône choisie, valide ou non).
function stopCategoryIcon(stop) {
    if (!stop || (stop.kind !== KIND_PLACE && stop.kind !== KIND_BASE)) {
        return KIND_ICONS[stop?.kind] || KIND_ICONS.find;
    }
    if (stop.category === 'custom' && /^ti-[a-z0-9-]+$/.test(stop.icon || '')) return stop.icon;
    return CATEGORY_ICONS[stop.category] || KIND_ICONS[stop.kind];
}

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
    else if (stop.kind === KIND_PLACE) parts.push(categoryLabel(stop.category) || t('lieu'));
    else if (stop.kind === KIND_BASE) { const c = categoryLabel(stop.category); if (c) parts.push(c); }
    else if (stop.type) parts.push(stop.type);
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
    'parcours-edit-time', 'parcours-edit-pin', 'parcours-edit-unpin', 'parcours-edit-leg', 'parcours-edit-visit',
    'parcours-edit-day', 'parcours-edit-exclude', 'parcours-edit-delete-place',
    'parcours-edit-place-name', 'parcours-edit-place-rename', 'parcours-edit-place-kind',
    'parcours-edit-place-day', 'parcours-edit-place-role', 'parcours-edit-place-move', 'parcours-edit-locate',
    'parcours-edit-place-category',
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
    updateCollapseAll();
    updateUndoButtons();
}

// « Tout plier / Tout déplier » : libellé et état selon les journées repliées.
function updateCollapseAll() {
    const btn = el('btnParcoursCollapseDays');
    if (!btn) return;
    const days = ordered?.days || [];
    const allCollapsed = days.length > 0 && days.every((d) => collapsedDays.has(d.date));
    btn.querySelector('span').textContent = allCollapsed ? t('Tout déplier') : t('Tout plier');
}

// Déplie la journée qui contient l'étape — sinon son panneau d'ajustement
// s'ouvrirait sur une ligne masquée.
function expandDayOf(key) {
    const day = ordered?.days.find((d) => d.stops.some((s) => s.key === key));
    if (day) collapsedDays.delete(day.date);
}

function renderDay(day) {
    const section = document.createElement('section');
    const collapsed = collapsedDays.has(day.date);
    section.className = 'parcours-day mb-3';
    if (collapsed) section.classList.add('is-collapsed');
    section.dataset.date = day.date;
    const header = document.createElement('div');
    header.className = 'd-flex align-items-center gap-2 flex-wrap';
    const body = document.createElement('div');
    body.id = `parcoursDay-${day.date}`;
    body.className = 'parcours-day-body';
    body.hidden = collapsed;
    const toggle = button('btn btn-link btn-sm p-0 parcours-day-toggle', 'ti-chevron-down',
        collapsed ? t('Déplier la journée') : t('Replier la journée'));
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', body.id);
    toggle.addEventListener('click', () => {
        // Bascule en place, sans reconstruire la liste : le focus et les
        // poignées de glisser-déposer restent tels quels.
        const open = collapsedDays.delete(day.date);
        if (!open) collapsedDays.add(day.date);
        section.classList.toggle('is-collapsed', !open);
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? t('Replier la journée') : t('Déplier la journée'));
        toggle.title = toggle.getAttribute('aria-label');
        updateCollapseAll();
    });
    const title = document.createElement('h6');
    title.className = 'parcours-day-title mb-1';
    title.textContent = formatDay(day.date);
    // Couleur de la journée, quand les étapes ou le trait la prennent.
    const { color_by: colorBy, trail_by_day: trailByDay } = stopStyle();
    if (colorBy === 'day' || trailByDay) {
        const dot = document.createElement('span');
        dot.className = 'parcours-day-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.backgroundColor = dayColor(dayIndexes().byDate.get(day.date) ?? 0, stopStyle().day_palette);
        title.prepend(dot);
    }
    // Le nombre d'étapes reste lisible quand la journée est repliée.
    const count = document.createElement('span');
    count.className = 'small text-muted parcours-day-count';
    count.textContent = t('${n} étapes', { n: day.stops.length });
    header.append(toggle, title, count);
    if (day.manual) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-azure-lt parcours-day-manual';
        badge.textContent = t('ordre manuel');
        const auto = button('btn btn-link btn-sm p-0 parcours-day-auto', 'ti-arrow-back-up',
            t('Revenir à l’ordre automatique'), { text: t('Ordre automatique') });
        auto.addEventListener('click', () => resetDayOrder(day));
        header.append(badge, auto);
    }
    section.append(header, body);
    if (day.stops.length > 0) {
        const diagnostic = document.createElement('div');
        diagnostic.className = 'small text-muted mb-1 parcours-day-diagnostic';
        diagnostic.textContent = dayDiagnostic(day);
        body.append(diagnostic);
    } else {
        const empty = document.createElement('div');
        empty.className = 'small text-muted';
        empty.textContent = t('Aucune étape ce jour-là');
        body.append(empty);
    }
    if (day.stops.length > 0 || day.excluded.length > 0) {
        const list = document.createElement('ol');
        list.className = 'list-unstyled mb-0 parcours-stop-list';
        const movable = day.stops.filter((stop) => stop.kind !== KIND_BASE);
        for (const stop of day.stops) list.append(...renderStopRow(stop, day, movable));
        for (const stop of day.excluded) list.append(...renderExcludedRow(stop));
        body.append(list);
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
        // La journée de dépôt se déplie pour montrer le résultat.
        collapsedDays.delete(day.date);
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
    // Même peinture que le plan ; creuse : fond blanc cerclé de la couleur.
    const paint = paintOfStop(stop);
    badge.style.backgroundColor = paint.hollow ? '#ffffff' : paint.fill;
    badge.style.color = paintTextColor(paint);
    if (paint.hollow) badge.style.boxShadow = `inset 0 0 0 2px ${paint.fill}`;
    if (Number.isFinite(stop.index)) {
        // Même numéro que le plan ; sans numéros sur la carte, la liste
        // garde le rang sur tout le parcours.
        badge.textContent = currentStopLabels().get(stop.key) || String(stop.index);
    } else {
        const icon = document.createElement('i');
        icon.className = `ti ${stopCategoryIcon(stop)}`;
        icon.setAttribute('aria-hidden', 'true');
        badge.append(icon);
    }
    const icon = document.createElement('i');
    icon.className = `ti ${stopCategoryIcon(stop)} text-muted mt-1`;
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
        const pinned = pinnedTimeOf(stop);
        input.value = pinned || minutesToTime(stop.arrivalMin);
        label.htmlFor = input.id = `parcoursEditTime-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const pin = button('btn btn-sm btn-outline-primary parcours-edit-pin', 'ti-pin', t('Épingler cette heure'),
            { text: t('Épingler') });
        pin.addEventListener('click', () => pinStopTime(stop, input.value));
        row.append(label, input, pin);
        if (pinned) {
            const unpin = button('btn btn-sm btn-link parcours-edit-unpin', 'ti-x', t('Retirer l’heure épinglée'),
                { text: t('Retirer') });
            unpin.addEventListener('click', () => pinStopTime(stop, null));
            row.append(unpin);
        }
        panel.append(row);

        // Durée de visite : vide = durée estimée du type de l'étape ; les
        // heures des étapes suivantes suivent la durée imposée.
        const visitRow = document.createElement('div');
        visitRow.className = 'd-flex align-items-center gap-2 flex-wrap mb-2';
        const visitLabel = document.createElement('label');
        visitLabel.className = 'small';
        visitLabel.textContent = t('Durée de visite');
        const visitInput = document.createElement('input');
        visitInput.type = 'number';
        visitInput.min = '0';
        visitInput.max = '720';
        visitInput.step = '5';
        visitInput.placeholder = t('${n} min', { n: visitMinutes(stop) });
        visitInput.className = 'form-control form-control-sm parcours-edit-visit';
        visitInput.style.width = '5.5rem';
        const visitOverride = overrideOf(stop.key)?.visitMin;
        visitInput.value = Number.isFinite(visitOverride) ? visitOverride : '';
        visitLabel.htmlFor = visitInput.id = `parcoursEditVisit-${stop.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const visitHint = document.createElement('span');
        visitHint.className = 'small text-muted';
        visitHint.textContent = t('min');
        visitInput.addEventListener('change', () => {
            const value = visitInput.value === '' ? null : Math.max(0, Math.min(720, Math.round(Number(visitInput.value) || 0)));
            // La suppression de l'input pendant le re-rendu relance change
            // sur blur : ignorer la valeur déjà appliquée.
            if (value === (overrideOf(stop.key)?.visitMin ?? null)) return;
            saveOverrides([{ key: stop.key, visitMin: value }]);
        });
        visitRow.append(visitLabel, visitInput, visitHint);
        panel.append(visitRow);
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
        // Rôle d'une base : départ et retour, ou une seule extrémité — partir
        // d'un hôtel, dormir ailleurs.
        if (place.kind === KIND_BASE) {
            const roleLabel = document.createElement('label');
            roleLabel.className = 'small';
            roleLabel.textContent = t('Rôle');
            const roleSelect = document.createElement('select');
            roleSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-role';
            roleLabel.htmlFor = roleSelect.id = `parcoursEditPlaceRole-${place.id}`;
            for (const [value, text] of [['both', t('Départ et retour')],
                    ['start', t('Départ seulement')], ['end', t('Arrivée seulement')]]) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = text;
                roleSelect.append(opt);
            }
            roleSelect.value = ['start', 'end'].includes(place.role) ? place.role : 'both';
            roleSelect.addEventListener('change', () => updatePlace(place.id, { role: roleSelect.value }));
            metaRow.append(roleLabel, roleSelect);
        }
        // Catégorie d'affichage : icône dans la liste et sur la carte ; le
        // comportement reste celui du type.
        const catLabel = document.createElement('label');
        catLabel.className = 'small';
        catLabel.textContent = t('Catégorie');
        const catSelect = document.createElement('select');
        catSelect.className = 'form-select form-select-sm w-auto parcours-edit-place-category';
        catLabel.htmlFor = catSelect.id = `parcoursEditPlaceCategory-${place.id}`;
        for (const value of PLACE_CATEGORIES) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = categoryOptionLabel(value);
            catSelect.append(opt);
        }
        catSelect.value = PLACE_CATEGORIES.includes(place.category) ? place.category : 'other';
        catSelect.addEventListener('change', () => updatePlace(place.id, { category: catSelect.value }));
        metaRow.append(catLabel, catSelect);
        panel.append(metaRow);
        // Icône libre pour la catégorie « custom ».
        if (place.category === 'custom') {
            const picker = document.createElement('div');
            picker.className = 'parcours-icon-picker mb-2';
            const selected = /^ti-[a-z0-9-]+$/.test(place.icon || '') ? place.icon : CUSTOM_ICONS[0];
            buildIconPicker(picker, selected, (cls) => updatePlace(place.id, { icon: cls }));
            panel.append(picker);
        }
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
        exclude.addEventListener('click', () => excludeStop(stop));
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
    if (editKey === stop.key) editKey = null;
    saveOverrides([{ key: stop.key, excluded: true, rank: null }]);
}

// Panneau d'ajustement d'une étape ouvert dans la liste (onglet Données).
function openStopDetails(key) {
    editKey = key;
    expandDayOf(key);
    renderStops();
    pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]'));
    el('parcoursStops')?.querySelector(`[data-edit-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
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
            key: patch.key, rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null,
        };
        for (const field of ['rank', 'pinnedTime', 'day', 'excluded', 'legMode', 'visitMin']) {
            if (field in patch) row[field] = patch[field];
        }
        if (row.rank === null && row.pinnedTime === null && row.day === null && !row.excluded
                && row.legMode === null && row.visitMin === null) {
            rows.delete(patch.key);
        } else {
            rows.set(patch.key, row);
        }
    }
    inputs.overrides = [...rows.values()];
}

// Historique des ajustements : une entrée = la liste des ajustements telle
// qu'elle était AVANT le geste (JSON — copie et comparaison en une fois).
// L'annulation rejoue l'état précédent comme des patches ; les lieux posés
// ne font pas partie de l'historique (leur identifiant changerait).
const UNDO_LIMIT = 50;
let undoStack = [];
let redoStack = [];

function snapshotOverrides() {
    return JSON.stringify((inputs?.overrides || []).map((o) => ({ ...o })));
}

// Patches transformant les ajustements actuels en `target` : chaque ligne
// voulue est posée entière, chaque ligne disparue est vidée (ce qui la
// retire, même sémantique de fusion que le serveur).
function patchesTo(target) {
    const fields = { rank: null, pinnedTime: null, day: null, excluded: false, legMode: null, visitMin: null };
    const current = new Map((inputs.overrides || []).map((o) => [o.key, o]));
    const wanted = new Map(target.map((o) => [o.key, o]));
    const patches = [];
    for (const [key, row] of wanted) {
        const next = { key };
        for (const field of Object.keys(fields)) {
            next[field] = field === 'excluded' ? !!row[field] : (row[field] ?? null);
        }
        const cur = current.get(key);
        if (!cur || Object.keys(fields).some((f) => next[f] !== (f === 'excluded' ? !!cur[f] : (cur[f] ?? null)))) {
            patches.push(next);
        }
    }
    for (const key of current.keys()) {
        if (!wanted.has(key)) patches.push({ key, ...fields });
    }
    return patches;
}

// Écrit les patches : fusion locale, reconstruction, envoi en file — sans
// enregistrer dans l'historique (utilisé par l'annulation elle-même).
function writeOverrides(patches) {
    if (!patches.length) return;
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

function saveOverrides(patches) {
    if (!selectedId || adjustmentsLocked() || !inputs) return;
    const before = snapshotOverrides();
    writeOverrides(patches);
    // Le geste n'entre dans l'historique que s'il a changé quelque chose.
    if (snapshotOverrides() !== before) {
        undoStack.push(before);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack = [];
        updateUndoButtons();
    }
}

function undoAdjustment() {
    if (!undoStack.length || !selectedId || adjustmentsLocked() || !inputs) return;
    const current = snapshotOverrides();
    const target = undoStack.pop();
    redoStack.push(current);
    writeOverrides(patchesTo(JSON.parse(target)));
    updateUndoButtons();
}

function redoAdjustment() {
    if (!redoStack.length || !selectedId || adjustmentsLocked() || !inputs) return;
    const current = snapshotOverrides();
    const target = redoStack.pop();
    undoStack.push(current);
    writeOverrides(patchesTo(JSON.parse(target)));
    updateUndoButtons();
}

function updateUndoButtons() {
    const undo = el('btnParcoursUndo');
    const redo = el('btnParcoursRedo');
    if (undo) undo.disabled = undoStack.length === 0;
    if (redo) redo.disabled = redoStack.length === 0;
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
    // Même file que les PATCH : un déplacement encore en vol doit être
    // écrit AVANT la remise à zéro, sinon il ressusciterait ses ajustements.
    // Le vidage par lignes nulles retire chaque ajustement — et entre dans
    // l'historique comme les autres gestes.
    saveOverrides(patchesTo([]));
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
    if (!selectedId || adjustmentsLocked()) return false;
    const pid = selectedId;
    try {
        await fetchJson(`/api/parcours/${pid}/places/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
        await reloadAdjustments(pid);
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
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

function openPlaceForm({ lon, lat }, { kind = KIND_PLACE } = {}) {
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
    showDraftCoords();
    el('parcoursPlaceName').value = '';
    el('parcoursPlaceTime').value = '';
    el('parcoursPlaceKind').value = kind === KIND_BASE ? KIND_BASE : KIND_PLACE;
    el('parcoursPlaceRole').value = 'both';
    el('parcoursPlaceCategory').value = 'other';
    placeIconDraft = CUSTOM_ICONS[0];
    buildIconPicker(el('parcoursPlaceIcons'), placeIconDraft, (cls) => {
        placeIconDraft = cls;
        markIconPicker(el('parcoursPlaceIcons'), cls);
        renderLayer();
    });
    syncPlaceForm();
    form.hidden = false;
    el('parcoursPlaceName')?.focus();
}

function showDraftCoords() {
    const coords = el('parcoursPlaceCoords');
    if (coords && placeDraft) coords.textContent = `${placeDraft.lat.toFixed(5)}, ${placeDraft.lon.toFixed(5)}`;
}

// Grille d'icônes Tabler de la catégorie « custom » : boutons `aria-pressed`,
// `onPick(cls)` au choix.
function buildIconPicker(container, selected, onPick) {
    if (!container) return;
    container.replaceChildren();
    for (const cls of CUSTOM_ICONS) {
        const btn = button('parcours-icon-choice', cls, t('Icône ${icon}', { icon: cls.slice(3) }));
        btn.classList.toggle('is-selected', cls === selected);
        btn.setAttribute('aria-pressed', String(cls === selected));
        btn.addEventListener('click', () => onPick(cls));
        container.append(btn);
    }
}

function markIconPicker(container, selected) {
    for (const btn of container?.querySelectorAll('.parcours-icon-choice') || []) {
        const on = !!btn.querySelector('i')?.classList.contains(selected);
        btn.classList.toggle('is-selected', on);
        btn.setAttribute('aria-pressed', String(on));
    }
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
    const roleRow = el('parcoursPlaceRoleRow');
    if (roleRow) roleRow.hidden = !base;
    const iconRow = el('parcoursPlaceIconRow');
    if (iconRow) iconRow.hidden = el('parcoursPlaceCategory')?.value !== 'custom';
    // Le point provisoire prend la forme du type et de la catégorie choisis.
    renderLayer();
}

function closePlaceForm() {
    placeDraft = null;
    const form = el('parcoursPlaceForm');
    if (form) form.hidden = true;
    renderLayer();
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
    el('btnParcoursCollapseDays')?.addEventListener('click', () => {
        const days = ordered?.days || [];
        const allCollapsed = days.length > 0 && days.every((d) => collapsedDays.has(d.date));
        collapsedDays = allCollapsed ? new Set() : new Set(days.map((d) => d.date));
        renderStops();
    });
    el('parcoursPlaceKind')?.addEventListener('change', syncPlaceForm);
    el('parcoursPlaceCategory')?.addEventListener('change', syncPlaceForm);
    el('btnParcoursPlaceCancel')?.addEventListener('click', closePlaceForm);
    el('parcoursPlaceForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!placeDraft) return;
        const kind = el('parcoursPlaceKind').value;
        const category = el('parcoursPlaceCategory').value;
        const ok = await createPlace({
            kind,
            name: el('parcoursPlaceName').value,
            lat: placeDraft.lat,
            lon: placeDraft.lon,
            date: el('parcoursPlaceDay').value || null,
            time: kind === KIND_PLACE ? (el('parcoursPlaceTime').value || null) : null,
            role: kind === KIND_BASE ? (el('parcoursPlaceRole').value || 'both') : 'both',
            category,
            icon: category === 'custom' ? placeIconDraft : null,
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
    const progress = el('parcoursRoutesProgress');
    if (progress) {
        progress.hidden = !loading;
        progress.max = routeState.total || 1;
        progress.value = routeState.done || 0;
    }
    if (!config.enabled) status.textContent = '';
    else if (routeState.state === 'loading') {
        status.textContent = t('Calcul des itinéraires : ${done} / ${total} trajets…',
            { done: routeState.done || 0, total: routeState.total || '?' });
    }
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

function styleColorIds() {
    return {
        find: 'parcoursStyleColorFind', lab: 'parcoursStyleColorLab', dnf: 'parcoursStyleColorDnf',
        place: 'parcoursStyleColorPlace', base: 'parcoursStyleColorBase',
    };
}

function readStyleUI() {
    const value = (id) => el(id)?.value;
    return normalizeParcoursStyle({
        render: value('parcoursStyleRender'),
        numbers: value('parcoursStyleNumbers'),
        color_by: value('parcoursStyleColorBy'),
        trail_by_day: el('parcoursStyleTrailByDay') ? el('parcoursStyleTrailByDay').checked : undefined,
        day_palette: paletteInputs().map((input) => input.value),
        size: value('parcoursStyleSize'),
        colors: Object.fromEntries(Object.entries(styleColorIds()).map(([kind, id]) => [kind, value(id)])),
        plan_line: value('parcoursStylePlanLine'),
        trail_color: value('parcoursStyleTrailColor'),
        trail_width: value('parcoursStyleTrailWidth'),
        trail_opacity: value('parcoursStyleTrailOpacity'),
    }, stopStyle());
}

function commitParcoursStyle(style) {
    if (!pkg.options?.point) return;
    pkg.options.point.parcoursStyle = style;
    syncParcoursStyleUI();
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

// Reflète le thème dans les contrôles. N'écrit que le DOM (même contrat que
// syncPointOptionsUI, qui l'appelle au chargement d'un thème).
export function syncParcoursStyleUI() {
    const numbers = el('parcoursStyleNumbers');
    if (!numbers) return;
    const style = stopStyle();
    const set = (id, value) => {
        const input = el(id);
        if (input) input.value = String(value);
    };
    numbers.value = style.numbers;
    set('parcoursStyleRender', style.render);
    set('parcoursStyleSize', style.size);
    set('parcoursStyleColorBy', style.color_by);
    // Couleurs par nature des étapes comptées : utiles en mode « par nature »
    // seulement (lieux et bases gardent toujours la leur).
    for (const box of document.querySelectorAll('#parcoursStopsCard [data-kind-color]')) {
        box.hidden = style.color_by !== 'kind';
    }
    // Palette des journées : montrée dès qu'elle sert (étapes ou trait).
    const palette = el('parcoursStyleDayPalette');
    if (palette) palette.hidden = style.color_by !== 'day' && !style.trail_by_day;
    syncPaletteInputs(style.day_palette);
    const byDay = el('parcoursStyleTrailByDay');
    if (byDay) byDay.checked = style.trail_by_day;
    const trailColor = el('parcoursStyleTrailColor');
    if (trailColor) trailColor.disabled = style.trail_by_day;
    for (const [kind, id] of Object.entries(styleColorIds())) set(id, style.colors[kind]);
    set('parcoursStylePlanLine', style.plan_line);
    set('parcoursStyleTrailColor', style.trail_color);
    set('parcoursStyleTrailWidth', style.trail_width);
    set('parcoursStyleTrailOpacity', style.trail_opacity);
    const opacityValue = el('parcoursStyleTrailOpacityValue');
    if (opacityValue) opacityValue.textContent = `${style.trail_opacity}%`;
}

// Cases de la palette des journées : une par couleur, refaites quand leur
// nombre change (thème chargé, ajout, retrait), sinon seulement mises à jour.
function paletteInputs() {
    return [...(el('parcoursStyleDayPalette')?.querySelectorAll('.parcours-day-swatches input') || [])];
}

function syncPaletteInputs(colors) {
    const box = el('parcoursStyleDayPalette')?.querySelector('.parcours-day-swatches');
    if (!box) return;
    let inputs = paletteInputs();
    if (inputs.length !== colors.length) {
        box.replaceChildren();
        inputs = colors.map((_, i) => {
            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'form-control form-control-color';
            const label = t('Couleur de la journée ${n}', { n: i + 1 });
            input.title = label;
            input.setAttribute('aria-label', label);
            input.addEventListener('change', () => commitParcoursStyle(readStyleUI()));
            box.append(input);
            return input;
        });
    }
    colors.forEach((value, i) => { inputs[i].value = value; });
    const add = el('btnParcoursPaletteAdd');
    if (add) add.disabled = colors.length >= PARCOURS_PALETTE_SIZE[1];
    const remove = el('btnParcoursPaletteRemove');
    if (remove) remove.disabled = colors.length <= PARCOURS_PALETTE_SIZE[0];
}

function bindParcoursStyle() {
    const commit = () => commitParcoursStyle(readStyleUI());
    for (const id of ['parcoursStyleRender', 'parcoursStyleNumbers', 'parcoursStyleColorBy', 'parcoursStyleTrailByDay',
        'parcoursStyleSize', 'parcoursStylePlanLine',
        'parcoursStyleTrailColor', 'parcoursStyleTrailWidth', ...Object.values(styleColorIds())]) {
        el(id)?.addEventListener('change', commit);
    }
    // Valeur bornée réaffichée à la sortie du champ (25 → 18).
    for (const id of ['parcoursStyleSize', 'parcoursStyleTrailWidth']) {
        el(id)?.addEventListener('blur', syncParcoursStyleUI);
    }
    // Opacité : suivie pendant le glisser.
    el('parcoursStyleTrailOpacity')?.addEventListener('input', commit);
    // Palette : une case de plus (couleur proposée), la dernière en moins,
    // retour aux couleurs par défaut.
    const setPalette = (colors) => commitParcoursStyle(normalizeParcoursStyle({ day_palette: colors }, stopStyle()));
    el('btnParcoursPaletteAdd')?.addEventListener('click', () => {
        const colors = stopStyle().day_palette;
        if (colors.length < PARCOURS_PALETTE_SIZE[1]) setPalette([...colors, nextPaletteColor(colors)]);
    });
    el('btnParcoursPaletteRemove')?.addEventListener('click', () => {
        const colors = stopStyle().day_palette;
        if (colors.length > PARCOURS_PALETTE_SIZE[0]) setPalette(colors.slice(0, -1));
    });
    el('btnParcoursPaletteReset')?.addEventListener('click', () => setPalette(parcoursStyleDefaults().day_palette));
    el('btnParcoursStyleColorsReset')?.addEventListener('click', () => {
        commitParcoursStyle(normalizeParcoursStyle({ colors: parcoursStyleDefaults().colors }, stopStyle()));
    });
    syncParcoursStyleUI();
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
        normal = placeStyle(kind);
        const badge = categoryBadgeStyle(kind, featureIconClass(feature));
        if (badge) normal = [normal, badge];
    } else if (stopStyle().render === RENDER_THEME) {
        normal = themeNumberStyle(featurePaint(feature), featureLabel(feature), { hit: true });
    } else {
        normal = pile ? [pileShadowStyle(featurePaint(feature)), numberedStyle(feature)] : numberedStyle(feature);
    }
    const styles = Array.isArray(normal) ? normal : [normal];
    return feature.get('hovered') ? [haloStyle(), ...styles] : normal;
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
    return feature.get('hovered') ? [haloStyle(), style] : style;
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

// Base : carré ; lieu : étoile (couleurs du thème, anthracite et violet par
// défaut). Communs au plan et à la lecture, à l'échelle des pastilles.
function placeStyle(kind) {
    return cachedStyle(`place:${kind}`, ({ size }) => {
        const base = kind === KIND_BASE;
        return new ol.style.Style({
            image: new ol.style.RegularShape({
                points: base ? 4 : 5,
                radius: base ? Math.round(size * 10 / 11) : size,
                radius2: base ? undefined : size * 5 / 11,
                angle: base ? Math.PI / 4 : 0,
                fill: new ol.style.Fill({ color: kindColor(kind) }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }),
            }),
        });
    });
}

// Pastille de catégorie en bas à droite du marqueur : glyphe Tabler sur
// rond blanc cerclé de la couleur du type. null sans la police chargée.
function categoryBadgeStyle(kind, iconClass) {
    if (!iconClass) return null;
    return cachedStyle(`badge:${kind}:${iconClass}`, ({ size }) => {
        const glyph = tablerGlyph(iconClass);
        if (!glyph) return null;
        const k = size / 11;
        const offset = Math.round(13 * k);
        const color = kindColor(kind);
        return new ol.style.Style({
            image: new ol.style.Circle({
                radius: Math.max(6, Math.round(8 * k)),
                displacement: [offset, offset],
                fill: new ol.style.Fill({ color: '#ffffff' }),
                stroke: new ol.style.Stroke({ color, width: 1.5 }),
            }),
            text: new ol.style.Text({
                text: glyph,
                font: `${Math.max(9, Math.round(11 * k))}px "tabler-icons"`,
                fill: new ol.style.Fill({ color }),
                offsetX: offset,
                offsetY: offset,
            }),
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
                    const styles = [haloStyle(true), placeStyle(kind)];
                    const badge = categoryBadgeStyle(kind, featureIconClass(feature));
                    if (badge) styles.push(badge);
                    return styles;
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
    return role === 'stop' && (feature.get('kind') === KIND_PLACE || feature.get('kind') === KIND_BASE)
        && feature.get('placeId') != null;
}

function bindMapLink(map) {
    if (hoverBound) return;
    hoverBound = true;
    map.on('pointermove', (event) => {
        if (event.dragging || dragging) return;
        const feature = planFeatureAt(map, event.pixel, ['stop', 'draft', 'fan']);
        highlightRowsFor(feature?.get('role') === 'draft' ? null : feature);
        const target = map.getTargetElement();
        if (target && !picking) target.style.cursor = feature ? (isDraggable(feature) ? 'grab' : 'pointer') : '';
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
    for (const f of stops) f.setProperties({ stacked: false, stackKeys: null, stackLabel: null }, true);
    if (resolution) {
        const stacks = stackStops(stops.map((f) => stackItem(f.getGeometry().getCoordinates(), f.get('key'), resolution)),
            stopStyle().size * STACK_DISTANCE);
        for (const { rep, members } of stacks) {
            if (members.length < 2) continue;
            stops[rep].setProperties({
                stackKeys: members.map((m) => stops[m].get('key')),
                stackLabel: stackLabel(members.map((m) => stops[m].get('label') || '')),
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
        filter: (feature) => isDraggable(feature) && !clock.running && !picking,
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
            placeDraft = { lon, lat };
            showDraftCoords();
            return;
        }
        movePlaceTo(feature.get('placeId'), lon, lat);
    });
    map.addInteraction(translate);
}

// Refus (lecture en cours, erreur du serveur) : le repère revient à sa place.
async function movePlaceTo(id, lon, lat) {
    if (!(await updatePlace(id, { lat, lon }))) renderLayer();
}

// Bulle d'une étape du plan (moteur › popupAt, appelé par le clic de
// mapgl.js) : rien pendant une pose, une lecture ou juste après un glisser.
function parcoursPopupAt(pixel) {
    if (picking || clock.running || performance.now() < clickMutedUntil) return null;
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
    detail.textContent = [stopTime(stop), stopDetail(stop)].filter(Boolean).join(' · ');
    wrap.append(title, detail);
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
    if (place) {
        const hint = document.createElement('div');
        hint.className = 'gc-popup-note';
        hint.textContent = t('Glissez le repère sur la carte pour le déplacer.');
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
    if (picking || clock.running) return;
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
                cancelPlacePicking();
                pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]'));
                openPlaceForm({ lon, lat }, { kind });
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
            category: stop.category || 'other',
            icon: stop.icon || null,
            geometry: new ol.geom.Point(ol.proj.fromLonLat([stop.lon, stop.lat])),
        }));
    }
    // Point provisoire du formulaire de pose : du clic sur la carte à la
    // validation (ou l'annulation), pour que le clic ne semble pas perdu.
    if (placeDraft) {
        const draftCategory = el('parcoursPlaceCategory')?.value || 'other';
        features.push(new ol.Feature({
            role: 'draft',
            kind: el('parcoursPlaceKind')?.value || KIND_PLACE,
            category: draftCategory,
            icon: draftCategory === 'custom' ? placeIconDraft : null,
            geometry: new ol.geom.Point(ol.proj.fromLonLat([placeDraft.lon, placeDraft.lat])),
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
        adjustmentRevision,
        overridesQueued,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        editKey,
        picking,
        placeDraft: placeDraft ? { ...placeDraft } : null,
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
                if (place) main = placeStyle(kind);
                else if (stopStyle().render === RENDER_THEME) main = themeNumberStyle(paint, f.get('label') || '');
                else main = numberedStyle(f);
                const image = main?.getImage();
                return [f.get('key'), {
                    label: main?.getText()?.getText() || '',
                    color: paint.fill,
                    hollow: paint.hollow,
                    textColor: main?.getText()?.getFill()?.getColor() || null,
                    radius: image?.getRadius?.() ?? null,
                    offset: image?.getDisplacement?.() || null,
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
}
