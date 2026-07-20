// GESTION DES FRAMES d'INFORMATIONS ET DE TITRE 
import * as pkg from './index.js';

export function displayFrames(){
    const optionsTitre = pkg.options.infos.title;
    updateTitleFrame(optionsTitre.text);
    syncOverlayVisibility();
}

// Source de vérité unique pour la visibilité des overlays. Le CSS utilisateur
// ne doit jamais pouvoir contredire les cases à cocher / options du profil.
export function syncOverlayVisibility(){
    const opts = pkg.options?.infos;
    if (!opts) return;

    const titleFrame = document.getElementById("titleFrame");
    const infosFrame = document.getElementById("infosFrame");
    const showTitle = opts.title?.display === true;
    const showInfos = opts.numberOfCaches?.display === true || opts.currentDate?.display === true;

    if (titleFrame) {
        titleFrame.style.display = showTitle ? "block" : "none";
        titleFrame.setAttribute('aria-hidden', showTitle ? 'false' : 'true');
    }
    if (infosFrame) {
        infosFrame.style.display = showInfos ? "block" : "none";
        infosFrame.setAttribute('aria-hidden', showInfos ? 'false' : 'true');
    }
    updateInfosSpansVisibility();
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// Affiche/masque nombre de caches, date et le séparateur "-" selon les options.
// Le "-" n'est visible que si les deux infos sont affichées.
export function updateInfosSpansVisibility(){
    const opts = pkg.options.infos;
    const showCaches = opts.numberOfCaches.display === true;
    const showDate = opts.currentDate.display === true;
    const spanCaches = document.getElementById("spanNbCaches");
    const spanDate = document.getElementById("spanCurrentDate");
    const spanSep = document.getElementById("spanInfosSep");
    if (spanCaches) {
        spanCaches.hidden = !showCaches;
        spanCaches.style.display = showCaches ? "inline" : "none";
    }
    if (spanDate) {
        spanDate.hidden = !showDate;
        spanDate.style.display = showDate ? "inline" : "none";
    }
    if (spanSep) {
        const showSeparator = showCaches && showDate;
        spanSep.hidden = !showSeparator;
        spanSep.style.display = showSeparator ? "inline" : "none";
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
    syncOverlayVisibility();
}

// destruction Frame Infos. La demande est gérée par l'ui si toutes les checkbox sont desactivees
export function destroyInfosFrame(){
    const infosFrame = document.getElementById("infosFrame");
    if (infosFrame) infosFrame.style.display = "none";
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// mise à jour du nombre de caches
export function updateNbCaches(nbCaches){
    const spanNbCaches = document.getElementById("spanNbCaches");
    if (spanNbCaches) spanNbCaches.textContent = nbCaches ?? 0;
}

// mise à jour de la date
export function updateCurrentDate(currentDate){
    currentDate = formatDate(currentDate);
    const spanCurrentDate = document.getElementById("spanCurrentDate");
    if (spanCurrentDate) spanCurrentDate.textContent = currentDate;
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
    const cleaned = sanitizeOverlayCss(userCss);
    // Appliquer le CSS
    infosFrame.style.cssText = cleaned;
    syncCssTextarea('inputInfosCss', cleaned);
    syncOverlayVisibility();
    return cleaned;
}


// -------------------- TITRE -------------------

// creation Titre
export function createTitleFrame(){
    syncOverlayVisibility();
}

// destruction Titre
export function destroyTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    if (titleFrame) titleFrame.style.display = "none";
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// mise à jour du titre
export function updateTitleFrame(title){
    const titleFrame = document.getElementById("titleFrame"); 
    if (titleFrame) titleFrame.textContent = title == null ? '' : String(title).slice(0, 500);
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// Changement css via formulaire
export function changeTitleCssValues(userCss){
    const titleFrame = document.getElementById("titleFrame"); 
    if (!titleFrame) return;
    const cleaned = sanitizeOverlayCss(userCss);
    // Appliquer le CSS
    titleFrame.style.cssText = cleaned;
    syncCssTextarea('inputTitleCss', cleaned);
    syncOverlayVisibility();
    return cleaned;
}

// Les profils sont importables : on limite le CSS à des déclarations locales.
// display reste réservé au contrôleur et url() éviterait des requêtes externes
// invisibles lors du chargement d'un profil tiers.
export function sanitizeOverlayCss(css) {
    const declarations = extractCssDeclarations(css);
    if (!declarations || typeof document === 'undefined') return declarations;
    const probe = document.createElement('div');
    probe.style.cssText = declarations;
    for (const prop of Array.from(probe.style)) {
        const value = probe.style.getPropertyValue(prop);
        if (prop.toLowerCase() === 'display' || /url\s*\(/i.test(value)) {
            probe.style.removeProperty(prop);
        }
    }
    return probe.style.cssText.trim();
}

function syncCssTextarea(id, css) {
    const textarea = document.getElementById(id);
    if (textarea && textarea.value !== css) textarea.value = css;
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


