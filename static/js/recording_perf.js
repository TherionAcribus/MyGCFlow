// Métriques et surveillance des performances d'enregistrement.
//
// Extrait de mapgl.js. Deux responsabilités voisines mais distinctes :
//  - perfMetrics : compteurs bruts d'une session (frames capturées, uploads,
//    temps cumulés), agrégés dans le bilan de fin d'enregistrement ;
//  - recordingPerformanceMonitor : détection à chaud des frames lentes et
//    proposition à l'utilisateur d'augmenter le ralentissement (MediaRecorder).
//
// Aucun état partagé avec l'animation ou la carte : ce module ne dépend que de
// `pkg` (toasts, options, i18n) et du DOM.
import * as pkg from './index.js';

// Compteurs de la session en cours. L'objet n'est JAMAIS réaffecté (seulement
// remis à zéro champ par champ par resetPerfMetrics) : les modules qui
// l'importent gardent ainsi une référence valable d'une session à l'autre.
export const perfMetrics = {
    totalFrames: 0,
    capturedFrames: 0,
    uploadOk: 0,
    uploadFail: 0,
    captureTimeMs: 0,
    uploadTimeMs: 0,
    startedAt: 0,
    lastCaptureStart: 0,
};

export function resetPerfMetrics() {
    perfMetrics.totalFrames = 0;
    perfMetrics.capturedFrames = 0;
    perfMetrics.uploadOk = 0;
    perfMetrics.uploadFail = 0;
    perfMetrics.captureTimeMs = 0;
    perfMetrics.uploadTimeMs = 0;
    perfMetrics.startedAt = performance.now();
    perfMetrics.lastCaptureStart = 0;
}

