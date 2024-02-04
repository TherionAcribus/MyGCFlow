let imageCounter

document.getElementById("startCapture").addEventListener("click", function() {
    console.log("start");
    startAnimation(4); // Démarre l'animation
    startCapture().then(() => {
        // Cette fonction ne s'exécute que lorsque startCapture est terminé
        createMovie();
    });
});


document.getElementById("makeMovie").addEventListener("click", function() {
    createMovie();
})

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

function captureElement() {
    const element = document.getElementById('map'); 
    toPng(element)
      .then((dataUrl) => {
        // Vous avez maintenant une image au format data URL que vous pouvez envoyer à votre serveur Flask
        sendImageToServer(dataUrl, imageCounter++);
      })
      .catch((error) => {
        console.error('Erreur lors de la capture de l’élément : ', error);
      });
  }


function sendImageToServer(dataUrl, counter) {
    fetch('http://localhost:5000/upload_image', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: dataUrl, counter: counter })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Erreur réseau lors de l’envoi de l’image.');
        }
        return response.json();
    })
    .then(data => {
        //console.log('Image envoyée avec succès:', data);
    })
    .catch(error => {
        console.error('Erreur lors de l’envoi de l’image:', error);
    });
}

function createMovie() {
    fetch('http://localhost:5000/start_create_video')
        .then(response => response.json())
        .then(data => console.log(data))
        .catch(error => console.error('Erreur:', error));
}