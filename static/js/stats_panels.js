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
import { appMode, isEvolutionPage, isMainPage, isPosesPage } from './app_mode.mjs';
import {
    ALL_STATS_SOURCES,
    DT_LABELS,
    EVOLUTION_METRICS_BY_KIND,
    OTHERS_KEY,
    STATS_ANCHORS,
    STATS_DAY_TILES,
    STATS_DEFAULTS,
    STATS_HEIGHT_RANGE,
    STATS_METRICS_BY_KIND,
    STATS_WIDTH_RANGE,
    UNKNOWN_KEY,
    arrangePanels,
    barModel,
    counterValues,
    countedUniverse,
    countFeatures,
    countMetricOf,
    createStatsAccumulator,
    createStatsPanel,
    createTweenStore,
    dayNumberOfDate,
    evolutionActivePeaks,
    evolutionCounterValues,
    evolutionEventsBetween,
    evolutionLineModel,
    evolutionMeanActiveAge,
    evolutionStateAt,
    evolutionStatusAcc,
    extremesOfFeatures,
    featuresUpTo,
    foldExtreme,
    formatDdm,
    gridModel,
    hasActiveHighlights,
    highlightLevel,
    layoutPanels,
    lineMilestones,
    lineModel,
    metricsForPanels,
    normalizeStatsSettings,
    rectsOverlap,
    statsPanelRegistry,
    statsPanelSource,
    statsPanelsKey,
    statsStylePreset,
    yearTicks,
    ymdOfDay,
} from './stats_model.mjs';
import { STATS_RENDERERS, drawStatsPanel, hitStatsPanel, measureStatsPanel } from './stats_render.mjs';

const DEFAULT_HIGHLIGHT_MS = 600;

// Tuiles dont la valeur dépend du jour affiché (lues hors de l'accumulateur :
// chronologie de Mes poses, états des DNF et des caches posées) : un panneau
// qui en porte est redessiné aussi les jours sans événement compté.
const DAY_TILES = new Set(STATS_DAY_TILES);
// Tuiles « poseur » remplies depuis la chronologie de Mes poses
// (posesCounterStats), pas depuis l'accumulateur.
const POSES_COUNTER_TILES = new Set(['ftf_delay', 'neglected', 'finds_per_cache', 'unfound']);

let settings = normalizeStatsSettings(STATS_DEFAULTS);

// Comptage par SOURCE (docs/panneaux-stats.md) : sur la page principale,
// chaque panneau compte les trouvailles, les DNF ou les caches posées ; sur
// Mes poses, les trouvailles reçues, les DNF reçus ou les favoris reçus
// (stats_model › statsPanelSource, validée par page). Chaque source a son
// index par jour, son accumulateur, ses totaux et sa référence — les états
// vides en pratique : « owned » sur Mes poses, « favorites » sur la page
// principale (countingStates ne retient que ceux avec métriques). Évolution
// n'a que la source « finds » (métriques des catégories, accumulateur propre).
function newSourceState(key) {
    return {
        key,
        metrics: new Set(),
        metricsKey: '',
        current: createStatsAccumulator(),
        totalsMemo: null,      // { key, acc }
        referenceMemo: null,   // { key, acc }
        // Index par jour des sauts et de l'accumulation (statsDayIndex).
        daysMemo: null,        // { revision, days, feats, extremes, prefix }
        appliedPos: 0,         // nombre de jours de tête comptés dans `current`
        basePos: 0,            // jours d'avant la date de début : plancher d'un saut
        appliedRev: -1,        // révision de l'index couverte par `current`
    };
}
const sourceStates = new Map(ALL_STATS_SOURCES.map((key) => [key, newSourceState(key)]));
const FINDS = sourceStates.get('finds');

function panelState(panel) {
    const m = appMode();
    return (m === 'main' || m === 'poses')
        ? (sourceStates.get(statsPanelSource(panel, m)) || FINDS)
        : FINDS;
}

// Sources dont au moins un panneau actif compte quelque chose.
function countingStates() {
    return [...sourceStates.values()].filter((S) => S.metrics.size > 0);
}

// 'rest' : totaux de la sélection ; 'animating' : accumulateurs courants.
let mode = 'rest';
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
// glissent vers leur cible à l'horloge des points, immédiates au repos. Un
// magasin par panneau : celui dont plus rien ne glisse n'est pas redessiné
// pendant qu'un autre anime encore (cf. panelAnimating).
let tweenDuration = DEFAULT_HIGHLIGHT_MS;
const panelTweens = new Map();   // id → createTweenStore

function tweensOf(id) {
    let store = panelTweens.get(id);
    if (!store) {
        store = createTweenStore(tweenDuration);
        panelTweens.set(id, store);
    }
    return store;
}

function clearTweens(duration = tweenDuration) {
    tweenDuration = duration;
    for (const store of panelTweens.values()) store.clear(duration);
}

// Révision : tout ce qui change ce que dessinent les panneaux (comptes,
// réglages, mise en page, surbrillance qui s'estompe). Entre dans la signature
// des frames MediaRecorder : une matrice qui se remplit sur une carte immobile
// doit quand même produire des frames.
let revision = 0;
// Révision du contenu, commune à tous les panneaux : comptes, réglages, mode,
// cadre. Elle n'avance pas aux frames d'une surbrillance ou d'une valeur qui
// glisse, ni au glisser d'un panneau : chaque panneau a sa clé de dessin
// (panelDrawKey), qui n'ajoute l'horloge que tant que LUI anime.
let contentRevision = 0;
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

