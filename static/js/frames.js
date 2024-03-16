// GESTION DES FRAMES d'INFORMATIONS ET DE TITRE 


// -------------------- INFOS -------------------



export function displayFrames(optionsValues){
    // titre
    const optionsTitre = optionsValues.infos.title;
    console.log(optionsValues)
    console.log(optionsTitre)
    if (optionsTitre.display) {
        createTitleFrame();
        updateTitleFrame(optionsTitre.text);
    }
}

// creation Titre
export function createTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style.display = "block";
}

// destruction Titre
export function destroyTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style.display = "none";    
}

// mise à jour du titre
export function updateTitleFrame(title){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.innerHTML = title;
}

// Changement css via formulaire
export function changeCssValues(userCss){
    const titleFrame = document.getElementById("titleFrame"); 
    titleFrame.style = userCss;
}


