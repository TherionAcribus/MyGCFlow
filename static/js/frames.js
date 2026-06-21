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
    if (optionsInfos.numberOfCaches.display || optionsInfos.currentDate.display) {
        createInfosFrame();
    }
}


// -------------------- INFOS -------------------

// Affiche le nombre de caches + date après Filtre ou 1er Chargement
export function updateInfosFrameAfterReadBdd(metadata){
    updateNbCaches(metadata.numberOfCaches);
    updateCurrentDate(metadata.endDate);
}

// creation Frame Infos. Peut importe qui envoie la demande de création, on l'affiche si pas affiché
export function createInfosFrame(){
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
    if (!date) return '--/--/----';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '--/--/----';
    let day = d.getDate();
    let month = d.getMonth() + 1;
    let year = d.getFullYear();
    day = day < 10 ? '0' + day : day;
    month = month < 10 ? '0' + month : month;
    return `${day}/${month}/${year}`;
}

// Changement css via formulaire
export function changeInfosCssValues(userCss){
    const infosFrame = document.getElementById("infosFrame"); 
    if (!infosFrame) return;
    const cleaned = extractCssDeclarations(userCss);
    // Appliquer le CSS
    infosFrame.style.cssText = cleaned;
    // S'assurer que la frame est visible si l'utilisateur n'a pas spécifié display
    if (!/\bdisplay\s*:/i.test(cleaned)) {
        infosFrame.style.display = 'block';
    }
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
    if (!titleFrame) return;
    const cleaned = extractCssDeclarations(userCss);
    // Appliquer le CSS
    titleFrame.style.cssText = cleaned;
    // S'assurer que la frame est visible si l'utilisateur n'a pas spécifié display
    if (!/\bdisplay\s*:/i.test(cleaned)) {
        titleFrame.style.display = 'block';
    }
}

// Utilitaire: extrait uniquement les déclarations CSS (retire sélecteurs et accolades)
function extractCssDeclarations(css) {
    if (!css || typeof css !== 'string') return '';
    let text = css.trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        text = text.substring(first + 1, last);
    }
    // Nettoyage des espaces superflus en début de ligne
    text = text.replace(/^\s+/gm, '');
    return text.trim();
}


