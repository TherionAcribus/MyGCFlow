// Page Statistiques : chargement des sources (trouvailles, DNF, caches posées,
// Mes poses, jeux Évolution) et des tableaux de bord.

import { syncThemeFromSettings } from './theme.js';
import { t } from './notifications.js';
import { chartSources } from './chart_spec.mjs';
import { dnfTable, evolutionTables, findsTable, ownedTable, posesTables } from './chart_sources.mjs';
import { dashboardSources, defaultDocument, normalizeDocument } from './dashboard_model.mjs';
import { renderDashboard } from './stats_page_cards.js';
import { activeDashboard, datasetName } from './stats_page_dashboard.js';
import { recoverCorruptDocument, scheduleSave } from './stats_page_save.js';
import { $, EMPTY_TABLE, PERSONAL_SOURCES, state } from './stats_page_state.js';

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

export async function loadUserSettings() {
    try {
        const response = await fetch('/api/settings');
        if (!response.ok) return;
        const settings = await response.json();
        window.userSettings = settings;
        syncThemeFromSettings(settings);
    } catch (e) {
        console.warn('[stats] Préférences non chargées :', e?.message || e);
    }
}

async function loadTypeColors() {
    try {
        const response = await fetch('/static/json/defaultGcColors.json');
        if (response.ok) state.typeColors = await response.json();
    } catch (_) {
        state.typeColors = {};
    }
}

export async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return response.json();
}

// Sources personnelles : les trouvailles sont indispensables (échec = page
// en erreur) ; DNF, caches posées et Mes poses sont facultatifs — pas de
// logs importés = tables vides, mais un ÉCHEC n'est pas un zéro : la source
// est marquée indisponible (sourceErrors) et le graphique propose une relance.
export const PERSONAL_LOADERS = [
    { url: '/api/stats/dnf', sources: ['dnf'], apply: (p) => [['dnf', dnfTable(p)]] },
    { url: '/api/stats/owned', sources: ['owned'], apply: (p) => [['owned', ownedTable(p)]] },
    { url: '/api/poses/data', sources: ['poses.received', 'poses.dnf', 'poses.favorites'],
      apply: (p) => {
          const tables = posesTables(p);
          return [['poses.received', tables.received], ['poses.dnf', tables.dnf],
                  ['poses.favorites', tables.favorites]];
      } },
];
const SOURCE_LOADER = new Map(PERSONAL_LOADERS.flatMap((l) => l.sources.map((s) => [s, l])));

// Toute écriture d'une table change les données : le cache de résultats
// est invalidé via dataRev (les cartes concernées seront recalculées).
export function setTable(source, table) {
    state.tables.set(source, table);
    state.dataRev += 1;
}

export function loadPersonalLoader(loader) {
    return fetchJson(loader.url).then((payload) => {
        for (const [source, table] of loader.apply(payload)) {
            setTable(source, table);
            state.sourceErrors.delete(source);
        }
    }).catch((e) => {
        console.warn('[stats] Source indisponible :', e?.message || e);
        for (const source of loader.sources) {
            setTable(source, EMPTY_TABLE);
            state.sourceErrors.add(source);
        }
    });
}

async function loadPersonalSources() {
    const [finds] = await Promise.all([
        fetchJson('/api/stats/finds').then(findsTable),
        ...PERSONAL_LOADERS.map(loadPersonalLoader),
    ]);
    setTable('finds', finds);
}

// Recharge les sources en échec d'un graphique (bouton « Réessayer »), puis
// redessine tout : la note des données et le résumé des filtres en dépendent.
export function retrySources(spec) {
    const failed = chartSources(spec).filter((s) => state.sourceErrors.has(s));
    const loaders = [...new Set(failed.map((s) => SOURCE_LOADER.get(s)).filter(Boolean))];
    const datasets = failed.filter((s) => s.startsWith('evolution:'))
        .map((s) => s.split(':')[1]);
    // L'échec n'est pas gardé en cache : ensureEvolution relancera le GET.
    for (const id of datasets) state.evolutionLoads.delete(id);
    return Promise.all([...loaders.map(loadPersonalLoader), ...datasets.map(ensureEvolution)])
        .then(renderDashboard);
}

