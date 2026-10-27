// Page Mes poses (/poses) : vie des caches posées par le joueur, tirée des logs
// importés par la carte « Mes logs » du mode principal (docs/mode-poses.md).
//
// Les données arrivent en colonnes (/api/poses/data, poses_dataset.py) et
// restent en tableaux typés (poses_timeline.mjs). Comme en mode Évolution,
// les caches sélectionnées deviennent des features OpenLayers ajoutées UNE
// fois à la carte : leur apparition (et leur disparition quand les archivées
// sont masquées) est calculée par le style WebGL. Seul l'attribut `pstate`
// (active / désactivée / archivée, rendu grisé) est réécrit, les jours où
// l'état d'une cache change — quelques dizaines de fois sur des années.
//
// mapgl.js pilote l'animation par le moteur enregistré ici
// (lifecycle_engine.mjs).

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { t } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { isPosesPage } from './app_mode.mjs';
import { registerLifecycleEngine } from './lifecycle_engine.mjs';
import { DEFAULT_POSES_TEMPLATE, POSES_INFO_TAGS } from './infos_template.mjs';
import { staggerDelayMs } from './flash_impulse.mjs';
import { inclusiveDayCount } from './video_timing.mjs';
import { EVO_NEVER_DAY } from './evolution_style.mjs';
import { EVENT_FLASH_KINDS, flashScale, resolveEventFlash, scaledFlash } from './event_flash.mjs';
import { normalizePosesEffects } from './poses_effects.mjs';
import {
    beginEvolution,
    buildCountryRegionTree,
    createEvolutionClock,
    dateOfDayIndex,
    dayIndexOf,
    endEvolution,
    evolutionFrameVariables,
    filterRows,
    lonLatExtentOf,
    stepEvolution,
} from './evolution_timeline.mjs';
import {
    APPEAR_BETA_FIND,
    APPEAR_FIRST_LOG,
    APPEAR_PLACED,
    APPEAR_PUBLISH,
    POSES_COUNTER_TAGS,
    STATE_ARCHIVED,
    STATE_DISABLED,
    appearancesInRange,
    NO_DAY,
    buildPosesBase,
    buildPosesEffects,
    filterPosesRows,
    foundInRange,
    posesEffectAttrs,
    findDayCounts,
    buildPosesTimeline,
    flashesInRange,
    posesCacheMilestones,
    maxFlashesInWindow,
    posesCounterAt,
    posesCounterAtDay,
    posesCounterMaxes,
    posesCountersAt,
    stateAt,
    stateChangesInRange,
    visibleSegment,
} from './poses_timeline.mjs';

const ARCHIVED_DISPLAYS = ['grey', 'hide'];

let base = null;              // colonnes (buildPosesBase)
let payloadMeta = null;       // meta de la charge utile (statut de la carte)
let timeline = null;          // chronologie de la sélection (buildPosesTimeline)
let rows = new Int32Array(0); // lignes retenues par les filtres
let olFeatures = [];          // features de la sélection, dans l'ordre de `rows`
let endDay = 0;
let staggerOn = false;
let archivedDisplay = 'grey';
let pendingSelection = null;  // filtre modifié pendant une animation
let pendingReload = false;    // rechargement demandé pendant une animation
let pendingTimer = null;
let loadSeq = 0;
let dataRevision = 0;
let flashOptionsByKind = new Map(); // résolus au début de l'animation
// Effets de points du thème (points.poses_effects) : valeurs par trouvaille
// (buildPosesEffects), reconstruites quand la sélection, l'échelle de taille
// ou la demi-vie de la lueur changent ; null quand aucun effet n'en a besoin.
let effectsFx = null;
let effectsKey = '';
// Index par jour des événements Stats de la page, par source : 'finds' =
// trouvailles reçues, 'dnf' = DNF reçus, 'favorites' = trouvailles reçues
// portant un point favori (posesStatsFinds). Mémoïsés par (source, révision).
const statsFindsIndexes = new Map();
let cacheMarksMemo = null;          // { revision, marks } — repères par cache (barre)
let counterStatsMemo = null;        // { revision, day, stats } — tuiles « poseur » (Stats)
let stateMutations = 0;             // réécritures de `pstate` (tests, mesures)
const flashLog = [];                // derniers flashs joués (tests)
const FLASH_LOG_MAX = 500;
const clock = createEvolutionClock();
let infosTemplate = normalizeInfosTemplate(window.userSettings?.poses_infos_template);
let datasetScope = { selected: 0, total: 0 };

function normalizeInfosTemplate(value) {
    return typeof value === 'string' ? value : DEFAULT_POSES_TEMPLATE;
}

