require("materialize-css/dist/css/materialize.css");
var $3Q6cM$materializecss = require("materialize-css");
var $3Q6cM$olMap = require("ol/Map");
var $3Q6cM$olsourceVector = require("ol/source/Vector");
var $3Q6cM$olformatGeoJSON = require("ol/format/GeoJSON");
var $3Q6cM$olView = require("ol/View");
var $3Q6cM$ollayerTile = require("ol/layer/Tile");
var $3Q6cM$olsourceOSM = require("ol/source/OSM");
var $3Q6cM$olsourceStadiaMapsjs = require("ol/source/StadiaMaps.js");
var $3Q6cM$olformatMVTjs = require("ol/format/MVT.js");
var $3Q6cM$olsourceOGCVectorTilejs = require("ol/source/OGCVectorTile.js");
var $3Q6cM$ollayerVectorTilejs = require("ol/layer/VectorTile.js");
var $3Q6cM$olproj = require("ol/proj");
require("ol/layer/WebGLPoints");
require("ol/geom/Point");
require("ol/Feature");
var $3Q6cM$ollayerVector = require("ol/layer/Vector");
var $3Q6cM$olstyle = require("ol/style");
var $3Q6cM$olstyleCircle = require("ol/style/Circle");


function $parcel$exportWildcard(dest, source) {
  Object.keys(source).forEach(function(key) {
    if (key === 'default' || key === '__esModule' || Object.prototype.hasOwnProperty.call(dest, key)) {
      return;
    }

    Object.defineProperty(dest, key, {
      enumerable: true,
      get: function get() {
        return source[key];
      }
    });
  });

  return dest;
}

function $parcel$export(e, n, v, s) {
  Object.defineProperty(e, n, {get: v, set: s, enumerable: true, configurable: true});
}

function $parcel$interopDefault(a) {
  return a && a.__esModule ? a.default : a;
}
var $6966e9eb4cb47979$exports = {};

$parcel$export($6966e9eb4cb47979$exports, "changeButtonsStamenToner", function () { return $6966e9eb4cb47979$export$19b9812988dad00b; });
$parcel$export($6966e9eb4cb47979$exports, "selectVectorMapMenu", function () { return $6966e9eb4cb47979$export$2a590b744dadc20e; });
$parcel$export($6966e9eb4cb47979$exports, "selectOSMMapMenu", function () { return $6966e9eb4cb47979$export$319f8550c043a8e1; });
$parcel$export($6966e9eb4cb47979$exports, "selectWatercolorMapMenu", function () { return $6966e9eb4cb47979$export$15cf80e15c4a163; });
$parcel$export($6966e9eb4cb47979$exports, "selectStamenTonerMapMenu", function () { return $6966e9eb4cb47979$export$ae092c3a11099722; });
$parcel$export($6966e9eb4cb47979$exports, "openModalLoading", function () { return $6966e9eb4cb47979$export$5f33e2806c1ebbf0; });
$parcel$export($6966e9eb4cb47979$exports, "closeModalLoading", function () { return $6966e9eb4cb47979$export$dd8730dfa5dca00a; });
$parcel$export($6966e9eb4cb47979$exports, "updateProgressBar", function () { return $6966e9eb4cb47979$export$55220155eeb8e52c; });

