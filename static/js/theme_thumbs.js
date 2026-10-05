// Vignettes visuelles des thèmes (audit 2.D).
//
// Chaque vignette résume le thème ENREGISTRÉ : fond de carte réel (une tuile
// d'échantillon commune pour les fonds raster — même lieu pour tous les
// thèmes, donc comparables — ou les pays d'Europe de l'Ouest aux vraies
// couleurs pour vectorMap, cf. theme_thumb_map.js), style des points, glyphe
// du flash, trait de déplacement et pastille du titre. Tout est construit par
// createElement / createElementNS : aucune donnée de profil ne passe par
// innerHTML, et le seul accès réseau est la tuile de fond elle-même (repli
// couleur si elle échoue).
//
// Consommé par profiles.js (lignes du tiroir « Gérer les thèmes », seul
// endroit de choix visuel d'un thème). Pas d'import de `pkg` : le module est
// sans état et ne lit que les sources OpenLayers (URL de tuile) et la palette
// GC.

import { getBasemapTileUrl } from './basemaps.js';
import { defaultGcColors } from './gc_colors.js';
import { THUMB_COUNTRIES_PATH } from './theme_thumb_map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Espace de travail vectoriel : le CSS redimensionne la vignette (≈96×58 en
// ligne de liste), la géométrie interne reste identique.
const VB_W = 150;
const VB_H = 90;

// Trois caches d'exemple, sur la diagonale suivie par le trait.
const SAMPLE_POINTS = Object.freeze([[34, 60], [74, 34], [112, 62]]);

// Types de cache utilisés pour échantillonner la palette GC (couleurs les
// plus fréquentes et les plus distinctes).
const GC_SAMPLE_TYPES = Object.freeze(['Traditional Cache', 'Multi-cache', 'Mystery Cache']);
const GC_SAMPLE_FALLBACK = Object.freeze(['#008000', '#FFA500', '#0000FF']);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) el.setAttribute(key, String(attrs[key]));
    return el;
}

// Échantillon de la palette GC (liaison vivante : la table peut ne pas encore
// être chargée au premier rendu — d'où le repli intégré).
function gcSampleColor(index) {
    const i = index % GC_SAMPLE_TYPES.length;
    const color = defaultGcColors && defaultGcColors[GC_SAMPLE_TYPES[i]];
    return (typeof color === 'string' && color) || GC_SAMPLE_FALLBACK[i];
}

// Couleur effective d'un remplissage/contour selon son type ('gc', 'none',
// 'fix'…). `index` choisit l'échantillon GC, `fixed` la couleur du réglage.
function themedColor(type, fixed, index) {
    if (type === 'gc') return gcSampleColor(index);
    if (type === 'none') return 'transparent';
    return (typeof fixed === 'string' && fixed) || '#888888';
}

// Scène de fond pour les thèmes à carte vectorielle : les vrais pays d'Europe
// de l'Ouest (THUMB_COUNTRIES_PATH, tiré du même fichier que le fond réel) aux
// couleurs vector_options du thème (fond, remplissage, contour). Même règle
// que buildVectorMapStyle : sans contour (largeur <= 0), un trait fin de la
// couleur du remplissage recouvre les coutures entre pays adjacents.
function buildVectorScene(vectorOptions) {
    const v = vectorOptions && typeof vectorOptions === 'object' ? vectorOptions : {};
    const svg = svgEl('svg', {
        class: 'theme-thumb-vectorscene',
        viewBox: `0 0 ${VB_W} ${VB_H}`,
        preserveAspectRatio: 'xMidYMid slice',
        'aria-hidden': 'true',
        focusable: 'false',
    });
    svg.appendChild(svgEl('rect', {
        x: 0, y: 0, width: VB_W, height: VB_H,
        fill: v.background_color || '#8c8b8b',
    }));
    const fill = v.fill_color || '#c8c8c8';
    const width = parseFloat(v.stroke_width);
    const hasContour = Number.isFinite(width) && width > 0;
    svg.appendChild(svgEl('path', {
        d: THUMB_COUNTRIES_PATH,
        fill,
        stroke: hasContour ? (v.stroke_color || '#000000') : fill,
        // Largeur réduite à l'échelle de la vignette, bornée pour que les
        // petits pays ne disparaissent pas sous leur frontière.
        'stroke-width': hasContour ? clamp(width * 0.4, 0.4, 1.4) : 0.5,
        'stroke-linejoin': 'round',
    }));
    return svg;
}

