import * as pkg from './index.js';
import { showBsTab, getBsTab, initTomSelect, getTomSelect, refreshTomSelect, initTempusDominus, getTempusDominus, setTdDate, getTdDate } from './ui_bootstrap.js';
import { automaticEndHoldMs } from './video_timing.mjs';
import {
    RECORDING_LIMITS,
    RECORDING_QUALITY_PROFILES,
    estimateRecordingSizeBytes,
    formatEstimatedFileSize,
    isValidRecordingInteger,
    normalizeRecordingBitrateMbps,
    normalizeRecordingFps,
    recordingQualityProfileFor,
} from './recording_settings.mjs';

// Flag de debug pour les filtres (COUNTRY/FILTER).
// Mettre à true pour réactiver les logs en console.
const DEBUG_FILTERS = false;
const dbgFilters = (...args) => { if (DEBUG_FILTERS) console.log(...args); };

// Flag de debug général pour le reste de ce fichier. Mettre à true pour
// réactiver les logs en console (désactivés par défaut : sérialiser des
// objets/chaînes à chaque appel a un coût, sensible sur les chemins fréquents).
const DEBUG_UI = false;
const dbgUi = (...args) => { if (DEBUG_UI) console.log(...args); };

// Variables globales pour les éléments UI
var btnOSM, btnWatercolor, btnStamenToner, btnVectorMap;
var divVectorMapOptions, divTonerMapOptions;
var btnStamenTonerLight, btnStamenTonerDark;
var cpPointCenterColor, cpPointBorderColor;
var radioFillColorPoint, radioborderColorPoint;
var switchIconeVectoriel, selectShape;
// Filtres BDD - boutons d'aide
var btnAllType, btnNoneType, btnAllDifficulty, btnNoneDifficulty, btnAllTerrain, btnNoneTerrain, btnAllContainer, btnNoneContainer;
var infoType, infoDifficulty, infoTerrain, infoContainer;
var debounceTimer = null;
const DEBOUNCE_DELAY = 200; // ms
var isBatchReset = false; // court-circuite le debounce pendant un reset groupé
// Dates par défaut (capture au chargement BDD)
var defaultStartDate = null;
var defaultEndDate = null;
// Dates de publication par défaut
var defaultPublishedStartDate = null;
var defaultPublishedEndDate = null;
// Pays/Etats
let countryToStates = {};
var inputTimePerDay;
var inputExtraEndTime;
var selectFlashMode, inputTimeFlash, inputSizeFlash, cpFlashColor;
var cpStrokeColor, cpFillColor, cpBackgroundColor, strokeWidth;
var cbDisplayTitle, cbDisplayNumberofCaches, cbDisplayCurrentDate, inputTitle;
var inputTitleCss, inputInfosCss, btnTitleCss, btnInfosCss;
var spanNbCaches, spanCurrentDate;
let overlayCssDefaultsReady = Promise.resolve();
let overlayCssDefaultsStarted = false;
var selectLanguage, selectCheckVersionOnline, buttonCheckVersion, buttonHome;
var inputMapCenterLat, inputMapCenterLon, inputMapCenterCombined, inputMapDefaultZoom;
var btnUseCurrentMapCenter, btnPickMapCenter, btnClearMapCenter;
var btnToggleLatLonMode, fieldLat, fieldLon, fieldCombined, rowLatLon;
let isCombinedLatLonMode = true;
// Enregistrement
var selectRecordMode, selectRecordQualityProfile, recordAdvancedSettings, inputRecordFps, inputRecordBitrate, selectRecordMime, inputRecordSlowdown, inputRecordScaleFactor, cbRecordUpload, cbRecordDownload, cbRecordNormalize;
var cbRecordAudioEnable, inputAudioFile, inputAudioVolume;
// Flag pour savoir si la durée totale est définie depuis la musique
var isDurationLockedToAudio = false;

const LANGUAGE_COOKIE_NAME = 'gcmap_lang';

function persistLanguagePreference(language) {
    if (!language) return;
    localStorage.setItem('selectedLanguage', language);
    // Cookie lisible côté serveur pour Flask-Babel
    document.cookie = `${LANGUAGE_COOKIE_NAME}=${language}; path=/; max-age=31536000; samesite=Lax`;
}

function setRecordingInputValidity(input, limits) {
    if (!input) return false;
    const isValid = isValidRecordingInteger(input.value, limits);
    input.classList.toggle('is-invalid', !isValid);
    input.setAttribute('aria-invalid', isValid ? 'false' : 'true');
    return isValid;
}

function normalizeRecordOptionsInPlace() {
    pkg.options.record = pkg.options.record || {};
    pkg.options.record.mediaRecorder = pkg.options.record.mediaRecorder || {};
    pkg.options.record.fps = normalizeRecordingFps(pkg.options.record.fps);
    const bitrateMbps = normalizeRecordingBitrateMbps(
        Number(pkg.options.record.mediaRecorder.videoBitsPerSecond) / 1_000_000
    );
    pkg.options.record.mediaRecorder.videoBitsPerSecond = bitrateMbps * 1_000_000;
}

function syncRecordingQualityProfile({ revealCustom = false } = {}) {
    if (!selectRecordQualityProfile || !inputRecordFps || !inputRecordBitrate) return;
    const valuesAreValid = isValidRecordingInteger(inputRecordFps.value, RECORDING_LIMITS.fps)
        && isValidRecordingInteger(inputRecordBitrate.value, RECORDING_LIMITS.bitrateMbps);
    const profileName = valuesAreValid
        ? recordingQualityProfileFor(inputRecordFps.value, inputRecordBitrate.value)
        : 'custom';
    selectRecordQualityProfile.value = profileName;
    if (recordAdvancedSettings && profileName === 'custom' && revealCustom) {
        recordAdvancedSettings.open = true;
    }
}

function finalizeRecordingNumberInput(input, normalizer, limits) {
    if (!input) return;
    input.value = String(normalizer(input.value));
    setRecordingInputValidity(input, limits);
    syncRecordingQualityProfile();
    changeRecordValues();
}

function onRecordingQualityInput() {
    setRecordingInputValidity(inputRecordFps, RECORDING_LIMITS.fps);
    setRecordingInputValidity(inputRecordBitrate, RECORDING_LIMITS.bitrateMbps);
    syncRecordingQualityProfile({ revealCustom: true });
    changeRecordValues();
}

function applyRecordingQualityProfile() {
    if (!selectRecordQualityProfile) return;
    const profile = RECORDING_QUALITY_PROFILES[selectRecordQualityProfile.value];
    if (!profile) {
        if (recordAdvancedSettings) recordAdvancedSettings.open = true;
        return;
    }
    if (inputRecordFps) inputRecordFps.value = String(profile.fps);
    if (inputRecordBitrate) inputRecordBitrate.value = String(profile.bitrateMbps);
    setRecordingInputValidity(inputRecordFps, RECORDING_LIMITS.fps);
    setRecordingInputValidity(inputRecordBitrate, RECORDING_LIMITS.bitrateMbps);
    if (recordAdvancedSettings) recordAdvancedSettings.open = false;
    changeRecordValues();
}

function recordingOutputDurationMs() {
    const calculatedDuration = Number(pkg.options.record?.totalTimeInMilliSec);
    const fallbackDuration = (
        Math.max(1, Number(pkg.metadata?.deltaDays) || 1)
        * Math.max(0, Number(pkg.options.animation?.timePerDay) || 0)
    ) + getExtraEndMs() + getAutomaticEndHoldMs();
    const baseDuration = Number.isFinite(calculatedDuration) && calculatedDuration > 0
        ? calculatedDuration
        : fallbackDuration;
    const slowdown = Math.max(1, Number(pkg.options.record?.mediaRecorder?.slowdownFactor) || 1);
    const normalize = pkg.options.record?.mediaRecorder?.offlineNormalization ?? true;
    return baseDuration * (normalize ? 1 : slowdown);
}

function formatEstimatedDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

function updateRecordingSizeEstimate() {
    const sizeElement = document.getElementById('recordEstimatedSize');
    const durationElement = document.getElementById('recordEstimatedDuration');
    if (!sizeElement || !durationElement) return;
    const durationMs = recordingOutputDurationMs();
    const bitrateMbps = normalizeRecordingBitrateMbps(
        Number(pkg.options.record?.mediaRecorder?.videoBitsPerSecond) / 1_000_000
    );
    sizeElement.textContent = formatEstimatedFileSize(
        estimateRecordingSizeBytes({ bitrateMbps, durationMs })
    );
    durationElement.textContent = formatEstimatedDuration(durationMs);
}

// Fonction pour mettre à jour l'apparence du label selon si la durée est lockée
function updateDurationLockIndicator() {
    const label = document.getElementById('labelTotalTime');
    if (label) {
        if (isDurationLockedToAudio) {
            const lockedText = label.getAttribute('data-locked-text') || 'Temps total (minutes) - défini par musique';
            label.innerHTML = '<i class="ti ti-music me-1" aria-hidden="true"></i>' + lockedText;
            label.style.color = '#2196F3'; // Bleu Material Design
        } else {
            const normalText = label.getAttribute('data-normal-text') || 'Temps total (minutes)';
            label.innerHTML = normalText;
            label.style.color = ''; // Couleur par défaut
        }
    }
}

// Fonction pour mettre à jour l'indicateur de correspondance des durées
async function updateDurationMatchIndicator() {
    const indicator = document.getElementById('durationMatchIndicator');
    const btnSetDuration = document.getElementById('btnSetDurationFromAudio');

    if (!indicator || !btnSetDuration) return;

    // Vérifier si l'audio est activé et si une musique est sélectionnée
    const audioEnabled = cbRecordAudioEnable && cbRecordAudioEnable.checked;
    const hasFile = inputAudioFile && inputAudioFile.files && inputAudioFile.files.length > 0;

    if (!audioEnabled || !hasFile) {
        indicator.style.display = 'none';
        return;
    }

    try {
        const audioDurationSec = await getAudioDuration(inputAudioFile.files[0]);
        const audioDurationMin = audioDurationSec / 60;
        const currentTotalTime = parseFloat(inputTotalTime.value) || 0;

        const tolerance = 0.01; // Tolérance de 0.01 minute (~0.6 seconde)
        const matches = Math.abs(audioDurationMin - currentTotalTime) <= tolerance;

        if (matches) {
            // Ne rien afficher si les durées coïncident
            indicator.style.display = 'none';
        } else {
            // Afficher la différence seulement si les durées ne coïncident pas
            const diff = audioDurationMin - currentTotalTime;
            const diffText = diff > 0 ? `+${diff.toFixed(2)} min` : `${diff.toFixed(2)} min`;
            const differenceText = indicator.dataset.differenceText || 'Différence';
            indicator.innerHTML = '<i class="ti ti-alert-triangle me-1" style="color:#FF9800;" aria-hidden="true"></i>' + differenceText + ': ' + diffText;
            indicator.style.color = '#FF9800';
            indicator.style.display = 'inline';
        }
    } catch(e) {
        console.warn('Erreur lors de la vérification de la durée audio:', e);
        indicator.style.display = 'none';
    }
}

// États de l'application
var isAnimationRunning = false;
var isRecording = false;
var isFullscreen = false;

// État visuel du bouton fullscreen
var fullscreenButtonActive = false;

// Initialisation des éléments UI avec vérification d'existence
function initUIElements() {
// MENU BDD

// select BDD
const selectType = document.getElementById('selectType');
    if (selectType) selectType.addEventListener('change', onSelectionChangedDebounced);

const selectTerrain = document.getElementById('selectTerrain');
    if (selectTerrain) selectTerrain.addEventListener('change', onSelectionChangedDebounced);

const selectDifficulty = document.getElementById('selectDifficulty');
    if (selectDifficulty) selectDifficulty.addEventListener('change', onSelectionChangedDebounced);

const selectContainer = document.getElementById('selectContainer');
    if (selectContainer) selectContainer.addEventListener('change', onSelectionChangedDebounced);

// Country/State selects
const selectCountry = document.getElementById('selectCountry');
const selectState = document.getElementById('selectState');
    if (selectCountry) selectCountry.addEventListener('change', onSelectionChangedDebounced);
    if (selectState) selectState.addEventListener('change', onSelectionChangedDebounced);

// datepicker (trouvaille)
const datePickerStart = document.getElementById('datePickerStart');
const datePickerEnd = document.getElementById('datePickerEnd');
    if (datePickerStart) datePickerStart.addEventListener('change', () => { onSelectionChangedDebounced(); updateResetButtonsHighlight(); updateAnimFilterInfo(); });
    if (datePickerEnd) datePickerEnd.addEventListener('change', () => { onSelectionChangedDebounced(); updateResetButtonsHighlight(); updateAnimFilterInfo(); });

// datepicker (pose)
const publishedDatePickerStart = document.getElementById('publishedDatePickerStart');
const publishedDatePickerEnd = document.getElementById('publishedDatePickerEnd');
    if (publishedDatePickerStart) publishedDatePickerStart.addEventListener('change', () => { onSelectionChangedDebounced(); updatePublishedResetButtonsHighlight(); });
    if (publishedDatePickerEnd) publishedDatePickerEnd.addEventListener('change', () => { onSelectionChangedDebounced(); updatePublishedResetButtonsHighlight(); });

// Boutons reset dates (valeurs par défaut de la BDD)
    const btnResetStartDate = document.getElementById('btnResetStartDate');
    const btnResetEndDate = document.getElementById('btnResetEndDate');
    if (btnResetStartDate) btnResetStartDate.addEventListener('click', resetStartDateToDefault);
    if (btnResetEndDate) btnResetEndDate.addEventListener('click', resetEndDateToDefault);

    // Boutons reset dates de publication
    const btnResetPublishedStartDate = document.getElementById('btnResetPublishedStartDate');
    const btnResetPublishedEndDate = document.getElementById('btnResetPublishedEndDate');
    if (btnResetPublishedStartDate) btnResetPublishedStartDate.addEventListener('click', resetPublishedStartDateToDefault);
    if (btnResetPublishedEndDate) btnResetPublishedEndDate.addEventListener('click', resetPublishedEndDateToDefault);

// Boutons Tout/Aucun
    btnAllType = document.getElementById('btnAllType');
    btnNoneType = document.getElementById('btnNoneType');
    if (btnAllType) btnAllType.addEventListener('click', () => selectAllOptions(selectType));
    if (btnNoneType) btnNoneType.addEventListener('click', () => deselectAllOptions(selectType));

    btnAllDifficulty = document.getElementById('btnAllDifficulty');
    btnNoneDifficulty = document.getElementById('btnNoneDifficulty');
    if (btnAllDifficulty) btnAllDifficulty.addEventListener('click', () => selectAllOptions(selectDifficulty));
    if (btnNoneDifficulty) btnNoneDifficulty.addEventListener('click', () => deselectAllOptions(selectDifficulty));

    btnAllTerrain = document.getElementById('btnAllTerrain');
    btnNoneTerrain = document.getElementById('btnNoneTerrain');
    if (btnAllTerrain) btnAllTerrain.addEventListener('click', () => selectAllOptions(selectTerrain));
    if (btnNoneTerrain) btnNoneTerrain.addEventListener('click', () => deselectAllOptions(selectTerrain));

    btnAllContainer = document.getElementById('btnAllContainer');
    btnNoneContainer = document.getElementById('btnNoneContainer');
    if (btnAllContainer) btnAllContainer.addEventListener('click', () => selectAllOptions(selectContainer));
    if (btnNoneContainer) btnNoneContainer.addEventListener('click', () => deselectAllOptions(selectContainer));

    // Pays / États - boutons Tout/Aucun et infos
    const btnAllCountry = document.getElementById('btnAllCountry');
    const btnNoneCountry = document.getElementById('btnNoneCountry');
    const btnAllState = document.getElementById('btnAllState');
    const btnNoneState = document.getElementById('btnNoneState');
    const selectCountryEl = document.getElementById('selectCountry');
    const selectStateEl = document.getElementById('selectState');
    if (btnAllCountry) btnAllCountry.addEventListener('click', () => selectAllOptions(selectCountryEl));
    if (btnNoneCountry) btnNoneCountry.addEventListener('click', () => {
        deselectAllOptions(selectCountryEl);
        // si aucun pays, vider aussi les états
        if (selectStateEl) {
            Array.from(selectStateEl.options).forEach(opt => { opt.selected = false; });
            refreshTomSelect(selectStateEl);
        }
        onSelectionChangedDebounced();
        updateFilterInfos();
    });
    if (btnAllState) btnAllState.addEventListener('click', () => selectAllOptions(selectStateEl));
    if (btnNoneState) btnNoneState.addEventListener('click', () => {
        deselectAllOptions(selectStateEl);
        onSelectionChangedDebounced();
        updateFilterInfos();
    });

    // Bouton "Réinitialiser tous les filtres"
    const btnResetAllFilters = document.getElementById('btnResetAllFilters');
    if (btnResetAllFilters) btnResetAllFilters.addEventListener('click', resetAllFilters);

    // Zones d'information sous chaque filtre
    infoType = document.getElementById('infoType');
    infoDifficulty = document.getElementById('infoDifficulty');
    infoTerrain = document.getElementById('infoTerrain');
    infoContainer = document.getElementById('infoContainer');

    // Initialiser Tom Select (remplace Materialize FormSelect)
    if (selectType) initFilterTomSelect(selectType);
    if (selectDifficulty) initFilterTomSelect(selectDifficulty);
    if (selectTerrain) initFilterTomSelect(selectTerrain);
    if (selectContainer) initFilterTomSelect(selectContainer);

    // Initialiser Tempus Dominus sur les datepickers de filtre (remplace Materialize Datepicker)
    const tdOptions = {
        display: { components: { clock: false } },
        localization: { format: 'yyyy-MM-dd' },
    };
    if (datePickerStart) initTempusDominus(datePickerStart, tdOptions);
    if (datePickerEnd) initTempusDominus(datePickerEnd, tdOptions);
    if (publishedDatePickerStart) initTempusDominus(publishedDatePickerStart, tdOptions);
    if (publishedDatePickerEnd) initTempusDominus(publishedDatePickerEnd, tdOptions);

    // Restaurer la sélection si existante
    restoreSelectedValues();

    // Première mise à jour des infos
    updateFilterInfos();

    // Accessibilité : rendre les boutons Tout/Aucun/Reset navigables au clavier
    setupFilterButtonAccessibility();

// MENU CARTES

// boutons pour le choix des cartes
    btnOSM = document.getElementById('OSM');
    btnWatercolor = document.getElementById('watercolor');
    btnStamenToner = document.getElementById('stamenToner');
    btnVectorMap = document.getElementById('vectorMap');

    // sous menu pour le choix des cartes
    divVectorMapOptions = document.getElementById('vectorMapOptions');
    divTonerMapOptions = document.getElementById('tonerMapOptions');
    btnStamenTonerLight = document.getElementById('stamenTonerLight');
    if (btnStamenTonerLight) {
        btnStamenTonerLight.addEventListener('click', function() {
            dbgUi('Bouton Clair cliqué');
            changeStamenTonerStyle.call(this);
        });
    } else {
        console.warn('Bouton stamenTonerLight non trouvé');
    }

    btnStamenTonerDark = document.getElementById('stamenTonerDark');
    if (btnStamenTonerDark) {
        btnStamenTonerDark.addEventListener('click', function() {
            dbgUi('Bouton Sombre cliqué');
            changeStamenTonerStyle.call(this);
        });
    } else {
        console.warn('Bouton stamenTonerDark non trouvé');
    }

    // Champs pour les options de la carte vectorielle
    cpStrokeColor = document.getElementById('fieldVectorMapStrokeColor');
    if (cpStrokeColor) cpStrokeColor.addEventListener('change', changecpStrokeColor);

    cpFillColor = document.getElementById('fieldVectorMapFillColor');
    if (cpFillColor) cpFillColor.addEventListener('change', changecpfillColor);

    cpBackgroundColor = document.getElementById('fieldVectorMapBackgroundColor');
    if (cpBackgroundColor) cpBackgroundColor.addEventListener('change', changecpBackgroundColor);

    strokeWidth = document.getElementById('fieldVectorMapStrokeWidth');
    if (strokeWidth) {
        strokeWidth.addEventListener('change', changestrokeWidth);
        strokeWidth.addEventListener('input', updateStrokeWidthValue);
    }

    // Initialiser la valeur du slider
    updateStrokeWidthValue();

// Champs pour les options de la carte Toner Stamen
const tonerStyleElements = document.getElementsByClassName("changeTonerStyle");
Array.from(tonerStyleElements).forEach(function(element) {
    element.addEventListener("click", changeStamenTonerStyle);
});


// POINTS
// Colorpickers
// --- in
    cpPointCenterColor = document.getElementById('pointCenterColor');
    if (cpPointCenterColor) cpPointCenterColor.addEventListener('change', changePointStyleUI);

// -- out
    cpPointBorderColor = document.getElementById('pointBorderColor');
    if (cpPointBorderColor) cpPointBorderColor.addEventListener('change', changePointStyleUI);

// Radio buttons
// --- in
    radioFillColorPoint = document.getElementsByName('fillColorPoint');
radioFillColorPoint.forEach(radio => {
    radio.addEventListener('change', () => changePointStyleUI(radio));
});
// -- out
    radioborderColorPoint = document.getElementsByName('borderColorPoint');
radioborderColorPoint.forEach(radio => {
    radio.addEventListener('change', () => changePointStyleUI(radio));
});

// sliders et input associé
// --- in
const sliderSizePoint = document.getElementById('sliderSizePoint');
const inputSizePoint = document.getElementById('inputSizePoint');
    if (sliderSizePoint) sliderSizePoint.addEventListener('change', changePointStyleUI);
    if (inputSizePoint) inputSizePoint.addEventListener('change', changePointStyleUI);

// -- out
const sliderSizeBorder = document.getElementById('sliderSizeBorder');
const inputSizeBorder = document.getElementById('inputSizeBorder');
    if (sliderSizeBorder) sliderSizeBorder.addEventListener('change', changePointStyleUI);
    if (inputSizeBorder) inputSizeBorder.addEventListener('change', changePointStyleUI);

// switch
    switchIconeVectoriel = document.getElementById('switchIconeVectoriel');
    if (switchIconeVectoriel) switchIconeVectoriel.addEventListener('change', changePointStyleUI);

// select
    selectShape = document.getElementById('selectShape');
    if (selectShape) {
        selectShape.addEventListener('change', changePointStyleUI);
        // Pas de remove_button : ce champ doit toujours avoir une valeur.
        initTomSelect(selectShape, { maxItems: 1, plugins: [] });
    }

// ANIMATION DE LA CARTE
// Boutons
const btnStartAnimation = document.getElementById('btnStartAnimation');
    if (btnStartAnimation) btnStartAnimation.addEventListener('click', clickStartAnimation);

const btnRecordAnimation = document.getElementById('btnRecordAnimation');
    if (btnRecordAnimation) btnRecordAnimation.addEventListener('click', clickRecordAnimation);

    inputTimePerDay = document.getElementById('inputTimePerDay');
    if (inputTimePerDay) inputTimePerDay.addEventListener('input', changeAnimationValues);
    inputExtraEndTime = document.getElementById('inputExtraEndTime');
    if (inputExtraEndTime) inputExtraEndTime.addEventListener('input', changeAnimationValues);

const btnStopAnimation = document.getElementById('btnStopAnimation');
    if (btnStopAnimation) btnStopAnimation.addEventListener('click', () => {
        pkg.stopAnimation();
        showStartRecordButtons();
        updateFullscreenControls();
    });

    const btnPauseAnimation = document.getElementById('btnPauseAnimation');
    if (btnPauseAnimation) btnPauseAnimation.addEventListener('click', toggleButtonAnimationPauseAndRestart);

    // Contrôles plein écran
    const btnFullscreenMode = document.getElementById('btnFullscreenMode');
    if (btnFullscreenMode) btnFullscreenMode.addEventListener('click', toggleFullscreenMode);

    const btnStartBar = document.getElementById('btnStartBar');
    if (btnStartBar) btnStartBar.addEventListener('click', () => {
        clickStartAnimation();
    });

    const btnRecordBar = document.getElementById('btnRecordBar');
    if (btnRecordBar) btnRecordBar.addEventListener('click', () => {
        clickRecordAnimation();
    });

    const btnPauseBar = document.getElementById('btnPauseBar');
    if (btnPauseBar) btnPauseBar.addEventListener('click', () => {
        toggleButtonAnimationPauseAndRestart();
        updateControlBar();
    });

    const btnStopBar = document.getElementById('btnStopBar');
    if (btnStopBar) btnStopBar.addEventListener('click', () => {
        pkg.stopAnimation();
        showStartRecordButtons();
        updateControlBar();
    });

    const btnToggleFullscreen = document.getElementById('btnToggleFullscreen');
    if (btnToggleFullscreen) btnToggleFullscreen.addEventListener('click', toggleFullscreenFromButton);

    // Datepickers Animation (Tempus Dominus — remplace Materialize Datepicker)
    const animDateStart = document.getElementById('animDateStart');
    const animDateEnd = document.getElementById('animDateEnd');
    if (animDateStart) {
        initTempusDominus(animDateStart, { display: { components: { clock: false } }, localization: { format: 'yyyy-MM-dd' } });
        // Les dates seront pré-remplies dans setPickerDates() quand la BDD sera chargée
        animDateStart.addEventListener('change', () => {
            const parsedDate = pkg.parseDateInput(animDateStart.value);
            pkg.options.animation.dateStart = parsedDate;
            updateResetAnimButtonsHighlight();
            updateDeltaDaysAndTimes();
        });
    }
    if (animDateEnd) {
        initTempusDominus(animDateEnd, { display: { components: { clock: false } }, localization: { format: 'yyyy-MM-dd' } });
        // Les dates seront pré-remplies dans setPickerDates() quand la BDD sera chargée
        animDateEnd.addEventListener('change', () => {
            const parsedDate = pkg.parseDateInput(animDateEnd.value);
            pkg.options.animation.dateEnd = parsedDate;
            updateResetAnimButtonsHighlight();
            updateDeltaDaysAndTimes();
        });
    }

    // Boutons reset dates Animation
    const btnResetAnimStartDate = document.getElementById('btnResetAnimStartDate');
    const btnResetAnimEndDate = document.getElementById('btnResetAnimEndDate');
    if (btnResetAnimStartDate) btnResetAnimStartDate.addEventListener('click', resetAnimStartDateToDefault);
    if (btnResetAnimEndDate) btnResetAnimEndDate.addEventListener('click', resetAnimEndDateToDefault);
    // Initialiser tooltips Bootstrap 5 (remplace Materialize Tooltips)
    pkg.initBsTooltips();

    // Initialiser l'état des contrôles (boutons principaux et barre latérale)
    dbgUi("=== INITIALISATION DES CONTROLES ===");
    showStartRecordButtons();
    dbgUi("Appel updateControlBar depuis initUIElements");
    updateControlBar();

    // Initialiser l'apparence du bouton fullscreen
    updateFullscreenButtonAppearance();

    // FLASH
    // select pour le mode de flash
    selectFlashMode = document.getElementById('selectFlashMode');
    if (selectFlashMode) {
        selectFlashMode.addEventListener('change', () => changeFlashValues(selectFlashMode));
        // Initialiser Tom Select (remplace Materialize)
        // Pas de remove_button : ce champ doit toujours avoir une valeur
        // (comme un <select> natif), "Pas de flash" étant déjà une option explicite.
        initTomSelect(selectFlashMode, { maxItems: 1, plugins: [] });
    }
    // inputs
    inputTimeFlash = document.getElementById('inputTimeFlash');
    if (inputTimeFlash) {
        inputTimeFlash.addEventListener('input', changeFlashValues);
        inputTimeFlash.addEventListener('blur', validateTimeFlash); // Validation seulement à la perte de focus
    }

    inputSizeFlash = document.getElementById('inputSizeFlash');
    if (inputSizeFlash) {
        inputSizeFlash.addEventListener('input', changeFlashValues);
        inputSizeFlash.addEventListener('blur', validateSizeFlash); // Validation seulement à la perte de focus
    }

    // colorpickers
    cpFlashColor = document.getElementById('flashColor');
    if (cpFlashColor) cpFlashColor.addEventListener('change', changeFlashValues);

    // radio buttons pour les couleurs du flash
    const radioFlashColor = document.getElementsByName('flashColor');
    radioFlashColor.forEach(radio => {
        radio.addEventListener('change', () => changeFlashColorType(radio));
    });

    // INFOS
    // checkboxes
    cbDisplayTitle = document.getElementById('cbDisplayTitle');
    if (cbDisplayTitle) cbDisplayTitle.addEventListener('change', changeInfosValues);

    cbDisplayNumberofCaches = document.getElementById('cbDisplayNumberofCaches');
    if (cbDisplayNumberofCaches) cbDisplayNumberofCaches.addEventListener('change', changeInfosValues);

    cbDisplayCurrentDate = document.getElementById('cbDisplayCurrentDate');
    if (cbDisplayCurrentDate) cbDisplayCurrentDate.addEventListener('change', changeInfosValues);

    // inputs
    inputTitle = document.getElementById('inputTitle');
    if (inputTitle) inputTitle.addEventListener('input', changeInfosValues);

    // textareas
    inputTitleCss = document.getElementById('inputTitleCss');
    inputInfosCss = document.getElementById('inputInfosCss');
    beginOverlayCssDefaultsLoad();

    // boutons
    btnTitleCss = document.getElementById('btnTitleCss');
    if (btnTitleCss) {
        btnTitleCss.addEventListener('click', () => {
            try {
                const value = inputTitleCss ? inputTitleCss.value : '';
                pkg.changeTitleCssValues(value);
                dbgUi('[CSS] TitleFrame appliqué:', value.substring(0, 100));
            } catch(e) { console.warn('[CSS] TitleFrame erreur', e); }
        });
    }

    btnInfosCss = document.getElementById('btnInfosCss');
    if (btnInfosCss) {
        btnInfosCss.addEventListener('click', () => {
            try {
                const value = inputInfosCss ? inputInfosCss.value : '';
                pkg.changeInfosCssValues(value);
                dbgUi('[CSS] InfosFrame appliqué:', value.substring(0, 100));
            } catch(e) { console.warn('[CSS] InfosFrame erreur', e); }
        });
    }

    initCssAssistant();

    // Spans dans Frame Infos
    spanNbCaches = document.getElementById('spanNbCaches');
    spanCurrentDate = document.getElementById('spanCurrentDate');

    // OPTIONS
    selectLanguage = document.getElementById('selectLanguage');
    if (selectLanguage) {
        selectLanguage.addEventListener('change', changeOptionsValues);
        initTomSelect(selectLanguage, {});
    }

    selectCheckVersionOnline = document.getElementById('selectCheckVersionOnline');
    if (selectCheckVersionOnline) {
        selectCheckVersionOnline.addEventListener('change', changeOptionsValues);
        initTomSelect(selectCheckVersionOnline, {});
    }

    // Select profil par défaut (Tom Select)
    const selectDefaultProfile = document.getElementById('selectDefaultProfile');
    if (selectDefaultProfile) initTomSelect(selectDefaultProfile, {});

    // boutons
    buttonCheckVersion = document.getElementById('buttonCheckVersion');
    if (buttonCheckVersion) buttonCheckVersion.addEventListener('click', () => pkg.checkVersion("manual"));

    buttonHome = document.getElementById('buttonHome');
    if (buttonHome) buttonHome.addEventListener('click', pkg.openHomePage);

    inputMapCenterLat = document.getElementById('inputMapCenterLat');
    inputMapCenterLon = document.getElementById('inputMapCenterLon');
    inputMapCenterCombined = document.getElementById('inputMapCenterCombined');
    inputMapDefaultZoom = document.getElementById('inputMapDefaultZoom');
    fieldLat = document.getElementById('fieldLat');
    fieldLon = document.getElementById('fieldLon');
    fieldCombined = document.getElementById('fieldCombined');
    rowLatLon = document.getElementById('rowLatLon');
    if (inputMapCenterLat) {
        inputMapCenterLat.addEventListener('blur', saveMapCenterSettings);
        inputMapCenterLat.addEventListener('keydown', onMapCenterKeyDown);
    }
    if (inputMapCenterLon) {
        inputMapCenterLon.addEventListener('blur', saveMapCenterSettings);
        inputMapCenterLon.addEventListener('keydown', onMapCenterKeyDown);
    }
    if (inputMapCenterCombined) {
        inputMapCenterCombined.addEventListener('blur', onCombinedCenterBlur);
        inputMapCenterCombined.addEventListener('keydown', onMapCenterKeyDown);
    }
    if (inputMapDefaultZoom) {
        inputMapDefaultZoom.addEventListener('blur', saveMapCenterSettings);
        inputMapDefaultZoom.addEventListener('keydown', onMapCenterKeyDown);
    }

    btnUseCurrentMapCenter = document.getElementById('btnUseCurrentMapCenter');
    if (btnUseCurrentMapCenter) btnUseCurrentMapCenter.addEventListener('click', applyCurrentMapViewAsDefault);

    btnPickMapCenter = document.getElementById('btnPickMapCenter');
    if (btnPickMapCenter) btnPickMapCenter.addEventListener('click', togglePickMapCenter);

    btnClearMapCenter = document.getElementById('btnClearMapCenter');
    if (btnClearMapCenter) btnClearMapCenter.addEventListener('click', clearMapCenterSettings);

    btnToggleLatLonMode = document.getElementById('btnToggleLatLonMode');
    if (btnToggleLatLonMode) btnToggleLatLonMode.addEventListener('click', toggleLatLonMode);
    // Mode combiné par défaut
    setLatLonMode(true);

    // Initialiser les éléments du menu paramètres
    initOptionsElements();
}

