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

// Fonction utilitaire pour convertir dataUrl en Blob WebP
function dataUrlToBlob(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);

            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Échec conversion en Blob'));
                }
            }, 'image/webp', 0.9); // WebP avec qualité 95%
        };
        img.onerror = () => reject(new Error('Échec chargement image'));
        img.src = dataUrl;
    });
}

export function sendImageToServer(imageData, counter) {
    return new Promise((resolve, reject) => {
        let blobPromise;

        // Détecter si c'est déjà un Blob (canvas-only) ou une dataUrl (html2canvas)
        if (imageData instanceof Blob) {
            // C'est déjà un Blob, on peut l'utiliser directement
            blobPromise = Promise.resolve(imageData);
        } else if (typeof imageData === 'string' && imageData.startsWith('data:')) {
            // C'est une dataUrl, on la convertit en Blob
            blobPromise = dataUrlToBlob(imageData);
        } else {
            reject(new Error('Type de données image non supporté'));
            return;
        }

        blobPromise
            .then(blob => {
                const fd = new FormData();
                const fileName = `image_${String(counter).padStart(pkg.options.record.numberOfDigits, '0')}.webp`;
                fd.append('image', blob, fileName);
                fd.append('counter', counter.toString());
                fd.append('numberSize', pkg.options.record.numberOfDigits.toString());

                return fetch(`${CONFIG.BASE_URL}/upload_image`, {
                    method: 'POST',
                    body: fd // FormData, pas de headers Content-Type explicite
                });
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Erreur réseau lors de l’envoi de l’image (${response.status})`);
                }
                return response.json();
            })
            .then(data => {
                //console.log('Image WebP envoyée avec succès:', data);
                resolve(data);
            })
            .catch(error => {
                console.error('Erreur lors de l’envoi de l’image:', error);
                reject(error);
            });
    });
}

function createMovie() {
    fetch(`${CONFIG.BASE_URL}/start_create_video`)
        .then(response => response.json())
        .then(data => console.log(data))
        .catch(error => console.error('Erreur:', error));
}