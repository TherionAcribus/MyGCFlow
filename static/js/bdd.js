import * as pkg from './index.js';
import { CONFIG } from './init.js';

const btnuploadBddForm = document.getElementById('uploadBddForm');
btnuploadBddForm.addEventListener('submit', uploadBddRequest);

export let metadata;
export let json_data;
// Index pré-calculé des points par date pour optimiser l'animation
export let pointsByDate = new Map();

// TODO Gestion des erreurs
// CHoix de la BDD 
// Visualisation des informations
// Résumé des informations à améliorer (nombre de points)

// TODO Vu qu'il y a json_data, faut il garder json ? 

// chargement d'un fichier dans la BDD
function uploadBddRequest(e){
    e.preventDefault();

    var formData = new FormData();
    var fileInput = document.getElementById('file-input');
    formData.append('file', fileInput.files[0]);

    // Afficher un toast de chargement non-bloquant
    const loadingToast = pkg.showLoadingToast("Analyse du fichier GPX en cours...", "Analyse");

    // d'abord on vérifie que le fichier soit correcte
    fetch (`${CONFIG.BASE_URL}/analyse_file`, {
        method: 'POST',
        body: formData,
    }).then (response => response.json())
    .then (data => {
        console.log("data", data);
        if (data.success) {
            console.log("success");
            // Masquer le toast d'analyse et commencer le chargement
            pkg.hideToast(loadingToast);
            uploadBdd();
        } else {
            // Erreur d'analyse
            pkg.hideToast(loadingToast);
            pkg.showToast(data.message, "error", "Erreur d'analyse");
        }
    })
    .catch(error => {
        pkg.hideToast(loadingToast);
        pkg.showToast("Erreur lors de l'analyse du fichier", "error", "Erreur");
        console.error("Erreur analyse:", error);
    });
}


