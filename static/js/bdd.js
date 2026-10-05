import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showInfo, t } from './notifications.js';
import { clearMap } from './mapgl.js';
import { showBsModal } from './ui_bootstrap.js';
import { inclusiveDayCount } from './video_timing.mjs';
import { isEvolutionPage } from './app_mode.mjs';

export let json_data = null;
export const metadata = {};
export const pointsByDate = new Map();
// Révision de l'index : change à chaque reconstruction (import, filtre, vidage).
// Le trajet des traits de déplacement, précalculé à partir de l'index, s'en sert
// comme clé de mémoïsation.
export let pointsByDateRevision = 0;
export let totalCaches = 0;

let readLoadingToast = null;
let noCacheToast = null;

// Dernier verdict connu de /db_status (renseigné par readBddValues, lancée
// en parallèle du démarrage) : true = base non vide, false = vide ou absente,
// null = pas encore tranché. readBdd s'en sert pour choisir son retour
// visuel sans requête supplémentaire.
let lastDbHasData = null;

// Jeu de données complet (toutes les caches) conservé en mémoire pour permettre
// un filtrage 100% côté client, sans aller-retour serveur. Alimenté à chaque
// chargement complet (readBdd / loadAndDisplayPoints) et remis à null au vidage.
let baseGeojson = null;

// Gestionnaire pour le chargement automatique lors de la sélection de fichier
const fileInput = document.getElementById('file-input');

// Input fichier stylé : l'input natif est visuellement masqué, un bouton
// « Parcourir… » ouvre le sélecteur et une zone à côté affiche le nom du
// dernier fichier choisi (l'input garde ses listeners métier ci-dessous).
const fileInputBtn = document.getElementById('file-input-btn');
const fileInputName = document.getElementById('file-input-name');
if (fileInputBtn && fileInput) {
    fileInputBtn.addEventListener('click', () => fileInput.click());
}
// Variante compacte affichée quand une base est déjà chargée (menu_data.html,
// bloc .data-has-only) : même délégation à l'input masqué.
const fileInputBtnCompact = document.getElementById('file-input-btn-compact');
if (fileInputBtnCompact && fileInput) {
    fileInputBtnCompact.addEventListener('click', () => fileInput.click());
}
if (fileInput && fileInputName) {
    // Enregistré AVANT le listener d'upload : uploadBddRequest vide
    // input.value dans le même événement (pour permettre la re-sélection
    // du même fichier), un listener ajouté après lirait déjà une liste vide.
    fileInput.addEventListener('change', () => {
        fileInputName.textContent = (fileInput.files && fileInput.files.length)
            ? fileInput.files[0].name
            : t('Aucun fichier sélectionné');
    });
}

if (fileInput) {
    fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            // Lancer automatiquement le chargement quand un fichier est sélectionné
            uploadBddRequest(e);
        }
    });
}

const clearDatabaseBtn = document.getElementById('clearDatabaseBtn');
if (clearDatabaseBtn) {
    clearDatabaseBtn.addEventListener('click', clearDatabase);
}

// Bouton d'import de l'état vide (app.html) : délègue au clic à #file-input,
// mais reste cliquable si on ne le désactive pas explicitement pendant un import.
const emptyStateImportBtn = document.getElementById('btnEmptyStateImport');

// Lien d'aide de l'état vide : ouvre la modale #modal_first_use, désormais
// purement informative (« Comment obtenir mon fichier .gpx ? ») depuis
// qu'elle ne s'affiche plus automatiquement au premier lancement.
const emptyStateGpxHelp = document.getElementById('btnEmptyStateGpxHelp');
if (emptyStateGpxHelp) {
    emptyStateGpxHelp.addEventListener('click', () => {
        try { showBsModal('modal_first_use'); } catch (e) {
            console.warn('Affichage de la modale d\'aide impossible:', e);
        }
    });
}

// --- Verrouillage des contrôles pendant un import --------------------------
// Un import vide puis remplit la table Geocache en une transaction côté
// serveur (voir bdd.py:uploadBdd). Lancer un second import ou un vidage de
// base pendant qu'un premier tourne entrelacerait ces opérations. On désactive
// donc les points d'entrée (inputs fichier, bouton de suppression) pendant
// toute la durée d'un import ; le drag & drop, qui ne passe pas par ces
// éléments (listeners globaux sur window), est bloqué via le flag ci-dessous.
let importInProgress = false;

function setImportControlsDisabled(disabled) {
    if (fileInput) fileInput.disabled = disabled;
    // Le bouton « Parcourir… » est le point d'entrée visible de l'input :
    // il suit le même verrouillage pendant un import.
    if (fileInputBtn) fileInputBtn.disabled = disabled;
    if (clearDatabaseBtn) clearDatabaseBtn.disabled = disabled;
    if (emptyStateImportBtn) emptyStateImportBtn.disabled = disabled;
}

function beginImport() {
    importInProgress = true;
    setImportControlsDisabled(true);
}

function endImport() {
    importInProgress = false;
    setImportControlsDisabled(false);
}

// --- Drag & drop de fichiers GPX -----------------------------------------
// Un overlay plein écran apparaît dès qu'un fichier est glissé au-dessus de la
// fenêtre (n'importe où, y compris sur la carte). Le drop route vers le même
// pipeline d'upload que les inputs fichier.

function isGpxFile(file) {
    return !!file && /\.gpx$/i.test(file.name || '');
}

// Pocket Query telle que téléchargée sur geocaching.com : le serveur en
// extrait le GPX (bdd.py:extract_gpx_from_zip).
function isZipFile(file) {
    return !!file && /\.zip$/i.test(file.name || '');
}

// Un vrai GPX "My Finds" ne dépasse jamais quelques dizaines de Mo ; au-delà,
// il s'agit presque certainement du mauvais fichier. On bloque tôt plutôt que
// de laisser l'utilisateur attendre un upload voué à l'échec.
const GPX_MAX_SIZE_BYTES = 200 * 1024 * 1024; // 200 Mo
// Nombre d'octets lus en tête de fichier pour sniffer <name>/<desc>/<author>
// avant le premier <wpt>, sans upload réseau (cf. GPX_HEADER_SNIFF_BYTES ci-dessous
// et bdd.py:_read_gpx_header pour la même logique, côté serveur, en streaming).
const GPX_HEADER_SNIFF_BYTES = 64 * 1024;

// Extrait le texte du premier tag <tagName>...</tagName> rencontré (sans
// espace de nom). Suffisant ici : les tags d'en-tête GPX (<name>, <desc>,
// <author>) ne sont jamais préfixés dans les exports Groundspeak.
function extractFirstTagText(text, tagName) {
    const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
}

