import * as pkg from './index.js';
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
const btnStartAnimation = document.getElementById('btnStartAnimation');
btnStartAnimation.addEventListener('click', clickStartAnimation);
const btnRecordAnimation = document.getElementById('btnRecordAnimation');
btnRecordAnimation.addEventListener('click', clickRecordAnimation);
const inputTimePerDay = document.getElementById('inputTimePerDay');
inputTimePerDay.addEventListener('input', changeAnimationValues);
const cbDisplayDaysWithoutCache = document.getElementById('cbDisplayDaysWithoutCache');
cbDisplayDaysWithoutCache.addEventListener('change', changeAnimationValues);


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

// OPTIONS 
const switchEngine = document.getElementById('switchEngine');
switchEngine.addEventListener('change', changeEngine);


// initialisation les éléments des options par défaut
export function init_ui(optionsValues) {
    // ---------- OPTIONS ------------------
    // switch 2D/3D
    if (optionsValues.options.engine === "webgl") {
        switchEngine.checked = true;
    }
    // ---------- POINTS ------------------
    // colorpickers
    cpPointBorderColor.value = optionsValues.point.border.color;
    cpPointCenterColor.value = optionsValues.point.center.color;
    // radio buttons
    for (let radio of radioFillColorPoint) {
        if (radio.value === optionsValues.point.center.mode) {
            radio.checked = true;
            break;
        }
    }
    for (let radio of radioborderColorPoint) {
        console.log(radio)
        if (radio.value === optionsValues.point.border.mode) {
            radio.checked = true;
            break;
        }
    }
    // synchronise sliders et input associés
    synchronizeSliderAndInputCenter(optionsValues);
    synchronizeSliderAndInputBorder(optionsValues);
    
    // ------- ANIMATION DE LA CARTE -------   
    // Inputs
    inputTimePerDay.value = optionsValues.animation.timePerDay;
    cbDisplayDaysWithoutCache.checked = optionsValues.animation.displayDaysWithoutCache;

    // ------- FLASH -------
    // colorpicker
    cpFlashColor.value = optionsValues.flash.color;
    // inputs
    inputTimeFlash.value = optionsValues.flash.duration;
    inputSizeFlash.value = optionsValues.flash.size;
    // radio buttons
    for (let radio of radioflashMode) {
        if (radio.value === optionsValues.flash.mode) {
            radio.checked = true;
            break;
        }
    }
    // ------- INFOS -------
    // checkboxes
    cbDisplayTitle.checked = optionsValues.infos.title.display;
    cbDisplayNumberofCaches.checked = optionsValues.infos.numberOfCaches.display;
    cbDisplayCurrentDate.checked = optionsValues.infos.currentDate.display;
    // inputs
    inputTitle.value = optionsValues.infos.title.text;
    if (inputTitle.value != "My Geocaching Map") {
        // enlève le placeholder si un texte est enregistré
        M.updateTextFields();
    }
    // textAreas
    

    // ------- CARTE VECTORIELLE -------

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
    changeButtonsStamenToner(optionsValues.map.stamenToner.type);
}


// ----------- OPTIONS DE L'APP ------------

// passe de 2D à 3D et inversement
function changeEngine() {
    let engine = switchEngine.checked ? "webgl" : "2D";
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshPoints(optionsValues); 
}



// ----------- POINTS ------------

// recupère tous les changements liés aux points
function changePointStyleUI(event){
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    // colorpickers
    optionsValues.point.border.color = cpPointBorderColor.value;
    optionsValues.point.center.color = cpPointCenterColor.value;
    // radio buttons
    if (event.type == "radio") {
        if (event.name == "fillColorPoint"){
            optionsValues.point.center.mode = event.value;
        }
        else if (event.name == "borderColorPoint"){
            optionsValues.point.border.mode = event.value;
        }
    }
    // sliders
    optionsValues.point.center.size = inputSizePoint.value
    optionsValues.point.border.size = inputSizeBorder.value
    // stockage
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    // rafraichissement des points
    pkg.refreshPoints(optionsValues);
}

