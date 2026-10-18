// Panneaux de statistiques posés sur la carte : cycle de vie.
//
// Relie le modèle (stats_model.mjs) et le dessin (stats_render.mjs) à
// l'application :
//   - un <canvas class="stats-panel"> par panneau dans #mapWithFrames (aperçu) ;
//   - addStatsPanelsToCanvas() pour les deux pipelines vidéo, avec la même
//     fonction de dessin et la même géométrie que l'aperçu ;
//   - un accumulateur alimenté par mapgl.js jour après jour.
//
// Branchements côté mapgl.js, volontairement minces : les jours ajoutés
// suffisent, les caches sont relues ici dans l'index par jour (bdd.js).
//   resetStatsForAnimation({ startDate, endDate, highlightMs })  — 3 démarrages
//   accumulateStatsForDates(dates, now)                          — chaque lot de jours
//   showStatsTotals()                                            — retour au repos
//   tickStatsPanels(now) → surbrillance encore active ?          — avant chaque rendu
//
// Au repos, les panneaux montrent les totaux de la sélection ; pendant
// l'animation, l'état courant, mis à l'échelle de la RÉFÉRENCE (comptes à la
// date de fin) pour que rien ne se redimensionne ni ne change de rang.
import * as pkg from './index.js';
import { isEvolutionPage } from './app_mode.mjs';
import {
    DT_LABELS,
    EVOLUTION_METRICS_BY_KIND,
    OTHERS_KEY,
    STATS_DEFAULTS,
    STATS_METRICS_BY_KIND,
    STATS_WIDTH_RANGE,
    UNKNOWN_KEY,
    barModel,
    counterValues,
    countFeatures,
    createStatsAccumulator,
    createTweenStore,
    dayNumberOfDate,
    evolutionActivePeaks,
    evolutionCounterValues,
    evolutionLineModel,
    evolutionStateAt,
    evolutionStatusAcc,
    featuresUpTo,
    gridModel,
    hasActiveHighlights,
    highlightLevel,
    layoutPanels,
    lineModel,
    metricsForPanels,
    normalizeStatsSettings,
    rectsOverlap,
    yearTicks,
    ymdOfDay,
} from './stats_model.mjs';
import { STATS_RENDERERS, drawStatsPanel, measureStatsPanel } from './stats_render.mjs';

const DEFAULT_HIGHLIGHT_MS = 600;

let settings = normalizeStatsSettings(STATS_DEFAULTS);
let metrics = new Set();
let metricsKey = '';

// 'rest' : totaux de la sélection ; 'animating' : accumulateur courant.
let mode = 'rest';
let current = createStatsAccumulator();
let animation = null;   // { startDate, endDate, lastDate, highlightMs }
let lastNow = Number.NaN;
let highlightWasActive = false;

// Mode Évolution : accumulateur à trois univers (actives / placées /
// archivées), alimenté par les événements de la chronologie ; le jour
// appliqué est un index depuis l'origin du jeu (evolution_timeline.mjs).
let evoCurrent = null;
let evoAppliedDay = null;
let evoRestMemo = null;      // { key, acc } — état des trois univers au repos
let evoPeaksMemo = null;     // { key, ref } — pics de l'ensemble actif (échelle)

// Valeurs animées (barres, parts d'anneau, compteurs, tête de courbe) : elles
// glissent vers leur cible à l'horloge des points, immédiates au repos.
const tweens = createTweenStore(DEFAULT_HIGHLIGHT_MS);

let totalsMemo = null;      // { key, acc }
let referenceMemo = null;   // { key, acc }

// Révision : tout ce qui change ce que dessinent les panneaux (comptes,
// réglages, mise en page, surbrillance qui s'estompe). Entre dans la signature
// des frames MediaRecorder : une matrice qui se remplit sur une carte immobile
// doit quand même produire des frames.
let revision = 0;
// Version des réglages appliqués : entre dans la clé du texte alternatif,
// dont le contenu dépend aussi du titre et des options affichées.
let settingsRev = 0;

const panelNodes = new Map();   // id → { canvas, alt, layout, cssWidth, drawnKey }
// Panneau sélectionné dans l'onglet Stats : le canvas porte `is-selected`,
// dont le liseré n'apparaît qu'en mode édition (cf. ui_improvements.css).
let selectedPanelId = null;
let layoutDirty = true;
let drawDirty = true;
let frameRequest = 0;
let containerSize = { width: 0, height: 0 };
let layoutWarnings = [];
let overlayRectsCache = [];
let resizeObserver = null;
let fontFamilyCache = null;

const videoCache = new Map();   // id → { canvas, key }
let videoDrawCount = 0;

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

export function getStatsSettings() {
    return settings;
}

// Applique des réglages (chargement, onglet Stats). L'aperçu suit aussitôt ;
// la persistance est l'affaire de stats_ui.js.
export function applyStatsSettings(raw) {
    // Patch de premier niveau, comme le serveur : une clé absente garde la
    // valeur COURANTE — sinon applyStatsSettings({ enabled: false }) viderait
    // localement la liste des panneaux que le serveur aurait conservée.
    settings = normalizeStatsSettings(raw, settings);
    settingsRev += 1;
    const evolution = isEvolutionPage();
    const nextMetrics = metricsForPanels(settings, { evolution });
    const nextKey = [...nextMetrics].sort().join(',');
    if (nextKey !== metricsKey) {
        metrics = nextMetrics;
        metricsKey = nextKey;
        totalsMemo = null;
        referenceMemo = null;
        evoRestMemo = null;
        evoPeaksMemo = null;
        // Métrique ajoutée en pleine animation : l'accumulateur est reconstruit
        // jusqu'au dernier jour affiché, sans relancer l'animation.
        if (mode === 'animating') {
            if (evolution && evolutionIndex()) {
                evoCurrent = evolutionStateAt(evolutionIndex(), metrics, evoAppliedDay ?? -1);
            } else if (!evolution) {
                rebuildCurrent();
            }
        } else if (!evolution) {
            current = createStatsAccumulator(metrics);
        }
    }
    videoCache.clear();
    fontFamilyCache = null;
    invalidateStatsLayout();
    return settings;
}

function visiblePanels() {
    if (!settings.enabled) return [];
    // Une liste par mode (stats.panels / stats.evolution_panels) ; le filtre
    // par registre masque un éventuel panneau à métrique étrangère, gardé
    // tel quel dans sa liste (badge « autre mode » côté stats_ui).
    if (isEvolutionPage()) {
        if (!evolutionIndex()) return [];
        return (settings.evolution_panels || []).filter((panel) => panel.enabled
            && STATS_RENDERERS[panel.kind]
            && (EVOLUTION_METRICS_BY_KIND[panel.kind] || []).includes(panel.metric));
    }
    if (!(pkg.hasDatabase?.() ?? false)) return [];
    return (settings.panels || []).filter((panel) => panel.enabled && STATS_RENDERERS[panel.kind]
        && (STATS_METRICS_BY_KIND[panel.kind] || []).includes(panel.metric));
}

// Index de la sélection Évolution (chronologie + features + révision), ou
// null tant qu'aucune base n'est ouverte — evolution_data.js ›
// evolutionStatsIndex.
function evolutionIndex() {
    return pkg.evolutionStatsIndex?.() || null;
}

// ---------------------------------------------------------------------------
// Comptage
// ---------------------------------------------------------------------------

function indexFeaturesUpTo(until) {
    const visible = featuresUpTo(pkg.pointsByDate, until);
    const hidden = featuresUpTo(pkg.hiddenPointsByDate, until);
    for (const feature of hidden) visible.push(feature);
    return visible;
}

function indexRevision() {
    return Number(pkg.pointsByDateRevision) || 0;
}

