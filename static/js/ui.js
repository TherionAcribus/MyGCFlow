import * as pkg from './index.js';

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
// Dates par défaut (capture au chargement BDD)
var defaultStartDate = null;
var defaultEndDate = null;
// Dates de publication par défaut
var defaultPublishedStartDate = null;
var defaultPublishedEndDate = null;
// Pays/Etats
let countryToStates = {};
var inputTimePerDay;
var selectFlashMode, inputTimeFlash, inputSizeFlash, cpFlashColor;
var cpStrokeColor, cpFillColor, cpBackgroundColor, strokeWidth;
var cbDisplayTitle, cbDisplayNumberofCaches, cbDisplayCurrentDate, inputTitle;
var inputTitleCss, inputInfosCss, btnTitleCss, btnInfosCss;
var spanNbCaches, spanCurrentDate;
var selectLanguage, selectCheckVersionOnline, buttonCheckVersion, buttonHome;
// Enregistrement
var selectRecordMode, inputRecordFps, inputRecordBitrate, selectRecordMime, inputRecordSlowdown, inputRecordScaleFactor, cbRecordUpload, cbRecordDownload;
var cbRecordAudioEnable, inputAudioFile, inputAudioVolume;
// Flag pour savoir si la durée totale est définie depuis la musique
var isDurationLockedToAudio = false;

