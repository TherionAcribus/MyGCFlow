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
import { registerLifecycleEngine } from './lifecycle_engine.mjs';
import { DEFAULT_PARCOURS_TEMPLATE, PARCOURS_INFO_TAGS } from './infos_template.mjs';
import { EVO_NEVER_DAY } from './evolution_style.mjs';
import {
    formatKm,
    stopDetail,
    stopLabel,
    stopTime,
    stopsCountText,
    suggestionName,
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
    FRAMING_FRAME,
    HEAD_PICTOGRAM,
    QUANTUM_MS,
    buildParcoursTimeline,
    dayCardAt,
    openCardAt,
    endCardAt,
    formatClock,
    headAt,
    headModeAt,
    nightLevelAt,
    normalizePlayback,
    sceneTimingOptions,
    stateAt,
    stopsInRange,
} from './parcours_timeline.mjs';
import { chaptersForUpload, createChapterLog } from './parcours_chapters.mjs';
import { createParcoursTimelineBar, slotLabels } from './parcours_tbar.mjs';
import { createParcoursAdjust } from './parcours_adjust.mjs';
import { createParcoursStyleUI } from './parcours_style_ui.mjs';
import { createParcoursPaints } from './parcours_paints.mjs';
import { createParcoursPlayDraw } from './parcours_play.mjs';
import { createParcoursList } from './parcours_list.mjs';
import { createParcoursPlan } from './parcours_plan.mjs';
import { createPlaceForm } from './parcours_place_form.mjs';
import { createStopsPanel } from './parcours_stops_panel.mjs';
import { createTracksPanel } from './parcours_tracks_panel.mjs';
import { createPhotosPanel } from './parcours_photos_panel.mjs';
import { bindParcoursFileDrop, createParcoursUploads } from './parcours_upload.mjs';
import { cameraPoseAt } from './parcours_camera.mjs';
import { createParcoursCamera } from './parcours_camera_ui.mjs';
import { createParcoursPlaybackUI } from './parcours_playback_ui.mjs';
import { initParcoursCollect, parcoursCollectSnapshot, refreshParcoursCollect } from './parcours_collect.js';
import {
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
    PHOTO_LAYOUT_NONE,
    normalizePhotoDisplay,
    photoCrop,
    photoSlots,
    photoTimelineOptions,
} from './parcours_photo_layout.mjs';
import { reconstructWithEvidence } from './parcours_tracks.mjs';
import { createParcoursRouting } from './parcours_routing_ui.mjs';
import { dayColor } from './parcours_style.mjs';

const LAST_ID_KEY = 'parcours.lastId';
// Opacité de la ligne du plan, relative à celle du trait : elle reste sous
// les pastilles sans les concurrencer.

// Plan au repos au-dessus des points WebGL (zIndex 1001) : ses numéros
// restent lisibles. Masqué pendant la lecture.
// Rendu des étapes (`points.parcours_style.render`), au repos comme en lecture.
const RENDER_STOPS = 'stops';
const RENDER_THEME = 'theme';
// Cadrage d'un parcours : une sortie tient souvent dans quelques kilomètres.

let listing = [];             // parcours enregistrés (GET /api/parcours)
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
let counts = null;
let logsAvailable = false;
let status = 'idle';          // idle | loading | ready | error
let loadSeq = 0;

