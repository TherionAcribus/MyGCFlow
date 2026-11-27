// Plan du parcours au repos (couche `parcours`, z 1060) : étapes reliées
// par journée, traces GPS, point provisoire de la pose de lieu ; piles des
// étapes recouvertes (éventail au clic), lien liste ↔ carte (halo, lignes
// surlignées), glisser des repères (lieu, base, étape → ajustement), bulle
// d'actions au clic et menu « Poser un lieu » au clic droit.
//
// La couche et son état (piles, éventail, survol, glisser) vivent ici ;
// peintures partagées via `paints` (parcours_paints.mjs), moteur et entrées
// par `getState()`, gestes (ajustements, lieux, pose) injectés — pas
// d'import de parcours_data.js.
import { showConfirmation, t } from './notifications.js';
import { KIND_BASE, KIND_PLACE, isCountedStop, minutesToTime } from './parcours_reconstruct.mjs';
import { stopDetail, stopFacts, stopLabel, stopTime } from './parcours_labels.mjs';
import { STACK_DISTANCE, fanOffsets, stackLabel, stackStops } from './parcours_stack.mjs';
import { parcoursExtent, parcoursStops } from './parcours_model.mjs';
import { infoEnabled } from './parcours_info.mjs';

const el = (id) => document.getElementById(id);

const LAYER_Z_INDEX = 1060;
const FIT_MAX_ZOOM = 16;

