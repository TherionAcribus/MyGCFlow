// Fonds de carte : instance ol.Map, couches de fond (OSM, Stamen Watercolor,
// Stamen Toner, carte vectorielle), bascule entre fonds, centrage/zoom par
// défaut et suivi des erreurs de chargement de tuiles.
//
// Extrait de mapgl.js, qui reste responsable des points, popups, animation,
// enregistrement vidéo et audio de fond.
//
// Import croisé avec mapgl.js (celui-ci importe `olMap` et les helpers de tuiles
// d'ici, on lui emprunte initPopupOverlay/isRecordingActive) : sans danger, les
// deux côtés n'échangent que des déclarations de fonctions (hissées) et une
// liaison `let` lue uniquement à l'exécution, jamais pendant l'évaluation des
// modules.
import * as pkg from './index.js';
import { CONFIG } from './init.js';
import { initPopupOverlay, isRecordingActive } from './mapgl.js';

// Carte de l'app. Exportée en `let` et non seulement via getMap() : mapgl.js
// l'importe sous le nom `map` (import { olMap as map }) et profite de la liaison
// vivante d'ES modules, donc il voit l'affectation faite ici par createMap()
// sans avoir à appeler un accesseur à chaque usage.
export let olMap;

export function getMap() {
    return olMap;
}

// les couches de cartographie
let OSMLayer;
let stamenWatercolorLayer;
let stamenTonerLayer;
let vectorTileLayer;
// Registre des fonds de carte : { id: { layer, optionsPanelId } }. Peuplé dans
// addMaps(). switchLayer() n'a plus besoin d'un branchement manuel par fond :
// ajouter un fond de carte se fait en ajoutant une entrée ici (+ le bouton
// correspondant dans menu_style.html), sans toucher switchLayer().
const basemaps = {};

function registerBasemap(id, layer, optionsPanelId = null) {
    basemaps[id] = { layer, optionsPanelId };
    pkg.registerMapMenu(id, optionsPanelId);
}


// --- Suivi des erreurs de chargement de tuiles ---
// Signale les échecs réseau/CDN plutôt que de laisser des zones de carte
// silencieusement vides. Particulièrement utile pendant un enregistrement vidéo,
// où une tuile manquante produit un artefact qu'on ne remarque qu'à la relecture :
// on n'interrompt pas la capture avec un toast, mais le compte est intégré au
// message de fin d'enregistrement (cf. recordAnimation / stopMediaRecorderPipeline).
let tileErrorCount = 0;
let lastTileErrorToastAt = 0;
const TILE_ERROR_TOAST_THROTTLE_MS = 15000;

function handleTileLoadError() {
    tileErrorCount++;
    if (isRecordingActive()) return;

    const now = performance.now();
    if (now - lastTileErrorToastAt < TILE_ERROR_TOAST_THROTTLE_MS) return;
    lastTileErrorToastAt = now;
    try {
        const msg = pkg.t
            ? pkg.t('Certaines tuiles de la carte n\'ont pas pu être chargées (connexion instable ?).')
            : 'Certaines tuiles de la carte n\'ont pas pu être chargées (connexion instable ?).';
        pkg.showToast && pkg.showToast(msg, 'warning', pkg.t ? pkg.t('Carte') : 'Carte', 6000);
    } catch(_) {}
}

// À appeler sur chaque source de tuiles (OSM, Stadia...). Ne rien faire pour les
// sources qui n'émettent pas cet évènement (ex. ol.source.Vector).
function watchTileErrors(source) {
    if (source && typeof source.on === 'function') {
        source.on('tileloaderror', handleTileLoadError);
    }
}

export function getTileErrorCount() {
    return tileErrorCount;
}

// Repart d'un compte propre au début d'une session d'enregistrement.
export function resetTileErrorCount() {
    tileErrorCount = 0;
}

