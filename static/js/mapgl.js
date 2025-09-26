// TODO EN COURS -> Reprendre le nombre de Frame pas seconde et toute la chaine + Synchro Filtre et affichage dans Menu Animation. C'est peut être ça qui déconne

// TODO Afficher le contenu de la Session : stats, liste des caches, matrice (v3) Chargement dynamique au chargment de l'onglet

// EN COURS -> CREATION DES DATEPICKERS. POur l'instant initialisés au démarrage avec des dates au pif. Réécrire JS pour mettre date début + fin 
// + Voir si possible d'ajouter des infos sur nbre cache par date 
// + coloration de la période ou il y a des caches ?

// TODO MODAL au premier affichage pour langue et connexion.

// TODO Traduction
// TODO Refresh page apres changement de langue + avertissement

// TODO BDD:
// Tester les fichiers GPX issus d'autres sources (GSAK, ProjectGC...)

// TODO Virer tout ce qui concerne Non WebGL

// TODO Ajouter les autres filtres (Pays, Region, Poseur, Attributs)
// TODO COloration selon autre critères que le type (T, D, size) (v2)
// TODO Permettre afficher images à la place des cercles (icones officielles) (V2)
// TODO Permettre d'afficher des images à la places des flash (avec icones officielles) (V2)

// Possibilité d'utiliser des icones:
// https://openlayers.org/en/v8.1.0/examples/icon-sprite-webgl.html

// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences

// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)
// TODO Watercolor, on peut ajouter labels
// TODO Vectorielle, il y a des version avec regions

// stockage des infos dans cookies au lieu localstorage ? Laissez le choix ?

// TODO Gerer les arret / pause chargement pour Enregistrement

// TODO GEstion Traduction

// TODO Menu point : désactiver/réactiver ce qui n'est pas utilisable

// FRAMES (TItre, infos)
// TODO Faire input pour les différentes option et rendre css optionnel (v2)
// TODO AJouter colorisation syntaxique pour le css (V2)
// TODO Ajouter une image (V2)
// TODO Nombre de caches du jour avec un chiffre qui grossi (+ gradient couleur) (V2)
// TODO Raccourci clavier pour valider css
// TODO Permettre de choisir le format de la date pour tout le programme (Frame, pickers...)

// POINTS 
// TODO GEstion des anneaux
// WEBGL AVec style standard peut être plus rapide. A tester 
// Taille relative ou absolue
// remettre pas de bordures

// TODO Fusionner les deux fonctions tout en bas.
// Mettre le switch dans la bonne position
// Aller lire le json s'il existe au lieu de recharger le fichier

// TODO Juste une capture d'une image (a Faire affichage carte avec choix d'une date précise)

// TODO Forcer la taille de la carte (V2)

// TODO Check nouvelle version -> Autoriser ou non (connexion serveur)


import * as pkg from './index.js';
import { CONFIG } from './init.js';

// Debug toasts/assemblage
const TOAST_DEBUG = true;
function logToast(...args) { if (TOAST_DEBUG) { try { console.log('[TOAST]', ...args); } catch(e) {} } }

let map;  // carte de l'app
let engine;  // quel moteur graphique est utilisé
// les couches de cartographie
let OSMLayer;
let stamenWatercolorLayer;
let stamenTonerLayer;
let vectorTileLayer;
// couche de points
let vectorLayer;
let features;
// couleurs GC par défaut
let defaultGcColors;
// Popup d'information (overlay)
let popupOverlay;
let popupEl;
// ANIMATION
// date en cours pour l'animation
let currentDate;
// ENREGISTREMENT
// Compteur de frames pour le jour en cours
let currentFrame = 0;
let infosProgressBar = new Object;
let perfMetrics = {
    totalFrames: 0,
    capturedFrames: 0,
    uploadOk: 0,
    uploadFail: 0,
    captureTimeMs: 0,
    uploadTimeMs: 0,
    startedAt: 0,
    lastCaptureStart: 0, // Ajouté pour perfMetrics.lastCaptureStart
};

// Système global de surveillance des performances d'enregistrement
let recordingPerformanceMonitor = {
    frameTimings: [],
    performanceWarningShown: false,
    lastWarningLevel: 0, // Niveau de la dernière alerte (pour permettre les alertes successives)
    isMonitoring: false,
    currentPerformanceToast: null, // Référence au toast de performance actuel
    
    reset() {
        this.frameTimings = [];
        this.performanceWarningShown = false;
        this.lastWarningLevel = 0;
        this.isMonitoring = false;
        this.currentPerformanceToast = null;
    },
    
    startMonitoring() {
        this.reset();
        this.isMonitoring = true;
    },

    stopMonitoring() {
        this.isMonitoring = false;
        // Fermer le toast de performance en cours
        this.closeCurrentPerformanceToast();
    },
    
    // Fonction pour fermer le toast actuel
    closeCurrentPerformanceToast() {
        if (this.currentPerformanceToast) {
            try {
                pkg.hideToast && pkg.hideToast(this.currentPerformanceToast);
            } catch(_) {
                try { this.currentPerformanceToast.remove(); } catch(_) {}
            }
            this.currentPerformanceToast = null;
        }
    },
    
    // Fonction pour vérifier si le toast existe encore
    isPerformanceToastVisible() {
        if (!this.currentPerformanceToast) return false;
        
        // Vérifier si l'élément existe encore dans le DOM
        return document.body.contains(this.currentPerformanceToast);
    },
    
    // Fonction pour mettre à jour le contenu d'un toast existant
    updatePerformanceToastContent(newMessage, newTitle = 'Performance enregistrement') {
        if (!this.isPerformanceToastVisible()) return false;

        try {
            const titleElement = this.currentPerformanceToast.querySelector('.gcm-toast-title');
            const messageElement = this.currentPerformanceToast.querySelector('.gcm-toast-message');

            if (titleElement) titleElement.textContent = newTitle;
            if (messageElement) messageElement.textContent = newMessage;

            // Réanimer le toast pour attirer l'attention
            this.currentPerformanceToast.classList.remove('show');
            setTimeout(() => {
                if (this.currentPerformanceToast) {
                    this.currentPerformanceToast.classList.add('show');
                }
            }, 100);

            return true;
        } catch(err) {
            return false;
        }
    },
    
    checkPerformance(frameTime, expectedFrameTime, recordingMode = 'unknown') {
        if (!this.isMonitoring) return;
        
        this.frameTimings.push(frameTime);
        
        const PERFORMANCE_CHECK_INTERVAL = 30;
        const FRAME_TIME_THRESHOLD = expectedFrameTime * 2.5; // 2.5x le temps attendu
        const BAD_FRAMES_THRESHOLD = 0.2; // 20% de frames lentes = problème
        
        if (this.frameTimings.length >= PERFORMANCE_CHECK_INTERVAL) {
            const slowFrames = this.frameTimings.filter(time => time > FRAME_TIME_THRESHOLD).length;
            const slowFrameRatio = slowFrames / this.frameTimings.length;
            
            // Déterminer le niveau de sévérité (permet plusieurs alertes)
            const warningLevel = Math.floor(slowFrameRatio * 10); // 0-10 selon pourcentage
            const shouldAlert = slowFrameRatio > BAD_FRAMES_THRESHOLD && warningLevel > this.lastWarningLevel;
            
            if (shouldAlert) {
                this.lastWarningLevel = warningLevel;
                const currentSlowdown = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
                const suggestedSlowdown = Math.min(8, currentSlowdown + 1);
                
                
                if (recordingMode === 'mediarecorder' && suggestedSlowdown <= 8) {
                    // Offrir d'augmenter automatiquement le ralentissement
                    const message = `Performance d'enregistrement instable (${Math.round(slowFrameRatio * 100)}% de frames lentes). Souhaitez-vous augmenter le ralentissement à x${suggestedSlowdown} automatiquement ?`;
                    
                    // Vérifier si on peut réutiliser le toast existant
                    if (this.isPerformanceToastVisible()) {
                        // Mettre à jour le toast existant
                        const updated = this.updatePerformanceToastContent(message);
                        if (updated) {
                            return; // Pas besoin de créer un nouveau toast
                        } else {
                            // Échec de la mise à jour, fermer l'ancien
                            this.closeCurrentPerformanceToast();
                        }
                    }

                    // Créer un nouveau toast seulement si nécessaire
                    try {
                        if (pkg && pkg.showConfirmation) {
                            this.currentPerformanceToast = pkg.showConfirmation(
                                message,
                                'Performance enregistrement',
                                () => {
                                    // Confirmation : augmenter le ralentissement
                                    try {
                                        pkg.options.record.mediaRecorder.slowdownFactor = suggestedSlowdown;
                                        // Sauvegarder dans les paramètres persistants si possible
                                        try { pkg.saveRecordSettings && pkg.saveRecordSettings(); } catch(_) {}
                                        // Mettre à jour l'interface
                                        const slowdownInput = document.getElementById('inputRecordSlowdown');
                                        if (slowdownInput) slowdownInput.value = suggestedSlowdown;
                                        
                                        pkg.showToast && pkg.showToast(`Ralentissement augmenté à x${suggestedSlowdown}. Redémarrez l'enregistrement pour appliquer le changement.`, 'success', 'Paramètre mis à jour', 8000);
                                    } catch(err) {
                                        console.error('Erreur lors de l\'application du ralentissement:', err);
                                        pkg.showToast && pkg.showToast('Erreur lors de la mise à jour du paramètre.', 'error', 'Erreur', 5000);
                                    }
                                    this.currentPerformanceToast = null; // Reset après confirmation
                                },
                                () => {
                                    // Annulation : juste afficher un conseil
                                    pkg.showToast && pkg.showToast(`Vous pouvez manuellement augmenter le ralentissement à x${suggestedSlowdown} dans les paramètres d'enregistrement.`, 'info', 'Conseil', 8000);
                                    this.currentPerformanceToast = null; // Reset après annulation
                                }
                            );
                        } else {
                            throw new Error('showConfirmation non disponible');
                        }
                    } catch(err) {
                        // Fallback vers toast simple
                        const fallbackMessage = `Performance instable (${Math.round(slowFrameRatio * 100)}% de frames lentes). Augmentez le ralentissement à x${suggestedSlowdown} dans les paramètres.`;
                        
                        // Même logique pour le fallback
                        if (this.isPerformanceToastVisible()) {
                            this.updatePerformanceToastContent(fallbackMessage);
                        } else if (pkg && pkg.showToast) {
                            this.currentPerformanceToast = pkg.showToast(fallbackMessage, 'warning', 'Performance enregistrement', 10000);
                        }
                    }
                } else {
                    // Mode images ou ralentissement déjà au maximum
                    let suggestion = '';
                    if (recordingMode === 'mediarecorder') {
                        suggestion = `Le ralentissement est déjà au maximum (x${currentSlowdown}). Réduisez le nombre de points affichés ou la résolution.`;
                    } else {
                        suggestion = `Réduisez la vitesse d'animation (augmentez la durée par jour) ou le nombre de points affichés.`;
                    }
                    
                    const message = `Performance d'enregistrement instable (${Math.round(slowFrameRatio * 100)}% de frames lentes). ${suggestion}`;
                    
                    // Même logique pour les suggestions
                    if (this.isPerformanceToastVisible()) {
                        this.updatePerformanceToastContent(message);
                    } else {
                        try {
                            if (pkg && pkg.showToast) {
                                this.currentPerformanceToast = pkg.showToast(message, 'warning', 'Performance enregistrement', 10000);
                            }
                        } catch(err) {
                            // Silencieux en cas d'erreur d'affichage toast
                        }
                    }
                }
            }
            
            // Limiter la taille du buffer 
            this.frameTimings = this.frameTimings.slice(-PERFORMANCE_CHECK_INTERVAL);
        }
    }
};
// TEMP
export let framesPerDay = 30;  
let imageCounter = 0;
// FLASH
let animationSource;
let animationLayer;

let vectorSource;

// definition de l'interval hors de la fonction d'animation pour pouvoir l'arreter.
let interval;
// element qui stocke les infos à afficher dans les frames. Sortie de la fonction pour pouvoir les garder en mémoire
let infos;
// flag pour indiquer si un enregistrement est en cours
let isRecording = false;

// MediaRecorder pipeline state
let mrRecorder = null;
let mrRecordedChunks = [];
let mrOutCanvas = null;
let mrOutCtx = null;
let mrDrawIntervalId = null;
let mrProgressIntervalId = null;
let isMediaRecording = false;
let mrOnFinalizeRestoreTimePerDay = null;

// Audio lecture seule (hors enregistrement) et audio pour MediaRecorder
let bgAudioCtx = null, bgAudioEl = null, bgAudioSource = null, bgAudioGain = null, bgAudioActive = false;
let mrAudioCtx = null, mrAudioSource = null, mrAudioDest = null, mrAudioGain = null, mrAudioEl = null, mrHadAudio = false;
let blockBackgroundAudioPlayback = false;
let mrMuxAudioCtx = null; // Contexte audio "déverrouillé" par un geste utilisateur pour le mux post-enregistrement

