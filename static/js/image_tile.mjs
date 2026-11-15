// Tuile image d'un tableau de bord (page Statistiques) : un logo, une photo
// posée entre les graphiques. Elle vit dans le tableau comme un graphique —
// même élément `{ size, height, spec }`, même identifiant, mêmes
// déplacements — mais sa description ne porte qu'une image de la
// bibliothèque (onglet Images de la carte, `images/`), une légende (le
// titre) et un cadrage. Aucune requête : pas de source.
// Module pur, testé par tests/js/image_tile.test.mjs.

// « Image entière » (proportions gardées, bandes vides) ou « remplir la
// tuile » (recadrée au centre).
export const IMAGE_FITS = Object.freeze(['contain', 'cover']);
export const IMAGE_FIT_DEFAULT = 'contain';

// Nom d'un fichier de la bibliothèque : empreinte du contenu + extension
// (image_library.py › _NAME_RE). Jamais un chemin.
const FILE_RE = /^[0-9a-f]{16}\.(?:png|jpg)$/;

export const isImageFile = (value) => typeof value === 'string' && FILE_RE.test(value);

export function isImageSpec(spec) {
    return spec?.view?.chart === 'image';
}

// Vue d'une tuile image : un fichier invalide devient '' (tuile « image
// introuvable », à rechoisir), le cadrage retombe sur « image entière ».
export function normalizeImageView(raw) {
    const src = raw !== null && typeof raw === 'object' && raw.image !== null && typeof raw.image === 'object' ? raw.image : {};
    return {
        chart: 'image',
        image: {
            file: isImageFile(src.file) ? src.file : '',
            fit: IMAGE_FITS.includes(src.fit) ? src.fit : IMAGE_FIT_DEFAULT,
        },
    };
}

export function imageUrl(file) {
    return '/api/images/' + encodeURIComponent(file);
}

// Rectangle où dessiner une image `iw × ih` dans une boîte `w × h` :
// entière et centrée (contain) ou couvrant la boîte, centrée (cover — elle
// déborde, l'appelant découpe). `zoom` agrandit autour du centre.
export function fitRect(iw, ih, w, h, fit = IMAGE_FIT_DEFAULT, zoom = 1) {
    if (!(iw > 0 && ih > 0 && w > 0 && h > 0)) return { x: 0, y: 0, width: 0, height: 0 };
    const scale = (fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)) * zoom;
    const width = iw * scale;
    const height = ih * scale;
    return { x: (w - width) / 2, y: (h - height) / 2, width, height };
}

// Vidéo : l'image s'avance doucement pendant son écran (de 95 % à sa
// taille entière, décéléré — jamais au-delà : un logo ne perd pas ses
// bords) ; `progress` de 0 à 1.
export const VIDEO_IMAGE_ZOOM = 0.05;
export function imageZoom(progress) {
    const p = Math.min(1, Math.max(0, Number(progress) || 0));
    return 1 - VIDEO_IMAGE_ZOOM * (1 - p) ** 2;
}