// À appeler en fin d'enregistrement (mode images et mode MediaRecorder) : signale
// après coup les tuiles manquantes accumulées pendant la capture, puisqu'aucun
// toast n'a été affiché à chaud pour ne pas perturber l'enregistrement.
export function warnIfTileErrors() {
    if (tileErrorCount > 0) {
        const count = tileErrorCount;
        try {
            const msg = pkg.t
                ? pkg.t("${count} tuile(s) de carte n'ont pas pu être chargées pendant l'enregistrement : la vidéo peut comporter des zones vides.", { count })
                : `${count} tuile(s) de carte n'ont pas pu être chargées pendant l'enregistrement : la vidéo peut comporter des zones vides.`;
            pkg.showToast && pkg.showToast(msg, 'warning', pkg.t ? pkg.t('Carte') : 'Carte', 8000);
        } catch(_) {}
    }
    tileErrorCount = 0;
}


// Initialisation de la carte
// Convention unique pour tous les centres persistés et échangés par l'app :
// [longitude, latitude], identique à GeoJSON et à ol.proj.fromLonLat().
// Le centre et le zoom par défaut sont déclarés dans defaultValues.json
// (map.default_center / map.default_zoom), comme le reste des valeurs par
// défaut. Les constantes ci-dessous ne sont qu'un dernier repli : fichier
// injoignable ou illisible (cf. le repli de requeteDefaultValues() dans
// init.js), clés absentes, ou module utilisé avant options.init().
const FALLBACK_MAP_CENTER_LON_LAT = Object.freeze([2.2137, 46.2276]);
const FALLBACK_MAP_ZOOM = 6;

