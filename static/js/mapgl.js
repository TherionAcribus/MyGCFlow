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
import fixWebmDuration from './fix-webm-duration.js';

// Debug toasts/assemblage
const TOAST_DEBUG = false;
function logToast(...args) { if (TOAST_DEBUG) { try { console.log('[TOAST]', ...args); } catch(e) {} } }

// Flag de debug général pour le reste de ce fichier. Mettre à true pour
// réactiver les logs en console. Désactivé par défaut : certains de ces logs
// sérialisent des compteurs/objets à chaque frame (boucle d'animation,
// displayWebGLPoints), ce qui a un coût mesurable pendant une animation.
const DEBUG_MAPGL = false;
const dbgMapgl = (...args) => { if (DEBUG_MAPGL) console.log(...args); };

// html2canvas n'est utilisé que comme repli rare quand la capture "canvas-only"
// échoue pendant l'enregistrement image par image (cf. scheduleCaptureFrame) : le
// charger sur chaque page serait du poids mort pour l'immense majorité des sessions
// qui n'en ont jamais besoin. On l'injecte donc à la demande, en tâche de fond, dès
// le début d'un enregistrement (le temps de téléchargement se recouvre alors avec le
// début de la capture plutôt que de bloquer la première frame qui en aurait besoin).
let html2canvasLoadPromise = null;
function loadHtml2Canvas() {
    if (typeof html2canvas !== 'undefined') return Promise.resolve();
    if (html2canvasLoadPromise) return html2canvasLoadPromise;
    html2canvasLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        script.onload = () => resolve();
        script.onerror = () => {
            // Échec de chargement : on remet à null pour permettre un nouvel essai
            // lors d'un prochain enregistrement, plutôt que de rester bloqué en échec.
            html2canvasLoadPromise = null;
            reject(new Error('Impossible de charger html2canvas'));
        };
        document.head.appendChild(script);
    });
    return html2canvasLoadPromise;
}

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
// Tableau à plat des couleurs GC précalculé pour les expressions WebGL 'match'
// Évite de recalculer Object.entries().flat() à chaque appel de displayWebGLPoints
let gcColorsFlat = [];
// Popup d'information (overlay)
let popupOverlay;
let popupEl;
// ANIMATION
// date en cours pour l'animation
let currentDate;
// ENREGISTREMENT
// Cache des overlays (titre, infos) : calculé une seule fois au démarrage de chaque session
// pour éviter getElementById / getBoundingClientRect / getComputedStyle à chaque frame
let overlayCache = null;
// Compteur de frames pour le jour en cours
let currentFrame = 0;
let globalRecordFrame = 0;  // avance d'1 par capture (pas par rendu)
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
        // Pas pertinent pour le mode images/MoviePy (juste plus long, pas un problème perf interactif)
        if (recordingMode === 'images') return;
        if (!this.isMonitoring) return;
        
        this.frameTimings.push(frameTime);
        
        const PERFORMANCE_CHECK_INTERVAL = 30;
        const FRAME_TIME_THRESHOLD = expectedFrameTime * 2.5; // 2.5x le temps attendu
        const BAD_FRAMES_THRESHOLD = 0.3; // 30% de frames lentes = problème
        
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
                    const message = pkg.t(
                        "Performance d'enregistrement instable (${pct}% de frames lentes). Souhaitez-vous augmenter le ralentissement à x${slowdown} automatiquement ?",
                        { pct: Math.round(slowFrameRatio * 100), slowdown: suggestedSlowdown }
                    );
                    
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
                                "Performance enregistrement",
                                () => {
                                    // Confirmation : augmenter le ralentissement
                                    try {
                                        pkg.options.record.mediaRecorder.slowdownFactor = suggestedSlowdown;
                                        // Sauvegarder dans les paramètres persistants si possible
                                        try { pkg.saveRecordSettings && pkg.saveRecordSettings(); } catch(_) {}
                                        // Mettre à jour l'interface
                                        const slowdownInput = document.getElementById('inputRecordSlowdown');
                                        if (slowdownInput) slowdownInput.value = suggestedSlowdown;
                                        
                                        pkg.showToast && pkg.showToast(
                                            pkg.t("Ralentissement augmenté à x${slowdown}. Redémarrez l'enregistrement pour appliquer le changement.", { slowdown: suggestedSlowdown }),
                                            'success',
                                            'Paramètre mis à jour',
                                            8000
                                        );
                                    } catch(err) {
                                        console.error('Erreur lors de l\'application du ralentissement:', err);
                                        pkg.showToast && pkg.showToast('Erreur lors de la mise à jour du paramètre.', 'error', 'Erreur', 5000);
                                    }
                                    this.currentPerformanceToast = null; // Reset après confirmation
                                },
                                () => {
                                    // Annulation : juste afficher un conseil
                                    pkg.showToast && pkg.showToast(
                                        pkg.t("Vous pouvez manuellement augmenter le ralentissement à x${slowdown} dans les paramètres d'enregistrement.", { slowdown: suggestedSlowdown }),
                                        'info',
                                        'Conseil',
                                        8000
                                    );
                                    this.currentPerformanceToast = null; // Reset après annulation
                                }
                            );
                        } else {
                            throw new Error('showConfirmation non disponible');
                        }
                    } catch(err) {
                        // Fallback vers toast simple
                        const fallbackMessage = pkg.t(
                            "Performance instable (${pct}% de frames lentes). Augmentez le ralentissement à x${slowdown} dans les paramètres.",
                            { pct: Math.round(slowFrameRatio * 100), slowdown: suggestedSlowdown }
                        );
                        
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
                        suggestion = pkg.t(
                            "Le ralentissement est déjà au maximum (x${slowdown}). Réduisez le nombre de points affichés ou la résolution.",
                            { slowdown: currentSlowdown }
                        );
                    } else {
                        suggestion = "Réduisez la vitesse d'animation (augmentez la durée par jour) ou le nombre de points affichés.";
                    }
                    
                    const message = pkg.t(
                        "Performance d'enregistrement instable (${pct}% de frames lentes). ${suggestion}",
                        { pct: Math.round(slowFrameRatio * 100), suggestion }
                    );
                    
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

// Boucle de prévisualisation (startAnimation/pauseAnimation/stopAnimation) pilotée
// par requestAnimationFrame + accumulateur de temps plutôt que setInterval : un
// setInterval dont le délai est plus court que le temps de rendu d'un jour (frame
// dense, onglet en arrière-plan, etc.) empile ses callbacks et les décharge en
// rafale dès que le thread se libère, ce qui saccade l'animation. rAF ne peut pas
// s'empiler (un seul callback par frame de rendu) et l'accumulateur ne rattrape
// jamais plus d'un jour à la fois, donc jamais de rafale.
let animationRafId = null;
let animationLastTs = null;
let animationAccMs = 0;
let endTimeout = null;
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
let mrStopTimeoutId = null;      // filet de sécurité (durée théorique très généreuse)
let mrTailStopTimeoutId = null;  // arrêt réel piloté par la fin d'animation + tail freeze
let mrTailMs = 3000;             // durée du gel de la dernière frame après la fin d'animation
let isMediaRecording = false;
let mrIsFinalizing = false;
let mrOnFinalizeRestoreTimePerDay = null;

// Audio lecture seule (hors enregistrement) et audio pour MediaRecorder
let bgAudioCtx = null, bgAudioEl = null, bgAudioSource = null, bgAudioGain = null, bgAudioActive = false;
let mrAudioCtx = null, mrAudioSource = null, mrAudioDest = null, mrAudioGain = null, mrAudioEl = null, mrHadAudio = false;
let blockBackgroundAudioPlayback = false;
let mrMuxAudioCtx = null; // Contexte audio "déverrouillé" par un geste utilisateur pour le mux post-enregistrement

// --- File d'upload bornée (mode images) ---
// Découple la capture de l'upload : on n'attend plus la fin du POST avant de capturer
// la frame suivante (l'upload bloquait la capture → saccades). Un plafond de concurrence
// évite une consommation mémoire non bornée si le réseau est plus lent que la capture.
const MAX_UPLOAD_CONCURRENCY = 4;
let uploadInFlight = 0;
let pendingUploads = [];
let uploadQueueError = null;

function resetUploadQueue() {
    uploadInFlight = 0;
    pendingUploads = [];
    uploadQueueError = null;
}

// Lance un upload en tâche de fond (suivi pour backpressure et attente finale).
function enqueueImageUpload(blob, counter) {
    uploadInFlight++;
    const t0 = performance.now();
    const p = pkg.sendImageToServer(blob, counter)
        .then(() => {
            perfMetrics.uploadTimeMs += (performance.now() - t0);
            perfMetrics.uploadOk += 1;
        })
        .catch((err) => {
            perfMetrics.uploadFail += 1;
            if (!uploadQueueError) uploadQueueError = err;
            throw err;
        })
        .finally(() => {
            uploadInFlight--;
            const i = pendingUploads.indexOf(p);
            if (i >= 0) pendingUploads.splice(i, 1);
        });
    pendingUploads.push(p);
    return p;
}

// Backpressure : attend qu'un créneau se libère si trop d'uploads sont en vol.
// Propage une éventuelle erreur d'upload déjà survenue pour abandonner tôt.
async function awaitUploadSlot() {
    if (uploadQueueError) throw uploadQueueError;
    while (uploadInFlight >= MAX_UPLOAD_CONCURRENCY) {
        await Promise.race(pendingUploads.map(p => p.catch(() => {})));
        if (uploadQueueError) throw uploadQueueError;
    }
}

// Attend la fin de tous les uploads en attente (fin d'enregistrement, avant assemblage).
async function awaitAllUploads() {
    await Promise.allSettled(pendingUploads.slice());
    if (uploadQueueError) throw uploadQueueError;
}

export function getMap() {
    return map;
}

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
        // Lecture unique : le son ne doit pas se relancer automatiquement en fin de piste
        bgAudioEl.loop = false;

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
        dbgMapgl('🎨 Couleurs GC chargées avec succès:', defaultGcColors);
        dbgMapgl('🎨 Test hexToRgb avec #008000:', pkg.hexToRgb('#008000'));
        dbgMapgl('🎨 Toutes les clés disponibles:', Object.keys(defaultGcColors));
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
    gcColorsFlat = Object.entries(defaultGcColors).flat();
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
        style: buildVectorMapStyle(defaultSettings.vectorMap)
    });

    map.addLayer(vectorTileLayer);
    vectorTileLayer.setVisible(false);
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
    vectorTileLayer.setStyle(buildVectorMapStyle(newValues));
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
    let lonLat = franceCenterLonLat;
    let zoom = 6;

    try {
        const s = window.userSettings;
        if (s && Array.isArray(s.map_default_center) && s.map_default_center.length === 2) {
            const lat = parseFloat(s.map_default_center[0]);
            const lon = parseFloat(s.map_default_center[1]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                lonLat = [lon, lat];
            }
        }
        if (s && (typeof s.map_default_zoom === 'number' || typeof s.map_default_zoom === 'string')) {
            const z = parseInt(s.map_default_zoom);
            if (Number.isFinite(z)) {
                zoom = z;
            }
        }
    } catch(e) {
    }

    // Conversion des coordonnées en EPSG:3857 pour OpenLayers
    const webMercator = ol.proj.fromLonLat(lonLat);
    map.getView().setCenter(webMercator);
    map.getView().setZoom(zoom); // Ajustez le niveau de zoom selon vos besoins
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
    if (!data) {
        console.warn('[addVector] data is null/undefined, abort');
        features = [];
        return;
    }
    // Lire les entités GeoJSON
    features = new ol.format.GeoJSON().readFeatures(data, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857'
    });
    dbgMapgl('[addVector] features lues:', features.length, '| vectorSource existant:', !!window.vectorSource, '| vectorLayer existant:', !!vectorLayer);

    // Vider la source avant le rechargement pour éviter l'accumulation de features
    if (window.vectorSource) {
        window.vectorSource.clear();
    }

    selectEngineAndRefresh();
}