function startBackgroundMusicIfAny(){
    try {
        // Ne pas jouer pendant l'enregistrement ni si bloqué explicitement
        if (typeof isRecording !== 'undefined' && isRecording) return;
        if (typeof isMediaRecording !== 'undefined' && isMediaRecording) return;
        if (blockBackgroundAudioPlayback) return;

        const enabled = !!(pkg.options?.record?.audio?.enabled);
        if (!enabled) return;

        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        if (!file) return;

        const volume = Number(pkg.options?.record?.audio?.volume) || 1;
        const AC = window.AudioContext || window.webkitAudioContext;
        bgAudioCtx = new AC();

        bgAudioEl = new Audio(URL.createObjectURL(file));
        bgAudioEl.preload = 'auto';
        bgAudioEl.loop = true;

        bgAudioSource = bgAudioCtx.createMediaElementSource(bgAudioEl);
        bgAudioGain = bgAudioCtx.createGain();
        bgAudioGain.gain.value = Math.max(0, Math.min(1, volume));
        bgAudioSource.connect(bgAudioGain).connect(bgAudioCtx.destination);

        try { bgAudioCtx.resume().catch(()=>{}); } catch(_) {}
        bgAudioEl.play().then(()=>{ bgAudioActive = true; }).catch(e => console.warn('Lecture audio bloquée:', e));
    } catch(e) {
        console.warn('startBackgroundMusicIfAny error:', e);
    }
}

function stopBackgroundMusic(){
    try { if (bgAudioEl) { bgAudioEl.pause(); URL.revokeObjectURL(bgAudioEl.src); } } catch(_) {}
    try { if (bgAudioCtx) { bgAudioCtx.close(); } } catch(_) {}
    bgAudioEl = bgAudioCtx = bgAudioSource = bgAudioGain = null;
    bgAudioActive = false;
}


