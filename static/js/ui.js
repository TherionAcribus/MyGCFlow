import * as pkg from './index.js';

// MENU BDD

// select BDD
const selectType = document.getElementById('selectType');
selectType.addEventListener('change', changeSelection);
const selectTerrain = document.getElementById('selectTerrain');
selectTerrain.addEventListener('change', changeSelection);
const selectDifficulty = document.getElementById('selectDifficulty');
selectDifficulty.addEventListener('change', changeSelection);
const selectContainer = document.getElementById('selectContainer');
selectContainer.addEventListener('change', changeSelection);
// datepicker
const datePickerStart = document.getElementById('datePickerStart');
const datePickerEnd = document.getElementById('datePickerEnd');
datePickerStart.addEventListener('change', changeSelection);
datePickerEnd.addEventListener('change', changeSelection);


// MENU CARTES

// boutons pour le choix des cartes
const btnOSM = document.getElementById('OSM');
const btnWatercolor = document.getElementById('watercolor');
const btnStamenToner = document.getElementById('stamenToner');
const btnVectorMap = document.getElementById('vectorMap');

// sous menu pour le choix des cartes
const divVectorMapOptions = document.getElementById('vectorMapOptions');
const divTonerMapOptions = document.getElementById('tonerMapOptions');
const btnStamenTonerLight = document.getElementById('stamenTonerLight');
const btnStamenTonerDark = document.getElementById('stamenTonerDark');

// Champs pour les options de la carte vectorielle
const cpStrokeColor = document.getElementById('fieldVectorMapStrokeColor');
cpStrokeColor.addEventListener('change', changecpStrokeColor);
const cpFillColor = document.getElementById('fieldVectorMapFillColor');
cpFillColor.addEventListener('change', changecpfillColor);
const cpBackgroundColor = document.getElementById('fieldVectorMapBackgroundColor');
cpBackgroundColor.addEventListener('change', changecpBackgroundColor);
const strokeWidth = document.getElementById('fieldVectorMapStrokeWidth');
strokeWidth.addEventListener('change', changestrokeWidth);

// Champs pour les options de la carte Toner Stamen
const tonerStyleElements = document.getElementsByClassName("changeTonerStyle");
Array.from(tonerStyleElements).forEach(function(element) {
    element.addEventListener("click", changeStamenTonerStyle);
});


// POINTS
// Colorpickers
// --- in
const cpPointCenterColor = document.getElementById('pointCenterColor');
cpPointCenterColor.addEventListener('change', changePointStyleUI);
// -- out
const cpPointBorderColor = document.getElementById('pointBorderColor');
cpPointBorderColor.addEventListener('change', changePointStyleUI);
// Radio buttons
// --- in
const radioFillColorPoint = document.getElementsByName('fillColorPoint');
radioFillColorPoint.forEach(radio => {
    radio.addEventListener('change', () => changePointStyleUI(radio));
});
// -- out
const radioborderColorPoint = document.getElementsByName('borderColorPoint');
radioborderColorPoint.forEach(radio => {
    radio.addEventListener('change', () => changePointStyleUI(radio));
});
// sliders et input associé
// --- in
const sliderSizePoint = document.getElementById('sliderSizePoint');
const inputSizePoint = document.getElementById('inputSizePoint');
sliderSizePoint.addEventListener('change', changePointStyleUI);
inputSizePoint.addEventListener('change', changePointStyleUI);
// -- out
const sliderSizeBorder = document.getElementById('sliderSizeBorder');
const inputSizeBorder = document.getElementById('inputSizeBorder');
sliderSizeBorder.addEventListener('change', changePointStyleUI);
inputSizeBorder.addEventListener('change', changePointStyleUI);


// ANIMATION DE LA CARTE
// Boutons
const btnStartAnimation = document.getElementById('btnStartAnimation');
btnStartAnimation.addEventListener('click', clickStartAnimation);
const btnRecordAnimation = document.getElementById('btnRecordAnimation');
btnRecordAnimation.addEventListener('click', clickRecordAnimation);
const inputTimePerDay = document.getElementById('inputTimePerDay');
inputTimePerDay.addEventListener('input', changeAnimationValues);
// jours sans caches
const cbDisplayDaysWithoutCache = document.getElementById('cbDisplayDaysWithoutCache');
cbDisplayDaysWithoutCache.addEventListener('change', changeAnimationValues);
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


