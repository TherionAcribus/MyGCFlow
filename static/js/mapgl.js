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
import {
    automaticEndHoldMs,
    buildImageTimingPlan,
    clampPlaybackRate,
    framesForDay,
    inclusiveDayCount,
    serverNormalizationFactor,
    splitCameraBudget,
} from './video_timing.mjs';
import {
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
} from './recording_settings.mjs';
import { createMapDirtyTracker } from './map_dirty.mjs';
// Fonds de carte extraits dans basemaps.js. `olMap` est importé sous le nom
// `map` : c'est une liaison vivante d'ES modules, donc l'affectation faite par
// createMap() côté basemaps.js est visible ici sans accesseur.
import { olMap as map, resetTileErrorCount, warnIfTileErrors } from './basemaps.js';
import { perfMetrics, recordingPerformanceMonitor, resetPerfMetrics } from './recording_perf.js';
import {
    awaitAllUploads,
    awaitUploadSlot,
    enqueueImageUpload,
    resetUploadQueue,
} from './upload_queue.js';
import {
    setBackgroundAudioBlocked,
    startBackgroundMusicIfAny,
    pauseBackgroundMusic,
    resumeBackgroundMusic,
    stopBackgroundMusic,
} from './background_audio.js';
import {
    fixWebmFinalDuration,
    muxRecordedVideoWithAudio,
    normalizeRecordedVideoSpeed,
} from './video_postprocess.js';
import {
    addOverlaysToCanvas,
    buildOverlayCache,
    getOverlayCacheRevision,
    getOverlayTextContent,
} from './overlay_canvas.js';
import { buildPointStyle } from './point_webgl_style.js';
import { createAppearClock, POINT_APPEAR_MS, STATIC_APPEAR } from './point_appear.mjs';
import { EVO_FILTER, EVO_STATIC_FROM, POINT_DISAPPEAR_MS } from './evolution_style.mjs';
import { isEvolutionPage } from './app_mode.mjs';
import { CAPTURE_IMAGE_QUALITY, CAPTURE_IMAGE_TYPE } from './capture_image_format.mjs';
import { captureRatioFor } from './capture_resolution.mjs';
import { normalizeColorFidelity } from './color_fidelity.mjs';
import {
    centroid,
    clampToExtent,
    createCameraJourney,
    createCameraPacing,
    INTENSE_EXTRA_ZOOM_OUT,
    normalizeCameraDynamism,
    pacedDayMs,
    sampleCameraJourney,
    shouldMoveCamera,
    simulateCameraJourneys,
} from './camera_follow.mjs';
import { dateToDayNumber, dayNumberToDate } from './evolution_timeline.mjs';
import {
    buildTrailPath,
    buildTrailRoute,
    composeTransform,
    lengthAtDay,
    nextDayIndex,
    normalizeTrailOptions,
    opacityBucket,
    penLengthAt,
    pointAtLength,
    scheduleStroke,
    SEGMENT_HIDDEN,
    SEGMENT_JUMP_DASHED,
    splitTrailRuns,
    TRAIL_DEFAULTS,
    trailOpacity,
    visibleVertexRange,
} from './travel_trail.mjs';
import { flashStyleAt } from './flash_styles.js';
import { liveFlashStep } from './flash_style_cache.mjs';
import { IMPULSE_MAX_STAGGER_MS, staggerDelayFrames, staggerDelayMs } from './flash_impulse.mjs';
import { COUNTER_ANIMATION_MS, createCountAnimator } from './overlay_counter.mjs';
import { renderInfosTemplate } from './infos_template.mjs';
import { fetchWithTimeout, FETCH_TIMEOUTS } from './fetch_with_timeout.mjs';
import { createPausableTimeout } from './pausable_timer.mjs';
import { createVideoStream } from './video_stream.mjs';

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
// Servi en local (static/js/vendor/) plutôt que depuis cdnjs : ce repli d'enregistrement
// ne doit pas dépendre de la disponibilité d'un tiers externe au moment précis où on
// en a besoin.
let html2canvasLoadPromise = null;
function loadHtml2Canvas() {
    if (typeof html2canvas !== 'undefined') return Promise.resolve();
    if (html2canvasLoadPromise) return html2canvasLoadPromise;
    html2canvasLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${CONFIG.BASE_URL}/static/js/vendor/html2canvas.min.js`;
        script.onload = () => resolve();
        script.onerror = () => {
            // Échec de chargement : on remet à null pour permettre un nouvel essai
            // lors d'un prochain enregistrement, plutôt que de rester bloqué en échec.
            html2canvasLoadPromise = null;
            reject(new Error(pkg.t('Impossible de charger html2canvas')));
        };
        document.head.appendChild(script);
    });
    return html2canvasLoadPromise;
}

// couche de points
let vectorLayer;
let features;
// Mode Évolution : vrai tant que la source contient toutes les caches filtrées
// (elles y restent en permanence ; seul le style décide de leur visibilité).
let evolutionPointsLoaded = false;
// Popup d'information (overlay)
let popupOverlay;
let popupEl;
// ANIMATION
// date en cours pour l'animation
let currentDate;
// ENREGISTREMENT
// Compteur de frames pour le jour en cours
let currentFrame = 0;
let globalRecordFrame = 0;  // avance d'1 par capture (pas par rendu)
let infosProgressBar = new Object;
// TEMP
export let framesPerDay = 30;  
let imageCounter = 0;
// Identifiant de la session de capture en cours (mode images). Chaque
// enregistrement écrit ses frames dans captured/<sessionId>/ : un upload tardif
// de la session précédente atterrit dans son propre dossier au lieu de se
// mélanger aux images de la nouvelle (les lots déjà partis ne s'annulent pas).
let captureSessionId = null;
let recordingDayIndex = 0;
let recordingDayCount = 1;
let recordingBaseFrameCount = 1;
let currentDayFrameTarget = 1;
// FLASH
let animationSource;
let animationLayer;
// Flashs en cours, tous dessinés par l'unique listener postrender de
// animationLayer (drawActiveFlashes) plutôt que par un listener chacun.
let activeFlashes = [];

// Boucle de prévisualisation (startAnimation/pauseAnimation/stopAnimation) pilotée
// par requestAnimationFrame + accumulateur de temps plutôt que setInterval : un
// setInterval dont le délai est plus court que le temps de rendu d'un jour (frame
// dense, onglet en arrière-plan, etc.) empile ses callbacks et les décharge en
// rafale dès que le thread se libère, ce qui saccade l'animation. rAF ne peut pas
// s'empiler (un seul callback par frame de rendu) et l'accumulateur rattrape au
// plus MAX_DAYS_PER_FRAME jours à la fois, donc jamais de rafale.
//
// Ce plafond ne peut pas valoir 1 : à 60 Hz l'animation serait bloquée à 60
// jours/s, alors qu'un timePerDay court en demande davantage (10 ms/jour = 100
// jours/s). L'animation dériverait et durerait plus longtemps que configuré.
// 4 jours/frame couvre jusqu'à ~240 jours/s tout en bornant le travail d'une
// frame ; les jours rattrapés sont agrégés en un seul addFeatures.
const MAX_DAYS_PER_FRAME = 4;
// Mode Évolution : un jour ne coûte que ses flashs (aucun point n'est ajouté à
// la source), et des décennies doivent tenir en quelques secondes : une vidéo
// de 10 s sur 25 ans demande ~1 300 jours/s. Le plafond reste large pour tenir
// ce rythme même quand le rendu tombe à 15-20 images/s (grosse base, machine
// modeste) ; il ne sert qu'à éviter une rafale au retour d'un onglet masqué.
const EVOLUTION_MAX_DAYS_PER_FRAME = 120;
let animationRafId = null;
let animationLastTs = null;
let animationAccMs = 0;
let animationDatesComplete = false;
// Vrai entre le démarrage d'une animation de prévisualisation et sa fin réelle
// (arrêt manuel ou dernier jour atteint). Reste vrai pendant une pause, où
// animationRafId est remis à null alors que la carte n'affiche toujours qu'une
// partie des points : c'est ce que animationRafId seul ne permet pas de savoir.
let animationInProgress = false;
// Maintien de fin d'animation (extraEndSeconds). Suspendable : pendant une pause
// « onglet masqué » de l'enregistrement MediaRecorder, un setTimeout ordinaire
// finirait par se déclencher (les timers d'arrière-plan restent bridés mais non
// bloqués) et arrêterait la capture au milieu de la pause.
const endHoldTimer = createPausableTimeout(() => finalizeAnimationEnd());
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
// Filet de sécurité (durée théorique très généreuse) : suspendable, sinon il
// finirait par se déclencher pendant une pause « onglet masqué » et arrêterait
// l'enregistrement alors que tout va bien.
const mrSafetyTimer = createPausableTimeout(() => {
    if (isMediaRecording) {
        console.warn('[MediaRecorder] Arrêt par filet de sécurité (fin d\'animation non détectée)');
        stopMediaRecorderPipeline(true);
    }
});
// Arrêt réel piloté par la fin d'animation + tail freeze : suspendable pour la
// même raison (le gel ne doit pas s'écouler pendant que rien n'est enregistré).
const mrTailTimer = createPausableTimeout(() => {
    if (isMediaRecording) stopMediaRecorderPipeline(true);
});
let mrTailMs = 3000;             // durée du gel de la dernière frame après la fin d'animation
// Horloge « temps actif » du pipeline MediaRecorder : exclut les pauses d'onglet
// masqué. mrStartedAtTs = performance.now() au démarrage ; mrPausedSince borne
// la pause en cours ; mrPausedTotalMs cumule les pauses terminées.
let mrStartedAtTs = 0;
let mrPausedSince = null;
let mrPausedTotalMs = 0;
// Facteur de ralentissement réellement appliqué à la timeline au démarrage. La
// préférence peut être modifiée en cours de route (moniteur de performance) :
// la normalisation finale doit utiliser le facteur qui a gouverné la capture.
let mrAppliedSlowdown = 1;
let isMediaRecording = false;
let mrIsFinalizing = false;
// Flux de délestage mémoire : les fragments .webm partent vers le serveur au
// fil de l'eau au lieu de s'accumuler dans mrRecordedChunks. null si le flux
// n'a pas pu s'ouvrir (repli : accumulation en mémoire comme avant).
let mrVideoStream = null;
let mrOnFinalizeRestoreTimePerDay = null;
// Paramètres du compositing MR conservés au niveau module pour pouvoir relancer
// la boucle de dessin après une mise en pause (onglet masqué, cf. C8).
let mrDrawParams = null;
// Suivi « carte sale » : évite un renderSync() + une recomposition complète pour
// des frames strictement identiques (cas courant dès que timePerDay > 1/fps).
// Alimenté par displayFeaturesForDates, les flashs et les rendus naturels d'OL.
const mapDirtyTracker = createMapDirtyTracker();
// Apparition animée des points (voir point_appear.mjs). L'objet des variables de
// style est partagé par référence avec le layer WebGLPoints, qui relit 'now' à
// chaque rendu : le mettre à jour ne demande ni changed() ni nouveau style.
const pointAppearClock = createAppearClock();
// Pause de lecture (bouton Pause) : le temps « live » de l'horloge des points
// est figé tant que livePausedAt est posé ; à la reprise, la pause écoulée est
// accumulée dans livePauseOffsetMs pour que les animations reprennent sans
// rattraper le temps passé en pause. Sans effet sur les sources 'frames' et
// 'mediarecorder' (enregistrement, où la pause n'existe pas).
let livePausedAt = null;
let livePauseOffsetMs = 0;
// glowMs : durée de la fenêtre de persistance des points récents, en temps
// d'animation. Toujours >= 1, les expressions de style divisant par elle.
// Les variables evo* pilotent le mode Évolution (voir evolution_style.mjs) :
// elles doivent exister dès la création du layer, une variable absente
// donnant un uniform indéfini au shader.
const pointStyleVariables = {
    now: 0,
    glowMs: 1,
    evoDay: 0,
    evoIntraMs: 0,
    evoFrom: EVO_STATIC_FROM,
    evoMsPerDay: 1,
    evoStagger: 0,
};
let pointsAppearUntil = 0;       // fin de la dernière apparition en cours (horloge)
let pointsAppearing = false;     // compte comme une animation pour mapDirtyTracker
let pointsGlowing = false;       // persistance active : la carte change à chaque frame
// Suivi de caméra (voir camera_follow.mjs) : cible = barycentre des caches du
// jour, étendue = celle de toutes les caches affichées, horloge = celle des points.
let cameraTarget = null;
let cameraExtent = null;
let cameraInteractionKey = null;
let cameraTravelPending = false;
let cameraJourney = null;
let cameraJourneyStartedAt = null;
let cameraRenderPending = false;
let cameraRenderKey = null;
let cameraRenderTimeout = null;
let cameraDynamism = 2;
const CAMERA_RENDER_TIMEOUT_MS = 6000;
// Durée imposée (rythme « Par durée » ou « Sur la musique ») : les trajets sont
// simulés au lancement, puis chaque date reçoit le temps qui permet de finir à
// l'heure (cf. prepareCameraPacing). null quand les trajets s'ajoutent librement.
let cameraPacing = null;
// Temps écoulé et avancement de l'animation en cours, pour ce calcul.
let cameraPacingState = { elapsedMs: 0, travelSpentMs: 0, dayIndex: 0, travelFrames: 0, retarget: false };
// Facteur appliqué à la durée des trajets : accélération pour tenir la durée
// imposée, multipliée par le ralentissement éventuel de la capture rapide.
let cameraDurationScale = 1;
// Dernière simulation des trajets, resservie pendant qu'une animation tourne
// (la vue est alors en plein déplacement : la simuler n'aurait aucun sens).
let lastCameraTravelEstimate = null;
// Delta maximal compté par frame dans le temps écoulé : un onglet revenu au
// premier plan ne doit pas faire croire à plusieurs secondes d'animation.
const CAMERA_PACING_MAX_STEP_MS = 1000;
// Traits de déplacement (voir travel_trail.mjs) : couche sous les points,
// trajet précalculé au lancement et mémoïsé, stylo piloté par l'horloge des
// points (déterministe en capture image par image).
let trailLayer = null;          // le trait, sous les points
let trailHeadLayer = null;      // la tête du trait, au-dessus des points
// var et non let : initUIElements (ui.js) s'exécute pendant l'évaluation des
// modules, alors que mapgl n'a pas encore fini la sienne (import circulaire
// via index.js). Les fonctions exportées ci-dessous, déjà hissées, peuvent
// donc être appelées avant cette ligne : var est initialisé à undefined dès
// l'instanciation, ce qui évite la zone morte (TDZ) d'un let.
var trailGeometry = null;       // { key, route, path, buildMs } — trajet mémoïsé
let trailState = null;          // animation en cours (voir resetTravelTrail)
// Aperçu statique du trajet calculé (bouton « Aperçu du trajet » de l'onglet
// Trajet) : { route, path } mémoïsés, dessinés à pleine opacité hors animation.
var trailPreview = null;
let trailAnimating = false;     // compte comme une animation pour mapDirtyTracker
let trailDrawnVertices = 0;     // sommets dessinés à la dernière frame (tests)
// Maximums dessinés depuis le dernier lancement (tests, diagnostic) : gardés
// après l'arrêt, pour vérifier après coup un enregistrement image par image.
let trailDrawnMax = { vertices: 0, length: 0 };
let trailLastDrawMs = null;     // durée du dernier dessin du trait (mesure)
// Durée appliquée au dernier tracé planifié : conservée après l'arrêt comme
// trailDrawnMax, pour vérifier après coup un enregistrement image par image.
let trailLastStrokeDurationMs = null;
// Compteur de caches animé : la valeur affichée rejoint le total du jour au lieu
// de sauter. Piloté par la même horloge que les points, donc déterministe en
// enregistrement image par image.
const cacheCountAnimator = createCountAnimator();
// Mode Évolution : les trois grandeurs de la ligne d'infos à balises
// (actives présentes, cumuls placées/archivées) sont animées chacune.
const evolutionCounters = {
    actives: createCountAnimator(),
    placees: createCountAnimator(),
    archivees: createCountAnimator(),
};
let displayedCacheCount = null;
let pointAppearListenerKey = null;
// Garde : true pendant nos propres renderSync de compositing (cf. mrPostrenderKey).
let mrOwnRender = false;
let mrPostrenderKey = null;
// Canvas de sortie du mode images, réutilisé entre frames (P4) : le recréer à
// chaque frame générait une pression GC inutile. Réutilisation sûre car la capture
// est strictement séquentielle (toBlob résout avant la frame suivante).
let imgOutCanvas = null;
let imgOutCtx = null;
// Garde « onglet masqué » (C8) : handlers visibilitychange + toast d'avertissement.
let mrVisibilityHandler = null;
let mrVisibilityToast = null;
let captureVisibilityHandler = null;
let captureVisibilityToast = null;


// Consulté par basemaps.js (suivi des erreurs de tuiles) : pendant une capture,
// on n'interrompt pas l'utilisateur avec un toast.
export function isRecordingActive() {
    return isRecording || isMediaRecording;
}




// Fonction pour ajouter les données GeoJSON à la source vectorielle au chargement du GeoJSON
export function addVector(data) {
    // Le trajet affiché (animation ou simple aperçu) décrivait l'ancienne
    // sélection.
    clearTravelTrail();
    clearTrailPreview();
    clearFlashPreview();
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

    displayWebGLPoints(features || [], pkg.options.point);
}

// fonction appelée au changement d'options graphique
export function refreshPoints(){
    // Un changement de style ne doit jamais changer QUELS points sont visibles.
    // Pendant une animation (en cours, en pause ou en enregistrement), la carte
    // n'affiche que les points déjà « sortis » : repartir de `features` ferait
    // surgir d'un coup toute la base. On reprend donc le contenu courant de la
    // source, capturé avant clearMap() — lequel reste indispensable car un layer
    // WebGLPoints ignore tout nouveau style tant qu'il n'est pas recréé.
    // Hors animation, la source contient déjà tous les points affichés ; on garde
    // `features` en repli si elle est vide (source pas encore alimentée).
    let toDisplay = features || [];
    if (!isEvolutionPage() && isAnimationInProgress() && window.vectorSource) {
        toDisplay = window.vectorSource.getFeatures();
    }

    // Toast seulement s'il y a des points à redessiner : le thème appliqué au
    // démarrage passe ici avant le chargement de la base, et le toast n'y
    // annonçait rien (il se superposait en outre à celui d'un import lancé
    // aussitôt).
    if (toDisplay.length > 0) {
        const title = pkg.t ? pkg.t('Affichage des points') : 'Affichage des points';
        const message = pkg.t ? pkg.t('Mise à jour de l\'affichage des points...') : 'Mise à jour de l\'affichage des points...';
        pkg.showPointsToast(message, title);

        // Masquer automatiquement après 1.5 secondes
        setTimeout(() => {
            pkg.hidePointsToast();
        }, 1500);
    }

    clearMap();
    displayWebGLPoints(toDisplay, pkg.options.point);
}


// recherche une couche en particulier sur la carte
function isLayerOnMap(map, layerToFind) {
    const layers = map.getLayers().getArray();
    return layers.includes(layerToFind);
}

// Vrai tant qu'une animation n'a pas déroulé toutes ses dates : lecture en cours,
// lecture en pause, ou enregistrement (images ou MediaRecorder). Dans ces états,
// la carte n'affiche qu'un sous-ensemble des points.
export function isAnimationInProgress(){
    return !!animationInProgress || !!isRecording || !!isMediaRecording;
}

// Détermine si l'application est au repos (ni animation, ni enregistrement en cours)
function isIdleState(){
    try {
        const isAnimating = !!animationRafId; // boucle rAF active => animation en cours
        const rec = !!isRecording || !!isMediaRecording; // enregistrement en cours
        return !isAnimating && !rec;
    } catch(_) { return true; }
}

// Distance de capture d'une étape, en pixels écran, pour l'inspection au clic.
const TRAIL_PICK_PX = 12;

// En aperçu du trajet, ouvre la popup sur l'étape la plus proche du clic si
// elle est à portée : date de l'étape et nombre de caches qu'elle regroupe.
// Retourne vrai si une étape a été trouvée (popup affichée).
// NOTE : concaténation plutôt que gabarit `${}` — le lexer Babel qui extrait
// les chaînes t() se désynchronise sur les gabarits imbriqués (comme celui du
// popup cache plus bas) ; rester en code simple garantit l'extraction.
function inspectTrailStopAt(pixel, coordinate) {
    // Le trailState anime déjà la carte : l'aperçu est alors masqué.
    if (!trailPreview || trailState || !map) return false;
    const { route, path } = trailPreview;
    let best = -1;
    let bestD2 = TRAIL_PICK_PX * TRAIL_PICK_PX;
    for (let i = 0; i < route.lon.length; i++) {
        const v = path.stopVertex[i];
        const p = map.getPixelFromCoordinate([path.xy[2 * v], path.xy[2 * v + 1]]);
        if (!p) continue;
        const dx = p[0] - pixel[0];
        const dy = p[1] - pixel[1];
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
            bestD2 = d2;
            best = i;
        }
    }
    if (best < 0) return false;

    const t = pkg.t || ((s) => s);
    const count = route.stopSize?.[best] || 1;
    const sizeLabel = count > 1
        ? t('${count} caches regroupées', { count })
        : t('1 cache');
    const date = dayNumberToDate(route.day[best]);
    const dateLabel = pkg.formatDateDisplay?.(date) || '';
    const titleLabel = t('Étape ${index} sur ${total}', { index: best + 1, total: route.lon.length });
    const html = '<div class="gc-popup-title">' + sanitize(titleLabel) + '</div>'
        + (dateLabel ? '<div>' + sanitize(dateLabel) + '</div>' : '')
        + '<div>' + sizeLabel + '</div>';
    const contentEl = popupEl.querySelector('.gc-popup-content') || popupEl;
    contentEl.innerHTML = html;
    popupEl.classList.add('is-visible');
    popupOverlay.setPosition(coordinate);
    return true;
}

// Initialise l'overlay de popup et les interactions de clic
// Exportée pour createMap() (basemaps.js), qui l'appelle une fois la carte créée.
export function initPopupOverlay(){
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
            // Aperçu du trajet : un clic près d'une étape (sans cache touchée)
            // décrit le groupe de caches qu'elle représente.
            if (inspectTrailStopAt(pixel, evt.coordinate)) return;
            hidePopup();
            return;
        }

        if (isEvolutionPage()) {
            // Dates de placement et d'archivage ; nom et propriétaire sont
            // chargés à la demande (absents des données de la carte).
            const contentEl = popupEl.querySelector('.gc-popup-content') || popupEl;
            pkg.renderEvolutionPopup?.(feature, contentEl);
            popupEl.classList.add('is-visible');
            popupOverlay.setPosition(evt.coordinate);
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
        const owner = sanitize(props.owner);
        // Les propriétés GeoJSON sont en ISO « yyyy-mm-dd » : affichage dans le
        // format choisi dans les préférences (jj/mm ou mm/jj). Si la valeur
        // n'est pas une date lisible, on retombe sur le texte brut échappé.
        const fmtPopupDate = (v) => {
            const d = pkg.parseLocalDate?.(v);
            const formatted = d ? pkg.formatDateDisplay?.(d) : '';
            return formatted || sanitize(v);
        };
        const dateFind = fmtPopupDate(props.date_find);
        const publishedDate = fmtPopupDate(props.published_date);

        const t = pkg.t || ((s) => s);
        const nameLabel = name || t('Sans nom');
        const foundLabel = props.found ? t('Trouvé') : t('DNF');
        const publishedLabel = publishedDate ? t('Publié le ${date}', { date: publishedDate }) : '';
        const dateFindLabel = dateFind ? t('le ${date}', { date: dateFind }) : '';

        const html = `
            <div class="gc-popup-title">${linkHref ? `<a href=\"${linkHref}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"gc-popup-link\">` : ''}${gcEsc}${linkHref ? '</a>' : ''} - ${nameLabel}</div>
            <div>${type || '-'}, ${cont || '-'}, ${dif||'-'}/${ter||'-'}</div>
            ${owner ? `<div>${owner}</div>` : ''}
            ${publishedLabel ? `<div>${publishedLabel}</div>` : ''}
            <div>${foundLabel} ${dateFindLabel}</div>`;
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


// appear (facultatif) : { at, delayMs(lon, lat) } pour animer l'apparition des
// points ajoutés. Sans lui, les points sont affichés d'emblée à leur taille.
function displayWebGLPoints(features, pointOptions, appear = null) {
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
        const evolution = isEvolutionPage();
        vectorLayer = new ol.layer.WebGLPoints({
            source: window.vectorSource,
            style: buildPointStyle(pointOptions, { evolution }),
            // Mode Évolution : les points pas encore placés ou déjà disparus
            // sont écartés par le shader, y compris pour le clic (popup).
            ...(evolution ? { filter: EVO_FILTER } : {}),
            variables: pointStyleVariables,
            zIndex: 1001,
        });
        map.addLayer(vectorLayer);
    }
    if (!pointAppearListenerKey) {
        pointAppearListenerKey = map.on('precompose', updatePointAppearClock);
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

        if (isEvolutionPage()) {
            // Apparition et disparition calculées par le style (evolution_style.mjs).
            window.vectorSource.addFeatures(toAdd);
            evolutionPointsLoaded = true;
        } else {
            setAppearAttributes(toAdd, featureList, isOlFeature, pointOptions, appear);
            window.vectorSource.addFeatures(toAdd);
        }
        // Même précaution : getFeatures().length ne doit pas s'exécuter quand le debug est éteint.
        if (DEBUG_MAPGL) dbgMapgl('[displayWebGLPoints] Après addFeatures:', window.vectorSource.getFeatures().length, 'features dans source');
    } else {
        console.warn('[displayWebGLPoints] featureList vide, rien à afficher');
    }
}

// Horloge de l'apparition des points : temps vidéo pendant une capture image par
// image (déterministe, comme les flashs), temps réel sinon.
function sampleAppearClock() {
    if (isRecording) {
        const fps = Number(pkg.options.record.framesPerSec) || 30;
        return pointAppearClock.sample('frames', globalRecordFrame * 1000 / fps);
    }
    // En capture MediaRecorder, l'horloge live exclut les pauses « onglet
    // masqué » : sans cela le temps de pause serait compté au retour et toutes
    // les apparitions en cours sauteraient à leur état final dans la vidéo.
    // Source distincte de 'live' : ce temps actif repart de zéro au démarrage
    // du pipeline, et seul un changement de source fait raccorder l'horloge.
    // Sous le même nom, elle restait figée à sa dernière valeur live pendant
    // toute la capture (compteur et apparitions des points immobiles).
    if (isMediaRecording) {
        return pointAppearClock.sample('mediarecorder', mrActiveElapsedMs());
    }
    return pointAppearClock.sample('live', (livePausedAt ?? performance.now()) - livePauseOffsetMs);
}

// Temps écoulé depuis le démarrage du pipeline MediaRecorder, pauses « onglet
// masqué » exclues. Progression affichée, filet de sécurité et horloge
// d'apparition des points partagent cette mesure.
function mrActiveElapsedMs() {
    let paused = mrPausedTotalMs;
    if (mrPausedSince !== null) paused += performance.now() - mrPausedSince;
    return Math.max(0, performance.now() - mrStartedAtTs - paused);
}

// Écrit l'attribut 'appear' lu par le style WebGL. Il est posé silencieusement
// AVANT l'ajout à la source : le layer lit les attributs à l'insertion. Une
// feature qui en a déjà un (réaffichage après un changement de style) le garde,
// pour qu'une apparition en cours se poursuive.
function setAppearAttributes(olFeatures, featureList, isOlFeature, pointOptions, appear) {
    const animate = Boolean(appear && pointOptions?.appearAnimation);
    let latest = -Infinity;
    for (let i = 0; i < olFeatures.length; i++) {
        const feature = olFeatures[i];
        if (!animate) {
            if (feature.get('appear') === undefined) feature.set('appear', STATIC_APPEAR, true);
            continue;
        }
        let delay = 0;
        if (appear.delayMs) {
            const lonLat = isOlFeature
                ? ol.proj.toLonLat(feature.getGeometry().getCoordinates())
                : featureList[i].geometry.coordinates;
            delay = appear.delayMs(lonLat[0], lonLat[1]);
        }
        feature.set('appear', appear.at + delay, true);
        latest = Math.max(latest, appear.at + delay);
    }
    if (animate && olFeatures.length > 0) {
        extendPointsAnimation(latest + POINT_APPEAR_MS);
    }
}

// Signale qu'une apparition (ou disparition) de points est en cours jusqu'à
// l'instant `until` de l'horloge des points.
function extendPointsAnimation(until) {
    pointsAppearUntil = Math.max(pointsAppearUntil, until);
    if (!pointsAppearing) {
        pointsAppearing = true;
        // Tant qu'un point apparaît, chaque frame diffère : le compositing
        // MediaRecorder ne doit rien sauter.
        mapDirtyTracker.beginAnimation();
    }
}

// Avant chaque rendu : avance l'horloge des points, et entretient le rendu tant
// qu'une apparition est en cours (en lecture live, rien d'autre ne redemande de
// rendu si le flash est désactivé).
function updatePointAppearClock() {
    const now = sampleAppearClock();
    pointStyleVariables.now = now;
    // Lecture en pause : horloge figée, aucune frame ne diffère — ne pas
    // entretenir une boucle de rendu pendant toute la pause.
    if (livePausedAt !== null) return false;
    if (isEvolutionPage()) {
        const vars = pkg.evolutionFrameVars?.(now, animationMsPerDay());
        if (vars) Object.assign(pointStyleVariables, vars);
    }

    const glowDays = Math.max(0, Number(pkg.options.point?.recentGlowDays) || 0);
    if (glowDays > 0) pointStyleVariables.glowMs = Math.max(1, glowDays * animationMsPerDay());
    // La persistance s'estompe en continu : chaque frame diffère de la précédente
    // tant qu'une animation tourne, même sans nouveau point ni flash.
    setPointsGlowing(glowDays > 0 && isAnimationInProgress());

    // updateAnimatedCacheCount écrit le compteur dans le DOM : il doit
    // s'évaluer même quand la persistance est active, sinon le compteur reste
    // figé à sa valeur de départ pendant toute l'animation.
    let pending = updateAnimatedCacheCount(now) || pointsGlowing;
    if (pointsAppearing) {
        if (now >= pointsAppearUntil) {
            pointsAppearing = false;
            mapDirtyTracker.endAnimation();
        } else {
            pending = true;
        }
    }
    if (updateCameraFollow(now)) pending = true;
    if (updateTravelTrail(now)) pending = true;

    // Capture image par image et MediaRecorder pilotent eux-mêmes leurs rendus.
    if (pending && !isRecording && !isMediaRecording) map.render();
}

// Fait glisser la vue vers la cible, une fois par frame rendue. Retourne true
// tant que la caméra bouge, pour entretenir le rendu comme les autres animations.
//
// Le centre est posé pendant le pré-rendu : il s'applique donc à la frame
// suivante. C'est voulu — modifier la vue au milieu du rendu courant
// produirait une frame incohérente (tuiles et points décalés d'un cran).
function updateCameraFollow(now) {
    // Pas de condition « animation en cours » : la caméra doit finir son
    // glissement après le dernier jour plutôt que de se figer en plein
    // mouvement. Elle s'arrête d'elle-même en entrant dans la zone morte.
    if (!pkg.options.animation?.cameraFollow) {
        cancelCameraFollowMotion();
        return false;
    }
    if (cameraRenderPending) return false;
    if (!cameraTarget) {
        cameraTravelPending = false;
        return false;
    }

    const view = map.getView();
    if (!cameraJourney) {
        const target = clampToExtent(cameraTarget, cameraExtent);
        cameraJourney = createCameraJourney(
            view.getCenter(),
            target,
            view.getZoom(),
            view.getResolution(),
            {
                extraZoomOut: cameraDynamism === 4 ? INTENSE_EXTRA_ZOOM_OUT : 0,
                durationScale: cameraDurationScale,
            },
        );
        cameraJourneyStartedAt = now;
        if (!cameraJourney) {
            cameraTarget = null;
            beginCameraRenderWait();
            return false;
        }
    }

    const state = sampleCameraJourney(cameraJourney, now - cameraJourneyStartedAt);
    if (!state) {
        cancelCameraFollowMotion();
        return false;
    }
    cameraTravelPending = true;
    view.setCenter(state.center);
    view.setZoom(state.zoom);
    if (state.done) {
        cameraTarget = null;
        cameraJourney = null;
        cameraJourneyStartedAt = null;
        beginCameraRenderWait();
        return false;
    }
    return true;
}

function cameraFollowBlocksDates() {
    return pkg.options.animation?.cameraFollow === true
        && cameraTravelPending;
}

function clearCameraRenderWait() {
    if (cameraRenderKey) {
        try { ol.Observable.unByKey(cameraRenderKey); } catch(_) {}
        cameraRenderKey = null;
    }
    if (cameraRenderTimeout) {
        clearTimeout(cameraRenderTimeout);
        cameraRenderTimeout = null;
    }
    cameraRenderPending = false;
}

function finishCameraRenderWait(timedOut = false) {
    clearCameraRenderWait();
    cameraTravelPending = false;
    mapDirtyTracker.markDirty();
    if (timedOut) console.warn('[CAMERA] Rendu final libéré après le délai de sécurité.');
    if (!isRecording && !isMediaRecording) map.render();
}

// `rendercomplete` n'est émis qu'une fois les sources et tuiles nécessaires au
// viewport chargées. La date reste donc visible avant que la suivante puisse
// déplacer la caméra. Le timeout évite un blocage infini hors connexion.
function beginCameraRenderWait() {
    clearCameraRenderWait();
    cameraRenderPending = true;
    cameraTravelPending = true;
    cameraRenderKey = map.once('rendercomplete', () => finishCameraRenderWait(false));
    cameraRenderTimeout = setTimeout(
        () => finishCameraRenderWait(true),
        CAMERA_RENDER_TIMEOUT_MS,
    );
    map.render();
}

function cancelCameraFollowMotion() {
    clearCameraRenderWait();
    cameraTarget = null;
    cameraJourney = null;
    cameraJourneyStartedAt = null;
    cameraTravelPending = false;
}

// À appeler au début d'une lecture ou d'un enregistrement : la caméra repart de
// la vue courante, et ne sortira pas de l'étendue des caches affichées.
function resetCameraFollow() {
    cancelCameraFollowMotion();
    cameraExtent = null;
    if (!pkg.options.animation?.cameraFollow || isEvolutionPage()) return;
    // L'utilisateur reprend la main dès qu'il touche la carte : sans cela, la
    // vue glisserait de nouveau vers la cible juste après son déplacement.
    if (!cameraInteractionKey) {
        cameraInteractionKey = map.on('pointerdown', () => {
            cancelCameraFollowMotion();
        });
    }
    try {
        const points = getAllFilteredPoints() || [];
        const coordinates = points.map((feature) => ol.proj.fromLonLat([
            feature.geometry.coordinates[0],
            feature.geometry.coordinates[1],
        ]));
        if (coordinates.length > 0) cameraExtent = ol.extent.boundingExtent(coordinates);
    } catch (e) {
        console.warn('[CAMERA] Étendue des caches indisponible, suivi sans bornes:', e);
    }
}

// Barycentre et étendue des caches d'un jour, en coordonnées de carte : ce que
// displayFeaturesForDates donne à viser à la caméra. Calculés sans tableau
// intermédiaire, la simulation parcourant toutes les caches de la sélection.
function summarizeCameraDay(points) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const lonLat = points[i]?.geometry?.coordinates;
        if (!lonLat) continue;
        const [x, y] = ol.proj.fromLonLat([lonLat[0], lonLat[1]]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sumX += x;
        sumY += y;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    if (count === 0) return null;
    return { center: [sumX / count, sumY / count], extent: [minX, minY, maxX, maxY] };
}

// Déroule à blanc les trajets que fera la caméra depuis la vue courante, sur la
// plage de dates animée. null si le suivi est inactif ou les données absentes.
function simulateCurrentCameraJourneys() {
    if (!pkg.options.animation?.cameraFollow || isEvolutionPage()) return null;
    try {
        const start = animationStartDate();
        const end = animationEndDate();
        if (!map || !pkg.pointsByDate || !(start instanceof Date) || !(end instanceof Date) || end < start) return null;

        // Même borne que resetCameraFollow : l'étendue de toutes les caches.
        const summaries = new Map();
        let extent = null;
        for (const [dateKey, points] of pkg.pointsByDate.entries()) {
            const summary = summarizeCameraDay(points || []);
            if (!summary) continue;
            summaries.set(dateKey, summary);
            extent = extent ? ol.extent.extend(extent, summary.extent) : [...summary.extent];
        }

        const days = [];
        const day = new Date(start);
        while (day <= end) {
            days.push(summaries.get(day.toDateString()) || null);
            day.setDate(day.getDate() + 1);
        }

        const view = map.getView();
        return simulateCameraJourneys(days, {
            center: view.getCenter(),
            zoom: view.getZoom(),
            resolution: view.getResolution(),
            viewportSize: map.getSize(),
            dynamism: pkg.options.animation?.cameraDynamism,
            extent,
        });
    } catch (e) {
        console.warn('[CAMERA] Simulation des trajets indisponible:', e);
        return null;
    }
}

// Durée cumulée et nombre des trajets de caméra de la prochaine animation, pour
// le plan de durée affiché (ui.js, refreshTimingPlan).
export function estimateCameraTravel() {
    if (!pkg.options.animation?.cameraFollow || isEvolutionPage()) return null;
    if (!animationInProgress && !isRecording && !isMediaRecording) {
        lastCameraTravelEstimate = simulateCurrentCameraJourneys();
    }
    return lastCameraTravelEstimate;
}

// À appeler au lancement d'une lecture ou d'un enregistrement, la vue étant
// celle du départ. Simule les trajets et, si la durée est imposée, partage
// cette durée entre dates et trajets : la vidéo finit alors à l'heure au lieu
// de s'allonger de tous les déplacements.
//
// timelineScale : ralentissement de la capture rapide. Toute la timeline est
// étirée puis ramenée à sa vitesse par la normalisation : les trajets doivent
// l'être aussi, sinon ils seraient accélérés dans la vidéo finale.
//
// Retourne { travelMs, datesMs } en temps vidéo final (datesMs null quand la
// durée n'est pas imposée), ou null sans suivi de caméra.
function prepareCameraPacing({ timelineScale = 1 } = {}) {
    const stretch = Math.max(1, Number(timelineScale) || 1);
    cameraPacing = null;
    cameraPacingState = { elapsedMs: 0, travelSpentMs: 0, dayIndex: 0, travelFrames: 0, retarget: false };
    cameraDurationScale = stretch;

    const simulation = simulateCurrentCameraJourneys();
    if (!simulation) return null;
    lastCameraTravelEstimate = simulation;

    const budgetMs = Number(pkg.options.animation?.cameraTimeBudgetMs);
    if (!(budgetMs > 0) || !(simulation.dayCount > 0)) {
        return { travelMs: simulation.totalMs, datesMs: null };
    }
    const fps = normalizeRecordingFps(pkg.options.record?.fps);
    const split = splitCameraBudget({
        animationMs: budgetMs,
        minDatesMs: simulation.dayCount * 1000 / fps,
        travelMs: simulation.totalMs,
    });
    cameraDurationScale = split.travelScale * stretch;
    cameraPacing = createCameraPacing({
        budgetMs: budgetMs * stretch,
        travelMsByDay: simulation.travelMsByDay,
        travelScale: cameraDurationScale,
    });
    dbgMapgl('[CAMERA] Durée imposée:', budgetMs, 'ms dont trajets', split.travelMs, 'ms (x' + split.travelScale + ')');
    return { travelMs: split.travelMs, datesMs: split.datesMs };
}

// Nombre d'images à accorder à la date courante en capture image par image,
// quand la durée est imposée. travelDone : son trajet vient d'être capturé.
function cameraPacedFrameTarget(travelDone) {
    const fps = Number(pkg.options.record.framesPerSec) || 30;
    const frameMs = 1000 / fps;
    const dayMs = pacedDayMs(cameraPacing, {
        dayIndex: recordingDayIndex,
        spentMs: globalRecordFrame * frameMs,
        travelSpentMs: cameraPacingState.travelFrames * frameMs,
        travelDone,
        minMs: frameMs,
        // Un trajet coûte en pratique une à deux images de plus que sa durée :
        // celle où il démarre et celle qui attend le rendu final.
        defaultOverheadMs: 2 * frameMs,
    });
    return Math.max(1, Math.round(dayMs / frameMs));
}

// Écrit la valeur courante du compteur dans l'overlay. Retourne true tant que
// l'animation du compteur n'est pas terminée (il faut continuer à redessiner).
function updateAnimatedCacheCount(now) {
    if (isEvolutionPage()) {
        // spanNbCaches reste alimenté en arrière-plan avec les actives : la
        // valeur sert au dessin de débogage et à la réserve historique.
        const actives = evolutionCounters.actives.valueAt(now);
        if (actives !== displayedCacheCount) {
            displayedCacheCount = actives;
            pkg.updateNbCaches(actives);
        }
        renderEvolutionInfosLine(now);
        return evolutionCounters.actives.isAnimating(now)
            || evolutionCounters.placees.isAnimating(now)
            || evolutionCounters.archivees.isAnimating(now);
    }
    const value = cacheCountAnimator.valueAt(now);
    if (value !== displayedCacheCount) {
        displayedCacheCount = value;
        pkg.updateNbCaches(value);
    }
    return cacheCountAnimator.isAnimating(now);
}

// Compose la ligne d'infos du mode Évolution depuis le modèle à balises et
// l'écrit dans son span si elle a changé. {date} lit #spanCurrentDate,
// alimenté en arrière-plan comme les autres spans classiques.
function renderEvolutionInfosLine(now) {
    const span = document.getElementById('spanInfosTemplate');
    if (!span) return;
    const text = renderInfosTemplate(pkg.evolutionInfosTemplate?.() ?? '', {
        date: document.getElementById('spanCurrentDate')?.textContent ?? '',
        actives: evolutionCounters.actives.valueAt(now),
        placees: evolutionCounters.placees.valueAt(now),
        archivees: evolutionCounters.archivees.valueAt(now),
        total: pkg.metadata?.numberOfCaches ?? 0,
    });
    if (span.textContent !== text) span.textContent = text;
}

// Remet le compteur à une valeur exacte, sans animation.
function resetCacheCount(value = 0) {
    cacheCountAnimator.set(value);
    displayedCacheCount = value;
    pkg.updateNbCaches(value);
}

// Mode Évolution : pose les trois compteurs sans animation et réécrit la
// ligne d'infos immédiatement (état au repos, début d'animation).
function resetEvolutionCounters(values = {}) {
    for (const key of ['actives', 'placees', 'archivees']) {
        evolutionCounters[key].set(values?.[key]);
    }
    const actives = evolutionCounters.actives.valueAt(sampleAppearClock());
    displayedCacheCount = actives;
    pkg.updateNbCaches(actives);
    renderEvolutionInfosLine(sampleAppearClock());
}

// Durée d'un jour d'animation, dans l'unité de l'horloge des points : temps vidéo
// pendant une capture image par image, temps réel sinon.
function animationMsPerDay() {
    if (isRecording) {
        const fps = Number(pkg.options.record.framesPerSec) || 30;
        const framesPerDay = Number(pkg.options.record.framesPerDay) || fps;
        return framesPerDay * 1000 / fps;
    }
    return Number(pkg.options.animation.timePerDay) || 1000;
}

function setPointsGlowing(active) {
    if (active === pointsGlowing) return;
    pointsGlowing = active;
    if (active) mapDirtyTracker.beginAnimation();
    else mapDirtyTracker.endAnimation();
}

// À appeler quand le compteur d'animations de mapDirtyTracker est remis à zéro.
function resetPointAppearAnimation() {
    pointsAppearing = false;
    pointsGlowing = false;
    trailAnimating = false;
}

// supprime les points de la carte (centre et bordures si existantes)
export function clearMap(){
    evolutionPointsLoaded = false;
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
// Concatène points dans target sans spread : push(...points) passe chaque point
// en argument et dépasse la taille de pile au-delà de ~65k éléments (limite
// variable selon le navigateur), ce qui casse les très grosses journées.
function appendPoints(target, points) {
    if (!points) return target;
    for (let i = 0; i < points.length; i++) {
        target.push(points[i]);
    }
    return target;
}

// Fonction helper pour récupérer tous les points filtrés
function getAllFilteredPoints() {
    if (isEvolutionPage()) return features || [];
    const allPoints = [];
    if (pkg.pointsByDate) {
        for (const points of pkg.pointsByDate.values()) {
            appendPoints(allPoints, points);
        }
    }
    return allPoints;
}

// Date de début effective de l'animation : plage de l'onglet Animation, sinon
// première trouvaille de la sélection.
function animationStartDate() {
    return pkg.options.animation.dateStart instanceof Date
        ? pkg.options.animation.dateStart
        : pkg.metadata.startDate;
}

// Date de fin effective de l'animation : plage de l'onglet Animation, sinon
// dernière trouvaille de la sélection.
function animationEndDate() {
    return pkg.options.animation.dateEnd instanceof Date
        ? pkg.options.animation.dateEnd
        : pkg.metadata.endDate;
}

// Fonction helper pour récupérer tous les points filtrés jusqu'à la date de début d'animation
function getFilteredPointsAtStart() {
    // Mode Évolution : toutes les caches sont dans la source dès le départ.
    if (isEvolutionPage()) return features || [];
    const allPoints = [];
    if (pkg.pointsByDate) {
        // Utiliser la date de début d'animation comme limite supérieure
        const startDate = animationStartDate();

        for (const [dateKey, points] of pkg.pointsByDate.entries()) {
            const date = new Date(dateKey);
            if (date < startDate) {
                appendPoints(allPoints, points);
            }
        }
    }
    return allPoints;
}

// Fonction helper pour récupérer tous les points jusqu'à une date donnée (incluse)
function getPointsUpToDate(targetDate) {
    if (isEvolutionPage()) return features || [];
    const allPoints = [];
    if (pkg.pointsByDate) {
        for (const [dateKey, points] of pkg.pointsByDate.entries()) {
            const date = new Date(dateKey);
            if (date <= targetDate) {
                appendPoints(allPoints, points);
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

// Rendu haute résolution du pipeline « images » (voir capture_resolution.mjs).
// Tant qu'il est actif, la carte est rendue à cette densité : c'est elle qui
// dimensionne les frames et les overlays, à la place de celle de l'écran.
let highResRatio = null;
let highResPreviousPixelRatio = null;

// Densité à laquelle la frame courante est composée.
function getCaptureRatio() {
    return highResRatio || getCaptureDpr();
}

// Fait rendre la carte à la densité demandée. OpenLayers relit `pixelRatio_` à
// chaque frame : lui donner une valeur plus élevée revient à brancher un écran
// plus fin — tuiles d'un zoom plus fin, vecteurs et textes redessinés, tailles
// de points mises à l'échelle — sans toucher à la mise en page ni au cadrage.
//
// `pixelRatio_` est interne à OpenLayers (10.6 vendoré ici, donc figé) : on
// vérifie qu'il existe et que les canvas ont bien grandi, faute de quoi on
// repart à la densité de l'écran plutôt que de produire une vidéo étirée.
function beginHighResCapture({ multiplier = 1 } = {}) {
    endHighResCapture();
    const viewport = map.getViewport();
    const rect = viewport.getBoundingClientRect();
    const plan = captureRatioFor({
        cssWidth: rect.width,
        cssHeight: rect.height,
        devicePixelRatio: getCaptureDpr(),
        resolution: pkg.options.record?.captureResolution,
        // Facteur d'échelle du mode MediaRecorder : même calcul pour les deux
        // pipelines, donc même définition de « résolution de sortie ».
        multiplier,
    });
    if (plan.ratio <= getCaptureDpr() + 1e-9) return plan;
    if (typeof map.pixelRatio_ !== 'number') {
        console.warn('[RECORD] Rendu haute résolution indisponible (OpenLayers a changé) : capture à la densité de l\'écran.');
        return null;
    }

    const before = viewport.querySelector('canvas')?.width || 0;
    highResPreviousPixelRatio = map.pixelRatio_;
    map.pixelRatio_ = plan.ratio;
    map.updateSize();
    map.renderSync();
    const after = viewport.querySelector('canvas')?.width || 0;
    if (after <= before) {
        console.warn('[RECORD] Rendu haute résolution sans effet : retour à la densité de l\'écran.');
        endHighResCapture();
        return null;
    }
    highResRatio = plan.ratio;
    dbgMapgl('[RECORD] Capture en', plan.width + 'x' + plan.height, '(densité', plan.ratio + ')');
    return plan;
}

// Remet la carte à la densité de l'écran. Appelée à la fin de la capture comme
// sur tous les chemins d'abandon : sans cela, l'aperçu resterait rendu en 4x.
function endHighResCapture() {
    if (highResPreviousPixelRatio === null) return;
    try {
        map.pixelRatio_ = highResPreviousPixelRatio;
        map.updateSize();
        map.renderSync();
    } catch (e) {
        console.warn('[RECORD] Restauration de la densité de rendu échouée:', e);
    }
    highResPreviousPixelRatio = null;
    highResRatio = null;
}

function finalizeAnimationEnd() {
    // Toutes les dates ont été déroulées : la carte affiche de nouveau la totalité
    // des points filtrés, un changement de style peut repartir de `features`.
    animationInProgress = false;
    animationDatesComplete = false;
    if (isEvolutionPage()) endEvolutionTimeline();

    // Fin RÉELLE de l'animation atteinte. En mode MediaRecorder, c'est ici qu'il
    // faut arrêter le recorder : le setTimeout théorique se désynchronise dès que
    // le rendu rame (l'animation prend du retard) et tronque la vidéo. On stoppe
    // depuis la fin réelle, après un court "tail" pour figer la dernière frame.
    if (isMediaRecording) {
        // Annuler le filet de sécurité théorique
        mrSafetyTimer.clear();
        const tailMs = Math.max(0, Number(mrTailMs) || 0);
        if (tailMs > 0) {
            // Suspendable : une pause « onglet masqué » pendant le gel ne doit
            // pas écouler le tail sans rien enregistrer.
            mrTailTimer.arm(tailMs);
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
    animationInProgress = true;
    // Reprise après pause : la pause écoulée ne fait plus partie du temps actif.
    if (livePausedAt !== null) livePauseOffsetMs += performance.now() - livePausedAt;
    livePausedAt = null;
    if (!restart) livePauseOffsetMs = 0;
    endHoldTimer.clear();
    if (!restart && isEvolutionPage()) {
        animationDatesComplete = false;
        // Toutes les caches restent dans la source : seul le style change.
        ensureEvolutionPoints();
        createFlashElements();
        // Le compteur et l'horloge des points sont posés plus bas, une fois la
        // date de début connue.
        try { startBackgroundMusicIfAny(); } catch(e) { console.warn('startBackgroundMusicIfAny error:', e); }
    } else if (!restart) {
        animationDatesComplete = false;
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
        resetCameraFollow();
        resetTravelTrail();
        infos = createObjectInfos(filteredPointsAtStart.length);
        // Démarrer la musique de fond si activée (lecture seule)
        try { startBackgroundMusicIfAny(); } catch(e) { console.warn('startBackgroundMusicIfAny error:', e); }
    } else {
        // En mode restart, s'assurer que 'infos' existe pour éviter les erreurs
        if (!infos) {
            infos = createObjectInfos();
        }
        // Reprendre la musique de fond là où la pause l'avait laissée
        try { resumeBackgroundMusic(); } catch(e) { console.warn('resumeBackgroundMusic error:', e); }
        // Flashs et apparitions figés pendant la pause : rien d'autre ne
        // redemande de rendu avant le prochain jour affiché.
        map.render();
    }

    let flashOptions = pkg.options.flash

    flashOptions.rgb = pkg.hexToRgb(flashOptions.color);
    if (flashOptions.border_color) flashOptions.border_rgb = pkg.hexToRgb(flashOptions.border_color);
    const baseDayDuration = pkg.options.animation.timePerDay;

    // Appliquer plage de dates définie dans l'onglet Animation si présente
    if (pkg.options.animation.dateStart instanceof Date) {
        pkg.metadata.startDate = new Date(pkg.options.animation.dateStart);
    }

    if (pkg.options.animation.dateEnd instanceof Date) {
        pkg.metadata.endDate = new Date(pkg.options.animation.dateEnd);
    }

    if (!restart) {
        currentDate = new Date(pkg.metadata.startDate);
        if (isEvolutionPage()) infos = createObjectInfos(beginEvolutionTimeline(currentDate));
    }
    // Sans effet à la reprise d'une pause : l'approche n'est planifiée qu'une fois.
    startTravelTrailApproach();
    // Durée imposée : partage du temps entre dates et trajets de caméra. Pas à
    // la reprise d'une pause, ni en capture rapide (qui arrive ici par
    // restart=true après avoir fait son propre partage, ralentissement compris).
    if (!restart) prepareCameraPacing();

    // Repart avec un accumulateur neutre : la reprise (restart=true) ne rattrape
    // pas le temps écoulé pendant la pause, exactement comme l'ancien
    // setInterval + clearInterval + nouveau setInterval.
    animationLastTs = null;
    animationAccMs = 0;

    const animationStep = (ts) => {
        if (animationLastTs === null) animationLastTs = ts;
        const pacedStepMs = cameraPacing ? Math.min(ts - animationLastTs, CAMERA_PACING_MAX_STEP_MS) : 0;
        cameraPacingState.elapsedMs += pacedStepMs;
        if (cameraFollowBlocksDates()) {
            // Le rythme configuré décrit le temps d'affichage des dates. Le
            // trajet de caméra s'y ajoute : on ne cumule donc aucun retard à
            // rattraper pendant le déplacement. (Durée imposée : ce temps est
            // compté, et retranché de celui des dates restantes.)
            cameraPacingState.travelSpentMs += pacedStepMs;
            animationLastTs = ts;
            animationAccMs = 0;
            animationRafId = requestAnimationFrame(animationStep);
            return;
        }
        if (animationDatesComplete) {
            animationRafId = null;
            const extraMs = getExtraEndMs();
            if (extraMs > 0) {
                endHoldTimer.arm(extraMs);
            } else {
                finalizeAnimationEnd();
            }
            return;
        }
        // Borner le delta évite qu'un onglet remis au premier plan après une
        // longue mise en arrière-plan ne fasse défiler des dizaines de jours
        // d'un coup (rAF est suspendu en arrière-plan, contrairement à setInterval).
        // Le plafond vaut exactement ce qu'une frame sait consommer : l'accumulateur
        // ne peut donc pas gonfler indéfiniment quand le rendu ne suit pas.
        const maxDaysThisFrame = isEvolutionPage()
            ? EVOLUTION_MAX_DAYS_PER_FRAME
            : (pkg.options.animation?.cameraFollow ? 1 : MAX_DAYS_PER_FRAME);
        // Durée imposée avec suivi de caméra : le temps d'une date se déduit de
        // ce qui reste une fois les trajets à venir retranchés. Le temps déjà
        // accumulé vers la date suivante est exclu du temps écoulé : le
        // résultat reste donc stable d'une frame à l'autre.
        const dayDuration = cameraPacing
            ? pacedDayMs(cameraPacing, {
                dayIndex: cameraPacingState.dayIndex,
                spentMs: cameraPacingState.elapsedMs - pacedStepMs - animationAccMs,
                travelSpentMs: cameraPacingState.travelSpentMs,
            })
            : baseDayDuration;
        animationAccMs += Math.min(ts - animationLastTs, dayDuration * Math.max(MAX_DAYS_PER_FRAME, maxDaysThisFrame));
        animationLastTs = ts;

        // Rattrape jusqu'à MAX_DAYS_PER_FRAME jours par frame — nécessaire dès que
        // timePerDay descend sous la durée d'une frame — mais jamais plus : pas de
        // rafale, contrairement à un setInterval dont les callbacks en retard se
        // déchargeraient d'un coup. Les jours du lot sont affichés ensemble.
        const daysThisFrame = [];
        let reachedEnd = false;
        while (animationAccMs >= dayDuration && daysThisFrame.length < maxDaysThisFrame) {
            animationAccMs -= dayDuration;
            // currentDate est muté juste après : le lot doit garder une copie.
            daysThisFrame.push(new Date(currentDate));
            cameraPacingState.dayIndex++;
            currentDate.setDate(currentDate.getDate() + 1);
            if (currentDate > pkg.metadata.endDate) {
                reachedEnd = true;
                break;
            }
        }

        if (daysThisFrame.length > 0) {
            displayFeaturesForDates(daysThisFrame, pkg.options.point, flashOptions, false, infos);
            if (cameraFollowBlocksDates()) animationAccMs = 0;
        }

        if (reachedEnd) {
            animationDatesComplete = true;
        }
        animationRafId = requestAnimationFrame(animationStep);
    };
    animationRafId = requestAnimationFrame(animationStep);
}

export function stopAnimation(){
    // Arrêter l'enregistrement si en cours
    isRecording = false;
    endHighResCapture();
    animationInProgress = false;
    animationDatesComplete = false;
    removeCaptureVisibilityGuard();

    if (animationRafId) {
        cancelAnimationFrame(animationRafId);
        animationRafId = null;
    }
    animationLastTs = null;
    livePausedAt = null;
    livePauseOffsetMs = 0;

    endHoldTimer.clear();

    // Arrêter le pipeline MediaRecorder si actif
    try {
        if (isMediaRecording) {
            stopMediaRecorderPipeline(true);
        }
    } catch(e) { console.warn('Erreur arrêt MediaRecorder:', e); }

    // Arrêter musique de fond si lecture seule
    try { stopBackgroundMusic(); } catch(e) { console.warn('stopBackgroundMusic error:', e); }

    // Fermer le toast de chargement s'il est ouvert
    // IMPORTANT: ne pas utiliser de sélecteur large type [class*="toast"] qui peut matcher
    // le conteneur (.gcm-toast-container) et casser l'affichage des loaders suivants.
    try {
        const loadingToast = document.querySelector('.toast-loading') ||
                           document.querySelector('.gcm-toast') ||
                           document.querySelector('.toast');
        if (loadingToast) {
            dbgMapgl('[STOP] Toast trouvé, tentative de fermeture:', loadingToast);
            pkg.hideToast && pkg.hideToast(loadingToast);
        } else {
            dbgMapgl('[STOP] Aucun toast trouvé avec les sélecteurs testés');
        }

        // Fermer aussi tous les toasts visibles (sans toucher au conteneur)
        const allToasts = document.querySelectorAll('.gcm-toast, .toast, .toast-loading');
        allToasts.forEach((toast, index) => {
            dbgMapgl(`[STOP] Fermeture toast ${index}:`, toast.textContent);
            pkg.hideToast && pkg.hideToast(toast);
        });
    } catch(e) {
        console.warn('Erreur lors de la fermeture du toast:', e);
    }

    // Remettre la carte à l'état d'origine avec tous les points filtrés.
    // Mode Évolution : les points restent dans la source, seul l'état au repos
    // du style est rétabli (plus bas).
    const evolution = isEvolutionPage();
    if (!evolution) {
        dbgMapgl('[STOP] Nettoyage de la carte...');
        clearMap();

        // Nettoyer les animations et effets
        if (window.vectorSource) {
            window.vectorSource.clear();
            dbgMapgl('[STOP] Vector source nettoyé');
        }
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
    clearTravelTrail();

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

    // Redéclencher un rendu pour appliquer le nettoyage ci-dessus
    map.render();
    dbgMapgl('[STOP] Styles d\'animation remis à zéro');

    if (evolution) {
        ensureEvolutionPoints();
        endEvolutionTimeline();
    } else {
        const allFilteredPoints = getAllFilteredPoints();
        dbgMapgl('[STOP] Nombre de points filtrés à afficher:', allFilteredPoints.length);
        if (allFilteredPoints.length > 0) {
            displayWebGLPoints(allFilteredPoints, pkg.options.point);
            dbgMapgl('[STOP] Points affichés avec succès');
        } else {
            dbgMapgl('[STOP] Aucun point à afficher');
        }
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
    // Figer l'horloge « live » : le stylo du trail, les apparitions de points et
    // la persistance s'arrêtent avec l'avancement des dates (reprise sans saut
    // dans startAnimation, via livePauseOffsetMs).
    if (livePausedAt === null) livePausedAt = performance.now();
    // Régler l'horloge tout de suite sur l'instant de pause : sinon le prochain
    // rendu rattraperait le cran entre la dernière frame et le clic, faisant
    // avancer le stylo (et les apparitions) une dernière fois pendant la pause.
    sampleAppearClock();
    // Stopper uniquement la boucle rAF d'avancement des dates
    if (animationRafId) {
        cancelAnimationFrame(animationRafId);
        animationRafId = null;
    }
    animationLastTs = null;
    // Stopper le maintien de fin éventuel
    endHoldTimer.clear();
    // Mettre la musique de fond en pause (elle reprendra à la reprise)
    try { pauseBackgroundMusic(); } catch(e) { console.warn('pauseAnimation pauseBackgroundMusic error:', e); }
    // La carte, vectorSource, les points et currentDate sont conservés tels quels
}

export function recordAnimation(){
    resetTileErrorCount(); // repartir d'un compte propre pour cette session d'enregistrement

    // Branche MediaRecorder si demandé et supporté
    try {
        const mode = pkg.options?.record?.mode;
        if (mode === 'mediarecorder' && isMediaRecorderSupported()) {
            recordAnimationMediaRecorder();
            return;
        } else if (mode === 'mediarecorder' && !isMediaRecorderSupported()) {
            pkg.showToast && pkg.showToast(pkg.t('Capture rapide non supportée, bascule en mode image par image.'), 'warning', pkg.t('Compatibilité'));
        }
    } catch(e) { console.warn('Detection MediaRecorder error:', e); }

    // Vérifier que les données sont prêtes
    if (!hasTimelineData()) {
        console.error("Les données de géocaches ne sont pas encore chargées");
        pkg.showToast(pkg.t("Données en cours de chargement. Veuillez réessayer."), "warning", pkg.t("Attention"));
        return;
    }

    // Nouvelle session de capture : identifiant propre à cet enregistrement.
    // Généré avant le nettoyage : même si celui-ci échoue, les frames de cette
    // session restent isolées des reliquats des enregistrements précédents.
    captureSessionId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Démarrer la surveillance des performances pour le mode images
    recordingPerformanceMonitor.startMonitoring();

    // Nettoyage initial du répertoire d'images avant la capture
    const prepToast = pkg.showToast && pkg.showToast(pkg.t('Préparation de l\'enregistrement...'), 'info', pkg.t('Nettoyage initial'), 0);
    fetchWithTimeout(`${CONFIG.BASE_URL}/clear_pictures_directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vider_repertoire' })
    }, { timeoutMs: FETCH_TIMEOUTS.control, t: pkg.t })
    .then(r => r.json())
    .then(d => {
        if (prepToast) { pkg.hideToast && pkg.hideToast(prepToast); }
        // Assemblage en cours côté serveur : le dossier n'a pas pu être vidé.
        // On annule la capture au lieu de poursuivre : les nouvelles images se
        // mélangeraient aux anciennes et la vidéo finale contiendrait les deux.
        if (d && d.busy) {
            try { recordingPerformanceMonitor.stopMonitoring(); } catch(_) {}
            pkg.showToast && pkg.showToast(
                d.message || pkg.t('Un assemblage vidéo est en cours. Réessayez à la fin du traitement.'),
                'warning', pkg.t('Enregistrement annulé'), 6000
            );
            return;
        }
        if (d && d.success) {
            pkg.showToast && pkg.showToast(pkg.t('Répertoire d’images nettoyé.'), 'success', pkg.t('Préparation'), 2000);
        } else {
            pkg.showToast && pkg.showToast(pkg.t('Nettoyage initial impossible. Poursuite de l\'enregistrement.'), 'warning', pkg.t('Attention'), 3000);
        }
        startRecordingProcess();
    })
    .catch(err => {
        if (prepToast) { pkg.hideToast && pkg.hideToast(prepToast); }
        pkg.showToast && pkg.showToast(pkg.t('Erreur nettoyage initial. Poursuite.'), 'warning', pkg.t('Attention'), 3000);
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

    // Remise à zéro de l'état de la carte et des informations affichées.
    // Mode Évolution : les caches restent dans la source (seul le style change),
    // les recharger coûterait plusieurs secondes sur un gros jeu de données.
    if (!isEvolutionPage()) clearMap(); // Nettoie les points sur la carte

    // Remise à zéro des compteurs d'images/frames pour un nouvel enregistrement
    imageCounter = 0;
    currentFrame = 0;
    globalRecordFrame = 0;
    infosProgressBar = {};

    // NB : l'affichage des caches antérieures à la date de début est fait plus bas,
    // APRÈS le window.vectorSource.clear() de préparation — sinon ce clear les efface
    // et l'enregistrement démarre sur une carte vide (contrairement à la lecture).

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

    // Calculer le total global puis répartir ses fractions entre les jours. Arrondir
    // chaque jour séparément faisait dériver fortement les vidéos longues.
    try {
        recordingDayCount = inclusiveDayCount(currentDate, pkg.metadata.endDate);
        // Suivi de caméra : les trajets sont simulés depuis la vue de départ.
        // Durée imposée → le temps des dates est ce qu'ils laissent libre.
        const cameraPlan = prepareCameraPacing();
        const timingPlan = buildImageTimingPlan({
            dayCount: recordingDayCount,
            timePerDayMs: Number.isFinite(cameraPlan?.datesMs)
                ? cameraPlan.datesMs / recordingDayCount
                : pkg.options.animation.timePerDay,
            cameraTravelMs: cameraPlan?.travelMs || 0,
            fps: pkg.options.record.fps,
            extraEndSeconds: pkg.options.animation.extraEndSeconds,
            tailFreezeMs: pkg.options.record?.mediaRecorder?.tailFreezeMs,
            flashMode: effectiveFlashMode(),
            flashDurationMs: pkg.options.flash.duration,
            allowMultipleDaysPerFrame: isEvolutionPage(),
        });

        recordingDayIndex = 0;
        recordingBaseFrameCount = timingPlan.baseFrameCount;
        currentDayFrameTarget = framesForDay(0, recordingDayCount, recordingBaseFrameCount,
            { allowZero: isEvolutionPage() });
        framesPerDay = timingPlan.framesPerDayAverage;
        pkg.options.record.framesPerDay = framesPerDay;
        pkg.options.record.framesPerSec = timingPlan.fps;
        pkg.options.record.flashFrames = Math.max(1, Math.round(
            Math.max(0, Number(pkg.options.flash.duration) || 0) * timingPlan.fps / 1000
        ));
        pkg.options.record.extraFrames = timingPlan.tailFrameCount;
        pkg.options.record.nbOfImages = timingPlan.totalFrameCount;
        pkg.options.record.numberOfDigits = Math.max(4, String(timingPlan.totalFrameCount).length);
        if (cameraPacing) currentDayFrameTarget = cameraPacedFrameTarget(false);
        dbgMapgl('[RECORD] Jours animation:', recordingDayCount, 'frames animation:', recordingBaseFrameCount, 'total images:', timingPlan.totalFrameCount);
    } catch(e) { console.warn('Calcul jours animation échoué:', e); }

    // Remise à zéro de l'affichage des informations
    resetCacheCount(0); // Remet le compteur de géocaches à zéro
    pkg.updateCurrentDate(currentDate); // Remet la date au début effectif
    try { pkg.updateProgressBar({ progress: 0, message: pkg.t('0% | préparation...') }); } catch(_) {}

    // Bloquer la musique et détecter l'audio pour l'intégrer dans le toast
    let _captureAudioNote = '';
    try {
        setBackgroundAudioBlocked(true);
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            _captureAudioNote = pkg.t(' ♪ La musique sera intégrée automatiquement après la capture.');
        }
    } catch(_) {}

    // ouverture modale avec avertissement dans le titre et info audio dans le message
    pkg.openModalLoading(
        pkg.t("Capture en cours – Ne pas bouger la fenêtre"),
        pkg.t("Préparation de la capture...") + _captureAudioNote
    );

    // Init métriques
    resetPerfMetrics();

    // Réinitialiser la file d'upload (uploads découplés de la capture en mode
    // images) et lui attacher la session : chaque lot emportera cet identifiant.
    resetUploadQueue(captureSessionId);

    // Marquer le début de l'enregistrement
    isRecording = true;

    // C8 — Onglet masqué : requestAnimationFrame est gelé, donc la capture se met
    // silencieusement en pause. La capture étant déterministe (indexée sur
    // globalRecordFrame, pas sur le temps réel), il n'y a pas de corruption : elle
    // reprend exactement où elle en était au retour au premier plan. On informe
    // simplement l'utilisateur pour ne pas laisser croire à un plantage.
    removeCaptureVisibilityGuard();
    captureVisibilityHandler = () => {
        if (!isRecording) return;
        if (document.hidden) {
            if (!captureVisibilityToast) {
                try { captureVisibilityToast = pkg.showToast && pkg.showToast(pkg.t('Capture en pause : revenez sur cet onglet pour la poursuivre.'), 'warning', pkg.t('Onglet masqué'), 0); } catch(_) {}
            }
        } else if (captureVisibilityToast) {
            try { pkg.hideToast && pkg.hideToast(captureVisibilityToast); } catch(_) {}
            captureVisibilityToast = null;
        }
    };
    document.addEventListener('visibilitychange', captureVisibilityHandler);

    // mise à jour des options RGB (MEttre ailleurs ? + idem lecture seule)
    pkg.options.flash.rgb = pkg.hexToRgb(pkg.options.flash.color);
    if (pkg.options.flash.border_color) {
        pkg.options.flash.border_rgb = pkg.hexToRgb(pkg.options.flash.border_color);
    }

    // Assurez-vous que vectorSource est initialisé
    if (!window.vectorSource) {
        window.vectorSource = new ol.source.Vector({
            wrapX: true,
        });
    }
    
    let initialCount;
    if (isEvolutionPage()) {
        ensureEvolutionPoints();
        createFlashElements();
        initialCount = beginEvolutionTimeline(currentDate);
    } else {
        window.vectorSource.clear();

        // Afficher les caches filtrées jusqu'à la date de début d'animation (sans effet flash).
        // L'état de départ dépend du FILTRE, pas de la date de début : restreindre la période
        // d'animation ne doit pas masquer les caches déjà présentes avant cette date.
        const filteredPointsAtStart = getFilteredPointsAtStart();
        if (filteredPointsAtStart.length > 0) {
            displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
        }

        createFlashElements();
        resetCameraFollow();
        resetTravelTrail();
        initialCount = filteredPointsAtStart.length;
    }
    // creation objet pour stocker les infos liées aux Frames (dt nombre de caches)
    let infos = createObjectInfos(initialCount);

    currentFrame = 0;  // Réinitialisez le compteur de frames

    // Rendu haute résolution éventuel AVANT le cache d'overlays : c'est lui qui
    // fixe l'échelle à laquelle les cartouches sont dessinées.
    beginHighResCapture();

    // Précalculer les propriétés statiques des overlays à l'échelle de capture,
    // cohérent avec le canvas de capture images dimensionné en pixels device.
    buildOverlayCache(getCaptureRatio());

    // Afficher les points initiaux pour la date de début
    displayFeaturesForDate(currentDate, pkg.options.point, pkg.options.flash, true, infos);

    // Attendre que le rendu soit complet avant de commencer la capture.
    // scheduleCaptureFrame attrape toute erreur de la boucle asynchrone pour
    // éviter que la modale reste bloquée en cas d'échec (upload, timeout, etc.).
    // Contrairement aux frames suivantes (captureElement borne chaque attente à
    // 5 s), cette première attente n'avait pas de limite : un rendu qui ne
    // termine jamais laissait la modale « Capture en cours » ouverte sans explication.
    let initialRenderKey = map.once('rendercomplete', () => {
        clearTimeout(initialRenderTimeout);
        initialRenderKey = null;
        scheduleCaptureFrame(pkg.options.point, pkg.options.flash, infos);
    });
    const initialRenderTimeout = setTimeout(() => {
        if (initialRenderKey) {
            ol.Observable.unByKey(initialRenderKey);
            initialRenderKey = null;
        }
        abortRecordingOnError(new Error(pkg.t('Le rendu initial de la carte n\'a pas abouti (timeout)')));
    }, 10000);
    try {
        // Forcer un rendu pour déclencher rendercomplete
        map.renderSync();
    } catch (e) {
        clearTimeout(initialRenderTimeout);
        if (initialRenderKey) {
            ol.Observable.unByKey(initialRenderKey);
            initialRenderKey = null;
        }
        abortRecordingOnError(e);
    }
}