// Lecture (lot 2).
// Origine fictive des dates du moteur : le quantum k est le jour
// QUANTUM_ORIGIN + k. Jamais affichée (infosValues donne la vraie date).
const QUANTUM_ORIGIN = new Date(2000, 0, 1);
const quantumBase = { originDay: dateToDayNumber(QUANTUM_ORIGIN) };
// Réglages de lecture : la préférence globale `parcours_playback` fait
// office de défaut, surchargée par les réglages propres au parcours ouvert
// (colonne `playback`, JSON épars — une journée à pied et trois semaines de
// voyage n'appellent pas les mêmes réglages).
let playbackDefaults = normalizePlayback(window.userSettings?.parcours_playback);
let playbackOverrides = {};     // surcharges du parcours ouvert
let playback = { ...playbackDefaults };
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
// Débuts de journée relevés pendant une capture : chapitres de la vidéo.
const chapterLog = createChapterLog();
let pendingOpenId = null;     // parcours ouvert pendant une lecture
let pendingTimeline = false;  // rythme changé pendant une lecture
let playMsPerDay = QUANTUM_MS;  // quantum à l'écran, tenu par parcoursFrameVars
let timingMemo = null;        // `timing` de la chronologie construite
let timingTimer = null;       // reconstruction différée au changement de plan
// Caméra de la lecture (lot 7, parcours_camera.mjs) : vue d'avant la lecture,
// rendue à la fin ; suspendue dès que l'utilisateur déplace la carte.

// Ajustements (lot 3).

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
    playbackDefaults = normalizePlayback(window.userSettings?.parcours_playback);
    playback = normalizePlayback({ ...playbackDefaults, ...playbackOverrides });
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
    bindTimingPlan();
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
        applyPlaybackContext();
        inputs = null;
        ordered = null;
        stopsPanel.reset();
        adjust.resetHistory();
        playDraw.clearImages();
        renderStops();
        applyTimeline();
        status = 'idle';
        signalLoaded();
        refreshParcoursCollect(null);
    }
}

