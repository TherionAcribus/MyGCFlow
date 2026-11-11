// Cartes par zones de la page Statistiques : description → résultat. Module
// pur (ni DOM ni ECharts), testé par tests/js/chart_zones.test.mjs.
//
// Le calcul passe par zone_model.mjs — le même que la couche animée de la
// carte : les chiffres sont identiques des deux côtés. Le résultat a la forme
// de chart_query.mjs (clés = ids de zones, une série par vignette), pour que
// « Voir les valeurs », l'export CSV et la présentation marchent sans
// changement ; `zones` y ajoute ce qui est propre à la carte.
//
// Plan : MyGCFlow_Plan_Carte_Zones.md ; doc : docs/carte-zones.md.

import { MAX_SERIES } from './chart_spec.mjs';
import { expandPeriods } from './chart_periods.mjs';
import { filterMask } from './chart_query.mjs';
import {
    ZONE_COLUMNS, createShareState, createZoneState, foundRowsTable, keyMoments, shareEventsOfTable,
    shareScaleThresholds, zoneScale,
} from './zone_model.mjs';
import { cellArea, withGridColumn } from './zone_grid.mjs';

export const LEVEL_OF_DIMENSION = Object.freeze({
    zone_country: 'country', zone_region: 'region', zone_subregion: 'subregion', zone_grid: 'grid',
});

// Mesure du graphique → mesure de zone_model et portée des lignes :
//   period  les lignes de la période (« trouvailles en 2024 ») ;
//   all     tout jusqu'à la fin de la période (cumul depuis le début,
//           caches actives, première trouvaille : la « conquête »).
export function zoneMeasureOf(spec) {
    const { op, field } = spec.measure || {};
    const per = spec.compare?.normalize === 'per_km2' ? 'km2' : null;
    switch (op) {
    case 'cumulative':
        return { measure: { op: 'count', per }, scope: spec.measure.from === 'all' ? 'all' : 'period' };
    case 'active':
        return { measure: { op: 'count', mode: 'active', per }, scope: 'all' };
    case 'distinct': {
        const zoneField = field === 'caches' ? 'code' : field === 'days' ? 'day' : field;
        return { measure: { op: 'distinct', field: zoneField, per }, scope: 'period' };
    }
    case 'mean':
        return { measure: { op: 'mean', field }, scope: 'period' };
    case 'dt_coverage':
        return { measure: { op: 'dt_coverage' }, scope: 'period' };
    case 'first_day':
        return { measure: { op: 'first_day' }, scope: 'all' };
    case 'found_share':
        return { measure: { op: 'found_share', base: spec.measure.base === 'all' ? 'all' : 'active' }, scope: 'all' };
    default:
        return { measure: { op: 'count', per }, scope: 'period' };
    }
}

// Colonne de zones à lire. Au niveau 2, un pays sans découpage plus fin
// (`fallbackCountries`) s'affiche à son niveau 1 : la colonne lue est alors
// un mélange (sous-région quand elle existe, sinon la région de ces pays).
// Partagé avec la couche de zones de la carte (zone_layer.js).
export function mixedZoneTable(table, level, fallbackCountries) {
    if (level !== 'subregion' || !fallbackCountries?.size) return table;
    const sub = table[ZONE_COLUMNS.subregion];
    const region = table[ZONE_COLUMNS.region];
    const country = table[ZONE_COLUMNS.country];
    const dicts = table.dicts || {};
    const subIds = dicts[ZONE_COLUMNS.subregion] || [];
    const regionIds = dicts[ZONE_COLUMNS.region] || [];
    const countryIds = dicts[ZONE_COLUMNS.country] || [];
    if (!sub || !region || !country) return table;
    const ids = [...subIds];
    const regionIndex = new Map();
    const mixed = new Int32Array(table.n);
    for (let r = 0; r < table.n; r++) {
        if (sub[r] >= 0) {
            mixed[r] = sub[r];
            continue;
        }
        const c = countryIds[country[r]];
        const g = region[r];
        if (g < 0 || !fallbackCountries.has(c)) {
            mixed[r] = -1;
            continue;
        }
        let idx = regionIndex.get(g);
        if (idx === undefined) {
            idx = ids.length;
            ids.push(regionIds[g]);
            regionIndex.set(g, idx);
        }
        mixed[r] = idx;
    }
    return {
        ...table,
        [ZONE_COLUMNS.subregion]: mixed,
        dicts: { ...dicts, [ZONE_COLUMNS.subregion]: ids },
    };
}