// Totaux de la sélection filtrée (locationless masquées comprises, comme le
// compteur de caches), recalculés une fois par changement de sélection.
function selectionTotals() {
    const key = `${indexRevision()}|${metricsKey}`;
    if (totalsMemo?.key !== key) {
        totalsMemo = { key, acc: countFeatures(indexFeaturesUpTo(null), metrics) };
    }
    return totalsMemo.acc;
}

// Comptes à la date de fin de l'animation : l'échelle, l'ordre et les bornes
// des graphes. Égaux aux totaux sans date de fin imposée.
function animationReference() {
    const end = animation?.endDate instanceof Date ? animation.endDate : null;
    const lastFind = pkg.metadata?.endDate instanceof Date ? pkg.metadata.endDate : null;
    if (!end || (lastFind && end.getTime() >= lastFind.getTime())) return selectionTotals();
    const key = `${indexRevision()}|${metricsKey}|${end.getTime()}`;
    if (referenceMemo?.key !== key) {
        referenceMemo = { key, acc: countFeatures(indexFeaturesUpTo(end), metrics) };
    }
    return referenceMemo.acc;
}

function rebuildCurrent() {
    current = createStatsAccumulator(metrics);
    if (!animation) return;
    const until = animation.lastDate
        || new Date(animation.startDate.getTime() - 1);
    current.add(indexFeaturesUpTo(until));
}

function featuresOfDates(dates) {
    const out = [];
    for (const date of dates) {
        const key = date.toDateString();
        const visible = pkg.pointsByDate?.get(key);
        if (visible) for (const feature of visible) out.push(feature);
        const hidden = pkg.hiddenPointsByDate?.get(key);
        if (hidden) for (const feature of hidden) out.push(feature);
    }
    return out;
}

// --- Mode Évolution ------------------------------------------------------------
//
// État des trois univers au jour de repos (fin de plage affichée) — l'échelle
// des cumuls placées/archivées, l'état de l'ensemble actif au repos et les
// catégories distinctes des compteurs.
function evolutionRestAcc() {
    const index = evolutionIndex();
    if (!index) return null;
    // restDay dépend de la date de fin choisie (onglet Animation), pas de la
    // révision des données : il fait partie de la clé, sinon l'état calculé
    // avant le changement de borne resterait servi indéfiniment.
    const key = `${index.revision}|${index.restDay}|${metricsKey}`;
    if (evoRestMemo?.key !== key) {
        evoRestMemo = { key, acc: evolutionStateAt(index, metrics, index.restDay) };
    }
    return evoRestMemo.acc;
}

// Référence « échelle fixe » de l'univers actif : maximum de chaque clé sur
// toute la plage (les barres ne changent pas d'échelle quand l'ensemble fond).
function evolutionActivePeaksRef() {
    const index = evolutionIndex();
    if (!index) return null;
    const key = `${index.revision}|${index.restDay}|${metricsKey}`;
    if (evoPeaksMemo?.key !== key) {
        evoPeaksMemo = { key, ref: evolutionActivePeaks(index, metrics, index.restDay) };
    }
    return evoPeaksMemo.ref;
}

// Événements d'un lot de jours affichés par l'animation Évolution : poses et
// archivages (features dans l'ordre de la chronologie). Un début de lot
// antérieur au curseur — reprise d'une autre date de début — reconstruit
// l'état au jour précédent plutôt que d'appliquer par-dessus.
export function accumulateEvolutionStats(dates, placed, archived, now) {
    if (!isEvolutionPage() || !dates?.length) return;
    const index = evolutionIndex();
    if (!index) return;
    const first = index.dayOf(dates[0]);
    const last = index.dayOf(dates[dates.length - 1]);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
    if (mode !== 'animating' || !animation?.evolution) {
        mode = 'animating';
        // resetStatsForAnimation a déjà posé la vitesse réelle (ms/jour) —
        // l'objet est remplacé (drapeau `evolution`), la vitesse conservée.
        animation = {
            endDate: pkg.metadata?.endDate instanceof Date ? pkg.metadata.endDate : null,
            lastDate: dates[dates.length - 1],
            highlightMs: animation?.highlightMs ?? DEFAULT_HIGHLIGHT_MS,
            evolution: true,
        };
        tweens.clear(animation.highlightMs);
        evoCurrent = null;
    }
    animation.lastDate = dates[dates.length - 1];
    if (!evoCurrent || evoAppliedDay !== first - 1) {
        evoCurrent = evolutionStateAt(index, metrics, first - 1);
    }
    const at = Number.isFinite(now) ? now : null;
    evoCurrent.add(placed, at);
    evoCurrent.remove(archived, at);
    evoAppliedDay = last;
    if (Number.isFinite(now)) lastNow = now;
    touch();
}

function touch() {
    revision += 1;
    drawDirty = true;
    scheduleFlush();
}

// Début d'une animation (aperçu, capture image par image, MediaRecorder) :
// l'accumulateur repart des caches antérieures à la date de début, déjà
// affichées sur la carte. Une reprise de pause ne passe pas par ici.
export function resetStatsForAnimation({ startDate, endDate, highlightMs } = {}) {
    if (!(startDate instanceof Date)) return;
    animation = {
        startDate,
        endDate: endDate instanceof Date ? endDate : null,
        lastDate: null,
        highlightMs: Number.isFinite(highlightMs) && highlightMs > 0
            ? Math.min(DEFAULT_HIGHLIGHT_MS, highlightMs)
            : DEFAULT_HIGHLIGHT_MS,
    };
    mode = 'animating';
    if (isEvolutionPage()) {
        // Évolution : les trois univers repartent de l'état juste avant la
        // date de début — les panneaux affichent le départ dès la première
        // frame, sans attendre le premier lot de displayEvolutionDates.
        animation.evolution = true;
        const index = evolutionIndex();
        const day = index?.dayOf?.(startDate);
        evoAppliedDay = Number.isFinite(day) ? day - 1 : null;
        evoCurrent = index ? evolutionStateAt(index, metrics, evoAppliedDay ?? -1) : null;
    } else {
        rebuildCurrent();
    }
    tweens.clear(animation.highlightMs);
    layoutDirty = true;
    touch();
}

// Lot de jours affichés par l'animation (un ou plusieurs jours rattrapés par
// la même frame) : leurs caches, locationless masquées comprises.
export function accumulateStatsForDates(dates, now) {
    if (mode !== 'animating' || !dates?.length || metrics.size === 0) {
        if (dates?.length && animation) animation.lastDate = dates[dates.length - 1];
        return;
    }
    animation.lastDate = dates[dates.length - 1];
    if (Number.isFinite(now)) lastNow = now;
    const features = featuresOfDates(dates);
    if (features.length === 0) {
        // Jours sans trouvaille : rien à compter, mais la tête d'une courbe
        // avance quand même sur l'axe des dates — il faut redessiner.
        if (visiblePanels().some((panel) => panel.kind === 'line')) touch();
        return;
    }
    current.add(features, Number.isFinite(now) ? now : null);
    touch();
}

// Retour au repos (arrêt, abandon d'enregistrement) : totaux de la sélection.
// La fin naturelle de l'animation n'y passe pas — l'état final reste affiché,
// comme le compteur de caches.
export function showStatsTotals() {
    mode = 'rest';
    animation = null;
    current = createStatsAccumulator(metrics);
    evoCurrent = null;
    tweens.clear();
    layoutDirty = true;
    touch();
}