// fonction appelée au changement d'options graphique
export function refreshPoints(){
    // Afficher un toast pour l'affichage des points
    const title = pkg.t ? pkg.t('Affichage des points') : 'Affichage des points';
    const message = pkg.t ? pkg.t('Mise à jour de l\'affichage des points...') : 'Mise à jour de l\'affichage des points...';
    pkg.showPointsToast(message, title);

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
    const currentFeatures = features || [];
    dbgMapgl('[selectEngineAndRefresh] engine:', engine, '| features count:', currentFeatures.length, '| point.mode:', pkg.options?.point?.mode);
    if (engine == "webgl"){
        displayWebGLPoints(currentFeatures, pkg.options.point);
    } else {
        displayAllPoints2D(currentFeatures, pkg.options.point);
    }
}

// Détermine si l'application est au repos (ni animation, ni enregistrement en cours)
function isIdleState(){
    try {
        const isAnimating = !!animationRafId; // boucle rAF active => animation en cours
        const rec = !!isRecording || !!isMediaRecording; // enregistrement en cours
        return !isAnimating && !rec;
    } catch(_) { return true; }
}

// Initialise l'overlay de popup et les interactions de clic
function initPopupOverlay(){
    // Créer l'élément DOM de la popup à partir du gabarit s'il n'existe pas
    // déjà (initPopupOverlay peut être rappelée si la carte est recréée).
    // Styles visuels : classes .gc-popup* (tabler_theme.css), pas de style inline.
    popupEl = document.getElementById('gcPopup');
    if (!popupEl) {
        const template = document.getElementById('gcPopupTemplate');
        if (template) {
            document.body.appendChild(template.content.cloneNode(true));
            popupEl = document.getElementById('gcPopup');
        } else {
            // Fallback si le gabarit est absent de la page (ne devrait pas arriver)
            popupEl = document.createElement('div');
            popupEl.id = 'gcPopup';
            popupEl.className = 'gc-popup';
            popupEl.innerHTML = '<div class="gc-popup-content"></div>';
            document.body.appendChild(popupEl);
        }
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
            <div class="gc-popup-title">${linkHref ? `<a href=\"${linkHref}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"gc-popup-link\">` : ''}${gcEsc}${linkHref ? '</a>' : ''} - ${name || 'Sans nom'}</div>
            <div>${type || '-'}, ${cont || '-'}, ${dif||'-'}/${ter||'-'}</div>
            ${owner ? `<div>${owner}</div>` : ''}
            ${publishedDate ? `<div>Publié le ${publishedDate}</div>` : ''}
            <div>${foundText === 'Oui' ? 'Trouvé' : 'DNF'} ${dateFind ? `le ${dateFind}` : ''}</div>`;
        const contentEl = popupEl.querySelector('.gc-popup-content') || popupEl;
        contentEl.innerHTML = html;
        popupEl.classList.add('is-visible');
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
    if (popupEl) popupEl.classList.remove('is-visible');
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

// Construit l'objet de style WebGLPoints (icône sprite ou cercle/triangle uni)
// à partir des options de points courantes. Le style WebGL est figé à la
// création du layer (il compile des shaders) : cette fonction n'est donc à
// appeler qu'à la (re)création du layer, jamais à chaque frame d'animation.
function buildPointStyle(pointOptions) {
    // Validation et valeurs par défaut pour éviter NaN dans les shaders WebGL
    const pointSize = Math.max(1, parseInt(pointOptions.center.size) || 3);
    const borderSizeValue = Math.max(0, parseInt(pointOptions.border.size) || 0);
    const borderWidth = borderSizeValue / 5; // Épaisseur réelle de la bordure
    let borderColor;

    if (pointOptions.border.mode == "gc") {
        borderColor = [
            'match',
            ['get', 'cache_type'],
            ...gcColorsFlat,
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
            ...gcColorsFlat,
            '#000000' // couleur par défaut
        ]
    } else if (pointOptions.center.mode == "fix") {
        fillColor = pointOptions.center.color
    }

    let pointStyle;
    if (pointOptions.mode == "icone") {
        // Utilisation du sprite Geocaching: offset/size dynamiques selon le type ('cache_type')
        if (pointOptions.sprite && pointOptions.sprite.map) {
            const sp = pointOptions.sprite;

            // Mapping des valeurs 'cache_type' des features -> clés du sprite
            const typeToKey = (sp.typeMap) || {
                'Traditional Cache': 'trad',
                'Multi-cache': 'multi',
                'Mystery Cache': 'myst',
                'Unknown Cache': 'unknown',
                'Letterbox Hybrid': 'letterbox',
                'Event Cache': 'event',
                'Mega-Event Cache': 'mega',
                'Giga-Event Cache': 'giga',
                'Earthcache': 'earth',
                'Virtual Cache': 'virtual',
                'Wherigo Cache': 'wherigo',
                'Lab Cache': 'lab',
                'Cache In Trash Out Event': 'cito',
                'Community Celebration Event': 'event',
                'GPS Adventures Exhibit': 'maze',
                'Locationless (Reverse) Cache': 'locationless',
                'Webcam Cache': 'webcam'
            };

            // Pour le jeu 'smiley', forcer tous les points à utiliser 'found'
            if (pointOptions.iconSet === 'smiley') {
                Object.keys(typeToKey).forEach(cacheType => {
                    typeToKey[cacheType] = 'found';
                });
            }

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

            // Support retina (@2x) sans changer la méta logique : on choisit l'URL selon devicePixelRatio, mais
            // on conserve width/height logiques (1x) pour les offsets et icon-scale.
            const pixelRatio = (window.devicePixelRatio && window.devicePixelRatio >= 2) ? 2 : 1;
            const iconUrl = (pixelRatio > 1 && sp.url2x) ? sp.url2x : sp.url;
            const logicalSheetW = sp.sheetWidth;
            const logicalSheetH = sp.sheetHeight;

            pointStyle = {
                'icon-src': iconUrl,
                'icon-size': buildMatchArray('size', [defaultRect.w, defaultRect.h]),
                // tailles de feuille RESTENT logiques (1x) pour préserver les offsets
                'icon-width': logicalSheetW,
                'icon-height': logicalSheetH,
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

    return pointStyle;
}

function displayWebGLPoints(features, pointOptions) {
    dbgMapgl('[displayWebGLPoints] featureList count:', (Array.isArray(features) ? features.length : 'not-array'), '| mode:', pointOptions?.mode, '| shape:', pointOptions?.shape, '| sprite:', !!pointOptions?.sprite);

    const featureList = Array.isArray(features) ? features : [];

    // Réutiliser la source existante si possible (évite les sources orphelines)
    if (!window.vectorSource) {
        dbgMapgl('[displayWebGLPoints] Création nouvelle vectorSource');
        window.vectorSource = new ol.source.Vector({ wrapX: true });
    }

    // Créer le layer seulement si absent (la source est réutilisée). Le style
    // n'est calculé que dans ce cas : il était auparavant reconstruit à chaque
    // appel (donc à chaque frame de l'animation) puis jeté sans être utilisé,
    // puisqu'un layer WebGLPoints existant ignore un nouveau style tant qu'il
    // n'est pas recréé (cf. clearMap() dans les autres appelants qui veulent
    // réellement changer le style).
    if (!vectorLayer) {
        dbgMapgl('[displayWebGLPoints] Création nouveau vectorLayer WebGLPoints');
        vectorLayer = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: buildPointStyle(pointOptions),
            zIndex: 1001,
        });
        map.addLayer(vectorLayer);
    }

    // Vérifier que le layer existe toujours sur la carte (il peut avoir été supprimé)
    const layerOnMap = map.getLayers().getArray().includes(vectorLayer);
    // getFeatures() reconstruit un tableau de TOUTES les features de la source : sur une
    // grosse BDD c'est un parcours O(n) exécuté à chaque frame d'animation. Comme les
    // arguments d'un appel sont évalués avant d'entrer dans dbgMapgl(), le passer en
    // argument le calculerait même flag éteint. On gate donc l'appel entier.
    if (DEBUG_MAPGL) dbgMapgl('[displayWebGLPoints] vectorLayer sur carte:', layerOnMap, '| vectorSource features avant add:', window.vectorSource.getFeatures().length);
    if (vectorLayer && !layerOnMap) {
        dbgMapgl('[displayWebGLPoints] Re-ajout du layer sur la carte');
        map.addLayer(vectorLayer);
    }

    // Alimenter la source avec les features filtrées
    if (featureList.length > 0) {
        let toAdd = featureList;
        const first = featureList[0];
        const isOlFeature = first && typeof first.getGeometry === 'function';
        dbgMapgl('[displayWebGLPoints] isOlFeature:', isOlFeature, '| toAdd count:', toAdd.length);

        if (!isOlFeature) {
            toAdd = new ol.format.GeoJSON().readFeatures({
                type: 'FeatureCollection',
                features: featureList
            }, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857'
            });
        }

        window.vectorSource.addFeatures(toAdd);
        // Même précaution : getFeatures().length ne doit pas s'exécuter quand le debug est éteint.
        if (DEBUG_MAPGL) dbgMapgl('[displayWebGLPoints] Après addFeatures:', window.vectorSource.getFeatures().length, 'features dans source');
    } else {
        console.warn('[displayWebGLPoints] featureList vide, rien à afficher');
    }
}

// supprime les points de la carte (centre et bordures si existantes)
export function clearMap(){
    // Garder vectorSource mais vider son contenu
    if (window.vectorSource) {
        window.vectorSource.clear();
    }

    // Retirer vectorLayer de la carte avant de perdre la référence
    if (vectorLayer) {
        map.removeLayer(vectorLayer);
        vectorLayer = undefined;
    }

    // Supprimer les autres layers si nécessaire
    if (window.borderLayer) {
        map.removeLayer(window.borderLayer);
        window.borderLayer = undefined;
    }
    if (window.centerLayer) {
        map.removeLayer(window.centerLayer);
        window.centerLayer = undefined;
    }

    // Nettoyer les layers d'animation
    if (window.animationLayer) {
        window.animationLayer.setVisible(false);
        window.animationLayer = undefined;
    }
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

function getExtraEndMs() {
    const extraSeconds = Number(pkg.options?.animation?.extraEndSeconds) || 0;
    return Math.max(0, extraSeconds) * 1000;
}

// Ratio de pixels device utilisé pour la capture (borné pour éviter des sorties démesurées).
// OpenLayers rend la carte en pixels device ; capturer à ce ratio évite le flou HiDPI.
function getCaptureDpr() {
    return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
}

function finalizeAnimationEnd() {
    endTimeout = null;

    // Fin RÉELLE de l'animation atteinte. En mode MediaRecorder, c'est ici qu'il
    // faut arrêter le recorder : le setTimeout théorique se désynchronise dès que
    // le rendu rame (l'animation prend du retard) et tronque la vidéo. On stoppe
    // depuis la fin réelle, après un court "tail" pour figer la dernière frame.
    if (isMediaRecording) {
        // Annuler le filet de sécurité théorique
        try { if (mrStopTimeoutId) { clearTimeout(mrStopTimeoutId); mrStopTimeoutId = null; } } catch(_) {}
        const tailMs = Math.max(0, Number(mrTailMs) || 0);
        if (tailMs > 0) {
            try { if (mrTailStopTimeoutId) clearTimeout(mrTailStopTimeoutId); } catch(_) {}
            mrTailStopTimeoutId = setTimeout(() => {
                mrTailStopTimeoutId = null;
                if (isMediaRecording) stopMediaRecorderPipeline(true);
            }, tailMs);
        } else if (isMediaRecording) {
            stopMediaRecorderPipeline(true);
        }
    }

    // Couper la musique de fond et remettre l'interface
    try { stopBackgroundMusic(); } catch(e) { console.warn('stopBackgroundMusic error:', e); }
    try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }
    try { hidePopup(); } catch(_) {}
}

export function startAnimation(restart=false) {
    if (endTimeout) {
        clearTimeout(endTimeout);
        endTimeout = null;
    }
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

    // Appliquer plage de dates définie dans l'onglet Animation si présente
    if (pkg.options.animation.dateStart instanceof Date) {
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
    }

    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
    }

    if (!restart) {
        currentDate = new Date(pkg.metadata.startDate);
    }

    // Repart avec un accumulateur neutre : la reprise (restart=true) ne rattrape
    // pas le temps écoulé pendant la pause, exactement comme l'ancien
    // setInterval + clearInterval + nouveau setInterval.
    animationLastTs = null;
    animationAccMs = 0;

    const animationStep = (ts) => {
        if (animationLastTs === null) animationLastTs = ts;
        // Borner le delta évite qu'un onglet remis au premier plan après une
        // longue mise en arrière-plan ne fasse défiler des dizaines de jours
        // d'un coup (rAF est suspendu en arrière-plan, contrairement à setInterval).
        animationAccMs += Math.min(ts - animationLastTs, dayDuration * 5);
        animationLastTs = ts;

        // Rattrape au plus un jour par frame : jamais de rafale, contrairement à
        // un setInterval dont les callbacks en retard se déchargeraient d'un coup.
        if (animationAccMs >= dayDuration) {
            animationAccMs -= dayDuration;
            displayFeaturesForDate(currentDate, pkg.options.point, flashOptions, false, infos);
            currentDate.setDate(currentDate.getDate() + 1);
            if (currentDate > pkg.metadata.endDate) {
                animationRafId = null;
                const extraMs = getExtraEndMs();
                if (extraMs > 0) {
                    if (endTimeout) {
                        clearTimeout(endTimeout);
                    }
                    endTimeout = setTimeout(() => finalizeAnimationEnd(), extraMs);
                } else {
                    finalizeAnimationEnd();
                }
                return;
            }
        }
        animationRafId = requestAnimationFrame(animationStep);
    };
    animationRafId = requestAnimationFrame(animationStep);
}

export function stopAnimation(){
    // Arrêter l'enregistrement si en cours
    isRecording = false;

    if (animationRafId) {
        cancelAnimationFrame(animationRafId);
        animationRafId = null;
    }
    animationLastTs = null;

    if (endTimeout) {
        clearTimeout(endTimeout);
        endTimeout = null;
    }

    // Arrêter le pipeline MediaRecorder si actif
    try {
        if (isMediaRecording) {
            stopMediaRecorderPipeline(true);
        }
    } catch(e) { console.warn('Erreur arrêt MediaRecorder:', e); }

    // Arrêter musique de fond si lecture seule
    try { stopBackgroundMusic(); } catch(e) { console.warn('stopBackgroundMusic error:', e); }

    // Fermer le toast de chargement s'il est ouvert
    try {
        // Essayer différents sélecteurs pour le toast
        const loadingToast = document.querySelector('.toast-loading') ||
                           document.querySelector('.toast') ||
                           document.querySelector('[class*="toast"]');
        if (loadingToast) {
            dbgMapgl('[STOP] Toast trouvé, tentative de fermeture:', loadingToast);
            pkg.hideToast && pkg.hideToast(loadingToast);
        } else {
            dbgMapgl('[STOP] Aucun toast trouvé avec les sélecteurs testés');
        }

        // Essayer aussi de fermer tous les toasts visibles
        const allToasts = document.querySelectorAll('.toast, [class*="toast"]');
        allToasts.forEach((toast, index) => {
            dbgMapgl(`[STOP] Fermeture toast ${index}:`, toast.textContent);
            pkg.hideToast && pkg.hideToast(toast);
        });
    } catch(e) {
        console.warn('Erreur lors de la fermeture du toast:', e);
    }

    // Remettre la carte à l'état d'origine avec tous les points filtrés
    dbgMapgl('[STOP] Nettoyage de la carte...');
    clearMap();

    // Nettoyer les animations et effets
    if (window.vectorSource) {
        window.vectorSource.clear();
        dbgMapgl('[STOP] Vector source nettoyé');
    }

    // Nettoyer les animations de flash
    if (animationSource) {
        animationSource.clear();
        dbgMapgl('[STOP] Animation source nettoyé');
    }

    // Nettoyer les layers d'animation
    if (animationLayer) {
        animationLayer.setVisible(false);
        dbgMapgl('[STOP] Animation layer masqué');
    }

    // Nettoyer les références globales
    if (window.animationSource) {
        window.animationSource.clear();
        window.animationSource = undefined;
        dbgMapgl('[STOP] Window animation source nettoyé');
    }

    if (window.animationLayer) {
        window.animationLayer.setVisible(false);
        window.animationLayer = undefined;
        dbgMapgl('[STOP] Window animation layer nettoyé');
    }

    // Remettre les styles par défaut
    updateAnimationStyles();
    dbgMapgl('[STOP] Styles d\'animation remis à zéro');

    const allFilteredPoints = getAllFilteredPoints();
    dbgMapgl('[STOP] Nombre de points filtrés à afficher:', allFilteredPoints.length);
    if (allFilteredPoints.length > 0) {
        displayWebGLPoints(allFilteredPoints, pkg.options.point);
        dbgMapgl('[STOP] Points affichés avec succès');
    } else {
        dbgMapgl('[STOP] Aucun point à afficher');
    }

    // Remettre les contrôles UI dans l'état initial
    try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }

    // S'assurer que la popup est masquée
    try { hidePopup(); } catch(_) {}
}

/**
 * Pause l'animation en cours (lecture seule) sans vider la carte ni réinitialiser l'état.
 * La reprise se fait via startAnimation("restart") qui reprend depuis currentDate.
 * NE PAS appeler en mode enregistrement (utiliser stopAnimation() à la place).
 */
export function pauseAnimation() {
    // Stopper uniquement la boucle rAF d'avancement des dates
    if (animationRafId) {
        cancelAnimationFrame(animationRafId);
        animationRafId = null;
    }
    animationLastTs = null;
    // Stopper le timeout de fin éventuel
    if (endTimeout) {
        clearTimeout(endTimeout);
        endTimeout = null;
    }
    // Mettre la musique de fond en pause (elle reprendra à la reprise)
    try { stopBackgroundMusic(); } catch(e) { console.warn('pauseAnimation stopBackgroundMusic error:', e); }
    // La carte, vectorSource, les points et currentDate sont conservés tels quels
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
    // Précharger html2canvas en tâche de fond : s'il est nécessaire (repli rare,
    // cf. scheduleCaptureFrame), le téléchargement se recouvre avec le début de
    // la capture au lieu de bloquer la première frame qui en aurait besoin.
    loadHtml2Canvas().catch(() => {});

    // Remise à zéro de l'état de la carte et des informations affichées
    clearMap(); // Nettoie les points sur la carte

    // Remise à zéro des compteurs d'images/frames pour un nouvel enregistrement
    imageCounter = 0;
    currentFrame = 0;
    globalRecordFrame = 0;
    infosProgressBar = {};

    // Afficher les caches filtrés jusqu'à la date de début d'animation (sans effet flash)
    const filteredPointsAtStart = getFilteredPointsAtStart();
    if (filteredPointsAtStart.length > 0) {
        displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
    }

    // Déterminer plage de dates d'animation si définie
    if (pkg.options.animation.dateStart instanceof Date) {
        currentDate = new Date(pkg.options.animation.dateStart);
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
        dbgMapgl('[RECORD] Date de début personnalisée appliquée:', pkg.metadata.startDate);
    } else {
        currentDate = new Date(pkg.metadata.startDate); // copie explicite pour ne pas muter pkg.metadata via setDate()
        dbgMapgl('[RECORD] ❌ Utilisation date de début par défaut:', currentDate);
    }
    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
        dbgMapgl('[RECORD] Date de fin personnalisée appliquée:', pkg.metadata.endDate);
    } else {
        dbgMapgl('[RECORD] ❌ Utilisation date de fin par défaut:', pkg.metadata.endDate);
    }

    dbgMapgl('[RECORD] 🚀 Démarrage enregistrement avec date:', currentDate, '->', pkg.metadata.endDate);

    // Calculer framesPerDay de façon autonome (ne pas dépendre d'un appel préalable à updateInfosForPictures)
    {
        const _fps       = pkg.options.record.fps || 24;
        const _tpd       = pkg.options.animation.timePerDay || 50;
        const _fpd       = Math.max(1, Math.round(_tpd * _fps / 1000));
        framesPerDay     = Math.max(1, Number(pkg.options.record.framesPerDay) || _fpd);
        // Recalculer framesPerSec et flashFrames si non définis ou issus d'un framesPerDay=0
        const _fps2      = framesPerDay * 1000 / _tpd;
        pkg.options.record.framesPerSec  = _fps2;
        pkg.options.record.framesPerDay  = framesPerDay;
        const _flashMs   = pkg.options.flash.duration || 2000;
        pkg.options.record.flashFrames   = _flashMs * _fps2 / 1000;
    }

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
        dbgMapgl('[RECORD] Jours animation:', animationDays, 'frames/jour:', framesPerDayLocal, 'total images:', pkg.options.record.nbOfImages);
    } catch(e) { console.warn('Calcul jours animation échoué:', e); }

    // Remise à zéro de l'affichage des informations
    pkg.updateNbCaches(0); // Remet le compteur de géocaches à zéro
    pkg.updateCurrentDate(currentDate); // Remet la date au début effectif
    try { pkg.updateProgressBar({ progress: 0, message: '0% | préparation...' }); } catch(_) {}

    // Bloquer la musique et détecter l'audio pour l'intégrer dans le toast
    let _captureAudioNote = '';
    try {
        blockBackgroundAudioPlayback = true;
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            _captureAudioNote = ` ♪ La musique sera intégrée automatiquement après la capture.`;
        }
    } catch(_) {}

    // ouverture modale avec avertissement dans le titre et info audio dans le message
    pkg.openModalLoading(
        "Capture en cours – Ne pas bouger la fenêtre",
        "Préparation de la capture..." + _captureAudioNote
    );

    // Init métriques
    perfMetrics = { totalFrames: 0, capturedFrames: 0, uploadOk: 0, uploadFail: 0, captureTimeMs: 0, uploadTimeMs: 0, startedAt: performance.now() };

    // Réinitialiser la file d'upload (uploads découplés de la capture en mode images)
    resetUploadQueue();

    // Marquer le début de l'enregistrement
    isRecording = true;

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

    // Précalculer les propriétés statiques des overlays à l'échelle dpr (pixels device),
    // cohérent avec le canvas de capture images dimensionné en pixels device.
    buildOverlayCache(getCaptureDpr());

    // Afficher les points initiaux pour la date de début
    displayFeaturesForDate(currentDate, pkg.options.point, pkg.options.flash, true, infos);

    // Attendre que le rendu soit complet avant de commencer la capture
    // scheduleCaptureFrame attrape toute erreur de la boucle asynchrone pour
    // éviter que la modale reste bloquée en cas d'échec (upload, timeout, etc.)
    map.once('rendercomplete', () => {
        scheduleCaptureFrame(pkg.options.point, pkg.options.flash, infos);
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


// Capture une frame avec retry automatique. captureElement() peut rejeter
// (timeout rendercomplete, toBlob null, upload épuisé) : on retente quelques
// fois avant d'abandonner, pour absorber les incidents transitoires.
async function captureElementWithRetry() {
    const maxRetries = Math.max(0, Number(pkg.options?.record?.frameRetries ?? 2));
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await captureElement();
            return;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                console.warn(`[CAPTURE] Frame ${imageCounter} échouée (tentative ${attempt + 1}/${maxRetries + 1}): ${error?.message || error} — nouvel essai`);
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }
    throw lastError;
}

// Planifie la frame suivante en attrapant TOUTE erreur de la boucle asynchrone.
// Sans ce .catch(), une seule frame échouée tuait la boucle silencieusement et
// laissait la modale « Capture en cours » ouverte à jamais.
function scheduleCaptureFrame(pointOptions, flashOptions, infos) {
    requestAnimationFrame(() => {
        captureNextFrame(true, pointOptions, flashOptions, infos).catch(err => {
            abortRecordingOnError(err);
        });
    });
}

// Termine proprement l'enregistrement en cas d'erreur irrécupérable :
// ferme la modale/les toasts, nettoie les animations, restaure la carte et
// les contrôles, puis affiche un message d'erreur explicite à l'utilisateur.
function abortRecordingOnError(error) {
    console.error('[CAPTURE] Abandon de l\'enregistrement suite à une erreur:', error);

    isRecording = false;
    try { recordingPerformanceMonitor.stopMonitoring(); } catch(_) {}
    try { blockBackgroundAudioPlayback = false; } catch(_) {}

    // Fermer la modale de chargement et les toasts
    try { pkg.closeModalLoading && pkg.closeModalLoading(); } catch(_) {}
    try {
        const allToasts = document.querySelectorAll('.gcm-toast, .toast, .toast-loading');
        allToasts.forEach(toast => { pkg.hideToast && pkg.hideToast(toast); });
    } catch(_) {}

    // Nettoyer les animations de flash
    try { if (animationSource) animationSource.clear(); } catch(_) {}
    try { if (animationLayer) animationLayer.setVisible(false); } catch(_) {}

    // Remettre la carte avec tous les points filtrés
    try {
        clearMap();
        const allFilteredPoints = getAllFilteredPoints();
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
        }
    } catch(_) {}

    // Réactiver les boutons et restaurer les contrôles
    try {
        const assembleBtn = document.getElementById('btnAssembleMoviePictures');
        const cleanBtn = document.getElementById('btnCleanMoviePictures');
        const recordBtn = document.getElementById('btnRecordAnimation');
        if (assembleBtn) { assembleBtn.disabled = false; assembleBtn.textContent = 'Assembler film'; }
        if (cleanBtn) { cleanBtn.disabled = false; cleanBtn.textContent = 'Nettoyer images'; }
        if (recordBtn) { recordBtn.disabled = false; }
    } catch(_) {}
    try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(_) {}

    // Informer l'utilisateur
    try {
        pkg.showToast && pkg.showToast(
            pkg.t('La capture a été interrompue suite à une erreur : ${message}', { message: (error?.message || 'erreur inconnue') }),
            'error',
            'Capture interrompue',
            8000
        );
    } catch(_) {}
}

// Poll générique d'une tâche de fond serveur (/tasks/<id>) jusqu'à ce qu'elle
// soit terminée. Résout avec le résultat, rejette en cas d'échec ou de timeout.
// Utilisé pour l'assemblage vidéo, lancé en tâche de fond côté serveur pour
// éviter l'expiration du fetch HTTP sur les vidéos longues.
function pollTaskStatus(taskId, { intervalMs = 700, timeoutMs = 1800000, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
            if (!taskId) { reject(new Error('task_id manquant')); return; }
            if (Date.now() - startedAt > timeoutMs) { reject(new Error('Délai d\'assemblage dépassé')); return; }
            fetch(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`, { method: 'GET' })
                .then(r => r.json())
                .then(status => {
                    const state = status?.state;
                    if (typeof onProgress === 'function' && typeof status?.progress === 'number') {
                        onProgress(status.progress, status.message);
                    }
                    if (state === 'finished') { resolve(status?.result || {}); return; }
                    if (state === 'failed') { reject(new Error(status?.error || status?.message || 'Tâche échouée')); return; }
                    setTimeout(tick, intervalMs);
                })
                .catch(err => reject(err));
        };
        tick();
    });
}

