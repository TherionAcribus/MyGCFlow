// Mode Évolution (page /evolution) : bases de caches importées depuis des
// exports CSV, filtres Pays / Région / Type / Taille / D / T / Département,
// et chronologie consultée par le moteur d'animation (mapgl.js) à chaque
// jour animé.
//
// La base ouverte arrive en colonnes (voir evolution_store.load_payload) et
// reste en tableaux typés (evolution_timeline.mjs). Les caches sélectionnées
// deviennent des features OpenLayers ajoutées UNE fois à la carte : leur
// apparition et leur disparition sont calculées par le style WebGL, jamais par
// des ajouts ou retraits de features (voir evolution_style.mjs).

import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { t } from './notifications.js';
import { showBsModal, hideBsModal } from './ui_bootstrap.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { isEvolutionPage } from './app_mode.mjs';
import { staggerDelayMs } from './flash_impulse.mjs';
import { inclusiveDayCount } from './video_timing.mjs';
import {
    beginEvolution,
    buildCountryRegionTree,
    buildEvolutionBase,
    buildRegionCountyTree,
    buildTimeline,
    counterAt,
    counterMaxFor,
    createEvolutionClock,
    dateOfDayIndex,
    dayIndexOf,
    endEvolution,
    eventsInRange,
    evolutionFrameVariables,
    filterRows,
    maxEventsInWindow,
    stepEvolution,
} from './evolution_timeline.mjs';

// Au-delà, le fichier n'est vraisemblablement pas un export de caches (même
// borne que le serveur, blueprints/evolution.py).
const MAX_CSV_BYTES = 500 * 1024 * 1024;
// Au-delà, la carte reste fluide mais la mémoire du navigateur devient
// sensible (~1 Ko par cache affichée) : l'utilisateur est prévenu.
const LARGE_SELECTION = 300000;
const TASK_POLL_MS = 400;

let datasets = [];
let current = null;          // base ouverte (entrée de la liste)
let base = null;             // colonnes de la base ouverte (buildEvolutionBase)
let timeline = null;         // chronologie de la sélection (buildTimeline)
let rows = new Int32Array(0); // lignes de la base retenues par le filtre
let olFeatures = [];         // features de la sélection, dans l'ordre de timeline
let endDay = 0;              // dernier jour de l'animation en cours
let staggerOn = false;
let pendingSelection = null; // filtre modifié pendant une animation
let importing = false;
let loadSeq = 0;             // seul le dernier chargement demandé s'applique
let nameModalMode = 'create';
let popupSeq = 0;
const clock = createEvolutionClock();
// Modèle de la ligne d'infos : texte libre avec balises {date}, {actives},
// {placees}, {archivees}, {total} remplacées par les valeurs courantes.
// Préférence globale persistée (evolution_infos_template de settings.json) ;
// une chaîne vide masque la ligne.
let infosTemplate = normalizeInfosTemplate(window.userSettings?.evolution_infos_template);
// Dernières stats de sélection poussées au moteur avec les métadonnées :
// repousser la méta les reprend telles quelles.
let datasetScope = { selected: 0, total: 0 };

// Borne le modèle à la taille du champ de saisie (200 caractères, comme le
// maxlength de inputInfosTemplate et la coercion côté serveur). Pas de trim :
// l'utilisateur peut vouloir des espaces ; une seule ligne — les sauts de
// ligne deviennent des espaces. Vide autorisé (masque la ligne).
function normalizeInfosTemplate(value) {
    return String(value ?? '').replace(/\r\n|[\r\n]/g, ' ').slice(0, 200);
}

// Modèle courant de la ligne d'infos, lu par frames.js, mapgl.js et
// overlay_canvas.js.
export function evolutionInfosTemplate() {
    return infosTemplate;
}

// --- Démarrage ------------------------------------------------------------------

export async function initEvolutionPage() {
    if (!isEvolutionPage()) return;
    bindControls();
    setupCsvDragAndDrop();
    const preferred = Number(window.userSettings?.evolution_dataset_id) || null;
    // Les préférences arrivent après l'évaluation du module : le modèle de la
    // ligne d'infos est (re)lu ici, à coup sûr, puis reflété dans le champ.
    infosTemplate = normalizeInfosTemplate(window.userSettings?.evolution_infos_template);
    const inp = document.getElementById('inputInfosTemplate');
    if (inp) inp.value = infosTemplate;
    // displayFrames() a tourné pendant que le modèle valait encore '' :
    // la visibilité de la cartouche (vide = masquée) doit être recalculée.
    pkg.syncOverlayVisibility?.();
    // Au démarrage, le cadrage enregistré est respecté si la zone y est visible.
    await refreshDatasets({ selectId: preferred, fit: 'if-outside' });
}