function synchronizeSliderAndInputCenter(optionsValues) {
    sliderSizePoint.oninput = function() {
        inputSizePoint.value = this.value;
    };

    // Mise à jour du slider lors de la modification de l'input number
    inputSizePoint.oninput = function() {
        sliderSizePoint.value = this.value;
    };

    // reglage des compteurs
    sliderSizePoint.value = optionsValues.point.center.size
    inputSizePoint.value = optionsValues.point.center.size
}


function synchronizeSliderAndInputBorder(optionsValues) {
    sliderSizeBorder.oninput = function() {
        inputSizeBorder.value = this.value;
    };

    // Mise à jour du slider lors de la modification de l'input number
    inputSizeBorder.oninput = function() {
        sliderSizeBorder.value = this.value;
    };

    // reglage des compteurs
    sliderSizeBorder.value = optionsValues.point.border.size
    inputSizeBorder.value = optionsValues.point.border.size
}


//  ------- CARTE VECTORIELLE -------
// TODO Faire comme pour les points : collecter tous les changements dans la même fonction

// changement de couleur de trait
function changecpStrokeColor() {
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    optionsValues.map.vectorMap.strokeColor = cpStrokeColor.value;
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshVectorMap(optionsValues.map.vectorMap);
}

// changement de couleur de remplissage
function changecpfillColor() {
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    optionsValues.map.vectorMap.fillColor = cpFillColor.value;
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshVectorMap(optionsValues.map.vectorMap);
}

// changement de couleur de fond
function changecpBackgroundColor() {
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    optionsValues.map.vectorMap.background = cpBackgroundColor.value;
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshVectorMap(optionsValues.map.vectorMap);
}

// changement de largeur de trait
function changestrokeWidth() {
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    optionsValues.map.vectorMap.strokeWidth = strokeWidth.value;
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));
    pkg.refreshVectorMap(optionsValues.map.vectorMap);
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
            let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
            optionsValues.map.stamenToner.type = style;
            localStorage.setItem('optionsValues', JSON.stringify(optionsValues));  
            // change boutons
            changeButtonsStamenToner(style);          
            // rafraichit carte
            pkg.refreshStamenTonerMap(optionsValues.map.stamenToner);
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

export function openModalLoading(){
    const instance = M.Modal.getInstance(document.getElementById('modal_loading'));
    instance.open();
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
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    // inputs
    optionsValues.animation.timePerDay = inputTimePerDay.value;
    // checkboxes
    optionsValues.animation.displayDaysWithoutCache = cbDisplayDaysWithoutCache.checked;

    // stockage
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));

    // POUR VOIR SI TOUT FONCTIONNE  !!! TEMP
    optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    console.log(optionsValues);
}


// ----------------- FLASH ----------------
// recupère tous les changements liés aux flashs
function changeFlashValues(event){
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));

    // radiobuttons
    if (event.type == "radio") {
        if (event.name == "flashMode"){
            optionsValues.flash.mode = event.value;
        }
    }
    // inputs
    optionsValues.flash.duration = inputTimeFlash.value
    optionsValues.flash.size = inputSizeFlash.value
    // colorpickers
    optionsValues.flash.color = cpFlashColor.value

    // stockage
    localStorage.setItem('optionsValues', JSON.stringify(optionsValues));

    // POUR VOIR SI TOUT FONCTIONNE  !!! TEMP
    optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    console.log(optionsValues);
}


// -------------------- INFOS AFFICHéEs -------------------
function changeInfosValues(event){
    let optionsValues = JSON.parse(localStorage.getItem('optionsValues'));
    console.log(event)

    optionsValues.infos.title.display = cbDisplayTitle.checked;
    optionsValues.infos.currentDate.display = cbDisplayCurrentDate.checked;
    optionsValues.infos.numberOfCaches.display = cbDisplayNumberofCaches.checked;

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
        console.log("cbDisplayNumberofCaches")
        pkg.createInfosFrame("number");
    } else if (event.target.id == "cbDisplayCurrentDate" && event.target.checked) {
        // Date
        console.log("cbDisplayCurrentDate")
        pkg.createInfosFrame("date");
    } else if ((event.target.id == "cbDisplayNumberofCaches" || event.target.id == "cbDisplayCurrentDate" ) 
        && (!cbDisplayNumberofCaches.checked && !cbDisplayCurrentDate.checked)) {
        // fermeture si les deux sont desactivés
        pkg.destroyInfosFrame();
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