// TODO Voir pour Capture, car à priori c'est forcement == True
async function captureNextFrame(capture, pointOptions, flashOptions, infos) {
    // Vérifier si l'enregistrement a été arrêté
    if (!isRecording) {
        dbgMapgl('[CAPTURE] Enregistrement arrêté par l\'utilisateur');

        // Fermer le toast de chargement
        // IMPORTANT: ne pas utiliser de sélecteur large type [class*="toast"] qui peut matcher le conteneur (.gcm-toast-container)
        // et casser l'affichage des loaders suivants.
        try {
            const loadingToast = document.querySelector('.toast-loading') ||
                               document.querySelector('.gcm-toast') ||
                               document.querySelector('.toast');
            if (loadingToast) {
                dbgMapgl('[CAPTURE] Toast trouvé, tentative de fermeture:', loadingToast);
                pkg.hideToast && pkg.hideToast(loadingToast);
            } else {
                dbgMapgl('[CAPTURE] Aucun toast trouvé avec les sélecteurs testés');
            }

            // Essayer aussi de fermer tous les toasts visibles (sans toucher au conteneur)
            const allToasts = document.querySelectorAll('.gcm-toast, .toast, .toast-loading');
            allToasts.forEach((toast, index) => {
                dbgMapgl(`[CAPTURE] Fermeture toast ${index}:`, toast.textContent);
                pkg.hideToast && pkg.hideToast(toast);
            });
        } catch(e) {
            console.warn('Erreur lors de la fermeture du toast:', e);
        }

        // Nettoyer les animations de flash
        if (animationSource) {
            animationSource.clear();
            dbgMapgl('[CAPTURE] Animation source nettoyé');
        }
        if (animationLayer) {
            animationLayer.setVisible(false);
            dbgMapgl('[CAPTURE] Animation layer masqué');
        }

        // Remettre la carte avec tous les points filtrés
        clearMap();
        const allFilteredPoints = getAllFilteredPoints();
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
            dbgMapgl('[CAPTURE] Affichage de', allFilteredPoints.length, 'points filtrés');
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }
        return;
    }

    if (currentDate > pkg.metadata.endDate) {
        for (let extraFrames = 0; extraFrames < pkg.options.record.extraFrames; extraFrames++) {
            updateAnimationStyles();
            if (capture == true) {
                await captureElementWithRetry();
                currentFrame++;

            } else {
                currentFrame++;
            }
        }

        // Les uploads sont découplés de la capture : attendre que TOUTES les images
        // soient effectivement envoyées avant de lancer l'assemblage (sinon la vidéo
        // serait assemblée sur des images manquantes). Une erreur d'upload propage ici
        // et déclenche l'abandon propre via scheduleCaptureFrame().
        try { pkg.updateProgressBar({ progress: 99, message: 'Envoi des dernières images...' }); } catch(_) {}
        await awaitAllUploads();

        // Traitement de fin
        isRecording = false; // Marquer la fin de l'enregistrement
        
        // Arrêter la surveillance des performances
        recordingPerformanceMonitor.stopMonitoring();
        
        try { blockBackgroundAudioPlayback = false; } catch(_) {}

        // Fermer le toast de chargement
        // IMPORTANT: ne pas utiliser de sélecteur large type [class*="toast"] qui peut matcher le conteneur (.gcm-toast-container)
        // et casser l'affichage des loaders suivants.
        try {
            const loadingToast = document.querySelector('.toast-loading') ||
                               document.querySelector('.gcm-toast') ||
                               document.querySelector('.toast');
            if (loadingToast) {
                pkg.hideToast && pkg.hideToast(loadingToast);
            }

            // Essayer aussi de fermer tous les toasts visibles (sans toucher au conteneur)
            const allToasts = document.querySelectorAll('.gcm-toast, .toast, .toast-loading');
            allToasts.forEach((toast, index) => {
                pkg.hideToast && pkg.hideToast(toast);
            });
        } catch(e) {
            console.warn('Erreur lors de la fermeture du toast:', e);
        }

        // Nettoyer les animations de flash
        if (animationSource) {
            animationSource.clear();
            dbgMapgl('[RECORD END] Animation source nettoyé');
        }
        if (animationLayer) {
            animationLayer.setVisible(false);
            dbgMapgl('[RECORD END] Animation layer masqué');
        }

        // Remettre la carte avec tous les points filtrés
        clearMap();
        const allFilteredPoints = getAllFilteredPoints();
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
            dbgMapgl('[RECORD END] Affichage de', allFilteredPoints.length, 'points filtrés');
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }

        // Assembler automatiquement puis nettoyer
        dbgMapgl('[RECORD END] Démarrage de l\'assemblage automatique...');

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
                // FPS configurable : doit correspondre à celui utilisé pour calculer
                // les frames, sinon la vitesse de lecture est faussée côté serveur.
                const fps = Number(pkg.options?.record?.fps) || 24;
                const url = new URL(`${CONFIG.BASE_URL}/start_create_video`, window.location.origin);
                url.searchParams.set('fps', String(fps));
                if (audioFileName) {
                    url.searchParams.set('audio', audioFileName);
                    url.searchParams.set('audio_volume', String(audioVol));
                }
                return fetch(url.toString());
            } catch(e) {
                console.warn('Assemblage avec audio: fallback sans audio', e);
                const fps = Number(pkg.options?.record?.fps) || 24;
                const fallbackUrl = new URL(`${CONFIG.BASE_URL}/start_create_video`, window.location.origin);
                fallbackUrl.searchParams.set('fps', String(fps));
                return fetch(fallbackUrl.toString());
            }
        };

        // Réactive les boutons de l'UI (factorisé, utilisé dans plusieurs branches)
        const reEnableRecordButtons = () => {
          if (assembleBtn) { assembleBtn.disabled = false; assembleBtn.textContent = 'Assembler film'; }
          if (cleanBtn) { cleanBtn.disabled = false; cleanBtn.textContent = 'Nettoyer images'; }
          if (recordBtn) { recordBtn.disabled = false; }
        };

        tryAssembleWithAudio()
          .then(response => { logToast('Réponse assemblage reçue, status:', response?.status); return response.json(); })
          .then(data => {
            // L'assemblage tourne désormais en tâche de fond : on récupère un task_id
            // et on suit sa progression via /tasks/<id> (fini l'expiration du fetch).
            if (!data || !data.task_id) {
              throw new Error(data && data.message ? data.message : 'Impossible de lancer l\'assemblage vidéo');
            }
            dbgMapgl('[RECORD END] Assemblage lancé en tâche de fond, task_id:', data.task_id);
            return pollTaskStatus(data.task_id, {
              onProgress: (p, msg) => {
                // Encodage vidéo mappé sur 0→70% de la barre globale
                try { pkg.updateProgressBar({ progress: Math.round(p * 0.7), message: msg || 'Création de la vidéo...' }); } catch(e) {}
              }
            });
          })
          .then(() => {
            dbgMapgl('[RECORD END] Assemblage réussi, nettoyage automatique...');
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
          })
          .then(response => response ? response.json() : null)
          .then(cleanData => {
            reEnableRecordButtons();
            if (cleanData && cleanData.success) {
              dbgMapgl('[RECORD END] Nettoyage automatique terminé');
              try { pkg.updateProgressBar({progress: 100, message: 'Nettoyage terminé'}); } catch(e) {}
              setTimeout(() => { try { pkg.closeModalLoading(); } catch(e) {} }, 400);
              pkg.showToast && pkg.showToast('Traitement automatique terminé avec succès !', 'success', 'Vidéo prête', 5000);
            } else {
              if (cleanData) console.warn('[RECORD END] Échec du nettoyage:', cleanData.message);
              try { pkg.closeModalLoading(); } catch(e) {}
            }
          })
          .catch(err => {
            console.error('[RECORD END] Erreur dans la chaîne automatique:', err);
            reEnableRecordButtons();
            try { pkg.closeModalLoading(); } catch(e) {}
            pkg.showToast && pkg.showToast(
              pkg.t('Erreur lors du traitement automatique: ${message}', { message: err.message }),
              'error',
              'Erreur chaîne',
              5000
            );
          });

        return;
    }

    if (currentFrame < framesPerDay) {
        // Capturez la frame actuelle
        if (capture == true) {
            await captureElementWithRetry();
                globalRecordFrame++;  // avancer l'animation d'1 cran par capture
                currentFrame++;
                scheduleCaptureFrame(pointOptions, flashOptions, infos);
        } else {
            currentFrame++;
            // De même ici, si vous avez besoin de passer des arguments spécifiques
            scheduleCaptureFrame(pointOptions, flashOptions, infos);
        }
    } else {
        // JOUR SUIVANT
        // Mise à jour de la Modale
        updateProgress();

        currentDate.setDate(currentDate.getDate() + 1);
        displayFeaturesForDate(currentDate, pointOptions, flashOptions, true, infos);
        currentFrame = 0;  // Réinitialisez le compteur de frames pour le nouveau jour
        scheduleCaptureFrame(pointOptions, flashOptions, infos);
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

    // Bloquer la musique et détecter l'audio pour l'intégrer dans le toast
    let _mrAudioNote = '';
    try {
        blockBackgroundAudioPlayback = true;
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            _mrAudioNote = ` ♪ La musique sera intégrée automatiquement après la capture.`;
            // Débloquer un AudioContext PENDANT le geste utilisateur (clic Enregistrer).
            // Le mux audio s'exécute après la capture, hors geste : un contexte créé à ce
            // moment-là resterait "suspended" et produirait une vidéo muette. On le pré-crée
            // et le résume ici pour que muxRecordedVideoWithAudio le réutilise.
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (AC && (!window.mrMuxAudioCtx || window.mrMuxAudioCtx.state === 'closed')) {
                    window.mrMuxAudioCtx = new AC();
                }
                if (window.mrMuxAudioCtx && window.mrMuxAudioCtx.state === 'suspended') {
                    window.mrMuxAudioCtx.resume().catch(()=>{});
                }
            } catch(_) {}
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
        currentDate = new Date(pkg.metadata.startDate); // copie explicite pour ne pas muter pkg.metadata via setDate()
    }
    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
    }

    // Frames/informations
    window.vectorSource = window.vectorSource || new ol.source.Vector({ wrapX: true });
    window.vectorSource.clear();
    createFlashElements();
    // IMPORTANT : réinitialiser la variable module 'infos' (compteur de caches).
    // startAnimation(true) réutilise ce même objet ; sans reset, cacheNumber
    // repart de l'ancien total accumulé → compteur faux. (Avant : un 'infosLocal'
    // local était créé puis jamais utilisé.)
    infos = createObjectInfos();
    pkg.updateNbCaches(0);
    pkg.updateCurrentDate(currentDate);

    // UI loader
    const totalMs = computeTotalAnimationMs();
    try { pkg.openModalLoading(
        'Enregistrement en cours – Ne pas bouger la fenêtre',
        'Démarrage de la capture...' + _mrAudioNote
    ); } catch(_) {}

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
            dbgMapgl('[RECORD] Slowdown x' + sd + ' appliqué: timePerDay=' + pkg.options.animation.timePerDay + ', flash.duration=' + pkg.options.flash.duration);
        }
    } catch(_) {}

    // Démarrer animation timeline existante (musique bloquée)
    try { startAnimation(true); } catch(_) { startAnimation(); }

    // Démarrer capture MediaRecorder
    startMediaRecorderPipeline(totalMs * appliedSlowdown).catch(e => {
        console.error('MediaRecorder pipeline error:', e);
        pkg.showToast && pkg.showToast('Erreur MediaRecorder, bascule en mode images.', 'error', 'Enregistrement');
        // Stopper proprement la boucle animation (rAF) déjà lancée par startAnimation()
        // AVANT de relancer recordAnimation(), pour éviter deux boucles d'avancement de date en parallèle
        try { stopMediaRecorderPipeline(false); } catch(_) {}
        if (animationRafId) { cancelAnimationFrame(animationRafId); animationRafId = null; }
        // Forcer le mode images pour éviter une boucle infinie MediaRecorder → fallback → MediaRecorder
        try { pkg.options.record.mode = 'images'; } catch(_) {}
        recordAnimation();
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
        const extraEndMs = Math.max(0, Number(pkg.options?.animation?.extraEndSeconds) || 0) * 1000;

        // Pour MediaRecorder, utiliser une durée fixe pour extraFrames (indépendante du FPS)
        // Pour éviter que la durée totale change avec le FPS
        const isMediaRecorder = pkg.options.record?.mode === 'mediarecorder';
        let tail;
        if (isMediaRecorder) {
            // Duree fixe de 3 secondes + temps additionnel pour la fin d'animation
            tail = 3000 + extraEndMs;
        } else {
            // Pour l'enregistrement par images, utiliser la logique existante
            tail = Math.round((extraFrames / fps) * 1000);
        }

        return base + tail;
    } catch(_) { return 3000; }
}

