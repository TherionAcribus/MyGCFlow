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


// calcul le nombre de zeros pour le nom du fichier de l'image pour qu'elles soient bien dans l'ordre
export function sizeOfPictureNumber(){
    // nombres d'images
    let nbImages = pkg.options.date.deltaDays * pkg.options.record.fps * (pkg.options.animation.timePerDay / 1000);
    // nombres de chiffres dans la partie entière.
    const numberOfDigits = Math.round(nbImages).toString().length;
    return numberOfDigits
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
