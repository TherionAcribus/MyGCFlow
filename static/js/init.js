// DEMARRAGE
// .\virtual\Scripts\activate
// flask --app app.py --debug run

import * as pkg from './index.js';

// Import de la couche d'abstraction Bootstrap/Tabler (remplace progressivement M.*)
import {
    initBsTabs,
    initBsModals,
    initBsTooltips,
    initBsDropdowns,
} from './ui_bootstrap.js';

// Configuration de base - URL dynamique pour éviter les URLs en dur
export const CONFIG = {
    BASE_URL: window.location.origin,
    API_BASE: `${window.location.origin}`
};

 // Attend que profiles.js ait instancié window.profileManager. Ce dernier est
 // créé dans le handler DOMContentLoaded de profiles.js, qui s'exécute après
 // celui d'init.js : on ne peut donc pas y compter au moment de l'appel.
 // On résout immédiatement s'il est déjà là, sinon on attend l'événement
 // 'profilemanager:ready' émis par profiles.js (plus de scrutation en boucle).
 function waitForProfileManager(timeoutMs = 3000) {
     return new Promise((resolve, reject) => {
         if (window.profileManager) {
             resolve(window.profileManager);
             return;
         }
         let timer;
         const onReady = () => {
             clearTimeout(timer);
             window.removeEventListener('profilemanager:ready', onReady);
             resolve(window.profileManager);
         };
         window.addEventListener('profilemanager:ready', onReady);
         timer = setTimeout(() => {
             window.removeEventListener('profilemanager:ready', onReady);
             if (window.profileManager) {
                 resolve(window.profileManager);
             } else {
                 reject(new Error('profileManager not available'));
             }
         }, timeoutMs);
     });
 }

document.addEventListener('DOMContentLoaded', async function() {
    // initialisation des elements de Materialize
    initTabs();
    initModals();
    initTooltips();
    // Note: initSelect() supprimé — l'init globale sur des <select> cachés schedule
    // des RAF (requestAnimationFrame) en Materialize qui crashent quand le destroy()
    // ultérieur vide _inputEl. Chaque select est initialisé individuellement par
    // la fonction qui le gère (populateCountryStateSelects, init_ui, etc.)
    initPickers();

    // initialisation des elements Bootstrap/Tabler (coexistence pendant la migration)
    // Les sélecteurs ciblent uniquement les composants migrés (classes .bs-* / data-bs-*)
    // pour éviter les conflits avec les composants Materialize encore présents.
    initBsTabs();
    initBsModals();
    initBsTooltips();
    initBsDropdowns();

    // Lancer en parallèle les trois requêtes réseau indépendantes du démarrage :
    // couleurs GC, valeurs par défaut et paramètres utilisateur. Aucune ne dépend
    // d'une donnée locale ; seule l'APPLICATION de leurs résultats a un ordre
    // (imposé plus bas). Les lancer ensemble plutôt qu'en série réduit le
    // time-to-map (elles se recouvrent au lieu de s'additionner).
    const gcColorsPromise = pkg.requetedefaultGcColors();
    const defaultValuesPromise = pkg.getDefaultValues();
    const userSettingsPromise = fetchUserSettings();

    // check la présence d'une BDD et les affiche (fire-and-forget, indépendant)
    pkg.readBddValues();

    // Les valeurs par défaut sont requises pour initialiser la classe "options".
    const optionsValues = await defaultValuesPromise;
    console.log('🚀 [INIT] Valeurs par défaut chargées:', {
        point_mode: optionsValues.point?.mode,
        all_options: optionsValues
    });

    // initialisation de la classe "options"
    pkg.options.init(optionsValues);
    console.log('🚀 [INIT] Options initialisées avec valeurs par défaut:', {
        point_mode: pkg.options.point?.mode,
        all_options: pkg.options
    });

    // Appliquer les paramètres utilisateur : leur requête a été lancée en
    // parallèle ci-dessus, mais leur application doit venir APRÈS options.init()
    // car elle mute pkg.options.options (langue, checkVersion).
    applyUserSettings(await userSettingsPromise);
    console.log('🚀 [INIT] Après applyUserSettings:', {
        point_mode: pkg.options.point?.mode,
        language: pkg.options.options?.language,
        checkVersion: pkg.options.options?.checkVersion
    });

    // Les couleurs GC doivent être prêtes avant tout rendu de points. La requête
    // tourne depuis le début ; on garantit ici seulement qu'elle est terminée
    // avant createMap() et la suite.
    await gcColorsPromise;

    // Initialiser la carte uniquement une fois que les options sont prêtes
    pkg.createMap();

    // check la version
    pkg.checkVersionInit();
    //creation des différentes cartographies
    pkg.addMaps();

    console.log('🚀 [INIT] Avant init_ui():', {
        point_mode: pkg.options.point?.mode
    });

    // mets les valeurs par défaut dans les formulaire
    //(optionsValues);
    pkg.init_ui();

    console.log('🚀 [INIT] Après init_ui() - état du switch:', {
        switch_checked: document.getElementById('switchIconeVectoriel')?.checked,
        point_mode: pkg.options.point?.mode
    });

    // Charger le profil par défaut APRÈS l'initialisation complète de l'interface
    console.log('🚀 [INIT] Interface initialisée, chargement du profil par défaut...');
    let defaultProfileApplied = false;
    try {
        const pm = await waitForProfileManager();
        await pm.loadDefaultProfileAtStartup();
        defaultProfileApplied = !!(pm && pm.currentProfile && pm.currentProfile.uid);
    } catch (e) {
        console.warn('⚠️ [INIT] Chargement profil par défaut ignoré:', e?.message || e);
    }

    if (!defaultProfileApplied) {
        // affiche la bonne carte
        pkg.selectDefaultCarto();
        // centrer la carte
        pkg.centerMap();
    }

    // Appliquer les préférences utilisateur (centre/zoom) même si un profil a été appliqué
    applyUserMapDefaults();

    // affiche les frames (infos, titre) si elles existent
    // (après le profil par défaut, pour éviter un "saut" visuel)
    pkg.displayFrames();

    pkg.readBdd();  // creation du geojson et des metadatas
});


