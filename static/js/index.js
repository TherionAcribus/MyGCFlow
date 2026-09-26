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
export * from './recording_perf.js';
export * from './upload_queue.js';
export * from './background_audio.js';
export * from './video_postprocess.js';
export * from './mapgl.js';
export * from './bdd.js';
export * from './record.js';
export * from './frames.js';
export * from './options.js';
export * from './notifications.js';
export * from './flash_animations.js';
export * from './profiles.js';
export * from './theme.js';

// Scripts de démonstration (fonctions window.demo*/test* à appeler depuis la
// console), réservés au développement. Le drapeau vient de Flask : tester
// l'adresse ne servait à rien puisque l'application installée sert elle aussi
// sur 127.0.0.1, et ces fichiers ne sont pas dans le paquet distribué.
if (document.body?.dataset.dev === '1') {
    import('./demo_toasts.js');
    import('./demo_flash.js');
}