// Lecture effective du parcours ouvert : ses surcharges posées sur le défaut
// global ; les contrôles (Animation) reflètent la valeur effective. Sans
// parcours ouvert, le défaut global seul.
function applyPlaybackContext() {
    const item = listing.find((entry) => entry.id === selectedId) || null;
    playbackOverrides = { ...(item?.playback || {}) };
    playback = normalizePlayback({ ...playbackDefaults, ...playbackOverrides });
    playbackUI.sync();
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
    applyPlaybackContext();
    renderList(id);
    status = 'loading';
    stopsPanel.reset();
    adjust.resetHistory();
    placeForm.dismiss();
    renderStops();
    // Itinéraires : toute suite en vol appartient au parcours quitté — le
    // numéro de séquence la tue, son état et son cache ne le suivent pas
    // (deux parcours peuvent partager les clés « place:n » de trajets).
    routing.reset();
    // Photos du parcours quitté : images pleine taille et vignettes sont
    // libérées, sinon elles s'accumulent d'un parcours à l'autre.
    playDraw.clearImages();
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

// Rythme de la chronologie (réglages Animation de la page, plan recalculé
// dans ui.js) : sous le quantum naturel, les contenus à lire gardent un
// plancher de temps écran — voir `timing` de buildParcoursTimeline. En
// durée imposée ou calée sur la musique, le total de quanta est conservé
// (`fixedTotal`) : le plan garde sa durée exacte.
function playbackTiming() {
    const msPerDay = Number(pkg.options?.animation?.timePerDay);
    if (!Number.isFinite(msPerDay) || msPerDay >= QUANTUM_MS) return null;
    return { msPerDay, fixedTotal: pkg.options?.animation?.rhythmMode !== 'rate' };
}

// Le plan de rythme change (durée saisie, musique, vitesse) : la chronologie
// est reconstruite avec le nouveau `timing` — différée en cours de lecture,
// comme un changement de rythme du parcours.
function bindTimingPlan() {
    document.addEventListener('mygcflow:timing-plan', () => {
        const next = playbackTiming();
        const same = (!next && !timingMemo)
            || (!!next && !!timingMemo && next.fixedTotal === timingMemo.fixedTotal
                && Math.abs(next.msPerDay - timingMemo.msPerDay) < 0.5);
        if (same || !ordered) return;
        clearTimeout(timingTimer);
        timingTimer = setTimeout(() => {
            if (clock.running) pendingTimeline = true;
            else applyTimeline();
        }, 300);
    });
}

// (Re)construit la chronologie écran du parcours ouvert et la donne au moteur :
// métadonnées (dates fictives des quanta), features WebGL, plan au repos.
function applyTimeline({ fit = false } = {}) {
    // Sans photos dans la vidéo, les étapes ne s'allongent pas pour elles.
    timingMemo = playbackTiming();
    // Le relevé `camera.pose` cadre comme le crochet caméra du moteur :
    // même quantum à l'écran (parcoursFrameVars l'affinerait en lecture).
    playMsPerDay = Number(pkg.options?.animation?.timePerDay) || QUANTUM_MS;
    timeline = ordered ? buildParcoursTimeline(ordered, {
        pace: playback.pace,
        photosByStop: photoDisplay.layout === PHOTO_LAYOUT_NONE ? null : photoByStop,
        legPaths,
        // Cartons d'ouverture (vue d'ensemble puis descente) et final :
        // temps d'écran ajoutés avec les cartons.
        endCard: playback.day_cards,
        openCard: playback.day_cards,
        options: photoTimelineOptions(photoDisplay),
        timing: timingMemo,
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
    playDraw.preloadPhotos();
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
    // Saut en pause (barre de chronologie, Ctrl+flèches, aperçu d'une
    // photo) : le moteur tourne encore — la vue d'avant la lecture et une
    // suspension manuelle de la caméra sont gardées, pas réécrites.
    const wasRunning = clock.running;
    beginEvolution(clock, startDay, at);
    currentQ = startDay;
    chapterLog.begin(timeline, startDay);
    playDraw.reset();
    pkg.hideMapPopup?.();
    closeFan();
    setPlanVisible(false);
    playDraw.ensureLayers();
    if (!wasRunning) beginCamera();
    return countersAt(startDay - 1);
}

function parcoursStep(dates, at) {
    if (!timeline || !dates || dates.length === 0) return null;
    const first = dayIndexOf(quantumBase, dates[0]);
    const last = dayIndexOf(quantumBase, dates[dates.length - 1]);
    const placed = stopsInRange(timeline, first, last).map((i) => olFeatures[i]).filter(Boolean);
    stepEvolution(clock, last, at, last >= endDay);
    chapterLog.note(last, pkg.recordingVideoTimeMs?.());
    return { placed, archived: [], values: countersAt(last) };
}

function parcoursFrameVars(now, msPerDay) {
    const vars = evolutionFrameVariables(clock, { now, msPerDay });
    if (clock.running) {
        // Position continue : le dernier quantum joué, plus la part écoulée
        // du suivant. Elle reste calée sur les apparitions même quand le
        // moteur rattrape plusieurs quanta dans une image.
        const perDay = Math.max(1e-3, Number(msPerDay) || 1);
        playMsPerDay = perDay;
        const elapsed = Math.max(0, (Number(now) || 0) - clock.stepAt);
        currentQ = Math.max(0, clock.day + Math.min(1, elapsed / perDay));
    }
    return vars;
}

// Chapitres de la dernière capture, pour l'encodage (mapgl.js) ; `speed` :
// accélération appliquée par le post-traitement.
function parcoursRecordingChapters(speed) {
    const display = (iso) => {
        const date = iso ? pkg.parseLocalDate?.(iso) : null;
        return (date && pkg.formatDateDisplay?.(date)) || iso || '';
    };
    return chaptersForUpload(chapterLog.entries(), speed, display);
}

function parcoursEnd() {
    endEvolution(clock);
    setPlanVisible(true);
    playDraw.hideLayers();
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
    // « Lire depuis ici » : la lecture (re)démarre à cette étape.
    const play = button('btn btn-sm btn-primary w-100 mt-1 parcours-popup-play', 'ti-player-play',
        t('Lire depuis ici'), { text: t('Lire depuis ici') });
    play.addEventListener('click', () => playFromQ(stop.q));
    container.replaceChildren(title, detail, play);
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

// Synthèse du minutage (onglet Animation) : étapes et journées comme dans la
// liste des étapes, au lieu des quanta du moteur.
function parcoursTimingUnits() {
    if (!ordered) return null;
    const days = ordered.days.length;
    return [stopsCountText(ordered.stopCount), days === 1 ? t('Une journée') : t('${n} jours', { n: days })];
}

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
    timingUnits: parcoursTimingUnits,
    popupAt: parcoursPopupAt,
    recordingChapters: parcoursRecordingChapters,
});


// --- Caméra de la lecture (parcours_camera_ui.mjs) ------------------------

// Suivi du géocacheur : pose pré-rendu, vue sauvegardée/restituée,
// suspension quand l'utilisateur reprend la main, tuiles préchargées.
const playCamera = createParcoursCamera({
    getState: () => ({ clock, playback, timeline, currentQ }),
    getMap: () => pkg.getMap?.(),
    isRecording: () => pkg.isRecordingActive?.() === true,
    prefetchTiles: (center, zoom) => pkg.prefetchBasemapTiles?.(center, zoom),
    onSuspended: (suspended) => syncCameraResumeButton(suspended),
});

function beginCamera() { playCamera.begin(); }
function endCamera() { playCamera.end(); }
function cameraFollowing() { return playCamera.following(); }
function bindCameraSuspension(map) { playCamera.bindSuspension(map); }
function parcoursCamera(leadMs, msPerDay) { return playCamera.camera(leadMs, msPerDay); }

// Bouton flottant « Reprendre le suivi » : posé sur la carte dès qu'un geste
// manuel suspend le suivi, retiré quand le suivi reprend ou que la lecture
// s'arrête (transitions signalées par onSuspended).
let cameraResumeButton = null;

function syncCameraResumeButton(suspended) {
    if (!suspended) {
        cameraResumeButton?.remove();
        cameraResumeButton = null;
        return;
    }
    if (cameraResumeButton) return;
    const viewport = pkg.getMap?.()?.getViewport();
    if (!viewport) return;
    cameraResumeButton = button('btn btn-sm btn-primary parcours-camera-resume', 'ti-video',
        t('Reprendre le suivi'), { text: t('Reprendre le suivi') });
    // Le bouton vit dans le viewport de la carte : sans stopPropagation, son
    // clic compterait comme un clic carte (bulle d'étape, glisser).
    for (const type of ['pointerdown', 'dblclick']) {
        cameraResumeButton.addEventListener(type, (event) => event.stopPropagation());
    }
    cameraResumeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        playCamera.unsuspend();
        // La pose déterministe du point courant est appliquée tout de suite ;
        // le rendu suivant confirme.
        parcoursCamera(0, playMsPerDay);
    });
    viewport.append(cameraResumeButton);
}