// Fonction pour mettre à jour l'apparence du label selon si la durée est lockée
function updateDurationLockIndicator() {
    const label = document.getElementById('labelTotalTime');
    if (label) {
        if (isDurationLockedToAudio) {
            const lockedText = label.getAttribute('data-locked-text') || 'Temps total (minutes) - défini par musique';
            label.innerHTML = '<i class="material-icons" style="font-size:14px; vertical-align:middle;">music_note</i> ' + lockedText;
            label.style.color = '#2196F3'; // Bleu Material Design
        } else {
            const normalText = label.getAttribute('data-normal-text') || 'Temps total (minutes)';
            label.innerHTML = normalText;
            label.style.color = ''; // Couleur par défaut
        }
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
    if (datePickerStart) datePickerStart.addEventListener('change', onSelectionChangedDebounced);
    if (datePickerEnd) datePickerEnd.addEventListener('change', onSelectionChangedDebounced);

// datepicker (pose)
const publishedDatePickerStart = document.getElementById('publishedDatePickerStart');
const publishedDatePickerEnd = document.getElementById('publishedDatePickerEnd');
    if (publishedDatePickerStart) publishedDatePickerStart.addEventListener('change', onSelectionChangedDebounced);
    if (publishedDatePickerEnd) publishedDatePickerEnd.addEventListener('change', onSelectionChangedDebounced);

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
            M.FormSelect.init(selectStateEl);
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

    // Zones d'information sous chaque filtre
    infoType = document.getElementById('infoType');
    infoDifficulty = document.getElementById('infoDifficulty');
    infoTerrain = document.getElementById('infoTerrain');
    infoContainer = document.getElementById('infoContainer');

    // Initialiser Materialize Selects
    if (selectType) M.FormSelect.init(selectType);
    if (selectDifficulty) M.FormSelect.init(selectDifficulty);
    if (selectTerrain) M.FormSelect.init(selectTerrain);
    if (selectContainer) M.FormSelect.init(selectContainer);
    // Restaurer la sélection si existante
    restoreSelectedValues();

    // Première mise à jour des infos
    updateFilterInfos();

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
            console.log('Bouton Clair cliqué');
            changeStamenTonerStyle.call(this);
        });
    } else {
        console.warn('Bouton stamenTonerLight non trouvé');
    }

    btnStamenTonerDark = document.getElementById('stamenTonerDark');
    if (btnStamenTonerDark) {
        btnStamenTonerDark.addEventListener('click', function() {
            console.log('Bouton Sombre cliqué');
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
    if (selectShape) selectShape.addEventListener('change', changePointStyleUI);

// ANIMATION DE LA CARTE
// Boutons
const btnStartAnimation = document.getElementById('btnStartAnimation');
    if (btnStartAnimation) btnStartAnimation.addEventListener('click', clickStartAnimation);

const btnRecordAnimation = document.getElementById('btnRecordAnimation');
    if (btnRecordAnimation) btnRecordAnimation.addEventListener('click', clickRecordAnimation);

    inputTimePerDay = document.getElementById('inputTimePerDay');
    if (inputTimePerDay) inputTimePerDay.addEventListener('input', changeAnimationValues);

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

    // Datepickers Animation (même UI que Données)
    const animDateStart = document.getElementById('animDateStart');
    const animDateEnd = document.getElementById('animDateEnd');
    if (animDateStart) {
        const dp1 = M.Datepicker.init(animDateStart, { format: 'dd/mm/yyyy' });
        // Les dates seront pré-remplies dans setPickerDates() quand la BDD sera chargée
        animDateStart.addEventListener('change', () => {
            const parsedDate = pkg.parseDateInput(animDateStart.value);
            pkg.options.animation.dateStart = parsedDate;
            updateResetAnimButtonsHighlight();
            updateDeltaDaysAndTimes();
        });
    }
    if (animDateEnd) {
        const dp2 = M.Datepicker.init(animDateEnd, { format: 'dd/mm/yyyy' });
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

    // Initialiser l'état des contrôles (boutons principaux et barre latérale)
    console.log("=== INITIALISATION DES CONTROLES ===");
    showStartRecordButtons();
    console.log("Appel updateControlBar depuis initUIElements");
    updateControlBar();

    // Initialiser l'apparence du bouton fullscreen
    updateFullscreenButtonAppearance();

    // FLASH
    // select pour le mode de flash
    selectFlashMode = document.getElementById('selectFlashMode');
    if (selectFlashMode) {
        selectFlashMode.addEventListener('change', () => changeFlashValues(selectFlashMode));
        // Initialiser Materialize Select
        M.FormSelect.init(selectFlashMode);
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

    // boutons
    btnTitleCss = document.getElementById('btnTitleCss');
    if (btnTitleCss) {
        btnTitleCss.addEventListener('click', () => {
            try {
                const value = inputTitleCss ? inputTitleCss.value : '';
                pkg.changeTitleCssValues(value);
                console.log('[CSS] TitleFrame appliqué:', value.substring(0, 100));
            } catch(e) { console.warn('[CSS] TitleFrame erreur', e); }
        });
    }

    btnInfosCss = document.getElementById('btnInfosCss');
    if (btnInfosCss) {
        btnInfosCss.addEventListener('click', () => {
            try {
                const value = inputInfosCss ? inputInfosCss.value : '';
                pkg.changeInfosCssValues(value);
                console.log('[CSS] InfosFrame appliqué:', value.substring(0, 100));
            } catch(e) { console.warn('[CSS] InfosFrame erreur', e); }
        });
    }

    // Spans dans Frame Infos
    spanNbCaches = document.getElementById('spanNbCaches');
    spanCurrentDate = document.getElementById('spanCurrentDate');

    // OPTIONS
    selectLanguage = document.getElementById('selectLanguage');
    if (selectLanguage) selectLanguage.addEventListener('change', changeOptionsValues);

    selectCheckVersionOnline = document.getElementById('selectCheckVersionOnline');
    if (selectCheckVersionOnline) selectCheckVersionOnline.addEventListener('change', changeOptionsValues);

    // boutons
    buttonCheckVersion = document.getElementById('buttonCheckVersion');
    if (buttonCheckVersion) buttonCheckVersion.addEventListener('click', pkg.checkVersion);

    buttonHome = document.getElementById('buttonHome');
    if (buttonHome) buttonHome.addEventListener('click', pkg.openHomePage);

    // Initialiser les éléments du menu paramètres
    initOptionsElements();
}

// Initialisation des éléments du menu paramètres
function initOptionsElements() {
    // ENREGISTREMENT
    selectRecordMode = document.getElementById('selectRecordMode');
    if (selectRecordMode) {
        selectRecordMode.addEventListener('change', onRecordModeChange);
        M.FormSelect.init(selectRecordMode);
    }
    inputRecordFps = document.getElementById('inputRecordFps');
    if (inputRecordFps) inputRecordFps.addEventListener('input', changeRecordValues);
    inputRecordBitrate = document.getElementById('inputRecordBitrate');
    if (inputRecordBitrate) inputRecordBitrate.addEventListener('input', changeRecordValues);
    selectRecordMime = document.getElementById('selectRecordMime');
    if (selectRecordMime) {
        selectRecordMime.addEventListener('change', changeRecordValues);
        M.FormSelect.init(selectRecordMime);
    }
    inputRecordSlowdown = document.getElementById('inputRecordSlowdown');
    if (inputRecordSlowdown) inputRecordSlowdown.addEventListener('input', changeRecordValues);
    inputRecordScaleFactor = document.getElementById('inputRecordScaleFactor');
    if (inputRecordScaleFactor) inputRecordScaleFactor.addEventListener('input', changeRecordValues);
    cbRecordUpload = document.getElementById('cbRecordUpload');
    if (cbRecordUpload) cbRecordUpload.addEventListener('change', changeRecordValues);
    cbRecordDownload = document.getElementById('cbRecordDownload');
    if (cbRecordDownload) cbRecordDownload.addEventListener('change', changeRecordValues);
    // Audio utilisateur
    cbRecordAudioEnable = document.getElementById('cbRecordAudioEnable');
    if (cbRecordAudioEnable) cbRecordAudioEnable.addEventListener('change', changeRecordValues);
    inputAudioVolume = document.getElementById('inputAudioVolume');
    if (inputAudioVolume) inputAudioVolume.addEventListener('input', changeRecordValues);
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
                        inputTotalTime.value = audioDurationMin.toFixed(2);

                        // Marquer que la durée est maintenant lockée à la musique
                        isDurationLockedToAudio = true;
                        updateDurationLockIndicator();

                        // Recalculer le temps par jour basé sur cette nouvelle durée totale
                        updateTimePerDay();

                        console.log(`Durée audio appliquée: ${audioDurationSec.toFixed(2)}s (${audioDurationMin.toFixed(2)}min) - Durée lockée`);
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
            // Réinitialiser Materialize si c'est un select
            if (element.querySelector('select')) {
                const select = element.querySelector('select');
                M.FormSelect.init(select);
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
        // Retirer la classe active de tous les onglets
        document.querySelectorAll('.tabs .tab a').forEach(tab => {
            tab.classList.remove('active');
        });
        // Ajouter la classe active à l'onglet sélectionné
        tabElement.classList.add('active');

        // Activer l'onglet dans Materialize
        const tabsInstance = M.Tabs.getInstance(document.querySelector('.tabs'));
        if (tabsInstance) {
            tabsInstance.select(activeTab);
        }

        // Sauvegarder dans localStorage si ce n'était pas déjà fait
        if (!urlHash) {
            localStorage.setItem('activeTab', activeTab);
        }
    }

    // Gérer le changement d'onglet
    document.querySelectorAll('.tabs .tab a').forEach(tab => {
        tab.addEventListener('click', function() {
            const tabId = this.getAttribute('href').substring(1); // Enlever le #
            localStorage.setItem('activeTab', tabId);
        });
    });
}

// Initialiser les éléments UI quand le DOM est chargé
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        initUIElements();
        initTabMemory();
    });
} else {
    // DOM déjà chargé
    initUIElements();
    initTabMemory();
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
btnCleanMoviePictures.addEventListener('click', clear_pictures_directory);
const btnAssembleMoviePictures = document.getElementById('btnAssembleMoviePictures');
btnAssembleMoviePictures.addEventListener('click', assemble_pictures_directory);


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

    selectLanguage.value = pkg.options.options.language;
    M.FormSelect.init(document.getElementById('selectLanguage'));
    selectCheckVersionOnline.value = pkg.options.options.checkVersion;
    M.FormSelect.init(document.getElementById('selectCheckVersionOnline'));

    // Charger l'arbre Country/State et peupler selects
    try {
        console.log('[COUNTRY] Fetching /api/country_state ...');
        const apiUrl = `${window.location.origin}/api/country_state`;
        fetch(apiUrl)
            .then(async r => {
                console.log('[COUNTRY] Response ok=', r.ok, 'status=', r.status);
                const txt = await r.text();
                console.log('[COUNTRY] Response length=', txt?.length);
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
                            console.log('[COUNTRY] Fallback static JSON loaded. Countries:', Object.keys(countryToStates).length);
                            populateCountryStateSelects(countryToStates);
                            setTimeout(() => {
                                console.log('[COUNTRY] Re-populate after delay (fallback)');
                                populateCountryStateSelects(countryToStates);
                            }, 800);
                        })
                        .catch(e => console.warn('[COUNTRY] Fallback fetch error:', e));
                }
                countryToStates = data || {};
                console.log('[COUNTRY] Data received. Countries:', Object.keys(countryToStates).length);
                populateCountryStateSelects(countryToStates);
            setTimeout(() => {
                console.log('[COUNTRY] Re-populate after delay');
                populateCountryStateSelects(countryToStates);
                // Mise à jour finale des infos après remplissage
                setTimeout(() => {
                    updateFilterInfos();
                }, 200);
            }, 800);
            })
            .catch((e)=>{ console.warn('[COUNTRY] Fetch error:', e); })
            .finally(()=>{ console.log('[COUNTRY] Fetch chain completed'); });
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
        console.log(radio)
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
    console.log('🎨 [INIT_UI] Application du mode des points:', {
        mode_dans_options: pkg.options.point.mode,
        switch_actuel: switchIconeVectoriel.checked
    });

    if (pkg.options.point.mode === "vectoriel") {
        switchIconeVectoriel.checked = true;
        console.log('🎨 [INIT_UI] Mode vectoriel appliqué - switch coché');
    } else if (pkg.options.point.mode === "icone") {
        switchIconeVectoriel.checked = false;
        console.log('🎨 [INIT_UI] Mode icone appliqué - switch décoché');
    } else {
        console.warn('🎨 [INIT_UI] Mode inconnu:', pkg.options.point.mode, '- utilisation de la valeur par défaut (vectoriel)');
        switchIconeVectoriel.checked = true; // valeur par défaut
    }

    console.log('🎨 [INIT_UI] État final du switch:', switchIconeVectoriel.checked);
    selectShape.value = pkg.options.point.shape
    // Obliger Materialize à actualiser l'affichage du select pour refléter la nouvelle valeur sélectionnée
    M.FormSelect.init(document.getElementById('selectShape'));

    
    // ------- ANIMATION DE LA CARTE -------
    // Inputs
    inputTimePerDay.value = pkg.options.animation.timePerDay;

    // ------- FLASH -------
    // colorpicker
    if (cpFlashColor) cpFlashColor.value = pkg.options.flash.color;
    // inputs
    if (inputTimeFlash) inputTimeFlash.value = pkg.options.flash.duration;
    if (inputSizeFlash) inputSizeFlash.value = pkg.options.flash.size;
    // select pour le mode de flash
    if (selectFlashMode) {
        selectFlashMode.value = pkg.options.flash.mode;
        // Rafraîchir le select Materialize après avoir changé la valeur
        M.FormSelect.init(selectFlashMode);
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
        M.updateTextFields();
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
    M.updateTextFields();
}

