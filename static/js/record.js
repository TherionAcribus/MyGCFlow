import * as pkg from './index.js';
import { CONFIG } from './init.js';

// Initialisation des event listeners pour les boutons d'enregistrement
function initRecordEventListeners() {
    const startCaptureBtn = document.getElementById("startCapture");
    const makeMovieBtn = document.getElementById("makeMovie");

    // ????? REVOIR CA EST CE UTILE ?????
    if (startCaptureBtn) {
        startCaptureBtn.addEventListener("click", function() {
            console.log("start");
            startAnimation(4); // Démarre l'animation
            startCapture().then(() => {
                // Cette fonction ne s'exécute que lorsque startCapture est terminé
                createMovie();
            });
        });
    } else {
        console.warn("Bouton 'startCapture' non trouvé dans le DOM");
    }

    // ????? REVOIR CA EST CE UTILE ?????
    if (makeMovieBtn) {
        makeMovieBtn.addEventListener("click", function() {
            createMovie();
        });
    } else {
        console.warn("Bouton 'makeMovie' non trouvé dans le DOM");
    }
}

// Initialiser les event listeners quand le DOM est chargé
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRecordEventListeners);
} else {
    // DOM déjà chargé
    initRecordEventListeners();
}

function startCapture() {
    return new Promise((resolve, reject) => {
        const interval = 1000 / 6;  // Pour 24 fps
        const captureDuration = 600000; // Durée totale de la capture
        imageCounter = 0;

        const intervalId = setInterval(() => {
            captureElement();
        }, interval);

        setTimeout(() => {
            clearInterval(intervalId); // Arrête la capture après la durée spécifiée
            resolve(); // Résout la promesse une fois la capture terminée
        }, captureDuration);
    });
}

export function sendImageToServer(dataUrl, counter) {
    return fetch(`${CONFIG.BASE_URL}/upload_image`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: dataUrl, counter: counter, numberSize: pkg.options.record.numberOfDigits })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Erreur réseau lors de l’envoi de l’image.');
        }
        return response.json();
    })
    .then(data => {
        //console.log('Image envoyée avec succès:', data);
        return data;
    })
    .catch(error => {
        console.error('Erreur lors de l’envoi de l’image:', error);
        throw error;
    });
}

function createMovie() {
    fetch(`${CONFIG.BASE_URL}/start_create_video`)
        .then(response => response.json())
        .then(data => console.log(data))
        .catch(error => console.error('Erreur:', error));
}