// Sniffe l'en-tête GPX (avant le 1er <wpt>) pour vérifier localement qu'il
// s'agit d'un fichier "My Finds" Groundspeak — sans envoyer le fichier au
// serveur. Reproduit la logique de bdd.py:validate_gpx_header (source unique
// de vérité côté serveur) ; le rejet définitif reste toujours fait côté
// serveur, cette étape n'est qu'une pré-validation pour économiser la bande
// passante sur les cas évidents.
async function sniffGpxHeader(file) {
    let head;
    try {
        head = await file.slice(0, GPX_HEADER_SNIFF_BYTES).text();
    } catch (e) {
        // Lecture locale impossible : ne pas bloquer, le serveur validera.
        return { checked: false };
    }

    const wptIndex = head.search(/<wpt[\s>]/i);
    const headerText = wptIndex === -1 ? head : head.slice(0, wptIndex);

    const nameText = extractFirstTagText(headerText, 'name');
    const descText = extractFirstTagText(headerText, 'desc');
    const authorText = extractFirstTagText(headerText, 'author');

    // Aucun tag d'en-tête trouvé ET aucun <wpt> atteint dans la portion lue :
    // fichier atypique (en-tête anormalement long) — on ne peut pas conclure,
    // on laisse passer et le serveur validera pleinement.
    if (nameText === null && descText === null && authorText === null && wptIndex === -1) {
        return { checked: false };
    }

    const isGroundspeak = (descText && descText.includes('Groundspeak'))
        || (authorText && authorText.includes('Groundspeak'));
    if (!isGroundspeak) {
        return { checked: true, ok: false, message: t("Le fichier GPX n'est pas un fichier produit par Groundspeak.") };
    }

    if (!nameText || !nameText.includes('My Finds Pocket Query')) {
        return { checked: true, ok: false, message: t("Le fichier GPX est une Pocket Query et non un fichier My Finds.") };
    }

    return { checked: true, ok: true };
}

// Validation cliente avant tout envoi réseau : extension, taille, puis
// contenu de l'en-tête (lu localement, sans upload).
async function validateGpxFile(file) {
    const isZip = isZipFile(file);
    if (!isGpxFile(file) && !isZip) {
        return { ok: false, message: t('Veuillez sélectionner un fichier .gpx ou .zip') };
    }
    if (file.size === 0) {
        return { ok: false, message: t('Le fichier sélectionné est vide') };
    }
    if (file.size > GPX_MAX_SIZE_BYTES) {
        return { ok: false, message: t('Le fichier est trop volumineux (200 Mo max)') };
    }

    // Contenu compressé : pas de sniff d'en-tête possible, le serveur valide.
    if (isZip) {
        return { ok: true };
    }

    const header = await sniffGpxHeader(file);
    if (header.checked && !header.ok) {
        return { ok: false, message: header.message };
    }
    return { ok: true };
}

// Point d'entrée unique pour tout fichier GPX à charger (sélection via input
// ou glisser-déposer) : valide localement, puis lance l'upload.
async function handleGpxFile(file) {
    if (importInProgress) {
        // Les inputs/bouton sont désactivés pendant un import, mais le drag &
        // drop passe par des listeners globaux sur window : cette garde le
        // couvre aussi (double clic très rapide, drop pendant la validation
        // asynchrone du fichier précédent, etc.).
        showError(t('Un import est déjà en cours, veuillez patienter.'), t('Import en cours'));
        return;
    }

    // Retour visuel immédiat : validateGpxFile lit l'en-tête du fichier sur
    // disque, ce qui peut prendre plusieurs secondes sur un gros GPX. Sans
    // toast dès le dépôt/la sélection, l'utilisateur n'a aucun signe que le
    // chargement a démarré. La toast créée ici est réutilisée ensuite par
    // uploadBdd pour l'envoi et le suivi serveur.
    let earlyToast = null;
    try { earlyToast = pkg.showLoadingToast(t('Analyse du fichier GPX en cours...'), t('Chargement')); } catch (_) {}
    // Indicateur inline de l'état vide de la carte (« Chargez votre fichier
    // .gpx pour commencer »), visible justement quand aucune donnée n'est
    // chargée.
    showUploadIndicator('emptyStateUploadProgress',
        t('Analyse du fichier GPX en cours...'));

    const result = await validateGpxFile(file);
    if (!result.ok) {
        try { pkg.hideToast(earlyToast); } catch (_) {}
        hideUploadIndicator('emptyStateUploadProgress');
        showError(result.message, t('Fichier invalide'));
        return;
    }
    uploadBdd(file, earlyToast);
}

// Vrai si le drag transporte des fichiers (et non du texte/HTML).
function dragHasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    // dt.types peut être un DOMStringList ou un array selon le navigateur.
    return Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
}

