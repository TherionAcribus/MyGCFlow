import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showInfo, t } from './notifications.js';
import { clearMap } from './mapgl.js';

export let json_data = null;
export const metadata = {};
export const pointsByDate = new Map();
export let totalCaches = 0;

let readLoadingToast = null;
let filterLoadingToast = null;
let noCacheToast = null;

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

export function readBddValues(){
    try {
        fetch(`${CONFIG.BASE_URL}/db_status`)
        .then(response => response.json())
        .then(data => {
            const infos = document.getElementById('infosBDD');
            const infosModal = document.getElementById('infosBDDModal');

            let text = '';
            if (data && data.exists && data.isEmpty === false) {
                const total = data.totalPoints ?? 0;
                const start = data.startDate ?? '';
                const end = data.endDate ?? '';
                const load = data.loadDate ?? '';
                text = `${total} caches | ${start} → ${end}${load ? ' | ' + load : ''}`;
            } else if (data && data.exists && data.isEmpty === true) {
                text = t('Aucune base de données chargée');
            } else {
                text = t('Aucune base de données chargée');
            }

            if (infos) infos.textContent = text;
            if (infosModal) infosModal.textContent = text;
        })
        .catch(err => {
            console.error('Erreur lecture infos BDD:', err);
        });
    } catch (e) {
        console.error('readBddValues error:', e);
    }
}

function setMetadata(meta) {
    try {
        for (const k of Object.keys(metadata)) {
            delete metadata[k];
        }
        if (meta && typeof meta === 'object') {
            Object.assign(metadata, meta);
        }
        if (metadata.startDate) {
            metadata.startDate = new Date(metadata.startDate);
        }
        if (metadata.endDate) {
            metadata.endDate = new Date(metadata.endDate);
        }
        if (metadata.publishedStartDate) {
            metadata.publishedStartDate = new Date(metadata.publishedStartDate);
        }
        if (metadata.publishedEndDate) {
            metadata.publishedEndDate = new Date(metadata.publishedEndDate);
        }
    } catch (e) {
        console.warn('setMetadata error:', e);
    }
}

function buildPointsByDateIndex(features = []) {
    try {
        pointsByDate.clear();
        if (!Array.isArray(features)) return;

        for (const f of features) {
            const dateStr = f?.properties?.date_find;
            if (!dateStr) continue;
            const d = new Date(`${dateStr}T00:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const key = d.toDateString();
            const arr = pointsByDate.get(key) || [];
            arr.push(f);
            pointsByDate.set(key, arr);
        }
    } catch (e) {
        console.warn('buildPointsByDateIndex error:', e);
    }
}

function dateStrToDate() {
    // Historique: conversion des dates côté frontend.
    // Désormais l'index pointsByDate fait l'essentiel (via buildPointsByDateIndex).
}

function updateOptionsValues(meta) {
    try {
        if (!meta || typeof meta !== 'object') return;
        if (typeof meta.deltaDays === 'number') {
            pkg.options.date.deltaDays = meta.deltaDays;
        }
        if (meta.startDate) {
            pkg.options.date.startDate = new Date(meta.startDate);
        }
        if (meta.endDate) {
            pkg.options.date.endDate = new Date(meta.endDate);
        }
        if (!(pkg.options.animation.dateStart instanceof Date) && meta.startDate) {
            pkg.options.animation.dateStart = new Date(meta.startDate);
        }
        if (!(pkg.options.animation.dateEnd instanceof Date) && meta.endDate) {
            pkg.options.animation.dateEnd = new Date(meta.endDate);
        }
    } catch (e) {
        console.warn('updateOptionsValues error:', e);
    }
}

function pollGeojsonTask(taskId, { onSuccess, onError, intervalMs = 400, timeoutMs = 120000 } = {}) {
    const startedAt = Date.now();

    const tick = () => {
        if (!taskId) {
            if (typeof onError === 'function') onError(new Error('Missing taskId'));
            return;
        }

        if (Date.now() - startedAt > timeoutMs) {
            if (typeof onError === 'function') onError(new Error('Task polling timeout'));
            return;
        }

        fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`, { method: 'GET' })
        .then(r => r.json())
        .then(status => {
            const state = status?.state;

            if (state === 'finished') {
                if (status && status.result) {
                    if (typeof onSuccess === 'function') onSuccess(status.result);
                } else {
                    if (typeof onError === 'function') onError(new Error('Task finished without result'));
                }
                return;
            }

            if (state === 'failed') {
                const msg = status?.error || status?.message || 'Task failed';
                if (typeof onError === 'function') onError(new Error(msg));
                return;
            }

            setTimeout(tick, intervalMs);
        })
        .catch(err => {
            if (typeof onError === 'function') onError(err);
        });
    };

    tick();
}

function checkLoadingProgress(toast, taskId, onSuccess, onError, { intervalMs = 400, timeoutMs = 120000 } = {}) {
    pollGeojsonTask(taskId, {
        intervalMs,
        timeoutMs,
        onSuccess: () => {
            if (typeof onSuccess === 'function') onSuccess();
        },
        onError: (err) => {
            try { if (toast) pkg.hideToast(toast); } catch(_) {}
            if (typeof onError === 'function') onError(err?.message || String(err));
        }
    });
}

function uploadBddRequest(e){
    e.preventDefault();

    var formData = new FormData();
    var fileInput = document.getElementById('file-input');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError(t("Veuillez sélectionner un fichier .gpx"), t("Aucun fichier"));
        return;
    }

    formData.append('file', selectedFile);

    // Afficher un toast de chargement non-bloquant
    const loadingToast = pkg.showLoadingToast(t("Analyse du fichier GPX en cours..."), t("Analyse"));

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
            pkg.showToast(data.message, "error", t("Erreur d'analyse"));
        }
    })
    .catch(error => {
        pkg.hideToast(loadingToast);
        pkg.showToast(t("Erreur lors de l'analyse du fichier"), "error", t("Erreur"));
        console.error("Erreur analyse:", error);
    });
}