// deps : { getState, paints, stackItem, placeForm, stopByKey, placeOf,
//   button, pinnedTimeOf, pinStopTime, excludeStop, saveOverrides, placeById,
//   updatePlace, pushHistory, deletePlace, openStopDetails,
//   closeDetailsExcept, adjustmentsLocked, getMap, hidePopup, showPopup,
//   showDataTab }
export function createParcoursPlan(deps) {
    const S = () => deps.getState();
    const paints = deps.paints;
    const placeForm = deps.placeForm;

    let parcoursLayer = null;

    // Lien liste ↔ carte : survoler un point du plan surligne sa ligne dans
    // la liste ; le survol d'une ligne met le point en évidence (halo) via
    // `setHoveredStop`. Agir depuis la carte, au repos :
    // - clic sur une étape : bulle d'actions (moteur › popupAt, bulle de
    //   mapgl.js), sa ligne amenée dans la liste ;
    // - glisser un lieu, une base ou le point provisoire de la pose ;
    // - clic droit : la bulle de l'étape, ou « Poser un lieu / une base
    //   ici ».
    let dragging = false;         // un repère est en train d'être glissé
    let hoverBound = false;
    let hoveredFeature = null;    // point du plan mis en évidence par la liste
    let mapHoverRows = [];        // lignes de la liste mises en évidence par la carte

    // Au repos, les étapes comptées d'une même journée qui se recouvrent au
    // zoom courant forment une pile (parcours_stack.mjs) : la première étape
    // en porte le libellé (`stackKeys`, `stackLabel`), les autres sont
    // cachées (`stacked`). Un clic l'écarte en éventail (`fan`) : features
    // `fan` (une par étape, cliquables : bulle), `fanline`, `fancenter`,
    // retirées à la fermeture (clic ailleurs, Échap, zoom, plan refait).
    let stackResolution = null;
    let fan = null;               // { repKey, keys } de la pile ouverte

    function ensureLayer() {
        const map = deps.getMap();
        if (!map) return null;
        if (!parcoursLayer) {
            parcoursLayer = new ol.layer.Vector({
                source: new ol.source.Vector(),
                zIndex: LAYER_Z_INDEX,
                style: (feature) => {
                    const role = feature.get('role');
                    if (role === 'track') return paints.trackStyle;
                    if (role === 'line') return paints.lineStyle(paints.dayIndexes().byDate.get(feature.get('date')) ?? 0);
                    if (role === 'fan') return paints.fanStopStyle(feature);
                    if (role === 'fanline') return paints.fanLineStyle();
                    if (role === 'fancenter') return paints.fanCenterStyle();
                    if (role === 'draft') {
                        const kind = feature.get('kind');
                        return [paints.haloStyle(true), paints.placeStyle(kind, paints.featureIconClass(feature))];
                    }
                    return paints.pointStyle(feature);
                },
            });
            parcoursLayer.set('name', 'parcours');
            parcoursLayer.on('postrender', drawRestInfo);
        }
        if (!map.getLayers().getArray().includes(parcoursLayer)) map.addLayer(parcoursLayer);
        bindMapLink(map);
        return parcoursLayer;
    }

    function planFeatureAt(map, pixel, roles = ['stop']) {
        return map.forEachFeatureAtPixel(pixel,
            (f) => (roles.includes(f.get('role')) ? f : null),
            { layerFilter: (layer) => layer === parcoursLayer, hitTolerance: 5 });
    }

    function isDraggable(feature) {
        const role = feature.get('role');
        if (role === 'draft') return true;
        // Étape comptée (lot 15) : seule, ou sortie de sa pile par
        // l'éventail.
        if (role === 'fan') return true;
        if (role !== 'stop') return false;
        const kind = feature.get('kind');
        if (kind === KIND_PLACE || kind === KIND_BASE) return feature.get('placeId') != null;
        return (feature.get('stackKeys')?.length || 0) < 2;
    }

    function bindMapLink(map) {
        if (hoverBound) return;
        hoverBound = true;
        map.on('pointermove', (event) => {
            if (event.dragging || dragging) return;
            const feature = planFeatureAt(map, event.pixel, ['stop', 'draft', 'fan']);
            highlightRowsFor(feature?.get('role') === 'draft' ? null : feature);
            setInfoHover(feature);
            const target = map.getTargetElement();
            if (target && !placeForm.isPicking()) target.style.cursor = feature ? (isDraggable(feature) ? 'grab' : 'pointer') : '';
        });
        bindPlanDrag(map);
        map.getViewport().addEventListener('contextmenu', (event) => onMapContextMenu(map, event));
        // Piles recalculées à chaque changement de zoom (éventail refermé).
        map.on('moveend', () => {
            if (map.getView().getResolution() === stackResolution) return;
            closeFan();
            updateStacks();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeFan();
        });
    }

    function stackableFeatures(source) {
        return source.getFeatures()
            .filter((f) => f.get('role') === 'stop' && f.get('kind') !== KIND_PLACE && f.get('kind') !== KIND_BASE)
            .sort((a, b) => (a.get('index') ?? 0) - (b.get('index') ?? 0));
    }

    function updateStacks() {
        const map = deps.getMap();
        const source = parcoursLayer?.getSource();
        if (!map || !source) return;
        const resolution = map.getView().getResolution();
        stackResolution = resolution;
        const stops = stackableFeatures(source);
        for (const f of stops) f.setProperties({ stacked: false, stackKeys: null, stackLabel: null, stackFavorite: false }, true);
        if (resolution) {
            const stacks = stackStops(stops.map((f) => deps.stackItem(f.getGeometry().getCoordinates(), f.get('key'), resolution)),
                paints.stopStyle().size * STACK_DISTANCE);
            for (const { rep, members } of stacks) {
                if (members.length < 2) continue;
                stops[rep].setProperties({
                    stackKeys: members.map((m) => stops[m].get('key')),
                    stackLabel: stackLabel(members.map((m) => stops[m].get('label') || '')),
                    stackFavorite: members.some((m) => stops[m].get('favorite')),
                }, true);
                for (const m of members.slice(1)) stops[m].set('stacked', true, true);
            }
        }
        parcoursLayer.changed();
    }

    function openFan(feature) {
        const map = deps.getMap();
        const source = parcoursLayer?.getSource();
        const keys = feature.get('stackKeys') || [];
        if (!map || !source || keys.length < 2) return;
        closeFan();
        deps.hidePopup();
        const center = feature.getGeometry().getCoordinates();
        const resolution = map.getView().getResolution();
        const offsets = fanOffsets(keys.length, paints.stopStyle().size);
        const byKey = new Map(stackableFeatures(source).map((f) => [f.get('key'), f]));
        const features = [new ol.Feature({ role: 'fancenter', geometry: new ol.geom.Point(center) })];
        keys.forEach((key, i) => {
            const stop = byKey.get(key);
            if (!stop) return;
            const position = [center[0] + offsets[i][0] * resolution, center[1] - offsets[i][1] * resolution];
            features.push(new ol.Feature({ role: 'fanline', geometry: new ol.geom.LineString([center, position]) }));
            features.push(new ol.Feature({
                role: 'fan',
                key,
                kind: stop.get('kind'),
                type: stop.get('type'),
                label: stop.get('label'),
                favorite: stop.get('favorite'),
                geometry: new ol.geom.Point(position),
            }));
        });
        fan = { repKey: feature.get('key'), keys };
        source.addFeatures(features);
        parcoursLayer.changed();
    }

    function closeFan() {
        if (!fan) return;
        fan = null;
        const source = parcoursLayer?.getSource();
        for (const f of source?.getFeatures() || []) {
            if (['fan', 'fanline', 'fancenter'].includes(f.get('role'))) source.removeFeature(f);
        }
        if (hoveredFeature && !source?.hasFeature(hoveredFeature)) hoveredFeature = null;
        parcoursLayer?.changed();
    }

    // Glisser un repère : la pose est enregistrée au lâcher (un lieu ou une
    // base), ou reportée dans le formulaire (point provisoire). Un appui
    // sans mouvement reste un clic (bulle).
    function bindPlanDrag(map) {
        const translate = new ol.interaction.Translate({
            layers: [parcoursLayer],
            filter: (feature) => isDraggable(feature) && !S().clock.running && !placeForm.isPicking(),
            hitTolerance: 5,
        });
        translate.on('translatestart', () => {
            dragging = true;
            deps.hidePopup();
            const target = map.getTargetElement();
            if (target) target.style.cursor = 'grabbing';
        });
        translate.on('translateend', (event) => {
            dragging = false;
            const target = map.getTargetElement();
            if (target) target.style.cursor = 'grab';
            const feature = event.features.item(0);
            const [sx, sy] = event.startCoordinate || [];
            const [ex, ey] = event.coordinate || [];
            if (!feature || (sx === ex && sy === ey)) return;
            const [lon, lat] = ol.proj.toLonLat(feature.getGeometry().getCoordinates());
            if (feature.get('role') === 'draft') {
                placeForm.setDraft({ lon, lat });
                return;
            }
            if (feature.get('placeId') == null) {
                moveStopTo(feature.get('key'), lon, lat);
                return;
            }
            movePlaceTo(feature.get('placeId'), lon, lat);
        });
        map.addInteraction(translate);
    }

    // Étape glissée (lot 15) : sa position devient un ajustement, qui prime
    // sur toute autre et passe par l'historique comme les autres.
    // Ajustements verrouillés : le plan est redessiné, l'étape revient à sa
    // place.
    function moveStopTo(key, lon, lat) {
        const { selectedId, inputs } = S();
        closeFan();
        if (!selectedId || deps.adjustmentsLocked() || !inputs || !key) {
            renderLayer();
            return;
        }
        const round = (value) => Math.round(value * 1e6) / 1e6;
        deps.saveOverrides([{ key, position: { lat: round(lat), lon: round(lon) } }]);
    }

    // Refus (lecture en cours, erreur du serveur) : le repère revient à sa
    // place. Accepté : le déplacement entre dans l'historique (Ctrl+Z le
    // défait).
    async function movePlaceTo(id, lon, lat) {
        const place = deps.placeById(id);
        const before = place && { place: id, lat: place.lat, lon: place.lon };
        if (!(await deps.updatePlace(id, { lat, lon }))) renderLayer();
        else if (before) deps.pushHistory(before);
    }

    // Bulle d'une étape du plan (moteur › popupAt, appelé par le clic de
    // mapgl.js) : rien pendant une pose, une lecture ou juste après un
    // glisser.
    function parcoursPopupAt(pixel) {
        const { clock } = S();
        if (placeForm.isPicking() || clock.running || placeForm.isClickMuted()) return null;
        const map = deps.getMap();
        if (!map || !parcoursLayer?.getVisible()) return null;
        const feature = planFeatureAt(map, pixel, ['stop', 'fan']);
        // Clic hors de l'éventail ouvert : il se referme.
        if (fan && feature?.get('role') !== 'fan') closeFan();
        // Une pile s'écarte en éventail, sans bulle.
        if (feature?.get('role') === 'stop' && (feature.get('stackKeys')?.length || 0) > 1) {
            openFan(feature);
            return { handled: true };
        }
        const stop = feature ? deps.stopByKey(feature.get('key')) : null;
        if (!stop) return null;
        // Le panneau d'ajustement d'une autre étape, resté ouvert, se ferme :
        // la liste montre l'étape cliquée.
        deps.closeDetailsExcept?.(stop.key);
        el('parcoursStops')?.querySelector(`[data-stop-key="${CSS.escape(stop.key)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        return { coordinate: feature.getGeometry().getCoordinates(), render: (box) => fillStopBubble(box, stop) };
    }

    // Bulle : nom, heure et raison de la place, puis les gestes courants —
    // épingler l'heure, exclure l'étape (supprimer un lieu), ouvrir le
    // panneau complet. Chaque geste ferme la bulle.
    function fillStopBubble(box, stop) {
        const { photoByStop } = S();
        const wrap = document.createElement('div');
        wrap.className = 'parcours-bubble';
        wrap.dataset.stopKey = stop.key;
        const title = document.createElement('div');
        title.className = 'gc-popup-title';
        const number = paints.currentStopLabels().get(stop.key);
        title.textContent = number ? `${number} · ${stopLabel(stop)}` : stopLabel(stop);
        const detail = document.createElement('div');
        detail.className = 'gc-popup-note';
        detail.textContent = [stopTime(stop), stopDetail(stop, photoByStop.get(stop.key)?.length || 0)].filter(Boolean).join(' · ');
        wrap.append(title, detail);
        const facts = stopFacts(stop);
        if (facts) {
            const line = document.createElement('div');
            line.className = 'gc-popup-note parcours-bubble-facts';
            line.textContent = facts;
            wrap.append(line);
        }
        // Ses photos : un clic ouvre la photo dans l'onglet Photos.
        const photos = deps.photoStrip?.(stop.key, { max: 4 });
        if (photos) wrap.append(photos);
        const done = (action) => () => {
            deps.hidePopup();
            action();
        };
        const place = deps.placeOf(stop);

        if (stop.kind !== KIND_BASE) {
            const row = document.createElement('div');
            row.className = 'parcours-bubble-row';
            const input = document.createElement('input');
            input.type = 'time';
            input.className = 'form-control form-control-sm parcours-bubble-time';
            input.setAttribute('aria-label', t('Heure'));
            const pinned = deps.pinnedTimeOf(stop);
            input.value = pinned || minutesToTime(stop.arrivalMin);
            const pin = deps.button('btn btn-sm btn-light parcours-bubble-pin', 'ti-pin', t('Épingler cette heure'),
                { text: t('Épingler') });
            pin.addEventListener('click', done(() => deps.pinStopTime(stop, input.value)));
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') pin.click();
            });
            row.append(input, pin);
            if (pinned) {
                const unpin = deps.button('btn btn-sm btn-outline-light parcours-bubble-unpin', 'ti-pinned-off',
                    t('Retirer l’heure épinglée'));
                unpin.addEventListener('click', done(() => deps.pinStopTime(stop, null)));
                row.append(unpin);
            }
            wrap.append(row);
        }

        const actions = document.createElement('div');
        actions.className = 'parcours-bubble-row';
        if (isCountedStop(stop)) {
            const exclude = deps.button('btn btn-sm btn-outline-light parcours-bubble-exclude', 'ti-eye-off',
                t('Exclure du parcours'), { text: t('Exclure') });
            exclude.addEventListener('click', done(() => deps.excludeStop(stop)));
            actions.append(exclude);
            if (stop.positionMoved) {
                const reset = deps.button('btn btn-sm btn-outline-light parcours-bubble-position', 'ti-map-pin-off',
                    t('Revenir à la position de la cache'), { text: t('Position d’origine') });
                reset.addEventListener('click', done(() => deps.saveOverrides([{ key: stop.key, position: null }])));
                actions.append(reset);
            }
        } else if (place) {
            const label = place.kind === KIND_BASE ? t('Supprimer la base') : t('Supprimer le lieu');
            const remove = deps.button('btn btn-sm btn-outline-light parcours-bubble-delete', 'ti-trash', label,
                { text: t('Supprimer') });
            remove.addEventListener('click', done(() => {
                showConfirmation(
                    place.kind === KIND_BASE ? t('Supprimer cette base du parcours ?') : t('Supprimer ce lieu du parcours ?'),
                    label,
                    () => deps.deletePlace(place.id),
                    null,
                    { danger: true, confirmText: t('Supprimer') },
                );
            }));
            actions.append(remove);
        }
        const more = deps.button('btn btn-sm btn-outline-light parcours-bubble-details', 'ti-adjustments',
            t('Tous les réglages de l’étape'), { text: t('Détails') });
        more.addEventListener('click', done(() => deps.openStopDetails(stop.key)));
        actions.append(more);
        wrap.append(actions);
        if (place || isCountedStop(stop)) {
            const hint = document.createElement('div');
            hint.className = 'gc-popup-note';
            hint.textContent = place ? t('Glissez le repère sur la carte pour le déplacer.')
                : t('Glissez l’étape sur la carte pour corriger sa position.');
            wrap.append(hint);
        }
        box.append(wrap);
    }

    // Clic droit au repos : la bulle de l'étape visée, sinon un menu pour
    // poser un lieu ou une base à cet endroit (formulaire de l'onglet
    // Données, type choisi d'avance). Sans parcours ouvert, le menu du
    // navigateur.
    function onMapContextMenu(map, event) {
        const { ordered, selectedId, clock } = S();
        if (!ordered || !selectedId) return;
        event.preventDefault();
        if (placeForm.isPicking() || clock.running) return;
        const pixel = map.getEventPixel(event);
        const own = parcoursPopupAt(pixel);
        if (own) {
            if (own.coordinate) deps.showPopup(own.coordinate, own.render);
            return;
        }
        const coordinate = map.getCoordinateFromPixel(pixel);
        if (!coordinate) return;
        const [lon, lat] = ol.proj.toLonLat(coordinate);
        deps.showPopup(coordinate, (box) => {
            const wrap = document.createElement('div');
            wrap.className = 'parcours-bubble parcours-bubble-menu';
            for (const [kind, icon, text] of [[KIND_PLACE, 'ti-map-pin-plus', t('Poser un lieu ici')],
                [KIND_BASE, 'ti-home-plus', t('Poser une base ici')]]) {
                const item = deps.button(`btn btn-sm btn-light parcours-bubble-add-${kind}`, icon, text, { text });
                item.addEventListener('click', () => {
                    deps.hidePopup();
                    placeForm.cancel();
                    deps.showDataTab();
                    placeForm.openForm({ lon, lat }, { kind });
                    el('parcoursPlaceForm')?.scrollIntoView({ block: 'nearest' });
                });
                wrap.append(item);
            }
            box.append(wrap);
        });
    }

    // Feature du plan correspondant à une étape : la clé pour un point
    // donné, le lieu pour une base dessinée une seule fois quelles que
    // soient ses occurrences dans les journées.
    // Étape d'une pile : la pile (ou, éventail ouvert, sa place dans
    // l'éventail).
    function stopFeatureFor(stop) {
        const source = parcoursLayer?.getSource();
        if (!source || !stop) return null;
        const features = source.getFeatures();
        const fanned = features.find((f) => f.get('role') === 'fan' && f.get('key') === stop.key);
        if (fanned) return fanned;
        const feature = features.find((f) => f.get('role') === 'stop'
            && (f.get('key') === stop.key || (stop.placeId != null && f.get('placeId') === stop.placeId))) || null;
        if (!feature?.get('stacked')) return feature;
        return features.find((f) => f.get('role') === 'stop' && f.get('stackKeys')?.includes(stop.key)) || feature;
    }

    function setHoveredStop(stop) {
        const feature = stopFeatureFor(stop);
        if (feature === hoveredFeature) return;
        hoveredFeature?.set('hovered', false);
        hoveredFeature = feature;
        hoveredFeature?.set('hovered', true);
        // La fiche suit l'étape de la ligne survolée (pas la pile qui la
        // porte : celle de l'étape elle-même).
        setInfoHover(stop ? { key: stop.key, feature } : null);
    }

    // --- Fiche des caches au repos (points.parcours_info) ---------------------
    //
    // Permanent (« toutes les étapes ») : une fiche par étape comptée seule à
    // sa place (une pile n'en a pas ; ouverte en éventail, chacune la sienne).
    // Temporaire (« étape en cours ») : celle de l'étape survolée, sur la
    // carte ou dans la liste. Dessinée par la lecture (`drawInfoLabels`),
    // au-dessus du plan.
    //
    // Sous-onglet Style › Fiches ouvert : le réglage se juge tout de suite —
    // une vraie fiche est épinglée sur l'étape la plus proche du centre de
    // la vue (`preview` du relevé), même si la fiche est coupée, et le
    // survol d'une autre étape montre la sienne. En permanent, tout est
    // déjà visible : rien de plus. L'étape épinglée est gardée tant qu'elle
    // est visible, pour ne pas sauter d'une étape à l'autre au fil du
    // panoramique.
    let infoHover = null;          // { key, feature } de l'étape survolée
    let infoPreview = null;        // { key, feature } de l'étape épinglée
    let restInfo = { near: [], hidden: 0, preview: null };

    // Le sous-onglet Fiches est-il ouvert — et visible : un volet d'onglet
    // masqué (onglet principal quitté) n'a pas de boîte de mise en page.
    function studioOpen() {
        const pane = el('tabParcoursInfo');
        return !!pane && pane.classList.contains('active') && pane.offsetParent !== null;
    }

    function infoEntryOf(feature, force = false, preview = false) {
        const stop = deps.stopByKey(feature.get('key'));
        return stop ? { stop, coords: feature.getGeometry().getCoordinates(), alpha: 1, force, preview } : null;
    }

    function infoFeatureEligible(feature) {
        const role = feature.get('role');
        const kind = feature.get('kind');
        if (kind === KIND_PLACE || kind === KIND_BASE) return false;
        return role === 'fan' || (role === 'stop' && !feature.get('stacked') && !feature.get('stackKeys'));
    }

    // Fiche épinglée du studio : l'étape la plus proche du centre de la
    // vue, gardée tant qu'elle reste valide et visible.
    function previewInfoEntry() {
        const source = parcoursLayer?.getSource();
        const map = deps.getMap();
        const center = map?.getView()?.getCenter();
        if (!source || !center) return null;
        if (infoPreview?.feature && source.hasFeature(infoPreview.feature) && infoFeatureEligible(infoPreview.feature)) {
            const px = map.getPixelFromCoordinate(infoPreview.feature.getGeometry().getCoordinates());
            const size = map.getSize() || [0, 0];
            if (px[0] >= 0 && px[1] >= 0 && px[0] <= size[0] && px[1] <= size[1]) {
                return infoEntryOf(infoPreview.feature, true, true);
            }
        }
        let best = null;
        let bestDist = Infinity;
        for (const feature of source.getFeatures()) {
            if (!infoFeatureEligible(feature)) continue;
            const [x, y] = feature.getGeometry().getCoordinates();
            const d = (x - center[0]) ** 2 + (y - center[1]) ** 2;
            if (d < bestDist) {
                bestDist = d;
                best = feature;
            }
        }
        infoPreview = best ? { key: best.get('key'), feature: best } : null;
        return best ? infoEntryOf(best, true, true) : null;
    }

    function setInfoHover(target) {
        let next = null;
        if (target?.key) next = target;
        else if (target && typeof target.get === 'function') {
            const role = target.get('role');
            const kind = target.get('kind');
            if ((role === 'stop' || role === 'fan') && kind !== KIND_PLACE && kind !== KIND_BASE && !target.get('stackKeys')) {
                next = { key: target.get('key'), feature: target };
            }
        }
        if ((next?.key ?? null) === (infoHover?.key ?? null)) return;
        infoHover = next;
        const info = paints.infoSettings();
        if (studioOpen() || (info.near !== 'none' && infoEnabled(info))) parcoursLayer?.changed();
    }

    function restInfoEntries(info, studio) {
        const source = parcoursLayer?.getSource();
        if (!source || S().clock?.running) return [];
        if (!studio) infoPreview = null;
        let first = null;
        if (infoHover?.key) {
            const stop = deps.stopByKey(infoHover.key);
            const feature = infoHover.feature && source.hasFeature(infoHover.feature) ? infoHover.feature : null;
            if (stop && feature && !feature.get('stacked')) {
                first = { stop, coords: feature.getGeometry().getCoordinates(), alpha: 1, force: true };
            }
        }
        // Studio ouvert : fiche coupée (« nulle part ») — le survol et la
        // fiche épinglée montrent quand même le rendu en cours de réglage.
        const mode = studio && info.near === 'none' ? 'current' : info.near;
        if (mode === 'current') {
            if (first) return [first];
            if (!studio) return [];
            const preview = previewInfoEntry();
            return preview ? [preview] : [];
        }
        const entries = source.getFeatures()
            .filter((f) => infoFeatureEligible(f))
            .sort((a, b) => (a.get('index') ?? 0) - (b.get('index') ?? 0))
            .map((f) => infoEntryOf(f))
            .filter((entry) => entry && entry.stop.key !== first?.stop.key);
        return first ? [first, ...entries] : entries;
    }

    function drawRestInfo(event) {
        const info = paints.infoSettings();
        restInfo = { near: [], hidden: 0, preview: null };
        const studio = studioOpen() && !S().clock?.running;
        if (!studio && (!infoEnabled(info) || info.near === 'none')) return;
        const entries = restInfoEntries(info, studio);
        // Même sans entrée (fin de survol) : la lecture laisse finir le
        // fondu de sortie de la dernière fiche.
        const out = deps.drawInfoLabels(event, entries, info);
        const preview = entries.find((entry) => entry?.preview);
        restInfo = { ...out, preview: preview && out.near.includes(preview.stop.key) ? preview.stop.key : null };
    }

    // Lignes de la liste correspondant à un point du plan (toutes celles
    // d'une base : elle n'est dessinée qu'une fois).
    function highlightRowsFor(feature) {
        const rows = [];
        const box = el('parcoursStops');
        if (feature && box) {
            // Une pile : les lignes de toutes ses étapes.
            const keys = feature.get('stackKeys') || [feature.get('key')];
            const placeId = feature.get('placeId');
            for (const row of box.querySelectorAll('.parcours-stop')) {
                if (keys.includes(row.dataset.stopKey) || (placeId != null && row.dataset.placeId === String(placeId))) {
                    rows.push(row);
                }
            }
        }
        for (const row of mapHoverRows) if (!rows.includes(row)) row.classList.remove('is-map-hover');
        for (const row of rows) row.classList.add('is-map-hover');
        mapHoverRows = rows;
    }

    function renderLayer({ fit = false } = {}) {
        const { ordered, inputs } = S();
        const layer = ensureLayer();
        if (!layer) return;
        // Plan refait : une bulle ouverte décrirait l'état d'avant.
        deps.hidePopup();
        const source = layer.getSource();
        source.clear();
        hoveredFeature = null;
        fan = null;
        if (!ordered) return;
        const features = [];
        for (const track of inputs?.tracks || []) {
            for (const segment of track.segments || []) {
                if (segment.length < 2) continue;
                features.push(new ol.Feature({
                    role: 'track',
                    geometry: new ol.geom.LineString(segment.map((p) => ol.proj.fromLonLat([p[0], p[1]]))),
                }));
            }
        }
        for (const day of ordered.days) {
            // Une ligne par jour : la nuit n'est pas un trajet.
            if (day.stops.length > 1) {
                features.push(new ol.Feature({
                    role: 'line',
                    date: day.date,
                    geometry: new ol.geom.LineString(day.stops.map((stop) => ol.proj.fromLonLat([stop.lon, stop.lat]))),
                }));
            }
        }
        // Points ensuite, du dernier au premier : le n° 1 est dessiné
        // au-dessus quand deux étapes se recouvrent. Une base n'est dessinée
        // qu'une fois.
        const labels = paints.currentStopLabels();
        const seen = new Set();
        for (const stop of [...parcoursStops(ordered)].reverse()) {
            const id = stop.kind === KIND_BASE ? `base:${stop.placeId}` : stop.key;
            if (seen.has(id)) continue;
            seen.add(id);
            features.push(new ol.Feature({
                role: 'stop',
                key: stop.key,
                placeId: stop.placeId ?? null,
                kind: stop.kind,
                type: stop.type || '',
                index: stop.index,
                label: labels.get(stop.key) || '',
                favorite: !!stop.favorite,
                category: stop.category || 'other',
                icon: stop.icon || null,
                geometry: new ol.geom.Point(ol.proj.fromLonLat([stop.lon, stop.lat])),
            }));
        }
        // Point provisoire du formulaire de pose : du clic sur la carte à la
        // validation (ou l'annulation), pour que le clic ne semble pas
        // perdu.
        const draft = placeForm.draft();
        if (draft) {
            const draftCategory = el('parcoursPlaceCategory')?.value || 'other';
            features.push(new ol.Feature({
                role: 'draft',
                kind: el('parcoursPlaceKind')?.value || KIND_PLACE,
                category: draftCategory,
                icon: draftCategory === 'custom' ? placeForm.draftIcon() : null,
                geometry: new ol.geom.Point(ol.proj.fromLonLat([draft.lon, draft.lat])),
            }));
        }
        source.addFeatures(features);
        if (fit) {
            const extent = parcoursExtent(parcoursStops(ordered));
            if (extent) fitParcours(extent);
        }
        updateStacks();
    }

    // Cadrage posé par la page : tant que la vue n'a pas bougé depuis, un
    // changement de taille de la carte (disposition, séparateur, fenêtre) le
    // refait — sinon des étapes restaient coupées aux bords. Une vue déplacée
    // par l'utilisateur, ou une lecture en cours, n'est jamais recadrée.
    let fitted = null;   // { extent (lon/lat), center, resolution }
    let refitBound = false;

    function fitParcours(lonLatExtent) {
        const map = deps.getMap();
        const size = map?.getSize();
        if (!map || !size || !size[0] || !size[1]) return;
        const extent = ol.proj.transformExtent(lonLatExtent, 'EPSG:4326', 'EPSG:3857');
        const view = map.getView();
        view.fit(extent, { padding: [60, 60, 60, 60], maxZoom: FIT_MAX_ZOOM, size });
        fitted = { extent: lonLatExtent, center: view.getCenter(), resolution: view.getResolution() };
        if (!refitBound) {
            refitBound = true;
            map.on('change:size', refitAfterResize);
        }
    }

    function refitAfterResize() {
        if (!fitted || S().clock.running) return;
        const view = deps.getMap()?.getView();
        const center = view?.getCenter();
        const untouched = center && view.getResolution() === fitted.resolution
            && center[0] === fitted.center[0] && center[1] === fitted.center[1];
        if (!untouched) {
            fitted = null;
            return;
        }
        fitParcours(fitted.extent);
    }

    return {
        render: renderLayer,
        fit: fitParcours,
        popupAt: parcoursPopupAt,
        setVisible: (visible) => parcoursLayer?.setVisible(visible),
        infoState: () => ({ ...restInfo, hover: infoHover?.key ?? null }),
        refreshInfo: () => parcoursLayer?.changed(),
        layer: () => parcoursLayer,
        fan: () => fan,
        closeFan,
        setHoveredStop,
        pruneHoverRows: () => { mapHoverRows = mapHoverRows.filter((row) => row.isConnected); },
        hoveredFeature: () => hoveredFeature,
        hoverRows: () => mapHoverRows,
    };
}
