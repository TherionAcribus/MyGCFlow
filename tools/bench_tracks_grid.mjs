// Banc ad hoc : rattachement des étapes aux traces (static/js/parcours_tracks.mjs),
// index spatial compris. Usage : node tools/bench_tracks_grid.mjs
import { matchStopsToTracks } from '../static/js/parcours_tracks.mjs';

// Trace de 50 000 points serpentant la zone ; 800 étapes dont une partie
// posée sur le tracé, le reste à quelques kilomètres.
const T0 = Date.parse('2025-07-12T06:00:00Z') / 1000;
const points = [];
for (let i = 0; i < 50000; i++) {
    const x = (i % 500) / 500 * 0.25;            // ~ 20 km de va-et-vient
    const y = Math.floor(i / 500) * 0.004 + Math.sin(i / 40) * 0.001;
    points.push([6.0 + x, 45.9 + y, T0 + i * 10]);
}
const tracks = [{ id: 1, segments: [points] }];

const stops = [];
for (let i = 0; i < 800; i++) {
    const onTrack = i % 3 !== 0;
    const k = (i * 61) % 49900;
    stops.push({
        key: `S${i}`,
        kind: 'find',
        lon: onTrack ? points[k][0] + 0.0001 : 6.1 + (i % 40) * 0.01,
        lat: onTrack ? points[k][1] + 0.0001 : 46.2,
    });
}
const reconstructed = { days: [{ date: '2025-07-12', stops }] };

const t0 = performance.now();
const matches = matchStopsToTracks(reconstructed, tracks, 0);
console.log(`${(performance.now() - t0).toFixed(0)} ms — ${matches.size} étapes rattachées sur 800 (trace de ${points.length} points)`);