// MENU CARTES
// boutons pour le choix des cartes
const $6966e9eb4cb47979$var$btnOSM = document.getElementById("OSM");
const $6966e9eb4cb47979$var$btnWatercolor = document.getElementById("watercolor");
const $6966e9eb4cb47979$var$btnStamenToner = document.getElementById("stamenToner");
const $6966e9eb4cb47979$var$btnVectorMap = document.getElementById("vectorMap");
// sous menu pour le choix des cartes
const $6966e9eb4cb47979$var$divVectorMapOptions = document.getElementById("vectorMapOptions");
const $6966e9eb4cb47979$var$divTonerMapOptions = document.getElementById("tonerMapOptions");
const $6966e9eb4cb47979$var$btnStamenTonerLight = document.getElementById("stamenTonerLight");
const $6966e9eb4cb47979$var$btnStamenTonerDark = document.getElementById("stamenTonerDark");
// Champs pour les options de la carte vectorielle
const $6966e9eb4cb47979$var$cpStrokeColor = document.getElementById("fieldVectorMapStrokeColor");
$6966e9eb4cb47979$var$cpStrokeColor.addEventListener("change", $6966e9eb4cb47979$var$changecpStrokeColor);
const $6966e9eb4cb47979$var$cpFillColor = document.getElementById("fieldVectorMapFillColor");
$6966e9eb4cb47979$var$cpFillColor.addEventListener("change", $6966e9eb4cb47979$var$changecpfillColor);
const $6966e9eb4cb47979$var$cpBackgroundColor = document.getElementById("fieldVectorMapBackgroundColor");
$6966e9eb4cb47979$var$cpBackgroundColor.addEventListener("change", $6966e9eb4cb47979$var$changecpBackgroundColor);
const $6966e9eb4cb47979$var$strokeWidth = document.getElementById("fieldVectorMapStrokeWidth");
$6966e9eb4cb47979$var$strokeWidth.addEventListener("change", $6966e9eb4cb47979$var$changestrokeWidth);
// Champs pour les options de la carte Toner Stamen
const $6966e9eb4cb47979$var$tonerStyleElements = document.getElementsByClassName("changeTonerStyle");
Array.from($6966e9eb4cb47979$var$tonerStyleElements).forEach(function(element) {
    element.addEventListener("click", $6966e9eb4cb47979$var$changeStamenTonerStyle);
});
//  ------- CARTE VECTORIELLE -------
// changement de couleur de trait
function $6966e9eb4cb47979$var$changecpStrokeColor() {
    let optionsValues = JSON.parse(localStorage.getItem("optionsValues"));
    optionsValues.map.vectorMap.strokeColor = $6966e9eb4cb47979$var$cpStrokeColor.value;
    localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
    $aec9b03efac4a82e$export$bef305adac49ebc9(optionsValues.map.vectorMap);
}
// changement de couleur de remplissage
function $6966e9eb4cb47979$var$changecpfillColor() {
    let optionsValues = JSON.parse(localStorage.getItem("optionsValues"));
    optionsValues.map.vectorMap.fillColor = $6966e9eb4cb47979$var$cpFillColor.value;
    localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
    $aec9b03efac4a82e$export$bef305adac49ebc9(optionsValues.map.vectorMap);
}
// changement de couleur de fond
function $6966e9eb4cb47979$var$changecpBackgroundColor() {
    let optionsValues = JSON.parse(localStorage.getItem("optionsValues"));
    optionsValues.map.vectorMap.background = $6966e9eb4cb47979$var$cpBackgroundColor.value;
    localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
    $aec9b03efac4a82e$export$bef305adac49ebc9(optionsValues.map.vectorMap);
}
// changement de largeur de trait
function $6966e9eb4cb47979$var$changestrokeWidth() {
    let optionsValues = JSON.parse(localStorage.getItem("optionsValues"));
    optionsValues.map.vectorMap.strokeWidth = $6966e9eb4cb47979$var$strokeWidth.value;
    localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
    $aec9b03efac4a82e$export$bef305adac49ebc9(optionsValues.map.vectorMap);
}
// ---------------- CARTE TONER -------------------
function $6966e9eb4cb47979$var$changeStamenTonerStyle(e) {
    // comme il y a un bouton avec plusieurs layers, il faut remonter dans les éléments parent pour trouver le layer du bouton
    let targetElement = e.target;
    while(targetElement != null && !targetElement.classList.contains("changeTonerStyle"))targetElement = targetElement.parentElement;
    // Si un élément avec 'changeMap' a été trouvé, récupérer son ID
    if (targetElement) {
        let styleName = targetElement.id;
        let style;
        if (styleName == "stamenTonerDark") style = "dark";
        else if (styleName == "stamenTonerLight") style = "light";
        let optionsValues = JSON.parse(localStorage.getItem("optionsValues"));
        optionsValues.map.stamenToner.type = style;
        localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
        // change boutons
        $6966e9eb4cb47979$export$19b9812988dad00b(style);
        // rafraichit carte
        $aec9b03efac4a82e$export$65db970c3554f8c(optionsValues.map.stamenToner);
    }
}
function $6966e9eb4cb47979$export$19b9812988dad00b(style) {
    if (style == "dark") {
        $6966e9eb4cb47979$var$btnStamenTonerLight.classList.remove("disabled");
        $6966e9eb4cb47979$var$btnStamenTonerDark.classList.add("disabled");
    } else if (style == "light") {
        $6966e9eb4cb47979$var$btnStamenTonerLight.classList.add("disabled");
        $6966e9eb4cb47979$var$btnStamenTonerDark.classList.remove("disabled");
    }
}
function $6966e9eb4cb47979$export$2a590b744dadc20e() {
    // TODO quand existera : on efface tous les autres sous menu
    // on affiche le sous menu
    $6966e9eb4cb47979$var$divVectorMapOptions.style.display = "block";
    $6966e9eb4cb47979$var$divTonerMapOptions.style.display = "none";
    // on reaffiche tous les boutons
    $6966e9eb4cb47979$var$unSelectAllMapsButtons();
    // on selectionne (disables) le bouton de la carte en question
    $6966e9eb4cb47979$var$btnVectorMap.classList.add("disabled");
}
function $6966e9eb4cb47979$export$319f8550c043a8e1() {
    $6966e9eb4cb47979$var$divVectorMapOptions.style.display = "none";
    $6966e9eb4cb47979$var$divTonerMapOptions.style.display = "none";
    $6966e9eb4cb47979$var$unSelectAllMapsButtons();
    $6966e9eb4cb47979$var$btnOSM.classList.add("disabled");
}
function $6966e9eb4cb47979$export$15cf80e15c4a163() {
    $6966e9eb4cb47979$var$divVectorMapOptions.style.display = "none";
    $6966e9eb4cb47979$var$divTonerMapOptions.style.display = "none";
    $6966e9eb4cb47979$var$unSelectAllMapsButtons();
    $6966e9eb4cb47979$var$btnWatercolor.classList.add("disabled");
}
function $6966e9eb4cb47979$export$ae092c3a11099722() {
    $6966e9eb4cb47979$var$divTonerMapOptions.style.display = "block";
    $6966e9eb4cb47979$var$divVectorMapOptions.style.display = "none";
    $6966e9eb4cb47979$var$unSelectAllMapsButtons();
    $6966e9eb4cb47979$var$btnStamenToner.classList.add("disabled");
}
// permet de deselectionner tous les boutons de cartes avant de reselectionner le bon
function $6966e9eb4cb47979$var$unSelectAllMapsButtons() {
    $6966e9eb4cb47979$var$btnOSM.classList.remove("disabled");
    $6966e9eb4cb47979$var$btnWatercolor.classList.remove("disabled");
    $6966e9eb4cb47979$var$btnStamenToner.classList.remove("disabled");
    $6966e9eb4cb47979$var$btnVectorMap.classList.remove("disabled");
}
function $6966e9eb4cb47979$export$5f33e2806c1ebbf0() {
    const instance = M.Modal.getInstance(document.getElementById("modal_loading"));
    instance.open();
}
function $6966e9eb4cb47979$export$dd8730dfa5dca00a() {
    const instance = M.Modal.getInstance(document.getElementById("modal_loading"));
    instance.close();
}
function $6966e9eb4cb47979$export$55220155eeb8e52c(data) {
    // Mets à jour l'avancement de la barre de progression
    const progressBar = document.getElementById("progressBar");
    progressBar.style.width = data.progress + "%";
    const progressText = document.getElementById("progressText");
    progressText.innerText = data.message;
}


