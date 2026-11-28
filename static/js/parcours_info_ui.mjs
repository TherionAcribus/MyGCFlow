// Sous-onglet Style › Fiches de la page Parcours (menu_info_parcours.html) :
// contrôles reflétant le bloc `points.parcours_info` du thème
// (parcours_info.mjs) — contenu, où et quand, design — et lecture du
// formulaire vers un objet normalisé. Les cartes des designs dessinent une
// fiche d'exemple avec les réglages courants (parcours_info_draw.mjs) :
// c'est aussi l'aperçu en direct des couleurs et de la police.
//
// L'écriture dans le thème et le rafraîchissement de la carte sont injectés
// (commitInfo) — pas d'import de parcours_data.js.
import { showConfirmation, t } from './notifications.js';
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
        code: 'parcoursInfoCode', type: 'parcoursInfoType', finds: 'parcoursInfoFinds', step: 'parcoursInfoStep',
    };
    const VALUE_IDS = {
        near: 'parcoursInfoNear', fixed: 'parcoursInfoFixed', duration: 'parcoursInfoDuration',
        filter: 'parcoursInfoFilter', filter_dt: 'parcoursInfoFilterDt',
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
        const twoLines = el('parcoursInfoTwoLines');
        if (twoLines) raw.two_lines = twoLines.checked;
        const places = el('parcoursInfoPlaces');
        if (places) raw.places = places.checked;
        return normalizeParcoursInfo({ ...raw, ...extra }, deps.getInfo());
    }

    function commit(extra) {
        deps.commitInfo(read(extra));
    }

    // Fiche d'exemple des vignettes.
    function sample(info) {
        return {
            name: info.name ? t('Le trésor caché du vieux moulin de la vallée') : null,
            dt: info.dt ? { d: 2.5, t: 3 } : null,
            owner: info.owner ? 'GeoFamille' : null,
            favorites: info.favorites ? 42 : null,
            code: info.code ? 'GC8F2K7' : null,
            type: info.type ? 'Multi-cache' : null,
            finds: info.finds ? 137 : null,
            step: info.step ? { n: 3, total: 12 } : null,
        };
    }

    // Dessine chaque carte de design avec les réglages courants : la carte
    // enfoncée est le design du thème.
    function drawThumbs(info) {
        const ratio = window.devicePixelRatio || 1;
        const accent = info.accent === 'fixed' ? info.accent_color : (deps.accentSample?.() || info.accent_color);
        const pageFamily = getComputedStyle(document.body).fontFamily || null;
        const content = sample(info);
        const empty = !content.name && !content.dt && !content.owner && content.favorites === null
            && !content.code && !content.type && content.finds === null && !content.step;
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
            const size = info.size * ratio;
            const layout = infoLayout(ctx, content, {
                design,
                twoLines: info.two_lines,
                family: infoFontFamily(info.font, pageFamily),
                size,
                locale: document.documentElement.lang || undefined,
                glyphs: { user: deps.tablerGlyph?.('ti-user') || null },
                strings: { by: (owner) => t('par ${owner}', { owner }) },
            });
            if (!layout) continue;
            // Point de l'étape à gauche, fiche à droite. Échelle constante,
            // calée pour que la taille maximale (28 px) remplisse la
            // vignette : les tailles moindres dessinent une fiche plus
            // petite — le réglage « Taille du texte » se juge enfin.
            const dotX = 14 * ratio;
            const dotY = canvas.height / 2;
            const room = canvas.width - dotX - 18 * ratio;
            const fit = Math.min(room / layout.w, (canvas.height - 8 * ratio) / layout.h);
            const scale = fit * Math.min(info.size, 28) / 28;
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

    // Dernière configuration active (near/fixed), pour la restaurer quand
    // l'interrupteur est réenclenché. Renseignée par sync().
    let lastActive = null;

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
        const twoLines = el('parcoursInfoTwoLines');
        if (twoLines) twoLines.checked = info.two_lines;
        const places = el('parcoursInfoPlaces');
        if (places) places.checked = info.places;
        const opacity = el('parcoursInfoBackgroundOpacityValue');
        if (opacity) opacity.textContent = `${info.background_opacity}%`;
        // Interrupteur : reflète l'état et retient la dernière configuration
        // active — le réenclencher la restaure plutôt qu'une valeur arbitraire.
        const off = info.near === 'none' && info.fixed === 'none';
        if (!off) lastActive = { near: info.near, fixed: info.fixed };
        const on = el('parcoursInfoOn');
        if (on) on.checked = !off;
        // Sans effet dans le mode choisi = masqué plutôt que grisé : le
        // nuancier d'accent ne vaut qu'en couleur fixe, la durée minimale
        // que pour le temporaire et le cartouche, le filtre que pour le
        // permanent (et son seuil que pour le filtre D/T). Les valeurs des
        // champs masqués restent lues par read() et conservées dans le
        // thème — masquer ne réinitialise rien.
        const show = (id, yes) => { const node = el(id); if (node) node.hidden = !yes; };
        show('parcoursInfoAccentColor', info.accent === 'fixed');
        show('parcoursInfoDurationCell', info.near === 'current' || info.fixed !== 'none');
        show('parcoursInfoFilterRow', info.near === 'all');
        show('parcoursInfoFilterDtCell', info.near === 'all' && info.filter === 'dt');
        // Bandeau : le fond est la couleur d'accent et le texte s'y adapte —
        // les deux couleurs sont sans effet, le montrer.
        const banner = info.design === 'banner';
        const textColor = el('parcoursInfoTextColor');
        if (textColor) textColor.disabled = banner;
        const backgroundColor = el('parcoursInfoBackgroundColor');
        if (backgroundColor) backgroundColor.disabled = banner;
        // Aides courtes suivant le mode choisi, plutôt qu'un pavé couvrant
        // les trois modes à la fois.
        const hint = (id, yes) => { const node = el(id); if (node) node.hidden = !yes; };
        hint('helpInfoCurrent', info.near === 'current');
        hint('helpInfoAll', info.near === 'all');
        hint('helpInfoFixed', info.fixed !== 'none');
        hint('helpInfoEverywhere', !off);
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
        for (const id of [...Object.values(VALUE_IDS), ...Object.values(FIELD_IDS), 'parcoursInfoTwoLines', 'parcoursInfoPlaces']) {
            el(id)?.addEventListener('change', () => commit());
        }
        // Valeur bornée réaffichée à la sortie du champ (40 → 28).
        for (const id of ['parcoursInfoSize', 'parcoursInfoDuration', 'parcoursInfoFilterDt']) el(id)?.addEventListener('blur', sync);
        // Opacité, taille et couleurs : suivies pendant le glisser et le
        // nuancier, sans attendre la fermeture du contrôle.
        el('parcoursInfoBackgroundOpacity')?.addEventListener('input', () => commit());
        el('parcoursInfoSize')?.addEventListener('input', () => commit());
        el('parcoursInfoFilterDt')?.addEventListener('input', () => commit());
        for (const id of ['parcoursInfoTextColor', 'parcoursInfoBackgroundColor', 'parcoursInfoAccentColor']) {
            el(id)?.addEventListener('input', () => commit());
        }
        // Interrupteur : couper vide les deux emplacements ; enclencher
        // restaure la dernière configuration active (temporaire à côté de
        // la cache si jamais il n'y en a pas eu).
        el('parcoursInfoOn')?.addEventListener('change', () => {
            if (el('parcoursInfoOn').checked) commit({ near: lastActive?.near || 'current', fixed: lastActive?.fixed || 'none' });
            else commit({ near: 'none', fixed: 'none' });
        });
        for (const button of document.querySelectorAll('#parcoursInfo [data-info-design]')) {
            button.addEventListener('click', () => commit({ design: button.dataset.infoDesign }));
        }
        // Tout réinitialiser : les défauts complets, pas seulement les
        // couleurs — confirmé, les réglages en cours sont perdus.
        el('parcoursInfoReset')?.addEventListener('click', () => {
            showConfirmation(
                t('Remettre tous les réglages de la fiche par défaut ?'),
                t('Réinitialiser'),
                () => deps.commitInfo(normalizeParcoursInfo(parcoursInfoDefaults(), deps.getInfo())),
                null,
                { confirmText: t('Réinitialiser'), danger: true },
            );
        });
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
        // Fiche épinglée d'exemple : la carte est redessinée quand le
        // sous-onglet — ou l'onglet Style qui le contient — apparaît ou
        // disparaît.
        const studioToggled = () => deps.onStudioToggle?.();
        for (const link of document.querySelectorAll('a[href="#tabParcoursInfo"], a[href="#style"]')) {
            link.addEventListener('shown.bs.tab', studioToggled);
            link.addEventListener('hidden.bs.tab', studioToggled);
        }
        sync();
    }

    return { bind, sync };
}
