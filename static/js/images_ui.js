// Onglet « Images » : liste des images posées sur la carte, ajout (fichier,
// dépôt sur l'onglet, bibliothèque des images déjà envoyées), formulaire de
// l'image choisie.
//
// Préférence globale, comme l'onglet Stats : chaque modification s'applique
// aussitôt à l'aperçu (applyImagesSettings) puis part au serveur en bloc
// complet `{ images }`, regroupée par un debounce. Les actions discrètes
// (ajout, suppression, réordonnancement) vident aussitôt la file.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import { makeDebouncedSettingsSaver } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { IMAGES_MAX_ITEMS, createImageItem, imagesItemsKey } from './images_model.mjs';
import { bindPanelDrag } from './panel_interactions.js';

const saveImagesDebounced = makeDebouncedSettingsSaver(500);

// Liste de la page courante : `items` sur « Mes Geocaches », `evolution_items`
// sur /evolution (comme stats.panels / stats.evolution_panels) ; l'interrupteur
// `enabled` reste commun aux deux pages.
const ITEMS_KEY = imagesItemsKey(isEvolutionPage());

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

function commit(next, field = null, { immediate = false } = {}) {
    const applied = pkg.applyImagesSettings(next);
    if (window.userSettings) window.userSettings.images = applied;
    const saving = saveImagesDebounced({ images: applied });
    if (immediate) saveImagesDebounced.flush();
    if (field) reportSave(field, saving);
    return applied;
}

function updateItems(mutate, field = null, options = {}) {
    const settings = currentSettings();
    const items = settings[ITEMS_KEY].map((item) => structuredClone(item));
    const result = mutate(items);
    // Le spread conserve l'autre liste (`evolution_items`/`items`) intacte.
    commit({ ...settings, [ITEMS_KEY]: result || items }, field, options);
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

function addItem(file, name = '') {
    let addedId = null;
    updateItems((items) => {
        if (items.length >= IMAGES_MAX_ITEMS) return items;
        const item = createImageItem(file, name);
        adoptCornerMargins(item, items);
        items.push(item);
        addedId = item.id;
        return items;
    }, IMAGES_SAVE_STATUS, { immediate: true });
    if (addedId) selectedId = addedId;
    renderImagesTab();
}

// Ajout d'un ou plusieurs fichiers (sélecteur multi, dépôt) : envoyés en
// série, dans la limite des places restantes. Les fichiers écartés faute de
// place sont signalés une fois, pas par fichier.
async function addFromFiles(files) {
    if (uploading || currentSettings()[ITEMS_KEY].length >= IMAGES_MAX_ITEMS) return;
    const room = IMAGES_MAX_ITEMS - currentSettings()[ITEMS_KEY].length;
    const list = [...(files || [])].filter(Boolean);
    if (list.length > room) {
        pkg.showToast?.(pkg.t('Quatre images au maximum.'), 'warning', pkg.t('Images'), 5000);
    }
    for (const file of list.slice(0, room)) {
        const data = await uploadImage(file);
        if (data) addItem(data.file, baseName(file.name));
    }
}

async function replaceFromFile(file) {
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
    fileInputMode = mode;
    // Multi-sélection à l'ajout seulement : le remplacement n'en prend qu'une
    // (si plusieurs sont choisies malgré tout, seule la première sert).
    const input = $('imagesFileInput');
    if (input) input.multiple = (mode === 'add');
    input?.click();
}

// Dépôt de fichiers sur l'onglet : même effet que « Ajouter une image ».
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
    pane.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    pane.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth = 0;
        card.classList.remove('is-dropping');
        addFromFiles(event.dataTransfer.files);
    });
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

async function renderLibrary() {
    const grid = $('imagesLibraryList');
    if (!grid) return;
    let listing = { files: [], total_bytes: 0 };
    try {
        const response = await fetch('/api/images');
        if (response.ok) listing = await response.json();
    } catch (_) {}
    const full = currentSettings()[ITEMS_KEY].length >= IMAGES_MAX_ITEMS;
    const awaitingUndo = filesAwaitingUndo();
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
        pick.title = entry.name
            ? `${entry.name} — ${entry.width} × ${entry.height}`
            : `${entry.width} × ${entry.height}`;
        pick.setAttribute('aria-label', entry.name
            ? pkg.t('Ajouter ${name} (${w} × ${h})', { name: entry.name, w: entry.width, h: entry.height })
            : pkg.t('Ajouter cette image (${w} × ${h})', { w: entry.width, h: entry.height }));
        const img = document.createElement('img');
        img.src = pkg.imageUrl(entry.file);
        img.alt = '';
        img.loading = 'lazy';
        pick.appendChild(img);
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
    if (empty) empty.hidden = listing.files.length > 0;
    const usage = $('imagesLibraryUsage');
    if (usage) {
        usage.hidden = listing.files.length === 0;
        usage.textContent = pkg.t('${n} image(s) · ${size}', { n: listing.files.length, size: formatBytes(listing.total_bytes) });
    }
}