// récupère les couleurs GC par défaut dans le JSON
// (permet d'être facilement modifiable contrairement à un dict en dur)
export async function requetedefaultGcColors(){
    try {
        const response = await fetch(`${CONFIG.BASE_URL}/static/json/defaultGcColors.json`);
        if (!response.ok) {
            const errorMsg = `Erreur lors du chargement des couleurs GC (${response.status}): ${response.statusText}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
        defaultGcColors = await response.json();
        console.log('🎨 Couleurs GC chargées avec succès:', defaultGcColors);
        console.log('🎨 Test hexToRgb avec #008000:', pkg.hexToRgb('#008000'));
        console.log('🎨 Toutes les clés disponibles:', Object.keys(defaultGcColors));
    } catch (error) {
        console.error('Erreur lors du chargement des couleurs GC:', error);
        // Utiliser des couleurs par défaut en cas d'erreur
        defaultGcColors = {
            'Traditional Cache': '#008000',
            'Multi-cache': '#FFA500',
            'Mystery Cache': '#0000FF',
            'EarthCache': '#87CEEB',
            'Letterbox Hybrid': '#0000FF',
            'Event Cache': '#FF0000',
            'Unknown Cache': '#0000FF',
            'Wherigo Cache': '#0000FF',
            'Virtual Cache': '#87CEEB',
            'Webcam Cache': '#87CEEB',
            'Giga-Event Cache': '#FF0000',
            'Mega-Event Cache': '#FF0000',
            'Cache In Trash Out Event': '#FF0000',
            'Community Celebration Event': '#FF0000',
            'GPS Adventures Exhibit': '#FF0000',
            'Locationless (Reverse) Cache': '#FFFFFF'
        };
        console.warn('Utilisation des couleurs GC par défaut suite à une erreur de chargement');
    }
}


// Initialisation de la carte
export function createMap(){
    map = new ol.Map({
        target: 'map',
        layers: [],
        view: new ol.View({
            center: [49, 6],
            zoom: 3
        }),
        renderer: "webgl",
        controls: [] 
    });

    // Initialiser l'overlay de popup et les écouteurs de clics
    try { initPopupOverlay(); } catch(e) { console.warn('Init popup error:', e); }
}

// ajoute les différents layers de cartes à la map et affiche la bonne
export function addMaps() {

    let defaultSettings = pkg.options.map;

    // Utilisation de l'objet global 'ol' pour accéder aux classes d'OpenLayers
    OSMLayer = new ol.layer.Tile({
        source: new ol.source.OSM()
    });
    map.addLayer(OSMLayer);

    stamenWatercolorLayer = new ol.layer.Tile({
        source: new ol.source.StadiaMaps({layer: 'stamen_watercolor'})
    });
    map.addLayer(stamenWatercolorLayer);
    stamenWatercolorLayer.setVisible(false);

    // Choix du type de Toner par défaut
    let stamenLayer;
    if (defaultSettings.stamenToner.type == "light") {
        stamenLayer = 'toner-lite'
    } else if (defaultSettings.stamenToner.type == "dark") {
        stamenLayer = 'toner'
    }

    stamenTonerLayer = new ol.layer.Tile({
        source: new ol.source.StadiaMaps({layer: "stamen_toner_lite"})
    });
    map.addLayer(stamenTonerLayer);
    stamenTonerLayer.setVisible(false);

    vectorTileLayer = new ol.layer.VectorTile({
        declutter: true,
        source: new ol.source.VectorTile({
          maxZoom: 15,
          format: new ol.format.MVT({
            idProperty: 'iso_a3',
          }),
          url:
            'https://ahocevar.com/geoserver/gwc/service/tms/1.0.0/' +
            'ne:ne_10m_admin_0_countries@EPSG%3A900913@pbf/{z}/{x}/{-y}.pbf',
        }),
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({
                width: defaultSettings.vectorMap.strokeWidth,
                color: defaultSettings.vectorMap.strokeColor
            }),
            fill: new ol.style.Fill({
                color: defaultSettings.vectorMap.fillColor
            })
        })
    });

    map.addLayer(vectorTileLayer);
    vectorTileLayer.setVisible(false);  
}

// rafraîchit la carte VectorMap quand on change ses proprietés
export function refreshVectorMap(newValues){
    vectorTileLayer.setStyle(new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: newValues.strokeColor,
            width: newValues.strokeWidth
        }),
        fill: new ol.style.Fill({
            color: newValues.fillColor
        }),
    }));
    // bizarrement la variable est background avec un _
    vectorTileLayer.background_ = newValues.background;
    vectorTileLayer.getSource().refresh();
}


// rafraichit la carte StamenToner quand on change ses proprietés
export function refreshStamenTonerMap(newValues){
    let layerName;
    if (newValues.type == "light") {
        layerName = 'stamen_toner_lite';
    } else if (newValues.type == "dark") {
        layerName = 'stamen_toner';
    }
    stamenTonerLayer.setSource(new ol.source.StadiaMaps({layer: layerName}));
}


// permet de faire le lien avec la fonction qui selectionne la bonne carte au lancement de l'application
export function selectDefaultCarto(){
    let layerName = pkg.options.map.default;
    switchLayer(layerName);
}

// centrer la carte
export function centerMap(){
    // Coordonnées du centre de la France en longitude et latitude
    const franceCenterLonLat = [2.2137, 46.2276];
    // Conversion des coordonnées en EPSG:3857 pour OpenLayers
    const franceCenterWebMercator = ol.proj.fromLonLat(franceCenterLonLat);
    map.getView().setCenter(franceCenterWebMercator);
    map.getView().setZoom(6); // Ajustez le niveau de zoom selon vos besoins
}


// permet de récupérer l'id du bouton. 
// Comme il y a une image dans le bouton, il faut éventuellement regarder dans le parent selon le lieu du clic.
function buttonSwitchLayer(e) {
    let targetElement = e.target;
        while (targetElement != null && !targetElement.classList.contains('changeMap')) {
            targetElement = targetElement.parentElement;
        }
            // Si un élément avec 'changeMap' a été trouvé, récupérer son ID
        if (targetElement) {
            let layerName = targetElement.id;
            switchLayer(layerName);
        }
}


// permet de switcher sur la bonne cartographie en fonction du choix fait
export function switchLayer(layerName) {
    // Masquez toutes les couches
    OSMLayer.setVisible(false);
    vectorTileLayer.setVisible(false);
    stamenWatercolorLayer.setVisible(false);
    stamenTonerLayer.setVisible(false);

    // Affichez la couche sélectionnée
    switch (layerName) {
        case 'OSM':
            // on rend visible la bonne carte
            OSMLayer.setVisible(true);
            // on affiche le bon sous menu
            pkg.selectOSMMapMenu();
            break;
        case 'vectorMap':
            vectorTileLayer.setVisible(true);
            pkg.selectVectorMapMenu();
            break;
        case 'watercolor':
            stamenWatercolorLayer.setVisible(true);
            pkg.selectWatercolorMapMenu();
            break;
        case 'stamenToner':
            stamenTonerLayer.setVisible(true);
            pkg.selectStamenTonerMapMenu();
            break;
    }

    // Mettre à jour l'état visuel des boutons de cartes
    try {
        const buttons = document.getElementsByClassName('changeMap');
        for (let btn of buttons) {
            if (btn && btn.classList) {
                btn.classList.remove('is-selected');
            }
        }
        const active = document.getElementById(layerName);
        if (active && active.classList) {
            active.classList.add('is-selected');
        }
    } catch (e) {
        // fail safe : ne casse pas l'app si DOM non présent
    }
}

// Événement pour changer la couche de fond de carte
const mapChoices = document.getElementsByClassName('changeMap')
for (let mapLayer of mapChoices){
    mapLayer.addEventListener('click', buttonSwitchLayer);
}


// Fonction pour ajouter les données GeoJSON à la source vectorielle au chargement du GeoJSON
export function addVector(data) {
    // Lire les entités GeoJSON
    features = new ol.format.GeoJSON().readFeatures(data, {
        dataProjection: 'EPSG:4326',  // Projection des données GeoJSON
        featureProjection: 'EPSG:3857' // Projection de la carte
    });

    // selon que l'on choisisse webgl ou non on affiche les points avec le bon moteur
    selectEngineAndRefresh();   
}

// fonction appelée au changement d'options graphique
export function refreshPoints(){
    // Afficher un toast pour l'affichage des points
    pkg.showPointsToast('Mise à jour de l\'affichage des points...', 'Affichage des points');

    // Masquer automatiquement après 1.5 secondes
    setTimeout(() => {
        pkg.hidePointsToast();
    }, 1500);

    clearMap();
    selectEngineAndRefresh();
}


// recherche une couche en particulier sur la carte
function isLayerOnMap(map, layerToFind) {
    const layers = map.getLayers().getArray();
    return layers.includes(layerToFind);
}


// Envoie l'affichage des points de features dans le bon vecteur
function selectEngineAndRefresh(){
    engine = pkg.options.options.engine;
    if (engine == "webgl"){
        displayWebGLPoints(false, pkg.options.point);
    } else {
        // TODO AJouter barre chargement
        displayAllPoints2D(features, pkg.options.point);
    }
}

// Détermine si l'application est au repos (ni animation, ni enregistrement en cours)
function isIdleState(){
    try {
        const isAnimating = !!interval; // interval actif => animation en cours
        const rec = !!isRecording || !!isMediaRecording; // enregistrement en cours
        return !isAnimating && !rec;
    } catch(_) { return true; }
}

// Initialise l'overlay de popup et les interactions de clic
function initPopupOverlay(){
    // Créer l'élément DOM de la popup s'il n'existe pas
    popupEl = document.getElementById('gcPopup');
    if (!popupEl) {
        popupEl = document.createElement('div');
        popupEl.id = 'gcPopup';
        popupEl.style.position = 'absolute';
        popupEl.style.background = 'rgba(0,0,0,0.75)';
        popupEl.style.color = '#fff';
        popupEl.style.padding = '8px 10px';
        popupEl.style.borderRadius = '6px';
        popupEl.style.fontSize = '12px';
        popupEl.style.pointerEvents = 'none';
        popupEl.style.width = '320px';
        popupEl.style.maxWidth = '700px';
        popupEl.style.wordWrap = 'break-word';
        popupEl.style.overflowWrap = 'break-word';
        popupEl.style.whiteSpace = 'normal';
        popupEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35)';
        popupEl.style.display = 'none';
        // petite flèche
        popupEl.style.transform = 'translate(-50%, -100%)';
        document.body.appendChild(popupEl);
    }

    // Créer l'overlay OpenLayers si besoin
    if (!popupOverlay) {
        popupOverlay = new ol.Overlay({
            element: popupEl,
            offset: [0, -10],
            positioning: 'bottom-center',
            stopEvent: true
        });
        map.addOverlay(popupOverlay);
    }

    // Clic sur la carte
    map.on('click', function(evt){
        // Afficher seulement si au repos
        if (!isIdleState()) {
            hidePopup();
            return;
        }

        const pixel = evt.pixel;
        const feature = map.forEachFeatureAtPixel(pixel, function(ft, layer){
            // On cible uniquement nos couches de points
            if (layer === vectorLayer) return ft;
        });

        if (!feature) {
            hidePopup();
            return;
        }

        const props = feature.getProperties() || {};
        // Construire le contenu
        const name = sanitize(props.name);
        const type = sanitize(props.cache_type);
        const dif = sanitize(props.difficulty);
        const ter = sanitize(props.terrain);
        const cont = sanitize(props.container);
        const gcRaw = props.gc_code ? String(props.gc_code) : '';
        const gcEsc = sanitize(gcRaw);
        const linkHref = gcRaw ? `https://coord.info/${encodeURIComponent(gcRaw)}` : null;
        const foundText = props.found ? 'Oui' : 'Non';
        const owner = sanitize(props.owner);
        const dateFind = sanitize(props.date_find);
        const publishedDate = sanitize(props.published_date);

        const html = `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="font-weight:600;font-size:13px;">${linkHref ? `<a href=\"${linkHref}\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"color:#fff;text-decoration:underline;pointer-events:auto;cursor:pointer;\">` : ''}${gcEsc}${linkHref ? '</a>' : ''} - ${name || 'Sans nom'}</div>
                <div>${type || '-'}, ${cont || '-'}, ${dif||'-'}/${ter||'-'}</div>
                ${owner ? `<div>${owner}</div>` : ''}
                ${publishedDate ? `<div>Publié le ${publishedDate}</div>` : ''}
                <div>${foundText === 'Oui' ? 'Trouvé' : 'DNF'} ${dateFind ? `le ${dateFind}` : ''}</div>
            </div>`;
        popupEl.innerHTML = html;
        popupEl.style.display = 'block';
        popupOverlay.setPosition(evt.coordinate);
    });

    // Masquer à l'échappement
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hidePopup();
    });

    // Masquer si on clique ailleurs sur la carte (sans feature)
    map.on('pointermove', function(evt){
        if (!isIdleState()) return; // pas de survol en mode non-idle
        const hit = map.hasFeatureAtPixel(evt.pixel, { layerFilter: l => l === vectorLayer });
        map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });
}

function hidePopup(){
    if (popupEl) popupEl.style.display = 'none';
    if (popupOverlay) popupOverlay.setPosition(undefined);
}

function sanitize(v){
    if (v == null) return '';
    return String(v).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// affichage des points 2D
function displayAllPoints2D(features, pointOptions){
    // Créer une source vectorielle avec les entités
    vectorSource = new ol.source.Vector({
        features: features // Ajouter les entités lues
    });

    vectorLayer = new ol.layer.Vector({
        source: vectorSource,
        style: function(feature) {
            return getStyle2D(feature, pointOptions);
        }
    });
    
    map.addLayer(vectorLayer);
}


function getStyle2D(feature, pointOptions) {
    // Type de la cache
    var cacheType = feature.get('cache_type');

    
    // Couleur du centre du point
    let fillColor;
    if (pointOptions.center.mode == "gc") {
        fillColor = defaultGcColors[cacheType] || 'gray'; // couleur par défaut
    } else if (pointOptions.center.mode == "fix") {
        fillColor = pointOptions.center.color
    }

    // Veut on une bordure ?
    let stroke = null;
    let borderSizeValue = Math.max(0, parseInt(pointOptions.border.size) || 0);
    if (pointOptions.border.mode != "none" && borderSizeValue > 0) {

        let borderSize = borderSizeValue / 5;

        let borderColor;
        if (pointOptions.border.mode == "gc") {
            borderColor = defaultGcColors[cacheType] || 'gray'; // couleur par défaut
        } else if (pointOptions.border.mode == "fix") {
            borderColor = pointOptions.border.color;
        }

        stroke = new ol.style.Stroke({color: borderColor, width: borderSize})
    }

    let pointSize = Math.max(1, parseInt(pointOptions.center.size) || 3);

    // Retournez le style OpenLayers pour cette entité
    return new ol.style.Style({
        image: new ol.style.Circle({
            radius: pointSize,
            fill: new ol.style.Fill({color: fillColor}),
            stroke: stroke
        })
    });
}

function displayWebGLPoints(features, pointOptions) {

    // Validation et valeurs par défaut pour éviter NaN dans les shaders WebGL
    let pointSize = Math.max(1, parseInt(pointOptions.center.size) || 3);
    let borderSizeValue = Math.max(0, parseInt(pointOptions.border.size) || 0);
    let borderWidth = borderSizeValue / 5; // Épaisseur réelle de la bordure
    let borderSize = pointSize + borderWidth; // Rayon total pour le layer de bordure
    let borderColor;

    if (pointOptions.border.mode == "gc") {
        borderColor = [
            'match',
            ['get', 'cache_type'],
            ...Object.entries(defaultGcColors).flat(), // Object.entries pour obtenir un tableau de paires clé-valeur, puis flat pour aplatir le tableau en un seul niveau
            '#000000' // couleur par défaut
        ]
    } else if (pointOptions.border.mode == "fix") {
        borderColor = pointOptions.border.color
    } else if (pointOptions.border.mode == "none") {
        borderColor = 'transparent' // Pas utilisé mais défini pour cohérence
    }

   
    let fillColor;
    if (pointOptions.center.mode == "gc") {
        fillColor = [
            'match',
            ['get', 'cache_type'],
            ...Object.entries(defaultGcColors).flat(), // Object.entries pour obtenir un tableau de paires clé-valeur, puis flat pour aplatir le tableau en un seul niveau
            '#000000' // couleur par défaut
        ]
    } else if (pointOptions.center.mode == "fix") {
        fillColor = pointOptions.center.color
    }

    let pointStyle;
    let pointStyleBorder;    
    if (pointOptions.mode == "icone") {
        // Utilisation du sprite Geocaching: offset/size dynamiques selon le type ('cache_type')
        if (pointOptions.sprite && pointOptions.sprite.map) {
            const sp = pointOptions.sprite;

            // Mapping des valeurs 'cache_type' des features -> clés du sprite
            const typeToKey = (sp.typeMap) || {
                'Traditional Cache': 'trad',
                'Multi-cache': 'multi',
                'Mystery Cache': 'myst',
                'Unknown Cache': 'myst',
                'Letterbox Hybrid': 'letterbox',
                'Event Cache': 'event',
                'Mega-Event Cache': 'mega',
                'Giga-Event Cache': 'giga',
                'Earthcache': 'earth',
                'Virtual Cache': 'virtual',
                'Wherigo Cache': 'wherigo',
                'Lab Cache': 'lab',
                'Cache In Trash Out Event': 'cito',
                'Community Celebration Event': 'block',
                'GPS Adventures Exhibit': 'event',
                'Locationless (Reverse) Cache': 'locationless',
                'Webcam Cache': 'webcam'
            };

            const typeEntries = Object.entries(typeToKey);

            // Construire des expressions 'match' par type réel
            const buildMatchArray = (prop, defaultValue) => {
                const arr = ['match', ['get', 'cache_type']];
                typeEntries.forEach(([cacheType, key]) => {
                    const r = sp.map[key];
                    if (!r) return;
                    if (prop === 'offset') {
                        arr.push(cacheType, [r.x, r.y]);
                    } else if (prop === 'size') {
                        arr.push(cacheType, [r.w, r.h]);
                    }
                });
                arr.push(defaultValue);
                return arr;
            };

            // Par défaut: premier rect dispo
            const defaultRect = (() => {
                const firstKey = Object.keys(sp.map)[0];
                return firstKey ? sp.map[firstKey] : {x:0,y:0,w:32,h:32};
            })();

            const desiredPx = Math.max(1, parseInt(pointOptions.iconSize || defaultRect.w));
            const scaleRatio = desiredPx / (defaultRect.w || 1);

            pointStyle = {
                'icon-src': sp.url,
                'icon-size': buildMatchArray('size', [defaultRect.w, defaultRect.h]),
                // taille réelle de la feuille (sprite sheet)
                'icon-width': sp.sheetWidth,
                'icon-height': sp.sheetHeight,
                'icon-offset': buildMatchArray('offset', [defaultRect.x, defaultRect.y]),
                'icon-offset-origin': 'top-left',
                'icon-scale': scaleRatio,
                'icon-rotate-with-view': false,
            };
        } else {
            // Fallback simple: rien si sprite absent
            pointStyle = {
                'circle-radius': pointSize,
                'circle-fill-color': fillColor || '#FF0000'
            };
        }
    } else {
        if (pointOptions.shape == "circle") {
            // Si taille bordure = 0 OU mode = none, pas de bordure du tout
            if (borderSizeValue == 0 || pointOptions.border.mode == "none") {
            pointStyle = {
            'circle-radius': pointSize,
                    'circle-fill-color': fillColor || '#FF0000',
            'circle-rotate-with-view': false,
            'circle-displacement': [0, 0],
            'circle-opacity': 1
            }
            } else {
                // Bordure avec épaisseur variable
                pointStyle = {
                    'circle-radius': pointSize,
                    'circle-fill-color': fillColor || '#FF0000',
                    'circle-stroke-color': borderColor || '#000000',
                    'circle-stroke-width': borderWidth,
                'circle-rotate-with-view': false,
                'circle-displacement': [0, 0],
                'circle-opacity': 1
                }
            }


    } else if (pointOptions.shape == "triangle") {
        // Si taille bordure = 0 OU mode = none, pas de bordure du tout
        if (borderSizeValue == 0 || pointOptions.border.mode == "none") {
        pointStyle = {
            'shape-points': 3,
            'shape-radius': pointSize,
            'shape-fill-color': fillColor,
            'shape-rotate-with-view': true,
            }
        } else {
            // Bordure avec épaisseur variable
            pointStyle = {
            'shape-points': 3,
                'shape-radius': pointSize,
                'shape-fill-color': fillColor,
                'shape-stroke-color': borderColor || '#000000',
                'shape-stroke-width': borderWidth,
            'shape-rotate-with-view': true,
            }
            }
        }

    }   


    // Assurez-vous que vectorSource et les layers sont initialisés
    if (!window.vectorSource || !vectorLayer) {
        window.vectorSource = new ol.source.Vector({
            wrapX: true,
        });

        // Plus besoin de layer séparé pour la bordure - elle est intégrée dans pointStyle

        vectorLayer = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: pointStyle,
            zIndex: 1001, // Z-index élevé pour visibilité
        });
        map.addLayer(vectorLayer);
    }

    // Vérifier que le layer existe toujours sur la carte (il peut avoir été supprimé)
    if (vectorLayer && !map.getLayers().getArray().includes(vectorLayer)) {
        map.addLayer(vectorLayer);
    }

    if (features) {
        if (features.length > 0) {
            // Puisque les features sont déjà au format GeoJSON, lisez-les directement
            const newFeatures = new ol.format.GeoJSON().readFeatures({
                type: 'FeatureCollection',
                features: features // Utilisez directement votre tableau de features GeoJSON
            }, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857'
            });
    
            window.vectorSource.addFeatures(newFeatures);
        }
    } else {
        // Chargez les features à partir d'un fichier GeoJSON si aucun feature n'est fourni
        fetch('static/geojson_data.json').then(response => response.json()).then(data => {
            const newFeatures = new ol.format.GeoJSON().readFeatures(data, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857'
            });
            window.vectorSource.addFeatures(newFeatures);
        });
    }
}

// supprime les points de la carte (centre et bordures si existantes)
export function clearMap(){
    console.log('[CLEAR] Début du nettoyage de la carte');

    // Garder vectorSource mais vider son contenu
    if (window.vectorSource) {
        window.vectorSource.clear();
        console.log('[CLEAR] Vector source nettoyé');
    }

    // Réinitialiser les références aux layers pour forcer leur recréation
    vectorLayer = undefined;
    console.log('[CLEAR] vectorLayer remis à undefined');

    // Supprimer les autres layers si nécessaire
    if (window.borderLayer) {
        map.removeLayer(window.borderLayer);
        window.borderLayer = undefined;
        console.log('[CLEAR] borderLayer supprimé');
    }
    if (window.centerLayer) {
        map.removeLayer(window.centerLayer);
        window.centerLayer = undefined;
        console.log('[CLEAR] centerLayer supprimé');
    }

    // Nettoyer les layers d'animation
    if (window.animationLayer) {
        window.animationLayer.setVisible(false);
        window.animationLayer = undefined;
        console.log('[CLEAR] animationLayer nettoyé');
    }

    console.log('[CLEAR] Fin du nettoyage de la carte');
}


// ----------- ANIMATION DE LA CARTE  ------------
// Fonction helper pour récupérer tous les points filtrés
function getAllFilteredPoints() {
    const allPoints = [];
    if (pkg.pointsByDate) {
        for (const points of pkg.pointsByDate.values()) {
            allPoints.push(...points);
        }
    }
    return allPoints;
}

// Fonction helper pour récupérer tous les points filtrés jusqu'à la date de début d'animation
function getFilteredPointsAtStart() {
    const allPoints = [];
    if (pkg.pointsByDate) {
        // Utiliser la date de début d'animation comme limite supérieure
        const animationStartDate = pkg.options.animation.dateStart instanceof Date
            ? pkg.options.animation.dateStart
            : pkg.metadata.startDate;

        for (const [dateKey, points] of pkg.pointsByDate.entries()) {
            const date = new Date(dateKey);
            if (date <= animationStartDate) {
                allPoints.push(...points);
            }
        }
    }
    return allPoints;
}

// Fonction helper pour récupérer tous les points jusqu'à une date donnée (incluse)
function getPointsUpToDate(targetDate) {
    const allPoints = [];
    if (pkg.pointsByDate) {
        for (const [dateKey, points] of pkg.pointsByDate.entries()) {
            const date = new Date(dateKey);
            if (date <= targetDate) {
                allPoints.push(...points);
            }
        }
    }
    return allPoints;
}

export function startAnimation(restart=false) {
    if (!restart) {
        // Vérification que vectorSource existe avant de l'utiliser
        if (window.vectorSource) {
        window.vectorSource.clear();
        }

        // Afficher les caches filtrés jusqu'à la date de début d'animation (sans effet flash)
        const filteredPointsAtStart = getFilteredPointsAtStart();
        if (filteredPointsAtStart.length > 0) {
            displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
        }

        createFlashElements();
        infos = createObjectInfos();
        // Démarrer la musique de fond si activée (lecture seule)
        try { startBackgroundMusicIfAny(); } catch(e) { console.warn('startBackgroundMusicIfAny error:', e); }
    } else {
        // En mode restart, s'assurer que 'infos' existe pour éviter les erreurs
        if (!infos) {
            infos = createObjectInfos();
        }
    }

    let flashOptions = pkg.options.flash

    flashOptions.rgb = pkg.hexToRgb(flashOptions.color);
    const dayDuration = pkg.options.animation.timePerDay;

    // Debug: Afficher les options d'animation
    console.log('[DEBUG ANIMATION] Options animation:', pkg.options.animation);
    console.log('[DEBUG ANIMATION] dateStart type:', typeof pkg.options.animation.dateStart, 'value:', pkg.options.animation.dateStart);
    console.log('[DEBUG ANIMATION] dateEnd type:', typeof pkg.options.animation.dateEnd, 'value:', pkg.options.animation.dateEnd);

    // Appliquer plage de dates définie dans l'onglet Animation si présente
    if (pkg.options.animation.dateStart instanceof Date) {
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
        console.log('[ANIMATION] Date de début personnalisée appliquée:', pkg.metadata.startDate);
    } else {
        console.log('[ANIMATION] ❌ Pas de date de début personnalisée, utilisation par défaut:', pkg.metadata.startDate);
    }

    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
        console.log('[ANIMATION] Date de fin personnalisée appliquée:', pkg.metadata.endDate);
    } else {
        console.log('[ANIMATION] ❌ Pas de date de fin personnalisée, utilisation par défaut:', pkg.metadata.endDate);
    }

    if (!restart) {
        currentDate = new Date(pkg.metadata.startDate); // Initialisation de la date avec la date de début (personnalisée ou par défaut)
        console.log('[ANIMATION] 🚀 Démarrage avec date:', currentDate, '->', pkg.metadata.endDate);
    }
    interval = setInterval(() => {
        displayFeaturesForDate(currentDate, pkg.options.point, flashOptions, false, infos);
        currentDate.setDate(currentDate.getDate() + 1);
        if (currentDate > pkg.metadata.endDate) {
            console.log('[ANIMATION] Fin atteinte. currentDate:', currentDate);
            clearInterval(interval);
            interval = null;
            try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }
            try { hidePopup(); } catch(_) {}
        }
    }, dayDuration);
}

export function stopAnimation(){
    // Arrêter l'enregistrement si en cours
    isRecording = false;

    // Arrêter le pipeline MediaRecorder si actif
    try {
        if (isMediaRecording) {
            stopMediaRecorderPipeline(true);
        }
    } catch(e) { console.warn('Erreur arrêt MediaRecorder:', e); }

    // Arrêter musique de fond si lecture seule
    try { stopBackgroundMusic(); } catch(e) { console.warn('stopBackgroundMusic error:', e); }

    if (interval) {
        clearInterval(interval);
        interval = null; // Nettoyer la référence à l'intervalle
    }

    // Fermer le toast de chargement s'il est ouvert
    try {
        // Essayer différents sélecteurs pour le toast
        const loadingToast = document.querySelector('.toast-loading') ||
                           document.querySelector('.toast') ||
                           document.querySelector('[class*="toast"]');
        if (loadingToast) {
            console.log('[STOP] Toast trouvé, tentative de fermeture:', loadingToast);
            pkg.hideToast && pkg.hideToast(loadingToast);
        } else {
            console.log('[STOP] Aucun toast trouvé avec les sélecteurs testés');
        }

        // Essayer aussi de fermer tous les toasts visibles
        const allToasts = document.querySelectorAll('.toast, [class*="toast"]');
        allToasts.forEach((toast, index) => {
            console.log(`[STOP] Fermeture toast ${index}:`, toast.textContent);
            pkg.hideToast && pkg.hideToast(toast);
        });
    } catch(e) {
        console.warn('Erreur lors de la fermeture du toast:', e);
    }

    // Remettre la carte à l'état d'origine avec tous les points filtrés
    console.log('[STOP] Nettoyage de la carte...');
    clearMap();

    // Nettoyer les animations et effets
    if (window.vectorSource) {
        window.vectorSource.clear();
        console.log('[STOP] Vector source nettoyé');
    }

    // Nettoyer les animations de flash
    if (animationSource) {
        animationSource.clear();
        console.log('[STOP] Animation source nettoyé');
    }

    // Nettoyer les layers d'animation
    if (animationLayer) {
        animationLayer.setVisible(false);
        console.log('[STOP] Animation layer masqué');
    }

    // Nettoyer les références globales
    if (window.animationSource) {
        window.animationSource.clear();
        window.animationSource = undefined;
        console.log('[STOP] Window animation source nettoyé');
    }

    if (window.animationLayer) {
        window.animationLayer.setVisible(false);
        window.animationLayer = undefined;
        console.log('[STOP] Window animation layer nettoyé');
    }

    // Remettre les styles par défaut
    updateAnimationStyles();
    console.log('[STOP] Styles d\'animation remis à zéro');

    const allFilteredPoints = getAllFilteredPoints();
    console.log('[STOP] Nombre de points filtrés à afficher:', allFilteredPoints.length);
    if (allFilteredPoints.length > 0) {
        displayWebGLPoints(allFilteredPoints, pkg.options.point);
        console.log('[STOP] Points affichés avec succès');
    } else {
        console.log('[STOP] Aucun point à afficher');
    }

    // Remettre les contrôles UI dans l'état initial
    try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }

    // S'assurer que la popup est masquée
    try { hidePopup(); } catch(_) {}
}

export function recordAnimation(){
    // Branche MediaRecorder si demandé et supporté
    try {
        const mode = pkg.options?.record?.mode;
        if (mode === 'mediarecorder' && isMediaRecorderSupported()) {
            recordAnimationMediaRecorder();
            return;
        } else if (mode === 'mediarecorder' && !isMediaRecorderSupported()) {
            pkg.showToast && pkg.showToast('MediaRecorder non supporté, bascule en mode images.', 'warning', 'Compatibilité');
        }
    } catch(e) { console.warn('Detection MediaRecorder error:', e); }

    // Vérifier que les données sont prêtes
    if (!pkg.pointsByDate || pkg.pointsByDate.size === 0) {
        console.error("Les données de géocaches ne sont pas encore chargées");
        pkg.showToast("Données en cours de chargement. Veuillez réessayer.", "warning", "Attention");
        return;
    }

    // Démarrer la surveillance des performances pour le mode images
    recordingPerformanceMonitor.startMonitoring();

    // Nettoyage initial du répertoire d'images avant la capture
    const prepToast = pkg.showToast && pkg.showToast('Préparation de l\'enregistrement...', 'info', 'Nettoyage initial', 0);
    fetch(`${CONFIG.BASE_URL}/clear_pictures_directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vider_repertoire' })
    })
    .then(r => r.json())
    .then(d => {
        if (prepToast) { pkg.hideToast && pkg.hideToast(prepToast); }
        if (d && d.success) {
            pkg.showToast && pkg.showToast('Répertoire d’images nettoyé.', 'success', 'Préparation', 2000);
        } else {
            pkg.showToast && pkg.showToast('Nettoyage initial impossible. Poursuite de l\'enregistrement.', 'warning', 'Attention', 3000);
        }
        startRecordingProcess();
    })
    .catch(err => {
        if (prepToast) { pkg.hideToast && pkg.hideToast(prepToast); }
        pkg.showToast && pkg.showToast('Erreur nettoyage initial. Poursuite.', 'warning', 'Attention', 3000);
        startRecordingProcess();
    });
    try { hidePopup(); } catch(_) {}
    return;
}