var $295ad24bca881c7d$exports = {};

$parcel$export($295ad24bca881c7d$exports, "optionsValuesCache", function () { return $295ad24bca881c7d$export$aa495f6bd8ecb9a; });
$parcel$export($295ad24bca881c7d$exports, "getDefaultValues", function () { return $295ad24bca881c7d$export$84c19026e616569e; });
// DEMARRAGE
// .\virtual\Scripts\activate    
// flask --app app.py --debug run
// npm start
// Importation de Materialize CSS et JS



let $295ad24bca881c7d$export$aa495f6bd8ecb9a = "rien";
document.addEventListener("DOMContentLoaded", function() {
    // initialisation des elements de Materialize
    $295ad24bca881c7d$var$initTabs();
    $295ad24bca881c7d$var$initModals();
    $aec9b03efac4a82e$export$d49c9aa30b771d59();
    // check la présence d'une BDD et les affiche
    $fffa426f99706db9$export$58da8b3b890bb53c();
    // recupération des options par défaut puis on initialise l'interface
    $295ad24bca881c7d$export$84c19026e616569e().then((optionsValues)=>{
        //creation des différentes cartographies
        $aec9b03efac4a82e$export$cb87fc447cb10466();
        // affiche la bonne carte
        $aec9b03efac4a82e$export$7f5bbf195a5f8a40();
        // centrer la carte
        $aec9b03efac4a82e$export$76b563df225ac0b7();
        // mets les valeurs par défaut dans les formulaire
        $295ad24bca881c7d$var$initForms(optionsValues);
    // ... autres fonctions qui dépendent de optionsValues ... 
    });
    $fffa426f99706db9$export$ac137f437ae33774();
});
// initialisation des Tabs de Materialize
function $295ad24bca881c7d$var$initTabs() {
    var elemsTabs = document.querySelectorAll(".tabs");
    (0, ($parcel$interopDefault($3Q6cM$materializecss))).Tabs.init(elemsTabs, {});
}
// initialisation des Modals de Materialize
function $295ad24bca881c7d$var$initModals() {
    var elemsModals = document.querySelectorAll(".modal");
    (0, ($parcel$interopDefault($3Q6cM$materializecss))).Modal.init(elemsModals, {});
}
function $295ad24bca881c7d$export$84c19026e616569e() {
    return $295ad24bca881c7d$var$requeteDefaultValues().then((optionsValues)=>{
        localStorage.setItem("optionsValues", JSON.stringify(optionsValues));
        return optionsValues;
    });
}
// fait la requête pour récupere les options par défaut
async function $295ad24bca881c7d$var$requeteDefaultValues() {
    try {
        const response = await fetch("http://localhost:5000/static/json/defaultValues.json");
        if (!response.ok) throw new Error("Network response was not ok " + response.statusText);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error("There has been a problem with your fetch operation:", error);
    }
}
// remplit les champs du formulaire avec les valeurs par défaut
function $295ad24bca881c7d$var$initForms(optionsValues) {
    // ------- CARTE VECTORIELLE -------
    // Champs pour les options de la carte vectorielle
    const cpStrokeColor = document.getElementById("fieldVectorMapStrokeColor");
    const cpFillColor = document.getElementById("fieldVectorMapFillColor");
    const cpBackgroundColor = document.getElementById("fieldVectorMapBackgroundColor");
    const strokeWidth = document.getElementById("fieldVectorMapStrokeWidth");
    // couleur de trait par défaut
    cpStrokeColor.value = optionsValues.map.vectorMap.strokeColor;
    // couleur de remplissage par défaut
    cpFillColor.value = optionsValues.map.vectorMap.fillColor;
    // couleur de fond par défaut
    cpBackgroundColor.value = optionsValues.map.vectorMap.background;
    // largeur de trait par défaut
    strokeWidth.value = optionsValues.map.vectorMap.strokeWidth;
    // ------- CARTE TONER -------
    // deselectionne le bouton par défaut
    $6966e9eb4cb47979$export$19b9812988dad00b(optionsValues.map.stamenToner.type);
}


