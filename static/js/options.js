import * as pkg from './index.js';
import { CONFIG } from './init.js';

export function checkVersionInit(){
    if (pkg.options.options.checkVersion == true) {
        checkVersion("init");
    }
}

export function checkVersion(mode="manual"){
    fetch(`${CONFIG.BASE_URL}/check_version`)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    })
    .then(data => {
        displayCheckVersion(data, mode);
    })
    .catch(error => {
        console.error('Erreur lors de la vérification de version:', error);
        // En cas d'erreur, afficher un message d'erreur seulement en mode manuel
        if (mode === "manual") {
            const errorData = {
                error: true,
                release_notes: `Erreur lors de la vérification de version: ${error.message}`
            };
            displayCheckVersion(errorData, mode);
        }
    });
}


// le mode permet de savoir si checkversion depuis initialisation ou demande user
// car on n'affiche la reponse si négative que si demande user
function displayCheckVersion(data, mode){
    console.log(data.update_available);
    let title;
    if (data.error == true) {
        title = "Error";
    } else if (data.update_available) {
        title = "Update available";
    } else {
        title = "No update available";
    }

    if (data.update_available || mode == "manual") {
    pkg.openModalnfos(title, data.release_notes, "html");
    }
}