// FLASH
// radio buttons
const radioflashMode = document.getElementsByName('flashMode');
radioflashMode.forEach(radio => {
    radio.addEventListener('change', () => changeFlashValues(radio));
});
// inputs
const inputTimeFlash = document.getElementById('inputTimeFlash');
inputTimeFlash.addEventListener('input', changeFlashValues);
const inputSizeFlash = document.getElementById('inputSizeFlash');
inputSizeFlash.addEventListener('input', changeFlashValues);
// colorpickers
const cpFlashColor = document.getElementById('flashColor');
cpFlashColor.addEventListener('change', changeFlashValues);

// INFOS 
// checkboxes
const cbDisplayTitle = document.getElementById('cbDisplayTitle');
cbDisplayTitle.addEventListener('change', changeInfosValues);
const cbDisplayNumberofCaches = document.getElementById('cbDisplayNumberofCaches');
cbDisplayNumberofCaches.addEventListener('change', changeInfosValues);
const cbDisplayCurrentDate = document.getElementById('cbDisplayCurrentDate');
cbDisplayCurrentDate.addEventListener('change', changeInfosValues);
// inputs
const inputTitle = document.getElementById('inputTitle');
inputTitle.addEventListener('input', changeInfosValues);
// textareas
const inputTitleCss = document.getElementById('inputTitleCss');
const inputInfosCss = document.getElementById('inputInfosCss');
// boutons
const btnTitleCss = document.getElementById('btnTitleCss');
const btnInfosCss = document.getElementById('btnInfosCss');
btnTitleCss.addEventListener('click', () => {
    pkg.changeTitleCssValues(inputTitleCss.value);
});
btnInfosCss.addEventListener('click', () => {
    pkg.changeInfosCssValues(inputInfosCss.value);
});
// Spans dans Frame Infos
const spanNbCaches = document.getElementById('spanNbCaches');
const spanCurrentDate = document.getElementById('spanCurrentDate');


// OPTIONS 
const switchEngine = document.getElementById('switchEngine');
switchEngine.addEventListener('change', changeEngine);


