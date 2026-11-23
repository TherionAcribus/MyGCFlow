// Dessin de la lecture du parcours : trait parcouru et trajet en cours,
// géocacheur (pastille ou pictogramme), étapes atteintes (pastilles ou
// numéros, piles mémorisées, anneau de l'étape en cours, atténuation du
// passé, aperçu pâle de la suite), lieux et bases, nuit, cartons de jour et
// de fin, crédits des itinéraires, cartes postales des photos. Deux couches
// dédiées (`parcours-trail`, `parcours-head`) repeignent à chaque image en
// postrender, à la position fractionnaire `currentQ` du moteur.
//
// Chargement des photos de la lecture : vignettes (épinglables à tout
// moment), pleine taille seulement près de la tête (PHOTO_AHEAD/BEHIND_Q) ;
// `photosReady` attend le décodage avant la première image d'un
// enregistrement. `previewPhoto` cale une lecture en pause sur une photo.
//
// État lu par injection : moteur (`clock`, `currentQ`), chronologie,
// réglages de lecture et d'affichage photo, étapes projetées, photos et
// rattachements (`getState`). Peintures d'étapes partagées avec le plan via
// `paints` (parcours_paints.mjs). Caméra, couches du plan et attribution des
// itinéraires restent dans parcours_data.js (deps).
import { KIND_BASE, KIND_PLACE, CONFIDENCE_ANCHORED, isCountedStop } from './parcours_reconstruct.mjs';
import {
    HEAD_PICTOGRAM,
    dayCardAt,
    openCardAt,
    dayStats,
    endCardAt,
    formatClock,
    headAt,
    headModeAt,
    legPoints,
    nightLevelAt,
    reachedIndex,
    sceneTimingOptions,
    trailAt,
} from './parcours_timeline.mjs';
import {
    CURRENT_RING_PERIOD,
    FAVORITE_COLOR,
    currentRingRadius,
    favoriteBurst,
    hexToRgba,
    playPhase,
    stopPopScale,
    trailColorFor,
} from './parcours_style.mjs';
import { STACK_DISTANCE, stackLabel, stackStops } from './parcours_stack.mjs';
import { cameraOffsets, favoritePhotoIds, photoClock, photoTimeTrusted } from './parcours_photos.mjs';
import {
    PHOTO_FADE_Q,
    PHOTO_LAYOUT_NONE,
    cardPhotos as pickCardPhotos,
    isPanorama,
    photoAspect,
    photoCaptionText,
    photoCropRect,
    photoFrameAt,
    photoSlots,
} from './parcours_photo_layout.mjs';
import { drawPhotoCard, drawPhotoLeader } from './parcours_photo_draw.mjs';
import { composeTransform } from './travel_trail.mjs';
import { dateOfDayIndex } from './evolution_timeline.mjs';
import { formatDay, formatKm, formatRange, stopLabel, stopsCountText } from './parcours_labels.mjs';
import { slotLabels } from './parcours_tbar.mjs';
import { t } from './notifications.js';
import { CONFIG } from './init.js';

const PLAY_TRAIL_Z_INDEX = 1000;
const PLAY_HEAD_Z_INDEX = 1050;

const NIGHT_ALPHA = 0.5;
// Cœur des PF donnés (marque et effet à l'arrivée) : glyphe texte, sans
// attendre la police d'icônes.
const HEART = '♥';

// Étapes passées : plus transparentes et un peu plus petites ; aperçu de la
// suite : à peine visibles. Variantes d'un style, gardées tant qu'il vit.
const DIM_PAST = { opacity: 0.4, scale: 0.85 };
const DIM_PREVIEW = { opacity: 0.3, scale: 0.8 };

// Styles du trait d'une journée : trajet, nuit (pointillés fins), trajet
// estimé (option, pointillés).
const TRAIL_KINDS = ['night', 'estimated', 'day'];

// Pictogrammes de la tête : glyphes de Tabler Icons lus dans la feuille de
// style (le sous-ensemble ne garde que les icônes citées dans le code).
const HEAD_ICON_CLASSES = Object.freeze({
    walk: 'ti-walk',
    bike: 'ti-bike',
    car: 'ti-car',
    plane: 'ti-plane',
    night: 'ti-moon',
});