function el(id) {
    return document.getElementById(id);
}

// --- Démarrage ------------------------------------------------------------------

export async function initPosesPage() {
    if (!isPosesPage()) return;
    const select = el('selectPosesArchivedDisplay');
    const saved = window.userSettings?.poses_archived_display;
    archivedDisplay = ARCHIVED_DISPLAYS.includes(saved) ? saved : 'grey';
    if (select) {
        select.value = archivedDisplay;
        select.addEventListener('change', (e) => {
            const value = ARCHIVED_DISPLAYS.includes(e.target.value) ? e.target.value : 'grey';
            if (window.userSettings) window.userSettings.poses_archived_display = value;
            try { saveSettingsPatch({ poses_archived_display: value }); } catch (_) {}
            if (clock.running) {
                pendingSelection = readFilterSelection();
                pkg.showToast(t("Le réglage s'appliquera à la fin de l'animation."), 'info', t('Caches archivées'));
                return;
            }
            archivedDisplay = value;
            applySelection(readFilterSelection());
        });
    }
    // Les préférences arrivent après l'évaluation du module : le modèle de la
    // ligne d'infos est (re)lu ici, puis reflété dans le champ.
    infosTemplate = normalizeInfosTemplate(window.userSettings?.poses_infos_template);
    const inp = el('inputInfosTemplate');
    if (inp) inp.value = infosTemplate;
    pkg.syncOverlayVisibility?.();
    await loadData({ fit: 'if-outside' });
}

async function loadData({ fit = null } = {}) {
    if (clock.running) {
        pendingReload = true;
        return;
    }
    pendingReload = false;
    const seq = ++loadSeq;
    let toast = null;
    try { toast = pkg.showLoadingToast(t('Chargement de vos caches posées...'), t('Chargement')); } catch (_) {}
    try {
        const response = await fetch(`${CONFIG.BASE_URL}/api/poses/data`, { headers: { Accept: 'application/json' } });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) throw new Error(payload?.message || `HTTP ${response.status}`);
        if (seq !== loadSeq) return;
        base = buildPosesBase(payload);
        payloadMeta = payload.meta || {};
        renderStatus();
        pkg.setCountryStateTree?.(buildCountryRegionTree(base));
        pkg.setEvolutionFilterOptions?.({ countiesByRegion: {}, types: base.types, sizes: base.sizes });
        applySelection(readFilterSelection(), { resetDates: true });
        if (fit && rows.length > 0) pkg.fitMapView?.(lonLatExtentOf(base, rows), { onlyIfOutside: fit === 'if-outside' });
        if (base.count === 0) pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    } catch (e) {
        if (seq !== loadSeq) return;
        console.error('[POSES] Chargement impossible:', e);
        pkg.showToast(t('Impossible de charger vos caches posées : ${message}', { message: e.message }), 'error', t('Erreur'));
        pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    } finally {
        try { if (toast) pkg.hideToast(toast); } catch (_) {}
        if (seq === loadSeq) signalLoaded();
    }
}

// Jalon pour les tests navigateur : les données de la page sont affichées.
function signalLoaded() {
    window.mygcflowPosesLoaded = true;
    window.dispatchEvent(new CustomEvent('mygcflow:poses-loaded', {
        detail: { selected: timeline?.count ?? 0, total: base?.count ?? 0 },
    }));
}

// --- Statut (carte « Mes caches posées », état vide) -----------------------------

function formatNumber(value) {
    const number = Number(value) || 0;
    try {
        return number.toLocaleString(document.documentElement.lang || undefined);
    } catch (_) {
        return String(number);
    }
}

function formatDate(date) {
    return (date && pkg.formatDateDisplay?.(date)) || '—';
}

function emptyReasonText(reason) {
    if (reason === 'no-collection') return t('Aucun log importé pour l\'instant');
    if (reason === 'no-account') return t('Le compte de vos logs est inconnu : importez un export de vos logs');
    if (reason === 'no-placed-caches') return t('Vos caches posées sont dans vos logs, mais aucune n\'a de position et de date connues');
    return t('Aucune cache posée trouvée dans vos logs importés');
}