async function startMediaRecorderPipeline(totalDurationMs){
    const fps = Number(pkg.options.record?.fps) || 24;
    const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
    const vbps = Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) || 6000000;
    const scaleFactor = Math.max(1, Math.min(3, Number(pkg.options?.record?.mediaRecorder?.scaleFactor) || 1));

    // Durée du gel de la dernière frame après la fin réelle de l'animation.
    // L'arrêt du recorder est piloté par finalizeAnimationEnd (fin réelle), pas
    // par un setTimeout théorique qui tronque la vidéo si le rendu prend du retard.
    mrTailMs = Math.max(0, Number(pkg.options?.record?.mediaRecorder?.tailFreezeMs ?? 3000));

    // devicePixelRatio : les canvas de la carte sont rendus par OpenLayers en pixels
    // device (rect.width * dpr). Ignorer le dpr sous-échantillonnait la sortie → vidéo
    // floue sur écran HiDPI. On capture donc à scaleFactor * dpr.
    const dpr = getCaptureDpr();
    const effScale = scaleFactor * dpr;

    const viewport = map.getViewport();
    const rect = viewport.getBoundingClientRect();
    mrOutCanvas = document.createElement('canvas');
    mrOutCanvas.width = Math.max(1, Math.floor(rect.width * effScale));
    mrOutCanvas.height = Math.max(1, Math.floor(rect.height * effScale));
    // Pas de willReadFrequently : ce canvas n'est jamais relu (getImageData) ; il est
    // uniquement composité puis exporté via captureStream. willReadFrequently:true
    // forçait un backing store CPU (pas d'accélération GPU) → compositing lent et saccades.
    mrOutCtx = mrOutCanvas.getContext('2d');

    const canvasStream = mrOutCanvas.captureStream(fps);
    // Pas d'audio pendant l'enregistrement MediaRecorder (audio ajouté après)
    mrHadAudio = false;
    const mixedStream = canvasStream;

    mrRecordedChunks = [];
    mrRecorder = new MediaRecorder(mixedStream, { mimeType: mime, videoBitsPerSecond: vbps });
    isMediaRecording = true;

    mrRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mrRecordedChunks.push(e.data); };
    mrRecorder.onstop = () => finalizeMediaRecorderVideo();
    // Utiliser un timeslice plus grand pour réduire le nombre de chunks et la pression GC
    const timesliceMs = Math.max(200, Number(pkg.options?.record?.mediaRecorder?.timesliceMs) || 1000);
    mrRecorder.start(timesliceMs);

    // Précalculer les propriétés statiques des overlays pour éviter les reflows par frame
    buildOverlayCache(effScale);

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
            addOverlaysToCanvas(mrOutCtx, w, h, effScale);
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
        const _hasAudio = !!(pkg.options?.record?.audio?.enabled) && !!document.getElementById('inputAudioFile')?.files?.[0];
        const msg = `${progress.toFixed(1)}% | capture .webm${_hasAudio ? ' ♪' : ''}`;
        try { pkg.updateProgressBar({ progress, message: msg }); } catch(_) {}
    }, 200);

    // Filet de sécurité UNIQUEMENT : l'arrêt normal est déclenché par
    // finalizeAnimationEnd() (fin réelle de l'animation). Ce timeout, volontairement
    // très généreux, ne sert qu'à éviter un enregistrement infini si la fin
    // d'animation n'était jamais atteinte (cas anormal). Il ne doit surtout PAS
    // se déclencher avant la fin réelle, même quand le rendu rame fortement.
    const safetyMs = Math.max(0, totalDurationMs) * 4 + 60000;
    mrStopTimeoutId = setTimeout(() => {
        mrStopTimeoutId = null;
        if (isMediaRecording) {
            console.warn('[MediaRecorder] Arrêt par filet de sécurité (fin d\'animation non détectée)');
            stopMediaRecorderPipeline(true);
        }
    }, safetyMs);
}

