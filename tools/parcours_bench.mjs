// Banc de la reconstruction des parcours (static/js/parcours_reconstruct.mjs).
//
// Entrée : le JSON de tools/parcours_bench_export.py (journées réelles).
// Usage : node tools/parcours_bench.mjs jours.json
//
// Mesures :
// 1. Verdict sur l'ordre des logs (journées d'au moins 4 étapes à log) :
//    part retenue, rapport chemin des logs / meilleur chemin, intrus, et
//    balayage du seuil `trustRatio`.
// 2. Heures Lab cachées : sur les journées d'au moins 4 étapes Lab
//    horodatées, une heure sur deux est masquée, la journée est
//    reconstruite, et l'heure prédite des étapes masquées est comparée à la
//    vraie — erreur en minutes, et étape restée entre les bonnes ancres.
//    Référence : le milieu des deux ancres voisines (sans modèle de trajet).
// 3. Calibrage des trajets sur les Labs consécutives : vitesse à pied et en
//    voiture, temps passé sur place.
// 4. Temps de calcul par journée.
//
// Aucune vérité terrain pour l'ordre des géocaches (pas d'heure) : la
// mesure 1 décrit le verdict, elle ne le valide pas. Seules les Labs
// donnent une vérité, d'où la mesure 2.

import fs from 'node:fs';
import { groundDistanceKm } from '../static/js/travel_trail.mjs';
import {
    LOG_ORDER_TRUSTED,
    RECONSTRUCT_DEFAULTS,
    reconstructDay,
    timeToMinutes,
} from '../static/js/parcours_reconstruct.mjs';

const file = process.argv[2];
if (!file) {
    console.error('Usage : node tools/parcours_bench.mjs jours.json');
    process.exit(1);
}
const { days } = JSON.parse(fs.readFileSync(file, 'utf-8'));

