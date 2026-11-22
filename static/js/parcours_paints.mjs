// Peintures des étapes du plan et de la lecture : pastilles numérotées
// (couleur par nature ou par journée), lieux et bases (pictogramme), piles et
// éventails, halo de survol, cœur des PF donnés, lignes de journées, points
// du thème (« pastilles » off). Tout est fonction du bloc
// `points.parcours_style` du thème (parcours_style.mjs) et de la
// reconstruction — mémoïsé par objet de réglages (`styleMemo.cache`), refait
// au remplacement du style ou de la reconstruction.
//
// État lu par injection : options de points du thème (`getPoint`),
// reconstruction (`getOrdered`), pile ouverte (`getFan`), sonde de glyphes
// Tabler (`tablerGlyph`, partagée avec la tête de lecture).
import { CATEGORY_ICONS, KIND_ICONS } from './parcours_labels.mjs';
import { KIND_BASE, KIND_PLACE } from './parcours_reconstruct.mjs';
import {
    FAVORITE_COLOR,
    favoriteBadge,
    hexToRgba,
    normalizeParcoursStyle,
    numberFontPx,
    paintTextColor,
    stopNumberLabels,
    stopPaint,
    themeNumberBadge,
    trailColorFor,
} from './parcours_style.mjs';

const HEART = '♥';
const PLAN_LINE_ALPHA = 0.55;
// Éventail d'une pile ouverte : les étapes à leur place autour du centre,
// reliées à lui par un fil, au-dessus du reste du plan (zIndex).
const FAN_Z = 20;
// Rendu « points du thème » : disque invisible qui garde l'étape cliquable.
const HIT_FILL = 'rgba(255, 255, 255, 0.01)';