// « Lire depuis ici » : la lecture (re)démarre à un quantum donné — depuis
// le repos, en pause ou en cours de route. En capture, refus : la vidéo se
// joue toujours depuis le début.
function playFromQ(q) {
    if (!timeline || !Number.isFinite(q)) return false;
    const state = pkg.previewPlaybackState?.();
    if (state === 'recording') return false;
    const clamped = Math.max(0, Math.min(timeline.quanta - 1, Math.floor(q)));
    const target = dateOfDayIndex(quantumBase, clamped);
    if (state === 'idle') {
        if (pkg.startPausedPreview?.() === false) return false;
    } else if (state === 'playing') {
        pkg.setPreviewPaused?.(true);
    }
    if (pkg.seekAnimationToDate?.(target) === false) return false;
    pkg.setPreviewPaused?.(false);
    return true;
}

// Le quantum d'une étape du panneau se relit dans la chronologie (les objets
// `ordered` et `timeline.stops` diffèrent ; la clé les relie).
function qOfStop(stop) {
    return timeline?.stops?.find((item) => item.key === stop?.key)?.q ?? null;
}

// Crédits des itinéraires (CGU des fournisseurs) : à l'écran, dans
// l'attribution de la carte ; dans la vidéo, peints en bas à droite (la vidéo
// ne compose que les canevas de la carte).
function routeCreditText() {
    if (!routingConfig().enabled || routing.effects().paths.size === 0) return '';
    return routingConfig().provider === 'ors'
        ? t('Itinéraires © contributeurs OpenStreetMap, openrouteservice')
        : t('Itinéraires © contributeurs OpenStreetMap, FOSSGIS');
}

