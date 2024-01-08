import * as pkg from './index';

const btnuploadBddForm = document.getElementById('uploadBddForm');
btnuploadBddForm.addEventListener('submit', uploadBddRequest);

// TODO Gestion des erreurs
// CHoix de la BDD 
// Visualisation des informations
// Résumé des informations à améliorer (nombre de points, date début et fin)
// 

// chargement d'un fichier dans la BSS
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
                setTimeout(checkLoadingProgress, 100); // Corrigez le nom de la fonction ici
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
    const divInfosBDD = document.getElementById('infosBDD');

    divInfosBDD.innerHTML = infos;
}

export function readBdd(){
    fetch('http://localhost:5000/get_geojson_points')
    .then(response => response.json())
    .then(data => {
        console.log(data);
        pkg.addVector(data);
    })
    .catch(error => console.error('Error:', error));
}
