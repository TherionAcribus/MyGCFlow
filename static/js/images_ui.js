// Onglet « Images » : liste des images posées sur la carte, ajout (fichier,
// dépôt sur l'onglet, bibliothèque des images déjà envoyées), formulaire de
// l'image choisie.
//
// Préférence globale, comme l'onglet Stats : chaque modification s'applique
// aussitôt à l'aperçu (applyImagesSettings) puis part au serveur en patch
// de premier niveau `{ images: { <clés changées> } }` (commit), regroupée
// par un debounce. Les actions discrètes (ajout, suppression,
// réordonnancement) vident aussitôt la file.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import { makeDebouncedSettingsSaver } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import {
    IMAGES_MAX_CONFIGS,
    IMAGES_MAX_ITEMS,
    SCHEDULE_UNREACHED,
    createImageItem,
    hasSchedule,
    normalizeImagesConfig,
    scheduleBounds,
    imageItemDefaults,
    imageStyleFieldStates,
    imageStylePreset,
    imagesItemsKey,
    isImageFile,
    matchingStylePreset,
    scheduleRangeIssue,
    withBackgroundColor,
} from './images_model.mjs';
import { imagePanelHeight } from './images_render.mjs';
import { bindPanelDrag } from './panel_interactions.js';
import { offsetFreeCopy } from './stats_model.mjs';

const saveImagesDebounced = makeDebouncedSettingsSaver(500);

// Liste de la page courante : `items` sur « Mes Geocaches », `evolution_items`
// sur /evolution (comme stats.panels / stats.evolution_panels) ; l'interrupteur
// `enabled` reste commun aux deux pages.
const ITEMS_KEY = imagesItemsKey(isEvolutionPage());
// Liste de l'autre page : la bibliothèque signale les images qui y servent.
const OTHER_ITEMS_KEY = imagesItemsKey(!isEvolutionPage());

// Titre « Images » : retour « Enregistré ✓ » des actions sans champ dédié.
const IMAGES_SAVE_STATUS = 'imagesSaveStatus';

let selectedId = null;
let initialized = false;
let uploading = false;
// Le sélecteur de fichier sert à ajouter une image ou à remplacer celle
// de l'image choisie.
let fileInputMode = 'add';

const $ = (id) => document.getElementById(id);

function currentSettings() {
    return pkg.getImagesSettings();
}

function selectedItem() {
    return currentSettings()[ITEMS_KEY].find((item) => item.id === selectedId) || null;
}

// Enregistrement en cours : toute modification des images serait dessinée au
// milieu de la vidéo capturée — l'onglet est en lecture seule (le glisser et
// les aperçus en direct sont déjà bloqués par isAnimationInProgress, qui
// couvre la capture). Le toast est espacé : un curseur enfoncé tente un
// commit à chaque événement « input ».
let recordingToastAt = 0;
function isRecordingBlocked() {
    if (!pkg.isRecordingActive?.()) return false;
    const now = Date.now();
    if (now - recordingToastAt < 4000) return true;
    recordingToastAt = now;
    pkg.showToast?.(pkg.t("Attendez la fin de l'enregistrement pour modifier les images."),
        'warning', pkg.t('Images'), 4000);
    return true;
}

// Clés de premier niveau du bloc `images` modifiées depuis la dernière
// écriture confirmée. Le serveur fait un patch de premier niveau : n'envoyer
// que les clés changées évite d'écraser la liste de l'autre page quand « Mes
// Géocaches » et « Évolution » sont ouverts dans deux onglets — chaque page
// renverrait sinon SA copie (périmée) du bloc complet. L'accumulateur est
// requis : le saver débouncé fusionne les patchs en surface (un second
// `{images: …}` remplace le premier entier), deux commits avant le drain
// perdraient sinon les clés du premier. En cas d'échec d'écriture, les clés
// restent et repartent au prochain commit.
const IMAGES_BLOCK_KEYS = ['enabled', 'items', 'evolution_items', 'configs'];
const pendingImageKeys = {};

// null quand l'écriture est refusée (enregistrement en cours) — rien n'est
// appliqué ni envoyé, l'appelant ne doit pas afficher de succès.
//
// `dirty` : clés de premier niveau que l'appelant vient de modifier. Il les
// déclare car le diff ne suffit pas : les aperçus en direct (glisser,
// poignées) écrivent déjà la valeur finale en place dans les réglages —
// `applied` et `previous` y sont alors identiques et le diff ne marque rien.
// Le diff reste calculé en union, en garde pour un appelant qui oublierait
// `dirty`.
function commit(next, field = null, { immediate = false, dirty = null } = {}) {
    if (isRecordingBlocked()) return null;
    const previous = currentSettings();
    const applied = pkg.applyImagesSettings(next);
    if (window.userSettings) window.userSettings.images = applied;
    for (const key of dirty || []) {
        if (IMAGES_BLOCK_KEYS.includes(key)) pendingImageKeys[key] = applied[key];
    }
    for (const key of IMAGES_BLOCK_KEYS) {
        if (JSON.stringify(applied[key]) !== JSON.stringify(previous[key])) {
            pendingImageKeys[key] = applied[key];
        }
    }
    // Copie : la charge programmée ne doit pas suivre les marquages suivants.
    const payload = { ...pendingImageKeys };
    const sentKeys = Object.keys(payload);
    const saving = sentKeys.length
        ? saveImagesDebounced({ images: payload }).then((ok) => {
            if (ok) {
                // Confirmée : la clé sort de l'accumulateur, sauf si un commit
                // plus récent l'a déjà réécrite (objet différent en attente).
                for (const key of sentKeys) {
                    if (pendingImageKeys[key] === payload[key]) delete pendingImageKeys[key];
                }
                // updateLocalCache a posé le patch partiel dans
                // userSettings.images : reposer le bloc complet.
                if (window.userSettings) window.userSettings.images = currentSettings();
            }
            return ok;
        })
        : Promise.resolve(true);
    if (immediate) saveImagesDebounced.flush();
    if (field) reportSave(field, saving);
    return applied;
}

function updateItems(mutate, field = null, options = {}) {
    // Bloqué AVANT mutate : un effet de bord du mutate (l'image « supprimée »
    // capturée par runListAction) survivrait au refus du commit.
    if (isRecordingBlocked()) return;
    const settings = currentSettings();
    const items = settings[ITEMS_KEY].map((item) => structuredClone(item));
    const result = mutate(items);
    // Le spread conserve l'autre liste (`evolution_items`/`items`) intacte.
    commit({ ...settings, [ITEMS_KEY]: result || items }, field, { ...options, dirty: [ITEMS_KEY] });
}

// `mutate(item, items)` : la liste entière est fournie pour les marges de
// coin, communes à toutes les images d'un même coin.
function updateSelected(mutate, field) {
    updateItems((items) => {
        const item = items.find((i) => i.id === selectedId);
        if (item) mutate(item, items);
        return items;
    }, field);
}

function cornerMates(items, item) {
    return items.filter((i) => i !== item && i.position.mode === 'anchor'
        && i.position.anchor === item.position.anchor);
}

// Une image qui rejoint un coin prend les marges de sa pile (cf.
// adoptCornerMargins de stats_ui.js, même règle de normalisation).
function adoptCornerMargins(item, items) {
    const mate = cornerMates(items, item)[0];
    if (!mate) return;
    item.position.dx = mate.position.dx;
    item.position.dy = mate.position.dy;
}

// Nom affiché : le nom d'origine du fichier, sinon « Image n ».
function displayName(item, index) {
    return item.name || pkg.t('Image ${n}', { n: index + 1 });
}

// Planing qui compte sur cette page : sur Évolution, pas de compteur de
// trouvailles — un planing par jalons y est ignoré (images_panels.js ›
// scheduleOf). null sans borne.
function effectiveSchedule(item) {
    const schedule = item?.schedule;
    if (!hasSchedule(schedule)) return null;
    if (schedule.by === 'find' && isEvolutionPage()) return null;
    return schedule;
}

function isMissing(item) {
    const state = pkg.imageSourceState?.(item.file);
    return state === 'missing' || state === 'failed';
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

// SVG : rastérisé ici, dans le navigateur — le meilleur moteur SVG qui soit,
// et sans dépendance côté serveur. Le serveur ne reçoit qu'un PNG : toute la
// chaîne (normalisation, empreinte, bibliothèque, vidéo) est inchangée.
// Dessiné via <img>, le SVG n'exécute ni script ni ressource externe.
const SVG_RASTER_SIDE = 2048; // côté le plus long, comme la normalisation serveur (IMAGE_MAX_SIDE)

function isSvgFile(file) {
    return file?.type === 'image/svg+xml' || /\.svg$/i.test(file?.name || '');
}

// Dimensions du rendu : taille intrinsèque, sinon viewBox, sinon carré.
async function rasterizeSvg(file) {
    const text = await file.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error(pkg.t("L'image SVG n'a pas pu être lue.")));
            image.src = url;
        });
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (!(w > 0) || !(h > 0)) {
            const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
            const box = (doc.documentElement?.getAttribute('viewBox') || '')
                .trim().split(/[\s,]+/).map(Number);
            if (box.length === 4 && box[2] > 0 && box[3] > 0) { w = box[2]; h = box[3]; }
        }
        if (!(w > 0) || !(h > 0)) { w = SVG_RASTER_SIDE; h = SVG_RASTER_SIDE; }
        const scale = SVG_RASTER_SIDE / Math.max(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error(pkg.t("L'image SVG n'a pas pu être lue."));
        return new File([blob], `${baseName(file.name)}.png`, { type: 'image/png' });
    } finally {
        URL.revokeObjectURL(url);
    }
}

