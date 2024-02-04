// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences

// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)
// TODO Watercolor, on peut ajouter labels
// TODO Vectorielle, il y a des version avec regions

// Utilisation d'une localStorage pour stocker les options de la carte

// Import des modules nécessaires d'OpenLayers


// POINTS 
// TODO GEstion des anneaux
// WEBGL AVec style standard peut être plus rapide. A tester 
// Taille relative ou absolue

// TODO Fusionner les deux fonctions tout en bas.
// Mettre le switch dans la bonne position
// Aller lire le json s'il existe au lieu de recharger le fichier

import * as pkg from './index.js';

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

let vectorSource;


// récupère les couleurs GC par défaut dans le JSON 
// (permet d'être facilement modifiable contrairement à un dict en dur)
export async function requetedefaultGcColors(){
    try {
        const response = await fetch('http://localhost:5000/static/json/defaultGcColors.json');
        if (!response.ok) {
            throw new Error('Network response was not ok ' + response.statusText);
        }
        defaultGcColors = await response.json();
    } catch (error) {
        console.error('There has been a problem with your fetch operation:', error);
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

    let defaultSettings = JSON.parse(localStorage.getItem('optionsValues')).map;

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
    let layerName = JSON.parse(localStorage.getItem('optionsValues')).map.default;
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
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    selectEngineAndRefresh(optionsValues);   
}

// fonction appelée au changement d'options graphique
export function refreshPoints(optionValues){
    clearMap();
    selectEngineAndRefresh(optionValues);
}


// recherche une couche en particulier sur la carte
function isLayerOnMap(map, layerToFind) {
    const layers = map.getLayers().getArray();
    return layers.includes(layerToFind);
}


// Envoie l'affichage des points de features dans le bon vecteur
function selectEngineAndRefresh(optionsValues){
    engine = optionsValues.options.engine;
    if (engine == "webgl"){
        displayWebGLPoints(features, optionsValues.point);
    } else {
        // TODO AJouter barre chargement
        displayAllPoints2D(features, optionsValues.point);

    }
}

// affichage des points 2D
function displayAllPoints2D(features, pointOptions){
    // Créer une source vectorielle avec les entités
    const vectorSource = new ol.source.Vector({
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
    //const vectorSource = new ol.source.Vector({
    //    url: 'static/geojson_data.json',
    //    format: new ol.format.GeoJSON(),
    //    wrapX: true,
    //  });

    const geojsonObject = {
        'type': 'FeatureCollection',
        'features': features
    };
    vectorSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(geojsonObject, {
            // Option pour définir le système de coordonnées des features GeoJSON
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857'
        }),
        wrapX: true,
    });

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

    let pointSize = parseInt(pointOptions.center.size)
    let borderSize = pointSize + parseInt(pointOptions.border.size) / 5

    const pointStyle = {
        'circle-radius': pointSize,
        'circle-fill-color': fillColor,
        'circle-rotate-with-view': false,
        'circle-displacement': [0, 0],
        'circle-opacity': 0.9
    }

    vectorLayer = new ol.layer.WebGLPoints({
        source: vectorSource,
        style: pointStyle
    });

    // si on a demandé une couche de bordure
    if (pointOptions.border.mode != "none"){

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

        // TODO CHoisir les réglages pour la taille des bordures
        let pointStyleBorder = {
            'circle-radius': borderSize,
            'circle-fill-color': borderColor,
            'circle-rotate-with-view': false,
            'circle-displacement': [0, 0],
            'circle-opacity': 0.9
        }

        vectorLayerBorder = new ol.layer.WebGLPoints({
            source: vectorSource,
            style: pointStyleBorder,
            index: 1000
        });

        map.addLayer(vectorLayerBorder);
    }

    // on ajoute la couche des cercles intérieurs à la fin
    map.addLayer(vectorLayer);
}

// supprime les points de la carte (centre et bordures si existantes)
function clearMap(){
    // on enleve la couche vectorielle avec les points
    map.removeLayer(vectorLayer);
    // on enleve la couche des bordures si elle existe (webgl)
    if (isLayerOnMap(map, vectorLayerBorder)){
        map.removeLayer(vectorLayerBorder);
    }
}


// ----------- ANIMATION DE LA CARTE  ------------
export function startAnimation(record=false) {
    const dayDuration = 200;
    clearMap();
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    currentDate = pkg.metadata.startDate;
    interval = setInterval(() => {
        displayFeaturesForDate(currentDate, optionsValues);
        currentDate.setDate(currentDate.getDate() + 1);
        if (currentDate > pkg.metadata.endDate) {
            clearInterval(interval);
        }
    }, dayDuration);
}


export function recordAnimation(){
    vectorSource.clear(); // Videz la source vectorielle avant de démarrer l'animation
    getDateFormat();  // récupère le format de date
    getSparkleShape();
    currentDate = metadata.startDate;
    // TEMPORAIRE !!!! JUSTE POUR AVOIR TRUC INTERESSANT A VOIR !!!!
    currentDate = new Date(2018, 7, 27);
    currentFrame = 0;  // Réinitialisez le compteur de frames
    captureNextFrame(capture=true);
}


function displayFeaturesForDate(date, optionsValues) {
    //console.log("currentDate", currentDate)

    const featuresForDate = pkg.json_data.features.filter(feature => {
        const featureDate = new Date(feature.properties.date_find);
        return featureDate.toDateString() === date.toDateString();
    });

    console.log("featuresForDate", featuresForDate)
    featuresForDate.forEach(featureData => {
        displayWebGLPoints(featuresForDate, optionsValues.point)
    });
}