// Trait de déplacement reliant les caches d'exemple. 'smooth' dessine une
// bézier quadratique passant par le point médian (contrôle = miroir du milieu
// par rapport aux extrémités), les autres formes une polyligne directe.
function appendTrail(overlay, trail) {
    if (!trail || trail.enabled !== true) return;
    const [p0, p1, p2] = SAMPLE_POINTS;
    let d;
    if (trail.curve === 'smooth') {
        const qx = 2 * p1[0] - (p0[0] + p2[0]) / 2;
        const qy = 2 * p1[1] - (p0[1] + p2[1]) / 2;
        d = `M ${p0} Q ${qx},${qy} ${p2}`;
    } else {
        d = `M ${p0} L ${p1} L ${p2}`;
    }
    const attrs = {
        d,
        fill: 'none',
        stroke: trail.color || '#00B8D4',
        'stroke-width': clamp(parseFloat(trail.width) || 3, 1, 4),
        'stroke-opacity': clamp((parseFloat(trail.opacity) || 85) / 100, 0.1, 1),
        'stroke-linecap': 'round',
    };
    if (trail.line_style === 'dashed') attrs['stroke-dasharray'] = '6 4';
    else if (trail.line_style === 'dotted') attrs['stroke-dasharray'] = '0.1 5';
    overlay.appendChild(svgEl('path', attrs));
}

// Les caches d'exemple : forme du thème (cercle/triangle, pastille générique
// en mode icône), remplissage selon fill_color_type ('gc' → palette GC,
// 'none' → contour seul, sinon couleur fixe) et contour si halo/bordure.
function appendSamplePoints(overlay, points) {
    const p = points && typeof points === 'object' ? points : {};
    const size = parseFloat(p.size);
    const r = clamp(Number.isFinite(size) ? size * 0.5 : 4, 2.2, 8);
    const borderSize = p.halo ? (parseInt(p.border_size) || 0) : 0;
    const sw = clamp(borderSize * 0.45, 0, 3);

    SAMPLE_POINTS.forEach(([cx, cy], i) => {
        const fill = p.mode === 'icone'
            ? themedColor('fix', p.color, i)
            : themedColor(p.fill_color_type || 'fix', p.color, i);
        let stroke = sw > 0 ? themedColor(p.border_color_type || 'fix', p.border_color, i) : 'none';
        let strokeWidth = sw;
        if (fill === 'transparent' && stroke === 'none') {
            // Point sans remplissage ni contour : liseré neutre pour rester
            // visible sur n'importe quel fond.
            stroke = 'rgba(148,163,184,0.9)';
            strokeWidth = 1;
        }
        const common = { fill, stroke, 'stroke-width': strokeWidth, 'stroke-linejoin': 'round' };
        if (p.shape === 'triangle' && p.mode !== 'icone') {
            overlay.appendChild(svgEl('polygon', {
                ...common,
                points: `${cx},${cy - r} ${cx - r},${cy + r * 0.8} ${cx + r},${cy + r * 0.8}`,
            }));
        } else {
            overlay.appendChild(svgEl('circle', { ...common, cx, cy, r }));
            if (p.mode === 'icone') {
                // Pastille générique : un centre plus clair suggère l'icône.
                overlay.appendChild(svgEl('circle', {
                    cx, cy, r: Math.max(1, r * 0.4), fill: 'rgba(255,255,255,0.75)',
                }));
            }
        }
    });
}

function starPath(cx, cy, spikes, outerR, innerR) {
    let d = '';
    for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (Math.PI / spikes) * i - Math.PI / 2;
        d += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
    }
    return `${d}Z`;
}

// Contour des formes pleines (étoile, carré…) : même ordre de décision que
// flashStrokeColor de flash_styles.js — 'auto' = liseré sombre historique.
function glyphStroke(flash) {
    const type = flash.border_color_type || 'auto';
    if (type === 'none') return 'none';
    if (type === 'gc') return gcSampleColor(1);
    if (type === 'fix') return flash.border_color || '#000000';
    return 'rgba(0,0,0,0.45)';
}

