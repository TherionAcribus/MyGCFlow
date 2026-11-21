// Libellés et formatage de la page Parcours — fonctions pures, sans état
// partagé : parcours_data.js leur passe ce qu'il faut (compte de photos,
// étape trouvée, journées, décalage UTC) au moment de l'appel.
import { t } from './notifications.js';
import {
    CONFIDENCE_ANCHORED,
    KIND_BASE,
    KIND_PLACE,
    LOG_ORDER_REJECTED,
    LOG_ORDER_TRUSTED,
    REASON_BASE,
    REASON_GEO,
    REASON_INSERTED,
    REASON_INTRUDER,
    REASON_LATE_TYPE,
    REASON_LOG_ORDER,
    REASON_MANUAL,
    REASON_PHOTO,
    REASON_PINNED,
    REASON_TIME,
    REASON_TRACK,
    minutesToTime,
} from './parcours_reconstruct.mjs';
import {
    MATCH_GPS,
    MATCH_MANUAL,
    photoClock,
} from './parcours_photos.mjs';
import {
    OFFSET_EVIDENCE,
    OFFSET_MANUAL,
    OFFSET_PHOTOS,
    localClock,
} from './parcours_tracks.mjs';

export const KIND_ICONS = Object.freeze({
    find: 'ti-map-pin', lab: 'ti-flask', dnf: 'ti-mood-sad', [KIND_PLACE]: 'ti-flag', [KIND_BASE]: 'ti-home',
});

export const CATEGORY_ICONS = Object.freeze({
    parking: 'ti-parking', meal: 'ti-tools-kitchen-2', viewpoint: 'ti-binoculars',
    lodging: 'ti-bed', supply: 'ti-bottle',
});

export function pageLocale() {
    return document.documentElement.lang || undefined;
}

// « AAAA-MM-JJ » → date civile affichée (sans fuseau : midi local évite tout
// glissement de jour).
export function formatDay(iso, options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return String(iso);
    return new Date(y, m - 1, d, 12).toLocaleDateString(pageLocale(), options);
}

export function formatRange(start, end) {
    const short = { day: 'numeric', month: 'short', year: 'numeric' };
    return start === end ? formatDay(start, short) : `${formatDay(start, short)} → ${formatDay(end, short)}`;
}

export function formatKm(km) {
    const value = Math.max(0, Number(km) || 0);
    return t('${km} km', {
        km: value.toLocaleString(pageLocale(), { maximumFractionDigits: value < 10 ? 1 : 0 }),
    });
}

export function stopsCountText(n) {
    return n > 1 ? t('${n} étapes', { n }) : t('${n} étape', { n });
}

export function travelModeLabel(mode) {
    switch (mode) {
        case 'bike': return t('à vélo');
        case 'car': return t('en voiture');
        case 'plane': return t('en avion');
        default: return t('à pied');
    }
}

export function suggestionName(item) {
    const range = formatRange(item.start, item.end);
    const name = item.place ? `${item.place}, ${range}` : range;
    return name.slice(0, 80);
}

export function categoryLabel(category) {
    switch (category) {
        case 'parking': return t('parking');
        case 'meal': return t('repas');
        case 'viewpoint': return t('point de vue');
        case 'lodging': return t('hébergement');
        case 'supply': return t('ravitaillement');
        case 'custom': return '';
        default: return '';
    }
}

// Libellé d'option (majuscule) pour les sélecteurs de catégorie.
export function categoryOptionLabel(category) {
    switch (category) {
        case 'parking': return t('Parking');
        case 'meal': return t('Repas / pique-nique');
        case 'viewpoint': return t('Point de vue');
        case 'lodging': return t('Hébergement');
        case 'supply': return t('Ravitaillement / eau');
        case 'custom': return t('Personnalisée…');
        default: return t('Autre');
    }
}

// Classe d'icône d'une étape de lieu ou de base : la catégorie prime sur le
// type (« custom » utilise l'icône choisie, valide ou non).
export function stopCategoryIcon(stop) {
    if (!stop || (stop.kind !== KIND_PLACE && stop.kind !== KIND_BASE)) {
        return KIND_ICONS[stop?.kind] || KIND_ICONS.find;
    }
    if (stop.category === 'custom' && /^ti-[a-z0-9-]+$/.test(stop.icon || '')) return stop.icon;
    return CATEGORY_ICONS[stop.category] || KIND_ICONS[stop.kind];
}