function setUploading(on) {
    uploading = on;
    const hint = $('imagesUploading');
    if (hint) hint.hidden = !on;
    // Remplacer pendant un envoi : refusé (replaceFromFile), donc grisé.
    const replace = $('btnImageReplace');
    if (replace) replace.disabled = on;
    renderList();
}

// Envoie un fichier au serveur, qui le normalise (image_library.py). Renvoie
// { file, width, height } ou null (message d'erreur affiché). Un SVG est
// d'abord rastérisé en PNG ici — même chose pour l'ajout, le remplacement,
// le collage et l'import JSON, qui passent tous par cette fonction.
async function uploadImage(file) {
    setUploading(true);
    try {
        if (isSvgFile(file)) file = await rasterizeSvg(file);
        const form = new FormData();
        form.append('image', file, file.name);
        const response = await fetch('/api/images', { method: 'POST', body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || pkg.t("L'image n'a pas pu être envoyée."));
        }
        // Le fichier est sur le serveur : un échec de chargement mémorisé
        // pour ce nom (même contenu, même nom) est périmé.
        pkg.forgetFailedImageSources?.(data.file);
        return data;
    } catch (e) {
        pkg.showToast?.(e.message || pkg.t("L'image n'a pas pu être envoyée."), 'error', pkg.t('Images'), 6000);
        return null;
    } finally {
        setUploading(false);
    }
}

// Nom d'origine sans extension : « logo-club.png » → « logo-club ».
function baseName(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '');
}

// `overrides` : réglages de départ (position libre d'un dépôt sur la carte).
// Une image ancrée prend les marges de la pile de son coin.
function addItem(file, name = '', overrides = {}) {
    let addedId = null;
    updateItems((items) => {
        if (items.length >= IMAGES_MAX_ITEMS) return items;
        const item = createImageItem(file, name, overrides);
        if (item.position.mode === 'anchor') adoptCornerMargins(item, items);
        items.push(item);
        addedId = item.id;
        return items;
    }, IMAGES_SAVE_STATUS, { immediate: true });
    if (addedId) selectedId = addedId;
    renderImagesTab();
}

// Position libre qui centre sur `point` (px CSS du conteneur de la carte)
// une nouvelle image de proportions `natural`, à sa largeur par défaut —
// même repère que le glisser (fractions de l'espace restant). null sans
// point ou sans conteneur.
function freePositionAt(point, natural) {
    const host = $('mapWithFrames');
    if (!point || !host) return null;
    const probe = imageItemDefaults();
    const width = Math.min(probe.position.width, host.clientWidth);
    const height = imagePanelHeight(probe, natural, width);
    const fraction = (offset, room) => (room > 0 ? Math.max(0, Math.min(1, offset / room)) : 0);
    return {
        mode: 'free',
        x: fraction(point.x - width / 2, host.clientWidth - width),
        y: fraction(point.y - height / 2, host.clientHeight - height),
    };
}

// Ajouts en attente : un dépôt ou un collage pendant un envoi n'est plus
// ignoré, il passe à la suite (la place restante est comptée à son tour).
let addQueue = Promise.resolve();

// Ajout d'un ou plusieurs fichiers (sélecteur multi, dépôt, collage) : envoyés
// en série, dans la limite des places restantes. Les fichiers écartés faute
// de place sont signalés une fois, pas par fichier. `at` : point du dépôt sur
// la carte (px CSS du conteneur) — les images y sont posées en position
// libre, décalées de 24 px les unes des autres.
function addFromFiles(files, at = null) {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return addQueue;
    const run = () => addFilesNow(list, at);
    addQueue = addQueue.then(run, run);
    return addQueue;
}

async function addFilesNow(list, at) {
    // Garde au moment de l'exécution : un enregistrement a pu démarrer
    // pendant que l'ajout attendait son tour dans la file.
    if (isRecordingBlocked()) return;
    const room = Math.max(0, IMAGES_MAX_ITEMS - currentSettings()[ITEMS_KEY].length);
    if (list.length > room) {
        pkg.showToast?.(pkg.t('Quatre images au maximum.'), 'warning', pkg.t('Images'), 5000);
    }
    let shift = 0;
    for (const file of list.slice(0, room)) {
        const data = await uploadImage(file);
        if (!data) continue;
        const point = at ? { x: at.x + shift, y: at.y + shift } : null;
        const position = freePositionAt(point, { width: data.width, height: data.height });
        addItem(data.file, baseName(file.name), position ? { position } : {});
        shift += 24;
    }
}

// Images déposées n'importe où dans la fenêtre : aiguillées ici par le
// gestionnaire de dépôt de la page (bdd.js, evolution_data.js), comme les
// musiques vers dropMusicFile. L'onglet Images s'ouvre et les reçoit ;
// lâchées sur la carte, elles sont posées en position libre au point du
// dépôt. `point` : coordonnées client du dépôt.
export function dropImageFiles(files, point = null) {
    const list = [...(files || [])].filter(isImageFile);
    if (!list.length) return null;
    // Pendant une capture, l'image apparaîtrait au milieu de la vidéo.
    if (pkg.isRecordingActive?.()) {
        pkg.showToast?.(pkg.t("Attendez la fin de l'enregistrement pour ajouter une image."), 'warning', pkg.t('Images'), 4000);
        return null;
    }
    const host = $('mapWithFrames');
    const r = host?.getBoundingClientRect();
    const onMap = !!(point && r && r.width > 0 && point.x >= r.left && point.x <= r.right
        && point.y >= r.top && point.y <= r.bottom);
    pkg.showBsTab?.(document.querySelector('#mainTabs a[href="#images"]'));
    return addFromFiles(list, onMap ? { x: point.x - r.left, y: point.y - r.top } : null);
}

async function replaceFromFile(file) {
    if (isRecordingBlocked()) return;
    const item = selectedItem();
    if (!file || !item || uploading) return;
    const data = await uploadImage(file);
    if (!data) return;
    updateSelected((target) => {
        target.file = data.file;
        if (!target.name) target.name = baseName(file.name);
    }, IMAGES_SAVE_STATUS);
    saveImagesDebounced.flush();
    renderImagesTab();
}

function openFilePicker(mode) {
    if (isRecordingBlocked()) return;
    fileInputMode = mode;
    // Multi-sélection à l'ajout seulement : le remplacement n'en prend qu'une
    // (si plusieurs sont choisies malgré tout, seule la première sert).
    const input = $('imagesFileInput');
    if (input) input.multiple = (mode === 'add');
    input?.click();
}

// Contour de dépôt sur la liste quand des fichiers survolent l'onglet. Le
// dépôt lui-même est traité par le gestionnaire de la fenêtre (bdd.js,
// evolution_data.js → dropImageFiles) : le traiter aussi ici enverrait
// l'image deux fois — et le gestionnaire de la fenêtre, qui ne connaissait
// pas les images, la prenait pour un GPX (« Fichier invalide »).
function bindFileDrop() {
    const pane = $('images');
    const card = $('imagesListCard');
    if (!pane || !card) return;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    pane.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        depth += 1;
        card.classList.add('is-dropping');
    });
    pane.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) card.classList.remove('is-dropping');
    });
    const reset = () => {
        depth = 0;
        card.classList.remove('is-dropping');
    };
    pane.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
}

// ---------------------------------------------------------------------------
// Bibliothèque : images déjà envoyées
// ---------------------------------------------------------------------------

// Fichiers que restaurerait un toast « Annuler » encore affiché (suppression
// d'une ligne, import) : toast → fichiers. Plus référencés par les réglages,
// le serveur les laisserait retirer de la bibliothèque — « Annuler »
// ramènerait alors une image manquante. La bibliothèque les protège tant que
// le toast est dans la page.
const undoProtected = new Map();

function protectUntilToastCloses(toast, files) {
    const kept = files.filter(Boolean);
    if (toast && kept.length) undoProtected.set(toast, kept);
}

function filesAwaitingUndo() {
    const files = new Set();
    for (const [toast, list] of undoProtected) {
        if (!toast.isConnected) {
            undoProtected.delete(toast);
            continue;
        }
        for (const file of list) files.add(file);
    }
    return files;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return pkg.t('${n} Mo', { n: (bytes / (1024 * 1024)).toFixed(1) });
    return pkg.t('${n} Ko', { n: Math.max(1, Math.round(bytes / 1024)) });
}

// Où une image de la bibliothèque sert déjà : sur cette page, sinon sur
// l'autre (chaque page a sa liste), sinon nulle part (null). Icônes du
// sélecteur de mode de l'en-tête (app.html).
function libraryUsage(file, usedHere, usedOther) {
    if (usedHere.has(file)) {
        return { where: 'here', icon: 'ti-check', label: pkg.t('Utilisée sur cette page') };
    }
    if (!usedOther.has(file)) return null;
    return isEvolutionPage()
        ? { where: 'other', icon: 'ti-database', label: pkg.t('Utilisée dans « Mes Géocaches »') }
        : { where: 'other', icon: 'ti-stack', label: pkg.t('Utilisée dans « Évolution »') };
}