function setupGpxDragAndDrop() {
    if (!document.body) return;

    let overlay = document.getElementById('gpxDropOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gpxDropOverlay';
        overlay.className = 'gpx-drop-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML =
            '<div class="gpx-drop-overlay__inner">' +
            '<i class="ti ti-file-upload"></i>' +
            '<div class="gpx-drop-overlay__text">' +
            t('Déposez votre fichier .gpx pour le charger') +
            '</div></div>';
        document.body.appendChild(overlay);
    }

    // Compteur de profondeur : dragenter/dragleave se déclenchent aussi au
    // passage d'un élément enfant à l'autre ; on ne masque l'overlay que
    // lorsqu'on a réellement quitté la fenêtre.
    let dragDepth = 0;
    const show = () => overlay.classList.add('is-visible');
    const hide = () => { dragDepth = 0; overlay.classList.remove('is-visible'); };

    window.addEventListener('dragenter', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        show();
    });
    window.addEventListener('dragover', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault(); // indispensable pour autoriser le drop
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    window.addEventListener('dragleave', (e) => {
        if (!dragHasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hide();
    });
    window.addEventListener('drop', (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        hide();
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleGpxFile(file);
    });
    // Sécurité : si le drag est abandonné hors fenêtre, masquer l'overlay.
    window.addEventListener('dragend', hide);
}

// Page du mode Évolution : le glisser-déposer y importe des CSV (evolution_data.js).
if (!isEvolutionPage()) setupGpxDragAndDrop();

// Lit l'état de la BDD (/db_status) et le reflète dans l'UI (texte d'infos +
// visibilité du bouton de vidage). Avec { settleFirstUse: true } (uniquement
// au démarrage), publie en fin de requête le jalon « première utilisation
// réglée » attendu par les tests/intégrations : sans données, c'est l'état
// vide de la carte qui invite à charger un GPX (la modale, purement
// informative, ne s'ouvre plus que via le lien d'aide de cet état vide).
// ---- Libellé des informations BDD ------------------------------------------
// « 6 caches · du 1er au 6 janvier 2026 · importé aujourd'hui à 11:35 » :
// les dates brutes renvoyées par /db_status (RFC GMT pour les bornes,
// « YYYY-MM-DD HH:mm:ss » local pour l'import) sont reformattées dans la
// langue de l'interface.

function bddInfoLocale() {
    return pkg.options?.options?.language === 'en' ? 'en-US' : 'fr-FR';
}

function parseBddInfoDate(value) {
    if (!value) return null;
    let d = new Date(value);
    // « 2026-09-25 11:22:21 » n'est pas un format standard : Safari exige le « T ».
    if (isNaN(d) && typeof value === 'string') d = new Date(value.replace(' ', 'T'));
    return isNaN(d) ? null : d;
}

// « du 1er au 6 janvier 2026 » — compresse mois/année partagés en français ;
// en anglais, seule l'année de début identique est omise.
function formatBddDateRange(s, e, locale) {
    const isFr = locale.startsWith('fr');
    const monthName = (d) => d.toLocaleDateString(locale, { month: 'long' });
    const full = (d) => d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    const dayNum = (d) => (isFr && d.getDate() === 1 ? '1er' : String(d.getDate()));

    if (s.toDateString() === e.toDateString()) {
        return t('le ${date}', { date: full(s) });
    }
    const sameYear = s.getFullYear() === e.getFullYear();
    const sameMonth = sameYear && s.getMonth() === e.getMonth();
    let startPart, endPart;
    if (isFr) {
        if (sameMonth)     { startPart = dayNum(s); endPart = `${dayNum(e)} ${monthName(e)} ${e.getFullYear()}`; }
        else if (sameYear) { startPart = `${dayNum(s)} ${monthName(s)}`; endPart = `${dayNum(e)} ${monthName(e)} ${e.getFullYear()}`; }
        else               { startPart = `${dayNum(s)} ${monthName(s)} ${s.getFullYear()}`; endPart = `${dayNum(e)} ${monthName(e)} ${e.getFullYear()}`; }
    } else {
        if (sameYear) { startPart = s.toLocaleDateString(locale, { month: 'long', day: 'numeric' }); endPart = full(e); }
        else          { startPart = full(s); endPart = full(e); }
    }
    return t('du ${start} au ${end}', { start: startPart, end: endPart });
}

// « aujourd'hui à 11:35 », « hier à 11:35 », « le 25 septembre 2026 »
function formatBddLoadWhen(d, locale) {
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return t("aujourd'hui à ${time}", { time });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return t('hier à ${time}', { time });
    const date = d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    return t('le ${date}', { date });
}

function formatBddInfos(data) {
    const locale = bddInfoLocale();
    const total = data.totalPoints ?? 0;
    const start = parseBddInfoDate(data.startDate);
    const end = parseBddInfoDate(data.endDate);
    const load = parseBddInfoDate(data.loadDate);

    // Libellé singulier/pluriel résolu hors du template literal pour que
    // l'extracteur Babel voie les deux msgids.
    const countLabel = total > 1 ? t('caches') : t('cache');
    const parts = [`${total} ${countLabel}`];
    if (start && end) parts.push(formatBddDateRange(start, end, locale));
    if (load) parts.push(t('importé ${when}', { when: formatBddLoadWhen(load, locale) }));
    return parts.join(' · ');
}

// Jalon du démarrage, pour les tests navigateur et les intégrations (même rôle
// que window.mygcflowReady) : la vérification « première utilisation »
// (/db_status, lancée en parallèle du démarrage) est terminée — base vide ou
// non, l'écran d'accueil (état vide ou points) est tranché. Ce signal arrivant
// après un aller-retour réseau, indépendamment de mygcflowReady, un test sait
// ainsi quand l'accueil est stabilisé.
function markFirstUseSettled() {
    window.mygcflowFirstUseSettled = true;
    window.dispatchEvent(new CustomEvent('mygcflow:first-use-settled'));
}

export function readBddValues({ settleFirstUse = false } = {}){
    try {
        fetch(`${CONFIG.BASE_URL}/db_status`)
        .then(response => response.json())
        .then(data => {
            const infos = document.getElementById('infosBDD');

            // "A des données" = base présente ET non vide. Les deux autres cas
            // (vide, ou inexistante) sont traités de façon identique côté UI.
            const hasData = !!(data && data.exists && data.isEmpty === false);
            lastDbHasData = hasData;

            const text = hasData
                ? formatBddInfos(data)
                : t('Aucune trouvaille chargée');

            if (infos) infos.textContent = text;

            const btn = document.getElementById('clearDatabaseBtn');
            if (btn) btn.style.display = hasData ? '' : 'none';

            // Appel du démarrage : la question « première utilisation » est
            // tranchée, quel que soit le verdict.
            if (settleFirstUse) markFirstUseSettled();
        })
        .catch(err => {
            console.error('Erreur lecture infos BDD:', err);
            if (settleFirstUse) markFirstUseSettled();
        });
    } catch (e) {
        console.error('readBddValues error:', e);
    }
}

function setMetadata(meta) {
    try {
        for (const k of Object.keys(metadata)) {
            delete metadata[k];
        }
        if (meta && typeof meta === 'object') {
            Object.assign(metadata, meta);
        }
        // parseLocalDate évite le décalage de jour des chaînes "YYYY-MM-DD"
        // parsées en UTC par new Date() dans les fuseaux à l'ouest de Greenwich.
        if (metadata.startDate) {
            metadata.startDate = pkg.parseLocalDate(metadata.startDate);
        }
        if (metadata.endDate) {
            metadata.endDate = pkg.parseLocalDate(metadata.endDate);
        }
        if (metadata.publishedStartDate) {
            metadata.publishedStartDate = pkg.parseLocalDate(metadata.publishedStartDate);
        }
        if (metadata.publishedEndDate) {
            metadata.publishedEndDate = pkg.parseLocalDate(metadata.publishedEndDate);
        }
    } catch (e) {
        console.warn('setMetadata error:', e);
    }
}

function clearLocalData() {
    json_data = null;
    baseGeojson = null;
    for (const k of Object.keys(metadata)) delete metadata[k];
    pointsByDate.clear();
    pointsByDateRevision++;
    totalCaches = 0;
    lastDbHasData = false;
}

// Emprise [ouest, sud, est, nord] (EPSG:4326) des points chargés, null si
// aucun. Sert au cadrage automatique (préférence map_framing = "fit") et au
// bouton « Cadrer sur les Geocaches » de l'onglet Paramètres.
export function dataExtentLonLat() {
    const feats = json_data && json_data.features;
    if (!Array.isArray(feats) || feats.length === 0) return null;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const f of feats) {
        const c = f && f.geometry && f.geometry.coordinates;
        if (!c || c.length < 2) continue;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }
    return west === Infinity ? null : [west, south, east, north];
}

