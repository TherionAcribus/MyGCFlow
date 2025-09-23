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
        console.log('Couleurs GC chargées avec succès:', defaultGcColors);
    } catch (error) {
        console.error('Erreur lors du chargement des couleurs GC:', error);
        // Utiliser des couleurs par défaut en cas d'erreur
        defaultGcColors = {
            'Traditional Cache': '#FF0000',
            'Multi-cache': '#00FF00',
            'Mystery Cache': '#0000FF',
            'EarthCache': '#8B4513',
            'Letterbox Hybrid': '#FFA500',
            'Event Cache': '#800080',
            'Virtual Cache': '#FFC0CB',
            'Webcam Cache': '#A52A2A'
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
    if (pointOptions.border.mode != "none" && parseInt(pointOptions.border.size) > 0) {

        let borderSize = parseInt(pointOptions.border.size) / 5;

        let borderColor;
        if (pointOptions.border.mode == "gc") {
            borderColor = defaultGcColors[cacheType] || 'gray'; // couleur par défaut
        } else if (pointOptions.border.mode == "fix") {
            borderColor = pointOptions.border.color;
        }

        stroke = new ol.style.Stroke({color: borderColor, width: borderSize})
    } 
    
    let pointSize = parseInt(pointOptions.center.size)

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

    let pointSize = parseInt(pointOptions.center.size)
    let borderSizeValue = parseInt(pointOptions.border.size)
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
        const shape = `/static/images/icones/${pointOptions.shape}.png`
        pointStyle = {
            variables: {
            filterShape: 'all',
            },
            'icon-src': shape,
            'icon-width': pointSize *5,  // *5 pour être à peu près même taille que vectoriel
            'icon-height': pointSize *5,
            'icon-color': fillColor,
            'icon-size': [32, 32],  // taille de l'image en pixel
            'icon-scale': 1,
        };
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
function clearMap(){
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

        fetch(`${CONFIG.BASE_URL}/start_create_video`)
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

    // Démarrer animation timeline existante
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

    const viewport = map.getViewport();
    const rect = viewport.getBoundingClientRect();
    mrOutCanvas = document.createElement('canvas');
    mrOutCanvas.width = Math.max(1, Math.floor(rect.width));
    mrOutCanvas.height = Math.max(1, Math.floor(rect.height));
    mrOutCtx = mrOutCanvas.getContext('2d', { willReadFrequently: true });

    const stream = mrOutCanvas.captureStream(fps);
    mrRecordedChunks = [];
    mrRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps });
    isMediaRecording = true;

    mrRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mrRecordedChunks.push(e.data); };
    mrRecorder.onstop = () => finalizeMediaRecorderVideo();
    mrRecorder.start(Math.max(1000 / fps, 50));

    // Dessin périodique (compositing)
    let drawing = false;
    const intervalMs = Math.max(4, Math.floor(1000 / fps));
    mrDrawIntervalId = setInterval(async () => {
        if (!isMediaRecording || drawing) return;
        drawing = true;
        try {
            map.renderSync();
            const canvasList = viewport.querySelectorAll('canvas');
            const w = mrOutCanvas.width;
            const h = mrOutCanvas.height;
            mrOutCtx.clearRect(0, 0, w, h);
            canvasList.forEach(c => { if (c.width > 0 && c.height > 0) mrOutCtx.drawImage(c, 0, 0, w, h); });
            await addOverlaysToCanvas(mrOutCtx, w, h);
        } catch(e) {
            console.warn('Composite frame error:', e);
        } finally {
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
    if (mrRecorder && mrRecorder.state !== 'inactive') {
        try { mrRecorder.stop(); } catch(_) {}
    } else if (finalize) {
        finalizeMediaRecorderVideo();
    }
    isMediaRecording = false;
}

function finalizeMediaRecorderVideo(){
    try {
        const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
        const blob = new Blob(mrRecordedChunks || [], { type: mime });
        const fileName = (pkg.options?.record?.mediaRecorder?.fileName) || 'output.webm';

        const wantsDownload = !!pkg.options?.record?.mediaRecorder?.downloadLocal;
        const wantsUpload = !!pkg.options?.record?.mediaRecorder?.uploadToServer;
        const slowdown = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
        const doNormalize = !!pkg.options?.record?.mediaRecorder?.offlineNormalization && slowdown > 1;

        const afterAll = () => {
            // Réactiver boutons et fermer loader
            try { pkg.updateProgressBar({ progress: 100, message: 'Terminé' }); } catch(_) {}
            setTimeout(() => { try { pkg.closeModalLoading(); } catch(_) {} }, 400);
            pkg.showToast && pkg.showToast('Vidéo prête', 'success', 'Enregistrement');
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

        if (doNormalize) {
            try { pkg.updateTextsModal('Normalisation', `Accélération x${slowdown} pour lecture à vitesse normale...`); } catch(_) {}
            normalizeRecordedVideoSpeed(blob, slowdown).then((normBlob) => {
                proceedWith(normBlob || blob);
            }).catch((e) => {
                console.warn('Normalization failed, using original blob:', e);
                proceedWith(blob);
            });
        } else {
            proceedWith(blob);
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
                        pkg.updateProgressBar({ progress: p, message: `Normalisation ${p.toFixed(1)}%` });
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

        perfMetrics.lastCaptureStart = performance.now();

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

                    // Ajouter les overlays (titre, date, nombre de caches)
                    await addOverlaysToCanvas(ctx, canvasWidth, canvasHeight);

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
async function addOverlaysToCanvas(ctx, canvasWidth, canvasHeight) {
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
            const x = Math.round(rect.left - containerRect.left);
            const y = Math.round(rect.top - containerRect.top);
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            const style = window.getComputedStyle(el);

            // Lire styles
            const bg = style.backgroundColor || 'rgba(255,255,255,1)';
            const color = style.color || '#000';
            const radius = parseFloat(style.borderRadius) || 0;
            const padL = parseFloat(style.paddingLeft) || 0;
            const padR = parseFloat(style.paddingRight) || 0;
            const padT = parseFloat(style.paddingTop) || 0;
            const padB = parseFloat(style.paddingBottom) || 0;
            const font = style.font && style.font !== '' ? style.font : `${style.fontWeight || 'normal'} ${style.fontSize || '16px'} ${style.fontFamily || 'Arial'}`;
            const textAlignCss = style.textAlign || 'left';

            // Box-shadow (simple parse)
            const shadow = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : null;
            let shColor = 'rgba(0,0,0,0)'; let shBlur = 0; let shOffX = 0; let shOffY = 0;
            if (shadow) {
                // ex: rgba(0, 0, 0, 0.2) 0px 0px 5px 0px
                const parts = shadow.match(/(rgba?\([^\)]+\))\s+([-0-9.]+)px\s+([-0-9.]+)px\s+([-0-9.]+)px/);
                if (parts) {
                    shColor = parts[1];
                    shOffX = parseFloat(parts[2]);
                    shOffY = parseFloat(parts[3]);
                    shBlur = parseFloat(parts[4]);
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
            const lineGap = 18; // px entre lignes
            let currentY = y + padT + 14; // marge supérieure + première ligne

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

        // Infos: construire les lignes en fonction des options (date / caches)
        try {
            const infosEl = document.getElementById('infosFrame');
            if (infosEl && infosEl.style.display !== 'none') {
                const lines = [];
                const showDate = !!(pkg.options?.infos?.currentDate?.display);
                const showCaches = !!(pkg.options?.infos?.numberOfCaches?.display);
                if (showDate && typeof currentDate !== 'undefined' && currentDate) {
                    lines.push(currentDate.toLocaleDateString('fr-FR'));
                }
                if (showCaches) {
                    const cacheCount = (typeof infos !== 'undefined' && infos && typeof infos.cacheNumber !== 'undefined') ? infos.cacheNumber : 0;
                    // Garder la même convention que l'UI: nombre seul (le libellé est déjà dans l'UI si besoin)
                    lines.push(String(cacheCount));
                }
                if (lines.length > 0) {
                    renderStyledElement(infosEl, lines);
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

    // Afficher tous les points jusqu'à la date courante (caches filtrés restent visibles)
    const pointsUpToDate = getPointsUpToDate(date);
    displayWebGLPoints(pointsUpToDate, pointOptions);

    // Pour l'effet flash, utiliser seulement les points de la date courante
    const dateKey = date.toDateString();
    const featuresForDate = pkg.pointsByDate.get(dateKey) || [];

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

        const animatedFeature = new ol.Feature({ geometry: geometry.clone(), type: featureData.properties.type });
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
            if (pkg.options.flash.mode == "star") {
                style = starStyle(radius, opacity, pkg.options.flash);
            } else if (pkg.options.flash.mode == "circle") {
                style = circleStyle(radius, opacity, pkg.options.flash);
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
            // Autres propriétés si nécessaire
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
        switch (flashOptions.mode) {
            case "star":
                style = starStyle(radius, opacity, flashOptions);
                break;
            case "circle":
                style = circleStyle(radius, opacity, flashOptions);
                break;
            case "square":
                style = squareStyle(radius, opacity, flashOptions);
                break;
            case "triangle":
                style = triangleStyle(radius, opacity, flashOptions);
                break;
            case "diamond":
                style = diamondStyle(radius, opacity, flashOptions);
                break;
            default:
                // Style par défaut (cercle) si le mode n'est pas reconnu
                style = circleStyle(radius, opacity, flashOptions);
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


export function starStyle(radius, opacity, flashOptions){
    const color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 5, // 5 points pour une étoile
            radius: radius, // Rayon extérieur
            radius2: radius / 2, // Rayon intérieur (pour la forme de l'étoile)
            angle: 0, // Angle initial de l'étoile
            stroke: new ol.style.Stroke({
                color: `rgba(0, 0, 0, ${opacity})`, // Couleur jaune avec l'opacité calculée
                width: 2, // Largeur du contour
            }),
            fill: new ol.style.Fill({
                color: color, // Remplissage jaune avec l'opacité calculée
            }),
        }),
    });
    return style;
}

export function circleStyle(radius, opacity, flashOptions){
    const color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
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

export function squareStyle(radius, opacity, flashOptions){
    const color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
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

export function triangleStyle(radius, opacity, flashOptions){
    const color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
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

export function diamondStyle(radius, opacity, flashOptions){
    const color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
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




