export * from './mapOptions.js';
export * from './utils.js';
export * from './ui.js';
export * from './ui_bootstrap.js';
export * from './init.js';
export * from './basemaps.js';
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

// Import des fichiers de démonstration uniquement en développement
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    import('./demo_toasts.js');
    import('./demo_flash.js');
}