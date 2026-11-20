// Page Parcours : étapes qui se recouvrent sur la carte (docs/parcours.md,
// « Étapes empilées »).
//
// Au zoom courant, les étapes d'une même journée dont les pastilles se
// recouvrent forment une PILE : une seule pastille, à la place de la
// première, qui porte « 4–7 » (numéros qui se suivent) ou « ×4 ». Au clic, la
// pile s'écarte en éventail. La lecture forme les mêmes piles avec les
// étapes déjà atteintes : le regroupement est glouton dans l'ordre du
// parcours, donc stable par préfixe — la fin de la vidéo retrouve les piles
// du plan au repos.
//
// Module pur (aucun DOM, ni OpenLayers) : testé par node --test.

// Deux étapes s'empilent quand leurs centres sont à moins de STACK_DISTANCE
// rayons de pastille : la seconde est alors à moitié cachée au moins.
export const STACK_DISTANCE = 1.5;

// Regroupe `items` ({ x, y, group } en pixels écran, dans l'ordre du
// parcours ; `group` : la journée — deux journées ne s'empilent jamais).
// Chaque étape rejoint la pile la plus proche dont la PREMIÈRE étape est à
// moins de `threshold` px (une pile ne s'étire pas en chaîne), sinon en
// ouvre une. Retourne [{ rep, members }] (index dans `items`, `rep` = le
// premier membre), dans l'ordre d'ouverture.
export function stackStops(items, threshold) {
    const stacks = [];
    const limit = Math.max(0, Number(threshold) || 0);
    if (!Array.isArray(items) || items.length === 0) return stacks;
    const cell = limit > 0 ? limit : 1;
    const grid = new Map();
    const cellKey = (cx, cy, group) => `${group}|${cx}|${cy}`;
    items.forEach((item, i) => {
        const x = Number(item?.x);
        const y = Number(item?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            stacks.push({ rep: i, members: [i] });
            return;
        }
        const group = item.group ?? '';
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        let best = null;
        let bestD2 = limit * limit;
        if (limit > 0) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (const stack of grid.get(cellKey(cx + dx, cy + dy, group)) || []) {
                        const d2 = (stack.x - x) ** 2 + (stack.y - y) ** 2;
                        if (d2 < bestD2) {
                            best = stack;
                            bestD2 = d2;
                        }
                    }
                }
            }
        }
        if (best) {
            best.members.push(i);
            return;
        }
        const stack = { rep: i, members: [i], x, y };
        stacks.push(stack);
        const key = cellKey(cx, cy, group);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(stack);
    });
    return stacks.map(({ rep, members }) => ({ rep, members }));
}

// Libellé d'une pile, d'après les numéros de ses étapes (dans l'ordre) :
// « 4–7 » s'ils se suivent, « ×4 » sinon (ou sans numéros). Une étape seule
// garde son numéro.
export function stackLabel(labels) {
    const list = Array.isArray(labels) ? labels.map((l) => String(l ?? '')) : [];
    if (list.length <= 1) return list[0] || '';
    const numbers = list.map((l) => (/^\d+$/.test(l) ? Number(l) : NaN));
    const consecutive = numbers.every((n, i) => Number.isFinite(n) && (i === 0 || n === numbers[i - 1] + 1));
    return consecutive ? `${numbers[0]}–${numbers[numbers.length - 1]}` : `×${list.length}`;
}

// Éventail d'une pile de `n` étapes de rayon `radius` : décalages [dx, dy]
// en pixels écran (y vers le bas) autour du centre de la pile. Jusqu'à neuf
// étapes, un cercle qui part du haut dans le sens des aiguilles d'une
// montre ; au-delà, une spirale. Les pastilles voisines ne se touchent pas.
export const FAN_CIRCLE_MAX = 9;

export function fanOffsets(n, radius) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const r = Math.max(1, Number(radius) || 1);
    const gap = r * 2.4;
    const out = [];
    if (count === 0) return out;
    if (count <= FAN_CIRCLE_MAX) {
        const ring = Math.max(gap, (count * gap) / (2 * Math.PI));
        for (let i = 0; i < count; i++) {
            const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
            out.push([round(ring * Math.cos(angle)), round(ring * Math.sin(angle))]);
        }
        return out;
    }
    // Spirale d'Archimède ρ = a·θ, points espacés de `gap` le long de la
    // courbe (approximation : Δθ = gap / ρ).
    const a = gap / (2 * Math.PI);
    let theta = 2 * Math.PI; // un tour : premier anneau à `gap` du centre
    for (let i = 0; i < count; i++) {
        const rho = a * theta;
        out.push([round(rho * Math.cos(theta - Math.PI / 2)), round(rho * Math.sin(theta - Math.PI / 2))]);
        theta += gap / rho;
    }
    return out;
}

function round(value) {
    return Math.round(value * 10) / 10;
}
