import * as pkg from './index.js';

export function checkVersionInit(){
    if (pkg.options.options.checkVersion == true) {
        checkVersion("init");
        console.log("CHECK")
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
    console.log("av", data.update_available, mode);
    if (data.update_available || mode == "manual") {
    pkg.openModalnfos(title, data.release_notes, "html");
    }
}