// Index reconstruit (filtre, import, vidage) : les mémos se périment seuls via
// pointsByDateRevision, il suffit de redessiner.
export function refreshStatsPanels() {
    // Fin naturelle puis nouveau filtre : l'état final de l'ancienne
    // sélection ne veut plus rien dire, place aux totaux de la nouvelle.
    if (mode === 'animating' && !(pkg.isAnimationInProgress?.() ?? false)) {
        mode = 'rest';
        animation = null;
        current = createStatsAccumulator(metrics);
        evoCurrent = null;
        tweens.clear();
    }
    layoutDirty = true;
    touch();
}

// Avant chaque rendu de la carte, avec l'horloge des points. Renvoie true tant
// qu'une surbrillance s'estompe : l'appelant entretient alors le rendu.
export function tickStatsPanels(now) {
    if (Number.isFinite(now)) lastNow = now;
    if (mode !== 'animating' || !animation) {
        if (drawDirty) flush();
        return false;
    }
    const panels = visiblePanels();
    const highlightActive = isEvolutionPage()
        ? hasActiveEvolutionHighlights(panels, lastNow, animation.highlightMs)
        : hasActiveHighlights(current, panels, lastNow, animation.highlightMs);
    const active = panels.length > 0 && (tweens.isActive(lastNow) || highlightActive);
    // Une surbrillance qui vient de s'éteindre demande une dernière frame.
    if (active || highlightWasActive) {
        revision += 1;
        drawDirty = true;
    }
    highlightWasActive = active;
    if (drawDirty) flush();
    return active;
}

export function getStatsRevision() {
    return revision;
}

// Surbrillance Évolution : chaque panneau lit l'horloge de SON univers
// (actives/placées à la pose, archivées à l'archivage) ; statut, courbe et
// compteurs ne surlignent pas.
function hasActiveEvolutionHighlights(panels, now, durationMs) {
    if (!evoCurrent) return false;
    for (const panel of panels) {
        const mode = panel.options?.highlight;
        if (!mode || mode === 'none') continue;
        if (panel.kind !== 'bar' && panel.kind !== 'donut') continue;
        if (panel.metric === 'status') continue;
        // Même test O(1) que hasActiveHighlights : le max des horloges de la
        // métrique décide pour toutes les clés (at monotone ≤ now, cf.
        // stats_model.mjs).
        const latest = evoCurrent.sets[panel.options.counted || 'active']?.latestHit?.get(panel.metric);
        if (latest && highlightLevel(latest, now, durationMs, mode) > 0) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Vues : modèle + libellés traduits, prêtes à dessiner
// ---------------------------------------------------------------------------

function locale() {
    return document.documentElement?.lang || 'fr';
}

let numberFormat = null;
let percentFormat = null;
function formatters() {
    const lang = locale();
    if (!numberFormat || numberFormat.lang !== lang) {
        numberFormat = { lang, fmt: new Intl.NumberFormat(lang) };
        percentFormat = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
    }
    return { number: (n) => numberFormat.fmt.format(n), percent: (r) => percentFormat.format(r) };
}

const monthNamesCache = new Map();
function monthNames(style) {
    const key = `${locale()}|${style}`;
    if (!monthNamesCache.has(key)) {
        const fmt = new Intl.DateTimeFormat(locale(), { month: style, timeZone: 'UTC' });
        monthNamesCache.set(key, Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2021, i, 1)))));
    }
    return monthNamesCache.get(key);
}

const weekdayNamesCache = new Map();
function weekdayNames(style) {
    const key = `${locale()}|${style}`;
    if (!weekdayNamesCache.has(key)) {
        const fmt = new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: 'UTC' });
        // 2024-01-01 est un lundi : l'ordre ISO commence la semaine par lundi.
        weekdayNamesCache.set(key, Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i)))));
    }
    return weekdayNamesCache.get(key);
}

// Titre par défaut d'un panneau, d'après sa métrique — aussi le nom affiché
// dans la liste de l'onglet Stats.
export function defaultStatsPanelTitle(panel) {
    switch (panel.metric) {
        case 'dt': return pkg.t('Matrice D/T');
        case 'jasmer': return pkg.t('Grille Jasmer');
        case 'calendar': return pkg.t('Calendrier 366');
        case 'cache_type': return pkg.t('Types de caches');
        case 'container': return pkg.t('Tailles');
        case 'difficulty': return pkg.t('Difficulté');
        case 'terrain': return pkg.t('Terrain');
        case 'year': return pkg.t('Trouvailles par année');
        case 'month': return pkg.t('Trouvailles par mois');
        case 'weekday': return pkg.t('Jours de la semaine');
        case 'attribute': return pkg.t('Attributs');
        case 'owner': return pkg.t('Propriétaires');
        case 'country': return pkg.t('Pays');
        case 'state': return pkg.t('Régions');
        case 'county': return pkg.t('Départements');
        case 'status': return pkg.t('Statut des caches');
        case 'actives': return pkg.t('Caches actives');
        case 'placees': return pkg.t('Poses cumulées');
        case 'archivees': return pkg.t('Archivages cumulés');
        case 'cumulative': return pkg.t('Progression des trouvailles');
        case 'summary': return pkg.t('Chiffres clés');
        default: return '';
    }
}

function categoryLabel(key) {
    if (key === OTHERS_KEY) return pkg.t('Autres');
    if (key === UNKNOWN_KEY) return pkg.t('Inconnu');
    return pkg.t(String(key));
}

function labelFor(metric, number) {
    if (metric === 'difficulty' || metric === 'terrain') {
        return (key) => (key === OTHERS_KEY ? pkg.t('Autres') : number(DT_LABELS[key]));
    }
    if (metric === 'year') return (key) => String(key);
    if (metric === 'month') return (key) => monthNames('short')[key - 1] ?? String(key);
    if (metric === 'weekday') return (key) => weekdayNames('short')[key] ?? String(key);
    if (metric === 'status') {
        return (key) => key === 'active' ? pkg.t('Caches actives') : pkg.t('Caches archivées');
    }
    return categoryLabel;
}

function excludedLine(metric, n) {
    switch (metric) {
        case 'dt': return pkg.t('Sans D/T : ${n}', { n });
        case 'difficulty': return pkg.t('Sans difficulté : ${n}', { n });
        case 'terrain': return pkg.t('Sans terrain : ${n}', { n });
        case 'jasmer': return pkg.t('Sans date de publication : ${n}', { n });
        case 'day': case 'month': case 'weekday':
            return pkg.t('Sans date de trouvaille : ${n}', { n });
        case 'attribute': return pkg.t('Sans attribut : ${n}', { n });
        default: return pkg.t('Sans date : ${n}', { n });
    }
}

function coverageLine(metric, filled, available, pct) {
    if (metric === 'dt') return pkg.t('Combinaisons : ${filled}/${available} (${pct})', { filled, available, pct });
    if (metric === 'jasmer') return pkg.t('Mois : ${filled}/${available} (${pct})', { filled, available, pct });
    return pkg.t('Jours : ${filled}/${available} (${pct})', { filled, available, pct });
}

function loopsLine(n) {
    return pkg.t('Tours de matrice : ${n}', { n });
}

function resolveFontFamily(panel) {
    if (!fontFamilyCache) {
        const infos = document.getElementById('infosFrame');
        fontFamilyCache = {
            infos: (infos && getComputedStyle(infos).fontFamily) || '',
            app: getComputedStyle(document.body).fontFamily || 'sans-serif',
        };
    }
    return (panel.style.inherit_font && fontFamilyCache.infos) || fontFamilyCache.app;
}

