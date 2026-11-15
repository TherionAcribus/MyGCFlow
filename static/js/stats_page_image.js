// Page Statistiques : tuiles image (image_tile.mjs) — fenêtre de choix
// (image, légende, cadrage), contenu d'une carte et d'une diapositive,
// chargement pour la vidéo. La bibliothèque est celle de l'onglet Images de
// la carte (/api/images, servie par le serveur local : même origine, les
// canevas de l'image du tableau et de la vidéo restent exportables) ; elle
// sert aussi l'image d'ouverture de la vidéo.

import { showError, t } from './notifications.js';
import { getBsModal, hideBsModal } from './ui_bootstrap.js';
import { createChartSpec, normalizeChartSpec } from './chart_spec.mjs';
import { MAX_ITEMS } from './dashboard_model.mjs';
import { IMAGE_FITS, imageUrl } from './image_tile.mjs';
import { withUndo } from './stats_page_card_actions.js';
import { cardSelector } from './stats_page_cards.js';
import { activeDashboard } from './stats_page_dashboard.js';
import { fetchJson } from './stats_page_data.js';
import { $, state } from './stats_page_state.js';

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------

// [{ file, name, width, height, … }], du plus récent au plus ancien.
export async function libraryImages() {
    return (await fetchJson('/api/images'))?.files || [];
}

// Envoi d'un fichier (normalisé par le serveur, refusé s'il n'est pas une
// image) → { file, width, height } ; l'erreur porte le message du serveur.
export async function uploadLibraryImage(file) {
    const form = new FormData();
    form.append('image', file, file.name);
    const response = await fetch('/api/images', { method: 'POST', body: form });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.message || t("L'image n'a pas pu être envoyée."));
    return data;
}

