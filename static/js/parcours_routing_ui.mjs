// Carte « Itinéraires » de la page Parcours : activation, fournisseur
// (FOSSGIS / openrouteservice), clé ORS, calcul des routes des trajets
// (requêtes chaînées côté serveur, cache de page par clé de trajet), état
// affiché (progression, « Réessayer », « Arrêter », « Recalculer »).
//
// Le cache et les requêtes utiles au parcours ouvert vivent ici ;
// `computeRuns` est appelé par la reconstruction, qui y lit chemins et durées
// déjà connus. Réglages persistés dans `parcours_routing` (settings_api) ;
// reconstruction et chronologie sont injectées — pas d'import de
// parcours_data.js.
import { showConfirmation, showToast, t } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { cacheKey, pendingRuns, routeEffects, routeRuns } from './parcours_routing.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, fetchJson, adjustmentsLocked, receiveAdjustments,
//   rebuild, renderStops, applyTimeline, clockRunning, deferTimeline,
//   syncAttribution }
export function createParcoursRouting(deps) {
    const S = () => deps.getState();

    let routeCache = new Map();  // cacheKey(profil, « from>to ») → réponse du serveur
    let routeRunsNow = [];       // requêtes utiles au parcours ouvert
    let routeEffectsNow = { hints: new Map(), paths: new Map(), missing: 0 };
    let routeState = { state: 'idle', message: '' };
    let routeSeq = 0;
    let routeRevision = 0;
    let cacheStats = null;       // relevé du cache serveur (tous parcours)

    // Contenu du cache serveur : relevé au premier rendu puis après chaque
    // calcul (les résultats partiels d'un échec sont gardés eux aussi).
    async function loadCacheStats() {
        try {
            cacheStats = await deps.fetchJson('/api/parcours/routes/cache');
        } catch (error) {
            console.warn('[PARCOURS] Relevé du cache d’itinéraires indisponible :', error);
            cacheStats = null;
        }
        render();
    }

    function config() {
        const raw = window.userSettings?.parcours_routing || {};
        return {
            enabled: raw.enabled === true,
            provider: raw.provider === 'ors' ? 'ors' : 'fossgis',
            orsKeySet: raw.ors_key_set === true,
        };
    }

    // Écrit le patch puis remet la valeur complète dans window.userSettings
    // (saveSettingsPatch y remplace la clé par le seul patch). Attendre cette
    // promesse avant de demander un itinéraire : le serveur lit `enabled`.
    async function save(patch) {
        const current = window.userSettings?.parcours_routing || {};
        const next = { ...current, ...patch };
        if ('ors_key' in patch) {
            next.ors_key_set = !!patch.ors_key;
            delete next.ors_key;
        }
        if (window.userSettings) window.userSettings.parcours_routing = next;
        const ok = await saveSettingsPatch({ parcours_routing: patch });
        if (window.userSettings) window.userSettings.parcours_routing = next;
        return ok;
    }

    // Calcule (côté serveur, cache compris) les itinéraires des trajets qui
    // en manquent, puis rejoue le parcours. Une erreur suspend les nouvelles
    // tentatives jusqu'à une action de l'utilisateur (« Recalculer »,
    // réglage) : sinon chaque reconstruction relancerait un fournisseur en
    // panne.
    async function ensure({ force = false } = {}) {
        const { selectedId, ordered } = S();
        if (!config().enabled || !selectedId || !ordered) {
            render();
            return;
        }
        // Erreur ou annulation : suspendues jusqu'à une action de
        // l'utilisateur.
        if ((routeState.state === 'error' || routeState.state === 'cancelled') && !force) return;
        const runs = force ? routeRunsNow : pendingRuns(routeRunsNow, routeCache);
        if (runs.length === 0) {
            render();
            return;
        }
        const seq = ++routeSeq;
        const total = runs.reduce((n, run) => n + run.keys.length, 0);
        let done = 0;
        routeState = { state: 'loading', message: '', done, total };
        render();
        let message = '';
        let failed = false;
        for (const run of runs) {
            let body;
            try {
                body = await deps.fetchJson('/api/parcours/routes', {
                    method: 'POST',
                    body: JSON.stringify({ profile: run.profile, waypoints: run.waypoints, force }),
                    // Le serveur chaîne des appels fournisseur temporisés
                    // (throttle + découverte des trajets sans route).
                    timeoutMs: 300_000,
                });
            } catch (error) {
                message = error.message;
                failed = true;
                break;
            }
            if (seq !== routeSeq) return;
            body.legs.forEach((leg, i) => {
                if (leg) routeCache.set(cacheKey(run.profile, run.keys[i]), leg);
            });
            done += run.keys.length;
            routeState = { state: 'loading', message: '', done, total };
            render();
            if (body.error) {
                message = body.message || '';
                failed = true;
                break;
            }
        }
        if (seq !== routeSeq) return;
        routeState = failed ? { state: 'error', message } : { state: 'ready', message: '' };
        routeRevision++;
        loadCacheStats();
        if (deps.clockRunning()) {
            deps.deferTimeline();
            render();
            return;
        }
        deps.rebuild();
        deps.renderStops();
        deps.applyTimeline();
    }

    function render() {
        deps.syncAttribution();
        const { inputs } = S();
        const card = el('parcoursRoutingCard');
        if (!card) return;
        card.hidden = !inputs;
        const cfg = config();
        const enabled = el('parcoursRoutingEnabled');
        if (enabled) enabled.checked = cfg.enabled;
        const provider = el('parcoursRoutingProvider');
        if (provider) provider.value = cfg.provider;
        const keyRow = el('parcoursOrsKeyRow');
        if (keyRow) keyRow.hidden = cfg.provider !== 'ors';
        const key = el('parcoursOrsKey');
        if (key) key.placeholder = cfg.orsKeySet ? t('Clé enregistrée (la remplacer)') : t('Clé openrouteservice');
        const details = el('parcoursRoutingDetails');
        if (details) details.hidden = !cfg.enabled;
        const status = el('parcoursRoutingStatus');
        if (!status) return;
        status.classList.toggle('text-danger', routeState.state === 'error');
        const loading = cfg.enabled && routeState.state === 'loading';
        const cancel = el('btnParcoursRoutesCancel');
        if (cancel) cancel.hidden = !loading;
        // « Réessayer » : proposé après un échec ou une annulation — reprend
        // le calcul sans ignorer le cache, là où « Recalculer » redemande
        // tout.
        const retry = el('btnParcoursRoutesRetry');
        if (retry) retry.hidden = !(cfg.enabled && (routeState.state === 'error' || routeState.state === 'cancelled'));
        const progress = el('parcoursRoutesProgress');
        if (progress) {
            progress.hidden = !loading;
            progress.max = routeState.total || 1;
            progress.value = routeState.done || 0;
        }
        const routed = routeEffectsNow.paths.size;
        const legs = routeRunsNow.reduce((total, run) => total + run.keys.length, 0);
        if (!cfg.enabled) status.textContent = '';
        else if (routeState.state === 'loading') {
            status.textContent = t('Calcul des itinéraires : ${done} / ${total} trajets…',
                { done: routeState.done || 0, total: routeState.total || '?' });
        }
        else if (routeState.state === 'error') status.textContent = routeState.message || t('Itinéraires indisponibles : trajets en ligne droite.');
        else if (routeState.state === 'cancelled') {
            status.textContent = t('Calcul interrompu : ${routed} trajets sur ${legs} gardent leurs itinéraires.', { routed, legs });
        }
        else {
            status.textContent = legs === 0
                ? t('Aucun trajet à calculer (trajets sur une trace ou en ligne droite).')
                : t('${routed} trajets sur ${legs} suivent les routes et chemins.', { routed, legs });
        }
        // Résumé lisible section repliée (en-tête de la section).
        const hint = el('parcoursRoutingHint');
        if (hint) {
            hint.textContent = cfg.enabled ? status.textContent : t('Désactivés : trajets en ligne droite');
            hint.classList.toggle('is-warning', cfg.enabled && routeState.state === 'error');
        }
        // Cache serveur (tous parcours) : ligne d'information et bouton de
        // purge, visibles seulement quand le relevé est connu et non vide.
        const cacheLine = el('parcoursRoutingCache');
        if (cacheLine) {
            const count = cacheStats?.count;
            cacheLine.textContent = !cfg.enabled || !Number.isFinite(count) ? ''
                : count === 0 ? t('Aucun itinéraire en cache.')
                : t('${n} itinéraires gardés en cache.', { n: count });
        }
        const clearCache = el('btnParcoursRoutesCacheClear');
        if (clearCache) {
            clearCache.hidden = !cfg.enabled || !(cacheStats?.count > 0)
                || routeState.state === 'loading';
        }
    }

    function bind() {
        const enabled = el('parcoursRoutingEnabled');
        enabled?.addEventListener('change', async () => {
            const pid = S().selectedId;
            await save({ enabled: enabled.checked });
            routeState = { state: 'idle', message: '' };
            deps.receiveAdjustments({}, pid);
        });
        const provider = el('parcoursRoutingProvider');
        provider?.addEventListener('change', async () => {
            const pid = S().selectedId;
            await save({ provider: provider.value });
            // Autre fournisseur, autres itinéraires : le cache de la page
            // repart.
            routeCache.clear();
            routeState = { state: 'idle', message: '' };
            deps.receiveAdjustments({}, pid);
        });
        el('btnParcoursOrsKeySave')?.addEventListener('click', async () => {
            const input = el('parcoursOrsKey');
            const value = (input?.value || '').trim();
            const pid = S().selectedId;
            await save({ ors_key: value });
            if (input) input.value = '';
            routeState = { state: 'idle', message: '' };
            deps.receiveAdjustments({}, pid);
        });
        el('btnParcoursRoutesRecompute')?.addEventListener('click', () => {
            if (deps.adjustmentsLocked()) return;
            routeState = { state: 'idle', message: '' };
            ensure({ force: true });
        });
        el('btnParcoursRoutesRetry')?.addEventListener('click', () => {
            if (deps.adjustmentsLocked()) return;
            routeState = { state: 'idle', message: '' };
            ensure();
        });
        el('btnParcoursRoutesCancel')?.addEventListener('click', () => {
            // La boucle meurt après sa requête en cours ; les itinéraires
            // déjà reçus restent en cache et s'affichent tout de suite.
            // Comme une erreur, l'annulation suspend les relances
            // automatiques — une reconstruction ne repartirait pas sans
            // « Recalculer ».
            routeSeq++;
            routeState = { state: 'cancelled', message: '' };
            deps.rebuild();
            deps.renderStops();
            deps.applyTimeline();
            render();
        });
        el('btnParcoursRoutesCacheClear')?.addEventListener('click', () => {
            if (deps.adjustmentsLocked() || routeState.state === 'loading') return;
            showConfirmation(
                t('Oublier les ${n} itinéraires gardés en cache ? Ils seront recalculés par le service en ligne au prochain besoin.', { n: cacheStats?.count || 0 }),
                t('Vider le cache des itinéraires'),
                async () => {
                    let body;
                    try {
                        body = await deps.fetchJson('/api/parcours/routes/cache', { method: 'DELETE' });
                    } catch (error) {
                        showToast(error.message, 'error');
                        return;
                    }
                    // Le cache de la page reste : les itinéraires affichés
                    // survivent, le serveur ne les redemandera qu'au prochain
                    // besoin (rechargement, autre parcours, « Recalculer »).
                    // Le vider ici relancerait aussitôt le téléchargement de
                    // tous les trajets via rebuild() → ensureRoutes().
                    cacheStats = { count: 0, providers: {} };
                    render();
                    showToast(t('${n} itinéraires oubliés.', { n: body?.removed || 0 }), 'success');
                },
                null,
                { danger: true, confirmText: t('Vider') },
            );
        });
        loadCacheStats();
    }

    // Changement de parcours ouvert : toute suite en vol appartient au
    // parcours quitté — le numéro de séquence la tue, son état et son cache
    // ne le suivent pas (deux parcours peuvent partager les clés « place:n »
    // de trajets).
    function reset() {
        routeSeq++;
        routeState = { state: 'idle', message: '' };
        routeCache.clear();
    }

    // Reconstruction : les requêtes et effets des trajets se recalculent sur
    // l'ordre courant — connus (durées dans l'horaire, chemins dans le tracé)
    // ou à demander. Le skip exclut les trajets déjà portés par une trace.
    function computeRuns(ordered, overrides, skip) {
        routeRunsNow = config().enabled ? routeRuns(ordered, overrides, { skip }) : [];
        routeEffectsNow = routeEffects(routeRunsNow, routeCache);
        return routeEffectsNow;
    }

    return {
        config,
        save,
        ensure,
        render,
        bind,
        reset,
        computeRuns,
        clearRunState: () => {
            routeRunsNow = [];
            routeEffectsNow = { hints: new Map(), paths: new Map(), missing: 0 };
        },
        runs: () => routeRunsNow,
        effects: () => routeEffectsNow,
        revision: () => routeRevision,
        state: () => ({
            state: routeState.state,
            message: routeState.message,
            done: routeState.done || 0,
            total: routeState.total || 0,
        }),
    };
}