function startRecordingProcess(){
    // Remise à zéro de l'état de la carte et des informations affichées
    clearMap(); // Nettoie les points sur la carte

    // Afficher les caches filtrés jusqu'à la date de début d'animation (sans effet flash)
    const filteredPointsAtStart = getFilteredPointsAtStart();
    if (filteredPointsAtStart.length > 0) {
        displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
    }

    // Déterminer plage de dates d'animation si définie
    if (pkg.options.animation.dateStart instanceof Date) {
        currentDate = new Date(pkg.options.animation.dateStart);
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
        console.log('[RECORD] Date de début personnalisée appliquée:', pkg.metadata.startDate);
    } else {
        currentDate = pkg.metadata.startDate;
        console.log('[RECORD] ❌ Utilisation date de début par défaut:', currentDate);
    }
    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
        console.log('[RECORD] Date de fin personnalisée appliquée:', pkg.metadata.endDate);
    } else {
        console.log('[RECORD] ❌ Utilisation date de fin par défaut:', pkg.metadata.endDate);
    }

    console.log('[RECORD] 🚀 Démarrage enregistrement avec date:', currentDate, '->', pkg.metadata.endDate);

    // Calculer le nombre de jours d'animation (basé sur la plage sélectionnée, pas toute la BDD)
    try {
        const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const end = new Date(pkg.metadata.endDate.getFullYear(), pkg.metadata.endDate.getMonth(), pkg.metadata.endDate.getDate());
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const rawDays = Math.floor((end - start) / MS_PER_DAY) + 1; // inclusif
        const animationDays = Math.max(1, rawDays);

        // Mettre à jour le total d'images attendu pour la progression
        const framesPerDayLocal = Number(pkg.options.record?.framesPerDay) || framesPerDay || 1;
        const extra = Math.max(0, Math.round(Number(pkg.options.record?.extraFrames) || 0));
        pkg.options.record.nbOfImages = animationDays * framesPerDayLocal + extra;
        pkg.options.record.numberOfDigits = Math.max(4, Math.round(pkg.options.record.nbOfImages).toString().length);
        console.log('[RECORD] Jours animation:', animationDays, 'frames/jour:', framesPerDayLocal, 'total images:', pkg.options.record.nbOfImages);
    } catch(e) { console.warn('Calcul jours animation échoué:', e); }

    // Remise à zéro de l'affichage des informations
    pkg.updateNbCaches(0); // Remet le compteur de géocaches à zéro
    pkg.updateCurrentDate(currentDate); // Remet la date au début effectif

    // ouverture modale (progress) avec instruction intégrée
    pkg.openModalLoading("Capture en cours", "Ne pas bouger la fenêtre pendant la capture.");

    // Init métriques
    perfMetrics = { totalFrames: 0, capturedFrames: 0, uploadOk: 0, uploadFail: 0, captureTimeMs: 0, uploadTimeMs: 0, startedAt: performance.now() };

    // Marquer le début de l'enregistrement
    isRecording = true;
    // Bloquer la musique de fond pendant la capture d'images et informer l'utilisateur si un fichier audio est chargé
    try {
        blockBackgroundAudioPlayback = true;
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            const name = file.name || 'audio';
            pkg.showToast && pkg.showToast(`Enregistrement: audio sera ajouté après capture: ${name}`, 'info', 'Audio différé', 4000);
        }
    } catch(_) {}

    // je fais une copie car plus rapide de gerer une valeur qu'un objet
    framesPerDay = pkg.options.record.framesPerDay

    // mise à jour des options RGB (MEttre ailleurs ? + idem lecture seule)
    pkg.options.flash.rgb = pkg.hexToRgb(pkg.options.flash.color);

    // Assurez-vous que vectorSource est initialisé
    if (!window.vectorSource) {
        window.vectorSource = new ol.source.Vector({
            wrapX: true,
        });
    }
    
    window.vectorSource.clear();
    createFlashElements();
    // creation objet pour stocker les infos liées aux Frames (dt nombre de caches)
    let infos = createObjectInfos();

    currentFrame = 0;  // Réinitialisez le compteur de frames

    // Afficher les points initiaux pour la date de début
    displayFeaturesForDate(currentDate, pkg.options.point, pkg.options.flash, true, infos);

    // Attendre que le rendu soit complet avant de commencer la capture
    map.once('rendercomplete', () => {
        requestAnimationFrame(() => {
            captureNextFrame(true, pkg.options.point, pkg.options.flash, infos);
        });
    });

    // Forcer un rendu pour déclencher rendercomplete
    map.renderSync();
}