// ---------------------------------------------------------------------------
// Export / import JSON : réglages ET fichiers
// ---------------------------------------------------------------------------

// Format du fichier : les images y sont embarquées (data URL), sans quoi un
// export ouvert sur un autre ordinateur n'afficherait que des images
// manquantes. Au plus quatre images d'au plus 2048 px : le fichier reste
// raisonnable.
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
    const items = currentSettings()[ITEMS_KEY];
    const files = {};
    for (const file of new Set(items.map((item) => item.file).filter(Boolean))) {
        try {
            const response = await fetch(pkg.imageUrl(file));
            if (response.ok) files[file] = await blobToDataUrl(await response.blob());
        } catch (_) { /* image absente : l'entrée reste, marquée manquante */ }
    }
    const payload = { format: EXPORT_FORMAT, version: 1, items, files };
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

async function importImages(file) {
    let data = null;
    try {
        data = JSON.parse(await file.text());
    } catch (_) { /* JSON illisible → toast d'erreur plus bas */ }
    const items = importedItems(data);
    // Fichier lisible mais sans image exploitable : refusé sans toucher la
    // liste courante (l'import la remplacerait par du vide).
    if (!items || !items.some((raw) => raw && typeof raw === 'object' && !Array.isArray(raw))) {
        pkg.showToast?.(pkg.t("Import impossible : fichier d'images invalide"), 'error', pkg.t('Images'), 5000);
        return;
    }
    // Chaque image embarquée repasse par le serveur, qui la normalise (et
    // retire ses métadonnées) ; son nom peut changer, les entrées suivent.
    const embedded = data && typeof data.files === 'object' && data.files ? data.files : {};
    const renamed = {};
    for (const name of new Set(items.map((raw) => raw?.file).filter((n) => typeof n === 'string' && n))) {
        const blob = dataUrlToBlob(embedded[name]);
        if (!blob) continue;
        const ext = blob.type === 'image/png' ? 'png' : 'jpg';
        // Le serveur retient le nom du fichier envoyé comme nom d'origine :
        // celui de l'item qui référençait ce fichier, sinon la base du nom.
        const itemName = items.find((i) => i?.file === name)?.name;
        const fileName = `${itemName || name.replace(/\.[^.]+$/, '')}.${ext}`;
        const saved = await uploadImage(new File([blob], fileName, { type: blob.type }));
        if (saved) renamed[name] = saved.file;
    }
    const next = items.map((raw) => (raw && typeof raw === 'object' && raw.file in renamed
        ? { ...raw, file: renamed[raw.file] }
        : raw));
    const previous = currentSettings()[ITEMS_KEY];
    const applied = commit({ ...currentSettings(), [ITEMS_KEY]: next }, IMAGES_SAVE_STATUS, { immediate: true });
    selectedId = applied[ITEMS_KEY][0]?.id || null;
    renderImagesTab();
    const toast = pkg.showActionToast?.(
        pkg.t('${count} image(s) importée(s)', { count: applied[ITEMS_KEY].length }),
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), [ITEMS_KEY]: previous }, IMAGES_SAVE_STATUS, { immediate: true });
            selectedId = previous[0]?.id || null;
            renderImagesTab();
        } });
    protectUntilToastCloses(toast, previous.map((item) => item.file));
}

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
    if (event.target.closest('[data-images-export]')) {
        exportImages();
        return;
    }
    if (event.target.closest('[data-images-import]')) {
        $('imagesImportFile')?.click();
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
        if (item.schedule?.start || item.schedule?.end) {
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
            // elle s'empile dans le même coin.
            const copy = createImageItem(items[index].file, items[index].name, {
                enabled: items[index].enabled,
                position: { ...items[index].position },
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

function renderForm() {
    const form = $('imagesForm');
    if (!form) return;
    const item = selectedItem();
    form.hidden = !item;
    if (!item) return;
    const missing = isMissing(item);
    const preview = $('imageFormPreview');
    if (preview) {
        preview.hidden = missing;
        if (!missing) preview.src = pkg.imageUrl(item.file);
    }
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

    const s = item.style;
    setValue('selectImageShape', s.shape);
    setValue('inputImageRadius', s.radius);
    const radius = $('inputImageRadius');
    if (radius) radius.disabled = s.shape !== 'rounded';
    setValue('selectImageFit', s.fit);
    setValue('rangeImageOpacity', s.opacity);
    setValue('inputImageBackground', s.background);
    setValue('rangeImageBackgroundOpacity', s.background_opacity);
    setValue('inputImagePadding', s.padding);
    setValue('switchImageShadow', s.shadow);
    setValue('inputImageBorderWidth', s.border_width);
    setValue('inputImageBorderColor', s.border_color);
    // Couleur sans objet sans bordure, comme le rayon hors « arrondi ».
    const borderColor = $('inputImageBorderColor');
    if (borderColor) borderColor.disabled = s.border_width === 0;
    const opacity = $('valueImageOpacity');
    if (opacity) opacity.textContent = `${s.opacity} %`;
    const bgOpacity = $('valueImageBackgroundOpacity');
    if (bgOpacity) bgOpacity.textContent = `${s.background_opacity} %`;

    const schedule = item.schedule || {};
    setValue('inputImageAppearDate', schedule.start ?? '');
    setValue('inputImageDisappearDate', schedule.end ?? '');
    setValue('inputImageFadeMs', schedule.fade ?? '');
    const appearClear = $('btnImageAppearClear');
    if (appearClear) appearClear.disabled = !schedule.start;
    const disappearClear = $('btnImageDisappearClear');
    if (disappearClear) disappearClear.disabled = !schedule.end;
}

// Champ du formulaire → chemin dans l'image. `number` : borné ensuite par la
// normalisation ; `date` : '' → null (toujours visible sans la borne).
const FIELDS = [
    ['inputImageName', 'name', 'text'],
    ['inputImageDx', 'position.dx', 'number'],
    ['inputImageDy', 'position.dy', 'number'],
    ['inputImageWidth', 'position.width', 'number'],
    ['selectImageShape', 'style.shape', 'text'],
    ['inputImageRadius', 'style.radius', 'number'],
    ['selectImageFit', 'style.fit', 'text'],
    ['rangeImageOpacity', 'style.opacity', 'number'],
    ['inputImageBackground', 'style.background', 'text'],
    ['rangeImageBackgroundOpacity', 'style.background_opacity', 'number'],
    ['inputImagePadding', 'style.padding', 'number'],
    ['switchImageShadow', 'style.shadow', 'bool'],
    ['inputImageBorderWidth', 'style.border_width', 'number'],
    ['inputImageBorderColor', 'style.border_color', 'text'],
    ['inputImageAppearDate', 'schedule.start', 'date'],
    ['inputImageDisappearDate', 'schedule.end', 'date'],
    ['inputImageFadeMs', 'schedule.fade', 'number'],
];
const MARGIN_PATHS = ['position.dx', 'position.dy'];

function readField(el, type) {
    if (type === 'bool') return el.checked;
    if (type === 'number') return el.value === '' ? undefined : Number(el.value);
    if (type === 'date') return el.value === '' ? null : el.value;
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
        const live = type === 'number' || type === 'text' ? 'input' : 'change';
        el.addEventListener(live, () => {
            const value = readField(el, type);
            if (value === undefined) return;
            let endClamped = false;
            updateSelected((item, items) => {
                writePath(item, path, value);
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
            if (path === 'name' || type === 'date') renderList();
            if (el.tagName === 'SELECT' || type === 'bool' || type === 'date' || path.startsWith('style.')) renderForm();
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
    ]) {
        $(btnId)?.addEventListener('click', () => {
            updateSelected((item) => { writePath(item, path, null); }, $(btnId));
            renderList();
            renderForm();
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
    syncDragMode();
}

export function initImagesTab() {
    if (initialized || !$('images')) return;
    initialized = true;
    $('switchImages')?.addEventListener('change', (event) => {
        commit({ ...currentSettings(), enabled: event.target.checked }, event.target, { immediate: true });
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
        if (file) importImages(file);
    });
    $('imagesLibraryMenu')?.addEventListener('click', onLibraryClick);
    const list = $('imagesList');
    list?.addEventListener('click', onListClick);
    list?.addEventListener('change', onListChange);
    bindFormFields();
    bindFileDrop();
    bindDragAndDrop();
    // Coller une image copiée l'ajoute, comme un dépôt : onglet ouvert,
    // place libre et aucun envoi en cours — addFromFiles gère la série,
    // la limite de quatre et les toasts.
    document.addEventListener('paste', (event) => {
        if (!$('images')?.classList.contains('active')) return;
        if (uploading || currentSettings()[ITEMS_KEY].length >= IMAGES_MAX_ITEMS) return;
        const files = event.clipboardData?.files;
        if (!files?.length) return;
        event.preventDefault();
        addFromFiles(files);
    });
    // Saisie à la souris : onglet ouvert/fermé, lecture lancée/arrêtée.
    document.addEventListener('shown.bs.tab', syncDragMode);
    document.addEventListener('hidden.bs.tab', syncDragMode);
    // Ouverture de l'onglet : les images restées en échec sont retentées
    // (un incident passager ne doit pas les laisser « manquantes »).
    document.addEventListener('shown.bs.tab', (event) => {
        if (event.target?.getAttribute?.('href') === '#images') pkg.forgetFailedImageSources?.();
    });
    const controlBar = $('controlBar');
    if (controlBar && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncDragMode).observe(controlBar, { attributes: true, attributeFilter: ['data-playback-state'] });
    }
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
