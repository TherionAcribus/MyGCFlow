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

let map;  // carte de l'app
let engine;  // quel moteur graphique est utilisé
// les couches de cartographie
let OSMLayer;
let stamenWatercolorLayer;
let stamenTonerLayer;
let vectorTileLayer;
// couche de points
let vectorLayer;
// couche de bordures (webGL)
let vectorLayerBorder;
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
    if (pointOptions.border.mode != "none") {

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
    let borderSize = pointSize + parseInt(pointOptions.border.size) / 5;
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
            pointStyle = {
            'circle-radius': pointSize,
            'circle-fill-color': fillColor || '#FF0000', // Couleur rouge par défaut
            'circle-stroke-color': '#000000', // Bordure noire
            'circle-stroke-width': 2,
            'circle-rotate-with-view': false,
            'circle-displacement': [0, 0],
            'circle-opacity': 1
            }

            pointStyleBorder = {
                'circle-radius': borderSize,
                'circle-fill-color': borderColor,
                'circle-rotate-with-view': false,
                'circle-displacement': [0, 0],
                'circle-opacity': 1
            }


    } else if (pointOptions.shape == "triangle") {

        pointStyle = {
            'shape-points': 3,
            'shape-radius': pointSize,
            'shape-fill-color': fillColor,
            'shape-rotate-with-view': true,
            }

        pointStyleBorder = {
            'shape-points': 3,
            'shape-radius': borderSize,
            'shape-fill-color': borderColor,
            'shape-rotate-with-view': true,
            }
        }

    }   


    // Assurez-vous que vectorSource et les layers sont initialisés
    if (!window.vectorSource || !vectorLayer) {
        window.vectorSource = new ol.source.Vector({
            wrapX: true,
        });

        if (pointOptions.mode == "vectoriel") {
            vectorLayerBorder = new ol.layer.WebGLPoints({
                source: window.vectorSource,
                style: pointStyleBorder,
                zIndex: 1000, // Z-index élevé pour visibilité
            });
            map.addLayer(vectorLayerBorder);
        }

        vectorLayer = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: pointStyle,
            zIndex: 1001, // Z-index élevé pour visibilité
        });
        map.addLayer(vectorLayer);
    }

    // Vérifier que les layers existent toujours sur la carte (ils peuvent avoir été supprimés)
    if (pointOptions.mode == "vectoriel" && vectorLayerBorder &&
        !map.getLayers().getArray().includes(vectorLayerBorder)) {
        map.addLayer(vectorLayerBorder);
    }
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
    // Garder vectorSource mais vider son contenu
    if (window.vectorSource) {
        window.vectorSource.clear();
    }
    // Réinitialiser les références aux layers pour forcer leur recréation
    vectorLayer = undefined;
    vectorLayerBorder = undefined;

    // Supprimer les autres layers si nécessaire
    if (window.borderLayer) {
        map.removeLayer(window.borderLayer);
        window.borderLayer = undefined;
    }
    if (window.centerLayer) {
        map.removeLayer(window.centerLayer);
        window.centerLayer = undefined;
    }
}


// ----------- ANIMATION DE LA CARTE  ------------
export function startAnimation(restart=false) {
    if (!restart) {
        // Vérification que vectorSource existe avant de l'utiliser
        if (window.vectorSource) {
            window.vectorSource.clear();
        }
        createFlashElements();
        infos = createObjectInfos();
    }

    let flashOptions = pkg.options.flash

    flashOptions.rgb = pkg.hexToRgb(flashOptions.color);
    const dayDuration = pkg.options.animation.timePerDay;
    //const displayDaysWithoutCache = pkg.options.animation.displayDaysWithoutCache;
    if (!restart) {
        currentDate = new Date(pkg.metadata.startDate); // Initialisation de la date seulement si elle n'est pas déjà définie (restart)
    }
    interval = setInterval(() => {
        displayFeaturesForDate(currentDate, pkg.options.point, flashOptions, false, infos);
        currentDate.setDate(currentDate.getDate() + 1);
        if (currentDate > pkg.metadata.endDate) {
            clearInterval(interval);
        }
    }, dayDuration);
}

