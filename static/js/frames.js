// GESTION DES FRAMES d'INFORMATIONS ET DE TITRE 
import * as pkg from './index.js';

export function displayFrames(){
    // titre
    const optionsTitre = pkg.options.infos.title;
    if (optionsTitre.display) {
        createTitleFrame();
        updateTitleFrame(optionsTitre.text);
    }
    const optionsInfos = pkg.options.infos;
    console.log(optionsInfos)
    if (optionsInfos.numberOfCaches.display || optionsInfos.currentDate.display) {
        createInfosFrame();
    }
}


// -------------------- INFOS -------------------

// Affiche le nombre de caches + date après Filtre ou 1er Chargement
export function updateInfosFrameAfterReadBdd(metadata){
    console.log(metadata)
    updateNbCaches(metadata.numberOfCaches);
    updateCurrentDate(metadata.endDate);
}

// creation Frame Infos. Peut importe qui envoie la demande de création, on l'affiche si pas affiché
export function createInfosFrame(){
    console.log("createInfosFrame")
    const infosFrame = document.getElementById("infosFrame");
    if (infosFrame.style.display == "none") {
        infosFrame.style.display = "block";
    }
}

// destruction Frame Infos. La demande est gérée par l'ui si toutes les checkbox sont desactivees
export function destroyInfosFrame(){
    const infosFrame = document.getElementById("infosFrame");
    if (infosFrame.style.display == "block") {
        infosFrame.style.display = "none";
    }
}

// mise à jour du nombre de caches
export function updateNbCaches(nbCaches){
    const spanNbCaches = document.getElementById("spanNbCaches");
    spanNbCaches.innerHTML = nbCaches;
}

// mise à jour de la date
export function updateCurrentDate(currentDate){
    currentDate = formatDate(currentDate);
    const spanCurrentDate = document.getElementById("spanCurrentDate");
    spanCurrentDate.innerHTML = currentDate;
}

// formatage date au format jour/mois/annee (optimisé car pas de manipulation d'objets)
function formatDate(date) {
    let day = date.getDate();
    let month = date.getMonth() + 1; // Les mois sont indexés à partir de 0
    let year = date.getFullYear();

    // Ajouter un zéro au début si le jour ou le mois est inférieur à 10
    day = day < 10 ? '0' + day : day;
    month = month < 10 ? '0' + month : month;

    return `${day}/${month}/${year}`;
}

// Changement css via formulaire
export function changeInfosCssValues(userCss){
    const infosFrame = document.getElementById("infosFrame"); 
    infosFrame.style = userCss;
}


// -------------------- TITRE -------------------

// creation Titre
export function createTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style.display = "block";
}

// destruction Titre
export function destroyTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style.display = "none";    
}

// mise à jour du titre
export function updateTitleFrame(title){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.innerHTML = title;
}

// Changement css via formulaire
export function changeTitleCssValues(userCss){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style = userCss;
}


