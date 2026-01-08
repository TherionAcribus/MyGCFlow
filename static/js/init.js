// DEMARRAGE
// .\virtual\Scripts\activate
// flask --app app.py --debug run

// Importation de Materialize CSS et JS

//import '../css/materialize-colorpicker.min.css';
//import '../js/materialize-colorpicker.min.js';
// TODO : A implanter ou a supprimer

import * as pkg from './index.js';

// Configuration de base - URL dynamique pour éviter les URLs en dur
export const CONFIG = {
    BASE_URL: window.location.origin,
    API_BASE: `${window.location.origin}`
};

 function waitForProfileManager(timeoutMs = 3000, intervalMs = 50) {
     const startedAt = Date.now();
     return new Promise((resolve, reject) => {
         const tick = () => {
             if (window.profileManager) {
                 resolve(window.profileManager);
                 return;
             }
             if (Date.now() - startedAt > timeoutMs) {
                 reject(new Error('profileManager not available'));
                 return;
             }
             setTimeout(tick, intervalMs);
         };
         tick();
     });
 }

document.addEventListener('DOMContentLoaded', async function() {
    // initialisation des elements de Materialize
    initTabs();
    initModals();
    initTooltips();
    initSelect();
    initPickers();

    await pkg.requetedefaultGcColors();

    // check la présence d'une BDD et les affiche
    pkg.readBddValues();

    // Vérifier si la base est vide pour afficher la modale de première utilisation
    setTimeout(() => {
        pkg.checkDatabaseOnStartup();
    }, 500); // Délai pour laisser le temps aux autres initialisations

    // recupération des options par défaut puis on initialise l'interface
    const optionsValues = await pkg.getDefaultValues();
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

    // Charger les paramètres utilisateur sauvegardés (comme pour les profils)
    await loadUserSettings();
    console.log('🚀 [INIT] Après loadUserSettings:', {
        point_mode: pkg.options.point?.mode,
        language: pkg.options.options?.language,
        checkVersion: pkg.options.options?.checkVersion
    });

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

    // affiche les frames (infos, titre) si elles existent
    // (après le profil par défaut, pour éviter un "saut" visuel)
    pkg.displayFrames();

    pkg.readBdd();  // creation du geojson et des metadatas
});


// initialisation des Tabs de Materialize
function initTabs() {
    var elemsTabs = document.querySelectorAll('.tabs');
    M.Tabs.init(elemsTabs, {});
}


// initialisation des Modals de Materialize
function initModals() {
    var elemsModals = document.querySelectorAll('.modal');
    M.Modal.init(elemsModals, {});
}

// initialisation des Tooltips de Materialize
function initTooltips() {
    var elemsTooltips = document.querySelectorAll('.tooltipped');
    M.Tooltip.init(elemsTooltips, {});
}

// initialisation des Selects de Materialize
function initSelect() {
    var elems = document.querySelectorAll('select');
    var options = {}; // Options par défaut pour les selects Materialize
    var instances = M.FormSelect.init(elems, options);
}


// initialisation des Pickers de Materialize
function initPickers() {
    console.log("initPickers")
    var elems = document.querySelectorAll('.datepicker');
    // Format de date du PIcker. TODO permettre de choisir pour tout le programme, le format de la date
    const options = {format: 'yyyy-mm-dd'}
    var instances = M.Datepicker.init(elems, options);
}

// recupération des options par défaut et les stocke dans sessionStorage dans la variable optionsValues
export function getDefaultValues() {
    return requeteDefaultValues().then(optionsValues => {
        localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
        return optionsValues;
    });
}

// Charger et appliquer les paramètres utilisateur sauvegardés
async function loadUserSettings() {
    try {
        console.log('📥 [USER_SETTINGS] Chargement des paramètres utilisateur...');
        const response = await fetch(`${CONFIG.BASE_URL}/api/settings`);
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const userSettings = await response.json();
        console.log('📥 [USER_SETTINGS] Paramètres utilisateur chargés:', userSettings);

        // Appliquer les paramètres utilisateur aux options locales
        if (userSettings.language) {
            pkg.options.options.language = userSettings.language;
            console.log('📥 [USER_SETTINGS] Langue appliquée:', userSettings.language);
            document.cookie = `gcmap_lang=${userSettings.language}; path=/; max-age=31536000; samesite=Lax`;
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

        // Sauvegarder dans localStorage pour cohérence
        if (userSettings.language) {
            localStorage.setItem('selectedLanguage', userSettings.language);
        }

    } catch (error) {
        console.warn('📥 [USER_SETTINGS] Impossible de charger les paramètres utilisateur:', error.message);
        console.log('📥 [USER_SETTINGS] Utilisation des paramètres par défaut');
    }
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
