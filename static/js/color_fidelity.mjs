// Fidélité des couleurs de la vidéo finale.
//
// Les deux pipelines finissent par un encodage H.264. Mesuré sur 40 frames
// réelles d'une animation dense (fond sombre, points aux couleurs GC) :
//
//   4:2:0 (compatible)  1834 Ko   couleurs 33,3 dB   SSIM 0,9616
//   4:4:4 (fidèle)      2025 Ko   couleurs 38,2 dB   SSIM 0,9777   (+10 %)
//
// En 4:2:0, la résolution de couleur est divisée par deux : c'est ce qui fait
// légèrement baver les points colorés sur fond sombre. Ni un meilleur CRF ni un
// bonus de bits sur la chrominance n'y changent rien (33,3 → 34,1 dB au mieux,
// pour +44 % de fichier) : la perte est spatiale, pas due à la compression.
//
// Le 4:4:4 la corrige pour 10 % de fichier en plus, mais exige un profil H.264
// (High 4:4:4 Predictive) que beaucoup de lecteurs matériels, de téléviseurs et
// Safari refusent d'ouvrir. D'où le défaut « compatible » : un fichier illisible
// chez le destinataire est pire qu'un fichier un peu moins net.
//
// Aucune dépendance au DOM : logique pure, testable. Miroir côté serveur :
// COLOR_FIDELITIES dans capture.py.

export const COLOR_FIDELITIES = Object.freeze(['compatible', 'fidele']);
export const DEFAULT_COLOR_FIDELITY = 'compatible';

export function normalizeColorFidelity(value) {
    return COLOR_FIDELITIES.includes(value) ? value : DEFAULT_COLOR_FIDELITY;
}
