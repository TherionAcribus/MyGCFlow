// Sources de la page Statistiques : données reçues → table d'événements en
// colonnes, prête pour chart_query.mjs. Module pur (ni DOM ni ECharts), testé
// par tests/js/chart_query.test.mjs.
//
// Une ligne = un événement daté (lot 1 : une trouvaille). Les rangées sans
// date valide sont écartées et comptées dans `undated`. Les dates sont des
// numéros de jour (jours depuis le 01/01/1970, sans fuseau : stats_model.mjs).

import { ageBucket, dayNumber, parseYmd, ymdOfDay } from './stats_model.mjs';

// Colonnes codées par dictionnaire dans le format serveur (stats_finds.py).
export const DICT_FIELDS = Object.freeze(['cache_type', 'container', 'country', 'state', 'owner']);
export const SOURCE_KIND_VALUES = Object.freeze(['geocache', 'lab']);

const NO_VALUE = -1;

// Jour de semaine ISO (lundi = 1 … dimanche = 7) d'un numéro de jour : le
// 01/01/1970 (jour 0) était un jeudi.
export function isoWeekday(day) {
    return ((((day + 3) % 7) + 7) % 7) + 1;
}

// Numéro de semaine ISO 8601 (1 à 53) : la semaine du jeudi.
export function isoWeek(day) {
    const thursday = day - isoWeekday(day) + 4;
    const { y } = ymdOfDay(thursday);
    return Math.floor((thursday - dayNumber({ y, m: 1, d: 1 })) / 7) + 1;
}

// Lundi de la semaine d'un jour (clé de la dimension « semaine »).
export function weekStart(day) {
    return day - isoWeekday(day) + 1;
}

// Case du jour dans une année bissextile (1 à 366) : le 1ᵉʳ mars est toujours
// la case 61, le 29 février la case 60 — les années se superposent jour pour
// jour, une année ordinaire laisse simplement la case 60 vide.
const LEAP_MONTH_START = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
export function dayOfYearSlot(m, d) {
    return LEAP_MONTH_START[m - 1] + d;
}

// Trouvailles du format serveur (`GET /api/stats/finds`) → table.
export function findsTable(payload) {
    const count = Number.isInteger(payload?.count) ? payload.count : 0;
    const col = (name) => (Array.isArray(payload?.[name]) ? payload[name] : []);
    const dates = col('date');

    const keep = [];
    let undated = 0;
    const parsed = [];
    for (let i = 0; i < count; i++) {
        const ymd = parseYmd(dates[i]);
        if (ymd) {
            keep.push(i);
            parsed.push(ymd);
        } else {
            undated++;
        }
    }

    const n = keep.length;
    const table = {
        source: 'finds',
        n,
        undated,
        day: new Int32Array(n),
        y: new Int16Array(n),
        m: new Uint8Array(n),
        d: new Uint8Array(n),
        weekday: new Uint8Array(n),
        week: new Uint8Array(n),
        doy: new Uint16Array(n),
        published: new Float64Array(n),
        publishedYear: new Int16Array(n),
        age: new Int8Array(n),
        ageDays: new Float64Array(n),
        kind: new Uint8Array(n),
        difficulty: new Float64Array(n),
        terrain: new Float64Array(n),
        code: new Array(n),
        attributes: new Array(n),
        dicts: {
            attribute: Array.isArray(payload?.dicts?.attribute) ? payload.dicts.attribute : [],
        },
        extent: null,
    };
    for (const field of DICT_FIELDS) {
        table[field] = new Int32Array(n);
        table.dicts[field] = Array.isArray(payload?.dicts?.[field]) ? payload.dicts[field] : [];
    }

    const published = col('published');
    const kind = col('kind');
    const code = col('code');
    const difficulty = col('difficulty');
    const terrain = col('terrain');
    const attributes = col('attributes');
    const dictCols = Object.fromEntries(DICT_FIELDS.map((f) => [f, col(f)]));
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

    let first = Infinity;
    let last = -Infinity;
    for (let r = 0; r < n; r++) {
        const i = keep[r];
        const ymd = parsed[r];
        const day = dayNumber(ymd);
        table.day[r] = day;
        table.y[r] = ymd.y;
        table.m[r] = ymd.m;
        table.d[r] = ymd.d;
        table.weekday[r] = isoWeekday(day);
        table.week[r] = isoWeek(day);
        table.doy[r] = dayOfYearSlot(ymd.m, ymd.d);
        if (day < first) first = day;
        if (day > last) last = day;

        const pub = parseYmd(published[i]);
        table.published[r] = pub ? dayNumber(pub) : NaN;
        table.publishedYear[r] = pub ? pub.y : 0;
        const bucket = pub ? ageBucket(pub, ymd) : null;
        table.age[r] = bucket === null ? NO_VALUE : bucket;
        table.ageDays[r] = pub && day >= table.published[r] ? day - table.published[r] : NaN;

        table.kind[r] = kind[i] === 1 ? 1 : 0;
        table.code[r] = typeof code[i] === 'string' && code[i] ? code[i] : null;
        table.difficulty[r] = num(difficulty[i]);
        table.terrain[r] = num(terrain[i]);
        table.attributes[r] = Array.isArray(attributes[i]) ? attributes[i] : [];
        for (const field of DICT_FIELDS) {
            const idx = dictCols[field][i];
            table[field][r] = Number.isInteger(idx) && idx >= 0 && idx < table.dicts[field].length ? idx : NO_VALUE;
        }
    }
    if (n) table.extent = { first, last };
    return table;
}