async function renderLibrary() {
    const grid = $('imagesLibraryList');
    if (!grid) return;
    // null quand le relevé a échoué : la bibliothèque n'est pas « vide » —
    // un état d'erreur avec réessai est affiché à la place.
    let listing = null;
    try {
        const response = await fetch('/api/images');
        if (response.ok) listing = await response.json();
    } catch (_) {}
    const failed = listing === null;
    listing = listing || { files: [], total_bytes: 0 };
    const settings = currentSettings();
    const full = settings[ITEMS_KEY].length >= IMAGES_MAX_ITEMS;
    const awaitingUndo = filesAwaitingUndo();
    const usedHere = new Set(settings[ITEMS_KEY].map((item) => item.file));
    const usedOther = new Set((settings[OTHER_ITEMS_KEY] || []).map((item) => item.file));
    grid.replaceChildren(...listing.files.map((entry) => {
        const cell = document.createElement('div');
        cell.className = 'images-library-cell';
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'images-library-item';
        pick.dataset.libraryFile = entry.file;
        // Nom d'origine retenu par le serveur (images/names.json) : repris
        // comme nom de l'item — une image reprise n'est plus « Image n ».
        pick.dataset.libraryName = entry.name || '';
        pick.disabled = full;
        const usage = libraryUsage(entry.file, usedHere, usedOther);
        const size = `${entry.width} × ${entry.height}`;
        pick.title = [entry.name, size, usage?.label].filter(Boolean).join(' — ');
        const label = entry.name
            ? pkg.t('Ajouter ${name} (${w} × ${h})', { name: entry.name, w: entry.width, h: entry.height })
            : pkg.t('Ajouter cette image (${w} × ${h})', { w: entry.width, h: entry.height });
        pick.setAttribute('aria-label', usage ? `${label} — ${usage.label}` : label);
        const img = document.createElement('img');
        img.src = pkg.imageUrl(entry.file);
        img.alt = '';
        img.loading = 'lazy';
        pick.appendChild(img);
        if (usage) {
            // Pastille : où l'image sert déjà (son texte est dans le titre
            // et le nom accessible du bouton).
            pick.classList.add(`is-used-${usage.where}`);
            const badge = document.createElement('span');
            badge.className = `images-library-badge is-${usage.where}`;
            badge.setAttribute('aria-hidden', 'true');
            badge.innerHTML = `<i class="ti ${usage.icon}"></i>`;
            pick.appendChild(badge);
        }
        cell.appendChild(pick);
        // Une image utilisée (sur la carte ou dans une configuration) ne
        // peut pas être retirée : le serveur refuserait. Une image qu'un
        // « Annuler » encore affiché remettrait sur la carte non plus.
        if (!entry.referenced && !awaitingUndo.has(entry.file)) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'images-library-remove btn btn-sm';
            remove.dataset.libraryDelete = entry.file;
            remove.dataset.libraryName = entry.name || '';
            remove.title = pkg.t('Retirer de la bibliothèque');
            remove.setAttribute('aria-label', pkg.t('Retirer de la bibliothèque'));
            remove.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
            cell.appendChild(remove);
        }
        return cell;
    }));
    const empty = $('imagesLibraryEmpty');
    if (empty) empty.hidden = failed || listing.files.length > 0;
    const error = $('imagesLibraryError');
    if (error) error.hidden = !failed;
    const usage = $('imagesLibraryUsage');
    if (usage) {
        usage.hidden = failed || listing.files.length === 0;
        usage.textContent = pkg.t('${n} image(s) · ${size}', { n: listing.files.length, size: formatBytes(listing.total_bytes) });
    }
}

// ---------------------------------------------------------------------------
// Export / import JSON : réglages ET fichiers
// ---------------------------------------------------------------------------

// Format du fichier : les images y sont embarquées (data URL), sans quoi un
// export ouvert sur un autre ordinateur n'afficherait que des images
// manquantes. Au plus quatre images d'au plus 2048 px plus les
// configurations : le fichier reste raisonnable. La version 2 ajoute
// `configs` (et les fichiers qu'elles référencent) — la 1, sans
// configurations, reste lisible à l'import.
const EXPORT_FORMAT = 'mygcflow-images';

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

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

// data URL d'image → Blob ; null si ce n'en est pas une.
function dataUrlToBlob(dataUrl) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    try {
        const bytes = atob(m[2].replace(/\s+/g, ''));
        const buffer = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
        return new Blob([buffer], { type: m[1] });
    } catch (_) {
        return null;
    }
}

async function exportImages() {
    const settings = currentSettings();
    const items = settings[ITEMS_KEY];
    const configs = settings.configs || [];
    // Fichiers référencés par la liste ET par les configurations : sans eux,
    // une configuration appliquée ailleurs ne produirait que des manquantes.
    const wanted = new Set(
        [...items, ...configs.flatMap((config) => config.items || [])]
            .map((item) => item?.file).filter(Boolean));
    const files = {};
    for (const file of wanted) {
        try {
            const response = await fetch(pkg.imageUrl(file));
            if (response.ok) files[file] = await blobToDataUrl(await response.blob());
        } catch (_) { /* image absente : l'entrée reste, marquée manquante */ }
    }
    const payload = { format: EXPORT_FORMAT, version: 2, items, configs, files };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
        'mygcflow-images.json');
}

// Accepte un tableau d'images, { items: [...] } (export — le format garde
// `items` quel que soit le mode) ou un bloc { images: { … } } de préférences
// complètes, lu alors dans la liste de la page courante.
function importedItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.images?.[ITEMS_KEY])) return data.images[ITEMS_KEY];
    return null;
}

// Import d'un export JSON. `append` : les images s'ajoutent à la liste de la
// page (dans la limite des places libres) au lieu de la remplacer. Les
// images en trop sont écartées AVANT envoi — aucun fichier envoyé pour rien —
// et signalées. Les configurations (version 2) fusionnent avec les
// existantes : même nom = remplacée, douze au total au plus.
async function importImages(file, { append = false } = {}) {
    if (isRecordingBlocked()) return;
    let data = null;
    try {
        data = JSON.parse(await file.text());
    } catch (_) { /* JSON illisible → toast d'erreur plus bas */ }
    const isObject = (raw) => raw && typeof raw === 'object' && !Array.isArray(raw);
    const valid = (importedItems(data) || []).filter(isObject);
    const validConfigs = (Array.isArray(data?.configs) ? data.configs : [])
        .filter((cfg) => isObject(cfg) && typeof cfg.name === 'string' && cfg.name.trim());
    // Fichier lisible mais sans image ni configuration exploitable : refusé
    // sans toucher les réglages (l'import les remplacerait par du vide).
    if (!valid.length && !validConfigs.length) {
        pkg.showToast?.(pkg.t("Import impossible : fichier d'images invalide"), 'error', pkg.t('Images'), 5000);
        return;
    }
    const settings = currentSettings();
    const previous = settings[ITEMS_KEY];
    const previousConfigs = settings.configs || [];
    const room = append ? IMAGES_MAX_ITEMS - previous.length : IMAGES_MAX_ITEMS;
    if (valid.length && room <= 0 && !validConfigs.length) {
        pkg.showToast?.(pkg.t('Quatre images au maximum.'), 'warning', pkg.t('Images'), 5000);
        return;
    }
    const items = valid.slice(0, Math.max(0, room));
    const dropped = valid.length - items.length;
    // Chaque image embarquée repasse par le serveur, qui la normalise (et
    // retire ses métadonnées) ; son nom peut changer, les entrées suivent.
    const embedded = data && typeof data.files === 'object' && data.files ? data.files : {};
    const wanted = new Set(
        [...items, ...validConfigs.flatMap((cfg) => (Array.isArray(cfg.items) ? cfg.items : []))]
            .map((raw) => raw?.file).filter((n) => typeof n === 'string' && n));
    const renamed = {};
    for (const name of wanted) {
        const blob = dataUrlToBlob(embedded[name]);
        if (!blob) continue;
        const ext = blob.type === 'image/png' ? 'png' : 'jpg';
        // Le serveur retient le nom du fichier envoyé comme nom d'origine :
        // celui de l'item qui référençait ce fichier, sinon la base du nom.
        const itemName = items.find((i) => i.file === name)?.name;
        const fileName = `${itemName || name.replace(/\.[^.]+$/, '')}.${ext}`;
        const saved = await uploadImage(new File([blob], fileName, { type: blob.type }));
        if (saved) renamed[name] = saved.file;
    }
    const renamedItem = (raw) =>
        (Object.hasOwn(renamed, raw.file) ? { ...raw, file: renamed[raw.file] } : raw);
    const imported = items.map(renamedItem);
    const importedConfigs = validConfigs.map((cfg) => ({
        ...cfg,
        items: (Array.isArray(cfg.items) ? cfg.items : []).filter(isObject).map(renamedItem),
    }));
    // Les configurations importées remplacent celles du même nom.
    let mergedConfigs = previousConfigs;
    let importedConfigCount = 0;
    let droppedConfigs = 0;
    if (importedConfigs.length) {
        const names = new Set(importedConfigs.map((cfg) => cfg.name.trim()));
        const kept = previousConfigs.filter((cfg) => !names.has(cfg.name));
        mergedConfigs = [...kept, ...importedConfigs].slice(0, IMAGES_MAX_CONFIGS);
        importedConfigCount = mergedConfigs.length - kept.length;
        droppedConfigs = importedConfigs.length - importedConfigCount;
    }
    // Ajout : un id déjà pris par la liste est régénéré par la normalisation
    // (l'image importée garde ses réglages, pas son id).
    const next = valid.length ? (append ? [...previous, ...imported] : imported) : previous;
    const dirty = [];
    if (valid.length) dirty.push(ITEMS_KEY);
    if (importedConfigs.length) dirty.push('configs');
    const applied = commit({ ...currentSettings(), [ITEMS_KEY]: next, configs: mergedConfigs },
        IMAGES_SAVE_STATUS, { immediate: true, dirty });
    if (!applied) return;
    selectedId = applied[ITEMS_KEY][append && valid.length ? previous.length : 0]?.id || null;
    renderImagesTab();
    if (dropped > 0) {
        pkg.showToast?.(pkg.t('${n} image(s) non importée(s) : quatre au maximum.', { n: dropped }),
            'warning', pkg.t('Images'), 6000);
    }
    if (droppedConfigs > 0) {
        pkg.showToast?.(pkg.t('${n} configuration(s) non importée(s) : douze au maximum.', { n: droppedConfigs }),
            'warning', pkg.t('Images'), 6000);
    }
    const label = importedConfigCount
        ? (imported.length
            ? pkg.t('${count} image(s) et ${n} configuration(s) importée(s)', { count: imported.length, n: importedConfigCount })
            : pkg.t('${n} configuration(s) importée(s)', { n: importedConfigCount }))
        : pkg.t('${count} image(s) importée(s)', { count: imported.length });
    const toast = pkg.showActionToast?.(label, { label: 'Annuler', onClick: () => {
        commit({ ...currentSettings(), [ITEMS_KEY]: previous, configs: previousConfigs },
            IMAGES_SAVE_STATUS, { immediate: true, dirty });
        selectedId = previous[0]?.id || null;
        renderImagesTab();
    } });
    protectUntilToastCloses(toast,
        [...previous, ...previousConfigs.flatMap((cfg) => cfg.items || [])].map((item) => item.file));
}

