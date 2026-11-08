// Sources de la page Statistiques : données reçues → table d'événements en
// colonnes, prête pour chart_query.mjs. Module pur (ni DOM ni ECharts), testé
// par tests/js/chart_query.test.mjs.
//
// Une ligne = un événement daté (lot 1 : une trouvaille). Les rangées sans
// date valide sont écartées et comptées dans `undated`. Les dates sont des
// numéros de jour (jours depuis le 01/01/1970, sans fuseau : stats_model.mjs).

import { ageBucket, dayNumber, parseYmd, ymdOfDay } from './stats_model.mjs';

// Colonnes codées par dictionnaire dans le format serveur (stats_finds.py).
// `cache`, `finder` (Mes poses) et `county` (Évolution) : absentes des
// trouvailles, toujours inconnues dans findsTable.
export const DICT_FIELDS = Object.freeze(['cache_type', 'container', 'country', 'state', 'owner', 'cache', 'finder', 'county']);
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
        // Une trouvaille ne « cesse » pas : pas de fin (mesure « actives »).
        endDay: new Float64Array(n).fill(NaN),
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

// ---------------------------------------------------------------------------
// Autres sources (lot 4)
// ---------------------------------------------------------------------------
//
// Chaque source est ramenée à des enregistrements { day, … } puis à la même
// table que les trouvailles (tableFromRecords). Propriétés absentes d'une
// source : valeur inconnue (-1 / NaN), et chart_spec.mjs › sourceDimensions
// ne propose pas la dimension.
//
//   dnfTable(payload)        GET /api/logs/dnf_features : un enregistrement
//                            par DNF (dnf_dates de chaque cache)
//   ownedTable(payload)      GET /api/logs/owner_features : un par cache
//                            posée, au jour de sa pose ; endDay = archivage
//   posesTables(payload)     GET /api/poses/data : { received, dnf,
//                            favorites } — un par log reçu
//   evolutionTables(payload) GET /api/evolution/datasets/<id>/data :
//                            { placed, archived }

const isoDay = (value) => {
    const ymd = parseYmd(value);
    return ymd ? dayNumber(ymd) : NaN;
};

const numberOr = (value) => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : NaN;
};

// Enregistrements → table (mêmes colonnes que findsTable). Champs d'un
// enregistrement : day (numéro de jour, requis), published (jour ou NaN),
// endDay (jour où l'élément cesse d'être actif, ou NaN), kind (0 géocache,
// 1 Lab), code, difficulty, terrain, attributes ([] ) et les champs texte de
// DICT_FIELDS ('' ou absent = inconnu).
export function tableFromRecords(records, { source = 'records' } = {}) {
    const rows = records.filter((r) => Number.isFinite(r.day));
    const n = rows.length;
    const table = {
        source,
        n,
        undated: records.length - n,
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
        endDay: new Float64Array(n),
        kind: new Uint8Array(n),
        difficulty: new Float64Array(n),
        terrain: new Float64Array(n),
        code: new Array(n),
        attributes: new Array(n),
        dicts: { attribute: [] },
        extent: null,
    };
    const indexes = {};
    for (const field of DICT_FIELDS) {
        table[field] = new Int32Array(n);
        table.dicts[field] = [];
        indexes[field] = new Map();
    }
    let first = Infinity;
    let last = -Infinity;
    for (let r = 0; r < n; r++) {
        const rec = rows[r];
        const day = rec.day;
        const ymd = ymdOfDay(day);
        table.day[r] = day;
        table.y[r] = ymd.y;
        table.m[r] = ymd.m;
        table.d[r] = ymd.d;
        table.weekday[r] = isoWeekday(day);
        table.week[r] = isoWeek(day);
        table.doy[r] = dayOfYearSlot(ymd.m, ymd.d);
        if (day < first) first = day;
        if (day > last) last = day;
        // Un archivage prolonge l'étendue : « toutes les données » doit
        // couvrir la disparition de la dernière cache.
        if (Number.isFinite(rec.endDay) && rec.endDay > last) last = rec.endDay;
        const pub = Number.isFinite(rec.published) ? rec.published : NaN;
        table.published[r] = pub;
        const pubYmd = Number.isFinite(pub) ? ymdOfDay(pub) : null;
        table.publishedYear[r] = pubYmd ? pubYmd.y : 0;
        const bucket = pubYmd ? ageBucket(pubYmd, ymd) : null;
        table.age[r] = bucket === null ? NO_VALUE : bucket;
        table.ageDays[r] = Number.isFinite(pub) && day >= pub ? day - pub : NaN;
        table.endDay[r] = Number.isFinite(rec.endDay) ? rec.endDay : NaN;
        table.kind[r] = rec.kind === 1 ? 1 : 0;
        table.code[r] = rec.code || null;
        table.difficulty[r] = numberOr(rec.difficulty);
        table.terrain[r] = numberOr(rec.terrain);
        table.attributes[r] = [];
        for (const field of DICT_FIELDS) {
            const raw = rec[field];
            const value = raw === null || raw === undefined ? '' : String(raw).trim();
            if (!value) {
                table[field][r] = NO_VALUE;
                continue;
            }
            let idx = indexes[field].get(value);
            if (idx === undefined) {
                idx = table.dicts[field].length;
                indexes[field].set(value, idx);
                table.dicts[field].push(value);
            }
            table[field][r] = idx;
        }
    }
    if (n) table.extent = { first, last };
    return table;
}