function el(id) {
    return document.getElementById(id);
}

function bindControls() {
    el('selectEvolutionDataset')?.addEventListener('change', (e) => {
        const id = Number(e.target.value);
        if (id) loadDataset(id, { fit: 'always' });
    });
    el('btnEvolutionCreate')?.addEventListener('click', () => openNameModal('create'));
    el('btnEvolutionRename')?.addEventListener('click', () => openNameModal('rename'));
    el('btnEvolutionExport')?.addEventListener('click', exportCurrentDataset);
    el('btnEvolutionDelete')?.addEventListener('click', openDeleteModal);
    el('btnEvolutionNameConfirm')?.addEventListener('click', confirmNameModal);
    el('inputEvolutionName')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmNameModal(); }
    });
    el('btnEvolutionDeleteConfirm')?.addEventListener('click', confirmDelete);

    const input = el('evolutionCsvInput');
    input?.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        handleCsvFiles(files);
    });
    el('btnEvolutionEmptyStateImport')?.addEventListener('click', () => input?.click());
}

// --- Liste des bases ----------------------------------------------------------------

// fit : cadrage de la carte sur la base chargée ('always', 'if-outside' ou null).
async function refreshDatasets({ selectId = null, fit = 'always' } = {}) {
    let payload;
    try {
        payload = await fetchJson(`${CONFIG.BASE_URL}/api/evolution/datasets`);
    } catch (e) {
        console.error('[EVOLUTION] Liste des bases indisponible:', e);
        pkg.showToast(t('Impossible de lire la liste des bases'), 'error', t('Erreur'));
        pkg.updateDataAvailabilityUI?.({ dataResolved: true });
        return;
    }
    datasets = Array.isArray(payload.datasets) ? payload.datasets : [];
    const chosen = datasets.find((d) => d.id === selectId) || datasets[0] || null;
    renderDatasetSelect(chosen?.id ?? null);

    // Import lancé avant un rechargement de la page : on en reprend le suivi.
    if (payload.import_task_id && !importing) followRunningImport(payload.import_task_id, chosen?.id ?? null);

    if (chosen) {
        await loadDataset(chosen.id, { fit });
    } else {
        clearDataset();
    }
}

function renderDatasetSelect(selectedId) {
    const select = el('selectEvolutionDataset');
    if (select) {
        select.innerHTML = '';
        for (const d of datasets) {
            const opt = document.createElement('option');
            opt.value = String(d.id);
            opt.textContent = t('${name} (${n} caches)', {
                name: d.name,
                n: formatNumber(d.stats?.total ?? 0),
            });
            opt.selected = d.id === selectedId;
            select.appendChild(opt);
        }
        select.disabled = datasets.length === 0;
    }
    const hasDataset = datasets.length > 0;
    const noDataset = el('evolutionNoDataset');
    if (noDataset) noDataset.hidden = hasDataset;
    for (const id of ['btnEvolutionRename', 'btnEvolutionExport', 'btnEvolutionDelete']) {
        const btn = el(id);
        if (btn) btn.disabled = !hasDataset;
    }
}

// --- Chargement d'une base ------------------------------------------------------------

async function loadDataset(id, { fit = null } = {}) {
    if (clock.running) {
        pkg.showToast(t("Arrêtez l'animation avant de changer de base."), 'warning', t('Attention'));
        renderDatasetSelect(current?.id ?? null);
        return;
    }
    const seq = ++loadSeq;
    current = datasets.find((d) => d.id === id) || null;
    renderStats();
    let toast = null;
    try { toast = pkg.showLoadingToast(t('Chargement de la base...'), t('Chargement')); } catch (_) {}
    try {
        const payload = await fetchJson(`${CONFIG.BASE_URL}/api/evolution/datasets/${id}/data`);
        if (seq !== loadSeq) return;
        base = buildEvolutionBase(payload);
        pkg.setCountryStateTree?.(buildCountryRegionTree(base));
        // Départements proposés = ceux des régions retenues : l'arbre
        // région -> départements vient des données, comme Pays -> Région.
        pkg.setEvolutionFilterOptions?.({
            countiesByRegion: buildRegionCountyTree(base),
            types: base.types,
            sizes: base.sizes,
        });
        applySelection(readFilterSelection(), { resetDates: true });
        if (fit) pkg.fitEvolutionView?.(selectionExtent(), { onlyIfOutside: fit === 'if-outside' });
        try { await saveSettingsPatch({ evolution_dataset_id: id }); } catch (_) {}
        if (window.userSettings) window.userSettings.evolution_dataset_id = id;
        loadImportHistory(id);
    } catch (e) {
        if (seq !== loadSeq) return;
        console.error('[EVOLUTION] Chargement de la base impossible:', e);
        pkg.showToast(t('Impossible de charger la base : ${message}', { message: e.message }), 'error', t('Erreur'));
    } finally {
        try { if (toast) pkg.hideToast(toast); } catch (_) {}
        if (seq === loadSeq) signalLoaded();
    }
}

