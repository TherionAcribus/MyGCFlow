// Panneaux de statistiques : modèle pur (réglages, comptage, grilles, mise en page).
//
// Les panneaux (matrice D/T, Jasmer, calendrier 366, histogrammes) se
// remplissent au fil de l'animation. Le comptage est INCRÉMENTAL et partagé :
// un seul accumulateur pour tous les panneaux, alimenté jour après jour par
// les caches qui apparaissent — le coût par jour est proportionnel aux
// nouvelles caches, pas au nombre de panneaux ni à la taille de la sélection.
//
// Tout ce qui structure un graphe (échelle, ordre des lignes, top-N, bornes)
// vient d'une RÉFÉRENCE (les comptes en fin d'animation), jamais de l'état
// courant : sinon les barres se redimensionneraient et changeraient de rang à
// chaque jour.
//
// Aucune dépendance au DOM : logique testable par `node --test`
// (test_stats_model.mjs). Le dessin vit dans stats_render.mjs, le cycle de vie
// dans stats_panels.js.

// ---------------------------------------------------------------------------
// Réglages — miroir exact de stats_settings.py. Les deux côtés passent les
// mêmes vecteurs (tests/fixtures/stats/settings_cases.json).
// ---------------------------------------------------------------------------

export const STATS_MAX_PANELS = 6;

export const STATS_METRICS_BY_KIND = Object.freeze({
    grid: Object.freeze(['dt', 'jasmer', 'calendar']),
    bar: Object.freeze(['cache_type', 'container', 'difficulty', 'terrain', 'year']),
});
export const STATS_KINDS = Object.freeze(Object.keys(STATS_METRICS_BY_KIND));

export const STATS_ANCHORS = Object.freeze([
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right',
]);

export const STATS_HIGHLIGHTS = Object.freeze(['new', 'every', 'none']);
export const STATS_CELL_MODES = Object.freeze(['count', 'filled', 'heat']);
export const STATS_SORTS = Object.freeze(['natural', 'count', 'label']);
export const STATS_ORIENTATIONS = Object.freeze(['horizontal', 'vertical']);
export const STATS_PALETTES = Object.freeze(['gc', 'accent', 'heat']);

export const STATS_OFFSET_RANGE = Object.freeze([0, 2000]);
export const STATS_WIDTH_RANGE = Object.freeze([120, 1200]);
export const STATS_MAX_ITEMS_RANGE = Object.freeze([3, 30]);
export const STATS_OPACITY_RANGE = Object.freeze([0, 100]);
export const STATS_FONT_SIZE_RANGE = Object.freeze([8, 32]);
export const STATS_RADIUS_RANGE = Object.freeze([0, 40]);
export const STATS_TITLE_MAX = 80;

export const STATS_DEFAULTS = Object.freeze({ enabled: true, panels: Object.freeze([]) });

const ID_RE = /^[0-9a-f]{6,32}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Même règle que _NUMERIC_RE côté serveur : « 12 », « -3 », « 12.5 », rien d'autre.
const NUMERIC_RE = /^[ \t]*-?[0-9]+(?:\.[0-9]+)?[ \t]*$/;

function intIn(value, fallback, [min, max]) {
    let number = null;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && NUMERIC_RE.test(value)) number = Number(value);
    if (number === null || !Number.isFinite(number)) return fallback;
    // Math.round = arrondi au demi supérieur, que le serveur reproduit
    // (floor(x + 0.5)) plutôt que l'arrondi au pair de round().
    return Math.max(min, Math.min(max, Math.round(number)));
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const choice = (value, choices, fallback) => (
    typeof value === 'string' && choices.includes(value) ? value : fallback
);

function color(value, fallback) {
    if (typeof value !== 'string' || !HEX_RE.test(value)) return fallback;
    // Forme longue : le sélecteur couleur HTML n'accepte pas « #abc ».
    return value.length === 4
        ? `#${value.slice(1).split('').map((c) => c + c).join('')}`
        : value;
}

