// Grilles de défis de la page Statistiques (graphique « grille de défi ») :
// D/T 81, Calendrier 366, Jasmer (mois de publication depuis mai 2000) et
// mois de trouvaille (un mois sans trouvaille ?). Module pur, testé par
// tests/js/chart_challenge.test.mjs.
//
// La géométrie est celle des panneaux vidéo de la carte (stats_model.mjs ›
// gridSpec) : mêmes lignes, mêmes colonnes, mêmes cases impossibles (30
// février, avant mai 2000, après la dernière trouvaille). Seules les clés
// changent : celles du moteur (chart_query.mjs › keyAccessor).

import { gridSpec, ymdOfDay } from './stats_model.mjs';
import { dayOfYearSlot } from './chart_sources.mjs';

// Regroupement du graphique → grille.
export const CHALLENGE_GRIDS = Object.freeze({
    dt: 'dt',
    day_of_year: 'calendar',
    published_month: 'jasmer',
    month: 'finds_ym',
});

const HALF_STEPS = Array.from({ length: 9 }, (_, i) => 1 + i / 2);

// Clé du moteur d'une case : « D|T » (nombres comme dans la table), case du
// jour de l'année (année bissextile de référence), année × 100 + mois.
function engineKey(metric, grid, r, c) {
    if (metric === 'dt') return `${HALF_STEPS[r]}|${HALF_STEPS[c]}`;
    if (metric === 'calendar') return dayOfYearSlot(r + 1, c + 1);
    return grid.keyAt(r, c);
}

const ymKey = (day) => {
    const { y, m } = ymdOfDay(day);
    return y * 100 + m;
};

// Grille d'un regroupement pour une période déployée (`entry` : { from, to,
// fullTo }, chart_periods.mjs) : { metric, rows, cols, rowKeys, colKeys,
// cells } — `cells` : les cases disponibles, ligne par ligne, { r, c, key }.
// La fin est celle de la période, sans dépasser aujourd'hui : Jasmer ne
// compte pas les mois à venir, ni la grille des mois ceux qui ne sont pas
// encore passés. null : regroupement sans grille.
export function challengeGrid(dim, entry, today) {
    const metric = CHALLENGE_GRIDS[dim];
    if (!metric) return null;
    const from = entry ? entry.from : today;
    const last = Math.max(from, Math.min(entry ? (entry.fullTo ?? entry.to) : today, today));
    let context = {};
    let inside = () => true;
    if (metric === 'jasmer') {
        const { y, m } = ymdOfDay(last);
        context = { end: { y, m } };
    } else if (metric === 'finds_ym') {
        const lo = ymKey(from);
        const hi = ymKey(last);
        context = { years: [Math.floor(lo / 100), Math.floor(hi / 100)] };
        inside = (key) => key >= lo && key <= hi;
    }
    const grid = gridSpec(metric, context);
    const cells = [];
    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
            if (grid.disabled(r, c) || !inside(grid.keyAt(r, c))) continue;
            cells.push({ r, c, key: engineKey(metric, grid, r, c) });
        }
    }
    return { metric, rows: grid.rows, cols: grid.cols, rowKeys: grid.rowKeys, colKeys: grid.colKeys, cells };
}

// Bilan d'une série alignée sur les cases (`values[i]` ↔ `cells[i]`) :
//   filled     cases trouvées au moins une fois ;
//   available  cases de la grille ;
//   loops      tours complets (le plus petit compte : un tour est fini
//              quand chaque case a été trouvée une fois de plus) ;
//   next       indices des cases qui manquent au tour suivant (celles
//              dont le compte vaut `loops`).
export function challengeSummary(values) {
    const list = Array.isArray(values) ? values : [];
    let filled = 0;
    let loops = Infinity;
    for (const value of list) {
        const n = value || 0;
        if (n > 0) filled++;
        if (n < loops) loops = n;
    }
    if (!list.length) loops = 0;
    const next = [];
    list.forEach((value, i) => {
        if ((value || 0) === loops) next.push(i);
    });
    return { filled, available: list.length, loops, next };
}
