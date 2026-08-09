// Script de test manuel : vérifie l'état carte tel que le lisent les profils.
// L'état carte n'est plus déduit du DOM (classe 'disabled' des boutons,
// visibilité des panneaux d'options) : sa source de vérité est pkg.options.map,
// écrite par switchLayer() et par les gestionnaires d'options de ui.js.
// Le DOM n'en est qu'un reflet — d'où la vérification de cohérence ci-dessous.
// Couverture automatisée équivalente : tests/e2e/map-source-of-truth.spec.mjs
console.log('🗺️ Test état carte (source de vérité : pkg.options.map)');

document.addEventListener('DOMContentLoaded', function() {
    console.log('📋 DOM chargé');

    setTimeout(async function() {
        const app = await import('/static/js/index.js');

        // 1. La source de vérité
        console.log('🔍 pkg.options.map:', JSON.parse(JSON.stringify(app.options.map)));

        // 2. Ce qu'en lit le gestionnaire de profils
        if (window.profileManager && window.profileManager.loadCurrentSettings) {
            window.profileManager.loadCurrentSettings();
            console.log('🎯 Profil - paramètres carte:', window.profileManager.currentSettings.map);
        } else {
            console.log('❌ profileManager.loadCurrentSettings non disponible');
        }

        // 3. Cohérence du reflet DOM : un seul bouton doit être 'disabled',
        //    celui du fond actif.
        const expected = app.options.map.default;
        ['OSM', 'stamenToner', 'vectorMap', 'watercolor'].forEach(btnId => {
            const btn = document.getElementById(btnId);
            if (!btn) {
                console.log(`  ${btnId}: NON TROUVÉ`);
                return;
            }
            const selected = btn.classList.contains('disabled');
            const ok = selected === (btnId === expected);
            console.log(`  ${btnId}: ${selected ? 'sélectionné' : 'inactif'} ${ok ? '✅' : '❌ incohérent avec les options'}`);
        });
    }, 1000); // Attendre que tout soit initialisé
});

console.log('🎯 Script de test chargé - allez dans Style → onglet avec les cartes');
