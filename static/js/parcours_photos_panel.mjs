// Panneau « Photos » du parcours ouvert (lots 4, 8, 9 et 10) : grille des
// vignettes, lieux proposés, détail (rattachement à une étape, légende,
// masquage, cadrage), réglages d'affichage et envoi. La préhension et le
// dessin en lecture restent dans parcours_data.js.
//
// L'état du parcours ouvert arrive par `getState()` ; les opérations qui
// touchent le parcours entier (création de lieu, aperçu de lecture, envois
// mutualisés, rechargement, verrou des ajustements) sont injectées — pas
// d'import de parcours_data.js.
import { showToast, t } from './notifications.js';
import { CONFIG } from './init.js';
import { saveSettingsPatch } from './settings_api.mjs';
import {
    calibrationOffset,
    formatDay,
    formatOffset,
    matchLabel,
    stopLabel,
} from './parcours_labels.mjs';
import {
    KIND_BASE,
    KIND_PLACE,
    minutesToTime,
} from './parcours_reconstruct.mjs';
import {
    cameraKey,
    cameraOffsets,
    hasPosition,
    photoClock,
    suggestPhotoPlaces,
} from './parcours_photos.mjs';
import {
    PHOTO_LAYOUT_NONE,
    PHOTO_ZOOM_RANGE,
    isFullFrame,
    normalizePhotoDisplay,
    photoCrop,
    photoCropRect,
    photoSlots,
} from './parcours_photo_layout.mjs';

const el = (id) => document.getElementById(id);

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