function renderStatus() {
    const meta = payloadMeta || {};
    const status = el('posesStatus');
    const detail = el('posesDetail');
    const emptyText = el('posesEmptyText');
    // Export CSV : toutes les caches posées (en attente et non datables
    // comprises) — le lien n'a de sens qu'avec des caches possédées, même
    // si aucune n'est plaçable.
    const exportLink = el('posesExportLink');
    if (exportLink) exportLink.hidden = !(meta.ownedTotal > 0);
    // Détail commun aux deux états : quand aucune cache n'est plaçable, les
    // compteurs « en attente » / « non datable » expliquent la carte vide.
    const lines = [];
    if (meta.pending > 0) lines.push(t('${n} caches sans position (complétez-les depuis la carte « Mes logs »)', { n: formatNumber(meta.pending) }));
    if (meta.undatable > 0) lines.push(t('${n} caches sans date de publication ni de pose', { n: formatNumber(meta.undatable) }));
    if (meta.inferredStates > 0) lines.push(t('${n} changements d\'état déduits du statut à l\'export (sans log)', { n: formatNumber(meta.inferredStates) }));
    if (meta.lastImportAt) lines.push(t('Logs importés le ${date}', { date: formatDate(pkg.parseLocalDate?.(meta.lastImportAt.slice(0, 10))) }));
    if (detail) {
        detail.textContent = '';
        for (const line of lines) {
            const li = document.createElement('li');
            li.textContent = line;
            detail.appendChild(li);
        }
        detail.hidden = lines.length === 0;
    }
    if (meta.reason || !base || base.count === 0) {
        const text = emptyReasonText(meta.reason);
        if (status) status.textContent = text;
        if (emptyText) emptyText.textContent = text;
        return;
    }
    if (status) {
        status.textContent = t('${caches} caches posées · ${finds} trouvailles reçues · ${favorites} favoris', {
            caches: formatNumber(base.count),
            finds: formatNumber(meta.finds),
            favorites: formatNumber(meta.favorites),
        });
    }
}

// --- Sélection --------------------------------------------------------------------

// Sélection lue sur les champs de filtre (même règle que le mode Évolution) :
// null quand le critère n'a aucune option, [] quand tout est décoché.
function readFilterSelection() {
    const read = (id) => {
        const select = el(id);
        if (!select) return null;
        const options = Array.from(select.options).filter((o) => !o.disabled && o.value !== '');
        if (options.length === 0) return null;
        return options.filter((o) => o.selected).map((o) => o.value);
    };
    return {
        countries: read('selectCountry'),
        regions: read('selectState'),
        types: read('selectType'),
        sizes: read('selectContainer'),
        difficulties: read('selectDifficulty'),
        terrains: read('selectTerrain'),
        // Critères propres à la page (état à l'export, trouvailles reçues) :
        // appliqués par filterPosesRows après filterRows.
        states: read('selectPosesStatus'),
        finds: read('selectPosesFinds'),
        // Aucune cache posée n'est « archivée sans date » (statut 2).
        undatedMode: 'keep',
    };
}

// Appelé par ui.js (moteur) à chaque changement de filtre.
export function posesApplySelection() {
    if (!base) return;
    const selection = readFilterSelection();
    if (clock.running) {
        pendingSelection = selection;
        pkg.showToast(t("Le filtre s'appliquera à la fin de l'animation."), 'info', t('Filtres'));
        return;
    }
    applySelection(selection);
}

function applySelection(selection, { resetDates = false } = {}) {
    if (!base) return;
    rows = filterRows(base, selection);
    rows = filterPosesRows(base, rows, selection);
    timeline = buildPosesTimeline(base, rows, { archivedDisplay });
    dataRevision += 1;
    ensureEffects();
    olFeatures = buildFeatures(rows);
    statsFindsIndexes.clear();
    datasetScope = { selected: rows.length, total: base.count };
    pkg.setExternalDatasetState(buildMeta(), datasetScope);
    // Sélection ramenée à zéro par les filtres : l'avertissement
    // #dataNoResults et « prochaine étape » suivent la nouvelle sélection.
    pkg.updateDataAvailabilityUI?.();
    if (resetDates) pkg.setPickerDates?.(pkg.metadata);
    pkg.updateAnimationMenuAfterReadBdd?.(pkg.metadata);
    pkg.setLifecycleFeatures(olFeatures);
    pkg.refreshStatsPanels?.();
    // Onglet Stats : la dispo des sources (DNF, favoris reçus) vient de changer.
    pkg.renderStatsTab?.();
    pkg.refreshTimelineBar?.();
    // Jalons « Ne trouvaille reçue » des images planifiées : dates recalculées.
    pkg.refreshImagesForData?.();
}

