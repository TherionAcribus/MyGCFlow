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

document.addEventListener('DOMContentLoaded', async function() {     
    // initialisation des elements de Materialize
    initTabs();
    initModals();
    initSelect();
    initPickers();
    pkg.createMap();
    await pkg.requetedefaultGcColors();
    // check la présence d'une BDD et les affiche
    pkg.readBddValues();
    // recupération des options par défaut puis on initialise l'interface
    pkg.getDefaultValues().then(async optionsValues => {
        // initialisation de la classe "options"
        pkg.options.init(optionsValues);

        // Charger les paramètres utilisateur sauvegardés (comme pour les profils)
        await loadUserSettings();

        // check la version
        pkg.checkVersionInit();
        //creation des différentes cartographies
        pkg.addMaps();
        // affiche la bonne carte
        pkg.selectDefaultCarto();
        // centrer la carte
        pkg.centerMap();
        // affiche les frames (infos, titre) si elles existent
        pkg.displayFrames();
        // mets les valeurs par défaut dans les formulaire
        //(optionsValues);
        pkg.init_ui();
        // ... autres fonctions qui dépendent de optionsValues ...
    });
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
        console.log('Chargement des paramètres utilisateur...');
        const response = await fetch(`${CONFIG.BASE_URL}/api/settings`);
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const userSettings = await response.json();
        console.log('Paramètres utilisateur chargés:', userSettings);

        // Appliquer les paramètres utilisateur aux options locales
        if (userSettings.language) {
            pkg.options.options.language = userSettings.language;
            console.log('Langue appliquée:', userSettings.language);
        }

        if (typeof userSettings.check_updates === 'boolean') {
            pkg.options.options.checkVersion = userSettings.check_updates;
            console.log('Option checkVersion appliquée:', userSettings.check_updates);
        }

        // Sauvegarder dans localStorage pour cohérence
        if (userSettings.language) {
            localStorage.setItem('selectedLanguage', userSettings.language);
        }

    } catch (error) {
        console.warn('Impossible de charger les paramètres utilisateur:', error.message);
        console.log('Utilisation des paramètres par défaut');
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
            animation: { speed: 1 },
            infos: { show: true },
            flash: { show: false },
            date: { format: 'yyyy-mm-dd' },
            record: { numberOfDigits: 4 }
        };
    }
}