// Jour de ma première trouvaille de chaque code (Map code → jour), depuis la
// table de mes trouvailles. Mémorisé par table.
const foundDaysMemo = new WeakMap();
export function foundDaysOf(findsTable) {
    if (!findsTable || typeof findsTable !== 'object') return new Map();
    let out = foundDaysMemo.get(findsTable);
    if (out) return out;
    out = new Map();
    const codes = findsTable.code || [];
    for (let r = 0; r < (findsTable.n || 0); r++) {
        const code = codes[r];
        const day = findsTable.day[r];
        if (!code || day !== day) continue;
        const known = out.get(code);
        if (known === undefined || day < known) out.set(code, day);
    }
    foundDaysMemo.set(findsTable, out);
    return out;
}

// Vignettes : périodes déployées, ou moments clés tirés des données. Part
// trouvée : moments tirés de mes trouvailles dans le jeu (`momentsOf()`,
// calculé seulement s'il y a des moments).
function zoneEntries(spec, table, rows, level, options, momentsOf = null) {
    const periods = options.periods !== undefined ? options.periods : spec.periods;
    const moments = (periods || []).find((p) => p?.kind === 'moments');
    if (moments) {
        // Aucune trouvaille dans le jeu : moments du jeu lui-même (cartes à 0 %).
        const found = momentsOf?.();
        const source = found?.rows.length ? found : { table, rows };
        const list = keyMoments(source.table, { rules: [moments.rule], level, rows: source.rows, max: MAX_SERIES });
        if (source === found) {
            // Dernière vignette : la fin du jeu, pas ma dernière trouvaille —
            // les archivages qui suivent changent encore la part.
            let end = -Infinity;
            for (const r of rows) {
                const e = table.endDay[r];
                end = Math.max(end, table.day[r], e === e ? e : -Infinity);
            }
            const last = list.find((m) => m.kind === 'last');
            if (last && end > last.day) last.day = end;
        }
        // (Boucle, pas Math.min(...) : un jeu Évolution dépasse la pile.)
        let first = Infinity;
        for (const r of rows) if (table.day[r] < first) first = table.day[r];
        return {
            truncated: false,
            entries: list.map((moment, index) => ({
                index, from: first, to: moment.day, fullTo: moment.day,
                as: { kind: 'moment', moment }, period: moments, step: null, ongoing: false,
            })),
        };
    }
    const { periods: entries, truncated } = expandPeriods(periods || [{ kind: 'all' }], {
        extent: table.extent, today: options.today ?? Infinity,
    });
    return { entries, truncated };
}

