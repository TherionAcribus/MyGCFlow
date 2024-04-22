// DEMARRAGE
// .\virtual\Scripts\activate    
// flask --app app.py --debug run

// Importation de Materialize CSS et JS

//import '../css/materialize-colorpicker.min.css';
//import '../js/materialize-colorpicker.min.js';
// TODO : A implanter ou a supprimer

import * as pkg from './index.js';

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
    pkg.getDefaultValues().then(optionsValues => {
        // initialisation de la classe "options"
        pkg.options.init(optionsValues);
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

// fait la requête pour récupere les options par défaut
async function requeteDefaultValues(){
    try {
        const response = await fetch('http://localhost:5000/static/json/defaultValues.json');
        if (!response.ok) {
            throw new Error('Network response was not ok ' + response.statusText);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('There has been a problem with your fetch operation:', error);
    }
}