function syncRouteAttribution() {
    const text = routeCreditText() || null;
    for (const layer of [planMap.layer(), playDraw.trailLayer()]) {
        const source = layer?.getSource();
        if (source && (source.get('routeCredit') ?? null) !== text) {
            source.set('routeCredit', text);
            source.setAttributions(text);
        }
    }
}

function setPlanVisible(visible) {
    planMap.setVisible(visible);
}

// --- Réglages de lecture (parcours_playback_ui.mjs) -------------------------------

// « Lecture » (onglet Animation) : rythme, heures, caméra, tête, cartons,
// nuit — écrit `playback` via setPlayback et redessine ou reporte la
// chronologie. La persistance va au parcours ouvert (surcharges éparses) ou,
// à défaut, à la préférence globale — cf. parcours_playback_ui.mjs.
const playbackUI = createParcoursPlaybackUI({
    getState: () => ({ playback, clock, selectedId }),
    // Sans parcours ouvert, le réglage écrit est le défaut global : les
    // surcharges d'un parcours ouvert ensuite repartent de la valeur à jour.
    setPlayback: (next) => {
        playback = next;
        if (selectedId == null) playbackDefaults = next;
    },
    saveParcoursPlayback: async (patch) => {
        playbackOverrides = { ...playbackOverrides, ...patch };
        try {
            const body = await fetchJson(`/api/parcours/${selectedId}`, {
                method: 'PATCH',
                body: JSON.stringify({ playback: playbackOverrides }),
            });
            const item = listing.find((entry) => entry.id === selectedId);
            if (item) item.playback = { ...(body?.parcours?.playback || {}) };
        } catch (error) {
            console.warn('[PARCOURS] Réglages de lecture non enregistrés :', error);
            showToast(t('Les réglages de lecture n’ont pas pu être enregistrés.'), 'error', t('Parcours'));
        }
    },
    applyTimeline,
    deferTimeline: () => { pendingTimeline = true; },
    unsuspendCamera: () => playCamera.unsuspend(),
    notifyRest: () => { pkg.showLifecycleRestState?.(); pkg.refreshTimelineBar?.(); },
    redraw: () => pkg.getMap?.()?.render(),
});

function bindPlayback() { playbackUI.bind(); }

// --- Liste, formulaire et suggestions (parcours_list.mjs) --------------------------

// Liste des parcours enregistrés, formulaire de création/modification et
// parcours suggérés. L'état du panneau (édition en cours, suggestions) vit
// dans le module ; les mutations de la sélection passent par les deps.
const listUI = createParcoursList({
    getState: () => ({ listing, selectedId, findsExtent, maxDays, ordered, inputs, utcOffset }),
    fetchJson,
    openParcours: (id) => openParcours(id),
    refreshParcoursList: (options) => refreshParcoursList(options),
    clearSelection: () => { selectedId = null; writeLastId(null); applyPlaybackContext(); },
});

function renderListError() { listUI.renderListError(); }
function renderList(activeId) { listUI.renderList(activeId); }
function bindForm() { listUI.bindForm(); }
function fillFormDefaults() { listUI.fillFormDefaults(); }
function loadSuggestions() { return listUI.loadSuggestions(); }
function exportGpx() { listUI.exportGpx(); }
export function duplicateParcours(id) { return listUI.duplicate(id); }
export function exportParcours(item) { return listUI.exportItem(item); }
export function deleteParcours(id) { return listUI.deleteItem(id); }


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
function stopByKey(key) {
    for (const day of ordered?.days || []) {
        const stop = day.stops.find((s) => s.key === key);
        if (stop) return stop;
    }
    return null;
}

// Position écran (px, y vers le bas) d'une étape pour le calcul des piles ;
// `group` : sa journée. Partagée entre les piles du plan et celles de la
// lecture (injectée dans parcours_play.mjs).
function stackItem(coordinate, key, resolution) {
    const res = resolution || 1;
    return { x: coordinate[0] / res, y: -coordinate[1] / res, group: dayIndexes().byKey.get(key) ?? 0 };
}