// Initialisation des valeurs UI pour les paramètres
function initOptionsUI() {
    // ------- ENREGISTREMENT -------
    try {
        // Restaurer les paramètres sauvegardés
        loadRecordSettings();

        if (selectRecordMode) {
            selectRecordMode.value = (pkg.options.record?.mode) || 'mediarecorder'; // MediaRecorder par défaut
            M.FormSelect.init(selectRecordMode);
        }
        if (inputRecordFps) inputRecordFps.value = (pkg.options.record?.fps) || 24;
        if (inputRecordBitrate) inputRecordBitrate.value = (pkg.options.record?.mediaRecorder?.videoBitsPerSecond) || 6000000;
        if (selectRecordMime) {
            selectRecordMime.value = (pkg.options.record?.mediaRecorder?.mimeType) || 'video/webm;codecs=vp9';
            M.FormSelect.init(selectRecordMime);
        }
        if (inputRecordSlowdown) inputRecordSlowdown.value = (pkg.options.record?.mediaRecorder?.slowdownFactor) || 1;
        if (inputRecordScaleFactor) inputRecordScaleFactor.value = (pkg.options.record?.mediaRecorder?.scaleFactor) || 1;
        if (cbRecordUpload) cbRecordUpload.checked = !!(pkg.options.record?.mediaRecorder?.uploadToServer);
        if (cbRecordDownload) cbRecordDownload.checked = !!(pkg.options.record?.mediaRecorder?.downloadLocal);

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
            if (inputAudioVolume) inputAudioVolume.value = (typeof pkg.options.record.audio.volume === 'number') ? pkg.options.record.audio.volume : 1;
        } catch(e) { console.warn('Init audio UI error:', e); }

        // Mettre à jour la visibilité après l'initialisation
        updateMediaRecorderOptionsVisibility();

        // Synchroniser la visibilité des overlays avec les paramètres utilisateur
        updateOverlayElementsVisibility();

        // Mettre à jour l'état du bouton durée audio
        updateAudioDurationButton();
        // Initialiser l'indicateur de durée lockée
        updateDurationLockIndicator();
    } catch(e) { console.warn('Init enregistrement UI error:', e); }
}


// ----------- OPTIONS DE L'APP ------------

//
async function changeOptionsValues() {
    const newLanguage = selectLanguage.value;
    const currentLanguage = pkg.options.options.language;

    // Sauvegarder la nouvelle langue dans les options
    pkg.options.options.language = newLanguage;
    pkg.options.options.checkVersion = selectCheckVersionOnline.value;

    // Sauvegarder dans localStorage
    localStorage.setItem('selectedLanguage', newLanguage);

    // Sauvegarder côté serveur via l'API settings (comme les profils)
    try {
        const currentSettings = await (await fetch('/api/settings')).json();
        currentSettings.language = newLanguage;
        currentSettings.check_updates = selectCheckVersionOnline.value === 'true' || selectCheckVersionOnline.value === true;

        const saveResponse = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentSettings)
        });

        if (saveResponse.ok) {
            console.log('Paramètres sauvegardés côté serveur:', { language: newLanguage, check_updates: currentSettings.check_updates });
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
            const fps = Math.max(1, Math.min(60, parseInt(inputRecordFps.value)) || 24);
            pkg.options.record.fps = fps;
        }
        if (inputRecordBitrate && inputRecordBitrate.value !== '') {
            const vbps = Math.max(100000, parseInt(inputRecordBitrate.value) || 6000000);
            pkg.options.record.mediaRecorder.videoBitsPerSecond = vbps;
        }
        if (selectRecordMime && selectRecordMime.value !== '') {
            pkg.options.record.mediaRecorder.mimeType = selectRecordMime.value;
        }
        if (inputRecordSlowdown && inputRecordSlowdown.value !== '') {
            const sd = Math.max(1, parseInt(inputRecordSlowdown.value) || 1);
            pkg.options.record.mediaRecorder.slowdownFactor = sd;
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
                    console.log('Durée délockée - audio désactivé');
                }
            }
            if (inputAudioVolume && inputAudioVolume.value !== '') {
                const vol = Math.max(0, Math.min(1, parseFloat(inputAudioVolume.value) || 1));
                pkg.options.record.audio.volume = vol;
            }
        } catch(e) { console.warn('changeRecordValues audio error:', e); }

        // Sauvegarder automatiquement les paramètres d'enregistrement
        saveRecordSettings();

        // Pas de recalcul forcé ici; les valeurs seront lues à l'enregistrement
    } catch(e) {
        console.warn('changeRecordValues error:', e);
    }
}

