import * as pkg from './index.js';

export function checkVersionInit(){
    if (pkg.options.options.checkVersion == true) {
        checkVersion("init");
    }
}

export function checkVersion(mode="manual"){
    fetch('http://localhost:5000/check_version')
    .then(response => response.json())
    .then(data => {
        displayCheckVersion(data, mode);
    })
    .catch(error => console.error('Erreur:', error));
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