// Liste de panneaux et registre de métriques de la page courante
// (stats.panels / evolution_panels / poses_panels).
function pagePanels() {
    return settings[statsPanelsKey(appMode())] || [];
}
// Registre d'un panneau sur la page courante (source comprise sur la page
// principale).
function pageRegistry(panel) {
    return statsPanelRegistry(panel, appMode());
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
    for (const S of sourceStates.values()) {
        // Sources alternatives : page principale (dnf/owned), Mes poses
        // (dnf/favorites — « owned » n'existe pas là : pas de métriques).
        const nextMetrics = S === FINDS || isMainPage() || (isPosesPage() && S.key !== 'owned')
            ? metricsForPanels(settings, { mode: appMode(), source: S.key })
            : new Set();
        const nextKey = [...nextMetrics].sort().join(',');
        if (nextKey === S.metricsKey) continue;
        S.metrics = nextMetrics;
        S.metricsKey = nextKey;
        S.totalsMemo = null;
        S.referenceMemo = null;
        if (S === FINDS) {
            evoRestMemo = null;
            evoPeaksMemo = null;
        }
        // Métrique ajoutée en pleine animation : l'accumulateur est reconstruit
        // jusqu'au dernier jour affiché, sans relancer l'animation.
        if (mode === 'animating') {
            if (evolution && S === FINDS && evolutionIndex()) {
                evoCurrent = evolutionStateAt(evolutionIndex(), S.metrics, evoAppliedDay ?? -1);
            } else if (!evolution) {
                rebuildCurrent(S);
            }
        } else if (!evolution) {
            S.current = createStatsAccumulator(S.metrics);
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
    // Mode principal (trouvailles, DNF ou caches posées selon la source du
    // panneau) et Mes poses (trouvailles reçues).
    const page = appMode();
    return pagePanels().filter((panel) => panel.enabled && STATS_RENDERERS[panel.kind]
        && (statsPanelRegistry(panel, page)[panel.kind] || []).includes(panel.metric));
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

// Événements comptés, par jour (clés Date.toDateString()). Page Mes poses,
// quelle que soit la clé : les événements de la source sont servis par
// poses_data.js › posesStatsFinds ('finds' = trouvailles reçues, 'dnf' =
// DNF reçus, 'favorites' = trouvailles reçues avec favori — mêmes
// propriétés : date_find, attributs de la cache, trouveur). Page
// principale : 'finds' = trouvailles de la carte (visibles puis locationless
// masquées), 'dnf' / 'owned' = un événement par DNF, une cache posée par
// jour d'apparition (dnf_data.js, owner_data.js), affichés ou non sur la
// carte ; 'favorites' (et toute autre) n'y a pas de source.
function findIndexes(S = FINDS) {
    if (isPosesPage()) {
        const source = pkg.posesStatsFinds?.(S.key);
        return { revision: `poses:${S.key}:${source?.revision ?? 'none'}`, maps: source ? [source.byDate] : [] };
    }
    if (S.key === 'finds') {
        return {
            revision: Number(pkg.pointsByDateRevision) || 0,
            maps: [pkg.pointsByDate, pkg.hiddenPointsByDate],
        };
    }
    if (S.key === 'dnf' || S.key === 'owned') {
        const source = S.key === 'dnf' ? pkg.dnfStatsIndex?.() : pkg.ownerStatsIndex?.();
        return { revision: source?.revision ?? `${S.key}:none`, maps: source ? [source.byDate] : [] };
    }
    return { revision: `${S.key}:none`, maps: [] };
}

function indexFeaturesUpTo(S, until) {
    const out = [];
    for (const map of findIndexes(S).maps) {
        for (const feature of featuresUpTo(map, until)) out.push(feature);
    }
    return out;
}

function indexRevision(S = FINDS) {
    return findIndexes(S).revision;
}

// Index par jour des sauts et de l'accumulation : jours triés → features
// (visibles puis locationless masquées, même ordre que featuresOfDates pour
// les égalités d'extrêmes). Mémoïsé par révision de l'index source ; les
// extrêmes par jour ne sont calculés qu'à la demande (repli d'un record
// retiré, cf. removeDays), les cumuls aussi (countUpTo).
function statsDayIndex(S) {
    const revision = indexRevision(S);
    if (S.daysMemo?.revision === revision) return S.daysMemo;
    const byDay = new Map();
    for (const byDate of findIndexes(S).maps) {
        if (!byDate) continue;
        for (const [key, list] of byDate.entries()) {
            if (!list?.length) continue;
            const day = dayNumberOfDate(new Date(key));
            if (!Number.isFinite(day)) continue;
            let bucket = byDay.get(day);
            if (!bucket) byDay.set(day, (bucket = []));
            for (const feature of list) bucket.push(feature);
        }
    }
    const days = [...byDay.keys()].sort((a, b) => a - b);
    S.daysMemo = {
        revision,
        days,
        feats: days.map((d) => byDay.get(d)),
        extremes: new Array(days.length).fill(null),
        prefix: null,
    };
    return S.daysMemo;
}

// Nombre d'entrées de `days` ≤ `day` (recherche dichotomique) : la position
// de comptage correspondant à un jour affiché.
function daysUpTo(days, day) {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (days[mid] <= day) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Nombre d'événements d'une source jusqu'au jour `day` inclus (Infinity :
// tous), indépendamment de ce que comptent ses panneaux — tuile « taux
// d'échec » (DNF / (DNF + trouvailles)).
function countUpTo(S, day) {
    const index = statsDayIndex(S);
    if (!index.prefix) {
        index.prefix = [0];
        for (const list of index.feats) index.prefix.push(index.prefix.at(-1) + list.length);
    }
    return index.prefix[daysUpTo(index.days, day)];
}

// Trouvailles de géocaches jusqu'au jour `day` (Infinity : toutes) :
// dénominateur du taux d'échec. Les Lab Caches ne peuvent pas recevoir de
// DNF — les compter diluerait le taux quand la sélection les affiche.
function geoFindsUpTo(day) {
    const index = statsDayIndex(FINDS);
    if (!index.geoPrefix) {
        index.geoPrefix = [0];
        for (const list of index.feats) {
            let n = 0;
            for (const feature of list) {
                if ((feature?.properties?.source_kind || 'geocache') === 'geocache') n++;
            }
            index.geoPrefix.push(index.geoPrefix.at(-1) + n);
        }
    }
    return index.geoPrefix[daysUpTo(index.days, day)];
}

// Extrêmes d'un jour de l'index, calculés une fois (mémoïsés dans l'index).
function dayExtremes(index, pos) {
    return index.extremes[pos] ?? (index.extremes[pos] = extremesOfFeatures(index.feats[pos]));
}

// Retire du comptage les jours [from, to) : mêmes comptes en moins, puis les
// records d'extrêmes nés dans un jour retiré (leur `day` identifie le seau
// d'origine) sont repliés sur les jours restants — premier gagnant à égalité,
// ordre chronologique, comme updateExtremes.
function removeDays(S, index, from, to) {
    const removed = new Set(index.days.slice(from, to));
    const batch = [];
    for (let i = from; i < to; i++) for (const feature of index.feats[i]) batch.push(feature);
    S.current.remove(batch);
    const ex = S.current.extremes;
    if (!ex) return;
    for (const dir of ['north', 'south', 'east', 'west']) {
        if (!ex[dir] || !removed.has(ex[dir].day)) continue;
        const entries = [];
        for (let i = 0; i < from; i++) entries.push(dayExtremes(index, i)[dir]);
        ex[dir] = foldExtreme(dir, entries);
    }
}

// Totaux de la sélection filtrée (locationless masquées comprises, comme le
// compteur de caches), recalculés une fois par changement de sélection.
function selectionTotals(S = FINDS) {
    const key = `${indexRevision(S)}|${S.metricsKey}`;
    if (S.totalsMemo?.key !== key) {
        S.totalsMemo = { key, acc: countFeatures(indexFeaturesUpTo(S, null), S.metrics) };
    }
    return S.totalsMemo.acc;
}

// Comptes à la date de fin de l'animation : l'échelle, l'ordre et les bornes
// des graphes. Égaux aux totaux sans date de fin imposée. Les DNF et les
// caches posées peuvent dépasser la dernière trouvaille : leur référence
// s'arrête toujours à la date de fin.
function animationReference(S = FINDS) {
    const end = animation?.endDate instanceof Date ? animation.endDate : null;
    const lastFind = pkg.metadata?.endDate instanceof Date ? pkg.metadata.endDate : null;
    if (!end || (S === FINDS && lastFind && end.getTime() >= lastFind.getTime())) return selectionTotals(S);
    const key = `${indexRevision(S)}|${S.metricsKey}|${end.getTime()}`;
    if (S.referenceMemo?.key !== key) {
        S.referenceMemo = { key, acc: countFeatures(indexFeaturesUpTo(S, end), S.metrics) };
    }
    return S.referenceMemo.acc;
}

function rebuildCurrent(S) {
    S.current = createStatsAccumulator(S.metrics);
    S.appliedPos = 0;
    S.basePos = 0;
    S.appliedRev = indexRevision(S);
    if (!animation || S.metrics.size === 0) return;
    const index = statsDayIndex(S);
    // Les jours d'avant la date de début sont comptés au lancement (caches
    // déjà affichées) : un saut ne redescend jamais sous ce plancher.
    S.basePos = animation.startDate instanceof Date
        ? daysUpTo(index.days, dayNumberOfDate(animation.startDate) - 1)
        : 0;
    const until = animation.lastDate || new Date(animation.startDate.getTime() - 1);
    S.appliedPos = daysUpTo(index.days, dayNumberOfDate(until));
    for (let i = 0; i < S.appliedPos; i++) S.current.add(index.feats[i]);
}

function featuresOfDates(S, dates) {
    const out = [];
    const maps = findIndexes(S).maps;
    for (const date of dates) {
        const key = date.toDateString();
        for (const map of maps) {
            const list = map?.get(key);
            if (list) for (const feature of list) out.push(feature);
        }
    }
    return out;
}

// Le panneau suit-il le jour affiché même sans événement compté ? Tête de
// courbe, année d'activité, tuiles lues au jour (DAY_TILES), état des caches
// posées (lu au jour, hors accumulateur — ownedStatusAcc).
function panelFollowsDay(panel) {
    return panel.kind === 'line' || panel.metric === 'activity'
        || (panel.metric === 'status' && panelState(panel).key === 'owned')
        || (panel.kind === 'counter' && (panel.options.items || []).some(DAY_TILES.has, DAY_TILES));
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
    const key = `${index.revision}|${index.restDay}|${FINDS.metricsKey}`;
    if (evoRestMemo?.key !== key) {
        evoRestMemo = { key, acc: evolutionStateAt(index, FINDS.metrics, index.restDay) };
    }
    return evoRestMemo.acc;
}

// Référence « échelle fixe » de l'univers actif : maximum de chaque clé sur
// toute la plage (les barres ne changent pas d'échelle quand l'ensemble fond).
function evolutionActivePeaksRef() {
    const index = evolutionIndex();
    if (!index) return null;
    const key = `${index.revision}|${index.restDay}|${FINDS.metricsKey}`;
    if (evoPeaksMemo?.key !== key) {
        evoPeaksMemo = { key, ref: evolutionActivePeaks(index, FINDS.metrics, index.restDay) };
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
        clearTweens(animation.highlightMs);
        evoCurrent = null;
    }
    animation.lastDate = dates[dates.length - 1];
    if (!evoCurrent || evoAppliedDay !== first - 1) {
        evoCurrent = evolutionStateAt(index, FINDS.metrics, first - 1);
    }
    const at = Number.isFinite(now) ? now : null;
    evoCurrent.add(placed, at);
    evoCurrent.remove(archived, at);
    evoAppliedDay = last;
    if (Number.isFinite(now)) lastNow = now;
    touch();
}

// Point d'entrée du moteur « cycle de vie » (mapgl › displayLifecycleDates) :
// `ev` = lot rendu par le moteur de la page (step).
export function accumulateLifecycleStats(dates, ev, now) {
    if (!ev) return;
    if (isEvolutionPage()) accumulateEvolutionStats(dates, ev.placed, ev.archived, now);
    // Mes poses : les trouvailles reçues des jours affichés, comme le mode
    // principal compte celles de la carte.
    else if (isPosesPage()) accumulateStatsForDates(dates, now);
}

function touch() {
    contentRevision += 1;
    touchFrame();
}

// Nouvelle frame sans changement de contenu commun : position glissée,
// taille (dans la clé du panneau), tête de courbe ou année d'activité sur un
// jour vide (dans la clé des panneaux concernés). La révision globale avance
// — signature MediaRecorder, flush —, chaque bitmap reste si sa clé tient.
function touchFrame() {
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
        evoCurrent = index ? evolutionStateAt(index, FINDS.metrics, evoAppliedDay ?? -1) : null;
    } else {
        for (const S of sourceStates.values()) rebuildCurrent(S);
    }
    clearTweens(animation.highlightMs);
    layoutDirty = true;
    touch();
}

// Lot de jours affichés par l'animation (un ou plusieurs jours rattrapés par
// la même frame) : leurs caches, locationless masquées comprises.
export function accumulateStatsForDates(dates, now) {
    if (mode !== 'animating' || !dates?.length) {
        if (dates?.length && animation) animation.lastDate = dates[dates.length - 1];
        return;
    }
    animation.lastDate = dates[dates.length - 1];
    if (Number.isFinite(now)) lastNow = now;
    const lastDay = dayNumberOfDate(dates[dates.length - 1]);
    let counted = false;
    for (const S of countingStates()) {
        const index = statsDayIndex(S);
        if (S.appliedRev !== index.revision) {
            // Index reconstruit en pleine animation (import, filtre) : l'état
            // courant est recompté jusqu'au dernier jour affiché, pas
            // incrémenté par-dessus — les features du lot en cours sont dedans.
            rebuildCurrent(S);
            counted = true;
            continue;
        }
        const features = featuresOfDates(S, dates);
        // Les jours sans événement ne figurent pas dans `days` : la borne sur
        // le dernier jour du lot suffit à suivre la position comptée.
        S.appliedPos = daysUpTo(index.days, lastDay);
        if (features.length === 0) continue;
        S.current.add(features, Number.isFinite(now) ? now : null);
        counted = true;
    }
    if (counted) {
        touch();
        return;
    }
    // Jours sans événement : rien à compter, mais la tête d'une courbe avance
    // quand même sur l'axe des dates, une année d'activité passe à l'année
    // suivante au 1ᵉʳ janvier, et les tuiles lues au jour (délai avant la
    // première trouvaille, DNF en
    // cours, caches actives…) suivent le jour affiché — il faut redessiner
    // (leur clé porte le jour, cf. panelDrawKey).
    if (visiblePanels().some(panelFollowsDay)) touchFrame();
}

// Saut dans la chronologie (barre de chronologie, aperçu en pause) : l'état à
// la fin du jour `date`, sans surbrillance — rien ne vient d'être trouvé.
// Incrémental comme seekPointsToDay pour les points de la carte : seuls les
// jours entre l'ancienne et la nouvelle position sont ajoutés ou retirés
// (un replay complet ne survient que si l'index a été reconstruit entre
// deux). Les échelles restent celles de la référence.
export function seekStatsToDate(date) {
    if (!(date instanceof Date)) return;
    if (isEvolutionPage()) {
        const index = evolutionIndex();
        const day = index?.dayOf?.(date);
        if (!Number.isFinite(day)) return;
        // Comme le premier lot de accumulateEvolutionStats : l'aperçu a pu
        // être mis en pause avant d'avoir affiché le moindre jour.
        mode = 'animating';
        animation = {
            ...(animation || {}),
            endDate: pkg.metadata?.endDate instanceof Date ? pkg.metadata.endDate : null,
            lastDate: date,
            highlightMs: animation?.highlightMs ?? DEFAULT_HIGHLIGHT_MS,
            evolution: true,
        };
        if (!evoCurrent || !Number.isFinite(evoAppliedDay)) {
            evoCurrent = evolutionStateAt(index, FINDS.metrics, day);
        } else if (day > evoAppliedDay) {
            // En avant : poses et archivages des jours (applied, day].
            const ev = evolutionEventsBetween(index, evoAppliedDay, day);
            evoCurrent.add(ev.placed, null);
            evoCurrent.remove(ev.archived, null);
        } else if (day < evoAppliedDay) {
            // En arrière : les mêmes événements défaits (les cumuls
            // redescendent, l'ensemble actif se repeuple) — rewind défait
            // les archivages avant les poses, l'ordre exact qui préserve
            // l'ensemble actif (cf. stats_model).
            const ev = evolutionEventsBetween(index, day, evoAppliedDay);
            evoCurrent.rewind(ev);
        }
        evoAppliedDay = day;
    } else {
        if (mode !== 'animating' || !animation) return;
        animation.lastDate = date;
        for (const S of countingStates()) {
            const index = statsDayIndex(S);
            if (S.appliedRev !== index.revision) rebuildCurrent(S);
            // jamais sous le plancher des jours d'avant la date de début.
            const target = Math.max(S.basePos, daysUpTo(index.days, dayNumberOfDate(date)));
            if (target > S.appliedPos) {
                // Sans horloge : rien ne surligne.
                for (let i = S.appliedPos; i < target; i++) S.current.add(index.feats[i]);
            } else if (target < S.appliedPos) {
                removeDays(S, index, target, S.appliedPos);
            }
            S.appliedPos = target;
        }
    }
    clearTweens(animation.highlightMs);
    touch();
}

// Retour au repos (arrêt, abandon d'enregistrement) : totaux de la sélection.
// La fin naturelle de l'animation n'y passe pas — l'état final reste affiché,
// comme le compteur de caches.
export function showStatsTotals() {
    mode = 'rest';
    animation = null;
    for (const S of sourceStates.values()) S.current = createStatsAccumulator(S.metrics);
    evoCurrent = null;
    clearTweens();
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
        for (const S of sourceStates.values()) S.current = createStatsAccumulator(S.metrics);
        evoCurrent = null;
        clearTweens();
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
    const active = visiblePanels().some(panelAnimating);
    // Une surbrillance qui vient de s'éteindre demande une dernière frame.
    // Seuls les panneaux dont la clé change sont redessinés (panelDrawKey).
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

// Le dessin de CE panneau dépend-il encore de l'horloge ? Une valeur qui
// glisse (barres, parts, compteurs, tête de courbe, paliers) ou une
// surbrillance qui s'estompe. Sinon, sa clé de dessin ignore l'horloge et
// son bitmap est gardé pendant que les autres animent.
function panelAnimating(panel) {
    if (mode !== 'animating' || !animation || !Number.isFinite(lastNow)) return false;
    if (panelTweens.get(panel.id)?.isActive(lastNow)) return true;
    return isEvolutionPage()
        ? hasActiveEvolutionHighlights([panel], lastNow, animation.highlightMs)
        : hasActiveHighlights(panelState(panel).current, [panel], lastNow, animation.highlightMs);
}

// Clé de dessin d'un panneau (aperçu et vidéo, taille du bitmap en plus) :
// contenu commun, jour de tête (courbe) et année (activité) — qui bougent sur
// les jours vides sans toucher au contenu commun —, horloge tant qu'il anime,
// taille logique. Une clé inchangée = un bitmap réutilisable tel quel.
function panelDrawKey(panel, view, rect) {
    const clock = panelAnimating(panel) ? lastNow : '';
    return `${contentRevision}|${view?.model?.headDay ?? ''}|${view?.model?.year ?? ''}|${view?.counterDay ?? ''}|${clock}|${rect.width}|${rect.height}`;
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
        const latest = evoCurrent.sets[countedUniverse(panel)]?.latestHit?.get(panel.metric);
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
let compactFormat = null;
function formatters() {
    const lang = locale();
    if (!numberFormat || numberFormat.lang !== lang) {
        numberFormat = { lang, fmt: new Intl.NumberFormat(lang) };
        percentFormat = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
        // « 1,2 k » / « 1.2K » : cases de grille trop étroites pour le nombre
        // complet (stats_render › gridValueFit).
        compactFormat = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
    }
    return {
        number: (n) => numberFormat.fmt.format(n),
        percent: (r) => percentFormat.format(r),
        compact: (n) => compactFormat.format(n),
    };
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
    const page = appMode();
    const source = (page === 'main' || page === 'poses') ? statsPanelSource(panel, page) : 'finds';
    if (page === 'main' && source === 'dnf') {
        switch (panel.metric) {
            case 'dt': return pkg.t('Matrice D/T des DNF');
            case 'finds_ym': return pkg.t('DNF mois × année');
            case 'calendar': return pkg.t('Calendrier des DNF');
            case 'activity': return pkg.t('Activité DNF');
            case 'cache': return pkg.t('DNF par cache');
            case 'cache_type': return pkg.t('DNF par type');
            case 'container': return pkg.t('DNF par taille');
            case 'difficulty': return pkg.t('DNF par difficulté');
            case 'terrain': return pkg.t('DNF par terrain');
            case 'year': return pkg.t('DNF par année');
            case 'month': return pkg.t('DNF par mois');
            case 'weekday': return pkg.t('DNF par jour de la semaine');
            case 'country': return pkg.t('DNF par pays');
            case 'state': return pkg.t('DNF par région');
            case 'owner': return pkg.t('DNF par propriétaire');
            case 'cumulative': return pkg.t('DNF cumulés');
            case 'summary': return pkg.t('Chiffres clés des DNF');
            default: break;
        }
    } else if (page === 'main' && source === 'owned') {
        switch (panel.metric) {
            case 'dt': return pkg.t('Matrice D/T de mes caches');
            case 'finds_ym': return pkg.t('Poses mois × année');
            case 'calendar': return pkg.t('Calendrier des poses');
            case 'activity': return pkg.t('Activité de poseur');
            case 'cache_type': return pkg.t('Mes caches par type');
            case 'container': return pkg.t('Mes caches par taille');
            case 'difficulty': return pkg.t('Mes caches par difficulté');
            case 'terrain': return pkg.t('Mes caches par terrain');
            case 'year': return pkg.t('Poses par année');
            case 'month': return pkg.t('Poses par mois');
            case 'weekday': return pkg.t('Poses par jour de la semaine');
            case 'country': return pkg.t('Mes caches par pays');
            case 'state': return pkg.t('Mes caches par région');
            case 'cumulative': return pkg.t('Caches posées cumulées');
            case 'status': return pkg.t('État de mes caches');
            case 'summary': return pkg.t('Chiffres clés de mes caches');
            default: break;
        }
    } else if (page === 'poses' && source === 'dnf') {
        switch (panel.metric) {
            case 'dt': return pkg.t('Matrice D/T des DNF reçus');
            case 'finds_ym': return pkg.t('DNF reçus mois × année');
            case 'calendar': return pkg.t('Calendrier des DNF reçus');
            case 'activity': return pkg.t('Activité des DNF reçus');
            case 'cache': return pkg.t('DNF reçus par cache');
            case 'finder': return pkg.t('DNF reçus par joueur');
            case 'year': return pkg.t('DNF reçus par année');
            case 'month': return pkg.t('DNF reçus par mois');
            case 'weekday': return pkg.t('DNF reçus par jour de la semaine');
            case 'age': return pkg.t('Âge des caches au DNF');
            case 'cache_type': return pkg.t('DNF reçus par type');
            case 'container': return pkg.t('DNF reçus par taille');
            case 'difficulty': return pkg.t('DNF reçus par difficulté');
            case 'terrain': return pkg.t('DNF reçus par terrain');
            case 'country': return pkg.t('DNF reçus par pays');
            case 'state': return pkg.t('DNF reçus par région');
            case 'cumulative': return pkg.t('DNF reçus');
            case 'summary': return pkg.t('Chiffres clés des DNF reçus');
            default: break;
        }
    } else if (page === 'poses' && source === 'favorites') {
        switch (panel.metric) {
            case 'dt': return pkg.t('Matrice D/T des favoris');
            case 'finds_ym': return pkg.t('Favoris reçus mois × année');
            case 'calendar': return pkg.t('Calendrier des favoris reçus');
            case 'activity': return pkg.t('Activité des favoris reçus');
            case 'cache': return pkg.t('Favoris reçus par cache');
            case 'finder': return pkg.t('Joueurs favorisants');
            case 'year': return pkg.t('Favoris reçus par année');
            case 'month': return pkg.t('Favoris reçus par mois');
            case 'weekday': return pkg.t('Favoris reçus par jour de la semaine');
            case 'age': return pkg.t('Âge des caches au favori');
            case 'cache_type': return pkg.t('Favoris reçus par type');
            case 'container': return pkg.t('Favoris reçus par taille');
            case 'difficulty': return pkg.t('Favoris reçus par difficulté');
            case 'terrain': return pkg.t('Favoris reçus par terrain');
            case 'country': return pkg.t('Favoris reçus par pays');
            case 'state': return pkg.t('Favoris reçus par région');
            case 'cumulative': return pkg.t('Favoris reçus');
            case 'summary': return pkg.t('Chiffres clés des favoris reçus');
            default: break;
        }
    }
    if (isPosesPage()) {
        switch (panel.metric) {
            case 'cache': return pkg.t('Caches les plus trouvées');
            case 'finder': return pkg.t('Meilleurs trouveurs');
            case 'year': return pkg.t('Trouvailles reçues par année');
            case 'month': return pkg.t('Trouvailles reçues par mois');
            case 'cumulative': return pkg.t('Trouvailles reçues');
            case 'finds_ym': return pkg.t('Trouvailles reçues mois × année');
            case 'summary': return pkg.t('Chiffres clés de mes poses');
            default: break;
        }
    }
    switch (panel.metric) {
        case 'dt': return pkg.t('Matrice D/T');
        case 'jasmer': return pkg.t('Grille Jasmer');
        case 'finds_ym': return pkg.t('Trouvailles mois × année');
        case 'calendar': return pkg.t('Calendrier 366');
        case 'activity': return pkg.t("Année d'activité");
        case 'cache_type': return pkg.t('Types de caches');
        case 'container': return pkg.t('Tailles');
        case 'difficulty': return pkg.t('Difficulté');
        case 'terrain': return pkg.t('Terrain');
        case 'year': return pkg.t('Trouvailles par année');
        case 'month': return pkg.t('Trouvailles par mois');
        case 'weekday': return pkg.t('Jours de la semaine');
        case 'age': return pkg.t('Âge des caches trouvées');
        case 'attribute': return pkg.t('Attributs');
        case 'owner': return pkg.t('Propriétaires');
        case 'country': return pkg.t('Pays');
        case 'state': return pkg.t('Régions');
        case 'county': return pkg.t('Départements');
        case 'status': return pkg.t('Statut des caches');
        case 'lifetime': return pkg.t('Durée de vie');
        case 'age_moyen': return pkg.t('Âge moyen des actives');
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

// Tranches d'âge à la trouvaille (stats_model › ageBucket).
const AGE_LABELS = [
    () => pkg.t('Le jour même'),
    () => pkg.t('1 à 7 jours'),
    () => pkg.t('8 jours à 1 mois'),
    () => pkg.t('1 à 6 mois'),
    () => pkg.t('6 à 12 mois'),
    () => pkg.t('1 à 2 ans'),
    () => pkg.t('2 à 5 ans'),
    () => pkg.t('5 à 10 ans'),
    () => pkg.t('10 à 15 ans'),
    () => pkg.t('15 ans et plus'),
];

// Tranches de durée de vie des caches archivées, Évolution
// (stats_model.mjs › KEY_OF.lifetime — même ordre).
const LIFETIME_LABELS = [
    () => pkg.t("Moins d'un an"),
    () => pkg.t('1 à 2 ans'),
    () => pkg.t('2 à 3 ans'),
    () => pkg.t('3 à 5 ans'),
    () => pkg.t('5 à 10 ans'),
    () => pkg.t('10 ans et plus'),
];

function labelFor(metric, number) {
    if (metric === 'difficulty' || metric === 'terrain') {
        return (key) => (key === OTHERS_KEY ? pkg.t('Autres') : number(DT_LABELS[key]));
    }
    if (metric === 'year') return (key) => String(key);
    if (metric === 'month') return (key) => monthNames('short')[key - 1] ?? String(key);
    if (metric === 'weekday') return (key) => weekdayNames('short')[key] ?? String(key);
    if (metric === 'age') return (key) => AGE_LABELS[key]?.() ?? String(key);
    if (metric === 'lifetime') return (key) => LIFETIME_LABELS[key]?.() ?? String(key);
    if (metric === 'status') {
        // « disabled » n'apparaît que dans le statut des caches posées (page
        // principale) ; en Évolution une cache est active ou archivée.
        return (key) => key === 'active' ? pkg.t('Caches actives')
            : key === 'disabled' ? pkg.t('Caches désactivées') : pkg.t('Caches archivées');
    }
    return categoryLabel;
}

function excludedLine(metric, n) {
    switch (metric) {
        case 'dt': return pkg.t('Sans D/T : ${n}', { n });
        case 'difficulty': return pkg.t('Sans difficulté : ${n}', { n });
        case 'terrain': return pkg.t('Sans terrain : ${n}', { n });
        case 'jasmer': case 'age': return pkg.t('Sans date de publication : ${n}', { n });
        case 'day': case 'month': case 'weekday': case 'activity': case 'finds_ym':
            return pkg.t('Sans date de trouvaille : ${n}', { n });
        case 'attribute': return pkg.t('Sans attribut : ${n}', { n });
        case 'lifetime': return pkg.t('Jamais archivées : ${n}', { n });
        default: return pkg.t('Sans date : ${n}', { n });
    }
}

function coverageLine(metric, filled, available, pct) {
    if (metric === 'dt') return pkg.t('Combinaisons : ${filled}/${available} (${pct})', { filled, available, pct });
    if (metric === 'jasmer' || metric === 'finds_ym') return pkg.t('Mois : ${filled}/${available} (${pct})', { filled, available, pct });
    return pkg.t('Jours : ${filled}/${available} (${pct})', { filled, available, pct });
}

// Tours complets : chaque case disponible trouvée au moins n fois.
function loopsLine(metric, n) {
    if (metric === 'jasmer') return pkg.t('Tours de Jasmer : ${n}', { n });
    if (metric === 'finds_ym') return pkg.t('Tours année × mois : ${n}', { n });
    if (metric === 'calendar') return pkg.t('Tours de calendrier : ${n}', { n });
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
function jasmerEnd(animating = mode === 'animating') {
    return jasmerEndOf((animating && animation?.endDate) || pkg.metadata?.endDate);
}

// Année de la grille d'activité : celle du jour affiché pendant l'animation
// (la grille passe à l'année suivante au 1ᵉʳ janvier), sinon celle de la
// dernière trouvaille de la sélection.
function activityYearOf(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    return d.getFullYear();
}
function activityYear(animating = mode === 'animating') {
    if (animating && animation) return activityYearOf(animation.lastDate || animation.startDate);
    return activityYearOf(pkg.metadata?.endDate);
}

// Contexte des grilles : fin de Jasmer, année d'activité.
function gridContext(animating = mode === 'animating') {
    return { end: jasmerEnd(animating), year: activityYear(animating) };
}

// Libellés d'axes d'une grille — partagés entre la vue et l'export CSV.
function gridAxisLabels(metric, model, number) {
    if (metric === 'dt') {
        // Lignes D, colonnes T : abréviations communes au français et à l'anglais.
        return { rowLabels: DT_LABELS.map(number), colLabels: DT_LABELS.map(number), corner: 'D/T' };
    }
    if (metric === 'jasmer' || metric === 'finds_ym') {
        // Années en lignes, mois en colonnes — la grille des trouvailles
        // (finds_ym) a la même géométrie que Jasmer.
        return { rowLabels: model.rowKeys.map(String), colLabels: monthNames('narrow'), corner: '' };
    }
    if (metric === 'activity') {
        // Mois au-dessus de la semaine qui contient son 1ᵉʳ (dans l'année) ;
        // les autres colonnes restent sans libellé (sparseColLabels).
        const names = monthNames('short');
        const colLabels = model.colKeys.map((monday) => {
            for (let i = 0; i < 7; i++) {
                const { y, m, d } = ymdOfDay(monday + i);
                if (d === 1 && y === model.year) return names[m - 1];
            }
            return '';
        });
        return { rowLabels: weekdayNames('short'), colLabels, corner: '', sparseColLabels: true };
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
    total: (source) => (source === 'dnf' ? pkg.t('DNF')
        : source === 'owned' ? pkg.t('Caches posées')
            : source === 'favorites' ? pkg.t('Favoris reçus')
                : isPosesPage() ? pkg.t('Trouvailles reçues') : pkg.t('Trouvailles')),
    finders: (source) => (source === 'dnf' ? pkg.t('Chercheurs distincts')
        : source === 'favorites' ? pkg.t('Joueurs favorisants') : pkg.t('Trouveurs différents')),
    favorites: () => pkg.t('Favoris reçus'),
    fav_ratio: () => pkg.t('Part de favoris'),
    loyal: () => pkg.t('Trouveurs fidèles'),
    ftf_delay: () => pkg.t('Délai moyen avant la première trouvaille'),
    neglected: () => pkg.t('Cache la plus délaissée'),
    finds_per_cache: () => pkg.t('Moyenne de trouvailles par cache'),
    unfound: () => pkg.t('Caches jamais trouvées'),
    caches: (source) => (source === 'dnf' ? pkg.t('Caches en échec')
        : source === 'favorites' ? pkg.t('Caches favorisées')
            : pkg.t('Caches trouvées au moins une fois')),
    days: (source) => (source === 'dnf' ? pkg.t('Jours avec DNF')
        : source === 'owned' ? pkg.t('Jours de pose')
            : source === 'favorites' ? pkg.t('Jours avec favori')
                : pkg.t('Jours avec trouvaille')),
    best_day: () => pkg.t('Record sur une journée'),
    streak: () => pkg.t('Plus longue série (jours)'),
    types: () => pkg.t('Types de caches différents'),
    countries: () => pkg.t('Pays'),
    states: () => pkg.t('Régions'),
    attributes: () => pkg.t('Attributs différents'),
    owners: () => pkg.t('Propriétaires différents'),
    oldest: () => pkg.t('Plus ancienne cache trouvée'),
    same_day: () => pkg.t('Trouvées le jour de publication'),
    north: () => pkg.t('Trouvaille la plus au nord'),
    south: () => pkg.t('Trouvaille la plus au sud'),
    east: () => pkg.t("Trouvaille la plus à l'est"),
    west: () => pkg.t("Trouvaille la plus à l'ouest"),
    actives: () => pkg.t('Caches actives'),
    placees: () => pkg.t('Caches posées'),
    archivees: () => pkg.t('Caches archivées'),
    peak: () => pkg.t('Pic de caches actives'),
    age_moyen: () => pkg.t('Âge moyen des actives'),
    dnf_open: () => pkg.t('DNF en cours'),
    dnf_resolved: () => pkg.t('DNF résolus'),
    dnf_ratio: () => pkg.t("Taux d'échec"),
    dnf_resolve_delay: () => pkg.t('Délai moyen de résolution'),
    dnf_visits: () => pkg.t('Record de tentatives'),
    owned_active: () => pkg.t('Caches actives'),
    owned_disabled: () => pkg.t('Caches désactivées'),
    owned_archived: () => pkg.t('Caches archivées'),
    maintenances: () => pkg.t('Maintenances'),
};

// Libellé d'une tuile selon la source comptée (onglet Stats : cases à cocher).
export function statsCounterLabel(item, source = 'finds') {
    return COUNTER_LABELS[item]?.(source) ?? item;
}

// Tuiles d'état des sources DNF et caches posées, lues au jour `day`
// (Infinity au repos : état actuel) dans les données de la source —
// dnf_data.js › dnfStatsAtDay, owner_data.js › ownerStatsAtDay. Le taux
// d'échec rapporte les DNF aux tentatives sur géocaches (DNF + trouvailles
// de géocaches, Lab Caches exclus) jusqu'à ce jour.
function sourceDayTiles(values, S, day) {
    if (S.key === 'dnf') {
        const states = pkg.dnfStatsAtDay?.(day) || { open: 0, resolved: 0 };
        values.dnf_open = { value: states.open };
        values.dnf_resolved = { value: states.resolved };
        // Délai moyen apparition → résolution (jour entier, rendu en durée) ;
        // record de passages sur une même cache, détail = code GC.
        values.dnf_resolve_delay = {
            value: states.resolved ? (states.resolveDays || 0) / states.resolved : null,
            duration: true,
        };
        values.dnf_visits = { value: states.visits || 0, detail: states.visitsCode || '' };
        const dnf = countUpTo(S, day);
        const finds = geoFindsUpTo(day);
        values.dnf_ratio = {
            value: dnf + finds > 0 ? dnf / (dnf + finds) : 0,
            pct: true,
            detail: pkg.t('${dnf} DNF · ${finds} trouvailles', { dnf, finds }),
        };
    } else if (S.key === 'owned') {
        const states = pkg.ownerStatsAtDay?.(day) || { active: 0, disabled: 0, archived: 0, maintenances: 0 };
        values.owned_active = { value: states.active };
        values.owned_disabled = { value: states.disabled };
        values.owned_archived = { value: states.archived };
        values.maintenances = { value: states.maintenances };
    }
}

// Relevé « état des caches posées » au jour `day` (Infinity au repos), sous
// la forme d'une vue de comptage pour barModel — lecture hors accumulateur
// (owner_data.js › ownerStatsAtDay), comme evolutionStatusAcc en Évolution.
function ownedStatusAcc(day) {
    const states = pkg.ownerStatsAtDay?.(day) || { active: 0, disabled: 0, archived: 0 };
    const counts = new Map([
        ['active', states.active || 0],
        ['disabled', states.disabled || 0],
        ['archived', states.archived || 0],
    ]);
    return {
        counts: new Map([['status', counts]]),
        excluded: new Map([['status', 0]]),
        lastHit: new Map(),
        total: counts.get('active') + counts.get('disabled') + counts.get('archived'),
    };
}

// Âge moyen des actives (jours) → texte compact : « 3,2 ans »,
// « 8 mois », « 42 jours » ; « — » sans active.
function meanAgeText(days, number) {
    if (!Number.isFinite(days)) return '—';
    if (days >= 365.25) return pkg.t('${n} ans', { n: number(Math.round(days / 36.525) / 10) });
    if (days >= 60) return pkg.t('${n} mois', { n: number(Math.round(days / 30.44)) });
    return pkg.t('${n} jours', { n: number(Math.round(days)) });
}

// Texte d'une tuile (vue, export CSV). `shown` : valeur animée à afficher,
// la valeur réelle par défaut. « Plus ancienne » est une année, les points
// extrêmes une coordonnée : ni animées ni formatées en nombre (« 2 001 »).
// `entry.duration` : valeur en jours rendue en durée (« 8 mois », « — » sans
// valeur) ; `entry.pct` : fraction rendue en pourcent (« 23 % »).
function counterText(item, entry, number, shown = entry.value, percent = null) {
    if (entry.axis) {
        const find = entry.find;
        return find
            ? { value: formatDdm(entry.value, entry.axis), detail: [find.gc_code, find.name].filter(Boolean).join(' · ') }
            : { value: '—', detail: '' };
    }
    if (entry.duration) {
        return {
            value: Number.isFinite(entry.value) ? meanAgeText(shown, number) : '—',
            detail: entry.detail || '',
        };
    }
    if (entry.pct) {
        return { value: percent ? percent(shown) : number(Math.round(shown)), detail: entry.detail || '' };
    }
    if (entry.float) {
        // Moyenne : une décimale (« 1,7 »), « — » tant qu'elle est indéfinie.
        return { value: Number.isFinite(entry.value) ? number(Math.round(shown * 10) / 10) : '—', detail: entry.detail || '' };
    }
    if (item === 'oldest') {
        return entry.day === null || entry.day === undefined
            ? { value: '—', detail: '' }
            : { value: String(entry.value), detail: formatDay(entry.day) };
    }
    let detail = entry.detail || '';
    if (item === 'best_day' && entry.value > 0 && entry.day !== null) detail = formatDay(entry.day);
    if (item === 'streak' && entry.value > 1) detail = `${formatDay(entry.start)} → ${formatDay(entry.end)}`;
    return { value: Number.isFinite(entry.value) ? number(Math.round(shown)) : '—', detail };
}

// Tuiles « poseur » d'un compteur Mes poses (délai avant la première
// trouvaille, cache délaissée, moyenne de trouvailles par cache, jamais
// trouvées) : lues dans la chronologie de la page au jour `day`
// (poses_data.js › posesCounterStats), pas dans l'accumulateur. Le détail de
// la délaissée est composé ici : code GC, suivi de la date de dernière
// visite ou de « jamais trouvée » ; celui des jamais trouvées liste leurs
// codes (5 premiers puis « … »).
function posesCounterTiles(values, day) {
    const extra = pkg.posesCounterStats?.(day);
    values.ftf_delay = { value: extra?.ftfDelay ?? null, duration: true };
    const neg = extra?.neglected;
    values.neglected = {
        value: neg ? neg.days : null,
        detail: neg
            ? neg.code + (neg.found ? ` · ${formatDay(neg.lastDay)}` : ' · ' + pkg.t('jamais trouvée'))
            : '',
        duration: true,
    };
    values.finds_per_cache = { value: extra?.findsPerCache ?? null, float: true };
    const un = extra?.unfound;
    values.unfound = {
        value: un ? un.length : null,
        detail: un?.length ? un.slice(0, 5).join(' · ') + (un.length > 5 ? ' · …' : '') : '',
    };
}

// Valeurs animées des lignes d'un histogramme ou d'un anneau ; course de
// barres : la place de chaque ligne glisse aussi.
function animateRows(panel, model, now, tweens = tweensOf(panel.id)) {
    model.rows.forEach((row, i) => {
        row.shown = tweens.set(`${panel.id}:v:${row.key}`, row.count, now);
        if (model.race) row.slot = tweens.set(`${panel.id}:s:${row.key}`, i, now);
    });
    model.shownMax = tweens.set(`${panel.id}:max`, model.max, now);
}

// `source` (vignettes de la galerie « Ajouter », drawStatsGalleryPreviews) :
// comptes imposés `{ totals }` / `{ evoAcc, evoPeaks }`, toujours une vue de
// repos, valeurs immédiates, magasin de tweens jetable — rien ne touche
// l'état des panneaux posés.
function buildView(panel, source = null) {
    if (isEvolutionPage()) return buildEvolutionView(panel, source);
    const animating = !source && mode === 'animating';
    const S = panelState(panel);
    const metric = panel.metric;
    // Source « caches posées », métrique « statut » : actives, désactivées et
    // archivées AU JOUR AFFICHÉ, lu hors accumulateur (ownedStatusAcc) — état
    // actuel au repos (Infinity), jour affiché en animation ; la référence
    // (ordre, couleurs) est l'état final.
    const ownedStatus = S.key === 'owned' && metric === 'status';
    const statusDay = ownedStatus
        ? (animating && animation?.lastDate ? dayNumberOfDate(animation.lastDate) : Infinity)
        : 0;
    const reference = ownedStatus ? ownedStatusAcc(Infinity)
        : source ? (source.totalsBySource?.get(S.key) ?? source.totals)
            : (animating ? animationReference(S) : selectionTotals(S));
    const state = ownedStatus ? ownedStatusAcc(statusDay) : (animating ? S.current : reference);
    const current = S.current;
    // Horloge des valeurs animées : aucune au repos (valeurs immédiates).
    const now = animating ? lastNow : Number.NaN;
    const tweens = source ? createTweenStore(0) : tweensOf(panel.id);
    const { number, percent, compact } = formatters();
    const view = {
        kind: panel.kind,
        metric,
        title: panel.show_title ? (panel.title || defaultStatsPanelTitle(panel)) : '',
        fontFamily: resolveFontFamily(panel),
        formatNumber: number,
        formatPercent: percent,
        formatCompact: compact,
        showValues: panel.options.show_values,
        showPercent: panel.options.show_percent,
        footer: [],
        highlight: animating && animation
            ? { mode: panel.options.highlight, durationMs: animation.highlightMs, hits: current.lastHit.get(countMetricOf(metric)) }
            : null,
    };
    view.source = S.key;
    // Statut des caches posées : la clé de dessin porte le jour, comme les
    // tuiles d'état — le panneau se redessine même les jours sans événement.
    if (ownedStatus) view.counterDay = animating ? statusDay : 'rest';
    // Présence des lignes de pied décidée sur la référence : la hauteur du
    // panneau ne change pas au premier Lab rencontré.
    const refExcluded = reference.excluded.get(countMetricOf(metric)) || 0;

    if (panel.kind === 'grid') {
        const model = gridModel(metric, state, reference, gridContext(animating));
        view.model = model;
        if (metric === 'activity' && panel.show_title && !panel.title) {
            view.title = S.key === 'dnf'
                    ? (isPosesPage() ? pkg.t('DNF reçus ${year}', { year: model.year })
                        : pkg.t('DNF ${year}', { year: model.year }))
                : S.key === 'favorites' ? pkg.t('Favoris ${year}', { year: model.year })
                    : S.key === 'owned' ? pkg.t('Poses ${year}', { year: model.year })
                        : pkg.t('Activité ${year}', { year: model.year });
        }
        view.cellMode = panel.options.cell_mode;
        Object.assign(view, gridAxisLabels(metric, model, number));
        if (panel.options.show_coverage) {
            view.footer.push(coverageLine(metric, model.filled, model.available,
                percent(model.available > 0 ? model.filled / model.available : 0)));
        }
        // Pas de « tour » d'une année d'activité : chaque jour ne vient qu'une fois.
        if (panel.options.show_loops && metric !== 'activity') view.footer.push(loopsLine(metric, number(model.loops)));
        if (refExcluded > 0) view.footer.push(excludedLine(metric, model.excluded));
        return view;
    }

    if (panel.kind === 'line') {
        const headDay = animating && animation?.lastDate ? dayNumberOfDate(animation.lastDate) : undefined;
        const endDay = animating && animation?.endDate ? dayNumberOfDate(animation.endDate) : undefined;
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
        // Paliers (100ᵉ, 500ᵉ… trouvaille) : `level` = éclat au franchissement,
        // porté par le tween 0 → 1 de chaque palier (immédiat au repos et à
        // la première passe d'une animation).
        view.milestones = panel.options.show_milestones
            ? lineMilestones(model).map((m) => {
                const key = `${panel.id}:ms:${m.value}`;
                tweens.set(key, m.day === null ? 0 : 1, now);
                return {
                    ...m,
                    label: number(m.value),
                    level: panel.options.highlight === 'none' || m.day === null ? 0 : tweens.level(key, now),
                };
            })
            : [];
        // Halo de la tête tant que la dernière trouvaille est fraîche.
        const lastDay = model.points.at(-1)?.day;
        view.headLevel = animating && animation && lastDay !== undefined
            ? highlightLevel(current.lastHit.get('day')?.get(lastDay), now, animation.highlightMs,
                panel.options.highlight === 'none' ? 'none' : 'every')
            : 0;
        if ((reference.excluded.get('day') || 0) > 0) view.footer.push(excludedLine('day', model.excluded));
        return view;
    }

    if (panel.kind === 'counter') {
        const values = counterValues(state, panel.options.items);
        // Tuiles « poseur » de Mes poses : délai avant la première trouvaille
        // et cache délaissée
        // suivent le jour affiché, lu dans la chronologie de la page — elles
        // ne sont proposées qu'en trouvailles reçues.
        if (isPosesPage() && S.key === 'finds'
            && panel.options.items.some((item) => POSES_COUNTER_TILES.has(item))) {
            const index = pkg.posesStatsIndex?.();
            if (index) {
                const day = animating && animation?.lastDate
                    ? index.dayOf(animation.lastDate)
                    : index.restDay;
                posesCounterTiles(values, day);
                view.counterDay = day;
            }
        }
        // Tuiles d'état DNF / caches posées : jour affiché, ou état actuel
        // au repos (clé de dessin constante). Page principale seulement —
        // les sources de Mes poses n'ont pas de tuiles « au jour ».
        if (isMainPage() && S.key !== 'finds' && panel.options.items.some(DAY_TILES.has, DAY_TILES)) {
            const day = animating && animation?.lastDate ? dayNumberOfDate(animation.lastDate) : Infinity;
            sourceDayTiles(values, S, day);
            view.counterDay = animating ? day : 'rest';
        }
        view.columns = panel.options.columns;
        view.tiles = panel.options.items.map((item) => {
            const entry = values[item] || { value: 0 };
            const key = `${panel.id}:c:${item}`;
            // « Plus ancienne », points extrêmes : le tween ne sert qu'à
            // l'éclat du changement (jour de publication, coordonnée du
            // record), la valeur s'affiche sans glisser. Une valeur non
            // numérique (tuile « poseur » sans donnée) glisse depuis 0 et
            // le texte affiche « — ».
            const shown = tweens.set(key,
                item === 'oldest' ? (entry.day ?? 0)
                    : (Number.isFinite(entry.value) ? entry.value : 0), now);
            const { value, detail } = counterText(item, entry, number, shown, percent);
            return {
                value,
                label: statsCounterLabel(item, S.key),
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
        animateRows(panel, model, now, tweens);
        view.model = model;
        view.hole = panel.options.hole;
        view.showLegend = panel.options.show_legend;
        view.centerLabel = S.key === 'dnf' ? pkg.t('DNF')
            : S.key === 'favorites' ? pkg.t('favoris')
                : S.key === 'owned' ? pkg.t('caches') : pkg.t('trouvailles');
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
    animateRows(panel, model, now, tweens);
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
function buildEvolutionView(panel, source = null) {
    const index = evolutionIndex();
    const animating = !source && mode === 'animating' && !!evoCurrent;
    const day = animating ? evoAppliedDay : (index?.restDay ?? 0);
    const restAcc = () => (source ? source.evoAcc : evolutionRestAcc());
    const acc = animating ? evoCurrent : restAcc();
    const counted = countedUniverse(panel);
    const now = animating ? lastNow : Number.NaN;
    const tweens = source ? createTweenStore(0) : tweensOf(panel.id);
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
            const shown = tweens.set(key, Number.isFinite(entry.value) ? entry.value : 0, now);
            return {
                // Âge moyen : valeur animée en jours, texte en durée ;
                // « — » tant qu'il n'y a pas d'active.
                value: item === 'age_moyen'
                    ? meanAgeText(Number.isFinite(entry.value) ? shown : null, number)
                    : number(Math.round(shown)),
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
            ? (source ? source.evoPeaks : evolutionActivePeaksRef())
            : restAcc()?.setView(counted);
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
    animateRows(panel, model, now, tweens);
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
    const list = pagePanels();
    const panel = list.find((p) => p.id === id);
    if (!panel || !Number.isFinite(x) || !Number.isFinite(y)) return;
    panel.position.mode = 'free';
    panel.position.x = Math.max(0, Math.min(1, x));
    panel.position.y = Math.max(0, Math.min(1, y));
    layoutDirty = true;
    // Le contenu ne change pas : le canvas bouge, aucun bitmap n'est redessiné.
    touchFrame();
}

// Même aperçu en direct pour la largeur (poignée du bord droit,
// stats_ui.js › bindDragAndDrop) : la hauteur se réadapte au prochain flush
// (measure dépend de la largeur). Le commit au dépôt renormalise.
export function previewStatsPanelWidth(id, width) {
    if (pkg.isAnimationInProgress?.()) return;
    const list = pagePanels();
    const panel = list.find((p) => p.id === id);
    const w = Number(width);
    if (!panel || !Number.isFinite(w)) return;
    const [min, max] = STATS_WIDTH_RANGE;
    panel.position.width = Math.max(min, Math.min(max, Math.round(w)));
    layoutDirty = true;
    // La taille entre dans la clé du panneau : lui seul est redessiné.
    touchFrame();
}

// Même aperçu en direct pour la hauteur (poignée du bord bas, ou du coin
// bas-droit avec la largeur) : position.height — jusque-là automatique —
// prend la valeur glissée, bornée. Vider le champ du formulaire la rend à
// l'automatique (null). Les grilles l'ignorent (cases carrées).
export function previewStatsPanelHeight(id, height) {
    if (pkg.isAnimationInProgress?.()) return;
    const list = pagePanels();
    const panel = list.find((p) => p.id === id);
    const h = Number(height);
    if (!panel || panel.kind === 'grid' || !Number.isFinite(h)) return;
    const [min, max] = STATS_HEIGHT_RANGE;
    panel.position.height = Math.max(min, Math.min(max, Math.round(h)));
    layoutDirty = true;
    touchFrame();
}

// Redimensionnement à la souris d'un panneau libre : x/y sont des fractions
// de l'espace restant, qui change avec la taille — sans correction, élargir
// déplacerait aussi le bord gauche et la poignée fuirait le pointeur. Tant
// que l'épingle est posée, chaque flush recalcule x/y en place, APRÈS la
// mesure (la hauteur automatique suit la largeur), pour garder le coin
// haut-gauche immobile. Le commit au dépôt reprend ces x/y avec la taille.
let resizePin = null;  // { id, left, top } en px CSS du conteneur

export function pinStatsPanelCorner(id) {
    const rect = panelNodes.get(id)?.layout;
    resizePin = rect ? { id, left: rect.x, top: rect.y } : null;
}

// Le dernier pointermove peut attendre encore son flush (rAF) : il est
// appliqué tout de suite, sans quoi le commit reprendrait les x/y d'avant.
export function unpinStatsPanelCorner() {
    if (resizePin && drawDirty) flush();
    resizePin = null;
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
        panelTweens.delete(id);
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
    // Images de l'onglet Images : priorité Titre/Infos > Images > Stats, les
    // piles les contournent comme les cartouches (id « image:<id> »). Quand
    // leur mise en page change, images_panels.js invalide celle-ci.
    try {
        for (const rect of pkg.getImagePanelRects?.() || []) rects.push(rect);
    } catch (_) {}
    return rects;
}

// Libellé d'une case de grille pour le texte alternatif : « D2/T3 »,
// « 2010-06 », « 14 mars » ou la date complète (année d'activité, `key` =
// numéro de jour) selon la métrique.
function gridCellLabel(view, r, c, key) {
    if (view.metric === 'activity') return formatDay(key);
    if (view.metric === 'dt') return `D${view.rowLabels[r]}/T${view.colLabels[c]}`;
    if (view.metric === 'jasmer' || view.metric === 'finds_ym') return `${view.rowLabels[r]}-${String(c + 1).padStart(2, '0')}`;
    return `${c + 1} ${view.rowLabels[r]}`;
}

// Équivalent textuel du canvas pour les technologies d'assistance : titre,
// comptes (les vrais, pas les valeurs animées) et lignes de pied, en liste.
// Reconstruit seulement quand `key` change — comptes, mode, sélection ou
// réglages — jamais à chaque frame de surbrillance. Pas de région « live » :
// le texte est lu quand l'utilisateur s'y arrête, il n'annonce rien de
// lui-même.
function refreshAltText(node, panel, view, key) {
    if (node.a11yKey === key) return false;
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
                : view.source === 'dnf'
                    ? pkg.t('${n} DNF au ${date}', { n: number(model.total), date: formatDay(model.headDay) })
                    : view.source === 'owned'
                        ? pkg.t('${n} caches posées au ${date}', { n: number(model.total), date: formatDay(model.headDay) })
                        : view.source === 'favorites'
                            ? pkg.t('${n} favoris au ${date}', { n: number(model.total), date: formatDay(model.headDay) })
                            : pkg.t('${n} trouvailles au ${date}', { n: number(model.total), date: formatDay(model.headDay) }));
        }
        const reached = (view.milestones || []).filter((m) => m.day !== null);
        if (reached.length) {
            empty = false;
            const list = reached.map((m) => `${m.label} (${formatDay(m.day)})`).join(', ');
            add(pkg.t('Paliers : ${list}', { list }));
        }
    } else if (view.kind === 'grid') {
        for (let r = 0; r < model.rows; r++) {
            for (let c = 0; c < model.cols; c++) {
                const { count, key } = model.cells[r * model.cols + c];
                if (!count) continue;
                empty = false;
                add(`${gridCellLabel(view, r, c, key)} : ${number(count)}`);
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
    return true;
}

// Texte de l'infobulle pour l'élément touché (hitStatsPanel) : la même
// ligne que l'équivalent textuel — « D2/T3 : 4 », « France : 12 (40 %) ».
function hitText(view, hit) {
    const { number, percent } = formatters();
    const model = view.model;
    if (view.kind === 'grid') {
        return `${gridCellLabel(view, hit.r, hit.c, hit.cell.key)} : ${number(hit.cell.count)}`;
    }
    if (view.kind === 'counter') {
        const tile = hit.tile;
        return `${tile.label} : ${tile.value}${tile.detail ? ` (${tile.detail})` : ''}`;
    }
    if (view.kind === 'line') {
        return `${formatDay(hit.day)} : ${number(hit.total)}`;
    }
    // Barres et anneaux : la ligne « catégorie : nombre (pourcentage) ».
    const label = `${view.labelOf(hit.row.key)} : ${number(hit.row.count)}`;
    return view.showPercent && model.total
        ? `${label} (${percent(hit.row.count / model.total)})`
        : label;
}

// Infobulle de survol d'un panneau (stats_ui.js › pointermove, mode
// édition) : le texte de ce qui est sous le pointeur en px CSS du canvas —
// case de grille, ligne, part d'anneau, tuile ou jour de la courbe — ou
// null hors d'un élément. Vue de la dernière passe de dessin : l'infobulle
// suit l'animation comme le canvas.
export function statsPanelHoverText(id, x, y) {
    const node = panelNodes.get(id);
    if (!node?.view || !node.panel || !node.layout) return null;
    const hit = hitStatsPanel(node.view, node.panel.style,
        node.layout.width, node.layout.height, x, y);
    return hit ? hitText(node.view, hit) : null;
}

// Pendant une animation, les textes alternatifs suivent au plus une fois par
// intervalle : une grille en porte des centaines de <li>, reconstruits sinon
// à chaque jour avec trouvaille, alors que personne ne les lit en pleine
// lecture (pas de région « live »). Le premier changement après un calme
// passe aussitôt ; les suivants attendent la fin de l'intervalle, et un
// minuteur rattrape le dernier — en pause ou en fin de lecture, le texte
// colle aux comptes affichés. Au repos, rien n'est différé.
const A11Y_ANIMATION_INTERVAL_MS = 1000;
let a11yRefreshedAt = -Infinity;
let a11yTimer = 0;
let a11yRebuildCount = 0;   // tests : textes reconstruits depuis le chargement

function scheduleA11yCatchUp(delay) {
    if (a11yTimer) return;
    a11yTimer = setTimeout(() => {
        a11yTimer = 0;
        drawDirty = true;
        scheduleFlush();
    }, Math.max(0, delay));
}

// Entrée de layoutPanels pour un panneau : sa position et sa taille mesurée
// à la largeur effective (bornée au conteneur).
function layoutItem(panel, view) {
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
        // Hauteur imposée optionnelle — les grilles l'ignorent même si
        // une valeur était stockée (cases carrées).
        height: measureStatsPanel(view, panel.style, Math.max(1, width),
            panel.kind === 'grid' ? null : panel.position.height),
    };
}

// Coins proposés à l'aimantation : tous sauf le centre de la carte, comme
// « Réorganiser » — un panneau posé au milieu y reste en position libre.
const SNAP_ANCHORS = STATS_ANCHORS.filter((anchor) => anchor !== 'middle-center');

// Aimantation du glisser-déposer (stats_ui.js › bindDragAndDrop) : pour
// chaque coin, le rect que prendrait le panneau s'il y était ancré — marges
// de la pile reprises comme le ferait adoptCornerMargins, titre et infos
// contournés, place dans la pile fixée par l'ordre de la liste. Calculé une
// fois au début du geste : les autres panneaux ne bougent plus ensuite. Les
// coins où le panneau déborderait du cadre ne sont pas proposés.
export function getStatsSnapTargets(id) {
    if (layoutDirty || drawDirty) flush();
    const panels = visiblePanels();
    const panel = panels.find((p) => p.id === id);
    if (!panel) return [];
    const list = pagePanels();
    const items = panels.map((p) => layoutItem(p, buildView(p)));
    const index = panels.indexOf(panel);
    const targets = [];
    for (const anchor of SNAP_ANCHORS) {
        const mate = list.find((p) => p.id !== id && p.position.mode === 'anchor' && p.position.anchor === anchor);
        const candidate = {
            ...items[index],
            mode: 'anchor',
            anchor,
            dx: mate ? mate.position.dx : panel.position.dx,
            dy: mate ? mate.position.dy : panel.position.dy,
        };
        const trial = items.map((item, i) => (i === index ? candidate : item));
        const rect = layoutPanels(trial, containerSize, overlayRectsCache).get(id);
        if (!rect || rect.overflow) continue;
        targets.push({ anchor, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    return targets;
}

// « Réorganiser » (stats_ui.js) : emplacements choisis par arrangePanels
// pour les panneaux affichés, à leur taille mesurée, dans le cadre courant,
// titre et infos compris. Les marges de coin viennent de la liste entière,
// panneaux masqués compris — la normalisation les prend aussi en compte
// (shareCornerMargins). null si rien n'est affiché.
export function arrangeStatsPanels() {
    if (layoutDirty || drawDirty) flush();
    const panels = visiblePanels();
    if (!panels.length) return null;
    const list = pagePanels();
    const cornerMargins = new Map();
    for (const { position } of list) {
        if (position.mode === 'anchor' && !cornerMargins.has(position.anchor)) {
            cornerMargins.set(position.anchor, { dx: position.dx, dy: position.dy });
        }
    }
    const items = panels.map((panel) => layoutItem(panel, buildView(panel)));
    return arrangePanels(items, containerSize, overlayRectsCache, cornerMargins);
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
    const altStates = evolution
        ? [mode === 'animating' ? evoCurrent : evolutionRestAcc()]
        : countingStates().map((S) => (mode === 'animating' ? S.current : selectionTotals(S)));
    // En Évolution l'état de repos dépend aussi du jour de fin choisi
    // (`restDay`) : l'accumulateur rejoué repart de revision 1, sans quoi
    // un changement de date de fin laisserait les textes (et dessins) figés.
    const evoIndex = evolution ? evolutionIndex() : null;
    const altIndexRev = evolution
        ? `${evoIndex?.revision || 0}:${evoIndex?.restDay ?? 0}`
        : countingStates().map((S) => indexRevision(S)).join(':');
    const a11yBase = `${mode}|${settingsRev}|${altIndexRev}|${altStates.map((acc) => acc?.revision || 0).join(':')}`;
    // Au repos, tout de suite ; en animation, au plus un passage par
    // intervalle (cf. A11Y_ANIMATION_INTERVAL_MS), le reste rattrapé ensuite.
    const clock = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const a11yWait = mode === 'animating' ? a11yRefreshedAt + A11Y_ANIMATION_INTERVAL_MS - clock : 0;
    const a11yDue = a11yWait <= 0;
    let a11yRebuilt = 0;
    let a11yPending = false;
    const items = panels.map((panel) => {
        const item = layoutItem(panel, views.get(panel.id));
        if (resizePin?.id === panel.id && panel.position.mode === 'free') {
            const fraction = (offset, room) => (room > 0 ? Math.max(0, Math.min(1, offset / room)) : 0);
            item.x = panel.position.x = fraction(resizePin.left, containerSize.width - item.width);
            item.y = panel.position.y = fraction(resizePin.top, containerSize.height - item.height);
        }
        return item;
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
        // courbe et l'année d'activité dépendent aussi du jour affiché (jours
        // vides compris).
        const view = views.get(panel.id);
        node.view = view;
        node.panel = panel;
        const a11yKey = `${a11yBase}|${view.model?.headDay ?? ''}|${view.model?.year ?? ''}|${view.counterDay ?? ''}`;
        if (a11yDue) {
            if (refreshAltText(node, panel, view, a11yKey)) a11yRebuilt += 1;
        } else if (node.a11yKey !== a11yKey) {
            a11yPending = true;
        }
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
        // Clé propre au panneau : celui qui n'anime pas garde son bitmap
        // pendant qu'un autre glisse ou s'allume. Reprise par la vidéo.
        node.contentKey = panelDrawKey(panel, view, rect);
        const key = `${node.contentKey}|${bw}|${bh}`;
        if (node.drawnKey !== key) {
            if (node.canvas.width !== bw || node.canvas.height !== bh) {
                node.canvas.width = bw;
                node.canvas.height = bh;
            }
            const ctx = node.canvas.getContext('2d');
            ctx.clearRect(0, 0, bw, bh);
            drawStatsPanel(ctx, { x: 0, y: 0, width: bw, height: bh },
                view, panel.style, lastNow, rect.width);
            node.drawnKey = key;
            node.drawCount = (node.drawCount || 0) + 1;
            node.drawnHeadDay = view?.model?.shownHeadDay ?? null;
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
    if (a11yRebuilt > 0) {
        a11yRefreshedAt = clock;
        a11yRebuildCount += a11yRebuilt;
    }
    if (a11yPending) scheduleA11yCatchUp(a11yWait);
    // Fin de la première passe d'une animation : les catégories qui
    // apparaîtront désormais pousseront depuis 0.
    if (mode === 'animating') for (const store of panelTweens.values()) store.settle();
    if (JSON.stringify(warnings) !== JSON.stringify(layoutWarnings)) {
        layoutWarnings = warnings;
        try {
            document.dispatchEvent(new CustomEvent('mygcflow:stats-layout', { detail: { warnings } }));
        } catch (_) {}
    }
    refreshFormPreview();
}

// Rect logique (px CSS, repère du conteneur) d'un panneau affiché, son type
// (le glisser-déposer en déduit les axes redimensionnables : hauteur hors
// grilles), son mode et son ancre (les bords qui portent les poignées) et la
// taille du conteneur — x/y normalisés pour stats_ui.js.
export function getStatsPanelRect(id) {
    const rect = panelNodes.get(id)?.layout;
    if (!rect) return null;
    const list = pagePanels();
    const panel = list.find((p) => p.id === id);
    return {
        ...rect,
        kind: panel?.kind || null,
        mode: panel?.position.mode || 'anchor',
        anchor: panel?.position.anchor || 'top-left',
        container: { ...containerSize },
    };
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
        // Même clé que l'aperçu (posée par le flush) : un panneau qui n'anime
        // pas coûte un drawImage, même quand un voisin se redessine.
        const key = `${node.contentKey}|${w}|${h}`;
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
            cached.drawCount = (cached.drawCount || 0) + 1;
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
    const list = pagePanels();
    const panel = (list || []).find((p) => p.id === id);
    if (!panel || !canvas || !(pageRegistry(panel)[panel.kind] || []).includes(panel.metric)) return false;
    if (drawDirty) flush();
    paintPanelPreview(panel, buildView(panel), canvas);
    return true;
}

// Un panneau dessiné hors carte, à sa largeur réelle (bitmap ≤ 2× : un
// aperçu n'a pas besoin de plus).
function paintPanelPreview(panel, view, canvas) {
    const cssWidth = Math.max(1, Math.round(panel.position.width || 280));
    const height = measureStatsPanel(view, panel.style, cssWidth,
        panel.kind === 'grid' ? null : panel.position.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);
    drawStatsPanel(ctx, { x: 0, y: 0, width: cssWidth, height }, view, panel.style, lastNow, cssWidth);
}

// Vignette d'un préréglage d'apparence (stats_ui.js) : le panneau dessiné
// avec le style du préréglage, réduit proportionnellement dans `box` (px CSS)
// — même pipeline que la carte et l'aperçu du formulaire. false si le
// panneau ou le préréglage est inconnu.
export function drawStatsStylePresetPreview(id, presetName, canvas, box) {
    const list = pagePanels();
    const panel = (list || []).find((p) => p.id === id);
    const patch = statsStylePreset(presetName);
    const width = Math.max(1, Math.round(box?.width || 0));
    const maxHeight = Math.max(1, Math.round(box?.height || 0));
    if (!panel || !canvas || !patch || !width || !maxHeight) return false;
    if (drawDirty) flush();
    const style = { ...panel.style, ...patch };
    const view = buildView(panel);
    const cssWidth = Math.max(1, Math.round(panel.position.width || 280));
    const height = measureStatsPanel(view, style, cssWidth,
        panel.kind === 'grid' ? null : panel.position.height);
    const shrink = Math.min(1, width / cssWidth, maxHeight / height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(cssWidth * shrink * dpr));
    canvas.height = Math.max(1, Math.round(height * shrink * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * shrink, 0, 0, dpr * shrink, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);
    drawStatsPanel(ctx, { x: 0, y: 0, width: cssWidth, height }, view, style, lastNow, cssWidth);
    return true;
}

// Vignettes de la galerie « Ajouter » (stats_ui.js) : chaque entrée
// `{ spec: [kind, metric, overrides], canvas }` est dessinée comme elle
// apparaîtrait au repos, avec les comptes de la sélection — TOUTES les
// métriques des vignettes, pas seulement celles des panneaux posés.
// Comptage unique pour la galerie, mémoïsé par révision des données.
// Renvoie l'ensemble des canvas dessinés (vide en Évolution sans base, ou
// pour une forme étrangère au mode).
let galleryMemo = null;   // { key, source }

function gallerySource(panels) {
    const evolution = isEvolutionPage();
    const needed = metricsForPanels({ enabled: true, [statsPanelsKey(appMode())]: panels }, { mode: appMode() });
    const metricKey = [...needed].sort().join(',');
    if (evolution) {
        const index = evolutionIndex();
        if (!index) return null;
        const key = `evo|${index.revision}|${index.restDay}|${metricKey}`;
        if (galleryMemo?.key !== key) {
            galleryMemo = { key, source: {
                evoAcc: evolutionStateAt(index, needed, index.restDay),
                evoPeaks: evolutionActivePeaks(index, needed, index.restDay),
            } };
        }
        return galleryMemo.source;
    }
    // Pages principale et Mes poses : une passe par source (trouvailles,
    // DNF, caches posées / trouvailles reçues, DNF reçus, favoris reçus —
    // « owned » n'existe pas sur Mes poses).
    const page = appMode();
    const list = { enabled: true, [statsPanelsKey(page)]: panels };
    const perSource = [...sourceStates.values()]
        .filter((S) => S === FINDS || isMainPage() || (isPosesPage() && S.key !== 'owned'))
        .map((S) => {
            const sourceMetrics = metricsForPanels(list, { mode: page, source: S.key });
            return { S, sourceMetrics, sig: `${S.key}:${indexRevision(S)}:${[...sourceMetrics].sort().join(',')}` };
        });
    const key = `main|${perSource.map((entry) => entry.sig).join('|')}|${metricKey}`;
    if (galleryMemo?.key !== key) {
        const totalsBySource = new Map(perSource.map(({ S, sourceMetrics }) =>
            [S.key, countFeatures(indexFeaturesUpTo(S, null), sourceMetrics)]));
        galleryMemo = { key, source: { totals: totalsBySource.get('finds'), totalsBySource } };
    }
    return galleryMemo.source;
}

export function drawStatsGalleryPreviews(entries) {
    const page = appMode();
    const items = (entries || [])
        .map(({ spec, canvas }) => ({ panel: createStatsPanel(spec[0], spec[1], spec[2] || {}), canvas }))
        .filter(({ panel, canvas }) => panel && canvas
            && (statsPanelRegistry(panel, page)[panel.kind] || []).includes(panel.metric));
    const source = items.length ? gallerySource(items.map(({ panel }) => panel)) : null;
    const drawn = new Set();
    if (!source) return drawn;
    for (const { panel, canvas } of items) {
        paintPanelPreview(panel, buildView(panel, source), canvas);
        drawn.add(canvas);
    }
    return drawn;
}

// Aperçu du formulaire (#statsPanelPreview, stats_ui › renderForm) : suit les
// panneaux de la carte — redessiné à la fin d'un flush dont la révision a
// changé (données chargées, filtre, animation), sans quoi il garderait les
// comptes du dernier réglage touché. Seulement onglet Stats ouvert : pendant
// une animation, ce serait sinon un panneau de plus dessiné à chaque frame
// pour un canvas invisible (l'ouverture de l'onglet le redessine, cf.
// stats_ui).
// Clé : celle du panneau sur la carte (il n'est redessiné que si lui change),
// la révision globale pour un panneau masqué, sans canvas sur la carte.
let previewKey = '';
function refreshFormPreview() {
    if (!selectedPanelId) return;
    const node = panelNodes.get(selectedPanelId);
    const key = `${selectedPanelId}|${node?.contentKey ?? `r${revision}`}`;
    if (previewKey === key) return;
    if (!document.getElementById('stats')?.classList.contains('active')) return;
    const canvas = document.getElementById('statsPanelPreview');
    if (!canvas || canvas.hidden) return;
    previewKey = key;
    drawStatsPanelPreview(selectedPanelId, canvas);
    // Ce qui dépend aussi de la taille dessinée (tailles d'export PNG,
    // stats_ui.js) suit le même rythme.
    try {
        document.dispatchEvent(new CustomEvent('mygcflow:stats-preview', { detail: { id: selectedPanelId } }));
    } catch (_) {}
}

// Export PNG : le panneau tel qu'il est affiché (mêmes comptes, même
// instant d'animation), REDESSINÉ à la taille demandée — 1× = taille CSS de
// la carte, 2× ≈ vidéo 1080p depuis une carte de 540 px, 4× ≈ 4K. Un
// redessin, pas un agrandissement du bitmap d'écran : net à toute échelle.
// Un panneau masqué s'exporte aussi, à sa largeur réglée ; un panneau à
// métrique étrangère au mode, non (null).
export const STATS_PNG_SCALES = Object.freeze([1, 2, 4]);

function panelForExport(id) {
    const panel = pagePanels().find((p) => p.id === id);
    return panel && (pageRegistry(panel)[panel.kind] || []).includes(panel.metric) ? panel : null;
}

// Vue et taille logique (px CSS) : celles de la carte si le panneau y est,
// sinon sa largeur réglée et la hauteur qui en découle.
function exportGeometry(panel) {
    if (drawDirty) flush();
    const view = buildView(panel);
    const rect = panelNodes.get(panel.id)?.layout;
    if (rect?.width > 0 && rect?.height > 0) return { view, width: rect.width, height: rect.height };
    const width = Math.max(1, Math.round(panel.position.width || 280));
    const height = measureStatsPanel(view, panel.style, width,
        panel.kind === 'grid' ? null : panel.position.height);
    return { view, width, height };
}

// Taille logique de l'export (le formulaire en déduit les pixels de chaque
// échelle), ou null si le panneau ne s'exporte pas.
export function statsPanelExportSize(id) {
    const panel = panelForExport(id);
    if (!panel) return null;
    const { width, height } = exportGeometry(panel);
    return { width, height };
}

export function statsPanelPngBlob(id, scale = 2) {
    const panel = panelForExport(id);
    if (!panel) return Promise.resolve(null);
    const factor = STATS_PNG_SCALES.includes(scale) ? scale : 2;
    const { view, width, height } = exportGeometry(panel);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * factor));
    canvas.height = Math.max(1, Math.round(height * factor));
    drawStatsPanel(canvas.getContext('2d'), { x: 0, y: 0, width: canvas.width, height: canvas.height },
        view, panel.style, lastNow, width);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Export groupé : tous les panneaux visibles à leur place, sur une image de
// la taille du cadre — le « tableau de bord » tel qu'affiché, à l'échelle
// choisie (même pipeline que la vidéo : addStatsPanelsToCanvas). Fond
// transparent : à poser sur une capture de carte ou un fond de son choix.
// null sans panneau visible (interrupteur coupé, liste vide).
export function statsPanelsExportSize() {
    if (drawDirty) flush();
    return visiblePanels().length && containerSize.width > 0 && containerSize.height > 0
        ? { ...containerSize } : null;
}

export function statsPanelsPngBlob(scale = 2) {
    const size = statsPanelsExportSize();
    if (!size) return Promise.resolve(null);
    const factor = STATS_PNG_SCALES.includes(scale) ? scale : 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.width * factor));
    canvas.height = Math.max(1, Math.round(size.height * factor));
    addStatsPanelsToCanvas(canvas.getContext('2d'), canvas.width, canvas.height, factor);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Cellule CSV : entre guillemets si elle contient « ; », un guillemet ou un
// saut de ligne, guillemets internes doublés. Le guillemet s'écrit \x22 dans
// les expressions régulières : un guillemet double littéral dans une regex
// fait perdre le fil au lexer JS de pybabel, qui n'extrait alors plus les
// chaînes t() qui suivent dans le fichier.
function csvCell(value) {
    const s = String(value ?? '');
    return /[;\x22\r\n]/.test(s) ? '"' + s.replace(/\x22/g, '""') + '"' : s;
}

// Valeurs du panneau en CSV : séparateur « ; » (convention Excel francophone)
// et BOM pour que l'UTF-8 s'ouvre sans assistant. Comptes réels de la
// sélection, calculés depuis selectionTotals() avec les fonctions pures du
// modèle — jamais l'état d'animation, et sans toucher aux tweens.
// null sans panneau.
export function statsPanelCsv(id) {
    const list = pagePanels();
    const panel = (list || []).find((p) => p.id === id);
    if (!panel) return null;
    const { number, percent } = formatters();
    if (isEvolutionPage()) return statsPanelCsvEvolution(panel, number, percent);
    const S = panelState(panel);
    const ref = selectionTotals(S);
    const rows = [];
    const push = (...cols) => rows.push(cols.map(csvCell).join(';'));
    if (panel.kind === 'counter') {
        push(pkg.t('Chiffre'), pkg.t('Valeur'), pkg.t('Détail'));
        const values = counterValues(ref, panel.options.items);
        // Mêmes tuiles « poseur » qu'à l'écran, au jour de repos (date de
        // fin) — trouvailles reçues seulement.
        if (isPosesPage() && S.key === 'finds'
            && panel.options.items.some((item) => POSES_COUNTER_TILES.has(item))) {
            const index = pkg.posesStatsIndex?.();
            if (index) posesCounterTiles(values, index.restDay);
        }
        if (isMainPage() && S.key !== 'finds') sourceDayTiles(values, S, Infinity);
        for (const item of panel.options.items) {
            const { value, detail } = counterText(item, values[item] || { value: 0 }, number, undefined, percent);
            push(statsCounterLabel(item, S.key), value, detail);
        }
    } else if (panel.kind === 'line') {
        push(pkg.t('Date'), pkg.t('Total'));
        for (const p of lineModel(ref, ref).points) push(formatDay(p.day), p.total);
    } else if (panel.kind === 'grid') {
        push(pkg.t('Case'), pkg.t('Nombre'));
        const model = gridModel(panel.metric, ref, ref,
            { end: jasmerEndOf(pkg.metadata?.endDate), year: activityYearOf(pkg.metadata?.endDate) });
        if (model) {
            const labels = gridAxisLabels(panel.metric, model, number);
            for (let r = 0; r < model.rows; r++) {
                for (let c = 0; c < model.cols; c++) {
                    const { count, key } = model.cells[r * model.cols + c];
                    if (count) push(gridCellLabel({ metric: panel.metric, ...labels }, r, c, key), count);
                }
            }
        }
    } else {
        push(pkg.t('Catégorie'), pkg.t('Nombre'), pkg.t('Pourcentage'));
        const labelOf = labelFor(panel.metric, number);
        const options = panel.kind === 'donut'
            ? { sort: 'count', max_items: panel.options.max_items }
            : panel.options;
        // Statut des caches posées : lu au jour, hors accumulateur — état
        // actuel (repos), comme à l'écran.
        const acc = S.key === 'owned' && panel.metric === 'status' ? ownedStatusAcc(Infinity) : ref;
        const model = barModel(panel.metric, acc, acc, options, labelOf);
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
    const rows = [];
    const push = (...cols) => rows.push(cols.map(csvCell).join(';'));
    if (panel.kind === 'counter') {
        push(pkg.t('Chiffre'), pkg.t('Valeur'), pkg.t('Détail'));
        const values = evolutionCounterValues(index, day, acc?.setView('active'), panel.options.items);
        for (const item of panel.options.items) {
            const entry = values[item] || { value: 0 };
            const value = item === 'age_moyen' ? meanAgeText(entry.value, number) : number(entry.value);
            push(statsCounterLabel(item), value, '');
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
        const counted = countedUniverse(panel);
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

// Nombre de dessins de chaque panneau (aperçu, vidéo) : les tests E2E
// vérifient qu'un panneau immobile n'est pas redessiné quand un autre anime.
function panelDrawCounts() {
    const out = {};
    for (const [id, node] of panelNodes) {
        out[id] = { preview: node.drawCount || 0, video: videoCache.get(id)?.drawCount || 0 };
    }
    return out;
}

// État courant, sérialisable : utilisé par les tests E2E pour comparer les
// comptes au compteur de caches affiché.
export function getStatsSnapshot() {
    if (isEvolutionPage()) {
        const index = evolutionIndex();
        const acc = (mode === 'animating' && evoCurrent) ? evoCurrent : evolutionRestAcc();
        const activeView = acc?.setView('active');
        const counts = {};
        const excluded = {};
        for (const metric of FINDS.metrics) {
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
                for (const metric of FINDS.metrics) {
                    setCounts[metric] = Object.fromEntries(set?.counts.get(metric) || new Map());
                }
                universes[name] = { total: set?.total || 0, counts: setCounts };
            }
        }
        return {
            mode,
            total: activeView?.total || 0,
            // Âge moyen des actives (jours) au jour affiché — tuile
            // « Âge moyen », vérifiable par les tests sans lire le canvas.
            meanActiveAge: evolutionMeanActiveAge(index,
                (mode === 'animating' && evoCurrent) ? evoAppliedDay : (index?.restDay ?? 0)),
            metrics: [...FINDS.metrics],
            counts,
            excluded,
            universes,
            revision,
            videoDrawCount,
            draws: panelDrawCounts(),
            a11yRebuilds: a11yRebuildCount,
            visible: visiblePanels().map((panel) => panel.id),
            drawnHeads: Object.fromEntries(visiblePanels()
                .filter((panel) => panel.kind === 'line')
                .map((panel) => [panel.id, panelNodes.get(panel.id)?.drawnHeadDay ?? null])),
        };
    }
    const snapshotOf = (S) => {
        const state = mode === 'animating' ? S.current : selectionTotals(S);
        const counts = {};
        const excluded = {};
        for (const metric of S.metrics) {
            counts[metric] = Object.fromEntries(state.counts.get(metric) || new Map());
            excluded[metric] = state.excluded.get(metric) || 0;
        }
        return { total: state.total, metrics: [...S.metrics], counts, excluded };
    };
    const finds = snapshotOf(FINDS);
    // Comptes par source : « finds » toujours, une source alternative
    // seulement quand un panneau la compte (page principale : DNF et caches
    // posées ; Mes poses : DNF reçus et favoris reçus).
    const sources = { finds };
    for (const S of sourceStates.values()) {
        if (S !== FINDS && S.metrics.size > 0) sources[S.key] = snapshotOf(S);
    }
    return {
        mode,
        total: finds.total,
        metrics: finds.metrics,
        counts: finds.counts,
        excluded: finds.excluded,
        sources,
        revision,
        videoDrawCount,
        draws: panelDrawCounts(),
        a11yRebuilds: a11yRebuildCount,
        visible: visiblePanels().map((panel) => panel.id),
        // Dernier jour peint par la tête de chaque courbe : les tests E2E
        // vérifient qu'elle avance pendant les jours sans trouvaille.
        drawnHeads: Object.fromEntries(visiblePanels()
            .filter((panel) => panel.kind === 'line')
            .map((panel) => [panel.id, panelNodes.get(panel.id)?.drawnHeadDay ?? null])),
    };
}
