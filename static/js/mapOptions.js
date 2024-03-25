class MapOptions {
    constructor() {
        this.options = {};
        this.map = {};
        this.point = {};
        this.animation = {};
        this.infos = {};
        this.flash = {};
        this.date = {};
        this.record = {};
    }

    // Méthode pour initialiser l'objet avec des valeurs par défaut
    init(defaultValues) {
        Object.assign(this, defaultValues);
    }
}

// creation de l'instance "options". Rendue publique dans toute l'app
export const options = new MapOptions();