const quantile = (values, q) => {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const pct = (part, total) => (total ? `${((100 * part) / total).toFixed(1)} %` : '—');
const late = new Set(RECONSTRUCT_DEFAULTS.lateTypes);
const isLogged = (s) => Number.isFinite(s.logId) && !late.has(s.type) && !s.localTime;

// --- 1. Verdict sur l'ordre des logs ----------------------------------------

function logOrderReport(trustRatio) {
    let judged = 0;
    let trusted = 0;
    const ratios = [];
    let intruders = 0;
    const intruderTypes = new Map();
    let lateCount = 0;
    for (const day of days) {
        if (day.stops.filter(isLogged).length < 4) continue;
        const result = reconstructDay(day, { options: { trustRatio } });
        judged++;
        if (result.diagnostics.logOrder === LOG_ORDER_TRUSTED) trusted++;
        if (Number.isFinite(result.diagnostics.logRatio)) ratios.push(result.diagnostics.logRatio);
        intruders += result.diagnostics.intruders;
        lateCount += result.diagnostics.lateTypes;
        for (const stop of result.stops) {
            if (stop.reason === 'intruder') intruderTypes.set(stop.type, (intruderTypes.get(stop.type) || 0) + 1);
        }
    }
    return { judged, trusted, ratios, intruders, intruderTypes, lateCount };
}

const base = logOrderReport(RECONSTRUCT_DEFAULTS.trustRatio);
console.log('\n## 1. Ordre des logs (journées ≥ 4 étapes à log)\n');
console.log(`Journées jugées : ${base.judged} ; ordre retenu : ${base.trusted} (${pct(base.trusted, base.judged)})`);
console.log(`Rapport chemin des logs / meilleur chemin : p10 ${fmt(quantile(base.ratios, 0.1))}, p25 ${fmt(quantile(base.ratios, 0.25))}, `
    + `p50 ${fmt(quantile(base.ratios, 0.5))}, p75 ${fmt(quantile(base.ratios, 0.75))}, p90 ${fmt(quantile(base.ratios, 0.9))}`);
console.log(`Intrus retirés : ${base.intruders} ; types logables après coup mis de côté : ${base.lateCount}`);
console.log('Intrus par type :', [...base.intruderTypes.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || '—');
console.log('\n| trustRatio | ordre des logs retenu |\n|---|---|');
for (const ratio of [1.05, 1.1, 1.2, 1.3, 1.5, 2, 3]) {
    const report = ratio === RECONSTRUCT_DEFAULTS.trustRatio ? base : logOrderReport(ratio);
    console.log(`| ${ratio} | ${pct(report.trusted, report.judged)} |`);
}

// --- 2. Heures Lab cachées ----------------------------------------------------

function hiddenLabsReport(options) {
    const errors = [];
    const midErrors = [];
    let betweenOk = 0;
    let bracketed = 0;
    let labDays = 0;
    for (const day of days) {
        const timed = day.stops.filter((s) => timeToMinutes(s.localTime) !== null)
            .sort((a, b) => timeToMinutes(a.localTime) - timeToMinutes(b.localTime) || (a.key < b.key ? -1 : 1));
        if (timed.length < 4) continue;
        labDays++;
        // Une sur deux masquée ; la première et la dernière restent des ancres.
        const hidden = new Map();
        timed.forEach((s, i) => {
            if (i % 2 === 1 && i < timed.length - 1) hidden.set(s.key, timeToMinutes(s.localTime));
        });
        const masked = {
            ...day,
            stops: day.stops.map((s) => (hidden.has(s.key) ? { ...s, localTime: null } : s)),
        };
        const result = reconstructDay(masked, { options });
        const rankOf = new Map(result.stops.map((s, k) => [s.key, k]));
        const kept = timed.filter((s) => !hidden.has(s.key));
        for (const [key, truth] of hidden) {
            const predicted = result.stops[rankOf.get(key)]?.arrivalMin;
            if (!Number.isFinite(predicted)) continue;
            errors.push(Math.abs(predicted - truth));
            // Ancres voisines dans le temps réel.
            const before = [...kept].reverse().find((s) => timeToMinutes(s.localTime) <= truth);
            const after = kept.find((s) => timeToMinutes(s.localTime) >= truth);
            if (before && after) {
                bracketed++;
                midErrors.push(Math.abs((timeToMinutes(before.localTime) + timeToMinutes(after.localTime)) / 2 - truth));
                const r = rankOf.get(key);
                if (rankOf.get(before.key) < r && r < rankOf.get(after.key)) betweenOk++;
            }
        }
    }
    return { labDays, errors, midErrors, betweenOk, bracketed };
}

console.log('\n## 2. Heures Lab cachées (journées ≥ 4 étapes Lab horodatées, une heure sur deux masquée)\n');
console.log('| réglages | erreur p50 | p75 | p90 | entre ses ancres |\n|---|---|---|---|---|');
let reference = null;
for (const [label, options] of [
    ['visite Lab 5 min', { visitMin: { ...RECONSTRUCT_DEFAULTS.visitMin, 'Lab Cache': 5 } }],
    ['par défaut (visite Lab 1 min)', {}],
]) {
    const r = hiddenLabsReport(options);
    reference = r;
    console.log(`| ${label} | ${fmt(quantile(r.errors, 0.5), 1)} | ${fmt(quantile(r.errors, 0.75), 1)} | `
        + `${fmt(quantile(r.errors, 0.9), 1)} | ${pct(r.betweenOk, r.bracketed)} |`);
}
console.log(`| référence : milieu des ancres voisines | ${fmt(quantile(reference.midErrors, 0.5), 1)} | `
    + `${fmt(quantile(reference.midErrors, 0.75), 1)} | ${fmt(quantile(reference.midErrors, 0.9), 1)} | — |`);
console.log(`\n${reference.labDays} journées, ${reference.errors.length} étapes masquées.`);

// --- 3. Calibrage des trajets sur les Labs consécutives ------------------------

const walkSpeeds = [];
const carSpeeds = [];
const dwell = [];
for (const day of days) {
    const timed = day.stops.filter((s) => timeToMinutes(s.localTime) !== null)
        .sort((a, b) => timeToMinutes(a.localTime) - timeToMinutes(b.localTime));
    for (let i = 1; i < timed.length; i++) {
        const dt = timeToMinutes(timed[i].localTime) - timeToMinutes(timed[i - 1].localTime);
        const km = groundDistanceKm([timed[i - 1].lon, timed[i - 1].lat], [timed[i].lon, timed[i].lat]);
        if (dt <= 0) continue;
        if (km < 0.03 && dt < 60) dwell.push(dt);
        else if (km >= 0.2 && km <= 1.5 && dt < 60) walkSpeeds.push(km / (dt / 60));
        else if (km >= 5 && dt < 240) carSpeeds.push(km / (dt / 60));
    }
}
console.log('\n## 3. Labs consécutives (vérité terrain des déplacements)\n');
console.log(`Même lieu (< 30 m) : ${dwell.length} paires, écart p50 ${fmt(quantile(dwell, 0.5), 1)} min`);
console.log(`0,2–1,5 km : ${walkSpeeds.length} paires, vitesse à vol d'oiseau p25 ${fmt(quantile(walkSpeeds, 0.25), 1)}, `
    + `p50 ${fmt(quantile(walkSpeeds, 0.5), 1)}, p75 ${fmt(quantile(walkSpeeds, 0.75), 1)} km/h `
    + `(modèle : ${fmt(RECONSTRUCT_DEFAULTS.walkKmh / RECONSTRUCT_DEFAULTS.walkDetour, 1)} km/h)`);
console.log(`≥ 5 km : ${carSpeeds.length} paires, vitesse à vol d'oiseau p25 ${fmt(quantile(carSpeeds, 0.25), 1)}, `
    + `p50 ${fmt(quantile(carSpeeds, 0.5), 1)}, p75 ${fmt(quantile(carSpeeds, 0.75), 1)} km/h `
    + `(modèle : ${fmt(RECONSTRUCT_DEFAULTS.carKmh / RECONSTRUCT_DEFAULTS.carDetour, 1)}–${fmt(RECONSTRUCT_DEFAULTS.carFastKmh / RECONSTRUCT_DEFAULTS.carDetour, 1)} km/h, hors stationnement)`);

// --- 4. Temps de calcul -------------------------------------------------------

const timings = [];
let biggest = 0;
for (const day of days) {
    const t0 = performance.now();
    reconstructDay(day);
    timings.push(performance.now() - t0);
    biggest = Math.max(biggest, day.stops.length);
}
console.log('\n## 4. Temps de calcul par journée\n');
console.log(`${days.length} journées (jusqu'à ${biggest} étapes) : p50 ${fmt(quantile(timings, 0.5))} ms, `
    + `p99 ${fmt(quantile(timings, 0.99))} ms, max ${fmt(Math.max(...timings))} ms`);
