/**
 * Démonstration des animations de flash
 * À utiliser uniquement en développement
 */

import { triggerFlash, FlashAnimationManager, FLASH_ANIMATIONS } from './flash_animations.js';
import * as pkg from './index.js';

// Test rapide pour vérifier que les styles OpenLayers fonctionnent
window.testOpenLayersFlash = function() {
    console.log('🧪 Test des styles OpenLayers pour le flash...');

    // Simuler des options de flash
    const flashOptions = {
        mode: 'circle',
        duration: 1000,
        size: 50,
        color: '#ffffff',
        rgb: { r: 255, g: 255, b: 255 }
    };

    // Tester si les fonctions de style existent et ne retournent pas undefined
    try {
        const radius = 20;
        const opacity = 0.8;

        console.log('🔵 Test circleStyle:', !!pkg.circleStyle(radius, opacity, flashOptions));
        console.log('⭐ Test starStyle:', !!pkg.starStyle(radius, opacity, flashOptions));
        console.log('🔲 Test squareStyle:', !!pkg.squareStyle(radius, opacity, flashOptions));
        console.log('🔺 Test triangleStyle:', !!pkg.triangleStyle(radius, opacity, flashOptions));
        console.log('💎 Test diamondStyle:', !!pkg.diamondStyle(radius, opacity, flashOptions));

        console.log('✅ Tous les styles sont disponibles !');
    } catch (error) {
        console.error('❌ Erreur lors du test des styles:', error);
    }
};

// Test rapide pour vérifier que les exports fonctionnent
window.testExports = function() {
    console.log('🔍 Test des exports...');

    const functionsToTest = [
        'starStyle', 'circleStyle', 'squareStyle', 'triangleStyle', 'diamondStyle'
    ];

    let passed = 0;
    let failed = 0;

    functionsToTest.forEach(funcName => {
        try {
            if (typeof pkg[funcName] === 'function') {
                console.log(`✅ ${funcName}: Export OK`);
                passed++;
            } else {
                console.log(`❌ ${funcName}: Fonction non trouvée dans pkg`);
                failed++;
            }
        } catch (error) {
            console.log(`❌ ${funcName}: Erreur - ${error.message}`);
            failed++;
        }
    });

    console.log(`\n📊 Résultat exports: ${passed} passés, ${failed} échoués`);

    if (failed === 0) {
        console.log('🎉 Tous les exports fonctionnent !');
    } else {
        console.log('⚠️ Certains exports ont des problèmes.');
    }
};

// Test rapide pour vérifier les exports et le système de flash
window.testFlashSystem = function() {
    console.log('🧪 Test du système de flash OpenLayers...');

    const flashOptions = {
        mode: 'circle',
        duration: 1000,
        size: 50,
        color: '#ffffff',
        rgb: { r: 255, g: 255, b: 255 }
    };

    const radius = 20;
    const opacity = 0.8;

    const tests = [
        { name: 'circleStyle', func: () => pkg.circleStyle(radius, opacity, flashOptions) },
        { name: 'starStyle', func: () => pkg.starStyle(radius, opacity, flashOptions) },
        { name: 'squareStyle', func: () => pkg.squareStyle(radius, opacity, flashOptions) },
        { name: 'triangleStyle', func: () => pkg.triangleStyle(radius, opacity, flashOptions) },
        { name: 'diamondStyle', func: () => pkg.diamondStyle(radius, opacity, flashOptions) },
        { name: 'heartStyle', func: () => pkg.heartStyle(radius, opacity, flashOptions) },
        { name: 'pulseStyle', func: () => pkg.pulseStyle(radius, opacity, flashOptions) },
        { name: 'ringStyle', func: () => pkg.ringStyle(radius, opacity, flashOptions) },
        { name: 'spiralStyle', func: () => pkg.spiralStyle(radius, opacity, flashOptions) },
    ];

    let passed = 0;
    let failed = 0;

    tests.forEach(test => {
        try {
            const result = test.func();
            if (result && result.getImage && typeof result.getImage === 'function') {
                console.log(`✅ ${test.name}: OK`);
                passed++;
            } else {
                console.log(`❌ ${test.name}: Style invalide`);
                failed++;
            }
        } catch (error) {
            console.log(`❌ ${test.name}: Erreur - ${error.message}`);
            failed++;
        }
    });

    console.log(`\n📊 Résultat: ${passed} passés, ${failed} échoués`);

    if (failed === 0) {
        console.log('🎉 Toutes les fonctions de style fonctionnent correctement !');
        console.log('💡 Vous pouvez maintenant utiliser tous les nouveaux modes de flash !');
    } else {
        console.log('⚠️ Certaines fonctions ont des problèmes. Vérifiez les logs ci-dessus.');
    }
};