function title(value) {
    if (typeof value !== 'string') return '';
    const flat = value.replace(/\r\n/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ');
    // Tronqué en points de code, comme le slicing Python (un emoji = 1).
    return Array.from(flat).slice(0, STATS_TITLE_MAX).join('');
}

// Valeurs par défaut d'un panneau, fonction de sa métrique : les grandeurs
// ordonnées (tailles, D/T, années) gardent leur ordre naturel, seuls les
// types — sans ordre propre — sont triés par nombre de trouvailles.
export function statsPanelDefaults(kind, metric) {
    let options;
    let palette;
    if (kind === 'grid') {
        options = {
            show_values: true,
            show_percent: false,
            highlight: 'new',
            cell_mode: metric === 'dt' ? 'count' : 'filled',
            show_coverage: true,
        };
        palette = 'heat';
    } else {
        options = {
            show_values: true,
            show_percent: false,
            highlight: 'every',
            sort: metric === 'cache_type' ? 'count' : 'natural',
            orientation: metric === 'cache_type' || metric === 'container' ? 'horizontal' : 'vertical',
            max_items: 8,
            hide_empty: false,
        };
        palette = metric === 'cache_type' ? 'gc' : 'accent';
    }
    return {
        enabled: true,
        show_title: true,
        title: '',
        position: { anchor: 'top-left', dx: 16, dy: 16, width: 280 },
        options,
        style: {
            background: '#0b1a2b',
            background_opacity: 85,
            text_color: '#ffffff',
            accent_color: '#29d34e',
            palette,
            font_size: 12,
            radius: 10,
            inherit_font: true,
        },
    };
}

const OPTION_COERCERS = {
    show_values: bool,
    show_percent: bool,
    highlight: (v, d) => choice(v, STATS_HIGHLIGHTS, d),
    cell_mode: (v, d) => choice(v, STATS_CELL_MODES, d),
    show_coverage: bool,
    sort: (v, d) => choice(v, STATS_SORTS, d),
    orientation: (v, d) => choice(v, STATS_ORIENTATIONS, d),
    max_items: (v, d) => intIn(v, d, STATS_MAX_ITEMS_RANGE),
    hide_empty: bool,
};

const STYLE_COERCERS = {
    background: color,
    background_opacity: (v, d) => intIn(v, d, STATS_OPACITY_RANGE),
    text_color: color,
    accent_color: color,
    palette: (v, d) => choice(v, STATS_PALETTES, d),
    font_size: (v, d) => intIn(v, d, STATS_FONT_SIZE_RANGE),
    radius: (v, d) => intIn(v, d, STATS_RADIUS_RANGE),
    inherit_font: bool,
};

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function coerceBlock(raw, defaults, coercers) {
    const source = isObject(raw) ? raw : {};
    const out = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        out[key] = coercers[key](source[key], fallback);
    }
    return out;
}

// Panneau normalisé, ou null s'il n'est pas représentable (type ou métrique
// inconnus, combinaison invalide). L'unicité de l'identifiant est vérifiée
// par normalizeStatsSettings.
export function normalizeStatsPanel(raw) {
    if (!isObject(raw)) return null;
    const { kind, metric } = raw;
    if (typeof kind !== 'string' || !Object.hasOwn(STATS_METRICS_BY_KIND, kind)) return null;
    if (!STATS_METRICS_BY_KIND[kind].includes(metric)) return null;
    const defaults = statsPanelDefaults(kind, metric);
    const position = isObject(raw.position) ? raw.position : {};
    const pd = defaults.position;
    return {
        id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '',
        kind,
        metric,
        enabled: bool(raw.enabled, defaults.enabled),
        show_title: bool(raw.show_title, defaults.show_title),
        title: title(raw.title),
        position: {
            anchor: choice(position.anchor, STATS_ANCHORS, pd.anchor),
            dx: intIn(position.dx, pd.dx, STATS_OFFSET_RANGE),
            dy: intIn(position.dy, pd.dy, STATS_OFFSET_RANGE),
            width: intIn(position.width, pd.width, STATS_WIDTH_RANGE),
        },
        options: coerceBlock(raw.options, defaults.options, OPTION_COERCERS),
        style: coerceBlock(raw.style, defaults.style, STYLE_COERCERS),
    };
}