// deps : { getState, paints, quantumBase, tablerGlyph, bindCamera,
//   syncAttribution, routeCredit, getMap, isRecording, previewState,
//   startPreview, seekTo }
export function createParcoursPlayDraw(deps) {
    const S = () => deps.getState();
    const paints = deps.paints;

    // Requête « prefers-reduced-motion », mémoïsée (même motif que mapgl.js,
    // qui ne peut pas être importé ici) : en aperçu, les effets d'arrivée
    // s'adoucissent — anneau fixe, pas d'envol de cœurs, pastilles à taille
    // pleine, photos qui entrent au fondu et sans Ken Burns. Jamais en
    // capture : la vidéo garde le dynamisme complet.
    let motionQuery;
    function reducedMotion() {
        if (motionQuery === undefined) {
            try {
                motionQuery = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
                    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
            } catch (_) {
                motionQuery = null;
            }
        }
        return !deps.isRecording() && !!motionQuery?.matches;
    }

    let playTrailLayer = null;
    let playHeadLayer = null;

    // Trait de la lecture (thème, `points.parcours_style`) : `color` avec son
    // opacité pour le trait, `solid` sans, pour le géocacheur. Aux couleurs
    // des journées, celle de la journée `dayIndex`.
    function trailOptions(dayIndex = 0) {
        const style = paints.stopStyle();
        const solid = trailColorFor(style, dayIndex);
        return {
            color: hexToRgba(solid, style.trail_opacity / 100),
            solid,
            width: style.trail_width,
        };
    }

    // Journée d'un trajet : celle de son arrivée — la nuit prend la couleur
    // du lendemain.
    function legDayIndex(leg) {
        return paints.dayIndexes().byKey.get(S().timeline?.stops[leg.to]?.key) ?? 0;
    }

    // Journée du géocacheur : celle du trajet en cours, sinon de la dernière
    // étape atteinte.
    function headDayIndex(current) {
        const { timeline, currentQ } = S();
        if (current) return legDayIndex(timeline.legs[current.leg]);
        // Dernière étape atteinte par bissection (reachedIndex), comme
        // partout ailleurs — le balayage linéaire coûtait O(n) à chaque
        // image de visite ou de nuit.
        const reached = reachedIndex(timeline, currentQ);
        return paints.dayIndexes().byKey.get(timeline.stops[reached]?.key) ?? 0;
    }

    function trailStyle(kind, dayIndex) {
        const { color, width } = trailOptions(dayIndex);
        return paints.cachedStyle(`trail:${kind}:${color}`, () => {
            if (kind === 'night') {
                return new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: Math.max(1, width * 0.6), lineDash: [width * 2, width * 2] }) });
            }
            return new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color, width, lineCap: 'round', lineJoin: 'round',
                    lineDash: kind === 'estimated' ? [width * 2.5, width * 2] : undefined,
                }),
            });
        });
    }

    function legKind(leg, dashed) {
        return leg.night ? 'night' : (dashed && !leg.path ? 'estimated' : 'day');
    }

    function ensureLayers() {
        const map = deps.getMap();
        if (!map) return;
        if (!playTrailLayer) {
            playTrailLayer = new ol.layer.Vector({ source: new ol.source.Vector(), zIndex: PLAY_TRAIL_Z_INDEX });
            playTrailLayer.set('name', 'parcours-trail');
            playTrailLayer.on('postrender', drawPlayTrail);
            playHeadLayer = new ol.layer.Vector({ source: new ol.source.Vector(), zIndex: PLAY_HEAD_Z_INDEX });
            playHeadLayer.set('name', 'parcours-head');
            playHeadLayer.on('postrender', drawPlayHead);
        }
        const layers = map.getLayers().getArray();
        if (!layers.includes(playTrailLayer)) map.addLayer(playTrailLayer);
        if (!layers.includes(playHeadLayer)) map.addLayer(playHeadLayer);
        playTrailLayer.setVisible(true);
        playHeadLayer.setVisible(true);
        deps.bindCamera(map);
        deps.syncAttribution();
    }

    function hideLayers() {
        playTrailLayer?.setVisible(false);
        playHeadLayer?.setVisible(false);
    }

    function layersVisible() {
        return !!(playTrailLayer?.getVisible() && playHeadLayer?.getVisible());
    }

    // Trait parcouru : trajets terminés, puis la part faite du trajet en
    // cours. La nuit (d'une journée à la suivante) en pointillés.
    //
    // Les trajets terminés sont regroupés par style — nature du trajet et,
    // aux couleurs des journées, journée — en MultiLineString persistants,
    // allongés à mesure que la lecture avance : une géométrie par style à
    // l'image au lieu d'une LineString par trajet (des centaines de trajets
    // routés recréés à chaque image sinon).
    let trailGroups = null;
    const currentLegGeom = new ol.geom.LineString([]);
    const headPoint = new ol.geom.Point([0, 0]);
    // Point de travail des dessins immédiats (étapes, PF, lieux) : un seul
    // objet repositionné, là où l'image en allouait un par fonction.
    const scratchPoint = new ol.geom.Point([0, 0]);

    function doneTrailGroups(done) {
        const { timeline, playback } = S();
        const byDay = paints.stopStyle().trail_by_day;
        if (!trailGroups || trailGroups.timeline !== timeline || trailGroups.dashed !== playback.estimated_dashed
                || trailGroups.byDay !== byDay) {
            trailGroups = { timeline, dashed: playback.estimated_dashed, byDay, done: 0, groups: new Map() };
        }
        // Retour en arrière dans la lecture : tout se refait depuis le début.
        if (done < trailGroups.done) {
            trailGroups.done = 0;
            trailGroups.groups.clear();
        }
        for (let k = trailGroups.done; k < done; k++) {
            const leg = timeline.legs[k];
            // Trajet sur une trace GPS ou un itinéraire : le vrai chemin,
            // sinon la ligne droite.
            const coords = S().legProjected[k] || [S().projected[leg.from], S().projected[leg.to]];
            const kind = legKind(leg, trailGroups.dashed);
            const dayIndex = byDay ? legDayIndex(leg) : 0;
            const key = `${kind}:${dayIndex}`;
            let g = trailGroups.groups.get(key);
            if (!g) {
                g = { kind, dayIndex, coords: [], geom: new ol.geom.MultiLineString([]) };
                trailGroups.groups.set(key, g);
            }
            g.coords.push(coords);
            g.geom.setCoordinates(g.coords);
        }
        trailGroups.done = done;
        return trailGroups;
    }

    function drawPlayTrail(event) {
        const { clock, timeline, currentQ, playback, projected, legProjected } = S();
        if (!clock.running || !timeline) return;
        const context = ol.render.getVectorContext(event);
        const { done, current } = frame().trail;
        const { groups } = doneTrailGroups(done);
        // Nuits sous les trajets estimés, eux-mêmes sous les trajets réels.
        for (const kind of TRAIL_KINDS) {
            for (const g of groups.values()) {
                if (g.kind !== kind || !g.coords.length) continue;
                context.setStyle(trailStyle(kind, g.dayIndex));
                context.drawGeometry(g.geom);
            }
        }
        if (current) {
            const leg = timeline.legs[current.leg];
            const coords = current.progress >= 1
                ? (legProjected[current.leg] || [projected[leg.from], projected[leg.to]])
                : legPoints(timeline, current.leg, current.progress).map((p) => ol.proj.fromLonLat(p));
            context.setStyle(trailStyle(legKind(leg, playback.estimated_dashed), legDayIndex(leg)));
            currentLegGeom.setCoordinates(coords);
            context.drawGeometry(currentLegGeom);
        }
    }

    // La nuit (assombrissement), les bases (toujours) et les lieux déjà
    // atteints, le géocacheur, puis la carte postale, le carton du jour et
    // les crédits des itinéraires (vidéo).
    function drawPlayHead(event) {
        const { clock, timeline, currentQ, playback } = S();
        if (!clock.running || !timeline) return;
        const head = frame().head;
        if (!head) return;
        const ctx = event.context;
        const ratio = event.frameState.pixelRatio || 1;
        const context = ol.render.getVectorContext(event);
        drawPlayStops(context, event.frameState.viewState.resolution, event.frameState.extent);
        const level = playback.day_cards ? nightLevelAt(timeline, currentQ) : 0;
        if (level > 0) {
            ctx.save();
            ctx.fillStyle = `rgba(10, 16, 38, ${(NIGHT_ALPHA * level).toFixed(3)})`;
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.restore();
        }
        drawPlayPlaces(context);
        const { solid: color } = trailOptions(headDayIndex(frame().trail.current));
        playStopsDrawn.headColor = color;
        const position = ol.proj.fromLonLat([head.lon, head.lat]);
        const glyph = playback.head === HEAD_PICTOGRAM ? headGlyph(frame().mode) : null;
        if (glyph) {
            const m = composeTransform(event.inversePixelTransform, event.frameState.coordinateToPixelTransform);
            const x = m[0] * position[0] + m[2] * position[1] + m[4];
            const y = m[1] * position[0] + m[3] * position[1] + m[5];
            drawHeadPictogram(ctx, x, y, ratio, color, glyph);
        } else {
            context.setStyle(paints.cachedStyle(`head:${color}`, () => new ol.style.Style({
                image: new ol.style.Circle({
                    radius: 7,
                    fill: new ol.style.Fill({ color }),
                    stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                }),
            })));
            headPoint.setCoordinates(position);
            context.drawGeometry(headPoint);
        }
        // Après le géocacheur : la carte postale passe au-dessus.
        drawPhotoCards(event);
        cardPhotosDrawn = [];
        drawOpenCard(ctx, ratio);
        drawDayCard(ctx, ratio);
        drawEndCard(ctx, ratio);
        drawRouteCredits(ctx, ratio);
    }

    // Étapes comptées déjà atteintes, dans le rendu du plan : pastilles, ou
    // numéros à côté des points du thème (WebGL, qui apparaissent seuls),
    // sous la nuit. Celles qui se recouvrent au zoom de l'image forment des
    // piles, comme au repos (« 4–5 », puis « 4–6 »…), à la place de leur
    // première étape. Dans l'ordre de la lecture ; une étape qui arrive fait
    // grossir sa pastille — ou sa pile — de rien à sa taille (stopPopScale).
    //
    // Lecture plus lisible (`play_*` du thème) : l'étape en cours entourée
    // d'un anneau qui pulse, les étapes passées atténuées, un aperçu pâle des
    // étapes à venir de la journée — ces deux derniers en rendu
    // « pastilles » : en points du thème, les points WebGL apparaissent
    // seuls.
    let playStopsDrawn = emptyPlayStops();

    // Piles d'étapes atteintes de l'image précédente : `projected` est refait
    // à chaque applyTimeline (invalidation), `fp` empreint les indices
    // atteints.
    let playStacksMemo = { projected: null, fp: -1, resKey: 0, distance: 0, stacks: [] };

    function emptyPlayStops() {
        return {
            drawn: 0, popping: 0, headColor: null, piles: [], current: null, ring: null, dimmed: 0, preview: 0, places: 0,
            favorites: 0, bursts: 0,
        };
    }

    function reset() {
        playStopsDrawn = emptyPlayStops();
    }

    // État de l'image en cours : trajet, tête, journée et pictogramme à
    // `currentQ`. Quatre dessins (trait, étapes, lieux, tête) les demandent
    // chacun — calculés une fois par image au lieu de relire la chronologie.
    let frameMemo = { timeline: null, q: NaN, trail: null, head: null, day: 0, mode: 'walk' };

    function frame() {
        const { timeline, currentQ } = S();
        if (frameMemo.timeline !== timeline || frameMemo.q !== currentQ) {
            let trail = { done: 0, current: null };
            let head = null;
            let day = 0;
            let mode = 'walk';
            if (timeline) {
                trail = trailAt(timeline, currentQ);
                head = headAt(timeline, currentQ);
                mode = headModeAt(timeline, currentQ);
                if (trail.current) day = timeline.stops[timeline.legs[trail.current.leg].to]?.day ?? 0;
                else {
                    // Journée de la dernière étape atteinte (reachedIndex :
                    // dernière étape à q ≤ currentQ, comme l'ancien balayage).
                    const reached = reachedIndex(timeline, currentQ);
                    if (reached >= 0) day = timeline.stops[reached].day;
                }
            }
            frameMemo = { timeline, q: currentQ, trail, head, day, mode };
        }
        return frameMemo;
    }

    function drawPlayStops(context, resolution, extent = null) {
        const { timeline, currentQ, projected } = S();
        const style = paints.stopStyle();
        const labels = paints.currentStopLabels();
        const themed = style.render === deps.renderTheme;
        const past = themed ? 'normal' : style.play_past;
        const day = frame().day;
        const point = scratchPoint;
        playStopsDrawn = { ...playStopsDrawn, current: null, ring: null, dimmed: 0, preview: 0 };
        if (!themed && style.play_preview) drawPlayPreview(context, day, labels);
        const reached = [];
        const favIdx = [];
        let fp = 0;
        // Quantas croissants : reachedIndex donne la dernière étape arrivée,
        // le balayage s'arrête là au lieu de lire toute la chronologie.
        const last = reachedIndex(timeline, currentQ);
        for (let i = 0; i <= last; i++) {
            const stop = timeline.stops[i];
            if (isCountedStop(stop)) {
                reached.push(i);
                if (stop.favorite) favIdx.push(i);
                // Décalage d'un : sinon la première étape atteinte (i = 0)
                // laisserait l'empreinte à 0, comme « aucune étape ».
                fp = ((fp * 31) + (i + 1)) | 0;
            }
        }
        // Regroupement mémorisé : il ne dépend que des étapes atteintes
        // (empreinte), de la résolution et de la distance de pile — une image
        // sans nouvelle étape ni zoom le réutilise tel quel. La résolution
        // est lue par paliers de ~3 % : en zoom continu (caméra qui suit),
        // elle change à chaque image sans que les piles ne bougent
        // visuellement — le regroupement serait sinon refait à chacune.
        const distance = style.size * STACK_DISTANCE;
        const resKey = Math.round(Math.log(resolution) * 32);
        if (playStacksMemo.projected !== projected || playStacksMemo.fp !== fp
            || playStacksMemo.resKey !== resKey || playStacksMemo.distance !== distance) {
            playStacksMemo = {
                projected, fp, resKey, distance,
                stacks: stackStops(reached.map((i) => deps.stackItem(projected[i], timeline.stops[i].key, resolution)), distance),
            };
        }
        const stacks = playStacksMemo.stacks;
        // Piles hors écran : pastille, anneau et numéro ne sont pas peints
        // (marge = taille + décalage du numéro + anneau). Les comptes du
        // relevé restent ceux des étapes atteintes.
        const margin = extent ? (style.size + 48) * resolution : 0;
        const inExtent = extent
            ? ([x, y]) => x >= extent[0] - margin && x <= extent[2] + margin
                && y >= extent[1] - margin && y <= extent[3] + margin
            : () => true;
        let drawn = 0;
        let popping = 0;
        let dimmed = 0;
        let favorites = 0;
        const piles = [];
        for (const { rep, members } of stacks) {
            const head = timeline.stops[reached[rep]];
            const newest = timeline.stops[reached[members[members.length - 1]]];
            const pile = members.length > 1;
            const phases = members.map((m) => playPhase(timeline.stops[reached[m]], currentQ, { day, past }));
            const currentIndex = phases.indexOf('current');
            const dim = phases.every((phase) => phase === 'past');
            const label = pile
                ? stackLabel(members.map((m) => labels.get(timeline.stops[reached[m]].key) || ''))
                : labels.get(head.key) || '';
            if (pile) piles.push(label);
            const scale = reducedMotion() ? 1 : stopPopScale(currentQ - newest.q);
            if (scale <= 0.01) continue;
            if (scale !== 1) popping++;
            if (dim) dimmed++;
            if (currentIndex >= 0) {
                const current = timeline.stops[reached[members[currentIndex]]];
                playStopsDrawn.current = current.key;
                if (style.play_current) playStopsDrawn.ring = current.key;
            }
            const hasFavorite = style.favorite_mark
                && members.some((m) => timeline.stops[reached[m]].favorite);
            if (hasFavorite) favorites++;
            const coords = projected[reached[rep]];
            if (!inExtent(coords)) continue;
            const paint = paints.paintOfStop(head);
            point.setCoordinates(coords);
            if (currentIndex >= 0 && style.play_current) {
                const current = timeline.stops[reached[members[currentIndex]]];
                const radius = themed ? paints.themePointRadius() + 2 : (pile ? style.size + 2 : style.size);
                drawCurrentRing(context, point, paint.fill, radius * scale, currentQ - current.q);
            }
            const styles = themed ? [paints.themeNumberStyle(paint, label)]
                : [...(pile ? [paints.pileShadowStyle(paint)] : []), paints.numberedStyleFor(paint, label, { pile })];
            if (hasFavorite) styles.push(paints.favoriteMarkStyle(pile));
            for (const s of styles) {
                if (!s) continue;
                const shown = dim ? dimmedStyle(s, DIM_PAST) : s;
                context.setStyle(scale === 1 ? shown : scaledStyle(shown, scale));
                context.drawGeometry(point);
            }
            drawn += members.length;
        }
        const bursts = style.favorite_burst && !reducedMotion() ? drawFavoriteBursts(context, favIdx) : 0;
        playStopsDrawn = { ...playStopsDrawn, drawn, popping, piles, dimmed, favorites, bursts };
    }

    // Effet à l'arrivée sur une étape où un PF a été donné (favoriteBurst :
    // cœurs qui s'envolent), par-dessus les pastilles. Renvoie le nombre
    // d'effets en cours. `favIdx` : indexes atteints déjà filtrés par
    // drawPlayStops (un balayage de toute la chronologie de moins par image).
    // Un seul style muté en place : scale, décalage et alpha bougent à
    // chaque image, une allocation par cœur serait sinon faite à chacune.
    const heartText = new ol.style.Text({
        text: HEART,
        font: '16px system-ui, sans-serif',
        fill: new ol.style.Fill({ color: FAVORITE_COLOR }),
        stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }),
    });
    const heartStyle = new ol.style.Style({ text: heartText });
    const heartFill = heartText.getFill();
    const heartStroke = heartText.getStroke();

    function drawFavoriteBursts(context, favIdx) {
        const { timeline, currentQ, projected } = S();
        const radius = paints.favoriteBaseRadius(false);
        const point = scratchPoint;
        let bursts = 0;
        for (const i of favIdx) {
            const stop = timeline.stops[i];
            const hearts = favoriteBurst(currentQ - stop.q, radius);
            if (!hearts.length) continue;
            bursts++;
            point.setCoordinates(projected[i]);
            for (const heart of hearts) {
                heartText.setScale(heart.scale);
                heartText.setOffsetX(heart.dx);
                heartText.setOffsetY(heart.dy);
                heartFill.setColor(hexToRgba(FAVORITE_COLOR, heart.alpha));
                heartStroke.setColor(`rgba(255, 255, 255, ${heart.alpha.toFixed(3)})`);
                context.setStyle(heartStyle);
                context.drawGeometry(point);
            }
        }
        return bursts;
    }

    // Anneau de l'étape en cours (currentRingRadius : pulse d'une seconde
    // d'écran), de la couleur de l'étape, sur un voile blanc léger.
    // Anneau de l'étape en cours : le rayon pulse à chaque image — le style
    // est mémorisé par palier de quart de pixel au lieu d'être reallocé.
    const ringStyles = new Map();

    function drawCurrentRing(context, point, color, radius, elapsedQ) {
        // Mouvement réduit : anneau fixe à mi-amplitude plutôt que pulsé.
        const elapsed = reducedMotion() ? CURRENT_RING_PERIOD / 4 : elapsedQ;
        const r = Math.round(currentRingRadius(radius, elapsed) * 4);
        const key = `${color}|${r}`;
        let style = ringStyles.get(key);
        if (!style) {
            style = new ol.style.Style({
                image: new ol.style.Circle({
                    radius: r / 4,
                    fill: new ol.style.Fill({ color: 'rgba(255, 255, 255, 0.35)' }),
                    stroke: new ol.style.Stroke({ color, width: 3 }),
                }),
            });
            ringStyles.set(key, style);
        }
        context.setStyle(style);
        context.drawGeometry(point);
    }

    const dimmedStyles = new WeakMap();

    function dimmedStyle(style, { opacity, scale }) {
        let variants = dimmedStyles.get(style);
        if (!variants) dimmedStyles.set(style, (variants = new Map()));
        const key = `${opacity}:${scale}`;
        if (!variants.has(key)) {
            const copy = style.clone();
            const image = copy.getImage();
            if (image) {
                image.setOpacity(opacity);
                image.setScale(scale);
                const shift = image.getDisplacement();
                if (shift[0] || shift[1]) image.setDisplacement([shift[0] * scale, shift[1] * scale]);
            }
            const text = copy.getText();
            if (text) {
                text.setScale(scale);
                text.setOffsetX(text.getOffsetX() * scale);
                text.setOffsetY(text.getOffsetY() * scale);
                const fill = text.getFill()?.getColor();
                if (typeof fill === 'string' && fill.startsWith('#')) text.setFill(new ol.style.Fill({ color: hexToRgba(fill, opacity) }));
            }
            variants.set(key, copy);
        }
        return variants.get(key);
    }

    // Aperçu de la suite : étapes comptées de la journée pas encore
    // atteintes, pâles, reliées depuis le géocacheur par un fil pointillé
    // dans l'ordre du parcours (la nuit : celles du lendemain).
    const previewGeom = new ol.geom.LineString([]);

    function drawPlayPreview(context, day, labels) {
        const { timeline, currentQ, projected } = S();
        const upcoming = [];
        // Quantas et journées croissants : les étapes à venir de la journée
        // forment un bloc contigu juste après la dernière atteinte (un lieu
        // posé dans la nuit peut porter la journée d'avant : on le saute).
        for (let i = reachedIndex(timeline, currentQ) + 1; i < timeline.stops.length; i++) {
            const stop = timeline.stops[i];
            if (stop.day > day) break;
            if (isCountedStop(stop) && stop.day === day) upcoming.push(i);
        }
        if (!upcoming.length) return;
        const head = frame().head;
        const coords = upcoming.map((i) => projected[i]);
        if (head) coords.unshift(ol.proj.fromLonLat([head.lon, head.lat]));
        const width = paints.stopStyle().trail_width;
        context.setStyle(paints.cachedStyle(`preview:line:${trailOptions(day).solid}`, () => new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: hexToRgba(trailOptions(day).solid, 0.5),
                width: Math.max(1, width * 0.5),
                lineDash: [3, 5],
            }),
        })));
        if (coords.length > 1) {
            previewGeom.setCoordinates(coords);
            context.drawGeometry(previewGeom);
        }
        const point = scratchPoint;
        for (const i of upcoming) {
            const stop = timeline.stops[i];
            context.setStyle(dimmedStyle(paints.numberedStyleFor(paints.paintOfStop(stop), labels.get(stop.key) || ''), DIM_PREVIEW));
            point.setCoordinates(projected[i]);
            context.drawGeometry(point);
        }
        playStopsDrawn.preview = upcoming.length;
    }

    // Lieux et bases pendant la lecture, avec leur pastille de catégorie, par
    // dessus la nuit : un lieu apparaît à son arrivée, une base à sa première
    // journée (une seule fois, quelles que soient ses occurrences), les deux
    // en grossissant. Un lieu où se trouve le géocacheur est entouré, un lieu
    // quitté suit le réglage des étapes passées.
    let baseFirstMemo = { timeline: null, firstQ: new Map() };

    function baseFirstQ() {
        const { timeline } = S();
        if (baseFirstMemo.timeline !== timeline) {
            const firstQ = new Map();
            for (const stop of timeline?.stops || []) {
                if (stop.kind === KIND_BASE && !(firstQ.get(stop.placeId) <= stop.q)) firstQ.set(stop.placeId, stop.q);
            }
            baseFirstMemo = { timeline, firstQ };
        }
        return baseFirstMemo.firstQ;
    }

    function drawPlayPlaces(context) {
        const { timeline, currentQ, projected } = S();
        const style = paints.stopStyle();
        const past = style.render === deps.renderTheme ? 'normal' : style.play_past;
        const day = frame().day;
        const firstQ = baseFirstQ();
        const bases = new Set();
        const point = scratchPoint;
        let places = 0;
        // Seules les étapes arrivées dessinent un lieu ou une base (une base
        // n'apparaît qu'à sa première occurrence, dont le quanta est atteint
        // aussi) : le balayage s'arrête à la dernière atteinte.
        const last = reachedIndex(timeline, currentQ);
        for (let i = 0; i <= last; i++) {
            const stop = timeline.stops[i];
            if (stop.kind !== KIND_BASE && stop.kind !== KIND_PLACE) continue;
            const base = stop.kind === KIND_BASE;
            if (base && bases.has(stop.placeId)) continue;
            const from = base ? (firstQ.get(stop.placeId) ?? stop.q) : stop.q;
            if (from > currentQ) continue;
            if (base) bases.add(stop.placeId);
            const scale = reducedMotion() ? 1 : stopPopScale(currentQ - from);
            if (scale <= 0.01) continue;
            point.setCoordinates(projected[i]);
            const phase = base ? 'normal' : playPhase(stop, currentQ, { day, past });
            if (phase === 'current') {
                playStopsDrawn.current = stop.key;
                if (style.play_current) {
                    playStopsDrawn.ring = stop.key;
                    drawCurrentRing(context, point, paints.kindColor(stop.kind), style.size * scale, currentQ - stop.q);
                }
            }
            const s = paints.placeStyle(stop.kind, paints.stopIconClass(stop.category, stop.icon));
            const shown = phase === 'past' ? dimmedStyle(s, DIM_PAST) : s;
            context.setStyle(scale === 1 ? shown : scaledStyle(shown, scale));
            context.drawGeometry(point);
            places++;
        }
        playStopsDrawn.places = places;
    }

    // Copie d'un style à l'échelle `scale`, décalages compris (numéro posé à
    // côté d'un point du thème).
    function scaledStyle(style, scale) {
        const copy = style.clone();
        const image = copy.getImage();
        if (image) {
            image.setScale(scale);
            const shift = image.getDisplacement();
            if (shift[0] || shift[1]) image.setDisplacement([shift[0] * scale, shift[1] * scale]);
        }
        const text = copy.getText();
        if (text) {
            text.setScale(scale);
            text.setOffsetX(text.getOffsetX() * scale);
            text.setOffsetY(text.getOffsetY() * scale);
        }
        return copy;
    }

    function headGlyph(mode) {
        const className = HEAD_ICON_CLASSES[mode];
        return className ? deps.tablerGlyph(className) : null;
    }

    function drawHeadPictogram(ctx, x, y, ratio, color, glyph) {
        const radius = 14 * ratio;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 6 * ratio;
        ctx.shadowOffsetY = 1.5 * ratio;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 2.5 * ratio;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.font = `${Math.round(17 * ratio)}px "tabler-icons"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(glyph, x, y + 0.5 * ratio);
        ctx.restore();
    }

    let pageFont = null;
    function pageFontFamily() {
        if (!pageFont) pageFont = getComputedStyle(document.body).fontFamily || 'sans-serif';
        return pageFont;
    }

    // Carton « Jour 2 · dimanche 13 juillet 2025 » d'un parcours de plusieurs
    // journées, au tiers haut de la carte.
    function dayCardText(dayIndex) {
        const { timeline } = S();
        const day = timeline?.days?.[dayIndex];
        if (!day) return null;
        const stats = dayStats(timeline, dayIndex);
        // Ellipse : « n jours plus tard » devant la date quand des journées
        // calendaires ont été sautées ; bilan en troisième ligne.
        const date = formatDay(day.date);
        const subtitle = stats && stats.gapDays > 1
            ? t('${n} jours plus tard · ${date}', { n: stats.gapDays, date })
            : date;
        const parts = [];
        if (stats?.counted) parts.push(stopsCountText(stats.counted));
        if (stats?.km >= 0.05) parts.push(formatKm(stats.km));
        return {
            title: t('Jour ${n}', { n: day.dayNumber }),
            subtitle,
            detail: parts.join(' · ') || null,
        };
    }

    // Carton d'ouverture, sur la vue d'ensemble en début de lecture : nom du
    // parcours, ses dates (« 13 juil. 2025 → 20 juil. 2025 ») et son bilan —
    // le miroir du carton final.
    function openCardText() {
        const { listing, selectedId, timeline } = S();
        const item = listing.find((p) => p.id === selectedId);
        const days = timeline?.days || [];
        const counted = timeline?.stops?.filter(isCountedStop).length || 0;
        const parts = [stopsCountText(counted), formatKm(timeline?.totalKm || 0)];
        if (days.length > 1) parts.push(t('${n} journées', { n: days.length }));
        return {
            title: item?.name || t('Le parcours'),
            subtitle: days.length ? formatRange(days[0].date, days[days.length - 1].date) : '',
            detail: parts.join(' · '),
        };
    }

    // Carton final de synthèse : nom du parcours, puis « 5 étapes · 7,9 km »
    // et les journées quand il y en a plusieurs.
    function endCardText() {
        const { listing, selectedId, timeline } = S();
        const item = listing.find((p) => p.id === selectedId);
        const counted = timeline?.stops?.filter(isCountedStop).length || 0;
        const parts = [stopsCountText(counted), formatKm(timeline?.totalKm || 0)];
        if ((timeline?.days?.length || 0) > 1) parts.push(t('${n} journées', { n: timeline.days.length }));
        return { title: item?.name || t('Fin du parcours'), subtitle: parts.join(' · ') };
    }

    // Photos favorites des cartons (`cardPhotos` de parcours_photo_layout.mjs),
    // recalculées quand la chronologie ou les photos changent.
    let cardMemo = { timeline: null, photos: null, value: null };
    let cardPhotosDrawn = [];     // ids peints sur les cartons à la dernière image (relevé e2e)

    function currentCardPhotos() {
        const { timeline, inputs } = S();
        if (!cardMemo.value || cardMemo.timeline !== timeline || cardMemo.photos !== inputs?.photos) {
            cardMemo = { timeline, photos: inputs?.photos, value: pickCardPhotos(timeline, favoritePhotoIds(inputs?.photos)) };
        }
        return cardMemo.value;
    }

    // Ids des photos des cartons — seulement quand les cartons sont montrés.
    function cardPhotoIds() {
        if (!S().playback?.day_cards) return [];
        const c = currentCardPhotos();
        return [...new Set([c.open, ...c.days, ...c.end].filter((id) => id != null))];
    }

    // Image prête d'une photo : la pleine taille, sinon la vignette.
    function readyPhotoImage(id) {
        const full = photoImages.get(id);
        if (imageReady(full)) return full;
        const thumb = photoThumbs.get(id);
        return imageReady(thumb) ? thumb : null;
    }

    // Photos d'un carton, au-dessus du texte : une photo à son cadrage, ou une
    // rangée de vignettes carrées (mosaïque de fin), en carte postale. Une
    // photo encore en chargement n'est pas dessinée. → { tiles, width,
    // height, gap } en px du canevas.
    function cardPhotoTiles(ctx, ratio, ids, mosaic) {
        const W = ctx.canvas.width;
        const H = ctx.canvas.height;
        // Entre deux vignettes : leurs deux marges blanches (6 px) et un jour.
        const gap = 22 * ratio;
        const tiles = [];
        for (const id of ids) {
            const photo = photoById(id);
            const img = photo ? readyPhotoImage(id) : null;
            if (!img) continue;
            const natural = { width: img.naturalWidth, height: img.naturalHeight };
            const rect = photoCropRect(natural, mosaic ? { ...photo, aspect: '1:1' } : photo);
            tiles.push({ id, img, rect, aspect: rect.width / rect.height });
        }
        if (!tiles.length) return { tiles, width: 0, height: 0 };
        if (mosaic) {
            const side = Math.min(H * 0.2, (W * 0.86 - gap * (tiles.length - 1)) / tiles.length);
            for (const tile of tiles) {
                tile.w = side;
                tile.h = side;
            }
        } else {
            const tile = tiles[0];
            tiles.length = 1;
            tile.h = Math.min(H * 0.32, (W * 0.5) / tile.aspect);
            tile.w = tile.h * tile.aspect;
        }
        const width = tiles.reduce((sum, tile) => sum + tile.w, 0) + gap * (tiles.length - 1);
        const height = Math.max(...tiles.map((tile) => tile.h));
        return { tiles, width, height, gap };
    }

    function paintCardTiles(ctx, ratio, layout, top) {
        const border = 6 * ratio;
        let x = ctx.canvas.width / 2 - layout.width / 2;
        for (const tile of layout.tiles) {
            const y = top + (layout.height - tile.h) / 2;
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
            ctx.shadowBlur = 14 * ratio;
            ctx.shadowOffsetY = 4 * ratio;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - border, y - border, tile.w + border * 2, tile.h + border * 2);
            ctx.restore();
            ctx.drawImage(tile.img, tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height, x, y, tile.w, tile.h);
            cardPhotosDrawn.push(tile.id);
            x += tile.w + layout.gap;
        }
    }

    // Dessin commun d'un carton {title, subtitle} centré au tiers haut —
    // précédé, s'il y en a, de ses photos favorites (`photoIds` ; `mosaic` :
    // vignettes carrées en rangée).
    function drawCard(ctx, ratio, text, alpha, photoIds = [], mosaic = false) {
        const font = pageFontFamily();
        const titleSize = 30 * ratio;
        const subtitleSize = 17 * ratio;
        const detailSize = 13 * ratio;
        const gap = 8 * ratio;
        const padX = 28 * ratio;
        const padY = 18 * ratio;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `700 ${titleSize}px ${font}`;
        const titleW = ctx.measureText(text.title).width;
        ctx.font = `400 ${subtitleSize}px ${font}`;
        const subtitleW = ctx.measureText(text.subtitle).width;
        let detailW = 0;
        if (text.detail) {
            ctx.font = `400 ${detailSize}px ${font}`;
            detailW = ctx.measureText(text.detail).width;
        }
        const boxW = Math.max(titleW, subtitleW, detailW) + padX * 2;
        const boxH = titleSize + gap + subtitleSize
            + (text.detail ? gap + detailSize : 0) + padY * 2;
        const cx = ctx.canvas.width / 2;
        let top = ctx.canvas.height * 0.36 - boxH / 2;
        const photos = photoIds.length ? cardPhotoTiles(ctx, ratio, photoIds, mosaic) : null;
        if (photos?.tiles.length) {
            // Photos puis texte, le tout centré un peu plus bas que le texte seul.
            const between = 18 * ratio;
            const groupH = photos.height + 12 * ratio + between + boxH;
            const groupTop = Math.max(12 * ratio, ctx.canvas.height * 0.42 - groupH / 2);
            paintCardTiles(ctx, ratio, photos, groupTop + 6 * ratio);
            top = groupTop + photos.height + 12 * ratio + between;
        }
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - boxW / 2, top, boxW, boxH, 14 * ratio);
        else ctx.rect(cx - boxW / 2, top, boxW, boxH);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `700 ${titleSize}px ${font}`;
        ctx.fillText(text.title, cx, top + padY);
        ctx.font = `400 ${subtitleSize}px ${font}`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillText(text.subtitle, cx, top + padY + titleSize + gap);
        if (text.detail) {
            ctx.font = `400 ${detailSize}px ${font}`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.fillText(text.detail, cx, top + padY + titleSize + gap + subtitleSize + gap);
        }
        ctx.restore();
    }

    function drawDayCard(ctx, ratio) {
        const { playback, timeline, currentQ, msPerDay } = S();
        const card = playback.day_cards ? dayCardAt(timeline, currentQ, sceneTimingOptions(msPerDay)) : null;
        const text = card && card.alpha > 0 ? dayCardText(card.day) : null;
        const photo = text ? currentCardPhotos().days[card.day] : null;
        if (text) drawCard(ctx, ratio, text, card.alpha, photo != null ? [photo] : []);
    }

    function drawOpenCard(ctx, ratio) {
        const { playback, timeline, currentQ, msPerDay } = S();
        const card = playback.day_cards ? openCardAt(timeline, currentQ, sceneTimingOptions(msPerDay)) : null;
        if (!card || !(card.alpha > 0)) return;
        const photo = currentCardPhotos().open;
        drawCard(ctx, ratio, openCardText(), card.alpha, photo != null ? [photo] : []);
    }

    function drawEndCard(ctx, ratio) {
        const { playback, timeline, currentQ, msPerDay } = S();
        const card = playback.day_cards ? endCardAt(timeline, currentQ, sceneTimingOptions(msPerDay)) : null;
        if (card && card.alpha > 0) drawCard(ctx, ratio, endCardText(), card.alpha, currentCardPhotos().end, true);
    }

    // Crédits des itinéraires (CGU des fournisseurs), peints en bas à droite
    // de la vidéo (la vidéo ne compose que les canevas de la carte) ; à
    // l'écran ils sont dans l'attribution — voir syncAttribution.
    function drawRouteCredits(ctx, ratio) {
        if (!deps.isRecording()) return;
        const text = deps.routeCredit();
        if (!text) return;
        ctx.save();
        ctx.font = `${Math.round(11 * ratio)}px ${pageFontFamily()}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3 * ratio;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        const x = ctx.canvas.width - 8 * ratio;
        const y = ctx.canvas.height - 6 * ratio;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    // --- Photos de la lecture --------------------------------------------------

    // Image chargée de chaque photo, pour la carte postale de la lecture et
    // de la vidéo : même origine que la page, le canevas reste exportable.
    const photoImages = new Map();   // id → HTMLImageElement
    const photoThumbs = new Map();   // id → HTMLImageElement (vignettes laissées sur la carte)

    function photoUrl(photo, thumb = false) {
        return `${CONFIG.BASE_URL}/api/parcours/${S().selectedId}/photos/${photo.id}/${thumb ? 'thumb' : 'file'}`;
    }

    // Index des photos par id, refait quand la liste est remplacée (un
    // changement de légende ou de cadrage remplace le tableau) : appelé
    // plusieurs fois par carte et par image, une recherche linéaire coûtait
    // ~7 ms par image avec 300 vignettes sur la carte.
    let photoIndex = { photos: null, byId: new Map() };
    function photoById(id) {
        const photos = S().inputs?.photos || null;
        if (photoIndex.photos !== photos) {
            photoIndex = { photos, byId: new Map((photos || []).map((photo) => [photo.id, photo])) };
        }
        return photoIndex.byId.get(id) || null;
    }

    function loadPhotoImage(id, thumb) {
        const cache = thumb ? photoThumbs : photoImages;
        if (cache.has(id)) return;
        const img = new Image();
        img.decoding = 'async';
        // En pause ou au repos, la prochaine image peinte attendrait un
        // geste : invalider la couche pour que la carte apparaisse dès
        // l'image reçue.
        img.onload = () => playHeadLayer?.changed();
        img.src = photoUrl({ id }, thumb);
        cache.set(id, img);
    }

    // Pleine taille préchargée dans une fenêtre autour de la position de
    // lecture : assez d'avance pour finir le téléchargement avant que la
    // carte n'apparaisse, et une marge derrière pour l'effacement et un
    // petit retour en arrière. Les créneaux lointains ne sont pas chargés —
    // sur un long parcours très illustré, l'ouverture ne télécharge plus des
    // centaines de photos 2048 px.
    const PHOTO_AHEAD_Q = 40;     // ~4 jours devant la tête
    const PHOTO_BEHIND_Q = 8;     // effacement + petit retour en arrière

    // Pleines tailles des créneaux proches de `currentQ`. Relancée à chaque
    // image de la lecture : le `break` sur les créneaux triés la rend quasi
    // gratuite, seuls les entrants dans la fenêtre déclenchent un
    // chargement.
    function ensurePhotosNear() {
        const { timeline, currentQ } = S();
        if (!timeline) return;
        for (const slot of photoSlots(timeline)) {
            if (slot.toQ + PHOTO_FADE_Q < currentQ - PHOTO_BEHIND_Q) continue;
            if (slot.fromQ > currentQ + PHOTO_AHEAD_Q) break;
            loadPhotoImage(slot.photoId, false);
        }
    }

    // Charge (une fois) les photos rattachées : la carte postale n'est
    // dessinée qu'une fois l'image décodée. Les miniatures servent aux
    // vignettes laissées sur la carte : des dizaines à chaque image, réduites
    // depuis 320 px plutôt que depuis la photo entière — elles sont toutes
    // chargées, épinglables à n'importe quel moment de la lecture. Les
    // pleines tailles ne le sont que près de la tête, sauf `all`
    // (enregistrement : toute la chronologie est filmée, tout doit être
    // prêt).
    //
    // Les photos sont celles des créneaux de la chronologie (photoSlots) :
    // étapes ET photos en chemin. Avant le 2026-11-23, seules celles des
    // étapes (`photoByStop`) l'étaient — une photo en chemin n'avait pas de
    // miniature et n'était pas attendue avant un enregistrement : elle
    // pouvait manquer dans la vidéo.
    function preloadPhotos(all = false) {
        const { timeline } = S();
        const ids = new Set(photoSlots(timeline).map((slot) => slot.photoId));
        for (const id of ids) if (photoById(id)) loadPhotoImage(id, true);
        // Photos des cartons : quelques-unes, en pleine taille dès l'ouverture
        // (le carton d'ouverture est la première image de la lecture).
        for (const id of cardPhotoIds()) if (photoById(id)) loadPhotoImage(id, false);
        if (all) {
            for (const id of ids) if (photoById(id)) loadPhotoImage(id, false);
        } else {
            ensurePhotosNear();
        }
    }

    const imageReady = (img) => !!img?.complete && img.naturalWidth > 0;

    // Résolue quand toutes les photos chargées sont décodées (ou en échec),
    // au plus tard après `timeoutMs` — comme `imagesReady` de l'onglet
    // Images : attendue avant la première frame d'un enregistrement pour
    // qu'une photo encore en vol ne manque pas dans la vidéo. Hors de la
    // page, ou sans photo, résout immédiatement.
    function photosReady(timeoutMs = 3000) {
        preloadPhotos(true);
        const pending = [];
        for (const cache of [photoImages, photoThumbs]) {
            for (const img of cache.values()) {
                if (!imageReady(img)) pending.push(img.decode().catch(() => {}));
            }
        }
        if (!pending.length) return Promise.resolve(true);
        return Promise.race([
            Promise.all(pending).then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
    }

    // Photos de la chronologie qui ne figureront pas dans la vidéo : aucune
    // image prête dans les deux caches — échec de chargement, photo absente
    // du parcours, ou encore en vol après le plafond d'attente de
    // l'enregistrement. Affichage « aucune » : elles ne manquent pas,
    // elles sont volontairement masquées.
    function photosMissing() {
        const { timeline, photoDisplay } = S();
        if (!timeline || photoDisplay?.layout === PHOTO_LAYOUT_NONE) return 0;
        const seen = new Set();
        let missing = 0;
        for (const id of [...photoSlots(timeline).map((slot) => slot.photoId), ...cardPhotoIds()]) {
            if (seen.has(id)) continue;
            seen.add(id);
            if (!readyPhotoImage(id)) missing++;
        }
        return missing;
    }

    // Photos de la lecture (lot 9) : mises en page à `currentQ` selon les
    // réglages (parcours_photo_layout.mjs), peintes dans le canevas de la
    // couche de la tête (parcours_photo_draw.mjs), donc filmées. Une photo
    // encore en chargement n'est pas dessinée.
    let lastPhotoCards = [];          // cartes peintes à la dernière image (relevé e2e)
    let lastPhotoView = null;         // taille du canevas de cette image

    function photoLayoutView(event) {
        const { projected } = S();
        const frameState = event.frameState;
        const m = composeTransform(event.inversePixelTransform, frameState.coordinateToPixelTransform);
        const canvas = event.context.canvas;
        return {
            width: canvas.width,
            height: canvas.height,
            ratio: frameState.pixelRatio || 1,
            stopPixel: (i) => {
                const [px, py] = projected[i] || [];
                return Number.isFinite(px) ? [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]] : null;
            },
            // Point d'arrêt d'une photo en chemin.
            pointPixel: (at) => {
                if (!Array.isArray(at)) return null;
                const [px, py] = ol.proj.fromLonLat(at);
                return [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
            },
            aspectOf: (id) => photoAspect(photoById(id)),
            panoramaOf: (id) => isPanorama(photoById(id)),
            captionOf: memoCaption,
            sideMemo,
        };
    }

    // Côté `auto` de chaque pile montrée, gardé d'une image à l'autre
    // (photoFrameAt).
    const sideMemo = { timeline: null, sides: new Map() };

    // Légendes composées, par créneau : avec les vignettes laissées sur la
    // carte ou la bande, toutes les photos passées sont remises en page à
    // chaque image — composer chaque légende (dates localisées comprises)
    // coûtait ~10 ms par image pour 300 photos. Refaites quand la
    // chronologie, les photos, les appareils, le gabarit ou le format des
    // heures changent.
    let captionMemo = { key: null, texts: new Map() };
    function memoCaption(slot) {
        const { photoDisplay, timeline, inputs, playback } = S();
        const key = [timeline, inputs?.photos, inputs?.cameras, photoDisplay.caption, playback.hours];
        if (!captionMemo.key || key.some((value, i) => value !== captionMemo.key[i])) {
            captionMemo = { key, texts: new Map() };
        }
        let text = captionMemo.texts.get(slot.order);
        if (text === undefined) {
            text = photoCaptionFor(slot);
            captionMemo.texts.set(slot.order, text);
        }
        return text;
    }

    // Légende d'une photo selon le gabarit des réglages. L'heure est celle de
    // la photo quand elle est de confiance (téléphone, appareil recalé),
    // sinon celle de l'étape — dans le format choisi pour {heure}.
    function photoCaptionFor(slot) {
        const { photoDisplay, timeline, inputs, playback } = S();
        if (!photoDisplay.caption || !timeline) return '';
        const photo = photoById(slot.photoId);
        // Photo en chemin : pas d'étape ({etape} vide), sa journée.
        const stop = slot.route ? null : timeline.stops[slot.stop];
        const day = timeline.days[slot.route ? slot.day : stop?.day];
        const offsets = cameraOffsets(inputs?.cameras);
        const clockValue = photo && photoTimeTrusted(photo) ? photoClock(photo, offsets) : null;
        const heure = clockValue
            ? formatClock(clockValue.minutes, false, playback.hours, slotLabels())
            : formatClock(stop?.arrivalMin, stop?.confidence !== CONFIDENCE_ANCHORED, playback.hours, slotLabels());
        return photoCaptionText(photoDisplay.caption, {
            legende: photo?.caption || '',
            etape: stop ? stopLabel(stop) : '',
            heure,
            jour: day ? String(day.dayNumber) : '',
            date: day ? formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '',
        });
    }

    function drawPhotoCards(event) {
        const { timeline, currentQ, photoDisplay } = S();
        lastPhotoCards = [];
        if (!timeline) return;
        ensurePhotosNear();
        const view = photoLayoutView(event);
        lastPhotoView = { width: view.width, height: view.height, ratio: view.ratio };
        // Mouvement réduit : entrée au fondu, jamais de Ken Burns.
        const display = reducedMotion() ? { ...photoDisplay, effect: 'fade', ken_burns: false } : photoDisplay;
        const { cards } = photoFrameAt(timeline, currentQ, display, view);
        const ctx = event.context;
        const font = pageFontFamily();
        for (const card of cards) {
            const thumb = card.pinned ? photoThumbs.get(card.photoId) : null;
            const img = imageReady(thumb) ? thumb : photoImages.get(card.photoId);
            if (!imageReady(img)) continue;
            drawPhotoLeader(ctx, card, view.ratio);
            drawPhotoCard(ctx, card, img, photoById(card.photoId), { font, ratio: view.ratio });
            lastPhotoCards.push(card);
        }
    }

    // Aperçu en pause calé sur une photo : la lecture s'ouvre en pause (si
    // elle ne tourne pas) et saute au milieu du premier temps de la photo.
    function previewPhoto(photoId) {
        const { timeline } = S();
        if (!timeline) return false;
        const slot = photoSlots(timeline).find((s) => s.photoId === photoId);
        if (!slot) return false;
        if (deps.previewState() === 'idle' && !deps.startPreview()) return false;
        if (deps.previewState() !== 'paused') return false;
        const q = Math.floor(slot.fromQ + Math.min(5, (slot.toQ - slot.fromQ) / 2));
        const ok = deps.seekTo(dateOfDayIndex(deps.quantumBase, q)) !== false;
        if (ok) ensurePhotosNear();
        return ok;
    }

    function clearImages() {
        photoImages.clear();
        photoThumbs.clear();
    }

    function evictImage(id) {
        photoImages.delete(id);
        photoThumbs.delete(id);
    }

    function imageStats() {
        return {
            loaded: [...photoImages.values()].filter(imageReady).length,
            thumbs: [...photoThumbs.values()].filter(imageReady).length,
        };
    }

    return {
        ensureLayers,
        hideLayers,
        layersVisible,
        trailLayer: () => playTrailLayer,
        reset,
        stopsDrawn: () => playStopsDrawn,
        headGlyph,
        preloadPhotos,
        photosReady,
        photosMissing,
        reducedMotion,
        clearImages,
        evictImage,
        imageStats,
        lastPhotoView: () => lastPhotoView,
        lastPhotoCards: () => lastPhotoCards,
        cardPhotos: () => {
            const c = currentCardPhotos();
            return { open: c.open, days: [...c.days], end: [...c.end] };
        },
        lastCardPhotos: () => cardPhotosDrawn,
        previewPhoto,
        trailOptions,
        dayCardText,
        openCardText,
        endCardText,
    };
}