function uploadBdd (){
    var formData = new FormData();
    var fileInput = document.getElementById('file-input');
    formData.append('file', fileInput.files[0]);

    // Afficher un toast de chargement avec progress bar
    const uploadToast = pkg.showLoadingToast(t("Chargement du fichier GPX en cours..."), t("Chargement"));

    fetch(`${CONFIG.BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
    })
    .then(response => response.json())
    .then(data => {
        console.log("data", data);
        if (!data.success || !data.task_id) {
            throw new Error(data.message || "Impossible de lancer l'import GPX");
        }

        checkLoadingProgress(uploadToast, data.task_id, () => {
            pkg.hideToast(uploadToast);
            pkg.showToast(t("Fichier chargé avec succès !"), "success", t("Terminé"));

            // mets à jour les infos de la BDD
            readBddValues();
            
            // Charger et afficher les points sur la carte
            loadAndDisplayPoints();
        }, (message) => {
            pkg.hideToast(uploadToast);
            pkg.showToast(message || t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
        });
    })
    .catch(error => {
        console.error('Error:', error);
        pkg.hideToast(uploadToast);
        pkg.showToast(t("Erreur lors du chargement du fichier"), "error", t("Erreur"));
    });
}

export function readBdd(){
    try { readLoadingToast = pkg.showLoadingToast(t("Chargement de l'application..."), t('Chargement')); } catch(e) {}
    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
    .then(response => response.json())
    .then(data => {
        if (!data.task_id) {
            throw new Error(data.message || 'Impossible de lancer le chargement de la BDD');
        }
        pollGeojsonTask(data.task_id, {
            onSuccess: (result) => {
                json_data = result.geojson;
                setMetadata(result.metadata || {});

                // Mémoriser le total de caches initial
                totalCaches = metadata.numberOfCaches || (result.geojson?.features?.length || 0);

                // Pré-calcul de l'index des points par date pour optimiser l'animation
                buildPointsByDateIndex(result.geojson?.features || []);

                // conversion en objet date
                dateStrToDate();
                // MAJ des frames Infos
                pkg.updateInfosFrameAfterReadBdd(metadata);
                // MAJ du menu d'animation
                pkg.updateAnimationMenuAfterReadBdd(metadata);
                // mise à jour des Date Pickers de l'ui (filtre BDD)
                pkg.setPickerDates(metadata);
                // mise à jour des options en fonction de la BDD (dates début et fin)
                updateOptionsValues(metadata);
                clearMap();
                pkg.addVector(result.geojson);

                // Mettre à jour le compteur : sélection = total au chargement initial
                updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);
                try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
            },
            onError: (err) => {
                console.error('Erreur lors du chargement de la BDD:', err);
                try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
                showError(t('Erreur lors du chargement des données'), t('Erreur'));
            }
        });
    })
    .catch(error => {
        console.error('Error:', error);
        try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
        showError(t('Erreur lors du chargement des données'), t('Erreur'));
    });
}

function changeSelect(selectedValues, optionValues) {
    console.log('[FILTER] changeSelect called with selectedValues:', selectedValues);
    console.log('[FILTER] Types selected:', selectedValues.type);
    try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } filterLoadingToast = pkg.showLoadingToast(t('Filtrage des caches...'), t('Filtrage')); } catch(e) {}

    fetch(`${CONFIG.BASE_URL}/filter_caches`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ types: selectedValues }),
    })
    .then(response => response.json())
    .then(data => {
        if (!data.task_id) {
            throw new Error(data.message || 'Impossible de lancer le filtrage');
        }
        pollGeojsonTask(data.task_id, {
            onSuccess: (result) => {
                const geojson = result.geojson;
                const meta = result.metadata || {};
                console.log('[FILTER] GeoJSON généré:', geojson?.features?.length || 0);
                json_data = geojson;
                setMetadata(meta);

                // Reconstruit l'index des points par date avec les données filtrées
                buildPointsByDateIndex(geojson?.features || []);

                // conversion en objet date
                dateStrToDate();
                // remets à jour les options/infos dépendant de la BDD (delayDate)
                updateOptionsValues(metadata);
                // MAJ des frames Infos
                pkg.updateInfosFrameAfterReadBdd(metadata);
                // Mettre à jour les features affichées sur la carte
                clearMap();
                pkg.addVector(geojson);

                // Mettre à jour le compteur : sélection courante / total initial
                updateFiltersCounter(metadata.numberOfCaches || (geojson?.features?.length || 0), totalCaches);
                try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {}
            },
            onError: (err) => {
                console.error('[FILTER] Erreur lors du suivi du filtrage:', err);
                try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {}
                showError(t('Erreur lors du filtrage des caches'), t('Erreur de filtrage'));
            }
        });
    })
    .catch(error => {
        console.error('Error:', error);
        try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {}
        showError(t('Erreur lors du filtrage des caches'), t('Erreur de filtrage'));
    });
}

function updateFiltersCounter(selected, total){
    try {
        const el = document.getElementById('filtersCounter');
        if (el) {
            el.textContent = `Sélection: ${selected} / ${total}`;
        }

        // Gérer la toast d'alerte "aucune cache visible"
        if (selected === 0 && total > 0) {
            // Afficher la toast si elle n'existe pas encore
            if (!noCacheToast) {
                noCacheToast = pkg.showToast(t('Aucune cache ne correspond aux critères sélectionnés par les filtres.'), 'warning', t('Aucune cache visible'), 0);
            }

        } else {
            // Fermer la toast si elle existe et qu'il y a des caches affichées
            if (noCacheToast) {
                try {
                    pkg.hideToast(noCacheToast);
                } catch(e) {
                    console.warn('Erreur lors de la fermeture de la toast "aucune cache visible"', e);
                }
                noCacheToast = null;
            }
        }
    } catch(e) { console.warn('updateFiltersCounter error', e); }
}

async function clearDatabase() {
    let clearingToast = null;
    
    try {
        // Afficher un toast de chargement
        clearingToast = pkg.showLoadingToast(t("Vidage de la base de données..."), t("Suppression"));

        // Appel à l'endpoint pour vider la base de données
        const response = await fetch(`${CONFIG.BASE_URL}/clear_database`, {
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
            showSuccess(t("Base de données vidée avec succès"), t("Suppression réussie"));
            
        } else {
            throw new Error(result.message || 'Erreur inconnue');
        }
        
    } catch (error) {
        console.error('Erreur vidage BDD:', error);
        if (clearingToast) {
            pkg.hideToast(clearingToast);
        }
        showError(t("Erreur lors du vidage de la base de données: ") + error.message, t("Erreur"));
    }
}

function uploadBddRequestFromModal(e) {
    e.preventDefault();

    var formData = new FormData();
    var fileInput = document.getElementById('file-input-modal');
    var selectedFile = fileInput.files[0];

    if (!selectedFile) {
        showError(t("Veuillez sélectionner un fichier .gpx"), t("Aucun fichier"));
        return;
    }

    formData.append('file', selectedFile);

    // Étape 1 : analyse du fichier (même logique que l'upload principal)
    const analyseToast = pkg.showLoadingToast(t("Analyse du fichier GPX en cours..."), t("Analyse"));

    fetch (`${CONFIG.BASE_URL}/analyse_file`, {
        method: 'POST',
        body: formData,
    }).then (response => response.json())
    .then (data => {
        if (data.success) {
            pkg.hideToast(analyseToast);
            // Étape 2 : upload réel (progress)
            performUploadFromModal(selectedFile);
        } else {
            pkg.hideToast(analyseToast);
            pkg.showToast(data.message, "error", t("Erreur d'analyse"));
        }
    })
    .catch(error => {
        console.error('Erreur analyse (modale):', error);
        pkg.hideToast(analyseToast);
        pkg.showToast(t("Erreur lors de l'analyse du fichier"), "error", t("Erreur"));
    });
}

function performUploadFromModal(file){
    var formData = new FormData();
    formData.append('file', file);

    // Afficher un toast de chargement avec progress bar
    const uploadToast = pkg.showLoadingToast(t("Chargement du fichier GPX en cours..."), t("Chargement"));

    fetch(`${CONFIG.BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
    })
    .then(response => response.json())
    .then(data => {
        console.log("data depuis modale", data);
        if (!data.success || !data.task_id) {
            throw new Error(data.message || "Impossible de lancer l'import GPX");
        }

        checkLoadingProgress(uploadToast, data.task_id, () => {
            pkg.hideToast(uploadToast);
            showSuccess(t("Fichier chargé avec succès !"), t("Chargement terminé"));

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
        }, (message) => {
            pkg.hideToast(uploadToast);
            showError(message || t("Erreur lors du chargement du fichier"), t("Erreur"));
        });
    })
    .catch(error => {
        console.error('Erreur:', error);
        pkg.hideToast(uploadToast);
        showError(t("Erreur lors du chargement du fichier"), t("Erreur"));
    });
}