export function newStatsPanelId(random = Math.random) {
    let id = '';
    for (let i = 0; i < 12; i++) id += Math.floor(random() * 16).toString(16);
    return id;
}

// Bloc `stats` normalisé. Patch de premier niveau, comme le serveur : une
// clé absente garde la valeur de `current`.
export function normalizeStatsSettings(raw, current = STATS_DEFAULTS, newId = newStatsPanelId) {
    const base = isObject(current) ? current : STATS_DEFAULTS;
    if (!isObject(raw)) {
        return { enabled: bool(base.enabled, true), panels: Array.isArray(base.panels) ? [...base.panels] : [] };
    }
    const enabled = bool(raw.enabled, bool(base.enabled, true));
    const source = Object.hasOwn(raw, 'panels') ? raw.panels : base.panels;
    const panels = [];
    const seen = new Set();
    for (const item of Array.isArray(source) ? source : []) {
        const panel = normalizeStatsPanel(item);
        if (!panel) continue;
        while (!panel.id || seen.has(panel.id)) panel.id = newId();
        seen.add(panel.id);
        panels.push(panel);
        if (panels.length >= STATS_MAX_PANELS) break;
    }
    return { enabled, panels };
}

// Nouveau panneau prêt à l'emploi (bouton « Ajouter », modèles) : défauts de
// la métrique, surchargés par `overrides` (position, options…).
export function createStatsPanel(kind, metric, overrides = {}, newId = newStatsPanelId) {
    const defaults = statsPanelDefaults(kind, metric);
    return normalizeStatsPanel({
        ...defaults,
        ...overrides,
        id: newId(),
        kind,
        metric,
        position: { ...defaults.position, ...(overrides.position || {}) },
        options: { ...defaults.options, ...(overrides.options || {}) },
        style: { ...defaults.style, ...(overrides.style || {}) },
    });
}

// Métriques à compter pour une liste de panneaux : seuls les panneaux actifs
// coûtent quelque chose.
export function metricsForPanels(settings) {
    const metrics = new Set();
    if (!settings?.enabled) return metrics;
    for (const panel of settings.panels || []) {
        if (panel.enabled) metrics.add(panel.metric);
    }
    return metrics;
}

// ---------------------------------------------------------------------------
// Bucketisation : clé d'une cache pour une métrique, ou null (exclue).
// ---------------------------------------------------------------------------

// Difficulté/terrain 1 → 5 par demi-points : index 0 → 8. Non numérique (Labs,
// donnée absente) → -1.
export function dtIndex(value) {
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) return -1;
    return Math.max(0, Math.min(8, Math.round((value - 1) * 2)));
}

// « YYYY-MM-DD » → { y, m, d } sans passer par Date (une par cache sinon).
export function parseYmd(value) {
    if (typeof value !== 'string' || value.length < 10) return null;
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(5, 7));
    const d = Number(value.slice(8, 10));
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y, m, d };
}

// Première publication de géocache : mai 2000. Une date antérieure est une
// donnée corrompue — exclue de la grille Jasmer plutôt que d'en élargir l'axe.
export const JASMER_START = Object.freeze({ y: 2000, m: 5 });

export const UNKNOWN_KEY = 'unknown';

