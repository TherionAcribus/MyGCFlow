// Script de test pour vérifier que profileManager et les nouvelles fonctionnalités fonctionnent
console.log('🧪 TEST ÉTENDU - profileManager et récupération des paramètres...');

// Attendre que le DOM soit chargé
document.addEventListener('DOMContentLoaded', function() {
    console.log('📋 DOM chargé - Test des éléments HTML...');

    // Vérifier que profileManager est disponible
    setTimeout(function() {
        if (window.profileManager) {
            console.log('✅ profileManager est disponible globalement');

            // Tester la récupération des paramètres actuels
            console.log('🔍 Test récupération paramètres actuels...');
            window.profileManager.loadCurrentSettings();

            // Attendre un peu pour voir les logs
            setTimeout(function() {
                console.log('🎯 Test des fonctions d\'application...');

                // Tester applyMapSettings (vérifier seulement si la fonction existe)
                if (typeof window.applyMapSettings === 'function') {
                    console.log('✅ applyMapSettings disponible');
                } else {
                    console.log('❌ applyMapSettings non disponible');
                }

                if (typeof window.applyPointSettings === 'function') {
                    console.log('✅ applyPointSettings disponible');

                    // Tester avec des paramètres de bordure spécifiques
                    console.log('🔍 Test application bordures...');
                    const testBorderOptions = {
                        size: 10,
                        color: '#ff5722',
                        shape: 'circle',
                        halo: true,
                        border_color: '#ff0000',
                        border_size: 8,
                        fill_color_type: 'fix',
                        border_color_type: 'fix'
                    };

                    try {
                        window.applyPointSettings(testBorderOptions);
                        console.log('✅ Test application bordures terminé');
                    } catch (error) {
                        console.error('❌ Erreur test bordures:', error);
                    }
                } else {
                    console.log('❌ applyPointSettings non disponible');
                }

                if (typeof window.applyFlashSettings === 'function') {
                    console.log('✅ applyFlashSettings disponible');
                } else {
                    console.log('❌ applyFlashSettings non disponible');
                }

                if (typeof window.applyAnimationSettings === 'function') {
                    console.log('✅ applyAnimationSettings disponible');
                } else {
                    console.log('❌ applyAnimationSettings non disponible');
                }

                console.log('🎯 Tests terminés. Vérifiez les logs ci-dessus pour les valeurs récupérées.');

                // Test de l'affichage du profil actif
                console.log('🎨 Test affichage profil actif...');

                // Simuler le chargement d'un profil
                const testProfile = { name: 'Test', version: 1 };
                profileManager.currentProfile = testProfile;

                // Tester la mise à jour de l'indicateur
                profileManager.updateCurrentProfileIndicator();

                // Vérifier que l'indicateur a été mis à jour
                const indicator = document.getElementById('current-profile-indicator');
                if (indicator && indicator.textContent.includes('Test')) {
                    console.log('✅ Indicateur de profil actif mis à jour correctement');
                } else {
                    console.log('❌ Indicateur de profil actif non mis à jour');
                }

                console.log('🎨 Test affichage profil actif terminé.');

                // Test du système de toast GCM
                console.log('🍞 Test système de toast GCM...');
                try {
                    // Tester différents types de toasts
                    setTimeout(() => {
                        if (window.profileManager && window.profileManager.showToast) {
                            console.log('✅ Fonction showToast disponible');

                            // Test success
                            window.profileManager.showToast('Test toast succès', 'green');
                            console.log('📤 Toast succès envoyé');

                            // Test error
                            setTimeout(() => {
                                window.profileManager.showToast('Test toast erreur', 'red');
                                console.log('📤 Toast erreur envoyé');
                            }, 1000);

                            // Test warning
                            setTimeout(() => {
                                window.profileManager.showToast('Test toast avertissement', 'orange');
                                console.log('📤 Toast avertissement envoyé');
                            }, 2000);

                        } else {
                            console.log('❌ Fonction showToast non disponible');
                        }
                    }, 500);

                } catch (error) {
                    console.error('❌ Erreur test système toast:', error);
                }

                console.log('🍞 Test système toast terminé.');

                // Test spécifique des types de couleur
                console.log('🎨 Test des types de couleur...');
                const fillColorChecked = document.querySelector('input[name="fillColorPoint"]:checked');
                const borderColorChecked = document.querySelector('input[name="borderColorPoint"]:checked');

                console.log('Types de couleur actuels:', {
                    fill: fillColorChecked ? fillColorChecked.value : 'none',
                    border: borderColorChecked ? borderColorChecked.value : 'none'
                });

            }, 500);

        } else {
            console.error('❌ profileManager n\'est pas disponible globalement');
        }
    }, 100);
});