// Fonction de démonstration (à appeler depuis la console)
window.demoFlashAnimations = function(map, layer) {
    console.log('🎯 Démarrage de la démonstration des flashs...');
    console.log('📋 Formes disponibles:', Object.keys(FLASH_ANIMATIONS));

    // Créer quelques points de test si aucun n'existe
    const testFeatures = createTestFeatures();

    // Démonstration séquentielle
    let index = 0;
    const flashTypes = Object.keys(FLASH_ANIMATIONS).filter(type => type !== 'none');

    const demoNextFlash = () => {
        if (index >= flashTypes.length) {
            console.log('✅ Démonstration terminée !');
            return;
        }

        const flashType = flashTypes[index];
        const feature = testFeatures[index % testFeatures.length];

        console.log(`✨ Test de ${FLASH_ANIMATIONS[flashType].name} (${flashType})`);

        // Déclencher le flash
        triggerFlash(map, layer, feature, {
            mode: flashType,
            duration: 1000,
            size: 60,
            color: getRandomColor(),
            intensity: 0.8
        });

        index++;

        // Prochain flash dans 1.5 secondes
        setTimeout(demoNextFlash, 1500);
    };

    // Démarrer la démonstration
    setTimeout(demoNextFlash, 500);
};

// Fonction pour créer des points de test
function createTestFeatures() {
    const features = [];

    // Coordonnées de test autour de Paris (ajustez selon votre carte)
    const testCoords = [
        [2.3522, 48.8566],   // Paris centre
        [2.3422, 48.8666],   // Paris nord
        [2.3622, 48.8466],   // Paris sud
        [2.3322, 48.8566],   // Paris ouest
        [2.3722, 48.8566],   // Paris est
    ];

    testCoords.forEach((coord, index) => {
        // Créer une feature OpenLayers
        const feature = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat(coord)),
            name: `Point test ${index + 1}`,
            type: 'demo'
        });

        features.push(feature);
    });

    return features;
}

// Fonction pour générer une couleur aléatoire
function getRandomColor() {
    const colors = [
        '#ffffff', // Blanc
        '#ffff00', // Jaune
        '#ff0000', // Rouge
        '#00ff00', // Vert
        '#0000ff', // Bleu
        '#ff00ff', // Magenta
        '#00ffff', // Cyan
        '#ffa500', // Orange
        '#800080', // Violet
        '#ffc0cb'  // Rose
    ];

    return colors[Math.floor(Math.random() * colors.length)];
}

// Fonction pour tester un flash spécifique
window.testSpecificFlash = function(map, layer, flashType, featureIndex = 0) {
    const testCoords = [
        [2.3522, 48.8566],   // Paris centre
    ];

    const coord = testCoords[featureIndex % testCoords.length];
    const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat(coord)),
        name: `Test ${flashType}`,
        type: 'test'
    });

    console.log(`🎯 Test de ${FLASH_ANIMATIONS[flashType]?.name || flashType}`);

    triggerFlash(map, layer, feature, {
        mode: flashType,
        duration: 1200,
        size: 80,
        color: '#ffffff',
        intensity: 0.9
    });
};

// Message d'aide dans la console
console.log(`
🎨 ANIMATIONS DE FLASH DISPONIBLES

Commandes de démonstration :
• demoFlashAnimations(map, layer)  - Teste toutes les formes
• testSpecificFlash(map, layer, 'heart') - Teste une forme spécifique
• testFlashSystem() - Vérifie que toutes les fonctions fonctionnent
• testExports() - Vérifie que tous les exports sont corrects

Formes disponibles :
${Object.entries(FLASH_ANIMATIONS).map(([key, value]) =>
    `• ${key.padEnd(10)} : ${value.name}`
).join('\n')}

Exemples :
testSpecificFlash(map, layer, 'star')
testSpecificFlash(map, layer, 'diamond')
testSpecificFlash(map, layer, 'square')
testFlashSystem()
testExports()
`);