// Propriétés communes d'une feature (DNF, caches posées).
function featureRecord(props) {
    return {
        published: isoDay(props.published_date),
        code: props.gc_code || props.record_uid || null,
        difficulty: props.difficulty,
        terrain: props.terrain,
        cache_type: props.cache_type,
        container: props.container,
        country: props.country,
        state: props.state,
        owner: props.owner,
    };
}

// Mes DNF : un enregistrement par log « Didn't find it ».
export function dnfTable(payload) {
    const records = [];
    for (const feature of payload?.features || []) {
        const props = feature?.properties || {};
        const base = featureRecord(props);
        const dates = Array.isArray(props.dnf_dates) && props.dnf_dates.length ? props.dnf_dates : [props.date_find];
        for (const date of dates) records.push({ ...base, day: isoDay(date) });
    }
    return tableFromRecords(records, { source: 'dnf' });
}

// Jour où une cache posée cesse d'être active : son dernier passage à
// l'état archivé (2), s'il est encore archivé à la fin de l'historique.
function archivedDay(states) {
    if (!Array.isArray(states) || !states.length) return NaN;
    const lastChange = states[states.length - 1];
    return lastChange?.[1] === 2 ? isoDay(lastChange[0]) : NaN;
}

// Mes caches posées : un enregistrement par cache, au jour de sa pose. Le
// propriétaire est le joueur : pas de colonne « propriétaire ».
export function ownedTable(payload) {
    const records = (payload?.features || []).map((feature) => {
        const props = feature?.properties || {};
        return {
            ...featureRecord(props),
            owner: null,
            published: NaN,
            day: isoDay(props.date_find),
            endDay: archivedDay(props.owner_states),
        };
    });
    return tableFromRecords(records, { source: 'owned' });
}

// Mes poses : un enregistrement par log reçu sur une cache posée — les
// trouvailles, les DNF et les favoris (trouvaille portant un favori).
export function posesTables(payload) {
    const empty = () => tableFromRecords([], { source: 'poses' });
    if (!payload || !Number.isInteger(payload.count) || !payload.count || !payload.ev) {
        return { received: empty(), dnf: empty(), favorites: empty() };
    }
    const origin = isoDay(payload.origin);
    const kinds = Array.isArray(payload.logKinds) ? payload.logKinds : [];
    const FIND = kinds.indexOf('find');
    const DNF = kinds.indexOf('dnf');
    const dict = (list, i) => (Array.isArray(list) && i >= 0 ? list[i] : '');
    const caches = Array.from({ length: payload.count }, (_, k) => ({
        code: payload.code?.[k] || null,
        cache: payload.name?.[k] || payload.code?.[k] || '',
        published: origin + payload.placed[k],
        cache_type: dict(payload.types, payload.type?.[k]),
        container: dict(payload.sizes, payload.size?.[k]),
        difficulty: dict(payload.difficulties, payload.difficulty?.[k]),
        terrain: dict(payload.terrains, payload.terrain?.[k]),
        country: dict(payload.countries, payload.country?.[k]),
        state: dict(payload.regions, payload.region?.[k]),
    }));
    const out = { received: [], dnf: [], favorites: [] };
    const ev = payload.ev;
    for (let i = 0; i < ev.day.length; i++) {
        const base = caches[ev.cache[i]];
        if (!base) continue;
        const record = { ...base, day: origin + ev.day[i], finder: dict(payload.authors, ev.author?.[i]) };
        if (ev.kind[i] === FIND) {
            out.received.push(record);
            if (ev.fav?.[i]) out.favorites.push(record);
        } else if (ev.kind[i] === DNF) {
            out.dnf.push(record);
        }
    }
    return {
        received: tableFromRecords(out.received, { source: 'poses.received' }),
        dnf: tableFromRecords(out.dnf, { source: 'poses.dnf' }),
        favorites: tableFromRecords(out.favorites, { source: 'poses.favorites' }),
    };
}

// Jeu Évolution : les caches publiées (au jour de publication, actives
// jusqu'à leur archivage) et les archivages datés. Une cache archivée sans
// date d'archivage compte parmi les publiées mais jamais parmi les actives
// (impossible de dire quand elle a disparu) ni parmi les archivages.
export function evolutionTables(payload) {
    const placed = [];
    const archived = [];
    if (payload && Number.isInteger(payload.count)) {
        const origin = isoDay(payload.origin);
        const dict = (list, i) => (Array.isArray(list) && i >= 0 ? list[i] : '');
        for (let k = 0; k < payload.count; k++) {
            const day = origin + payload.placed[k];
            const archivedOn = payload.archived[k] >= 0 ? origin + payload.archived[k] : NaN;
            const base = {
                code: payload.code?.[k] || null,
                cache_type: dict(payload.types, payload.type?.[k]),
                container: dict(payload.sizes, payload.size?.[k]),
                difficulty: dict(payload.difficulties, payload.difficulty?.[k]),
                terrain: dict(payload.terrains, payload.terrain?.[k]),
                country: dict(payload.countries, payload.country?.[k]),
                state: dict(payload.regions, payload.region?.[k]),
                county: dict(payload.counties, payload.county?.[k]),
            };
            const noDate = payload.status?.[k] === 2;
            placed.push({ ...base, day, endDay: noDate ? day : archivedOn });
            if (Number.isFinite(archivedOn)) archived.push({ ...base, day: archivedOn });
        }
    }
    return {
        placed: tableFromRecords(placed, { source: 'evolution' }),
        archived: tableFromRecords(archived, { source: 'evolution:archived' }),
    };
}