// Fin de la grille Jasmer : on ne peut pas avoir trouvé une cache publiée
// après sa dernière trouvaille.
function jasmerEndOf(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function jasmerEnd() {
    return jasmerEndOf((mode === 'animating' && animation?.endDate) || pkg.metadata?.endDate);
}

// Libellés d'axes d'une grille — partagés entre la vue et l'export CSV.
function gridAxisLabels(metric, model, number) {
    if (metric === 'dt') {
        // Lignes D, colonnes T : abréviations communes au français et à l'anglais.
        return { rowLabels: DT_LABELS.map(number), colLabels: DT_LABELS.map(number), corner: 'D/T' };
    }
    if (metric === 'jasmer') {
        return { rowLabels: model.rowKeys.map(String), colLabels: monthNames('narrow'), corner: '' };
    }
    return { rowLabels: monthNames('short'), colLabels: model.colKeys.map(String), corner: '' };
}

// Indice de couleur stable d'une catégorie (palette « multi ») : son rang dans
// la référence, pour qu'elle garde sa couleur quand elle change de place.
// Rang mémoïsé par révision de la référence : le tri des clés ne change qu'à
// l'ajout d'un lot, pas à chaque frame. Sans révision (accumulateur factice) :
// calcul direct.
const colorRankCache = new WeakMap();  // ref → Map<metric, {revision, ranks}>

function colorIndexer(reference, metric) {
    const compute = () => new Map(
        [...(reference.counts.get(metric) || new Map()).entries()]
            .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
            .map(([key], i) => [key, i]),
    );
    if (!Number.isFinite(reference?.revision)) {
        const ranks = compute();
        return (key) => ranks.get(key) ?? ranks.size;
    }
    let perMetric = colorRankCache.get(reference);
    let cached = perMetric?.get(metric);
    if (!cached || cached.revision !== reference.revision) {
        cached = { revision: reference.revision, ranks: compute() };
        if (!perMetric) { perMetric = new Map(); colorRankCache.set(reference, perMetric); }
        perMetric.set(metric, cached);
    }
    return (key) => cached.ranks.get(key) ?? cached.ranks.size;
}

let dateFormat = null;
function formatDay(day) {
    const lang = locale();
    if (!dateFormat || dateFormat.lang !== lang) {
        dateFormat = { lang, fmt: new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) };
    }
    const { y, m, d } = ymdOfDay(day);
    return dateFormat.fmt.format(new Date(Date.UTC(y, m - 1, d)));
}

const COUNTER_LABELS = {
    days: () => pkg.t('Jours avec trouvaille'),
    best_day: () => pkg.t('Record sur une journée'),
    streak: () => pkg.t('Plus longue série (jours)'),
    types: () => pkg.t('Types de caches différents'),
    countries: () => pkg.t('Pays'),
    states: () => pkg.t('Régions'),
    attributes: () => pkg.t('Attributs différents'),
    owners: () => pkg.t('Propriétaires différents'),
    actives: () => pkg.t('Caches actives'),
    placees: () => pkg.t('Caches posées'),
    archivees: () => pkg.t('Caches archivées'),
    peak: () => pkg.t('Pic de caches actives'),
};

// Valeurs animées des lignes d'un histogramme ou d'un anneau ; course de
// barres : la place de chaque ligne glisse aussi.
function animateRows(panel, model, now) {
    model.rows.forEach((row, i) => {
        row.shown = tweens.set(`${panel.id}:v:${row.key}`, row.count, now);
        if (model.race) row.slot = tweens.set(`${panel.id}:s:${row.key}`, i, now);
    });
    model.shownMax = tweens.set(`${panel.id}:max`, model.max, now);
}

function buildView(panel) {
    if (isEvolutionPage()) return buildEvolutionView(panel);
    const reference = mode === 'animating' ? animationReference() : selectionTotals();
    const state = mode === 'animating' ? current : reference;
    // Horloge des valeurs animées : aucune au repos (valeurs immédiates).
    const now = mode === 'animating' ? lastNow : Number.NaN;
    const { number, percent } = formatters();
    const metric = panel.metric;
    const view = {
        kind: panel.kind,
        metric,
        title: panel.show_title ? (panel.title || defaultStatsPanelTitle(panel)) : '',
        fontFamily: resolveFontFamily(panel),
        formatNumber: number,
        formatPercent: percent,
        showValues: panel.options.show_values,
        showPercent: panel.options.show_percent,
        footer: [],
        highlight: mode === 'animating' && animation
            ? { mode: panel.options.highlight, durationMs: animation.highlightMs, hits: current.lastHit.get(metric) }
            : null,
    };
    // Présence des lignes de pied décidée sur la référence : la hauteur du
    // panneau ne change pas au premier Lab rencontré.
    const refExcluded = reference.excluded.get(metric) || 0;

    if (panel.kind === 'grid') {
        const model = gridModel(metric, state, reference, { end: jasmerEnd() });
        view.model = model;
        view.cellMode = panel.options.cell_mode;
        Object.assign(view, gridAxisLabels(metric, model, number));
        if (panel.options.show_coverage) {
            view.footer.push(coverageLine(metric, model.filled, model.available,
                percent(model.available > 0 ? model.filled / model.available : 0)));
        }
        if (metric === 'dt' && panel.options.show_loops) {
            view.footer.push(loopsLine(number(model.loops)));
        }
        if (refExcluded > 0) view.footer.push(excludedLine(metric, model.excluded));
        return view;
    }

    if (panel.kind === 'line') {
        const headDay = mode === 'animating' && animation?.lastDate ? dayNumberOfDate(animation.lastDate) : undefined;
        const endDay = mode === 'animating' && animation?.endDate ? dayNumberOfDate(animation.endDate) : undefined;
        const model = lineModel(state, reference, { headDay, endDay });
        model.shownTotal = tweens.set(`${panel.id}:total`, model.total, now);
        model.shownHeadDay = tweens.set(`${panel.id}:head`, model.headDay, now);
        view.model = model;
        view.showArea = panel.options.show_area;
        // Axe : années, ou dates complètes si la période tient dans une année ;
        // jalons annuels entre les deux bords (le dessin éclaircit les
        // collisions — axe court, dates complètes plus larges qu'une année).
        if (!model.empty) {
            const sameYear = ymdOfDay(model.first).y === ymdOfDay(model.last).y;
            view.startLabel = sameYear ? formatDay(model.first) : String(ymdOfDay(model.first).y);
            view.endLabel = sameYear ? formatDay(model.last) : String(ymdOfDay(model.last).y);
        }
        view.ticks = model.empty ? [] : yearTicks(model.first, model.last);
        // Halo de la tête tant que la dernière trouvaille est fraîche.
        const lastDay = model.points.at(-1)?.day;
        view.headLevel = mode === 'animating' && animation && lastDay !== undefined
            ? highlightLevel(current.lastHit.get('day')?.get(lastDay), now, animation.highlightMs,
                panel.options.highlight === 'none' ? 'none' : 'every')
            : 0;
        if ((reference.excluded.get('day') || 0) > 0) view.footer.push(excludedLine('day', model.excluded));
        return view;
    }

    if (panel.kind === 'counter') {
        const values = counterValues(state, panel.options.items);
        view.columns = panel.options.columns;
        view.tiles = panel.options.items.map((item) => {
            const entry = values[item] || { value: 0 };
            const key = `${panel.id}:c:${item}`;
            const shown = tweens.set(key, entry.value, now);
            let detail = '';
            if (item === 'best_day' && entry.value > 0 && entry.day !== null) detail = formatDay(entry.day);
            if (item === 'streak' && entry.value > 1) detail = `${formatDay(entry.start)} → ${formatDay(entry.end)}`;
            return {
                value: number(Math.round(shown)),
                label: COUNTER_LABELS[item](),
                detail,
                level: panel.options.highlight === 'none' ? 0 : tweens.level(key, now),
            };
        });
        return view;
    }

    const labelOf = labelFor(metric, number);
    view.labelOf = labelOf;
    view.palette = panel.style.palette;
    view.colorOf = (key) => pkg.defaultGcColors?.[key] || null;
    view.colorIndex = colorIndexer(reference, metric);

    if (panel.kind === 'donut') {
        const model = barModel(metric, state, reference, { sort: 'count', max_items: panel.options.max_items }, labelOf);
        animateRows(panel, model, now);
        view.model = model;
        view.hole = panel.options.hole;
        view.showLegend = panel.options.show_legend;
        view.centerLabel = pkg.t('trouvailles');
        // Même pied « exclus » que les barres : seule `attribute` peut en
        // produire parmi les catégories (une cache sans attribut n'a pas de
        // ligne « Inconnu », elle est hors sujet).
        if (refExcluded > 0 && !['cache_type', 'container', 'country', 'state', 'owner'].includes(metric)) {
            view.footer.push(excludedLine(metric, model.excluded));
        }
        return view;
    }

    const model = barModel(metric, state, reference, panel.options, labelOf);
    if (model.race) {
        // Places fixes : la hauteur ne varie pas quand des catégories entrent.
        const known = new Set([...(reference.counts.get(metric) || new Map()).keys(), ...model.rows.map((r) => r.key)]);
        model.slots = Math.max(1, Math.min(panel.options.max_items, known.size));
    }
    animateRows(panel, model, now);
    view.model = model;
    view.orientation = panel.options.orientation;
    view.sum = model.rows.reduce((s, row) => s + Math.max(0, row.shown), 0);
    if (refExcluded > 0 && !['cache_type', 'container', 'country', 'state', 'owner'].includes(metric)) {
        view.footer.push(excludedLine(metric, model.excluded));
    }
    return view;
}

