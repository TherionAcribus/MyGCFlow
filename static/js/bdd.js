import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showInfo } from './notifications.js';
import { clearMap } from './mapgl.js';

const btnuploadBddForm = document.getElementById('uploadBddForm');
btnuploadBddForm.addEventListener('submit', uploadBddRequest);

// Gestionnaire pour le chargement automatique lors de la sélection de fichier
const fileInput = document.getElementById('file-input');
if (fileInput) {
    fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            // Lancer automatiquement le chargement quand un fichier est sélectionné
            uploadBddRequest(e);
        }
    });
}

// Bouton pour vider la base de données
const btnClearDatabase = document.getElementById('clearDatabaseBtn');
if (btnClearDatabase) {
    btnClearDatabase.addEventListener('click', clearDatabaseWithConfirmation);
}

// Formulaire de chargement dans la modale de première utilisation
const btnUploadBddFormModal = document.getElementById('uploadBddFormModal');
if (btnUploadBddFormModal) {
    btnUploadBddFormModal.addEventListener('submit', uploadBddRequestFromModal);
}

// Gestionnaire pour le chargement automatique dans la modale lors de la sélection de fichier
const fileInputModal = document.getElementById('file-input-modal');
if (fileInputModal) {
    fileInputModal.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            // Lancer automatiquement le chargement quand un fichier est sélectionné
            uploadBddRequestFromModal(e);
        }
    });
}

export let metadata;
export let json_data;
let totalCaches = 0; // total initial (toutes caches de la BDD)
// Index pré-calculé des points par date pour optimiser l'animation
export let pointsByDate = new Map();
// Toasts de chargement
let readLoadingToast = null;
let filterLoadingToast = null;

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
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError("Veuillez sélectionner un fichier .gpx", "Aucun fichier");
        return;
    }

    formData.append('file', selectedFile);

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
        
        // Charger et afficher les points sur la carte
        loadAndDisplayPoints();
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
    const divInfosBDD = document.getElementById('infosBDD');
    let htmlContent = '';
    
    if (!data.exists) {
        // Base de données n'existe pas
        htmlContent = `
            <div class="chip red lighten-4 red-text">
                <i class="material-icons tiny">error</i>
                Base de données non trouvée
            </div>
            <p class="grey-text">
                La base de données SQLite n'existe pas encore. 
                Commencez par charger un fichier .gpx avec vos trouvailles.
            </p>
        `;
        divInfosBDD.className = 'mt-3';
        
    } else if (data.isEmpty) {
        // Base de données existe mais est vide
        htmlContent = `
            <div class="chip orange lighten-4 orange-text">
                <i class="material-icons tiny">warning</i>
                Base de données vide
            </div>
            <p class="grey-text">
                La base de données SQLite existe mais ne contient aucune donnée.<br>
                Taille du fichier : <strong>${formatFileSize(data.size)}</strong>
            </p>
            <p class="grey-text">
                Chargez un fichier .gpx pour commencer à utiliser l'application.
            </p>
        `;
        divInfosBDD.className = 'mt-3';
        
    } else {
        // Base de données existe et contient des données
        htmlContent = `
            <div class="chip green lighten-4 green-text">
                <i class="material-icons tiny">check_circle</i>
                Base de données chargée
            </div>
            <div class="db-info-grid" style="margin-top: 10px;">
                <div class="row" style="margin-bottom: 5px;">
                    <div class="col s6">
                        <span class="grey-text text-darken-1">Nombre de points :</span>
                    </div>
                    <div class="col s6">
                        <strong>${data.totalPoints.toLocaleString()}</strong>
                    </div>
                </div>
                
                <div class="row" style="margin-bottom: 5px;">
                    <div class="col s6">
                        <span class="grey-text text-darken-1">Taille du fichier :</span>
                    </div>
                    <div class="col s6">
                        <strong>${formatFileSize(data.size)}</strong>
                    </div>
                </div>
                
                ${data.loadDate ? `
                <div class="row" style="margin-bottom: 5px;">
                    <div class="col s6">
                        <span class="grey-text text-darken-1">Dernière mise à jour :</span>
                    </div>
                    <div class="col s6">
                        <strong>${formatDate(data.loadDate)}</strong>
                    </div>
                </div>
                ` : ''}
                
                ${data.startDate && data.endDate ? `
                <div class="row" style="margin-bottom: 5px;">
                    <div class="col s6">
                        <span class="grey-text text-darken-1">Période couverte :</span>
                    </div>
                    <div class="col s6">
                        <strong>${formatDate(data.startDate)} - ${formatDate(data.endDate)}</strong>
                    </div>
                </div>
                ` : ''}
            </div>
        `;
        divInfosBDD.className = 'mt-3';
        
        // Afficher le bouton de vidage si la base de données contient des données
        showClearDatabaseButton();
    }
    
    divInfosBDD.innerHTML = htmlContent;
}