// Mode du prochain import (sélecteur de fichier commun aux deux entrées du
// menu) : ajout ou remplacement.
let importAppends = false;

async function deleteLibraryImage(file) {
    try {
        const response = await fetch('/api/images/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) throw new Error(data.message || '');
        pkg.showToast?.(pkg.t('Image retirée de la bibliothèque.'), 'success', pkg.t('Images'), 3000);
    } catch (e) {
        pkg.showToast?.(e.message || pkg.t("L'image n'a pas pu être retirée."), 'error', pkg.t('Images'), 5000);
    }
    renderLibrary();
}

async function onLibraryClick(event) {
    if (event.target.closest('#btnImagesLibraryRetry')) {
        // Le menu reste ouvert pendant le nouvel essai.
        event.stopPropagation();
        renderLibrary();
        return;
    }
    const remove = event.target.closest('[data-library-delete]');
    if (remove) {
        // Retrait définitif du fichier (aucun « Annuler » possible) :
        // confirmé d'abord. Le menu se ferme au profit de la modale.
        event.stopPropagation();
        const file = remove.dataset.libraryDelete;
        const name = remove.dataset.libraryName;
        const message = name
            ? pkg.t('« ${name} » sera supprimée définitivement de la bibliothèque.', { name })
            : pkg.t('Cette image sera supprimée définitivement de la bibliothèque.');
        pkg.showConfirmation?.(message, pkg.t('Retirer de la bibliothèque'), () => deleteLibraryImage(file),
            null, { confirmText: pkg.t('Supprimer'), danger: true });
        return;
    }
    const pick = event.target.closest('[data-library-file]');
    if (pick && !pick.disabled) addItem(pick.dataset.libraryFile, pick.dataset.libraryName || '');
}

// ---------------------------------------------------------------------------
// Configurations nommées : instantané de la liste, ré-applicable sur l'une ou
// l'autre page (une image est la même partout) — c'est aussi le moyen de
// reprendre sur une page les images de l'autre.
// ---------------------------------------------------------------------------

// Entrées du menu entre l'en-tête « Enregistrées » et le séparateur ; chaque
// ligne porte le nom (clic = appliquer) et une corbeille.
function renderConfigMenu() {
    const menu = $('imagesConfigMenu');
    if (!menu) return;
    const settings = currentSettings();
    const configs = settings.configs || [];
    menu.querySelectorAll('[data-config-entry]').forEach((el) => el.remove());
    const header = $('imagesConfigHeader');
    if (header) header.hidden = configs.length === 0;
    const empty = $('imagesConfigEmpty');
    if (empty) empty.hidden = configs.length > 0;
    const sep = $('imagesConfigSep');
    for (const config of configs) {
        const li = document.createElement('li');
        li.className = 'd-flex align-items-center';
        li.dataset.configEntry = '';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'dropdown-item text-truncate flex-grow-1';
        apply.dataset.configApply = config.name;
        apply.textContent = config.name;
        const count = document.createElement('span');
        count.className = 'text-muted ms-1';
        count.textContent = `(${config.items.length})`;
        apply.appendChild(count);
        const del = iconButton('ti-trash', pkg.t('Supprimer'), 'config-delete');
        del.classList.add('btn-sm', 'px-2');
        del.dataset.configDelete = config.name;
        li.append(apply, del);
        sep?.before(li);
    }
    const save = menu.querySelector('[data-images-config-save]');
    // Sans image rien à enregistrer ; la liste est bornée à IMAGES_MAX_CONFIGS
    // (un nom déjà pris remplace sa configuration, il reste donc possible de
    // mettre à jour une configuration quand la liste est pleine).
    if (save) save.disabled = !settings[ITEMS_KEY].length;
}

function showConfigSave() {
    const row = $('imagesConfigSave');
    if (!row) return;
    row.hidden = false;
    $('inputImagesConfigName')?.focus();
}

function hideConfigSave() {
    const row = $('imagesConfigSave');
    if (row) row.hidden = true;
    const input = $('inputImagesConfigName');
    if (input) input.value = '';
}

function saveCurrentConfig() {
    if (isRecordingBlocked()) return;
    const settings = currentSettings();
    const entry = normalizeImagesConfig({ name: $('inputImagesConfigName')?.value, items: settings[ITEMS_KEY] });
    if (!entry) return;
    const configs = settings.configs || [];
    // À nom égal, la configuration est remplacée — la mise à jour passe par là.
    const replaced = configs.some((c) => c.name === entry.name);
    if (!replaced && configs.length >= IMAGES_MAX_CONFIGS) {
        pkg.showToast?.(pkg.t('Douze configurations au maximum : supprimez-en une, ou réutilisez un nom.'),
            'warning', pkg.t('Images'), 6000);
        return;
    }
    commit({ ...settings, configs: [...configs.filter((c) => c.name !== entry.name), entry] },
        IMAGES_SAVE_STATUS, { immediate: true, dirty: ['configs'] });
    hideConfigSave();
    renderImagesTab();
    pkg.showToast?.(pkg.t('Configuration « ${name} » enregistrée', { name: entry.name }));
}

function applyConfig(name) {
    if (isRecordingBlocked()) return;
    const settings = currentSettings();
    const config = (settings.configs || []).find((c) => c.name === name);
    if (!config) return;
    const previous = settings[ITEMS_KEY];
    const applied = commit({ ...settings, [ITEMS_KEY]: config.items }, IMAGES_SAVE_STATUS,
        { immediate: true, dirty: [ITEMS_KEY] });
    if (!applied) return;
    selectedId = applied[ITEMS_KEY][0]?.id || null;
    renderImagesTab();
    // Fichier absent de cette machine : l'image est signalée « manquante »
    // dans la liste, comme à l'import.
    const toast = pkg.showActionToast?.(
        pkg.t('Configuration « ${name} » appliquée', { name }),
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), [ITEMS_KEY]: previous }, IMAGES_SAVE_STATUS,
                { immediate: true, dirty: [ITEMS_KEY] });
            selectedId = previous[0]?.id || null;
            renderImagesTab();
        } });
    protectUntilToastCloses(toast, previous.map((item) => item.file));
}

function deleteConfig(name) {
    if (isRecordingBlocked()) return;
    const settings = currentSettings();
    const configs = settings.configs || [];
    const index = configs.findIndex((c) => c.name === name);
    if (index < 0) return;
    const removed = configs[index];
    commit({ ...settings, configs: configs.filter((c) => c.name !== name) },
        IMAGES_SAVE_STATUS, { immediate: true, dirty: ['configs'] });
    renderImagesTab();
    const toast = pkg.showActionToast?.(
        pkg.t('« ${name} » supprimée', { name }),
        { label: 'Annuler', onClick: () => {
            const current = currentSettings();
            const list = (current.configs || []).slice();
            list.splice(Math.min(index, list.length), 0, removed);
            commit({ ...current, configs: list }, IMAGES_SAVE_STATUS,
                { immediate: true, dirty: ['configs'] });
            renderImagesTab();
        } });
    protectUntilToastCloses(toast, removed.items.map((item) => item.file));
}