// Recadre la vue sur l'emprise des données chargées. Sans `force`, ne fait
// rien quand la préférence map_framing n'est pas « fit » (l'utilisateur a
// choisi un centre/zoom personnalisés), ni pendant une animation ou un
// enregistrement où un saut de caméra casserait le rendu. Avec `force`
// (bouton dédié, bascule vers le mode « fit »), le cadrage est appliqué dans
// tous les cas.
export function fitViewOnData({ force = false } = {}) {
    const extent = dataExtentLonLat();
    if (!extent) return;
    if (!force) {
        if (window.userSettings?.map_framing !== 'fit') return;
        if (pkg.isAnimationInProgress?.()) return;
    }
    pkg.fitMapView?.(extent);
}

function updateUIAfterClear() {
    const infos = document.getElementById('infosBDD');
    const btn = document.getElementById('clearDatabaseBtn');

    if (infos) infos.textContent = t('Aucune trouvaille chargée');
    if (btn) btn.style.display = 'none';
    // Compteur « 0 / 0 », badge d'onglet, toast « aucune cache » et état
    // « filtre actif » du panneau passent tous par l'écrivain unique.
    updateFiltersCounter(0, 0);

    // Sans données, Lecture/Enregistrement n'ont plus rien à animer et
    // l'état vide revient sur la carte.
    try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) { console.warn('updateDataAvailabilityUI error:', e); }
}

function buildPointsByDateIndex(features = []) {
    pointsByDateRevision++;
    try {
        pointsByDate.clear();
        if (!Array.isArray(features)) return;

        for (const f of features) {
            const dateStr = f?.properties?.date_find;
            if (!dateStr) continue;
            const d = new Date(`${dateStr}T00:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const key = d.toDateString();
            const arr = pointsByDate.get(key) || [];
            arr.push(f);
            pointsByDate.set(key, arr);
        }
    } catch (e) {
        console.warn('buildPointsByDateIndex error:', e);
    }
}

function dateStrToDate() {
    // Historique: conversion des dates côté frontend.
    // Désormais l'index pointsByDate fait l'essentiel (via buildPointsByDateIndex).
}

// --- Filtrage côté client -------------------------------------------------
// Reproduit fidèlement la sémantique du filtrage serveur
// (geojson_cache.py : _matches_filters / build_metadata_from_features) afin
// d'éviter tout aller-retour réseau lorsqu'un filtre change. Les dates (find /
// published) et les bornes des date pickers sont au format ISO 'YYYY-MM-DD',
// donc comparables lexicographiquement.

function toFloatSet(values) {
    const s = new Set();
    for (const v of values || []) {
        const n = Number(v);
        if (Number.isFinite(n)) s.add(n);
    }
    return s;
}

function toStrSet(values) {
    const s = new Set();
    for (const v of values || []) s.add(String(v));
    return s;
}

function normIsoDate(value) {
    if (typeof value !== 'string' || value.length < 10) return null;
    const iso = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

// Vrai si le <select multiple> possède au moins une option réelle (hors
// placeholder disabled à valeur vide). Sert à distinguer "l'utilisateur a
// désélectionné toutes les options (Aucun)" de "la dimension n'a aucune option".
function selectHasRealOptions(selectId) {
    const el = document.getElementById(selectId);
    if (!el) return false;
    return Array.from(el.options).some(o => !o.disabled && o.value !== '');
}

function filterFeaturesClientSide(features, sel) {
    const types = new Set(sel.type || []);
    // Aucun type sélectionné => aucun résultat (comportement identique au serveur).
    if (types.size === 0) return [];

    const terrains = toFloatSet(sel.terrain);
    const difficulties = toFloatSet(sel.difficulty);
    const containers = toStrSet(sel.container);
    const countries = toStrSet(sel.countries);
    const states = toStrSet(sel.states);

    // "Aucun" (aucune option sélectionnée) => aucun résultat, comme pour le type.
    // terrain / difficulté / taille ont toujours des options fixes : un ensemble
    // vide y signifie donc sans ambiguïté "Aucun" et non "pas de filtre".
    if (terrains.size === 0 || difficulties.size === 0 || containers.size === 0) return [];

    // Pays / régions sont peuplés dynamiquement. Un ensemble vide veut dire "Aucun"
    // seulement si le <select> possède réellement des options ; sinon (aucune donnée
    // géographique disponible) la dimension est inactive et ne doit pas filtrer.
    if (selectHasRealOptions('selectCountry') && countries.size === 0) return [];
    if (selectHasRealOptions('selectState') && states.size === 0) return [];

    const dStart = normIsoDate(sel.dates?.startDate);
    const dEnd = normIsoDate(sel.dates?.endDate);
    const dateActive = !!(dStart && dEnd);

    const pStart = normIsoDate(sel.published_dates?.startDate);
    const pEnd = normIsoDate(sel.published_dates?.endDate);
    const pubActive = !!(pStart && pEnd);

    const matchFloat = (val, set) => {
        if (set.size === 0) return true;
        const n = Number(val);
        return Number.isFinite(n) && set.has(n);
    };
    const matchStr = (val, set) => set.size === 0 || set.has(String(val));

    const out = [];
    for (const f of features) {
        const p = (f && f.properties) || {};
        if (!types.has(p.cache_type)) continue;
        if (!matchFloat(p.terrain, terrains)) continue;
        if (!matchFloat(p.difficulty, difficulties)) continue;
        if (!matchStr(p.container, containers)) continue;
        if (!matchStr(p.country, countries)) continue;
        if (!matchStr(p.state, states)) continue;
        if (dateActive) {
            const df = normIsoDate(p.date_find);
            if (!df || df < dStart || df > dEnd) continue;
        }
        if (pubActive) {
            const pd = normIsoDate(p.published_date);
            if (!pd || pd < pStart || pd > pEnd) continue;
        }
        out.push(f);
    }
    return out;
}

function buildMetadataClientSide(features) {
    if (!features || features.length === 0) {
        return {
            startDate: null, endDate: null, deltaDays: null,
            numberOfCaches: 0, publishedStartDate: null, publishedEndDate: null,
        };
    }
    let minFind = null, maxFind = null, minPub = null, maxPub = null;
    for (const f of features) {
        const p = (f && f.properties) || {};
        const df = p.date_find;
        if (df) {
            if (minFind === null || df < minFind) minFind = df;
            if (maxFind === null || df > maxFind) maxFind = df;
        }
        const pd = p.published_date;
        if (pd) {
            if (minPub === null || pd < minPub) minPub = pd;
            if (maxPub === null || pd > maxPub) maxPub = pd;
        }
    }
    let deltaDays = null;
    if (minFind && maxFind) {
        // Comptage inclusif normalisé UTC (identique au serveur et à
        // video_timing.mjs) : l'animation joue le premier et le dernier jour.
        const a = new Date(`${minFind}T00:00:00`);
        const b = new Date(`${maxFind}T00:00:00`);
        deltaDays = inclusiveDayCount(a, b);
        if (!Number.isFinite(deltaDays) || deltaDays < 1) deltaDays = null;
    }
    return {
        startDate: minFind, endDate: maxFind, deltaDays,
        numberOfCaches: features.length,
        publishedStartDate: minPub, publishedEndDate: maxPub,
    };
}

function updateOptionsValues(meta) {
    try {
        if (!meta || typeof meta !== 'object') return;
        if (typeof meta.deltaDays === 'number') {
            pkg.options.date.deltaDays = meta.deltaDays;
        }
        if (meta.startDate) {
            pkg.options.date.startDate = pkg.parseLocalDate(meta.startDate);
        }
        if (meta.endDate) {
            pkg.options.date.endDate = pkg.parseLocalDate(meta.endDate);
        }
        if (!(pkg.options.animation.dateStart instanceof Date) && meta.startDate) {
            pkg.options.animation.dateStart = pkg.parseLocalDate(meta.startDate);
        }
        if (!(pkg.options.animation.dateEnd instanceof Date) && meta.endDate) {
            pkg.options.animation.dateEnd = pkg.parseLocalDate(meta.endDate);
        }
    } catch (e) {
        console.warn('updateOptionsValues error:', e);
    }
}

// stallTimeoutMs est un timeout d'INACTIVITÉ (aucune réponse serveur reçue
// depuis stallTimeoutMs), pas un plafond de durée totale : il est repoussé à
// chaque réponse valide, quel que soit l'état/la progression rapportés. Un
// gros import peut légitimement rester plusieurs minutes à progress=99
// ("Enregistrement en base de données...", cf. bdd.py) sans que le
// pourcentage bouge — un timeout basé sur la durée totale afficherait alors
// une erreur côté client alors que l'import continue et réussit côté serveur.
// maxConsecutiveErrors tolère quelques ratés réseau transitoires (Wi-Fi qui
// clignote, etc.) sans abandonner tout le suivi de la tâche.
function pollGeojsonTask(taskId, { onSuccess, onError, onProgress, intervalMs = 400, stallTimeoutMs = 120000, maxConsecutiveErrors = 10 } = {}) {
    let lastActivityAt = Date.now();
    let consecutiveErrors = 0;

    const tick = () => {
        if (!taskId) {
            if (typeof onError === 'function') onError(new Error('Missing taskId'));
            return;
        }

        if (Date.now() - lastActivityAt > stallTimeoutMs) {
            if (typeof onError === 'function') onError(new Error('Task polling timeout'));
            return;
        }

        fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`, { method: 'GET' })
        .then(r => r.json())
        .then(status => {
            // Réponse valide reçue : le serveur est joignable et suit toujours
            // la tâche — on repousse le timeout d'inactivité et on remet à
            // zéro le compteur d'erreurs réseau transitoires.
            lastActivityAt = Date.now();
            consecutiveErrors = 0;

            const state = status?.state;

            if (state === 'finished') {
                if (typeof onProgress === 'function') onProgress(100);
                if (status && status.result) {
                    if (typeof onSuccess === 'function') onSuccess(status.result);
                } else {
                    if (typeof onError === 'function') onError(new Error('Task finished without result'));
                }
                return;
            }

            if (state === 'failed') {
                const msg = status?.error || status?.message || 'Task failed';
                if (typeof onError === 'function') onError(new Error(msg));
                return;
            }

            if (typeof onProgress === 'function' && typeof status?.progress === 'number') {
                onProgress(status.progress);
            }

            setTimeout(tick, intervalMs);
        })
        .catch(err => {
            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                if (typeof onError === 'function') onError(err);
                return;
            }
            // Raté réseau isolé (pas une absence de réponse prolongée) : on
            // retente au prochain intervalle plutôt que d'abandonner tout de
            // suite. lastActivityAt n'est volontairement pas repoussé ici :
            // stallTimeoutMs reste le filet de sécurité en cas de panne réelle.
            setTimeout(tick, intervalMs);
        });
    };

    tick();
}