// Fonction utilitaire pour formater la taille de fichier
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Fonction utilitaire pour formater les dates
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateString; // Retourner la chaîne originale si le parsing échoue
    }
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
    try { readLoadingToast = pkg.showLoadingToast("Chargement de l'application...", "Chargement"); } catch(e) {}
    fetch(`${CONFIG.BASE_URL}/get_geojson_points`)
    .then(response => response.json())
    .then(data => {
        json_data = data.geojson;
        metadata = data.metadata;

        // Mémoriser le total de caches initial
        totalCaches = metadata.numberOfCaches || (data.geojson?.features?.length || 0);

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

        // Mettre à jour le compteur : sélection = total au chargement initial
        updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);
        try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
    })
    .catch(error => { console.error('Error:', error); try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {} });
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
    try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } filterLoadingToast = pkg.showLoadingToast("Filtrage des caches...", "Filtrage"); } catch(e) {}
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

        // Mettre à jour le compteur : sélection courante / total initial
        updateFiltersCounter(metadata.numberOfCaches || (data.geojson?.features?.length || 0), totalCaches);
        try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {}
    })
    .catch(error => { console.error('Error:', error); try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {} });
}

function updateFiltersCounter(selected, total){
    try {
        const el = document.getElementById('filtersCounter');
        if (el) {
            el.textContent = `Sélection: ${selected} / ${total}`;
        }
    } catch(e) { console.warn('updateFiltersCounter error', e); }
}

// Fonction pour afficher une confirmation avant de vider la base de données
function clearDatabaseWithConfirmation() {
    // Créer une modale de confirmation en utilisant la même structure que celle des mises à jour
    const modalId = 'clear-database-modal-' + Date.now();
    
    const modalHTML = `
        <div id="${modalId}" class="modal">
            <div class="modal-content">
                <div class="center-align">
                    <i class="material-icons large red-text">warning</i>
                    <h4>Vider la base de données</h4>
                    <p class="flow-text">
                        Êtes-vous sûr de vouloir vider complètement la base de données ?
                    </p>
                    <p class="red-text">
                        <strong>⚠️ Cette action est irréversible !</strong><br>
                        Toutes les données seront définitivement supprimées :
                    </p>
                    <ul class="left-align" style="display: inline-block;">
                        <li>• Tous les points de géocaches</li>
                        <li>• Les données GeoJSON</li>
                        <li>• L'historique des trouvailles</li>
                        <li>• Les filtres appliqués</li>
                    </ul>
                </div>
            </div>
            <div class="modal-footer">
                <div class="center-align">
                    <button class="waves-effect waves-light btn red" onclick="confirmClearDatabase('${modalId}')">
                        <i class="material-icons left">delete_forever</i>
                        Vider définitivement
                    </button>
                    <button class="waves-effect waves-light btn-flat modal-close">
                        <i class="material-icons left">close</i>
                        Annuler
                    </button>
                </div>
            </div>
        </div>
    `;
    
    // Ajouter la modale au DOM
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    
    // Initialiser et ouvrir la modale Materialize
    const modalElement = document.getElementById(modalId);
    const modal = M.Modal.init(modalElement, {
        dismissible: true,
        onCloseEnd: function() {
            // Supprimer la modale du DOM après fermeture
            modalElement.remove();
        }
    });
    
    modal.open();
}

