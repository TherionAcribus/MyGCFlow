// Réglages de lecture de la page Parcours (onglet Animation : section
// « Lecture » de « Dates & rythme », sous-onglet « Caméra » ; Style ›
// Titres : « Titre affiché ») : rythme, heures affichées, caméra, tête du
// géocacheur, cartons de journée, nuit pointillée, titre. Persistés dans le parcours ouvert (surcharges éparses,
// `saveParcoursPlayback`) — la préférence globale `parcours_playback` sert
// de défaut et n'est écrite que sans parcours ouvert. Les réglages du lot 7
// sont lus à chaque image et s'appliquent en pleine lecture, ceux qui
// changent la chronologie la font reconstruire — tout de suite au repos, à
// la fin sinon.
//
// `playback` est partagé avec le moteur : la normalisation et l'écriture
// passent par `setPlayback` (deps) — pas d'import de parcours_data.js.
import { showToast, t } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { normalizePlayback } from './parcours_timeline.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, setPlayback, saveParcoursPlayback, applyTimeline,
//   deferTimeline, unsuspendCamera, notifyRest, redraw }
// getState() → { playback, clock, selectedId }
export function createParcoursPlaybackUI(deps) {
    const S = () => deps.getState();

    // Valeurs effectives → contrôles : à l'ouverture d'un parcours comme à
    // l'initialisation (bind).
    function sync() {
        const { playback } = S();
        const pace = el('parcoursPace');
        const hours = el('parcoursHours');
        if (pace) pace.value = playback.pace;
        if (hours) hours.value = playback.hours;
        const camera = el('parcoursCamera');
        const framing = el('parcoursFraming');
        const head = el('parcoursHead');
        const dayCards = el('parcoursDayCards');
        const dashed = el('parcoursEstimatedDashed');
        if (camera) camera.value = playback.camera;
        // Le cadrage n'agit que sur la caméra suivie.
        if (framing) {
            framing.value = playback.framing;
            framing.disabled = playback.camera !== 'follow';
        }
        if (head) head.value = playback.head;
        if (dayCards) dayCards.checked = playback.day_cards;
        if (dashed) dashed.checked = playback.estimated_dashed;
        syncTitleSource();
    }

    // Style › Titres : « Titre affiché ». Le titre du thème n'a d'effet ici
    // qu'en « Titre du thème » : son champ est grisé sinon.
    function syncTitleSource() {
        const { playback } = S();
        const source = el('parcoursTitleSource');
        if (source) source.value = playback.title;
        const themeTitle = el('inputTitle');
        if (themeTitle && source) themeTitle.disabled = playback.title === 'name';
    }

    function bind() {
        sync();
        const pace = el('parcoursPace');
        const hours = el('parcoursHours');
        // Parcours ouvert : le patch rejoint ses surcharges ; sinon la
        // préférence globale (le défaut) — saveSettingsPatch la remplace
        // dans window.userSettings par le patch envoyé, d'où la valeur
        // complète remise une fois l'écriture faite.
        const save = (patch) => {
            const next = normalizePlayback({ ...S().playback, ...patch });
            deps.setPlayback(next);
            if (S().selectedId != null) {
                deps.saveParcoursPlayback(patch);
                return;
            }
            const full = { ...next };
            saveSettingsPatch({ parcours_playback: patch }).then(() => {
                if (window.userSettings) window.userSettings.parcours_playback = full;
            });
            if (window.userSettings) window.userSettings.parcours_playback = full;
        };
        pace?.addEventListener('change', () => {
            save({ pace: pace.value });
            if (S().clock.running) {
                deps.deferTimeline();
                showToast(t("Le réglage s'appliquera à la fin de l'animation."), 'info', t('Parcours'));
                return;
            }
            deps.applyTimeline();
        });
        hours?.addEventListener('change', () => {
            save({ hours: hours.value });
            deps.notifyRest();
        });
        // Lot 7 : lus à chaque image, ils s'appliquent aussi en pleine
        // lecture.
        const camera = el('parcoursCamera');
        const framing = el('parcoursFraming');
        const head = el('parcoursHead');
        const dayCards = el('parcoursDayCards');
        const dashed = el('parcoursEstimatedDashed');
        camera?.addEventListener('change', () => {
            save({ camera: camera.value });
            if (framing) framing.disabled = camera.value !== 'follow';
            deps.unsuspendCamera();
            deps.redraw();
        });
        framing?.addEventListener('change', () => {
            save({ framing: framing.value });
            deps.redraw();
        });
        head?.addEventListener('change', () => {
            save({ head: head.value });
            deps.redraw();
        });
        dayCards?.addEventListener('change', () => {
            save({ day_cards: dayCards.checked });
            deps.redraw();
            // Le carton final allonge la chronologie : reconstruite en fin
            // de lecture, tout de suite au repos.
            if (S().clock.running) deps.deferTimeline();
            else deps.applyTimeline();
        });
        dashed?.addEventListener('change', () => {
            save({ estimated_dashed: dashed.checked });
            deps.redraw();
        });
        // Le titre est repeint par setPlayback (applyParcoursTitle).
        const titleSource = el('parcoursTitleSource');
        titleSource?.addEventListener('change', () => {
            save({ title: titleSource.value });
            syncTitleSource();
        });
    }

    return { bind, sync };
}