var $aec9b03efac4a82e$exports = {};

$parcel$export($aec9b03efac4a82e$exports, "createMap", function () { return $aec9b03efac4a82e$export$d49c9aa30b771d59; });
$parcel$export($aec9b03efac4a82e$exports, "addMaps", function () { return $aec9b03efac4a82e$export$cb87fc447cb10466; });
$parcel$export($aec9b03efac4a82e$exports, "refreshVectorMap", function () { return $aec9b03efac4a82e$export$bef305adac49ebc9; });
$parcel$export($aec9b03efac4a82e$exports, "refreshStamenTonerMap", function () { return $aec9b03efac4a82e$export$65db970c3554f8c; });
$parcel$export($aec9b03efac4a82e$exports, "selectDefaultCarto", function () { return $aec9b03efac4a82e$export$7f5bbf195a5f8a40; });
$parcel$export($aec9b03efac4a82e$exports, "switchLayer", function () { return $aec9b03efac4a82e$export$7e55ff4ad8ce9b5a; });
$parcel$export($aec9b03efac4a82e$exports, "centerMap", function () { return $aec9b03efac4a82e$export$76b563df225ac0b7; });
$parcel$export($aec9b03efac4a82e$exports, "addVector", function () { return $aec9b03efac4a82e$export$36f5e0c666929461; });
// TODO Lors d'un refresh ou redémarrage de l'application demander si réinit ou si utilise les données du localstorage (si existe) ou utilisation cookies ?
// TODO Gestion des préférences
// CARTES
// TODO Création de différents profils pour les cartes vectorielles (V2)
// TODO Pour Stamen Toner, il est à priori possible d'avoir 3 types de layers avec ou non route / labels et possibilité choisir police labels (V2)
// Utilisation d'une localStorage pour stocker les options de la carte
// Import des modules nécessaires d'OpenLayers


