// initialisation les éléments des options par défaut
export function init_ui() {
    // ---------- OPTIONS ------------------
    // switch 2D/3D
    if (pkg.options.options.engine === "webgl") {
        switchEngine.checked = true;
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
    
    // ------- ANIMATION DE LA CARTE -------   
    // Inputs
    inputTimePerDay.value = pkg.options.animation.timePerDay;
    cbDisplayDaysWithoutCache.checked = pkg.options.animation.displayDaysWithoutCache;

    // ------- FLASH -------
    // colorpicker
    cpFlashColor.value = pkg.options.flash.color;
    // inputs
    inputTimeFlash.value = pkg.options.flash.duration;
    inputSizeFlash.value = pkg.options.flash.size;
    // radio buttons
    for (let radio of radioflashMode) {
        if (radio.value === pkg.options.flash.mode) {
            radio.checked = true;
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
    cpStrokeColor.value = pkg.options.map.vectorMap.strokeColor;
    // couleur de remplissage par défaut
    cpFillColor.value = pkg.options.map.vectorMap.fillColor;
    // couleur de fond par défaut
    cpBackgroundColor.value = pkg.options.map.vectorMap.background;
    // largeur de trait par défaut
    strokeWidth.value = pkg.options.map.vectorMap.strokeWidth;
    // ------- CARTE TONER -------
    // deselectionne le bouton par défaut
    changeButtonsStamenToner(pkg.options.map.stamenToner.type);
}


// ----------- OPTIONS DE L'APP ------------

// passe de 2D à 3D et inversement
function changeEngine() {
    let engine = switchEngine.checked ? "webgl" : "2D";
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshPoints(optionsValues); 
}



// ----------- BDD ------------

// Filtres

// synchronise les dates de selection des pickers avec BDD
export function setPickerDates(metadata) {
    const startDateElement = document.querySelector('#datePickerStart');
    const endDateElement = document.querySelector('#datePickerEnd');

    const startDatePicker = M.Datepicker.getInstance(startDateElement);
    const endDatePicker = M.Datepicker.getInstance(endDateElement);

    const formattedStartDate = formatDateForPickers(metadata.startDate);
    const formattedEndDate = formatDateForPickers(metadata.endDate);

    startDatePicker.setDate(metadata.startDate, true);
    endDatePicker.setDate(metadata.endDate, true);

    startDateElement.value = formattedStartDate;
    endDateElement.value = formattedEndDate;
}

function formatDateForPickers(date) {
    const options = { day: '2-digit', month: '2-digit', year: 'numeric', };
    return new Date(date).toLocaleDateString('fr-CA', options);
}

// si on modifie un élement de la selection, on filtre et rafraichit
function changeSelection(event){
    console.log(event.target)
    let selectedValues = {};
    selectedValues["type"] = Array.from(selectType.selectedOptions).map(option => option.value);
    selectedValues["terrain"] = Array.from(selectTerrain.selectedOptions).map(option => option.value);
    selectedValues["difficulty"] = Array.from(selectDifficulty.selectedOptions).map(option => option.value);
    selectedValues["container"] = Array.from(selectContainer.selectedOptions).map(option => option.value);
    selectedValues["dates"] = {startDate: document.querySelector('#datePickerStart').value, endDate: document.querySelector('#datePickerEnd').value};

    pkg.changeSelect(selectedValues, pkg.options);
}



// ----------- POINTS ------------

// recupère tous les changements liés aux points
function changePointStyleUI(event){
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
    // sliders
    pkg.options.point.center.size = inputSizePoint.value
    pkg.options.point.border.size = inputSizeBorder.value

    // rafraichissement des points
    pkg.refreshPoints(pkg.options);
}

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


// ---------------- CARTE TONER -------------------

function changeStamenTonerStyle(e){
    // comme il y a un bouton avec plusieurs layers, il faut remonter dans les éléments parent pour trouver le layer du bouton
    let targetElement = e.target;
        while (targetElement != null && !targetElement.classList.contains("changeTonerStyle")) {
            targetElement = targetElement.parentElement;
        }
            // Si un élément avec 'changeMap' a été trouvé, récupérer son ID
        if (targetElement) {
            let styleName = targetElement.id;
            let style;
            if (styleName == "stamenTonerDark"){
                style = "dark"
            } else if (styleName == "stamenTonerLight"){
                style = "light"
            }
            pkg.options.map.stamenToner.type = style;

            // change boutons
            changeButtonsStamenToner(style);          
            // rafraichit carte
            pkg.refreshStamenTonerMap(pkg.options.map.stamenToner);
        }
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
    // TODO quand existera : on efface tous les autres sous menu
    // on affiche le sous menu
    divVectorMapOptions.style.display = 'block';
    divTonerMapOptions.style.display = 'none';
    // on reaffiche tous les boutons
    unSelectAllMapsButtons();
    // on selectionne (disables) le bouton de la carte en question
    btnVectorMap.classList.add('disabled');
}

export function selectOSMMapMenu(){
    divVectorMapOptions.style.display = 'none';
    divTonerMapOptions.style.display = 'none';
    unSelectAllMapsButtons();
    btnOSM.classList.add('disabled');
}

export function selectWatercolorMapMenu(){
    divVectorMapOptions.style.display = 'none';
    divTonerMapOptions.style.display = 'none';
    unSelectAllMapsButtons();
    btnWatercolor.classList.add('disabled');
}

export function selectStamenTonerMapMenu(){
    divTonerMapOptions.style.display = 'block';
    divVectorMapOptions.style.display = 'none';
    unSelectAllMapsButtons();
    btnStamenToner.classList.add('disabled');
}

// permet de deselectionner tous les boutons de cartes avant de reselectionner le bon
function unSelectAllMapsButtons(){
    btnOSM.classList.remove('disabled');
    btnWatercolor.classList.remove('disabled');
    btnStamenToner.classList.remove('disabled');
    btnVectorMap.classList.remove('disabled');
}


// ----------------- MODAL CHARGEMENT ----------------

export function openModalLoading(title, description){
    const instance = M.Modal.getInstance(document.getElementById('modal_loading'));
    instance.open();
    updateTextsModal(title, description);
}

// changement du titre et de la description de la modale
export function updateTextsModal(title, description){
    const modalTitle = document.getElementById('modalTitle');
    const modalDescription = document.getElementById('modalDescription');
    modalTitle.innerText = title;
    modalDescription.innerText = description;
}

export function closeModalLoading(){
    const instance = M.Modal.getInstance(document.getElementById('modal_loading'));
    instance.close();
}

export function updateProgressBar(data) {
    // Mets à jour l'avancement de la barre de progression
    const progressBar = document.getElementById('progressBar');
    progressBar.style.width = data.progress + '%';
    const progressText = document.getElementById('progressText');
    progressText.innerText = data.message;
}


// MODAL INFOS / ERREURS
export function openModalnfos(title, description){
    const instance = M.Modal.getInstance(document.getElementById('modal_infos'));
    instance.open();
    updateTextsModalInfos(title, description);
}

// changement du titre et de la description de la modale
export function updateTextsModalInfos(title, description){
    const modalTitle = document.getElementById('modalInfosTitle');
    const modalDescription = document.getElementById('modalInfosDescription');
    modalTitle.innerText = title;
    modalDescription.innerText = description;
}

export function closeModalInfos(){
    const instance = M.Modal.getInstance(document.getElementById('modal_infos'));
    instance.close();
}



// ----------------- ANIMATION DE LA CARTE ----------------

function clickStartAnimation(){
    // Vide la source vectorielle avant de démarrer l'animation
    pkg.startAnimation();
}

function clickRecordAnimation(){
    // Vide la source vectorielle avant de démarrer l'animation
    pkg.recordAnimation();
}

// recupère tous les changements liés aux points
function changeAnimationValues(event){
    pkg.options.animation.displayDaysWithoutCache = cbDisplayDaysWithoutCache.checked;
    pkg.options.animation.timePerDay = inputTimePerDay.value;
    // mise à jour du nombre de chiffre pour l'enregistrement des images
    pkg.updateInfosForPictures();


    // mise à jour du temps de l'autre champs
    if (event.target.id == 'inputTimePerDay'){
        updateTotalTime();
    } else if (event.target.id == 'inputTotalTime'){
        updateTimePerDay();
    }

    // mise à jour du nombre de chiffre pour l'enregistrement des images
    pkg.updateInfosForPictures();

}

export function updateAnimationMenuAfterReadBdd(metadata){
    spanDeltaDays.innerText = metadata.deltaDays;
    updateTotalTime();
}

function updateTotalTime(){
    const totalTimeInMilliSec = pkg.metadata.deltaDays * inputTimePerDay.value
    console.log("totalTimeInMilliSec", totalTimeInMilliSec)
    // mise à jour du temps en ms pour futurs calculs
    pkg.options.record.totalTimeInMilliSec = totalTimeInMilliSec;
    inputTotalTime.value = (totalTimeInMilliSec / 60 / 1000).toFixed(2);
    updateToMinutesAndSeconds();
}

function updateTimePerDay(){
    const timePerDay = Math.floor(inputTotalTime.value / pkg.metadata.deltaDays * 60 * 1000) ;
    pkg.options.animation.timePerDay = timePerDay;
    inputTimePerDay.value = timePerDay;
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

    // radiobuttons
    if (event.type == "radio") {
        if (event.name == "flashMode"){
            pkg.options.flash.mode = event.value;
        }
    }
    // inputs
    pkg.options.flash.duration = inputTimeFlash.value
    pkg.options.flash.size = inputSizeFlash.value
    // colorpickers
    pkg.options.flash.color = cpFlashColor.value
}


// -------------------- INFOS AFFICHéEs -------------------
function changeInfosValues(event){

    pkg.options.infos.title.display = cbDisplayTitle.checked;
    pkg.options.infos.currentDate.display = cbDisplayCurrentDate.checked;
    pkg.options.infos.numberOfCaches.display = cbDisplayNumberofCaches.checked;

    console.log(event.target)

    // ----- TITRE -----

    // A METTRE DANS FRAME.JS !!!!!

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