// Sauvegarde les paramètres d'enregistrement dans localStorage
function saveRecordSettings() {
    try {
        const recordSettings = {
            mode: pkg.options.record?.mode || 'mediarecorder',
            fps: pkg.options.record?.fps || 24,
            mediaRecorder: {
                mimeType: pkg.options.record?.mediaRecorder?.mimeType || 'video/webm;codecs=vp9',
                videoBitsPerSecond: pkg.options.record?.mediaRecorder?.videoBitsPerSecond || 6000000,
                slowdownFactor: pkg.options.record?.mediaRecorder?.slowdownFactor || 1,
                uploadToServer: pkg.options.record?.mediaRecorder?.uploadToServer || true,
                downloadLocal: pkg.options.record?.mediaRecorder?.downloadLocal || true,
                offlineNormalization: pkg.options.record?.mediaRecorder?.offlineNormalization || true
                ,
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
                pkg.options.record.fps = recordSettings.fps || 24;
                pkg.options.record.mediaRecorder = pkg.options.record.mediaRecorder || {};
                pkg.options.record.mediaRecorder.mimeType = recordSettings.mediaRecorder?.mimeType || 'video/webm;codecs=vp9';
                pkg.options.record.mediaRecorder.videoBitsPerSecond = recordSettings.mediaRecorder?.videoBitsPerSecond || 6000000;
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

    const startDatePicker = M.Datepicker.getInstance(startDateElement);
    const endDatePicker = M.Datepicker.getInstance(endDateElement);

    // Capture des dates par défaut (clonées pour éviter toute mutation)
    defaultStartDate = metadata.startDate ? new Date(metadata.startDate) : null;
    defaultEndDate = metadata.endDate ? new Date(metadata.endDate) : null;
    // Pour les dates de publication, on utilise les mêmes dates que trouvaille (pas d'info spécifique dans metadata)
    defaultPublishedStartDate = metadata.startDate ? new Date(metadata.startDate) : null;
    defaultPublishedEndDate = metadata.endDate ? new Date(metadata.endDate) : null;

    const formattedStartDate = formatDateForPickers(defaultStartDate);
    const formattedEndDate = formatDateForPickers(defaultEndDate);

    startDatePicker.setDate(defaultStartDate, true);
    endDatePicker.setDate(defaultEndDate, true);

    startDateElement.value = formattedStartDate;
    endDateElement.value = formattedEndDate;

    // Mettre à jour les libellés des boutons reset
    const btnResetStartDate = document.getElementById('btnResetStartDate');
    const btnResetEndDate = document.getElementById('btnResetEndDate');
    if (btnResetStartDate) btnResetStartDate.textContent = `⟲ ${formattedStartDate}`;
    if (btnResetEndDate) btnResetEndDate.textContent = `⟲ ${formattedEndDate}`;
    updateResetButtonsHighlight();

    // Initialiser les datepickers de publication avec les mêmes valeurs par défaut
    const publishedStartElement = document.querySelector('#publishedDatePickerStart');
    const publishedEndElement = document.querySelector('#publishedDatePickerEnd');
    if (publishedStartElement && publishedEndElement) {
        const publishedStartPicker = M.Datepicker.getInstance(publishedStartElement) || M.Datepicker.init(publishedStartElement, {
            format: 'yyyy-mm-dd',
            autoClose: true,
            showClearBtn: false,
            i18n: frenchDatePickerConfig
        });
        const publishedEndPicker = M.Datepicker.getInstance(publishedEndElement) || M.Datepicker.init(publishedEndElement, {
            format: 'yyyy-mm-dd',
            autoClose: true,
            showClearBtn: false,
            i18n: frenchDatePickerConfig
        });

        publishedStartPicker.setDate(defaultPublishedStartDate, true);
        publishedEndPicker.setDate(defaultPublishedEndDate, true);

        publishedStartElement.value = formattedStartDate;
        publishedEndElement.value = formattedEndDate;

        // Mettre à jour les libellés des boutons reset publication
        const btnResetPublishedStartDate = document.getElementById('btnResetPublishedStartDate');
        const btnResetPublishedEndDate = document.getElementById('btnResetPublishedEndDate');
        if (btnResetPublishedStartDate) btnResetPublishedStartDate.textContent = `⟲ ${formattedStartDate}`;
        if (btnResetPublishedEndDate) btnResetPublishedEndDate.textContent = `⟲ ${formattedEndDate}`;
        updatePublishedResetButtonsHighlight();
    }

    // Pré-remplir les datepickers Animation avec les dates par défaut
    const animStartElement = document.querySelector('#animDateStart');
    const animEndElement = document.querySelector('#animDateEnd');

    if (animStartElement && defaultStartDate) {
        const animStartPicker = M.Datepicker.getInstance(animStartElement);
        if (animStartPicker) {
            animStartPicker.setDate(defaultStartDate, true);
            animStartElement.value = formattedStartDate;
            pkg.options.animation.dateStart = defaultStartDate;
        }
    }

    if (animEndElement && defaultEndDate) {
        const animEndPicker = M.Datepicker.getInstance(animEndElement);
        if (animEndPicker) {
            animEndPicker.setDate(defaultEndDate, true);
            animEndElement.value = formattedEndDate;
            pkg.options.animation.dateEnd = defaultEndDate;
        }
    }

    // Mettre à jour les boutons reset Animation aussi
    updateResetAnimButtonsHighlight();

    // Mettre à jour les labels Materialize après avoir défini les valeurs des datepickers
    M.updateTextFields();
}

function formatDateForPickers(date) {
    const options = { day: '2-digit', month: '2-digit', year: 'numeric', };
    return new Date(date).toLocaleDateString('fr-CA', options);
}
function resetStartDateToDefault(){
    const el = document.querySelector('#datePickerStart');
    const start = defaultStartDate;
    if (!el || !start) return;
    const inst = M.Datepicker.getInstance(el);
    inst.setDate(start, true);
    el.value = formatDateForPickers(start);
    onSelectionChangedDebounced();
    updateResetButtonsHighlight();
    updateResetAnimButtonsHighlight();
}

function resetEndDateToDefault(){
    const el = document.querySelector('#datePickerEnd');
    const end = defaultEndDate;
    if (!el || !end) return;
    const inst = M.Datepicker.getInstance(el);
    inst.setDate(end, true);
    el.value = formatDateForPickers(end);
    onSelectionChangedDebounced();
    updateResetButtonsHighlight();
    updateResetAnimButtonsHighlight();
}

function resetPublishedStartDateToDefault(){
    const el = document.querySelector('#publishedDatePickerStart');
    const start = defaultPublishedStartDate;
    if (!el || !start) return;
    const inst = M.Datepicker.getInstance(el);
    if (inst) {
        inst.setDate(start, true);
        el.value = formatDateForPickers(start);
        onSelectionChangedDebounced();
        updatePublishedResetButtonsHighlight();
    }
}

function resetPublishedEndDateToDefault(){
    const el = document.querySelector('#publishedDatePickerEnd');
    const end = defaultPublishedEndDate;
    if (!el || !end) return;
    const inst = M.Datepicker.getInstance(el);
    if (inst) {
        inst.setDate(end, true);
        el.value = formatDateForPickers(end);
        onSelectionChangedDebounced();
        updatePublishedResetButtonsHighlight();
    }
}

function updatePublishedResetButtonsHighlight(){
    const btnStart = document.getElementById('btnResetPublishedStartDate');
    const btnEnd = document.getElementById('btnResetPublishedEndDate');
    const currentStart = document.querySelector('#publishedDatePickerStart')?.value;
    const currentEnd = document.querySelector('#publishedDatePickerEnd')?.value;
    const defaultStartStr = defaultPublishedStartDate ? formatDateForPickers(defaultPublishedStartDate) : null;
    const defaultEndStr = defaultPublishedEndDate ? formatDateForPickers(defaultPublishedEndDate) : null;
    if (btnStart) {
        if (currentStart && defaultStartStr && currentStart === defaultStartStr) btnStart.classList.add('active-reset');
        else btnStart.classList.remove('active-reset');
    }
    if (btnEnd) {
        if (currentEnd && defaultEndStr && currentEnd === defaultEndStr) btnEnd.classList.add('active-reset');
        else btnEnd.classList.remove('active-reset');
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
        if (currentStart && defaultStartStr && currentStart === defaultStartStr) btnStart.classList.add('active-reset');
        else btnStart.classList.remove('active-reset');
    }
    if (btnEnd) {
        if (currentEnd && defaultEndStr && currentEnd === defaultEndStr) btnEnd.classList.add('active-reset');
        else btnEnd.classList.remove('active-reset');
    }
}

function resetAnimStartDateToDefault(){
    const el = document.querySelector('#animDateStart');
    const start = defaultStartDate;
    if (!el || !start) return;
    const inst = M.Datepicker.getInstance(el);
    inst.setDate(start, true);
    el.value = formatDateForPickers(start);
    pkg.options.animation.dateStart = start;
    updateResetAnimButtonsHighlight();
    updateDeltaDaysAndTimes();
}

function resetAnimEndDateToDefault(){
    const el = document.querySelector('#animDateEnd');
    const end = defaultEndDate;
    if (!el || !end) return;
    const inst = M.Datepicker.getInstance(el);
    inst.setDate(end, true);
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
        btnStart.textContent = defaultStartStr ? `⟲ ${defaultStartStr}` : '⟲';
        if (currentStart && defaultStartStr && currentStart === defaultStartStr) btnStart.classList.add('active-reset');
        else btnStart.classList.remove('active-reset');
    }
    if (btnEnd) {
        btnEnd.textContent = defaultEndStr ? `⟲ ${defaultEndStr}` : '⟲';
        if (currentEnd && defaultEndStr && currentEnd === defaultEndStr) btnEnd.classList.add('active-reset');
        else btnEnd.classList.remove('active-reset');
    }
}

// Debounce et wrapper
function onSelectionChangedDebounced(){
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
    selectedValues["type"] = selectType ? Array.from(selectType.selectedOptions).map(option => option.value) : [];
    selectedValues["terrain"] = selectTerrain ? Array.from(selectTerrain.selectedOptions).map(option => option.value) : [];
    selectedValues["difficulty"] = selectDifficulty ? Array.from(selectDifficulty.selectedOptions).map(option => option.value) : [];
    selectedValues["container"] = selectContainer ? Array.from(selectContainer.selectedOptions).map(option => option.value) : [];
    const selCountry = document.getElementById('selectCountry');
    const selState = document.getElementById('selectState');
    if (selCountry) selectedValues["countries"] = Array.from(selCountry.selectedOptions).map(o => o.value);
    if (selState) selectedValues["states"] = Array.from(selState.selectedOptions).map(o => o.value);
    selectedValues["dates"] = {startDate: document.querySelector('#datePickerStart')?.value, endDate: document.querySelector('#datePickerEnd')?.value};
    selectedValues["published_dates"] = {startDate: document.querySelector('#publishedDatePickerStart')?.value, endDate: document.querySelector('#publishedDatePickerEnd')?.value};
    return selectedValues;
}

function populateCountryStateSelects(tree){
    const selCountry = document.getElementById('selectCountry');
    const selState = document.getElementById('selectState');
    if (!selCountry || !selState) {
        console.log('[COUNTRY] Selects not ready, retry later');
        setTimeout(() => populateCountryStateSelects(tree), 200);
        return;
    }
    // Populate countries
    selCountry.innerHTML = '';
    // Ajouter l'option placeholder pour les pays
    const placeholderCountry = document.createElement('option');
    placeholderCountry.value = '';
    placeholderCountry.disabled = true;
    placeholderCountry.textContent = 'Filtrer par pays';
    selCountry.appendChild(placeholderCountry);
    
    const countries = Object.keys(tree).sort((a,b)=>a.localeCompare(b));
    console.log('[COUNTRY] Populating countries:', countries.length);
    const fragC = document.createDocumentFragment();
    for (const c of countries){
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c; opt.selected = true;
        fragC.appendChild(opt);
    }
    selCountry.appendChild(fragC);
    // Détruire l'instance Materialize existante si déjà initialisée
    try { M.FormSelect.getInstance(selCountry)?.destroy?.(); } catch(_) {}
    M.FormSelect.init(selCountry);

    // Populate states (from selected countries or all)
    const statesSet = new Set();
    for (const list of Object.values(tree)) { (list||[]).forEach(s => statesSet.add(s)); }
    console.log('[COUNTRY] Populating states total unique:', statesSet.size);
    selState.innerHTML = '';
    // Ajouter l'option placeholder pour les états
    const placeholderState = document.createElement('option');
    placeholderState.value = '';
    placeholderState.disabled = true;
    placeholderState.textContent = 'Filtrer par région/état';
    selState.appendChild(placeholderState);
    
    const fragS = document.createDocumentFragment();
    for (const s of Array.from(statesSet).sort((a,b)=>a.localeCompare(b))){
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s; opt.selected = true;
        fragS.appendChild(opt);
    }
    selState.appendChild(fragS);
    try { M.FormSelect.getInstance(selState)?.destroy?.(); } catch(_) {}
    M.FormSelect.init(selState);

    selCountry.addEventListener('change', () => {
        // Si des vraies options sont sélectionnées, désélectionner le placeholder
        const realSelected = Array.from(selCountry.selectedOptions).filter(o => !o.disabled && o.value !== '');
        if (realSelected.length > 0) {
            const placeholder = selCountry.querySelector('option[disabled][value=""]');
            if (placeholder) placeholder.selected = false;
        }
        
        const selected = Array.from(selCountry.selectedOptions).map(o => o.value);
        console.log('[COUNTRY] Country change selected=', selected);
        const sset = new Set();
        selected.forEach(c => (tree[c]||[]).forEach(s => sset.add(s)));
        selState.innerHTML = '';
        // Toujours ajouter le placeholder en premier
        const placeholderStateChange = document.createElement('option');
        placeholderStateChange.value = '';
        placeholderStateChange.disabled = true;
        placeholderStateChange.textContent = 'Filtrer par région/état';
        selState.appendChild(placeholderStateChange);
        
        const frag = document.createDocumentFragment();
        Array.from(sset).sort((a,b)=>a.localeCompare(b)).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s; opt.textContent = s; opt.selected = selected.length > 0; // si aucun pays, rien sélectionné
            frag.appendChild(opt);
        });
        selState.appendChild(frag);
        try { M.FormSelect.getInstance(selState)?.destroy?.(); } catch(_) {}
        M.FormSelect.init(selState);
        console.log('[COUNTRY] States populated for selection=', sset.size);
        // Mise à jour des infos et déclenchement filtrage
        updateFilterInfos();
        onSelectionChangedDebounced();
    });

    // Déclencher le filtrage quand l'utilisateur change la sélection des états directement
    selState.addEventListener('change', () => {
        console.log('[COUNTRY] State selection changed');
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
        if (!raw) return;
        const values = JSON.parse(raw);
        setSelectValues(selectType, values.type);
        setSelectValues(selectDifficulty, values.difficulty);
        setSelectValues(selectTerrain, values.terrain);
        setSelectValues(selectContainer, values.container);
        // dates
        const start = document.querySelector('#datePickerStart');
        const end = document.querySelector('#datePickerEnd');
        if (start && values.dates?.startDate) start.value = values.dates.startDate;
        if (end && values.dates?.endDate) end.value = values.dates.endDate;
        // refresh UI (Materialize)
        if (selectType) M.FormSelect.init(selectType);
        if (selectDifficulty) M.FormSelect.init(selectDifficulty);
        if (selectTerrain) M.FormSelect.init(selectTerrain);
        if (selectContainer) M.FormSelect.init(selectContainer);
        updateFilterInfos();
    } catch(e) { console.warn('Restore filters error', e); }
}

function setSelectValues(selectEl, values){
    if (!selectEl || !values) return;
    Array.from(selectEl.options).forEach(opt => { opt.selected = values.includes(opt.value); });
}

function selectAllOptions(selectEl){
    if (!selectEl) return;
    Array.from(selectEl.options).forEach(opt => { if (!opt.disabled) opt.selected = true; });
    // Réinitialiser Materialize pour mettre à jour l'affichage visuel
    M.FormSelect.init(selectEl);
    onSelectionChangedDebounced();
    updateFilterInfos();
}

function deselectAllOptions(selectEl){
    if (!selectEl) return;
    Array.from(selectEl.options).forEach(opt => { opt.selected = false; });
    
    // Pour les selects avec placeholder, sélectionner le placeholder quand tout est vide
    const placeholderOption = selectEl.querySelector('option[disabled][value=""]');
    if (placeholderOption) {
        placeholderOption.selected = true;
    }
    
    // Réinitialiser Materialize pour mettre à jour l'affichage visuel
    M.FormSelect.init(selectEl);
    onSelectionChangedDebounced();
    updateFilterInfos();
}

// Mise à jour des informations sous chaque filtre et surbrillance "TOUT"
function updateFilterInfos(){
    updateFilterInfoFor(selectType, infoType, btnAllType);
    updateFilterInfoFor(selectDifficulty, infoDifficulty, btnAllDifficulty);
    updateFilterInfoFor(selectTerrain, infoTerrain, btnAllTerrain);
    updateFilterInfoFor(selectContainer, infoContainer, btnAllContainer);
    // Country/State
    const selectCountryEl = document.getElementById('selectCountry');
    const selectStateEl = document.getElementById('selectState');
    const btnAllCountry = document.getElementById('btnAllCountry');
    const btnAllState = document.getElementById('btnAllState');
    const infoCountry = document.getElementById('infoCountry');
    const infoState = document.getElementById('infoState');
    updateFilterInfoFor(selectCountryEl, infoCountry, btnAllCountry);
    updateFilterInfoFor(selectStateEl, infoState, btnAllState);
}

function updateFilterInfoFor(selectEl, infoEl, btnAllEl){
    if (!selectEl || !infoEl) return;
    const all = areAllSelected(selectEl);
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
}

function areAllSelected(selectEl){
    const options = Array.from(selectEl.options).filter(opt => !opt.disabled && opt.value !== '');
    const selected = options.filter(opt => opt.selected);
    return options.length > 0 && selected.length === options.length;
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
                sheetWidth: 1800,
                sheetHeight: 200,
                items: [
                    { key: 'trad',    x:   0, y:  0, w:50, h:50, label: 'Traditional' },
                    { key: 'ape',   x:  100, y:  0, w:50, h:50, label: 'APE' },
                    { key: 'hq',    x:  200, y:  0, w:50, h:50, label: 'HQ' },
                    { key: 'multi',  x:  300, y:  0, w:50, h:50, label: 'Multi' },
                    { key: 'event',   x: 400, y:  0, w:50, h:50, label: 'Event' },
                    { key: 'cito',    x: 500, y:  0, w:50, h:50, label: 'CITO' },
                    { key: 'mega',    x: 600, y:  0, w:50, h:50, label: 'Mega' },
                    { key: 'giga',   x: 700, y:  0, w:50, h:50, label: 'Giga' },
                    { key: 'maze',    x: 800, y:  0, w:50, h:50, label: 'GPS Maze' },
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
        case 'cercle':
            // Mode vectoriel cercle: ne pas utiliser de sprite, mais basculer le mode/shape
            pkg.options.point.mode = 'vectoriel';
            pkg.options.point.shape = 'circle';
            pkg.refreshPoints(pkg.options);
            // Effacer le preview d'icônes car non pertinent
            iconPreview.innerHTML = '';
            return;
        case 'triangle':
            // Mode vectoriel triangle
            pkg.options.point.mode = 'vectoriel';
            pkg.options.point.shape = 'triangle';
            pkg.refreshPoints(pkg.options);
            iconPreview.innerHTML = '';
            return;
    }

    if (useSprite && spriteMeta) {
        // Rendu via sprite atlas
        iconPreview.innerHTML = spriteMeta.items.map((it) => `
            <div class="icon-item" data-icon="${it.key}" onclick="selectSpriteIcon('${it.key}')">
                <div class="icon-sprite" style="
                    background-image:url('${spriteMeta.url}');
                    background-position:-${it.x}px -${it.y}px;
                    width:${it.w}px; height:${it.h}px;
                    background-size:${spriteMeta.sheetWidth}px ${spriteMeta.sheetHeight}px;
                "></div>
                <div class="icon-label">${it.label}</div>
            </div>
        `).join('');

        // Sauvegarder la meta pour le rendu carte
        pkg.options.point.mode = 'icone';
        pkg.options.point.iconSet = 'geocaching';
        pkg.options.point.sprite = {
            url: spriteMeta.url,
            sheetWidth: spriteMeta.sheetWidth,
            sheetHeight: spriteMeta.sheetHeight,
            map: Object.fromEntries(spriteMeta.items.map(it => [it.key, {x:it.x,y:it.y,w:it.w,h:it.h}]))
        };

        // Restaure sélection
        const current = pkg.options?.point?.iconKey || spriteMeta.items[0].key;
        selectSpriteIcon(current);
    }
}

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
    console.log('Changement de style Toner:', styleName);

    let style;
    if (styleName === "stamenTonerDark"){
        style = "dark";
        console.log('Style sombre sélectionné');
    } else if (styleName === "stamenTonerLight"){
        style = "light";
        console.log('Style clair sélectionné');
    } else {
        console.warn('Style non reconnu:', styleName);
        return;
    }

    // Mettre à jour les options
    pkg.options.map.stamenToner.type = style;
    console.log('Options mises à jour:', pkg.options.map.stamenToner);

    // Changer l'apparence des boutons
    changeButtonsStamenToner(style);

    // Rafraîchir la carte
    pkg.refreshStamenTonerMap(pkg.options.map.stamenToner);
    console.log('Carte rafraîchie');
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
    console.log('Affichage des options Toner avec animation');

    if (divTonerMapOptions) {
        divTonerMapOptions.style.display = 'block';
        divTonerMapOptions.classList.add('show');
        console.log('Options Toner affichées avec animation');
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
        console.log('[LOADER] openModalLoading créé:', !!currentLoadingToast, currentLoadingToast);
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
    // Mettre à jour le toast actuel si existant
    if (currentLoadingToast) {
        const titleElement = currentLoadingToast.querySelector('.toast-title, .gcm-toast-title');
        const messageElement = currentLoadingToast.querySelector('.toast-message, .gcm-toast-message');
        if (titleElement) titleElement.textContent = title;
        if (messageElement) messageElement.textContent = description;
        console.log('[LOADER] updateTextsModal ok');
    } else {
        console.warn('[LOADER] updateTextsModal sans loader');
    }
}

export function closeModalLoading(){
    // Fermer le toast de chargement
    if (currentLoadingToast) {
        try { pkg.hideToast(currentLoadingToast); } catch(e) { try { currentLoadingToast.remove(); } catch(_) {} }
        currentLoadingToast = null;
        console.log('[LOADER] closeModalLoading');
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
        console.log('[LOADER] updateProgressBar:', data.progress);
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
    console.log("updateTextsModalInfos:", title, description);
}

export function closeModalInfos(){
    // Cette fonction n'est plus nécessaire avec les toasts
    // Les toasts se ferment automatiquement ou manuellement
}



// ----------------- ANIMATION DE LA CARTE ----------------

// Affichage boutons principaux
function showStartRecordButtons(){
    console.log("=== showStartRecordButtons ===");
    const btnStart = document.getElementById('btnStartAnimation');
    const btnRecord = document.getElementById('btnRecordAnimation');
    const btnPause = document.getElementById('btnPauseAnimation');
    const btnStop = document.getElementById('btnStopAnimation');
    if (!btnStart || !btnRecord || !btnPause || !btnStop) {
        console.log("❌ Boutons manquants:", {btnStart: !!btnStart, btnRecord: !!btnRecord, btnPause: !!btnPause, btnStop: !!btnStop});
        return;
    }

    console.log("Configuration boutons principaux:");
    console.log("  Start avant:", window.getComputedStyle(btnStart).display);
    console.log("  Record avant:", window.getComputedStyle(btnRecord).display);
    console.log("  Pause avant:", window.getComputedStyle(btnPause).display);
    console.log("  Stop avant:", window.getComputedStyle(btnStop).display);

    btnStart.style.setProperty('display', 'inline-block', 'important');
    btnRecord.style.setProperty('display', 'inline-block', 'important');
    btnPause.style.setProperty('display', 'none', 'important');
    btnStop.style.setProperty('display', 'none', 'important');

    console.log("  Start après:", window.getComputedStyle(btnStart).display);
    console.log("  Record après:", window.getComputedStyle(btnRecord).display);
    console.log("  Pause après:", window.getComputedStyle(btnPause).display);
    console.log("  Stop après:", window.getComputedStyle(btnStop).display);
}

function showPauseStopButtons(){
    console.log("showPauseStopButtons")
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
    updateControlBar();
}

// Exposé pour remise à zéro depuis mapgl.js
export function resetControlsToInitialState(){
    try {
        console.log('[UI] resetControlsToInitialState()');
        // Boutons principaux
        showStartRecordButtons();
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
function toggleButtonAnimationPauseAndRestart(reinitialisation = false){ {
    const btnPauseAnimation = document.getElementById('btnPauseAnimation');
    const icon = btnPauseAnimation.querySelector('i.material-icons');

    if (btnPauseAnimation.classList.contains('pause') && !reinitialisation) {
        btnPauseAnimation.classList.remove('pause');
        btnPauseAnimation.classList.add('restart');
        btnPauseAnimation.childNodes[2].nodeValue = "Continue";  // Mettre à jour le texte
        icon.textContent = 'chevron_right';  // Mettre à jour l'icône
        pkg.stopAnimation();
    } else if (btnPauseAnimation.classList.contains('restart') || reinitialisation) {
        btnPauseAnimation.classList.remove('restart');
        btnPauseAnimation.classList.add('pause');
        btnPauseAnimation.childNodes[2].nodeValue = "Pause";  // Mettre à jour le texte
        icon.textContent = 'pause';  // Mettre à jour l'icône
        if (!reinitialisation) {
            pkg.startAnimation("restart");
            }
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
            console.log('Durée délockée - utilisateur a modifié la durée par jour');
        }
        updateTotalTime();
    } else if (event.target.id == 'inputTotalTime'){
        // Si l'utilisateur change le temps total manuellement, délocker la durée audio
        if (isDurationLockedToAudio) {
            isDurationLockedToAudio = false;
            updateDurationLockIndicator();
            console.log('Durée délockée - utilisateur a modifié le temps total');
        }
        updateTimePerDay();
    }

    // mise à jour du nombre de chiffre pour l'enregistrement des images
    pkg.updateInfosForPictures();
}

export function updateAnimationMenuAfterReadBdd(metadata){
    spanDeltaDays.innerText = metadata.deltaDays;
    updateTotalTime();
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
        }

        // Mettre à jour les informations pour les images
        pkg.updateInfosForPictures();
    }
}

function updateTotalTime(){
    const totalTimeInMilliSec = pkg.metadata.deltaDays * inputTimePerDay.value
    console.log("totalTimeInMilliSec", totalTimeInMilliSec)
    // mise à jour du temps en ms pour futurs calculs
    pkg.options.record.totalTimeInMilliSec = totalTimeInMilliSec;

    // Ne pas modifier le temps total si la durée est lockée à la musique
    if (!isDurationLockedToAudio) {
        inputTotalTime.value = (totalTimeInMilliSec / 60 / 1000).toFixed(2);
        updateToMinutesAndSeconds();
    }
}

function updateTimePerDay(){
    const timePerDay = Math.floor(inputTotalTime.value / pkg.metadata.deltaDays * 60 * 1000) ;
    pkg.options.animation.timePerDay = timePerDay;
    inputTimePerDay.value = timePerDay;
    // Mettre à jour le temps total en millisecondes pour les calculs futurs
    pkg.options.record.totalTimeInMilliSec = inputTotalTime.value * 60 * 1000;
    // Mettre à jour l'affichage des minutes/secondes
    updateToMinutesAndSeconds();
}

function updateToMinutesAndSeconds(){
    const time = pkg.convertToMinutesAndSeconds(inputTotalTime.value);
    spanTotalTimeMinutes.innerText = time.minutes;
    spanTotalTimeSeconds.innerText = time.seconds;
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
        console.log(data); // Traiter la réponse de Django
        if(data.success) {
            // Mettre à jour l'interface utilisateur en conséquence
            console.log(data)
        }
    })
    .catch(error => console.error('Erreur:', error));
}