// deps : { getState, uploads, button, fetchJson, reloadAdjustments,
//          receiveAdjustments, adjustmentsLocked, stopByKey, createPlace,
//          previewPhoto, evictPhotoImages, getMap, getPhotoDisplay,
//          setPhotoDisplay, clockRunning, deferTimeline, applyTimeline }
// getState() → { inputs, ordered, photoMatches, timeline, selectedId }
export function createPhotosPanel(deps) {
    const s = () => deps.getState() || {};
    let photoDetailId = null;    // photo dont le panneau est ouvert
    let photosDirty = false;     // panneau à refaire à l'ouverture de l'onglet Photos
    // Cadrage montré mais pas encore enregistré (`values` : aspect, focusX,
    // focusY, zoom). Les flèches du clavier déplacent ce brouillon, qui
    // part en une requête quand la frappe s'arrête (un appui maintenu en
    // envoyait des dizaines). Les envois se suivent : une réponse ancienne
    // n'écrase jamais une valeur plus récente.
    const CROP_SAVE_DELAY_MS = 400;
    let cropDraft = null;        // { pid, id, values }
    let cropSent = null;         // dernier brouillon parti
    let cropTimer = 0;
    let cropQueue = Promise.resolve();

    function photoUrl(photo, thumb = false) {
        return `${CONFIG.BASE_URL}/api/parcours/${s().selectedId}/photos/${photo.id}/${thumb ? 'thumb' : 'file'}`;
    }

    function photoById(id) {
        return (s().inputs?.photos || []).find((photo) => photo.id === id) || null;
    }

    async function upload(files) {
        if (!s().selectedId || deps.adjustmentsLocked() || files.length === 0) return;
        await deps.uploads.run('photo', files);
    }

    async function linkPhoto(id, stopKey) {
        if (!s().selectedId || deps.adjustmentsLocked()) return;
        const pid = s().selectedId;
        try {
            await deps.fetchJson(`/api/parcours/${pid}/photos/${id}`, {
                method: 'PATCH', body: JSON.stringify({ stopKey }),
            });
            await deps.reloadAdjustments(pid);
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    // Réglages d'affichage d'une photo (lot 8). Masquer ou montrer change le
    // temps d'écran : reconstruction complète, refusée pendant une lecture.
    // Légende et cadrage ne touchent que le dessin : la photo est remplacée
    // en mémoire, le détail et la carte redessinés — pas la grille, qu'ils
    // ne changent pas. → true si enregistré.
    async function patchPhoto(id, patch, pid = s().selectedId) {
        if (!pid) return false;
        const rebuilds = 'hidden' in patch;
        if (rebuilds && deps.adjustmentsLocked()) {
            renderPhotoDetail();
            return false;
        }
        try {
            const { photo } = await deps.fetchJson(`/api/parcours/${pid}/photos/${id}`, {
                method: 'PATCH', body: JSON.stringify(patch),
            });
            const { inputs: fresh } = s();
            if (!fresh || !photo || pid !== s().selectedId) return false;
            const photos = (fresh.photos || []).map((p) => (p.id === photo.id ? photo : p));
            if (rebuilds) {
                deps.receiveAdjustments({ photos }, pid);
            } else {
                fresh.photos = photos;
                renderPhotoDetail();
                deps.getMap()?.render();
            }
            return true;
        } catch (error) {
            showToast(error.message, 'error');
            renderPhotoDetail();
            return false;
        }
    }

    // Brouillon de la photo `id` du parcours ouvert, ou null.
    function draftOf(id) {
        return cropDraft?.pid === s().selectedId && cropDraft.id === id ? cropDraft : null;
    }

    // Cadrage affiché : celui enregistré, le brouillon en attente par-dessus,
    // puis `extra` (geste en cours, pas encore confié au brouillon).
    function cropOf(photo, extra = null) {
        return { ...photoCrop(photo), ...(draftOf(photo.id)?.values || {}), ...(extra || {}) };
    }

    // Confie un changement de cadrage au brouillon, enregistré après `delay`
    // sans autre changement (0 : tout de suite, pour un geste terminé). Le
    // brouillon d'une autre photo part d'abord.
    function saveCrop(id, values, delay = 0) {
        const pid = s().selectedId;
        if (!pid) return;
        const same = draftOf(id);
        if (cropDraft && !same) flushCrop();
        // Toujours un nouvel objet : flushCrop reconnaît ainsi un brouillon
        // modifié pendant son envoi.
        cropDraft = { pid, id, values: { ...(same?.values || {}), ...values } };
        clearTimeout(cropTimer);
        cropTimer = setTimeout(flushCrop, delay);
    }

    function flushCrop() {
        clearTimeout(cropTimer);
        cropTimer = 0;
        const draft = cropDraft;
        if (!draft || draft === cropSent) return cropQueue;
        cropSent = draft;
        cropQueue = cropQueue.then(async () => {
            await patchPhoto(draft.id, draft.values, draft.pid);
            // Pas modifié entre-temps : enregistré (ou refusé) — le détail
            // montre de nouveau la photo telle qu'elle est.
            if (cropDraft === draft) {
                cropDraft = null;
                renderPhotoDetail();
            }
        });
        return cropQueue;
    }

    async function deletePhoto(id) {
        if (!s().selectedId || deps.adjustmentsLocked()) return;
        const pid = s().selectedId;
        try {
            await deps.fetchJson(`/api/parcours/${pid}/photos/${id}`, { method: 'DELETE' });
            deps.evictPhotoImages(id);
            if (photoDetailId === id) photoDetailId = null;
            if (draftOf(id)) {
                clearTimeout(cropTimer);
                cropDraft = null;
            }
            await deps.reloadAdjustments(pid);
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    async function setCameraOffset(camera, offsetMinutes) {
        if (!s().selectedId || deps.adjustmentsLocked()) return;
        const pid = s().selectedId;
        try {
            deps.receiveAdjustments(await deps.fetchJson(`/api/parcours/${pid}/cameras`, {
                method: 'PUT', body: JSON.stringify({ camera, offsetMinutes }),
            }), pid);
        } catch (error) {
            showToast(error.message, 'error');
        }
    }

    function render() {
        const { inputs, ordered, photoMatches } = s();
        const card = el('parcoursPhotosCard');
        if (!card) return;
        card.hidden = !inputs;
        const empty = el('parcoursPhotosEmpty');
        if (empty) empty.hidden = !!inputs;
        if (!inputs) return;
        // Onglet Photos non affiché : la grille (une vignette par photo,
        // jusqu'à des centaines) n'est pas reconstruite à chaque ajustement
        // fait ailleurs — juste marquée, refaite à l'ouverture de l'onglet.
        const pane = card.closest('.tab-pane');
        if (pane && !pane.classList.contains('active')) {
            photosDirty = true;
            return;
        }
        photosDirty = false;
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
        // Une ligne par clé d'appareil (un boîtier, ou un modèle sans numéro
        // de série) ; un modèle recalé garde sa ligne tant qu'un boîtier de ce
        // modèle en hérite, pour pouvoir l'oublier.
        const cameras = el('parcoursCameras');
        if (cameras) {
            const shown = photos.filter((p) => p.camera && !hasPosition(p));
            const keys = new Set(shown.map(cameraKey));
            for (const p of shown) if (offsets.has(p.camera)) keys.add(p.camera);
            const nameOf = new Map();
            for (const p of shown) {
                nameOf.set(cameraKey(p), p.cameraSerial
                    ? t('${camera} (n° ${serial})', { camera: p.camera, serial: p.cameraSerial })
                    : p.camera);
            }
            const modelOf = new Map(shown.map((p) => [cameraKey(p), p.camera]));
            cameras.replaceChildren(...[...keys].sort().map((key) => {
                const name = nameOf.get(key) || key;
                const model = modelOf.get(key) || key;
                const inherited = !offsets.has(key) && model !== key && offsets.has(model);
                const row = document.createElement('div');
                row.className = 'mb-2 parcours-camera';
                row.dataset.camera = key;
                const label = document.createElement('div');
                label.className = 'small mb-1';
                label.textContent = offsets.has(key)
                    ? t('${camera} : horloge recalée (${offset})', { camera: name, offset: formatOffset(offsets.get(key)) })
                    : inherited
                        ? t('${camera} : horloge recalée comme le modèle (${offset})', { camera: name, offset: formatOffset(offsets.get(model)) })
                        : t('${camera} : horloge non recalée, heures ignorées', { camera: name });
                const controls = document.createElement('div');
                controls.className = 'd-flex align-items-center gap-2 flex-wrap';
                const input = document.createElement('input');
                input.type = 'number';
                input.step = '1';
                input.className = 'form-control form-control-sm parcours-camera-offset';
                input.value = String(offsets.get(key) ?? (inherited ? offsets.get(model) : 0));
                input.setAttribute('aria-label', t('Décalage en minutes'));
                const unit = document.createElement('span');
                unit.className = 'small text-muted';
                unit.textContent = t('min');
                const apply = deps.button('btn btn-sm btn-outline-primary parcours-camera-apply', 'ti-clock',
                    t('Recaler l’horloge'), { text: t('Recaler l’horloge') });
                apply.addEventListener('click', () => {
                    const value = Math.round(Number(input.value));
                    if (Number.isFinite(value)) setCameraOffset(key, value);
                });
                controls.append(input, unit, apply);
                if (offsets.has(key)) {
                    const clear = deps.button('btn btn-sm btn-link parcours-camera-clear', 'ti-x', t('Oublier ce recalage'));
                    clear.addEventListener('click', () => setCameraOffset(key, null));
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
                const lostNote = t('étape choisie retirée du parcours');
                cell.title = [
                    photo.name,
                    matchLabel(match, deps.stopByKey(match?.key)),
                    match?.lostKey ? lostNote : '',
                    photo.hidden ? hiddenNote : '',
                ].filter(Boolean).join(' — ');
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
                    render();
                });
                return cell;
            }));
        }
        renderPhotoPlaces(ordered);
        renderPhotoDetail();
        renderPhotoDisplay();
    }

    // Photos géolocalisées hors de toute étape (lot 10) : un lieu proposé par
    // endroit, créé d'un clic (nom facultatif) ; ses photos s'y rattachent.
    function renderPhotoPlaces(ordered) {
        const { inputs, photoMatches } = s();
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
            const create = deps.button('btn btn-sm btn-outline-primary parcours-photo-place-create', 'ti-map-pin-plus',
                t('Créer ce lieu'), { text: t('Créer ce lieu') });
            create.addEventListener('click', async () => {
                create.disabled = true;
                const ok = await deps.createPlace({
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
        const { inputs, ordered, photoMatches, timeline } = s();
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
                photo.camera && photo.cameraSerial
                    ? t('${camera} (n° ${serial})', { camera: photo.camera, serial: photo.cameraSerial })
                    : photo.camera || '',
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
        // Étape choisie à la main puis retirée du parcours : gardée en
        // option (sélectionnée) tant que la photo l'attend ; « Automatique »
        // l'oublie.
        const autoMatch = photo.stopKey && !match?.lostKey ? null : match;
        auto.textContent = autoMatch?.key ? t('Automatique : ${label}', { label: matchLabel(autoMatch, deps.stopByKey(autoMatch.key)) }) : t('Automatique');
        select.append(auto);
        if (match?.lostKey) {
            const lost = document.createElement('option');
            lost.value = match.lostKey;
            lost.textContent = t('Étape retirée du parcours');
            select.append(lost);
        }
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
        const linkRow = [label, select];
        if (match?.lostKey) {
            const hint = document.createElement('div');
            hint.className = 'form-hint text-muted w-100 parcours-photo-lost';
            hint.textContent = t('L’étape choisie pour cette photo a été retirée du parcours : la photo suit le rattachement automatique, et retrouvera son étape si elle revient.');
            linkRow.push(hint);
        }
        el('parcoursPhotoLinkRow')?.replaceChildren(...linkRow);

        const shown = el('parcoursPhotoShown');
        if (shown) shown.checked = !photo.hidden;
        const caption = el('parcoursPhotoCaption');
        if (caption && document.activeElement !== caption) caption.value = photo.caption || '';
        const crop = cropOf(photo);
        const aspect = el('parcoursPhotoAspect');
        if (aspect) aspect.value = crop.aspect;
        const zoom = el('parcoursPhotoZoom');
        if (zoom) zoom.value = String(crop.zoom);
        renderCropPicker(photo);

        const actions = [];
        const stop = match?.key ? deps.stopByKey(match.key) : null;
        const offset = !hasPosition(photo) && photo.camera ? calibrationOffset(photo, stop, ordered?.days) : null;
        if (offset !== null) {
            const calibrate = deps.button('btn btn-sm btn-outline-primary parcours-photo-calibrate', 'ti-clock',
                t('Caler l’horloge de l’appareil sur cette étape'),
                { text: t('Caler l’horloge sur l’étape (${offset})', { offset: formatOffset(offset) }) });
            calibrate.addEventListener('click', () => setCameraOffset(cameraKey(photo), offset));
            actions.push(calibrate);
        }
        if (timeline && photoSlots(timeline).some((slot) => slot.photoId === photo.id)) {
            const show = deps.button('btn btn-sm btn-outline-secondary parcours-photo-preview', 'ti-eye',
                t('Ouvrir l’aperçu en pause sur cette photo'), { text: t('Voir sur la carte') });
            show.addEventListener('click', () => deps.previewPhoto(photo.id));
            actions.push(show);
        }
        const remove = deps.button('btn btn-sm btn-outline-danger parcours-photo-delete', 'ti-trash', t('Supprimer la photo'),
            { text: t('Supprimer la photo') });
        remove.addEventListener('click', () => deletePhoto(photo.id));
        actions.push(remove);
        el('parcoursPhotoActions')?.replaceChildren(...actions);
    }

    // Sélecteur du cadrage : la photo entière, la fenêtre gardée par-dessus
    // (le reste assombri). `draft` : cadrage en cours de geste, pas encore
    // confié au brouillon (cropOf).
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
        const crop = cropOf(photo, draft);
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

    // --- Réglages d'affichage des photos (lot 9) ---------------------------------

    function renderPhotoDisplay() {
        const photoDisplay = deps.getPhotoDisplay();
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
        const { timeline } = s();
        const preview = el('btnParcoursPhotoPreview');
        if (preview) preview.disabled = layout === PHOTO_LAYOUT_NONE || !timeline || photoSlots(timeline).length === 0;
    }

    function bindPhotoDisplay() {
        renderPhotoDisplay();
        // Valeur complète envoyée (comme parcours_playback) ; la durée, le
        // plafond et « aucune photo » changent la chronologie.
        const save = (patch) => {
            const before = deps.getPhotoDisplay();
            const next = normalizePhotoDisplay({ ...before, ...patch });
            deps.setPhotoDisplay(next);
            const full = { ...next };
            saveSettingsPatch({ parcours_photo_display: full }).then(() => {
                if (window.userSettings) window.userSettings.parcours_photo_display = full;
            });
            if (window.userSettings) window.userSettings.parcours_photo_display = full;
            renderPhotoDisplay();
            const timing = before.duration !== next.duration
                || before.max_per_stop !== next.max_per_stop
                || (before.layout === PHOTO_LAYOUT_NONE) !== (next.layout === PHOTO_LAYOUT_NONE);
            if (timing) {
                if (deps.clockRunning()) {
                    deps.deferTimeline();
                    showToast(t("Le réglage s'appliquera à la fin de l'animation."), 'info', t('Parcours'));
                } else {
                    deps.applyTimeline();
                }
            }
            deps.getMap()?.render();
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
            deps.setPhotoDisplay(normalizePhotoDisplay({ ...deps.getPhotoDisplay(), size: Number(size.value) }));
            const photoDisplay = deps.getPhotoDisplay();
            const sizeValue = el('parcoursPhotoSizeValue');
            if (sizeValue) sizeValue.textContent = `${photoDisplay.size} px`;
            deps.getMap()?.render();
        });
        size?.addEventListener('change', () => save({ size: Number(size.value) }));
        const pinSize = el('parcoursPhotoPinSize');
        pinSize?.addEventListener('input', () => {
            deps.setPhotoDisplay(normalizePhotoDisplay({ ...deps.getPhotoDisplay(), pin_size: Number(pinSize.value) }));
            const photoDisplay = deps.getPhotoDisplay();
            const value = el('parcoursPhotoPinSizeValue');
            if (value) value.textContent = `${photoDisplay.pin_size} px`;
            deps.getMap()?.render();
        });
        pinSize?.addEventListener('change', () => save({ pin_size: Number(pinSize.value) }));
        el('parcoursPhotoDuration')?.addEventListener('change', (event) => save({ duration: Number(event.target.value) }));
        el('parcoursPhotoMaxPerStop')?.addEventListener('change', (event) => save({ max_per_stop: Number(event.target.value) }));
        el('parcoursPhotoCaptionTemplate')?.addEventListener('change', (event) => save({ caption: event.target.value }));
        el('btnParcoursPhotoPreview')?.addEventListener('click', () => {
            const { timeline } = s();
            const first = timeline ? photoSlots(timeline)[0] : null;
            if (first) deps.previewPhoto(first.photoId);
        });
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
        // Proportions, zoom et point focal passent tous par le brouillon :
        // leurs envois se suivent dans l'ordre des gestes.
        el('parcoursPhotoAspect')?.addEventListener('change', (event) => {
            const photo = current();
            if (photo) saveCrop(photo.id, { aspect: event.target.value });
        });
        const zoom = el('parcoursPhotoZoom');
        zoom?.addEventListener('input', () => {
            const photo = current();
            if (photo) renderCropPicker(photo, { zoom: Number(zoom.value) });
        });
        zoom?.addEventListener('change', () => {
            const photo = current();
            const value = Math.round(Number(zoom.value));
            if (photo && value >= PHOTO_ZOOM_RANGE[0] && value <= PHOTO_ZOOM_RANGE[1]) saveCrop(photo.id, { zoom: value });
        });

        // Point focal : glisser (enregistré au relâchement), ou les flèches
        // (1 %, Maj = 10 %), comme le sélecteur de l'onglet Images — enregistré
        // quand la frappe s'arrête, ou à la sortie du sélecteur.
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
                if (draft) saveCrop(photo.id, draft);
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
            const crop = cropOf(photo);
            const clamp = (v) => Math.max(0, Math.min(100, v));
            saveCrop(photo.id, { focusX: clamp(crop.focusX + dir[0] * step), focusY: clamp(crop.focusY + dir[1] * step) },
                CROP_SAVE_DELAY_MS);
            renderCropPicker(photo);
        });
        picker.addEventListener('blur', () => flushCrop());
    }

    function bind() {
        bindPhotoDetail();
        bindPhotoDisplay();
        // Rendu différé quand l'onglet n'est pas affiché : refait à l'ouverture.
        document.querySelector('#mainTabs a[href="#photos"]')?.addEventListener('shown.bs.tab', () => {
            if (photosDirty) render();
        });
        el('btnParcoursPhotosStop')?.addEventListener('click', () => deps.uploads.cancel('photo'));
        const input = el('parcoursPhotoInput');
        el('btnParcoursAddPhotos')?.addEventListener('click', () => input?.click());
        input?.addEventListener('change', () => {
            const files = [...(input.files || [])];
            input.value = '';
            upload(files);
        });
    }

    return { bind, render, upload, linkPhoto };
}