const KEY_OF = {
    dt(p) {
        const d = dtIndex(p.difficulty);
        const t = dtIndex(p.terrain);
        return d < 0 || t < 0 ? null : d * 9 + t;
    },
    jasmer(p) {
        const date = parseYmd(p.published_date);
        if (!date) return null;
        if (date.y < JASMER_START.y || (date.y === JASMER_START.y && date.m < JASMER_START.m)) return null;
        return date.y * 100 + date.m;
    },
    calendar(p) {
        const date = parseYmd(p.date_find);
        return date ? date.m * 100 + date.d : null;
    },
    cache_type(p) {
        return typeof p.cache_type === 'string' && p.cache_type.trim() ? p.cache_type : UNKNOWN_KEY;
    },
    container(p) {
        const value = typeof p.container === 'string' ? p.container.trim() : '';
        return value && value.toLowerCase() !== 'unknown' ? value : UNKNOWN_KEY;
    },
    difficulty(p) {
        const i = dtIndex(p.difficulty);
        return i < 0 ? null : i;
    },
    terrain(p) {
        const i = dtIndex(p.terrain);
        return i < 0 ? null : i;
    },
    year(p) {
        const date = parseYmd(p.date_find);
        return date ? date.y : null;
    },
};

export function statsKeyOf(metric, properties) {
    const fn = KEY_OF[metric];
    return fn ? fn(properties || {}) : null;
}

// ---------------------------------------------------------------------------
// Accumulateur
// ---------------------------------------------------------------------------

// `metrics` : itérable des métriques à compter (metricsForPanels). Les autres
// ne coûtent rien.
//
// lastHit[metric] : clé → { at, newAt } — horloge du dernier incrément et du
// déblocage (passage de 0 à 1). Sert au surlignage ; ajouter sans horloge
// (`at` null : état initial, totaux) ne surligne rien.
export function createStatsAccumulator(metrics = []) {
    const list = [...new Set(metrics)].filter((m) => Object.hasOwn(KEY_OF, m));
    const acc = {
        metrics: list,
        total: 0,
        counts: new Map(),
        excluded: new Map(),
        lastHit: new Map(),
        revision: 0,
        reset() {
            acc.total = 0;
            for (const metric of list) {
                acc.counts.set(metric, new Map());
                acc.excluded.set(metric, 0);
                acc.lastHit.set(metric, new Map());
            }
            acc.revision += 1;
            return acc;
        },
        add(features, at = null) {
            if (!features || features.length === 0) return acc;
            const hasClock = Number.isFinite(at);
            for (const feature of features) {
                const properties = feature?.properties || feature?.getProperties?.() || {};
                acc.total += 1;
                for (const metric of list) {
                    const key = KEY_OF[metric](properties);
                    if (key === null) {
                        acc.excluded.set(metric, acc.excluded.get(metric) + 1);
                        continue;
                    }
                    const counts = acc.counts.get(metric);
                    const before = counts.get(key) || 0;
                    counts.set(key, before + 1);
                    if (hasClock) {
                        const hits = acc.lastHit.get(metric);
                        const hit = hits.get(key) || { at: null, newAt: null };
                        hit.at = at;
                        if (before === 0) hit.newAt = at;
                        hits.set(key, hit);
                    }
                }
            }
            acc.revision += 1;
            return acc;
        },
        count(metric, key) {
            return acc.counts.get(metric)?.get(key) || 0;
        },
    };
    return acc.reset();
}

// Comptes statiques d'une liste de caches (totaux, référence).
export function countFeatures(features, metrics) {
    return createStatsAccumulator(metrics).add(features);
}

// Caches d'un index par jour (clés `Date.toDateString()`, comme
// bdd.js › pointsByDate) dont la date est <= `until` (toutes si absent).
export function featuresUpTo(index, until = null) {
    const out = [];
    if (!index) return out;
    const limit = until instanceof Date ? until.getTime() : null;
    for (const [key, features] of index.entries()) {
        if (!features?.length) continue;
        if (limit !== null && new Date(key).getTime() > limit) continue;
        for (const feature of features) out.push(feature);
    }
    return out;
}