// Jalon pour les tests navigateur et les intégrations : la base demandée est
// affichée (ou il n'y en a aucune).
function signalLoaded() {
    window.mygcflowEvolutionLoaded = true;
    window.dispatchEvent(new CustomEvent('mygcflow:evolution-loaded', {
        detail: { datasetId: current?.id ?? null, selected: timeline?.count ?? 0 },
    }));
}

function clearDataset() {
    ++loadSeq;
    current = null;
    base = null;
    timeline = null;
    rows = new Int32Array(0);
    olFeatures = [];
    pkg.setCountryStateTree?.({});
    pkg.setEvolutionFilterOptions?.(null);
    datasetScope = { selected: 0, total: 0 };
    pkg.setExternalDatasetState?.({}, datasetScope);
    pkg.setEvolutionFeatures?.([]);
    renderStats();
    renderImportHistory([]);
    pkg.updateDataAvailabilityUI?.({ dataResolved: true });
    signalLoaded();
}

// Sélection lue sur les champs de filtre : null quand le critère n'a aucune
// option (champ absent ou liste vide — ex. base sans département), pour ne
// rien filtrer ; [] quand l'utilisateur a tout décoché (« Aucun »).
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
        counties: read('selectCounty'),
    };
}

// Appelé par ui.js à chaque changement de filtre.
export function evolutionApplySelection() {
    if (!base) return;
    const selection = readFilterSelection();
    if (clock.running) {
        // Changer les points en pleine animation fausserait la chronologie :
        // le filtre s'appliquera à l'arrêt.
        pendingSelection = selection;
        pkg.showToast(t("Le filtre s'appliquera à la fin de l'animation."), 'info', t('Filtres'));
        return;
    }
    applySelection(selection);
}

function applySelection(selection, { resetDates = false } = {}) {
    if (!base) return;
    rows = filterRows(base, selection);
    timeline = buildTimeline(base, rows);
    olFeatures = buildFeatures(rows);

    datasetScope = { selected: rows.length, total: base.count };
    pkg.setExternalDatasetState(buildMeta(), datasetScope);
    if (resetDates) pkg.setPickerDates?.(pkg.metadata);
    pkg.updateAnimationMenuAfterReadBdd?.(pkg.metadata);
    pkg.setEvolutionFeatures(olFeatures);

    if (rows.length > LARGE_SELECTION) {
        pkg.showToast(
            t('${n} caches affichées : la carte peut devenir lente. Filtrez par pays ou région pour alléger.', { n: formatNumber(rows.length) }),
            'warning', t('Grosse sélection'), 8000);
    }
}

// Étendue [ouest, sud, est, nord] des caches sélectionnées, null si aucune.
function selectionExtent() {
    if (!base || rows.length === 0) return null;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (let k = 0; k < rows.length; k++) {
        const i = rows[k];
        const lon = base.lon[i];
        const lat = base.lat[i];
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return [west, south, east, north];
}

function buildFeatures(rows) {
    const features = new Array(rows.length);
    for (let k = 0; k < rows.length; k++) {
        const i = rows[k];
        const lon = base.lon[i];
        const lat = base.lat[i];
        features[k] = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
            cache_type: base.types[base.type[i]] || '',
            placedDay: base.placed[i],
            archivedDay: base.archived[i],
            // Décalage de la vague du flash impulsion, fixe par position.
            stagger: staggerDelayMs(lon, lat),
            row: i,
        });
    }
    return features;
}