// créé un objet pour les infos pour permet de garder une consistance pour le nombre de caches
function createObjectInfos(){
    let infos = new Object();
    infos.displayDate = pkg.options.infos.currentDate.display
    infos.displayNumberofCaches = pkg.options.infos.numberOfCaches.display
    infos.cacheNumber = 0;
    return infos
}


// TODO Voir pour Capture, car à priori c'est forcement == True
async function captureNextFrame(capture, pointOptions, flashOptions, infos) {
    // Vérifier si l'enregistrement a été arrêté
    if (!isRecording) {
        console.log('[CAPTURE] Enregistrement arrêté par l\'utilisateur');

        // Fermer le toast de chargement
        try {
            const loadingToast = document.querySelector('.toast-loading') ||
                               document.querySelector('.toast') ||
                               document.querySelector('[class*="toast"]');
            if (loadingToast) {
                console.log('[CAPTURE] Toast trouvé, tentative de fermeture:', loadingToast);
                pkg.hideToast && pkg.hideToast(loadingToast);
            } else {
                console.log('[CAPTURE] Aucun toast trouvé avec les sélecteurs testés');
            }

            // Essayer aussi de fermer tous les toasts visibles
            const allToasts = document.querySelectorAll('.toast, [class*="toast"]');
            allToasts.forEach((toast, index) => {
                console.log(`[CAPTURE] Fermeture toast ${index}:`, toast.textContent);
                pkg.hideToast && pkg.hideToast(toast);
            });
        } catch(e) {
            console.warn('Erreur lors de la fermeture du toast:', e);
        }

        // Nettoyer les animations de flash
        if (animationSource) {
            animationSource.clear();
            console.log('[CAPTURE] Animation source nettoyé');
        }
        if (animationLayer) {
            animationLayer.setVisible(false);
            console.log('[CAPTURE] Animation layer masqué');
        }

        // Remettre la carte avec tous les points filtrés
        clearMap();
        const allFilteredPoints = getAllFilteredPoints();
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
            console.log('[CAPTURE] Affichage de', allFilteredPoints.length, 'points filtrés');
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }
        return;
    }

    if (currentDate > pkg.metadata.endDate) {
        for (let extraFrames = 0; extraFrames < pkg.options.record.extraFrames; extraFrames++) {
            updateAnimationStyles();
            if (capture == true) {
                await captureElement();
                currentFrame++;

            } else {
                currentFrame++;
            }
        }

        // Traitement de fin
        isRecording = false; // Marquer la fin de l'enregistrement
        
        // Arrêter la surveillance des performances
        recordingPerformanceMonitor.stopMonitoring();
        
        try { blockBackgroundAudioPlayback = false; } catch(_) {}

        // Fermer le toast de chargement
        try {
            const loadingToast = document.querySelector('.toast-loading') ||
                               document.querySelector('.toast') ||
                               document.querySelector('[class*="toast"]');
            if (loadingToast) {
                pkg.hideToast && pkg.hideToast(loadingToast);
            }

            // Essayer aussi de fermer tous les toasts visibles
            const allToasts = document.querySelectorAll('.toast, [class*="toast"]');
            allToasts.forEach((toast, index) => {
                pkg.hideToast && pkg.hideToast(toast);
            });
        } catch(e) {
            console.warn('Erreur lors de la fermeture du toast:', e);
        }

        // Nettoyer les animations de flash
        if (animationSource) {
            animationSource.clear();
            console.log('[RECORD END] Animation source nettoyé');
        }
        if (animationLayer) {
            animationLayer.setVisible(false);
            console.log('[RECORD END] Animation layer masqué');
        }

        // Remettre la carte avec tous les points filtrés
        clearMap();
        const allFilteredPoints = getAllFilteredPoints();
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
            console.log('[RECORD END] Affichage de', allFilteredPoints.length, 'points filtrés');
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }

        // Assembler automatiquement puis nettoyer
        console.log('[RECORD END] Démarrage de l\'assemblage automatique...');

        // Désactiver temporairement les boutons pour éviter les clics multiples
        const assembleBtn = document.getElementById('btnAssembleMoviePictures');
        const cleanBtn = document.getElementById('btnCleanMoviePictures');
        const recordBtn = document.getElementById('btnRecordAnimation');

        if (assembleBtn) {
          assembleBtn.disabled = true;
          assembleBtn.textContent = 'Assemblage en cours...';
        }
        if (cleanBtn) {
          cleanBtn.disabled = true;
          cleanBtn.textContent = 'Nettoyage en cours...';
        }
        if (recordBtn) {
          recordBtn.disabled = true;
        }

        // Réutiliser la modal/loader existante pour garantir l'affichage (système qui marche déjà chez toi)
        try { pkg.openModalLoading('Assemblage en cours', 'Création de la vidéo à partir des images...'); } catch(e) { console.warn('openModalLoading erreur:', e); }

        // Si un audio utilisateur est activé en mode images, l'uploader et passer son nom à l'assemblage
        const tryAssembleWithAudio = async () => {
            try {
                let audioFileName = null;
                const input = document.getElementById('inputAudioFile');
                const file = input?.files?.[0];
                const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
                const audioVol = (typeof pkg.options?.record?.audio?.volume === 'number') ? pkg.options.record.audio.volume : 1;
                if (audioEnabled && file) {
                    const fd = new FormData();
                    fd.append('audio', file);
                    const up = await fetch(`${CONFIG.BASE_URL}/upload_audio`, { method: 'POST', body: fd });
                    const upRes = await up.json().catch(()=>({success:false}));
                    if (upRes?.success && upRes?.file) audioFileName = upRes.file;
                }
                const url = new URL(`${CONFIG.BASE_URL}/start_create_video`, window.location.origin);
                if (audioFileName) {
                    url.searchParams.set('audio', audioFileName);
                    url.searchParams.set('audio_volume', String(audioVol));
                }
                return fetch(url.toString());
            } catch(e) {
                console.warn('Assemblage avec audio: fallback sans audio', e);
                return fetch(`${CONFIG.BASE_URL}/start_create_video`);
            }
        };

        tryAssembleWithAudio()
          .then(response => { logToast('Réponse assemblage reçue, status:', response?.status); return response.json(); })
          .then(data => {
            if (data && data.success) {
              console.log('[RECORD END] Assemblage réussi, nettoyage automatique...');
              // Mettre à jour le loader (70%) et texte via UI utils existants
              try { pkg.updateProgressBar({progress: 70, message: 'Vidéo créée. Nettoyage des images...'}); } catch(e) {}
              try { pkg.updateTextsModal('Nettoyage en cours', 'Vidéo créée avec succès. Nettoyage des images...'); } catch(e) {}

              // Nettoyer automatiquement
              return fetch(`${CONFIG.BASE_URL}/clear_pictures_directory`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ action: 'vider_repertoire' })
              });
            } else {
              console.warn('[RECORD END] Échec de l\'assemblage:', data.message);
              // Réactiver les boutons en cas d'erreur
              if (assembleBtn) {
                assembleBtn.disabled = false;
                assembleBtn.textContent = 'Assembler film';
              }
              if (cleanBtn) {
                cleanBtn.disabled = false;
                cleanBtn.textContent = 'Nettoyer images';
              }
              if (recordBtn) {
                recordBtn.disabled = false;
              }
              try { pkg.closeModalLoading(); } catch(e) {}
              pkg.showToast && pkg.showToast('Erreur lors de la création de la vidéo: ' + (data.message || 'Erreur inconnue'), 'error', 'Échec assemblage', 5000);
              throw new Error('Assemblage failed');
            }
          })
          .then(response => response ? response.json() : null)
          .then(cleanData => {
            if (cleanData && cleanData.success) {
              console.log('[RECORD END] Nettoyage automatique terminé');
              // Réactiver les boutons et restaurer les textes
              if (assembleBtn) {
                assembleBtn.disabled = false;
                assembleBtn.textContent = 'Assembler film';
              }
              if (cleanBtn) {
                cleanBtn.disabled = false;
                cleanBtn.textContent = 'Nettoyer images';
              }
              if (recordBtn) {
                recordBtn.disabled = false;
              }

              try { pkg.updateProgressBar({progress: 100, message: 'Nettoyage terminé'}); } catch(e) {}
              setTimeout(() => { try { pkg.closeModalLoading(); } catch(e) {} }, 400);
              pkg.showToast && pkg.showToast('Traitement automatique terminé avec succès !', 'success', 'Vidéo prête', 5000);
            } else if (cleanData) {
              console.warn('[RECORD END] Échec du nettoyage:', cleanData.message);
              // Réactiver les boutons même si le nettoyage échoue
              if (assembleBtn) {
                assembleBtn.disabled = false;
                assembleBtn.textContent = 'Assembler film';
              }
              if (cleanBtn) {
                cleanBtn.disabled = false;
                cleanBtn.textContent = 'Nettoyer images';
              }
              if (recordBtn) {
                recordBtn.disabled = false;
              }
              try { pkg.closeModalLoading(); } catch(e) {}
            }
          })
          .catch(err => {
            console.error('[RECORD END] Erreur dans la chaîne automatique:', err);
            // Réactiver les boutons en cas d'erreur
            if (assembleBtn) {
              assembleBtn.disabled = false;
              assembleBtn.textContent = 'Assembler film';
            }
            if (cleanBtn) {
              cleanBtn.disabled = false;
              cleanBtn.textContent = 'Nettoyer images';
            }
            if (recordBtn) {
              recordBtn.disabled = false;
            }
            try { pkg.closeModalLoading(); } catch(e) {}
            pkg.showToast && pkg.showToast('Erreur lors du traitement automatique: ' + err.message, 'error', 'Erreur chaîne', 5000);
          });

        return;
    }

    if (currentFrame < framesPerDay) {
        // Mettez à jour les styles d'animation avant de capturer la frame
        updateAnimationStyles();
        // Capturez la frame actuelle
        if (capture == true) {
            await captureElement();
                currentFrame++;
                requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
        } else {
            currentFrame++;
            // De même ici, si vous avez besoin de passer des arguments spécifiques
            requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
        }
    } else {
        // JOUR SUIVANT
        // Mise à jour de la Modale
        updateProgress();

        currentDate.setDate(currentDate.getDate() + 1);
        displayFeaturesForDate(currentDate, pointOptions, flashOptions, true, infos);
        currentFrame = 0;  // Réinitialisez le compteur de frames pour le nouveau jour
        requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
    }
}

// ---------------- MEDIARECORDER PIPELINE ----------------
function isMediaRecorderSupported() {
    try {
        const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
        const hasMR = typeof window !== 'undefined' && 'MediaRecorder' in window;
        const hasCanvasCapture = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
        const mimeOk = hasMR ? (MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported(mime) : true) : false;
        return hasMR && hasCanvasCapture && mimeOk;
    } catch(_) { return false; }
}

