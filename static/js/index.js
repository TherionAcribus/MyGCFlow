export * from './mapOptions.js';
export * from './utils.js';
export * from './ui.js';
export * from './ui_bootstrap.js';
export * from './init.js';
export * from './basemaps.js';
export * from './gc_colors.js';
export * from './point_webgl_style.js';
export * from './flash_styles.js';
export * from './overlay_canvas.js';
export * from './stats_panels.js';
export * from './images_panels.js';
export * from './stats_ui.js';
// Après images_panels.js : s'initialise lui-même en fin de module.
export * from './images_ui.js';
export * from './recording_perf.js';
export * from './upload_queue.js';
export * from './background_audio.js';
export * from './video_postprocess.js';
export * from './video_ready.js';
export * from './video_folder.js';
export * from './recent_videos.js';
export * from './mapgl.js';
export * from './bdd.js';
export * from './record.js';
export * from './frames.js';
export * from './options.js';
export * from './notifications.js';
export * from './flash_animations.js';
export * from './profiles.js';
export * from './theme.js';
export * from './evolution_data.js';
// Après evolution_data.js ; noms d'export uniques (posesXxx) : `export *`
// écarte en silence un nom exporté par deux modules.
export * from './poses_data.js';
export * from './infos_editor.js';
export * from './labs.js';
// S'initialise lui-même en fin de module (cf. AGENTS.md, ordre d'évaluation).
export * from './gc_logs.js';
// Points DNF (après bdd.js et ui.js, qu'il appelle) ; s'initialise lui-même.
export * from './dnf_data.js';
// Après ui.js : s'initialise lui-même (cf. AGENTS.md, ordre d'évaluation).
export * from './timeline_bar.js';

// Scripts de démonstration (fonctions window.demo*/test* à appeler depuis la
// console), réservés au développement. Le drapeau vient de Flask : tester
// l'adresse ne servait à rien puisque l'application installée sert elle aussi
// sur 127.0.0.1, et ces fichiers ne sont pas dans le paquet distribué.
if (document.body?.dataset.dev === '1') {
    import('./demo_toasts.js');
    import('./demo_flash.js');
}