// Métadonnées de la sélection, au format attendu par l'interface (bdd.js) :
// période = premier placement -> date de l'export le plus récent (les events
// futurs restent hors de l'animation tant que la fin n'est pas repoussée).
function buildMeta() {
    if (!timeline || timeline.count === 0) {
        return {
            startDate: null, endDate: null, deltaDays: null, numberOfCaches: 0,
            counterMaxes: { active: 0, placed: 0, archived: 0 },
        };
    }
    const start = dateOfDayIndex(base, timeline.firstDay);
    let end = base.meta?.snapshotDate ? pkg.parseLocalDate(base.meta.snapshotDate) : null;
    if (!(end instanceof Date) || end < start) end = dateOfDayIndex(base, timeline.lastDay);
    return {
        startDate: pkg.formatDateIso(start),
        endDate: pkg.formatDateIso(end),
        deltaDays: inclusiveDayCount(start, end),
        numberOfCaches: timeline.count,
        // Réserve de largeur de la ligne d'infos (frames.js / overlay_canvas.js) :
        // une valeur maximale par balise numérique du modèle.
        counterMaxes: {
            active: counterMaxFor(timeline, 'active'),
            placed: counterMaxFor(timeline, 'placed'),
            archived: counterMaxFor(timeline, 'archived'),
        },
    };
}

// --- Interface avec le moteur d'animation (mapgl.js) -------------------------------------

export function evolutionHasData() {
    return !!(timeline && timeline.count > 0);
}

// Champ « Ligne d'informations » de l'onglet Infos (ui.js). Hors animation,
// l'état au repos est réaffiché avec le nouveau modèle ; pendant l'animation
// le prochain rendu l'applique — rien d'autre à faire.
export function setEvolutionInfosTemplate(value) {
    const next = normalizeInfosTemplate(value);
    if (next === infosTemplate) return;
    infosTemplate = next;
    // Le modèle pilote le contenu, la réserve de largeur et la visibilité de
    // la cartouche (vide = ligne masquée).
    pkg.updateInfosReserve?.();
    pkg.invalidateOverlayCache?.();
    pkg.syncOverlayVisibility?.();
    if (!clock.running) pkg.showEvolutionRestState?.();
}

// Début d'animation : retourne les trois compteurs juste avant la date de
// début (actives présentes et cumuls placées/archivées), sources des balises
// de la ligne d'infos.
export function evolutionBegin(startDate, endDate, at, stagger) {
    if (!base || !timeline) return { actives: 0, placees: 0, archivees: 0 };
    const startDay = dayIndexOf(base, startDate);
    endDay = dayIndexOf(base, endDate instanceof Date ? endDate : restEndDate());
    staggerOn = !!stagger;
    beginEvolution(clock, startDay, at);
    return {
        actives: counterAt(timeline, startDay - 1, 'active'),
        placees: counterAt(timeline, startDay - 1, 'placed'),
        archivees: counterAt(timeline, startDay - 1, 'archived'),
    };
}

// Jours `dates` affichés : caches apparues et disparues, et valeurs des trois
// compteurs à la fin du dernier jour.
export function evolutionStep(dates, at) {
    if (!base || !timeline || !dates || dates.length === 0) return null;
    const first = dayIndexOf(base, dates[0]);
    const last = dayIndexOf(base, dates[dates.length - 1]);
    const ev = eventsInRange(timeline, first, last);
    stepEvolution(clock, last, at, last >= endDay);
    return {
        placed: pickFeatures(ev.placed),
        archived: pickFeatures(ev.archived),
        values: {
            actives: counterAt(timeline, last, 'active'),
            placees: counterAt(timeline, last, 'placed'),
            archivees: counterAt(timeline, last, 'archived'),
        },
    };
}