function buildFeatures(selected) {
    const restDay = restDayIndex();
    const features = new Array(selected.length);
    for (let k = 0; k < selected.length; k++) {
        const i = selected[k];
        const lon = base.lon[i];
        const lat = base.lat[i];
        const segment = visibleSegment(base, i, restDay, archivedDisplay);
        features[k] = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
            cache_type: base.types[base.type[i]] || '',
            container: base.sizes[base.size[i]] || '',
            difficulty: base.difficulties[base.difficulty[i]] || '',
            terrain: base.terrains[base.terrain[i]] || '',
            country: base.countries[base.country[i]] || '',
            state: base.regions[base.region[i]] || '',
            gc_code: base.code[i],
            name: base.name[i] || '',
            // Date d'apparition : l'âge d'une cache au jour d'un log (Stats).
            published_date: isoOfDay(base.placed[i]),
            placedDay: segment.placedDay,
            archivedDay: segment.archivedDay,
            // Rendu grisé (point_webgl_style.js) : 0 active, 1 désactivée,
            // 2 archivée.
            pstate: stateAt(base, i, restDay),
            stagger: staggerDelayMs(lon, lat),
            row: i,
            // Effets de points (poses_point_style.mjs) : toujours posés, le
            // shader lit un attribut absent comme 0.
            ...effectAttrsAt(i, restDay),
        });
    }
    return features;
}

// --- Effets de points (points.poses_effects, docs/mode-poses.md) ------------

function currentEffects() {
    return normalizePosesEffects(pkg.options?.point?.posesEffects);
}

// Les effets lus par le shader dans les attributs de la feature.
function effectsUseAttrs(fx) {
    return fx.popularity.enabled || fx.activity.enabled || fx.freshness.enabled;
}

function ensureEffects() {
    const fx = currentEffects();
    if (!base || !effectsUseAttrs(fx)) {
        effectsFx = null;
        effectsKey = '';
        return;
    }
    const key = `${dataRevision}|${fx.popularity.scale}|${fx.activity.half_life_days}`;
    if (key === effectsKey && effectsFx) return;
    effectsFx = buildPosesEffects(base, rows, { scale: fx.popularity.scale, halfLifeDays: fx.activity.half_life_days });
    effectsKey = key;
}

const NO_EFFECT = Object.freeze({ lastFind: 0, heatVal: 0, popLevels: 0, popDay: NO_DAY });

function effectAttrsAt(i, day) {
    if (!effectsFx) return { ...NO_EFFECT, lastFind: base.placed[i] };
    return posesEffectAttrs(base, effectsFx, i, day);
}

// Un réglage de style a changé (onglet Points, thème appliqué) : la couche
// vient d'être recréée par mapgl.js ; les attributs suivent le nouveau
// réglage, au jour affiché.
export function refreshPosesEffects() {
    if (!base || !timeline) return;
    ensureEffects();
    applyStatesAt(clock.running ? clock.day : restDayIndex());
}

function isoOfDay(dayIndex) {
    const date = dateOfDayIndex(base, dayIndex);
    return pkg.formatDateIso ? pkg.formatDateIso(date) : date.toISOString().slice(0, 10);
}

// Métadonnées au format attendu par l'interface (bdd.js) : période =
// première apparition -> export le plus récent (jamais avant le dernier
// événement).
function buildMeta() {
    if (!timeline || timeline.count === 0) {
        return { startDate: null, endDate: null, deltaDays: null, numberOfCaches: 0, tagMaxes: {} };
    }
    const start = dateOfDayIndex(base, timeline.firstDay);
    let end = payloadMeta?.snapshotDate ? pkg.parseLocalDate(payloadMeta.snapshotDate) : null;
    const last = dateOfDayIndex(base, timeline.lastDay);
    if (!(end instanceof Date) || end < last) end = last;
    return {
        startDate: pkg.formatDateIso(start),
        endDate: pkg.formatDateIso(end),
        deltaDays: inclusiveDayCount(start, end),
        numberOfCaches: timeline.count,
        // Réserve de largeur de la ligne d'infos (frames.js).
        tagMaxes: posesCounterMaxes(timeline),
    };
}

// --- États des points -------------------------------------------------------------

function setFeatureState(k, day) {
    const feature = olFeatures[k];
    if (!feature) return false;
    const i = rows[k];
    const pstate = stateAt(base, i, day);
    const segment = visibleSegment(base, i, day, archivedDisplay);
    const fx = effectAttrsAt(i, day);
    const changed = feature.get('pstate') !== pstate
        || feature.get('placedDay') !== segment.placedDay
        || feature.get('archivedDay') !== segment.archivedDay
        || feature.get('lastFind') !== fx.lastFind
        || feature.get('heatVal') !== fx.heatVal
        || feature.get('popLevels') !== fx.popLevels
        || feature.get('popDay') !== fx.popDay;
    if (changed) {
        feature.setProperties({ pstate, placedDay: segment.placedDay, archivedDay: segment.archivedDay, ...fx });
        stateMutations++;
    }
    return changed;
}