// Vue d'un panneau en mode Évolution : l'état courant est l'univers compté
// par le panneau (actives / placées / archivées) au dernier jour affiché ;
// la référence est figée sur la fin de plage — pics de l'ensemble actif pour
// « actives », état final pour les cumuls — comme les totaux du mode
// principal.
function buildEvolutionView(panel) {
    const index = evolutionIndex();
    const animating = mode === 'animating' && !!evoCurrent;
    const day = animating ? evoAppliedDay : (index?.restDay ?? 0);
    const acc = animating ? evoCurrent : evolutionRestAcc();
    const counted = panel.options.counted || 'active';
    const now = animating ? lastNow : Number.NaN;
    const { number, percent } = formatters();
    const metric = panel.metric;
    const view = {
        kind: panel.kind,
        metric,
        title: panel.show_title ? (panel.title || defaultStatsPanelTitle(panel)) : '',
        fontFamily: resolveFontFamily(panel),
        formatNumber: number,
        formatPercent: percent,
        showValues: panel.options.show_values,
        showPercent: panel.options.show_percent,
        footer: [],
        highlight: null,
    };
    if (animating && (panel.kind === 'bar' || panel.kind === 'donut') && metric !== 'status') {
        view.highlight = {
            mode: panel.options.highlight,
            durationMs: animation.highlightMs,
            hits: acc.sets[counted]?.lastHit.get(metric) || null,
        };
    }

    if (panel.kind === 'line') {
        const model = evolutionLineModel(index, metric, day);
        model.shownTotal = tweens.set(`${panel.id}:total`, model.total, now);
        model.shownHeadDay = tweens.set(`${panel.id}:head`, model.headDay, now);
        view.model = model;
        view.showArea = panel.options.show_area;
        if (!model.empty) {
            const sameYear = ymdOfDay(model.first).y === ymdOfDay(model.last).y;
            view.startLabel = sameYear ? formatDay(model.first) : String(ymdOfDay(model.first).y);
            view.endLabel = sameYear ? formatDay(model.last) : String(ymdOfDay(model.last).y);
        }
        view.ticks = model.empty ? [] : yearTicks(model.first, model.last);
        view.headLevel = 0;
        return view;
    }

    if (panel.kind === 'counter') {
        const values = evolutionCounterValues(index, day, acc?.setView('active'), panel.options.items);
        view.columns = panel.options.columns;
        view.tiles = panel.options.items.map((item) => {
            const entry = values[item] || { value: 0 };
            const key = `${panel.id}:c:${item}`;
            const shown = tweens.set(key, entry.value, now);
            return {
                value: number(Math.round(shown)),
                label: COUNTER_LABELS[item](),
                detail: '',
                level: panel.options.highlight === 'none' ? 0 : tweens.level(key, now),
            };
        });
        return view;
    }

    // Barres et anneaux : l'univers compté par « Compter », ou le statut
    // (actives vs archivées — indifférent à l'option).
    const labelOf = labelFor(metric, number);
    view.labelOf = labelOf;
    view.palette = panel.style.palette;
    view.colorOf = (key) => pkg.defaultGcColors?.[key] || null;
    let currentView;
    let referenceView;
    if (metric === 'status') {
        currentView = evolutionStatusAcc(index, day);
        referenceView = evolutionStatusAcc(index, index?.restDay ?? day, { reference: true });
    } else {
        currentView = acc?.setView(counted) || acc?.setView('active');
        referenceView = counted === 'active'
            ? evolutionActivePeaksRef()
            : evolutionRestAcc()?.setView(counted);
    }
    if (!currentView) currentView = { counts: new Map(), excluded: new Map(), total: 0 };
    if (!referenceView) referenceView = currentView;
    view.colorIndex = colorIndexer(referenceView, metric);
    const refExcluded = referenceView.excluded.get(metric) || 0;

    let model;
    if (panel.kind === 'donut') {
        model = barModel(metric, currentView, referenceView, { sort: 'count', max_items: panel.options.max_items }, labelOf);
        view.hole = panel.options.hole;
        view.showLegend = panel.options.show_legend;
        view.centerLabel = pkg.t('caches');
    } else {
        model = barModel(metric, currentView, referenceView, panel.options, labelOf);
        if (model.race) {
            const known = new Set([...(referenceView.counts.get(metric) || new Map()).keys(), ...model.rows.map((r) => r.key)]);
            model.slots = Math.max(1, Math.min(panel.options.max_items, known.size));
        }
        view.orientation = panel.options.orientation;
    }
    animateRows(panel, model, now);
    view.model = model;
    if (panel.kind !== 'donut') view.sum = model.rows.reduce((s, row) => s + Math.max(0, row.shown), 0);
    if (refExcluded > 0 && !['cache_type', 'container', 'country', 'state', 'county', 'status'].includes(metric)) {
        view.footer.push(excludedLine(metric, model.excluded));
    }
    return view;
}

// ---------------------------------------------------------------------------
// Aperçu : canvas DOM
// ---------------------------------------------------------------------------

function container() {
    return document.getElementById('mapWithFrames');
}

function ensureResizeObserver(host) {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => invalidateStatsLayout());
    resizeObserver.observe(host);
    // Le titre et les infos sont des obstacles pour les piles de coin : leur
    // taille peut changer sans que le conteneur bouge — titre retapé, modèle
    // d'infos, style ou police appliqués, bascule d'affichage (display none →
    // grid notifie aussi). Sans ça, overlayRectsCache garde la taille d'avant
    // et la pile chevauche la boîte qui a grandi (ou laisse un vide).
    for (const id of ['titleFrame', 'infosFrame']) {
        const el = document.getElementById(id);
        if (el) resizeObserver.observe(el);
    }
}

export function invalidateStatsLayout() {
    layoutDirty = true;
    touch();
}