function stopMediaRecorderPipeline(finalize){
    try { if (mrDrawIntervalId) { clearInterval(mrDrawIntervalId); mrDrawIntervalId = null; } } catch(_) {}
    try { if (mrProgressIntervalId) { clearInterval(mrProgressIntervalId); mrProgressIntervalId = null; } } catch(_) {}
    try { if (mrStopTimeoutId) { clearTimeout(mrStopTimeoutId); mrStopTimeoutId = null; } } catch(_) {}
    try { if (mrTailStopTimeoutId) { clearTimeout(mrTailStopTimeoutId); mrTailStopTimeoutId = null; } } catch(_) {}
    
    // Arrêter la surveillance des performances
    recordingPerformanceMonitor.stopMonitoring();
    
    if (mrRecorder && mrRecorder.state !== 'inactive') {
        try { mrRecorder.stop(); } catch(_) {}
    } else if (finalize) {
        finalizeMediaRecorderVideo();
    } else {
        // Annulation sans finalization : restaurer timePerDay immédiatement
        try { mrOnFinalizeRestoreTimePerDay?.(); mrOnFinalizeRestoreTimePerDay = null; } catch(_) {}
    }
    isMediaRecording = false;
    mrIsFinalizing = false;

    // Nettoyage audio MR
    try { if (mrAudioEl) { mrAudioEl.pause(); mrAudioEl.currentTime = 0; URL.revokeObjectURL(mrAudioEl.src); } } catch(_) {}
    try { if (mrAudioCtx) { mrAudioCtx.close(); } } catch(_) {}
    mrAudioEl = mrAudioCtx = mrAudioSource = mrAudioDest = mrAudioGain = null;
}

