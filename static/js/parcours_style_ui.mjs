// Panneau « Style du parcours » (carte Étapes, onglet Données) : contrôles
// reflétant le bloc `points.parcours_style` du thème (parcours_style.mjs) —
// rendu, numéros, coloriage (nature/journée/couleurs par nature), palette des
// journées, comportement pendant la lecture, plan et trait — et lecture du
// formulaire vers un objet de style normalisé. L'écriture dans le thème et
// le rafraîchissement du plan sont injectés (commitStyle) — pas d'import de
// parcours_data.js.
import { t } from './notifications.js';
import {
    PARCOURS_PALETTE_SIZE,
    nextPaletteColor,
    normalizeParcoursStyle,
    parcoursStyleDefaults,
} from './parcours_style.mjs';

const el = (id) => document.getElementById(id);

// deps : { getStyle, commitStyle, renderTheme }
// getStyle() → style parcours normalisé courant ; commitStyle(style) écrit
// dans le thème, resynchronise les contrôles et redessine.
export function createParcoursStyleUI(deps) {
    function styleColorIds() {
        return {
            find: 'parcoursStyleColorFind', lab: 'parcoursStyleColorLab', dnf: 'parcoursStyleColorDnf',
            place: 'parcoursStyleColorPlace', base: 'parcoursStyleColorBase',
        };
    }

    function readStyleUI() {
        const value = (id) => el(id)?.value;
        return normalizeParcoursStyle({
            render: value('parcoursStyleRender'),
            numbers: value('parcoursStyleNumbers'),
            color_by: value('parcoursStyleColorBy'),
            trail_by_day: el('parcoursStyleTrailByDay') ? el('parcoursStyleTrailByDay').checked : undefined,
            day_palette: paletteInputs().map((input) => input.value),
            play_current: el('parcoursStylePlayCurrent') ? el('parcoursStylePlayCurrent').checked : undefined,
            play_past: value('parcoursStylePlayPast'),
            play_preview: el('parcoursStylePlayPreview') ? el('parcoursStylePlayPreview').checked : undefined,
            favorite_mark: el('parcoursStyleFavoriteMark') ? el('parcoursStyleFavoriteMark').checked : undefined,
            favorite_burst: el('parcoursStyleFavoriteBurst') ? el('parcoursStyleFavoriteBurst').checked : undefined,
            size: value('parcoursStyleSize'),
            colors: Object.fromEntries(Object.entries(styleColorIds()).map(([kind, id]) => [kind, value(id)])),
            plan_line: value('parcoursStylePlanLine'),
            trail_color: value('parcoursStyleTrailColor'),
            trail_width: value('parcoursStyleTrailWidth'),
            trail_opacity: value('parcoursStyleTrailOpacity'),
        }, deps.getStyle());
    }

    // Reflète le thème dans les contrôles. N'écrit que le DOM (même contrat que
    // syncPointOptionsUI, qui l'appelle au chargement d'un thème).
    function sync() {
        const numbers = el('parcoursStyleNumbers');
        if (!numbers) return;
        const style = deps.getStyle();
        const set = (id, value) => {
            const input = el(id);
            if (input) input.value = String(value);
        };
        numbers.value = style.numbers;
        set('parcoursStyleRender', style.render);
        set('parcoursStyleSize', style.size);
        set('parcoursStyleColorBy', style.color_by);
        // Couleurs par nature des étapes comptées : utiles en mode « par nature »
        // seulement (lieux et bases gardent toujours la leur).
        for (const box of document.querySelectorAll('#parcoursStopsCard [data-kind-color]')) {
            box.hidden = style.color_by !== 'kind';
        }
        // Palette des journées : montrée dès qu'elle sert (étapes ou trait).
        const palette = el('parcoursStyleDayPalette');
        if (palette) palette.hidden = style.color_by !== 'day' && !style.trail_by_day;
        syncPaletteInputs(style.day_palette);
        const byDay = el('parcoursStyleTrailByDay');
        if (byDay) byDay.checked = style.trail_by_day;
        const trailColor = el('parcoursStyleTrailColor');
        if (trailColor) trailColor.disabled = style.trail_by_day;
        // Pendant la lecture : atténuation et aperçu en rendu « pastilles » seulement.
        const themed = style.render === deps.renderTheme;
        const playCurrent = el('parcoursStylePlayCurrent');
        if (playCurrent) playCurrent.checked = style.play_current;
        set('parcoursStylePlayPast', style.play_past);
        const playPreview = el('parcoursStylePlayPreview');
        if (playPreview) playPreview.checked = style.play_preview;
        for (const id of ['parcoursStylePlayPast', 'parcoursStylePlayPreview']) {
            const input = el(id);
            if (input) input.disabled = themed;
        }
        // Pastilles : points du thème masqués, leur graphisme (icône, vectoriel)
        // ne se voit pas — on le dit à côté du commutateur.
        const themeHint = el('parcoursThemePointsHint');
        if (themeHint) themeHint.hidden = themed;
        const favoriteMark = el('parcoursStyleFavoriteMark');
        if (favoriteMark) favoriteMark.checked = style.favorite_mark;
        const favoriteBurst = el('parcoursStyleFavoriteBurst');
        if (favoriteBurst) favoriteBurst.checked = style.favorite_burst;
        for (const [kind, id] of Object.entries(styleColorIds())) set(id, style.colors[kind]);
        set('parcoursStylePlanLine', style.plan_line);
        set('parcoursStyleTrailColor', style.trail_color);
        set('parcoursStyleTrailWidth', style.trail_width);
        set('parcoursStyleTrailOpacity', style.trail_opacity);
        const opacityValue = el('parcoursStyleTrailOpacityValue');
        if (opacityValue) opacityValue.textContent = `${style.trail_opacity}%`;
    }

    // Cases de la palette des journées : une par couleur, refaites quand leur
    // nombre change (thème chargé, ajout, retrait), sinon seulement mises à jour.
    function paletteInputs() {
        return [...(el('parcoursStyleDayPalette')?.querySelectorAll('.parcours-day-swatches input') || [])];
    }

    function syncPaletteInputs(colors) {
        const box = el('parcoursStyleDayPalette')?.querySelector('.parcours-day-swatches');
        if (!box) return;
        let inputs = paletteInputs();
        if (inputs.length !== colors.length) {
            box.replaceChildren();
            inputs = colors.map((_, i) => {
                const input = document.createElement('input');
                input.type = 'color';
                input.className = 'form-control form-control-color';
                const label = t('Couleur de la journée ${n}', { n: i + 1 });
                input.title = label;
                input.setAttribute('aria-label', label);
                input.addEventListener('change', () => deps.commitStyle(readStyleUI()));
                box.append(input);
                return input;
            });
        }
        colors.forEach((value, i) => { inputs[i].value = value; });
        const add = el('btnParcoursPaletteAdd');
        if (add) add.disabled = colors.length >= PARCOURS_PALETTE_SIZE[1];
        const remove = el('btnParcoursPaletteRemove');
        if (remove) remove.disabled = colors.length <= PARCOURS_PALETTE_SIZE[0];
    }

    function bind() {
        const commit = () => deps.commitStyle(readStyleUI());
        for (const id of ['parcoursStyleRender', 'parcoursStyleNumbers', 'parcoursStyleColorBy', 'parcoursStyleTrailByDay',
            'parcoursStylePlayCurrent', 'parcoursStylePlayPast', 'parcoursStylePlayPreview',
            'parcoursStyleFavoriteMark', 'parcoursStyleFavoriteBurst',
            'parcoursStyleSize', 'parcoursStylePlanLine',
            'parcoursStyleTrailColor', 'parcoursStyleTrailWidth', ...Object.values(styleColorIds())]) {
            el(id)?.addEventListener('change', commit);
        }
        // Valeur bornée réaffichée à la sortie du champ (25 → 18).
        for (const id of ['parcoursStyleSize', 'parcoursStyleTrailWidth']) {
            el(id)?.addEventListener('blur', sync);
        }
        // Opacité : suivie pendant le glisser.
        el('parcoursStyleTrailOpacity')?.addEventListener('input', commit);
        // Palette : une case de plus (couleur proposée), la dernière en moins,
        // retour aux couleurs par défaut.
        const setPalette = (colors) => deps.commitStyle(normalizeParcoursStyle({ day_palette: colors }, deps.getStyle()));
        el('btnParcoursPaletteAdd')?.addEventListener('click', () => {
            const colors = deps.getStyle().day_palette;
            if (colors.length < PARCOURS_PALETTE_SIZE[1]) setPalette([...colors, nextPaletteColor(colors)]);
        });
        el('btnParcoursPaletteRemove')?.addEventListener('click', () => {
            const colors = deps.getStyle().day_palette;
            if (colors.length > PARCOURS_PALETTE_SIZE[0]) setPalette(colors.slice(0, -1));
        });
        el('btnParcoursPaletteReset')?.addEventListener('click', () => setPalette(parcoursStyleDefaults().day_palette));
        el('btnParcoursStyleColorsReset')?.addEventListener('click', () => {
            deps.commitStyle(normalizeParcoursStyle({ colors: parcoursStyleDefaults().colors }, deps.getStyle()));
        });
        el('btnParcoursUseThemePoints')?.addEventListener('click', () => {
            deps.commitStyle(normalizeParcoursStyle({ render: deps.renderTheme }, deps.getStyle()));
        });
        sync();
    }

    return { bind, sync };
}