// Initialisation des éléments du menu paramètres
function initOptionsElements() {
    // ENREGISTREMENT
    selectRecordMode = document.getElementById('selectRecordMode');
    if (selectRecordMode) {
        selectRecordMode.addEventListener('change', onRecordModeChange);
        initTomSelect(selectRecordMode, {});
    }
    selectRecordQualityProfile = document.getElementById('selectRecordQualityProfile');
    if (selectRecordQualityProfile) {
        selectRecordQualityProfile.addEventListener('change', applyRecordingQualityProfile);
    }
    recordAdvancedSettings = document.getElementById('recordAdvancedSettings');
    inputRecordFps = document.getElementById('inputRecordFps');
    if (inputRecordFps) {
        inputRecordFps.addEventListener('input', onRecordingQualityInput);
        inputRecordFps.addEventListener('blur', () => finalizeRecordingNumberInput(
            inputRecordFps, normalizeRecordingFps, RECORDING_LIMITS.fps
        ));
    }
    inputRecordBitrate = document.getElementById('inputRecordBitrate');
    if (inputRecordBitrate) {
        inputRecordBitrate.addEventListener('input', onRecordingQualityInput);
        inputRecordBitrate.addEventListener('blur', () => finalizeRecordingNumberInput(
            inputRecordBitrate, normalizeRecordingBitrateMbps, RECORDING_LIMITS.bitrateMbps
        ));
    }
    selectRecordMime = document.getElementById('selectRecordMime');
    if (selectRecordMime) {
        selectRecordMime.addEventListener('change', () => {
            const mime = selectRecordMime.value;
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mime)) {
                pkg.showToast && pkg.showToast(
                    pkg.t ? pkg.t('Ce format vidéo n\'est pas supporté par votre navigateur et sera ignoré au démarrage de l\'enregistrement.') : 'Format non supporté par ce navigateur.',
                    'warning', 'Format non supporté', 6000
                );
            }
            changeRecordValues();
        });
        initTomSelect(selectRecordMime, {});
    }
    inputRecordSlowdown = document.getElementById('inputRecordSlowdown');
    if (inputRecordSlowdown) inputRecordSlowdown.addEventListener('input', changeRecordValues);
    inputRecordScaleFactor = document.getElementById('inputRecordScaleFactor');
    if (inputRecordScaleFactor) inputRecordScaleFactor.addEventListener('input', changeRecordValues);
    cbRecordUpload = document.getElementById('cbRecordUpload');
    if (cbRecordUpload) cbRecordUpload.addEventListener('change', changeRecordValues);
    cbRecordDownload = document.getElementById('cbRecordDownload');
    if (cbRecordDownload) cbRecordDownload.addEventListener('change', changeRecordValues);
    cbRecordNormalize = document.getElementById('cbRecordNormalize');
    if (cbRecordNormalize) cbRecordNormalize.addEventListener('change', changeRecordValues);
    // Audio utilisateur
    cbRecordAudioEnable = document.getElementById('cbRecordAudioEnable');
    if (cbRecordAudioEnable) cbRecordAudioEnable.addEventListener('change', changeRecordValues);
    inputAudioVolume = document.getElementById('inputAudioVolume');
    if (inputAudioVolume) {
        inputAudioVolume.addEventListener('input', () => {
            const display = document.getElementById('spanAudioVolumeDisplay');
            if (display) display.textContent = Math.round(parseFloat(inputAudioVolume.value) * 100) + '%';
            changeRecordValues();
        });
    }
    inputAudioFile = document.getElementById('inputAudioFile');
    if (inputAudioFile) {
        // Gérer la sélection/désélection d'un fichier audio
        inputAudioFile.addEventListener('change', function() {
            if (this.files && this.files.length > 0) {
                // Fichier sélectionné - cocher automatiquement la checkbox
                if (cbRecordAudioEnable) {
                    cbRecordAudioEnable.checked = true;
                }
                // Afficher les informations du fichier audio
                displayAudioFileInfo(this.files[0]);
                changeRecordValues(); // Met à jour les options
            } else {
                // Aucun fichier - masquer les infos, délocker la durée audio et décocher/désactiver la checkbox
                hideAudioFileInfo();
                isDurationLockedToAudio = false;
                updateDurationLockIndicator();
                if (cbRecordAudioEnable) {
                    cbRecordAudioEnable.checked = false;
                    cbRecordAudioEnable.disabled = true;
                }
            }
            // Activer/désactiver le bouton de durée et la checkbox selon si un fichier est chargé
            updateAudioDurationButton();
            // Mettre à jour l'indicateur de correspondance des durées
            updateDurationMatchIndicator();
        });
    }

    // Bouton pour définir la durée depuis la musique
    const btnSetDurationFromAudio = document.getElementById('btnSetDurationFromAudio');
    if (btnSetDurationFromAudio) {
        btnSetDurationFromAudio.addEventListener('click', async function() {
            try {
                // Pré-déverrouiller un AudioContext global si nécessaire pour le mux post-enregistrement
                if (typeof window.mrMuxAudioCtx === 'undefined' || !window.mrMuxAudioCtx) {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    window.mrMuxAudioCtx = new AC();
                    try { window.mrMuxAudioCtx.resume().catch(()=>{}); } catch(_) {}
                }
            } catch(_) {}
            if (inputAudioFile && inputAudioFile.files && inputAudioFile.files.length > 0) {
                try {
                    const audioDurationSec = await getAudioDuration(inputAudioFile.files[0]);
                    if (audioDurationSec && audioDurationSec > 0) {
                        // Convertir en minutes pour le champ inputTotalTime
                        const audioDurationMin = audioDurationSec / 60;
                        // Garder une précision suffisante pour ne pas perdre plusieurs
                        // dixièmes de seconde avant même de calculer les frames.
                        inputTotalTime.value = audioDurationMin.toFixed(4);

                        // Marquer que la durée est maintenant lockée à la musique
                        isDurationLockedToAudio = true;
                        updateDurationLockIndicator();

                        // Recalculer le temps par jour basé sur cette nouvelle durée totale
                        updateTimePerDay();

                        // Mettre à jour l'indicateur de correspondance des durées
                        updateDurationMatchIndicator();

                        dbgUi(`Durée audio appliquée: ${audioDurationSec.toFixed(2)}s (${audioDurationMin.toFixed(2)}min) - Durée lockée`);
                        pkg.showToast && pkg.showToast('Durée de l\'animation ajustée selon la musique', 'info', 'Musique', 3000);
                    }
                } catch(e) {
                    console.warn('Erreur lors de la récupération de la durée audio:', e);
                    pkg.showToast && pkg.showToast('Erreur lors de la lecture du fichier audio', 'error', 'Erreur', 3000);
                }
            }
        });
    }
}

// Gestionnaire pour le changement de mode d'enregistrement
function onRecordModeChange() {
    // Met à jour le mode d'enregistrement
    try {
        pkg.options.record = pkg.options.record || {};
        pkg.options.record.mediaRecorder = pkg.options.record.mediaRecorder || {};
        const mode = selectRecordMode.value === 'mediarecorder' ? 'mediarecorder' : 'images';
        pkg.options.record.mode = mode;

        // Sauvegarder immédiatement le changement de mode
        saveRecordSettings();
    } catch(e) {
        console.warn('Mode change error:', e);
    }

    changeRecordValues(); // Met à jour les autres options et sauvegarde
    updateMediaRecorderOptionsVisibility(); // Met à jour la visibilité
}

// Met à jour la visibilité des options MediaRecorder
function updateMediaRecorderOptionsVisibility() {
    const isMediaRecorder = selectRecordMode && selectRecordMode.value === 'mediarecorder';
    const mediaRecorderOptions = document.querySelectorAll('.mediarecorder-only');

    mediaRecorderOptions.forEach(element => {
        if (isMediaRecorder) {
            element.style.display = 'block';
            // Rafraîchir Tom Select si c'est un select
            if (element.querySelector('select')) {
                const select = element.querySelector('select');
                refreshTomSelect(select);
            }
        } else {
            element.style.display = 'none';
        }
    });
}

// Gestion de la mémorisation des onglets
function initTabMemory() {
    // Vérifier s'il y a un hash dans l'URL (priorité sur localStorage)
    const urlHash = window.location.hash.substring(1); // Enlever le #
    let activeTab = urlHash || localStorage.getItem('activeTab') || 'data'; // Défaut sur 'data'

    // Vérifier que l'onglet existe
    const tabElement = document.querySelector(`a[href="#${activeTab}"]`);
    if (tabElement) {
        // Activer l'onglet via Bootstrap 5 (remplace M.Tabs.select)
        showBsTab(tabElement);

        // Sauvegarder dans localStorage si ce n'était pas déjà fait
        if (!urlHash) {
            localStorage.setItem('activeTab', activeTab);
        }
    }

    // Gérer le changement d'onglet (tabs Bootstrap 5 + tabs Materialize restantes)
    document.querySelectorAll('#mainTabs .nav-link, .tabs .tab a').forEach(tab => {
        tab.addEventListener('click', function() {
            const tabId = this.getAttribute('href').substring(1); // Enlever le #
            localStorage.setItem('activeTab', tabId);
        });
    });
}

function initMapTabsSplitPane() {
    const container = document.getElementById('mapTabsContainer');
    const mapWithFrames = document.getElementById('mapWithFrames');
    const resizer = document.getElementById('mapTabsResizer');
    const tabsPanel = document.getElementById('tabsPanel');
    const mainEl = document.querySelector('main');

    if (!container || !mapWithFrames || !resizer || !tabsPanel) return;

    const STORAGE_KEY = 'mapTabsMapHeightPx';
    const MIN_MAP_PX = 200;
    const MIN_TABS_PX = 80;

    let isResizing = false;
    let suppressResizeHandler = false;
    let dragStartY = 0;
    let dragStartMapHeight = 0;
    let prevCursor = '';
    let prevUserSelect = '';
    let prevBodyOverflow = '';

    function isFullscreenMode() {
        return !!(mainEl && mainEl.classList.contains('fullscreen-mode'));
    }

    function dispatchMapResize() {
        suppressResizeHandler = true;
        setTimeout(() => {
            try { window.dispatchEvent(new Event('resize')); } catch(_) {}
            setTimeout(() => { suppressResizeHandler = false; }, 0);
        }, 0);
    }

    function getResizerHeight() {
        const h = resizer.getBoundingClientRect().height;
        return Number.isFinite(h) && h > 0 ? h : 8;
    }

    function clampMapHeightPx(mapHeightPx) {
        const containerHeight = container.clientHeight;
        const resizerHeight = getResizerHeight();
        const maxMapPx = Math.max(MIN_MAP_PX, containerHeight - MIN_TABS_PX - resizerHeight);
        const clamped = Math.max(MIN_MAP_PX, Math.min(mapHeightPx, maxMapPx));
        return { clamped, containerHeight };
    }

    function applyMapHeightPx(mapHeightPx, persist) {
        const { clamped, containerHeight } = clampMapHeightPx(mapHeightPx);
        mapWithFrames.style.height = `${clamped}px`;

        if (persist) {
            localStorage.setItem(STORAGE_KEY, String(Math.round(clamped)));
        }

        if (!isResizing) {
            dispatchMapResize();
        }
    }

    function applySavedRatioIfAny() {
        const raw = localStorage.getItem(STORAGE_KEY);
        const savedPx = raw ? parseFloat(raw) : NaN;
        if (!Number.isFinite(savedPx) || savedPx <= 0) {
            const currentHeight = mapWithFrames.getBoundingClientRect().height;
            if (Number.isFinite(currentHeight) && currentHeight > 0) {
                applyMapHeightPx(currentHeight, false);
            }
            return;
        }

        applyMapHeightPx(savedPx, false);
    }

    function beginResize() {
        container.classList.add('is-resizing');
        prevCursor = document.body.style.cursor;
        prevUserSelect = document.body.style.userSelect;
        prevBodyOverflow = document.body.style.overflow;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.body.style.overflow = 'hidden';
    }

    function endResize(persist) {
        container.classList.remove('is-resizing');
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        document.body.style.overflow = prevBodyOverflow;

        if (persist) {
            const currentHeight = mapWithFrames.getBoundingClientRect().height;
            if (Number.isFinite(currentHeight) && currentHeight > 0) {
                applyMapHeightPx(currentHeight, true);
            }
        }
    }

    resizer.addEventListener('pointerdown', (e) => {
        if (isFullscreenMode()) return;
        if (e.pointerType !== 'touch' && e.button !== 0) return;

        try { resizer.setPointerCapture(e.pointerId); } catch(_) {}
        isResizing = true;
        beginResize();

        dragStartY = e.clientY;
        dragStartMapHeight = mapWithFrames.getBoundingClientRect().height;
        applyMapHeightPx(dragStartMapHeight, false);
        e.preventDefault();
    });

    resizer.addEventListener('pointermove', (e) => {
        if (!isResizing) return;
        if (isFullscreenMode()) return;

        const deltaY = e.clientY - dragStartY;
        applyMapHeightPx(dragStartMapHeight + deltaY, false);
        e.preventDefault();
    });

    function stopPointerResize(e) {
        if (!isResizing) return;
        try { resizer.releasePointerCapture(e.pointerId); } catch(_) {}
        endResize(true);
        isResizing = false;
        dispatchMapResize();
    }

    resizer.addEventListener('pointerup', stopPointerResize);
    resizer.addEventListener('pointercancel', stopPointerResize);

    window.addEventListener('resize', () => {
        if (isFullscreenMode()) return;
        if (isResizing) return;
        if (suppressResizeHandler) return;
        applySavedRatioIfAny();
    });

    requestAnimationFrame(() => {
        if (isFullscreenMode()) return;
        applySavedRatioIfAny();
    });
}

// Initialiser les éléments UI quand le DOM est chargé
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        initUIElements();
        initTabMemory();
        initMapTabsSplitPane();
    });
} else {
    // DOM déjà chargé
    initUIElements();
    initTabMemory();
    initMapTabsSplitPane();
}


// ANIMATION DE LA CARTE
// Boutons (Ces éléments sont maintenant gérés dans initUIElements pour éviter les erreurs)
// jours sans caches - déplacé dans initUIElements()
// temps total
const inputTotalTime = document.getElementById('inputTotalTime');
inputTotalTime.addEventListener('input', changeAnimationValues);
// temps par jour en minutes 
const spanTotalTimeMinutes = document.getElementById('spanTotalTimeMinutes');
const spanTotalTimeSeconds = document.getElementById('spanTotalTimeSeconds');
// nombre de jours
const spanDeltaDays = document.getElementById('spanDeltaDays');

// TMP
const btnCleanMoviePictures = document.getElementById('btnCleanMoviePictures');
if (btnCleanMoviePictures) btnCleanMoviePictures.addEventListener('click', clear_pictures_directory);
const btnAssembleMoviePictures = document.getElementById('btnAssembleMoviePictures');
if (btnAssembleMoviePictures) btnAssembleMoviePictures.addEventListener('click', assemble_pictures_directory);
const btnOpenVideoFolder = document.getElementById('btnOpenVideoFolder');
if (btnOpenVideoFolder) btnOpenVideoFolder.addEventListener('click', open_video_folder);


// FLASH - éléments déplacés dans initUIElements()

// INFOS - éléments déplacés dans initUIElements()


// OPTIONS - éléments déplacés dans initUIElements()