function checkLoadingProgress(toast, taskId, onSuccess, onError, { intervalMs = 400, stallTimeoutMs = 120000, onProgress: onServerProgress = null } = {}) {
    pollGeojsonTask(taskId, {
        intervalMs,
        stallTimeoutMs,
        onProgress: (p) => {
            try { if (toast) pkg.updateToastProgress(toast, p); } catch(_) {}
            if (typeof onServerProgress === 'function') {
                try { onServerProgress(p); } catch(_) {}
            }
        },
        onSuccess: () => {
            if (typeof onSuccess === 'function') onSuccess();
        },
        onError: (err) => {
            try { if (toast) pkg.hideToast(toast); } catch(_) {}
            if (typeof onError === 'function') onError(err?.message || String(err));
        }
    });
}

// --- Indicateur de chargement inline --------------------------------------
// En complément de la toast, un bloc « spinner + libellé + barre de
// progression » existe dans l'état vide de la carte
// (#emptyStateUploadProgress). Il reste visible pendant tout l'import et
// reflète les mêmes phases que la toast, pour qu'il soit évident que le
// traitement est en cours là où l'utilisateur a déposé son fichier.

function showUploadIndicator(containerId, text) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.hidden = false;
    updateUploadIndicator(containerId, text, null);
}

// pct : nombre 0-100 pour une progression connue ; toute autre valeur (null,
// 0, NaN) laisse la barre en mode indéterminé (animation continue).
function updateUploadIndicator(containerId, text, pct) {
    const el = document.getElementById(containerId);
    if (!el || el.hidden) return;
    const label = el.querySelector('.upload-progress-text');
    const bar = el.querySelector('.upload-progress-bar');
    if (label && text) label.textContent = text;
    if (!bar) return;
    if (typeof pct === 'number' && isFinite(pct) && pct > 0) {
        const clamped = Math.min(100, Math.max(0, pct));
        bar.classList.remove('progress-bar-indeterminate');
        bar.style.width = `${clamped}%`;
        bar.setAttribute('aria-valuenow', String(clamped));
    } else {
        bar.classList.add('progress-bar-indeterminate');
        bar.style.width = '100%';
        bar.setAttribute('aria-valuenow', '0');
    }
}

function hideUploadIndicator(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.hidden = true;
}