function assemble_pictures_directory(){
    fetch('/assemble_pictures_directory', {
        method: 'POST', 
        headers: {
            'X-CSRFToken': pkg.getCookie('csrftoken'), 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'assembler' }),
    })
    .then(response => response.json())
    .then(data => {
        console.log(data); // Traiter la réponse de Django
        if(data.success) {
            // Mettre à jour l'interface utilisateur en conséquence
            console.log(data)
        }
    })
    .catch(error => console.error('Erreur:', error));
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

    // Mettre à jour immédiatement l'état des éléments DOM selon les paramètres
    updateOverlayElementsVisibility();

    console.log(event.target)

    // ----- TITRE -----

    // création / destruction du la Frame Titre
    if (event.target.id == "cbDisplayTitle" && event.target.checked) {
        console.log("cbDisplayTitle")
        pkg.createTitleFrame();
    } else if (event.target.id == "cbDisplayTitle" && !event.target.checked) {
        pkg.destroyTitleFrame();
    }

    // changement texte titre
    if (event.target.id == "inputTitle") {
        console.log("inputTitle")
        pkg.updateTitleFrame(event.target.value);
    }

    // ------- INFOS -----
    // Nombre caches
    if (event.target.id == "cbDisplayNumberofCaches" && event.target.checked) {
        // réaffiche span Caches
        spanNbCaches.style.display = "inline";
        pkg.createInfosFrame("number");
    } else if (event.target.id == "cbDisplayCurrentDate" && event.target.checked) {
        // Date
        // reaffiche span Date
        spanCurrentDate.style.display = "inline";
        pkg.createInfosFrame("date");
    } else if ((event.target.id == "cbDisplayNumberofCaches" || event.target.id == "cbDisplayCurrentDate" )
        && (!cbDisplayNumberofCaches.checked && !cbDisplayCurrentDate.checked)) {
        // fermeture si les deux sont desactivés
        pkg.destroyInfosFrame();
    }

    // efface span Date ou Nombre de Caches si demandé indifférement de la Frame global
    if (event.target.id == "cbDisplayNumberofCaches" && !event.target.checked) {
        spanNbCaches.style.display = "none";
    } else if (event.target.id == "cbDisplayCurrentDate" && !event.target.checked) {
        console.log("cbDisplayCurrentDate")
        spanCurrentDate.style.display = "none";
    }

}

