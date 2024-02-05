// Fonction pour convertir Hex en composantes RGB
export function hexToRgb(hex) {
    if (hex.startsWith('#')) hex = hex.slice(1); // Enlève le '#' si présent
    if (hex.length === 3) { // Support pour le format hex court
        hex = Array.from(hex).map(x => x + x).join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return {r, g, b};
}