// GESTION DE OPTIONVALUES DANS UN OBJET GLOBAL ????

// TODO Afficher le contenu de la Session : stats, liste des caches, matrice (v3) Chargement dynamique au chargment de l'onglet

// EN COURS -> CREATION DES DATEPICKERS. POur l'instant initialisés au démarrage avec des dates au pif. Réécrire JS pour mettre date début + fin 
// + Voir si possible d'ajouter des infos sur nbre cache par date 
// + coloration de la période ou il y a des caches ?

// TODO Ajouter les autres filtres (Pays, Region, Poseur, Attributs)
// TODO COloration selon autre critères que le type (T, D, size) (v2)
// TODO Permettre afficher images à la place des cercles (icones officielles) (V2)
// TODO Permettre d'afficher des images à la places des flash (avec icones officielles) (V2)


// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences

// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)
// TODO Watercolor, on peut ajouter labels
// TODO Vectorielle, il y a des version avec regions

// stockage des infos dans cookies au lieu localstorage ? Laissez le choix ?

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
// TEMP
let framesPerDay = 24;  
let imageCounter = 0;
// FLASH
let animationSource;
let animationLayer;

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
        displayWebGLPoints(false, optionsValues.point);
    } else {
        // TODO AJouter barre chargement
        displayAllPoints2D(features, optionsValues.point);
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

    const pointStyle = {
        'circle-radius': pointSize,
        'circle-fill-color': fillColor,
        'circle-rotate-with-view': false,
        'circle-displacement': [0, 0],
        'circle-opacity': 0.9
    }

    let pointStyleBorder = {
        'circle-radius': borderSize,
        'circle-fill-color': borderColor,
        'circle-rotate-with-view': false,
        'circle-displacement': [0, 0],
        'circle-opacity': 0.9
    }

    // Assurez-vous que vectorSource est initialisé une seule fois
    if (!window.vectorSource) {
        window.vectorSource = new ol.source.Vector({
            wrapX: true,
        });

        vectorLayerBorder = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: pointStyleBorder,
        });
        map.addLayer(vectorLayerBorder);

        vectorLayer = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: pointStyle,
        });
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

