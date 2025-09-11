// Script de test pour vérifier l'application immédiate du profil par défaut
console.log('🚀 Test Application Immédiate du Profil par Défaut');

// Attendre que le DOM soit chargé
document.addEventListener('DOMContentLoaded', function() {
    console.log('📋 DOM chargé');

    setTimeout(function() {
        // Tester si le sélecteur existe
        const selector = document.getElementById('selectDefaultProfile');
        if (selector) {
            console.log('✅ Sélecteur trouvé');

            // Écouter les changements pour voir les logs
            selector.addEventListener('change', function() {
                console.log('🎯 Changement détecté - Profil sélectionné:', selector.value);
                console.log('💡 Le profil devrait maintenant s\'appliquer immédiatement !');
            });

            // Simuler un changement pour tester
            if (selector.options.length > 1) {
                console.log('🔄 Simulation d\'un changement de profil...');
                const originalValue = selector.value;
                const testValue = selector.options[1].value; // Premier profil disponible

                console.log('📊 Valeur originale:', originalValue);
                console.log('🎯 Valeur de test:', testValue);

                // Changer la valeur
                selector.value = testValue;

                // Déclencher l'événement change manuellement pour tester
                console.log('⚡ Déclenchement manuel de l\'événement change...');
                selector.dispatchEvent(new Event('change'));

                console.log('✅ Test terminé - Vérifiez les logs pour voir l\'application du profil');
            } else {
                console.log('⚠️ Pas assez d\'options dans le sélecteur');
            }
        } else {
            console.log('❌ Sélecteur non trouvé - vérifiez que vous êtes sur la page des paramètres');
        }
    }, 1000); // Attendre que tout soit initialisé
});

console.log('🎯 Script de test chargé - allez dans Paramètres → Paramètres généraux');