export function stopLabel(stop) {
    if (stop.kind === 'lab') return stop.adventure ? `${stop.adventure} — ${stop.name || ''}` : (stop.name || stop.key);
    if (stop.kind === KIND_BASE) return stop.name || t('Base');
    if (stop.kind === KIND_PLACE) return stop.name || t('Lieu');
    return stop.name || stop.code || stop.key;
}

// Pourquoi l'étape est à cette place (parcours_reconstruct.mjs, REASON_*).
export function reasonLabel(reason) {
    switch (reason) {
        case REASON_TIME: return t('heure sûre');
        case REASON_LOG_ORDER: return t('ordre des logs');
        case REASON_LATE_TYPE: return t('souvent loguée après coup');
        case REASON_INTRUDER: return t('log tardif');
        case REASON_GEO: return t('géographie');
        case REASON_INSERTED: return t('au plus court');
        case REASON_PINNED: return t('heure épinglée');
        case REASON_MANUAL: return t('ordre manuel');
        case REASON_BASE: return t('base');
        case REASON_PHOTO: return t('heure d’une photo');
        case REASON_TRACK: return t('heure de la trace');
        default: return '';
    }
}

// `photoCount` : nombre de photos rattachées à l'étape (photoByStop du
// parcours ouvert — la fonction reste sans état).
export function stopDetail(stop, photoCount = 0) {
    const parts = [];
    if (stop.code) parts.push(stop.code);
    if (stop.kind === 'dnf') parts.push(t('DNF'));
    else if (stop.kind === KIND_PLACE) parts.push(categoryLabel(stop.category) || t('lieu'));
    else if (stop.kind === KIND_BASE) { const c = categoryLabel(stop.category); if (c) parts.push(c); }
    else if (stop.type) parts.push(stop.type);
    // Position autre que celle publiée : corrigée sur geocaching.com ou
    // saisie dans « Caches sans position » (log_store.cache_position).
    if (stop.positionMoved) parts.push(t('position déplacée sur la carte'));
    else if (stop.posSource === 'corrected') parts.push(t('coordonnées corrigées'));
    else if (stop.posSource === 'manual') parts.push(t('position saisie'));
    if (stop.favorite) parts.push(t('PF donné'));
    const reason = reasonLabel(stop.reason);
    if (reason) parts.push(reason);
    if (stop.movedFrom) parts.push(t('déplacée du ${day}', { day: formatDay(stop.movedFrom, { day: 'numeric', month: 'short' }) }));
    if (photoCount) parts.push(photoCount === 1 ? t('1 photo') : t('${n} photos', { n: photoCount }));
    return parts.join(' · ');
}

// Total de PF et nombre de trouvailles lus sur la fiche par le favori
// « Mes logs » : valeurs du jour de la collecte (`factsAt`), jamais de
// celui du passage — la date le dit.
export function stopFacts(stop) {
    const parts = [];
    const number = (value) => value.toLocaleString(pageLocale());
    if (Number.isFinite(stop.favoritePoints)) {
        parts.push(stop.favoritePoints === 1 ? t('1 PF') : t('${n} PF', { n: number(stop.favoritePoints) }));
    }
    if (Number.isFinite(stop.foundCount)) {
        parts.push(stop.foundCount === 1 ? t('1 trouvaille') : t('${n} trouvailles', { n: number(stop.foundCount) }));
    }
    if (!parts.length) return '';
    const facts = parts.join(' · ');
    if (!stop.factsAt) return facts;
    const date = formatDay(stop.factsAt, { day: 'numeric', month: 'short', year: 'numeric' });
    return t('${facts} au ${date}', { facts, date });
}

// Heure d'arrivée : exacte pour une ancre, « ≈ » sinon.
export function stopTime(stop) {
    const time = minutesToTime(stop.arrivalMin);
    if (!time) return '';
    return stop.confidence === CONFIDENCE_ANCHORED ? time : `≈ ${time}`;
}