function recordAnimationMediaRecorder(){
    // Vérifier données
    if (!pkg.pointsByDate || pkg.pointsByDate.size === 0) {
        pkg.showToast && pkg.showToast('Données en cours de chargement. Réessayez.', 'warning', 'Attention');
        return;
    }

    // Empêcher toute lecture de musique pendant l'enregistrement MR
    try {
        blockBackgroundAudioPlayback = true;
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            const name = file.name || 'audio';
            pkg.showToast && pkg.showToast(`Enregistrement: audio sera ajouté après capture: ${name}`, 'info', 'Audio différé', 4000);
        }
    } catch(_) {}

    // Préparation carte: points initiaux, animations, etc.
    try { clearMap(); } catch(_) {}

    const filteredPointsAtStart = getFilteredPointsAtStart();
    if (filteredPointsAtStart.length > 0) {
        displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
    }

    // Déterminer plage de dates
    if (pkg.options.animation.dateStart instanceof Date) {
        currentDate = new Date(pkg.options.animation.dateStart);
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
    } else {
        currentDate = pkg.metadata.startDate;
    }
    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
    }

    // Frames/informations
    window.vectorSource = window.vectorSource || new ol.source.Vector({ wrapX: true });
    window.vectorSource.clear();
    createFlashElements();
    let infosLocal = createObjectInfos();
    pkg.updateNbCaches(0);
    pkg.updateCurrentDate(currentDate);

    // UI loader
    const totalMs = computeTotalAnimationMs();
    try { pkg.openModalLoading('Enregistrement en cours', 'Ne pas bouger la fenêtre pendant la capture.'); } catch(_) {}

    // Appliquer un éventuel ralentissement utilisateur sur la timeline
    const originalTimePerDay = pkg.options.animation.timePerDay;
    const originalFlashDuration = pkg.options.flash.duration;
    let appliedSlowdown = 1;
    try {
        const sd = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
        appliedSlowdown = sd;
        if (sd > 1) {
            pkg.options.animation.timePerDay = originalTimePerDay * sd;
            // Ralentir aussi l'animation des flashs pour compenser la normalisation
            pkg.options.flash.duration = originalFlashDuration * sd;
            console.log('[RECORD] Slowdown x' + sd + ' appliqué: timePerDay=' + pkg.options.animation.timePerDay + ', flash.duration=' + pkg.options.flash.duration);
        }
    } catch(_) {}

    // Démarrer animation timeline existante (musique bloquée)
    try { startAnimation(true); } catch(_) { startAnimation(); }

    // Démarrer capture MediaRecorder
    startMediaRecorderPipeline(totalMs * appliedSlowdown).catch(e => {
        console.error('MediaRecorder pipeline error:', e);
        pkg.showToast && pkg.showToast('Erreur MediaRecorder, bascule en mode images.', 'error', 'Enregistrement');
        // Fallback vers pipeline images
        try { stopMediaRecorderPipeline(false); } catch(_) {}
        recordAnimation(); // relance en mode images (si l’option est encore mediarecorder, la détection support retournera false)
    });

    // Restaurer timePerDay après démarrage (sera effectif pour la suite)
    // On le fera surtout à la fin (onStop) pour garantir l’état UI
    mrOnFinalizeRestoreTimePerDay = () => {
        try { pkg.options.animation.timePerDay = originalTimePerDay; } catch(_) {}
        try { pkg.options.flash.duration = originalFlashDuration; } catch(_) {}
    };
}

function computeTotalAnimationMs(){
    try {
        const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const end = new Date(pkg.metadata.endDate.getFullYear(), pkg.metadata.endDate.getMonth(), pkg.metadata.endDate.getDate());
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const rawDays = Math.floor((end - start) / MS_PER_DAY) + 1; // inclusif
        const animationDays = Math.max(1, rawDays);
        const perDay = Number(pkg.options.animation?.timePerDay) || 50;
        const base = animationDays * perDay;
        const fps = Number(pkg.options.record?.fps) || 24;
        const extraFrames = Math.max(0, Math.round(Number(pkg.options.record?.extraFrames) || 0));
        const tail = Math.round((extraFrames / fps) * 1000);
        return base + tail;
    } catch(_) { return 3000; }
}

async function startMediaRecorderPipeline(totalDurationMs){
    const fps = Number(pkg.options.record?.fps) || 24;
    const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
    const vbps = Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) || 6000000;
    const scaleFactor = Math.max(1, Math.min(3, Number(pkg.options?.record?.mediaRecorder?.scaleFactor) || 1));

    const viewport = map.getViewport();
    const rect = viewport.getBoundingClientRect();
    mrOutCanvas = document.createElement('canvas');
    mrOutCanvas.width = Math.max(1, Math.floor(rect.width * scaleFactor));
    mrOutCanvas.height = Math.max(1, Math.floor(rect.height * scaleFactor));
    mrOutCtx = mrOutCanvas.getContext('2d', { willReadFrequently: true });

    const canvasStream = mrOutCanvas.captureStream(fps);
    // Pas d'audio pendant l'enregistrement MediaRecorder (audio ajouté après)
    mrHadAudio = false;
    const mixedStream = canvasStream;

    mrRecordedChunks = [];
    const abps = Number(pkg.options?.record?.mediaRecorder?.audioBitsPerSecond) || 128000;
    mrRecorder = new MediaRecorder(mixedStream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: abps });
    isMediaRecording = true;

    mrRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mrRecordedChunks.push(e.data); };
    mrRecorder.onstop = () => finalizeMediaRecorderVideo();
    // Utiliser un timeslice plus grand pour réduire le nombre de chunks et la pression GC
    const timesliceMs = Math.max(200, Number(pkg.options?.record?.mediaRecorder?.timesliceMs) || 1000);
    mrRecorder.start(timesliceMs);

    // Ne pas jouer la musique pendant l'enregistrement (audio différé)

    // Dessin périodique (compositing)
    let drawing = false;
    const intervalMs = Math.max(4, Math.floor(1000 / fps));
    
    // Démarrer la surveillance des performances
    recordingPerformanceMonitor.startMonitoring();
    
    mrDrawIntervalId = setInterval(() => {
        if (!isMediaRecording || drawing) return;
        drawing = true;
        
        const frameStart = performance.now();
        try {
            map.renderSync();
            const canvasList = viewport.querySelectorAll('canvas');
            const w = mrOutCanvas.width;
            const h = mrOutCanvas.height;
            mrOutCtx.clearRect(0, 0, w, h);
            canvasList.forEach(c => { if (c.width > 0 && c.height > 0) mrOutCtx.drawImage(c, 0, 0, w, h); });
            addOverlaysToCanvas(mrOutCtx, w, h, scaleFactor);
        } catch(e) {
            console.warn('Composite frame error:', e);
        } finally {
            const frameEnd = performance.now();
            const frameTime = frameEnd - frameStart;
            
            // Utiliser le système global de surveillance
            recordingPerformanceMonitor.checkPerformance(frameTime, intervalMs, 'mediarecorder');
            
            drawing = false;
        }
    }, intervalMs);

    // Progression
    const t0 = performance.now();
    mrProgressIntervalId = setInterval(() => {
        const elapsed = performance.now() - t0;
        const progress = Math.min(100, Math.max(0, (elapsed / totalDurationMs) * 100));
        const msg = `${progress.toFixed(1)}% | capture .webm`;
        try { pkg.updateProgressBar({ progress, message: msg }); } catch(_) {}
    }, 200);

    // Arrêt programmé
    setTimeout(() => {
        if (isMediaRecording) stopMediaRecorderPipeline(true);
    }, Math.max(0, totalDurationMs));
}

function stopMediaRecorderPipeline(finalize){
    try { if (mrDrawIntervalId) { clearInterval(mrDrawIntervalId); mrDrawIntervalId = null; } } catch(_) {}
    try { if (mrProgressIntervalId) { clearInterval(mrProgressIntervalId); mrProgressIntervalId = null; } } catch(_) {}
    
    // Arrêter la surveillance des performances
    recordingPerformanceMonitor.stopMonitoring();
    
    if (mrRecorder && mrRecorder.state !== 'inactive') {
        try { mrRecorder.stop(); } catch(_) {}
    } else if (finalize) {
        finalizeMediaRecorderVideo();
    }
    isMediaRecording = false;

    // Nettoyage audio MR
    try { if (mrAudioEl) { mrAudioEl.pause(); mrAudioEl.currentTime = 0; URL.revokeObjectURL(mrAudioEl.src); } } catch(_) {}
    try { if (mrAudioCtx) { mrAudioCtx.close(); } } catch(_) {}
    mrAudioEl = mrAudioCtx = mrAudioSource = mrAudioDest = mrAudioGain = null;
}

function finalizeMediaRecorderVideo(){
    try {
        const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
        const blob = new Blob(mrRecordedChunks || [], { type: mime });
        const fileName = (pkg.options?.record?.mediaRecorder?.fileName) || 'output.webm';

        const wantsDownload = !!pkg.options?.record?.mediaRecorder?.downloadLocal;
        const wantsUpload = !!pkg.options?.record?.mediaRecorder?.uploadToServer;
        const slowdown = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
        const wantsNorm = !!pkg.options?.record?.mediaRecorder?.offlineNormalization;
        const doNormalize = wantsNorm && slowdown > 1;

        const afterAll = () => {
            // Réactiver boutons et fermer loader
            try { pkg.updateProgressBar({ progress: 100, message: 'Terminé' }); } catch(_) {}
            setTimeout(() => { try { pkg.closeModalLoading(); } catch(_) {} }, 400);
            pkg.showToast && pkg.showToast('Vidéo prête', 'success', 'Enregistrement');
            // Débloquer la lecture de fond après enregistrement MR
            try { blockBackgroundAudioPlayback = false; } catch(_) {}
        };

        const proceedWith = (finalBlob) => {
            const tasks = [];
            if (wantsDownload) {
                try {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(finalBlob);
                    a.download = fileName;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                } catch(e) { console.warn('Download failed:', e); }
            }

            if (wantsUpload) {
                try {
                    const fd = new FormData();
                    fd.append('video', finalBlob, fileName);
                    fd.append('fileName', fileName);
                    tasks.push(fetch(`${CONFIG.BASE_URL}/upload_video`, { method: 'POST', body: fd }).then(r => r.json()).catch(e => ({ success:false, message: e?.message || 'upload error'}))
                        .then(res => { if (!res?.success) throw new Error(res?.message || 'Upload échoué'); }));
                } catch(e) { console.warn('Upload setup failed:', e); }
            }

            if (tasks.length) {
                Promise.allSettled(tasks).then(() => afterAll()).catch(() => afterAll());
            } else {
                afterAll();
            }
        };

        // Audio utilisateur éventuellement sélectionné
        const fileInput = document.getElementById('inputAudioFile');
        const audioFile = fileInput && fileInput.files && fileInput.files[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);

        // Orchestration: si normalisation requise, normaliser d'abord, puis mux audio si présent
        const doMux = (videoBlob) => {
            if (audioEnabled && audioFile) {
                try { pkg.updateTextsModal('Ajout audio', 'Fusion de la piste audio avec la vidéo en cours...'); } catch(_) {}
                muxRecordedVideoWithAudio(videoBlob, audioFile).then((mixed) => {
                    proceedWith(mixed || videoBlob);
                }).catch((e) => {
                    console.warn('Mux audio échoué, utilisation de la vidéo seule:', e);
                    proceedWith(videoBlob);
                });
            } else {
                proceedWith(videoBlob);
            }
        };

        if (doNormalize) {
            try { pkg.updateTextsModal('Normalisation', `Accélération x${slowdown} pour lecture à vitesse normale...`); } catch(_) {}
            normalizeRecordedVideoSpeed(blob, slowdown).then((normBlob) => {
                doMux(normBlob || blob);
            }).catch((e) => {
                console.warn('Normalization failed, continue without normalization:', e);
                doMux(blob);
            });
        } else {
            doMux(blob);
        }

    } catch(e) {
        console.error('Finalize MediaRecorder error:', e);
        try { pkg.closeModalLoading(); } catch(_) {}
    } finally {
        try { if (typeof mrOnFinalizeRestoreTimePerDay === 'function') { mrOnFinalizeRestoreTimePerDay(); } } catch(_) {}
        mrRecorder = null;
        mrRecordedChunks = [];
        mrOutCanvas = null;
        mrOutCtx = null;
    }
}

function normalizeRecordedVideoSpeed(sourceBlob, factor){
    return new Promise((resolve, reject) => {
        try {
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            const url = URL.createObjectURL(sourceBlob);
            video.src = url;

            const fps = Number(pkg.options?.record?.fps) || 24;
            const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
            const vbps = Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) || 6000000;

            let rec = null; let chunks = [];
            let progressTimer = null;

            const cleanup = () => {
                try { if (progressTimer) clearInterval(progressTimer); } catch(_) {}
                try { URL.revokeObjectURL(url); } catch(_) {}
                try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                try { video.playbackRate = factor; } catch(_) {}
                const duration = video.duration || 0;

                const stream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                if (!stream) { cleanup(); reject(new Error('captureStream non supporté pour la normalisation')); return; }

                rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps });
                rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                rec.onstop = () => {
                    cleanup();
                    try { resolve(new Blob(chunks, { type: mime })); } catch(e) { resolve(new Blob(chunks)); }
                };
                rec.start(Math.max(1000 / fps, 50));

                progressTimer = setInterval(() => {
                    try {
                        const p = duration > 0 ? Math.min(100, Math.max(0, (video.currentTime / duration) * 100)) : 0;
                        const message = p > 0 ? `Normalisation ${p.toFixed(1)}%` : 'Normalisation en cours';
                        pkg.updateProgressBar({ progress: p, message: message });
                    } catch(_) {}
                }, 200);

                video.addEventListener('ended', () => {
                    try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
                });

                video.play().catch(err => {
                    cleanup();
                    reject(err);
                });
            });

            video.addEventListener('error', (e) => {
                cleanup();
                reject(new Error('Erreur lecture vidéo pour normalisation'));
            });
        } catch(e) {
            reject(e);
        }
    });
}

