// Onglet « Images » : liste des images posées sur la carte, ajout (fichier,
// dépôt sur l'onglet, bibliothèque des images déjà envoyées), formulaire de
// l'image choisie.
//
// Préférence globale, comme l'onglet Stats : chaque modification s'applique
// aussitôt à l'aperçu (applyImagesSettings) puis part au serveur en bloc
// complet `{ images }`, regroupée par un debounce. Les actions discrètes
// (ajout, suppression, réordonnancement) vident aussitôt la file.
import * as pkg from './index.js';
import { makeDebouncedSettingsSaver } from './settings_api.mjs';
import { reportSave } from './saved_indicator.mjs';
import { IMAGES_MAX_ITEMS, createImageItem } from './images_model.mjs';
import { bindPanelDrag } from './panel_interactions.js';

const saveImagesDebounced = makeDebouncedSettingsSaver(500);

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
    return currentSettings().items.find((item) => item.id === selectedId) || null;
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
    const items = settings.items.map((item) => structuredClone(item));
    const result = mutate(items);
    commit({ ...settings, items: result || items }, field, options);
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

function setUploading(on) {
    uploading = on;
    const hint = $('imagesUploading');
    if (hint) hint.hidden = !on;
    renderList();
}

// Envoie un fichier au serveur, qui le normalise (image_library.py). Renvoie
// { file, width, height } ou null (message d'erreur affiché).
async function uploadImage(file) {
    const form = new FormData();
    form.append('image', file, file.name);
    setUploading(true);
    try {
        const response = await fetch('/api/images', { method: 'POST', body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || pkg.t("L'image n'a pas pu être envoyée."));
        }
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

async function addFromFile(file) {
    if (!file || uploading || currentSettings().items.length >= IMAGES_MAX_ITEMS) return;
    const data = await uploadImage(file);
    if (data) addItem(data.file, baseName(file.name));
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
    $('imagesFileInput')?.click();
}

// Dépôt d'un fichier sur l'onglet : même effet que « Ajouter une image ».
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
        addFromFile(event.dataTransfer.files?.[0]);
    });
}

// ---------------------------------------------------------------------------
// Bibliothèque : images déjà envoyées
// ---------------------------------------------------------------------------

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
    const full = currentSettings().items.length >= IMAGES_MAX_ITEMS;
    grid.replaceChildren(...listing.files.map((entry) => {
        const cell = document.createElement('div');
        cell.className = 'images-library-cell';
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'images-library-item';
        pick.dataset.libraryFile = entry.file;
        pick.disabled = full;
        pick.title = `${entry.width} × ${entry.height}`;
        pick.setAttribute('aria-label', pkg.t('Ajouter cette image (${w} × ${h})', { w: entry.width, h: entry.height }));
        const img = document.createElement('img');
        img.src = pkg.imageUrl(entry.file);
        img.alt = '';
        img.loading = 'lazy';
        pick.appendChild(img);
        cell.appendChild(pick);
        // Une image utilisée (sur la carte ou dans une configuration) ne
        // peut pas être retirée : le serveur refuserait.
        if (!entry.referenced) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'images-library-remove btn btn-sm';
            remove.dataset.libraryDelete = entry.file;
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
// manquantes. Au plus quatre images d'environ 1024 px : le fichier reste
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
    const items = currentSettings().items;
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

// Accepte un tableau d'images, { items: [...] } (export) ou un bloc
// { images: { items } } de préférences complètes.
function importedItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.images?.items)) return data.images.items;
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
        const saved = await uploadImage(new File([blob], `${name.replace(/\.[^.]+$/, '')}.${ext}`, { type: blob.type }));
        if (saved) renamed[name] = saved.file;
    }
    const next = items.map((raw) => (raw && typeof raw === 'object' && raw.file in renamed
        ? { ...raw, file: renamed[raw.file] }
        : raw));
    const previous = currentSettings().items;
    const applied = commit({ ...currentSettings(), items: next }, IMAGES_SAVE_STATUS, { immediate: true });
    selectedId = applied.items[0]?.id || null;
    renderImagesTab();
    pkg.showActionToast?.(
        pkg.t('${count} image(s) importée(s)', { count: applied.items.length }),
        { label: 'Annuler', onClick: () => {
            commit({ ...currentSettings(), items: previous }, IMAGES_SAVE_STATUS, { immediate: true });
            selectedId = previous[0]?.id || null;
            renderImagesTab();
        } });
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
        // Le menu reste ouvert : on retire puis on rafraîchit la grille.
        event.stopPropagation();
        try {
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: remove.dataset.libraryDelete }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) throw new Error(data.message || '');
        } catch (e) {
            pkg.showToast?.(e.message || pkg.t("L'image n'a pas pu être retirée."), 'error', pkg.t('Images'), 5000);
        }
        renderLibrary();
        return;
    }
    const pick = event.target.closest('[data-library-file]');
    if (pick && !pick.disabled) addItem(pick.dataset.libraryFile, '');
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
    const items = currentSettings().items;
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

        const actions = document.createElement('div');
        actions.className = 'btn-group btn-group-sm';
        actions.append(
            iconButton('ti-arrow-up', pkg.t('Monter'), 'up', index === 0),
            iconButton('ti-arrow-down', pkg.t('Descendre'), 'down', index === items.length - 1),
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
    const id = li.dataset.imageId;
    const action = target.dataset.action;
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
// fichier, lui, n'a pas quitté la bibliothèque (balayé seulement une heure
// après n'être plus référencé).
function showUndoForDelete(item, index) {
    pkg.showActionToast?.(
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
    }, toggle, { immediate: true });
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
    setValue('inputImageName', item.name);
    setValue('inputImageDx', p.dx);
    setValue('inputImageDy', p.dy);
    setValue('inputImageWidth', p.width);
    setValue('inputImageHeight', p.height ?? '');
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
    const opacity = $('valueImageOpacity');
    if (opacity) opacity.textContent = `${s.opacity} %`;
    const bgOpacity = $('valueImageBackgroundOpacity');
    if (bgOpacity) bgOpacity.textContent = `${s.background_opacity} %`;
}

// Champ du formulaire → chemin dans l'image. `number` : borné ensuite par la
// normalisation.
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
];
const MARGIN_PATHS = ['position.dx', 'position.dy'];

function readField(el, type) {
    if (type === 'bool') return el.checked;
    if (type === 'number') return el.value === '' ? undefined : Number(el.value);
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
            updateSelected((item, items) => {
                writePath(item, path, value);
                // Marges de coin : communes à la pile.
                if (MARGIN_PATHS.includes(path) && item.position.mode === 'anchor') {
                    for (const mate of cornerMates(items, item)) writePath(mate, path, value);
                }
            }, el);
            if (path === 'name') renderList();
            if (el.tagName === 'SELECT' || type === 'bool' || path.startsWith('style.')) renderForm();
        });
        if (live === 'input') el.addEventListener('change', () => renderForm());
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
    });
}

// ---------------------------------------------------------------------------
// Rendu et initialisation
// ---------------------------------------------------------------------------

export function renderImagesTab() {
    if (!$('images')) return;
    const settings = currentSettings();
    if (!settings.items.some((item) => item.id === selectedId)) {
        selectedId = settings.items[0]?.id || null;
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
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (fileInputMode === 'replace') replaceFromFile(file);
        else addFromFile(file);
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
    // Saisie à la souris : onglet ouvert/fermé, lecture lancée/arrêtée.
    document.addEventListener('shown.bs.tab', syncDragMode);
    document.addEventListener('hidden.bs.tab', syncDragMode);
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