export function stopAnimation(){
    if (interval) {
        clearInterval(interval);
        interval = null; // Nettoyer la référence à l'intervalle
    }
    // on remets la carte comme au départ
    refreshPoints();
}

export function recordAnimation(){
    // TODO Gérer date de début et fin personnalisées !!!!!

    // Vérifier que les données sont prêtes
    if (!pkg.pointsByDate || pkg.pointsByDate.size === 0) {
        console.error("Les données de géocaches ne sont pas encore chargées");
        pkg.showToast("Données en cours de chargement. Veuillez réessayer.", "warning", "Attention");
        return;
    }

    // Remise à zéro de l'état de la carte et des informations affichées
    clearMap(); // Nettoie les points sur la carte

    // Remise à zéro de l'affichage des informations
    pkg.updateNbCaches(0); // Remet le compteur de géocaches à zéro
    pkg.updateCurrentDate(pkg.metadata.startDate); // Remet la date au début

    // ouverture modale
    pkg.openModalLoading("Capture en cours", "Les images sont en cours de capture... Ne pas bouger la fenetre !");

    // Init métriques
    perfMetrics = { totalFrames: 0, capturedFrames: 0, uploadOk: 0, uploadFail: 0, captureTimeMs: 0, uploadTimeMs: 0, startedAt: performance.now() };

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
    currentDate = pkg.metadata.startDate;
    // TEMP
    currentDate = new Date("07-01-2018")
    pkg.metadata.endDate = new Date("08-01-2018")
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

    // CREATION FILM
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

        // Traitement de fin -> Assembler le film
        // Supprimer les images temporaires
        return;
    }

    if (currentFrame < framesPerDay) {
        // Mettez à jour les styles d'animation avant de capturer la frame
        updateAnimationStyles();
        // Capturez la frame actuelle
        if (capture == true) {
            captureElement().then(() => {
                currentFrame++;
                requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
            });
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

// mise à jour de la barre de progression
function updateProgress(){
    let percent = imageCounter / pkg.options.record.nbOfImages * 100 
    infosProgressBar.progress = percent
    const elapsed = performance.now() - perfMetrics.startedAt;
    const avgCapture = perfMetrics.capturedFrames ? (perfMetrics.captureTimeMs / perfMetrics.capturedFrames).toFixed(1) : 0;
    const avgUpload = (perfMetrics.uploadOk + perfMetrics.uploadFail) ? (perfMetrics.uploadTimeMs / (perfMetrics.uploadOk + perfMetrics.uploadFail)).toFixed(1) : 0;
    const fps = elapsed > 0 ? (perfMetrics.capturedFrames / (elapsed / 1000)).toFixed(1) : 0;
    infosProgressBar.message = `${percent.toFixed(1)}% | ${currentDate.toLocaleDateString()} | f:${perfMetrics.capturedFrames}/${perfMetrics.totalFrames} | fps:${fps} | cap:${avgCapture}ms | up:${avgUpload}ms`;
    pkg.updateProgressBar(infosProgressBar)
}


function captureElement() {
    return new Promise((resolve, reject) => {
        const element = document.getElementById('mapWithFrames');
        if (!element) {
            reject('Élément non trouvé');
            return;
        }

        // Fonction utilitaire pour essayer différentes méthodes de capture
        const tryCapture = (method, options) => {
            return new Promise((resolveCapture, rejectCapture) => {
                method(element, options)
                .then(dataUrl => resolveCapture(dataUrl))
                .catch(error => rejectCapture(error));
            });
        };

        // Essayer d'abord avec html2canvas (plus fiable pour les problèmes CORS)
        if (typeof html2canvas !== 'undefined') {
            const canvasOptions = {
                backgroundColor: '#ffffff',
                scale: 1,
                useCORS: true,
                allowTaint: false,
                width: element.offsetWidth,
                height: element.offsetHeight,
                logging: false // Désactiver les logs pour éviter le spam
            };

            const t0Capture = performance.now();
            tryCapture(html2canvas, canvasOptions)
            .then(canvas => {
                const dataUrl = canvas.toDataURL('image/png', 0.95);
                const t1Capture = performance.now();
                perfMetrics.captureTimeMs += (t1Capture - t0Capture);
                perfMetrics.capturedFrames += 1;
                perfMetrics.totalFrames += 1;
                const t0Upload = performance.now();
                return pkg.sendImageToServer(dataUrl, imageCounter++).then(() => {
                    const t1Upload = performance.now();
                    perfMetrics.uploadTimeMs += (t1Upload - t0Upload);
                    perfMetrics.uploadOk += 1;
                }).catch(() => {
                    const t1Upload = performance.now();
                    perfMetrics.uploadTimeMs += (t1Upload - t0Upload);
                    perfMetrics.uploadFail += 1;
                });
            })
            .then(() => resolve())
            .catch(canvasError => {
                console.warn('html2canvas a échoué, tentative avec html-to-image:', canvasError.message);

                // Fallback vers html-to-image avec configuration simplifiée
                const htmlToImageOptions = {
                    backgroundColor: '#ffffff',
                    quality: 0.95,
                    skipFonts: true,
                    filter: (domNode) => {
                        // Exclure les éléments problématiques
                        return !(domNode.tagName === 'LINK' && domNode.rel === 'stylesheet');
                    }
                };

                const t0Capture2 = performance.now();
                tryCapture(htmlToImage.toPng, htmlToImageOptions)
                .then(dataUrl => {
                    const t1Capture2 = performance.now();
                    perfMetrics.captureTimeMs += (t1Capture2 - t0Capture2);
                    perfMetrics.capturedFrames += 1;
                    perfMetrics.totalFrames += 1;
                    const t0Upload2 = performance.now();
                    return pkg.sendImageToServer(dataUrl, imageCounter++).then(() => {
                        const t1Upload2 = performance.now();
                        perfMetrics.uploadTimeMs += (t1Upload2 - t0Upload2);
                        perfMetrics.uploadOk += 1;
                    }).catch(() => {
                        const t1Upload2 = performance.now();
                        perfMetrics.uploadTimeMs += (t1Upload2 - t0Upload2);
                        perfMetrics.uploadFail += 1;
                    });
                })
                .then(() => resolve())
                .catch(htmlToImageError => {
                    console.error('Les deux méthodes de capture ont échoué:', htmlToImageError);
                    reject(htmlToImageError);
                });
            });
        } else {
            // html2canvas non disponible, utiliser html-to-image directement
            const htmlToImageOptions = {
                backgroundColor: '#ffffff',
                quality: 0.95,
                skipFonts: true
            };

            tryCapture(htmlToImage.toPng, htmlToImageOptions)
            .then(dataUrl => {
                pkg.sendImageToServer(dataUrl, imageCounter++);
                resolve();
            })
            .catch(error => {
                console.error('Erreur lors de la capture:', error);
                reject(error);
            });
        }
    });
}


function displayFeaturesForDate(date, pointOptions, flashOptions, record, infos) {

    // OPTIMISATION PERFORMANCE : Utilise l'index pré-calculé au lieu du filter coûteux
    // Avant : filter() sur tous les points à chaque frame (très lent)
    // Après : lookup instantanée dans Map pré-calculé (très rapide)
    const dateKey = date.toDateString();
    const featuresForDate = pkg.pointsByDate.get(dateKey) || [];

    displayWebGLPoints(featuresForDate, pointOptions)

    if (flashOptions.mode != "none") {
        // Animation de flash pour toutes les features filtrées
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
            const radius = ol.easing.easeOut(animationRatio) * 25 + 5;
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
        const radius = ol.easing.easeOut(elapsedRatio) * 25 + 5; // Taille de l'élément 
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