// `options` : periods, filters (résolus par l'appelant, comme
// runChartQueries), today, areas (km² par id, pour la densité),
// fallbackCountries (Set des pays sans niveau 2), found (Map code → jour de
// ma première trouvaille : mesure `found_share`).
export function runZoneQuery(spec, rawTable, options = {}) {
    const today = options.today ?? Infinity;
    const level = LEVEL_OF_DIMENSION[spec.groupBy] || 'country';
    const gridSize = spec.view.map?.gridSize;
    const table = level === 'grid'
        ? withGridColumn(rawTable, gridSize)
        : mixedZoneTable(rawTable, level, options.fallbackCountries);
    const filters = options.filters !== undefined ? options.filters : spec.filters;
    const mask = filterMask(table, filters);
    // Cadrage sur un pays ou un continent (options.frameCountries) : les
    // lignes d'un autre pays sortent du calcul — ni valeur, ni échelle —
    // et sont comptées « hors du cadre ». Une ligne sans pays reste « hors
    // carte ».
    const frameCountries = options.frameCountries instanceof Set ? options.frameCountries : null;
    const frameCol = table[ZONE_COLUMNS.country];
    const frameIds = table.dicts?.[ZONE_COLUMNS.country] || [];
    const rows = [];
    const framedOut = [];
    for (let r = 0; r < table.n; r++) {
        if (!mask[r]) continue;
        const c = frameCountries && frameCol ? frameIds[frameCol[r]] : null;
        if (c && !frameCountries.has(c)) framedOut.push(r);
        else rows.push(r);
    }

    const { measure, scope } = zoneMeasureOf(spec);
    const share = measure.op === 'found_share';
    const found = options.found instanceof Map ? options.found : new Map();
    const foundDay = (code) => found.get(code);
    const { entries, truncated } = zoneEntries(spec, table, rows, level, options,
        share ? () => foundRowsTable(table, { rows, foundDay }) : null);
    // Densité d'une grille : surface calculée de chaque case.
    const areas = level === 'grid'
        ? new Map((table.dicts.zone_grid || []).map((id) => [id, cellArea(id)]))
        : options.areas || null;
    let shared = null;
    const counted = new Uint8Array(table.n);
    const frames = entries.map((entry) => {
        const end = Math.min(entry.to, today);
        let state;
        if (share) {
            shared ??= createShareState({
                ids: table.dicts?.[ZONE_COLUMNS[level]] || [],
                events: shareEventsOfTable(table, { column: table[ZONE_COLUMNS[level]], rows, foundDay }),
                base: measure.base,
            });
            state = shared;
            for (const r of rows) if (table.day[r] <= end) counted[r] = 1;
        } else if (scope === 'all') {
            shared ??= createZoneState({ table, level, measure, rows: Int32Array.from(rows), areas });
            state = shared;
            for (const r of rows) if (table.day[r] <= end) counted[r] = 1;
        } else {
            const inPeriod = rows.filter((r) => table.day[r] >= entry.from && table.day[r] <= entry.to);
            for (const r of inPeriod) counted[r] = 1;
            state = createZoneState({ table, level, measure, rows: Int32Array.from(inPeriod), areas });
        }
        state.seek(end);
        const values = state.values();
        // Part trouvée : [trouvées, base] par zone (infobulle, valeurs).
        const parts = share ? new Map([...values.keys()].map((id) => [id, state.parts(id)])) : null;
        return { values, outside: state.outside, day: end, parts, totals: share ? state.totals() : null };
    });

    // Zones de l'axe : toutes celles qui ont une valeur dans une vignette,
    // les plus fortes de la dernière d'abord.
    const last = frames[frames.length - 1]?.values || new Map();
    const ids = new Set();
    for (const frame of frames) for (const id of frame.values.keys()) ids.add(id);
    const keys = [...ids].sort((a, b) => (last.get(b) ?? -Infinity) - (last.get(a) ?? -Infinity)
        || String(a).localeCompare(String(b)));

    const series = frames.map((frame, i) => {
        const previous = i > 0 ? frames[i - 1].values : null;
        const changed = previous
            ? keys.filter((id) => frame.values.has(id) && frame.values.get(id) !== previous.get(id))
            : [];
        return {
            id: `p${i}`,
            periodIndex: i,
            split: null,
            values: keys.map((id) => frame.values.get(id) ?? null),
            partial: -1,
            dates: null,
            day: frame.day,
            outside: frame.outside,
            changed,
            ...(share ? { parts: keys.map((id) => frame.parts.get(id) ?? null), totals: frame.totals } : {}),
        };
    });

    // Échelle commune à toutes les vignettes. Part trouvée : échelle fixe
    // 0–100 %, mêmes seuils que la carte (shareScaleThresholds).
    const pooled = series.flatMap((s) => s.values.filter((v) => v !== null));
    const classes = spec.view.map?.classes || 5;
    const scaleMode = measure.op === 'first_day' ? 'year' : share ? 'fixed' : (spec.view.map?.scale || 'quantile');
    const scale = zoneScale(pooled, { mode: scaleMode, classes, thresholds: share ? shareScaleThresholds(classes) : [] });

    // Pays présents : les contours à charger.
    const countryCol = table[ZONE_COLUMNS.country];
    const countryIds = table.dicts?.[ZONE_COLUMNS.country] || [];
    const countries = new Set();
    let rowsCounted = 0;
    for (const r of rows) {
        if (!counted[r]) continue;
        rowsCounted++;
        const c = countryCol ? countryIds[countryCol[r]] : undefined;
        if (c) countries.add(c);
    }
    // Hors du cadre : sur la fenêtre de temps des vignettes.
    const lo = scope === 'all' || share ? -Infinity : Math.min(...entries.map((e) => e.from));
    const hi = Math.max(-Infinity, ...entries.map((e) => Math.min(e.to, today)));
    const outOfFrame = framedOut.filter((r) => table.day[r] >= lo && table.day[r] <= hi).length;
    return {
        dim: spec.groupBy,
        kind: 'zone',
        align: 'calendar',
        elapsedUnit: null,
        keys,
        series,
        periods: entries,
        truncated,
        toDate: null,
        delta: null,
        normalize: spec.compare?.normalize || 'none',
        grid: null,
        sources: [spec.source],
        meta: { rows: rowsCounted, undated: table.undated || 0, noAttribute: 0, unknown: series.at(-1)?.outside || 0,
            outOfFrame },
        zones: {
            level,
            ...(level === 'grid' ? { gridSize } : {}),
            countries: [...countries].sort(),
            scale: { mode: scale.mode, breaks: scale.breaks, classes: scale.classes, min: scale.min, max: scale.max },
        },
    };
}

// Classe d'une valeur selon l'échelle sérialisée d'un résultat.
export function zoneClassOf(scale, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    let k = 0;
    while (k < scale.breaks.length && scale.breaks[k] <= value) k++;
    return k;
}
