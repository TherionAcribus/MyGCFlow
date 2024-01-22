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
        console.log(event);
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