// Fonction pour synchroniser la visibilité des éléments DOM avec les paramètres utilisateur
function updateOverlayElementsVisibility() {
    try {
        // Gérer le titre
        const titleFrame = document.getElementById('titleFrame');
        if (titleFrame) {
            if (pkg.options.infos?.title?.display === true) {
                titleFrame.style.display = 'block';
            } else {
                titleFrame.style.display = 'none';
            }
        }

        // Gérer les infos (date + nombre de caches)
        const infosFrame = document.getElementById('infosFrame');
        const shouldShowInfos = pkg.options.infos?.currentDate?.display === true ||
                               pkg.options.infos?.numberOfCaches?.display === true;

        if (infosFrame) {
            if (shouldShowInfos) {
                infosFrame.style.display = 'block';
            } else {
                infosFrame.style.display = 'none';
            }
        }

        console.log('[OVERLAY] Visibilité mise à jour:', {
            title: pkg.options.infos?.title?.display,
            date: pkg.options.infos?.currentDate?.display,
            caches: pkg.options.infos?.numberOfCaches?.display,
            titleFrame: titleFrame?.style.display,
            infosFrame: infosFrame?.style.display
        });
    } catch(e) {
        console.warn('Erreur updateOverlayElementsVisibility:', e);
    }
}

// fenetre css pour le titre. Le htmx charge tout le css avec également le #inputTitleCss {...} il faut donc le supprimer.
// Comme changement impossible directement dans htmx (sauf à ajouter une adresse qui gère le chargement du css) on intercepte le changement
// fait par le htmx et on le met à jour dans le textarea
// Suppression des accolades et des espace en débuts de ligne
document.addEventListener('htmx:afterSwap', function(event) {
    if (event.target.id === 'inputTitleCss' || event.target.id === 'inputInfosCss') {
        const cssContent = event.target.value;
        // Utiliser une expression régulière pour extraire le contenu entre les premières accolades trouvées
        const match = cssContent.match(/\{([\s\S]*?)\}/);
        if (match && match[1]) {
            // Supprimer les espaces en début de chaque ligne
            const cleanedCss = match[1].replace(/^\s*/gm, '');
            // Mettre à jour le contenu du textarea avec le CSS nettoyé
            event.target.value = cleanedCss.trim();
        }
    }
});

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

        // Redimensionner la carte pour prendre tout l'espace
        mapElement.style.height = 'calc(100vh - 60px)';
        mapElement.style.width = '100vw';

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

    // Restaurer la taille normale de la carte
    mapElement.style.height = '600px';
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
    if (fullscreenButtonActive) {
        // Mode plein écran actif
        btnFullscreenMode.classList.remove('grey');
        btnFullscreenMode.classList.add('blue');
        if (icon) icon.textContent = 'fullscreen_exit';
        btnFullscreenMode.title = 'Quitter le plein écran';
    } else {
        // Mode normal
        btnFullscreenMode.classList.remove('blue');
        btnFullscreenMode.classList.add('grey');
        if (icon) icon.textContent = 'fullscreen';
        btnFullscreenMode.title = 'Passer en plein écran';
    }
}