// Aperçu en direct du glisser-déposer (stats_ui.js › pointermove) : la
// position libre est écrite en place puis la mise en page invalidée, SANS
// renormaliser le bloc ni toucher `settingsRev` — sinon le texte alternatif
// de chaque panneau serait reconstruit à chaque mouvement (des centaines de
// <li> pour un calendrier). Le commit au dépôt (stats_ui.js) renormalise.
export function previewStatsPanelPosition(id, x, y) {
    if (pkg.isAnimationInProgress?.()) return;
    const list = settings[isEvolutionPage() ? 'evolution_panels' : 'panels'] || [];
    const panel = list.find((p) => p.id === id);
    if (!panel || !Number.isFinite(x) || !Number.isFinite(y)) return;
    panel.position.mode = 'free';
    panel.position.x = Math.max(0, Math.min(1, x));
    panel.position.y = Math.max(0, Math.min(1, y));
    layoutDirty = true;
    touch();
}

// Même aperçu en direct pour la largeur (poignée du bord droit,
// stats_ui.js › bindDragAndDrop) : la hauteur se réadapte au prochain flush
// (measure dépend de la largeur). Le commit au dépôt renormalise.
export function previewStatsPanelWidth(id, width) {
    if (pkg.isAnimationInProgress?.()) return;
    const list = settings[isEvolutionPage() ? 'evolution_panels' : 'panels'] || [];
    const panel = list.find((p) => p.id === id);
    const w = Number(width);
    if (!panel || !Number.isFinite(w)) return;
    const [min, max] = STATS_WIDTH_RANGE;
    panel.position.width = Math.max(min, Math.min(max, Math.round(w)));
    layoutDirty = true;
    touch();
}

function scheduleFlush() {
    if (frameRequest || typeof requestAnimationFrame === 'undefined') return;
    frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        flush();
    });
}

function nodeFor(panel, host) {
    let node = panelNodes.get(panel.id);
    if (!node) {
        const canvas = document.createElement('canvas');
        canvas.className = 'stats-panel';
        canvas.dataset.panelId = panel.id;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.classList.toggle('is-selected', panel.id === selectedPanelId);
        // Sous le titre et les infos (z-index 100), comme dans la vidéo où ils
        // sont dessinés après les panneaux.
        const map = document.getElementById('map');
        host.insertBefore(canvas, map ? map.nextSibling : host.firstChild);
        // Équivalent textuel du canvas pour les technologies d'assistance :
        // hors écran mais dans le DOM, juste après sa boîte.
        const alt = document.createElement('div');
        alt.className = 'stats-panel-alt visually-hidden';
        canvas.insertAdjacentElement('afterend', alt);
        node = { canvas, alt, layout: null, cssWidth: 0, drawnKey: '', cssKey: '', a11yKey: '' };
        panelNodes.set(panel.id, node);
    }
    return node;
}

function removeStalePanels(keep) {
    for (const [id, node] of panelNodes) {
        if (keep.has(id)) continue;
        node.canvas.remove();
        node.alt?.remove();
        panelNodes.delete(id);
        videoCache.delete(id);
    }
}

// Rects de #titleFrame et #infosFrame dans le repère du conteneur : les piles
// de coin les contournent, un panneau libre qui les chevauche est signalé.
function overlayRects(host) {
    const base = host.getBoundingClientRect();
    const rects = [];
    for (const id of ['titleFrame', 'infosFrame']) {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === 'none') continue;
        const r = el.getBoundingClientRect();
        rects.push({ id, x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height });
    }
    return rects;
}

// Libellé d'une case de grille pour le texte alternatif : « D2/T3 »,
// « 2010-06 » ou « 14 mars » selon la métrique.
function gridCellLabel(view, r, c) {
    if (view.metric === 'dt') return `D${view.rowLabels[r]}/T${view.colLabels[c]}`;
    if (view.metric === 'jasmer') return `${view.rowLabels[r]}-${String(c + 1).padStart(2, '0')}`;
    return `${c + 1} ${view.rowLabels[r]}`;
}

// Équivalent textuel du canvas pour les technologies d'assistance : titre,
// comptes (les vrais, pas les valeurs animées) et lignes de pied, en liste.
// Reconstruit seulement quand `key` change — comptes, mode, sélection ou
// réglages — jamais à chaque frame de surbrillance. Pas de région « live » :
// le texte est lu quand l'utilisateur s'y arrête, il n'annonce rien de
// lui-même.
function refreshAltText(node, panel, view, key) {
    if (node.a11yKey === key) return;
    node.a11yKey = key;
    const { number, percent } = formatters();
    const model = view.model;
    node.alt.replaceChildren();
    const caption = document.createElement('p');
    caption.textContent = view.title || defaultStatsPanelTitle(panel);
    node.alt.appendChild(caption);
    const list = document.createElement('ul');
    const add = (text) => {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
    };
    let empty = true;
    if (view.kind === 'counter') {
        for (const tile of view.tiles) {
            add(`${tile.label} : ${tile.value}${tile.detail ? ` (${tile.detail})` : ''}`);
            empty = false;
        }
    } else if (view.kind === 'line') {
        if (!model.empty) {
            empty = false;
            add(isEvolutionPage()
                ? `${COUNTER_LABELS[view.metric]?.() || view.metric} : ${number(model.total)} (${formatDay(model.headDay)})`
                : pkg.t('${n} trouvailles au ${date}', { n: number(model.total), date: formatDay(model.headDay) }));
        }
    } else if (view.kind === 'grid') {
        for (let r = 0; r < model.rows; r++) {
            for (let c = 0; c < model.cols; c++) {
                const count = model.cells[r * model.cols + c].count;
                if (!count) continue;
                empty = false;
                add(`${gridCellLabel(view, r, c)} : ${number(count)}`);
            }
        }
    } else {
        for (const row of model.rows) {
            const label = `${view.labelOf(row.key)} : ${number(row.count)}`;
            add(view.showPercent && model.total ? `${label} (${percent(row.count / model.total)})` : label);
            empty = false;
        }
    }
    if (empty) add(isEvolutionPage() ? pkg.t('Aucune cache') : pkg.t('Aucune trouvaille'));
    for (const line of view.footer || []) add(line);
    node.alt.appendChild(list);
}

