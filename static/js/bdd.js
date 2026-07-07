import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { showSuccess, showError, showInfo, t } from './notifications.js';
import { clearMap } from './mapgl.js';
import { hideBsModal } from './ui_bootstrap.js';

// Flag de debug pour les filtres (FILTER).
// Mettre à true pour réactiver les logs en console.
const DEBUG_FILTERS = false;
const dbgFilters = (...args) => { if (DEBUG_FILTERS) console.log(...args); };

export let json_data = null;
export const metadata = {};
export const pointsByDate = new Map();
export let totalCaches = 0;

let readLoadingToast = null;
let filterLoadingToast = null;
let noCacheToast = null;

// Époque de filtrage : incrémentée à chaque appel à changeSelect.
// Permet d'ignorer les résultats d'une tâche de filtrage obsolète
// (l'utilisateur a changé les filtres pendant que la tâche précédente tournait).
let filterEpoch = 0;

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

const clearDatabaseBtn = document.getElementById('clearDatabaseBtn');
if (clearDatabaseBtn) {
    clearDatabaseBtn.addEventListener('click', clearDatabase);
}

// Gestionnaire pour le chargement depuis la modale de première utilisation.
// Même logique que l'input principal, mais sur l'élément #file-input-modal
// présent dans templates/modal_first_use.html.
const fileInputModal = document.getElementById('file-input-modal');
if (fileInputModal) {
    fileInputModal.addEventListener('change', function(e) {
        if (e.target.files && e.target.files[0]) {
            uploadBddRequestFromModal(e);
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

            const btn = document.getElementById('clearDatabaseBtn');
            if (btn) btn.style.display = (data && data.exists && data.isEmpty === false) ? '' : 'none';
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

function clearLocalData() {
    json_data = null;
    for (const k of Object.keys(metadata)) delete metadata[k];
    pointsByDate.clear();
    totalCaches = 0;
}

function updateUIAfterClear() {
    const infos = document.getElementById('infosBDD');
    const infosModal = document.getElementById('infosBDDModal');
    const btn = document.getElementById('clearDatabaseBtn');
    const counter = document.getElementById('filtersCounter');

    if (infos) infos.textContent = t('Aucune base de données chargée');
    if (infosModal) infosModal.textContent = t('Aucune base de données chargée');
    if (btn) btn.style.display = 'none';
    if (counter) counter.textContent = t('Sélection: 0 / 0');
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

function pollGeojsonTask(taskId, { onSuccess, onError, onProgress, intervalMs = 400, timeoutMs = 120000 } = {}) {
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
                if (typeof onProgress === 'function') onProgress(100);
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

            if (typeof onProgress === 'function' && typeof status?.progress === 'number') {
                onProgress(status.progress);
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
        onProgress: (p) => {
            try { if (toast) pkg.updateToastProgress(toast, p); } catch(_) {}
        },
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
        if (data.success) {
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
        if (!data.success || !data.task_id) {
            throw new Error(data.message || "Impossible de lancer l'import GPX");
        }

        checkLoadingProgress(uploadToast, data.task_id, () => {
            console.log('[uploadBdd] Import terminé, lancement loadAndDisplayPoints');
            pkg.hideToast(uploadToast);
            pkg.showToast(t("Fichier chargé avec succès !"), "success", t("Terminé"));

            // mets à jour les infos de la BDD
            readBddValues();

            // Charger et afficher les points sur la carte
            loadAndDisplayPoints();
        }, (message) => {
            console.error('[uploadBdd] Erreur import:', message);
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
            onProgress: (p) => {
                try { if (readLoadingToast) pkg.updateToastProgress(readLoadingToast, p); } catch(_) {}
            },
            onSuccess: (result) => {
                if (result.error || !result.geojson) {
                    console.error('Erreur tâche GeoJSON (readBdd):', result.error || 'geojson manquant');
                    try { if (readLoadingToast) { pkg.hideToast(readLoadingToast); readLoadingToast = null; } } catch(e) {}
                    return;
                }
                console.log('[readBdd] onSuccess - features:', result.geojson?.features?.length, 'metadata:', result.metadata);
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
                console.log('[readBdd] Appel addVector avec', result.geojson?.features?.length, 'features');
                pkg.addVector(result.geojson);

                // Mettre à jour le compteur : sélection = total au chargement initial
                updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                const btn = document.getElementById('clearDatabaseBtn');
                if (btn) btn.style.display = totalCaches > 0 ? '' : 'none';

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

export function changeSelect(selectedValues, optionValues) {
    // Incrémenter l'époque : toute tâche de filtrage issue d'un appel
    // précédent ignorera son résultat (onSuccess/onError ci-dessous).
    const myEpoch = ++filterEpoch;

    try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } filterLoadingToast = pkg.showLoadingToast(t('Filtrage des caches...'), t('Filtrage')); } catch(e) {}

    fetch(`${CONFIG.BASE_URL}/filter_caches`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filters: selectedValues }),
    })
    .then(response => response.json())
    .then(data => {
        if (!data.task_id) {
            throw new Error(data.message || 'Impossible de lancer le filtrage');
        }
        // Si l'utilisateur a déjà changé les filtres pendant le fetch POST,
        // ne pas poller du tout — la tâche serveur tournera mais son résultat
        // sera ignoré par l'époque.
        if (myEpoch !== filterEpoch) {
            dbgFilters('[FILTER] Tâche obsolète (époque dépassée pendant le POST), polling annulé');
            return;
        }
        pollGeojsonTask(data.task_id, {
            onProgress: (p) => {
                // Ne mettre à jour la toast que si on est toujours l'époque courante
                if (myEpoch !== filterEpoch) return;
                try { if (filterLoadingToast) pkg.updateToastProgress(filterLoadingToast, p); } catch(_) {}
            },
            onSuccess: (result) => {
                // Ignorer ce résultat si une nouvelle requête de filtrage a été lancée
                // entre-temps : son résultat serait écrasé par celui-ci (race condition).
                if (myEpoch !== filterEpoch) {
                    dbgFilters('[FILTER] Résultat obsolète ignoré (époque dépassée)');
                    return;
                }
                const geojson = result.geojson;
                const meta = result.metadata || {};
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
                // Ne pas afficher d'erreur ni cacher la toast si on n'est plus l'époque courante
                if (myEpoch !== filterEpoch) {
                    dbgFilters('[FILTER] Erreur d\'une tâche obsolète ignorée (époque dépassée)');
                    return;
                }
                console.error('[FILTER] Erreur lors du suivi du filtrage:', err);
                try { if (filterLoadingToast) { pkg.hideToast(filterLoadingToast); filterLoadingToast = null; } } catch(e) {}
                showError(t('Erreur lors du filtrage des caches'), t('Erreur de filtrage'));
            }
        });
    })
    .catch(error => {
        // Erreur du fetch POST lui-même : ne traiter que si on est encore courant
        if (myEpoch !== filterEpoch) return;
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

        const badge = document.getElementById('dataTabBadge');
        if (badge) {
            if (total > 0 && selected < total) {
                badge.textContent = `${selected}/${total}`;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
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
        if (!data.success || !data.task_id) {
            throw new Error(data.message || "Impossible de lancer l'import GPX");
        }

        checkLoadingProgress(uploadToast, data.task_id, () => {
            pkg.hideToast(uploadToast);
            showSuccess(t("Fichier chargé avec succès !"), t("Chargement terminé"));

            // Fermer la modale de première utilisation (Bootstrap 5)
            const modalElement = document.getElementById('modal_first_use');
            if (modalElement) {
                hideBsModal(modalElement);
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
    // Afficher un toast pour l'affichage initial des points
    const pointsToast = pkg.showPointsToast(t('Chargement et affichage des points...'), t('Affichage des points'));

    fetch(`${CONFIG.BASE_URL}/get_geojson_points`, { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (!data.task_id) {
                throw new Error(data.message || 'Impossible de lancer la génération du GeoJSON');
            }
            pollGeojsonTask(data.task_id, {
                onProgress: (p) => {
                    try { if (pointsToast) pkg.updateToastProgress(pointsToast, p); } catch(_) {}
                },
                onSuccess: (result) => {
                    console.log('[loadAndDisplayPoints] onSuccess - features:', result?.geojson?.features?.length, '| error:', result?.error);
                    if (result.error || !result.geojson) {
                        console.error('Erreur tâche GeoJSON (loadAndDisplayPoints):', result.error || 'geojson manquant');
                        pkg.hidePointsToast();
                        showError(t("Erreur lors de l'affichage des points sur la carte"), t("Erreur d'affichage"));
                        return;
                    }
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
                    pkg.addVector(geojson);

                    // Mettre à jour le compteur : sélection = total au chargement initial
                    updateFiltersCounter(metadata.numberOfCaches || 0, totalCaches);

                    const btn = document.getElementById('clearDatabaseBtn');
                    if (btn) btn.style.display = '';

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