function applyStatesAt(day) {
    let changed = 0;
    for (let k = 0; k < olFeatures.length; k++) if (setFeatureState(k, day)) changed++;
    return changed;
}

// --- Flashs par événement -----------------------------------------------------------

function resolveFlashes() {
    flashOptionsByKind = new Map();
    const flash = pkg.options?.flash;
    // Flash de palier : seulement si l'effet est coché (points.poses_effects).
    const milestone = currentEffects().milestone_flash;
    for (const kind of EVENT_FLASH_KINDS) {
        flashOptionsByKind.set(kind, kind === 'milestone' && !milestone ? null : resolveEventFlash(kind, flash));
    }
}

function canFlash(kind) {
    return !!flashOptionsByKind.get(kind);
}

// --- Interface avec le moteur d'animation (mapgl.js) ------------------------------

function restEndDate() {
    const end = pkg.options?.animation?.dateEnd;
    if (end instanceof Date && Number.isFinite(end.getTime())) return end;
    const meta = pkg.metadata?.endDate;
    return meta instanceof Date && Number.isFinite(meta.getTime()) ? meta : null;
}

function restDayIndex() {
    const date = restEndDate();
    if (date && base) return dayIndexOf(base, date);
    return timeline ? timeline.lastDay : EVO_NEVER_DAY;
}

export function posesHasData() {
    return !!(timeline && timeline.count > 0);
}

export function posesInfosTemplate() {
    return infosTemplate;
}

export function setPosesInfosTemplate(value) {
    const next = normalizeInfosTemplate(value);
    if (next === infosTemplate) return;
    infosTemplate = next;
    pkg.updateInfosReserve?.();
    pkg.invalidateOverlayCache?.();
    pkg.syncOverlayVisibility?.();
    if (!clock.running) pkg.showLifecycleRestState?.();
}

function posesBegin(startDate, endDate, at, { stagger = false } = {}) {
    if (!base || !timeline) return posesCountersAt(null, 0);
    const startDay = dayIndexOf(base, startDate);
    endDay = dayIndexOf(base, endDate instanceof Date ? endDate : restEndDate());
    staggerOn = !!stagger;
    resolveFlashes();
    ensureEffects();
    applyStatesAt(startDay - 1);
    beginEvolution(clock, startDay, at);
    return posesCountersAt(timeline, startDay - 1);
}

function posesStep(dates, at) {
    if (!base || !timeline || !dates || dates.length === 0) return null;
    const first = dayIndexOf(base, dates[0]);
    const last = dayIndexOf(base, dates[dates.length - 1]);
    const placed = appearancesInRange(timeline, first, last).map((k) => olFeatures[k]);
    const { changed, archived } = stateChangesInRange(timeline, base, first, last);
    // Caches trouvées dans le lot : taille, lueur et fraîcheur à réécrire.
    const touched = effectsFx ? new Set([...changed, ...foundInRange(timeline, base, first, last)]) : changed;
    let mutated = 0;
    for (const k of touched) if (setFeatureState(k, last)) mutated++;
    stepEvolution(clock, last, at, last >= endDay);

    const flashes = [];
    for (const { k, kind, count } of flashesInRange(timeline, base, first, last, canFlash)) {
        const scale = flashScale(count);
        flashes.push({ feature: olFeatures[k], options: scaledFlash(flashOptionsByKind.get(kind), scale) });
        flashLog.push({ code: base.code[rows[k]], kind, count, scale, day: last });
    }
    if (flashLog.length > FLASH_LOG_MAX) flashLog.splice(0, flashLog.length - FLASH_LOG_MAX);
    return {
        placed,
        archived: archived.map((k) => olFeatures[k]),
        flashes,
        changed: mutated > 0,
        logRange: [first, last],
        values: posesCountersAt(timeline, last),
    };
}

function posesFrameVars(now, msPerDay) {
    return evolutionFrameVariables(clock, { now, msPerDay, stagger: staggerOn });
}

function posesEnd() {
    endEvolution(clock);
    applyPendingChanges();
}

// Changements reportés pendant l'animation (filtre, sort des archivées,
// rechargement) : appliqués après la fin complète de l'enregistrement.
function applyPendingChanges() {
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (!pendingReload && !pendingSelection) return;
    if (clock.running) return;
    if (pkg.isRecordingActive?.()) {
        pendingTimer = setTimeout(applyPendingChanges, 250);
        return;
    }
    const selectValue = el('selectPosesArchivedDisplay')?.value;
    if (ARCHIVED_DISPLAYS.includes(selectValue)) archivedDisplay = selectValue;
    if (pendingReload) {
        pendingSelection = null;
        loadData();
        return;
    }
    const selection = pendingSelection;
    pendingSelection = null;
    applySelection(selection);
}