// Envoie le fichier GPX via XMLHttpRequest plutôt que fetch : fetch ne rapporte
// aucune progression d'envoi, la toast resterait donc figée pendant tout le
// transfert d'un gros fichier sur une connexion lente. xhr.upload.progress
// permet d'afficher l'avancement réel ("Envoi du fichier : 43 %").
// Une fois le fichier reçu par le serveur, la promesse se résout et l'appelant
// bascule sur checkLoadingProgress, qui pilote la barre pour la phase suivante
// (parsing + import côté serveur — une échelle 0-100 distincte de l'upload).
// `hooks` (optionnel) permet de répercuter les phases sur un indicateur
// inline : onProgress(pct) pendant l'envoi, onPhase(message) au passage au
// traitement serveur.
function uploadGpxWithProgress(file, toast, hooks = null) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);

        xhr.upload.addEventListener('progress', (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.round((e.loaded / e.total) * 100);
            try {
                pkg.updateToastProgress(toast, pct);
                pkg.updateToastMessage(toast, t('Envoi du fichier : ${pct}%', { pct }));
            } catch (_) {}
            if (hooks && typeof hooks.onProgress === 'function') {
                try { hooks.onProgress(pct); } catch (_) {}
            }
        });

        xhr.addEventListener('load', () => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                reject(new Error(t('Réponse invalide du serveur')));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300 || !data.success || !data.task_id) {
                reject(new Error(data.message || t("Impossible de lancer l'import GPX")));
                return;
            }
            // Transfert terminé : bascule visuellement vers la phase de
            // traitement serveur, dont la progression est pilotée séparément
            // par checkLoadingProgress (appelé par l'appelant avec data.task_id).
            try {
                pkg.updateToastMessage(toast, t('Traitement du fichier en cours...'));
                pkg.setIndeterminateProgress(toast);
            } catch (_) {}
            if (hooks && typeof hooks.onPhase === 'function') {
                try { hooks.onPhase(t('Traitement du fichier en cours...')); } catch (_) {}
            }
            resolve(data);
        });

        xhr.addEventListener('error', () => reject(new Error(t("Erreur réseau lors de l'envoi du fichier"))));
        xhr.addEventListener('abort', () => reject(new Error(t('Envoi du fichier annulé'))));

        xhr.open('POST', `${CONFIG.BASE_URL}/upload`);
        xhr.send(formData);
    });
}

function uploadBddRequest(e){
    e.preventDefault();

    var fileInput = document.getElementById('file-input');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError(t("Veuillez sélectionner un fichier .gpx"), t("Aucun fichier"));
        return;
    }

    // Réinitialiser la valeur dès maintenant pour qu'une re-sélection du
    // même fichier (typiquement après un échec) déclenche à nouveau l'événement
    // change. Le fichier est capturé ci-dessus et passé explicitement à handleGpxFile.
    fileInput.value = '';

    // handleGpxFile valide localement (extension/taille/en-tête) avant tout envoi
    // réseau, puis appelle /upload. La validation complète reste faite côté
    // serveur (uploadBdd) : un fichier invalide qui passerait le sniff client
    // serait quand même rejeté par la tâche de fond.
    handleGpxFile(selectedFile);
}

function uploadBdd (file, uploadToast){
    // Verrouiller les contrôles (inputs, bouton de suppression) pour toute la
    // durée de l'import : évite qu'un second import ou un vidage de base ne
    // s'entrelace avec celui-ci.
    beginImport();

    // La toast est créée dans handleGpxFile dès la sélection du fichier (elle
    // couvre déjà la phase de validation locale) : on la réutilise pour
    // l'envoi puis le suivi serveur plutôt que d'en empiler une seconde.
    if (!uploadToast) uploadToast = pkg.showLoadingToast(t("Préparation de l'envoi..."), t("Chargement"));
    else { try { pkg.updateToastMessage(uploadToast, t("Préparation de l'envoi...")); } catch (_) {} }

    // Indicateur inline de l'état vide (« Chargez votre fichier .gpx pour
    // commencer »), mis à jour en miroir des phases de la toast.
    const indicatorId = 'emptyStateUploadProgress';
    showUploadIndicator(indicatorId, t("Préparation de l'envoi..."));
    const indicatorHooks = {
        onProgress: (pct) => updateUploadIndicator(indicatorId, t('Envoi du fichier : ${pct}%', { pct }), pct),
        onPhase: (msg) => updateUploadIndicator(indicatorId, msg, null),
    };

    uploadGpxWithProgress(file, uploadToast, indicatorHooks)
    .then(data => {
        checkLoadingProgress(uploadToast, data.task_id, () => {
            endImport();
            console.log('[uploadBdd] Import terminé, lancement loadAndDisplayPoints');
            pkg.hideToast(uploadToast);
            hideUploadIndicator(indicatorId);
            // Succès d'import : toast brève (4 s), l'information durable est
            // déjà portée par #infosBDD et #dataNextStep.
            pkg.showToast(t("Fichier chargé avec succès !"), "success", t("Terminé"), 4000);

            // mets à jour les infos de la BDD
            readBddValues();

            // Charger et afficher les points sur la carte
            loadAndDisplayPoints();
        }, (message) => {
            endImport();
            console.error('[uploadBdd] Erreur import:', message);
            pkg.hideToast(uploadToast);
            hideUploadIndicator(indicatorId);
            pkg.showToast(message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
        }, { onProgress: (p) => updateUploadIndicator(indicatorId, t('Traitement du fichier en cours...'), p) });
    })
    .catch(error => {
        endImport();
        console.error('Error:', error);
        pkg.hideToast(uploadToast);
        hideUploadIndicator(indicatorId);
        pkg.showToast(error?.message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
    });
}

// Retour visuel du chargement des données : plus de toast globale au
// démarrage (elle masquait les préréglages de disposition et n'offrait
// aucune action).
// - Base connue vide : l'état vide peut être affiché sans attendre la fin
//   du chargement (le verdict /db_status fait déjà foi) et l'indicateur
//   inline qu'il contient (#emptyStateUploadProgress) reflète la
//   progression à la place de la toast ;
// - base connue non vide (volume réel à relire) : la toast de chargement
//   reste utilisée pour ce seul cas non trivial ;
// - verdict /db_status pas encore connu : rien n'est montré, l'état vide
//   ou les points apparaissent en fin de chargement.
// aria-busy signale dans tous les cas la mise à jour du panneau de réglages.
export function readBdd(){
    const READ_INDICATOR_ID = 'emptyStateUploadProgress';
    const tabsPanel = document.getElementById('tabsPanel');
    const baseKnownLoaded = lastDbHasData === true || (Number(totalCaches) || 0) > 0;

    if (!baseKnownLoaded && lastDbHasData === false) {
        try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) {}
    }

    // L'indicateur inline ne sert que si l'état vide qui le contient est
    // réellement affiché (et présent dans le DOM : absent en mode Évolution).
    const emptyState = document.getElementById('emptyState');
    const readIndicator = document.getElementById(READ_INDICATOR_ID);
    const useInlineIndicator = !baseKnownLoaded && !!readIndicator
        && !!emptyState && getComputedStyle(emptyState).display !== 'none';

    if (tabsPanel) tabsPanel.setAttribute('aria-busy', 'true');
    if (useInlineIndicator) {
        showUploadIndicator(READ_INDICATOR_ID, t("Chargement de l'application..."));
    } else if (baseKnownLoaded) {
        try { readLoadingToast = pkg.showLoadingToast(t("Chargement de l'application..."), t('Chargement')); } catch(e) {}
    }

    // Tous les chemins de fin passent par ici : indicateur inline, toast
    // éventuelle et aria-busy sont refermés quoi qu'il arrive.
    const finishReadIndicators = () => {
        try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
        hideUploadIndicator(READ_INDICATOR_ID);
        if (tabsPanel) tabsPanel.removeAttribute('aria-busy');
    };

    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
    .then(response => response.json())
    .then(data => {
        if (!data.task_id) {
            throw new Error(data.message || t('Impossible de lancer le chargement des données'));
        }
        pollGeojsonTask(data.task_id, {
            onProgress: (p) => {
                if (useInlineIndicator) {
                    // Texte inchangé : la progression est portée par la barre
                    // (réécrire le libellé à chaque % spammerait aria-live).
                    updateUploadIndicator(READ_INDICATOR_ID, null, p);
                } else {
                    try { if (readLoadingToast) pkg.updateToastProgress(readLoadingToast, p); } catch(_) {}
                }
            },
            onSuccess: (result) => {
                if (result.error || !result.geojson) {
                    console.error('Erreur tâche GeoJSON (readBdd):', result.error || 'geojson manquant');
                    finishReadIndicators();
                    return;
                }
                console.log('[readBdd] onSuccess - features:', result.geojson?.features?.length, 'metadata:', result.metadata);
                json_data = result.geojson;
                // Conserver le jeu complet pour le filtrage client-side ultérieur.
                baseGeojson = result.geojson;
                setMetadata(result.metadata || {});

                // Mémoriser le total de caches initial
                totalCaches = metadata.numberOfCaches || (result.geojson?.features?.length || 0);
                lastDbHasData = totalCaches > 0;

                // Pré-calcul de l'index des points par date pour optimiser l'animation
                buildPointsByDateIndex(result.geojson?.features || []);

                // conversion en objet date
                dateStrToDate();
                // MAJ des frames Infos
                pkg.updateInfosFrameAfterReadBdd(metadata);
                // MAJ du menu d'animation
                pkg.updateAnimationMenuAfterReadBdd(metadata);
                // mise à jour des Date Pickers de l'ui (filtre BDD)
                pkg.setPickerDates(metadata);
                // mise à jour des options en fonction de la BDD (dates début et fin)
                updateOptionsValues(metadata);
                console.log('[readBdd] Appel addVector avec', result.geojson?.features?.length, 'features');
                pkg.addVector(result.geojson);

                // Cadrage « fit » : la vue s'ajuste sur l'emprise des données.
                fitViewOnData();

                // Mettre à jour le compteur : sélection = total au chargement initial
                updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                const btn = document.getElementById('clearDatabaseBtn');
                if (btn) btn.style.display = totalCaches > 0 ? '' : 'none';

                finishReadIndicators();
            },
            onError: (err) => {
                console.error('Erreur lors du chargement de la BDD:', err);
                finishReadIndicators();
                // Le chargement a échoué : la question « des données ? » est
                // quand même tranchée (réponse : non) — afficher l'état vide.
                try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) {}
                showError(t('Erreur lors du chargement des données'), t('Erreur'));
            }
        });
    })
    .catch(error => {
        console.error('Error:', error);
        finishReadIndicators();
        try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) {}
        showError(t('Erreur lors du chargement des données'), t('Erreur'));
    });
}