let $aec9b03efac4a82e$var$map; // carte de l'app
let $aec9b03efac4a82e$var$vectorSource = new (0, ($parcel$interopDefault($3Q6cM$olsourceVector)))(); // Source pour ajouter les points GeoJSON
// les couches de cartographie
let $aec9b03efac4a82e$var$OSMLayer;
let $aec9b03efac4a82e$var$stamenWatercolorLayer;
let $aec9b03efac4a82e$var$stamenTonerLayer;
let $aec9b03efac4a82e$var$vectorTileLayer;
function $aec9b03efac4a82e$export$d49c9aa30b771d59() {
    alert("createMap");
    $aec9b03efac4a82e$var$map = new (0, ($parcel$interopDefault($3Q6cM$olMap)))({
        target: "map",
        layers: [],
        view: new (0, ($parcel$interopDefault($3Q6cM$olView)))({
            center: [
                49,
                6
            ],
            zoom: 3
        }),
        renderer: "webgl",
        controls: []
    });
}
function $aec9b03efac4a82e$export$cb87fc447cb10466() {
    console.log("Add MAPS");
    let defaultSettings = JSON.parse(localStorage.getItem("optionsValues")).map;
    $aec9b03efac4a82e$var$OSMLayer = new (0, ($parcel$interopDefault($3Q6cM$ollayerTile)))({
        source: new (0, ($parcel$interopDefault($3Q6cM$olsourceOSM)))()
    });
    $aec9b03efac4a82e$var$map.addLayer($aec9b03efac4a82e$var$OSMLayer);
    $aec9b03efac4a82e$var$stamenWatercolorLayer = new (0, ($parcel$interopDefault($3Q6cM$ollayerTile)))({
        source: new (0, ($parcel$interopDefault($3Q6cM$olsourceStadiaMapsjs)))({
            layer: "stamen_watercolor"
        })
    });
    $aec9b03efac4a82e$var$map.addLayer($aec9b03efac4a82e$var$stamenWatercolorLayer);
    $aec9b03efac4a82e$var$stamenWatercolorLayer.setVisible(false);
    // Choix du type de Toner par défaut
    let stamenLayer;
    if (defaultSettings.stamenToner.type == "light") stamenLayer = "stamen_toner_lite";
    else if (defaultSettings.stamenToner.type == "dark") stamenLayer = "stamen_toner";
    $aec9b03efac4a82e$var$stamenTonerLayer = new (0, ($parcel$interopDefault($3Q6cM$ollayerTile)))({
        source: new (0, ($parcel$interopDefault($3Q6cM$olsourceStadiaMapsjs)))({
            layer: stamenLayer
        })
    });
    $aec9b03efac4a82e$var$map.addLayer($aec9b03efac4a82e$var$stamenTonerLayer);
    $aec9b03efac4a82e$var$stamenTonerLayer.setVisible(false);
    $aec9b03efac4a82e$var$vectorTileLayer = new (0, ($parcel$interopDefault($3Q6cM$ollayerVectorTilejs)))({
        source: new (0, ($parcel$interopDefault($3Q6cM$olsourceOGCVectorTilejs)))({
            url: "https://maps.gnosis.earth/ogcapi/collections/NaturalEarth:cultural:ne_10m_admin_0_countries/tiles/WebMercatorQuad",
            format: new (0, ($parcel$interopDefault($3Q6cM$olformatMVTjs)))()
        }),
        background: defaultSettings.vectorMap.background,
        style: {
            "stroke-width": defaultSettings.vectorMap.strokeWidth,
            "stroke-color": defaultSettings.vectorMap.strokeColor,
            "fill-color": defaultSettings.vectorMap.fillColor
        }
    });
    $aec9b03efac4a82e$var$map.addLayer($aec9b03efac4a82e$var$vectorTileLayer);
    $aec9b03efac4a82e$var$vectorTileLayer.setVisible(false);
}
function $aec9b03efac4a82e$export$bef305adac49ebc9(newValues) {
    $aec9b03efac4a82e$var$vectorTileLayer.setStyle(new (0, $3Q6cM$olstyle.Style)({
        stroke: new (0, $3Q6cM$olstyle.Stroke)({
            color: newValues.strokeColor,
            width: newValues.strokeWidth
        }),
        fill: new (0, $3Q6cM$olstyle.Fill)({
            color: newValues.fillColor
        })
    }));
    // bizarrement la variable est background avec un _
    $aec9b03efac4a82e$var$vectorTileLayer.background_ = newValues.background;
    $aec9b03efac4a82e$var$vectorTileLayer.getSource().refresh();
}
function $aec9b03efac4a82e$export$65db970c3554f8c(newValues) {
    let layerName;
    if (newValues.type == "light") layerName = "stamen_toner_lite";
    else if (newValues.type == "dark") layerName = "stamen_toner";
    $aec9b03efac4a82e$var$stamenTonerLayer.setSource(new (0, ($parcel$interopDefault($3Q6cM$olsourceStadiaMapsjs)))({
        layer: layerName
    }));
}
function $aec9b03efac4a82e$export$7f5bbf195a5f8a40() {
    let layerName = JSON.parse(localStorage.getItem("optionsValues")).map.default;
    $aec9b03efac4a82e$export$7e55ff4ad8ce9b5a(layerName);
}
function $aec9b03efac4a82e$export$76b563df225ac0b7() {
    // Coordonnées du centre de la France en longitude et latitude
    const franceCenterLonLat = [
        2.2137,
        46.2276
    ];
    // Conversion des coordonnées en EPSG:3857 pour OpenLayers
    const franceCenterWebMercator = (0, $3Q6cM$olproj.fromLonLat)(franceCenterLonLat);
    $aec9b03efac4a82e$var$map.getView().setCenter(franceCenterWebMercator);
    $aec9b03efac4a82e$var$map.getView().setZoom(6); // Ajustez le niveau de zoom selon vos besoins
}
// permet de récupérer l'id du bouton. 
// Comme il y a une image dans le bouton, il faut éventuellement regarder dans le parent selon le lieu du clic.
function $aec9b03efac4a82e$var$buttonSwitchLayer(e) {
    let targetElement = e.target;
    while(targetElement != null && !targetElement.classList.contains("changeMap"))targetElement = targetElement.parentElement;
    // Si un élément avec 'changeMap' a été trouvé, récupérer son ID
    if (targetElement) {
        let layerName = targetElement.id;
        $aec9b03efac4a82e$export$7e55ff4ad8ce9b5a(layerName);
    }
}
function $aec9b03efac4a82e$export$7e55ff4ad8ce9b5a(layerName) {
    // Masquez toutes les couches
    $aec9b03efac4a82e$var$OSMLayer.setVisible(false);
    $aec9b03efac4a82e$var$vectorTileLayer.setVisible(false);
    $aec9b03efac4a82e$var$stamenWatercolorLayer.setVisible(false);
    $aec9b03efac4a82e$var$stamenTonerLayer.setVisible(false);
    // Affichez la couche sélectionnée
    switch(layerName){
        case "OSM":
            // on rend visible la bonne carte
            $aec9b03efac4a82e$var$OSMLayer.setVisible(true);
            // on affiche le bon sous menu
            $6966e9eb4cb47979$export$319f8550c043a8e1();
            break;
        case "vectorMap":
            $aec9b03efac4a82e$var$vectorTileLayer.setVisible(true);
            $6966e9eb4cb47979$export$2a590b744dadc20e();
            break;
        case "watercolor":
            $aec9b03efac4a82e$var$stamenWatercolorLayer.setVisible(true);
            $6966e9eb4cb47979$export$15cf80e15c4a163();
            break;
        case "stamenToner":
            $aec9b03efac4a82e$var$stamenTonerLayer.setVisible(true);
            $6966e9eb4cb47979$export$ae092c3a11099722();
            break;
    }
}
// Événement pour changer la couche de fond de carte
const $aec9b03efac4a82e$var$mapChoices = document.getElementsByClassName("changeMap");
for (let mapLayer of $aec9b03efac4a82e$var$mapChoices)mapLayer.addEventListener("click", $aec9b03efac4a82e$var$buttonSwitchLayer);
function $aec9b03efac4a82e$export$36f5e0c666929461(data) {
    // Lire les entités GeoJSON
    const features = new (0, ($parcel$interopDefault($3Q6cM$olformatGeoJSON)))().readFeatures(data, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857" // Projection de la carte
    });
    // Créer une source vectorielle avec les entités
    const vectorSource = new (0, ($parcel$interopDefault($3Q6cM$olsourceVector)))({
        features: features // Ajouter les entités lues
    });
    $aec9b03efac4a82e$var$displayAllPoints2D(vectorSource);
}
function $aec9b03efac4a82e$var$displayAllPoints2D(vectorSource) {
    const vectorLayer = new (0, ($parcel$interopDefault($3Q6cM$ollayerVector)))({
        source: vectorSource,
        style: new (0, $3Q6cM$olstyle.Style)({
            image: new (0, ($parcel$interopDefault($3Q6cM$olstyleCircle)))({
                radius: 5,
                fill: new (0, $3Q6cM$olstyle.Fill)({
                    color: "red"
                }),
                stroke: new (0, $3Q6cM$olstyle.Stroke)({
                    color: "black",
                    width: 1
                })
            })
        })
    });
    $aec9b03efac4a82e$var$map.addLayer(vectorLayer);
    console.log("add");
}