// Fonction globale pour confirmer le vidage (appelée depuis la modale)
window.confirmClearDatabase = function(modalId) {
    // Fermer la modale
    const modalElement = document.getElementById(modalId);
    if (modalElement) {
        const modal = M.Modal.getInstance(modalElement);
        modal.close();
    }
    
    // Effectuer le vidage
    clearDatabase();
};

// Fonction pour effectuer le vidage de la base de données
async function clearDatabase() {
    let clearingToast = null;
    
    try {
        // Afficher un toast de chargement
        clearingToast = pkg.showLoadingToast("Vidage de la base de données...", "Suppression");
        
        // Appel à l'endpoint pour vider la base de données
        const response = await fetch('/clear_database', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Vider les données locales
            clearLocalData();
            
            // Vider la carte
            clearMap();
            
            // Mettre à jour l'interface
            updateUIAfterClear();
            
            // Masquer le toast de chargement et afficher le succès
            if (clearingToast) {
                pkg.hideToast(clearingToast);
            }
            showSuccess("Base de données vidée avec succès", "Suppression réussie");
            
        } else {
            throw new Error(result.message || 'Erreur inconnue');
        }
        
    } catch (error) {
        console.error('Erreur lors du vidage de la base de données:', error);
        
        if (clearingToast) {
            pkg.hideToast(clearingToast);
        }
        showError("Erreur lors du vidage de la base de données: " + error.message, "Erreur");
    }
}

// Fonction pour vider les données locales
function clearLocalData() {
    // Réinitialiser les variables globales
    json_data = null;
    metadata = null;
    totalCaches = 0;
    pointsByDate.clear();
    
    console.log('[CLEAR] Données locales vidées');
}

// Fonction pour mettre à jour l'interface après vidage
function updateUIAfterClear() {
    // Masquer le bouton de vidage
    const btnClearDatabase = document.getElementById('clearDatabaseBtn');
    if (btnClearDatabase) {
        btnClearDatabase.style.display = 'none';
    }
    
    // Mettre à jour les informations de la base de données
    // Relancer la vérification du statut de la base de données pour afficher l'état correct
    readBddValues();
    
    // Réinitialiser le compteur de filtres
    updateFiltersCounter(0, 0);
    
    // Réinitialiser le champ de fichier
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.value = '';
    }
    
    // Réinitialiser le champ de chemin de fichier Materialize
    const filePathInput = document.querySelector('.file-path');
    if (filePathInput) {
        filePathInput.value = '';
    }
    
    console.log('[CLEAR] Interface mise à jour après vidage');
}

// Fonction pour afficher le bouton de vidage (appelée quand des données sont chargées)
export function showClearDatabaseButton() {
    const btnClearDatabase = document.getElementById('clearDatabaseBtn');
    if (btnClearDatabase) {
        btnClearDatabase.style.display = 'block';
    }
}

// Fonction pour vérifier le statut de la base de données au démarrage et ouvrir la modale si nécessaire
export function checkDatabaseOnStartup() {
    fetch(`${CONFIG.BASE_URL}/db_status`)
        .then(response => response.json())
        .then(data => {
            console.log('Statut de la base au démarrage:', data);
            
            // Si la base n'existe pas ou est vide, ouvrir la modale de première utilisation
            if (!data.exists || data.isEmpty) {
                openFirstUseModal();
            }
        })
        .catch(error => {
            console.error('Erreur lors de la vérification de la base au démarrage:', error);
            // En cas d'erreur, ouvrir quand même la modale pour être sûr
            openFirstUseModal();
        });
}

