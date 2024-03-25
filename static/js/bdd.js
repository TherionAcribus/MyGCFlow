import * as pkg from './index.js';

const btnuploadBddForm = document.getElementById('uploadBddForm');
btnuploadBddForm.addEventListener('submit', uploadBddRequest);

export let metadata;
export let json_data;

// TODO Gestion des erreurs
// CHoix de la BDD 
// Visualisation des informations
// Résumé des informations à améliorer (nombre de points)

// TODO Vu qu'il y a json_data, faut il garder json ? 

// chargement d'un fichier dans la BDD
function uploadBddRequest(e){
    e.preventDefault();
    pkg.openModalLoading();

    var formData = new FormData();
    var fileInput = document.getElementById('file-input');
    formData.append('file', fileInput.files[0]);

    fetch('http://localhost:5000/upload', {
        method: 'POST',
        body: formData,
    })
    .then(response => response.json())
    .then(data => {
        console.log(data);
        // ferme la modale
        pkg.closeModalLoading();
        // mets à jour les infos de la BDD
        readBddValues();
    })
    .catch(error => {
        console.error('Error:', error);
    });
    checkLoadingProgress(); // Commencez à vérifier la progression
}


function checkLoadingProgress() {
    fetch('http://localhost:5000/progressBar')
        .then(response => response.json())
        .then(data => {
            pkg.updateProgressBar(data);
            console.log(data.progress);
            if (data.progress < 100) {
                setTimeout(checkLoadingProgress, 100);
            }
        })
        .catch(error => console.error('Error:', error));
}

// regarde si une base de données est disponible et si elle est remplie
export function readBddValues() {
    fetch('http://localhost:5000/db_status')
        .then(response => response.json())
        .then(data => {
            console.log(data);
            showBddInfos(data);
        })
        .catch(error => console.error('Error:', error));
}

// affiche le texte d'information sur la BDD
function showBddInfos(data){
    let infos = ""
    if (data.exists){
        infos = "La base de données SQL Lite est disponible."
    } else {
        infos = "La base de données SQL Lite n'est pas disponible. Quelque chose s'est mal déroulé lors de l'initialisation du programme."
    }

    if (data.size > 0){
        infos += " La base de données fait " + data.size + " octets."
    } else {
        infos += " La base de données est vide. Vous devez commencer par ajouter un nouveau fichier .gpx avec vos trouvailles. EXPLICATIONS "
    }

    if (data.exists){
        infos += "\n 1er enregistrement : " + data.startDate + "\n Dernier enregistrement : " + data.endDate
    } else {
        infos += " La base de données est vide. Vous devez commencer par ajouter un nouveau fichier .gpx avec vos trouvailles. EXPLICATIONS "
    }

    const divInfosBDD = document.getElementById('infosBDD');

    divInfosBDD.innerHTML = infos;
}

export function readBdd(){
    fetch('http://localhost:5000/get_geojson_points')
    .then(response => response.json())
    .then(data => {
        json_data = data.geojson;
        metadata = data.metadata;
        // conversion en objet date
        dateStrToDate();
        // MAJ des frames Infos
        pkg.updateInfosFrameAfterReadBdd(metadata);
        // MAJ du menu d'animation
        pkg.updateAnimationMenuAfterReadBdd(metadata);
        // mise à jour des Date Pickers de l'ui (filtre BDD)
        pkg.setPickerDates(metadata)
        // mise à jour des options en fonction de la BDD (dates début et fin)
        updateOptionsValues(metadata);
        pkg.addVector(data.geojson);
    })
    .catch(error => console.error('Error:', error));
}

function dateStrToDate(){
    metadata.startDate = new Date(metadata.startDate);
    metadata.endDate = new Date(metadata.endDate);
}

// mise à jour des optionsValues en fonction de la BDD (nbr jours pour l'instant)
// appelé à l'init de la BDD et si filtrage
export function updateOptionsValues(metadata){
    pkg.options.date.deltaDays = metadata.deltaDays;
    pkg.options.record.sizeNumber = pkg.sizeOfPictureNumber();
    console.log("Size", pkg.options.record.sizeNumber);
}


// Si on change le filtre de la BDD on refait une requete
export function changeSelect(selectedValues, optionValues) {
    fetch('http://localhost:5000/filter_caches', {
        method: 'POST', 
        headers: {
            'Content-Type': 'application/json', // Spécifie le type de contenu envoyé
        },
        body: JSON.stringify({ types: selectedValues }), // Convertit l'objet en chaîne JSON
    })
    .then(response => response.json())
    .then(data => {
        console.log(data);
        json_data = data.geojson;
        metadata = data.metadata;
        // conversion en objet date
        dateStrToDate();
        // remets à jour les options/infos dépendant de la BDD (delayDate)
        updateOptionsValues(metadata);
        // MAJ des frames Infos
        pkg.updateInfosFrameAfterReadBdd(metadata);
        pkg.refreshPoints(optionValues);
    })
    .catch(error => console.error('Error:', error));
}