// Intensité du surlignage d'une clé à l'instant `now` : 1 au moment de
// l'incrément, 0 après `durationMs`. `mode` : 'new' (déblocages seulement),
// 'every' (chaque incrément), 'none'.
export function highlightLevel(hit, now, durationMs, mode) {
    if (!hit || mode === 'none' || !(durationMs > 0) || !Number.isFinite(now)) return 0;
    const at = mode === 'new' ? hit.newAt : hit.at;
    if (!Number.isFinite(at)) return 0;
    const elapsed = now - at;
    if (elapsed < 0 || elapsed >= durationMs) return 0;
    return 1 - elapsed / durationMs;
}

// Une surbrillance est-elle encore visible pour l'un des panneaux ? Tant que
// oui, ils se redessinent à chaque frame ; ensuite ils se rendorment.
export function hasActiveHighlights(acc, panels, now, durationMs) {
    for (const panel of panels) {
        const mode = panel.options?.highlight;
        if (!mode || mode === 'none') continue;
        const hits = acc.lastHit.get(panel.metric);
        if (!hits) continue;
        for (const hit of hits.values()) {
            if (highlightLevel(hit, now, durationMs, mode) > 0) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Grilles
// ---------------------------------------------------------------------------

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const DT_LABELS = Object.freeze(
    Array.from({ length: 9 }, (_, i) => 1 + i / 2),
);

// Géométrie logique d'une grille. `context.end` ({ y, m }) borne Jasmer : les
// mois postérieurs à la fin de l'animation sont désactivés.
//   rows/cols  : nombre de lignes/colonnes
//   rowKeys    : valeur portée par chaque ligne (D, année, mois)
//   colKeys    : idem pour les colonnes (T, mois, jour)
//   keyAt(r,c) : clé de comptage de la case (KEY_OF)
//   disabled(r,c) : case impossible (avant mai 2000, 30 février…)
export function gridSpec(metric, context = {}) {
    if (metric === 'dt') {
        return {
            metric,
            rows: 9,
            cols: 9,
            rowKeys: DT_LABELS,
            colKeys: DT_LABELS,
            keyAt: (r, c) => r * 9 + c,
            disabled: () => false,
        };
    }
    if (metric === 'jasmer') {
        const end = context.end && Number.isInteger(context.end.y)
            ? context.end
            : { y: JASMER_START.y, m: 12 };
        const lastYear = Math.max(JASMER_START.y, end.y);
        const rowKeys = [];
        for (let y = JASMER_START.y; y <= lastYear; y++) rowKeys.push(y);
        return {
            metric,
            rows: rowKeys.length,
            cols: 12,
            rowKeys,
            colKeys: Array.from({ length: 12 }, (_, i) => i + 1),
            keyAt: (r, c) => rowKeys[r] * 100 + (c + 1),
            disabled: (r, c) => {
                const y = rowKeys[r];
                const m = c + 1;
                if (y === JASMER_START.y && m < JASMER_START.m) return true;
                return y > end.y || (y === end.y && m > end.m);
            },
        };
    }
    if (metric === 'calendar') {
        return {
            metric,
            rows: 12,
            cols: 31,
            rowKeys: Array.from({ length: 12 }, (_, i) => i + 1),
            colKeys: Array.from({ length: 31 }, (_, i) => i + 1),
            keyAt: (r, c) => (r + 1) * 100 + (c + 1),
            disabled: (r, c) => c + 1 > DAYS_IN_MONTH[r],
        };
    }
    return null;
}

// Modèle d'affichage d'une grille : cases, max de référence, couverture.
//   current   : accumulateur courant (ce qui est déjà apparu)
//   reference : accumulateur de référence (fin d'animation) — échelle
export function gridModel(metric, current, reference, context = {}) {
    const spec = gridSpec(metric, context);
    if (!spec) return null;
    const counts = current.counts.get(metric) || new Map();
    const refCounts = (reference || current).counts.get(metric) || new Map();
    let max = 0;
    let available = 0;
    let filled = 0;
    const cells = new Array(spec.rows * spec.cols);
    for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
            const disabled = spec.disabled(r, c);
            const key = spec.keyAt(r, c);
            const count = disabled ? 0 : (counts.get(key) || 0);
            if (!disabled) {
                available += 1;
                if (count > 0) filled += 1;
                max = Math.max(max, refCounts.get(key) || 0, count);
            }
            cells[r * spec.cols + c] = { key, count, disabled };
        }
    }
    return {
        ...spec,
        cells,
        max,
        filled,
        available,
        excluded: current.excluded.get(metric) || 0,
    };
}

// ---------------------------------------------------------------------------
// Histogrammes : lignes dans un ordre FIGÉ sur la référence
// ---------------------------------------------------------------------------

export const OTHERS_KEY = '__others__';

// Ordre naturel des tailles (valeurs groundspeak:container) ; une valeur
// inconnue de la liste suit, par ordre alphabétique, avant « Inconnu ».
export const CONTAINER_ORDER = Object.freeze([
    'Nano', 'Micro', 'Small', 'Regular', 'Large', 'Other', 'Virtual', 'Not chosen',
]);

const CATEGORICAL = new Set(['cache_type', 'container']);

function naturalCompare(metric, labelOf) {
    if (metric === 'container') {
        const rank = (key) => {
            if (key === UNKNOWN_KEY) return CONTAINER_ORDER.length + 1;
            const i = CONTAINER_ORDER.findIndex((v) => v.toLowerCase() === String(key).toLowerCase());
            return i < 0 ? CONTAINER_ORDER.length : i;
        };
        return (a, b) => rank(a) - rank(b) || String(labelOf(a)).localeCompare(String(labelOf(b)));
    }
    if (metric === 'cache_type') {
        return (a, b) => (a === UNKNOWN_KEY) - (b === UNKNOWN_KEY)
            || String(labelOf(a)).localeCompare(String(labelOf(b)));
    }
    return (a, b) => a - b;
}

// Lignes d'un histogramme.
//   options   : options normalisées du panneau (sort, max_items, hide_empty)
//   labelOf   : clé → libellé affiché (tri « label », ordre des catégories)
// Renvoie { rows: [{ key, keys, count, refCount }], max, excluded }.
// `keys` liste les clés agrégées (ligne « Autres ») pour le surlignage.
export function barModel(metric, current, reference, options = {}, labelOf = String) {
    const counts = current.counts.get(metric) || new Map();
    const ref = reference || current;
    const refCounts = ref.counts.get(metric) || new Map();
    const countOf = (key) => counts.get(key) || 0;
    const refOf = (key) => Math.max(refCounts.get(key) || 0, countOf(key));

    let keys;
    if (metric === 'difficulty' || metric === 'terrain') {
        keys = Array.from({ length: 9 }, (_, i) => i);
    } else if (metric === 'year') {
        const years = [...refCounts.keys(), ...counts.keys()];
        if (years.length) {
            const min = Math.min(...years);
            const max = Math.max(...years);
            keys = [];
            for (let y = min; y <= max; y++) keys.push(y);
        } else {
            keys = [];
        }
    } else {
        keys = [...new Set([...refCounts.keys(), ...counts.keys()])];
    }

    if (options.hide_empty) keys = keys.filter((key) => refOf(key) > 0);

    const natural = naturalCompare(metric, labelOf);
    const sort = options.sort || 'natural';
    if (sort === 'count') {
        keys.sort((a, b) => refOf(b) - refOf(a) || natural(a, b));
    } else if (sort === 'label') {
        keys.sort((a, b) => String(labelOf(a)).localeCompare(String(labelOf(b))) || natural(a, b));
    } else {
        keys.sort(natural);
    }

    let rows = keys.map((key) => ({ key, keys: [key], count: countOf(key), refCount: refOf(key) }));

    // Top-N + « Autres » : seulement pour les catégories (types, tailles). Les
    // grandeurs ordonnées (D/T, années) s'affichent en entier, sans trou.
    const maxItems = Number.isInteger(options.max_items) ? options.max_items : 8;
    if (CATEGORICAL.has(metric) && rows.length > maxItems) {
        // Les gardées : les plus fréquentes de la RÉFÉRENCE, affichées dans
        // l'ordre choisi — un type qui dépasse un autre en cours d'animation
        // ne change ni de rang ni d'appartenance au top.
        const kept = new Set(
            [...rows].sort((a, b) => b.refCount - a.refCount || natural(a.key, b.key))
                .slice(0, maxItems - 1)
                .map((row) => row.key),
        );
        const others = { key: OTHERS_KEY, keys: [], count: 0, refCount: 0 };
        rows = rows.filter((row) => {
            if (kept.has(row.key)) return true;
            others.keys.push(row.key);
            others.count += row.count;
            others.refCount += row.refCount;
            return false;
        });
        rows.push(others);
    }

    const max = rows.reduce((m, row) => Math.max(m, row.refCount), 0);
    return { rows, max, excluded: current.excluded.get(metric) || 0, total: ref.total };
}

// ---------------------------------------------------------------------------
// Mise en page : ancres et empilement
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Positionne les panneaux visibles dans un conteneur `{ width, height }`.
// items : [{ id, anchor, dx, dy, width, height }] dans l'ordre de la liste.
//
// Les panneaux d'une même ancre forment une pile, du coin vers l'intérieur :
// le premier est placé par ses dx/dy, les suivants à la suite, leur `dy`
// servant d'espacement avec le précédent. Ancres centrées : `dx` (colonne
// centrale) ou la pile entière (ligne médiane) sont centrés.
//
// Renvoie Map id → { x, y, width, height, css, overflow } ; `css` exprime la
// position par rapport à l'ancre (left/right, top/bottom), convention relue
// par overlay_canvas.js pour la vidéo.
export function layoutPanels(items, container) {
    const W = Math.max(0, container?.width || 0);
    const H = Math.max(0, container?.height || 0);
    const result = new Map();
    const groups = new Map();
    for (const item of items) {
        const anchor = STATS_ANCHORS.includes(item.anchor) ? item.anchor : 'top-left';
        if (!groups.has(anchor)) groups.set(anchor, []);
        groups.get(anchor).push(item);
    }

    for (const [anchor, group] of groups) {
        const [vertical, horizontal] = anchor.split('-');
        const heights = group.map((item) => Math.max(0, item.height || 0));
        const total = heights.reduce((s, h) => s + h, 0)
            + group.slice(1).reduce((s, item) => s + (item.dy || 0), 0);

        let cursor;
        if (vertical === 'top') cursor = group[0].dy || 0;
        else if (vertical === 'bottom') cursor = H - (group[0].dy || 0);
        else cursor = (H - total) / 2;
        const stackOverflow = (vertical === 'middle' ? total : total + (group[0].dy || 0)) > H;

        group.forEach((item, i) => {
            const width = Math.min(Math.max(0, item.width || 0), W);
            const height = heights[i];
            let x;
            if (horizontal === 'left') x = item.dx || 0;
            else if (horizontal === 'right') x = W - (item.dx || 0) - width;
            else x = (W - width) / 2;

            let y;
            if (vertical === 'bottom') {
                if (i > 0) cursor -= item.dy || 0;
                y = cursor - height;
                cursor = y;
            } else {
                if (i > 0) cursor += item.dy || 0;
                y = cursor;
                cursor = y + height;
            }

            const clampedX = clamp(x, 0, Math.max(0, W - width));
            const clampedY = clamp(y, 0, Math.max(0, H - height));
            const overflow = stackOverflow || clampedX !== x || clampedY !== y || width < (item.width || 0);
            const css = {};
            if (horizontal === 'right') css.right = Math.round(W - clampedX - width);
            else css.left = Math.round(clampedX);
            if (vertical === 'bottom') css.bottom = Math.round(H - clampedY - height);
            else css.top = Math.round(clampedY);
            result.set(item.id, { x: clampedX, y: clampedY, width, height, css, overflow });
        });
    }
    return result;
}

export function rectsOverlap(a, b) {
    if (!a || !b) return false;
    return a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
}