function muxRecordedVideoWithAudio(sourceBlob, audioFile){
    return new Promise((resolve, reject) => {
        try {
            const video = document.createElement('video');
            video.muted = true; // pas de sortie audio à l'écran
            video.playsInline = true;
            video.preload = 'auto';
            const videoUrl = URL.createObjectURL(sourceBlob);
            video.src = videoUrl;

            // Préparer chargement/décodage audio (WebAudio, pas d'élément <audio>)
            const AC = window.AudioContext || window.webkitAudioContext;
            let audioCtx = window.mrMuxAudioCtx || null, audioGain = null, audioDest = null, audioBuffer = null, audioNode = null;
            let audioUrl = null; // conservé pour cleanup si nécessaire
            const loadAudioBuffer = async () => {
                const arr = await audioFile.arrayBuffer();
                if (!audioCtx) audioCtx = new AC();
                audioGain = audioCtx.createGain();
                audioGain.gain.value = Math.max(0, Math.min(1, Number(pkg.options?.record?.audio?.volume) || 1));
                audioDest = audioCtx.createMediaStreamDestination();
                audioGain.connect(audioDest);
                audioBuffer = await audioCtx.decodeAudioData(arr);
                audioNode = audioCtx.createBufferSource();
                audioNode.buffer = audioBuffer;
                audioNode.connect(audioGain);
            };

            const fps = Number(pkg.options?.record?.fps) || 24;
            const vbps = Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) || 6000000;
            const abps = Number(pkg.options?.record?.mediaRecorder?.audioBitsPerSecond) || 128000;

            // Choisir un mime compatible audio (opus)
            const pickMuxMime = () => {
                const candidates = [
                    'video/webm;codecs=vp9,opus',
                    'video/webm;codecs=vp8,opus',
                    'video/webm;codecs=opus',
                    'video/webm'
                ];
                for (const m of candidates) {
                    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch(_) {}
                }
                return '';
            };
            const muxMime = pickMuxMime();

            let rec = null; let chunks = [];

            const cleanup = () => {
                try { URL.revokeObjectURL(videoUrl); } catch(_) {}
                try { if (audioUrl) URL.revokeObjectURL(audioUrl); } catch(_) {}
                try { if (audioCtx && audioCtx !== window.mrMuxAudioCtx) audioCtx.close(); } catch(_) {}
                try { if (rec && rec.state !== 'inactive') rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                try {
                    const vStream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                    if (!vStream) { cleanup(); reject(new Error('captureStream non supporté pour mux audio')); return; }

                    // Charger et préparer le buffer audio
                    // (pas de sortie vers destination pour rester silencieux)
                    // Utiliser des promesses pour garantir l'ordre
                    Promise.resolve()
                        .then(() => loadAudioBuffer())
                        .then(() => {
                            // Composer flux (vidéo + piste audio)
                            const composed = new MediaStream([
                                ...vStream.getVideoTracks(),
                                ...audioDest.stream.getAudioTracks()
                            ]);

                            // Debug: vérifier présence des pistes
                            try {
                                console.log('[MUX] tracks video:', vStream.getVideoTracks().length, 'audio:', audioDest.stream.getAudioTracks().length, 'mime:', muxMime);
                            } catch(_) {}

                            const mrOpts = { videoBitsPerSecond: vbps, audioBitsPerSecond: abps };
                            if (muxMime) mrOpts.mimeType = muxMime;
                            rec = new MediaRecorder(composed, mrOpts);
                            rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
                            rec.onstop = () => {
                                cleanup();
                                const outType = muxMime || 'video/webm';
                                try { resolve(new Blob(chunks, { type: outType })); } catch(e) { resolve(new Blob(chunks)); }
                            };
                            rec.start(Math.max(1000 / fps, 50));

                            // Fin: quand la vidéo se termine
                            video.addEventListener('ended', () => {
                                try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
                            });

                            // Démarrer la lecture silencieuse
                            try { audioCtx.resume().catch(()=>{}); } catch(_) {}
                            try { video.currentTime = 0; } catch(_) {}
                            try { audioNode.start(0); } catch(_) {}
                            video.play().catch(err => { cleanup(); reject(err); });
                        })
                        .catch((e) => { cleanup(); reject(e); });
                } catch(e) {
                    cleanup();
                    reject(e);
                }
            });

            video.addEventListener('error', (e) => {
                cleanup();
                reject(new Error('Erreur lecture vidéo pour mux audio'));
            });
        } catch(e) {
            reject(e);
        }
    });
}

// mise à jour de la barre de progression
function updateProgress(){
    // Sécuriser nbOfImages pour éviter une division par 0 ou undefined
    const totalImages = Math.max(1, Number(pkg.options.record?.nbOfImages) || 1);
    let percent = Math.min(100, (imageCounter / totalImages) * 100)
    infosProgressBar.progress = percent

    // THROTTLE: Mettre à jour le toast toutes les 2 frames (plus fluide mais raisonnable)
    if (perfMetrics.capturedFrames % 2 === 0 || percent >= 100) {
        const elapsed = performance.now() - perfMetrics.startedAt;
        const avgCapture = perfMetrics.capturedFrames ? (perfMetrics.captureTimeMs / perfMetrics.capturedFrames).toFixed(1) : 0;
        const avgUpload = (perfMetrics.uploadOk + perfMetrics.uploadFail) ? (perfMetrics.uploadTimeMs / (perfMetrics.uploadOk + perfMetrics.uploadFail)).toFixed(1) : 0;
        const fps = elapsed > 0 ? (perfMetrics.capturedFrames / (elapsed / 1000)).toFixed(1) : 0;
        const msg = `${percent.toFixed(1)}% | ${currentDate ? currentDate.toLocaleDateString() : ''} | f:${imageCounter}/${totalImages} | fps:${fps} | cap:${avgCapture}ms | up:${avgUpload}ms`;
        pkg.updateProgressBar({ progress: percent, message: msg });
    }
}


async function captureElement() {
    return new Promise((resolve, reject) => {
        const element = document.getElementById('mapWithFrames');
        if (!element) {
            reject('Élément non trouvé');
            return;
        }

        const captureStart = performance.now();
        perfMetrics.lastCaptureStart = captureStart;

        // OPTIMISATION MAJEURE : Capture canvas-only (3-10x plus rapide)
        try {
            // Synchroniser le rendu OpenLayers
            map.renderSync();

            // Attendre que le rendu soit complet pour capturer tous les calques
            map.once('rendercomplete', async () => {
                try {
                    // Récupérer tous les canvas de la carte (carte + points WebGL + animations)
                    const viewport = map.getViewport();
                    const allCanvases = viewport.querySelectorAll('canvas');

                    if (allCanvases.length === 0) {
                        reject(new Error('Aucun canvas trouvé dans la carte'));
                        return;
                    }

                    // Utiliser les dimensions du viewport
                    const rect = viewport.getBoundingClientRect();
                    const canvasWidth = rect.width;
                    const canvasHeight = rect.height;

                    // Créer un canvas de sortie
                    const outCanvas = document.createElement('canvas');
                    outCanvas.width = canvasWidth;
                    outCanvas.height = canvasHeight;
                    const ctx = outCanvas.getContext('2d', { willReadFrequently: true });

                    // Composer tous les canvas (carte + points WebGL + animations)
                    allCanvases.forEach(canvas => {
                        if (canvas.width > 0 && canvas.height > 0) {
                            ctx.drawImage(canvas, 0, 0, canvasWidth, canvasHeight);
                        }
                    });

                    // Ajouter les overlays (titre, date, nombre de caches) - scaleFactor 1 car pipeline images n'utilise pas le suréchantillonnage
                    addOverlaysToCanvas(ctx, canvasWidth, canvasHeight, 1);

                    // Convertir en WebP Blob et uploader
                    outCanvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('Échec conversion canvas en blob'));
                            return;
                        }

                        // Mesurer le temps de capture
                        perfMetrics.captureTimeMs += performance.now() - perfMetrics.lastCaptureStart;
                        perfMetrics.capturedFrames += 1;
                        perfMetrics.totalFrames += 1;

                        const t0Upload = performance.now();
                        pkg.sendImageToServer(blob, imageCounter++).then(() => {
                            const t1Upload = performance.now();
                            perfMetrics.uploadTimeMs += (t1Upload - t0Upload);
                            perfMetrics.uploadOk += 1;
                            
                            // Surveillance des performances pour mode images
                            const totalCaptureTime = t1Upload - captureStart;
                            const expectedFrameTime = pkg.options?.animation?.timePerDay || 100; // Temps par jour comme référence
                            recordingPerformanceMonitor.checkPerformance(totalCaptureTime, expectedFrameTime, 'images');
                            
                            // Mise à jour du toast de progression plus fréquemment (par frame)
                            try { updateProgress(); } catch(e) {}
                            resolve();
                        }).catch((uploadError) => {
                            const t1Upload = performance.now();
                            perfMetrics.uploadTimeMs += (t1Upload - t0Upload);
                            perfMetrics.uploadFail += 1;
                            reject(uploadError);
                        });
                    }, 'image/webp', 0.9);
                } catch (error) {
                    reject(error);
                }
            });

            // Forcer un rendu complet
            map.renderSync();

        } catch (error) {
            console.warn('Canvas-only a échoué, fallback vers html2canvas:', error.message);

            // Fallback vers html2canvas avec options optimisées
            if (typeof html2canvas !== 'undefined') {
                const canvasOptions = {
                    backgroundColor: '#ffffff',
                    scale: 1,
                    useCORS: true,
                    allowTaint: false,
                    width: element.offsetWidth,
                    height: element.offsetHeight,
                    logging: false
                };

                html2canvas(element, canvasOptions)
                .then(canvas => {
                    perfMetrics.captureTimeMs += performance.now() - perfMetrics.lastCaptureStart;
                    perfMetrics.capturedFrames += 1;
                    perfMetrics.totalFrames += 1;

                    return canvas.toBlob((blob) => {
                        const t0Upload = performance.now();
                        return pkg.sendImageToServer(blob, imageCounter++).then(() => {
                            const t1Upload = performance.now();
                            perfMetrics.uploadTimeMs += (t1Upload - t0Upload);
                            perfMetrics.uploadOk += 1;
                            // Mise à jour du toast de progression (fallback)
                            try { updateProgress(); } catch(e) {}
                        });
                    }, 'image/webp', 0.9);
                })
                .then(() => resolve())
                .catch(fallbackError => {
                    console.error('html2canvas a aussi échoué:', fallbackError);
                    reject(fallbackError);
                });
            } else {
                reject(error);
            }
        }
    });
}

