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
import { ZONE_COLUMNS, createZoneState, keyMoments, zoneScale } from './zone_model.mjs';

export const LEVEL_OF_DIMENSION = Object.freeze({
    zone_country: 'country', zone_region: 'region', zone_subregion: 'subregion',
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

// Vignettes : périodes déployées, ou moments clés tirés des données.
function zoneEntries(spec, table, rows, level, options) {
    const periods = options.periods !== undefined ? options.periods : spec.periods;
    const moments = (periods || []).find((p) => p?.kind === 'moments');
    if (moments) {
        const list = keyMoments(table, { rules: [moments.rule], level, rows, max: MAX_SERIES });
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
// fallbackCountries (Set des pays sans niveau 2).
export function runZoneQuery(spec, rawTable, options = {}) {
    const today = options.today ?? Infinity;
    const level = LEVEL_OF_DIMENSION[spec.groupBy] || 'country';
    const table = mixedZoneTable(rawTable, level, options.fallbackCountries);
    const filters = options.filters !== undefined ? options.filters : spec.filters;
    const mask = filterMask(table, filters);
    const rows = [];
    for (let r = 0; r < table.n; r++) if (mask[r]) rows.push(r);

    const { entries, truncated } = zoneEntries(spec, table, rows, level, options);
    const { measure, scope } = zoneMeasureOf(spec);
    const areas = options.areas || null;
    let shared = null;
    const counted = new Uint8Array(table.n);
    const frames = entries.map((entry) => {
        const end = Math.min(entry.to, today);
        let state;
        if (scope === 'all') {
            shared ??= createZoneState({ table, level, measure, rows: Int32Array.from(rows), areas });
            state = shared;
            for (const r of rows) if (table.day[r] <= end) counted[r] = 1;
        } else {
            const inPeriod = rows.filter((r) => table.day[r] >= entry.from && table.day[r] <= entry.to);
            for (const r of inPeriod) counted[r] = 1;
            state = createZoneState({ table, level, measure, rows: Int32Array.from(inPeriod), areas });
        }
        state.seek(end);
        return { values: state.values(), outside: state.outside, day: end };
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
        };
    });

    // Échelle commune à toutes les vignettes.
    const pooled = series.flatMap((s) => s.values.filter((v) => v !== null));
    const scaleMode = measure.op === 'first_day' ? 'year' : (spec.view.map?.scale || 'quantile');
    const scale = zoneScale(pooled, { mode: scaleMode, classes: spec.view.map?.classes || 5 });

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
        meta: { rows: rowsCounted, undated: table.undated || 0, noAttribute: 0, unknown: series.at(-1)?.outside || 0 },
        zones: {
            level,
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