// initialisation les éléments des options par défaut
export function init_ui() {
    // ------- OPTIONS  -------
    // Charger la langue depuis localStorage si elle existe, sinon utiliser celle par défaut
    const savedLanguage = localStorage.getItem('selectedLanguage');
    if (savedLanguage && (savedLanguage === 'fr' || savedLanguage === 'en')) {
        pkg.options.options.language = savedLanguage;
    }

    persistLanguagePreference(pkg.options.options.language);

    selectLanguage.value = pkg.options.options.language;
    refreshTomSelect(document.getElementById('selectLanguage'));
    selectCheckVersionOnline.value = pkg.options.options.checkVersion;
    refreshTomSelect(document.getElementById('selectCheckVersionOnline'));

    try {
        const s = window.userSettings;
        if (s && Array.isArray(s.map_default_center) && s.map_default_center.length === 2) {
            const latVal = String(s.map_default_center[0] ?? '');
            const lonVal = String(s.map_default_center[1] ?? '');
            setLatLonInputs(latVal, lonVal);
            lastSavedCenterKey = centerKey([latVal, lonVal]);
        }
        if (s && (typeof s.map_default_zoom === 'number' || typeof s.map_default_zoom === 'string')) {
            if (inputMapDefaultZoom) inputMapDefaultZoom.value = String(s.map_default_zoom ?? '');
            lastSavedZoom = parseInt(s.map_default_zoom);
        }
    } catch(_) {}

    // Charger l'arbre Country/State et peupler selects
    try {
        dbgFilters('[COUNTRY] Fetching /api/country_state ...');
        const apiUrl = `${window.location.origin}/api/country_state`;
        fetch(apiUrl)
            .then(async r => {
                dbgFilters('[COUNTRY] Response ok=', r.ok, 'status=', r.status);
                const txt = await r.text();
                dbgFilters('[COUNTRY] Response length=', txt?.length);
                let data;
                try {
                    data = txt ? JSON.parse(txt) : {};
                } catch(err) {
                    console.warn('[COUNTRY] JSON parse failed for API. Falling back to static file.', err);
                    // Fallback vers le JSON statique
                const staticUrl = `${window.location.origin}/static/json/country_state.json`;
                    return fetch(staticUrl)
                        .then(rr => rr.json())
                        .then(dd => {
                            countryToStates = dd || {};
                            dbgFilters('[COUNTRY] Fallback static JSON loaded. Countries:', Object.keys(countryToStates).length);
                            populateCountryStateSelects(countryToStates);
                        })
                        .catch(e => console.warn('[COUNTRY] Fallback fetch error:', e));
                }
                countryToStates = data || {};
                dbgFilters('[COUNTRY] Data received. Countries:', Object.keys(countryToStates).length);
                populateCountryStateSelects(countryToStates);
            })
            .catch((e)=>{ console.warn('[COUNTRY] Fetch error:', e); })
            .finally(()=>{ dbgFilters('[COUNTRY] Fetch chain completed'); });
    } catch(e) {
        console.warn('[COUNTRY] Outer try/catch error:', e);
    }

    // ---------- POINTS ------------------
    // colorpickers
    cpPointBorderColor.value = pkg.options.point.border.color;
    cpPointCenterColor.value = pkg.options.point.center.color;
    // radio buttons
    for (let radio of radioFillColorPoint) {
        if (radio.value === pkg.options.point.center.mode) {
            radio.checked = true;
            break;
        }
    }
    for (let radio of radioborderColorPoint) {
        dbgUi(radio)
        if (radio.value === pkg.options.point.border.mode) {
            radio.checked = true;
            break;
        }
    }
    // synchronise sliders et input associés
    synchronizeSliderAndInputCenter();
    synchronizeSliderAndInputBorder();

    // Initialiser l'affichage des sous-menus de points
    updatePointOptionsDisplay();
    // switch Icone/Vectoriel
    dbgUi('🎨 [INIT_UI] Application du mode des points:', {
        mode_dans_options: pkg.options.point.mode,
        switch_actuel: switchIconeVectoriel.checked
    });

    if (pkg.options.point.mode === "vectoriel") {
        switchIconeVectoriel.checked = true;
        dbgUi('🎨 [INIT_UI] Mode vectoriel appliqué - switch coché');
    } else if (pkg.options.point.mode === "icone") {
        switchIconeVectoriel.checked = false;
        dbgUi('🎨 [INIT_UI] Mode icone appliqué - switch décoché');
    } else {
        console.warn('🎨 [INIT_UI] Mode inconnu:', pkg.options.point.mode, '- utilisation de la valeur par défaut (vectoriel)');
        switchIconeVectoriel.checked = true; // valeur par défaut
    }

    dbgUi('🎨 [INIT_UI] État final du switch:', switchIconeVectoriel.checked);
    selectShape.value = pkg.options.point.shape
    // Rafraîchir Tom Select pour refléter la nouvelle valeur sélectionnée
    refreshTomSelect(document.getElementById('selectShape'));

    
    // ------- ANIMATION DE LA CARTE -------
    // Inputs
    inputTimePerDay.value = pkg.options.animation.timePerDay;
    if (inputExtraEndTime) {
        const extraSeconds = Number(pkg.options.animation.extraEndSeconds) || 0;
        pkg.options.animation.extraEndSeconds = Math.max(0, extraSeconds);
        inputExtraEndTime.value = pkg.options.animation.extraEndSeconds;
    }

    // ------- FLASH -------
    // colorpicker
    if (cpFlashColor) cpFlashColor.value = pkg.options.flash.color;
    // inputs
    if (inputTimeFlash) inputTimeFlash.value = pkg.options.flash.duration;
    if (inputSizeFlash) inputSizeFlash.value = pkg.options.flash.size;
    // select pour le mode de flash
    if (selectFlashMode) {
        selectFlashMode.value = pkg.options.flash.mode;
        // Rafraîchir Tom Select après avoir changé la valeur
        refreshTomSelect(selectFlashMode);
    }
    // radio buttons pour le type de couleur du flash
    const flashColorRadios = document.getElementsByName('flashColor');
    for (let radio of flashColorRadios) {
        if (radio.value === pkg.options.flash.color_type) {
            radio.checked = true;
            // Déclencher l'événement pour mettre à jour l'affichage
            radio.dispatchEvent(new Event('change'));
            break;
        }
    }
    // ------- INFOS -------
    // checkboxes
    cbDisplayTitle.checked = pkg.options.infos.title.display;
    cbDisplayNumberofCaches.checked = pkg.options.infos.numberOfCaches.display;
    cbDisplayCurrentDate.checked = pkg.options.infos.currentDate.display;
    // inputs
    inputTitle.value = pkg.options.infos.title.text;
    if (inputTitle.value != "My Geocaching Map") {
        // enlève le placeholder si un texte est enregistré
        /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
    }
    // textAreas
    

    // ------- CARTE VECTORIELLE -------

    // couleur de trait par défaut
    if (cpStrokeColor) cpStrokeColor.value = pkg.options.map.vectorMap.strokeColor;
    // couleur de remplissage par défaut
    if (cpFillColor) cpFillColor.value = pkg.options.map.vectorMap.fillColor;
    // couleur de fond par défaut
    if (cpBackgroundColor) cpBackgroundColor.value = pkg.options.map.vectorMap.background;
    // largeur de trait par défaut
    if (strokeWidth) strokeWidth.value = pkg.options.map.vectorMap.strokeWidth;

    // Mettre à jour l'affichage de la valeur du slider
    updateStrokeWidthValue();
    // ------- CARTE TONER -------
    // deselectionne le bouton par défaut
    changeButtonsStamenToner(pkg.options.map.stamenToner.type);

    // Initialiser l'interface des paramètres (enregistrement)
    initOptionsUI();

    // Mettre à jour tous les champs Materialize pour repositionner les labels
    /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
}

let isPickingMapCenter = false;
let pickMapCenterHandler = null;
let lastMapCenterToast = null;
let lastSavedCenterKey = null;
let lastSavedZoom = null;