function pickFeatures(indices) {
    const out = new Array(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = olFeatures[indices[i]];
    return out;
}

export function evolutionFrameVars(now, msPerDay) {
    return evolutionFrameVariables(clock, { now, msPerDay, stagger: staggerOn });
}

export function evolutionEnd() {
    endEvolution(clock);
    if (pendingSelection) {
        const selection = pendingSelection;
        pendingSelection = null;
        applySelection(selection);
    }
}

// État au repos : valeurs des trois compteurs à la date de fin de l'animation.
export function evolutionRestState() {
    if (!base || !timeline) return null;
    const date = restEndDate();
    if (!date) return null;
    const day = dayIndexOf(base, date);
    clock.restDay = day;
    return {
        day,
        date,
        values: {
            actives: counterAt(timeline, day, 'active'),
            placees: counterAt(timeline, day, 'placed'),
            archivees: counterAt(timeline, day, 'archived'),
        },
    };
}

// La date de fin a changé (onglet Animation) : la carte au repos la suit.
export function evolutionRefreshRest() {
    if (clock.running || !base || !timeline) return;
    const date = restEndDate();
    if (!date) return;
    if (dayIndexOf(base, date) !== clock.restDay) pkg.showEvolutionRestState?.();
}

function restEndDate() {
    const end = pkg.options?.animation?.dateEnd;
    if (end instanceof Date && Number.isFinite(end.getTime())) return end;
    const meta = pkg.metadata?.endDate;
    return meta instanceof Date && Number.isFinite(meta.getTime()) ? meta : null;
}

export function evolutionMaxEventsInWindow(windowDays) {
    return maxEventsInWindow(timeline, windowDays);
}

// --- Popup ----------------------------------------------------------------------------------

export function renderEvolutionPopup(feature, container) {
    const row = feature?.get?.('row');
    if (!base || !Number.isInteger(row) || !container) return;
    const seq = ++popupSeq;
    const code = base.code[row];
    const status = base.status[row];
    const placed = formatDate(dateOfDayIndex(base, base.placed[row]));
    const archivedText = status === 1
        ? t('Archivée le ${date}', { date: formatDate(dateOfDayIndex(base, base.archived[row])) })
        : status === 2 ? t('Archivée (date inconnue)') : t('Active');

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
    name.textContent = '';
    title.append(link, name);
    const details = document.createElement('div');
    details.textContent = base.types[base.type[row]] || '-';
    const owner = document.createElement('div');
    const placedLine = document.createElement('div');
    placedLine.textContent = t('Placée le ${date}', { date: placed });
    const archivedLine = document.createElement('div');
    archivedLine.textContent = archivedText;
    container.append(title, details, owner, placedLine, archivedLine);

    // Nom, taille, D/T et propriétaire ne font pas partie des données de la
    // carte : chargés à la demande.
    const datasetId = current?.id;
    if (!datasetId) return;
    fetchJson(`${CONFIG.BASE_URL}/api/evolution/datasets/${datasetId}/caches/${encodeURIComponent(code)}`)
        .then(({ cache }) => {
            if (seq !== popupSeq || !cache) return;
            if (cache.name) name.textContent = ` - ${cache.name}`;
            const parts = [cache.type || '-', cache.size || '-', `${cache.difficulty ?? '-'}/${cache.terrain ?? '-'}`];
            details.textContent = parts.join(', ');
            owner.textContent = cache.owner || '';
        })
        .catch(() => {});
}

// --- Import de CSV --------------------------------------------------------------------------

async function handleCsvFiles(files) {
    if (!files || files.length === 0) return;
    if (importing) {
        pkg.showToast(t('Un import est déjà en cours'), 'warning', t('Import'));
        return;
    }
    if (clock.running) {
        pkg.showToast(t("Arrêtez l'animation avant d'importer."), 'warning', t('Import'));
        return;
    }
    for (const file of files) {
        const problem = !/\.(csv|txt)$/i.test(file.name)
            ? t('${name} : seuls les fichiers .csv sont acceptés', { name: file.name })
            : file.size === 0 ? t('${name} : fichier vide', { name: file.name })
            : file.size > MAX_CSV_BYTES ? t('${name} : fichier trop volumineux (500 Mo au plus)', { name: file.name })
            : null;
        if (problem) {
            pkg.showToast(problem, 'error', t('Import'));
            return;
        }
    }

    let target = current;
    if (!target) {
        target = await createDatasetForFile(files[0].name);
        if (!target) return;
    }

    setImporting(true);
    showImportProgress(t('Envoi des fichiers...'), 0);
    hideImportSummary();
    try {
        const { task_id: taskId } = await uploadFiles(target.id, files);
        await followImportTask(taskId, target.id);
    } catch (e) {
        showImportError(e.message || String(e));
    } finally {
        setImporting(false);
        hideImportProgress();
    }
}

async function followRunningImport(taskId, datasetId) {
    setImporting(true);
    showImportProgress(t('Import en cours...'), 0);
    try {
        await followImportTask(taskId, datasetId);
    } catch (e) {
        showImportError(e.message || String(e));
    } finally {
        setImporting(false);
        hideImportProgress();
    }
}

async function followImportTask(taskId, datasetId) {
    const status = await pollTask(taskId, (progress, message) => {
        showImportProgress(message || t('Import en cours...'), progress);
    });
    const files = status.result?.files || [];
    renderImportSummary(files);
    if (status.state === 'failed') {
        throw new Error(status.error || t("L'import a échoué"));
    }
    // Nouvel export d'une zone déjà ouverte : le cadrage en cours est gardé.
    await refreshDatasets({ selectId: datasetId, fit: 'if-outside' });
}

function uploadFiles(datasetId, files) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const form = new FormData();
        for (const file of files) form.append('files', file, file.name);
        xhr.upload.addEventListener('progress', (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.round((e.loaded / e.total) * 100);
            showImportProgress(t('Envoi des fichiers : ${pct}%', { pct }), pct);
        });
        xhr.addEventListener('load', () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch (_) {}
            if (xhr.status === 202 && data?.task_id) {
                resolve(data);
            } else {
                reject(new Error(data?.message || t("Impossible de lancer l'import")));
            }
        });
        xhr.addEventListener('error', () => reject(new Error(t("Erreur réseau lors de l'envoi du fichier"))));
        xhr.addEventListener('abort', () => reject(new Error(t('Envoi du fichier annulé'))));
        xhr.open('POST', `${CONFIG.BASE_URL}/api/evolution/datasets/${datasetId}/import`);
        xhr.send(form);
    });
}