// Glyphe d'une classe Tabler lu dans la feuille de style, pour les
// marqueurs de la carte et la tête de lecture (injectée dans les deux
// modules) ; null sans la police chargée.
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
    showToast,
    t,
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
    routing.clearRunState();
    if (routingConfig().enabled) {
        // Itinéraires déjà connus : leurs durées entrent dans l'horaire, leurs
        // chemins dans le tracé. Les trajets sur une trace n'en ont pas besoin.
        const overrides = new Map((inputs?.overrides || []).map((o) => [o.key, o]));
        const effects = routing.computeRuns(result.ordered, overrides, new Set(result.legPaths.keys()));
        if (effects.hints.size > 0) {
            result = reconstructWithEvidence(inputs, null, { legHints: effects.hints });
        }
    }
    ordered = result.ordered;
    photoMatches = result.matches;
    photoByStop = result.byStop;
    trackMatches = result.trackMatches;
    // Trace GPS d'abord, itinéraire ensuite.
    legPaths = new Map([...routing.effects().paths, ...result.legPaths]);
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
    evictPhotoImages: (id) => playDraw.evictImage(id),
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

// Peintures des étapes (parcours_paints.mjs) : pastilles, lieux, piles,
// halo, lignes de journées — fonctions du thème et de la reconstruction,
// mémoïsées par objet de réglages. Définies avant les panneaux qui les
// reçoivent en dépendance.
const paints = createParcoursPaints({
    getPoint: () => pkg.options?.point,
    getOrdered: () => ordered,
    getFan: () => planMap.fan(),
    getGcColors: () => pkg.defaultGcColors,
    tablerGlyph,
    renderTheme: RENDER_THEME,
});
const {
    stopStyle, cachedStyle, kindColor, dayIndexes, paintOfStop, featurePaint,
    currentStopLabels, haloStyle, featureIconClass, stopIconClass, pointStyle,
    featureShowsFavorite, favoriteBaseRadius, favoriteMarkStyle,
    numberedStyleFor, numberedStyle, featureLabel,
    pileShadowStyle, fanStopStyle, fanLineStyle, fanCenterStyle,
    themePointRadius, themeNumberStyle, placeStyle, lineStyle, trackStyle,
} = paints;

// Dessin de la lecture (parcours_play.mjs) : tête, trait parcouru, étapes
// atteintes, nuit, cartons, cartes postales — deux couches postrender
// recréées par `ensureLayers` au début de chaque lecture.
const playDraw = createParcoursPlayDraw({
    getState: () => ({
        clock, timeline, currentQ, playback, projected, legProjected,
        inputs, photoByStop, photoDisplay, listing, selectedId,
        msPerDay: playMsPerDay,
    }),
    paints,
    quantumBase,
    renderTheme: RENDER_THEME,
    tablerGlyph,
    stackItem,
    bindCamera: bindCameraSuspension,
    syncAttribution: syncRouteAttribution,
    routeCredit: routeCreditText,
    getMap: () => pkg.getMap?.(),
    isRecording: () => pkg.isRecordingActive?.() === true,
    previewState: () => pkg.previewPlaybackState?.(),
    startPreview: () => pkg.startPausedPreview?.(),
    seekTo: (date) => pkg.seekAnimationToDate?.(date),
});

// Appelé par le panneau photo pour cadrer la lecture sur une photo.
function previewPhoto(photoId) {
    return playDraw.previewPhoto(photoId);
}

// Attendue avant la première frame d'un enregistrement : toutes les photos
// chargées décodées (ou timeout). Exportée pour record.js.
export function parcoursPhotosReady(timeoutMs = 3000) {
    return playDraw.photosReady(timeoutMs);
}