export async function loadDatasets() {
    try {
        state.datasets = (await fetchJson('/api/evolution/datasets')).datasets || [];
    } catch (_) {
        state.datasets = [];
    }
}

// Jeu Évolution chargé à la demande (premier affichage d'un tableau qui
// l'utilise). Un jeu supprimé (404) donne des tables vides et la mention
// « n'existe plus » ; toute autre erreur est temporaire : la source est
// marquée indisponible et la promesse n'est pas gardée — une relance repart.
export function ensureEvolution(id) {
    if (!id) return Promise.resolve();
    if (!state.evolutionLoads.has(id)) {
        state.evolutionLoads.set(id, fetchJson('/api/evolution/datasets/' + id + '/data')
            .then((payload) => {
                const { placed, archived } = evolutionTables(payload);
                setTable('evolution:' + id, placed);
                setTable('evolution:' + id + ':archived', archived);
                state.sourceErrors.delete('evolution:' + id);
                state.sourceErrors.delete('evolution:' + id + ':archived');
            })
            .catch((e) => {
                const sources = ['evolution:' + id, 'evolution:' + id + ':archived'];
                if (/^HTTP 404\b/.test(e?.message || '')) {
                    state.missingDatasets.add(id);
                } else {
                    for (const source of sources) state.sourceErrors.add(source);
                    // Pas de promesse en cache : la prochaine tentative repart.
                    state.evolutionLoads.delete(id);
                }
                for (const source of sources) setTable(source, EMPTY_TABLE);
            }));
    }
    return state.evolutionLoads.get(id);
}

export const tableOf = (source) => state.tables.get(source) || EMPTY_TABLE;

// Étendue des données d'un tableau (menus de périodes) : réunion de ses
// sources.
export function dashboardExtent(dashboard = activeDashboard()) {
    const extents = dashboardSources(dashboard).map((source) => tableOf(source).extent).filter(Boolean);
    if (!extents.length) return null;
    return { first: Math.min(...extents.map((e) => e.first)), last: Math.max(...extents.map((e) => e.last)) };
}

export const dashboardTables = (dashboard = activeDashboard()) => dashboardSources(dashboard).map(tableOf);

async function loadDashboards() {
    const response = await fetch('/api/dashboards');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    state.docRev = typeof body.rev === 'string' ? body.rev : null;
    state.corruptDocument = body.corrupt === true;
    state.backupAvailable = body.backup_available === true;
    return normalizeDocument(body.document);
}

function newDefaultDocument() {
    return defaultDocument({
        name: t('Mon tableau de bord'),
        titleOf: (id) => state.labels.question(id).title,
    });
}

function showSection(id) {
    for (const section of ['statsLoading', 'statsLoadError', 'statsEmptyState', 'statsDashboard']) {
        $(section).hidden = section !== id;
    }
}

export async function loadPage() {
    $('statsLoadingText').textContent = t('Chargement de vos statistiques…');
    showSection('statsLoading');
    try {
        const [, doc] = await Promise.all([loadPersonalSources(), loadDashboards(), loadTypeColors(), loadDatasets()]);
        // Rien à compter nulle part : la page invite à importer.
        const personal = PERSONAL_SOURCES.some((source) => tableOf(source).n > 0);
        if (!personal && !state.datasets.length) {
            showSection('statsEmptyState');
            return;
        }
        state.doc = doc;
        if (!state.doc && state.corruptDocument) {
            state.doc = await recoverCorruptDocument();
        }
        if (!state.doc) {
            // Première visite (ou fichier corrompu abandonné) : un tableau
            // de bord prêt à lire, enregistré tout de suite pour qu'il
            // survive au rechargement.
            state.doc = newDefaultDocument();
            scheduleSave({ immediate: true });
        }
        const { dataset } = activeDashboard();
        if (dataset) {
            // Premier appel après le démarrage : le serveur prépare le jeu
            // (~3 s pour un jeu national) — dire ce qui se passe.
            $('statsLoadingText').textContent = t('Chargement du jeu Évolution « ${name} »…', { name: datasetName(dataset) });
            await ensureEvolution(dataset);
        }
        state.ready = true;
        showSection('statsDashboard');
        renderDashboard();
    } catch (e) {
        console.error('[stats] Chargement impossible :', e);
        showSection('statsLoadError');
    }
}