// État au repos : valeurs des compteurs et états des points à la date de fin.
function posesRestState() {
    if (!base || !timeline) return null;
    const date = restEndDate();
    if (!date) return null;
    const day = dayIndexOf(base, date);
    clock.restDay = day;
    ensureEffects();
    applyStatesAt(day);
    return { day, date, values: posesCountersAt(timeline, day) };
}

function posesRefreshRest() {
    if (clock.running || !base || !timeline) return;
    const date = restEndDate();
    if (!date) return;
    if (dayIndexOf(base, date) !== clock.restDay) pkg.showLifecycleRestState?.();
}

// Filtre d'une source d'événements Stats : 'finds' = trouvailles reçues,
// 'dnf' = DNF reçus, 'favorites' = trouvailles reçues portant un point
// favori. Toute autre clé : pas de source ici (null).
function statsSourceKeep(source) {
    if (source === 'finds') return (j) => base.ev.kind[j] === base.kindCode.find;
    if (source === 'dnf') return (j) => base.ev.kind[j] === base.kindCode.dnf;
    if (source === 'favorites') return (j) => base.ev.kind[j] === base.kindCode.find && base.ev.fav[j] === 1;
    return null;
}

// Événements de la sélection comptés par les panneaux Stats de la page, par
// jour (clés Date.toDateString(), comme bdd.js › pointsByDate). Mêmes
// propriétés que les trouvailles du mode principal (date_find = date du log,
// attributs de la cache, géométrie GeoJSON pour les points extrêmes), plus
// le trouveur et le point favori. Mémoïsé par (source, révision).
export function posesStatsFinds(source = 'finds') {
    if (!base || !timeline) return null;
    const keep = statsSourceKeep(source);
    if (!keep) return null;
    const cached = statsFindsIndexes.get(source);
    if (cached?.revision === dataRevision) return cached;
    const byDate = new Map();
    const props = new Map();
    const cacheProps = (i) => {
        let p = props.get(i);
        if (!p) {
            p = {
                gc_code: base.code[i],
                name: base.name[i] || '',
                cache_type: base.types[base.type[i]] || '',
                container: base.sizes[base.size[i]] || '',
                difficulty: base.difficulties[base.difficulty[i]] || '',
                terrain: base.terrains[base.terrain[i]] || '',
                country: base.countries[base.country[i]] || '',
                state: base.regions[base.region[i]] || '',
                published_date: isoOfDay(base.placed[i]),
            };
            props.set(i, p);
        }
        return p;
    };
    let lastDay = null;
    let key = '';
    let iso = '';
    for (let e = 0; e < timeline.evOrder.length; e++) {
        const j = timeline.evOrder[e];
        if (!keep(j)) continue;
        const day = base.ev.day[j];
        if (day !== lastDay) {
            const date = dateOfDayIndex(base, day);
            key = date.toDateString();
            iso = isoOfDay(day);
            lastDay = day;
        }
        const i = base.ev.cache[j];
        const author = base.ev.author[j];
        const record = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [base.lon[i], base.lat[i]] },
            properties: {
                ...cacheProps(i),
                date_find: iso,
                finder: author >= 0 ? (base.authors[author] || '') : '',
                favorite: base.ev.fav[j] === 1,
            },
        };
        let list = byDate.get(key);
        if (!list) byDate.set(key, (list = []));
        list.push(record);
    }
    const index = { revision: dataRevision, byDate };
    statsFindsIndexes.set(source, index);
    return index;
}

// La source est proposée (select « Données comptées », galerie) quand la
// sélection lui apporte au moins un événement.
export function posesSourceAvailable(source) {
    const index = posesStatsFinds(source);
    for (const list of index?.byDate?.values() || []) if (list.length) return true;
    return false;
}

// Vue de l'index pour les panneaux Stats et la barre de chronologie.
export function posesStatsIndex() {
    if (!base || !timeline) return null;
    return {
        base,
        timeline,
        features: olFeatures,
        originDay: base.originDay,
        revision: dataRevision,
        restDay: restDayIndex(),
        dayOf: (date) => dayIndexOf(base, date),
    };
}

// Tuiles « poseur » des compteurs Stats (délai moyen avant la première
// trouvaille, cache la plus délaissée) au jour affiché. Mémoïsé par
// (révision, jour) : le dessin l'appelle à chaque frame ; le calcul reste
// O(événements ≤ jour), arrêt au premier log postérieur (poses_timeline.mjs
// › posesCounterAtDay) — les journaux reçus restent modestes.
export function posesCounterStats(day) {
    if (!base || !timeline) return null;
    const d = Number.isFinite(day) ? day : restDayIndex();
    if (counterStatsMemo && counterStatsMemo.revision === dataRevision
        && counterStatsMemo.day === d) {
        return counterStatsMemo.stats;
    }
    const stats = posesCounterAtDay(timeline, base, d);
    counterStatsMemo = { revision: dataRevision, day: d, stats };
    return stats;
}