// Photos de la chronologie sans image prête : elles manqueront dans la
// vidéo — le départ d'une capture le signale (mapgl.js).
export function parcoursPhotosMissing() {
    return playDraw.photosMissing();
}

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
    pruneHoverRows: () => planMap.pruneHoverRows(),
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
    // « Lire depuis ici » : l'étape directement, la journée depuis sa nuit
    // (le carton « Jour n » s'affiche donc aussi). `timeline.days` ne liste
    // que les journées avec étapes : le rang se relit par la première étape.
    playFromStop: (stop) => playFromQ(qOfStop(stop)),
    playFromDay: (day) => {
        const first = timeline?.stops?.find((item) => item.key === day?.stops?.[0]?.key);
        const startQ = first ? timeline.days[first.day]?.startQ : null;
        return playFromQ(startQ ?? qOfStop(day?.stops?.[0]));
    },
});

function renderStops(errorMessage = '') {
    stopsPanel.render(errorMessage);
}


// --- Itinéraires (lot 6, parcours_routing_ui.mjs) --------------------------------

// Carte « Itinéraires » : réglages (activation, fournisseur, clé ORS),
// calcul des routes en chaîne et cache de page — tout l'état y vit ;
// `rebuild` lui demande requêtes et effets via `computeRuns`.
const routing = createParcoursRouting({
    getState: () => ({ selectedId, ordered, inputs }),
    fetchJson,
    adjustmentsLocked,
    receiveAdjustments,
    rebuild,
    renderStops,
    applyTimeline,
    clockRunning: () => clock.running,
    deferTimeline: () => { pendingTimeline = true; },
    syncAttribution: syncRouteAttribution,
});

function routingConfig() { return routing.config(); }
function renderRouting() { routing.render(); }
function bindRouting() { routing.bind(); }
function ensureRoutes(options) { return routing.ensure(options); }

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


// --- Carte : plan du parcours (parcours_plan.mjs) ---------------------------------

// Couche `parcours` au repos : étapes par journée, piles et éventail,
// lien liste ↔ carte, glisser des repères, bulle et menu au clic droit.
// La couche et son état y vivent ; les gestes sont injectés.
const planMap = createParcoursPlan({
    getState: () => ({ clock, ordered, inputs, selectedId, photoByStop }),
    paints,
    stackItem,
    placeForm,
    stopByKey, placeOf, button,
    pinnedTimeOf, pinStopTime, excludeStop,
    saveOverrides, placeById, updatePlace, pushHistory, deletePlace,
    openStopDetails, adjustmentsLocked,
    getMap: () => pkg.getMap?.(),
    hidePopup: () => pkg.hideMapPopup?.(),
    showPopup: (coordinate, render) => pkg.showMapPopup?.(coordinate, render),
    showDataTab: () => pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#data"]')),
});

function renderLayer(options) { planMap.render(options); }
function setHoveredStop(stop) { planMap.setHoveredStop(stop); }
function parcoursPopupAt(pixel) { return planMap.popupAt(pixel); }
function closeFan() { planMap.closeFan(); }

// --- Relevé (tests) ---------------------------------------------------------------