function finalizeMediaRecorderVideo(){
    if (mrIsFinalizing) return;
    mrIsFinalizing = true;
    try {
        const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
        const blob = new Blob(mrRecordedChunks || [], { type: mime });

        // Construire un nom horodaté pour éviter l'écrasement
        const buildTimestampedName = (base) => {
            const safeBase = (base || 'gcmap.webm').trim();
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const lastDot = safeBase.lastIndexOf('.');
            if (lastDot > 0 && lastDot < safeBase.length - 1) {
                const name = safeBase.slice(0, lastDot);
                const ext = safeBase.slice(lastDot);
                return `${name}_${stamp}${ext}`;
            }
            return `${safeBase}_${stamp}.webm`;
        };

        const fileName = buildTimestampedName(pkg.options?.record?.mediaRecorder?.fileName);

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

        const deliver = (finalBlob) => {
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

        // Avant livraison : réécrire l'en-tête WebM pour y injecter la durée réelle.
        // Sans ça, MediaRecorder produit un .webm sans "Duration" : les lecteurs
        // n'affichent pas la durée et la barre de progression ne permet pas de chercher.
        const proceedWith = (finalBlob) => {
            try { pkg.updateTextsModal('Finalisation', 'Écriture de la durée de la vidéo...'); } catch(_) {}
            fixWebmFinalDuration(finalBlob).then((fixedBlob) => deliver(fixedBlob || finalBlob));
        };

        // Audio utilisateur éventuellement sélectionné
        const fileInput = document.getElementById('inputAudioFile');
        const audioFile = fileInput && fileInput.files && fileInput.files[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);

        // ---- Repli navigateur (ancien pipeline) : normalisation playbackRate + mux par re-capture ----
        // Lent et doublement lossy, conservé uniquement en secours si le serveur échoue.
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
        const runClientFallback = () => {
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
        };

        // ---- Traitement serveur (ffmpeg, une seule passe) : normalisation + mux ----
        // Rapide, robuste, sans onglet actif obligatoire. Remplace jusqu'à 3 ré-encodages navigateur.
        const processOnServer = () => new Promise((resolve, reject) => {
            try { pkg.updateTextsModal('Traitement serveur', 'Envoi de la vidéo au serveur...'); } catch(_) {}
            // Réécrire la durée du .webm pour que ffmpeg la lise correctement (opération légère, pas de ré-encodage)
            fixWebmFinalDuration(blob).then((fixedBlob) => {
                const toSend = fixedBlob || blob;
                const fd = new FormData();
                fd.append('video', toSend, 'recording.webm');
                fd.append('slowdown', String(slowdown));
                fd.append('fps', String(Number(pkg.options?.record?.fps) || 24));
                fd.append('fileName', fileName);
                if (audioEnabled && audioFile) {
                    fd.append('audio', audioFile, audioFile.name || 'music');
                    const vol = (typeof pkg.options?.record?.audio?.volume === 'number') ? pkg.options.record.audio.volume : 1;
                    fd.append('audio_volume', String(vol));
                }
                try { pkg.updateProgressBar({ progress: 0, message: 'Traitement serveur...' }); } catch(_) {}
                fetch(`${CONFIG.BASE_URL}/process_recorded_video`, { method: 'POST', body: fd })
                    .then(r => r.json())
                    .then(data => {
                        if (!data || !data.task_id) throw new Error(data && data.message ? data.message : 'Traitement serveur non démarré');
                        return pollTaskStatus(data.task_id, {
                            onProgress: (p, msg) => { try { pkg.updateProgressBar({ progress: p, message: msg || 'Traitement serveur...' }); } catch(_) {} }
                        });
                    })
                    .then(result => {
                        const file = result && result.file;
                        // Si téléchargement local demandé, récupérer le MP4 traité depuis le serveur
                        if (wantsDownload && file) {
                            try {
                                const a = document.createElement('a');
                                a.href = `${CONFIG.BASE_URL}/download_video/${encodeURIComponent(file)}`;
                                a.download = file;
                                document.body.appendChild(a);
                                a.click();
                                setTimeout(() => a.remove(), 1000);
                            } catch(e) { console.warn('Téléchargement du résultat échoué:', e); }
                        }
                        afterAll();
                        resolve();
                    })
                    .catch(reject);
            }).catch(reject);
        });

        processOnServer().catch((err) => {
            console.warn('Traitement serveur échoué, repli sur le pipeline navigateur:', err);
            try { pkg.showToast && pkg.showToast('Traitement serveur indisponible, repli local...', 'warning', 'Enregistrement', 4000); } catch(_) {}
            runClientFallback();
        });

    } catch(e) {
        console.error('Finalize MediaRecorder error:', e);
        try { pkg.closeModalLoading(); } catch(_) {}
    } finally {
        try { if (typeof mrOnFinalizeRestoreTimePerDay === 'function') { mrOnFinalizeRestoreTimePerDay(); } } catch(_) {}
        mrOnFinalizeRestoreTimePerDay = null;
        mrRecorder = null;
        mrRecordedChunks = [];
        mrOutCanvas = null;
        mrOutCtx = null;
        mrIsFinalizing = false;
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
            let safetyTimeout = null;

            const cleanup = () => {
                try { if (progressTimer) clearInterval(progressTimer); } catch(_) {}
                try { if (safetyTimeout) clearTimeout(safetyTimeout); } catch(_) {}
                try { URL.revokeObjectURL(url); } catch(_) {}
                try { rec && rec.state !== 'inactive' && rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                try { video.playbackRate = factor; } catch(_) {}
                // Les .webm de MediaRecorder rapportent souvent duration === Infinity :
                // ne pas le laisser fuiter dans setTimeout (Infinity → 0 → déclenchement immédiat).
                const rawDur = video.duration;
                const duration = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 0;

                const stream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                if (!stream) { cleanup(); reject(new Error('captureStream non supporté pour la normalisation')); return; }

                // Timeout basé sur la durée à 1x + 60s : couvre le cas où playbackRate échoue silencieusement
                const maxMs = duration > 0 ? (duration * 1000 + 60000) : 1800000; // 30 min de garde si durée inconnue
                safetyTimeout = setTimeout(() => {
                    safetyTimeout = null;
                    cleanup();
                    reject(new Error('Timeout normalisation vidéo (' + Math.round(maxMs / 1000) + 's) : lecture bloquée ?'));
                }, maxMs);

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
            let muxSafetyTimeout = null;

            const cleanup = () => {
                try { if (muxSafetyTimeout) clearTimeout(muxSafetyTimeout); } catch(_) {}
                try { URL.revokeObjectURL(videoUrl); } catch(_) {}
                try { if (audioUrl) URL.revokeObjectURL(audioUrl); } catch(_) {}
                try { if (audioCtx && audioCtx !== window.mrMuxAudioCtx) audioCtx.close(); } catch(_) {}
                try { if (rec && rec.state !== 'inactive') rec.stop(); } catch(_) {}
            };

            video.addEventListener('loadedmetadata', () => {
                try {
                    const vStream = (typeof video.captureStream === 'function') ? video.captureStream(fps) : null;
                    if (!vStream) { cleanup(); reject(new Error('captureStream non supporté pour mux audio')); return; }

                    // Timeout de sécurité : durée vidéo + 60s de marge.
                    // ATTENTION : les .webm issus de MediaRecorder rapportent souvent
                    // video.duration === Infinity (pas de cue de durée dans l'en-tête).
                    // Infinity passé à setTimeout est converti en 0 → déclenchement immédiat
                    // → le mux échouait toujours. On retombe donc sur un délai fixe généreux
                    // si la durée n'est pas finie ; l'arrêt normal se fait sur l'évènement 'ended'.
                    const rawDur = video.duration;
                    const duration = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 0;
                    const maxMs = duration > 0 ? (duration * 1000 + 60000) : 1800000; // 30 min de garde
                    muxSafetyTimeout = setTimeout(() => {
                        muxSafetyTimeout = null;
                        cleanup();
                        reject(new Error('Timeout mux audio (' + Math.round(maxMs / 1000) + 's) : lecture bloquée ?'));
                    }, maxMs);

                    // Charger et préparer le buffer audio
                    // (pas de sortie vers destination pour rester silencieux)
                    // Utiliser des promesses pour garantir l'ordre
                    Promise.resolve()
                        .then(() => loadAudioBuffer())
                        .then(() => {
                            // Composer flux (vidéo + piste audio)
                            const videoTracks = vStream.getVideoTracks();
                            if (videoTracks.length === 0) {
                                cleanup();
                                reject(new Error('Aucune piste vidéo disponible pour le mux audio'));
                                return;
                            }
                            const composed = new MediaStream([
                                ...videoTracks,
                                ...audioDest.stream.getAudioTracks()
                            ]);

                            // Debug: vérifier présence des pistes
                            try {
                                dbgMapgl('[MUX] tracks video:', vStream.getVideoTracks().length, 'audio:', audioDest.stream.getAudioTracks().length, 'mime:', muxMime);
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
                            try {
                                audioNode.start(0);
                            } catch(e) {
                                cleanup();
                                reject(new Error('Impossible de démarrer la piste audio : ' + e.message));
                                return;
                            }
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

// Mesure la durée réelle (en ms) d'un blob vidéo, même si l'en-tête WebM
// rapporte duration === Infinity (cas MediaRecorder). On utilise l'astuce
// du "seek vers la fin" qui force le navigateur à recalculer la vraie durée.
function getBlobDurationMs(blob){
    return new Promise((resolve) => {
        let settled = false;
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        const url = URL.createObjectURL(blob);
        const finish = (durSec) => {
            if (settled) return;
            settled = true;
            try { URL.revokeObjectURL(url); } catch(_) {}
            resolve((Number.isFinite(durSec) && durSec > 0) ? Math.round(durSec * 1000) : 0);
        };
        v.onloadedmetadata = () => {
            const d = v.duration;
            if (!Number.isFinite(d) || d <= 0) {
                // Forcer la résolution de la durée en cherchant très loin
                v.ontimeupdate = () => { v.ontimeupdate = null; finish(v.duration); };
                try { v.currentTime = 1e101; } catch(_) { finish(0); }
            } else {
                finish(d);
            }
        };
        v.onerror = () => finish(0);
        // Garde-fou si aucun évènement ne se déclenche
        setTimeout(() => finish(v.duration), 10000);
        v.src = url;
    });
}

// Réécrit l'en-tête WebM du blob final pour y inscrire la durée → les lecteurs
// affichent la durée et autorisent la navigation (seek). Renvoie le blob corrigé
// (ou l'original en cas d'échec ou de format non-WebM).
async function fixWebmFinalDuration(blob){
    try {
        if (!blob || !/webm/i.test(blob.type || '')) return blob;
        const durMs = await getBlobDurationMs(blob);
        if (durMs > 0) {
            const fixed = await fixWebmDuration(blob, durMs, { logger: false });
            dbgMapgl('[duration-fix] durée écrite:', durMs, 'ms');
            return fixed || blob;
        }
        console.warn('[duration-fix] durée non mesurable, blob inchangé');
    } catch(e) {
        console.warn('[duration-fix] échec, blob inchangé:', e);
    }
    return blob;
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
            // Timeout de sécurité : si rendercomplete ne se déclenche pas dans 5s,
            // on rejette la Promise pour éviter un blocage silencieux de la capture
            let renderCompleteListenerKey = null;
            const renderTimeout = setTimeout(() => {
                if (renderCompleteListenerKey) {
                    ol.Observable.unByKey(renderCompleteListenerKey);
                    renderCompleteListenerKey = null;
                }
                reject(new Error('Timeout rendercomplete (5s) : rendu carte bloqué'));
            }, 5000);

            // IMPORTANT : enregistrer le listener AVANT map.renderSync() car renderSync()
            // déclenche rendercomplete de façon synchrone. Si le listener est enregistré après,
            // il rate cet événement et la capture se fait sur un rendu ultérieur qui peut ne pas
            // inclure les calques d'animation (animationLayer) mis à jour.
            renderCompleteListenerKey = map.once('rendercomplete', async () => {
                clearTimeout(renderTimeout);
                renderCompleteListenerKey = null;
                try {
                    // Récupérer tous les canvas de la carte (carte + points WebGL + animations)
                    const viewport = map.getViewport();
                    const allCanvases = viewport.querySelectorAll('canvas');

                    if (allCanvases.length === 0) {
                        reject(new Error('Aucun canvas trouvé dans la carte'));
                        return;
                    }

                    // Dimensions en pixels device (dpr) pour éviter le flou HiDPI :
                    // les canvas de la carte sont rendus par OpenLayers en pixels device.
                    const rect = viewport.getBoundingClientRect();
                    const dpr = getCaptureDpr();
                    const canvasWidth = Math.max(1, Math.floor(rect.width * dpr));
                    const canvasHeight = Math.max(1, Math.floor(rect.height * dpr));

                    // Créer un canvas de sortie
                    // Pas de willReadFrequently : canvas jamais relu (uniquement composité puis toBlob).
                    // willReadFrequently:true forçait un backing store CPU → compositing lent.
                    const outCanvas = document.createElement('canvas');
                    outCanvas.width = canvasWidth;
                    outCanvas.height = canvasHeight;
                    const ctx = outCanvas.getContext('2d');

                    // Composer tous les canvas (carte + points WebGL + animations)
                    allCanvases.forEach(canvas => {
                        if (canvas.width > 0 && canvas.height > 0) {
                            ctx.drawImage(canvas, 0, 0, canvasWidth, canvasHeight);
                        }
                    });

                    // Ajouter les overlays (titre, date, nombre de caches) à l'échelle dpr
                    addOverlaysToCanvas(ctx, canvasWidth, canvasHeight, dpr);

                    // Convertir en WebP Blob puis uploader SANS bloquer la capture suivante.
                    // L'upload est mis en file (concurrence bornée) et la Promise se résout
                    // dès que la frame est prête → capture et upload se recouvrent (pipeline).
                    outCanvas.toBlob(async (blob) => {
                        if (!blob) {
                            reject(new Error('Échec conversion canvas en blob'));
                            return;
                        }

                        // Mesurer le temps de capture
                        perfMetrics.captureTimeMs += performance.now() - perfMetrics.lastCaptureStart;
                        perfMetrics.capturedFrames += 1;
                        perfMetrics.totalFrames += 1;

                        try {
                            // Backpressure : attend un créneau si trop d'uploads en vol,
                            // et remonte une éventuelle erreur d'upload déjà survenue.
                            await awaitUploadSlot();
                        } catch (e) { reject(e); return; }

                        // Upload en tâche de fond (ne bloque pas la frame suivante)
                        enqueueImageUpload(blob, imageCounter++);

                        // Surveillance des performances (temps de capture seul, upload désormais async)
                        try {
                            const totalCaptureTime = performance.now() - captureStart;
                            const expectedFrameTime = pkg.options?.animation?.timePerDay || 100;
                            recordingPerformanceMonitor.checkPerformance(totalCaptureTime, expectedFrameTime, 'images');
                        } catch(e) {}

                        try { updateProgress(); } catch(e) {}
                        resolve();
                    }, 'image/webp', 0.9);
                } catch (error) {
                    reject(error);
                }
            });

            // Forcer un rendu complet (marquer animationLayer dirty pour que postrender fire)
            if (animationLayer) { animationLayer.changed(); }
            map.renderSync();

        } catch (error) {
            console.warn('Canvas-only a échoué, fallback vers html2canvas:', error.message);

            // Fallback vers html2canvas avec options optimisées. Chargé à la demande
            // (cf. loadHtml2Canvas) : le préchargement lancé par startRecordingProcess()
            // a normalement déjà résolu à ce stade ; s'il ne l'a pas encore fait (tout
            // premier fallback d'une session, réseau lent), on attend simplement ici.
            loadHtml2Canvas().then(() => {
                const canvasOptions = {
                    backgroundColor: '#ffffff',
                    scale: 1,
                    useCORS: true,
                    allowTaint: false,
                    width: element.offsetWidth,
                    height: element.offsetHeight,
                    logging: false
                };

                return html2canvas(element, canvasOptions)
                .then(canvas => {
                    perfMetrics.captureTimeMs += performance.now() - perfMetrics.lastCaptureStart;
                    perfMetrics.capturedFrames += 1;
                    perfMetrics.totalFrames += 1;

                    // toBlob() est callback-based : on le wrappe dans une Promise. L'upload
                    // est découplé (file bornée) comme dans le chemin principal.
                    return new Promise((resBlob, rejBlob) => {
                        canvas.toBlob(async (blob) => {
                            if (!blob) { rejBlob(new Error('html2canvas toBlob a retourné null')); return; }
                            try { await awaitUploadSlot(); } catch(e) { rejBlob(e); return; }
                            enqueueImageUpload(blob, imageCounter++);
                            try { updateProgress(); } catch(e) {}
                            resBlob();
                        }, 'image/webp', 0.9);
                    });
                })
                .then(() => resolve())
                .catch(fallbackError => {
                    console.error('html2canvas a aussi échoué:', fallbackError);
                    reject(fallbackError);
                });
            }).catch(() => {
                // Échec de chargement de html2canvas : impossible de tenter le repli,
                // on rejette avec l'erreur d'origine (comportement identique à l'ancien
                // cas "typeof html2canvas === 'undefined'").
                reject(error);
            });
        }
    });
}

// Précalcule les propriétés statiques d'un overlay (styles CSS, position, shadow, font)
// pour éviter getElementById/getBoundingClientRect/getComputedStyle à chaque frame.
// Appelé une seule fois au démarrage de chaque session d'enregistrement.
function buildOverlayCache(scaleFactor) {
    overlayCache = null;
    const container = document.getElementById('mapWithFrames');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    const cacheElement = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        const x = Math.round((rect.left - containerRect.left) * scaleFactor);
        const y = Math.round((rect.top - containerRect.top) * scaleFactor);
        const w = Math.round(rect.width * scaleFactor);
        const h = Math.round(rect.height * scaleFactor);

        const bg = style.backgroundColor || 'rgba(255,255,255,1)';
        const color = style.color || '#000';
        const radius = parseFloat(style.borderRadius) || 0;
        const padL = (parseFloat(style.paddingLeft) || 0) * scaleFactor;
        const padR = (parseFloat(style.paddingRight) || 0) * scaleFactor;
        const padT = (parseFloat(style.paddingTop) || 0) * scaleFactor;
        const fontSizePx = parseFloat(style.fontSize) || 16;
        const font = `${style.fontWeight || 'normal'} ${Math.round(fontSizePx * scaleFactor)}px ${style.fontFamily || 'Arial'}`;
        const textAlignCss = style.textAlign || 'left';

        const shadowRaw = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : null;
        let shColor = 'rgba(0,0,0,0)', shBlur = 0, shOffX = 0, shOffY = 0;
        if (shadowRaw) {
            const parts = shadowRaw.match(/(rgba?\([^\)]+\))\s+([-0-9.]+)px\s+([-0-9.]+)px\s+([-0-9.]+)px/);
            if (parts) {
                shColor = parts[1];
                shOffX = parseFloat(parts[2]) * scaleFactor;
                shOffY = parseFloat(parts[3]) * scaleFactor;
                shBlur = parseFloat(parts[4]) * scaleFactor;
            }
        }

        const padB = (parseFloat(style.paddingBottom) || 0) * scaleFactor;
        const fontPx = Math.round(fontSizePx * scaleFactor);
        const lineHeightCss = parseFloat(style.lineHeight);

        // Bordure (uniforme : on se base sur le côté haut)
        const borderW = (parseFloat(style.borderTopWidth) || 0) * scaleFactor;
        const borderStyle = style.borderTopStyle || 'none';
        const borderColor = style.borderTopColor || 'rgba(0,0,0,0)';
        const hasBorder = borderW > 0 && borderStyle !== 'none';

        return {
            el, x, y, w, h, bg, color, radius, padL, padR: (parseFloat(style.paddingRight) || 0) * scaleFactor,
            padT, padB, font, fontPx, textAlignCss, hasShadow: !!shadowRaw,
            shColor, shBlur, shOffX, shOffY,
            hasBorder, borderW, borderColor,
            lineGap: Math.round((Number.isFinite(lineHeightCss) ? lineHeightCss : fontSizePx * 1.2) * scaleFactor),
        };
    };

    overlayCache = {
        scaleFactor,
        titleOn: !!(pkg.options?.infos?.title?.display),
        title: cacheElement('titleFrame'),
        infos: cacheElement('infosFrame'),
    };
}

// Ajoute les overlays (titre, date, nb caches) au canvas d'enregistrement.
// Les propriétés statiques (styles CSS, positions) sont lues depuis overlayCache
// pour éviter des reflows à chaque frame. Seuls display et textContent sont lus en direct.
function addOverlaysToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor = 1) {
    if (!overlayCache || overlayCache.scaleFactor !== scaleFactor) {
        buildOverlayCache(scaleFactor);
    }
    if (!overlayCache) return;

    try {
        const renderFromCache = (cached, getText) => {
            if (!cached || !cached.el || cached.el.style.display === 'none') return;
            const text = getText();
            if (!text || !text.trim()) return;

            const { x, y, w, h, bg, color, radius, padL, padR, padT, padB, font, fontPx, textAlignCss,
                    hasShadow, shColor, shBlur, shOffX, shOffY, lineGap,
                    hasBorder, borderW, borderColor } = cached;

            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.font = font;
            ctx.textBaseline = 'alphabetic';

            const lines = Array.isArray(text) ? text : [String(text)];

            // Mesurer le texte pour adapter la boîte (le contenu grandit pendant l'animation :
            // compteur de caches, dates plus longues...). La largeur cachée du DOM correspond
            // au texte initial court et provoquerait un débordement.
            let maxTextW = 0;
            for (const line of lines) {
                if (!line) continue;
                const m = ctx.measureText(line);
                if (m.width > maxTextW) maxTextW = m.width;
            }
            // Métriques verticales (fallback si actualBoundingBox non disponible)
            const fm = ctx.measureText('Mg');
            const ascent = fm.actualBoundingBoxAscent || (fontPx * 0.8);
            const descent = fm.actualBoundingBoxDescent || (fontPx * 0.2);
            const lh = Math.max(lineGap, ascent + descent);
            const textBlockH = ascent + descent + (lines.length - 1) * lh;

            // La boîte ne rétrécit jamais sous la taille CSS, mais grandit pour contenir le texte
            const drawW = Math.max(w, Math.ceil(padL + maxTextW + padR));
            const drawH = Math.max(h, Math.ceil(padT + textBlockH + padB));

            if (hasShadow) { ctx.shadowColor = shColor; ctx.shadowBlur = shBlur; ctx.shadowOffsetX = shOffX; ctx.shadowOffsetY = shOffY; }
            drawRoundedRect(ctx, x, y, drawW, drawH, radius, bg,
                            hasBorder ? borderColor : null, hasBorder ? borderW : 0);
            ctx.shadowColor = 'rgba(0,0,0,0)';

            ctx.fillStyle = color;
            if (textAlignCss === 'center') ctx.textAlign = 'center';
            else if (textAlignCss === 'right' || textAlignCss === 'end') ctx.textAlign = 'right';
            else ctx.textAlign = 'left';

            // Centrer verticalement le bloc de texte dans la boîte
            let curY = y + (drawH - textBlockH) / 2 + ascent;
            lines.forEach(line => {
                if (!line) { curY += lh; return; }
                let xText = x + padL;
                if (ctx.textAlign === 'center') xText = x + (drawW / 2);
                else if (ctx.textAlign === 'right') xText = x + drawW - padR;
                ctx.fillText(line, xText, curY);
                curY += lh;
            });
            ctx.restore();
        };

        if (overlayCache.titleOn) {
            renderFromCache(overlayCache.title, () => overlayCache.title?.el?.textContent || '');
        }
        renderFromCache(overlayCache.infos, () => (overlayCache.infos?.el?.textContent || overlayCache.infos?.el?.innerText || '').trim());

    } catch (error) {
        console.warn('Erreur lors du rendu des overlays:', error);
    }
}

function roundedRectPath(ctx, x, y, width, height, radius) {
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
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle, strokeStyle = null, lineWidth = 0) {
    roundedRectPath(ctx, x, y, width, height, radius);
    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }

    if (strokeStyle && lineWidth > 0) {
        // La bordure CSS est dessinée à l'intérieur de la border-box : on trace le contour
        // en retrait d'une demi-épaisseur pour que le trait reste dans la boîte.
        const inset = lineWidth / 2;
        // Pas d'ombre sur le trait de bordure (l'ombre vient déjà du fond)
        ctx.shadowColor = 'rgba(0,0,0,0)';
        roundedRectPath(ctx, x + inset, y + inset, width - lineWidth, height - lineWidth, Math.max(0, radius - inset));
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeStyle;
        ctx.stroke();
    }
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
    const flashOptions = pkg.options.flash;
    const maxFrames = Math.max(1, pkg.options.record.flashFrames || 1);
    // Capturer la valeur de globalRecordFrame au moment de l'appel (frame de départ du flash)
    const startFrame = globalRecordFrame;


    features.forEach(featureData => {
        const coords = ol.proj.fromLonLat([
            featureData.geometry.coordinates[0],
            featureData.geometry.coordinates[1]
        ]);
        const flashGeom = new ol.geom.Point(coords);
        const cacheType = featureData.properties?.cache_type;

        const listenerKey = animationLayer.on('postrender', function(event) {
            // elapsed = nombre de captures depuis le début de ce flash
            const elapsed = globalRecordFrame - startFrame;

            if (elapsed >= maxFrames) {
                ol.Observable.unByKey(listenerKey);
                return;
            }
            const animationRatio = elapsed / maxFrames;
            const radius = ol.easing.easeOut(animationRatio) * (flashOptions.size / 2) + (flashOptions.size / 10);
            const opacity = ol.easing.easeOut(1 - animationRatio);
            let style;
            switch (flashOptions.mode) {
                case "star":     style = starStyle(radius, opacity, flashOptions, cacheType);     break;
                case "sparkle":  style = sparkleStyle(radius, opacity, flashOptions, cacheType);  break;
                case "circle":   style = circleStyle(radius, opacity, flashOptions, cacheType);   break;
                case "square":   style = squareStyle(radius, opacity, flashOptions, cacheType);   break;
                case "triangle": style = triangleStyle(radius, opacity, flashOptions, cacheType); break;
                case "diamond":  style = diamondStyle(radius, opacity, flashOptions, cacheType);  break;
                default:         style = circleStyle(radius, opacity, flashOptions, cacheType);   break;
            }
            if (style) {
                const vectorContext = ol.render.getVectorContext(event);
                vectorContext.setStyle(style);
                vectorContext.drawGeometry(flashGeom);
            }
        });
    });
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
            switch (pkg.options.flash.mode) {
                case "star":
                    style = starStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                case "sparkle":
                    style = sparkleStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                case "circle":
                    style = circleStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                case "square":
                    style = squareStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                case "triangle":
                    style = triangleStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                case "diamond":
                    style = diamondStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
                default:
                    style = circleStyle(radius, opacity, pkg.options.flash, cacheType);
                    break;
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
            case "sparkle":
                style = sparkleStyle(radius, opacity, flashOptions, cacheType);
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
            // En capture MediaRecorder, la boucle de dessin (renderSync @fps) pilote déjà
            // les rendus : se re-planifier ici via map.render() doublerait (voire pire, en
            // rafale rAF) le rendu par frame → saccades. On ne le fait qu'en lecture live.
            if (!isMediaRecording) {
                map.render();
            }
        }
    }
}


function createFlashElements(){
    if (animationLayer) {
        map.removeLayer(animationLayer);
    }
    animationSource = new ol.source.Vector();
    animationLayer = new ol.layer.Vector({
        source: animationSource,
        style: null,
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
        if (gcColor) {
            const rgb = pkg.hexToRgb(gcColor);
            color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
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

// Scintillement : étoile fine à 4 branches avec un éclat blanc, pour un effet
// d'étincelle qui brille à l'apparition du point. Utilise les mêmes réglages que
// les autres flashs (taille, durée, couleur).
export function sparkleStyle(radius, opacity, flashOptions, cacheType = null){
    let color;

    // Déterminer la couleur selon le type sélectionné (même logique que les autres flashs)
    if (flashOptions.color_type === 'gc' && cacheType && defaultGcColors) {
        const gcColor = defaultGcColors[cacheType];
        if (gcColor) {
            if (gcColor.startsWith('#')) {
                const rgb = pkg.hexToRgb(gcColor);
                color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
            } else {
                color = gcColor;
            }
        } else {
            color = `rgba(128, 128, 128, ${opacity})`;
        }
    } else if (flashOptions.color_type === 'none') {
        color = `rgba(0, 0, 0, 0)`;
    } else {
        color = `rgba(${flashOptions.rgb.r}, ${flashOptions.rgb.g}, ${flashOptions.rgb.b}, ${opacity})`;
    }

    const style = new ol.style.Style({
        image: new ol.style.RegularShape({
            points: 4,                 // 4 branches = forme d'étincelle
            radius: radius,            // rayon extérieur (pointe des branches)
            radius2: radius * 0.18,    // rayon intérieur faible = branches fines et pointues
            angle: 0,
            fill: new ol.style.Fill({
                color: color,
            }),
            stroke: new ol.style.Stroke({
                color: `rgba(255, 255, 255, ${opacity})`, // éclat blanc lumineux
                width: 1.5,
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