var $fffa426f99706db9$exports = {};

$parcel$export($fffa426f99706db9$exports, "readBddValues", function () { return $fffa426f99706db9$export$58da8b3b890bb53c; });
$parcel$export($fffa426f99706db9$exports, "readBdd", function () { return $fffa426f99706db9$export$ac137f437ae33774; });

const $fffa426f99706db9$var$btnuploadBddForm = document.getElementById("uploadBddForm");
$fffa426f99706db9$var$btnuploadBddForm.addEventListener("submit", $fffa426f99706db9$var$uploadBddRequest);
// TODO Gestion des erreurs
// CHoix de la BDD 
// Visualisation des informations
// Résumé des informations à améliorer (nombre de points, date début et fin)
// 
// chargement d'un fichier dans la BSS
function $fffa426f99706db9$var$uploadBddRequest(e) {
    e.preventDefault();
    $6966e9eb4cb47979$export$5f33e2806c1ebbf0();
    var formData = new FormData();
    var fileInput = document.getElementById("file-input");
    formData.append("file", fileInput.files[0]);
    fetch("http://localhost:5000/upload", {
        method: "POST",
        body: formData
    }).then((response)=>response.json()).then((data)=>{
        console.log(data);
        // ferme la modale
        $6966e9eb4cb47979$export$dd8730dfa5dca00a();
        // mets à jour les infos de la BDD
        $fffa426f99706db9$export$58da8b3b890bb53c();
    }).catch((error)=>{
        console.error("Error:", error);
    });
    $fffa426f99706db9$var$checkLoadingProgress(); // Commencez à vérifier la progression
}
function $fffa426f99706db9$var$checkLoadingProgress() {
    fetch("http://localhost:5000/progressBar").then((response)=>response.json()).then((data)=>{
        $6966e9eb4cb47979$export$55220155eeb8e52c(data);
        console.log(data.progress);
        if (data.progress < 100) setTimeout($fffa426f99706db9$var$checkLoadingProgress, 100); // Corrigez le nom de la fonction ici
    }).catch((error)=>console.error("Error:", error));
}
function $fffa426f99706db9$export$58da8b3b890bb53c() {
    fetch("http://localhost:5000/db_status").then((response)=>response.json()).then((data)=>{
        console.log(data);
        $fffa426f99706db9$var$showBddInfos(data);
    }).catch((error)=>console.error("Error:", error));
}
// affiche le texte d'information sur la BDD
function $fffa426f99706db9$var$showBddInfos(data) {
    let infos = "";
    if (data.exists) infos = "La base de donn\xe9es SQL Lite est disponible.";
    else infos = "La base de donn\xe9es SQL Lite n'est pas disponible. Quelque chose s'est mal d\xe9roul\xe9 lors de l'initialisation du programme.";
    if (data.size > 0) infos += " La base de donn\xe9es fait " + data.size + " octets.";
    else infos += " La base de donn\xe9es est vide. Vous devez commencer par ajouter un nouveau fichier .gpx avec vos trouvailles. EXPLICATIONS ";
    const divInfosBDD = document.getElementById("infosBDD");
    divInfosBDD.innerHTML = infos;
}
function $fffa426f99706db9$export$ac137f437ae33774() {
    fetch("http://localhost:5000/get_geojson_points").then((response)=>response.json()).then((data)=>{
        console.log(data);
        $aec9b03efac4a82e$export$36f5e0c666929461(data);
    }).catch((error)=>console.error("Error:", error));
}


alert("!!!");
$parcel$exportWildcard(module.exports, $6966e9eb4cb47979$exports);
$parcel$exportWildcard(module.exports, $295ad24bca881c7d$exports);
$parcel$exportWildcard(module.exports, $aec9b03efac4a82e$exports);
$parcel$exportWildcard(module.exports, $fffa426f99706db9$exports);


//# sourceMappingURL=index.js.map
