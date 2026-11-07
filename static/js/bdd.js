import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showError, showInfo, t } from './notifications.js';
import { clearMap } from './mapgl.js';
import { getBsModal, hideBsModal, showBsModal } from './ui_bootstrap.js';
import { inclusiveDayCount } from './video_timing.mjs';
import { isMainPage } from './app_mode.mjs';
import { dnfAliveInWindow } from './dnf_model.mjs';
import { ownerAliveInWindow } from './owner_model.mjs';
import { isAudioFile } from './music_track.mjs';
import { isImageFile } from './images_model.mjs';
import { countLabel } from './utils.js';
import { featureOwner, matchesAttributes, matchesSearch, normalizeSearchText } from './filter_model.mjs';
import { exportSelectionFileName, selectionToCsv, selectionToGpx } from './export_selection.mjs';

export let json_data = null;
export const metadata = {};
export const pointsByDate = new Map();
// Caches comptées mais jamais dessinées : les locationless quand la préférence
// « locationless_display » vaut « hidden » (leur position GPX est fictive).
// Indexées par jour comme pointsByDate pour que le compteur de l'animation
// continue de les prendre en compte à leur date de trouvaille.
export const hiddenPointsByDate = new Map();
// Révision de l'index : change à chaque reconstruction (import, filtre, vidage).
// Le trajet des traits de déplacement, précalculé à partir de l'index, s'en sert
// comme clé de mémoïsation.
export let pointsByDateRevision = 0;
export let totalCaches = 0;
// Compteur des seules géocaches GPX (hors Lab Caches) : pilote la
// présentation de la carte « Mes Géocaches » (classe has-geocaches posée par
// updateDataAvailabilityUI), son état vide et son bouton de suppression.
// Alimenté par /db_status (sources.geocaches) et par la ventilation
// countBySource du GeoJSON chargé.
export let geocachesCount = 0;

// À appeler quand les features indexées ont été modifiées en place (coordonnées
// mutées sans reconstruction de l'index — scénarios de test notamment) : les
// mémoïsations indexées sur la révision (traits de déplacement, résumés de la
// simulation caméra) seraient sinon figées sur l'ancien contenu.
export function bumpPointsByDateRevision() {
    pointsByDateRevision++;
}

let readLoadingToast = null;
let noCacheToast = null;

// Dernier verdict connu de /db_status (renseigné par readBddValues, lancée
// en parallèle du démarrage) : true = base non vide, false = vide ou absente,
// null = pas encore tranché. readBdd s'en sert pour choisir son retour
// visuel sans requête supplémentaire.
let lastDbHasData = null;

// Dernière sélection appliquée par changeSelect (null tant qu'aucun filtre
// n'a été appliqué : au chargement, seules les sources affichées comptent).
// Les points DNF (dnf_data.js) sont filtrés avec elle.
let lastSelection = null;

// Jeu de données complet (toutes les caches) conservé en mémoire pour permettre
// un filtrage 100% côté client, sans aller-retour serveur. Alimenté à chaque
// chargement complet (readBdd / loadAndDisplayPoints) et remis à null au vidage.
// Exporté : les compteurs d'options des filtres (refreshFilterOptionCounts,
// ui.js) comptent sur cet univers complet, pas sur la sélection filtrée.
export let baseGeojson = null;

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