// Ligne de bilan d'une journée : distance, verdict sur l'ordre des logs,
// heures sûres, journée comprimée.
export function dayDiagnostic(day) {
    const km = day.legs.reduce((total, leg) => total + leg.km, 0);
    const parts = [t('${km} km', { km: km.toLocaleString(pageLocale(), { maximumFractionDigits: 1 }) })];
    const d = day.diagnostics;
    // Ordre manuel : le verdict sur l'ordre des logs ne décrit plus la journée.
    if (day.manual) {
        // rien
    } else if (d.logOrder === LOG_ORDER_TRUSTED) parts.push(t('ordre de saisie des logs retenu'));
    else if (d.logOrder === LOG_ORDER_REJECTED) {
        parts.push(t('logs saisis dans le désordre (trajet ×${ratio}) : ordre géographique',
            { ratio: d.logRatio.toLocaleString(pageLocale(), { maximumFractionDigits: 1 }) }));
    }
    if (d.anchors > 0) parts.push(t('${n} heures sûres', { n: d.anchors }));
    if (d.compressed) parts.push(t('horaire comprimé'));
    if (d.clockBacktrack) parts.push(t('ordre contraire aux heures sûres : l’heure recule'));
    return parts.join(' · ');
}

export function formatOffset(minutes) {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(minutes);
    return `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')}`;
}

export function formatUtcOffset(minutes) {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function offsetSourceLabel(source) {
    switch (source) {
        case OFFSET_MANUAL: return t('réglé à la main');
        case OFFSET_PHOTOS: return t('déduit des photos');
        case OFFSET_EVIDENCE: return t('déduit des Labs et photos situés sur la trace');
        default: return t('fuseau de cet ordinateur');
    }
}

export function trackRange(track, utcOffsetMinutes) {
    const start = Date.parse(track.start || '') / 1000;
    const end = Date.parse(track.end || '') / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
    const a = localClock(start, utcOffsetMinutes);
    const b = localClock(end, utcOffsetMinutes);
    const day = formatDay(a.date, { weekday: 'short', day: 'numeric', month: 'short' });
    return a.date === b.date
        ? `${day} ${minutesToTime(a.minutes)} → ${minutesToTime(b.minutes)}`
        : `${day} ${minutesToTime(a.minutes)} → ${formatDay(b.date, { day: 'numeric', month: 'short' })} ${minutesToTime(b.minutes)}`;
}

// Libellé du rattachement d'une photo ; `stop` est l'étape trouvée par
// l'appelant (stopByKey), null si la clé ne désigne plus rien.
export function matchLabel(match, stop) {
    if (!match?.key) return t('non rattachée');
    const name = stop ? stopLabel(stop) : match.key;
    if (match.source === MATCH_MANUAL) return t('${name} (à la main)', { name });
    if (match.source === MATCH_GPS) return t('${name} (position)', { name });
    return t('${name} (heure)', { name });
}

// Décalage photo ↔ étape pour l'outil de calibration du fuseau : null tant
// que l'étape n'est pas une heure sûre autre qu'une heure de photo. `days`
// = ordered.days (l'étape cherche sa journée parmi elles).
export function calibrationOffset(photo, stop, days) {
    if (!stop || stop.confidence !== CONFIDENCE_ANCHORED || stop.reason === REASON_PHOTO) return null;
    const raw = photoClock(photo);
    const day = (days || []).find((d) => d.stops.includes(stop))?.date;
    if (!raw || !day) return null;
    const dayShift = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${raw.date}T00:00:00Z`)) / 60000);
    return Math.round(stop.arrivalMin - raw.minutes + dayShift);
}

// Résumé des fichiers refusés à l'envoi, groupés par cause.
export function refuseSummary(refused) {
    const byMessage = new Map();
    for (const { name, message } of refused) {
        if (!byMessage.has(message)) byMessage.set(message, []);
        byMessage.get(message).push(name);
    }
    const lines = [];
    for (const [message, names] of byMessage) {
        const shown = names.slice(0, 3).join(', ');
        const more = names.length > 3 ? t(' et ${n} autres', { n: names.length - 3 }) : '';
        lines.push(`${shown}${more} : ${message}`);
    }
    return lines.join('\n');
}
