// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences

// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)
// TODO Watercolor, on peut ajouter labels
// TODO Vectorielle, il y a des version avec regions

// Utilisation d'une localStorage pour stocker les options de la carte

// Import des modules nécessaires d'OpenLayers


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
let features;


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
    engine = optionsValues.options.engine;
    selectEngineAndRefresh(engine);   
}

// fonction appelée au changement d'options graphique
export function refreshPoints(engine){
    map.removeLayer(vectorLayer);
    selectEngineAndRefresh(engine);
}

// Envoie l'affichage des points de features dans le bon vecteur
function selectEngineAndRefresh(engine){
    if (engine == "webgl"){
        displayWebGLPoints(features);
    } else {
        displayAllPoints2D(features);
    }
}

// affichage des points 2D
function displayAllPoints2D(features){
    // Créer une source vectorielle avec les entités
    const vectorSource = new ol.source.Vector({
        features: features // Ajouter les entités lues
    });

    vectorLayer = new ol.layer.Vector({
        source: vectorSource,
        style: new ol.style.Style({
            image: new ol.style.Circle({
                radius: 5,
                fill: new ol.style.Fill({color: 'red'}),
                stroke: new ol.style.Stroke({color: 'black', width: 1})
            })
        })
    });
    
    map.addLayer(vectorLayer);
}

// affichage des points WebGL
function displayWebGLPoints(features){
    let vectorSourceGL = new ol.source.Vector();

    // Création de la couche vectorielle en utilisant la source vectorielle
    vectorLayer = new ol.layer.Vector({
        source: vectorSourceGL
    });    
    // Ajout de la couche vectorielle à la carte
    map.addLayer(vectorLayer);

    vectorSourceGL.addFeatures(features);
}