// Export de la sélection filtrée (menu_filtre.html) : GPX/CSV générés côté
// client depuis les features déjà en mémoire — aucun backend, symétrique
// des boutons « Exporter » des cartes Labs/logs (qui, elles, vont chercher
// un fichier serveur). Le gabarit n'est inclus qu'en mode principal ; les
// gardes couvrent son absence en Évolution / Mes poses.
const exportSelectionGpxBtn = document.getElementById('exportSelectionGpx');
const exportSelectionCsvBtn = document.getElementById('exportSelectionCsv');
if (exportSelectionGpxBtn) {
    exportSelectionGpxBtn.addEventListener('click', () => downloadSelectionExport('gpx'));
}
if (exportSelectionCsvBtn) {
    exportSelectionCsvBtn.addEventListener('click', () => downloadSelectionExport('csv'));
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

// --- Bilan de fin d'opération « Mes Géocaches » ---------------------------
// Quand l'onglet Données est affiché, un toast de bilan (import réussi,
// vidage) se poserait SUR le panneau en cours de lecture : il s'écrit alors
// dans #bddReportNote (sous #infosBDD — celle-ci est réservée aux relevés
// périodiques) et AUCUN toast n'est émis. Onglet masqué → toast comme avant.
// Les erreurs ne passent jamais par ici : elles restent des toasts.
function dataTabVisible() {
    if (!document.getElementById('data')?.classList.contains('active')) return false;
    // La note de bilan vit dans le sous-onglet « Sources » : si l'utilisateur
    // est sur « Filtres & affichage », une note écrite dans le pane fermé ne
    // se verrait pas — retomber sur le toast. Tolérant quand le pane
    // n'existe pas (page Évolution, sans sous-onglets).
    const pane = document.getElementById('dataSourcesPane');
    if (pane && !pane.classList.contains('active') && !pane.classList.contains('show')) return false;
    return true;
}

// La note persiste (c'est un bilan, pas un statut) mais s'efface au
// démarrage d'une nouvelle opération de la carte (handleGpxFile,
// clearDatabase — là où l'indicateur d'activité apparaît).
function hideBddReportNote() {
    const note = document.getElementById('bddReportNote');
    if (note) { note.textContent = ''; note.hidden = true; }
}

function emitBddReport(message, { warning = false, title = t('Terminé'), duration = 4000 } = {}) {
    const note = document.getElementById('bddReportNote');
    if (note && dataTabVisible()) {
        note.textContent = message;
        note.classList.toggle('text-success', !warning);
        note.classList.toggle('text-warning', warning);
        note.hidden = false;
        return;
    }
    pkg.showToast(message, warning ? 'warning' : 'success', title, duration);
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

// Fichier de logs pour la carte « Mes logs » : `mygcflow-logs` (.json) ou
// GPX Groundspeak de logs (Pocket Query, GSAK), reconnus à leur en-tête. À
// tester AVANT isLabFile, qui prend tout .json pour un historique Labs —
// et un GPX Lab2Gpx reste aux Labs (le sniffer l'écarte). Un GPX
// « My Finds » n'est PAS routé ici : l'import des géocaches le lit déjà
// (il alimente les deux tables), l'y renvoyer lancerait un second parcours.
async function isLogsFile(file) {
    if (!file) return false;
    const name = file.name || '';
    let head;
    try {
        head = await file.slice(0, GPX_HEADER_SNIFF_BYTES).text();
    } catch (_) {
        return false;
    }
    if (/\.json$/i.test(name)) {
        // \x22 et non un guillemet : pybabel perdrait la suite des t() (AGENTS.md).
        return /\x22format\x22\s*:\s*\x22mygcflow-logs\x22/.test(head);
    }
    if (isGpxFile(file)) {
        return /groundspeak\.com\/cache/.test(head)
            && !/lab2gpx/i.test(head)
            && !/my finds pocket query/i.test(head);
    }
    return false;
}

// Fichier Adventure Lab : export d'historique (.json) ou GPX Lab2Gpx, reconnu
// à son en-tête. Il ne passe pas par le pipeline « My Finds », qui le
// refuserait (« Fichier invalide ») : il est confié à l'import Labs. Un .zip
// reste indécidable sans le décompresser — cf. routeDroppedFiles.
async function isLabFile(file) {
    if (!file) return false;
    if (/\.json$/i.test(file.name || '')) return true;
    if (!isGpxFile(file)) return false;
    try {
        return /lab2gpx/i.test(await file.slice(0, GPX_HEADER_SNIFF_BYTES).text());
    } catch (_) {
        return false;
    }
}

// Aiguillage d'un dépôt : les images rejoignent l'onglet Images (posées au
// point du dépôt si lâchées sur la carte — `point`, coordonnées client) ;
// une musique rejoint le sous-onglet Musique (la
// première, s'il y en a plusieurs) ; un fichier de logs part vers « Mes
// logs » (le premier) ; dès qu'un fichier Lab est reconnu, le
// lot part vers l'import Labs — avec les .zip qui l'accompagnent, un GPX
// Lab2Gpx pouvant être compressé. Sinon, le premier fichier suit le
// chargement « My Finds ».
// Un dépôt routé vers une carte source doit être vu : ouvrir le sous-onglet
// « Sources » de l'onglet Données s'il est fermé — sinon la progression de
// l'import se déroulerait dans un pane masqué. Les images et les musiques
// partent ailleurs (onglet Images / musique) : pas de bascule pour elles.
// Sans effet hors page principale (pas de sous-onglets) ou si déjà affiché.
function openDataSourcesPane() {
    const pane = document.getElementById('dataSourcesPane');
    if (!pane || pane.classList.contains('active') || pane.classList.contains('show')) return;
    // Bascule imposée par le routage du dépôt, pas un choix de l'utilisateur :
    // elle ne doit pas écraser le sous-onglet mémorisé.
    pkg.showDataSubTabProgrammatic(document.getElementById('dataSourcesTab'));
}

async function routeDroppedFiles(files, point = null) {
    const images = files.filter(isImageFile);
    if (images.length) {
        pkg.dropImageFiles?.(images, point);
        files = files.filter((f) => !isImageFile(f));
    }
    const music = files.find(isAudioFile);
    if (music) {
        pkg.dropMusicFile?.(music);
        files = files.filter((f) => !isAudioFile(f));
    }
    if (!files.length) return;
    const logs = await Promise.all(files.map(isLogsFile));
    if (logs.some(Boolean)) {
        openDataSourcesPane();
        pkg.importLogFile?.(files[logs.indexOf(true)]);
        return;
    }
    const isLab = await Promise.all(files.map(isLabFile));
    if (isLab.some(Boolean)) {
        openDataSourcesPane();
        pkg.importLabFiles?.(files.filter((f, i) => isLab[i] || isZipFile(f)));
        return;
    }
    openDataSourcesPane();
    handleGpxFile(files[0]);
}

// Point d'entrée unique pour tout fichier GPX à charger (sélection via input
// ou glisser-déposer) : valide localement, puis lance l'upload.
async function handleGpxFile(file) {
    // Un fichier de logs ou Lab choisi par le sélecteur des géocaches : même
    // aiguillage que le glisser-déposer.
    if (await isLogsFile(file)) {
        pkg.importLogFile?.(file);
        return;
    }
    if (await isLabFile(file)) {
        pkg.importLabFiles?.([file]);
        return;
    }
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
    // Nouvel import : le bilan de l'opération précédente de la carte est
    // périmé — la note s'efface avec l'apparition des indicateurs.
    hideBddReportNote();
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

    // Réimport sur une base non vide : l'upload remplace TOUTES les géocaches
    // (DELETE complet de la table côté serveur, bdd.py:uploadBdd). Avant tout
    // remplacement, un aperçu diff (preview + modale #gpxDiffModal) montre ce
    // qui changera — même pattern que les Labs et les logs. Sur base vide,
    // l'upload direct (/upload) reste le chemin le plus court.
    if (geocachesCount > 0) {
        await uploadBddWithPreview(file, earlyToast);
        return;
    }
    uploadBdd(file, earlyToast);
}

// --- Réimport : aperçu diff avant remplacement ----------------------------
// Quand la base est déjà chargée, le fichier part vers
// /api/geocaches/import/preview (conservé sous un jeton à durée limitée
// côté serveur), la modale #gpxDiffModal montre le diff (« N nouvelles, N
// retirées, N inchangées »), puis seule la validation envoie le commit —
// même tâche de fond que l'upload direct. Rien n'est importé si l'aperçu
// est refermé sans confirmation ; le jeton expire seul côté serveur.
let gpxDiffExpiryTimer = null;

function renderGpxDiff(preview) {
    const s = preview.summary || {};

    // Échéance du jeton : annoncée, puis « expiré » + « Remplacer » coupé —
    // sans elle, le clic échouerait 30 min plus tard sans raison apparente
    // (même pattern que gcLogsPreviewExpiry, gc_logs.js).
    if (gpxDiffExpiryTimer) { clearTimeout(gpxDiffExpiryTimer); gpxDiffExpiryTimer = null; }
    const expiryEl = document.getElementById('gpxDiffExpiry');
    const confirmBtn = document.getElementById('gpxDiffConfirmBtn');
    confirmBtn.disabled = false;
    const expiresAt = Date.now() + (preview.expires_in_seconds || 0) * 1000;
    const markExpired = () => {
        gpxDiffExpiryTimer = null;
        expiryEl.textContent = t("Cet aperçu a expiré — fermez-le et relancez l'import.");
        expiryEl.className = 'form-hint me-auto small text-warning';
        expiryEl.hidden = false;
        confirmBtn.disabled = true;
    };
    if (Date.now() >= expiresAt) {
        markExpired();
    } else {
        const deadline = new Date(expiresAt);
        const hh = String(deadline.getHours()).padStart(2, '0');
        const mm = String(deadline.getMinutes()).padStart(2, '0');
        expiryEl.textContent = t("À valider avant ${time} — au-delà, relancez l'aperçu.",
            { time: `${hh}:${mm}` });
        expiryEl.className = 'form-hint text-muted me-auto small';
        expiryEl.hidden = false;
        gpxDiffExpiryTimer = setTimeout(markExpired, expiresAt - Date.now());
    }

    const changes = document.getElementById('gpxDiffChanges');
    changes.textContent = '';
    const head = document.createElement('div');
    head.className = 'fw-bold mb-1';
    head.textContent = preview.name || '';
    changes.appendChild(head);
    // Libellés singulier/pluriel résolus hors de countLabel pour que
    // l'extracteur Babel voie les msgids (AGENTS.md).
    for (const line of [
        countLabel(s.added ?? 0, t('nouvelle géocache'), t('nouvelles géocaches')),
        countLabel(s.unchanged ?? 0, t('géocache inchangée'), t('géocaches inchangées')),
    ]) {
        const div = document.createElement('div');
        div.textContent = line;
        changes.appendChild(div);
    }

    // Retraits : visibles avant validation — un My Finds incomplet ne doit
    // pas effacer des trouvailles en silence.
    const removalsEl = document.getElementById('gpxDiffRemovals');
    removalsEl.textContent = '';
    removalsEl.hidden = !(s.removed > 0);
    if (s.removed > 0) {
        const title = document.createElement('div');
        title.className = 'fw-bold mb-1';
        title.textContent = countLabel(s.removed, t('géocache sera retirée'), t('géocaches seront retirées'));
        removalsEl.appendChild(title);
        const why = document.createElement('div');
        why.textContent = t("Elles sont absentes du fichier : un My Finds liste toutes vos trouvailles — l'import les retirera donc de la base.");
        removalsEl.appendChild(why);
        const list = document.createElement('ul');
        list.className = 'mb-0 mt-1';
        for (const code of (s.removed_sample || [])) {
            const item = document.createElement('li');
            item.textContent = code;
            list.appendChild(item);
        }
        const more = s.removed - (s.removed_sample || []).length;
        if (more > 0) {
            const item = document.createElement('li');
            item.textContent = more === 1 ? t('… et 1 autre') : t('… et ${n} autres', { n: more });
            list.appendChild(item);
        }
        removalsEl.appendChild(list);
    }
}

// Modale diff : résout le jeton d'import à valider, ou null si l'aperçu est
// refermé sans confirmation (Annuler, croix, Échap, clic de fond).
function confirmGpxDiff(preview) {
    return new Promise(resolve => {
        const modal = document.getElementById('gpxDiffModal');
        const bsModal = modal ? getBsModal(modal) : null;
        if (!bsModal) { resolve(null); return; }
        const confirmBtn = document.getElementById('gpxDiffConfirmBtn');
        let resolved = false;
        const done = (token) => {
            if (resolved) return;
            resolved = true;
            modal.removeEventListener('hidden.bs.modal', onHidden);
            confirmBtn.removeEventListener('click', onConfirm);
            resolve(token);
        };
        const onHidden = () => done(null);
        // Résoudre AVANT de fermer : sans classe .fade, hide() déclenche
        // 'hidden.bs.modal' de façon synchrone, qui ferait sinon gagner
        // onHidden(null) avant que le jeton ne soit rendu.
        const onConfirm = () => { done(preview.import_token); hideBsModal(modal); };
        modal.addEventListener('hidden.bs.modal', onHidden);
        confirmBtn.addEventListener('click', onConfirm);
        renderGpxDiff(preview);
        bsModal.show();
    });
}

async function uploadBddWithPreview(file, uploadToast) {
    // Le verrou d'import couvre aussi l'aperçu : un second dépôt/drop pendant
    // l'analyse ou la modale empilerait les fenêtres — les contrôles restent
    // désactivés jusqu'à la fin du remplacement (ou son annulation).
    beginImport();
    const indicatorId = 'emptyStateUploadProgress';
    const indicatorHooks = {
        onProgress: (pct) => updateUploadIndicator(indicatorId, t('Envoi du fichier : ${pct}%', { pct }), pct),
        onPhase: (msg) => updateUploadIndicator(indicatorId, msg, null),
    };
    try {
        const preview = await uploadGpxWithProgress(file, uploadToast, indicatorHooks,
            { url: '/api/geocaches/import/preview', requireTaskId: false });
        const token = await confirmGpxDiff(preview);
        if (!token) {
            // Aperçu abandonné : rien n'est importé — même nettoyage que le
            // chemin « confirmation refusée » historique.
            endImport();
            try { pkg.hideToast(uploadToast); } catch (_) {}
            hideUploadIndicator(indicatorId);
            return;
        }
        try {
            pkg.updateToastMessage(uploadToast, t('Traitement du fichier en cours...'));
            pkg.setIndeterminateProgress(uploadToast);
        } catch (_) {}
        updateUploadIndicator(indicatorId, t('Traitement du fichier en cours...'), null);
        const resp = await fetch(`${CONFIG.BASE_URL}/api/geocaches/import/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ import_token: token }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success || !data.task_id) {
            throw new Error(data.message || t('Import refusé'));
        }
        // Même suite que l'upload direct : suivi de la tâche puis affichage.
        trackGpxImportTask(uploadToast, data.task_id, indicatorId);
    } catch (error) {
        endImport();
        console.error('[uploadBddWithPreview] Erreur:', error);
        try { pkg.hideToast(uploadToast); } catch (_) {}
        hideUploadIndicator(indicatorId);
        showError(error?.message || t("Erreur lors du chargement du fichier"), t("Erreur"));
    }
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
            t('Déposez votre fichier (.gpx, .zip ou export Lab Caches) pour le charger, une musique ou une image') +
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
        routeDroppedFiles(Array.from(e.dataTransfer.files || []), { x: e.clientX, y: e.clientY });
    });
    // Sécurité : si le drag est abandonné hors fenêtre, masquer l'overlay.
    window.addEventListener('dragend', hide);
}

// Page du mode Évolution : le glisser-déposer y importe des CSV (evolution_data.js).
if (isMainPage()) setupGpxDragAndDrop();

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
    // La carte « Mes Géocaches » ne décrit que la source GPX : le total et
    // les bornes du jeu animable incluent les étapes Labs, exclues ici.
    const total = Number(data.sources?.geocaches ?? data.totalPoints) || 0;
    const start = parseBddInfoDate(data.geocachesStartDate ?? data.startDate);
    const end = parseBddInfoDate(data.geocachesEndDate ?? data.endDate);
    const load = parseBddInfoDate(data.loadDate);

    // Libellé singulier/pluriel résolu hors du template literal pour que
    // l'extracteur Babel voie les deux msgids (nommé cachesLabel : countLabel
    // est le helper importé de utils.js).
    const cachesLabel = total > 1 ? t('caches') : t('cache');
    const parts = [`${total} ${cachesLabel}`];
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

            // Ventilation par source : « Mes Géocaches » ne reflète que le
            // fichier GPX — les Lab Caches ont leur propre carte et statut.
            const sources = data?.sources;
            geocachesCount = sources
                ? (Number(sources.geocaches) || 0)
                : (hasData ? (Number(data?.totalPoints) || 0) : 0);

            const text = geocachesCount > 0
                ? formatBddInfos(data)
                : t('Aucune géocache chargée');

            if (infos) infos.textContent = text;

            setClearDatabaseAvailable(geocachesCount > 0);

            // La présentation compacte/détaillée de la carte dépend de ce
            // compteur : réévaluer sans attendre le prochain recalcul.
            try { pkg.updateDataAvailabilityUI?.(); } catch (e) {}

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

// Étendue réelle de la sélection affichée (première/dernière date), capturée
// à chaque setMetadata. On ne peut pas la relire dans metadata à la demande :
// le moteur d'animation réécrit metadata.startDate/endDate avec la plage
// choisie au démarrage d'une lecture (mapgl.js). Elle alimente les boutons
// « Sélection » de l'onglet Animation.
// var et non let : ui.js appelle getSelectionDateExtent (updateAnimFilterInfo,
// déclenché par la restauration des dates des datepickers) pendant sa propre
// évaluation, avant celle de ce module — un let serait encore en zone morte
// (ReferenceError).
var selectionExtentStart = null;
var selectionExtentEnd = null;

export function getSelectionDateExtent() {
    return { start: selectionExtentStart, end: selectionExtentEnd };
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
        selectionExtentStart = metadata.startDate ? new Date(metadata.startDate) : null;
        selectionExtentEnd = metadata.endDate ? new Date(metadata.endDate) : null;
    } catch (e) {
        console.warn('setMetadata error:', e);
    }
}

function clearLocalData() {
    json_data = null;
    baseGeojson = null;
    for (const k of Object.keys(metadata)) delete metadata[k];
    selectionExtentStart = null;
    selectionExtentEnd = null;
    geocachesCount = 0;
    pointsByDate.clear();
    hiddenPointsByDate.clear();
    pointsByDateRevision++;
    totalCaches = 0;
    lastDbHasData = false;
    // Options des filtres inclusifs (attributs, propriétaire) : vidées —
    // elles sont reconstruites sur le jeu chargé (refreshAttributeOwnerFilters).
    try { pkg.refreshAttributeOwnerFilters?.(); } catch(e) {}
    pkg.refreshStatsPanels?.();
    pkg.refreshTimelineBar?.();
    pkg.refreshImagesForData?.();
}

// Emprise [ouest, sud, est, nord] (EPSG:4326) des points chargés, null si
// aucun. Sert au cadrage automatique (préférence map_framing = "fit") et au
// bouton « Cadrer sur les Geocaches » de l'onglet Paramètres.
export function dataExtentLonLat() {
    const feats = json_data && json_data.features;
    if (!Array.isArray(feats) || feats.length === 0) return null;
    // Locationless masquées : leur position fictive ne doit pas étendre
    // l'emprise (un point aux États-Unis dézoomerait toute la carte).
    const hideLocationless = !pkg.isLocationlessShown();
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const f of feats) {
        if (hideLocationless && pkg.isLocationlessFeature(f)) continue;
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

// Features de la sélection affichée — le même ensemble que le compteur
// « n / total » (json_data est réécrit à chaque chargement et à chaque
// application de filtre, cf. readBdd/loadAndDisplayPoints/changeSelect).
// Tableau vide sans données chargées ou en mode Évolution/Mes poses. Sert
// à l'export de la sélection (GPX/CSV) et exposé pour les tests.
export function getFilteredFeatures() {
    return (json_data && Array.isArray(json_data.features)) ? json_data.features : [];
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

// Bascule « locationless affichées / comptées sans point » appliquée à la volée
// (changement de la préférence dans l'onglet Paramètres). La sélection et les
// compteurs ne changent pas : seul l'index des jours est reconstruit — les
// locationless passent de pointsByDate à hiddenPointsByDate (ou inversement),
// ce qui invalide aussi le trajet et les résumés caméra mémoïsés via
// pointsByDateRevision — puis la carte réaffiche la sélection courante.
export function refreshLocationlessDisplay() {
    if (!json_data || !Array.isArray(json_data.features)) return;
    buildPointsByDateIndex(json_data.features);
    clearMap();
    pkg.addVector(json_data);
    // En cadrage « fit », l'emprise a changé (le point fictif entre ou sort) :
    // la vue se recale d'elle-même. Hors « fit », la vue de l'utilisateur prime.
    fitViewOnData();
}

// « Options avancées » de la carte « Mes Géocaches » : leur seul contenu
// est la suppression, donc la section n'existe qu'avec des géocaches.
function setClearDatabaseAvailable(available) {
    const section = document.getElementById('geocachesAdvanced');
    if (!section) return;
    section.hidden = !available;
    if (!available) section.open = false;
}

function updateUIAfterClear() {
    const infos = document.getElementById('infosBDD');

    if (infos) infos.textContent = t('Aucune géocache chargée');
    setClearDatabaseAvailable(false);
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
        hiddenPointsByDate.clear();
        if (!Array.isArray(features)) return;

        // Locationless masquées : comptées par jour (hiddenPointsByDate) mais
        // hors de pointsByDate, dont dépendent l'affichage, le trajet et le
        // suivi de caméra — aucun point ne s'affiche à leur position fictive.
        const hideLocationless = !pkg.isLocationlessShown();
        for (const f of features) {
            const dateStr = f?.properties?.date_find;
            if (!dateStr) continue;
            const d = new Date(`${dateStr}T00:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const key = d.toDateString();
            const index = (hideLocationless && pkg.isLocationlessFeature(f))
                ? hiddenPointsByDate
                : pointsByDate;
            const arr = index.get(key) || [];
            arr.push(f);
            index.set(key, arr);
        }
    } catch (e) {
        console.warn('buildPointsByDateIndex error:', e);
    } finally {
        // Points DNF et caches posées : refiltrés avec la même sélection,
        // hors de l'index.
        pkg.rebuildDnfIndex?.();
        pkg.rebuildOwnerIndex?.();
        // Les événements de ces couches peuvent étendre les bornes « Données »
        // de l'animation (case « Étendre aux DNF et étapes… ») : le nouvel
        // index change leur étendue, les bornes « au défaut » suivent.
        pkg.refreshAnimDateDefaults?.();
        // Panneaux de stats : leurs totaux, mémoïsés sur la révision, se
        // recalculent au prochain dessin — encore faut-il en demander un.
        pkg.refreshStatsPanels?.();
        pkg.refreshTimelineBar?.();
        // Onglet Images : les jalons de trouvailles changent de date.
        pkg.refreshImagesForData?.();
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

// Sentinelle des valeurs géographiques inconnues — identique à UNKNOWN_GEO
// côté serveur (geojson_cache.py). Les Labs n'ont ni pays ni région : sous
// sélection neutre (« tous ») ils restent visibles ; sous sélection réelle
// ils ne passent que via cette valeur.
const UNKNOWN_GEO = '__unknown__';

// Vrai si toutes les options réelles du <select> sont sélectionnées (état «
// tous » neutre). Sans options réelles, la dimension est inactive = neutre.
function allRealOptionsSelected(selectId, selSet) {
    const el = document.getElementById(selectId);
    if (!el) return true;
    const real = Array.from(el.options).filter(o => !o.disabled && o.value !== '');
    return real.length === 0 || real.every(o => selSet.has(o.value));
}

function filterFeaturesClientSide(features, sel) {
    // Restriction de sources explicite : liste vide = aucun résultat ;
    // champ absent = pas de restriction (même règle que le serveur).
    const sources = sel.sources;
    if (Array.isArray(sources) && sources.length === 0) return [];

    const types = new Set(sel.type || []);
    // Aucun type sélectionné => aucun résultat (comportement identique au serveur).
    if (types.size === 0) return [];

    const terrains = toFloatSet(sel.terrain);
    const difficulties = toFloatSet(sel.difficulty);
    const containers = toStrSet(sel.container);
    const countries = toStrSet(sel.countries);
    const states = toStrSet(sel.states);

    // Pays / régions sont peuplés dynamiquement. Un ensemble vide veut dire "Aucun"
    // seulement si le <select> possède réellement des options ; sinon (aucune donnée
    // géographique disponible) la dimension est inactive et ne doit pas filtrer.
    // "Aucun" exclut aussi les Labs : aucune région n'est alors sélectionnée,
    // pas même « Non renseigné ».
    if (selectHasRealOptions('selectCountry') && countries.size === 0) return [];
    if (selectHasRealOptions('selectState') && states.size === 0) return [];

    // Neutralité géographique : la sélection couvre toutes les options nommées
    // connues => état « tous », les valeurs inconnues (Labs comprises) passent.
    const countryNeutral = allRealOptionsSelected('selectCountry', countries);
    const stateNeutral = allRealOptionsSelected('selectState', states);

    const dStart = normIsoDate(sel.dates?.startDate);
    const dEnd = normIsoDate(sel.dates?.endDate);
    const dateActive = !!(dStart && dEnd);

    const pStart = normIsoDate(sel.published_dates?.startDate);
    const pEnd = normIsoDate(sel.published_dates?.endDate);
    const pubActive = !!(pStart && pEnd);

    // Filtres INCLUSIFS (attributs, propriétaire, recherche — filter_model.mjs) :
    // sémantique inversée des listes exclusives ci-dessus — une sélection VIDE
    // est NEUTRE (le critère ne retire rien), non vide = la feature doit
    // satisfaire le critère. Attributs et propriétaire ne s'appliquent pas aux
    // Labs (pas d'attributs GPX ; l'owner qu'ils portent n'est pas filtrable,
    // cf. applyDiscoverySourceMode) ; la recherche s'applique à tous.
    const wantedAttrs = new Set(sel.attributes || []);
    const wantedOwners = new Set(sel.owners || []);
    const searchNeedle = normalizeSearchText(sel.search || '');

    const matchFloat = (val, set) => {
        if (set.size === 0) return true;
        const n = Number(val);
        return Number.isFinite(n) && set.has(n);
    };
    const matchStr = (val, set) => set.size === 0 || set.has(String(val));

    const out = [];
    for (const f of features) {
        const p = (f && f.properties) || {};
        const kind = p.source_kind || 'geocache';
        if (Array.isArray(sources) && !sources.includes(kind)) continue;
        if (!types.has(p.cache_type)) continue;

        const isLab = kind === 'lab';
        if (!isLab) {
            // "Aucun" (ensemble vide) exclut les géocaches ; les Labs, auxquels
            // ces dimensions ne s'appliquent pas, ne sont jamais retirés ici.
            if (terrains.size === 0 || !matchFloat(p.terrain, terrains)) continue;
            if (difficulties.size === 0 || !matchFloat(p.difficulty, difficulties)) continue;
            if (containers.size === 0 || !matchStr(p.container, containers)) continue;
            if (pubActive) {
                const pd = normIsoDate(p.published_date);
                if (!pd || pd < pStart || pd > pEnd) continue;
            }
            // Attributs : la cache doit porter TOUS ceux demandés (inc ≠ '0').
            if (wantedAttrs.size && !matchesAttributes(p, wantedAttrs)) continue;
            // Propriétaire : owner (placed_by en repli) ∈ sélection (ANY).
            if (wantedOwners.size && !wantedOwners.has(featureOwner(p))) continue;
        } else if (pubActive) {
            // Période de pose : un Lab n'y est soumis que si sa publication
            // est connue — inconnue, elle ne le retire pas.
            const pd = normIsoDate(p.published_date);
            if (pd && (pd < pStart || pd > pEnd)) continue;
        }
        // Sous sélection géographique réelle, la valeur inconnue ne correspond
        // qu'à la sentinelle « Non renseigné ».
        if (!countryNeutral && !countries.has(p.country || UNKNOWN_GEO)) continue;
        if (!stateNeutral && !states.has(p.state || UNKNOWN_GEO)) continue;

        if (dateActive) {
            const df = normIsoDate(p.date_find);
            if (!df || df < dStart || df > dEnd) continue;
        }
        // Recherche texte : toutes features confondues, Labs comprises — le
        // match porte sur gc_code ET name, ce qui existe dans les deux cas.
        if (searchNeedle && !matchesSearch(p, searchNeedle)) continue;
        out.push(f);
    }
    return out;
}

// Bornes « Période de découverte » effectivement déplacées par l'utilisateur
// (null quand une borne reste au défaut — l'étendue des trouvailles, qui
// écarte trop souvent les points hors jeu principal). Partagées par
// filterLikeCurrentSelection et la carte statique (syncDnfStatic /
// syncOwnerStatic, mapgl.js) pour l'état « en fin de fenêtre ».
export function movedDiscoveryBounds() {
    if (!lastSelection) return { start: null, end: null };
    const atDefault = pkg.dateBoundsAtDefault?.() || {};
    return {
        start: atDefault.findStart ? null : normIsoDate(lastSelection.dates?.startDate),
        end: atDefault.findEnd ? null : normIsoDate(lastSelection.dates?.endDate),
    };
}

// Filtre des features hors jeu principal (points DNF, caches posées) selon la
// sélection courante — sans la dimension « sources », que dnf_data.js et
// owner_data.js traitent eux-mêmes. Une borne « découverte » déplacée
// s'interprète en « vivante dans la fenêtre » (aliveInWindow), une borne
// « pose » reste un filtre d'attribut (published_date).
export function filterLikeCurrentSelection(features) {
    if (!lastSelection) return features;
    const atDefault = pkg.dateBoundsAtDefault?.() || {};
    const bounds = (range, startAtDefault, endAtDefault) => ({
        start: startAtDefault ? null : normIsoDate(range?.startDate),
        end: endAtDefault ? null : normIsoDate(range?.endDate),
    });
    const found = movedDiscoveryBounds();
    const published = bounds(lastSelection.published_dates, atDefault.pubStart, atDefault.pubEnd);
    const within = (value, range) => {
        if (!range.start && !range.end) return true;
        const iso = normIsoDate(value);
        return !!iso && (!range.start || iso >= range.start) && (!range.end || iso <= range.end);
    };
    // Les points à durée de vie (DNF en échec, caches posées présentes pour
    // toujours) ne sont pas filtrés sur le jour de leur premier événement
    // mais sur leur présence dans la fenêtre — sinon reculer la borne de
    // début retirait une cache posée bien avant, pourtant encore là.
    const aliveInWindow = (p, range) => {
        if (!range.start && !range.end) return true;
        if (p?.source_kind === 'dnf') return dnfAliveInWindow(p, range.start, range.end);
        if (p?.source_kind === 'owned') return ownerAliveInWindow(p, range.end);
        return within(p?.date_find, range);
    };
    // « attributes » écarté : les features annexes (DNF, caches posées) ne
    // portent pas d'attributs GPX — le critère les retirerait toutes.
    // « owners » et « search » s'appliquent : elles portent owner, name et
    // gc_code (dnf_geojson.py / owner_geojson.py).
    const rest = { ...lastSelection, sources: undefined, dates: undefined, published_dates: undefined, attributes: undefined };
    return filterFeaturesClientSide(features, rest).filter((f) =>
        aliveInWindow(f?.properties, found) && within(f?.properties?.published_date, published));
}

// La préférence « sources affichées » (main_discovery_sources) s'applique
// dès l'affichage initial — contrairement aux filtres de sélection qui
// n'agissent qu'au premier changement. Filtrage sur la seule dimension
// sources : filterFeaturesClientSide donnerait à « type »/pays absents le
// sens « Aucun sélectionné » des widgets, ce qui viderait le résultat.
function applyDiscoverySourcesAtLoad(features) {
    if (!Array.isArray(features)) return features;
    const kinds = pkg.getDiscoverySourceKinds?.();
    if (!kinds) return features;
    return features.filter(f => kinds.includes(f?.properties?.source_kind || 'geocache'));
}

// Recharge le jeu principal après une mutation (import ou vidage d'une
// source) : la carte, les compteurs et l'état vide reflètent ce qui
// subsiste — par ex. des Lab Caches après « Supprimer mes géocaches ».
// `onDone` est appelé une fois les points affichés (ou l'échec acté) — la
// séquence Labs s'en sert pour n'émettre son bilan qu'après l'indicateur de
// chargement, jamais empilé dessus.
export function reloadMainDatasetAfterMutation({ onDone = null } = {}) {
    clearLocalData();
    clearMap();
    updateUIAfterClear();
    // /db_status relit la ventilation réelle (géocaches vs Labs) : la ligne
    // d'infos de la carte et le compteur geocachesCount suivent ce qui
    // subsiste — updateUIAfterClear ne pose qu'un intitulé provisoire.
    readBddValues();
    loadAndDisplayPoints({ onDone });
}

// Nombre de géocaches du jeu chargé : la ventilation countBySource du
// serveur quand elle est là, sinon décompte direct des features (les non
// marquées sont des géocaches — même convention que geojson_cache.py).
function countGeocachesInResult(result) {
    const bySource = result?.metadata?.countBySource;
    if (bySource && typeof bySource === 'object') {
        return Number(bySource.geocache) || 0;
    }
    return (result?.geojson?.features || [])
        .filter(f => (f?.properties?.source_kind || 'geocache') === 'geocache')
        .length;
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
        onSuccess: (result) => {
            // Le résultat posé par la tâche (ex. {"success": true, "summary": …}
            // de run_import_task) est transmis à l'appelant : le bilan de fin
            // d'import affiche ses compteurs.
            if (typeof onSuccess === 'function') onSuccess(result);
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
// `options` (optionnel) : `url` — endpoint de destination ('/upload' pour un
// import direct, '/api/geocaches/import/preview' pour l'aperçu diff d'un
// réimport) ; `requireTaskId` — la réponse doit porter task_id (faux pour
// l'aperçu, qui rend un import_token).
function uploadGpxWithProgress(file, toast, hooks = null, { url = '/upload', requireTaskId = true } = {}) {
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
            if (xhr.status < 200 || xhr.status >= 300 || !data.success || (requireTaskId && !data.task_id)) {
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

        xhr.open('POST', `${CONFIG.BASE_URL}${url}`);
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

// Message du bilan de fin d'import : compteurs remontés par le serveur dans
// result.summary (posé par run_import_task, construit par uploadBdd — bdd.py).
// Une seule chaîne : la note inline est rendue en textContent.
// « N géocaches importées — X géocache(s) sans date de trouvaille ·
//  Y géocache(s) sans position · N log(s) ajouté(s) · N log(s) rejeté(s) ».
// Les compteurs à zéro sont omis ; sans summary (ancienne tâche/serveur),
// retour au libellé historique.
function gpxImportReportMessage(result) {
    const s = result?.summary;
    if (!s || typeof s.imported !== 'number') {
        return t("Fichier chargé avec succès !");
    }
    // Libellés singulier/pluriel résolus hors de countLabel pour que
    // l'extracteur Babel voie les msgids (AGENTS.md).
    const head = countLabel(s.imported, t('géocache importée'), t('géocaches importées'));
    const details = [];
    if (s.without_find_date > 0) {
        details.push(countLabel(s.without_find_date,
            t('géocache sans date de trouvaille'), t('géocaches sans date de trouvaille')));
    }
    if (s.without_coords > 0) {
        details.push(countLabel(s.without_coords,
            t('géocache sans position'), t('géocaches sans position')));
    }
    if (s.logs) {
        if (s.logs.added > 0) {
            details.push(countLabel(s.logs.added, t('log ajouté'), t('logs ajoutés')));
        }
        if (s.logs.rejected > 0) {
            details.push(countLabel(s.logs.rejected, t('log rejeté'), t('logs rejetés')));
        }
    }
    return details.length ? `${head} — ${details.join(' · ')}` : head;
}

// Suite commune à tout import accepté par le serveur — upload direct
// (/upload, base vide) ou commit d'un aperçu diff (base déjà chargée) :
// suivi de la tâche, bilan, relecture des statuts et affichage des points.
function trackGpxImportTask(uploadToast, taskId, indicatorId) {
    checkLoadingProgress(uploadToast, taskId, (result) => {
        console.log('[uploadBdd] Import terminé, lancement loadAndDisplayPoints');
        pkg.hideToast(uploadToast);
        // Succès d'import : note inline quand l'onglet Données est
        // affiché, sinon toast brève (4 s) — l'information durable est
        // déjà portée par #infosBDD et #dataNextStep.
        emitBddReport(gpxImportReportMessage(result));

        // mets à jour les infos de la BDD
        readBddValues();
        // Le My Finds apporte aussi ses logs (DNF suivis d'une trouvaille…)
        // et résout des DNF : statut de « Mes logs » et points DNF relus.
        pkg.refreshLogsStatus?.();
        pkg.reloadDnfData?.();
        pkg.reloadOwnerData?.();

        // L'état vide reste affiché tant que totalCaches n'est pas connu :
        // garder l'indicateur (et les contrôles verrouillés, endImport est
        // différé à onDone) pendant tout l'affichage des points — sinon la
        // carte re-proposerait un import pendant le délai entre la fin de
        // l'import et l'apparition des points.
        updateUploadIndicator(indicatorId, t('Chargement et affichage des points...'), null);
        const finishDisplay = () => {
            endImport();
            hideUploadIndicator(indicatorId);
        };
        // Charger et afficher les points sur la carte
        try {
            loadAndDisplayPoints({
                onProgress: (p) => updateUploadIndicator(indicatorId, null, p),
                onDone: finishDisplay,
            });
        } catch (e) {
            console.error('[uploadBdd] loadAndDisplayPoints a levé une erreur:', e);
            finishDisplay();
        }
    }, (message) => {
        endImport();
        console.error('[uploadBdd] Erreur import:', message);
        pkg.hideToast(uploadToast);
        hideUploadIndicator(indicatorId);
        pkg.showToast(message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
    }, { onProgress: (p) => updateUploadIndicator(indicatorId, t('Traitement du fichier en cours...'), p) });
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
    .then(data => trackGpxImportTask(uploadToast, data.task_id, indicatorId))
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
                // Conserver le jeu complet pour le filtrage client-side ultérieur.
                baseGeojson = result.geojson;
                lastSelection = null;
                // Options des filtres inclusifs (attributs, propriétaire)
                // reconstruites sur le jeu frais — avant le filtrage déclenché
                // par setPickerDates, pour que la sélection persistée
                // s'applique dès ce premier cycle.
                try { pkg.refreshAttributeOwnerFilters?.(); } catch(e) { console.warn('refreshAttributeOwnerFilters error:', e); }
                // La préférence « sources affichées » s'applique dès le
                // chargement, contrairement aux filtres de sélection qui
                // attendent le premier changement (comportement historique).
                const displayFeatures = applyDiscoverySourcesAtLoad(result.geojson?.features || []);
                const displayGeojson = { type: 'FeatureCollection', features: displayFeatures };
                json_data = displayGeojson;
                setMetadata({ ...(result.metadata || {}), ...buildMetadataClientSide(displayFeatures) });

                // Mémoriser le total de caches initial (toutes sources)
                totalCaches = result.metadata?.numberOfCaches || (result.geojson?.features?.length || 0);
                lastDbHasData = totalCaches > 0;
                geocachesCount = countGeocachesInResult(result);

                // Pré-calcul de l'index des points par date pour optimiser l'animation
                buildPointsByDateIndex(displayFeatures);

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
                console.log('[readBdd] Appel addVector avec', displayFeatures.length, 'features');
                pkg.addVector(displayGeojson);

                // Cadrage « fit » : la vue s'ajuste sur l'emprise des données.
                fitViewOnData();

                // Mettre à jour le compteur : sélection = univers affichable au
                // chargement initial ; les découvertes retirées par le réglage
                // « Découvertes affichées » sont signalées à part (note
                // « n masquée(s) »), pas dans le dénominateur.
                updateFiltersCounter(metadata.numberOfCaches || 0, displayFeatures.length,
                    { hidden: Math.max(0, totalCaches - displayFeatures.length) });

                setClearDatabaseAvailable(geocachesCount > 0);

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
    lastSelection = sel;
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
    // Boutons « Sélection » de l'onglet Animation : l'étendue a pu changer.
    pkg.updateAnimFilterInfo?.();
    // MAJ des frames Infos
    pkg.updateInfosFrameAfterReadBdd(metadata);
    // Mettre à jour les features affichées sur la carte
    clearMap();
    pkg.addVector(geojson);

    // Mettre à jour le compteur : sélection courante / univers affichable
    // (features du jeu complet éligibles au réglage « Découvertes affichées »,
    // porté par sel.sources — liste de kinds posée par collectSelectedValues).
    // Les sources masquées sont signalées à part, pas dans le dénominateur.
    const sourceKinds = Array.isArray(sel.sources) ? sel.sources : null;
    const eligibleCount = sourceKinds
        ? baseGeojson.features.filter(f => sourceKinds.includes(f?.properties?.source_kind || 'geocache')).length
        : applyDiscoverySourcesAtLoad(baseGeojson.features).length;
    updateFiltersCounter(metadata.numberOfCaches || filteredFeatures.length, eligibleCount,
        { hidden: Math.max(0, baseGeojson.features.length - eligibleCount) });
}

// Mode Évolution : les données viennent d'une base de caches importée depuis
// des CSV (evolution_data.js), pas de la base des trouvailles. On renseigne
// l'état partagé dont dépendent l'interface (état vide, compteur de sélection,
// activation de Lecture/Enregistrement) et le moteur (dates de l'animation).
export function setExternalDatasetState(meta, { selected = 0, total = 0 } = {}) {
    json_data = null;
    baseGeojson = null;
    pointsByDate.clear();
    hiddenPointsByDate.clear();
    pointsByDateRevision++;
    setMetadata(meta || {});
    totalCaches = Math.max(0, Number(total) || 0);
    // Les bases Évolution ne sont pas la base des trouvailles : la carte
    // « Mes Géocaches » (absente de ce mode) resterait en état vide.
    geocachesCount = 0;
    updateOptionsValues(metadata);
    // Pas de sélecteur de sources en mode Évolution/Poses : l'univers
    // affichable est le jeu entier, rien de masqué.
    updateFiltersCounter(selected, totalCaches, { hidden: 0 });
    // Boutons « Sélection » de l'onglet Animation : l'étendue a pu changer.
    pkg.updateAnimFilterInfo?.();
}

// Badge « sélection / univers affichable » : le dénominateur `eligible` ne
// compte que les découvertes admises par le réglage « Découvertes affichées »,
// pas tout le stockage — sinon « 6 / 14 » ferait croire qu'un filtre retire
// les 8 Lab Caches qu'une préférence d'affichage masque. Celles-ci sont
// signalées à part par `hidden` dans la note discrète #filtersHiddenNote
// (« (8 masquées) », explication en bulle native via `title` — aucun tooltip
// Bootstrap n'est branché sur ces éléments, le title suffit).
function updateFiltersCounter(selected, eligible, { hidden = 0 } = {}){
    try {
        hidden = Math.max(0, Number(hidden) || 0);
        // « stockage » = univers affichable + découvertes masquées par le
        // réglage sources (l'ancien `total`, égal à totalCaches).
        const storage = eligible + hidden;
        const el = document.getElementById('filtersCounter');
        if (el) {
            // Badge accolé au titre « Filtres » : le préfixe « Sélection »
            // serait redondant, le compteur reste au format compact « n / total ».
            el.textContent = t('${selected} / ${total}', { selected, total: eligible });
        }

        const note = document.getElementById('filtersHiddenNote');
        if (note) {
            if (hidden > 0) {
                // Libellé pluriel hors du template literal : l'extracteur
                // Babel ne lit pas les t() dans une interpolation ${...}.
                const label = countLabel(hidden, t('masquée'), t('masquées'));
                note.textContent = `(${label})`;
                note.title = t('Découvertes masquées par le réglage « Découvertes affichées »');
            } else {
                note.textContent = '';
                note.removeAttribute('title');
            }
        }

        // Bouton « Réinitialiser tous les filtres » : rouge seulement quand
        // un filtre sort de l'état neutre (marqueur data-filters-active lu
        // par la CSS). Le repli « sélection partielle » compare à l'univers
        // affichable : des découvertes masquées par le réglage sources ne
        // constituent pas un filtre actif.
        updateFilterPanelState(selected, eligible);

        // « Exporter la sélection » (menu_filtre.html) : inerte tant que la
        // sélection affichée est vide — base non chargée ou filtre qui a
        // tout retiré. Pas un filtre : il exporte l'ensemble que le
        // compteur vient de compter.
        const exportBtn = document.getElementById('btnExportSelection');
        if (exportBtn) exportBtn.disabled = !(selected > 0);

        // État vide, filtres et actions Lecture/Enregistrement suivent la
        // présence de données (base chargée et sélection non vide).
        try { pkg.updateDataAvailabilityUI?.({ dataResolved: true }); } catch(e) { console.warn('updateDataAvailabilityUI error:', e); }

        const badge = document.getElementById('dataTabBadge');
        if (badge) {
            if (eligible > 0 && selected < eligible) {
                badge.textContent = `${selected}/${eligible}`;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }

        // Gérer la toast d'alerte "aucune cache visible" : elle signale un
        // écran vide alors que le stockage n'est pas vide — que la cause soit
        // un filtre qui a tout retiré ou le réglage sources qui masque tout.
        if (selected === 0 && storage > 0) {
            // Message selon la cause : eligible === 0 signifie que le réglage
            // « Découvertes affichées » masque tout (pas un filtre).
            const noCacheMsg = eligible === 0
                ? t('Aucune découverte affichée : le réglage « Découvertes affichées » masque toutes les sources.')
                : t('Aucune cache ne correspond aux critères sélectionnés par les filtres.');
            if (!noCacheToast) {
                noCacheToast = pkg.showToast(noCacheMsg, 'warning', t('Aucune cache visible'), 0);
            } else {
                // La cause a pu basculer (filtre ↔ réglage sources) alors que
                // la toast est déjà affichée : son message le reflète.
                try { pkg.updateToastMessage?.(noCacheToast, noCacheMsg); } catch(_) {}
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
    // Pastille du sous-onglet « Filtres & affichage » : même condition que
    // le marqueur — un filtre qui sort de l'état neutre s'oublierait vite
    // une fois le pane fermé.
    const dot = document.getElementById('dataFiltersTabDot');
    if (dot) dot.hidden = atDefault;
}

// --- Export de la sélection filtrée ---------------------------------------
// Téléchargement 100 % client : Blob → <a download> cliqué → revoke, comme
// downloadBlob de stats_ui.js. Pas de toast de bilan : le téléchargement se
// voit de lui-même.
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function downloadSelectionExport(format) {
    // Le bouton est désactivé sur sélection vide ; la garde couvre un clic
    // resté en file (ou un appel programmatique).
    const features = getFilteredFeatures();
    if (!features.length) return;
    try {
        const isGpx = format === 'gpx';
        const text = isGpx ? selectionToGpx(features) : selectionToCsv(features);
        downloadBlob(new Blob([text], {
            type: isGpx ? 'application/gpx+xml;charset=utf-8' : 'text/csv;charset=utf-8',
        }), exportSelectionFileName(isGpx ? 'gpx' : 'csv'));
    } catch (e) {
        console.warn('[export sélection]', e);
        showError(t("Erreur lors de l'export de la sélection"), t('Erreur'));
    }
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
                { danger: true, confirmText: t('Supprimer mes géocaches') }
            );
        } else {
            // Fallback : pas de système de confirmation disponible, on n'efface pas
            // silencieusement — on alerte l'utilisateur.
            showError(t("Confirmation non disponible, action annulée."), t("Suppression"));
            resolve(false);
        }
    });

    if (!confirmed) return;

    // Nouvelle opération de la carte : le bilan précédent est périmé.
    hideBddReportNote();
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
            // Vidage limité aux géocaches : des Lab Caches peuvent rester
            // affichables — le rechargement reflète ce qui subsiste (base
            // complètement vide incluse).
            reloadMainDatasetAfterMutation();

            // Masquer le toast de chargement et afficher le succès
            if (clearingToast) {
                pkg.hideToast(clearingToast);
            }
            emitBddReport(t("Trouvailles supprimées avec succès"),
                { title: t("Suppression réussie"), duration: 5000 });
            
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

// onProgress : progression 0-100 de la tâche GeoJSON (en miroir de la toast,
// pour l'indicateur inline de l'état vide) ; onDone : appelé une fois sur
// chaque chemin terminal (succès ou erreur) — uploadBdd s'en sert pour
// refermer l'indicateur et lever le verrou d'import une fois les points
// affichés ou l'échec acté.
function loadAndDisplayPoints({ onProgress: onDisplayProgress = null, onDone = null } = {}) {
    const finishDisplay = () => {
        if (typeof onDone === 'function') { try { onDone(); } catch (_) {} }
    };
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
                    if (typeof onDisplayProgress === 'function') { try { onDisplayProgress(p); } catch(_) {} }
                },
                onSuccess: (result) => {
                    console.log('[loadAndDisplayPoints] onSuccess - features:', result?.geojson?.features?.length, '| error:', result?.error);
                    if (result.error || !result.geojson) {
                        console.error('Erreur tâche GeoJSON (loadAndDisplayPoints):', result.error || 'geojson manquant');
                        pkg.hidePointsToast();
                        showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                        finishDisplay();
                        return;
                    }
                    const geojson = result.geojson;
                    const meta = result.metadata || {};

                    // Conserver le jeu complet pour le filtrage client-side ultérieur.
                    baseGeojson = geojson;
                    // Options des filtres inclusifs (attributs, propriétaire)
                    // reconstruites sur le jeu frais (cf. readBdd) — avant le
                    // filtrage déclenché par setPickerDates.
                    try { pkg.refreshAttributeOwnerFilters?.(); } catch(e) { console.warn('refreshAttributeOwnerFilters error:', e); }
                    // « Sources affichées » appliquée dès l'affichage initial
                    // (cf. readBdd).
                    const displayFeatures = applyDiscoverySourcesAtLoad(geojson?.features || []);
                    const displayGeojson = { type: 'FeatureCollection', features: displayFeatures };
                    json_data = displayGeojson;
                    setMetadata({ ...meta, ...buildMetadataClientSide(displayFeatures) });

                    // Mémoriser le total de caches initial (toutes sources)
                    totalCaches = meta.numberOfCaches || (geojson?.features?.length || 0);
                    lastDbHasData = totalCaches > 0;
                    geocachesCount = countGeocachesInResult(result);

                    // Pré-calcul de l'index des points par date pour optimiser l'animation
                    buildPointsByDateIndex(displayFeatures);

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
                    pkg.addVector(displayGeojson);

                    // Cadrage « fit » : après un import, la vue s'ajuste sur
                    // l'emprise des données fraîchement chargées.
                    fitViewOnData();

                    // Mettre à jour le compteur : sélection = univers affichable
                    // au chargement initial ; les découvertes retirées par le
                    // réglage « Découvertes affichées » sont signalées à part
                    // (note « n masquée(s) »), pas dans le dénominateur.
                    updateFiltersCounter(metadata.numberOfCaches || 0, displayFeatures.length,
                        { hidden: Math.max(0, totalCaches - displayFeatures.length) });

                    setClearDatabaseAvailable(geocachesCount > 0);

                    // L'arbre pays/régions n'est chargé qu'à l'init : après un
                    // premier import sur base vide il faut le recharger pour
                    // que les filtres Pays/Région soient peuplés.
                    try { pkg.refreshCountryStateFilters?.(); } catch(e) { console.warn('refreshCountryStateFilters error:', e); }

                    // Masquer le toast d'affichage initial
                    pkg.hidePointsToast();
                    finishDisplay();
                },
                onError: (err) => {
                    console.error('[LOAD_POINTS] Erreur lors du suivi de la génération GeoJSON:', err);
                    pkg.hidePointsToast();
                    showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                    finishDisplay();
                }
            });
        })
        .catch(error => {
            console.error('[LOAD_POINTS] Erreur lors du lancement de la génération des points:', error);
            pkg.hidePointsToast();
            showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
            finishDisplay();
        });
}