function parseCoordinate(value) {
    if (value === null || typeof value === 'undefined') return null;
    if (typeof value !== 'string') value = String(value);
    let s = value.trim();
    if (!s) return null;

    s = s.toUpperCase();

    let hemi = null;
    const startH = s.match(/^\s*([NSEW])\s+/);
    if (startH) {
        hemi = startH[1];
        s = s.replace(/^\s*[NSEW]\s+/, '').trim();
    }
    const endH = s.match(/\s*([NSEW])\s*$/);
    if (endH) {
        if (!hemi) hemi = endH[1];
        s = s.replace(/\s*[NSEW]\s*$/, '').trim();
    }

    s = s.replace(',', '.');

    const numericOnly = s.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*$/);
    if (numericOnly) {
        const degVal = parseFloat(numericOnly[1]);
        if (!Number.isFinite(degVal)) return null;
        let sign = degVal < 0 ? -1 : 1;
        if (hemi === 'S' || hemi === 'W') sign = -1;
        if (hemi === 'N' || hemi === 'E') sign = 1;
        return sign * Math.abs(degVal);
    }

    const cleaned = s
        .replace(/[°º]/g, ' ')
        .replace(/[′’']/g, ' ')
        .replace(/[″"]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length === 0) return null;

    const deg = parseFloat(parts[0]);
    const min = parts.length >= 2 ? parseFloat(parts[1]) : 0;
    const sec = parts.length >= 3 ? parseFloat(parts[2]) : 0;
    if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
    if (Math.abs(min) >= 60 || Math.abs(sec) >= 60) return null;

    let sign = deg < 0 ? -1 : 1;
    if (hemi === 'S' || hemi === 'W') sign = -1;
    if (hemi === 'N' || hemi === 'E') sign = 1;

    const abs = Math.abs(deg) + (Math.abs(min) / 60) + (Math.abs(sec) / 3600);
    return sign * abs;
}

function parseCombinedLatLon(value) {
    if (!value) return { lat: null, lon: null };
    const raw = value.replace(/\s+/g, ' ').trim();

    const geo = raw.toUpperCase().match(/^\s*([NS])\s*([0-9°º\.,\s'"′’]+?)\s*([EW])\s*([0-9°º\.,\s'"′’]+?)\s*$/);
    if (geo) {
        const lat = parseCoordinate(`${geo[1]} ${geo[2]}`);
        const lon = parseCoordinate(`${geo[3]} ${geo[4]}`);
        return { lat, lon };
    }

    const raw2 = raw.replace(';', ',');
    if (raw2.includes(',')) {
        const parts = raw2.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) return { lat: null, lon: null };
        const lat = parseCoordinate(parts[0]);
        const lon = parseCoordinate(parts[1]);
        return { lat, lon };
    }

    const parts = raw2.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { lat: null, lon: null };
    const lat = parseCoordinate(parts[0]);
    const lon = parseCoordinate(parts[1]);
    return { lat, lon };
}

function setLatLonInputs(latVal, lonVal) {
    if (inputMapCenterLat) inputMapCenterLat.value = latVal;
    if (inputMapCenterLon) inputMapCenterLon.value = lonVal;
    if (inputMapCenterCombined) inputMapCenterCombined.value = `${latVal}, ${lonVal}`;
    /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
}

function centerKey(center) {
    if (!center || center.length !== 2) return 'null';
    const lat = Number(center[0]);
    const lon = Number(center[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'null';
    return `${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

function setCoordinateValidity({ latValid = true, lonValid = true, combinedValid = true } = {}) {
    if (inputMapCenterLat) {
        inputMapCenterLat.classList.toggle('invalid', !latValid);
        if (latValid) inputMapCenterLat.classList.remove('invalid');
    }
    if (inputMapCenterLon) {
        inputMapCenterLon.classList.toggle('invalid', !lonValid);
        if (lonValid) inputMapCenterLon.classList.remove('invalid');
    }
    if (inputMapCenterCombined) {
        inputMapCenterCombined.classList.toggle('invalid', !combinedValid);
        if (combinedValid) inputMapCenterCombined.classList.remove('invalid');
    }
}

function setLatLonMode(useCombined) {
    isCombinedLatLonMode = !!useCombined;
    if (fieldCombined) fieldCombined.classList.toggle('hide', !useCombined);
    if (rowLatLon) rowLatLon.classList.toggle('hide', useCombined);
    if (fieldLat) fieldLat.classList.toggle('hide', useCombined);
    if (fieldLon) fieldLon.classList.toggle('hide', useCombined);
    /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
}

function toggleLatLonMode() {
    setLatLonMode(!isCombinedLatLonMode);
}

function onCombinedCenterBlur() {
    if (!inputMapCenterCombined) return;
    const { lat, lon } = parseCombinedLatLon(inputMapCenterCombined.value);
    if (lat !== null) inputMapCenterLat.value = lat;
    if (lon !== null) inputMapCenterLon.value = lon;
    /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
    saveMapCenterSettings();
}

function onMapCenterKeyDown(e) {
    if (!e) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target === inputMapCenterCombined) {
        onCombinedCenterBlur();
        return;
    }
    saveMapCenterSettings();
}

async function saveAppSettingsPatch(patch) {
    try {
        const currentSettings = await (await fetch('/api/settings')).json();
        const merged = Object.assign({}, currentSettings, patch || {});
        const saveResponse = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged)
        });
        if (!saveResponse.ok) {
            return false;
        }
        try {
            window.userSettings = merged;
        } catch(_) {}
        return true;
    } catch(e) {
        return false;
    }
}

async function saveMapCenterSettings() {
    try {
        if (!inputMapCenterLat || !inputMapCenterLon || !inputMapDefaultZoom || !inputMapCenterCombined) return;

        const patch = {};
        setCoordinateValidity({ latValid: true, lonValid: true, combinedValid: true });

        let lat = null;
        let lon = null;
        let newCenterKey = 'null';

        if (isCombinedLatLonMode) {
            const rawCombined = (inputMapCenterCombined.value || '').trim();
            if (!rawCombined) {
                patch.map_default_center = null;
            } else {
                const parsed = parseCombinedLatLon(rawCombined);
                lat = parsed.lat;
                lon = parsed.lon;
                const inRange = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
                if (!inRange) {
                    setCoordinateValidity({ latValid: true, lonValid: true, combinedValid: false });
                    pkg.showToast && pkg.showToast('Coordonnées invalides. Ex: 48.85, 2.35 ou N 49° 16.029 E 006° 07.512', 'warning', 'Carte', 5000);
                    return false;
                }
                patch.map_default_center = [lat, lon];
                inputMapCenterLat.value = lat;
                inputMapCenterLon.value = lon;
                newCenterKey = centerKey(patch.map_default_center);
            }
        } else {
            const latRaw = (inputMapCenterLat.value || '').trim();
            const lonRaw = (inputMapCenterLon.value || '').trim();

            if (!latRaw && !lonRaw) {
                patch.map_default_center = null;
            } else {
                lat = parseCoordinate(latRaw);
                lon = parseCoordinate(lonRaw);
                const inRange = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
                if (!inRange) {
                    const latValid = lat !== null && lat >= -90 && lat <= 90;
                    const lonValid = lon !== null && lon >= -180 && lon <= 180;
                    setCoordinateValidity({ latValid, lonValid, combinedValid: true });
                    pkg.showToast && pkg.showToast('Coordonnées invalides. Ex: N 49° 16.029 / E 006° 07.512', 'warning', 'Carte', 5000);
                    return false;
                }
                patch.map_default_center = [lat, lon];
                newCenterKey = centerKey(patch.map_default_center);
            }
        }

        const zoomRaw = (inputMapDefaultZoom.value || '').trim();
        if (!zoomRaw) {
            patch.map_default_zoom = null;
        } else {
            const z = parseInt(zoomRaw);
            if (Number.isFinite(z)) patch.map_default_zoom = z;
        }

        const zoomChanged = (patch.map_default_zoom !== undefined) && (patch.map_default_zoom !== lastSavedZoom);
        const centerChanged = newCenterKey !== lastSavedCenterKey;
        if (!centerChanged && !zoomChanged) {
            return true;
        }

        const ok = await saveAppSettingsPatch(patch);
        if (!ok) {
            pkg.showToast && pkg.showToast('Échec sauvegarde paramètres carte', 'warning', 'Paramètres', 3000);
        }
        if (patch.map_default_center && inputMapCenterCombined) {
            const latStr = `${patch.map_default_center[0]}`;
            const lonStr = `${patch.map_default_center[1]}`;
            inputMapCenterCombined.value = `${latStr}, ${lonStr}`;
            setCoordinateValidity({ latValid: true, lonValid: true, combinedValid: true });
            try {
                if (lastMapCenterToast) pkg.hideToast(lastMapCenterToast);
            } catch(_) {}
            if (centerChanged) {
                lastMapCenterToast = pkg.showToast && pkg.showToast('Coordonnées enregistrées', 'success', 'Carte', 2500);
            }
        }
        lastSavedCenterKey = newCenterKey;
        if (patch.map_default_zoom !== undefined) {
            lastSavedZoom = patch.map_default_zoom;
        }
        /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
        return ok;
    } catch(e) {
    }
}

async function applyCurrentMapViewAsDefault() {
    try {
        const map = pkg.getMap && pkg.getMap();
        if (!map || !map.getView) return;
        const view = map.getView();
        const center3857 = view.getCenter();
        if (!center3857) return;
        const lonLat = ol.proj.toLonLat(center3857);
        const lon = lonLat[0];
        const lat = lonLat[1];
        if (inputMapCenterLat) inputMapCenterLat.value = lat.toFixed(6);
        if (inputMapCenterLon) inputMapCenterLon.value = lon.toFixed(6);
        if (inputMapDefaultZoom) inputMapDefaultZoom.value = String(view.getZoom());
        /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
        const ok = await saveMapCenterSettings();
        if (ok !== false && pkg.showToast) {
            const title = pkg.t ? pkg.t('Carte') : 'Carte';
            const message = pkg.t ? pkg.t('Centre par défaut mis à jour depuis la vue actuelle') : 'Centre par défaut mis à jour depuis la vue actuelle';
            pkg.showToast(message, 'success', title, 3000);
        }
    } catch(e) {
    }
}

function clearMapCenterSettings() {
    try {
        if (inputMapCenterLat) inputMapCenterLat.value = '';
        if (inputMapCenterLon) inputMapCenterLon.value = '';
        if (inputMapCenterCombined) inputMapCenterCombined.value = '';
        if (inputMapDefaultZoom) inputMapDefaultZoom.value = '';
        /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
        saveAppSettingsPatch({ map_default_center: null, map_default_zoom: null });
    } catch(e) {
    }
}

function togglePickMapCenter() {
    try {
        const map = pkg.getMap && pkg.getMap();
        if (!map || !map.on) return;

        if (isPickingMapCenter) {
            disablePickMapCenter(map);
            return;
        }

        isPickingMapCenter = true;
        try { map.getTargetElement().style.cursor = 'crosshair'; } catch(_) {}
        pkg.showToast && pkg.showToast('Cliquez sur la carte pour choisir le centre', 'info', 'Carte', 4000);

        pickMapCenterHandler = async function(evt) {
            try {
                const lonLat = ol.proj.toLonLat(evt.coordinate);
                const lon = lonLat[0];
                const lat = lonLat[1];
                if (inputMapCenterLat) inputMapCenterLat.value = lat.toFixed(6);
                if (inputMapCenterLon) inputMapCenterLon.value = lon.toFixed(6);
                if (inputMapCenterCombined) inputMapCenterCombined.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                try {
                    const view = map.getView();
                    if (view && inputMapDefaultZoom) inputMapDefaultZoom.value = String(view.getZoom());
                } catch(_) {}
                /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
                const ok = await saveMapCenterSettings();
                if (ok !== false && pkg.showToast) {
                    pkg.showToast('Centre par défaut mis à jour depuis la carte', 'success', 'Carte', 3000);
                }
            } finally {
                disablePickMapCenter(map);
            }
        };

        map.on('singleclick', pickMapCenterHandler);
    } catch(e) {
    }
}

function disablePickMapCenter(map) {
    isPickingMapCenter = false;
    try { map.getTargetElement().style.cursor = ''; } catch(_) {}
    try {
        if (map && pickMapCenterHandler && typeof map.un === 'function') {
            map.un('singleclick', pickMapCenterHandler);
        }
    } catch(_) {}
    pickMapCenterHandler = null;
}

// Initialisation des valeurs UI pour les paramètres
function initOptionsUI() {
    // ------- ENREGISTREMENT -------
    try {
        // Restaurer les paramètres sauvegardés
        loadRecordSettings();
        normalizeRecordOptionsInPlace();

        if (selectRecordMode) {
            selectRecordMode.value = (pkg.options.record?.mode) || 'mediarecorder'; // MediaRecorder par défaut
            refreshTomSelect(selectRecordMode);
        }
        if (inputRecordFps) inputRecordFps.value = pkg.options.record.fps;
        if (inputRecordBitrate) inputRecordBitrate.value = ((pkg.options.record?.mediaRecorder?.videoBitsPerSecond) || 6000000) / 1000000;
        if (selectRecordMime) {
            selectRecordMime.value = (pkg.options.record?.mediaRecorder?.mimeType) || 'video/webm;codecs=vp9';
            refreshTomSelect(selectRecordMime);
        }
        if (inputRecordSlowdown) inputRecordSlowdown.value = (pkg.options.record?.mediaRecorder?.slowdownFactor) || 1;
        if (inputRecordScaleFactor) inputRecordScaleFactor.value = (pkg.options.record?.mediaRecorder?.scaleFactor) || 1;
        if (cbRecordUpload) cbRecordUpload.checked = !!(pkg.options.record?.mediaRecorder?.uploadToServer);
        if (cbRecordDownload) cbRecordDownload.checked = !!(pkg.options.record?.mediaRecorder?.downloadLocal);
        if (cbRecordNormalize) cbRecordNormalize.checked = !!(pkg.options.record?.mediaRecorder?.offlineNormalization ?? true);

        // Vérifier le format sauvegardé et l'état initial de normalize
        if (selectRecordMime && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
            const savedMime = selectRecordMime.value;
            if (savedMime && !MediaRecorder.isTypeSupported(savedMime)) {
                setTimeout(() => {
                    pkg.showToast && pkg.showToast(
                        pkg.t ? pkg.t('Le format vidéo sauvegardé (${mime}) n\'est pas supporté par ce navigateur.', { mime: savedMime }) : `Format ${savedMime} non supporté.`,
                        'warning', 'Format non supporté', 7000
                    );
                }, 1500);
            }
        }
        if (cbRecordNormalize && inputRecordSlowdown) {
            const sd = Math.max(1, parseInt(inputRecordSlowdown.value) || 1);
            cbRecordNormalize.disabled = sd === 1;
            const normalizeLabel = cbRecordNormalize.labels?.[0];
            if (normalizeLabel) normalizeLabel.style.opacity = sd === 1 ? '0.4' : '';
        }
        setRecordingInputValidity(inputRecordFps, RECORDING_LIMITS.fps);
        setRecordingInputValidity(inputRecordBitrate, RECORDING_LIMITS.bitrateMbps);
        syncRecordingQualityProfile();
        if (recordAdvancedSettings) {
            recordAdvancedSettings.open = selectRecordQualityProfile?.value === 'custom';
        }

        // ------- AUDIO UTILISATEUR -------
        try {
            // Restaurer options audio si existantes (désactivé par défaut)
            pkg.options.record = pkg.options.record || {};
            pkg.options.record.audio = pkg.options.record.audio || {};
            if (cbRecordAudioEnable) {
                // Ne cocher que si explicitement activé ET qu'un fichier est chargé
                const hasFile = inputAudioFile && inputAudioFile.files && inputAudioFile.files.length > 0;
                cbRecordAudioEnable.checked = !!pkg.options.record.audio.enabled && hasFile;
                cbRecordAudioEnable.disabled = !hasFile; // Désactiver si pas de fichier
            }
            if (inputAudioVolume) {
                const vol = (typeof pkg.options.record.audio.volume === 'number') ? pkg.options.record.audio.volume : 1;
                inputAudioVolume.value = vol;
                const display = document.getElementById('spanAudioVolumeDisplay');
                if (display) display.textContent = Math.round(vol * 100) + '%';
            }
        } catch(e) { console.warn('Init audio UI error:', e); }

        // Mettre à jour la visibilité après l'initialisation
        updateMediaRecorderOptionsVisibility();

        // Synchroniser la visibilité des overlays avec les paramètres utilisateur
        updateOverlayElementsVisibility();

        // Mettre à jour l'état du bouton durée audio
        updateAudioDurationButton();
        // Initialiser l'indicateur de durée lockée
        updateDurationLockIndicator();
        updateRecordingSizeEstimate();
    } catch(e) { console.warn('Init enregistrement UI error:', e); }
}


// ----------- OPTIONS DE L'APP ------------

//
async function changeOptionsValues() {
    const newLanguage = selectLanguage.value;
    const currentLanguage = pkg.options.options.language;

    // Sauvegarder la nouvelle langue dans les options
    pkg.options.options.language = newLanguage;
    if (selectCheckVersionOnline) {
        pkg.options.options.checkVersion = selectCheckVersionOnline.value === 'true' || selectCheckVersionOnline.value === true;
    }

    // Sauvegarder dans localStorage + cookie pour le backend
    persistLanguagePreference(newLanguage);

    // Sauvegarder côté serveur via l'API settings (comme les profils)
    try {
        const currentSettings = await (await fetch('/api/settings')).json();
        currentSettings.language = newLanguage;
        if (selectCheckVersionOnline) {
            currentSettings.check_updates = selectCheckVersionOnline.value === 'true' || selectCheckVersionOnline.value === true;
        }

        const saveResponse = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentSettings)
        });

        if (saveResponse.ok) {
            dbgUi('Paramètres sauvegardés côté serveur:', { language: newLanguage, check_updates: currentSettings.check_updates });
        } else {
            console.warn('Échec sauvegarde côté serveur, paramètres locaux seulement');
        }
    } catch (error) {
        console.error('❌ Erreur sauvegarde paramètres côté serveur:', error);
        console.warn('Paramètres sauvegardés localement seulement');
    }

    // Si la langue a changé, afficher la modale de confirmation
    if (newLanguage !== currentLanguage) {
        openLanguageChangeModal(newLanguage, currentLanguage);
    }
}

// ----------- ENREGISTREMENT (UI -> options.record) ------------
function changeRecordValues() {
    try {
        // S'assurer que la structure existe
        pkg.options.record = pkg.options.record || {};
        pkg.options.record.mediaRecorder = pkg.options.record.mediaRecorder || {};

        if (inputRecordFps && inputRecordFps.value !== '') {
            pkg.options.record.fps = normalizeRecordingFps(inputRecordFps.value);
        }
        if (inputRecordBitrate && inputRecordBitrate.value !== '') {
            const bitrateMbps = normalizeRecordingBitrateMbps(inputRecordBitrate.value);
            pkg.options.record.mediaRecorder.videoBitsPerSecond = bitrateMbps * 1_000_000;
        }
        if (selectRecordMime && selectRecordMime.value !== '') {
            pkg.options.record.mediaRecorder.mimeType = selectRecordMime.value;
        }
        if (inputRecordSlowdown && inputRecordSlowdown.value !== '') {
            const sd = Math.max(1, parseInt(inputRecordSlowdown.value) || 1);
            pkg.options.record.mediaRecorder.slowdownFactor = sd;
            if (cbRecordNormalize) {
                cbRecordNormalize.disabled = sd === 1;
                const normalizeLabel = cbRecordNormalize.labels?.[0];
                if (normalizeLabel) normalizeLabel.style.opacity = sd === 1 ? '0.4' : '';
            }
        }
        if (inputRecordScaleFactor && inputRecordScaleFactor.value !== '') {
            const sc = Math.max(1, Math.min(3, parseFloat(inputRecordScaleFactor.value) || 1));
            pkg.options.record.mediaRecorder.scaleFactor = sc;
        }
        if (cbRecordUpload) {
            pkg.options.record.mediaRecorder.uploadToServer = !!cbRecordUpload.checked;
        }
        if (cbRecordDownload) {
            pkg.options.record.mediaRecorder.downloadLocal = !!cbRecordDownload.checked;
        }
        if (cbRecordNormalize) {
            pkg.options.record.mediaRecorder.offlineNormalization = !!cbRecordNormalize.checked;
        }

        if (cbRecordUpload && cbRecordDownload && !cbRecordUpload.checked && !cbRecordDownload.checked) {
            pkg.showToast && pkg.showToast(
                pkg.t ? pkg.t('La vidéo ne sera ni téléchargée ni uploadée : elle sera perdue après l\'enregistrement.') : 'La vidéo sera perdue si aucune destination n\'est sélectionnée.',
                'warning', 'Aucune destination', 5000
            );
        }

        // ------- AUDIO UTILISATEUR -------
        try {
            pkg.options.record.audio = pkg.options.record.audio || {};
            if (cbRecordAudioEnable) {
                const wasEnabled = pkg.options.record.audio.enabled;
                pkg.options.record.audio.enabled = !!cbRecordAudioEnable.checked;
                // Si l'utilisateur désactive l'audio, délocker la durée
                if (wasEnabled && !pkg.options.record.audio.enabled && isDurationLockedToAudio) {
                    isDurationLockedToAudio = false;
                    updateDurationLockIndicator();
                    dbgUi('Durée délockée - audio désactivé');
                }
                // Mettre à jour l'indicateur de correspondance des durées
                updateDurationMatchIndicator();
            }
            if (inputAudioVolume && inputAudioVolume.value !== '') {
                const vol = Math.max(0, Math.min(1, parseFloat(inputAudioVolume.value) || 1));
                pkg.options.record.audio.volume = vol;
            }
        } catch(e) { console.warn('changeRecordValues audio error:', e); }

        // Sauvegarder automatiquement les paramètres d'enregistrement
        saveRecordSettings();

        // Le FPS peut modifier la durée minimale réalisable (une frame par date).
        // Si la durée vient de la musique, conserver cette cible autant que possible.
        if (isDurationLockedToAudio) updateTimePerDay();
        pkg.updateInfosForPictures();
        updateRecordingSizeEstimate();
    } catch(e) {
        console.warn('changeRecordValues error:', e);
    }
}

// Sauvegarde les paramètres d'enregistrement dans localStorage
function saveRecordSettings() {
    try {
        const recordSettings = {
            mode: pkg.options.record?.mode || 'mediarecorder',
            fps: normalizeRecordingFps(pkg.options.record?.fps),
            mediaRecorder: {
                mimeType: pkg.options.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9',
                videoBitsPerSecond: normalizeRecordingBitrateMbps(
                    Number(pkg.options.record?.mediaRecorder?.videoBitsPerSecond) / 1_000_000
                ) * 1_000_000,
                slowdownFactor: pkg.options.record?.mediaRecorder?.slowdownFactor || 1,
                uploadToServer: pkg.options.record?.mediaRecorder?.uploadToServer ?? true,
                downloadLocal: pkg.options.record?.mediaRecorder?.downloadLocal ?? true,
                offlineNormalization: pkg.options.record?.mediaRecorder?.offlineNormalization ?? true,
                scaleFactor: pkg.options.record?.mediaRecorder?.scaleFactor || 1
            },
            audio: {
                enabled: pkg.options.record?.audio?.enabled || false,
                volume: (typeof pkg.options.record?.audio?.volume === 'number') ? pkg.options.record.audio.volume : 1
            }
        };
        localStorage.setItem('recordSettings', JSON.stringify(recordSettings));
    } catch(e) {
        console.warn('Save record settings error:', e);
    }
}

// Restaure les paramètres d'enregistrement depuis localStorage
function loadRecordSettings() {
    try {
        const saved = localStorage.getItem('recordSettings');
        if (saved) {
            const recordSettings = JSON.parse(saved);
            // Appliquer les paramètres sauvegardés
            if (recordSettings.mode) {
                pkg.options.record = pkg.options.record || {};
                pkg.options.record.mode = recordSettings.mode;
                pkg.options.record.fps = normalizeRecordingFps(recordSettings.fps);
                pkg.options.record.mediaRecorder = pkg.options.record.mediaRecorder || {};
                pkg.options.record.mediaRecorder.mimeType = recordSettings.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
                pkg.options.record.mediaRecorder.videoBitsPerSecond = normalizeRecordingBitrateMbps(
                    Number(recordSettings.mediaRecorder?.videoBitsPerSecond) / 1_000_000
                ) * 1_000_000;
                pkg.options.record.mediaRecorder.slowdownFactor = recordSettings.mediaRecorder?.slowdownFactor || 1;
                pkg.options.record.mediaRecorder.uploadToServer = recordSettings.mediaRecorder?.uploadToServer ?? true;
                pkg.options.record.mediaRecorder.downloadLocal = recordSettings.mediaRecorder?.downloadLocal ?? true;
                pkg.options.record.mediaRecorder.offlineNormalization = recordSettings.mediaRecorder?.offlineNormalization ?? true;
                pkg.options.record.mediaRecorder.scaleFactor = recordSettings.mediaRecorder?.scaleFactor || 1;
                // Audio utilisateur
                pkg.options.record.audio = pkg.options.record.audio || {};
                pkg.options.record.audio.enabled = recordSettings.audio?.enabled || false;
                pkg.options.record.audio.volume = (typeof recordSettings.audio?.volume === 'number') ? recordSettings.audio.volume : 1;
            }
            return true;
        }
    } catch(e) {
        console.warn('Load record settings error:', e);
    }
    return false;
}


// ----------- BDD ------------

// Filtres

// synchronise les dates de selection des pickers avec BDD
export function setPickerDates(metadata) {
    const startDateElement = document.querySelector('#datePickerStart');
    const endDateElement = document.querySelector('#datePickerEnd');

    // Capture des dates par défaut (clonées pour éviter toute mutation)
    defaultStartDate = metadata.startDate ? new Date(metadata.startDate) : null;
    defaultEndDate = metadata.endDate ? new Date(metadata.endDate) : null;
    // Utiliser les vraies dates de publication depuis les métadonnées
    defaultPublishedStartDate = metadata.publishedStartDate ? new Date(metadata.publishedStartDate) : null;
    defaultPublishedEndDate = metadata.publishedEndDate ? new Date(metadata.publishedEndDate) : null;

    const formattedStartDate = formatDateForPickers(defaultStartDate);
    const formattedEndDate = formatDateForPickers(defaultEndDate);

    // Tempus Dominus : définir la date via l'API + l'input texte
    setTdDate(startDateElement, defaultStartDate);
    setTdDate(endDateElement, defaultEndDate);
    startDateElement.value = formattedStartDate;
    endDateElement.value = formattedEndDate;

    updateResetButtonsHighlight();

    // Initialiser les datepickers de publication avec les mêmes valeurs par défaut
    const publishedStartElement = document.querySelector('#publishedDatePickerStart');
    const publishedEndElement = document.querySelector('#publishedDatePickerEnd');
    if (publishedStartElement && publishedEndElement) {
        // S'assurer que Tempus Dominus est initialisé
        if (!getTempusDominus(publishedStartElement)) {
            initTempusDominus(publishedStartElement, { display: { components: { clock: false } }, localization: { format: 'yyyy-MM-dd' } });
        }
        if (!getTempusDominus(publishedEndElement)) {
            initTempusDominus(publishedEndElement, { display: { components: { clock: false } }, localization: { format: 'yyyy-MM-dd' } });
        }

        setTdDate(publishedStartElement, defaultPublishedStartDate);
        setTdDate(publishedEndElement, defaultPublishedEndDate);

        const formattedPublishedStartDate = formatDateForPickers(defaultPublishedStartDate);
        const formattedPublishedEndDate = formatDateForPickers(defaultPublishedEndDate);

        publishedStartElement.value = formattedPublishedStartDate;
        publishedEndElement.value = formattedPublishedEndDate;

        updatePublishedResetButtonsHighlight();
    }

    // Pré-remplir les datepickers Animation avec les dates par défaut
    const animStartElement = document.querySelector('#animDateStart');
    const animEndElement = document.querySelector('#animDateEnd');

    if (animStartElement && defaultStartDate) {
        setTdDate(animStartElement, defaultStartDate);
        animStartElement.value = formattedStartDate;
        pkg.options.animation.dateStart = defaultStartDate;
    }

    if (animEndElement && defaultEndDate) {
        setTdDate(animEndElement, defaultEndDate);
        animEndElement.value = formattedEndDate;
        pkg.options.animation.dateEnd = defaultEndDate;
    }

    // Mettre à jour les boutons reset Animation aussi
    updateResetAnimButtonsHighlight();

    // Mettre à jour les labels Materialize après avoir défini les valeurs des datepickers
    /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */
}

function formatDateForPickers(date) {
    const options = { day: '2-digit', month: '2-digit', year: 'numeric', };
    return new Date(date).toLocaleDateString('fr-CA', options);
}
function resetStartDateToDefault(){
    const el = document.querySelector('#datePickerStart');
    const start = defaultStartDate;
    if (!el || !start) return;
    setTdDate(el, start);
    el.value = formatDateForPickers(start);
    onSelectionChangedDebounced();
    updateResetButtonsHighlight();
    updateResetAnimButtonsHighlight();
    updateAnimFilterInfo();
}

function resetEndDateToDefault(){
    const el = document.querySelector('#datePickerEnd');
    const end = defaultEndDate;
    if (!el || !end) return;
    setTdDate(el, end);
    el.value = formatDateForPickers(end);
    onSelectionChangedDebounced();
    updateResetButtonsHighlight();
    updateResetAnimButtonsHighlight();
    updateAnimFilterInfo();
}

function resetPublishedStartDateToDefault(){
    const el = document.querySelector('#publishedDatePickerStart');
    const start = defaultPublishedStartDate;
    if (!el || !start) return;
    setTdDate(el, start);
    el.value = formatDateForPickers(start);
    onSelectionChangedDebounced();
    updatePublishedResetButtonsHighlight();
}

function resetPublishedEndDateToDefault(){
    const el = document.querySelector('#publishedDatePickerEnd');
    const end = defaultPublishedEndDate;
    if (!el || !end) return;
    setTdDate(el, end);
    el.value = formatDateForPickers(end);
    onSelectionChangedDebounced();
    updatePublishedResetButtonsHighlight();
}

function updateDateSourceButton(button, value, isActive){
    if (!button) return;
    const valueElement = button.querySelector('.date-source-value');
    if (valueElement) valueElement.textContent = value || '—';
    button.disabled = !value;
    button.classList.toggle('is-active', Boolean(isActive));
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
}

function updatePublishedResetButtonsHighlight(){
    const btnStart = document.getElementById('btnResetPublishedStartDate');
    const btnEnd = document.getElementById('btnResetPublishedEndDate');
    const currentStart = document.querySelector('#publishedDatePickerStart')?.value;
    const currentEnd = document.querySelector('#publishedDatePickerEnd')?.value;
    const defaultStartStr = defaultPublishedStartDate ? formatDateForPickers(defaultPublishedStartDate) : null;
    const defaultEndStr = defaultPublishedEndDate ? formatDateForPickers(defaultPublishedEndDate) : null;
    if (btnStart) {
        const atDefault = currentStart && defaultStartStr && currentStart === defaultStartStr;
        updateDateSourceButton(btnStart, defaultStartStr, atDefault);
    }
    if (btnEnd) {
        const atDefault = currentEnd && defaultEndStr && currentEnd === defaultEndStr;
        updateDateSourceButton(btnEnd, defaultEndStr, atDefault);
    }
}

function updateResetButtonsHighlight(){
    const btnStart = document.getElementById('btnResetStartDate');
    const btnEnd = document.getElementById('btnResetEndDate');
    const currentStart = document.querySelector('#datePickerStart')?.value;
    const currentEnd = document.querySelector('#datePickerEnd')?.value;
    const defaultStartStr = defaultStartDate ? formatDateForPickers(defaultStartDate) : null;
    const defaultEndStr = defaultEndDate ? formatDateForPickers(defaultEndDate) : null;
    if (btnStart) {
        const atDefault = currentStart && defaultStartStr && currentStart === defaultStartStr;
        updateDateSourceButton(btnStart, defaultStartStr, atDefault);
    }
    if (btnEnd) {
        const atDefault = currentEnd && defaultEndStr && currentEnd === defaultEndStr;
        updateDateSourceButton(btnEnd, defaultEndStr, atDefault);
    }
}

function resetAnimStartDateToDefault(){
    const el = document.querySelector('#animDateStart');
    const start = defaultStartDate;
    if (!el || !start) return;
    setTdDate(el, start);
    el.value = formatDateForPickers(start);
    pkg.options.animation.dateStart = start;
    updateResetAnimButtonsHighlight();
    updateDeltaDaysAndTimes();
}

function resetAnimEndDateToDefault(){
    const el = document.querySelector('#animDateEnd');
    const end = defaultEndDate;
    if (!el || !end) return;
    setTdDate(el, end);
    el.value = formatDateForPickers(end);
    pkg.options.animation.dateEnd = end;
    updateResetAnimButtonsHighlight();
    updateDeltaDaysAndTimes();
}

function updateResetAnimButtonsHighlight(){
    const btnStart = document.getElementById('btnResetAnimStartDate');
    const btnEnd = document.getElementById('btnResetAnimEndDate');
    const currentStart = document.querySelector('#animDateStart')?.value;
    const currentEnd = document.querySelector('#animDateEnd')?.value;
    const defaultStartStr = defaultStartDate ? formatDateForPickers(defaultStartDate) : null;
    const defaultEndStr = defaultEndDate ? formatDateForPickers(defaultEndDate) : null;

    if (btnStart) {
        updateDateSourceButton(btnStart, defaultStartStr, currentStart && defaultStartStr && currentStart === defaultStartStr);
    }
    if (btnEnd) {
        updateDateSourceButton(btnEnd, defaultEndStr, currentEnd && defaultEndStr && currentEnd === defaultEndStr);
    }
    updateAnimFilterInfo();
}

// Affichage conditionnel des dates de filtre sous les champs Animation
function updateAnimFilterInfo(){
    const startRow = document.getElementById('animFilterStartInfo');
    const endRow = document.getElementById('animFilterEndInfo');
    const startValueEl = document.getElementById('animFilterStartValue');
    const endValueEl = document.getElementById('animFilterEndValue');

    const filterStart = document.querySelector('#datePickerStart')?.value?.trim();
    const filterEnd = document.querySelector('#datePickerEnd')?.value?.trim();
    const animStart = document.querySelector('#animDateStart')?.value?.trim();
    const animEnd = document.querySelector('#animDateEnd')?.value?.trim();
    const defaultStartStr = defaultStartDate ? formatDateForPickers(defaultStartDate) : null;
    const defaultEndStr = defaultEndDate ? formatDateForPickers(defaultEndDate) : null;

    const showStart = !!(startRow && filterStart && defaultStartStr && filterStart !== defaultStartStr);
    const showEnd = !!(endRow && filterEnd && defaultEndStr && filterEnd !== defaultEndStr);

    if (startRow) {
        startRow.style.display = showStart ? 'flex' : 'none';
        if (showStart && startValueEl) {
            updateDateSourceButton(startValueEl, filterStart, animStart === filterStart);
            startValueEl.onclick = applyFilterStartToAnim;
        }
    }
    if (endRow) {
        endRow.style.display = showEnd ? 'flex' : 'none';
        if (showEnd && endValueEl) {
            updateDateSourceButton(endValueEl, filterEnd, animEnd === filterEnd);
            endValueEl.onclick = applyFilterEndToAnim;
        }
    }
}

function applyFilterStartToAnim(){
    const filterStart = document.querySelector('#datePickerStart')?.value;
    if (!filterStart) return;
    const parsed = pkg.parseDateInput(filterStart);
    if (!parsed) return;
    const animStartEl = document.querySelector('#animDateStart');
    if (animStartEl) {
        setTdDate(animStartEl, parsed);
        animStartEl.value = formatDateForPickers(parsed);
    }
    pkg.options.animation.dateStart = parsed;
    updateResetAnimButtonsHighlight();
    updateDeltaDaysAndTimes();
}

function applyFilterEndToAnim(){
    const filterEnd = document.querySelector('#datePickerEnd')?.value;
    if (!filterEnd) return;
    const parsed = pkg.parseDateInput(filterEnd);
    if (!parsed) return;
    const animEndEl = document.querySelector('#animDateEnd');
    if (animEndEl) {
        setTdDate(animEndEl, parsed);
        animEndEl.value = formatDateForPickers(parsed);
    }
    pkg.options.animation.dateEnd = parsed;
    updateResetAnimButtonsHighlight();
    updateDeltaDaysAndTimes();
}

// Debounce et wrapper
function onSelectionChangedDebounced(){
    if (isBatchReset) return; // ignoré pendant un reset groupé
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applySelectionChange, DEBOUNCE_DELAY);
}

function applySelectionChange(){
    const selectedValues = collectSelectedValues();
    persistSelectedValues(selectedValues);
    updateFilterInfos();
    pkg.changeSelect(selectedValues, pkg.options);
}

function collectSelectedValues(){
    let selectedValues = {};
    selectedValues["type"] = selectType ? Array.from(selectType.selectedOptions).map(option => option.value).filter(v => v !== '') : [];
    selectedValues["terrain"] = selectTerrain ? Array.from(selectTerrain.selectedOptions).map(option => option.value).filter(v => v !== '') : [];
    selectedValues["difficulty"] = selectDifficulty ? Array.from(selectDifficulty.selectedOptions).map(option => option.value).filter(v => v !== '') : [];
    selectedValues["container"] = selectContainer ? Array.from(selectContainer.selectedOptions).map(option => option.value).filter(v => v !== '') : [];
    const selCountry = document.getElementById('selectCountry');
    const selState = document.getElementById('selectState');
    if (selCountry) selectedValues["countries"] = Array.from(selCountry.selectedOptions).map(o => o.value).filter(v => v !== '');
    if (selState) selectedValues["states"] = Array.from(selState.selectedOptions).map(o => o.value).filter(v => v !== '');
    selectedValues["dates"] = {startDate: document.querySelector('#datePickerStart')?.value, endDate: document.querySelector('#datePickerEnd')?.value};
    selectedValues["published_dates"] = {startDate: document.querySelector('#publishedDatePickerStart')?.value, endDate: document.querySelector('#publishedDatePickerEnd')?.value};
    return selectedValues;
}

// Affiche un résumé compact dans le champ fermé et place la recherche dans le
// menu déroulant. La liste reste ouverte pendant les choix multiples et chaque
// option dispose d'une case à cocher.
function initFilterTomSelect(selectEl){
    if (!selectEl) return null;
    const placeholderOption = selectEl.querySelector('option[disabled][value=""]');
    const searchPlaceholder = placeholderOption?.textContent?.trim()
        || selectEl.getAttribute('aria-label')
        || '';
    const ts = initTomSelect(selectEl, {
        plugins: ['checkbox_options', 'dropdown_input'],
        maxItems: null,
        hideSelected: false,
        hidePlaceholder: true,
        closeAfterSelect: false,
    });
    if (!ts) return null;

    ts.wrapper.classList.add('filter-select-control');
    const searchInput = ts.dropdown?.querySelector('input');
    if (searchInput) {
        searchInput.placeholder = searchPlaceholder;
        searchInput.setAttribute('aria-label', searchPlaceholder);
    }
    updateCompactFilterSummary(selectEl);
    return ts;
}

function updateCompactFilterSummary(selectEl, all = null, none = null){
    const ts = getTomSelect(selectEl);
    if (!ts) return;
    const options = Array.from(selectEl.options).filter(opt => !opt.disabled && opt.value !== '');
    const selectedCount = options.filter(opt => opt.selected).length;
    const isAll = all ?? (options.length > 0 && selectedCount === options.length);
    const isNone = none ?? selectedCount === 0;
    const summary = isAll
        ? `${pkg.t ? pkg.t('Tout') : 'Tout'} (${options.length})`
        : isNone
            ? (pkg.t ? pkg.t('Aucun') : 'Aucun')
            : `${selectedCount} / ${options.length}`;
    ts.control.dataset.summary = summary;
    ts.control.setAttribute('aria-label', `${selectEl.getAttribute('aria-label') || ''}: ${summary}`);
}

function populateCountryStateSelects(tree){
    const selCountry = document.getElementById('selectCountry');
    const selState = document.getElementById('selectState');
    if (!selCountry || !selState) {
        dbgFilters('[COUNTRY] Selects not ready, retry later');
        setTimeout(() => populateCountryStateSelects(tree), 200);
        return;
    }
    // Détruire les instances Tom Select AVANT de modifier le DOM
    try { const ts = getTomSelect(selCountry); if (ts) ts.destroy(); } catch(_) {}
    try { const ts = getTomSelect(selState); if (ts) ts.destroy(); } catch(_) {}

    // Populate countries
    selCountry.innerHTML = '';
    // Ajouter l'option placeholder pour les pays
    const placeholderCountry = document.createElement('option');
    placeholderCountry.value = '';
    placeholderCountry.disabled = true;
    placeholderCountry.textContent = pkg.t ? pkg.t('Filtrer par pays') : 'Filtrer par pays';
    selCountry.appendChild(placeholderCountry);

    const countries = Object.keys(tree).sort((a,b)=>a.localeCompare(b));
    dbgFilters('[COUNTRY] Populating countries:', countries.length);
    const fragC = document.createDocumentFragment();
    for (const c of countries){
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c; opt.selected = true;
        fragC.appendChild(opt);
    }
    selCountry.appendChild(fragC);
    // Initialiser Tom Select sur les pays
    if (countries.length > 0) {
        try { initFilterTomSelect(selCountry); } catch(_) {}
    }

    // Populate states (from selected countries or all)
    const statesSet = new Set();
    for (const list of Object.values(tree)) { (list||[]).forEach(s => statesSet.add(s)); }
    dbgFilters('[COUNTRY] Populating states total unique:', statesSet.size);
    selState.innerHTML = '';
    // Ajouter l'option placeholder pour les états
    const placeholderState = document.createElement('option');
    placeholderState.value = '';
    placeholderState.disabled = true;
    placeholderState.textContent = pkg.t ? pkg.t('Filtrer par région/état') : 'Filtrer par région/état';
    selState.appendChild(placeholderState);

    const fragS = document.createDocumentFragment();
    for (const s of Array.from(statesSet).sort((a,b)=>a.localeCompare(b))){
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s; opt.selected = true;
        fragS.appendChild(opt);
    }
    selState.appendChild(fragS);
    if (statesSet.size > 0) {
        try { initFilterTomSelect(selState); } catch(_) {}
    }

    selCountry.addEventListener('change', () => {
        // Si des vraies options sont sélectionnées, désélectionner le placeholder
        const realSelected = Array.from(selCountry.selectedOptions).filter(o => !o.disabled && o.value !== '');
        if (realSelected.length > 0) {
            const placeholder = selCountry.querySelector('option[disabled][value=""]');
            if (placeholder) placeholder.selected = false;
        }

        const selected = Array.from(selCountry.selectedOptions).map(o => o.value);
        dbgFilters('[COUNTRY] Country change selected=', selected);
        const sset = new Set();
        selected.forEach(c => (tree[c]||[]).forEach(s => sset.add(s)));
        // Détruire avant de modifier le <select> natif afin que Tom Select ne
        // conserve pas d'options obsolètes dans son DOM interne.
        try { const ts = getTomSelect(selState); if (ts) ts.destroy(); } catch(_) {}
        selState.innerHTML = '';
        // Toujours ajouter le placeholder en premier
        const placeholderStateChange = document.createElement('option');
        placeholderStateChange.value = '';
        placeholderStateChange.disabled = true;
        placeholderStateChange.textContent = pkg.t ? pkg.t('Filtrer par région/état') : 'Filtrer par région/état';
        selState.appendChild(placeholderStateChange);

        const frag = document.createDocumentFragment();
        Array.from(sset).sort((a,b)=>a.localeCompare(b)).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s; opt.textContent = s; opt.selected = selected.length > 0; // si aucun pays, rien sélectionné
            frag.appendChild(opt);
        });
        selState.appendChild(frag);
        if (sset.size > 0) {
            try { initFilterTomSelect(selState); } catch(_) {}
        }
        dbgFilters('[COUNTRY] States populated for selection=', sset.size);
        // Mise à jour des infos et déclenchement filtrage
        updateFilterInfos();
        onSelectionChangedDebounced();
    });

    // Déclencher le filtrage quand l'utilisateur change la sélection des états directement
    selState.addEventListener('change', () => {
        dbgFilters('[COUNTRY] State selection changed');
        // Si des vraies options sont sélectionnées, désélectionner le placeholder
        const realSelected = Array.from(selState.selectedOptions).filter(o => !o.disabled && o.value !== '');
        if (realSelected.length > 0) {
            const placeholder = selState.querySelector('option[disabled][value=""]');
            if (placeholder) placeholder.selected = false;
        }
        updateFilterInfos();
        onSelectionChangedDebounced();
    });
}

function persistSelectedValues(values){
    try {
        localStorage.setItem('filtersSelection', JSON.stringify(values));
    } catch(e) { console.warn('Persist filters error', e); }
}

function restoreSelectedValues(){
    try {
        const raw = localStorage.getItem('filtersSelection');
        if (!raw) {
            // Pas de sauvegarde, utiliser les valeurs par défaut du HTML (attributs selected)
            dbgFilters('[FILTER] No saved filters, using HTML defaults');
            // Juste rafraîchir Tom Select pour afficher les valeurs selected du HTML
            if (selectType) refreshTomSelect(selectType);
            if (selectDifficulty) refreshTomSelect(selectDifficulty);
            if (selectTerrain) refreshTomSelect(selectTerrain);
            if (selectContainer) refreshTomSelect(selectContainer);
            updateFilterInfos();
            return;
        }

        const values = JSON.parse(raw);
        dbgFilters('[FILTER] Restoring saved filters:', values);
        setSelectValues(selectType, values.type);
        setSelectValues(selectDifficulty, values.difficulty);
        setSelectValues(selectTerrain, values.terrain);
        setSelectValues(selectContainer, values.container);
        // dates
        const start = document.querySelector('#datePickerStart');
        const end = document.querySelector('#datePickerEnd');
        if (start && values.dates?.startDate) start.value = values.dates.startDate;
        if (end && values.dates?.endDate) end.value = values.dates.endDate;
        // refresh UI (Tom Select)
        if (selectType) refreshTomSelect(selectType);
        if (selectDifficulty) refreshTomSelect(selectDifficulty);
        if (selectTerrain) refreshTomSelect(selectTerrain);
        if (selectContainer) refreshTomSelect(selectContainer);
        updateFilterInfos();
    } catch(e) {
        console.warn('Restore filters error', e);
        // En cas d'erreur, utiliser les valeurs par défaut du HTML
        if (selectType) refreshTomSelect(selectType);
        if (selectDifficulty) refreshTomSelect(selectDifficulty);
        if (selectTerrain) refreshTomSelect(selectTerrain);
        if (selectContainer) refreshTomSelect(selectContainer);
        updateFilterInfos();
    }
}

function setSelectValues(selectEl, values){
    if (!selectEl || !values) return;
    Array.from(selectEl.options).forEach(opt => { opt.selected = values.includes(opt.value); });
}

function selectAllOptions(selectEl){
    if (!selectEl) return;
    // No-op si tout est déjà sélectionné (évite un cycle de filtrage inutile)
    if (areAllSelected(selectEl)) return;
    Array.from(selectEl.options).forEach(opt => { if (!opt.disabled) opt.selected = true; });
    // Synchroniser Tom Select pour mettre à jour l'affichage visuel
    refreshTomSelect(selectEl);
    onSelectionChangedDebounced();
    updateFilterInfos();
}

function deselectAllOptions(selectEl){
    if (!selectEl) return;
    // No-op si rien n'est déjà sélectionné (évite un cycle de filtrage inutile)
    if (areNoneSelected(selectEl)) return;
    Array.from(selectEl.options).forEach(opt => { opt.selected = false; });

    // Pour les selects avec placeholder, sélectionner le placeholder quand tout est vide
    const placeholderOption = selectEl.querySelector('option[disabled][value=""]');
    if (placeholderOption) {
        placeholderOption.selected = true;
    }

    // Synchroniser Tom Select pour mettre à jour l'affichage visuel
    refreshTomSelect(selectEl);
    onSelectionChangedDebounced();
    updateFilterInfos();
}

// Réinitialise tous les filtres (selects + dates) aux valeurs par défaut en un seul cycle
function resetAllFilters(){
    isBatchReset = true;
    try {
        // Selects : tout sélectionner (valeur par défaut = tout)
        selectAllOptions(selectType);
        selectAllOptions(selectDifficulty);
        selectAllOptions(selectTerrain);
        selectAllOptions(selectContainer);
        const selCountry = document.getElementById('selectCountry');
        const selState = document.getElementById('selectState');
        if (selCountry) selectAllOptions(selCountry);
        if (selState) selectAllOptions(selState);
        // Dates : reset aux valeurs par défaut
        resetStartDateToDefault();
        resetEndDateToDefault();
        resetPublishedStartDateToDefault();
        resetPublishedEndDateToDefault();
    } finally {
        isBatchReset = false;
    }
    // Un seul cycle de filtrage à la fin
    updateFilterInfos();
    onSelectionChangedDebounced();
}

// Mise à jour des informations sous chaque filtre et surbrillance "TOUT"
function updateFilterInfos(){
    updateFilterInfoFor(selectType, infoType, btnAllType, btnNoneType);
    updateFilterInfoFor(selectDifficulty, infoDifficulty, btnAllDifficulty, btnNoneDifficulty);
    updateFilterInfoFor(selectTerrain, infoTerrain, btnAllTerrain, btnNoneTerrain);
    updateFilterInfoFor(selectContainer, infoContainer, btnAllContainer, btnNoneContainer);
    // Country/State
    const selectCountryEl = document.getElementById('selectCountry');
    const selectStateEl = document.getElementById('selectState');
    const btnAllCountry = document.getElementById('btnAllCountry');
    const btnAllState = document.getElementById('btnAllState');
    const btnNoneCountry = document.getElementById('btnNoneCountry');
    const btnNoneState = document.getElementById('btnNoneState');
    const infoCountry = document.getElementById('infoCountry');
    const infoState = document.getElementById('infoState');
    updateFilterInfoFor(selectCountryEl, infoCountry, btnAllCountry, btnNoneCountry);
    updateFilterInfoFor(selectStateEl, infoState, btnAllState, btnNoneState);
}

function updateFilterInfoFor(selectEl, infoEl, btnAllEl, btnNoneEl){
    if (!selectEl || !infoEl) return;
    const all = areAllSelected(selectEl);
    const none = areNoneSelected(selectEl);
    if (all) {
        infoEl.textContent = 'TOUT';
        infoEl.classList.add('filter-info-all');
        if (btnAllEl) btnAllEl.classList.add('filter-all-active');
    } else {
        const text = getSelectedValuesText(selectEl);
        infoEl.textContent = text.length ? text : 'Aucun';
        infoEl.classList.remove('filter-info-all');
        if (btnAllEl) btnAllEl.classList.remove('filter-all-active');
    }
    // Désactivation visuelle des boutons sans effet :
    // "Tout" grisé quand tout est déjà sélectionné,
    // "Aucun" grisé quand rien n'est sélectionné.
    setBtnDisabled(btnAllEl, all);
    setBtnDisabled(btnNoneEl, none);
    updateCompactFilterSummary(selectEl, all, none);
}

function setBtnDisabled(btnEl, disabled){
    if (!btnEl) return;
    if (disabled) {
        btnEl.classList.add('filter-btn-disabled');
        btnEl.setAttribute('aria-disabled', 'true');
    } else {
        btnEl.classList.remove('filter-btn-disabled');
        btnEl.removeAttribute('aria-disabled');
    }
}

// Accessibilité : rend les <a> du panneau de filtres navigables au clavier.
// Ajoute role="button", tabindex="0" et déclenche le click sur Enter/Space.
function setupFilterButtonAccessibility(){
    const panel = document.getElementById('filterPanel');
    if (!panel) return;
    const buttons = panel.querySelectorAll('a.btn-link, a.btn-flat');
    buttons.forEach(btn => {
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        // Éviter d'ajouter plusieurs fois le handler
        if (btn.dataset.a11yBound) return;
        btn.dataset.a11yBound = '1';
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                // Respecter aria-disabled (boutons grisés du point 14)
                if (btn.getAttribute('aria-disabled') === 'true') return;
                btn.click();
            }
        });
    });
}

function areAllSelected(selectEl){
    const options = Array.from(selectEl.options).filter(opt => !opt.disabled && opt.value !== '');
    const selected = options.filter(opt => opt.selected);
    return options.length > 0 && selected.length === options.length;
}

function areNoneSelected(selectEl){
    const options = Array.from(selectEl.options).filter(opt => !opt.disabled && opt.value !== '');
    if (options.length === 0) return true;
    const selected = options.filter(opt => opt.selected);
    return selected.length === 0;
}

function getSelectedValuesText(selectEl){
    const values = Array.from(selectEl.selectedOptions)
        .filter(o => !o.disabled && o.value !== '') // Exclure les placeholders
        .map(o => o.textContent.trim());
    return values.join(', ');
}



// ----------- POINTS ------------

// recupère tous les changements liés aux points
function changePointStyleUI(event){
    // switch
    if (switchIconeVectoriel.checked) {
        pkg.options.point.mode = "vectoriel";
    } else {
        pkg.options.point.mode = "icone";
    }

    // Gestion de l'affichage des sous-menus
    updatePointOptionsDisplay();
    // colorpickers
    pkg.options.point.border.color = cpPointBorderColor.value;
    pkg.options.point.center.color = cpPointCenterColor.value;
    // radio buttons
    if (event.type == "radio") {
        if (event.name == "fillColorPoint"){
            pkg.options.point.center.mode = event.value;
        }
        else if (event.name == "borderColorPoint"){
            pkg.options.point.border.mode = event.value;
        }
    }
    // sliders - validation pour éviter NaN
    pkg.options.point.center.size = Math.max(1, parseInt(inputSizePoint.value) || 3);
    pkg.options.point.border.size = Math.max(0, parseInt(inputSizeBorder.value) || 0);
    // selects
    pkg.options.point.shape = selectShape.value

    // rafraichissement des points
    pkg.refreshPoints(pkg.options);
}

// Gestion de l'affichage des sous-menus pour les points
function updatePointOptionsDisplay() {
    const vectorielOptions = document.getElementById('vectorielOptions');
    const iconeOptions = document.getElementById('iconeOptions');

    if (switchIconeVectoriel.checked) {
        // Mode vectoriel - afficher les options vectorielles, masquer les icônes
        if (vectorielOptions) vectorielOptions.style.display = 'block';
        if (iconeOptions) iconeOptions.style.display = 'none';
    } else {
        // Mode icône - afficher les options d'icônes, masquer les vectorielles
        if (vectorielOptions) vectorielOptions.style.display = 'none';
        if (iconeOptions) iconeOptions.style.display = 'block';

        // Initialiser les options d'icônes si nécessaire
        initializeIconOptions();
    }
}

// Initialisation des options d'icônes
function initializeIconOptions() {
    // Synchroniser les sliders de taille d'icône
    const sliderSizeIcon = document.getElementById('sliderSizeIcon');
    const inputSizeIcon = document.getElementById('inputSizeIcon');

    if (sliderSizeIcon && inputSizeIcon) {
        // Synchronisation des contrôles
        sliderSizeIcon.oninput = function() {
            inputSizeIcon.value = this.value;
            updateIconSize();
        };
        inputSizeIcon.oninput = function() {
            sliderSizeIcon.value = this.value;
            updateIconSize();
        };

        // Valeurs par défaut
        if (!sliderSizeIcon.value) sliderSizeIcon.value = 24;
        if (!inputSizeIcon.value) inputSizeIcon.value = 24;
    }

    // Gestion du select d'icônes
    const selectIconSet = document.getElementById('selectIconSet');
    if (selectIconSet) {
        selectIconSet.addEventListener('change', updateIconSet);
        // Pas de remove_button : ce champ doit toujours avoir une valeur.
        initTomSelect(selectIconSet, { maxItems: 1, plugins: [] });
        // Initialiser avec le premier jeu d'icônes
        updateIconSet();
    }
}

// Mise à jour du jeu d'icônes affiché
function updateIconSet() {
    const selectIconSet = document.getElementById('selectIconSet');
    const iconPreview = document.getElementById('iconPreview');

    if (!selectIconSet || !iconPreview) return;

    const selectedSet = selectIconSet.value;
    let icons = [];
    let useSprite = false;
    let spriteMeta = null; // {url, sheetWidth, sheetHeight, items: [{key,x,y,w,h}]}

    // Définir les icônes selon le jeu sélectionné
    switch (selectedSet) {
        case 'geocaching':
            // Sprite Geocaching: définir la meta (à adapter à votre sprite)
            useSprite = true;
            spriteMeta = {
                url: '/static/img/geocaching-sprite.png',
                url2x: '/static/img/geocaching-sprite@2x.png',
                // Feuille paddée en puissance de 2 (2048x256) pour autoriser les mipmaps GPU (WebGL1).
                // Les icônes restent ancrées en haut-gauche, le padding est en bas-droite : les offsets ne changent pas.
                sheetWidth: 2048,
                sheetHeight: 256,
                items: [
                    { key: 'trad',    x:   0, y:  0, w:50, h:50, label: 'Traditional' },
                    { key: 'ape',   x:  100, y:  0, w:50, h:50, label: 'APE' },

                    { key: 'hq',    x:  200, y:  0, w:50, h:50, label: 'HQ' },
                    { key: 'multi',  x:  300, y:  0, w:50, h:50, label: 'Multi' },
                    { key: 'event',   x: 400, y:  0, w:50, h:50, label: 'Event' },
                    { key: 'cito',    x: 500, y:  0, w:50, h:50, label: 'CITO' },
                    { key: 'mega',    x: 600, y:  0, w:50, h:50, label: 'Mega' },
                    { key: 'giga',   x: 700, y:  0, w:50, h:50, label: 'Giga' },
                    { key: 'maze',    x: 800, y:  0, w:50, h:50, label: 'GPS Adventures Exhibit' },
                    { key: 'earth',     x: 900, y:  0, w:50, h:50, label: 'Earthcache' },
                    { key: 'virtual', x: 1000, y:  0, w:50, h:50, label: 'Virtual' },
                    { key: 'webcam', x: 1100, y:  0, w:50, h:50, label: 'Webcam' },
                    { key: 'locationless', x: 1200, y:  0, w:50, h:50, label: 'Locationless' },
                    { key: 'unknown',     x: 1300, y:  0, w:50, h:50, label: 'Unknown' },
                    { key: 'letterbox',      x: 1400, y:  0, w:50, h:50, label: 'Letterbox' },
                    { key: 'wherigo',   x: 1500, y:  0, w:50, h:50, label: 'Wherigo' },
                    // Autres à ajouter éventuellement)
                ]
            };
            break;
        case 'smiley':
            // Sprite Smiley: seulement l'icône "found it" du geocaching
            useSprite = true;
            spriteMeta = {
                url: '/static/img/geocaching-sprite.png',
                url2x: '/static/img/geocaching-sprite@2x.png',
                // Feuille paddée en puissance de 2 (2048x256) — voir cas 'geocaching'.
                sheetWidth: 2048,
                sheetHeight: 256,
                items: [
                    { key: 'found', x: 1700, y: 0, w: 50, h: 50, label: 'Found It' }
                ]
            };
            break;
    }

    if (useSprite && spriteMeta) {
        // Rendu via sprite atlas
        const sheetW = spriteMeta.sheetWidth;
        const sheetH = spriteMeta.sheetHeight;
        const url1x = spriteMeta.url;
        const url2x = spriteMeta.url2x;

        iconPreview.innerHTML = spriteMeta.items.map((it) => `
            <div class="icon-item" data-icon="${it.key}">
                <div class="icon-sprite" style="
                    background-image:url('${url1x}');
                    ${url2x ? `background-image: image-set(
                        url('${url1x}') 1x,
                        url('${url2x}') 2x
                    );` : ''}
                    background-position:-${it.x}px -${it.y}px;
                    width:${it.w}px; height:${it.h}px;
                    background-size:${sheetW}px ${sheetH}px;
                "></div>
                <div class="icon-label">${it.label}</div>
            </div>
        `).join('');

        // Sauvegarder la meta pour le rendu carte
        pkg.options.point.mode = 'icone';
        pkg.options.point.iconSet = selectedSet;
        pkg.options.point.sprite = {
            url: spriteMeta.url,
            url2x: spriteMeta.url2x,
            sheetWidth: spriteMeta.sheetWidth,
            sheetHeight: spriteMeta.sheetHeight,
            map: Object.fromEntries(spriteMeta.items.map(it => [it.key, {x:it.x,y:it.y,w:it.w,h:it.h}]))
        };

        pkg.refreshPoints(pkg.options);
    }
}

// ... (rest of the code remains the same)
// (suppression du mode emoji)

// Sélection d'une icône dans le sprite
function selectSpriteIcon(iconKey) {
    document.querySelectorAll('.icon-item').forEach(item => item.classList.remove('selected'));
    const selectedItem = document.querySelector(`[data-icon="${iconKey}"]`);
    if (selectedItem) selectedItem.classList.add('selected');

    if (pkg.options && pkg.options.point) {
        pkg.options.point.iconKey = iconKey; // clé logique (trad, multi, ...)
        pkg.options.point.icon = iconKey;    // compat
        pkg.refreshPoints(pkg.options);
    }
}

// Mise à jour de la taille des icônes
function updateIconSize() {
    const inputSizeIcon = document.getElementById('inputSizeIcon');
    if (inputSizeIcon && pkg.options && pkg.options.point) {
        pkg.options.point.iconSize = parseInt(inputSizeIcon.value) || 24;
        pkg.refreshPoints(pkg.options);
    }
}

// Exposer les fonctions globalement pour les appels depuis le HTML
window.selectSpriteIcon = selectSpriteIcon;
window.updateIconSize = updateIconSize;

function synchronizeSliderAndInputCenter() {
    sliderSizePoint.oninput = function() {
        inputSizePoint.value = this.value;
    };

    // Mise à jour du slider lors de la modification de l'input number
    inputSizePoint.oninput = function() {
        sliderSizePoint.value = this.value;
    };

    // reglage des compteurs
    sliderSizePoint.value = pkg.options.point.center.size
    inputSizePoint.value = pkg.options.point.center.size
}


function synchronizeSliderAndInputBorder() {
    sliderSizeBorder.oninput = function() {
        inputSizeBorder.value = this.value;
    };

    // Mise à jour du slider lors de la modification de l'input number
    inputSizeBorder.oninput = function() {
        sliderSizeBorder.value = this.value;
    };

    // reglage des compteurs
    sliderSizeBorder.value = pkg.options.point.border.size
    inputSizeBorder.value = pkg.options.point.border.size
}


//  ------- CARTE VECTORIELLE -------
// TODO Faire comme pour les points : collecter tous les changements dans la même fonction

// changement de couleur de trait
function changecpStrokeColor() {
    pkg.options.map.vectorMap.strokeColor = cpStrokeColor.value;
    pkg.refreshVectorMap(pkg.options.map.vectorMap);
}

// changement de couleur de remplissage
function changecpfillColor() {
    pkg.options.map.vectorMap.fillColor = cpFillColor.value;
    pkg.refreshVectorMap(pkg.options.map.vectorMap);
}

// changement de couleur de fond
function changecpBackgroundColor() {
    pkg.options.map.vectorMap.background = cpBackgroundColor.value;
    pkg.refreshVectorMap(pkg.options.map.vectorMap);
}

// changement de largeur de trait
function changestrokeWidth() {
    pkg.options.map.vectorMap.strokeWidth = strokeWidth.value;
    pkg.refreshVectorMap(pkg.options.map.vectorMap);
}

// mise à jour de l'affichage de la valeur du slider
function updateStrokeWidthValue() {
    const sliderValueElement = document.querySelector('.vector-slider-value');
    if (sliderValueElement && strokeWidth) {
        sliderValueElement.textContent = parseFloat(strokeWidth.value).toFixed(1);
    }
}


// ---------------- CARTE TONER -------------------

function changeStamenTonerStyle(){
    // Récupérer l'ID du bouton cliqué directement
    const styleName = this.id;
    dbgUi('Changement de style Toner:', styleName);

    let style;
    if (styleName === "stamenTonerDark"){
        style = "dark";
        dbgUi('Style sombre sélectionné');
    } else if (styleName === "stamenTonerLight"){
        style = "light";
        dbgUi('Style clair sélectionné');
    } else {
        console.warn('Style non reconnu:', styleName);
        return;
    }

    // Mettre à jour les options
    pkg.options.map.stamenToner.type = style;
    dbgUi('Options mises à jour:', pkg.options.map.stamenToner);

    // Changer l'apparence des boutons
    changeButtonsStamenToner(style);

    // Rafraîchir la carte
    pkg.refreshStamenTonerMap(pkg.options.map.stamenToner);
    dbgUi('Carte rafraîchie');
}

// selectionne/deselectionne les boutons pour le Sous menu Stamen Toner au démarrage et au clic sur un des boutons
function changeButtonsStamenToner(style){
    if (style == "dark"){
        btnStamenTonerLight.classList.remove('disabled');
        btnStamenTonerDark.classList.add('disabled');
    } else if (style == "light"){
        btnStamenTonerLight.classList.add('disabled');
        btnStamenTonerDark.classList.remove('disabled');
    }
}   


// -------------CHANGEMENT DES CARTES ----------------

export function selectVectorMapMenu(){
    // Animation fluide avec classes CSS
    if (divVectorMapOptions) {
        divVectorMapOptions.style.display = 'block';
        divVectorMapOptions.classList.add('show');
    }
    if (divTonerMapOptions) {
        divTonerMapOptions.classList.remove('show');
        // Délai pour l'animation avant de masquer complètement
        setTimeout(() => {
            if (divTonerMapOptions) divTonerMapOptions.style.display = 'none';
        }, 300);
    }

    // on reaffiche tous les boutons
    unSelectAllMapsButtons();
    // on selectionne (disables) le bouton de la carte en question
    if (btnVectorMap) btnVectorMap.classList.add('disabled');
}

export function selectOSMMapMenu(){
    // Masquer toutes les options avec animation
    if (divVectorMapOptions) {
        divVectorMapOptions.classList.remove('show');
        setTimeout(() => {
            if (divVectorMapOptions) divVectorMapOptions.style.display = 'none';
        }, 300);
    }
    if (divTonerMapOptions) {
        divTonerMapOptions.classList.remove('show');
        setTimeout(() => {
            if (divTonerMapOptions) divTonerMapOptions.style.display = 'none';
        }, 300);
    }

    unSelectAllMapsButtons();
    if (btnOSM) btnOSM.classList.add('disabled');
}

export function selectWatercolorMapMenu(){
    // Masquer toutes les options avec animation
    if (divVectorMapOptions) {
        divVectorMapOptions.classList.remove('show');
        setTimeout(() => {
            if (divVectorMapOptions) divVectorMapOptions.style.display = 'none';
        }, 300);
    }
    if (divTonerMapOptions) {
        divTonerMapOptions.classList.remove('show');
        setTimeout(() => {
            if (divTonerMapOptions) divTonerMapOptions.style.display = 'none';
        }, 300);
    }

    unSelectAllMapsButtons();
    if (btnWatercolor) btnWatercolor.classList.add('disabled');
}

export function selectStamenTonerMapMenu(){
    dbgUi('Affichage des options Toner avec animation');

    if (divTonerMapOptions) {
        divTonerMapOptions.style.display = 'block';
        divTonerMapOptions.classList.add('show');
        dbgUi('Options Toner affichées avec animation');
    } else {
        console.warn('divTonerMapOptions non trouvé');
    }

    if (divVectorMapOptions) {
        divVectorMapOptions.classList.remove('show');
        // Délai pour l'animation avant de masquer complètement
        setTimeout(() => {
            if (divVectorMapOptions) divVectorMapOptions.style.display = 'none';
        }, 300);
    }

    unSelectAllMapsButtons();
    if (btnStamenToner) {
        btnStamenToner.classList.add('disabled');
    }
}

// permet de deselectionner tous les boutons de cartes avant de reselectionner le bon
function unSelectAllMapsButtons(){
    btnOSM.classList.remove('disabled');
    btnWatercolor.classList.remove('disabled');
    btnStamenToner.classList.remove('disabled');
    btnVectorMap.classList.remove('disabled');
}


// ----------------- SYSTÈME DE NOTIFICATIONS (remplace les modales) ----------------

// Fonctions de compatibilité pour remplacer les modales
let currentLoadingToast = null;

export function openModalLoading(title, description){
    try {
        if (pkg && typeof pkg.t === 'function') {
            title = title ? pkg.t(title) : title;
            description = description ? pkg.t(description) : description;
        }
    } catch(_) {}
    // Fermer un éventuel loader précédent pour éviter les doublons
    try {
        if (currentLoadingToast) {
            try { pkg.hideToast(currentLoadingToast); } catch(_) { try { currentLoadingToast.remove(); } catch(_) {} }
            currentLoadingToast = null;
        }
    } catch(_) {}

    // Remplacer la modal par un toast non-bloquant
    try {
        currentLoadingToast = pkg.showLoadingToast(description, title);
        dbgUi('[LOADER] openModalLoading créé:', !!currentLoadingToast, currentLoadingToast);
        // S'assurer que le toast est bien visible (certaines implémentations peuvent retourner un élément déjà dans le DOM mais masqué)
        if (currentLoadingToast) {
            try { currentLoadingToast.style.display = 'flex'; } catch(_) {}
            try { currentLoadingToast.classList.add('show'); } catch(_) {}
        }
        // Activer l'animation indéterminée pour montrer que quelque chose se passe
        pkg.setIndeterminateProgress && pkg.setIndeterminateProgress(currentLoadingToast);
    } catch (e) {
        console.warn('[LOADER] showLoadingToast a échoué, fallback manuel', e);
        // Fallback manuel
        const container = document.querySelector('.gcm-toast-container') || (function(){
            const c = document.createElement('div');
            c.className = 'gcm-toast-container';
            c.style.position = 'fixed';
            c.style.top = '20px';
            c.style.right = '20px';
            c.style.zIndex = '2147483000';
            c.style.maxWidth = '400px';
            document.body.appendChild(c);
            return c;
        })();
        const toast = document.createElement('div');
        toast.className = 'gcm-toast info show';
        toast.innerHTML = `
            <div class="gcm-toast-icon">ℹ️</div>
            <div class="gcm-toast-content">
                ${title ? `<div class=\"gcm-toast-title\">${title}</div>` : ''}
                <div class="gcm-toast-message">${description || ''}</div>
                <div class="gcm-toast-progress">
                    <div class="gcm-progress-bar"><div class="gcm-progress-fill indeterminate" style="width:30%"></div></div>
                </div>
            </div>
            <button class="gcm-toast-close" onclick="this.parentElement.remove()">×</button>
        `;
        container.appendChild(toast);
        currentLoadingToast = toast;
    }

    // Plus besoin d'overlay séparé - le toast est déjà dans le bon conteneur
}

export function updateTextsModal(title, description){
    try {
        if (pkg && typeof pkg.t === 'function') {
            title = title ? pkg.t(title) : title;
            description = description ? pkg.t(description) : description;
        }
    } catch(_) {}
    // Mettre à jour le toast actuel si existant
    if (currentLoadingToast) {
        const titleElement = currentLoadingToast.querySelector('.toast-title, .gcm-toast-title');
        const messageElement = currentLoadingToast.querySelector('.toast-message, .gcm-toast-message');
        if (titleElement) titleElement.textContent = title;
        if (messageElement) messageElement.textContent = description;
        dbgUi('[LOADER] updateTextsModal ok');
    } else {
        console.warn('[LOADER] updateTextsModal sans loader');
    }
}

export function closeModalLoading(){
    // Fermer le toast de chargement
    if (currentLoadingToast) {
        try { pkg.hideToast(currentLoadingToast); } catch(e) { try { currentLoadingToast.remove(); } catch(_) {} }
        currentLoadingToast = null;
        dbgUi('[LOADER] closeModalLoading');
    }
}

export function updateProgressBar(data) {
    // Mettre à jour la progress bar du toast actuel
    if (currentLoadingToast) {
        // Progression attendue en pourcentage 0..100
        let p = data && typeof data.progress === 'number' ? data.progress : 0;
        p = Math.min(100, Math.max(0, p));
        try { pkg.updateToastProgress(currentLoadingToast, p); } catch(e) {
            const fill = currentLoadingToast.querySelector('.gcm-progress-fill, .progress-fill');
            if (fill) fill.style.width = `${p}%`;
        }

        // Mettre à jour le message si fourni
        if (data.message) {
            const messageElement = currentLoadingToast.querySelector('.toast-message, .gcm-toast-message');
            if (messageElement) {
                messageElement.textContent = data.message;
            }
        }
        dbgUi('[LOADER] updateProgressBar:', data.progress);
    } else {
        console.warn('[LOADER] updateProgressBar sans loader');
    }
}


// SYSTÈME DE NOTIFICATIONS (remplace les modales d'infos)
export function openModalnfos(title, description, mode="text"){
    // Déterminer le type de toast selon le titre
    let type = 'info';
    if (title.toLowerCase().includes('erreur') || title.toLowerCase().includes('error')) {
        type = 'error';
    } else if (title.toLowerCase().includes('succès') || title.toLowerCase().includes('success')) {
        type = 'success';
    } else if (title.toLowerCase().includes('attention') || title.toLowerCase().includes('warning')) {
        type = 'warning';
    }

    // Nettoyer le HTML si nécessaire pour l'affichage en toast
    let cleanDescription = description;
    if (mode === "html") {
        // Extraire le texte des balises HTML simples
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = description;
        cleanDescription = tempDiv.textContent || tempDiv.innerText || description;
    }

    // Afficher le toast
    pkg.showToast(cleanDescription, type, title, 8000); // 8 secondes pour les messages importants
}

// Fonction de compatibilité (plus nécessaire mais gardée pour compatibilité)
export function updateTextsModalInfos(title, description, mode="text"){
    // Cette fonction n'est plus nécessaire avec les toasts
    dbgUi("updateTextsModalInfos:", title, description);
}

export function closeModalInfos(){
    // Cette fonction n'est plus nécessaire avec les toasts
    // Les toasts se ferment automatiquement ou manuellement
}



// ----------------- ANIMATION DE LA CARTE ----------------

// Affichage boutons principaux
function showStartRecordButtons(){
    dbgUi("=== showStartRecordButtons ===");
    const btnStart = document.getElementById('btnStartAnimation');
    const btnRecord = document.getElementById('btnRecordAnimation');
    const btnPause = document.getElementById('btnPauseAnimation');
    const btnStop = document.getElementById('btnStopAnimation');
    if (!btnStart || !btnRecord || !btnPause || !btnStop) {
        dbgUi("❌ Boutons manquants:", {btnStart: !!btnStart, btnRecord: !!btnRecord, btnPause: !!btnPause, btnStop: !!btnStop});
        return;
    }

    dbgUi("Configuration boutons principaux:");
    dbgUi("  Start avant:", window.getComputedStyle(btnStart).display);
    dbgUi("  Record avant:", window.getComputedStyle(btnRecord).display);
    dbgUi("  Pause avant:", window.getComputedStyle(btnPause).display);
    dbgUi("  Stop avant:", window.getComputedStyle(btnStop).display);

    btnStart.style.setProperty('display', 'inline-block', 'important');
    btnRecord.style.setProperty('display', 'inline-block', 'important');
    btnPause.style.setProperty('display', 'none', 'important');
    btnStop.style.setProperty('display', 'none', 'important');

    dbgUi("  Start après:", window.getComputedStyle(btnStart).display);
    dbgUi("  Record après:", window.getComputedStyle(btnRecord).display);
    dbgUi("  Pause après:", window.getComputedStyle(btnPause).display);
    dbgUi("  Stop après:", window.getComputedStyle(btnStop).display);
}

function showPauseStopButtons(){
    dbgUi("showPauseStopButtons")
    const btnStart = document.getElementById('btnStartAnimation');
    const btnRecord = document.getElementById('btnRecordAnimation');
    const btnPause = document.getElementById('btnPauseAnimation');
    const btnStop = document.getElementById('btnStopAnimation');
    if (!btnStart || !btnRecord || !btnPause || !btnStop) return;

    btnStart.style.setProperty('display', 'none', 'important');
    btnRecord.style.setProperty('display', 'none', 'important');
    btnPause.style.setProperty('display', 'inline-block', 'important');
    btnStop.style.setProperty('display', 'inline-block', 'important');
}

function clickStartAnimation(){
    toggleButtonAnimationPauseAndRestart(true);
    // Vide la source vectorielle avant de démarrer l'animation
    pkg.startAnimation();
    showPauseStopButtons();
    updateControlBar();
}

function clickRecordAnimation(){
    // Vide la source vectorielle avant de démarrer l'animation
    pkg.recordAnimation();
    showPauseStopButtons();
    // En mode enregistrement, la pause ferait un arrêt complet sans feedback
    // → on désactive le bouton Pause et on redirige vers Arrêter
    const btnPause = document.getElementById('btnPauseAnimation');
    if (btnPause) {
        btnPause.disabled = true;
        btnPause.title = 'Pause non disponible pendant l\'enregistrement - utilisez Arrêter';
    }
    updateControlBar();
}

// Exposé pour remise à zéro depuis mapgl.js
export function resetControlsToInitialState(){
    try {
        dbgUi('[UI] resetControlsToInitialState()');
        // Boutons principaux
        showStartRecordButtons();
        // Réactiver le bouton Pause (peut avoir été désactivé en mode enregistrement)
        const btnPause = document.getElementById('btnPauseAnimation');
        if (btnPause) { btnPause.disabled = false; btnPause.title = ''; }
        // Barre latérale
        updateControlBar();
        // Bouton plein écran (garde l'état courant visuel)
        updateFullscreenButtonAppearance && updateFullscreenButtonAppearance();
    } catch (e) {
        console.warn('resetControlsToInitialState error:', e);
    }
}

// on clique sur le bouton Pause/Restart
// on change le texte du bouton et une class qui sert d'indicateur
// si réinitialisation = true, c'est que l'on veut remettre le bouton dans son état d'origine 
// sans lancer startAnimation. Utilisé quand on clique sur Start ou Annuler
function toggleButtonAnimationPauseAndRestart(reinitialisation = false){
    const btnPauseAnimation = document.getElementById('btnPauseAnimation');
    if (!btnPauseAnimation) return;
    const icon = btnPauseAnimation.querySelector('i');
    const label = btnPauseAnimation.querySelector('.animation-pause-label');
    const pauseText = btnPauseAnimation.dataset.pauseText || 'Pause';
    const continueText = btnPauseAnimation.dataset.continueText || 'Continuer';

    if (btnPauseAnimation.classList.contains('pause') && !reinitialisation) {
        btnPauseAnimation.classList.remove('pause');
        btnPauseAnimation.classList.add('restart');
        if (label) label.textContent = continueText;
        if (icon) {
            icon.classList.remove('ti-player-pause');
            icon.classList.add('ti-player-play');
        }
        pkg.pauseAnimation(); // pause douce : stoppe l'interval sans vider la carte
    } else if (btnPauseAnimation.classList.contains('restart') || reinitialisation) {
        btnPauseAnimation.classList.remove('restart');
        btnPauseAnimation.classList.add('pause');
        if (label) label.textContent = pauseText;
        if (icon) {
            icon.classList.remove('ti-player-play');
            icon.classList.add('ti-player-pause');
        }
        if (!reinitialisation) {
            pkg.startAnimation("restart");
        }
    }

    // Mettre à jour les contrôles
    updateControlBar();
}


// recupère tous les changements liés aux points
function changeAnimationValues(event){
    // mise à jour du temps de l'autre champs
    if (event.target.id == 'inputTimePerDay'){
        pkg.options.animation.timePerDay = inputTimePerDay.value;
        // Si l'utilisateur change la durée par jour manuellement, délocker la durée audio
        if (isDurationLockedToAudio) {
            isDurationLockedToAudio = false;
            updateDurationLockIndicator();
            dbgUi('Durée délockée - utilisateur a modifié la durée par jour');
        }
        updateTotalTime();
        // Mettre à jour l'indicateur de correspondance des durées
        updateDurationMatchIndicator();
    } else if (event.target.id == 'inputTotalTime'){
        // Si l'utilisateur change le temps total manuellement, délocker la durée audio
        if (isDurationLockedToAudio) {
            isDurationLockedToAudio = false;
            updateDurationLockIndicator();
            dbgUi('Durée délockée - utilisateur a modifié le temps total');
        }
        updateTimePerDay();
        // Mettre à jour l'indicateur de correspondance des durées
        updateDurationMatchIndicator();
    } else if (event.target.id == 'inputExtraEndTime'){
        const extraSeconds = Math.max(0, parseFloat(inputExtraEndTime.value) || 0);
        pkg.options.animation.extraEndSeconds = extraSeconds;
        if (isDurationLockedToAudio) {
            updateTimePerDay();
        } else {
            updateTotalTime();
        }
        updateDurationMatchIndicator();
    }

    // mise à jour du nombre de chiffre pour l'enregistrement des images
    pkg.updateInfosForPictures();
}

export function updateAnimationMenuAfterReadBdd(metadata){
    spanDeltaDays.innerText = metadata.deltaDays;
    updateTotalTime();
    // Mettre à jour l'indicateur de correspondance des durées
    updateDurationMatchIndicator();
}

function updateDeltaDaysAndTimes(){
    // Calculer le nouveau deltaDays basé sur les dates d'animation sélectionnées
    if (pkg.options.animation.dateStart && pkg.options.animation.dateEnd) {
        const deltaTime = pkg.options.animation.dateEnd.getTime() - pkg.options.animation.dateStart.getTime();
        const deltaDays = Math.ceil(deltaTime / (1000 * 60 * 60 * 24)) + 1; // +1 pour inclure le dernier jour

        // Mettre à jour le metadata et les options
        pkg.metadata.deltaDays = deltaDays;
        pkg.options.date.deltaDays = deltaDays;
        spanDeltaDays.innerText = deltaDays;

        // Si la durée est lockée à la musique, recalculer la durée par jour
        if (isDurationLockedToAudio) {
            updateTimePerDay();
        } else {
            // Recalculer les temps normalement (durée par jour constante)
            updateTotalTime();
            // Mettre à jour l'indicateur de correspondance des durées
            updateDurationMatchIndicator();
        }

        // Mettre à jour les informations pour les images
        pkg.updateInfosForPictures();
    }
}

function getExtraEndMs(){
    const extraSeconds = Number(pkg.options.animation.extraEndSeconds) || 0;
    return Math.max(0, extraSeconds) * 1000;
}

function getAutomaticEndHoldMs(){
    return automaticEndHoldMs({
        tailFreezeMs: pkg.options.record?.mediaRecorder?.tailFreezeMs,
        flashMode: pkg.options.flash?.mode,
        flashDurationMs: pkg.options.flash?.duration,
    });
}

function updateTotalTime(){
    const baseTimeMs = pkg.metadata.deltaDays * inputTimePerDay.value;
    const extraMs = getExtraEndMs();
    const automaticHoldMs = getAutomaticEndHoldMs();
    const totalTimeInMilliSec = baseTimeMs + extraMs + automaticHoldMs;
    dbgUi("totalTimeInMilliSec", totalTimeInMilliSec);
    // mise à jour du temps en ms pour futurs calculs
    pkg.options.record.totalTimeInMilliSec = totalTimeInMilliSec;

    // Ne pas modifier le temps total si la durée est lockée à la musique
    if (!isDurationLockedToAudio) {
        inputTotalTime.value = (totalTimeInMilliSec / 60 / 1000).toFixed(4);
    }
    updateTimeBreakdown(baseTimeMs, extraMs, automaticHoldMs, totalTimeInMilliSec);
    updateRecordingSizeEstimate();
}

function updateTimePerDay(){
    const totalTimeMs = inputTotalTime.value * 60 * 1000;
    const extraMs = getExtraEndMs();
    const automaticHoldMs = getAutomaticEndHoldMs();
    const fps = normalizeRecordingFps(pkg.options.record?.fps);
    const dayCount = Math.max(1, Number(pkg.metadata.deltaDays) || 1);
    const minimumBaseMs = dayCount * 1000 / fps;
    const baseTimeMs = Math.max(minimumBaseMs, totalTimeMs - extraMs - automaticHoldMs);
    const timePerDay = baseTimeMs / dayCount;
    pkg.options.animation.timePerDay = timePerDay;
    inputTimePerDay.value = Number(timePerDay.toFixed(3));
    // Mettre à jour le temps total en millisecondes pour les calculs futurs
    pkg.options.record.totalTimeInMilliSec = baseTimeMs + extraMs + automaticHoldMs;
    // Mettre à jour l'affichage des minutes/secondes et du détail
    updateTimeBreakdown(baseTimeMs, extraMs, automaticHoldMs, pkg.options.record.totalTimeInMilliSec);
    updateRecordingSizeEstimate();
}

function updateTimeBreakdown(baseMs, extraMs, automaticHoldMs, totalMs){
    const toMinSec = (ms) => {
        const minutesFraction = ms / 60000;
        const { minutes, seconds } = pkg.convertToMinutesAndSeconds(minutesFraction);
        return { minutes, seconds };
    };

    const total = toMinSec(totalMs);
    const base = toMinSec(baseMs);
    const extra = toMinSec(extraMs);
    const automaticHold = toMinSec(automaticHoldMs);

    spanTotalTimeMinutes.innerText = total.minutes;
    spanTotalTimeSeconds.innerText = total.seconds;
    const baseMinutesEl = document.getElementById('spanBaseTimeMinutes');
    const baseSecondsEl = document.getElementById('spanBaseTimeSeconds');
    const extraMinutesEl = document.getElementById('spanExtraTimeMinutes');
    const extraSecondsEl = document.getElementById('spanExtraTimeSeconds');
    const automaticHoldMinutesEl = document.getElementById('spanAutomaticHoldMinutes');
    const automaticHoldSecondsEl = document.getElementById('spanAutomaticHoldSeconds');
    if (baseMinutesEl) baseMinutesEl.innerText = base.minutes;
    if (baseSecondsEl) baseSecondsEl.innerText = base.seconds;
    if (extraMinutesEl) extraMinutesEl.innerText = extra.minutes;
    if (extraSecondsEl) extraSecondsEl.innerText = extra.seconds;
    if (automaticHoldMinutesEl) automaticHoldMinutesEl.innerText = automaticHold.minutes;
    if (automaticHoldSecondsEl) automaticHoldSecondsEl.innerText = automaticHold.seconds;
}


function clear_pictures_directory(){
// TMP : Pour l'instant on vider le repertoire via un bouton. Devra par la suite être automatique après assemblage.
    fetch('/clear_pictures_directory', {
        method: 'POST', 
        headers: {
            'X-CSRFToken': pkg.getCookie('csrftoken'), 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'vider_repertoire' }),
    })
    .then(response => response.json())
    .then(data => {
        dbgUi(data); // Traiter la réponse de Django
        if(data.success) {
            // Mettre à jour l'interface utilisateur en conséquence
            dbgUi(data)
        }
    })
    .catch(error => console.error('Erreur:', error));
}

function open_video_folder(){
    fetch('/open_video_folder', {
        method: 'POST',
        headers: {
            'X-CSRFToken': pkg.getCookie('csrftoken'),
            'Content-Type': 'application/json',
        }
    })
    .then(response => response.json())
    .then(data => {
        dbgUi(data);
        if (data?.success && data.folder) {
            pkg.showToast && pkg.showToast(pkg.t('Dossier vidéo: ${folder}', { folder: data.folder }), 'info', 'Ouverture');
        } else {
            pkg.showToast && pkg.showToast(data?.message || 'Impossible d’ouvrir le dossier vidéo', 'error', 'Ouverture');
        }
    })
    .catch(error => {
        console.error('Erreur:', error);
        pkg.showToast && pkg.showToast('Erreur lors de l’ouverture du dossier vidéo', 'error', 'Ouverture');
    });
}

// Poll d'une tâche de fond serveur (/tasks/<id>) jusqu'à sa fin.
function pollAssembleTask(taskId, { intervalMs = 700, timeoutMs = 1800000, onProgress } = {}){
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
            if (!taskId) { reject(new Error('task_id manquant')); return; }
            if (Date.now() - startedAt > timeoutMs) { reject(new Error('Délai d\'assemblage dépassé')); return; }
            fetch(`/tasks/${encodeURIComponent(taskId)}?include_result=true`, { method: 'GET' })
                .then(r => r.json())
                .then(status => {
                    if (typeof onProgress === 'function' && typeof status?.progress === 'number') onProgress(status.progress, status.message);
                    if (status?.state === 'finished') { resolve(status?.result || {}); return; }
                    if (status?.state === 'failed') { reject(new Error(status?.error || status?.message || 'Tâche échouée')); return; }
                    setTimeout(tick, intervalMs);
                })
                .catch(reject);
        };
        tick();
    });
}

function assemble_pictures_directory(){
    // FPS configurable : doit correspondre à celui utilisé pour calculer les frames,
    // sinon la vitesse de lecture de la vidéo assemblée est faussée.
    const fps = normalizeRecordingFps(pkg.options?.record?.fps);
    const tr = (s) => (pkg.t ? pkg.t(s) : s);
    const assembleToast = pkg.showLoadingToast ? pkg.showLoadingToast(tr("Assemblage de la vidéo en cours..."), tr("Assemblage")) : null;
    fetch('/assemble_pictures_directory', {
        method: 'POST', 
        headers: {
            'X-CSRFToken': pkg.getCookie('csrftoken'), 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'assembler', fps: fps }),
    })
    .then(response => response.json())
    .then(data => {
        // Assemblage en tâche de fond : on suit la progression via /tasks/<id>
        if (!data || !data.task_id) {
            throw new Error(data && data.message ? data.message : "Impossible de lancer l'assemblage");
        }
        return pollAssembleTask(data.task_id, {
            onProgress: (p) => { try { if (assembleToast) pkg.updateToastProgress(assembleToast, p); } catch(_) {} }
        });
    })
    .then(() => {
        try { if (assembleToast) pkg.hideToast(assembleToast); } catch(_) {}
        pkg.showToast && pkg.showToast(tr("Vidéo créée avec succès !"), "success", tr("Vidéo prête"));
    })
    .catch(error => {
        console.error('Erreur:', error);
        try { if (assembleToast) pkg.hideToast(assembleToast); } catch(_) {}
        pkg.showToast && pkg.showToast(tr("Erreur lors de l'assemblage de la vidéo"), "error", tr("Erreur"));
    });
}



// ----------------- FLASH ----------------
// recupère tous les changements liés aux flashs
function changeFlashValues(event){

    // select pour le mode de flash
    if (event.id === "selectFlashMode") {
        pkg.options.flash.mode = event.value;
    }
    // inputs avec validation légère (pendant la saisie)
    if (inputTimeFlash) {
        let duration = parseInt(inputTimeFlash.value);
        // Ne valide que si c'est un nombre valide
        if (!isNaN(duration)) {
            pkg.options.flash.duration = duration;
        }
    }
    if (inputSizeFlash) {
        let size = parseInt(inputSizeFlash.value);
        // Ne valide que si c'est un nombre valide
        if (!isNaN(size)) {
            pkg.options.flash.size = size;
        }
    }
    // colorpickers
    if (cpFlashColor) pkg.options.flash.color = cpFlashColor.value;

    // Un flash plus long que le gel final étend automatiquement la fin de vidéo.
    // Répercuter immédiatement ce changement dans le total affiché.
    if (isDurationLockedToAudio) updateTimePerDay();
    else updateTotalTime();
    pkg.updateInfosForPictures();
}

// Gestion du type de couleur du flash (GC, fix, none)
function changeFlashColorType(event) {
    // Mettre à jour le mode de couleur dans les options
    pkg.options.flash.color_type = event.value;

    // Gestion de l'affichage du color picker
    const flashColorPickerContainer = document.querySelector('#flashColor').closest('.input-field');

    if (event.value === 'fix') {
        // Afficher le color picker pour couleur fixe
        if (flashColorPickerContainer) {
            flashColorPickerContainer.style.display = 'block';
        }
    } else {
        // Masquer le color picker pour GC ou transparent
        if (flashColorPickerContainer) {
            flashColorPickerContainer.style.display = 'none';
        }
    }
}

// Fonction de validation à la perte de focus pour la durée du flash
function validateTimeFlash() {
    if (inputTimeFlash) {
        let duration = parseInt(inputTimeFlash.value);
        // Validation de la durée (100ms à 10000ms) seulement à la perte de focus
        if (isNaN(duration) || duration < 100) {
            duration = 100;
            inputTimeFlash.value = duration;
        } else if (duration > 10000) {
            duration = 10000;
            inputTimeFlash.value = duration;
        }
        pkg.options.flash.duration = duration;
    }
}

// Fonction de validation à la perte de focus pour la taille du flash
function validateSizeFlash() {
    if (inputSizeFlash) {
        let size = parseInt(inputSizeFlash.value);
        // Validation de la taille (5px à 200px) seulement à la perte de focus
        if (isNaN(size) || size < 5) {
            size = 5;
            inputSizeFlash.value = size;
        } else if (size > 200) {
            size = 200;
            inputSizeFlash.value = size;
        }
        pkg.options.flash.size = size;
    }
}


// -------------------- INFOS AFFICHéEs -------------------
function changeInfosValues(event){

    pkg.options.infos.title.display = cbDisplayTitle.checked;
    pkg.options.infos.currentDate.display = cbDisplayCurrentDate.checked;
    pkg.options.infos.numberOfCaches.display = cbDisplayNumberofCaches.checked;

    if (event?.target?.id === "inputTitle") {
        const title = String(event.target.value || '').slice(0, 500);
        pkg.options.infos.title.text = title;
        pkg.updateTitleFrame(title);
    }
    updateOverlayElementsVisibility();
    dbgUi(event?.target);
}

// Fonction pour synchroniser la visibilité des éléments DOM avec les paramètres utilisateur
function updateOverlayElementsVisibility() {
    try {
        pkg.syncOverlayVisibility();

        dbgUi('[OVERLAY] Visibilité mise à jour:', {
            title: pkg.options.infos?.title?.display,
            date: pkg.options.infos?.currentDate?.display,
            caches: pkg.options.infos?.numberOfCaches?.display,
            titleFrame: document.getElementById('titleFrame')?.style.display,
            infosFrame: document.getElementById('infosFrame')?.style.display
        });
    } catch(e) {
        console.warn('Erreur updateOverlayElementsVisibility:', e);
    }
}

function extractCssDeclarationsFromFile(cssContent) {
    if (!cssContent || typeof cssContent !== 'string') return '';
    const match = cssContent.match(/\{([\s\S]*?)\}/);
    return (match?.[1] || cssContent).replace(/^\s*/gm, '').trim();
}

function beginOverlayCssDefaultsLoad() {
    if (overlayCssDefaultsStarted) return overlayCssDefaultsReady;
    overlayCssDefaultsStarted = true;
    const editors = [inputTitleCss, inputInfosCss].filter(Boolean);
    overlayCssDefaultsReady = Promise.all(editors.map(async (textarea) => {
        const url = textarea.dataset.cssUrl;
        if (!url || textarea.value.trim()) return;
        try {
            const response = await fetch(new URL(url, window.location.href));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const cssText = await response.text();
            // Ne jamais écraser une valeur posée entre-temps par l'utilisateur.
            if (!textarea.value.trim()) {
                textarea.value = extractCssDeclarationsFromFile(cssText);
            }
        } catch (error) {
            console.warn(`Chargement du CSS Overlay par défaut impossible (${url}):`, error);
        }
    })).then(() => {
        try { window.gcCssAssistantSyncFromTextareas?.(); } catch(_) {}
    });
    return overlayCssDefaultsReady;
}

export function waitForOverlayCssDefaults() {
    return beginOverlayCssDefaultsLoad();
}

function initCssAssistant() {
    const root = document.getElementById('gcCssAssistant');
    if (!root) return;

    const btnTargetTitle = document.getElementById('gcCssTargetTitle');
    const btnTargetInfos = document.getElementById('gcCssTargetInfos');
    const btnCopyToOther = document.getElementById('gcCssCopyToOther');
    const badgeUnmanaged = document.getElementById('gcCssUnmanagedBadge');
    const cbAdvanced = document.getElementById('gcCssAdvancedMode');
    const advancedPanel = document.getElementById('gcCssAdvancedPanel');
    const rawEditor = document.getElementById('gcCssRawEditor');
    const btnApply = document.getElementById('gcCssApply');
    const tabLinks = root.querySelectorAll('.gc-css-tab');

    const infosPanelTitle = document.getElementById('gcInfosPanelTitle');
    const infosPanelInfos = document.getElementById('gcInfosPanelInfos');

    if (!btnTargetTitle || !btnTargetInfos || !btnCopyToOther || !badgeUnmanaged || !cbAdvanced || !advancedPanel || !rawEditor || !btnApply) return;

    const fields = {
        textColor: document.getElementById('gcCssTextColor'),
        fontSize: document.getElementById('gcCssFontSize'),
        fontFamily: document.getElementById('gcCssFontFamily'),
        fontWeight: document.getElementById('gcCssFontWeight'),
        textAlign: document.getElementById('gcCssTextAlign'),
        backgroundColor: document.getElementById('gcCssBackgroundColor'),
        padding: document.getElementById('gcCssPadding'),
        borderRadius: document.getElementById('gcCssBorderRadius'),
        borderWidth: document.getElementById('gcCssBorderWidth'),
        borderStyle: document.getElementById('gcCssBorderStyle'),
        borderColor: document.getElementById('gcCssBorderColor'),
        boxShadowEnable: document.getElementById('gcCssBoxShadowEnable'),
        shadowX: document.getElementById('gcCssShadowX'),
        shadowY: document.getElementById('gcCssShadowY'),
        shadowBlur: document.getElementById('gcCssShadowBlur'),
        shadowSpread: document.getElementById('gcCssShadowSpread'),
        shadowColor: document.getElementById('gcCssShadowColor'),
        position: document.getElementById('gcCssPosition'),
        zIndex: document.getElementById('gcCssZIndex'),
        top: document.getElementById('gcCssTop'),
        right: document.getElementById('gcCssRight'),
        bottom: document.getElementById('gcCssBottom'),
        left: document.getElementById('gcCssLeft'),
        opacity: document.getElementById('gcCssOpacity'),
    };

    // Initialiser Tom Select sur les selects du panneau d'informations
    ['fontFamily', 'fontWeight', 'textAlign', 'borderStyle', 'position'].forEach(key => {
        if (fields[key] && fields[key].tagName === 'SELECT') {
            initTomSelect(fields[key], {});
        }
    });

    // Valeurs par défaut pour éviter le fond noir au démarrage
    if (fields.backgroundColor && !fields.backgroundColor.value) {
        fields.backgroundColor.value = '#ffffff';
    }
    if (fields.textColor && !fields.textColor.value) {
        fields.textColor.value = '#000000';
    }

    let activeTarget = 'title';

    const managedProps = new Set([
        'color',
        'font-size',
        'font-family',
        'font-weight',
        'text-align',
        'background-color',
        'padding',
        'border-radius',
        'border',
        'border-width',
        'border-style',
        'border-color',
        'box-shadow',
        'position',
        'z-index',
        'top',
        'right',
        'bottom',
        'left',
        'opacity',
    ]);

    function normalizeColorToHex(value) {
        if (!value || typeof value !== 'string') return '';
        const v = value.trim();
        if (/^#([0-9a-f]{3})$/i.test(v)) {
            const m = v.substring(1);
            return `#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`.toLowerCase();
        }
        if (/^#([0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
        const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
        if (rgb) {
            const r = Math.max(0, Math.min(255, parseInt(rgb[1], 10)));
            const g = Math.max(0, Math.min(255, parseInt(rgb[2], 10)));
            const b = Math.max(0, Math.min(255, parseInt(rgb[3], 10)));
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }
        return '';
    }

    function parseDeclarations(css) {
        const out = {};
        const unmanaged = [];
        if (!css || typeof css !== 'string') return { declarations: out, unmanaged };
        const parts = css.split(';');
        for (const p of parts) {
            const part = p.trim();
            if (!part) continue;
            const idx = part.indexOf(':');
            if (idx === -1) continue;
            const prop = part.substring(0, idx).trim().toLowerCase();
            const value = part.substring(idx + 1).trim();
            out[prop] = value;
            if (!managedProps.has(prop)) unmanaged.push(prop);
        }
        return { declarations: out, unmanaged };
    }

    function ensureSelectRefresh(selectEl) {
        if (!selectEl) return;
        refreshTomSelect(selectEl);
    }

    function setBadgeCount(count) {
        if (!badgeUnmanaged) return;
        // Cette icône est une aide permanente, pas un voyant d'état du profil.
        // Le comptage reste disponible pour le diagnostic interne du formulaire,
        // mais ne doit jamais afficher ou masquer le point d'interrogation.
        void count;
        badgeUnmanaged.textContent = '?';
        badgeUnmanaged.style.display = 'inline-flex';
    }

    function getTextareaForTarget(t) {
        if (t === 'infos') return inputInfosCss;
        return inputTitleCss;
    }

    function applyCssToTarget(t, css) {
        const textarea = getTextareaForTarget(t);
        let appliedCss = css;
        if (t === 'infos') {
            if (typeof pkg.changeInfosCssValues === 'function') appliedCss = pkg.changeInfosCssValues(css) ?? css;
        } else {
            if (typeof pkg.changeTitleCssValues === 'function') appliedCss = pkg.changeTitleCssValues(css) ?? css;
        }
        if (textarea) textarea.value = appliedCss;
        return appliedCss;
    }

    function syncFormFromCss(target) {
        const textarea = getTextareaForTarget(target);
        const css = textarea ? (textarea.value || '') : '';
        rawEditor.value = css;

        const { declarations, unmanaged } = parseDeclarations(css);
        const unmanagedExtra = [];

        if (fields.textColor) {
            const v = normalizeColorToHex(declarations['color']);
            if (v) fields.textColor.value = v;
            else if (declarations['color']) unmanagedExtra.push('color');
        }
        if (fields.fontSize) {
            const m = (declarations['font-size'] || '').match(/(-?\d+(?:\.\d+)?)px/i);
            if (m) fields.fontSize.value = m[1];
            else if (declarations['font-size']) unmanagedExtra.push('font-size');
        }
        if (fields.fontFamily) {
            fields.fontFamily.value = declarations['font-family'] || '';
            ensureSelectRefresh(fields.fontFamily);
        }
        if (fields.fontWeight) {
            fields.fontWeight.value = declarations['font-weight'] || '';
            ensureSelectRefresh(fields.fontWeight);
        }
        if (fields.textAlign) {
            fields.textAlign.value = declarations['text-align'] || '';
            ensureSelectRefresh(fields.textAlign);
        }
        if (fields.backgroundColor) {
            const v = normalizeColorToHex(declarations['background-color']);
            if (v) fields.backgroundColor.value = v;
            else if (declarations['background-color']) unmanagedExtra.push('background-color');
            else fields.backgroundColor.value = '#ffffff';
        }
        if (fields.padding) {
            const m = (declarations['padding'] || '').match(/(\d+(?:\.\d+)?)px/i);
            if (m) fields.padding.value = m[1];
            else if (declarations['padding']) unmanagedExtra.push('padding');
        }
        if (fields.borderRadius) {
            const m = (declarations['border-radius'] || '').match(/(\d+(?:\.\d+)?)px/i);
            if (m) fields.borderRadius.value = m[1];
            else if (declarations['border-radius']) unmanagedExtra.push('border-radius');
        }

        let borderWidth = declarations['border-width'] || '';
        let borderStyle = declarations['border-style'] || '';
        let borderColor = declarations['border-color'] || '';
        const border = declarations['border'] || '';
        if (border && (!borderWidth || !borderStyle || !borderColor)) {
            const bm = border.match(/\b(-?\d+(?:\.\d+)?)px\b\s+(solid|dashed|dotted|none)\b\s+(.+)$/i);
            if (bm) {
                if (!borderWidth) borderWidth = `${bm[1]}px`;
                if (!borderStyle) borderStyle = bm[2].toLowerCase();
                if (!borderColor) borderColor = bm[3].trim();
            }
        }

        if (fields.borderWidth) {
            const m = (borderWidth || '').match(/(\d+(?:\.\d+)?)px/i);
            if (m) fields.borderWidth.value = m[1];
            else if (borderWidth) unmanagedExtra.push('border-width');
        }
        if (fields.borderStyle) {
            fields.borderStyle.value = borderStyle || '';
            ensureSelectRefresh(fields.borderStyle);
        }
        if (fields.borderColor) {
            const v = normalizeColorToHex(borderColor);
            if (v) fields.borderColor.value = v;
            else if (borderColor) unmanagedExtra.push('border-color');
        }

        if (fields.boxShadowEnable) {
            const bs = declarations['box-shadow'] || '';
            if (bs && bs !== 'none') {
                fields.boxShadowEnable.checked = true;
                const sm = bs.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(.+)$/i);
                if (sm) {
                    if (fields.shadowX) fields.shadowX.value = sm[1];
                    if (fields.shadowY) fields.shadowY.value = sm[2];
                    if (fields.shadowBlur) fields.shadowBlur.value = sm[3];
                    if (fields.shadowSpread) fields.shadowSpread.value = sm[4];
                    if (fields.shadowColor) {
                        const c = normalizeColorToHex(sm[5]);
                        if (c) fields.shadowColor.value = c;
                        else unmanagedExtra.push('box-shadow');
                    }
                } else {
                    unmanagedExtra.push('box-shadow');
                }
            } else {
                fields.boxShadowEnable.checked = false;
            }
        }

        if (fields.position) {
            fields.position.value = declarations['position'] || '';
            ensureSelectRefresh(fields.position);
        }
        if (fields.zIndex) fields.zIndex.value = declarations['z-index'] || '';

        const setPxNum = (el, prop) => {
            if (!el) return;
            const m = (declarations[prop] || '').match(/(-?\d+(?:\.\d+)?)px/i);
            if (m) el.value = m[1];
            else if (declarations[prop]) unmanagedExtra.push(prop);
        };
        setPxNum(fields.top, 'top');
        setPxNum(fields.right, 'right');
        setPxNum(fields.bottom, 'bottom');
        setPxNum(fields.left, 'left');

        if (fields.opacity) {
            const op = declarations['opacity'];
            if (op !== undefined && op !== '') {
                const n = parseFloat(op);
                if (!Number.isNaN(n)) fields.opacity.value = n;
                else unmanagedExtra.push('opacity');
            }
        }

        try { /* M.updateTextFields() — removed (Bootstrap 5 handles labels) */ } catch(_) {}
        setBadgeCount(new Set(unmanaged.concat(unmanagedExtra)).size);
    }

    function buildCssFromForm() {
        const lines = [];

        const push = (prop, val) => {
            if (val === undefined || val === null) return;
            const v = `${val}`.trim();
            if (!v) return;
            lines.push(`${prop}: ${v};`);
        };

        if (fields.textColor && fields.textColor.value) push('color', fields.textColor.value);
        if (fields.fontSize && fields.fontSize.value !== '') push('font-size', `${fields.fontSize.value}px`);
        if (fields.fontFamily && fields.fontFamily.value) push('font-family', fields.fontFamily.value);
        if (fields.fontWeight && fields.fontWeight.value) push('font-weight', fields.fontWeight.value);
        if (fields.textAlign && fields.textAlign.value) push('text-align', fields.textAlign.value);

        if (fields.backgroundColor && fields.backgroundColor.value) push('background-color', fields.backgroundColor.value);
        if (fields.padding && fields.padding.value !== '') push('padding', `${fields.padding.value}px`);
        if (fields.borderRadius && fields.borderRadius.value !== '') push('border-radius', `${fields.borderRadius.value}px`);

        const bw = fields.borderWidth && fields.borderWidth.value !== '' ? `${fields.borderWidth.value}px` : '';
        const bs = fields.borderStyle && fields.borderStyle.value ? fields.borderStyle.value : '';
        const bc = fields.borderColor && fields.borderColor.value ? fields.borderColor.value : '';
        if (bw || bs || bc) {
            const style = bs || 'solid';
            const width = bw || '1px';
            const color = bc || '#000000';
            push('border', `${width} ${style} ${color}`);
        }

        if (fields.boxShadowEnable && fields.boxShadowEnable.checked) {
            const x = fields.shadowX && fields.shadowX.value !== '' ? fields.shadowX.value : '0';
            const y = fields.shadowY && fields.shadowY.value !== '' ? fields.shadowY.value : '0';
            const blur = fields.shadowBlur && fields.shadowBlur.value !== '' ? fields.shadowBlur.value : '0';
            const spread = fields.shadowSpread && fields.shadowSpread.value !== '' ? fields.shadowSpread.value : '0';
            const color = fields.shadowColor && fields.shadowColor.value ? fields.shadowColor.value : '#000000';
            push('box-shadow', `${x}px ${y}px ${blur}px ${spread}px ${color}`);
        }

        if (fields.position && fields.position.value) push('position', fields.position.value);
        if (fields.zIndex && fields.zIndex.value !== '') push('z-index', fields.zIndex.value);
        const pushPx = (prop, el) => {
            if (!el) return;
            if (el.value === '' || el.value === null || el.value === undefined) return;
            push(prop, `${el.value}px`);
        };
        pushPx('top', fields.top);
        pushPx('right', fields.right);
        pushPx('bottom', fields.bottom);
        pushPx('left', fields.left);
        if (fields.opacity && fields.opacity.value !== '') push('opacity', fields.opacity.value);

        return lines.join('\n');
    }

    // Modifie uniquement la propriété associée au champ touché. Cette approche
    // conserve les déclarations avancées (gradient, letter-spacing, border-left,
    // etc.) au lieu de reconstruire et d'écraser toute la feuille.
    function patchCssFromField(changedField) {
        const textarea = getTextareaForTarget(activeTarget);
        const probe = document.createElement('div');
        probe.style.cssText = textarea ? (textarea.value || '') : '';
        const set = (prop, value) => {
            const normalized = value == null ? '' : String(value).trim();
            if (normalized) probe.style.setProperty(prop, normalized);
            else probe.style.removeProperty(prop);
        };
        const px = (field) => field?.value === '' ? '' : `${field.value}px`;

        switch (changedField) {
            case fields.textColor: set('color', fields.textColor.value); break;
            case fields.fontSize: set('font-size', px(fields.fontSize)); break;
            case fields.fontFamily: set('font-family', fields.fontFamily.value); break;
            case fields.fontWeight: set('font-weight', fields.fontWeight.value); break;
            case fields.textAlign: set('text-align', fields.textAlign.value); break;
            case fields.backgroundColor: set('background-color', fields.backgroundColor.value); break;
            case fields.padding: set('padding', px(fields.padding)); break;
            case fields.borderRadius: set('border-radius', px(fields.borderRadius)); break;
            case fields.borderWidth:
            case fields.borderStyle:
            case fields.borderColor: {
                const width = fields.borderWidth?.value !== '' ? `${fields.borderWidth.value}px` : '1px';
                const style = fields.borderStyle?.value || 'solid';
                const color = fields.borderColor?.value || '#000000';
                set('border', `${width} ${style} ${color}`);
                break;
            }
            case fields.boxShadowEnable:
            case fields.shadowX:
            case fields.shadowY:
            case fields.shadowBlur:
            case fields.shadowSpread:
            case fields.shadowColor:
                if (!fields.boxShadowEnable?.checked) {
                    set('box-shadow', 'none');
                } else {
                    set('box-shadow', `${fields.shadowX?.value || 0}px ${fields.shadowY?.value || 0}px ${fields.shadowBlur?.value || 0}px ${fields.shadowSpread?.value || 0}px ${fields.shadowColor?.value || '#000000'}`);
                }
                break;
            case fields.position: set('position', fields.position.value); break;
            case fields.zIndex: set('z-index', fields.zIndex.value); break;
            case fields.top: set('top', px(fields.top)); break;
            case fields.right: set('right', px(fields.right)); break;
            case fields.bottom: set('bottom', px(fields.bottom)); break;
            case fields.left: set('left', px(fields.left)); break;
            case fields.opacity: set('opacity', fields.opacity.value); break;
            default: return textarea ? (textarea.value || '') : '';
        }
        return probe.style.cssText;
    }

    function refreshTargetButtons() {
        const titleActive = activeTarget === 'title';
        btnTargetTitle.classList.toggle('active', titleActive);
        btnTargetTitle.setAttribute('aria-selected', titleActive ? 'true' : 'false');
        btnTargetTitle.tabIndex = titleActive ? 0 : -1;
        btnTargetInfos.classList.toggle('active', !titleActive);
        btnTargetInfos.setAttribute('aria-selected', titleActive ? 'false' : 'true');
        btnTargetInfos.tabIndex = titleActive ? -1 : 0;
    }

    function refreshInfosPanels() {
        if (infosPanelTitle) infosPanelTitle.hidden = activeTarget !== 'title';
        if (infosPanelInfos) infosPanelInfos.hidden = activeTarget !== 'infos';
    }

    function updateAdvancedVisibility() {
        const on = !!cbAdvanced.checked;
        advancedPanel.style.display = on ? 'block' : 'none';
        // Masquer les onglets et panes du formulaire quand le mode CSS avancé est actif
        const tabsBar = root.querySelector('.gc-css-tabs');
        if (tabsBar) tabsBar.style.display = on ? 'none' : '';
        root.querySelectorAll('.gc-css-pane').forEach(p => {
            p.style.display = on ? 'none' : '';
        });
    }

    function applyCurrentCss() {
        const textarea = getTextareaForTarget(activeTarget);
        const css = cbAdvanced.checked
            ? (rawEditor.value || '')
            : ((textarea?.value || '').trim() ? textarea.value : buildCssFromForm());
        const appliedCss = applyCssToTarget(activeTarget, css);
        rawEditor.value = appliedCss;
        syncFormFromCss(activeTarget);
    }

    function switchTarget(t) {
        if (t !== 'title' && t !== 'infos') return;
        activeTarget = t;
        refreshTargetButtons();
        refreshInfosPanels();
        syncFormFromCss(activeTarget);
    }

    tabLinks.forEach(a => {
        a.addEventListener('click', () => {
            const paneId = a.getAttribute('data-pane');
            if (!paneId) return;
            tabLinks.forEach(x => x.classList.remove('active'));
            a.classList.add('active');
            root.querySelectorAll('.gc-css-pane').forEach(p => p.classList.remove('active'));
            const pane = document.getElementById(paneId);
            if (pane) pane.classList.add('active');
        });
    });

    btnTargetTitle.addEventListener('click', () => switchTarget('title'));
    btnTargetInfos.addEventListener('click', () => switchTarget('infos'));
    [btnTargetTitle, btnTargetInfos].forEach((tab, index, tabs) => {
        tab.addEventListener('keydown', (event) => {
            let nextIndex = null;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            tabs[nextIndex].focus();
            tabs[nextIndex].click();
        });
    });
    btnCopyToOther.addEventListener('click', () => {
        const from = activeTarget;
        const to = from === 'title' ? 'infos' : 'title';
        const sourceTextarea = getTextareaForTarget(from);
        const css = cbAdvanced.checked ? (rawEditor.value || '') : (sourceTextarea?.value || '');
        applyCssToTarget(to, css);
        if (to === activeTarget) syncFormFromCss(activeTarget);
    });

    cbAdvanced.addEventListener('change', () => {
        updateAdvancedVisibility();
        const t = getTextareaForTarget(activeTarget);
        rawEditor.value = t ? (t.value || '') : '';
    });

    btnApply.addEventListener('click', () => {
        applyCurrentCss();
    });

    const onFieldChange = (event) => {
        const css = patchCssFromField(event.currentTarget);
        const appliedCss = applyCssToTarget(activeTarget, css);
        rawEditor.value = appliedCss;
        syncFormFromCss(activeTarget);
    };

    Object.values(fields).forEach(el => {
        if (!el) return;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'select') {
            el.addEventListener('change', onFieldChange);
        } else {
            // Certains color pickers déclenchent seulement l'événement change selon le navigateur
            el.addEventListener('input', onFieldChange);
            el.addEventListener('change', onFieldChange);
        }
    });

    let rawPreviewRaf = null;
    rawEditor.addEventListener('input', () => {
        if (!cbAdvanced.checked) return;
        if (rawPreviewRaf !== null) cancelAnimationFrame(rawPreviewRaf);
        rawPreviewRaf = requestAnimationFrame(() => {
            rawPreviewRaf = null;
            applyCssToTarget(activeTarget, rawEditor.value || '');
        });
    });
    rawEditor.addEventListener('change', () => {
        if (!cbAdvanced.checked) return;
        applyCssToTarget(activeTarget, rawEditor.value || '');
        syncFormFromCss(activeTarget);
    });

    window.gcCssAssistantSyncFromTextareas = function() {
        syncFormFromCss(activeTarget);
    };

    // Le profil par défaut est appliqué de façon asynchrone après
    // l'initialisation de ce panneau. Recalculer une dernière fois l'état
    // sur le CSS effectivement actif lorsque toute l'application est prête.
    const syncWhenAppIsReady = () => syncFormFromCss(activeTarget);
    if (window.gcmapReady) {
        syncWhenAppIsReady();
    } else {
        window.addEventListener('gcmap:ready', syncWhenAppIsReady, { once: true });
    }

    // Forcer la sélection initiale sur Titre
    switchTarget('title');
    updateAdvancedVisibility();
    syncFormFromCss(activeTarget);
}

// Gestion du mode plein écran
function toggleFullscreenMode() {
    const btnFullscreenMode = document.getElementById('btnFullscreenMode');
    const mainElement = document.querySelector('main');
    const controlBar = document.getElementById('controlBar');
    const mapElement = document.getElementById('map');

    // Basculer l'état
    fullscreenButtonActive = !fullscreenButtonActive;

    if (fullscreenButtonActive) {
        // Activer le mode plein écran
        mainElement.classList.add('fullscreen-mode');
        controlBar.style.display = 'flex';

        // Forcer l'état initial des boutons de la barre latérale selon l'état actuel
        const btnStartAnimation = document.getElementById('btnStartAnimation');
        const isIdle = btnStartAnimation && window.getComputedStyle(btnStartAnimation).display !== 'none';

        if (isIdle) {
            // État repos : afficher Start/Record, masquer Pause/Stop
            const btnStartBar = document.getElementById('btnStartBar');
            const btnRecordBar = document.getElementById('btnRecordBar');
            const btnPauseBar = document.getElementById('btnPauseBar');
            const btnStopBar = document.getElementById('btnStopBar');

            if (btnStartBar) btnStartBar.style.setProperty('display', 'flex', 'important');
            if (btnRecordBar) btnRecordBar.style.setProperty('display', 'flex', 'important');
            if (btnPauseBar) btnPauseBar.style.setProperty('display', 'none', 'important');
            if (btnStopBar) btnStopBar.style.setProperty('display', 'none', 'important');
        }

        // Redimensionner la carte pour prendre tout l'espace sans bande résiduelle
        mapElement.style.height = '100%';
        mapElement.style.width = '100%';

        // Forcer le redimensionnement d'OpenLayers
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 100);

    } else {
        // Désactiver le mode plein écran
        exitFullscreenMode();
    }

    // Mettre à jour l'apparence du bouton
    updateFullscreenButtonAppearance();

    // Mettre à jour la barre latérale
    updateControlBar();
}

function exitFullscreenMode() {
    const mainElement = document.querySelector('main');
    const controlBar = document.getElementById('controlBar');
    const mapElement = document.getElementById('map');

    // Désactiver le mode plein écran
    mainElement.classList.remove('fullscreen-mode');
    controlBar.style.display = 'none';

    // Restaurer la taille normale de la carte (gérée par le split-pane)
    mapElement.style.height = '100%';
    mapElement.style.width = '100%';

    // Forcer le redimensionnement d'OpenLayers
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 100);
}

// Mettre à jour l'apparence du bouton fullscreen
function updateFullscreenButtonAppearance() {
    const btnFullscreenMode = document.getElementById('btnFullscreenMode');
    if (!btnFullscreenMode) return;

    const icon = btnFullscreenMode.querySelector('i');
    const label = btnFullscreenMode.querySelector('.fullscreen-label');
    const enterText = label?.dataset.enterText || 'Plein écran';
    const exitText = label?.dataset.exitText || 'Quitter le plein écran';
    if (fullscreenButtonActive) {
        // Mode plein écran actif
        btnFullscreenMode.classList.remove('btn-secondary');
        btnFullscreenMode.classList.add('btn-primary');
        if (icon) {
            icon.classList.remove('ti-maximize');
            icon.classList.add('ti-minimize');
        }
        if (label) label.textContent = exitText;
        btnFullscreenMode.title = exitText;
    } else {
        // Mode normal
        btnFullscreenMode.classList.remove('btn-primary');
        btnFullscreenMode.classList.add('btn-secondary');
        if (icon) {
            icon.classList.remove('ti-minimize');
            icon.classList.add('ti-maximize');
        }
        if (label) label.textContent = enterText;
        btnFullscreenMode.title = enterText;
    }
}

function updateControlBar() {
    dbgUi("=== updateControlBar ===");
    const controlBar = document.getElementById('controlBar');
    const btnStartBar = document.getElementById('btnStartBar');
    const btnRecordBar = document.getElementById('btnRecordBar');
    const btnPauseBar = document.getElementById('btnPauseBar');
    const btnStopBar = document.getElementById('btnStopBar');
    const btnToggleFullscreen = document.getElementById('btnToggleFullscreen');
    const btnStartAnimation = document.getElementById('btnStartAnimation');
    const btnPauseAnimation = document.getElementById('btnPauseAnimation');
    const btnStopAnimation = document.getElementById('btnStopAnimation');

    dbgUi("Boutons trouvés:", {
        controlBar: !!controlBar,
        btnStartBar: !!btnStartBar,
        btnRecordBar: !!btnRecordBar,
        btnPauseBar: !!btnPauseBar,
        btnStopBar: !!btnStopBar,
        btnToggleFullscreen: !!btnToggleFullscreen,
        btnStartAnimation: !!btnStartAnimation
    });

    if (!controlBar) {
        dbgUi("❌ controlBar non trouvé");
        return;
    }

    // Déterminer l'état courant : vérifier si Start est visible (état repos)
    let isIdle = false;
    if (btnStartAnimation && window.getComputedStyle(btnStartAnimation).display !== 'none') {
        isIdle = true;
    }

    dbgUi("État détecté:", {
        isIdle: isIdle,
        btnStartAnimation_display: btnStartAnimation ? window.getComputedStyle(btnStartAnimation).display : 'null',
        btnPauseAnimation_display: btnPauseAnimation ? window.getComputedStyle(btnPauseAnimation).display : 'null',
        btnStopAnimation_display: btnStopAnimation ? window.getComputedStyle(btnStopAnimation).display : 'null'
    });

    // Gestion des boutons selon l'état
    dbgUi("Configuration des boutons de la barre latérale:");
    if (isIdle) {
        dbgUi("  Mode IDLE: afficher Start/Record, masquer Pause/Stop");
        // État repos -> afficher Start/Record, masquer Pause/Stop
        if (btnStartBar) {
            dbgUi("    btnStartBar avant:", window.getComputedStyle(btnStartBar).display);
            btnStartBar.style.setProperty('display', 'flex', 'important');
            dbgUi("    btnStartBar après:", window.getComputedStyle(btnStartBar).display);
        }
        if (btnRecordBar) {
            dbgUi("    btnRecordBar avant:", window.getComputedStyle(btnRecordBar).display);
            btnRecordBar.style.setProperty('display', 'flex', 'important');
            dbgUi("    btnRecordBar après:", window.getComputedStyle(btnRecordBar).display);
        }
        if (btnPauseBar) {
            dbgUi("    btnPauseBar avant:", window.getComputedStyle(btnPauseBar).display);
            btnPauseBar.style.setProperty('display', 'none', 'important');
            dbgUi("    btnPauseBar après:", window.getComputedStyle(btnPauseBar).display);
        }
        if (btnStopBar) {
            dbgUi("    btnStopBar avant:", window.getComputedStyle(btnStopBar).display);
            btnStopBar.style.setProperty('display', 'none', 'important');
            dbgUi("    btnStopBar après:", window.getComputedStyle(btnStopBar).display);
        }
    } else {
        dbgUi("  Mode RUNNING: masquer Start/Record, afficher Pause/Stop");
        // Animation/enregistrement en cours -> masquer Start/Record, afficher Pause/Stop
        if (btnStartBar) {
            dbgUi("    btnStartBar avant:", window.getComputedStyle(btnStartBar).display);
            btnStartBar.style.setProperty('display', 'none', 'important');
            dbgUi("    btnStartBar après:", window.getComputedStyle(btnStartBar).display);
        }
        if (btnRecordBar) {
            dbgUi("    btnRecordBar avant:", window.getComputedStyle(btnRecordBar).display);
            btnRecordBar.style.setProperty('display', 'none', 'important');
            dbgUi("    btnRecordBar après:", window.getComputedStyle(btnRecordBar).display);
        }
        if (btnPauseBar) {
            dbgUi("    btnPauseBar avant:", window.getComputedStyle(btnPauseBar).display);
            btnPauseBar.style.setProperty('display', 'flex', 'important');
            dbgUi("    btnPauseBar après:", window.getComputedStyle(btnPauseBar).display);
        }
        if (btnStopBar) {
            dbgUi("    btnStopBar avant:", window.getComputedStyle(btnStopBar).display);
            btnStopBar.style.setProperty('display', 'flex', 'important');
            dbgUi("    btnStopBar après:", window.getComputedStyle(btnStopBar).display);
        }
    }

    // Toujours afficher le bouton pour basculer plein écran quand la barre est visible
    if (btnToggleFullscreen) {
        btnToggleFullscreen.style.display = 'flex';
        const iconToggle = btnToggleFullscreen.querySelector('i');
        const isFs = document.querySelector('main').classList.contains('fullscreen-mode');
        // Icône Tabler selon l'état. L'ancien code posait un textContent Material
        // ('fullscreen'/'fullscreen_exit') qui s'affichait en toutes lettres à côté
        // du glyphe sur les éléments .ti. Le nom accessible et la tooltip sont
        // désormais portés statiquement par le HTML (aria-label + data-bs-title) ;
        // on ne touche donc plus à .title, qui doublerait la tooltip Bootstrap.
        if (iconToggle) {
            iconToggle.classList.toggle('ti-minimize', isFs);
            iconToggle.classList.toggle('ti-maximize', !isFs);
        }
    }

    // Synchroniser l'icône Pause/Play
    if (btnPauseBar && btnPauseAnimation) {
        const isPaused = btnPauseAnimation.classList.contains('restart');
        const icon = btnPauseBar.querySelector('i');
        // Icône Tabler selon l'état (même correctif que le bouton plein écran :
        // l'ancien textContent Material 'play_arrow'/'pause' s'affichait en toutes
        // lettres sur l'élément .ti).
        if (isPaused) {
            btnPauseBar.classList.add('green');
            btnPauseBar.classList.remove('yellow', 'darken-2');
            if (icon) { icon.classList.add('ti-player-play'); icon.classList.remove('ti-player-pause'); }
        } else {
            btnPauseBar.classList.remove('green');
            btnPauseBar.classList.add('yellow', 'darken-2');
            if (icon) { icon.classList.add('ti-player-pause'); icon.classList.remove('ti-player-play'); }
        }
    }
}

// Bouton de bascule plein écran depuis la barre latérale
function toggleFullscreenFromButton(){
    const mainElement = document.querySelector('main');
    const isFs = mainElement.classList.contains('fullscreen-mode');
    // Si on est déjà en fullscreen, on veut quitter
    if (isFs) {
        fullscreenButtonActive = true; // Pour forcer la bascule
    }
    toggleFullscreenMode();
}

// Fonction pour activer/désactiver le bouton de durée audio et la checkbox selon si un fichier est chargé
function updateAudioDurationButton() {
    const btn = document.getElementById('btnSetDurationFromAudio');
    const inputAudio = document.getElementById('inputAudioFile');
    const cbAudio = document.getElementById('cbRecordAudioEnable');
    const hasFile = inputAudio && inputAudio.files && inputAudio.files.length > 0;

    // Bouton de durée
    if (btn) {
        if (hasFile) {
            btn.classList.remove('disabled');
        } else {
            btn.classList.add('disabled');
        }
    }

    // Checkbox
    if (cbAudio) {
        cbAudio.disabled = !hasFile;
        if (!hasFile) {
            cbAudio.checked = false; // Décocher si pas de fichier
        }
        // Si fichier chargé et checkbox pas encore cochée, la cocher (sécurité)
        if (hasFile && !cbAudio.checked) {
            cbAudio.checked = true;
        }
    }
}

// Fonction pour afficher les informations du fichier audio (maintenant seulement la tooltip)
async function displayAudioFileInfo(file) {
    const infoDiv = document.getElementById('audioFileInfo');

    if (!infoDiv) return;

    try {
        // Afficher le nom complet du fichier sélectionné
        const fileName = file.name;
        infoDiv.innerHTML = `<strong>${fileName}</strong>`;

        // Ajouter la tooltip avec métadonnées détaillées sur le nom du fichier
        await addAudioMetadataTooltip(file, infoDiv);

    } catch(e) {
        console.warn('Erreur lors de l\'affichage des infos audio:', e);
        infoDiv.innerHTML = `<strong>${file.name}</strong>`;
    }
}

// Fonction pour masquer les informations du fichier audio (remettre le message par défaut)
function hideAudioFileInfo() {
    const infoDiv = document.getElementById('audioFileInfo');
    if (infoDiv) {
        infoDiv.innerHTML = '<em>Aucune musique sélectionnée</em>';
    }
}

// Fonction pour ajouter une tooltip avec les métadonnées audio
async function addAudioMetadataTooltip(file, element) {
    try {
        // Informations de base du fichier
        const sizeKB = Math.round(file.size / 1024);
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        const type = file.type || 'Type inconnu';

        // Essayer d'extraire plus de métadonnées si disponible
        let metadata = {
            name: file.name,
            size: `${sizeKB} KB (${sizeMB} MB)`,
            type: type,
            lastModified: new Date(file.lastModified).toLocaleDateString()
        };

        // Essayer d'extraire la durée via Web Audio
        try {
            const duration = await getAudioDuration(file);
            if (duration && duration > 0) {
                const minutes = Math.floor(duration / 60);
                const seconds = Math.floor(duration % 60);
                metadata.duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            }
        } catch(e) {
            metadata.duration = 'Non disponible';
        }

        // Créer le contenu de la tooltip
        const tooltipContent = `
            <div style="max-width:300px;">
                <strong>${metadata.name}</strong><br>
                <small>
                    Taille: ${metadata.size}<br>
                    Type: ${metadata.type}<br>
                    Durée: ${metadata.duration}<br>
                    Modifié: ${metadata.lastModified}
                </small>
            </div>
        `;

        // Ajouter la tooltip Bootstrap 5
        element.setAttribute('data-bs-toggle', 'tooltip');
        element.setAttribute('data-bs-html', 'true');
        element.setAttribute('data-bs-title', tooltipContent);
        if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
            new bootstrap.Tooltip(element, { html: true, placement: 'top' });
        }

    } catch(e) {
        console.warn('Erreur lors de l\'extraction des métadonnées:', e);
    }
}

// Fonction pour extraire la durée d'un fichier audio
async function getAudioDuration(file) {
    return new Promise((resolve, reject) => {
        try {
            const audio = new Audio();
            const url = URL.createObjectURL(file);

            audio.addEventListener('loadedmetadata', () => {
                URL.revokeObjectURL(url);
                resolve(audio.duration);
            });

            audio.addEventListener('error', (e) => {
                URL.revokeObjectURL(url);
                reject(new Error('Erreur lors du chargement du fichier audio'));
            });

            audio.src = url;
        } catch(e) {
            reject(e);
        }
    });
}

// Fonction pour ouvrir une modale de confirmation de changement de langue
function openLanguageChangeModal(newLanguage, currentLanguage) {
    // Créer l'ID unique pour la modal
    const modalId = 'language-change-modal-' + Date.now();

    // Déterminer les noms des langues
    const languageNames = {
        'fr': { fr: 'Français', en: 'French' },
        'en': { fr: 'Anglais', en: 'English' }
    };

    // Déterminer les textes selon la langue actuelle et cible
    let title, message, confirmText, cancelText;

    if (window.TRANSLATIONS) {
        // Titre dans la langue actuelle
        if (currentLanguage === 'en') {
            title = window.TRANSLATIONS.language_change_title_en || 'Language Change';
        } else {
            title = window.TRANSLATIONS.language_change_title || 'Changement de langue';
        }

        // Question bilingue : langue actuelle + langue cible
        const targetLangNameCurrent = languageNames[newLanguage][currentLanguage] || newLanguage.toUpperCase();
        const targetLangNameTarget = languageNames[newLanguage][newLanguage] || newLanguage.toUpperCase();

        const switchTextCurrent = currentLanguage === 'en' ?
            `Switch to ${targetLangNameCurrent}?` :
            `Passer en ${targetLangNameCurrent} ?`;

        const switchTextTarget = newLanguage === 'en' ?
            `Switch to ${targetLangNameTarget}?` :
            `Passer en ${targetLangNameTarget} ?`;

        const messageCurrent = currentLanguage === 'en' ?
            'The language will be changed. The application will restart to apply the changes.' :
            'La langue va être changée. L\'application va redémarrer pour appliquer les modifications.';

        const messageTarget = newLanguage === 'en' ?
            'The language will be changed. The application will restart to apply the changes.' :
            'La langue va être changée. L\'application va redémarrer pour appliquer les modifications.';

        message = `<div class="language-change-message">
            <div class="bilingual-question">
                <div class="lang-current"><strong>${switchTextCurrent}</strong></div>
                <div class="lang-target"><strong>${switchTextTarget}</strong></div>
            </div>
            <div class="bilingual-message">
                <div class="lang-current">${messageCurrent}</div>
                <div class="lang-target">${messageTarget}</div>
            </div>
        </div>`;

        // Boutons dans la langue actuelle
        if (currentLanguage === 'en') {
            confirmText = window.TRANSLATIONS.confirm_en || 'Confirm';
            cancelText = window.TRANSLATIONS.cancel_en || 'Cancel';
        } else {
            confirmText = window.TRANSLATIONS.confirm || 'Confirmer';
            cancelText = window.TRANSLATIONS.cancel || 'Annuler';
        }
    } else {
        // Fallback si les traductions ne sont pas chargées
        const targetLangNameCurrent = languageNames[newLanguage][currentLanguage] || newLanguage.toUpperCase();
        const targetLangNameTarget = languageNames[newLanguage][newLanguage] || newLanguage.toUpperCase();

        const switchTextCurrent = currentLanguage === 'en' ?
            `Switch to ${targetLangNameCurrent}?` :
            `Passer en ${targetLangNameCurrent} ?`;

        const switchTextTarget = newLanguage === 'en' ?
            `Switch to ${targetLangNameTarget}?` :
            `Passer en ${targetLangNameTarget} ?`;

        if (currentLanguage === 'en') {
            title = 'Language Change';
            message = `<div class="language-change-message">
                <div class="bilingual-question">
                    <div class="lang-current"><strong>${switchTextCurrent}</strong></div>
                    <div class="lang-target"><strong>${switchTextTarget}</strong></div>
                </div>
                <div class="bilingual-message">
                    <div class="lang-current">The language will be changed. The application will restart to apply the changes.</div>
                    <div class="lang-target">La langue va être changée. L'application va redémarrer pour appliquer les modifications.</div>
                </div>
            </div>`;
            confirmText = 'Confirm';
            cancelText = 'Cancel';
        } else {
            title = 'Changement de langue';
            message = `<div class="language-change-message">
                <div class="bilingual-question">
                    <div class="lang-current"><strong>${switchTextCurrent}</strong></div>
                    <div class="lang-target"><strong>${switchTextTarget}</strong></div>
                </div>
                <div class="bilingual-message">
                    <div class="lang-current">La langue va être changée. L'application va redémarrer pour appliquer les modifications.</div>
                    <div class="lang-target">The language will be changed. The application will restart to apply the changes.</div>
                </div>
            </div>`;
            confirmText = 'Confirmer';
            cancelText = 'Annuler';
        }
    }

    // Créer le contenu HTML de la modal Bootstrap 5
    const modalHTML = `
        <div id="${modalId}" class="modal bs-modal" tabindex="-1">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title text-center">${title}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        ${message}
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary modal-close" data-bs-dismiss="modal">${cancelText}</button>
                        <button type="button" id="confirm-language-change" class="btn btn-primary">${confirmText}</button>
                    </div>
                </div>
            </div>
        </div>
        <style>
            #${modalId} .language-change-message {
                text-align: center;
                margin: 20px 0;
            }
            #${modalId} .bilingual-question {
                margin-bottom: 15px;
                padding-bottom: 10px;
                border-bottom: 1px solid #e0e0e0;
            }
            #${modalId} .bilingual-message {
                padding-top: 15px;
                margin-top: 15px;
            }
            #${modalId} .lang-current {
                margin-bottom: 8px;
                font-weight: 500;
                color: #424242;
            }
            #${modalId} .lang-target {
                font-style: italic;
                color: #666;
                font-size: 0.9em;
            }
        </style>
    `;

    // Ajouter la modal au DOM
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Initialiser et ouvrir la modal Bootstrap 5
    const modalElement = document.getElementById(modalId);
    const bsModal = new bootstrap.Modal(modalElement, {
        backdrop: 'static', // Empêcher la fermeture en cliquant à l'extérieur
        keyboard: false
    });
    // Nettoyer la modal du DOM après fermeture
    modalElement.addEventListener('hidden.bs.modal', function() {
        modalElement.remove();
    });
    bsModal.show();

    // Gérer le clic sur le bouton de confirmation
    document.getElementById('confirm-language-change').addEventListener('click', function() {
        bsModal.hide();
        // Persister la langue côté navigateur + backend
        persistLanguagePreference(newLanguage);

        // Recharger la page en conservant l'onglet actif (sans dépendre du paramètre lang)
        const url = new URL(window.location);
        url.searchParams.delete('lang');

        // Récupérer l'onglet actif actuel et l'ajouter à l'URL
        const activeTab = localStorage.getItem('activeTab');
        if (activeTab && activeTab !== 'data') { // 'data' est l'onglet par défaut
            url.hash = activeTab;
        }

        // Recharger la page avec la nouvelle langue (détectée via cookie/localStorage)
        window.location.replace(url.toString());
        // Sécurité : forcer un reload même si l'URL est identique
        setTimeout(() => window.location.reload(), 100);
    });

    // Ouvrir la modal
    modalInstance.open();
}