// initialisation des Tabs de Materialize (exclut les tabs migrées .nav-tabs)
// Materialize n'est plus chargé — ces fonctions sont des no-ops de sécurité
function initTabs() {
    var elemsTabs = document.querySelectorAll('.tabs:not(.nav-tabs)');
    if (elemsTabs.length === 0 || typeof M === 'undefined') return;
    M.Tabs.init(elemsTabs, {});
}


// initialisation des Modals de Materialize (exclut les modals migrées .bs-modal)
function initModals() {
    var elemsModals = document.querySelectorAll('.modal:not(.bs-modal)');
    if (elemsModals.length === 0 || typeof M === 'undefined') return;
    M.Modal.init(elemsModals, {});
}

// initialisation des Tooltips de Materialize (exclut les tooltips migrés vers Bootstrap 5)
function initTooltips() {
    var elemsTooltips = document.querySelectorAll('.tooltipped:not([data-bs-toggle="tooltip"])');
    if (elemsTooltips.length === 0 || typeof M === 'undefined') return;
    M.Tooltip.init(elemsTooltips, {});
}

// initialisation des Selects de Materialize (exclut les selects migrés vers Tom Select)
function initSelect() {
    var elems = document.querySelectorAll('select:not(.tomselected)');
    if (elems.length === 0 || typeof M === 'undefined') return;
    var options = {}; // Options par défaut pour les selects Materialize
    M.FormSelect.init(elems, options);
}


// initialisation des Pickers de Materialize (exclut les datepickers migrés .td-input)
function initPickers() {
    console.log("initPickers")
    var elems = document.querySelectorAll('.datepicker:not(.td-input)');
    if (elems.length === 0 || typeof M === 'undefined') return;
    // Format de date du PIcker. TODO permettre de choisir pour tout le programme, le format de la date
    const options = {format: 'yyyy-mm-dd'}
    M.Datepicker.init(elems, options);
}