// Système global de surveillance des performances d'enregistrement
export const recordingPerformanceMonitor = {
    frameTimings: [],
    performanceWarningShown: false,
    lastWarningLevel: 0, // Niveau de la dernière alerte (pour permettre les alertes successives)
    isMonitoring: false,
    currentPerformanceToast: null, // Référence au toast de performance actuel

    reset() {
        this.frameTimings = [];
        this.performanceWarningShown = false;
        this.lastWarningLevel = 0;
        this.isMonitoring = false;
        this.currentPerformanceToast = null;
    },

    startMonitoring() {
        this.reset();
        this.isMonitoring = true;
    },

    stopMonitoring() {
        this.isMonitoring = false;
        // Fermer le toast de performance en cours
        this.closeCurrentPerformanceToast();
    },

    // Fonction pour fermer le toast actuel
    closeCurrentPerformanceToast() {
        if (this.currentPerformanceToast) {
            try {
                pkg.hideToast && pkg.hideToast(this.currentPerformanceToast);
            } catch(_) {
                try { this.currentPerformanceToast.remove(); } catch(_) {}
            }
            this.currentPerformanceToast = null;
        }
    },

    // Fonction pour vérifier si le toast existe encore
    isPerformanceToastVisible() {
        if (!this.currentPerformanceToast) return false;

        // Vérifier si l'élément existe encore dans le DOM
        return document.body.contains(this.currentPerformanceToast);
    },

    // Fonction pour mettre à jour le contenu d'un toast existant
    updatePerformanceToastContent(newMessage, newTitle = 'Performance enregistrement') {
        if (!this.isPerformanceToastVisible()) return false;

        try {
            const titleElement = this.currentPerformanceToast.querySelector('.gcm-toast-title');
            const messageElement = this.currentPerformanceToast.querySelector('.gcm-toast-message');

            if (titleElement) titleElement.textContent = newTitle;
            if (messageElement) messageElement.textContent = newMessage;

            // Réanimer le toast pour attirer l'attention
            this.currentPerformanceToast.classList.remove('show');
            setTimeout(() => {
                if (this.currentPerformanceToast) {
                    this.currentPerformanceToast.classList.add('show');
                }
            }, 100);

            return true;
        } catch(err) {
            return false;
        }
    },

    checkPerformance(frameTime, expectedFrameTime, recordingMode = 'unknown') {
        // Pas pertinent pour le mode images/MoviePy (juste plus long, pas un problème perf interactif)
        if (recordingMode === 'images') return;
        if (!this.isMonitoring) return;

        this.frameTimings.push(frameTime);

        const PERFORMANCE_CHECK_INTERVAL = 30;
        const FRAME_TIME_THRESHOLD = expectedFrameTime * 2.5; // 2.5x le temps attendu
        const BAD_FRAMES_THRESHOLD = 0.3; // 30% de frames lentes = problème

        if (this.frameTimings.length >= PERFORMANCE_CHECK_INTERVAL) {
            const slowFrames = this.frameTimings.filter(time => time > FRAME_TIME_THRESHOLD).length;
            const slowFrameRatio = slowFrames / this.frameTimings.length;

            // Déterminer le niveau de sévérité (permet plusieurs alertes)
            const warningLevel = Math.floor(slowFrameRatio * 10); // 0-10 selon pourcentage
            const shouldAlert = slowFrameRatio > BAD_FRAMES_THRESHOLD && warningLevel > this.lastWarningLevel;

            if (shouldAlert) {
                this.lastWarningLevel = warningLevel;
                const currentSlowdown = Math.max(1, parseInt(pkg.options?.record?.mediaRecorder?.slowdownFactor) || 1);
                const suggestedSlowdown = Math.min(8, currentSlowdown + 1);


                if (recordingMode === 'mediarecorder' && suggestedSlowdown <= 8) {
                    // Offrir d'augmenter automatiquement le ralentissement
                    const message = pkg.t(
                        "Performance d'enregistrement instable (${pct}% de frames lentes). Souhaitez-vous augmenter le ralentissement à x${slowdown} automatiquement ?",
                        { pct: Math.round(slowFrameRatio * 100), slowdown: suggestedSlowdown }
                    );

                    // Vérifier si on peut réutiliser le toast existant
                    if (this.isPerformanceToastVisible()) {
                        // Mettre à jour le toast existant
                        const updated = this.updatePerformanceToastContent(message);
                        if (updated) {
                            return; // Pas besoin de créer un nouveau toast
                        } else {
                            // Échec de la mise à jour, fermer l'ancien
                            this.closeCurrentPerformanceToast();
                        }
                    }

                    // Créer un nouveau toast seulement si nécessaire
                    try {
                        if (pkg && pkg.showConfirmation) {
                            this.currentPerformanceToast = pkg.showConfirmation(
                                message,
                                "Performance enregistrement",
                                () => {
                                    // Confirmation : augmenter le ralentissement
                                    try {
                                        pkg.options.record.mediaRecorder.slowdownFactor = suggestedSlowdown;
                                        // Refléter la nouvelle valeur dans le champ AVANT d'enregistrer :
                                        // c'est lui que l'indicateur « Enregistré ✓ » vient confirmer.
                                        const slowdownInput = document.getElementById('inputRecordSlowdown');
                                        if (slowdownInput) slowdownInput.value = suggestedSlowdown;
                                        // Le ralentissement est une préférence globale : il doit survivre
                                        // au rechargement, comme s'il avait été saisi dans le formulaire.
                                        // Champ nommé explicitement — on ne vient pas d'une saisie, donc
                                        // le « dernier champ manipulé » ne désignerait pas celui-ci.
                                        pkg.saveRecordSettings('inputRecordSlowdown');

                                        pkg.showToast && pkg.showToast(
                                            pkg.t("Ralentissement augmenté à x${slowdown}. Redémarrez l'enregistrement pour appliquer le changement.", { slowdown: suggestedSlowdown }),
                                            'success',
                                            'Paramètre mis à jour',
                                            8000
                                        );
                                    } catch(err) {
                                        console.error('Erreur lors de l\'application du ralentissement:', err);
                                        pkg.showToast && pkg.showToast('Erreur lors de la mise à jour du paramètre.', 'error', 'Erreur', 5000);
                                    }
                                    this.currentPerformanceToast = null; // Reset après confirmation
                                },
                                () => {
                                    // Annulation : juste afficher un conseil
                                    pkg.showToast && pkg.showToast(
                                        pkg.t("Vous pouvez manuellement augmenter le ralentissement à x${slowdown} dans les paramètres d'enregistrement.", { slowdown: suggestedSlowdown }),
                                        'info',
                                        'Conseil',
                                        8000
                                    );
                                    this.currentPerformanceToast = null; // Reset après annulation
                                }
                            );
                        } else {
                            throw new Error('showConfirmation non disponible');
                        }
                    } catch(err) {
                        // Fallback vers toast simple
                        const fallbackMessage = pkg.t(
                            "Performance instable (${pct}% de frames lentes). Augmentez le ralentissement à x${slowdown} dans les paramètres.",
                            { pct: Math.round(slowFrameRatio * 100), slowdown: suggestedSlowdown }
                        );

                        // Même logique pour le fallback
                        if (this.isPerformanceToastVisible()) {
                            this.updatePerformanceToastContent(fallbackMessage);
                        } else if (pkg && pkg.showToast) {
                            this.currentPerformanceToast = pkg.showToast(fallbackMessage, 'warning', 'Performance enregistrement', 10000);
                        }
                    }
                } else {
                    // Mode images ou ralentissement déjà au maximum
                    let suggestion = '';
                    if (recordingMode === 'mediarecorder') {
                        suggestion = pkg.t(
                            "Le ralentissement est déjà au maximum (x${slowdown}). Réduisez le nombre de points affichés ou la résolution.",
                            { slowdown: currentSlowdown }
                        );
                    } else {
                        suggestion = "Réduisez la vitesse d'animation (augmentez la durée par jour) ou le nombre de points affichés.";
                    }

                    const message = pkg.t(
                        "Performance d'enregistrement instable (${pct}% de frames lentes). ${suggestion}",
                        { pct: Math.round(slowFrameRatio * 100), suggestion }
                    );

                    // Même logique pour les suggestions
                    if (this.isPerformanceToastVisible()) {
                        this.updatePerformanceToastContent(message);
                    } else {
                        try {
                            if (pkg && pkg.showToast) {
                                this.currentPerformanceToast = pkg.showToast(message, 'warning', 'Performance enregistrement', 10000);
                            }
                        } catch(err) {
                            // Silencieux en cas d'erreur d'affichage toast
                        }
                    }
                }
            }

            // Limiter la taille du buffer
            this.frameTimings = this.frameTimings.slice(-PERFORMANCE_CHECK_INTERVAL);
        }
    }
};