function displayWebGLPoints_old(features, pointOptions) {
    // si pas de features (on lit le geojson : plus simple pour lire tout le fichier)
    if (! features) {
    vectorSource = new ol.source.Vector({
        url: 'static/geojson_data.json',
        format: new ol.format.GeoJSON(),
        wrapX: true,
      });
    }

    // sinon on lit les features (enregistrement ou animation)
    else {
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
    //map.removeLayer(vectorLayer);
    // on enleve la couche des bordures si elle existe (webgl)
    //if (isLayerOnMap(map, vectorLayerBorder)){
    //    map.removeLayer(vectorLayerBorder);
    //}
    window.vectorSource.clear();
    if (window.borderLayer) {
        map.removeLayer(window.borderLayer);
        window.borderLayer = undefined; // Réinitialisez la référence
    }

    if (window.centerLayer) {
        map.removeLayer(window.centerLayer);
        window.centerLayer = undefined; // Réinitialisez la référence
    }
    window.vectorSource = undefined;
}


// ----------- ANIMATION DE LA CARTE  ------------
export function startAnimation() {
    window.vectorSource.clear();
    createFlashElements();

    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    let flashOptions = optionsValues.flash

    let infos = createObjectInfos(optionsValues);

    flashOptions.rgb = pkg.hexToRgb(flashOptions.color);
    const dayDuration = optionsValues.animation.timePerDay;
    //const displayDaysWithoutCache = optionsValues.animation.displayDaysWithoutCache;
    currentDate = pkg.metadata.startDate;
    interval = setInterval(() => {
        displayFeaturesForDate(currentDate, optionsValues.point, flashOptions, false, infos);
        currentDate.setDate(currentDate.getDate() + 1);
        if (currentDate > pkg.metadata.endDate) {
            clearInterval(interval);
        }
    }, dayDuration);
}

export function recordAnimation(){
    window.vectorSource.clear();
    createFlashElements();
    // creation objet pour stocker les infos liées aux Frames (dt nombre de caches)
    let infos = createObjectInfos();
    currentDate = pkg.metadata.startDate;
    // TEMPORAIRE !!!! JUSTE POUR AVOIR TRUC INTERESSANT A VOIR !!!!
    currentDate = new Date(2018, 7, 27);
    currentFrame = 0;  // Réinitialisez le compteur de frames
    captureNextFrame(true, optionsValues.point, optionsValues.flash, infos);
}


// créé un objet pour les infos pour permet de garder une consistance pour le nombre de caches
function createObjectInfos(){
    let infos = new Object();
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    infos.displayDate = optionsValues.infos.currentDate.display
    infos.displayNumberofCaches = optionsValues.infos.numberOfCaches.display
    infos.cacheNumber = 0;
    return infos
}


function captureNextFrame(capture, pointOptions, flashOptions, infos) {
    if (currentDate > pkg.metadata.endDate) {
        // Traitement de fin -> Assembler le film
        // Supprimer les images temporaires
        return;
    }

    //updateTextOverlay(`Date: ${currentDate.toDateString()}, Frame: ${currentFrame}`);
    
    if (currentFrame < framesPerDay) {
        // Mettez à jour les styles d'animation avant de capturer la frame
        updateAnimationStyles();

        // Capturez la frame actuelle
        if (capture == true) {
            captureElement().then(() => {
                currentFrame++;
                // Utilisation d'une fonction fléchée pour passer des arguments
                requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
            });
        } else {
            currentFrame++;
            // De même ici, si vous avez besoin de passer des arguments spécifiques
            requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
        }
    } else {
        // Passez au jour suivant
        currentDate.setDate(currentDate.getDate() + 1);
        displayFeaturesForDate(currentDate, pointOptions, flashOptions, true, infos);
        currentFrame = 0;  // Réinitialisez le compteur de frames pour le nouveau jour
        requestAnimationFrame(() => captureNextFrame(true, pointOptions, flashOptions, infos));
    }
}

function captureElement() {
    return new Promise((resolve, reject) => {
        const element = document.getElementById('mapWithFrames');
        if (!element) {
            // Si l'élément n'est pas trouvé, rejetez immédiatement la promesse.
            reject('Élément non trouvé'); // Assurez-vous que cette ligne est à l'intérieur de la Promesse.
            return; // Sortir de la fonction si l'élément n'est pas trouvé.
        }
        // Si l'élément est trouvé, continuez avec la conversion en PNG.
        htmlToImage.toPng(element)
        .then((dataUrl) => {
            // Traitement de l'image capturée
            pkg.sendImageToServer(dataUrl, imageCounter++);
            resolve(); // Résolution de la promesse après l'envoi de l'image.
        })
        .catch((error) => {
            console.error('Erreur lors de la capture de l’élément : ', error);
            reject(error); // Rejet de la promesse en cas d'erreur.
        });
    });
}


function displayFeaturesForDate(date, pointOptions, flashOptions, record, infos) {

    const featuresForDate = pkg.json_data.features.filter(feature => {
        const featureDate = new Date(feature.properties.date_find);
        return featureDate.toDateString() === date.toDateString();
    });

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
    console.log(infos)
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
        const maxAnimationFrames = 24; // Durée de l'animation pour chaque point

        if (animationFrame > maxAnimationFrames) {
            // Retirer l'entité de animationSource une fois l'animation terminée
            animationSource.removeFeature(feature);
        } else {
            // Mettre à jour le style pour l'animation
            const animationRatio = animationFrame / maxAnimationFrames;
            const radius = ol.easing.easeOut(animationRatio) * 25 + 5;
            const opacity = ol.easing.easeOut(1 - animationRatio);

            const style = new ol.style.Style({
                image: new ol.style.Circle({
                    radius: radius,
                    stroke: new ol.style.Stroke({
                        color: `rgba(255, 0, 0, ${opacity})`,
                        width: 2,
                    }),
                }),
            });

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

        // Style pour l'étoile
        let style;
        if (flashOptions.mode == "star") {
            style = starStyle(radius, opacity, flashOptions);}
        else if(flashOptions.mode == "circle") {
            style = circleStyle(radius, opacity, flashOptions);
        }

        const vectorContext = ol.render.getVectorContext(event);
        vectorContext.setStyle(style);
        vectorContext.drawGeometry(flashGeom);
        map.render();
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


function starStyle(radius, opacity, flashOptions){
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

function circleStyle(radius, opacity, flashOptions){
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