export function changeSelect(selectedValues, optionValues) {
    // Filtrage 100% côté client : le jeu de données complet est déjà en mémoire
    // (baseGeojson). Plus aucun aller-retour serveur — donc plus de tâche, de
    // polling, de toast d'attente ni de mécanisme d'époque anti-race-condition :
    // le traitement est synchrone, il ne peut plus y avoir de résultat obsolète.
    if (!baseGeojson || !Array.isArray(baseGeojson.features)) {
        // Données pas encore chargées : rien à filtrer pour l'instant.
        return;
    }

    const sel = selectedValues || {};
    const filteredFeatures = filterFeaturesClientSide(baseGeojson.features, sel);
    const geojson = { type: 'FeatureCollection', features: filteredFeatures };
    const meta = buildMetadataClientSide(filteredFeatures);

    json_data = geojson;
    setMetadata(meta);

    // Reconstruit l'index des points par date avec les données filtrées
    buildPointsByDateIndex(filteredFeatures);

    // conversion en objet date
    dateStrToDate();
    // remets à jour les options/infos dépendant de la BDD (deltaDays, dates)
    updateOptionsValues(metadata);
    // MAJ des frames Infos
    pkg.updateInfosFrameAfterReadBdd(metadata);
    // Mettre à jour les features affichées sur la carte
    clearMap();
    pkg.addVector(geojson);

    // Mettre à jour le compteur : sélection courante / total initial
    updateFiltersCounter(metadata.numberOfCaches || filteredFeatures.length, totalCaches);
}

// Mode Évolution : les données viennent d'une base de caches importée depuis
// des CSV (evolution_data.js), pas de la base des trouvailles. On renseigne
// l'état partagé dont dépendent l'interface (état vide, compteur de sélection,
// activation de Lecture/Enregistrement) et le moteur (dates de l'animation).
export function setExternalDatasetState(meta, { selected = 0, total = 0 } = {}) {
    json_data = null;
    baseGeojson = null;
    pointsByDate.clear();
    pointsByDateRevision++;
    setMetadata(meta || {});
    totalCaches = Math.max(0, Number(total) || 0);
    updateOptionsValues(metadata);
    updateFiltersCounter(selected, totalCaches);
}

function updateFiltersCounter(selected, total){
    try {
        const el = document.getElementById('filtersCounter');
        if (el) {
            // Badge accolé au titre « Filtres » : le préfixe « Sélection »
            // serait redondant, le compteur reste au format compact « n / total ».
            el.textContent = t('${selected} / ${total}', { selected, total });
        }

        // Bouton « Réinitialiser tous les filtres » : rouge seulement quand
        // un filtre sort de l'état neutre (marqueur data-filters-active lu
        // par la CSS).
        updateFilterPanelState(selected, total);

        // État vide, filtres et actions Lecture/Enregistrement suivent la
        // présence de données (base chargée et sélection non vide).
        try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) { console.warn('updateDataAvailabilityUI error:', e); }

        const badge = document.getElementById('dataTabBadge');
        if (badge) {
            if (total > 0 && selected < total) {
                badge.textContent = `${selected}/${total}`;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }

        // Gérer la toast d'alerte "aucune cache visible"
        if (selected === 0 && total > 0) {
            // Afficher la toast si elle n'existe pas encore
            if (!noCacheToast) {
                noCacheToast = pkg.showToast(t('Aucune cache ne correspond aux critères sélectionnés par les filtres.'), 'warning', t('Aucune cache visible'), 0);
            }

        } else {
            // Fermer la toast si elle existe et qu'il y a des caches affichées
            if (noCacheToast) {
                try {
                    pkg.hideToast(noCacheToast);
                } catch(e) {
                    console.warn('Erreur lors de la fermeture de la toast "aucune cache visible"', e);
                }
                noCacheToast = null;
            }
        }
    } catch(e) { console.warn('updateFiltersCounter error', e); }
}

