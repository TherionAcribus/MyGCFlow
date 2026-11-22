// Réglages de lecture de la page Parcours (onglet Animation : section
// « Lecture » de « Dates & rythme », sous-onglet « Caméra ») : rythme,
// heures affichées, caméra, tête du géocacheur, cartons de journée, nuit
// pointillée. Persistés dans `parcours_playback` (settings_api) ; les
// réglages du lot 7 sont lus à chaque image et s'appliquent en pleine
// lecture, ceux qui changent la chronologie la font reconstruire — tout de
// suite au repos, à la fin sinon.
//
// `playback` est partagé avec le moteur : la normalisation et l'écriture
// passent par `setPlayback` (deps) — pas d'import de parcours_data.js.
import { showToast, t } from './notifications.js';
import { saveSettingsPatch } from './settings_api.mjs';
import { normalizePlayback } from './parcours_timeline.mjs';

const el = (id) => document.getElementById(id);

// deps : { getState, setPlayback, applyTimeline, deferTimeline,
//   unsuspendCamera, notifyRest, redraw }
export function createParcoursPlaybackUI(deps) {
    const S = () => deps.getState();

    function bind() {
        const { playback } = S();
        const pace = el('parcoursPace');
        const hours = el('parcoursHours');
        if (pace) pace.value = playback.pace;
        if (hours) hours.value = playback.hours;
        // saveSettingsPatch remplace la clé entière dans window.userSettings
        // par le patch envoyé : la valeur complète y est remise une fois
        // l'écriture faite.
        const save = (patch) => {
            const next = normalizePlayback({ ...S().playback, ...patch });
            const full = { ...next };
            deps.setPlayback(next);
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
        const head = el('parcoursHead');
        const dayCards = el('parcoursDayCards');
        const dashed = el('parcoursEstimatedDashed');
        if (camera) camera.value = playback.camera;
        if (head) head.value = playback.head;
        if (dayCards) dayCards.checked = playback.day_cards;
        if (dashed) dashed.checked = playback.estimated_dashed;
        camera?.addEventListener('change', () => {
            save({ camera: camera.value });
            deps.unsuspendCamera();
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
    }

    return { bind };
}
