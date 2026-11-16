// Itinéraires réels d'un parcours (MyGCFlow_Plan_Parcours.md, § 10 ; lot 6) :
// quel mode pour chaque trajet, quelles requêtes envoyer, et ce que les
// itinéraires calculés changent (durées, chemins).
//
// Les itinéraires sont calculés par le serveur (parcours_routing.py,
// POST /api/parcours/routes), un appel par SUITE de trajets consécutifs de
// même profil dans une journée : une journée coûte une poignée d'appels.
//
// Mode d'un trajet : celui imposé par l'étape de départ (`legMode` de ses
// ajustements), sinon à pied jusqu'à walkMaxKm (1,5 km), en voiture
// jusqu'à STRAIGHT_BEYOND_KM, en ligne droite au-delà (avion, ferry : pas
// d'itinéraire). La nuit n'est jamais routée (d'une journée à l'autre), ni
// un trajet qui suit déjà une trace GPS (prioritaire).
//
// Aucune dépendance au DOM ni à OpenLayers : testé sous Node
// (tests/js/parcours_routing.test.mjs).

import { groundDistanceKm } from './travel_trail.mjs';
import { RECONSTRUCT_DEFAULTS } from './parcours_reconstruct.mjs';

export const LEG_MODES = Object.freeze(['walk', 'bike', 'car', 'straight']);
export const ROUTE_PROFILES = Object.freeze({ walk: 'foot', bike: 'bike', car: 'car' });
export const STRAIGHT_BEYOND_KM = 300;
// openrouteservice : 50 points au plus par itinéraire.
export const MAX_RUN_WAYPOINTS = 50;

export function legKey(fromKey, toKey) {
    return `${fromKey}>${toKey}`;
}

// Mode d'un trajet de `km` km, `forced` : mode imposé ou null.
export function legModeFor(km, forced = null, opts = RECONSTRUCT_DEFAULTS) {
    if (LEG_MODES.includes(forced)) return forced;
    if (km <= opts.walkMaxKm) return 'walk';
    return km <= STRAIGHT_BEYOND_KM ? 'car' : 'straight';
}

// Requêtes à envoyer : [{ profile, keys: [« from>to »], waypoints: [[lon,
// lat]] }], une par suite de trajets consécutifs de même profil dans une
// journée. `overrides` : Map clé d'étape → ajustements ; `skip` : trajets à
// ne pas router (déjà sur une trace).
export function routeRuns(reconstructed, overrides = new Map(), { skip = new Set(), opts = RECONSTRUCT_DEFAULTS } = {}) {
    const runs = [];
    for (const day of reconstructed?.days || []) {
        let run = null;
        for (let i = 1; i < day.stops.length; i++) {
            const a = day.stops[i - 1];
            const b = day.stops[i];
            const key = legKey(a.key, b.key);
            const km = groundDistanceKm([a.lon, a.lat], [b.lon, b.lat]);
            const mode = legModeFor(km, overrides.get(a.key)?.legMode ?? null, opts);
            const profile = ROUTE_PROFILES[mode];
            // Deux étapes au même endroit : rien à router.
            if (!profile || skip.has(key) || km < 0.005) {
                run = null;
                continue;
            }
            if (run && run.profile === profile && run.keys.length < MAX_RUN_WAYPOINTS - 1) {
                run.keys.push(key);
                run.waypoints.push([b.lon, b.lat]);
            } else {
                run = { profile, keys: [key], waypoints: [[a.lon, a.lat], [b.lon, b.lat]] };
                runs.push(run);
            }
        }
    }
    return runs;
}

// Clé de cache côté page : un même trajet peut être demandé à pied puis en
// voiture.
export function cacheKey(profile, key) {
    return `${profile}|${key}`;
}

const MODE_OF_PROFILE = Object.freeze({ foot: 'walk', bike: 'bike', car: 'car' });

// Ce que les itinéraires calculés apportent aux trajets demandés :
// { hints: Map « from>to » → { minutes, km, mode }, paths: Map « from>to » →
// [[lon, lat]], missing: nombre de trajets pas encore calculés }. `cache` :
// Map cacheKey → réponse du serveur pour ce trajet ({ path, distanceM,
// durationS } ; path null : pas de route, ligne droite).
export function routeEffects(runs, cache, opts = RECONSTRUCT_DEFAULTS) {
    const hints = new Map();
    const paths = new Map();
    let missing = 0;
    for (const run of runs) {
        const mode = MODE_OF_PROFILE[run.profile];
        for (const key of run.keys) {
            const leg = cache.get(cacheKey(run.profile, key));
            if (leg === undefined) {
                missing++;
                continue;
            }
            if (!leg?.path || !Number.isFinite(leg.durationS)) continue;
            hints.set(key, {
                minutes: leg.durationS / 60 + (mode === 'car' ? opts.parkMin : 0),
                km: (leg.distanceM || 0) / 1000,
                mode,
            });
            paths.set(key, leg.path);
        }
    }
    return { hints, paths, missing };
}

// Requêtes encore utiles : les suites dont au moins un trajet manque.
export function pendingRuns(runs, cache) {
    return runs.filter((run) => run.keys.some((key) => !cache.has(cacheKey(run.profile, key))));
}