function uploadBdd (){
    var formData = new FormData();
    var fileInput = document.getElementById('file-input');
    formData.append('file', fileInput.files[0]);

    // Afficher un toast de chargement avec progress bar
    const uploadToast = pkg.showLoadingToast("Chargement du fichier GPX en cours...", "Chargement");

    fetch(`${CONFIG.BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
    })
    .then(response => response.json())
    .then(data => {
        console.log("data", data);
        // Masquer le toast et afficher succès
        pkg.hideToast(uploadToast);
        pkg.showToast("Fichier chargé avec succès !", "success", "Terminé");

        // mets à jour les infos de la BDD
        readBddValues();
    })
    .catch(error => {
        console.error('Error:', error);
        pkg.hideToast(uploadToast);
        pkg.showToast("Erreur lors du chargement du fichier", "error", "Erreur");
    });

    // Démarrer la surveillance du progrès
    checkLoadingProgress(uploadToast);
}

function checkLoadingProgress(uploadToast) {
    fetch(`${CONFIG.BASE_URL}/progressBar`)
        .then(response => response.json())
        .then(data => {
            // Mettre à jour la progress bar du toast
            pkg.updateToastProgress(uploadToast, data.progress);

            // Mettre à jour le message du toast avec les détails
            const messageElement = uploadToast.querySelector('.toast-message');
            if (messageElement && data.message) {
                messageElement.textContent = data.message;
            }

            console.log(data.progress);
            if (data.progress < 100) {
                setTimeout(() => checkLoadingProgress(uploadToast), 200); // Un peu moins fréquent
            } else {
                // Chargement terminé - masquer le toast après un court délai
                setTimeout(() => {
                    pkg.hideToast(uploadToast);
                    pkg.showToast("Base de données prête !", "success", "Prêt");
                }, 500);
            }
        })
        .catch(error => {
            console.error('Error:', error);
            pkg.hideToast(uploadToast);
            pkg.showToast("Erreur lors du suivi du progrès", "error", "Erreur");
        });
}

// regarde si une base de données est disponible et si elle est remplie
export function readBddValues() {
    fetch(`${CONFIG.BASE_URL}/db_status`)
        .then(response => response.json())
        .then(data => {
            console.log(data);
            showBddInfos(data);
        })
        .catch(error => console.error('Error:', error));
}

// affiche le texte d'information sur la BDD
function showBddInfos(data){
    let infos = ""
    if (data.exists){
        infos = "La base de données SQL Lite est disponible."
    } else {
        infos = "La base de données SQL Lite n'est pas disponible. Quelque chose s'est mal déroulé lors de l'initialisation du programme."
    }

    if (data.size > 0){
        infos += " La base de données fait " + data.size + " octets."
    } else {
        infos += " La base de données est vide. Vous devez commencer par ajouter un nouveau fichier .gpx avec vos trouvailles. EXPLICATIONS "
    }

    if (data.exists){
        infos += "\n 1er enregistrement : " + data.startDate + "\n Dernier enregistrement : " + data.endDate
    } else {
        infos += " La base de données est vide. Vous devez commencer par ajouter un nouveau fichier .gpx avec vos trouvailles. EXPLICATIONS "
    }

    const divInfosBDD = document.getElementById('infosBDD');

    divInfosBDD.innerHTML = infos;
}

// Pré-calcule l'index des points par date pour optimiser l'animation
function buildPointsByDateIndex(features) {
    pointsByDate.clear();
    console.log(`Pré-calcul de l'index pour ${features.length} points...`);

    features.forEach(feature => {
        const dateStr = feature.properties.date_find;
        if (dateStr) {
            // Utilise seulement la date (YYYY-MM-DD) comme clé, pas l'heure
            const date = new Date(dateStr);
            const dateKey = date.toDateString();

            if (!pointsByDate.has(dateKey)) {
                pointsByDate.set(dateKey, []);
            }
            pointsByDate.get(dateKey).push(feature);
        }
    });

    console.log(`Index créé avec ${pointsByDate.size} dates différentes`);
}

export function readBdd(){
    fetch(`${CONFIG.BASE_URL}/get_geojson_points`)
    .then(response => response.json())
    .then(data => {
        json_data = data.geojson;
        metadata = data.metadata;

        // Pré-calcul de l'index des points par date pour optimiser l'animation
        buildPointsByDateIndex(data.geojson.features);

        // conversion en objet date
        dateStrToDate();
        // MAJ des frames Infos
        pkg.updateInfosFrameAfterReadBdd(metadata);
        // MAJ du menu d'animation
        pkg.updateAnimationMenuAfterReadBdd(metadata);
        // mise à jour des Date Pickers de l'ui (filtre BDD)
        pkg.setPickerDates(metadata)
        // mise à jour des options en fonction de la BDD (dates début et fin)
        updateOptionsValues(metadata);
        pkg.addVector(data.geojson);
    })
    .catch(error => console.error('Error:', error));
}

function dateStrToDate(){
    metadata.startDate = new Date(metadata.startDate);
    metadata.endDate = new Date(metadata.endDate);
}

// mise à jour des optionsValues en fonction de la BDD (nbr jours pour l'instant)
// appelé à l'init de la BDD et si filtrage
export function updateOptionsValues(metadata){
    pkg.options.date.deltaDays = metadata.deltaDays;
    // MAj, nombre frame, nbre images, 
    pkg.updateInfosForPictures();
}


// Si on change le filtre de la BDD on refait une requete
export function changeSelect(selectedValues, optionValues) {
    fetch(`${CONFIG.BASE_URL}/filter_caches`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', // Spécifie le type de contenu envoyé
        },
        body: JSON.stringify({ types: selectedValues }), // Convertit l'objet en chaîne JSON
    })
    .then(response => response.json())
    .then(data => {
        console.log(data);
        json_data = data.geojson;
        metadata = data.metadata;

        // Reconstruit l'index des points par date avec les données filtrées
        buildPointsByDateIndex(data.geojson.features);

        // conversion en objet date
        dateStrToDate();
        // remets à jour les options/infos dépendant de la BDD (delayDate)
        updateOptionsValues(metadata);
        // MAJ des frames Infos
        pkg.updateInfosFrameAfterReadBdd(metadata);
        pkg.refreshPoints(optionValues);
    })
    .catch(error => console.error('Error:', error));
}
