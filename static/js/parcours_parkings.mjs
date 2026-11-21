// Parkings proposés comme lieux (MyGCFlow_Plan_Parcours.md § 15.6) : ceux
// des caches de chaque journée, lus sur leur fiche par le favori « Mes
// logs » (`inputs.parkings`, docs/parcours.md). Rien n'est créé sans un
// clic, rien n'est retenu d'une proposition ignorée.
//
// Module pur (aucun DOM, ni OpenLayers) : testé par node --test.

import { groundDistanceKm } from './travel_trail.mjs';

// Deux parkings à moins de PARKING_MERGE_M n'en font qu'un (caches voisines
// qui partagent le même) ; un parking à moins de PARKING_NEAR_PLACE_M d'un
// lieu ou d'une base de la journée n'est plus proposé : il est posé.
export const PARKING_MERGE_M = 40;
export const PARKING_NEAR_PLACE_M = 60;

function near(a, b, meters) {
    return groundDistanceKm([a.lon, a.lat], [b.lon, b.lat]) * 1000 <= meters;
}

// `days` : journées de la reconstruction ({ date, stops }) — étapes gardées
// seulement, dans l'ordre de la journée ; `parkings` : [{ code, name, lat,
// lon }] ; `places` : lieux et bases posés ({ lat, lon, date }, date nulle :
// toutes les journées). Renvoie Map date → [{ name, lat, lon, codes }],
// dans l'ordre de la première étape qui les cite.
export function suggestParkings(days, parkings, places = [],
    { mergeM = PARKING_MERGE_M, nearPlaceM = PARKING_NEAR_PLACE_M } = {}) {
    const byCode = new Map();
    for (const p of Array.isArray(parkings) ? parkings : []) {
        if (!p?.code || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
        if (!byCode.has(p.code)) byCode.set(p.code, []);
        byCode.get(p.code).push(p);
    }
    const posed = (Array.isArray(places) ? places : [])
        .filter((place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lon));
    const out = new Map();
    for (const day of Array.isArray(days) ? days : []) {
        const dayPlaces = posed.filter((place) => place.date == null || place.date === day.date);
        const found = [];
        for (const stop of day.stops || []) {
            for (const p of byCode.get(stop.code) || []) {
                if (dayPlaces.some((place) => near(place, p, nearPlaceM))) continue;
                const same = found.find((f) => near(f, p, mergeM));
                if (same) {
                    if (!same.codes.includes(stop.code)) same.codes.push(stop.code);
                    if (!same.name && p.name) same.name = p.name;
                    continue;
                }
                found.push({ name: p.name || null, lat: p.lat, lon: p.lon, codes: [stop.code] });
            }
        }
        if (found.length) out.set(day.date, found);
    }
    return out;
}