function loadAndDisplayPoints() {
    console.log('[LOAD_POINTS] Chargement des points après upload...');

    // Afficher un toast pour l'affichage initial des points
    pkg.showPointsToast(t('Chargement et affichage des points...'), t('Affichage des points'));

    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (!data.task_id) {
                throw new Error(data.message || 'Impossible de lancer la génération du GeoJSON');
            }
            pollGeojsonTask(data.task_id, {
                onSuccess: (result) => {
                    const geojson = result.geojson;
                    const meta = result.metadata || {};

                    json_data = geojson;
                    setMetadata(meta);

                    // Mémoriser le total de caches initial
                    totalCaches = metadata.numberOfCaches || (geojson?.features?.length || 0);

                    // Pré-calcul de l'index des points par date pour optimiser l'animation
                    buildPointsByDateIndex(geojson?.features || []);

                    // conversion en objet date
                    dateStrToDate();
                    // MAJ des frames Infos
                    pkg.updateInfosFrameAfterReadBdd(metadata);
                    // MAJ du menu d'animation
                    pkg.updateAnimationMenuAfterReadBdd(metadata);
                    // mise à jour des Date Pickers de l'ui (filtre BDD)
                    pkg.setPickerDates(metadata);
                    // mise à jour des options en fonction de la BDD (dates début et fin)
                    updateOptionsValues(metadata);

                    // Ajouter les points à la carte
                    clearMap();
                    pkg.addVector(geojson);

                    // Mettre à jour le compteur : sélection = total au chargement initial
                    updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                    // Masquer le toast d'affichage initial
                    pkg.hidePointsToast();
                },
                onError: (err) => {
                    console.error('[LOAD_POINTS] Erreur lors du suivi de la génération GeoJSON:', err);
                    pkg.hidePointsToast();
                    showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                }
            });
        })
        .catch(error => {
            console.error('[LOAD_POINTS] Erreur lors du lancement de la génération des points:', error);
            pkg.hidePointsToast();
            showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
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
