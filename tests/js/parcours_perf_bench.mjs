// Banc de lecture : coût des requêtes pures de la chronologie par image,
// sur un parcours synthétique de 500 étapes (power trail, 5 × 100).
// Manuel : node tests/js/parcours_perf_bench.mjs
// Hors suite `*.test.mjs` — mesure, pas assertion.
import { reconstructParcours } from '../../static/js/parcours_reconstruct.mjs';
import {
    buildParcoursTimeline,
    dayCardAt,
    endCardAt,
    headAt,
    headModeAt,
    nightLevelAt,
    reachedIndex,
    stateAt,
    trailAt,
} from '../../static/js/parcours_timeline.mjs';

const DEG_PER_100M = 0.1 / (111.195 * Math.cos(45 * Math.PI / 180));

// Power trail : 5 journées × 100 trouvailles espacées de ~100 m en ligne.
function powerTrail() {
    const days = [];
    for (let d = 0; d < 5; d++) {
        const stops = [];
        for (let i = 0; i < 100; i++) {
            const n = d * 100 + i;
            stops.push({
                key: `GCPT${String(n).padStart(4, '0')}`,
                kind: 'find',
                type: 'Traditional Cache',
                lon: 5 + n * DEG_PER_100M,
                lat: 45 + (n % 3) * DEG_PER_100M * 0.2,
                logId: n + 1,
                localTime: null,
                favorite: n % 17 === 0,
            });
        }
        days.push({ date: `2025-07-${String(12 + d).padStart(2, '0')}`, stops });
    }
    return reconstructParcours({ days });
}

const timeline = buildParcoursTimeline(powerTrail(), { endCard: true });
console.log(`chronologie : ${timeline.stops.length} étapes, ${timeline.legs.length} trajets, ${timeline.quanta} quanta`);

// Appels réellement faits à chaque image de la lecture (parcours_play.mjs +
// parcours_data.js) : frame() → trailAt + headAt + headModeAt, compteurs →
// stateAt, scène → nightLevelAt + dayCardAt + endCardAt, étapes → reachedIndex.
const perFrame = [
    ['trailAt', (tl, q) => trailAt(tl, q)],
    ['headAt', (tl, q) => headAt(tl, q)],
    ['headModeAt', (tl, q) => headModeAt(tl, q)],
    ['stateAt', (tl, q) => stateAt(tl, q)],
    ['nightLevelAt', (tl, q) => nightLevelAt(tl, q)],
    ['dayCardAt', (tl, q) => dayCardAt(tl, q)],
    ['endCardAt', (tl, q) => endCardAt(tl, q)],
    ['reachedIndex', (tl, q) => reachedIndex(tl, q)],
];

const times = new Float64Array(timeline.quanta);
const t0 = performance.now();
for (let q = 0; q < timeline.quanta; q++) {
    const start = performance.now();
    for (const [, fn] of perFrame) fn(timeline, q);
    times[q] = performance.now() - start;
}
const total = performance.now() - t0;
times.sort();
const p = (share) => times[Math.floor(times.length * share)];
console.log(`ensemble des requêtes pures par image (µs) : p50 ${(p(0.5) * 1000).toFixed(1)} · p95 ${(p(0.95) * 1000).toFixed(1)} · max ${(times[times.length - 1] * 1000).toFixed(1)}`);
console.log(`total pour ${timeline.quanta} images : ${total.toFixed(1)} ms`);

// Détail par fonction (moyenne µs/image).
for (const [name, fn] of perFrame) {
    const start = performance.now();
    for (let q = 0; q < timeline.quanta; q++) fn(timeline, q);
    console.log(`  ${name.padEnd(14)} ${((performance.now() - start) * 1000 / timeline.quanta).toFixed(1)} µs/image`);
}