// Barre de chronologie : par jour de l'axe, trouvailles reçues (`events`),
// autres logs (`secondary`, empilés dessus : la pile vaut les logs du jour),
// cumul des trouvailles reçues (`level`) et cumul de la veille (`base`).
function posesTimelineSeries(axisStart, span) {
    const events = new Float64Array(span);
    const secondary = new Float64Array(span);
    const level = new Float64Array(span);
    if (!base || !timeline || !(axisStart instanceof Date)) return { events, secondary, level, base: 0 };
    const first = dayIndexOf(base, axisStart);
    const at = (tag, day) => posesCounterAt(timeline, tag, day);
    const startFinds = at('trouvailles', first - 1);
    let finds = startFinds;
    let logs = at('logs', first - 1);
    for (let k = 0; k < span; k++) {
        const nextFinds = at('trouvailles', first + k);
        const nextLogs = at('logs', first + k);
        events[k] = nextFinds - finds;
        secondary[k] = (nextLogs - logs) - (nextFinds - finds);
        level[k] = nextFinds;
        finds = nextFinds;
        logs = nextLogs;
    }
    return { events, secondary, level, base: startFinds };
}

// Repères par cache de la barre de chronologie, sur la fenêtre de l'axe :
// première trouvaille reçue ('ftf') et paliers ronds ('cacheRound').
// posesCacheMilestones travaille sur les jours de la base ; la conversion en
// décalages d'axe est refaite à l'appel (la liste est mémoïsée par révision).
// → [{ offset, kind, code, value }]
function posesMilestones(axisStart, span) {
    if (!base || !timeline || !(axisStart instanceof Date) || !(span > 0)) return [];
    if (cacheMarksMemo?.revision !== dataRevision) {
        cacheMarksMemo = { revision: dataRevision, marks: posesCacheMilestones(timeline, base) };
    }
    const first = dayIndexOf(base, axisStart);
    const out = [];
    for (const m of cacheMarksMemo.marks) {
        const offset = m.day - first;
        if (offset < 0 || offset >= span) continue;
        out.push({ offset, kind: m.kind, code: base.code[rows[m.k]], value: m.value });
    }
    return out;
}

// Flash d'un type réglé ailleurs que « aucun » : la pause de fin en tient
// compte quand le flash principal est coupé.
function posesHasOwnFlashes() {
    const flash = pkg.options?.flash;
    const milestone = currentEffects().milestone_flash;
    return EVENT_FLASH_KINDS.some((kind) => kind !== 'publish'
        && (kind !== 'milestone' || milestone) && !!resolveEventFlash(kind, flash));
}

// Pour les tests navigateur : états à l'écran, flashs joués, réécritures.
export function getPosesDebugState() {
    const states = { active: 0, disabled: 0, archived: 0 };
    for (const feature of olFeatures) {
        const s = feature.get('pstate');
        if (s === STATE_ARCHIVED) states.archived++;
        else if (s === STATE_DISABLED) states.disabled++;
        else states.active++;
    }
    return {
        loaded: !!base,
        reason: payloadMeta?.reason ?? null,
        selected: timeline?.count ?? 0,
        total: base?.count ?? 0,
        archivedDisplay,
        day: clock.running ? clock.day : clock.restDay,
        running: clock.running,
        states,
        features: olFeatures.map((f) => ({
            code: f.get('gc_code'), pstate: f.get('pstate'),
            placedDay: f.get('placedDay'), archivedDay: f.get('archivedDay'),
            lastFind: f.get('lastFind'), heatVal: f.get('heatVal'),
            popLevels: f.get('popLevels'), popDay: f.get('popDay'),
        })),
        effects: currentEffects(),
        activityLayer: pkg.posesActivityLayerShown?.() === true,
        flashLog: flashLog.slice(),
        mutations: stateMutations,
        counters: timeline ? posesCountersAt(timeline, clock.running ? clock.day : clock.restDay) : null,
    };
}

export function clearPosesFlashLog() {
    flashLog.length = 0;
}

// --- Popup --------------------------------------------------------------------------

const STATE_LABELS = () => ({
    0: t('Active'),
    1: t('Désactivée'),
    2: t('Archivée'),
});