// Image décodée (vidéo), null si absente ou illisible.
export async function loadImage(file) {
    if (!file) return null;
    const el = new Image();
    el.src = imageUrl(file);
    try {
        await el.decode();
        return el;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Contenu d'une tuile
// ---------------------------------------------------------------------------

// L'image au cadrage voulu, ou « Image introuvable » (retirée de la
// bibliothèque depuis, fichier illisible). `data-state` : loading → ready
// ou missing (relevé E2E, attente de l'image du tableau).
export function imageBlock(spec, { fit = spec.view.image.fit, className = '' } = {}) {
    const box = document.createElement('div');
    box.className = ('stats-image ' + className).trim();
    box.dataset.fit = fit;
    const missing = () => {
        box.dataset.state = 'missing';
        const block = document.createElement('div');
        block.className = 'stats-card-unavailable';
        const icon = document.createElement('i');
        icon.className = 'ti ti-photo-off';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('p');
        text.textContent = t("Image introuvable : elle a peut-être été retirée de la bibliothèque. « Modifier » permet d'en choisir une autre.");
        block.append(icon, text);
        box.replaceChildren(block);
    };
    const { file } = spec.view.image;
    if (!file) {
        missing();
        return box;
    }
    box.dataset.state = 'loading';
    const img = document.createElement('img');
    img.alt = spec.title || t('Image');
    img.addEventListener('load', () => { box.dataset.state = 'ready'; }, { once: true });
    img.addEventListener('error', missing, { once: true });
    img.src = imageUrl(file);
    box.append(img);
    return box;
}

// ---------------------------------------------------------------------------
// Fenêtre « Ajouter une image » / « Modifier l'image »
// ---------------------------------------------------------------------------

// { mode: 'new' | 'edit', item } — l'élément en cours d'édition (copie).
let editor = null;
let listSeq = 0;

export function openImageEditor({ mode, item = null }) {
    const spec = item?.spec || createChartSpec({ view: { chart: 'image' } });
    editor = { mode, item: item ? structuredClone(item) : { size: 'S', height: 'M', spec } };
    $('statsImageTitle').textContent = mode === 'new' ? t('Ajouter une image') : t("Modifier l'image");
    $('btnStatsImageSave').textContent = mode === 'new' ? t('Ajouter') : t('Enregistrer');
    $('statsImageCaption').value = editor.item.spec.title;
    const fit = editor.item.spec.view.image.fit;
    for (const radio of document.querySelectorAll('input[name="statsImageFit"]')) radio.checked = radio.value === fit;
    fillImageLibrary(editor.item.spec.view.image.file);
    getBsModal('statsImageModal')?.show();
}

// Liste de la bibliothèque ; `current` reposé s'il y est encore.
async function fillImageLibrary(current) {
    const seq = ++listSeq;
    const select = $('statsImageFile');
    select.replaceChildren(new Option(t('Choisir une image…'), ''));
    select.value = '';
    syncImagePreview();
    let files = [];
    try {
        files = await libraryImages();
    } catch (e) {
        console.warn("[stats] Bibliothèque d'images non lue :", e?.message || e);
    }
    if (seq !== listSeq) return;
    for (const entry of files) select.add(new Option(entry.name || entry.file, entry.file));
    // Une saisie faite pendant le chargement (envoi d'un fichier) prime.
    if (!select.value && files.some((entry) => entry.file === current)) select.value = current;
    syncImagePreview();
}

function readImageSpec() {
    const fit = document.querySelector('input[name="statsImageFit"]:checked')?.value;
    return normalizeChartSpec({
        ...editor.item.spec,
        title: $('statsImageCaption').value,
        view: { chart: 'image', image: { file: $('statsImageFile').value, fit: IMAGE_FITS.includes(fit) ? fit : undefined } },
    });
}

// Aperçu : la tuile telle qu'elle sera (cadrage compris) ; « Ajouter » /
// « Enregistrer » attend une image.
export function syncImagePreview() {
    if (!editor) return;
    const spec = readImageSpec();
    const preview = $('statsImagePreview');
    const file = spec.view.image.file;
    preview.dataset.fit = spec.view.image.fit;
    $('btnStatsImageSave').disabled = !file;
    const img = preview.querySelector('img');
    if (!file) {
        img?.remove();
        $('statsImagePreviewEmpty').hidden = false;
        return;
    }
    $('statsImagePreviewEmpty').hidden = true;
    const alt = spec.title || t('Image');
    if (img?.getAttribute('src') === imageUrl(file)) {
        img.alt = alt;
        return;
    }
    img?.remove();
    const next = document.createElement('img');
    next.alt = alt;
    next.src = imageUrl(file);
    preview.append(next);
}

// « Parcourir… » : le fichier rejoint la bibliothèque, puis est choisi.
export async function onImageUpload() {
    const file = $('statsImageUpload').files?.[0];
    if (!file || !editor) return;
    const button = $('btnStatsImageBrowse');
    button.disabled = true;
    let data;
    try {
        data = await uploadLibraryImage(file);
    } catch (e) {
        showError(e.message);
        return;
    } finally {
        button.disabled = false;
    }
    if (!editor) return;
    const select = $('statsImageFile');
    if (![...select.options].some((option) => option.value === data.file)) select.add(new Option(file.name, data.file), 1);
    select.value = data.file;
    syncImagePreview();
}

export function saveImageEditor(event) {
    event?.preventDefault();
    if (!editor) return;
    const spec = readImageSpec();
    if (!spec.view.image.file) return;
    const { mode } = editor;
    const item = { ...editor.item, spec };
    editor = null;
    hideBsModal('statsImageModal');
    const dashboard = activeDashboard();
    if (mode === 'new') {
        if (dashboard.items.length >= MAX_ITEMS) return;
        withUndo(t('Image ajoutée.'), () => dashboard.items.push(item));
        $('statsGrid').querySelector(cardSelector(spec.id))
            ?.scrollIntoView({ block: 'nearest', behavior: state.reduceMotion ? 'auto' : 'smooth' });
        return;
    }
    const index = dashboard.items.findIndex((entry) => entry.spec.id === spec.id);
    if (index >= 0) withUndo(t('Image enregistrée.'), () => { dashboard.items[index] = item; });
}