// Fonction pour ouvrir la modale de première utilisation
function openFirstUseModal() {
    const modalElement = document.getElementById('modal_first_use');
    if (modalElement) {
        const modal = M.Modal.init(modalElement, {
            dismissible: true,
            preventScrolling: true
        });
        modal.open();
        console.log('[FIRST_USE] Modale de première utilisation ouverte');
    }
}

// Fonction pour gérer le chargement de fichier depuis la modale
function uploadBddRequestFromModal(e) {
    e.preventDefault();

    var formData = new FormData();
    var fileInput = document.getElementById('file-input-modal');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError("Veuillez sélectionner un fichier .gpx", "Aucun fichier");
        return;
    }

    formData.append('file', selectedFile);

    // Afficher un toast de chargement avec progress bar
    const uploadToast = pkg.showLoadingToast("Chargement du fichier GPX en cours...", "Chargement");

    fetch(`${CONFIG.BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
    })
    .then(response => response.json())
    .then(data => {
        console.log("data depuis modale", data);
        // Masquer le toast et afficher succès
        pkg.hideToast(uploadToast);
        showSuccess("Fichier chargé avec succès !", "Chargement terminé");

        // Fermer la modale de première utilisation
        const modalElement = document.getElementById('modal_first_use');
        if (modalElement) {
            const modal = M.Modal.getInstance(modalElement);
            if (modal) {
                modal.close();
            }
        }

        // Mettre à jour les infos de la BDD
        readBddValues();
        
        // Charger et afficher les points sur la carte
        loadAndDisplayPoints();
        
        // Optionnel : rediriger vers l'onglet de données
        switchToDataTab();
    })
    .catch(error => {
        console.error('Erreur:', error);
        pkg.hideToast(uploadToast);
        showError("Erreur lors du chargement du fichier", "Erreur");
    });

    // Démarrer la surveillance du progrès
    checkLoadingProgressModal(uploadToast);
}

// Fonction pour surveiller le progrès depuis la modale (similaire à checkLoadingProgress)
function checkLoadingProgressModal(uploadToast) {
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
                setTimeout(() => checkLoadingProgressModal(uploadToast), 200);
            } else {
                // Chargement terminé - masquer le toast après un court délai
                setTimeout(() => {
                    pkg.hideToast(uploadToast);
                    showSuccess("Base de données prête !", "Prêt");
                }, 1000);
            }
        })
        .catch(error => {
            console.error('Erreur lors de la surveillance du progrès:', error);
        });
}

// Fonction pour charger et afficher les points sur la carte après chargement de fichier
function loadAndDisplayPoints() {
    console.log('[LOAD_POINTS] Chargement des points après upload...');
    
    fetch(`${CONFIG.BASE_URL}/get_geojson_points`)
        .then(response => response.json())
        .then(data => {
            console.log('[LOAD_POINTS] Données GeoJSON reçues:', data);
            
            json_data = data.geojson;
            metadata = data.metadata;

            // Mémoriser le total de caches initial
            totalCaches = metadata.numberOfCaches || (data.geojson?.features?.length || 0);

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
            
            // Ajouter les points à la carte
            pkg.addVector(data.geojson);

            // Mettre à jour le compteur : sélection = total au chargement initial
            updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);
            
            console.log('[LOAD_POINTS] Points affichés sur la carte');
        })
        .catch(error => {
            console.error('[LOAD_POINTS] Erreur lors du chargement des points:', error);
            showError("Erreur lors de l'affichage des points sur la carte", "Erreur d'affichage");
        });
}

// Fonction pour basculer vers l'onglet de données
function switchToDataTab() {
    try {
        // Cliquer sur l'onglet "Données" pour l'activer
        const dataTab = document.querySelector('a[href="#data"]');
        if (dataTab) {
            dataTab.click();
        }
    } catch (e) {
        console.warn('Impossible de basculer vers l\'onglet de données:', e);
    }
}