function flush() {
    drawDirty = false;
    const host = container();
    if (!host) return;
    ensureResizeObserver(host);
    const panels = visiblePanels();
    const views = new Map(panels.map((panel) => [panel.id, buildView(panel)]));
    removeStalePanels(new Set(panels.map((panel) => panel.id)));

    // Lectures de géométrie DOM seulement sur invalidation (resize, réglages,
    // changement de mode) : jamais à chaque frame d'animation.
    if (layoutDirty) {
        layoutDirty = false;
        containerSize = { width: host.clientWidth, height: host.clientHeight };
        overlayRectsCache = panels.length ? overlayRects(host) : [];
    }
    // Clé de contenu des textes alternatifs : comptes (révision de
    // l'accumulateur), mode, sélection et réglages — pas `revision`, qui
    // bouge à chaque estompe de surbrillance sans changer les chiffres.
    const evolution = isEvolutionPage();
    const altState = evolution
        ? (mode === 'animating' ? evoCurrent : evolutionRestAcc())
        : (mode === 'animating' ? current : selectionTotals());
    // En Évolution l'état de repos dépend aussi du jour de fin choisi
    // (`restDay`) : l'accumulateur rejoué repart de revision 1, sans quoi
    // un changement de date de fin laisserait les textes (et dessins) figés.
    const evoIndex = evolution ? evolutionIndex() : null;
    const altIndexRev = evolution
        ? `${evoIndex?.revision || 0}:${evoIndex?.restDay ?? 0}`
        : indexRevision();
    const a11yBase = `${mode}|${settingsRev}|${altIndexRev}|${altState?.revision || 0}`;
    const items = panels.map((panel) => {
        const width = Math.min(panel.position.width, containerSize.width);
        return {
            id: panel.id,
            mode: panel.position.mode,
            anchor: panel.position.anchor,
            dx: panel.position.dx,
            dy: panel.position.dy,
            x: panel.position.x,
            y: panel.position.y,
            width,
            height: measureStatsPanel(views.get(panel.id), panel.style, Math.max(1, width)),
        };
    });
    // Les piles de coin contournent le titre et les infos.
    const layout = layoutPanels(items, containerSize, overlayRectsCache);
    const warnings = [];

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    for (const panel of panels) {
        const rect = layout.get(panel.id);
        const node = nodeFor(panel, host);
        node.layout = rect;
        node.cssWidth = rect.width;
        // Texte alternatif : reconstruit quand les comptes bougent. La tête de
        // courbe dépend aussi du jour affiché (jours vides compris).
        const view = views.get(panel.id);
        refreshAltText(node, panel, view, `${a11yBase}|${view.model?.headDay ?? ''}`);
        const css = rect.css;
        const cssKey = `${css.left}|${css.right}|${css.top}|${css.bottom}|${rect.width}|${rect.height}`;
        if (node.cssKey !== cssKey) {
            const style = node.canvas.style;
            style.left = css.left != null ? `${css.left}px` : '';
            style.right = css.right != null ? `${css.right}px` : '';
            style.top = css.top != null ? `${css.top}px` : '';
            style.bottom = css.bottom != null ? `${css.bottom}px` : '';
            style.width = `${rect.width}px`;
            style.height = `${rect.height}px`;
            node.cssKey = cssKey;
        }
        const bw = Math.max(1, Math.round(rect.width * dpr));
        const bh = Math.max(1, Math.round(rect.height * dpr));
        const key = `${revision}|${bw}|${bh}`;
        if (node.drawnKey !== key) {
            if (node.canvas.width !== bw || node.canvas.height !== bh) {
                node.canvas.width = bw;
                node.canvas.height = bh;
            }
            const ctx = node.canvas.getContext('2d');
            ctx.clearRect(0, 0, bw, bh);
            drawStatsPanel(ctx, { x: 0, y: 0, width: bw, height: bh },
                views.get(panel.id), panel.style, lastNow, rect.width);
            node.drawnKey = key;
            node.drawnHeadDay = views.get(panel.id)?.model?.shownHeadDay ?? null;
        }
        node.canvas.classList.toggle('is-free', panel.position.mode === 'free');
        if (rect.overflow) warnings.push({ id: panel.id, kind: 'overflow' });
        for (const overlay of overlayRectsCache) {
            if (rectsOverlap(rect, overlay)) warnings.push({ id: panel.id, kind: 'overlap', with: overlay.id });
        }
    }
    // Deux panneaux de coins différents (ou un panneau libre) qui se recouvrent :
    // l'empilement ne règle que les panneaux d'une même pile.
    for (let i = 0; i < panels.length; i++) {
        for (let j = i + 1; j < panels.length; j++) {
            if (rectsOverlap(layout.get(panels[i].id), layout.get(panels[j].id))) {
                warnings.push({ id: panels[j].id, kind: 'panels', with: panels[i].id });
            }
        }
    }
    // Fin de la première passe d'une animation : les catégories qui
    // apparaîtront désormais pousseront depuis 0.
    if (mode === 'animating') tweens.settle();
    if (JSON.stringify(warnings) !== JSON.stringify(layoutWarnings)) {
        layoutWarnings = warnings;
        try {
            document.dispatchEvent(new CustomEvent('mygcflow:stats-layout', { detail: { warnings } }));
        } catch (_) {}
    }
}

// Rect logique (px CSS, repère du conteneur) d'un panneau affiché, et taille
// du conteneur : le glisser-déposer de stats_ui.js en déduit x/y normalisés.
export function getStatsPanelRect(id) {
    const rect = panelNodes.get(id)?.layout;
    return rect ? { ...rect, container: { ...containerSize } } : null;
}

export function getStatsLayoutWarnings() {
    return layoutWarnings;
}

// Panneau sélectionné dans l'onglet Stats : son canvas prend `is-selected`.
// Pur repère visuel de l'aperçu — la vidéo ne lit jamais les classes DOM.
export function setStatsPanelSelection(id) {
    selectedPanelId = id || null;
    for (const [pid, node] of panelNodes) {
        node.canvas.classList.toggle('is-selected', pid === selectedPanelId);
    }
}

// Base vidée, page Évolution, interrupteur : la visibilité se recalcule au
// prochain dessin (appelé par frames.js › syncOverlayVisibility).
export function syncStatsPanelsVisibility() {
    fontFamilyCache = null;
    invalidateStatsLayout();
}

// ---------------------------------------------------------------------------
// Vidéo
// ---------------------------------------------------------------------------

// Dessine les panneaux sur le canvas d'enregistrement, AVANT les overlays
// titre/infos (même empilement que l'aperçu). Géométrie : celle de l'aperçu
// × scaleFactor, ancrée comme dans le DOM (left/right, top/bottom). Chaque
// panneau est rendu dans un canvas hors écran gardé tant que la révision et
// l'échelle ne changent pas : un panneau immobile coûte un drawImage.
export function addStatsPanelsToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    if (drawDirty) flush();
    const panels = visiblePanels();
    if (panels.length === 0) return;
    videoDrawCount += 1;
    const views = new Map();
    for (const panel of panels) {
        const node = panelNodes.get(panel.id);
        const rect = node?.layout;
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
        const w = Math.max(1, Math.round(rect.width * scaleFactor));
        const h = Math.max(1, Math.round(rect.height * scaleFactor));
        const x = rect.css.right != null
            ? canvasWidth - Math.round(rect.css.right * scaleFactor) - w
            : Math.round(rect.css.left * scaleFactor);
        const y = rect.css.bottom != null
            ? canvasHeight - Math.round(rect.css.bottom * scaleFactor) - h
            : Math.round(rect.css.top * scaleFactor);
        const key = `${revision}|${w}|${h}`;
        let cached = videoCache.get(panel.id);
        if (!cached) {
            cached = { canvas: document.createElement('canvas'), key: '' };
            videoCache.set(panel.id, cached);
        }
        if (cached.key !== key) {
            if (cached.canvas.width !== w || cached.canvas.height !== h) {
                cached.canvas.width = w;
                cached.canvas.height = h;
            }
            const offCtx = cached.canvas.getContext('2d');
            offCtx.clearRect(0, 0, w, h);
            if (!views.has(panel.id)) views.set(panel.id, buildView(panel));
            drawStatsPanel(offCtx, { x: 0, y: 0, width: w, height: h },
                views.get(panel.id), panel.style, lastNow, rect.width);
            cached.key = key;
            node.drawnHeadDay = views.get(panel.id)?.model?.shownHeadDay ?? null;
        }
        ctx.drawImage(cached.canvas, x, y);
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Mini-aperçu du panneau sélectionné dans l'onglet (stats_ui.js) : la vue
// courante dessinée dans un canvas du formulaire — même pipeline que la
// carte et la vidéo, à la largeur réelle du panneau. false si le panneau
// n'est pas dessinable ici (inconnu, métrique étrangère au mode).
export function drawStatsPanelPreview(id, canvas) {
    const list = isEvolutionPage() ? settings.evolution_panels : settings.panels;
    const panel = (list || []).find((p) => p.id === id);
    const registry = isEvolutionPage() ? EVOLUTION_METRICS_BY_KIND : STATS_METRICS_BY_KIND;
    if (!panel || !canvas || !(registry[panel.kind] || []).includes(panel.metric)) return false;
    if (drawDirty) flush();
    const view = buildView(panel);
    const cssWidth = Math.max(1, Math.round(panel.position.width || 280));
    const height = measureStatsPanel(view, panel.style, cssWidth);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);
    drawStatsPanel(ctx, { x: 0, y: 0, width: cssWidth, height }, view, panel.style, lastNow, cssWidth);
    return true;
}