export function getParcoursSnapshot() {
    const source = planMap.layer()?.getSource();
    return {
        status,
        ids: listing.map((item) => item.id),
        suggestions: listUI.suggestions().map((item) => ({ ...item, name: suggestionName(item) })),
        suggestionsTotal: listUI.totalSuggestions(),
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
        photosLoaded: playDraw.imageStats().loaded,
        photosThumbs: playDraw.imageStats().thumbs,
        photosMissing: playDraw.photosMissing(),
        // Lot 9 : réglages d'affichage, créneaux et cartes peintes à la
        // dernière image (centre, taille et cadre en px du canevas).
        photoDisplay: { ...photoDisplay },
        photoSlots: timeline ? photoSlots(timeline).map((slot) => ({ ...slot })) : [],
        photoView: playDraw.lastPhotoView() ? { ...playDraw.lastPhotoView() } : null,
        photoCards: playDraw.lastPhotoCards().map((card) => ({
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
            ...routing.state(),
            revision: routing.revision(),
            requests: routing.runs().length,
            routed: routing.effects().paths.size,
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
        fan: planMap.fan() ? { key: planMap.fan().repKey, keys: [...planMap.fan().keys] } : null,
        fanPixels: Object.fromEntries((source?.getFeatures() || [])
            .filter((f) => f.get('role') === 'fan')
            .map((f) => [f.get('key'), pkg.getMap?.()?.getPixelFromCoordinate(f.getGeometry().getCoordinates())])),
        playStops: { ...playDraw.stopsDrawn() },
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
        trail: playDraw.trailOptions(),
        layer: source ? {
            stops: source.getFeatures().filter((f) => f.get('role') === 'stop').length,
            lines: source.getFeatures().filter((f) => f.get('role') === 'line').length,
            draft: source.getFeatures().filter((f) => f.get('role') === 'draft').length,
            onMap: !!pkg.getMap?.()?.getLayers().getArray().includes(planMap.layer()),
            visible: planMap.layer().getVisible(),
        } : null,
        // Lien liste ↔ carte : point entouré d'un halo, lignes surlignées.
        hovered: planMap.hoveredFeature()?.get('key') || null,
        mapHover: planMap.hoverRows().filter((row) => row.isConnected).map((row) => row.dataset.stopKey),
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
            // Début de chaque journée (nuit comprise) : bornes des chapitres.
            dayStartQ: timeline.days.map((day) => day.startQ),
        } : null,
        // Chapitres relevés pendant la dernière capture (ms de vidéo brute).
        chapters: chapterLog.entries(),
        running: clock.running,
        currentQ,
        reducedMotion: playDraw.reducedMotion(),
        head: timeline ? headAt(timeline, currentQ) : null,
        infos: parcoursInfosValues(),
        playLayers: playDraw.layersVisible(),
        // Lot 7 : caméra, nuit, carton, pictogramme, crédits.
        camera: (() => {
            const view = pkg.getMap?.()?.getView();
            const pose = cameraPoseAt(timeline, currentQ, pkg.getMap?.()?.getSize(), {
                msPerDay: Math.round(playMsPerDay * 10) / 10,
                frame: FRAMING_FRAME[playback.framing] ?? 1,
            });
            return {
                following: cameraFollowing(),
                suspended: playCamera.suspended(),
                center: view?.getCenter() ? ol.proj.toLonLat(view.getCenter()) : null,
                zoom: view?.getZoom() ?? null,
                // Pose qu'aurait la caméra à la position courante : un saut
                // en pause doit l'atteindre, comme en déroulé continu.
                pose: pose ? { center: ol.proj.toLonLat(pose.center), zoom: pose.zoom } : null,
            };
        })(),
        scene: timeline ? {
            night: playback.day_cards ? nightLevelAt(timeline, currentQ) : 0,
            card: playback.day_cards ? dayCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null,
            cardText: (() => {
                const card = playback.day_cards ? dayCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null;
                return card ? playDraw.dayCardText(card.day) : null;
            })(),
            openCard: playback.day_cards ? openCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null,
            openCardText: (() => {
                const card = playback.day_cards ? openCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null;
                return card ? playDraw.openCardText() : null;
            })(),
            endCard: playback.day_cards ? endCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null,
            endCardText: (() => {
                const card = playback.day_cards ? endCardAt(timeline, currentQ, sceneTimingOptions(playMsPerDay)) : null;
                return card ? playDraw.endCardText() : null;
            })(),
            headMode: headModeAt(timeline, currentQ),
            headGlyph: playback.head === HEAD_PICTOGRAM && !!playDraw.headGlyph(headModeAt(timeline, currentQ)),
        } : null,
        routeCredit: routeCreditText(),
    };
}

if (isParcoursPage()) {
    registerLifecycleEngine(PARCOURS_ENGINE);
    window.getParcoursSnapshot = getParcoursSnapshot;
    window.getParcoursCollectSnapshot = parcoursCollectSnapshot;
    window.parcoursPhotosReady = parcoursPhotosReady;
    window.parcoursPhotosMissing = parcoursPhotosMissing;
}
