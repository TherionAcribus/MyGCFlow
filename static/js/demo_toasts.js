/**
 * Démonstration du système de notifications toast
 * À utiliser pour tester les différentes fonctionnalités
 */

import * as pkg from './index.js';

// Fonction de démonstration (à appeler depuis la console)
window.demoToasts = function() {
    console.log("🚀 Démonstration du système de toasts");

    // Toast simple
    setTimeout(() => {
        pkg.showToast("Ceci est un message d'information", "info", "Demo");
    }, 500);

    // Toast de succès
    setTimeout(() => {
        pkg.showToast("Opération réussie !", "success", "Succès");
    }, 2000);

    // Toast d'erreur
    setTimeout(() => {
        pkg.showToast("Une erreur s'est produite", "error", "Erreur");
    }, 4000);

    // Toast d'avertissement
    setTimeout(() => {
        pkg.showToast("Attention : action requise", "warning", "Attention");
    }, 6000);

    // Toast avec progress bar
    setTimeout(() => {
        const loadingToast = pkg.showLoadingToast("Simulation de chargement...");
        let progress = 0;
        const interval = setInterval(() => {
            progress += 10;
            pkg.updateToastProgress(loadingToast, progress);
            if (progress >= 100) {
                clearInterval(interval);
                pkg.hideToast(loadingToast);
                pkg.showToast("Chargement terminé !", "success", "Terminé");
            }
        }, 300);
    }, 8000);

    // Toast de confirmation
    setTimeout(() => {
        pkg.showConfirmation(
            "Voulez-vous continuer cette démonstration ?",
            "Confirmation",
            () => console.log("✅ Utilisateur a confirmé"),
            () => console.log("❌ Utilisateur a annulé")
        );
    }, 10000);
};

// Fonction pour nettoyer tous les toasts
window.clearAllToasts = function() {
    pkg.clearAllToasts();
    console.log("🧹 Tous les toasts ont été supprimés");
};

console.log("🎯 Système de toasts chargé !");
console.log("💡 Utilisez demoToasts() dans la console pour voir la démonstration");
console.log("🧹 Utilisez clearAllToasts() pour nettoyer");