// Fonction pour ajouter les overlays (titre, date, nb caches) au canvas
function addOverlaysToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    try {
        const container = document.getElementById('mapWithFrames');
        if (!container) return;
        const containerRect = container.getBoundingClientRect();

        const renderStyledElement = (el, lines) => {
            // Vérifier seulement l'état DOM (maintenant synchronisé avec les paramètres utilisateur)
            if (!el || el.style.display === 'none') return;
            // Aucune ligne à dessiner => rien
            if (!lines || (Array.isArray(lines) && lines.length === 0)) return;

            const rect = el.getBoundingClientRect();
            const x = Math.round((rect.left - containerRect.left) * scaleFactor);
            const y = Math.round((rect.top - containerRect.top) * scaleFactor);
            const w = Math.round(rect.width * scaleFactor);
            const h = Math.round(rect.height * scaleFactor);
            const style = window.getComputedStyle(el);

            // Lire styles
            const bg = style.backgroundColor || 'rgba(255,255,255,1)';
            const color = style.color || '#000';
            const radius = parseFloat(style.borderRadius) || 0;
            const padL = (parseFloat(style.paddingLeft) || 0) * scaleFactor;
            const padR = (parseFloat(style.paddingRight) || 0) * scaleFactor;
            const padT = (parseFloat(style.paddingTop) || 0) * scaleFactor;
            const padB = (parseFloat(style.paddingBottom) || 0) * scaleFactor;
            // Mise à l'échelle de la police
            const fontSizePx = parseFloat(style.fontSize) || 16;
            const fontSizeScaled = (fontSizePx * scaleFactor) + 'px';
            const fontFamily = style.fontFamily || 'Arial';
            const fontWeight = style.fontWeight || 'normal';
            const font = `${fontWeight} ${fontSizeScaled} ${fontFamily}`;
            const textAlignCss = style.textAlign || 'left';

            // Box-shadow (simple parse)
            const shadow = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : null;
            let shColor = 'rgba(0,0,0,0)'; let shBlur = 0; let shOffX = 0; let shOffY = 0;
            if (shadow) {
                // ex: rgba(0, 0, 0, 0.2) 0px 0px 5px 0px
                const parts = shadow.match(/(rgba?\([^\)]+\))\s+([-0-9.]+)px\s+([-0-9.]+)px\s+([-0-9.]+)px/);
                if (parts) {
                    shColor = parts[1];
                    shOffX = parseFloat(parts[2]) * scaleFactor;
                    shOffY = parseFloat(parts[3]) * scaleFactor;
                    shBlur = parseFloat(parts[4]) * scaleFactor;
                }
            }

            // Dessin de la boîte
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            if (shadow) { ctx.shadowColor = shColor; ctx.shadowBlur = shBlur; ctx.shadowOffsetX = shOffX; ctx.shadowOffsetY = shOffY; }
            drawRoundedRect(ctx, x, y, w, h, radius, bg);
            // Texte(s)
            ctx.shadowColor = 'rgba(0,0,0,0)';
            ctx.fillStyle = color;
            ctx.font = font;
            ctx.textBaseline = 'alphabetic';
            // Alignement horizontal
            if (textAlignCss === 'center') {
                ctx.textAlign = 'center';
            } else if (textAlignCss === 'right' || textAlignCss === 'end') {
                ctx.textAlign = 'right';
            } else {
                ctx.textAlign = 'left';
            }
            const texts = Array.isArray(lines) ? lines : [String(lines)];
            const innerH = Math.max(0, h - padT - padB);
            const lineGap = Math.round(18 * scaleFactor); // px entre lignes
            let currentY = y + padT + Math.round(14 * scaleFactor); // marge supérieure + première ligne

            texts.forEach((text) => {
                if (!text) return;
                const metrics = ctx.measureText(text);
                let xText = x + padL; // left par défaut
                if (ctx.textAlign === 'center') {
                    xText = x + (w / 2);
                } else if (ctx.textAlign === 'right') {
                    xText = x + w - padR;
                }
                ctx.fillText(text, xText, currentY);
                currentY += lineGap;
            });
            ctx.restore();
        };

        // Titre: dessiner uniquement si visible et activé
        try {
            const titleEl = document.getElementById('titleFrame');
            const titleOn = !!(pkg.options?.infos?.title?.display);
            if (titleOn && titleEl && titleEl.style.display !== 'none') {
                const titleText = titleEl.textContent || '';
                renderStyledElement(titleEl, titleText);
            }
        } catch(_) {}

        // Infos: utiliser le contenu textuel de l'élément HTML pour respecter la structure originale
        try {
            const infosEl = document.getElementById('infosFrame');
            if (infosEl && infosEl.style.display !== 'none') {
                // Récupérer le contenu textuel tel qu'il est affiché à l'écran (respecte la structure HTML)
                const infosText = infosEl.textContent || infosEl.innerText || '';
                if (infosText.trim()) {
                    renderStyledElement(infosEl, infosText.trim());
                }
            }
        } catch(_) {}

    } catch (error) {
        console.warn('Erreur lors du rendu des overlays:', error);
        // Le fallback drawManualOverlay() respecte maintenant les paramètres utilisateur
    }
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
    const r = Math.max(0, Math.min(radius || 0, Math.min(width, height) / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
}

// Fonction fallback pour dessiner manuellement les overlays
function drawManualOverlay(ctx, type, infos = null) {
    let x, y, text;

    if (type === 'title') {
        // Vérifier le paramètre utilisateur pour le titre
        if (!pkg.options?.infos?.title?.display) return;
        x = 20;
        y = 20;
        text = pkg.options.infos.title.text ? pkg.options.infos.title.text : 'My Geocaching Map';
    } else if (type === 'infos') {
        // Vérifier si au moins un paramètre est activé
        const shouldDisplayDate = pkg.options?.infos?.currentDate?.display === true;
        const shouldDisplayCaches = pkg.options?.infos?.numberOfCaches?.display === true;
        if (!shouldDisplayDate && !shouldDisplayCaches) return;

        x = 20;
        y = 40;

        // Fond semi-transparent pour les overlays
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(12, 12, Math.min(300, ctx.canvas.width - 24), 60);

        // Style du texte
        ctx.fillStyle = '#000';
        ctx.font = '16px Arial';
        ctx.textBaseline = 'top';

        // Date
        if (shouldDisplayDate && currentDate) {
            const dateText = currentDate.toLocaleDateString('fr-FR');
            ctx.fillText(dateText, x, y);
            y += 20;
        }

        // Nombre de caches
        if (shouldDisplayCaches) {
            const cacheCount = infos ? infos.cacheNumber || 0 : 0;
            ctx.fillText(`${cacheCount} caches`, x, y);
        }
    }
}


function displayFeaturesForDate(date, pointOptions, flashOptions, record, infos) {

    // OPTIMISATION PERFORMANCE : Utilise l'index pré-calculé au lieu du filter coûteux
    // Avant : filter() sur tous les points à chaque frame (très lent)
    // Après : lookup instantanée dans Map pré-calculé (très rapide)

    // IMPORTANT: n'ajouter que les nouveaux points du jour pour éviter l'accumulation de doublons
    // Les points des jours précédents restent déjà visibles car ajoutés aux itérations antérieures

    // Pour l'effet flash, utiliser seulement les points de la date courante
    const dateKey = date.toDateString();
    const featuresForDate = pkg.pointsByDate.get(dateKey) || [];

    // Afficher seulement les points du jour courant
    if (featuresForDate.length > 0) {
        displayWebGLPoints(featuresForDate, pointOptions);
    }

    if (flashOptions.mode != "none") {
        // Animation de flash seulement pour les nouvelles features (date courante)
        if (record) {
            flashRecord(featuresForDate, flashOptions);
        } else {
            flashFeatures(featuresForDate, flashOptions);
        }
    }

    // affiche éventuellement les infos demandées
    displayInfosForDate(infos, date, featuresForDate);
}

// affiche les infos (date, nb de caches) en fonction des jours
function displayInfosForDate(infos, date, featuresForDate) {
    if (infos.displayDate) {
        pkg.updateCurrentDate(date);
    }
    if (infos.displayNumberofCaches) {
        const newCaches = featuresForDate.length;
        infos.cacheNumber += newCaches
        pkg.updateNbCaches(infos.cacheNumber);
    }    
}

// -------------- FLASH ---------------------------------------

function flashRecord(features) {

    features.forEach(featureData => {
        const geometry = new ol.geom.Point(
            ol.proj.transform(
                [featureData.geometry.coordinates[0], featureData.geometry.coordinates[1]],
                'EPSG:4326',
                'EPSG:3857'
            )
        );

        const animatedFeature = new ol.Feature({ geometry: geometry.clone(), type: featureData.properties.cache_type });
        animatedFeature.set('animationFrame', 0);
        animationSource.addFeature(animatedFeature);

        })
}


function updateAnimationStyles() {
    animationSource.getFeatures().forEach(feature => {
        const animationFrame = feature.get('animationFrame');
        const maxAnimationFrames = pkg.options.record.flashFrames; // Durée de l'animation pour chaque point

        if (animationFrame > maxAnimationFrames) {
            // Retirer l'entité de animationSource une fois l'animation terminée
            animationSource.removeFeature(feature);
        } else {
            // Mettre à jour le style pour l'animation
            const animationRatio = animationFrame / maxAnimationFrames;
            const radius = ol.easing.easeOut(animationRatio) * (pkg.options.flash.size / 2) + (pkg.options.flash.size / 10);
            const opacity = ol.easing.easeOut(1 - animationRatio);

            let style;
            const cacheType = feature.get('type'); // Récupérer le type de cache depuis la feature
            if (pkg.options.flash.mode == "star") {
                style = starStyle(radius, opacity, pkg.options.flash, cacheType);
            } else if (pkg.options.flash.mode == "circle") {
                style = circleStyle(radius, opacity, pkg.options.flash, cacheType);
            }
            
            feature.setStyle(style);
            feature.set('animationFrame', animationFrame + 1); // Incrémenter le compteur de frames
        }
    });

    map.render(); // Redéclenchez l'animation
}


function flashFeatures(features, flashOptions) {
    features.forEach(featureData => {
        // Assumons que featureData.geometry.coordinates contient les coordonnées en format [longitude, latitude]
        const coords = ol.proj.fromLonLat([
            featureData.geometry.coordinates[0],
            featureData.geometry.coordinates[1]
        ], 'EPSG:3857'); // Assurez-vous que la projection est correcte pour votre carte

        // Création de la géométrie de point pour la feature
        const featureGeometry = new ol.geom.Point(coords);
        const feature = new ol.Feature({
            geometry: featureGeometry,
            type: featureData.properties.cache_type // Définir le type de cache pour les couleurs GC
        });

        // Ajoutez ici la feature à une source/vector layer dédiée à l'animation si ce n'est pas déjà fait dans flash()
        flash(feature, flashOptions); // Utilisez votre fonction flash existante
    });
}


function flash(feature, flashOptions) {
    const start = Date.now();
    const flashGeom = feature.getGeometry().clone();
    const listenerKey = animationLayer.on('postrender', animate);
    const duration = flashOptions.duration; 

    function animate(event) {
        const frameState = event.frameState;
        const elapsed = frameState.time - start;
        if (elapsed >= duration) {
            ol.Observable.unByKey(listenerKey);
            return;
        }

        const elapsedRatio = elapsed / duration;
        // Définissez la taille et l'opacité de l'étoile
        const radius = ol.easing.easeOut(elapsedRatio) * (flashOptions.size / 2) + (flashOptions.size / 10); // Taille de l'élément basée sur les options utilisateur
        const opacity = ol.easing.easeOut(1 - elapsedRatio); // Opacité de l'élément 

        // Style pour l'animation de flash
        let style;
        const cacheType = feature.get('type'); // Récupérer le type de cache depuis la feature
        switch (flashOptions.mode) {
            case "star":
                style = starStyle(radius, opacity, flashOptions, cacheType);
                break;
            case "circle":
                style = circleStyle(radius, opacity, flashOptions, cacheType);
                break;
            case "square":
                style = squareStyle(radius, opacity, flashOptions, cacheType);
                break;
            case "triangle":
                style = triangleStyle(radius, opacity, flashOptions, cacheType);
                break;
            case "diamond":
                style = diamondStyle(radius, opacity, flashOptions, cacheType);
                break;
            default:
                // Style par défaut (cercle) si le mode n'est pas reconnu
                style = circleStyle(radius, opacity, flashOptions, cacheType);
                break;
        }

        // Vérifier que le style est valide avant de l'appliquer
        if (style) {
            const vectorContext = ol.render.getVectorContext(event);
            vectorContext.setStyle(style);
            vectorContext.drawGeometry(flashGeom);
            map.render();
        }
    }
}


function createFlashElements(){
    animationSource = new ol.source.Vector();
    animationLayer = new ol.layer.Vector({
    source: animationSource,
    style: null,  // nous définirons le style dans la fonction d'animation
    zIndex: 1100
});
map.addLayer(animationLayer);
}


export function starStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        console.log('⭐ GC mode - gcColor trouvé:', gcColor, 'pour type:', cacheType);
        if (gcColor) {
            const rgb = pkg.hexToRgb(gcColor);
            color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            console.log('⭐ Couleur GC finale:', color);
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
            console.log('⭐ Couleur par défaut (type non trouvé):', color);
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
        console.log('⭐ Mode transparent');
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
        console.log('⭐ Mode couleur fixe:', color, 'rgb:', flashOptions.rgb);
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 5, // 5 points pour une étoile
            radius: radius, // Rayon extérieur
            radius2: radius / 2, // Rayon intérieur (pour la forme de l'étoile)
            angle: 0, // Angle initial de l'étoile
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`, // Contour noir avec l'opacité calculée
                width: 2, // Largeur du contour
            }),
            fill: new ol.style.Fill({
                color: color, // Remplissage avec la couleur déterminée
            }),
        }),
    });
    return style;
}

export function circleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.Circle({
            radius: radius,
            stroke: new ol.style.Stroke({
                color: color,
                width: 2,
            }),
        }),
    });
    return style;
}

export function squareStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,
            radius: radius,
            angle: Math.PI / 4, // Rotation de 45° pour un carré aligné
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}

export function triangleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 3,
            radius: radius,
            angle: 0,
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}

export function diamondStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        // Utiliser la couleur GC du type de cache
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            // gcColor est déjà un nom de couleur CSS valide (green, orange, etc.)
            // On peut l'utiliser directement avec une opacité
            if (gcColor.startsWith('#')) {
                // Si c'est une valeur hexadécimale, convertir en rgba
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                // Si c'est un nom de couleur CSS, l'utiliser directement
                color = gcColor; // Les noms de couleurs CSS sont supportés par OpenLayers
            }
        } else {
            // Couleur par défaut si le type n'est pas trouvé
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        // Transparent
        color = `rgba(0, 0, 0, 0)`;
    } else {
        // Couleur fixe (par défaut)
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,
            radius: radius,
            angle: 0, // Losange pointant vers le haut
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`,
                width: 2,
            }),
            fill: new ol.style.Fill({
                color: color,
            }),
        }),
    });
    return style;
}




