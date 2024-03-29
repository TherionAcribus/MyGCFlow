import * as pkg from './index.js';

// Fonction pour convertir Hex en composantes RGB
export function hexToRgb(hex) {
    if (hex.startsWith('#')) hex = hex.slice(1); // Enlève le '#' si présent
    if (hex.length === 3) { // Support pour le format hex court
        hex = Array.from(hex).map(x => x + x).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return {r, g, b};
}

// permet de générer un certificat cfrf
export function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            // Vérifie si le cookie commence par le nom demandé suivi de "="
            if (cookie.startsWith(name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}


// Mets à jour le nombre de frames par jour, le nombre d'images, et le nombre de chiffres
export function updateInfosForPictures(){
    // frames par jour
    const framesPerDay = calculFramePerDay(pkg.options.animation.timePerDay, pkg.framesPerDay);
    pkg.options.record.framesPerDay = framesPerDay;
    // nombres d'images
    const nbImages = pkg.options.date.deltaDays * framesPerDay;
    pkg.options.record.nbOfImages = nbImages;
    // nombres de chiffres dans la partie entière.
    pkg.options.record.numberOfDigits = Math.round(nbImages).toString().length;
    // nombre de frames en plus en fin d'animation
    const flashFrames = pkg.options.flash.duration * framesPerDay / 1000;
    pkg.options.record.extraFrames = flashFrames + 50;  // TODO GErer ce nombre de Frames en plus après la fin de l'animation
}


// calcul le nombre de Frame pour 1 jour
function calculFramePerDay(timePerDay, fps) {
    return Math.round(timePerDay / (1000 / fps));
}


// Retourne un temps en fraction de minutes en minutes et secondes
export function convertToMinutesAndSeconds(timeInFraction) {
    // Séparer les minutes et la partie fractionnaire
    const minutes = Math.floor(timeInFraction);
    const fractionalPart = timeInFraction - minutes;

    // Convertir la partie fractionnaire en secondes
    const seconds = Math.round(fractionalPart * 60);

    return {minutes, seconds};
}


