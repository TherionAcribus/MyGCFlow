// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences

// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)

// Utilisation d'une localStorage pour stocker les options de la carte

// Import des modules nécessaires d'OpenLayers
import Map from 'ol/Map';
import VectorSource from 'ol/source/Vector';
import Vector from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import StadiaMaps from 'ol/source/StadiaMaps.js';
import MVT from 'ol/format/MVT.js';
import OGCVectorTile from 'ol/source/OGCVectorTile.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import { fromLonLat } from 'ol/proj';
import WebGLPointsLayer from 'ol/layer/WebGLPoints';
import Point from 'ol/geom/Point';
import Feature from 'ol/Feature';
import VectorLayer from 'ol/layer/Vector';
import { Fill, Stroke, Style } from 'ol/style';
import CircleStyle from 'ol/style/Circle';


import * as pkg from './index';

let map;  // carte de l'app
let vectorSource = new VectorSource();  // Source pour ajouter les points GeoJSON
// les couches de cartographie
let OSMLayer;
let stamenWatercolorLayer;
let stamenTonerLayer;
let vectorTileLayer;


// Initialisation de la carte
export function createMap(){
    alert("createMap")
    map = new Map({
        target: 'map',
        layers: [],
        view: new View({
            center: [49, 6],
            zoom: 3
        }),
        renderer: "webgl",
        controls: [] 
    });
}


// ajoute les différents layers de cartes à la map et affiche la bonne
export function addMaps(){
    console.log("Add MAPS")

    let defaultSettings = JSON.parse(localStorage.getItem('optionsValues')).map;

    OSMLayer = new TileLayer({
        source: new OSM()
    });
    map.addLayer(OSMLayer);

    stamenWatercolorLayer = new TileLayer({
        source: new StadiaMaps({layer: 'stamen_watercolor'})
    });
    map.addLayer(stamenWatercolorLayer);
    stamenWatercolorLayer.setVisible(false);

    // Choix du type de Toner par défaut
    let stamenLayer;
    if (defaultSettings.stamenToner.type == "light") {
        stamenLayer = 'stamen_toner_lite'
    } else if (defaultSettings.stamenToner.type == "dark") {
        stamenLayer = 'stamen_toner'
    }

    stamenTonerLayer = new TileLayer({
        source: new StadiaMaps({layer: stamenLayer})
    });
    map.addLayer(stamenTonerLayer);
    stamenTonerLayer.setVisible(false);

    vectorTileLayer = new VectorTileLayer({
        source: new OGCVectorTile({
            url: 'https://maps.gnosis.earth/ogcapi/collections/NaturalEarth:cultural:ne_10m_admin_0_countries/tiles/WebMercatorQuad',
            format: new MVT(),
        }),
        background: defaultSettings.vectorMap.background,
        style: {
            'stroke-width': defaultSettings.vectorMap.strokeWidth,
            'stroke-color': defaultSettings.vectorMap.strokeColor,
            'fill-color': defaultSettings.vectorMap.fillColor,
        },
    });
    map.addLayer(vectorTileLayer);
    vectorTileLayer.setVisible(false);    
}

// rafraîchit la carte VectorMap quand on change ses proprietés
export function refreshVectorMap(newValues){
    vectorTileLayer.setStyle(new Style({
        stroke: new Stroke({
            color: newValues.strokeColor,
            width: newValues.strokeWidth
        }),
        fill: new Fill({
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
    stamenTonerLayer.setSource(new StadiaMaps({layer: layerName}));
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
    const franceCenterWebMercator = fromLonLat(franceCenterLonLat);
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
    const features = new GeoJSON().readFeatures(data, {
        dataProjection: 'EPSG:4326',  // Projection des données GeoJSON
        featureProjection: 'EPSG:3857' // Projection de la carte
    });

    // Créer une source vectorielle avec les entités
    const vectorSource = new Vector({
        features: features // Ajouter les entités lues
    });

    displayAllPoints2D(vectorSource);
}


function displayAllPoints2D(vectorSource){
    const vectorLayer = new VectorLayer({
        source: vectorSource,
        style: new Style({
            image: new CircleStyle({
                radius: 5,
                fill: new Fill({color: 'red'}),
                stroke: new Stroke({color: 'black', width: 1})
            })
        })
    });
    
    map.addLayer(vectorLayer);
    console.log("add")
}