// Pose data-filters-active sur #filterPanel quand au moins un filtre sort de
// l'état neutre (« tout sélectionné / toutes dates ») ; la CSS repasse alors
// « Réinitialiser tous les filtres » en rouge. L'état exact des contrôles
// (selects Tom Select, datepickers) est connu de ui.js via filtersAreDefault ;
// en son absence, une sélection partielle (compteur) suffit à signaler un
// filtre actif.
function updateFilterPanelState(selected, total){
    const panel = document.getElementById('filterPanel');
    if (!panel) return;
    const atDefault = (typeof pkg.filtersAreDefault === 'function')
        ? pkg.filtersAreDefault()
        : !(total > 0 && selected < total);
    panel.toggleAttribute('data-filters-active', !atDefault);
}

async function clearDatabase() {
    // Le bouton est désactivé pendant un import (setImportControlsDisabled),
    // mais un clic en file d'attente juste avant la désactivation reste
    // possible : cette garde couvre ce cas limite.
    if (importInProgress) {
        showError(t('Un import est en cours, veuillez patienter avant de supprimer les données.'), t('Import en cours'));
        return;
    }

    // Action destructive et irréversible : demander confirmation avant toute
    // requête vers /clear_database. showConfirmation ouvre une vraie modale
    // (focus piégé, Échap = annulation) avec un bouton danger explicite.
    const confirmed = await new Promise(resolve => {
        if (pkg && pkg.showConfirmation) {
            pkg.showConfirmation(
                t("Êtes-vous sûr de vouloir supprimer toutes vos trouvailles ? Cette action est irréversible."),
                t("Confirmation de suppression"),
                () => resolve(true),
                () => resolve(false),
                { danger: true, confirmText: t('Supprimer mes trouvailles') }
            );
        } else {
            // Fallback : pas de système de confirmation disponible, on n'efface pas
            // silencieusement — on alerte l'utilisateur.
            showError(t("Confirmation non disponible, action annulée."), t("Suppression"));
            resolve(false);
        }
    });

    if (!confirmed) return;

    let clearingToast = null;
    
    try {
        // Afficher un toast de chargement
        clearingToast = pkg.showLoadingToast(t("Suppression des trouvailles..."), t("Suppression"));

        // Appel à l'endpoint pour vider la base de données
        const response = await fetch(`${CONFIG.BASE_URL}/clear_database`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Vider les données locales
            clearLocalData();
            
            // Vider la carte
            clearMap();
            
            // Mettre à jour l'interface
            updateUIAfterClear();
            
            // Masquer le toast de chargement et afficher le succès
            if (clearingToast) {
                pkg.hideToast(clearingToast);
            }
            showSuccess(t("Trouvailles supprimées avec succès"), t("Suppression réussie"));
            
        } else {
            throw new Error(result.message || 'Erreur inconnue');
        }
        
    } catch (error) {
        console.error('Erreur vidage BDD:', error);
        if (clearingToast) {
            pkg.hideToast(clearingToast);
        }
        showError(t("Erreur lors de la suppression des trouvailles: ") + error.message, t("Erreur"));
    }
}

function loadAndDisplayPoints() {
    // Afficher un toast pour l'affichage initial des points
    const pointsToast = pkg.showPointsToast(t('Chargement et affichage des points...'), t('Affichage des points'));

    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (!data.task_id) {
                throw new Error(data.message || t('Impossible de lancer la génération du GeoJSON'));
            }
            pollGeojsonTask(data.task_id, {
                onProgress: (p) => {
                    try { if (pointsToast) pkg.updateToastProgress(pointsToast, p); } catch(_) {}
                },
                onSuccess: (result) => {
                    console.log('[loadAndDisplayPoints] onSuccess - features:', result?.geojson?.features?.length, '| error:', result?.error);
                    if (result.error || !result.geojson) {
                        console.error('Erreur tâche GeoJSON (loadAndDisplayPoints):', result.error || 'geojson manquant');
                        pkg.hidePointsToast();
                        showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                        return;
                    }
                    const geojson = result.geojson;
                    const meta = result.metadata || {};

                    json_data = geojson;
                    // Conserver le jeu complet pour le filtrage client-side ultérieur.
                    baseGeojson = geojson;
                    setMetadata(meta);

                    // Mémoriser le total de caches initial
                    totalCaches = metadata.numberOfCaches || (geojson?.features?.length || 0);
                    lastDbHasData = totalCaches > 0;

                    // Pré-calcul de l'index des points par date pour optimiser l'animation
                    buildPointsByDateIndex(geojson?.features || []);

                    // conversion en objet date
                    dateStrToDate();
                    // MAJ des frames Infos
                    pkg.updateInfosFrameAfterReadBdd(metadata);
                    // MAJ du menu d'animation
                    pkg.updateAnimationMenuAfterReadBdd(metadata);
                    // mise à jour des Date Pickers de l'ui (filtre BDD)
                    pkg.setPickerDates(metadata);
                    // mise à jour des options en fonction de la BDD (dates début et fin)
                    updateOptionsValues(metadata);

                    // Ajouter les points à la carte
                    pkg.addVector(geojson);

                    // Cadrage « fit » : après un import, la vue s'ajuste sur
                    // l'emprise des données fraîchement chargées.
                    fitViewOnData();

                    // Mettre à jour le compteur : sélection = total au chargement initial
                    updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                    const btn = document.getElementById('clearDatabaseBtn');
                    if (btn) btn.style.display = '';

                    // L'arbre pays/régions n'est chargé qu'à l'init : après un
                    // premier import sur base vide il faut le recharger pour
                    // que les filtres Pays/Région soient peuplés.
                    try { pkg.refreshCountryStateFilters?.(); } catch(e) { console.warn('refreshCountryStateFilters error:', e); }

                    // Masquer le toast d'affichage initial
                    pkg.hidePointsToast();
                },
                onError: (err) => {
                    console.error('[LOAD_POINTS] Erreur lors du suivi de la génération GeoJSON:', err);
                    pkg.hidePointsToast();
                    showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                }
            });
        })
        .catch(error => {
            console.error('[LOAD_POINTS] Erreur lors du lancement de la génération des points:', error);
            pkg.hidePointsToast();
            showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
        });
}