// Popup d'une cache posée : tout vient de `base` (aucun fetch) pour que les
// comptes — trouvailles, favoris, DNF — s'arrêtent au jour affiché pendant
// l'animation. `ev` est trié par jour : le parcours s'arrête au premier log
// postérieur ; les logs « folded » (ramenés à l'apparition) comptent.
export function renderPosesPopup(feature, container) {
    const row = feature?.get?.('row');
    if (!base || !Number.isInteger(row) || !container) return;
    const code = base.code[row];
    const day = clock.running ? clock.day : clock.restDay;

    container.textContent = '';
    const title = document.createElement('div');
    title.className = 'gc-popup-title';
    const link = document.createElement('a');
    link.href = `https://coord.info/${encodeURIComponent(code)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'gc-popup-link';
    link.textContent = code;
    const name = document.createElement('span');
    name.textContent = base.name[row] ? ` - ${base.name[row]}` : '';
    title.append(link, name);
    const details = document.createElement('div');
    details.textContent = [
        base.types[base.type[row]] || '-',
        base.sizes[base.size[row]] || '-',
        `${base.difficulties[base.difficulty[row]] || '-'}/${base.terrains[base.terrain[row]] || '-'}`,
    ].join(', ');
    const appearDate = formatDate(dateOfDayIndex(base, base.placed[row]));
    const appearLine = document.createElement('div');
    // Libellé d'apparition selon la source (poses_dataset.APPEAR_*).
    const appearText = {
        [APPEAR_PUBLISH]: t('Publiée le ${date}', { date: appearDate }),
        [APPEAR_PLACED]: t('Posée le ${date}', { date: appearDate }),
        [APPEAR_BETA_FIND]: t('Trouvée avant sa publication le ${date}', { date: appearDate }),
        [APPEAR_FIRST_LOG]: t('Premier log le ${date}', { date: appearDate }),
    };
    appearLine.textContent = appearText[base.appearSource[row]] || appearText[APPEAR_PUBLISH];
    const stateLine = document.createElement('div');
    stateLine.textContent = STATE_LABELS()[stateAt(base, row, day)] || '';
    const findCode = base.kindCode.find;
    const dnfCode = base.kindCode.dnf;
    let finds = 0, favorites = 0, dnf = 0, firstFind = -1;
    for (let j = 0; j < base.ev.cache.length; j++) {
        if (base.ev.day[j] > day) break;
        if (base.ev.cache[j] !== row) continue;
        const kind = base.ev.kind[j];
        if (kind === findCode) {
            finds++;
            if (base.ev.fav[j]) favorites++;
            if (firstFind < 0) firstFind = j;
        } else if (kind === dnfCode) {
            dnf++;
        }
    }
    const countsLine = document.createElement('div');
    countsLine.textContent = t('${finds} trouvailles · ${favorites} favoris · ${dnf} DNF', {
        finds: formatNumber(finds),
        favorites: formatNumber(favorites),
        dnf: formatNumber(dnf),
    });
    container.append(title, details, appearLine, stateLine, countsLine);
    // Premier trouveur : seulement s'il est déjà passé au jour affiché et nommé.
    if (firstFind >= 0 && base.ev.author[firstFind] >= 0) {
        const ftf = document.createElement('div');
        ftf.textContent = t('Premier trouveur : ${name} (${date})', {
            name: base.authors[base.ev.author[firstFind]] || '',
            date: formatDate(dateOfDayIndex(base, base.ev.day[firstFind])),
        });
        container.appendChild(ftf);
    }
}

// --- Moteur « cycle de vie » ----------------------------------------------------------

const POSES_ENGINE = Object.freeze({
    id: 'poses',
    counterKeys: POSES_COUNTER_TAGS,
    infosTags: POSES_INFO_TAGS,
    hasData: posesHasData,
    infosTemplate: posesInfosTemplate,
    infosTemplateKey: 'poses_infos_template',
    setInfosTemplate: setPosesInfosTemplate,
    begin: posesBegin,
    step: posesStep,
    frameVars: posesFrameVars,
    end: posesEnd,
    restState: posesRestState,
    refreshRest: posesRefreshRest,
    applySelection: posesApplySelection,
    statsIndex: posesStatsIndex,
    counterStats: posesCounterStats,
    maxEventsInWindow: (windowDays) => maxFlashesInWindow(timeline, windowDays),
    findDayCounts: () => findDayCounts(timeline, base),
    timelineSeries: posesTimelineSeries,
    milestones: posesMilestones,
    renderPopup: renderPosesPopup,
    hasOwnFlashes: posesHasOwnFlashes,
    styleChanged: refreshPosesEffects,
});

if (isPosesPage()) registerLifecycleEngine(POSES_ENGINE);