// deps : { getPoint, getOrdered, getFan, getGcColors, tablerGlyph, renderTheme }
export function createParcoursPaints(deps) {
    // Apparence des étapes et du trait : bloc du thème `points.parcours_style`
    // (parcours_style.mjs). Normalisé une fois par objet de réglages — l'onglet
    // Style et le chargement d'un thème le REMPLACENT, ils ne le modifient pas
    // en place — avec les styles OpenLayers qui en découlent (`cache`), refaits
    // au changement.
    let styleMemo = { raw: undefined, value: null, cache: new Map() };

    function stopStyle() {
        const raw = deps.getPoint()?.parcoursStyle;
        if (styleMemo.raw !== raw || !styleMemo.value) {
            styleMemo = { raw, value: normalizeParcoursStyle(raw), cache: new Map() };
        }
        return styleMemo.value;
    }

    function cachedStyle(key, build) {
        stopStyle();
        if (!styleMemo.cache.has(key)) styleMemo.cache.set(key, build(styleMemo.value));
        return styleMemo.cache.get(key);
    }

    function kindColor(kind) {
        const colors = stopStyle().colors;
        return colors[kind] || colors.find;
    }

    // Rang de la journée de chaque étape (clé) et de chaque date, dans la plage
    // du parcours (jours vides compris) : index de la couleur par journée.
    let dayMemo = { ordered: null, byKey: new Map(), byDate: new Map() };

    function dayIndexes() {
        const ordered = deps.getOrdered();
        if (dayMemo.ordered !== ordered) {
            const byKey = new Map();
            const byDate = new Map();
            (ordered?.days || []).forEach((day, i) => {
                byDate.set(day.date, i);
                for (const stop of day.stops) byKey.set(stop.key, i);
                for (const stop of day.excluded || []) byKey.set(stop.key, i);
            });
            dayMemo = { ordered, byKey, byDate };
        }
        return dayMemo;
    }

    // Peinture d'une étape (`{ key, kind, type }`) selon « Couleur des étapes » :
    // par nature, par journée, par type de cache (couleurs Geocaching).
    function paintOfStop(stop) {
        return stopPaint(stop, stopStyle(), {
            dayIndex: dayIndexes().byKey.get(stop.key) ?? 0,
            typeColors: deps.getGcColors() || null,
        });
    }

    function featurePaint(feature) {
        return paintOfStop({ key: feature.get('key'), kind: feature.get('kind'), type: feature.get('type') });
    }

    // Numéro affiché de chaque étape (clé → texte), selon le réglage « Numéros
    // des étapes » : recalculé quand la reconstruction ou le réglage change.
    let labelMemo = { ordered: null, numbers: null, labels: new Map() };

    function currentStopLabels() {
        const { numbers } = stopStyle();
        const ordered = deps.getOrdered();
        if (labelMemo.ordered !== ordered || labelMemo.numbers !== numbers) {
            labelMemo = { ordered, numbers, labels: stopNumberLabels(ordered, numbers) };
        }
        return labelMemo.labels;
    }

    // Halo dessiné sous l'étape dont la ligne est survolée (et réciproquement).
    // Anneau en pointillés : point provisoire, posé au clic, en attente de la
    // validation du formulaire. Rayon : 6 px de plus que la pastille.
    function haloStyle(draft = false) {
        return cachedStyle(draft ? 'halo:draft' : 'halo', ({ size }) => new ol.style.Style({
            image: new ol.style.Circle({
                radius: size + 6,
                fill: new ol.style.Fill({ color: `rgba(32, 107, 196, ${draft ? 0.10 : 0.18})` }),
                stroke: new ol.style.Stroke({ color: 'rgba(32, 107, 196, 0.9)', width: 2, lineDash: draft ? [5, 4] : undefined }),
            }),
        }));
    }

    // Classe d'icône de catégorie portée par une feature du plan (lieu, base ou
    // brouillon de pose) : « custom » lit l'icône libre.
    function featureIconClass(feature) {
        return stopIconClass(feature.get('category'), feature.get('icon'));
    }

    function stopIconClass(category, icon) {
        if (category === 'custom') return /^ti-[a-z0-9-]+$/.test(icon || '') ? icon : null;
        return CATEGORY_ICONS[category] || null;
    }

    function pointStyle(feature) {
        const kind = feature.get('kind');
        const fan = deps.getFan();
        // Étape cachée dans une pile, ou pile ouverte en éventail : rien (ni
        // dessin ni clic) — la pile ou l'éventail la représente.
        if (feature.get('stacked') || (fan && fan.repKey === feature.get('key'))) return null;
        const pile = (feature.get('stackKeys')?.length || 0) > 1;
        let normal;
        if (kind === KIND_BASE || kind === KIND_PLACE) {
            normal = placeStyle(kind, featureIconClass(feature));
        } else if (stopStyle().render === deps.renderTheme) {
            normal = themeNumberStyle(featurePaint(feature), featureLabel(feature), { hit: true });
        } else {
            normal = pile ? [pileShadowStyle(featurePaint(feature)), numberedStyle(feature)] : numberedStyle(feature);
        }
        if (featureShowsFavorite(feature)) normal = [...(Array.isArray(normal) ? normal : [normal]), favoriteMarkStyle(pile)];
        const styles = Array.isArray(normal) ? normal : [normal];
        return feature.get('hovered') ? [haloStyle(), ...styles] : normal;
    }

    // Cœur d'un PF donné sur une étape du plan (une pile : si l'une de ses
    // étapes en a un), selon « Marquer les PF donnés » du thème.
    function featureShowsFavorite(feature) {
        const kind = feature.get('kind');
        if (kind === KIND_BASE || kind === KIND_PLACE || !stopStyle().favorite_mark) return false;
        return (feature.get('stackKeys')?.length || 0) > 1 ? !!feature.get('stackFavorite') : !!feature.get('favorite');
    }

    // Rayon du marqueur auquel le cœur s'accroche : la pastille (une pile : un
    // peu plus grande), ou le point du thème.
    function favoriteBaseRadius(pile) {
        const style = stopStyle();
        if (style.render === deps.renderTheme) return themePointRadius();
        return pile ? style.size + 2 : style.size;
    }

    // Cœur sur un rond blanc, en haut à gauche de l'étape (favoriteBadge).
    function favoriteMarkStyle(pile = false) {
        const base = favoriteBaseRadius(pile);
        return cachedStyle(`fav:${base}`, () => {
            const { radius, offset } = favoriteBadge(base);
            return new ol.style.Style({
                image: new ol.style.Circle({
                    radius,
                    displacement: offset,
                    fill: new ol.style.Fill({ color: '#ffffff' }),
                    stroke: new ol.style.Stroke({ color: FAVORITE_COLOR, width: 1.5 }),
                }),
                text: new ol.style.Text({
                    text: HEART,
                    font: `${Math.max(8, Math.round(radius * 1.4))}px system-ui, sans-serif`,
                    fill: new ol.style.Fill({ color: FAVORITE_COLOR }),
                    // Texte : y vers le bas, à l'inverse de `displacement`.
                    offsetX: offset[0],
                    offsetY: -offset[1] + 0.5,
                }),
            });
        });
    }

    // Pastille d'une étape comptée, avec son numéro (aucun : pastille seule).
    // Le texte passe en sombre sur une couleur claire ; trois chiffres et plus
    // sont écrits plus petit pour tenir dans la pastille. Pastille creuse (DNF
    // hors couleur par nature) : fond blanc, contour et numéro de la couleur.
    function numberedStyle(feature) {
        return numberedStyleFor(featurePaint(feature), featureLabel(feature),
            { pile: (feature.get('stackKeys')?.length || 0) > 1 });
    }

    // Numéro affiché par une feature d'étape : celui de sa pile si elle en est
    // la tête.
    function featureLabel(feature) {
        return feature.get('stackLabel') || feature.get('label') || '';
    }

    function paintedCircle(paint, radius, width, extra = {}) {
        return new ol.style.Circle({
            radius,
            fill: new ol.style.Fill({ color: paint.hollow ? '#ffffff' : paint.fill }),
            stroke: new ol.style.Stroke({ color: paint.hollow ? paint.fill : '#ffffff', width: paint.hollow ? width + 0.5 : width }),
            ...extra,
        });
    }

    // Pile : pastille un peu plus grande, posée sur une seconde (pileShadowStyle).
    function numberedStyleFor(paint, label, { pile = false } = {}) {
        return cachedStyle(`stop:${paint.fill}:${paint.hollow ? 1 : 0}:${label}:${pile ? 1 : 0}`, ({ size }) => new ol.style.Style({
            image: paintedCircle(paint, pile ? size + 2 : size, 2),
            text: label ? new ol.style.Text({
                text: label,
                font: `600 ${numberFontPx(pile ? size + 2 : size, label)}px system-ui, sans-serif`,
                fill: new ol.style.Fill({ color: paintTextColor(paint) }),
            }) : undefined,
        }));
    }

    // Seconde pastille d'une pile, décalée en haut à droite derrière la
    // première : on voit qu'il y en a plusieurs.
    function pileShadowStyle(paint) {
        return cachedStyle(`pile:${paint.fill}:${paint.hollow ? 1 : 0}`, ({ size }) => new ol.style.Style({
            image: paintedCircle(paint, size + 2, 2, { displacement: [4, 4] }),
        }));
    }

    function fanStopStyle(feature) {
        const base = numberedStyleFor(featurePaint(feature), feature.get('label') || '');
        const style = cachedStyle(`fan:${featurePaint(feature).fill}:${featurePaint(feature).hollow ? 1 : 0}:${feature.get('label') || ''}`,
            () => {
                const copy = base.clone();
                copy.setZIndex(FAN_Z + 2);
                return copy;
            });
        const styles = [style];
        if (stopStyle().favorite_mark && feature.get('favorite')) {
            styles.push(cachedStyle('fan:fav', () => {
                const copy = favoriteMarkStyle(false).clone();
                copy.setZIndex(FAN_Z + 3);
                return copy;
            }));
        }
        return feature.get('hovered') ? [haloStyle(), ...styles] : styles;
    }

    function fanLineStyle() {
        return cachedStyle('fan:line', () => new ol.style.Style({
            stroke: new ol.style.Stroke({ color: 'rgba(33, 37, 41, 0.55)', width: 1.5 }),
            zIndex: FAN_Z,
        }));
    }

    function fanCenterStyle() {
        return cachedStyle('fan:center', () => new ol.style.Style({
            image: new ol.style.Circle({
                radius: 4,
                fill: new ol.style.Fill({ color: 'rgba(33, 37, 41, 0.75)' }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 }),
            }),
            zIndex: FAN_Z + 1,
        }));
    }

    // Rayon approché du point du thème (centre + contour), pour poser le numéro
    // à côté.
    function themePointRadius() {
        const point = deps.getPoint() || {};
        const center = Math.max(1, parseInt(point.center?.size, 10) || 3);
        const border = point.border?.mode === 'none' ? 0 : Math.max(0, parseInt(point.border?.size, 10) || 0) / 5;
        return center + border;
    }

    // Rendu « points du thème » : le point est celui du thème (couche WebGL) ;
    // le plan n'y ajoute que le numéro, dans une petite pastille en haut à
    // droite (rien sans numéro). Au repos (`hit`), un disque invisible de la
    // taille d'une pastille garde l'étape survolable et cliquable.
    function themeNumberStyle(paint, label, { hit = false } = {}) {
        const themeRadius = themePointRadius();
        const key = `theme:${paint.fill}:${paint.hollow ? 1 : 0}:${label}:${hit ? 1 : 0}:${themeRadius}`;
        return cachedStyle(key, ({ size }) => {
            const styles = [];
            if (hit) {
                styles.push(new ol.style.Style({
                    image: new ol.style.Circle({ radius: Math.max(size, themeRadius), fill: new ol.style.Fill({ color: HIT_FILL }) }),
                }));
            }
            if (label) {
                const { radius, offset } = themeNumberBadge(size, themeRadius);
                styles.push(new ol.style.Style({
                    image: paintedCircle(paint, radius, 1.5, { displacement: offset }),
                    text: new ol.style.Text({
                        text: label,
                        font: `600 ${numberFontPx(radius, label)}px system-ui, sans-serif`,
                        fill: new ol.style.Fill({ color: paintTextColor(paint) }),
                        // Texte : y vers le bas, à l'inverse de `displacement`.
                        offsetX: offset[0],
                        offsetY: -offset[1],
                    }),
                }));
            }
            return hit ? styles : (styles[0] || null);
        });
    }

    // Lieu : rond ; base : carré — à la couleur du type (thème, violet et
    // anthracite par défaut), avec au centre, en blanc, le pictogramme de la
    // catégorie (à défaut, celui du type : drapeau, maison). Un seul symbole,
    // lisible d'un coup d'œil. Sans la police chargée : la forme seule (la clé
    // change quand elle arrive). Communs au plan et à la lecture, à l'échelle
    // des pastilles.
    function placeStyle(kind, iconClass = null) {
        const glyph = deps.tablerGlyph(iconClass || KIND_ICONS[kind]);
        return cachedStyle(`place:${kind}:${glyph || ''}`, ({ size }) => {
            const fill = new ol.style.Fill({ color: kindColor(kind) });
            const stroke = new ol.style.Stroke({ color: '#ffffff', width: 2 });
            // Carré posé sur sa base : rayon = demi-diagonale, côté ≈ diamètre
            // du rond.
            const image = kind === KIND_BASE
                ? new ol.style.RegularShape({ points: 4, radius: Math.round((size + 2) * 1.35), angle: Math.PI / 4, fill, stroke })
                : new ol.style.Circle({ radius: size + 2, fill, stroke });
            return new ol.style.Style({
                image,
                text: glyph ? new ol.style.Text({
                    text: glyph,
                    font: `${Math.max(11, Math.round(size * 1.45))}px "tabler-icons"`,
                    fill: new ol.style.Fill({ color: '#ffffff' }),
                }) : undefined,
            });
        });
    }

    // Ligne d'une journée au repos : couleur (aux couleurs des journées, celle
    // de la journée) et épaisseur du trait, plus transparente ; pointillés,
    // pleine, ou aucune (null).
    function lineStyle(dayIndex = 0) {
        const color = trailColorFor(stopStyle(), dayIndex);
        return cachedStyle(`line:${color}`, (style) => {
            if (style.plan_line === 'none') return null;
            const width = style.trail_width;
            const dashed = style.plan_line === 'dashed';
            return new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: hexToRgba(color, PLAN_LINE_ALPHA * style.trail_opacity / 100),
                    width,
                    // Bouts ronds : ils allongeraient les tirets.
                    lineCap: dashed ? 'butt' : 'round',
                    lineJoin: 'round',
                    lineDash: dashed ? [2 * width, 2 * width] : undefined,
                }),
            });
        });
    }

    // Traces GPS importées, sous le plan.
    const trackStyle = new ol.style.Style({
        stroke: new ol.style.Stroke({ color: 'rgba(52, 58, 64, 0.45)', width: 2 }),
    });

    return {
        stopStyle, cachedStyle, kindColor, dayIndexes, paintOfStop, featurePaint,
        currentStopLabels, haloStyle, featureIconClass, stopIconClass, pointStyle,
        featureShowsFavorite, favoriteBaseRadius, favoriteMarkStyle,
        numberedStyleFor, numberedStyle, featureLabel,
        pileShadowStyle, fanStopStyle, fanLineStyle, fanCenterStyle,
        themePointRadius, themeNumberStyle, placeStyle, lineStyle, trackStyle,
    };
}