// Instantané PNG : le bitmap déjà dessiné pour l'aperçu (résolution écran).
// null si le panneau n'est pas affiché (désactivé, base vide, Évolution).
export function statsPanelPngBlob(id) {
    const node = panelNodes.get(id);
    if (!node) return Promise.resolve(null);
    return new Promise((resolve) => node.canvas.toBlob(resolve, 'image/png'));
}

// Valeurs du panneau en CSV : séparateur « ; » (convention Excel francophone)
// et BOM pour que l'UTF-8 s'ouvre sans assistant. Comptes réels de la
// sélection, calculés depuis selectionTotals() avec les fonctions pures du
// modèle — jamais l'état d'animation, et sans toucher aux tweens.
// null sans panneau.
export function statsPanelCsv(id) {
    const list = isEvolutionPage() ? settings.evolution_panels : settings.panels;
    const panel = (list || []).find((p) => p.id === id);
    if (!panel) return null;
    const { number, percent } = formatters();
    if (isEvolutionPage()) return statsPanelCsvEvolution(panel, number, percent);
    const ref = selectionTotals();
    const cell = (v) => {
        const s = String(v ?? '');
        return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [];
    const push = (...cols) => rows.push(cols.map(cell).join(';'));
    if (panel.kind === 'counter') {
        push(pkg.t('Chiffre'), pkg.t('Valeur'), pkg.t('Détail'));
        const values = counterValues(ref, panel.options.items);
        for (const item of panel.options.items) {
            const entry = values[item] || { value: 0 };
            let detail = '';
            if (item === 'best_day' && entry.value > 0 && entry.day !== null) detail = formatDay(entry.day);
            if (item === 'streak' && entry.value > 1) detail = `${formatDay(entry.start)} → ${formatDay(entry.end)}`;
            push(COUNTER_LABELS[item](), number(entry.value), detail);
        }
    } else if (panel.kind === 'line') {
        push(pkg.t('Date'), pkg.t('Total'));
        for (const p of lineModel(ref, ref).points) push(formatDay(p.day), p.total);
    } else if (panel.kind === 'grid') {
        push(pkg.t('Case'), pkg.t('Nombre'));
        const model = gridModel(panel.metric, ref, ref, { end: jasmerEndOf(pkg.metadata?.endDate) });
        if (model) {
            const labels = gridAxisLabels(panel.metric, model, number);
            for (let r = 0; r < model.rows; r++) {
                for (let c = 0; c < model.cols; c++) {
                    const count = model.cells[r * model.cols + c].count;
                    if (count) push(gridCellLabel({ metric: panel.metric, ...labels }, r, c), count);
                }
            }
        }
    } else {
        push(pkg.t('Catégorie'), pkg.t('Nombre'), pkg.t('Pourcentage'));
        const labelOf = labelFor(panel.metric, number);
        const options = panel.kind === 'donut'
            ? { sort: 'count', max_items: panel.options.max_items }
            : panel.options;
        const model = barModel(panel.metric, ref, ref, options, labelOf);
        for (const row of model.rows) {
            push(labelOf(row.key), row.count,
                model.total ? percent(row.count / model.total) : '');
        }
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

// CSV d'un panneau Évolution : valeurs réelles au jour de repos (fin de
// plage), mêmes en-têtes et conventions que le mode principal.
function statsPanelCsvEvolution(panel, number, percent) {
    const index = evolutionIndex();
    const day = index?.restDay ?? 0;
    const acc = evolutionRestAcc();
    const cell = (v) => {
        const s = String(v ?? '');
        return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [];
    const push = (...cols) => rows.push(cols.map(cell).join(';'));
    if (panel.kind === 'counter') {
        push(pkg.t('Chiffre'), pkg.t('Valeur'), pkg.t('Détail'));
        const values = evolutionCounterValues(index, day, acc?.setView('active'), panel.options.items);
        for (const item of panel.options.items) {
            const entry = values[item] || { value: 0 };
            push(COUNTER_LABELS[item](), number(entry.value), '');
        }
    } else if (panel.kind === 'line') {
        push(pkg.t('Date'), pkg.t('Total'));
        for (const p of evolutionLineModel(index, panel.metric, day).points) {
            push(formatDay(p.day), p.total);
        }
    } else {
        push(pkg.t('Catégorie'), pkg.t('Nombre'), pkg.t('Pourcentage'));
        const metric = panel.metric;
        const labelOf = labelFor(metric, number);
        const counted = panel.options.counted || 'active';
        const current = metric === 'status'
            ? evolutionStatusAcc(index, day)
            : acc?.setView(counted) || { counts: new Map(), excluded: new Map(), total: 0 };
        const options = panel.kind === 'donut'
            ? { sort: 'count', max_items: panel.options.max_items }
            : panel.options;
        const model = barModel(metric, current, current, options, labelOf);
        for (const row of model.rows) {
            push(labelOf(row.key), row.count,
                model.total ? percent(row.count / model.total) : '');
        }
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// État courant, sérialisable : utilisé par les tests E2E pour comparer les
// comptes au compteur de caches affiché.
export function getStatsSnapshot() {
    if (isEvolutionPage()) {
        const acc = (mode === 'animating' && evoCurrent) ? evoCurrent : evolutionRestAcc();
        const activeView = acc?.setView('active');
        const counts = {};
        const excluded = {};
        for (const metric of metrics) {
            counts[metric] = Object.fromEntries(activeView?.counts.get(metric) || new Map());
            excluded[metric] = activeView?.excluded.get(metric) || 0;
        }
        // Les trois univers complets : vérifiables par les tests (un panneau
        // « Compter : poses cumulées » lit `placed`, invisible dans `counts`).
        const universes = {};
        if (acc) {
            for (const name of ['active', 'placed', 'archived']) {
                const set = acc.sets[name];
                const setCounts = {};
                for (const metric of metrics) {
                    setCounts[metric] = Object.fromEntries(set?.counts.get(metric) || new Map());
                }
                universes[name] = { total: set?.total || 0, counts: setCounts };
            }
        }
        return {
            mode,
            total: activeView?.total || 0,
            metrics: [...metrics],
            counts,
            excluded,
            universes,
            revision,
            videoDrawCount,
            visible: visiblePanels().map((panel) => panel.id),
            drawnHeads: Object.fromEntries(visiblePanels()
                .filter((panel) => panel.kind === 'line')
                .map((panel) => [panel.id, panelNodes.get(panel.id)?.drawnHeadDay ?? null])),
        };
    }
    const state = mode === 'animating' ? current : selectionTotals();
    const counts = {};
    const excluded = {};
    for (const metric of metrics) {
        counts[metric] = Object.fromEntries(state.counts.get(metric) || new Map());
        excluded[metric] = state.excluded.get(metric) || 0;
    }
    return {
        mode,
        total: state.total,
        metrics: [...metrics],
        counts,
        excluded,
        revision,
        videoDrawCount,
        visible: visiblePanels().map((panel) => panel.id),
        // Dernier jour peint par la tête de chaque courbe : les tests E2E
        // vérifient qu'elle avance pendant les jours sans trouvaille.
        drawnHeads: Object.fromEntries(visiblePanels()
            .filter((panel) => panel.kind === 'line')
            .map((panel) => [panel.id, panelNodes.get(panel.id)?.drawnHeadDay ?? null])),
    };
}
