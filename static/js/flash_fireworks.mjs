// Flash « feu d'artifice » : célébration d'un DNF enfin trouvé
// (docs/logs-geocaching.md).
//
// Un éclat blanc au centre, puis douze traînées qui jaillissent en étoile et
// retombent légèrement (gravité), et huit étincelles plus claires, décalées
// en angle et en temps ; le tout s'éteint sur la fin. Coordonnées en pixels,
// relatives au point, y vers le bas (canvas).
//
// Aucune dépendance au DOM ni à OpenLayers : logique pure, testable.

const RAYS = 12;
const SPARKS = 8;
const SPARK_DELAY = 0.12;     // les étincelles partent un peu après les traînées
const FADE_OUT_FROM = 0.55;

function clamp01(t) {
    return Math.min(1, Math.max(0, Number(t) || 0));
}

function easeOutCubic(u) {
    return 1 - Math.pow(1 - u, 3);
}

function fade(r) {
    if (r <= FADE_OUT_FROM) return 1;
    const u = (r - FADE_OUT_FROM) / (1 - FADE_OUT_FROM);
    return 1 - u * u * (3 - 2 * u);
}

// Une gerbe de `count` particules à l'avancement local `u` (0 -> 1).
function burst(count, angleOffset, reach, u, width, tint) {
    const out = [];
    const e = easeOutCubic(u);
    const head = reach * e;
    const tail = reach * Math.max(0, e - 0.35 * (1 - u));      // traînée qui raccourcit
    const sag = reach * 0.25 * u * u;                          // retombée
    for (let i = 0; i < count; i++) {
        const a = angleOffset + (2 * Math.PI * i) / count;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        out.push({
            x1: tail * cos, y1: tail * sin + sag * 0.6,
            x2: head * cos, y2: head * sin + sag,
            width: Math.max(0.8, width * (1 - 0.6 * u)),
            tint,
        });
    }
    return out;
}

// Image du feu d'artifice à l'avancement t (0 -> 1) pour une taille de flash
// `size` (portée des traînées ~0,6·size, comparable aux autres formes).
export function fireworksFrame(t, size) {
    const r = clamp01(t);
    const s = Math.max(0, Number(size) || 0);
    const opacity = fade(r);

    const rays = burst(RAYS, 0, s * 0.6, r, Math.max(1.5, s * 0.06), 0);
    const sparkU = clamp01((r - SPARK_DELAY) / (1 - SPARK_DELAY));
    const sparks = sparkU > 0
        ? burst(SPARKS, Math.PI / SPARKS, s * 0.38, sparkU, Math.max(1.2, s * 0.045), 1)
        : [];
    const particles = rays.concat(sparks);

    // Éclat central : grossit vite, puis s'efface avant la gerbe.
    const coreIn = Math.min(1, r / 0.08);
    const coreOut = 1 - clamp01((r - 0.08) / 0.3);

    let extent = 1;
    for (const p of particles) {
        extent = Math.max(extent, Math.abs(p.x1), Math.abs(p.y1), Math.abs(p.x2), Math.abs(p.y2));
    }
    const coreRadius = Math.max(0.8, s * 0.16 * coreIn);
    return {
        particles,
        particleOpacity: opacity,
        coreRadius,
        coreOpacity: coreIn * coreOut,
        extent: Math.max(extent, coreRadius) + Math.max(1.5, s * 0.06),
    };
}