// Applique centre/zoom depuis les préférences utilisateur (settings)
function applyUserMapDefaults() {
    try {
        const s = window.userSettings;
        const map = pkg.getMap && pkg.getMap();
        if (!s || !map || !map.getView) return;
        const view = map.getView();
        let applied = false;

        if (Array.isArray(s.map_default_center) && s.map_default_center.length === 2) {
            const lat = parseFloat(s.map_default_center[0]);
            const lon = parseFloat(s.map_default_center[1]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                const webMercator = ol.proj.fromLonLat([lon, lat]);
                view.setCenter(webMercator);
                applied = true;
            }
        }

        if (typeof s.map_default_zoom === 'number' || typeof s.map_default_zoom === 'string') {
            const z = parseInt(s.map_default_zoom);
            if (Number.isFinite(z)) {
                view.setZoom(z);
                applied = true;
            }
        }

        if (applied) {
            console.log('[INIT] Carte centrée selon préférences utilisateur', {
                center: s.map_default_center,
                zoom: s.map_default_zoom
            });
        }
    } catch(e) {
        console.warn('[INIT] applyUserMapDefaults error:', e);
    }
}

// recupération des options par défaut et les stocke dans sessionStorage dans la variable optionsValues
export function getDefaultValues() {
    return requeteDefaultValues().then(optionsValues => {
        localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
        return optionsValues;
    });
}

// Récupère les paramètres utilisateur depuis le serveur (sans les appliquer).
// Séparé de l'application pour pouvoir lancer la requête tôt, en parallèle des
// autres fetchs de démarrage, tout en n'appliquant les valeurs qu'une fois la
// classe options initialisée. Renvoie l'objet paramètres, ou null en cas
// d'échec (le démarrage se poursuit alors avec les valeurs par défaut).
async function fetchUserSettings() {
    try {
        console.log('📥 [USER_SETTINGS] Chargement des paramètres utilisateur...');
        const response = await fetch(`${CONFIG.BASE_URL}/api/settings`);
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }
        const userSettings = await response.json();
        console.log('📥 [USER_SETTINGS] Paramètres utilisateur chargés:', userSettings);
        // Exposé tôt : applyUserMapDefaults() lit window.userSettings plus tard.
        try {
            window.userSettings = userSettings;
        } catch(_) {}
        return userSettings;
    } catch (error) {
        console.warn('📥 [USER_SETTINGS] Impossible de charger les paramètres utilisateur:', error.message);
        console.log('📥 [USER_SETTINGS] Utilisation des paramètres par défaut');
        return null;
    }
}

// Applique les paramètres utilisateur aux options locales. Doit être appelée
// APRÈS pkg.options.init() : elle mute pkg.options.options.
function applyUserSettings(userSettings) {
    if (!userSettings) return;

    if (userSettings.language) {
        pkg.options.options.language = userSettings.language;
        console.log('📥 [USER_SETTINGS] Langue appliquée:', userSettings.language);
        document.cookie = `gcmap_lang=${userSettings.language}; path=/; max-age=31536000; samesite=Lax`;
        // Sauvegarder dans localStorage pour cohérence
        localStorage.setItem('selectedLanguage', userSettings.language);
    }

    if (typeof userSettings.check_updates === 'boolean') {
        pkg.options.options.checkVersion = userSettings.check_updates;
        console.log('📥 [USER_SETTINGS] Option checkVersion appliquée:', userSettings.check_updates);
    }

    console.log('📥 [USER_SETTINGS] État après application:', {
        language: pkg.options.options.language,
        checkVersion: pkg.options.options.checkVersion,
        point_mode: pkg.options.point?.mode  // Vérifier si les points sont affectés
    });
}

// fait la requête pour récupere les options par défaut
async function requeteDefaultValues(){
    try {
        const response = await fetch(`${CONFIG.BASE_URL}/static/json/defaultValues.json`);
        if (!response.ok) {
            const errorMsg = `Erreur réseau (${response.status}): ${response.statusText}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Erreur lors du chargement des valeurs par défaut:', error);
        // Retourner des valeurs par défaut en cas d'erreur
        return {
            map: { center: [48.8566, 2.3522], zoom: 10 },
            point: { size: 8, color: '#ff0000' },
            animation: { speed: 1, timePerDay: 50, extraEndSeconds: 0 },
            infos: { show: true },
            flash: { show: false },
            date: { format: 'yyyy-mm-dd' },
            record: { numberOfDigits: 4 }
        };
    }
}
