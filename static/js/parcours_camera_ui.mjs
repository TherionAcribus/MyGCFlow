// Caméra de la lecture du parcours : suivi du géocacheur (pose pré-rendu
// de parcours_camera.mjs), sauvegarde et restitution de la vue autour de la
// lecture, suspension quand l'utilisateur reprend la main (sauf pendant une
// capture), préchargement des tuiles de la suite.
//
// L'état du moteur arrive par `getState()` ; la carte et la capture par
// deps — pas d'import de parcours_data.js.
import { CAMERA_FOLLOW } from './parcours_timeline.mjs';
import { cameraPoseAt } from './parcours_camera.mjs';

// deps : { getState, getMap, isRecording, prefetchTiles }
export function createParcoursCamera(deps) {
    const S = () => deps.getState();

    let savedView = null;
    let cameraSuspended = false;
    let cameraBound = false;
    let prefetchBucket = null;

    function following() {
        const { clock, playback, timeline } = S();
        return clock.running && playback.camera === CAMERA_FOLLOW && !cameraSuspended && !!timeline;
    }

    // Début de lecture : la vue courante est gardée pour la fin.
    function begin() {
        const view = deps.getMap()?.getView();
        savedView = view ? { center: view.getCenter(), resolution: view.getResolution() } : null;
        cameraSuspended = false;
        prefetchBucket = null;
    }

    // Fin de lecture : la vue d'avant, sauf si l'utilisateur a repris la
    // main.
    function end() {
        const view = deps.getMap()?.getView();
        if (view && savedView && S().playback.camera === CAMERA_FOLLOW && !cameraSuspended) {
            view.setCenter(savedView.center);
            view.setResolution(savedView.resolution);
        }
        savedView = null;
    }

    // Carte déplacée ou zoomée à la main pendant la lecture : la caméra la
    // laisse. Pendant une capture en revanche, un geste parasite ne doit pas
    // figer la caméra pour tout le reste de la vidéo — la pose est reposée à
    // l'image suivante, la suspension serait silencieuse et définitive.
    function bindSuspension(map) {
        if (cameraBound) return;
        cameraBound = true;
        const suspend = () => {
            if (deps.isRecording()) return;
            const { clock, playback } = S();
            if (clock.running && playback.camera === CAMERA_FOLLOW) cameraSuspended = true;
        };
        map.on('pointerdrag', suspend);
        map.getViewport().addEventListener('wheel', suspend, { passive: true });
    }

    // Appelée par mapgl.js avant chaque rendu (updatePointAppearClock). La
    // pose posée en pré-rendu s'applique à l'image suivante : en capture
    // image par image, `leadMs` (une image) la fait tomber sur la bonne.
    function camera(leadMs = 0, msPerDay = 1) {
        const { timeline, currentQ } = S();
        if (!following()) return false;
        const map = deps.getMap();
        const size = map?.getSize();
        const perDay = Math.max(1e-3, Number(msPerDay) || 1);
        const q = currentQ + Math.max(0, Number(leadMs) || 0) / perDay;
        // Constantes de temps de la caméra en secondes d'écran (dixième de ms :
        // une piste par valeur sert le cache sans l'inonder).
        const timing = { msPerDay: Math.round(perDay * 10) / 10 };
        const pose = cameraPoseAt(timeline, q, size, timing);
        if (!pose) return false;
        const view = map.getView();
        const center = view.getCenter();
        const moved = !center || center[0] !== pose.center[0] || center[1] !== pose.center[1]
            || view.getResolution() !== pose.resolution;
        if (moved) {
            view.setCenter(pose.center);
            view.setResolution(pose.resolution);
        }
        // Tuiles de la suite chargées d'avance (une demande par seconde
        // d'écran, 1,5 s plus loin).
        const bucket = Math.floor((q * perDay) / 1000);
        if (bucket !== prefetchBucket) {
            prefetchBucket = bucket;
            const ahead = cameraPoseAt(timeline, q + 1500 / perDay, size, timing);
            if (ahead) deps.prefetchTiles(ahead.center, ahead.zoom);
        }
        return moved;
    }

    return {
        begin,
        end,
        bindSuspension,
        camera,
        following,
        suspended: () => cameraSuspended,
        unsuspend: () => { cameraSuspended = false; },
    };
}