function onConfigMenuClick(event) {
    const apply = event.target.closest('[data-config-apply]');
    if (apply) {
        applyConfig(apply.dataset.configApply);
        return;
    }
    const del = event.target.closest('[data-config-delete]');
    if (del) {
        deleteConfig(del.dataset.configDelete);
        return;
    }
    if (event.target.closest('[data-images-config-save]')) {
        showConfigSave();
        return;
    }
    if (event.target.closest('[data-images-export]')) {
        exportImages();
        return;
    }
    const importButton = event.target.closest('[data-images-import]');
    if (importButton) {
        importAppends = importButton.dataset.imagesImport === 'append';
        $('imagesImportFile')?.click();
    }
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

function iconButton(icon, label, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-secondary';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    const i = document.createElement('i');
    i.className = `ti ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    button.appendChild(i);
    return button;
}

function renderList() {
    const list = $('imagesList');
    if (!list) return;
    const items = currentSettings()[ITEMS_KEY];
    list.replaceChildren(...items.map((item, index) => {
        const li = document.createElement('li');
        li.className = `list-group-item${item.id === selectedId ? ' is-selected' : ''}`;
        li.dataset.imageId = item.id;

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'form-check-input m-0';
        toggle.checked = item.enabled;
        toggle.dataset.action = 'toggle';
        toggle.setAttribute('aria-label', pkg.t('Afficher cette image'));

        const missing = isMissing(item);
        let thumb;
        if (missing) {
            thumb = document.createElement('i');
            thumb.className = 'ti ti-photo-off text-danger images-thumb-missing';
            thumb.setAttribute('aria-hidden', 'true');
        } else {
            thumb = document.createElement('img');
            thumb.className = 'images-thumb';
            thumb.src = pkg.imageUrl(item.file);
            thumb.alt = '';
        }

        const name = document.createElement('button');
        name.type = 'button';
        name.className = `btn btn-link p-0 text-reset text-start text-decoration-none stats-panel-name${item.enabled ? '' : ' is-disabled'}`;
        name.dataset.action = 'select';
        name.textContent = displayName(item, index);
        name.setAttribute('aria-pressed', String(item.id === selectedId));
        if (missing) {
            const badge = document.createElement('span');
            badge.className = 'text-danger small ms-1';
            badge.textContent = pkg.t('(manquante)');
            name.appendChild(badge);
        }
        if (effectiveSchedule(item)) {
            const badge = document.createElement('i');
            badge.className = 'ti ti-calendar-time text-muted ms-1';
            badge.title = pkg.t('Apparition planifiée');
            badge.setAttribute('aria-hidden', 'true');
            name.appendChild(badge);
        }

        const actions = document.createElement('div');
        actions.className = 'btn-group btn-group-sm';
        actions.append(
            iconButton('ti-arrow-up', pkg.t('Monter'), 'up', index === 0),
            iconButton('ti-arrow-down', pkg.t('Descendre'), 'down', index === items.length - 1),
            iconButton('ti-copy', pkg.t('Dupliquer'), 'duplicate', items.length >= IMAGES_MAX_ITEMS),
            iconButton('ti-trash', pkg.t('Supprimer'), 'delete'),
        );
        li.append(toggle, thumb, name, actions);
        return li;
    }));
    const empty = $('imagesEmpty');
    if (empty) empty.hidden = items.length > 0;
    const full = items.length >= IMAGES_MAX_ITEMS;
    const limit = $('imagesLimitHint');
    if (limit) limit.hidden = !full;
    const add = $('btnImagesAdd');
    if (add) add.disabled = full || uploading;
}

function onListClick(event) {
    const target = event.target.closest('[data-action]');
    const li = event.target.closest('[data-image-id]');
    if (!target || !li) return;
    runListAction(li.dataset.imageId, target.dataset.action);
}

// Action de ligne partagée : clic sur un bouton ou touche Suppr sur la
// sélection (remove de bindPanelDrag). `select`/`toggle` viennent du clic.
function runListAction(id, action) {
    if (action === 'select') {
        selectedId = id;
        renderImagesTab();
        return;
    }
    if (action === 'toggle') return;   // géré par « change »
    let removed = null;
    let removedIndex = -1;
    updateItems((items) => {
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return items;
        if (action === 'up' && index > 0) {
            [items[index - 1], items[index]] = [items[index], items[index - 1]];
        } else if (action === 'down' && index < items.length - 1) {
            [items[index + 1], items[index]] = [items[index], items[index + 1]];
        } else if (action === 'duplicate' && items.length < IMAGES_MAX_ITEMS) {
            // Même image, mêmes réglages, nouvel id (createImageItem) :
            // ancrée, elle s'empile dans le même coin ; libre, elle est
            // décalée pour ne pas cacher l'original.
            const copy = createImageItem(items[index].file, items[index].name, {
                enabled: items[index].enabled,
                position: offsetFreeCopy({ ...items[index].position },
                    pkg.getImagePanelRect?.(items[index].id) || null),
                style: { ...items[index].style },
                schedule: { ...items[index].schedule },
            });
            items.splice(index + 1, 0, copy);
            selectedId = copy.id;
        } else if (action === 'delete') {
            [removed] = items.splice(index, 1);
            removedIndex = index;
            if (selectedId === id) selectedId = items[Math.min(index, items.length - 1)]?.id || null;
        }
        return items;
    }, IMAGES_SAVE_STATUS, { immediate: true });
    renderImagesTab();
    if (removed) showUndoForDelete(removed, removedIndex);
}

// « Annuler » du toast de suppression : l'image revient à sa place. Le
// fichier, lui, reste dans la bibliothèque — il n'en sort que par le
// retrait manuel, refusé tant que ce toast est affiché.
function showUndoForDelete(item, index) {
    const toast = pkg.showActionToast?.(
        pkg.t('« ${name} » supprimée', { name: displayName(item, index) }),
        { label: 'Annuler', onClick: () => {
            updateItems((items) => {
                items.splice(Math.min(index, items.length), 0, structuredClone(item));
                return items;
            }, IMAGES_SAVE_STATUS, { immediate: true });
            selectedId = item.id;
            renderImagesTab();
        } },
    );
    protectUntilToastCloses(toast, [item.file]);
}

function onListChange(event) {
    const toggle = event.target.closest('[data-action="toggle"]');
    const li = event.target.closest('[data-image-id]');
    if (!toggle || !li) return;
    const id = li.dataset.imageId;
    updateItems((items) => {
        const item = items.find((i) => i.id === id);
        if (item) item.enabled = toggle.checked;
        return items;
    }, IMAGES_SAVE_STATUS, { immediate: true });
    renderList();
}

// ---------------------------------------------------------------------------
// Formulaire
// ---------------------------------------------------------------------------

function setValue(id, value) {
    const el = $(id);
    if (!el || value === undefined || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
}

function setRadio(name, value) {
    document.getElementsByName(name).forEach((radio) => { radio.checked = radio.value === value; });
}

// Case de la vignette du formulaire, en px CSS (.image-form-preview, marge
// intérieure déduite).
const FORM_PREVIEW_BOX = Object.freeze({ width: 104, height: 88 });

// Vignette : l'image avec son style (forme, fond, bordure, ombre…), redessinée
// à chaque réglage. Rien pour une image manquante (aide affichée à la place).
function renderFormPreview(item = selectedItem()) {
    if (item) renderPresetThumbs(item);
    const canvas = $('imageFormPreview');
    if (!canvas || !item || isMissing(item)) return;
    pkg.drawImageFormPreview?.(canvas, item, FORM_PREVIEW_BOX);
}

// Case d'une vignette de préréglage, en px CSS (.image-preset-thumb, marge
// intérieure déduite).
const PRESET_THUMB_BOX = Object.freeze({ width: 56, height: 38 });
// Les vignettes ne dépendent que du fichier et de la taille de l'image (le
// préréglage fixe tout le style) : redessinées seulement quand ils changent.
let presetThumbsKey = null;

// Cartes des préréglages : l'image elle-même dans chaque style, à l'échelle
// réelle réduite comme la vignette du formulaire. Image pas encore décodée
// ou manquante : l'icône du préréglage reste à sa place.
function renderPresetThumbs(item) {
    const ready = pkg.imageSourceState?.(item.file) === 'ready';
    const key = ready ? [item.file, item.position.width, item.position.height].join('|') : '';
    if (key === presetThumbsKey) return;
    presetThumbsKey = key;
    document.querySelectorAll('[data-image-preset]').forEach((button) => {
        const canvas = button.querySelector('canvas');
        const icon = button.querySelector('.image-preset-thumb .ti');
        if (!canvas) return;
        const result = ready ? imageStylePreset(item, button.dataset.imagePreset) : null;
        const drawn = !!result && !!pkg.drawImageFormPreview?.(canvas, {
            ...item,
            style: result.style,
            position: { ...item.position, height: result.height },
        }, PRESET_THUMB_BOX);
        canvas.hidden = !drawn;
        if (icon) icon.hidden = drawn;
    });
}

// Nom affiché d'un préréglage (sans le texte éventuel de la vignette).
function presetLabel(button) {
    return button?.querySelector('.image-preset-label')?.textContent.trim() || '';
}

// Bloc « Apparence ». Les réglages sans objet pour ce style
// (imageStyleFieldStates) sont masqués — rayon hors « Arrondi », couleur sans
// bordure — ou grisés avec une explication : l'ajustement, qu'on doit
// pouvoir découvrir.
function renderStyleFields(item) {
    const s = item.style;
    const states = imageStyleFieldStates(item);
    setRadio('imageShape', s.shape);
    setValue('inputImageRadius', s.radius);
    const radiusGroup = $('imageRadiusGroup');
    if (radiusGroup) radiusGroup.hidden = !states.radius;
    setRadio('imageFit', s.fit);
    document.getElementsByName('imageFit').forEach((radio) => { radio.disabled = !states.fit; });
    const fitHint = $('imageFitHint');
    if (fitHint) fitHint.hidden = states.fit;
    setValue('inputImageBackground', s.background);
    setValue('rangeImageBackgroundOpacity', s.background_opacity);
    setValue('inputImagePadding', s.padding);
    setValue('inputImageBorderWidth', s.border_width);
    setValue('inputImageBorderColor', s.border_color);
    const borderColor = $('inputImageBorderColor');
    if (borderColor) borderColor.hidden = !states.borderColor;
    setValue('switchImageShadow', s.shadow);
    setValue('rangeImageOpacity', s.opacity);
    const opacity = $('valueImageOpacity');
    if (opacity) opacity.textContent = `${s.opacity} %`;
    const bgOpacity = $('valueImageBackgroundOpacity');
    if (bgOpacity) bgOpacity.textContent = `${s.background_opacity} %`;
    const preset = matchingStylePreset(s);
    document.querySelectorAll('[data-image-preset]').forEach((button) => {
        const active = button.dataset.imagePreset === preset;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

// ---------------------------------------------------------------------------
// Sections repliables du formulaire (Position, Apparence, Apparition)
// ---------------------------------------------------------------------------
//
// <details> natifs, mêmes classes que l'onglet Stats. Ouvertes par défaut
// (sans « Contenu » toujours visible comme dans Stats, un formulaire tout
// replié n'afficherait rien), état mémorisé par section dans ce navigateur.

const FORM_SECTIONS_KEY = 'imagesFormSections';

function readFormSections() {
    try {
        const parsed = JSON.parse(localStorage.getItem(FORM_SECTIONS_KEY));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};
    }
}

function bindFormSections() {
    const saved = readFormSections();
    document.querySelectorAll('#imagesForm details.stats-form-section[id]').forEach((section) => {
        if (typeof saved[section.id] === 'boolean') section.open = saved[section.id];
        section.addEventListener('toggle', () => {
            const state = readFormSections();
            state[section.id] = section.open;
            try { localStorage.setItem(FORM_SECTIONS_KEY, JSON.stringify(state)); } catch (_) { /* quota */ }
            // Les saisies d'une section ouverte ne rafraîchissent pas toutes
            // son résumé (masqué) : recalculé à la fermeture.
            if (!section.open) renderSectionSummaries();
        });
    });
}

// Résumé d'une section repliée ; `title` pour le texte coupé par l'ellipse.
function setSummary(id, text, { warning = false } = {}) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.title = text;
    el.classList.toggle('is-warning', warning);
}

// Libellé affiché d'un bouton radio (déjà traduit par le gabarit).
function radioLabel(id) {
    return $(id)?.labels?.[0]?.textContent.trim() || '';
}

function formatScheduleDate(iso) {
    return pkg.formatDateDisplay?.(new Date(`${iso}T00:00:00`)) || iso;
}

function scheduleSummary(schedule) {
    if (!schedule) return pkg.t('Toujours visible');
    if (schedule.by === 'find') {
        const { start_find: from, end_find: to } = schedule;
        if (from && to) return pkg.t('Trouvailles n°${from} à n°${to}', { from, to });
        if (from) return pkg.t('Dès la trouvaille n°${n}', { n: from });
        return pkg.t("Jusqu'à la trouvaille n°${n}", { n: to });
    }
    const { start, end } = schedule;
    if (start && end) {
        return pkg.t('Du ${from} au ${to}', { from: formatScheduleDate(start), to: formatScheduleDate(end) });
    }
    if (start) return pkg.t('À partir du ${date}', { date: formatScheduleDate(start) });
    return pkg.t("Jusqu'au ${date}", { date: formatScheduleDate(end) });
}

// Résumés des sections : visibles seulement section repliée (CSS), ils
// montrent les réglages en cours — emplacement et taille, préréglage ou
// forme, bornes du planing (en alerte si l'image ne sera jamais visible).
function renderSectionSummaries(item = selectedItem()) {
    if (!item) return;
    const p = item.position;
    const where = p.mode === 'free'
        ? pkg.t('Position libre')
        : ($(`imageAnchor-${p.anchor}`)?.getAttribute('aria-label') || p.anchor);
    const size = p.height == null ? `${p.width} px` : `${p.width} × ${p.height} px`;
    setSummary('imagePositionSummary', `${where} · ${size}`);

    const s = item.style;
    const preset = matchingStylePreset(s);
    const presetButton = [...document.querySelectorAll('[data-image-preset]')]
        .find((button) => button.dataset.imagePreset === preset);
    let appearance;
    if (presetButton) {
        appearance = [presetLabel(presetButton)];
    } else {
        appearance = [radioLabel(`imageShape-${s.shape}`) || s.shape];
        if (s.background_opacity > 0) appearance.push(pkg.t('fond'));
        if (s.border_width > 0) appearance.push(pkg.t('bordure'));
        if (s.shadow) appearance.push(pkg.t('ombre'));
        if (s.opacity < 100) appearance.push(`${s.opacity} %`);
    }
    setSummary('imageAppearanceSummary', appearance.join(' · '));

    const warning = $('imageScheduleWarning');
    setSummary('imageScheduleSummary', scheduleSummary(effectiveSchedule(item)),
        { warning: !!warning && !warning.hidden });
}

function renderForm() {
    const form = $('imagesForm');
    if (!form) return;
    const item = selectedItem();
    form.hidden = !item;
    if (!item) return;
    const missing = isMissing(item);
    const previewBox = $('imageFormPreviewBox');
    if (previewBox) previewBox.hidden = missing;
    renderFormPreview(item);
    const missingHint = $('imageMissingHint');
    if (missingHint) missingHint.hidden = !missing;

    const p = item.position;
    const free = p.mode === 'free';
    document.querySelectorAll('input[name="imageAnchor"]').forEach((radio) => {
        radio.checked = !free && radio.value === p.anchor;
    });
    const freeHint = $('imageFreeHint');
    if (freeHint) freeHint.hidden = !free;
    // Position libre : retour au coin conservé dans position.anchor.
    const anchorBack = $('btnImageAnchorBack');
    if (anchorBack) anchorBack.hidden = !free;
    setValue('inputImageName', item.name);
    setValue('inputImageDx', p.dx);
    setValue('inputImageDy', p.dy);
    setValue('inputImageWidth', p.width);
    setValue('inputImageHeight', p.height ?? '');
    // Hauteur imposée (champ ou poignée verticale) : retour aux proportions.
    const heightAuto = $('btnImageHeightAuto');
    if (heightAuto) heightAuto.hidden = p.height == null;
    // Colonne centrale : centrée, la marge horizontale ne sert pas ; ligne
    // médiane : la pile est centrée, la verticale non plus ; libre : aucune.
    const dx = $('inputImageDx');
    if (dx) dx.disabled = free || p.anchor.endsWith('-center');
    const dy = $('inputImageDy');
    if (dy) dy.disabled = free || p.anchor.startsWith('middle-');

    renderStyleFields(item);

    const schedule = item.schedule || {};
    // Jalons : page « Mes Géocaches » seulement — sur Évolution, les dates.
    const byFind = schedule.by === 'find' && !isEvolutionPage();
    document.querySelectorAll('input[name="imageScheduleBy"]').forEach((radio) => {
        radio.checked = radio.value === (byFind ? 'find' : 'date');
    });
    const dates = $('imageScheduleDates');
    if (dates) dates.hidden = byFind;
    const finds = $('imageScheduleFinds');
    if (finds) finds.hidden = !byFind;
    setValue('inputImageAppearDate', schedule.start ?? '');
    setValue('inputImageDisappearDate', schedule.end ?? '');
    setValue('inputImageAppearFind', schedule.start_find ?? '');
    setValue('inputImageDisappearFind', schedule.end_find ?? '');
    setValue('selectImageEffect', schedule.effect || 'fade');
    setValue('inputImageFadeMs', schedule.fade ?? '');
    for (const [id, value] of [
        ['btnImageAppearClear', schedule.start],
        ['btnImageDisappearClear', schedule.end],
        ['btnImageAppearFindClear', schedule.start_find],
        ['btnImageDisappearFindClear', schedule.end_find],
    ]) {
        const button = $(id);
        if (button) button.disabled = value == null || value === '';
    }
    renderFindDates(schedule);
    renderScheduleWarning(item);
    renderSectionSummaries(item);
}

// Date de chaque jalon sous son champ : « le 12/03/2024 », ou jamais atteint
// (total de la sélection). Rien sans données chargées.
function renderFindDates(schedule) {
    const total = pkg.imageFindTotal?.() ?? 0;
    for (const [id, n] of [['imageAppearFindDate', schedule.start_find], ['imageDisappearFindDate', schedule.end_find]]) {
        const hint = $(id);
        if (!hint) continue;
        let text = '';
        if (n && total > 0) {
            const iso = pkg.imageFindDate?.(n);
            text = iso
                ? pkg.t('Le ${date}', { date: pkg.formatDateDisplay?.(new Date(`${iso}T00:00:00`)) || iso })
                : pkg.t('Jamais atteinte : ${total} trouvaille(s) au total', { total });
        }
        hint.textContent = text;
    }
}

// Planing qui rend l'image invisible pendant toute l'animation (fenêtre vide,
// apparition après la fin, disparition avant le début) : signalé sous les
// dates — sans quoi rien n'indique pourquoi l'image manque à la vidéo. La
// période est celle de l'animation (dates de début et de fin, onglet
// Animation) ; inconnue sans données, seule la fenêtre vide est signalée.
function renderScheduleWarning(item) {
    const warning = $('imageScheduleWarning');
    if (!warning) return;
    const schedule = effectiveSchedule(item);
    const range = pkg.getTimelineState?.() || null;
    const rangeStart = range ? pkg.formatDateIso?.(range.start) : null;
    const rangeEnd = range ? pkg.formatDateIso?.(range.end) : null;
    const byFind = schedule?.by === 'find';
    const total = byFind ? (pkg.imageFindTotal?.() ?? 0) : 0;
    // Jalons sans données chargées : rien à comparer.
    const bounds = byFind && total === 0
        ? { start: null, end: null }
        : scheduleBounds(schedule, (n) => pkg.imageFindDate?.(n) ?? null);
    const issue = scheduleRangeIssue(bounds, rangeStart, rangeEnd);
    let message = '';
    if (byFind && bounds.start === SCHEDULE_UNREACHED) {
        message = pkg.t("La trouvaille n°${n} n'est jamais atteinte (${total} au total) : l'image ne sera pas visible.",
            { n: schedule.start_find, total });
    } else if (issue === 'empty' && byFind) {
        message = pkg.t("La disparition tombe le jour de l'apparition : l'image ne sera jamais visible.");
    } else if (issue === 'empty') {
        message = pkg.t("« Disparaît le » tombe le jour de l'apparition : l'image ne sera jamais visible.");
    } else if (issue === 'after') {
        message = pkg.t("L'image n'apparaît qu'après la fin de l'animation (${date}) : elle ne sera pas visible dans la vidéo.",
            { date: pkg.formatDateDisplay?.(range.end) || rangeEnd });
    } else if (issue === 'before') {
        message = pkg.t("L'image disparaît avant le début de l'animation (${date}) : elle ne sera pas visible dans la vidéo.",
            { date: pkg.formatDateDisplay?.(range.start) || rangeStart });
    }
    warning.textContent = message;
    warning.hidden = !message;
}

// Aperçu en pause : un planing modifié s'applique tout de suite au jour
// affiché (instantané, comme un saut) — sans cela l'image garderait son état
// jusqu'au prochain saut ou à la reprise. En lecture, le lot de jours
// suivant s'en charge.
function resyncScheduleWhilePaused() {
    const state = pkg.getTimelineState?.();
    if (state?.paused) pkg.syncImagesToDate?.(state.position, null);
}

// « Jour affiché » : la date de l'aperçu (en lecture ou en pause) devient la
// borne `which` ('start' | 'end') du planing de l'image sélectionnée.
function scheduleFromPreview(which, button) {
    const item = selectedItem();
    if (!item) return;
    const state = pkg.getTimelineState?.();
    if (state?.recording) {
        pkg.showToast?.(pkg.t("Attendez la fin de l'enregistrement."), 'warning', pkg.t('Images'), 4000);
        return;
    }
    if (!state?.active) {
        pkg.showToast?.(pkg.t("Lancez l'aperçu et mettez-le en pause sur le jour voulu (barre de chronologie), puis recliquez."),
            'info', pkg.t('Images'), 6000);
        return;
    }
    const day = pkg.formatDateIso?.(state.position);
    if (!day) return;
    updateSelected((target) => {
        target.schedule.by = 'date';
        target.schedule[which] = day;
        // Même garde que la saisie : la disparition ne précède jamais
        // l'apparition.
        if (target.schedule.start && target.schedule.end && target.schedule.end < target.schedule.start) {
            if (which === 'start') target.schedule.end = day;
            else target.schedule.start = day;
        }
    }, button);
    saveImagesDebounced.flush();
    resyncScheduleWhilePaused();
    renderList();
    renderForm();
}

// Préréglage d'apparence, annulable : le style d'avant revient (et la
// hauteur, qu'un préréglage rond rend aux proportions).
function applyStylePreset(name, button) {
    if (isRecordingBlocked()) return;
    const item = selectedItem();
    const result = item ? imageStylePreset(item, name) : null;
    if (!result) return;
    const id = item.id;
    const before = { style: structuredClone(item.style), height: item.position.height };
    updateSelected((target) => {
        target.style = result.style;
        target.position.height = result.height;
    }, IMAGES_SAVE_STATUS);
    saveImagesDebounced.flush();
    renderForm();
    pkg.showActionToast?.(
        pkg.t('Préréglage « ${name} » appliqué', { name: presetLabel(button) || name }),
        { label: 'Annuler', onClick: () => {
            updateItem(id, (target) => {
                target.style = before.style;
                target.position.height = before.height;
            });
            renderForm();
        } },
    );
}

// Champ du formulaire → chemin dans l'image. `number` : borné ensuite par la
// normalisation ; `date` : '' → null (toujours visible sans la borne).
const FIELDS = [
    ['inputImageName', 'name', 'text'],
    ['inputImageDx', 'position.dx', 'number'],
    ['inputImageDy', 'position.dy', 'number'],
    ['inputImageWidth', 'position.width', 'number'],
    ['inputImageRadius', 'style.radius', 'number'],
    ['rangeImageOpacity', 'style.opacity', 'number'],
    ['inputImageBackground', 'style.background', 'text'],
    ['rangeImageBackgroundOpacity', 'style.background_opacity', 'number'],
    ['inputImagePadding', 'style.padding', 'number'],
    ['switchImageShadow', 'style.shadow', 'bool'],
    ['inputImageBorderWidth', 'style.border_width', 'number'],
    ['inputImageBorderColor', 'style.border_color', 'text'],
    ['inputImageAppearDate', 'schedule.start', 'date'],
    ['inputImageDisappearDate', 'schedule.end', 'date'],
    ['inputImageAppearFind', 'schedule.start_find', 'find'],
    ['inputImageDisappearFind', 'schedule.end_find', 'find'],
    ['selectImageEffect', 'schedule.effect', 'text'],
    ['inputImageFadeMs', 'schedule.fade', 'number'],
];
// Saisir une borne d'un mode du planing (dates ou jalons) l'active : le
// mode suit le champ modifié.
const SCHEDULE_BY_OF_TYPE = { date: 'date', find: 'find' };
const MARGIN_PATHS = ['position.dx', 'position.dy'];

function readField(el, type) {
    if (type === 'bool') return el.checked;
    if (type === 'number') return el.value === '' ? undefined : Number(el.value);
    if (type === 'date') return el.value === '' ? null : el.value;
    if (type === 'find') return el.value === '' ? null : Number(el.value);
    return el.value;
}

function writePath(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) node = node[key];
    node[keys.at(-1)] = value;
}

function bindFormFields() {
    for (const [id, path, type] of FIELDS) {
        const el = $(id);
        if (!el) continue;
        // Saisie : aperçu en direct, sans réécrire le champ ; sortie du
        // champ : le formulaire reprend la valeur normalisée.
        const live = type === 'number' || type === 'text' || type === 'find' ? 'input' : 'change';
        el.addEventListener(live, () => {
            const value = readField(el, type);
            if (value === undefined) return;
            let endClamped = false;
            updateSelected((item, items) => {
                // Couleur de fond : un fond transparent devient opaque.
                if (path === 'style.background') item.style = withBackgroundColor(item.style, value);
                else writePath(item, path, value);
                if (SCHEDULE_BY_OF_TYPE[type]) item.schedule.by = SCHEDULE_BY_OF_TYPE[type];
                // « Disparaît le » avant « Apparaît le » : jamais visible —
                // recalé à la date d'apparition (garde de saisie, pas une
                // coercition du modèle).
                if (type === 'date' && item.schedule.start && item.schedule.end
                    && item.schedule.end < item.schedule.start) {
                    item.schedule.end = item.schedule.start;
                    endClamped = true;
                }
                // Marges de coin : communes à la pile.
                if (MARGIN_PATHS.includes(path) && item.position.mode === 'anchor') {
                    for (const mate of cornerMates(items, item)) writePath(mate, path, value);
                }
            }, el);
            if (path === 'name' || type === 'date' || type === 'find') renderList();
            if (path.startsWith('schedule.')) resyncScheduleWhilePaused();
            if (el.tagName === 'SELECT' || type === 'bool' || type === 'date' || type === 'find'
                || path.startsWith('style.')) renderForm();
            // Largeur : la vignette suit les proportions de la boîte.
            else if (path.startsWith('position.')) renderFormPreview();
            if (endClamped) {
                // « Disparaît le » recalé : la réécriture ne se pose que si
                // le champ n'est pas en cours de frappe — taper l'année
                // produit des dates intermédiaires (« 0002-… ») que le
                // modèle borne mais que l'input garde pour continuer la
                // saisie ; la valeur recalée s'affiche à la sortie (blur).
                const endInput = $('inputImageDisappearDate');
                const item = selectedItem();
                if (endInput && item && endInput !== document.activeElement) {
                    endInput.value = item.schedule.end ?? '';
                }
            }
        });
        if (live === 'input') el.addEventListener('change', () => renderForm());
        // Champ date quitté : la valeur normalisée (borne de la garde)
        // remplace l'éventuelle saisie intermédiaire restée affichée.
        else if (type === 'date') el.addEventListener('blur', () => renderForm());
    }

    // Hauteur : vide = d'après les proportions (null).
    const height = $('inputImageHeight');
    if (height) {
        height.addEventListener('input', () => {
            const raw = height.value.trim();
            const value = Number(raw);
            updateSelected((item) => {
                item.position.height = raw === '' || !Number.isFinite(value) ? null : value;
            }, height);
            // L'ajustement n'a d'effet qu'avec une hauteur imposée ; le champ
            // en cours de frappe n'est pas réécrit (setValue).
            renderForm();
        });
        height.addEventListener('change', () => renderForm());
    }

    // « Rétablir les proportions » : la hauteur redevient celle de l'image.
    $('btnImageHeightAuto')?.addEventListener('click', () => {
        updateSelected((item) => { item.position.height = null; }, $('btnImageHeightAuto'));
        renderForm();
    });

    // « × » des dates du planing : vider un champ date au clavier
    // impose d'effacer jour, mois et année segment par segment.
    for (const [btnId, path] of [
        ['btnImageAppearClear', 'schedule.start'],
        ['btnImageDisappearClear', 'schedule.end'],
        ['btnImageAppearFindClear', 'schedule.start_find'],
        ['btnImageDisappearFindClear', 'schedule.end_find'],
    ]) {
        $(btnId)?.addEventListener('click', () => {
            updateSelected((item) => { writePath(item, path, null); }, $(btnId));
            resyncScheduleWhilePaused();
            renderList();
            renderForm();
        });
    }

    // Repère du planing : dates ou jalons du compteur (les bornes des deux
    // modes sont gardées, un aller-retour ne perd rien).
    document.querySelectorAll('input[name="imageScheduleBy"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            updateSelected((item) => { item.schedule.by = radio.value; }, radio.closest('[role="radiogroup"]'));
            saveImagesDebounced.flush();
            resyncScheduleWhilePaused();
            renderList();
            renderForm();
        });
    });

    document.querySelectorAll('[data-schedule-from-preview]').forEach((button) => {
        button.addEventListener('click', () => scheduleFromPreview(button.dataset.scheduleFromPreview, button));
    });
    document.querySelectorAll('[data-image-preset]').forEach((button) => {
        button.addEventListener('click', () => applyStylePreset(button.dataset.imagePreset, button));
    });

    // Forme et ajustement : groupes de boutons radio.
    for (const [name, key] of [['imageShape', 'shape'], ['imageFit', 'fit']]) {
        document.getElementsByName(name).forEach((radio) => {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                updateSelected((item) => { item.style[key] = radio.value; }, radio.closest('[role="radiogroup"]'));
                renderForm();
            });
        });
    }

    // « Revenir à l'emplacement » : la position libre redevient le coin
    // conservé dans position.anchor, avec les marges de sa pile.
    $('btnImageAnchorBack')?.addEventListener('click', () => {
        updateSelected((item, items) => {
            item.position.mode = 'anchor';
            adoptCornerMargins(item, items);
        }, $('btnImageAnchorBack'));
        renderForm();
    });

    // Choisir un emplacement ramène une image libre dans la pile du coin.
    document.querySelectorAll('input[name="imageAnchor"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            updateSelected((item, items) => {
                item.position.anchor = radio.value;
                item.position.mode = 'anchor';
                adoptCornerMargins(item, items);
            }, radio.closest('.stats-anchor-grid'));
            renderForm();
        });
    });
}

// ---------------------------------------------------------------------------
// Glisser-déposer sur la carte
// ---------------------------------------------------------------------------

// Onglet Images ouvert, au repos : les images se saisissent à la souris
// (classe `images-editing`, comme `stats-editing` pour les panneaux).
function syncDragMode() {
    const host = $('mapWithFrames');
    if (!host) return;
    const tabOpen = !!$('images')?.classList.contains('active');
    const idle = !(pkg.isAnimationInProgress?.() ?? false);
    host.classList.toggle('images-editing', tabOpen && idle);
    // Le plancher d'édition du planing (30 %) suit la bascule : sans repose,
    // un état posé pendant la fenêtre où la classe était périmée survivrait.
    pkg.refreshImageScheduleOpacity?.();
}

function updateItem(id, mutate) {
    updateItems((items) => {
        const item = items.find((i) => i.id === id);
        if (item) mutate(item, items);
        return items;
    }, IMAGES_SAVE_STATUS, { immediate: true });
}

// Même mécanique que les panneaux de stats (panel_interactions.js) : position
// libre, aimantation aux emplacements (Alt pour s'en passer), poignées sur
// les bords qui bougent. Les aperçus en direct passent par images_panels.js.
function bindDragAndDrop() {
    bindPanelDrag({
        host: $('mapWithFrames'),
        selector: 'canvas.image-panel',
        idOf: (el) => el.dataset.imageId,
        editingClass: 'images-editing',
        ghostClass: 'panel-snap-ghost image-snap-ghost',
        isBusy: () => !!pkg.isAnimationInProgress?.(),
        getRect: (id) => pkg.getImagePanelRect?.(id) || null,
        getSnapTargets: (id) => pkg.getImageSnapTargets?.(id) || [],
        previewPosition: (id, x, y) => pkg.previewImagePosition?.(id, x, y),
        previewWidth: (id, width) => pkg.previewImageWidth?.(id, width),
        previewHeight: (id, height) => pkg.previewImageHeight?.(id, height),
        pinCorner: (id) => pkg.pinImageCorner?.(id),
        unpinCorner: () => pkg.unpinImageCorner?.(),
        onGrab: (id) => {
            selectedId = id;
            renderImagesTab();
        },
        commitFree: (id, x, y) => updateItem(id, (item) => {
            item.position.mode = 'free';
            item.position.x = x;
            item.position.y = y;
        }),
        commitSnap: (id, anchor) => updateItem(id, (item, items) => {
            item.position.mode = 'anchor';
            item.position.anchor = anchor;
            adoptCornerMargins(item, items);
        }),
        commitResize: (id, patch) => updateItem(id, (item) => Object.assign(item.position, patch)),
        onRelease: () => renderForm(),
        selectedId: () => selectedId,
        // Flèches : 1 px (10 avec Maj) depuis la place affichée — une image
        // ancrée devient libre là où elle est. Sauvegarde débouncée (PAS
        // immediate) : les répétitions de la touche se regroupent en un
        // seul PUT. En mode libre, le formulaire affiche imageFreeHint et
        // désactive les marges : il est resynchronisé.
        nudge: (id, dxPx, dyPx, rect) => {
            const clamp01 = (v) => Math.max(0, Math.min(1, v));
            const freeW = rect.container.width - rect.width;
            const freeH = rect.container.height - rect.height;
            const x = freeW > 0 ? clamp01((rect.x + dxPx) / freeW) : 0;
            const y = freeH > 0 ? clamp01((rect.y + dyPx) / freeH) : 0;
            updateItems((items) => {
                const item = items.find((i) => i.id === id);
                if (item) {
                    item.position.mode = 'free';
                    item.position.x = x;
                    item.position.y = y;
                }
                return items;
            }, IMAGES_SAVE_STATUS);
            renderForm();
        },
        // Suppr : même chemin que le bouton « Supprimer » de la ligne —
        // toast « Annuler » compris.
        remove: (id) => runListAction(id, 'delete'),
    });
}

// ---------------------------------------------------------------------------
// Rendu et initialisation
// ---------------------------------------------------------------------------

export function renderImagesTab() {
    if (!$('images')) return;
    const settings = currentSettings();
    if (!settings[ITEMS_KEY].some((item) => item.id === selectedId)) {
        selectedId = settings[ITEMS_KEY][0]?.id || null;
    }
    setValue('switchImages', settings.enabled);
    // Le liseré de l'image choisie suit la sélection (visible en mode édition).
    pkg.setImagePanelSelection?.(selectedId);
    renderList();
    renderForm();
    renderConfigMenu();
    syncDragMode();
}

export function initImagesTab() {
    if (initialized || !$('images')) return;
    initialized = true;
    $('switchImages')?.addEventListener('change', (event) => {
        if (isRecordingBlocked()) {
            // Rien n'a changé : l'interrupteur revient à l'état enregistré.
            event.target.checked = currentSettings().enabled;
            return;
        }
        commit({ ...currentSettings(), enabled: event.target.checked }, event.target,
            { immediate: true, dirty: ['enabled'] });
    });
    $('btnImagesAdd')?.addEventListener('click', () => openFilePicker('add'));
    $('btnImageReplace')?.addEventListener('click', () => openFilePicker('replace'));
    $('imagesFileInput')?.addEventListener('change', (event) => {
        // FileList « live » : figée en tableau avant la remise à zéro de
        // l'input (qui la viderait).
        const files = [...(event.target.files || [])];
        event.target.value = '';
        if (!files.length) return;
        if (fileInputMode === 'replace') replaceFromFile(files[0]);
        else addFromFiles(files);
    });
    $('btnImagesLibrary')?.addEventListener('show.bs.dropdown', renderLibrary);
    $('imagesImportFile')?.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) importImages(file, { append: importAppends });
    });
    $('imagesLibraryMenu')?.addEventListener('click', onLibraryClick);
    $('btnImagesConfigs')?.addEventListener('show.bs.dropdown', renderConfigMenu);
    $('imagesConfigMenu')?.addEventListener('click', onConfigMenuClick);
    $('btnImagesConfigSaveOk')?.addEventListener('click', saveCurrentConfig);
    $('btnImagesConfigSaveCancel')?.addEventListener('click', hideConfigSave);
    $('inputImagesConfigName')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentConfig();
        else if (event.key === 'Escape') hideConfigSave();
    });
    const list = $('imagesList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('change', onListChange);
    bindFormFields();
    bindFormSections();
    bindFileDrop();
    bindDragAndDrop();
    // Coller une image copiée l'ajoute, comme un dépôt (onglet ouvert) :
    // addFromFiles gère la série, la file d'attente pendant un envoi, la
    // limite de quatre et les toasts.
    document.addEventListener('paste', (event) => {
        if (!$('images')?.classList.contains('active')) return;
        const files = [...(event.clipboardData?.files || [])].filter(isImageFile);
        if (!files.length) return;
        event.preventDefault();
        addFromFiles(files);
    });
    // Saisie à la souris : onglet ouvert/fermé, lecture lancée/arrêtée.
    document.addEventListener('shown.bs.tab', syncDragMode);
    document.addEventListener('hidden.bs.tab', syncDragMode);
    // Ouverture de l'onglet : les images restées en échec sont retentées
    // (un incident passager ne doit pas les laisser « manquantes »).
    document.addEventListener('shown.bs.tab', (event) => {
        if (event.target?.getAttribute?.('href') !== '#images') return;
        pkg.forgetFailedImageSources?.();
        // La période animée a pu changer (onglet Animation) : l'avertissement
        // du planing est recalculé.
        renderForm();
    });
    const controlBar = $('controlBar');
    if (controlBar && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncDragMode).observe(controlBar, { attributes: true, attributeFilter: ['data-playback-state'] });
    }
    // Données chargées, filtrées ou vidées : dates des jalons et
    // avertissement du planing à jour si l'onglet est ouvert (sinon, à son
    // ouverture).
    document.addEventListener('mygcflow:images-data', () => {
        if ($('images')?.classList.contains('active')) renderForm();
    });
    // Image chargée ou introuvable : la liste marque les manquantes.
    document.addEventListener('mygcflow:image-source', () => {
        renderList();
        renderForm();
    });
    renderImagesTab();
}

// Auto-initialisation en fin de module (cf. AGENTS.md, ordre d'évaluation) :
// un appel depuis initUIElements tomberait dans la zone morte de ses `let`.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initImagesTab);
    else initImagesTab();
}