// Suit une tâche de fond jusqu'à sa fin (terminée ou en échec).
async function pollTask(taskId, onProgress) {
    let errors = 0;
    for (;;) {
        await new Promise((r) => setTimeout(r, TASK_POLL_MS));
        let status;
        try {
            status = await fetchJson(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`);
            errors = 0;
        } catch (e) {
            if (++errors >= 10) throw e;
            continue;
        }
        if (status.state === 'finished' || status.state === 'failed') return status;
        onProgress?.(Number(status.progress) || 0, status.message || '');
    }
}

// Aucune base : on en crée une au nom du premier fichier (sans l'horodatage
// que les outils d'export y ajoutent), en évitant les noms déjà pris.
async function createDatasetForFile(filename) {
    const stem = String(filename || '').replace(/\.[^.]+$/, '').replace(/[-_ ]?\d{8,14}$/, '').trim();
    const baseName = (stem || t('Ma zone')).slice(0, 90);
    for (let n = 1; n <= 20; n++) {
        const name = n === 1 ? baseName : `${baseName} (${n})`;
        const response = await fetch(`${CONFIG.BASE_URL}/api/evolution/datasets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 201 && data.dataset) {
            datasets.push(data.dataset);
            current = data.dataset;
            renderDatasetSelect(current.id);
            return current;
        }
        if (response.status !== 409) {
            pkg.showToast(data.message || t('Impossible de créer la base'), 'error', t('Erreur'));
            return null;
        }
    }
    pkg.showToast(t('Impossible de créer la base'), 'error', t('Erreur'));
    return null;
}

// Pendant un import, ni second import, ni changement de base.
function setImporting(active) {
    importing = active;
    const noDataset = datasets.length === 0;
    const states = {
        evolutionCsvInput: active,
        btnEvolutionEmptyStateImport: active,
        btnEvolutionCreate: active,
        selectEvolutionDataset: active || noDataset,
        btnEvolutionRename: active || noDataset,
        btnEvolutionExport: active || noDataset,
        btnEvolutionDelete: active || noDataset,
    };
    for (const [id, disabled] of Object.entries(states)) {
        const node = el(id);
        if (node) node.disabled = disabled;
    }
}

function showImportProgress(message, progress) {
    const box = el('evolutionImportProgress');
    if (box) box.hidden = false;
    const msg = el('evolutionImportMessage');
    if (msg) msg.textContent = message;
    const bar = el('evolutionImportBar');
    if (bar) {
        const pct = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
        bar.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
    }
}

function hideImportProgress() {
    const box = el('evolutionImportProgress');
    if (box) box.hidden = true;
}

function hideImportSummary() {
    const box = el('evolutionImportSummary');
    if (box) { box.hidden = true; box.textContent = ''; }
}

function showImportError(message) {
    pkg.showToast(message, 'error', t("Erreur d'import"), 8000);
}

// Compte rendu par fichier : ce qui a été ajouté, mis à jour ou écarté.
function renderImportSummary(files) {
    const box = el('evolutionImportSummary');
    if (!box) return;
    box.textContent = '';
    for (const report of files) {
        const item = document.createElement('div');
        item.className = 'evolution-import-file mb-2';
        const title = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = report.filename || '';
        title.appendChild(strong);
        item.appendChild(title);
        for (const line of summaryLines(report)) {
            const div = document.createElement('div');
            div.className = line.warning ? 'text-warning small' : 'small';
            div.textContent = line.text;
            item.appendChild(div);
        }
        box.appendChild(item);
    }
    box.hidden = files.length === 0;
}

function summaryLines(r) {
    if (r.error) return [{ text: r.error, warning: true }];
    const n = formatNumber;
    const lines = [{
        text: t('${read} lignes lues : ${added} nouvelles, ${updated} mises à jour, ${unchanged} inchangées', {
            read: n(r.rows_read), added: n(r.rows_new), updated: n(r.rows_updated), unchanged: n(r.rows_unchanged),
        }),
    }];
    if (r.rows_newly_archived > 0) {
        lines.push({ text: t('${n} caches archivées depuis le précédent export', { n: n(r.rows_newly_archived) }) });
    }
    if (r.rows_older > 0) {
        lines.push({ text: t('${n} lignes plus anciennes que la version déjà connue, ignorées', { n: n(r.rows_older) }) });
    }
    if (r.rows_duplicate > 0) {
        lines.push({ text: t('${n} doublons dans le fichier (version la plus récente retenue)', { n: n(r.rows_duplicate) }) });
    }
    if (r.archived_without_date > 0) {
        lines.push({ text: t('${n} caches archivées sans date d\'archivage : elles restent affichées jusqu\'à la fin', { n: n(r.archived_without_date) }), warning: true });
    }
    if (r.rows_invalid > 0) {
        const reasons = Object.entries(r.invalid || {}).map(([k, v]) => `${invalidReasonLabel(k)} : ${n(v)}`).join(', ');
        lines.push({ text: t('${n} lignes invalides ignorées (${reasons})', { n: n(r.rows_invalid), reasons }), warning: true });
    }
    if (r.archive_before_placement > 0) {
        lines.push({ text: t('${n} dates d\'archivage antérieures au placement (disparition le jour du placement)', { n: n(r.archive_before_placement) }), warning: true });
    }
    if (r.reactivated > 0) {
        lines.push({ text: t('${n} caches réactivées : leur ancienne date d\'archivage est ignorée', { n: n(r.reactivated) }) });
    }
    const unknownTypes = Object.keys(r.unknown_types || {});
    if (unknownTypes.length > 0) {
        lines.push({ text: t('Types non reconnus (couleur par défaut) : ${types}', { types: unknownTypes.join(', ') }), warning: true });
    }
    return lines;
}

function invalidReasonLabel(reason) {
    switch (reason) {
        case 'code': return t('code GC');
        case 'coordinates': return t('coordonnées');
        case 'placed': return t('date de placement');
        default: return reason;
    }
}

// --- Statistiques et historique -----------------------------------------------------------

function renderStats() {
    const box = el('evolutionStats');
    if (!box) return;
    const s = current?.stats;
    if (!s || !s.total) {
        box.textContent = current ? t('Base vide : importez un export CSV.') : '';
        return;
    }
    const parts = [
        t('${n} caches', { n: formatNumber(s.total) }),
        t('${n} actives', { n: formatNumber(s.active + (s.archived_no_date || 0)) }),
        t('${n} archivées', { n: formatNumber(s.archived) }),
    ];
    if (s.archived_no_date) {
        parts.push(t('${n} archivées sans date', { n: formatNumber(s.archived_no_date) }));
    }
    if (s.min_placed && s.max_placed) {
        parts.push(t('placements du ${from} au ${to}', {
            from: formatDate(pkg.parseLocalDate(s.min_placed)),
            to: formatDate(pkg.parseLocalDate(s.max_placed)),
        }));
    }
    if (s.snapshot_date) {
        parts.push(t('export du ${date}', { date: formatDate(pkg.parseLocalDate(s.snapshot_date)) }));
    }
    box.textContent = parts.join(' · ');
}

async function loadImportHistory(datasetId) {
    try {
        const data = await fetchJson(`${CONFIG.BASE_URL}/api/evolution/datasets/${datasetId}`);
        if (current?.id !== datasetId) return;
        if (data.dataset) {
            current = data.dataset;
            renderStats();
        }
        renderImportHistory(data.imports || []);
    } catch (_) {
        renderImportHistory([]);
    }
}

function renderImportHistory(imports) {
    const details = el('evolutionImportHistory');
    const list = el('evolutionImportHistoryList');
    if (!details || !list) return;
    list.textContent = '';
    for (const entry of imports) {
        const li = document.createElement('li');
        const r = entry.report || {};
        const when = formatDate(pkg.parseLocalDate(String(entry.imported_at || '').slice(0, 10)));
        li.textContent = t('${date} · ${file} : ${added} nouvelles, ${updated} mises à jour', {
            date: when,
            file: entry.filename || '',
            added: formatNumber(r.rows_new ?? 0),
            updated: formatNumber(r.rows_updated ?? 0),
        });
        list.appendChild(li);
    }
    details.hidden = imports.length === 0;
}

// --- Création, renommage, suppression ---------------------------------------------------------

function openNameModal(mode) {
    if (mode === 'rename' && !current) return;
    nameModalMode = mode;
    const title = el('modalEvolutionNameTitle');
    if (title) title.textContent = mode === 'rename' ? t('Renommer la base') : t('Nouvelle base');
    const input = el('inputEvolutionName');
    if (input) {
        input.value = mode === 'rename' ? current.name : '';
        input.classList.remove('is-invalid');
    }
    const feedback = el('feedbackEvolutionName');
    if (feedback) feedback.textContent = '';
    showBsModal('modalEvolutionName');
    setTimeout(() => input?.focus(), 200);
}

async function confirmNameModal() {
    const input = el('inputEvolutionName');
    const name = (input?.value || '').trim();
    const rename = nameModalMode === 'rename' && current;
    const url = rename
        ? `${CONFIG.BASE_URL}/api/evolution/datasets/${current.id}`
        : `${CONFIG.BASE_URL}/api/evolution/datasets`;
    try {
        const response = await fetch(url, {
            method: rename ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.dataset) {
            if (input) input.classList.add('is-invalid');
            const feedback = el('feedbackEvolutionName');
            if (feedback) feedback.textContent = data.message || t('Nom refusé');
            return;
        }
        hideBsModal('modalEvolutionName');
        if (rename) {
            const index = datasets.findIndex((d) => d.id === data.dataset.id);
            if (index >= 0) datasets[index] = data.dataset;
            current = data.dataset;
            renderDatasetSelect(current.id);
        } else {
            await refreshDatasets({ selectId: data.dataset.id });
        }
    } catch (e) {
        pkg.showToast(t('Erreur : ${message}', { message: e.message }), 'error', t('Erreur'));
    }
}

// CSV fusionné de la base (sauvegarde, portage vers une autre installation :
// le fichier produit est ré-importable tel quel). Un simple changement
// d'adresse suffit : le navigateur télécharge le flux.
function exportCurrentDataset() {
    if (!current) return;
    window.location.assign(`${CONFIG.BASE_URL}/api/evolution/datasets/${current.id}/export.csv`);
}

function openDeleteModal() {
    if (!current) return;
    const message = el('evolutionDeleteMessage');
    if (message) {
        message.textContent = t('Supprimer la base « ${name} » et ses ${n} caches ? Les fichiers CSV d\'origine ne sont pas touchés.', {
            name: current.name,
            n: formatNumber(current.stats?.total ?? 0),
        });
    }
    showBsModal('modalEvolutionDelete');
}

async function confirmDelete() {
    if (!current) return;
    if (clock.running) {
        pkg.showToast(t("Arrêtez l'animation avant de supprimer la base."), 'warning', t('Attention'));
        return;
    }
    const id = current.id;
    try {
        const response = await fetch(`${CONFIG.BASE_URL}/api/evolution/datasets/${id}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            pkg.showToast(data.message || t('Suppression impossible'), 'error', t('Erreur'));
            return;
        }
        hideBsModal('modalEvolutionDelete');
        current = null;
        try { await saveSettingsPatch({ evolution_dataset_id: null }); } catch (_) {}
        await refreshDatasets();
    } catch (e) {
        pkg.showToast(t('Erreur : ${message}', { message: e.message }), 'error', t('Erreur'));
    }
}

// --- Glisser-déposer de CSV ------------------------------------------------------------------

function setupCsvDragAndDrop() {
    if (!document.body) return;
    const overlay = document.createElement('div');
    overlay.id = 'evolutionDropOverlay';
    overlay.className = 'gpx-drop-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'gpx-drop-overlay__inner';
    const icon = document.createElement('i');
    icon.className = 'ti ti-file-upload';
    const text = document.createElement('div');
    text.className = 'gpx-drop-overlay__text';
    text.textContent = t('Déposez vos exports CSV pour les ajouter à la base');
    inner.append(icon, text);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    const hasFiles = (e) => Array.prototype.indexOf.call(e.dataTransfer?.types || [], 'Files') !== -1;
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
        handleCsvFiles(Array.from(e.dataTransfer.files || []));
    });
    window.addEventListener('dragend', hide);
}

// --- Utilitaires -------------------------------------------------------------------------------

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    return data;
}

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
