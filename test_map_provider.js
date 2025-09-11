// Script de test pour vérifier la détection des providers de carte
console.log('🗺️ Test détection provider de carte - VERSION AMÉLIORÉE');

// Attendre que le DOM soit chargé
document.addEventListener('DOMContentLoaded', function() {
    console.log('📋 DOM chargé');

    setTimeout(function() {
        // Tester la fonction loadCurrentSettings du profileManager
        if (window.profileManager && window.profileManager.loadCurrentSettings) {
            console.log('✅ Fonction loadCurrentSettings disponible');

            console.log('🔍 Test récupération paramètres actuels (incluant carte)...');
            window.profileManager.loadCurrentSettings();

            // Attendre un peu pour voir les logs
            setTimeout(() => {
                console.log('🎯 Test terminé - Vérifiez les logs pour voir le provider détecté');
            }, 500);

        } else {
            console.log('❌ Fonction loadCurrentSettings non disponible');
        }

        // Vérifier aussi manuellement l'état des boutons avec la bonne classe 'disabled'
        console.log('🔍 Vérification manuelle des boutons carte (classe "disabled"):');
        const mapButtons = ['OSM', 'stamenToner', 'vectorMap', 'watercolor'];

        mapButtons.forEach(btnId => {
            const btn = document.getElementById(btnId);
            if (btn) {
                const classes = Array.from(btn.classList);
                const hasDisabled = classes.includes('disabled');
                console.log(`  ${btnId}: ${hasDisabled ? 'ACTIF (disabled)' : 'inactif'} (classes: ${classes.join(', ')})`);
            } else {
                console.log(`  ${btnId}: NON TROUVÉ`);
            }
        });

        // Vérifier aussi les options de carte
        console.log('🔍 Vérification des options de carte:');
        const vectorOptions = document.getElementById('vectorMapOptions');
        const tonerOptions = document.getElementById('tonerMapOptions');

        console.log(`  vectorMapOptions: ${vectorOptions ? vectorOptions.style.display : 'non trouvé'}`);
        console.log(`  tonerMapOptions: ${tonerOptions ? tonerOptions.style.display : 'non trouvé'}`);

    }, 1000); // Attendre que tout soit initialisé
});

console.log('🎯 Script de test chargé - allez dans Style → onglet avec les cartes');