// Glyphe représentant la forme du flash, posé sur le cache central : l'emblème
// du mode choisi dans #selectFlashMode, pas la simulation de l'animation.
function appendFlashGlyph(overlay, [cx, cy], flash) {
    const mode = flash && flash.mode;
    if (!mode || mode === 'none') return;

    let color;
    if (flash.color_type === 'gc') color = gcSampleColor(1);
    else if (flash.color_type === 'none') color = 'rgba(255,255,255,0.85)';
    else color = flash.color || '#FF00FF';

    const rawSize = parseFloat(flash.size);
    const R = clamp(Number.isFinite(rawSize) ? rawSize * 0.32 : 14, 6, 16);
    const solid = { fill: color, stroke: glyphStroke(flash), 'stroke-width': 1.2, 'stroke-linejoin': 'round' };
    const ring = (r, w, opacity = 1) => svgEl('circle', {
        cx, cy, r, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-opacity': opacity,
    });

    switch (mode) {
        case 'impulse':
            overlay.appendChild(svgEl('circle', { cx, cy, r: R, fill: color, 'fill-opacity': 0.2 }));
            overlay.appendChild(ring(R * 0.5, 1.6));
            break;
        case 'implode':
            // Anneau épais qui se referme sur le point.
            overlay.appendChild(ring(R * 0.7, R * 0.26, 0.9));
            break;
        case 'echo':
            overlay.appendChild(ring(R * 0.45, 1.6));
            overlay.appendChild(ring(R * 0.82, 1.2, 0.5));
            break;
        case 'target':
            overlay.appendChild(ring(R * 0.62, 1.4));
            for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                overlay.appendChild(svgEl('line', {
                    x1: cx + dx * R * 0.78, y1: cy + dy * R * 0.78,
                    x2: cx + dx * R * 1.0, y2: cy + dy * R * 1.0,
                    stroke: color, 'stroke-width': 1.4, 'stroke-linecap': 'round',
                }));
            }
            overlay.appendChild(svgEl('circle', { cx, cy, r: R * 0.14, fill: color }));
            break;
        case 'star':
            overlay.appendChild(svgEl('path', { ...solid, d: starPath(cx, cy, 5, R, R * 0.45) }));
            break;
        case 'sparkle':
            overlay.appendChild(svgEl('path', { ...solid, d: starPath(cx, cy, 4, R, R * 0.2) }));
            break;
        case 'square':
            overlay.appendChild(svgEl('rect', {
                ...solid,
                x: cx - R * 0.62, y: cy - R * 0.62,
                width: R * 1.24, height: R * 1.24, rx: R * 0.15,
            }));
            break;
        case 'triangle':
            overlay.appendChild(svgEl('polygon', {
                ...solid,
                points: `${cx},${cy - R * 0.85} ${cx - R * 0.8},${cy + R * 0.6} ${cx + R * 0.8},${cy + R * 0.6}`,
            }));
            break;
        case 'diamond':
            overlay.appendChild(svgEl('polygon', {
                ...solid,
                points: `${cx},${cy - R} ${cx + R * 0.7},${cy} ${cx},${cy + R} ${cx - R * 0.7},${cy}`,
            }));
            break;
        case 'circle':
        default:
            // Modes inconnus : anneau générique, comme le repli circleStyle de
            // flashStyleAt().
            overlay.appendChild(ring(R * 0.75, 1.8));
            break;
    }
}

// Déclarations CSS seules : le CSS stocké peut encore être enveloppé d'accolades
// (même nettoyage que extractCssDeclarations de profiles.js). Le CSS des
// overlays est assaini côté serveur (sanitize_overlay_css : ni url() ni
// display) et peut donc être posé via style.cssText ; les dimensions restent
// clampées par .theme-thumb-title (!important).
function cssDeclarationsOnly(css) {
    let text = String(css || '').trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        text = text.substring(first + 1, last);
    }
    return text.trim();
}

// Pastille du titre en bas de la vignette : le texte et le CSS du thème (la
// feuille de style borne la taille). Titre masqué dans le thème = pas de
// pastille ; titre sans texte = « Aa » pour montrer le style.
function appendTitleChip(root, infos) {
    const block = infos && typeof infos === 'object' ? infos : {};
    const title = block.title && typeof block.title === 'object' ? block.title : {};
    if (title.display === false) return;
    const chip = document.createElement('span');
    chip.className = 'theme-thumb-title';
    chip.textContent = (typeof title.text === 'string' && title.text.trim()) || 'Aa';
    const css = cssDeclarationsOnly(block.title_css);
    if (css) chip.style.cssText = css;
    root.appendChild(chip);
}

// Vignette d'un thème (ligne de la liste de gestion, ≈96×58 côté CSS).
// `profile` est le dict complet renvoyé par GET /api/profiles/<name>.
export function buildThemeThumbnail(profile) {
    const dict = profile && typeof profile === 'object' ? profile : {};
    const root = document.createElement('div');
    root.className = 'theme-thumb theme-thumb--row';

    const map = dict.map && typeof dict.map === 'object' ? dict.map : {};
    const provider = map.tile_provider || 'OSM';
    root.dataset.thumbProvider = provider;

    if (provider === 'vectorMap') {
        root.appendChild(buildVectorScene(map.vector_options));
    } else {
        const url = getBasemapTileUrl(provider, map.toner_options?.variant);
        if (url) {
            const img = document.createElement('img');
            img.className = 'theme-thumb-basemap';
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            // Tuile inaccessible (hors-ligne, quota CDN) : fond neutre, le reste
            // de la vignette (surcouche SVG) reste représentatif. L'img reste
            // dans le DOM, masquée par le CSS, pour garder une structure stable.
            img.addEventListener('error', () => {
                root.classList.add('theme-thumb--fallback');
            });
            img.src = url;
            root.appendChild(img);
        } else {
            root.classList.add('theme-thumb--fallback');
        }
    }

    const overlay = svgEl('svg', {
        class: 'theme-thumb-overlay',
        viewBox: `0 0 ${VB_W} ${VB_H}`,
        'aria-hidden': 'true',
        focusable: 'false',
    });
    appendTrail(overlay, dict.trail);
    appendSamplePoints(overlay, dict.points);
    appendFlashGlyph(overlay, SAMPLE_POINTS[1], dict.flash || {});
    root.appendChild(overlay);

    appendTitleChip(root, dict.infos);
    return root;
}