// Valide un couple [longitude, latitude] et le normalise en nombres.
// Retourne null si la valeur est inexploitable (mauvaise forme, non numérique
// ou hors des bornes géographiques).
export function parseLonLat(value){
    if (!Array.isArray(value) || value.length !== 2) return null;
    const lon = parseFloat(value[0]);
    const lat = parseFloat(value[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return [lon, lat];
}

// Centre/zoom par défaut de l'application. Fonctions et non constantes : les
// options ne sont chargées qu'au démarrage (options.init()), donc bien après
// l'évaluation de ce module.
export function getDefaultMapCenter(){
    return parseLonLat(pkg.options?.map?.default_center) || [...FALLBACK_MAP_CENTER_LON_LAT];
}

export function getDefaultMapZoom(){
    const zoom = parseFloat(pkg.options?.map?.default_zoom);
    return Number.isFinite(zoom) ? zoom : FALLBACK_MAP_ZOOM;
}

export function createMap(){
    olMap = new ol.Map({
        target: 'map',
        layers: [],
        view: new ol.View({
            // Point de repli avant que centerMap() ne recadre selon les préférences
            // utilisateur ; doit être en EPSG:3857 (la vue), pas en lon/lat brut.
            center: ol.proj.fromLonLat(getDefaultMapCenter()),
            zoom: getDefaultMapZoom(),
            // Au-delà de 19, les fonds de carte (Watercolor en particulier) n'ont
            // plus de tuiles et affichent un agrandissement flou du dernier niveau.
            maxZoom: 19
        }),
        // Attribution non-repliable : les CGU d'OpenStreetMap et de Stadia Maps
        // (Toner/Watercolor) imposent une attribution visible, y compris dans les
        // vidéos exportées par l'app.
        controls: [new ol.control.Attribution({ collapsible: false })]
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
    olMap.addLayer(OSMLayer);
    watchTileErrors(OSMLayer.getSource());
    registerBasemap('OSM', OSMLayer);

    stamenWatercolorLayer = new ol.layer.Tile({
        source: new ol.source.StadiaMaps({layer: 'stamen_watercolor'})
    });
    olMap.addLayer(stamenWatercolorLayer);
    stamenWatercolorLayer.setVisible(false);
    watchTileErrors(stamenWatercolorLayer.getSource());
    registerBasemap('watercolor', stamenWatercolorLayer);

    // Layer créé avec une source provisoire ; refreshStamenTonerMap() ci-dessous
    // pose la vraie source selon le type par défaut (light/dark), pour n'avoir
    // qu'une seule table de correspondance type -> nom de layer Stadia.
    stamenTonerLayer = new ol.layer.Tile({
        source: new ol.source.StadiaMaps({layer: "stamen_toner_lite"})
    });
    olMap.addLayer(stamenTonerLayer);
    stamenTonerLayer.setVisible(false);
    stamenTonerLayerName = null; // source provisoire : toujours remplacée ci-dessous
    refreshStamenTonerMap(defaultSettings.stamenToner);
    registerBasemap('stamenToner', stamenTonerLayer, 'tonerMapOptions');

    // Frontières mondiales servies en local (fichier statique, cf. static/json/) au
    // lieu du serveur de démonstration OpenLayers (ahocevar.com) : ce dernier n'offre
    // aucune garantie de disponibilité et faisait dépendre ce fond de carte d'un
    // tiers hors de notre contrôle. Résolution 1:50m (world-atlas / Natural Earth) :
    // largement suffisante pour un aplat de couleur uni par pays, pas une carte
    // politique détaillée.
    vectorTileLayer = new ol.layer.Vector({
        background: defaultSettings.vectorMap.background,
        source: new ol.source.Vector({
            url: `${CONFIG.BASE_URL}/static/json/world-countries-50m.topo.json`,
            format: new ol.format.TopoJSON({ layers: ['countries'] }),
        }),
        style: buildVectorMapStyle(defaultSettings.vectorMap)
    });

    olMap.addLayer(vectorTileLayer);
    vectorTileLayer.setVisible(false);
    registerBasemap('vectorMap', vectorTileLayer, 'vectorMapOptions');
}

// Construit le style de la carte vectorielle.
// Largeur de contour <= 0 = « pas de contour ». On ne peut pas simplement omettre
// le Stroke : les polygones VectorTile remplis laissent alors apparaître un fin
// liseré (anti-aliasing sur les bords de tuiles et entre pays adjacents). On trace
// donc un contour de la MÊME couleur que le remplissage : invisible en tant que
// bordure, mais il recouvre ces coutures pour un aplat uniforme.
function buildVectorMapStyle(values){
    const w = parseFloat(values.strokeWidth);
    const strokeWidth = Number.isFinite(w) ? w : 0;
    const hasContour = strokeWidth > 0;
    return new ol.style.Style({
        fill: new ol.style.Fill({ color: values.fillColor }),
        stroke: new ol.style.Stroke({
            color: hasContour ? values.strokeColor : values.fillColor,
            width: hasContour ? strokeWidth : 1
        })
    });
}

// rafraîchit la carte VectorMap quand on change ses proprietés
export function refreshVectorMap(newValues){
    // setStyle()/setBackground() redéclenchent seuls le rendu : la géométrie des
    // pays ne change pas, inutile de refaire une requête sur le fichier local.
    vectorTileLayer.setStyle(buildVectorMapStyle(newValues));
    vectorTileLayer.setBackground(newValues.background);
}


// Nom de layer Stadia actuellement posé sur stamenTonerLayer, pour éviter de
// recréer une source identique. Reste null tant que refreshStamenTonerMap()
// n'a pas remplacé la source provisoire créée par addMaps().
let stamenTonerLayerName = null;

// rafraichit la carte StamenToner quand on change ses proprietés
export function refreshStamenTonerMap(newValues){
    let layerName;
    if (newValues && newValues.type == "dark") {
        layerName = 'stamen_toner';
    } else if (newValues && newValues.type == "light") {
        layerName = 'stamen_toner_lite';
    } else {
        // Variante inconnue (profil corrompu, valeur obsolète...) : replier sur
        // le clair, comme switchLayer() replie sur OSM. Sans ce repli, layerName
        // restait undefined et la source Stadia produite était invalide (aucune
        // tuile, aucun message). On normalise aussi l'option elle-même : c'est
        // pkg.options.map.stamenToner qui nous est passé, donc la source de
        // vérité cesse de porter la valeur invalide (boutons du menu compris).
        console.warn(`refreshStamenTonerMap: variante Toner inconnue "${newValues && newValues.type}", repli sur light`);
        layerName = 'stamen_toner_lite';
        if (newValues) newValues.type = 'light';
    }

    // Une source Stadia identique n'apporterait rien et jetterait le cache de
    // tuiles déjà chargées (rechargement complet à chaque appel, alors que
    // refreshStamenTonerMap() est aussi appelée à l'application d'un profil).
    if (layerName === stamenTonerLayerName) return;

    const newSource = new ol.source.StadiaMaps({layer: layerName});
    watchTileErrors(newSource); // setSource() ci-dessous perd les écouteurs de l'ancienne source
    stamenTonerLayer.setSource(newSource);
    stamenTonerLayerName = layerName;
}


// permet de faire le lien avec la fonction qui selectionne la bonne carte au lancement de l'application
export function selectDefaultCarto(){
    let layerName = pkg.options.map.default;
    switchLayer(layerName);
}

// Unique point d'écriture du centre/zoom dans la vue. Tous les centres reçus sont
// au format [longitude, latitude]. Les préférences utilisateur peuvent remplacer
// les valeurs fournies ; un profil passe preferUserSettings=false pour appliquer
// explicitement sa propre vue. Centre et zoom restent indépendants.
// Retourne true si au moins une valeur a été appliquée à la vue.
export function applyMapDefaults(fallbackLonLat, fallbackZoom, preferUserSettings = true){
    let lonLat = null;
    let zoom = null;

    try {
        const s = preferUserSettings ? window.userSettings : null;
        if (s) lonLat = parseLonLat(s.map_default_center);
        if (s && (typeof s.map_default_zoom === 'number' || typeof s.map_default_zoom === 'string')) {
            const z = parseInt(s.map_default_zoom);
            if (Number.isFinite(z)) {
                zoom = z;
            }
        }
    } catch(e) {
        console.warn('applyMapDefaults error:', e);
    }

    if (lonLat == null) lonLat = parseLonLat(fallbackLonLat);
    const parsedFallbackZoom = parseFloat(fallbackZoom);
    if (zoom == null && Number.isFinite(parsedFallbackZoom)) zoom = parsedFallbackZoom;

    const view = olMap.getView();
    let applied = false;
    if (lonLat) {
        view.setCenter(ol.proj.fromLonLat(lonLat));
        applied = true;
    }
    if (Number.isFinite(zoom)) {
        view.setZoom(zoom);
        applied = true;
    }
    return applied;
}

// centrer la carte (repli sur le centre par défaut de defaultValues.json si
// aucune préférence utilisateur)
export function centerMap(){
    applyMapDefaults(getDefaultMapCenter(), getDefaultMapZoom());
}


// permet de switcher sur la bonne cartographie en fonction du choix fait
export function switchLayer(layerName) {
    const basemapsReady = Object.keys(basemaps).length > 0;

    if (basemapsReady && !basemaps[layerName]) {
        // Nom de couche inconnu (profil corrompu, valeur obsolète en
        // localStorage...) : replier sur OSM plutôt que de laisser la carte
        // entièrement vide sans aucun message.
        console.warn(`switchLayer: nom de couche inconnu "${layerName}", repli sur OSM`);
        layerName = 'OSM';
    }

    // pkg.options.map.default est LA source de vérité du fond actif : c'est ici
    // qu'elle est écrite, et nulle part ailleurs. Les lecteurs (profils,
    // selectDefaultCarto()) n'ont donc jamais à déduire l'état de la carte des
    // classes CSS des boutons ou de la visibilité des panneaux d'options — une
    // heuristique qui pouvait se tromper tant qu'une transition CSS n'était pas
    // terminée. L'écriture a lieu avant le rendu pour que l'état reste correct
    // même si les couches ne sont pas encore créées.
    if (pkg.options && pkg.options.map) pkg.options.map.default = layerName;

    if (!basemapsReady) {
        // addMaps() pas encore appelé : l'option écrite ci-dessus suffit, c'est
        // elle que liront addMaps() puis selectDefaultCarto() au démarrage.
        console.warn('switchLayer: fonds de carte pas encore créés, affichage différé au démarrage de la carte');
        return;
    }

    for (const id in basemaps) {
        basemaps[id].layer.setVisible(id === layerName);
    }
    pkg.selectMapMenu(layerName);
}

// Délègue les clics depuis le conteneur : les boutons peuvent être rendus ou
// remplacés après le chargement du module sans devoir rattacher des écouteurs.
function initMapMenuDelegation() {
    const container = document.getElementById('tabMapOverlay');
    if (!container) return;

    container.addEventListener('click', event => {
        const mapChoice = event.target.closest?.('.changeMap');
        if (mapChoice && container.contains(mapChoice)) {
            switchLayer(mapChoice.id);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMapMenuDelegation, { once: true });
} else {
    initMapMenuDelegation();
}