// créé un objet pour les infos pour permet de garder une consistance pour le nombre de caches
// initialCount : caches déjà présentes sur la carte au démarrage (celles antérieures
// à la date de début d'animation). Le compteur doit partir de ce nombre, sinon il
// annonce 0 alors que ces points sont bien visibles.
// En mode Évolution, beginEvolutionTimeline passe un objet { actives, placees,
// archivees } qui initialise les trois compteurs de la ligne d'infos à balises.
function createObjectInfos(initialCount = getFilteredPointsAtStart().length){
    let infos = new Object();
    infos.displayDate = pkg.options.infos.currentDate.display
    infos.displayNumberofCaches = pkg.options.infos.numberOfCaches.display
    if (initialCount && typeof initialCount === 'object') {
        infos.cacheNumber = Math.max(0, Number(initialCount.actives) || 0);
        // Les balises puisent indifféremment dans la date et les compteurs :
        // les deux grandeurs sont alimentées quelles que soient les cases du
        // profil (ces cases ne sont pas proposées dans ce mode).
        infos.displayDate = true;
        infos.displayNumberofCaches = true;
        // La ligne repart des valeurs d'avant la date de début, sans animer
        // depuis le total de la base affiché hors animation.
        resetEvolutionCounters(initialCount);
        return infos
    }
    infos.cacheNumber = Math.max(0, Number(initialCount) || 0);
    // Le compteur affiché repart du nombre de caches déjà affichées, sans animer
    // depuis le total de la base affiché hors animation.
    resetCacheCount(infos.cacheNumber);
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

// Bascule l'état « occupé » des boutons nettoyer/enregistrer (B6 : la même
// séquence enable/disable était dupliquée dans plusieurs branches).
function setAssembleUiBusy(busy) {
    const cleanBtn = document.getElementById('btnCleanMoviePictures');
    const recordBtn = document.getElementById('btnRecordAnimation');
    if (cleanBtn) {
        cleanBtn.disabled = busy;
        // Seul le libellé change : écrire dans le bouton lui-même effacerait son
        // icône et le compteur d'images.
        const label = cleanBtn.querySelector('.btn-label');
        if (label) {
            if (busy) {
                if (!cleanBtn.dataset.idleLabel) cleanBtn.dataset.idleLabel = label.textContent;
                label.textContent = pkg.t('Nettoyage en cours...');
            } else if (cleanBtn.dataset.idleLabel) {
                label.textContent = cleanBtn.dataset.idleLabel;
            }
        }
    }
    if (busy && recordBtn) { recordBtn.disabled = true; }
    // En fin d'opération, ne pas réactiver aveuglément : sans données ou avec
    // un timing invalide, le bouton doit rester désactivé — c'est
    // updateDataAvailabilityUI qui arbitre (hasData && timingInputsValid).
    if (!busy) { try { pkg.updateDataAvailabilityUI?.(); } catch(_) {} }
    // Fin d'opération : le dossier temporaire a pu être vidé (ou pas, en cas
    // d'échec) → réaligner l'affichage du bouton sur son contenu réel.
    if (!busy) { try { pkg.refreshCapturedPicturesUi && pkg.refreshCapturedPicturesUi(); } catch(_) {} }
}

// Retire la garde « onglet masqué » du mode images (C8) et ferme son toast.
// Idempotent : sûr à appeler même si aucune garde n'est active.
function removeCaptureVisibilityGuard() {
    try { if (captureVisibilityHandler) { document.removeEventListener('visibilitychange', captureVisibilityHandler); captureVisibilityHandler = null; } } catch(_) {}
    try { if (captureVisibilityToast) { pkg.hideToast && pkg.hideToast(captureVisibilityToast); captureVisibilityToast = null; } } catch(_) {}
}

// Termine proprement l'enregistrement en cas d'erreur irrécupérable :
// ferme la modale/les toasts, nettoie les animations, restaure la carte et
// les contrôles, puis affiche un message d'erreur explicite à l'utilisateur.
function abortRecordingOnError(error) {
    console.error('[CAPTURE] Abandon de l\'enregistrement suite à une erreur:', error);

    isRecording = false;
    endHighResCapture();
    removeCaptureVisibilityGuard();
    imgOutCanvas = imgOutCtx = null; // libérer le canvas réutilisé (P4)
    try { recordingPerformanceMonitor.stopMonitoring(); } catch(_) {}
    try { setBackgroundAudioBlocked(false); } catch(_) {}

    // Fermer la modale de chargement et les toasts
    try { pkg.closeModalLoading && pkg.closeModalLoading(); } catch(_) {}
    try {
        const allToasts = document.querySelectorAll('.gcm-toast, .toast, .toast-loading');
        allToasts.forEach(toast => { pkg.hideToast && pkg.hideToast(toast); });
    } catch(_) {}

    // Nettoyer les animations de flash
    try { if (animationSource) animationSource.clear(); } catch(_) {}
    try { if (animationLayer) animationLayer.setVisible(false); } catch(_) {}
    try { clearTravelTrail(); } catch(_) {}

    // Remettre la carte avec tous les points filtrés
    try {
        if (isEvolutionPage()) {
            ensureEvolutionPoints();
            endEvolutionTimeline();
        } else {
            clearMap();
            const allFilteredPoints = getAllFilteredPoints();
            if (allFilteredPoints.length > 0) {
                displayWebGLPoints(allFilteredPoints, pkg.options.point);
            }
        }
    } catch(_) {}

    // Réactiver les boutons et restaurer les contrôles
    try { setAssembleUiBusy(false); } catch(_) {}
    try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(_) {}

    // Informer l'utilisateur
    try {
        const errDetail = error?.message || pkg.t('erreur inconnue');
        pkg.showToast && pkg.showToast(
            pkg.t('La capture a été interrompue suite à une erreur : ${message}', { message: errDetail }),
            'error',
            pkg.t('Capture interrompue'),
            8000
        );
    } catch(_) {}
}

// Fin d'export réussie : l'écran « Vidéo prête » présente le fichier et les
// actions pour y accéder. Sans fichier côté serveur (repli navigateur avec
// téléchargement seul), il n'y a rien à présenter : simple toast.
function announceVideoReady(video) {
    let shown = false;
    // La capture est terminée : redimensionner la carte n'affecte plus la vidéo.
    try { pkg.leaveFullscreenMode?.(); } catch (e) { console.warn('[RECORD END] Sortie du plein écran impossible:', e); }
    try { shown = !!pkg.showVideoReady?.(video); } catch (e) { console.warn('[RECORD END] Écran de fin indisponible:', e); }
    if (!shown) pkg.showToast && pkg.showToast(pkg.t('Vidéo prête'), 'success', pkg.t('Enregistrement'));
    // La liste « Dernières vidéos » de l'onglet Export se met à jour.
    window.dispatchEvent(new CustomEvent('mygcflow:video-exported'));
}

// Lancement de l'assemblage vidéo. En POST : la route déclenche un encodage, et
// un GET pouvait être rejoué par un préchargement de lien ou un scanner d'URL.
function postStartCreateVideo(body) {
    return fetchWithTimeout(`${CONFIG.BASE_URL}/start_create_video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // file_name : nom de base de la vidéo (saisie ou thème actif), que le
        // serveur horodate — même règle qu'en capture rapide.
        body: JSON.stringify({ file_name: pkg.recordingFileBaseName?.() || '', ...(body || {}) }),
    }, { timeoutMs: FETCH_TIMEOUTS.control, t: pkg.t });
}

// Poll générique d'une tâche de fond serveur (/tasks/<id>) jusqu'à ce qu'elle
// soit terminée. Résout avec le résultat, rejette en cas d'échec ou de timeout.
// Utilisé pour l'assemblage vidéo, lancé en tâche de fond côté serveur pour
// éviter l'expiration du fetch HTTP sur les vidéos longues.
// maxConsecutiveErrors : la tâche continue côté serveur pendant une micro-coupure
// réseau ou un pic de charge ; on ne renonce au suivi qu'après plusieurs échecs
// d'affilée, un seul fetch raté ne doit pas faire échouer tout l'assemblage.
function pollTaskStatus(taskId, { intervalMs = 700, timeoutMs = 1800000, maxConsecutiveErrors = 5, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let consecutiveErrors = 0;
        const tick = () => {
            if (!taskId) { reject(new Error(pkg.t('task_id manquant'))); return; }
            if (Date.now() - startedAt > timeoutMs) { reject(new Error(pkg.t('Délai d\'assemblage dépassé'))); return; }
            fetchWithTimeout(`${CONFIG.BASE_URL}/tasks/${encodeURIComponent(taskId)}?include_result=true`,
                { method: 'GET' }, { timeoutMs: FETCH_TIMEOUTS.status, t: pkg.t })
                .then(r => {
                    // 404 : la tâche est définitivement perdue (purgée du
                    // TaskManager, serveur redémarré). Aucun nouvel essai ne la
                    // fera réapparaître : on échoue tout de suite au lieu de
                    // laisser le compteur d'erreurs transitoires s'épuiser.
                    if (r.status === 404) {
                        const lost = new Error(pkg.t('Tâche introuvable sur le serveur (purgée ou serveur redémarré)'));
                        lost.fatal = true;
                        throw lost;
                    }
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json();
                })
                .then(status => {
                    consecutiveErrors = 0;
                    const state = status?.state;
                    if (typeof onProgress === 'function' && typeof status?.progress === 'number') {
                        onProgress(status.progress, status.message);
                    }
                    if (state === 'finished') { resolve(status?.result || {}); return; }
                    if (state === 'failed') { reject(new Error(status?.error || status?.message || pkg.t('Tâche échouée'))); return; }
                    setTimeout(tick, intervalMs);
                })
                .catch(err => {
                    if (err && err.fatal) { reject(err); return; }
                    consecutiveErrors++;
                    if (consecutiveErrors >= maxConsecutiveErrors) {
                        reject(new Error(pkg.t('Suivi de la tâche interrompu après ${count} erreurs consécutives : ${detail}', { count: consecutiveErrors, detail: err?.message || err })));
                        return;
                    }
                    dbgMapgl(`[TASK] Erreur de suivi ${consecutiveErrors}/${maxConsecutiveErrors} : ${err?.message || err}`);
                    // Back-off progressif pour laisser le serveur/réseau se rétablir
                    setTimeout(tick, intervalMs * (consecutiveErrors + 1));
                });
        };
        tick();
    });
}

// TODO Voir pour Capture, car à priori c'est forcement == True
async function captureNextFrame(capture, pointOptions, flashOptions, infos) {
    // Vérifier si l'enregistrement a été arrêté
    if (!isRecording) {
        dbgMapgl('[CAPTURE] Enregistrement arrêté par l\'utilisateur');
        removeCaptureVisibilityGuard();
        imgOutCanvas = imgOutCtx = null; // libérer le canvas réutilisé (P4)

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
        clearTravelTrail();

        // Remettre la carte avec tous les points filtrés
        if (isEvolutionPage()) {
            ensureEvolutionPoints();
            endEvolutionTimeline();
        } else {
            clearMap();
            const allFilteredPoints = getAllFilteredPoints();
            if (allFilteredPoints.length > 0) {
                displayWebGLPoints(allFilteredPoints, pkg.options.point);
                dbgMapgl('[CAPTURE] Affichage de', allFilteredPoints.length, 'points filtrés');
            }
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }
        return;
    }

    if (cameraFollowBlocksDates()) {
        // En mode Images, chaque pas de caméra devient une vraie frame vidéo,
        // mais ne consomme pas le temps d'affichage réservé à la date courante.
        if (capture == true) {
            // Les trajets simulés sont déjà dans le total : il ne grandit que
            // s'ils en demandent davantage que prévu.
            pkg.options.record.nbOfImages = Math.max(
                imageCounter + 2,
                Number(pkg.options.record.nbOfImages) || 0
            );
            await captureElementWithRetry();
            globalRecordFrame++;
            cameraPacingState.travelFrames++;
            cameraPacingState.retarget = true;
        }
        scheduleCaptureFrame(pointOptions, flashOptions, infos);
        return;
    }

    // Durée imposée : le trajet de la date courante vient de se terminer, son
    // coût réel est connu — ses images sont recalculées avant d'être capturées.
    if (cameraPacingState.retarget) {
        cameraPacingState.retarget = false;
        if (cameraPacing && currentFrame === 0 && currentDate <= pkg.metadata.endDate) {
            currentDayFrameTarget = cameraPacedFrameTarget(true);
        }
    }

    if (currentDate > pkg.metadata.endDate) {
        for (let extraFrames = 0; extraFrames < pkg.options.record.extraFrames; extraFrames++) {
            // Avancer l'animation d'un cran et redéclencher un rendu : drawActiveFlashes
            // (flashs indexés sur globalRecordFrame) termine
            // ainsi le fondu des flashs encore actifs sur les frames de fin.
            globalRecordFrame++;
            map.render();
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
        try { pkg.updateProgressBar({ progress: 99, message: pkg.t('Envoi des dernières images...') }); } catch(_) {}
        await awaitAllUploads();

        // Traitement de fin
        isRecording = false; // Marquer la fin de l'enregistrement
        endHighResCapture();
        removeCaptureVisibilityGuard();
        imgOutCanvas = imgOutCtx = null; // libérer le canvas réutilisé (P4)

        // Arrêter la surveillance des performances
        recordingPerformanceMonitor.stopMonitoring();
        
        try { setBackgroundAudioBlocked(false); } catch(_) {}

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
        clearTravelTrail();

        // Remettre la carte avec tous les points filtrés
        if (isEvolutionPage()) {
            ensureEvolutionPoints();
            endEvolutionTimeline();
        } else {
            clearMap();
            const allFilteredPoints = getAllFilteredPoints();
            if (allFilteredPoints.length > 0) {
                displayWebGLPoints(allFilteredPoints, pkg.options.point);
                dbgMapgl('[RECORD END] Affichage de', allFilteredPoints.length, 'points filtrés');
            }
        }

        try { pkg.resetControlsToInitialState && pkg.resetControlsToInitialState(); } catch(e) { console.warn(e); }

        // Assembler automatiquement puis nettoyer
        dbgMapgl('[RECORD END] Démarrage de l\'assemblage automatique...');

        // Désactiver temporairement les boutons pour éviter les clics multiples
        setAssembleUiBusy(true);

        // Réutiliser la modal/loader existante pour garantir l'affichage (système qui marche déjà chez toi)
        try { pkg.openModalLoading(pkg.t('Assemblage en cours'), pkg.t('Création de la vidéo à partir des images...')); } catch(e) { console.warn('openModalLoading erreur:', e); }

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
                    const up = await fetchWithTimeout(`${CONFIG.BASE_URL}/upload_audio`, { method: 'POST', body: fd }, { timeoutMs: FETCH_TIMEOUTS.upload, t: pkg.t });
                    const upRes = await up.json().catch(()=>({success:false}));
                    if (upRes?.success && upRes?.file) audioFileName = upRes.file;
                }
                // FPS configurable : doit correspondre à celui utilisé pour calculer
                // les frames, sinon la vitesse de lecture est faussée côté serveur.
                const fps = normalizeRecordingFps(pkg.options?.record?.fps);
                const body = {
                    fps,
                    color_fidelity: normalizeColorFidelity(pkg.options?.record?.colorFidelity),
                    // Session + nombre de frames : le serveur assemble le dossier
                    // de CETTE capture et refuse un assemblage incomplet.
                    session: captureSessionId,
                    expected_frames: imageCounter,
                };
                if (audioFileName) {
                    body.audio = audioFileName;
                    body.audio_volume = audioVol;
                }
                return postStartCreateVideo(body);
            } catch(e) {
                console.warn('Assemblage avec audio: fallback sans audio', e);
                const fps = normalizeRecordingFps(pkg.options?.record?.fps);
                return postStartCreateVideo({
                    fps,
                    color_fidelity: normalizeColorFidelity(pkg.options?.record?.colorFidelity),
                    session: captureSessionId,
                    expected_frames: imageCounter,
                });
            }
        };

        // Réactive les boutons de l'UI (utilisé dans plusieurs branches)
        const reEnableRecordButtons = () => setAssembleUiBusy(false);
        // Résultat de l'assemblage (nom, taille, durée) pour l'écran de fin.
        let assembledVideo = null;

        tryAssembleWithAudio()
          .then(response => { logToast('Réponse assemblage reçue, status:', response?.status); return response.json(); })
          .then(data => {
            // L'assemblage tourne désormais en tâche de fond : on récupère un task_id
            // et on suit sa progression via /tasks/<id> (fini l'expiration du fetch).
            if (!data || !data.task_id) {
              throw new Error(data && data.message ? data.message : pkg.t('Impossible de lancer l\'assemblage vidéo'));
            }
            dbgMapgl('[RECORD END] Assemblage lancé en tâche de fond, task_id:', data.task_id);
            return pollTaskStatus(data.task_id, {
              onProgress: (p, msg) => {
                // Encodage vidéo mappé sur 0→70% de la barre globale
                try { pkg.updateProgressBar({ progress: Math.round(p * 0.7), message: msg || pkg.t('Création de la vidéo...') }); } catch(e) {}
              }
            });
          })
          .then((result) => {
            assembledVideo = result;
            dbgMapgl('[RECORD END] Assemblage réussi, nettoyage automatique...');
            try { pkg.updateProgressBar({progress: 70, message: pkg.t('Vidéo créée. Nettoyage des images...')}); } catch(e) {}
            try { pkg.updateTextsModal(pkg.t('Nettoyage en cours'), pkg.t('Vidéo créée avec succès. Nettoyage des images...')); } catch(e) {}

            // Nettoyer automatiquement
            return fetchWithTimeout(`${CONFIG.BASE_URL}/clear_pictures_directory`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ action: 'vider_repertoire' })
            }, { timeoutMs: FETCH_TIMEOUTS.control, t: pkg.t });
          })
          .then(response => response ? response.json() : null)
          .then(cleanData => {
            reEnableRecordButtons();
            if (cleanData && cleanData.success) {
              dbgMapgl('[RECORD END] Nettoyage automatique terminé');
              try { pkg.updateProgressBar({progress: 100, message: pkg.t('Nettoyage terminé')}); } catch(e) {}
              setTimeout(() => { try { pkg.closeModalLoading(); } catch(e) {} }, 400);
              announceVideoReady(assembledVideo);
              warnIfTileErrors();
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
              pkg.t('Erreur chaîne'),
              5000
            );
          });

        return;
    }

    if (currentFrame < currentDayFrameTarget) {
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

        if (isEvolutionPage()) {
            // Plusieurs jours peuvent partager une image : les jours qui n'en
            // reçoivent aucune sont affichés en un seul lot avec le suivant.
            const batch = [];
            do {
                currentDate.setDate(currentDate.getDate() + 1);
                if (currentDate > pkg.metadata.endDate) break;
                recordingDayIndex++;
                currentDayFrameTarget = framesForDay(
                    recordingDayIndex,
                    recordingDayCount,
                    recordingBaseFrameCount,
                    { allowZero: true },
                );
                batch.push(new Date(currentDate));
            } while (currentDayFrameTarget === 0);
            if (batch.length > 0) displayFeaturesForDates(batch, pointOptions, flashOptions, true, infos);
        } else {
            currentDate.setDate(currentDate.getDate() + 1);
            if (currentDate <= pkg.metadata.endDate) {
                recordingDayIndex++;
                currentDayFrameTarget = cameraPacing
                    ? cameraPacedFrameTarget(false)
                    : framesForDay(
                        recordingDayIndex,
                        recordingDayCount,
                        recordingBaseFrameCount,
                    );
                displayFeaturesForDate(currentDate, pointOptions, flashOptions, true, infos);
            }
        }
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
    if (!hasTimelineData()) {
        pkg.showToast && pkg.showToast(pkg.t('Données en cours de chargement. Réessayez.'), 'warning', pkg.t('Attention'));
        return;
    }

    // Bloquer la musique et détecter l'audio pour l'intégrer dans le toast
    let _mrAudioNote = '';
    try {
        setBackgroundAudioBlocked(true);
        stopBackgroundMusic();
        const input = document.getElementById('inputAudioFile');
        const file = input?.files?.[0];
        const audioEnabled = !!(pkg.options?.record?.audio?.enabled);
        if (audioEnabled && file) {
            _mrAudioNote = pkg.t(' ♪ La musique sera intégrée automatiquement après la capture.');
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
    // NB : les points initiaux sont affichés plus bas, APRÈS le window.vectorSource.clear()
    // de préparation — sinon ce clear les efface et la vidéo démarre sur une carte vide.
    if (!isEvolutionPage()) {
        try { clearMap(); } catch(_) {}
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
    let initialCount;
    if (isEvolutionPage()) {
        ensureEvolutionPoints();
        createFlashElements();
        initialCount = beginEvolutionTimeline(currentDate);
    } else {
        window.vectorSource.clear();

        // Afficher les caches filtrées jusqu'à la date de début d'animation (sans effet flash).
        // L'état de départ dépend du FILTRE, pas de la date de début : restreindre la période
        // d'animation ne doit pas masquer les caches déjà présentes avant cette date.
        const filteredPointsAtStart = getFilteredPointsAtStart();
        if (filteredPointsAtStart.length > 0) {
            displayWebGLPoints(filteredPointsAtStart, pkg.options.point);
        }

        createFlashElements();
        resetCameraFollow();
        // Silencieux : isMediaRecording n'est posé que dans
        // startMediaRecorderPipeline, plus bas — sans `silent`, les toasts
        // d'info apparaîtraient au lancement de l'enregistrement.
        resetTravelTrail(true);
        initialCount = filteredPointsAtStart.length;
    }
    animationDatesComplete = false;
    // IMPORTANT : réinitialiser la variable module 'infos' (compteur de caches).
    // startAnimation(true) réutilise ce même objet ; sans reset, cacheNumber
    // repart de l'ancien total accumulé → compteur faux. (Avant : un 'infosLocal'
    // local était créé puis jamais utilisé.)
    infos = createObjectInfos(initialCount);
    pkg.updateCurrentDate(currentDate);

    // UI loader
    const totalMs = computeTotalAnimationMs();
    try { pkg.openModalLoading(
        pkg.t('Enregistrement en cours – Ne pas bouger la fenêtre'),
        pkg.t('Démarrage de la capture...') + _mrAudioNote
    ); } catch(_) {}

    // Appliquer un éventuel ralentissement utilisateur sur la timeline
    const originalTimePerDay = pkg.options.animation.timePerDay;
    const originalFlashDuration = pkg.options.flash.duration;
    const originalTrailDuration = pkg.options.trail?.duration;
    const originalExtraEndSeconds = pkg.options.animation.extraEndSeconds;
    let appliedSlowdown = 1;
    try {
        const sd = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
        appliedSlowdown = sd;
        if (sd > 1) {
            pkg.options.animation.timePerDay = originalTimePerDay * sd;
            // Ralentir aussi l'animation des flashs pour compenser la normalisation
            pkg.options.flash.duration = originalFlashDuration * sd;
            // Idem pour le tracé des traits de déplacement.
            if (pkg.options.trail) pkg.options.trail.duration = normalizeTrailOptions(pkg.options.trail).duration * sd;
            // Toute la timeline doit être ralentie, y compris la fin demandée.
            // Sinon ffmpeg raccourcit cette partie lors de la normalisation.
            pkg.options.animation.extraEndSeconds = originalExtraEndSeconds * sd;
            dbgMapgl('[RECORD] Slowdown x' + sd + ' appliqué: timePerDay=' + pkg.options.animation.timePerDay + ', flash.duration=' + pkg.options.flash.duration);
        }
    } catch(_) {}

    // Suivi de caméra : trajets simulés depuis la vue de départ et, si la durée
    // est imposée, partage de cette durée — le tout étiré comme la timeline.
    prepareCameraPacing({ timelineScale: appliedSlowdown });

    // Démarrer animation timeline existante (musique bloquée)
    try { startAnimation(true); } catch(_) { startAnimation(); }

    // Démarrer capture MediaRecorder
    startMediaRecorderPipeline(totalMs * appliedSlowdown, appliedSlowdown).catch(e => {
        console.error('MediaRecorder pipeline error:', e);
        pkg.showToast && pkg.showToast(pkg.t('Erreur de la capture rapide, bascule en mode image par image.'), 'error', pkg.t('Enregistrement'));
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
        try { if (pkg.options.trail) pkg.options.trail.duration = originalTrailDuration; } catch(_) {}
        try { pkg.options.animation.extraEndSeconds = originalExtraEndSeconds; } catch(_) {}
    };
}

function computeTotalAnimationMs(){
    try {
        const animationDays = inclusiveDayCount(currentDate, pkg.metadata.endDate);
        const perDay = Number(pkg.options.animation?.timePerDay) || 50;
        let base = animationDays * perDay;
        // Suivi de caméra : la durée imposée couvre déjà dates et trajets ;
        // sinon les trajets s'ajoutent au temps des dates.
        const cameraBudgetMs = Number(pkg.options.animation?.cameraTimeBudgetMs);
        const cameraTravel = estimateCameraTravel();
        if (cameraTravel) base = cameraBudgetMs > 0 ? cameraBudgetMs : base + cameraTravel.totalMs;
        const extraEndMs = Math.max(0, Number(pkg.options?.animation?.extraEndSeconds) || 0) * 1000;
        const endHoldMs = automaticEndHoldMs({
            tailFreezeMs: pkg.options.record?.mediaRecorder?.tailFreezeMs,
            flashMode: pkg.options.flash?.mode,
            flashDurationMs: pkg.options.flash?.duration,
        });
        return base + endHoldMs + extraEndMs;
    } catch(_) { return 3000; }
}

// (Re)démarre la boucle de compositing MediaRecorder à partir des paramètres
// mémorisés dans mrDrawParams. Idempotent : ne fait rien si une boucle tourne déjà
// ou si les paramètres ne sont pas encore initialisés. Extrait pour permettre la
// pause/reprise sur changement de visibilité de l'onglet (C8).
function startMrDrawLoop() {
    if (mrDrawIntervalId || !mrDrawParams) return;
    const { viewport, effScale, intervalMs } = mrDrawParams;
    // Reprise après pause (onglet masqué) : l'état de la carte a pu changer sans
    // que nous en soyons informés, la première frame est donc toujours dessinée.
    mapDirtyTracker.markDirty();
    let drawing = false;
    mrDrawIntervalId = setInterval(() => {
        if (!isMediaRecording || drawing) return;

        // Rien n'a bougé depuis la frame précédente : le canvas de sortie garde
        // déjà le bon contenu, on économise le rendu complet de la carte.
        const frameStart = performance.now();
        const signature = overlayContentSignature();
        if (!mapDirtyTracker.shouldDraw(frameStart, signature)) return;

        drawing = true;
        try {
            // renderSync() émet un postrender : la garde évite que notre propre
            // rendu remarque la carte comme sale.
            mrOwnRender = true;
            try { map.renderSync(); } finally { mrOwnRender = false; }
            const canvasList = viewport.querySelectorAll('canvas');
            const w = mrOutCanvas.width;
            const h = mrOutCanvas.height;
            mrOutCtx.clearRect(0, 0, w, h);
            canvasList.forEach(c => { if (c.width > 0 && c.height > 0) mrOutCtx.drawImage(c, 0, 0, w, h); });
            addOverlaysToCanvas(mrOutCtx, w, h, effScale);
            mapDirtyTracker.noteDraw(frameStart, signature);
        } catch(e) {
            console.warn('Composite frame error:', e);
        } finally {
            // Seules les frames réellement composées alimentent le moniteur : les
            // ticks sautés coûtent ~0 et masqueraient les vraies chutes de perf.
            const frameTime = performance.now() - frameStart;
            recordingPerformanceMonitor.checkPerformance(frameTime, intervalMs, 'mediarecorder');
            drawing = false;
        }
    }, intervalMs);
}

// Signature du contenu redessiné à chaque frame par addOverlaysToCanvas : le
// texte peut changer (date, compteur de caches, titre édité en direct) sans que
// la carte, elle, soit modifiée. La révision du cache couvre les changements de
// style/police/dimension. Lecture de textContent uniquement : pas de reflow.
function overlayContentSignature() {
    try {
        const { title, infos } = getOverlayTextContent();
        return `${getOverlayCacheRevision()}\u0000${title}\u0000${infos}`;
    } catch(_) {
        // Contenu illisible : on ne prend pas le risque d'une frame périmée.
        mapDirtyTracker.markDirty();
        return null;
    }
}

async function startMediaRecorderPipeline(totalDurationMs, timelineScale = 1){
    const fps = normalizeRecordingFps(pkg.options.record?.fps);
    const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
    const vbps = normalizeRecordingBitrateMbps(
        Number(pkg.options?.record?.mediaRecorder?.videoBitsPerSecond) / 1_000_000
    ) * 1_000_000;
    const scaleFactor = Math.max(1, Math.min(3, Number(pkg.options?.record?.mediaRecorder?.scaleFactor) || 1));

    // Durée du gel de la dernière frame après la fin réelle de l'animation.
    // L'arrêt du recorder est piloté par finalizeAnimationEnd (fin réelle), pas
    // par un setTimeout théorique qui tronque la vidéo si le rendu prend du retard.
    mrTailMs = automaticEndHoldMs({
        tailFreezeMs: Math.max(0, Number(pkg.options?.record?.mediaRecorder?.tailFreezeMs ?? 3000)) * timelineScale,
        flashMode: pkg.options.flash?.mode,
        // La durée du flash a déjà été multipliée avant le démarrage de l'animation.
        flashDurationMs: pkg.options.flash?.duration,
    });

    // Résolution de sortie : même calcul que le mode images (facteur d'échelle et
    // hauteur visée réunis). La carte est RENDUE à cette densité — tuiles plus
    // fines, vecteurs et textes redessinés — au lieu d'être étirée vers un canvas
    // plus grand, ce qui grossissait l'image sans ajouter le moindre détail.
    //
    // Contrairement au mode images, ce pipeline tourne en temps réel : le coût
    // d'une frame composée croît avec le carré de la densité. Mesuré en rendu
    // logiciel (le pire cas, celui des tests) depuis une fenêtre 1280x540 :
    // 7,5 ms en 1x, 34 ms en 2x, 81 ms en 3x. Au-delà de 2x, 30 images/s n'est
    // plus tenable sans carte graphique : le moniteur de performance prévient
    // alors l'utilisateur des images perdues.
    const plan = beginHighResCapture({ multiplier: scaleFactor }) || {};
    // Repli : si le rendu haute résolution n'a pas pu être activé, on retrouve
    // l'ancien comportement (étirement vers un canvas plus grand) plutôt que de
    // rendre une sortie plus petite que celle demandée.
    const effScale = highResRatio || scaleFactor * getCaptureDpr();

    const viewport = map.getViewport();
    const rect = viewport.getBoundingClientRect();
    mrOutCanvas = document.createElement('canvas');
    mrOutCanvas.width = Math.max(1, Math.floor(rect.width * effScale));
    mrOutCanvas.height = Math.max(1, Math.floor(rect.height * effScale));
    if (plan.limited) {
        try {
            pkg.showToast && pkg.showToast(
                pkg.t ? pkg.t('Résolution réduite aux capacités du navigateur.') : 'Résolution réduite aux capacités du navigateur.',
                'warning', 'Enregistrement', 6000);
        } catch(_) {}
    }
    // Pas de willReadFrequently : ce canvas n'est jamais relu (getImageData) ; il est
    // uniquement composité puis exporté via captureStream. willReadFrequently:true
    // forçait un backing store CPU (pas d'accélération GPU) → compositing lent et saccades.
    mrOutCtx = mrOutCanvas.getContext('2d');

    // Pas d'audio pendant l'enregistrement MediaRecorder : la piste est muxée
    // après coup par muxRecordedVideoWithAudio() (cf. video_postprocess.js).
    const mixedStream = mrOutCanvas.captureStream(fps);

    mrRecordedChunks = [];
    mrRecorder = new MediaRecorder(mixedStream, { mimeType: mime, videoBitsPerSecond: vbps });
    isMediaRecording = true;
    // Horloge « temps actif » : repart de zéro pour cette session. Les pauses
    // « onglet masqué » seront déduites par mrActiveElapsedMs().
    mrStartedAtTs = performance.now();
    mrPausedSince = null;
    mrPausedTotalMs = 0;
    // Instantané du ralentissement réellement appliqué : la préférence peut être
    // modifiée pendant la capture (moniteur de performance), la normalisation
    // finale doit utiliser le facteur en vigueur ici.
    mrAppliedSlowdown = Math.max(1, Number(timelineScale) || 1);

    mrRecorder.ondataavailable = (e) => {
        if (!e.data || e.data.size <= 0) return;
        if (mrVideoStream) {
            mrVideoStream.push(e.data);
            // Un fragment perdu rend la vidéo incomplète : arrêter tout de suite
            // plutôt que de poursuivre une capture irrécupérable.
            if (mrVideoStream.error) {
                console.error('[MediaRecorder] Échec d\'envoi d\'un fragment:', mrVideoStream.error);
                try { pkg.showToast && pkg.showToast(pkg.t('La copie de la vidéo a échoué. Arrêt de l\'enregistrement.'), 'error', pkg.t('Enregistrement'), 8000); } catch(_) {}
                try { stopMediaRecorderPipeline(true); } catch(_) {}
            }
        } else {
            mrRecordedChunks.push(e.data);
        }
    };
    mrRecorder.onstop = () => finalizeMediaRecorderVideo();
    // C9 — Échec de l'encodeur (mémoire, reset GPU...) : sans ce handler, ni onstop
    // ni finalize ne sont appelés, la modale « Enregistrement » reste ouverte à
    // jamais. On arrête proprement le pipeline (stopMediaRecorderPipeline route vers
    // finalize, qui tente de récupérer les chunks déjà capturés et ferme la modale).
    mrRecorder.onerror = (e) => {
        console.error('[MediaRecorder] Erreur encodeur:', e?.error || e);
        try { pkg.showToast && pkg.showToast(pkg.t('Erreur de l\'encodeur vidéo. Arrêt de l\'enregistrement et récupération de la séquence déjà capturée.'), 'error', pkg.t('Enregistrement'), 8000); } catch(_) {}
        try { stopMediaRecorderPipeline(true); } catch(_) {}
    };
    // Utiliser un timeslice plus grand pour réduire le nombre de chunks et la pression GC
    const timesliceMs = Math.max(200, Number(pkg.options?.record?.mediaRecorder?.timesliceMs) || 1000);
    // Délestage mémoire : ouvrir le flux vers le serveur local avant le premier
    // fragment. Sans lui, les chunks s'accumuleraient en RAM jusqu'à la fin
    // (~225 Mo/min à 30 Mbit/s). Repli silencieux sur l'accumulation en mémoire.
    mrVideoStream = createVideoStream({
        baseUrl: CONFIG.BASE_URL,
        fetchImpl: (url, opts) => fetchWithTimeout(url, opts, { timeoutMs: FETCH_TIMEOUTS.upload, t: pkg.t }),
        t: pkg.t,
    });
    try { await mrVideoStream.begin(); } catch (e) {
        console.warn('[MediaRecorder] Flux serveur indisponible, accumulation en mémoire:', e);
        mrVideoStream = null;
    }
    mrRecorder.start(timesliceMs);

    // Précalculer les propriétés statiques des overlays pour éviter les reflows par frame
    buildOverlayCache(effScale);

    // Démarrer la surveillance des performances
    recordingPerformanceMonitor.startMonitoring();

    // Suivi « carte sale ». Remise à zéro sûre ici : cette fonction s'exécute de
    // façon synchrone juste après startAnimation(), aucune frame rAF n'a encore pu
    // créer de flash. Un compteur non nul serait donc un reliquat d'une lecture
    // précédente interrompue (listeners jamais expirés faute de rendu), qui
    // désactiverait l'optimisation pour tout l'enregistrement.
    mapDirtyTracker.reset();
    resetPointAppearAnimation();
    // Filet générique : tout rendu déclenché par OpenLayers lui-même (tuile de fond
    // chargée, animation de vue, source modifiée hors animation) passe par un
    // postrender. Nos propres renderSync de compositing en sont exclus par la
    // garde mrOwnRender, sans quoi aucune frame ne serait jamais considérée
    // comme propre.
    mrPostrenderKey = map.on('postrender', () => { if (!mrOwnRender) mapDirtyTracker.markDirty(); });

    // Dessin périodique (compositing) — factorisé au niveau module (startMrDrawLoop)
    // pour pouvoir être suspendu puis relancé lors d'un changement de visibilité de
    // l'onglet (cf. mrVisibilityHandler / C8).
    mrDrawParams = { viewport, effScale, intervalMs: Math.max(4, Math.floor(1000 / fps)) };
    startMrDrawLoop();

    // C8 — Onglet/fenêtre masqué : rAF (avancement des jours) est gelé par le
    // navigateur et le setInterval de compositing est bridé à ~1 Hz, alors que le
    // MediaRecorder continue d'accumuler du temps réel → long segment figé et
    // désynchronisé dans la vidéo. On met donc tout en pause de façon cohérente :
    // pause du recorder (le temps mis en pause est exclu de la vidéo) + arrêt du
    // compositing, ce qui reste synchrone avec l'animation gelée.
    mrVisibilityHandler = () => {
        if (!isMediaRecording) return;
        if (document.hidden) {
            // Figer les horloges : temps actif, minuteurs de fin et filet de
            // sécurité cessent de s'écouler tant que la pause dure.
            if (mrPausedSince === null) mrPausedSince = performance.now();
            mrSafetyTimer.pause();
            mrTailTimer.pause();
            endHoldTimer.pause();
            try { if (mrDrawIntervalId) { clearInterval(mrDrawIntervalId); mrDrawIntervalId = null; } } catch(_) {}
            try { if (mrRecorder && mrRecorder.state === 'recording') mrRecorder.pause(); } catch(_) {}
            // rAF est déjà gelé ; remettre la référence temporelle à null évite tout
            // rattrapage de jours au retour (la 1re frame repart d'un delta nul).
            animationLastTs = null;
            if (!mrVisibilityToast) {
                try { mrVisibilityToast = pkg.showToast && pkg.showToast(pkg.t('Enregistrement en pause : revenez sur cet onglet pour reprendre la capture.'), 'warning', pkg.t('Onglet masqué'), 0); } catch(_) {}
            }
        } else {
            // Déplier la pause : cumuler son temps. Les flashs « live » suivent
            // l'horloge des points, qui exclut ce temps (mrActiveElapsedMs) :
            // ils reprennent là où ils en étaient, sans décalage à appliquer.
            if (mrPausedSince !== null) {
                mrPausedTotalMs += performance.now() - mrPausedSince;
                mrPausedSince = null;
            }
            mrSafetyTimer.resume();
            mrTailTimer.resume();
            endHoldTimer.resume();
            try { if (mrRecorder && mrRecorder.state === 'paused') mrRecorder.resume(); } catch(_) {}
            startMrDrawLoop();
            if (mrVisibilityToast) { try { pkg.hideToast && pkg.hideToast(mrVisibilityToast); } catch(_) {} mrVisibilityToast = null; }
        }
    };
    document.addEventListener('visibilitychange', mrVisibilityHandler);

    // Progression : temps actif, pauses « onglet masqué » exclues — sinon le
    // pourcentage continuerait de grimper pendant que rien n'est enregistré.
    mrProgressIntervalId = setInterval(() => {
        const elapsed = mrActiveElapsedMs();
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
    // Suspendable : il s'écoule en temps actif, jamais pendant une pause.
    mrSafetyTimer.arm(Math.max(0, totalDurationMs) * 4 + 60000);
}

function stopMediaRecorderPipeline(finalize){
    try { if (mrDrawIntervalId) { clearInterval(mrDrawIntervalId); mrDrawIntervalId = null; } } catch(_) {}
    try { if (mrProgressIntervalId) { clearInterval(mrProgressIntervalId); mrProgressIntervalId = null; } } catch(_) {}
    mrSafetyTimer.clear();
    mrTailTimer.clear();
    // Toute pause en cours s'arrête avec le pipeline : l'horloge active repartira
    // de zéro à la prochaine session.
    mrPausedSince = null;
    mrPausedTotalMs = 0;

    // Retirer la garde « onglet masqué » (C8) et fermer son toast éventuel.
    try { if (mrVisibilityHandler) { document.removeEventListener('visibilitychange', mrVisibilityHandler); mrVisibilityHandler = null; } } catch(_) {}
    try { if (mrVisibilityToast) { pkg.hideToast && pkg.hideToast(mrVisibilityToast); mrVisibilityToast = null; } } catch(_) {}
    try { if (mrPostrenderKey) { ol.Observable.unByKey(mrPostrenderKey); mrPostrenderKey = null; } } catch(_) {}
    mrOwnRender = false;
    mrDrawParams = null;

    // Arrêter la surveillance des performances
    recordingPerformanceMonitor.stopMonitoring();
    // La carte doit retrouver la densité de l'écran, sinon l'aperçu resterait
    // rendu en haute résolution après l'enregistrement.
    endHighResCapture();

    if (mrRecorder && mrRecorder.state !== 'inactive') {
        try { mrRecorder.stop(); } catch(_) {}
    } else if (finalize) {
        finalizeMediaRecorderVideo();
    } else {
        // Annulation sans finalization : restaurer timePerDay immédiatement
        try { mrOnFinalizeRestoreTimePerDay?.(); mrOnFinalizeRestoreTimePerDay = null; } catch(_) {}
        // Un flux ouvert sans finalisation : le purger côté serveur (le fichier
        // partiel n'a plus de raison d'être).
        try { if (mrVideoStream) { mrVideoStream.abort(); mrVideoStream = null; } } catch(_) {}
    }
    isMediaRecording = false;
    mrIsFinalizing = false;
    // Pas de nettoyage audio ici : le flux MediaRecorder ne porte aucune piste
    // audio (elle est ajoutée après coup au mux).
}

function finalizeMediaRecorderVideo(){
    if (mrIsFinalizing) return;
    mrIsFinalizing = true;
    try {
        const mime = pkg.options?.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
        // Chemin « flux » : les fragments ont déjà été poussés au serveur au fil
        // de l'eau — rien à assembler en mémoire, blob reste null.
        const stream = mrVideoStream;
        mrVideoStream = null;
        let blob = stream ? null : new Blob(mrRecordedChunks || [], { type: mime });
        // Nom de l'enregistrement brut remuxé côté serveur (renseigné par
        // finish() du flux) ; il reste dans le dossier de travail du serveur.
        let streamedFile = null;

        // Nom de base de la vidéo (saisie de l'onglet Export, sinon thème actif).
        // Le serveur le nettoie, l'horodate et pose l'extension : aucun nom de
        // fichier n'est construit ici.
        const baseName = pkg.recordingFileBaseName?.() || '';
        // Facteur réellement appliqué à la timeline (instantané du démarrage) :
        // la préférence a pu être modifiée pendant la capture par le moniteur
        // de performance, et normaliser avec une autre valeur désynchroniserait
        // la vidéo (vitesse, audio, tail freeze).
        const slowdown = mrAppliedSlowdown;
        const wantsNorm = !!pkg.options?.record?.mediaRecorder?.offlineNormalization;
        const doNormalize = wantsNorm && slowdown > 1;

        // `video` : description du fichier produit dans le dossier des vidéos
        // (absente si la vidéo n'a été que téléchargée par le navigateur).
        const afterAll = (video) => {
            // Réactiver boutons et fermer loader
            try { pkg.updateProgressBar({ progress: 100, message: pkg.t('Terminé') }); } catch(_) {}
            setTimeout(() => { try { pkg.closeModalLoading(); } catch(_) {} }, 400);
            announceVideoReady(video);
            warnIfTileErrors();
            // Débloquer la lecture de fond après enregistrement MR
            try { setBackgroundAudioBlocked(false); } catch(_) {}
        };

        // Repli navigateur : la vidéo finale n'existe que dans cet onglet. Elle
        // rejoint le dossier des vidéos comme les autres ; si cette copie
        // échoue, on la télécharge plutôt que de la perdre.
        const deliver = (finalBlob) => {
            const uploadName = `${baseName || 'mygcflow'}.webm`;
            const fd = new FormData();
            fd.append('video', finalBlob, 'recording.webm');
            fd.append('fileName', uploadName);
            fetchWithTimeout(`${CONFIG.BASE_URL}/upload_video`, { method: 'POST', body: fd }, { timeoutMs: FETCH_TIMEOUTS.videoUpload, t: pkg.t })
                .then(r => r.json())
                .then(res => {
                    if (!res?.success) throw new Error(res?.message || pkg.t('Copie vers le dossier vidéo échouée'));
                    afterAll(res);
                })
                .catch((e) => {
                    console.warn('Copie vers le dossier vidéo échouée, téléchargement de secours:', e);
                    try {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(finalBlob);
                        a.download = uploadName;
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                    } catch(err) { console.warn('Download failed:', err); }
                    afterAll();
                });
        };

        // Avant livraison : réécrire l'en-tête WebM pour y injecter la durée réelle.
        // Sans ça, MediaRecorder produit un .webm sans "Duration" : les lecteurs
        // n'affichent pas la durée et la barre de progression ne permet pas de chercher.
        const proceedWith = (finalBlob) => {
            try { pkg.updateTextsModal(pkg.t('Finalisation'), pkg.t('Écriture de la durée de la vidéo...')); } catch(_) {}
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
                try { pkg.updateTextsModal(pkg.t('Ajout audio'), pkg.t('Fusion de la piste audio avec la vidéo en cours...')); } catch(_) {}
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
        // Le repli navigateur travaille sur un Blob : en chemin « flux », on le
        // re-télécharge depuis le serveur — cas rare (serveur de traitement en
        // échec alors que le flux a abouti), la mémoire n'est plus le souci ici.
        const ensureBlob = () => {
            if (blob) return Promise.resolve(blob);
            if (!streamedFile) return Promise.reject(new Error('pas de données vidéo disponibles'));
            return fetchWithTimeout(
                `${CONFIG.BASE_URL}/recorded_video/${encodeURIComponent(streamedFile)}`,
                {}, { timeoutMs: FETCH_TIMEOUTS.videoUpload, t: pkg.t },
            ).then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.blob();
            });
        };
        const runClientFallback = () => {
            ensureBlob().then((b) => {
                blob = b;
                if (doNormalize) {
                    // Annoncer le facteur réellement applicable : le navigateur plafonne playbackRate.
                    const applicable = clampPlaybackRate(slowdown).rate;
                    try { pkg.updateTextsModal(pkg.t('Normalisation'), pkg.t('Accélération x${applicable} pour lecture à vitesse normale...', { applicable })); } catch(_) {}
                    normalizeRecordedVideoSpeed(blob, slowdown).then((normBlob) => {
                        doMux(normBlob || blob);
                    }).catch((e) => {
                        console.warn('Normalization failed, continue without normalization:', e);
                        doMux(blob);
                    });
                } else {
                    doMux(blob);
                }
            }).catch((e) => {
                console.error('Flux indisponible pour le repli local:', e);
                try { pkg.closeModalLoading(); } catch(_) {}
                try { setBackgroundAudioBlocked(false); } catch(_) {}
                try { pkg.showToast && pkg.showToast(pkg.t('La vidéo n\'a pas pu être assemblée.'), 'error', pkg.t('Enregistrement'), 8000); } catch(_) {}
            });
        };

        // ---- Traitement serveur (ffmpeg, une seule passe) : normalisation + mux ----
        // Rapide, robuste, sans onglet actif obligatoire. Remplace jusqu'à 3 ré-encodages navigateur.
        const processOnServer = () => new Promise((resolve, reject) => {
            try { pkg.updateTextsModal(pkg.t('Traitement serveur'), pkg.t('Envoi de la vidéo au serveur...')); } catch(_) {}
            const launchProcessing = () => {
                const fd = new FormData();
                if (streamedFile) {
                    // Le .webm est déjà sur le serveur (flux délesté) : on désigne
                    // son nom au lieu de re-téléverser le fichier complet.
                    fd.append('recorded_file', streamedFile);
                } else {
                    fd.append('video', blob, 'recording.webm');
                }
                // Le serveur ne doit accélérer la vidéo que si l'utilisateur a
                // explicitement demandé la normalisation. Auparavant, décocher
                // l'option n'avait aucun effet dans le chemin ffmpeg.
                fd.append('slowdown', String(serverNormalizationFactor(slowdown, doNormalize)));
                fd.append('fps', String(normalizeRecordingFps(pkg.options?.record?.fps)));
                // Fidélité de couleur de l'encodage final (cf. color_fidelity.mjs).
                fd.append('color_fidelity', normalizeColorFidelity(pkg.options?.record?.colorFidelity));
                fd.append('fileName', baseName);
                if (audioEnabled && audioFile) {
                    fd.append('audio', audioFile, audioFile.name || 'music');
                    const vol = (typeof pkg.options?.record?.audio?.volume === 'number') ? pkg.options.record.audio.volume : 1;
                    fd.append('audio_volume', String(vol));
                }
                try { pkg.updateProgressBar({ progress: 0, message: pkg.t('Traitement serveur...') }); } catch(_) {}
                fetchWithTimeout(`${CONFIG.BASE_URL}/process_recorded_video`, { method: 'POST', body: fd }, { timeoutMs: FETCH_TIMEOUTS.videoUpload, t: pkg.t })
                    .then(r => r.json())
                    .then(data => {
                        if (!data || !data.task_id) throw new Error(data && data.message ? data.message : pkg.t('Traitement serveur non démarré'));
                        return pollTaskStatus(data.task_id, {
                            onProgress: (p, msg) => { try { pkg.updateProgressBar({ progress: p, message: msg || pkg.t('Traitement serveur...') }); } catch(_) {} }
                        });
                    })
                    .then(result => {
                        afterAll(result);
                        resolve();
                    })
                    .catch(reject);
            };
            if (stream) {
                // Les fragments ont été poussés au fil de l'eau : on attend la
                // file d'envoi puis on demande le remux serveur, qui répare au
                // passage l'élément « Duration » absent des flux MediaRecorder
                // (remplace fixWebmFinalDuration sans charger le blob en mémoire).
                stream.drain()
                    .then(() => stream.finish())
                    .then((fin) => { streamedFile = fin.file; launchProcessing(); })
                    .catch(reject);
            } else {
                // Réécrire la durée du .webm pour que ffmpeg la lise correctement
                // (opération légère, pas de ré-encodage)
                fixWebmFinalDuration(blob).then((fixedBlob) => {
                    blob = fixedBlob || blob;
                    launchProcessing();
                }).catch(reject);
            }
        });

        processOnServer().catch((err) => {
            if (stream && !streamedFile) {
                // Le flux n'a pas abouti (fragment perdu ou remux impossible) :
                // la vidéo est incomplète et rien n'est rattrapable côté client.
                console.error('[MediaRecorder] Flux vidéo incomplet:', err);
                try { stream.abort(); } catch(_) {}
                try { pkg.closeModalLoading(); } catch(_) {}
                try { setBackgroundAudioBlocked(false); } catch(_) {}
                try { pkg.showToast && pkg.showToast(pkg.t('L\'enregistrement a été interrompu : la copie des données a échoué.'), 'error', pkg.t('Enregistrement'), 8000); } catch(_) {}
                return;
            }
            console.warn('Traitement serveur échoué, repli sur le pipeline navigateur:', err);
            try { pkg.showToast && pkg.showToast(pkg.t('Traitement serveur indisponible, repli local...'), 'warning', pkg.t('Enregistrement'), 4000); } catch(_) {}
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

// Le repli navigateur accélère la vidéo via playbackRate, plafonné à 16x par les
// navigateurs : au-delà, la valeur est ignorée en silence et le résultat sort au
// mauvais rythme sans la moindre erreur. On borne donc explicitement la demande,
// on relit le taux réellement retenu par l'élément, et on prévient l'utilisateur
// quand l'accélération obtenue est inférieure à celle demandée.

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
            reject(pkg.t('Élément non trouvé'));
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
                reject(new Error(pkg.t('Timeout rendercomplete (5s) : rendu carte bloqué')));
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
                        reject(new Error(pkg.t('Aucun canvas trouvé dans la carte')));
                        return;
                    }

                    // Dimensions en pixels device (dpr) pour éviter le flou HiDPI :
                    // les canvas de la carte sont rendus par OpenLayers en pixels device.
                    const rect = viewport.getBoundingClientRect();
                    const dpr = getCaptureRatio();
                    const canvasWidth = Math.max(1, Math.floor(rect.width * dpr));
                    const canvasHeight = Math.max(1, Math.floor(rect.height * dpr));

                    // Canvas de sortie réutilisé entre frames (P4). Pas de
                    // willReadFrequently : canvas jamais relu (uniquement composité puis
                    // toBlob) ; willReadFrequently:true forçait un backing store CPU.
                    if (!imgOutCanvas) {
                        imgOutCanvas = document.createElement('canvas');
                        imgOutCtx = imgOutCanvas.getContext('2d');
                    }
                    // Ne redimensionner (ce qui réinitialise le bitmap) que si nécessaire.
                    if (imgOutCanvas.width !== canvasWidth || imgOutCanvas.height !== canvasHeight) {
                        imgOutCanvas.width = canvasWidth;
                        imgOutCanvas.height = canvasHeight;
                    }
                    const outCanvas = imgOutCanvas;
                    const ctx = imgOutCtx;
                    // Effacer la frame précédente (canvas réutilisé) avant de recomposer.
                    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

                    // Composer tous les canvas (carte + points WebGL + animations).
                    // Chaque canvas OL couvre le même viewport : l'étirer vers la taille de
                    // sortie mappe correctement les sources de résolution différente (P6).
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
                            reject(new Error(pkg.t('Échec conversion canvas en blob')));
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

                        // NB : recordingPerformanceMonitor.checkPerformance ignore le mode
                        // images (return anticipé) ; on ne l'appelle donc plus ici. Le suivi
                        // du temps de capture se fait via perfMetrics (bilan de fin).

                        try { updateProgress(); } catch(e) {}
                        resolve();
                    }, CAPTURE_IMAGE_TYPE, CAPTURE_IMAGE_QUALITY);
                } catch (error) {
                    reject(error);
                }
            });

            // Forcer un rendu complet (marquer animationLayer dirty pour que postrender fire)
            if (animationLayer) { animationLayer.changed(); }
            if (trailLayer) { trailLayer.changed(); }
            if (trailHeadLayer) { trailHeadLayer.changed(); }
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
                        }, CAPTURE_IMAGE_TYPE, CAPTURE_IMAGE_QUALITY);
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
    displayFeaturesForDates([date], pointOptions, flashOptions, record, infos);
}

// Traite un lot de jours consécutifs en une passe : un seul addFeatures et une
// seule mise à jour des infos, quel que soit le nombre de jours rattrapés par la
// frame rAF. Les enregistrements (frame par frame) passent toujours un jour unique.
function displayFeaturesForDates(dates, pointOptions, flashOptions, record, infos) {
    if (!dates || dates.length === 0) return;
    if (isEvolutionPage()) {
        displayEvolutionDates(dates, flashOptions, record, infos);
        return;
    }

    // OPTIMISATION PERFORMANCE : Utilise l'index pré-calculé au lieu du filter coûteux
    // Avant : filter() sur tous les points à chaque frame (très lent)
    // Après : lookup instantanée dans Map pré-calculé (très rapide)

    // IMPORTANT: n'ajouter que les nouveaux points du lot pour éviter l'accumulation de doublons
    // Les points des jours précédents restent déjà visibles car ajoutés aux itérations antérieures

    // Pour l'effet flash, utiliser seulement les points des dates du lot
    let newFeatures = [];
    if (dates.length === 1) {
        // Cas courant : réutiliser directement le tableau indexé, sans recopie.
        newFeatures = pkg.pointsByDate.get(dates[0].toDateString()) || [];
    } else {
        for (const date of dates) {
            appendPoints(newFeatures, pkg.pointsByDate.get(date.toDateString()));
        }
    }

    // Afficher seulement les points des jours du lot
    if (newFeatures.length > 0) {
        displayWebGLPoints(newFeatures, pointOptions, {
            at: sampleAppearClock(),
            // En mode impulsion, chaque point apparaît avec le même décalage que son
            // flash : la vague touche le point et son flash ensemble.
            delayMs: flashOptions.mode === 'impulse' ? staggerDelayMs : null,
        });
    }

    if (flashOptions.mode != "none") {
        // Animation de flash seulement pour les nouvelles features (dates du lot)
        if (record) {
            flashRecord(newFeatures, flashOptions);
        } else {
            flashFeatures(newFeatures, flashOptions);
        }
    }

    // Traits de déplacement : le stylo atteint (ou rattrape) les caches du lot et
    // part vers le prochain jour de trouvailles, pour y arriver à son apparition.
    if (trailState) advanceTravelTrail(dateToDayNumber(dates[dates.length - 1]), sampleAppearClock());

    // affiche éventuellement les infos demandées : la date affichée est celle du
    // dernier jour du lot, le compteur reçoit le total des points ajoutés.
    displayInfosForDate(infos, dates[dates.length - 1], newFeatures);

    if (pkg.options.animation?.cameraFollow) {
        // La caméra vise le barycentre des caches du jour ; c'est le lissage qui
        // fait le mouvement, pas ce saut de cible.
        const coordinates = newFeatures.map((feature) => ol.proj.fromLonLat([
            feature.geometry.coordinates[0],
            feature.geometry.coordinates[1],
        ]));
        const target = centroid(coordinates);
        const targetExtent = coordinates.length > 0 ? ol.extent.boundingExtent(coordinates) : null;
        cameraDynamism = normalizeCameraDynamism(pkg.options.animation?.cameraDynamism);
        const view = map.getView();
        if (target && shouldMoveCamera(
            view.getCenter(),
            view.getResolution(),
            map.getSize(),
            targetExtent,
            cameraDynamism,
        )) {
            cameraTarget = target;
            cameraJourney = null;
            cameraJourneyStartedAt = null;
            cameraTravelPending = true;
        }
    }

    // Source de changement principale de l'animation : signalée explicitement pour
    // que la frame suivante du compositing MR soit composée sans attendre le
    // postrender naturel d'OpenLayers (qui arriverait une frame plus tard).
    mapDirtyTracker.markDirty();
}

// affiche les infos (date, nb de caches) en fonction des jours
function displayInfosForDate(infos, date, featuresForDate) {
    if (infos.displayDate) {
        pkg.updateCurrentDate(date);
    }
    if (infos.displayNumberofCaches) {
        const newCaches = featuresForDate.length;
        infos.cacheNumber += newCaches
        // L'animation du compteur ne dure jamais plus d'un jour d'animation : la
        // valeur exacte du jour est toujours atteinte avant le jour suivant.
        cacheCountAnimator.setTarget(
            infos.cacheNumber,
            sampleAppearClock(),
            Math.min(COUNTER_ANIMATION_MS, animationMsPerDay()),
        );
    }    
}

// -------------- MODE ÉVOLUTION ------------------------------
//
// Toutes les caches filtrées sont ajoutées une seule fois à la source ; leur
// apparition (placement) et leur disparition (archivage) sont calculées par le
// style WebGL à partir des variables evo* (voir evolution_style.mjs), mises à
// jour par updatePointAppearClock. Les données et la chronologie vivent dans
// evolution_data.js ; ici, seulement ce qui touche la carte et l'animation.

// Remplace les points affichés par les caches de la sélection courante.
export function setEvolutionFeatures(olFeatures) {
    features = Array.isArray(olFeatures) ? olFeatures : [];
    if (vectorLayer && isLayerOnMap(map, vectorLayer) && window.vectorSource) {
        // Le layer garde son style : seules les features changent. Le recréer
        // à chaque filtre relancerait la compilation des shaders, et un layer
        // WebGL retiré pendant la préparation de ses buffers lève une erreur
        // dans OpenLayers.
        window.vectorSource.clear();
        if (features.length > 0) window.vectorSource.addFeatures(features);
        evolutionPointsLoaded = true;
    } else {
        clearMap();
        if (features.length > 0) displayWebGLPoints(features, pkg.options.point);
    }
    showEvolutionRestState();
}

// Cadre la vue sur l'étendue [ouest, sud, est, nord] (degrés) d'une base.
// Sert au mode Évolution et au cadrage automatique du mode principal
// (préférence map_framing = "fit", voir fitViewOnData dans bdd.js).
// onlyIfOutside : ne rien faire si la zone est déjà (en partie) visible, pour
// respecter un cadrage choisi par l'utilisateur.
export function fitMapView(lonLatExtent, { onlyIfOutside = false } = {}) {
    if (!map || !Array.isArray(lonLatExtent) || !lonLatExtent.every(Number.isFinite)) return;
    const extent = ol.proj.transformExtent(lonLatExtent, 'EPSG:4326', 'EPSG:3857');
    const view = map.getView();
    const size = map.getSize();
    if (onlyIfOutside && size) {
        const visible = view.calculateExtent(size);
        if (ol.extent.intersects(visible, extent)) return;
    }
    view.fit(extent, { padding: [40, 40, 40, 40], maxZoom: 13, size });
}

// Remet les caches dans la source si un nettoyage de la carte les en a retirées.
function ensureEvolutionPoints() {
    if (evolutionPointsLoaded && vectorLayer && isLayerOnMap(map, vectorLayer)) return;
    clearMap();
    if (features && features.length > 0) displayWebGLPoints(features, pkg.options.point);
}

// Carte au repos : état final à la date de fin, ligne d'infos et date à
// l'avenant (la date avant les compteurs : la balise {date} la lit).
export function showEvolutionRestState() {
    const rest = pkg.evolutionRestState?.();
    if (!rest) return;
    if (rest.date) pkg.updateCurrentDate(rest.date);
    resetEvolutionCounters(rest.values);
    mapDirtyTracker.markDirty();
    try { map.render(); } catch (_) {}
}

// Début d'animation ou d'enregistrement ; retourne les trois compteurs
// ({ actives, placees, archivees }) juste avant la date de début.
function beginEvolutionTimeline(startDate) {
    const disappear = pkg.options.flash?.disappear;
    if (disappear?.color) disappear.rgb = pkg.hexToRgb(disappear.color);
    if (disappear?.border_color) disappear.border_rgb = pkg.hexToRgb(disappear.border_color);
    return pkg.evolutionBegin?.(startDate, pkg.metadata.endDate, sampleAppearClock(),
        pkg.options.flash?.mode === 'impulse') || 0;
}

function endEvolutionTimeline() {
    pkg.evolutionEnd?.();
    showEvolutionRestState();
}

function hasTimelineData() {
    if (isEvolutionPage()) return !!pkg.evolutionHasData?.();
    return !!(pkg.pointsByDate && pkg.pointsByDate.size > 0);
}

// Mode du flash retenu pour la pause de fin : en mode Évolution, le flash de
// disparition compte aussi (il peut être le seul actif).
export function effectiveFlashMode() {
    const mode = pkg.options.flash?.mode || 'none';
    if (mode !== 'none' || !isEvolutionPage()) return mode;
    const disappear = pkg.options.flash?.disappear?.mode;
    return disappear && disappear !== 'none' ? 'circle' : 'none';
}

// Équivalent de displayFeaturesForDates pour le mode Évolution : aucun point
// n'est ajouté ni retiré, le jour courant avance et les flashs partent.
function displayEvolutionDates(dates, flashOptions, record, infos) {
    const at = sampleAppearClock();
    const ev = pkg.evolutionStep?.(dates, at);
    if (!ev) return;

    if (flashOptions.mode !== 'none' && ev.placed.length > 0) {
        pushFeatureFlashes(ev.placed, flashOptions, record, flashOptions.mode === 'impulse');
    }
    const disappear = pkg.options.flash?.disappear;
    if (disappear && disappear.mode && disappear.mode !== 'none' && ev.archived.length > 0) {
        pushFeatureFlashes(ev.archived, disappear, record, false);
    }
    if (ev.placed.length > 0 || ev.archived.length > 0) {
        extendPointsAnimation(at + Math.max(POINT_APPEAR_MS, POINT_DISAPPEAR_MS) + IMPULSE_MAX_STAGGER_MS);
    }

    if (infos.displayDate) pkg.updateCurrentDate(dates[dates.length - 1]);
    if (infos.displayNumberofCaches) {
        // Valeurs absolues des trois compteurs de la ligne d'infos : actives
        // présentes (monte et descend) et cumuls placées/archivées (ne font
        // que monter).
        const duration = Math.min(COUNTER_ANIMATION_MS, animationMsPerDay());
        evolutionCounters.actives.setTarget(ev.values.actives, at, duration);
        evolutionCounters.placees.setTarget(ev.values.placees, at, duration);
        evolutionCounters.archivees.setTarget(ev.values.archivees, at, duration);
        infos.cacheNumber = ev.values.actives;
    }

    mapDirtyTracker.markDirty();
    // Aucune feature n'a changé : rien ne redemande de rendu à OpenLayers.
    if (!isRecording && !isMediaRecording) map.render();
}

// Flashs de features OpenLayers (mode Évolution) : même file que flashRecord /
// flashFeatures, sans reconversion des coordonnées. Le décalage de vague est
// précalculé sur chaque feature (attribut 'stagger', en ms).
function pushFeatureFlashes(olFeatures, flashOptions, record, useStagger) {
    const durationMs = Math.max(0, Number(pkg.options.flash?.duration) || 0);
    if (record) {
        const maxFrames = Math.max(1, pkg.options.record.flashFrames || 1);
        const startFrame = globalRecordFrame;
        for (let i = 0; i < olFeatures.length; i++) {
            const feature = olFeatures[i];
            const delay = useStagger && durationMs > 0
                ? Math.round((Number(feature.get('stagger')) || 0) * maxFrames / durationMs)
                : 0;
            mapDirtyTracker.beginAnimation();
            activeFlashes.push({
                geometry: feature.getGeometry(),
                cacheType: feature.get('cache_type'),
                flashOptions,
                startFrame: startFrame + delay,
                maxFrames,
            });
        }
        return;
    }
    const start = sampleAppearClock(); // horloge des points, comme flashFeatures
    for (let i = 0; i < olFeatures.length; i++) {
        const feature = olFeatures[i];
        mapDirtyTracker.beginAnimation();
        activeFlashes.push({
            geometry: feature.getGeometry(),
            cacheType: feature.get('cache_type'),
            flashOptions,
            start: start + (useStagger ? (Number(feature.get('stagger')) || 0) : 0),
            duration: durationMs,
        });
    }
}

// -------------- TRAITS DE DÉPLACEMENT -------------------------
//
// Le trajet (étapes et polyligne) est calculé par travel_trail.mjs au lancement
// de la lecture ou de l'enregistrement, puis mémoïsé. Pendant l'animation, un
// « stylo » avance le long de la polyligne : à chaque jour de trouvailles
// affiché, il part vers le suivant pour y arriver quand ses caches apparaissent.
// Le dessin se fait dans le postrender d'une couche dédiée, directement sur le
// canvas : pas de géométrie OpenLayers créée à chaque frame.

// Période de la tête « pulsante », en ms d'horloge des points.
const TRAIL_PULSE_MS = 1200;
// Deux sommets consécutifs plus proches que cela (px écran) ne sont pas tracés
// séparément : moins de segments quand beaucoup d'étapes se superposent à
// l'écran (vue très dézoomée). Le coût restant est surtout la rastérisation.
const TRAIL_MIN_STEP_PX = 1.5;

function currentTrailOptions() {
    return normalizeTrailOptions(pkg.options.trail);
}

// Durée max réellement appliquée à un tracé : la borne 100-10000 ms vaut pour la
// saisie utilisateur, pas pour l'exécution — le ralentissement MediaRecorder
// multiplie la préférence pendant la capture et peut légitimement la dépasser.
function trailStrokeDurationMs() {
    const d = Number(pkg.options.trail?.duration);
    return Number.isFinite(d) && d > 0 ? d : TRAIL_DEFAULTS.duration;
}

// Deux couches : le trait SOUS les points (1001), pour mener aux caches sans
// jamais les masquer, et la tête (le géocacheur) AU-DESSUS, sinon elle
// disparaîtrait sous la cache sur laquelle elle vient de se poser. Les flashs
// (1100) restent au premier plan.
function ensureTrailLayers() {
    if (!trailLayer || !isLayerOnMap(map, trailLayer)) {
        trailLayer = new ol.layer.Vector({
            source: new ol.source.Vector(), style: null, zIndex: 1000, visible: false,
        });
        trailLayer.on('postrender', drawTravelTrail);
        map.addLayer(trailLayer);
    }
    if (!trailHeadLayer || !isLayerOnMap(map, trailHeadLayer)) {
        trailHeadLayer = new ol.layer.Vector({
            source: new ol.source.Vector(), style: null, zIndex: 1050, visible: false,
        });
        trailHeadLayer.on('postrender', drawTravelTrailHead);
        map.addLayer(trailHeadLayer);
    }
}

function setTrailLayersVisible(visible) {
    for (const layer of [trailLayer, trailHeadLayer]) {
        if (!layer) continue;
        layer.setVisible(visible);
        if (visible) layer.changed();
    }
}

// Clé de mémoïsation du trajet : révision de l'index des jours, réglages de
// tracé et borne de fin. Toute divergence invalide la géométrie calculée.
function trailGeometryKey(opts) {
    const endDay = dateToDayNumber(animationEndDate());
    return [
        pkg.pointsByDateRevision,
        opts.routing, opts.clusterKm, opts.jumpKm, opts.jumpStyle, opts.curve,
        Number.isFinite(endDay) ? endDay : 'all',
    ].join('|');
}

// Trajet de la sélection courante. Recalculé seulement si les données
// (révision de l'index des jours) ou les réglages de tracé ont changé :
// relancer une lecture ou un enregistrement ne coûte rien de plus.
function getTrailGeometry(opts) {
    const endDay = dateToDayNumber(animationEndDate());
    const key = trailGeometryKey(opts);
    if (trailGeometry?.key === key) return trailGeometry;

    const startedAt = performance.now();
    const days = [];
    for (const [dateKey, points] of pkg.pointsByDate.entries()) {
        const day = dateToDayNumber(new Date(dateKey));
        if (!Number.isFinite(day) || !points?.length) continue;
        // Les trouvailles postérieures à la date de fin ne font pas partie de
        // l'animation (le passé avant la date de début reste inclus : il
        // positionne le stylo).
        if (Number.isFinite(endDay) && day > endDay) continue;
        days.push({ day, points: points.map((feature) => feature.geometry.coordinates) });
    }
    const route = buildTrailRoute(days, opts);
    const path = buildTrailPath(route, {
        project: (lon, lat) => ol.proj.fromLonLat([lon, lat]),
        curve: opts.curve,
        jumpKm: opts.jumpKm,
        jumpStyle: opts.jumpStyle,
    });
    trailGeometry = { key, route, path, buildMs: performance.now() - startedAt };
    dbgMapgl('[TRAIL] Trajet calculé :', route.lon.length, 'étapes,', path.cum.length,
        'sommets en', trailGeometry.buildMs.toFixed(1), 'ms');
    return trailGeometry;
}

// À appeler au début d'une lecture ou d'un enregistrement, une fois les points
// antérieurs à la date de début affichés. `silent` supprime les toasts d'info :
// sur le chemin MediaRecorder, `isMediaRecording` n'est posé qu'au démarrage
// effectif du pipeline (il choisit la source de l'horloge), après cet appel.
function resetTravelTrail(silent = false) {
    // L'aperçu statique cède la place à l'animation ; l'arrêt de lecture, lui,
    // ne l'efface pas (clearTravelTrail ne touche pas trailPreview) : après un
    // stop, l'utilisateur revoit sa route.
    clearTrailPreview();
    clearTravelTrail();
    if (isEvolutionPage()) return;
    const opts = currentTrailOptions();
    if (!opts.enabled) return;

    let geometry;
    try {
        geometry = getTrailGeometry(opts);
    } catch (e) {
        console.warn('[TRAIL] Trajet impossible à calculer, animation sans traits :', e);
        return;
    }
    const { route, path } = geometry;
    // Le trait est activé mais sans effet visible : le dire, hors capture
    // (en enregistrement, un toast n'apparaîtrait pas dans la vidéo mais
    // dérangerait l'utilisateur qui la prépare).
    if (!silent && !isRecording && !isMediaRecording) {
        if (route.lon.length < 2) {
            pkg.showToast?.(pkg.t('Aucun déplacement à tracer pour cette sélection.'), 'info', pkg.t('Trajet'));
        } else if (route.fallbackDays.length > 0) {
            pkg.showToast?.(pkg.t('Journées très chargées : regroupement automatique appliqué sur le rayon choisi.'), 'info', pkg.t('Trajet'));
        }
    }
    const startDay = dateToDayNumber(animationStartDate());
    if (route.days.length === 0 || !Number.isFinite(startDay)) return;

    // Trouvailles antérieures à la date de début : le stylo part de la dernière
    // étape connue, sans que ce passé soit dessiné.
    const firstIdx = nextDayIndex(route, startDay - 1);
    const startLen = firstIdx > 0 ? lengthAtDay(route, path, firstIdx - 1) : 0;
    trailState = {
        route,
        path,
        startDay,
        startLen,
        hasHistory: firstIdx > 0,
        firstDay: firstIdx < route.days.length ? route.days[firstIdx] : Infinity,
        pen: { fromLen: startLen, toLen: startLen, startAt: -Infinity, endAt: -Infinity },
        shownDay: startDay - 1,
        shownAt: null,
        scheduledIdx: -1,
        approachPending: true,
    };
    trailDrawnMax = { vertices: 0, length: 0 };
    trailLastDrawMs = null;
    trailLastStrokeDurationMs = null;
    ensureTrailLayers();
    setTrailLayersVisible(true);
}

// Retire le trait (arrêt, fin d'enregistrement, nouvelles données).
// Ne touche pas volontairement trailPreview : l'aperçu survit à l'arrêt de la
// lecture (l'utilisateur revoit sa route). Il est effacé explicitement par
// resetTravelTrail (l'animation prend le relais), addVector (les données
// changent) et refreshTrailPreview (mode Évolution).
function clearTravelTrail() {
    setTrailAnimating(false);
    trailState = null;
    trailDrawnVertices = 0;
    setTrailLayersVisible(false);
}

// --- Aperçu statique du trajet ------------------------------------------------
//
// Le trajet calculé (étapes + polyligne mémoïsée) affiché tel quel, sans
// animation : tout le parcours à pleine opacité, style courant, pas de tête.
// Utile pour vérifier les réglages de tracé sans lancer la lecture.

export function isTrailPreviewActive() {
    return !!trailPreview;
}

export function toggleTrailPreview() {
    if (trailPreview) {
        clearTrailPreview();
        return false;
    }
    // Le trajet n'a pas de sens en mode Évolution (onglet absent) ; pendant
    // une lecture ou un enregistrement, l'aperçu serait de toute façon masqué
    // par l'animation — le bouton est alors désactivé côté UI. La pause garde
    // animationInProgress vrai (isIdleState seul la laisserait passer). Trajet
    // désactivé, l'aperçu reste ouvrable : il sert à régler avant d'activer.
    if (isEvolutionPage() || !isIdleState() || isAnimationInProgress()) return !!trailPreview;
    const opts = currentTrailOptions();

    let geometry;
    try {
        geometry = getTrailGeometry(opts);
    } catch (e) {
        console.warn('[TRAIL] Aperçu impossible à calculer :', e);
        return false;
    }
    if (geometry.route.lon.length < 2) {
        pkg.showToast?.(pkg.t('Aucun déplacement à tracer pour cette sélection.'), 'info', pkg.t('Trajet'));
        return false;
    }
    trailPreview = { route: geometry.route, path: geometry.path };
    ensureTrailLayers();
    // La couche de tête reste cachée : pas de géocacheur dans l'aperçu.
    trailLayer.setVisible(true);
    trailLayer.changed();
    return true;
}

function clearTrailPreview() {
    if (!trailPreview) return;
    trailPreview = null;
    // Sans animation en cours la couche n'a plus rien à dessiner ; sinon
    // l'animation la garde visible (le reprendre n'arrive que via
    // resetTravelTrail, qui réaffiche ensuite les deux couches).
    if (trailLayer) {
        if (!trailState) trailLayer.setVisible(false);
        else trailLayer.changed();
    }
}

// Réglages modifiés pendant l'aperçu : recalcul si la géométrie a divergé
// (la clé mémoïsée couvre routing/clusterKm/jumpKm/jumpStyle/curve et la
// borne de fin), redessin sinon. Le trajet désactivé ne ferme PAS l'aperçu :
// il est permis justement pour régler avant d'activer.
export function refreshTrailPreview() {
    if (!trailPreview) return;
    const opts = currentTrailOptions();
    if (isEvolutionPage()) {
        clearTrailPreview();
        return;
    }
    let geometry;
    try {
        geometry = getTrailGeometry(opts);
    } catch (e) {
        console.warn('[TRAIL] Aperçu impossible à recalculer :', e);
        clearTrailPreview();
        return;
    }
    trailPreview = { route: geometry.route, path: geometry.path };
    trailLayer?.changed();
}

// Premier trajet : planifié comme si la veille de la date de début venait de
// s'afficher. Appelé par startAnimation, donc APRÈS l'éventuel ralentissement
// MediaRecorder : durées et rythme sont ceux de la capture. En image par image,
// le premier jour s'affiche dès la frame 0 et c'est lui qui lance le stylo.
function startTravelTrailApproach() {
    if (!trailState?.approachPending) return;
    scheduleTravelTrail(trailState.startDay - 1, sampleAppearClock());
}

// Un lot de jours vient de s'afficher ; `lastDay` est son dernier jour.
function advanceTravelTrail(lastDay, now) {
    if (!trailState || !Number.isFinite(lastDay)) return;
    scheduleTravelTrail(lastDay, now);
}

function scheduleTravelTrail(lastDay, now) {
    const state = trailState;
    state.approachPending = false;
    state.shownDay = lastDay;
    state.shownAt = now;

    const { route, path } = state;
    const nextIdx = nextDayIndex(route, lastDay);
    // Jour sans trouvaille : le trait déjà planifié poursuit sa route.
    if (nextIdx === state.scheduledIdx) return;
    state.scheduledIdx = nextIdx;

    // Durée brute de la préférence (non bornée) : le ralentissement
    // MediaRecorder la multiplie au-delà de la saisie maximale autorisée.
    const maxDurationMs = trailStrokeDurationMs();
    state.lastStrokeDurationMs = maxDurationMs;
    trailLastStrokeDurationMs = maxDurationMs;
    const msPerDay = animationMsPerDay();
    // Étapes déjà affichées : le stylo doit les avoir atteintes, sinon il est en
    // retard et repart immédiatement.
    const behindLen = Math.max(state.startLen, nextIdx > 0 ? lengthAtDay(route, path, nextIdx - 1) : 0);
    let targetLen;
    let arrivalAt;
    if (nextIdx < route.days.length) {
        targetLen = lengthAtDay(route, path, nextIdx);
        // Estimation : les jours défilent au rythme configuré. Si le suivi de
        // caméra fait attendre une date, le stylo arrive en avance et patiente.
        arrivalAt = now + (route.days[nextIdx] - lastDay) * msPerDay;
    } else {
        targetLen = behindLen;
        arrivalAt = now + Math.min(maxDurationMs, msPerDay);
    }
    state.pen = scheduleStroke(state.pen, { now, targetLen, arrivalAt, maxDurationMs, behindLen });
    mapDirtyTracker.markDirty();
}

// Avant chaque rendu : vrai tant que le trait change d'une frame à l'autre
// (stylo en mouvement ou en attente de départ, fondu de la traînée pendant
// l'animation), pour entretenir le rendu et le compositing MediaRecorder.
function updateTravelTrail(now) {
    const state = trailState;
    let active = false;
    if (state && pkg.options.trail?.enabled === true) {
        active = now < state.pen.endAt
            || (isAnimationInProgress() && state.shownAt !== null && now - state.shownAt < animationMsPerDay());
    }
    setTrailAnimating(active);
    return active;
}

function setTrailAnimating(active) {
    if (active === trailAnimating) return;
    trailAnimating = active;
    if (active) mapDirtyTracker.beginAnimation();
    else mapDirtyTracker.endAnimation();
}

// État du trait pour la frame en cours, commun au trait et à sa tête. null si
// rien n'est à dessiner.
function trailFrame(event) {
    const state = trailState;
    const frameState = event.frameState;
    if (!state) {
        // Aperçu statique : tout le trajet est déjà « tracé » (stylo en bout
        // de chemin, jour courant infini). L'animation, si elle tourne,
        // l'emporte sur l'aperçu.
        if (!trailPreview) return null;
        const opts = currentTrailOptions();
        if (!opts.enabled) return null;
        return {
            state: {
                path: trailPreview.path,
                route: trailPreview.route,
                startDay: -Infinity,
                hasHistory: false,
            },
            preview: true,
            opts,
            now: sampleAppearClock(),
            penLen: trailPreview.path.length,
            dayNow: Infinity,
            ratio: frameState.pixelRatio || 1,
            m: composeTransform(event.inversePixelTransform, frameState.coordinateToPixelTransform),
        };
    }
    const opts = currentTrailOptions();
    if (!opts.enabled) return null;
    const now = sampleAppearClock();
    // Jour courant en continu, pour un fondu sans à-coups : au plus un jour
    // après le dernier affiché (pause, attente du suivi de caméra).
    const msPerDay = Math.max(1, animationMsPerDay());
    const elapsed = state.shownAt === null ? 0 : (now - state.shownAt) / msPerDay;
    return {
        state,
        opts,
        now,
        penLen: penLengthAt(state.pen, now),
        dayNow: state.shownDay + Math.min(1, Math.max(0, elapsed)),
        ratio: frameState.pixelRatio || 1,
        m: composeTransform(event.inversePixelTransform, frameState.coordinateToPixelTransform),
    };
}

// Listener postrender de trailLayer : le trait lui-même.
function drawTravelTrail(event) {
    const startedAt = performance.now();
    trailDrawnVertices = 0;
    const frame = trailFrame(event);
    if (!frame) return;
    const { state, opts, penLen, dayNow, ratio, m } = frame;
    const { path } = state;
    // Aperçu : tout le trajet (minDay = -Infinity) à pleine opacité, sans le
    // fondu de persistance — c'est le tracé calculé, pas la traînée animée.
    const minDay = frame.preview ? -Infinity
        : opts.persistDays > 0
            ? Math.max(state.startDay, dayNow - opts.persistDays)
            : state.startDay;
    const range = visibleVertexRange(path, penLen, minDay);
    if (!range) return;

    const ctx = event.context;
    const width = opts.width * ratio;
    const alpha = opts.opacity / 100;
    const bucketOf = frame.preview
        ? () => 1
        : (v) => opacityBucket(trailOpacity(dayNow - path.vday[v], opts.persistDays));
    const runs = splitTrailRuns(path.kind, bucketOf, range.first, range.last);
    // Longueur de carte -> pixels du canvas, pour caler les tirets sur la
    // distance parcourue : le motif ne « glisse » pas quand la queue avance.
    const pxPerUnit = ratio / event.frameState.viewState.resolution;
    const dash = {
        solid: [],
        dashed: [width * 3, width * 2],
        dotted: [0.01, width * 2.2],
    }[opts.lineStyle];
    const jumpDash = [width * 1.2, width * 2.4];

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = opts.color;
    for (const glow of opts.effect === 'glow' ? [true, false] : [false]) {
        for (const run of runs) {
            if (run.kind === SEGMENT_HIDDEN || run.bucket <= 0) continue;
            if (glow) {
                ctx.setLineDash([]);
                ctx.lineWidth = width * 3;
                ctx.globalAlpha = alpha * run.bucket * 0.22;
            } else {
                ctx.setLineDash(run.kind === SEGMENT_JUMP_DASHED ? jumpDash : dash);
                ctx.lineDashOffset = path.cum[run.start - 1] * pxPerUnit;
                ctx.lineWidth = width;
                ctx.globalAlpha = alpha * run.bucket;
            }
            strokeTrailRun(ctx, path, run, range, m, TRAIL_MIN_STEP_PX * ratio);
        }
    }
    ctx.restore();
    trailDrawnMax.vertices = Math.max(trailDrawnMax.vertices, trailDrawnVertices);
    trailDrawnMax.length = Math.max(trailDrawnMax.length, penLen);
    trailLastDrawMs = performance.now() - startedAt;
}

// Listener postrender de trailHeadLayer : la tête, c'est-à-dire le géocacheur.
// Masquée avant qu'il ait une position connue, et pendant un grand saut
// « masqué » (il se téléporte).
function drawTravelTrailHead(event) {
    const frame = trailFrame(event);
    // Pas de tête dans l'aperçu : rien ne se déplace, un point fixe en bout de
    // trajet ferait croire à une position courante.
    if (!frame || frame.preview || frame.opts.head === 'none') return;
    const { state, opts, now, penLen, ratio, m } = frame;
    const { path } = state;
    const started = state.hasHistory || penLen > state.startLen + 1e-6 || state.shownDay >= state.firstDay;
    if (!started) return;
    const head = pointAtLength(path, penLen);
    if (!head) return;
    if (path.kind[head.segment] === SEGMENT_HIDDEN && penLen < path.cum[head.segment] - 1e-6) return;

    const ctx = event.context;
    const hx = m[0] * head.x + m[2] * head.y + m[4];
    const hy = m[1] * head.x + m[3] * head.y + m[5];
    const radius = Math.max(2.5, opts.width * 1.4) * ratio;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.fillStyle = opts.color;
    if (opts.head === 'pulse') {
        const phase = (((now % TRAIL_PULSE_MS) + TRAIL_PULSE_MS) % TRAIL_PULSE_MS) / TRAIL_PULSE_MS;
        ctx.globalAlpha = (1 - phase) * 0.7;
        ctx.lineWidth = 1.5 * ratio;
        ctx.beginPath();
        ctx.arc(hx, hy, radius * (1 + 1.8 * phase), 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(hx, hy, radius, 0, Math.PI * 2);
    ctx.fill();
    // Liseré clair : la tête reste lisible sur un fond de la même couleur.
    ctx.lineWidth = 1.2 * ratio;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();
    ctx.restore();
}

// Trace un tronçon (segments run.start..run.end) en un seul stroke. Le dernier
// segment visible s'arrête au stylo s'il est en cours de tracé.
function strokeTrailRun(ctx, path, run, range, m, minStep) {
    const xy = path.xy;
    const v0 = run.start - 1;
    let lastX = m[0] * xy[2 * v0] + m[2] * xy[2 * v0 + 1] + m[4];
    let lastY = m[1] * xy[2 * v0] + m[3] * xy[2 * v0 + 1] + m[5];
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    for (let v = run.start; v <= run.end; v++) {
        let x = xy[2 * v];
        let y = xy[2 * v + 1];
        if (v === range.last && range.partial) [x, y] = range.point;
        const px = m[0] * x + m[2] * y + m[4];
        const py = m[1] * x + m[3] * y + m[5];
        if (v < run.end && Math.abs(px - lastX) + Math.abs(py - lastY) < minStep) continue;
        ctx.lineTo(px, py);
        lastX = px;
        lastY = py;
        trailDrawnVertices++;
    }
    ctx.stroke();
}

// Un réglage d'apparence a changé : le trait affiché (animation, aperçu ou
// trait terminé) est redessiné tout de suite, sans attendre la frame suivante.
export function refreshTravelTrailStyle() {
    if ((trailState || trailPreview) && trailLayer?.getVisible()) map.render();
}

// Vrai si les réglages de tracé ont divergé de la géométrie mémoïsée : le trait
// affiché (animation en cours ou terminée) ne reflète pas les derniers réglages.
export function isTrailGeometryStale() {
    return !!trailGeometry && trailGeometry.key !== trailGeometryKey(currentTrailOptions());
}

// État observable du trait, pour les tests navigateur et le diagnostic.
export function getTravelTrailDebugState() {
    const state = trailState;
    const now = pointAppearClock.last;
    return {
        active: !!state,
        preview: !!trailPreview,
        layerVisible: !!trailLayer?.getVisible(),
        stops: trailGeometry?.route.lon.length ?? 0,
        vertices: trailGeometry?.path.cum.length ?? 0,
        fallbackDays: trailGeometry?.route.fallbackDays?.length ?? 0,
        totalLength: trailGeometry?.path.length ?? 0,
        startLength: state?.startLen ?? 0,
        penLength: state ? penLengthAt(state.pen, now) : 0,
        drawnVertices: trailDrawnVertices,
        maxDrawnVertices: trailDrawnMax.vertices,
        maxDrawnLength: trailDrawnMax.length,
        buildMs: trailGeometry?.buildMs ?? null,
        lastDrawMs: trailLastDrawMs,
        // trailState disparaît à l'arrêt (clearTravelTrail) : repli sur la
        // valeur conservée pour le diagnostic post-enregistrement.
        strokeDurationMs: state?.lastStrokeDurationMs ?? trailLastStrokeDurationMs,
    };
}

// -------------- FLASH ---------------------------------------

function flashGeometry(featureData) {
    return new ol.geom.Point(ol.proj.fromLonLat([
        featureData.geometry.coordinates[0],
        featureData.geometry.coordinates[1]
    ]));
}

// Enregistrement : l'avancement d'un flash se compte en captures
// (globalRecordFrame), pas en temps réel, pour rester déterministe.
function flashRecord(features, flashOptions = pkg.options.flash) {
    const maxFrames = Math.max(1, pkg.options.record.flashFrames || 1);
    // Capturer la valeur de globalRecordFrame au moment de l'appel (frame de départ du flash)
    const startFrame = globalRecordFrame;

    const stagger = flashOptions.mode === 'impulse';

    features.forEach(featureData => {
        const [lon, lat] = featureData.geometry.coordinates;
        // Un flash en cours redessine la carte à chaque rendu : le compositing MR
        // ne peut donc rien sauter tant qu'il n'est pas terminé.
        mapDirtyTracker.beginAnimation();
        activeFlashes.push({
            geometry: flashGeometry(featureData),
            cacheType: featureData.properties?.cache_type,
            flashOptions,
            startFrame: startFrame + (stagger ? staggerDelayFrames(lon, lat, maxFrames, flashOptions.duration) : 0),
            maxFrames,
        });
    });
}

// Lecture live : l'avancement se mesure sur l'horloge des points
// (sampleAppearClock), qui exclut les pauses : un flash se fige avec les
// points au lieu de se terminer pendant la pause.
function flashFeatures(features, flashOptions) {
    const start = sampleAppearClock();
    // Durée figée au lancement du flash ; forme, taille et couleur restent relues
    // à chaque frame (voir flashStyleAt).
    const duration = flashOptions.duration;
    const stagger = flashOptions.mode === 'impulse';

    features.forEach(featureData => {
        const [lon, lat] = featureData.geometry.coordinates;
        mapDirtyTracker.beginAnimation();
        activeFlashes.push({
            geometry: flashGeometry(featureData),
            cacheType: featureData.properties?.cache_type,
            flashOptions,
            start: start + (stagger ? staggerDelayMs(lon, lat) : 0),
            duration,
        });
    });
}

// Unique listener postrender de animationLayer : dessine tous les flashs actifs
// et retire ceux qui sont terminés. Un flash dont le départ est décalé (mode
// impulsion) reste en attente, sans être dessiné, jusqu'à son tour.
function drawActiveFlashes(event) {
    if (activeFlashes.length === 0 && !flashPreview) return;

    // Même horloge que flashFeatures : figée pendant une pause.
    const now = sampleAppearClock();
    let vectorContext = null;
    let liveFlashPending = false;
    let kept = 0;

    for (const flash of activeFlashes) {
        let step, steps;
        if (flash.maxFrames !== undefined) {
            // elapsed = nombre de captures depuis le début de ce flash
            step = globalRecordFrame - flash.startFrame;
            steps = flash.maxFrames;
            if (step >= steps) {
                mapDirtyTracker.endAnimation();
                continue;
            }
        } else {
            const elapsed = now - flash.start;
            if (elapsed >= flash.duration) {
                mapDirtyTracker.endAnimation();
                continue;
            }
            liveFlashPending = true;
            if (elapsed >= 0) ({ step, steps } = liveFlashStep(elapsed, flash.duration));
        }
        activeFlashes[kept++] = flash;
        if (!(step >= 0)) continue; // départ décalé pas encore atteint

        const style = flashStyleAt(step, steps, flash.flashOptions, flash.cacheType);
        if (style) {
            vectorContext ??= ol.render.getVectorContext(event);
            for (const layerStyle of (Array.isArray(style) ? style : [style])) {
                vectorContext.setStyle(layerStyle);
                vectorContext.drawGeometry(flash.geometry);
            }
        }
    }
    activeFlashes.length = kept;

    // Aperçu du flash : la vague qui s'achève enfile tout de suite la suivante
    // (avec sa petite pause de départ) — sans cela la boucle de rendu
    // s'arrêterait entre deux vagues.
    if (flashPreview && activeFlashes.length === 0) queueFlashPreviewRound();

    // En capture MediaRecorder, la boucle de dessin (renderSync @fps) pilote déjà
    // les rendus : se re-planifier ici via map.render() doublerait (voire pire, en
    // rafale rAF) le rendu par frame → saccades. On ne le fait qu'en lecture live,
    // et pas en pause : les flashs y sont figés, la reprise relance le rendu.
    // En aperçu, la file non vide entretient la boucle jusqu'à la vague suivante ;
    // file vide = plus de cible à l'écran, le prochain rendu (pan, zoom)
    // retentera l'échantillonnage.
    if ((liveFlashPending || (flashPreview && activeFlashes.length > 0))
            && !isMediaRecording && livePausedAt === null) {
        map.render();
    }
}


function createFlashElements(){
    if (animationLayer) {
        map.removeLayer(animationLayer);
        // Les flashs encore actifs sont abandonnés avec la couche (voir plus bas) :
        // ils ne décrémenteront plus le compteur d'animations eux-mêmes.
        mapDirtyTracker.resetAnimations();
        resetPointAppearAnimation();
    }
    animationSource = new ol.source.Vector();
    animationLayer = new ol.layer.Vector({
        source: animationSource,
        style: null,
        zIndex: 1100
    });
    map.addLayer(animationLayer);
    // Les flashs de l'ancienne couche ne seront plus dessinés : on repart à vide.
    activeFlashes = [];
    // Lancement d'une lecture ou d'un enregistrement : les vrais flashs
    // occupent la file, l'aperçu s'arrête (le bouton se resynchronise à la
    // prochaine maj de la barre de contrôle).
    flashPreview = false;
    animationLayer.on('postrender', drawActiveFlashes);
}

// --- Aperçu du flash -------------------------------------------------------
// Rejoue le flash en boucle sur un échantillon de caches visibles, sans
// lancer l'animation : la forme, la taille et les couleurs se jugent sur le
// fond de carte réel, à côté des vrais points. Chaque vague est une série de
// flashs « live » ordinaires dans activeFlashes — même dessin, même horloge
// que la lecture (sampleAppearClock tourne aussi au repos).
const FLASH_PREVIEW_MAX_POINTS = 8;  // au-delà, l'écran se couvre
const FLASH_PREVIEW_GAP_MS = 600;    // souffle entre deux vagues

// Vrai tant que l'aperçu est demandé. Aucune géométrie n'est conservée :
// chaque vague ré-échantillonne la vue, ce qui suit le déplacement de la
// carte et les changements de sélection sans recalcul explicite.
let flashPreview = false;
// Nombre de vagues enfilées depuis l'ouverture : la boucle se prouve sans
// observer le canvas (specs e2e, diagnostic).
let flashPreviewWaves = 0;

export function isFlashPreviewActive() {
    return !!flashPreview;
}

// État exposé pour les specs e2e et le diagnostic (cf.
// getTravelTrailDebugState) : bascule, file en cours, vagues déjà parties.
export function getFlashPreviewDebugState() {
    return {
        preview: !!flashPreview,
        waves: flashPreviewWaves,
        queued: activeFlashes.length,
        layerVisible: animationLayer ? animationLayer.getVisible() === true : false,
    };
}

// Bascule calquée sur toggleTrailPreview : refusée pendant la lecture ou
// l'enregistrement (les vrais flashs occupent alors la file) et quand la
// forme est « aucun » — il n'y a rien à rejouer.
export function toggleFlashPreview() {
    if (flashPreview) {
        clearFlashPreview();
        return false;
    }
    if (!isIdleState() || isAnimationInProgress()) return false;
    if (pkg.options.flash?.mode === 'none') {
        pkg.showToast?.(pkg.t('Choisissez d’abord une forme de flash.'), 'info', pkg.t('Flash'));
        return false;
    }
    if (pickFlashPreviewFeatures().length === 0) {
        pkg.showToast?.(pkg.t('Aucune cache visible à l’écran : déplacez la carte au-dessus de vos points.'), 'info', pkg.t('Flash'));
        return false;
    }
    // animationLayer ne naît qu'au premier lancement d'animation : l'aperçu
    // doit pouvoir s'ouvrir avant toute lecture ; les nettoyages de fin
    // l'avaient éventuellement laissée masquée.
    if (!animationLayer) createFlashElements();
    else if (!animationLayer.getVisible()) animationLayer.setVisible(true);
    flashPreview = true;
    flashPreviewWaves = 0;
    map.render();
    return true;
}

// Fermeture : les vagues déjà en file jouent jusqu'au bout (fondu naturel),
// la suivante ne sera plus enfilée — cf. queueFlashPreviewRound.
function clearFlashPreview() {
    flashPreview = false;
}

// Cibles d'une vague : jusqu'à FLASH_PREVIEW_MAX_POINTS caches dans la vue
// courante, mélangées par type (« Couleurs GC » ne se juge que si plusieurs
// types clignotent ensemble) et étirées dans chaque groupe pour disperser
// les cibles. En mode Évolution, la source contient aussi les caches hors
// vue temporelle (pas encore placées ou déjà disparues) : flasher un
// emplacement vide serait trompeur, on ne garde que le visible à l'instant.
function pickFlashPreviewFeatures() {
    if (!map || !window.vectorSource) return [];
    const extent = map.getView().calculateExtent(map.getSize());
    const restDay = isEvolutionPage() ? pointStyleVariables.evoDay : null;
    const byType = new Map();
    window.vectorSource.forEachFeatureInExtent(extent, (feature) => {
        if (restDay !== null) {
            const placed = Number(feature.get('placedDay')) || 0;
            const archived = Number(feature.get('archivedDay')) || 0;
            if (!(placed <= restDay && archived > restDay)) return;
        }
        const type = feature.get('cache_type') || '';
        let bucket = byType.get(type);
        if (!bucket) byType.set(type, bucket = []);
        // Plafond par type : l'échantillonnage reste borné quand la vue
        // couvre des dizaines de milliers de caches.
        if (bucket.length < FLASH_PREVIEW_MAX_POINTS * 4) bucket.push(feature);
    });
    // Indice échelonné dans chaque groupe puis rotation entre types.
    const queues = [...byType.values()].map((bucket) => {
        const take = Math.min(bucket.length, FLASH_PREVIEW_MAX_POINTS);
        const step = bucket.length / take;
        const queue = [];
        for (let i = 0; i < take; i++) queue.push(bucket[Math.floor(i * step)]);
        return queue;
    });
    const picked = [];
    while (picked.length < FLASH_PREVIEW_MAX_POINTS) {
        let progressed = false;
        for (const queue of queues) {
            if (picked.length >= FLASH_PREVIEW_MAX_POINTS) break;
            const feature = queue.shift();
            if (feature) { picked.push(feature); progressed = true; }
        }
        if (!progressed) break;
    }
    return picked;
}

// Une vague de l'aperçu : un flash par cache de l'échantillon, dont le départ
// est différé d'un souffle pour laisser la vague précédente s'achever. Les
// réglages sont relus à chaque vague (forme, taille, durée) et à chaque frame
// par flashStyleAt (couleurs) : modifier l'onglet s'applique sans réarmer
// l'aperçu — sauf « aucun », qui ferme la boucle.
function queueFlashPreviewRound() {
    const flashOptions = pkg.options.flash;
    if (!flashOptions || flashOptions.mode === 'none') {
        clearFlashPreview();
        return;
    }
    const duration = Math.max(1, Number(flashOptions.duration) || 0);
    const stagger = flashOptions.mode === 'impulse';
    const start = sampleAppearClock() + FLASH_PREVIEW_GAP_MS;
    const targets = pickFlashPreviewFeatures();
    if (targets.length > 0) flashPreviewWaves++;
    for (const feature of targets) {
        const [lon, lat] = ol.proj.toLonLat(feature.getGeometry().getCoordinates());
        // Même raison que pushFeatureFlashes : un flash en cours empêche le
        // compositing d'enregistrement de sauter des rendus.
        mapDirtyTracker.beginAnimation();
        activeFlashes.push({
            geometry: feature.getGeometry(),
            cacheType: feature.get('cache_type'),
            flashOptions,
            start: start + (stagger ? staggerDelayMs(lon, lat) : 0),
            duration,
        });
    }
}
