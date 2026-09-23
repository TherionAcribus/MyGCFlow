// Format des images capturées par le pipeline « images ».
//
// Chaque frame est encodée côté navigateur avant d'être envoyée au serveur, qui
// les assemble ensuite en H.264. Une compression avec perte à cette étape est
// doublement pénalisante : ses artefacts sont figés dans l'image, puis réencodés
// par ffmpeg qui les prend pour du détail à préserver.
//
// Mesuré sur une frame 1280x540 (fond vectoriel sombre du profil Cinématique) :
//
//   webp 0,90 (ancien)   46 Ko   écart max 20 niveaux   46 ms
//   webp 0,95            51 Ko   écart max 14 niveaux   47 ms
//   webp 1,00 (actuel)   47 Ko   identique au pixel     10 ms
//   png                  98 Ko   identique au pixel      4 ms
//
// Chrome bascule sur un encodage SANS PERTE à partir de la qualité 1 : sur les
// cartes à aplats (vectorielle, Toner), c'est à la fois exact, aussi léger et
// plus rapide. Les écarts de l'ancien réglage se concentraient sur les frontières
// et le texte des cartouches, et décalaient d'environ 10 niveaux les aplats
// sombres — d'où les bavures visibles en vidéo.
//
// Le prix se paie sur les fonds raster (photos de tuiles), moins compressibles
// sans perte : OSM passe de 205 Ko à 889 Ko par frame, Toner de 79 à 158 Ko.
// C'est du stockage temporaire (les frames sont supprimées après l'assemblage),
// et l'encodage reste plus rapide dans tous les cas mesurés.

export const CAPTURE_IMAGE_TYPE = 'image/webp';
// 1 = sans perte (cf. ci-dessus). Ne pas descendre sous 1 sans mesurer.
export const CAPTURE_IMAGE_QUALITY = 1;
