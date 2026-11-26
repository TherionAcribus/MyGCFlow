// Sous-onglet Style › Fiches de la page Parcours (menu_info_parcours.html) :
// contrôles reflétant le bloc `points.parcours_info` du thème
// (parcours_info.mjs) — contenu, où et quand, design — et lecture du
// formulaire vers un objet normalisé. Les cartes des designs dessinent une
// fiche d'exemple avec les réglages courants (parcours_info_draw.mjs) :
// c'est aussi l'aperçu en direct des couleurs et de la police.
//
// L'écriture dans le thème et le rafraîchissement de la carte sont injectés
// (commitInfo) — pas d'import de parcours_data.js.
import { t } from './notifications.js';
import { normalizeParcoursInfo, parcoursInfoDefaults } from './parcours_info.mjs';
import { drawInfo, infoFontFamily, infoLayout } from './parcours_info_draw.mjs';

const el = (id) => document.getElementById(id);

// Couleurs toutes faites (texte, fond, opacité du fond).
const COLOR_SETS = Object.freeze({
    light: { text_color: '#212529', background_color: '#ffffff', background_opacity: 92 },
    dark: { text_color: '#f8f9fa', background_color: '#1f2933', background_opacity: 88 },
});

// deps : { getInfo, commitInfo, accentSample, tablerGlyph }
// getInfo() → réglages normalisés courants ; commitInfo(info) écrit dans le
// thème, resynchronise les contrôles et redessine ; accentSample() → couleur
// d'une trouvaille (accent « couleur de l'étape » des vignettes).
export function createParcoursInfoUI(deps) {
    const FIELD_IDS = {
        name: 'parcoursInfoName', dt: 'parcoursInfoDt', owner: 'parcoursInfoOwner', favorites: 'parcoursInfoFavorites',
    };
    const VALUE_IDS = {
        near: 'parcoursInfoNear', fixed: 'parcoursInfoFixed', duration: 'parcoursInfoDuration',
        font: 'parcoursInfoFont', size: 'parcoursInfoSize', text_color: 'parcoursInfoTextColor',
        background_color: 'parcoursInfoBackgroundColor', background_opacity: 'parcoursInfoBackgroundOpacity',
        accent: 'parcoursInfoAccent', accent_color: 'parcoursInfoAccentColor',
    };

    function read(extra = {}) {
        const raw = {};
        for (const [key, id] of Object.entries(VALUE_IDS)) {
            const input = el(id);
            if (input) raw[key] = input.value;
        }
        for (const [key, id] of Object.entries(FIELD_IDS)) {
            const input = el(id);
            if (input) raw[key] = input.checked;
        }
        return normalizeParcoursInfo({ ...raw, ...extra }, deps.getInfo());
    }

    function commit(extra) {
        deps.commitInfo(read(extra));
    }

    // Fiche d'exemple des vignettes.
    function sample(info) {
        return {
            name: info.name ? t('Le trésor du vieux moulin') : null,
            dt: info.dt ? { d: 2.5, t: 3 } : null,
            owner: info.owner ? 'GeoFamille' : null,
            favorites: info.favorites ? 42 : null,
        };
    }

    // Dessine chaque carte de design avec les réglages courants : la carte
    // enfoncée est le design du thème.
    function drawThumbs(info) {
        const ratio = window.devicePixelRatio || 1;
        const accent = info.accent === 'fixed' ? info.accent_color : (deps.accentSample?.() || info.accent_color);
        const pageFamily = getComputedStyle(document.body).fontFamily || null;
        const content = sample(info);
        const empty = !content.name && !content.dt && !content.owner && content.favorites === null;
        for (const button of document.querySelectorAll('#parcoursInfo [data-info-design]')) {
            const design = button.dataset.infoDesign;
            button.setAttribute('aria-pressed', String(design === info.design));
            const canvas = button.querySelector('canvas');
            if (!canvas) continue;
            const cssW = canvas.clientWidth || 220;
            const cssH = canvas.clientHeight || 96;
            canvas.width = Math.round(cssW * ratio);
            canvas.height = Math.round(cssH * ratio);
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (empty) continue;
            // Une taille raisonnable pour la vignette, quelle que soit celle
            // réglée (jusqu'à 28 px).
            const size = Math.min(info.size, 14) * ratio;
            const layout = infoLayout(ctx, content, {
                design,
                family: infoFontFamily(info.font, pageFamily),
                size,
                locale: document.documentElement.lang || undefined,
                glyphs: { user: deps.tablerGlyph?.('ti-user') || null },
                strings: { by: (owner) => t('par ${owner}', { owner }) },
            });
            if (!layout) continue;
            // Point de l'étape à gauche, fiche à droite (réduite si trop large).
            const dotX = 14 * ratio;
            const dotY = canvas.height / 2;
            const room = canvas.width - dotX - 18 * ratio;
            const scale = Math.min(1, room / layout.w, (canvas.height - 8 * ratio) / layout.h);
            ctx.save();
            ctx.fillStyle = accent;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2 * ratio;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 6 * ratio, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            const x = dotX + 14 * ratio;
            ctx.translate(x, dotY);
            ctx.scale(scale, scale);
            drawInfo(ctx, layout, 0, -layout.h / 2, {
                textColor: info.text_color,
                backgroundColor: info.background_color,
                backgroundOpacity: info.background_opacity,
                accent,
                ratio,
                leader: { fromX: (dotX - x) / scale, fromY: 0, radius: 7 * ratio / scale },
            });
            ctx.restore();
        }
    }

    // Reflète le thème dans les contrôles. N'écrit que le DOM.
    function sync() {
        if (!el('parcoursInfo')) return;
        const info = deps.getInfo();
        for (const [key, id] of Object.entries(VALUE_IDS)) {
            const input = el(id);
            if (input) input.value = String(info[key]);
        }
        for (const [key, id] of Object.entries(FIELD_IDS)) {
            const input = el(id);
            if (input) input.checked = info[key];
        }
        const opacity = el('parcoursInfoBackgroundOpacityValue');
        if (opacity) opacity.textContent = `${info.background_opacity}%`;
        const accentColor = el('parcoursInfoAccentColor');
        if (accentColor) accentColor.disabled = info.accent !== 'fixed';
        const duration = el('parcoursInfoDuration');
        if (duration) duration.disabled = info.near !== 'current' && info.fixed === 'none';
        // Rien de coché : la fiche ne s'affichera nulle part, le dire.
        const empty = !Object.keys(FIELD_IDS).some((key) => info[key]);
        const emptyHint = el('parcoursInfoEmptyHint');
        if (emptyHint) emptyHint.hidden = !empty;
        const offHint = el('parcoursInfoOffHint');
        if (offHint) offHint.hidden = empty || info.near !== 'none' || info.fixed !== 'none';
        drawThumbs(info);
    }

    function bind() {
        if (!el('parcoursInfo')) return;
        for (const id of [...Object.values(VALUE_IDS), ...Object.values(FIELD_IDS)]) {
            el(id)?.addEventListener('change', () => commit());
        }
        // Valeur bornée réaffichée à la sortie du champ (40 → 28).
        for (const id of ['parcoursInfoSize', 'parcoursInfoDuration']) el(id)?.addEventListener('blur', sync);
        // Opacité : suivie pendant le glisser.
        el('parcoursInfoBackgroundOpacity')?.addEventListener('input', () => commit());
        for (const button of document.querySelectorAll('#parcoursInfo [data-info-design]')) {
            button.addEventListener('click', () => commit({ design: button.dataset.infoDesign }));
        }
        for (const button of document.querySelectorAll('#parcoursInfo [data-info-colors]')) {
            button.addEventListener('click', () => {
                const set = button.dataset.infoColors === 'reset'
                    ? (({ text_color, background_color, background_opacity, accent, accent_color }) => (
                        { text_color, background_color, background_opacity, accent, accent_color }))(parcoursInfoDefaults())
                    : COLOR_SETS[button.dataset.infoColors];
                if (set) deps.commitInfo(normalizeParcoursInfo(set, deps.getInfo()));
            });
        }
        // Vignettes : redessinées quand l'onglet devient visible (taille du
        // canevas inconnue tant qu'il est masqué) et quand les polices
        // (dont celle des icônes) arrivent.
        document.querySelector('a[href="#tabParcoursInfo"]')?.addEventListener('shown.bs.tab', sync);
        document.fonts?.ready?.then(() => sync());
        sync();
    }

    return { bind, sync };
}