function updateControlBar() {
    console.log("=== updateControlBar ===");
    const controlBar = document.getElementById('controlBar');
    const btnStartBar = document.getElementById('btnStartBar');
    const btnRecordBar = document.getElementById('btnRecordBar');
    const btnPauseBar = document.getElementById('btnPauseBar');
    const btnStopBar = document.getElementById('btnStopBar');
    const btnToggleFullscreen = document.getElementById('btnToggleFullscreen');
    const btnStartAnimation = document.getElementById('btnStartAnimation');
    const btnPauseAnimation = document.getElementById('btnPauseAnimation');
    const btnStopAnimation = document.getElementById('btnStopAnimation');

    console.log("Boutons trouvés:", {
        controlBar: !!controlBar,
        btnStartBar: !!btnStartBar,
        btnRecordBar: !!btnRecordBar,
        btnPauseBar: !!btnPauseBar,
        btnStopBar: !!btnStopBar,
        btnToggleFullscreen: !!btnToggleFullscreen,
        btnStartAnimation: !!btnStartAnimation
    });

    if (!controlBar) {
        console.log("❌ controlBar non trouvé");
        return;
    }

    // Déterminer l'état courant : vérifier si Start est visible (état repos)
    let isIdle = false;
    if (btnStartAnimation && window.getComputedStyle(btnStartAnimation).display !== 'none') {
        isIdle = true;
    }

    console.log("État détecté:", {
        isIdle: isIdle,
        btnStartAnimation_display: btnStartAnimation ? window.getComputedStyle(btnStartAnimation).display : 'null',
        btnPauseAnimation_display: btnPauseAnimation ? window.getComputedStyle(btnPauseAnimation).display : 'null',
        btnStopAnimation_display: btnStopAnimation ? window.getComputedStyle(btnStopAnimation).display : 'null'
    });

    // Gestion des boutons selon l'état
    console.log("Configuration des boutons de la barre latérale:");
    if (isIdle) {
        console.log("  Mode IDLE: afficher Start/Record, masquer Pause/Stop");
        // État repos -> afficher Start/Record, masquer Pause/Stop
        if (btnStartBar) {
            console.log("    btnStartBar avant:", window.getComputedStyle(btnStartBar).display);
            btnStartBar.style.setProperty('display', 'flex', 'important');
            console.log("    btnStartBar après:", window.getComputedStyle(btnStartBar).display);
        }
        if (btnRecordBar) {
            console.log("    btnRecordBar avant:", window.getComputedStyle(btnRecordBar).display);
            btnRecordBar.style.setProperty('display', 'flex', 'important');
            console.log("    btnRecordBar après:", window.getComputedStyle(btnRecordBar).display);
        }
        if (btnPauseBar) {
            console.log("    btnPauseBar avant:", window.getComputedStyle(btnPauseBar).display);
            btnPauseBar.style.setProperty('display', 'none', 'important');
            console.log("    btnPauseBar après:", window.getComputedStyle(btnPauseBar).display);
        }
        if (btnStopBar) {
            console.log("    btnStopBar avant:", window.getComputedStyle(btnStopBar).display);
            btnStopBar.style.setProperty('display', 'none', 'important');
            console.log("    btnStopBar après:", window.getComputedStyle(btnStopBar).display);
        }
    } else {
        console.log("  Mode RUNNING: masquer Start/Record, afficher Pause/Stop");
        // Animation/enregistrement en cours -> masquer Start/Record, afficher Pause/Stop
        if (btnStartBar) {
            console.log("    btnStartBar avant:", window.getComputedStyle(btnStartBar).display);
            btnStartBar.style.setProperty('display', 'none', 'important');
            console.log("    btnStartBar après:", window.getComputedStyle(btnStartBar).display);
        }
        if (btnRecordBar) {
            console.log("    btnRecordBar avant:", window.getComputedStyle(btnRecordBar).display);
            btnRecordBar.style.setProperty('display', 'none', 'important');
            console.log("    btnRecordBar après:", window.getComputedStyle(btnRecordBar).display);
        }
        if (btnPauseBar) {
            console.log("    btnPauseBar avant:", window.getComputedStyle(btnPauseBar).display);
            btnPauseBar.style.setProperty('display', 'flex', 'important');
            console.log("    btnPauseBar après:", window.getComputedStyle(btnPauseBar).display);
        }
        if (btnStopBar) {
            console.log("    btnStopBar avant:", window.getComputedStyle(btnStopBar).display);
            btnStopBar.style.setProperty('display', 'flex', 'important');
            console.log("    btnStopBar après:", window.getComputedStyle(btnStopBar).display);
        }
    }

    // Toujours afficher le bouton pour basculer plein écran quand la barre est visible
    if (btnToggleFullscreen) {
        btnToggleFullscreen.style.display = 'flex';
        const iconToggle = btnToggleFullscreen.querySelector('i');
        const isFs = document.querySelector('main').classList.contains('fullscreen-mode');
        if (iconToggle) iconToggle.textContent = isFs ? 'fullscreen_exit' : 'fullscreen';
        btnToggleFullscreen.title = isFs ? 'Quitter le plein écran' : 'Passer en plein écran';
    }

    // Synchroniser l'icône Pause/Play
    if (btnPauseBar && btnPauseAnimation) {
        const isPaused = btnPauseAnimation.classList.contains('restart');
        const icon = btnPauseBar.querySelector('i');
        if (isPaused) {
            btnPauseBar.classList.add('green');
            btnPauseBar.classList.remove('yellow', 'darken-2');
            if (icon) icon.textContent = 'play_arrow';
        } else {
            btnPauseBar.classList.remove('green');
            btnPauseBar.classList.add('yellow', 'darken-2');
            if (icon) icon.textContent = 'pause';
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

        // Ajouter la tooltip Materialize
        element.setAttribute('data-tooltip', tooltipContent);
        element.classList.add('tooltipped');
        if (typeof M !== 'undefined' && M.Tooltip) {
            M.Tooltip.init(element, {
                html: true,
                position: 'top',
                margin: 5
            });
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

    // Créer le contenu HTML de la modal Materialize
    const modalHTML = `
        <div id="${modalId}" class="modal">
            <div class="modal-content">
                <h4 class="center-align">${title}</h4>
                ${message}
            </div>
            <div class="modal-footer">
                <a href="#!" class="modal-close waves-effect waves-red btn-flat">${cancelText}</a>
                <a href="#!" id="confirm-language-change" class="waves-effect waves-green btn">${confirmText}</a>
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

    // Initialiser et ouvrir la modal Materialize
    const modalElement = document.getElementById(modalId);
    const modalInstance = M.Modal.init(modalElement, {
        dismissible: false, // Empêcher la fermeture en cliquant à l'extérieur
        onCloseEnd: function() {
            // Nettoyer la modal du DOM après fermeture
            modalElement.remove();
        }
    });

    // Gérer le clic sur le bouton de confirmation
    document.getElementById('confirm-language-change').addEventListener('click', function() {
        modalInstance.close();
        // Recharger la page avec le paramètre de langue et préserver l'onglet actif
        const url = new URL(window.location);
        url.searchParams.set('lang', newLanguage);

        // Récupérer l'onglet actif actuel et l'ajouter à l'URL
        const activeTab = localStorage.getItem('activeTab');
        if (activeTab && activeTab !== 'data') { // 'data' est l'onglet par défaut
            url.hash = activeTab;
        }

        // Recharger la page avec la nouvelle langue
        window.location.href = url.toString();
    });

    // Ouvrir la modal
    modalInstance.open();
}