# Détection automatique des saccades d'enregistrement

## Fonctionnalité

Le système de détection automatique des saccades surveille en temps réel les performances d'enregistrement et alerte l'utilisateur lorsque des problèmes de fluidité sont détectés.

## Comment ça marche

### Surveillance temps réel
- **Fréquence de vérification** : Toutes les 30 frames
- **Seuil de détection** : 2,5x le temps attendu par frame
- **Seuil d'alerte** : 20% de frames lentes = problème détecté

### Types d'alertes

#### Mode MediaRecorder
- **Toast de confirmation** proposant d'augmenter automatiquement le ralentissement
- **Action automatique** : Mise à jour du paramètre `slowdownFactor` et de l'interface
- **Persistance** : Sauvegarde du nouveau paramètre

#### Mode Capture d'images
- **Toast d'information** avec conseils d'optimisation
- **Suggestions** : Réduire la vitesse d'animation ou le nombre de points

### Paramètres configurables

```javascript
// Dans recordingPerformanceMonitor
const PERFORMANCE_CHECK_INTERVAL = 30;      // Frames avant vérification
const FRAME_TIME_THRESHOLD = expectedTime * 2.5;  // Seuil de lenteur
const BAD_FRAMES_THRESHOLD = 0.2;           // 20% de frames lentes
```

## Déclenchement

### Automatique
- Démarre avec `recordingPerformanceMonitor.startMonitoring()`
- S'arrête avec `recordingPerformanceMonitor.stopMonitoring()`

### MediaRecorder
```javascript
// Démarrage automatique dans startMediaRecorderPipeline()
recordingPerformanceMonitor.startMonitoring();

// Monitoring dans la boucle de rendu
recordingPerformanceMonitor.checkPerformance(frameTime, intervalMs, 'mediarecorder');

// Arrêt automatique dans stopMediaRecorderPipeline()
recordingPerformanceMonitor.stopMonitoring();
```

### Mode Images
```javascript
// Démarrage dans recordAnimation()
recordingPerformanceMonitor.startMonitoring();

// Monitoring dans captureElement()
recordingPerformanceMonitor.checkPerformance(totalCaptureTime, expectedFrameTime, 'images');

// Arrêt automatique à la fin
recordingPerformanceMonitor.stopMonitoring();
```

## Interface utilisateur

### Toast de confirmation (MediaRecorder)
- **Message** : "Performance d'enregistrement instable (X% de frames lentes). Souhaitez-vous augmenter le ralentissement à xN automatiquement ?"
- **Actions** :
  - **Confirmer** : Applique le nouveau ralentissement et sauvegarde
  - **Annuler** : Affiche un conseil manuel

### Toast d'information (Mode Images)
- **Message** : Conseils d'optimisation adaptés au contexte
- **Suggestions** : Actions concrètes pour améliorer les performances

## Avantages

1. **Détection proactive** : Identifie les problèmes avant qu'ils n'affectent gravement l'enregistrement
2. **Solution automatique** : Propose et applique une correction en un clic
3. **Non-intrusif** : Ne s'affiche qu'une seule fois par session d'enregistrement
4. **Adaptatif** : Suggestions différentes selon le mode d'enregistrement
5. **Persistant** : Les paramètres modifiés sont sauvegardés

## Fiabilité

### Métriques collectées
- Temps de rendu par frame
- Ratio de frames lentes
- Temps moyen de traitement
- Mode d'enregistrement

### Mode silencieux
Le système fonctionne maintenant en mode silencieux par défaut, sans polluer la console du navigateur avec des logs de debug. Seules les erreurs importantes sont encore loggées si nécessaire.

### Seuils de sécurité
- **Ralentissement maximum** : x8
- **Alertes progressives** : Un seul toast à la fois, mis à jour si performances empirent
- **Fallback** : Toast simple si confirmation échoue

## Impact sur la qualité

✅ **Préservation de la qualité** : Le ralentissement n'affecte pas la résolution ou les détails
✅ **Fluidité garantie** : Réduit drastiquement les saccades
✅ **Rendu des points maintenu** : Tous les éléments restent visibles et animés
✅ **Compatibilité audio** : La normalisation post-traitement compense le ralentissement

Cette fonctionnalité répond parfaitement au besoin [[memory:7909780]] d'optimiser les performances sans réduire la qualité d'image et en gardant le rendu des points visible.
