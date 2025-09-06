## Optimisations de performance – Enregistrement d'animation

Objectif: réduire drastiquement le temps de capture et le poids des images/vidéo, tout en éliminant les blocages UI et les rechargements inutiles.

### Priorités (impact → effort)

1) Canvas-only (très fort → moyen)
- Capturer directement le canvas OpenLayers (OL) au lieu de « snapshot » le DOM.
- Dessiner les overlays (titre, date, nb caches) directement dans un canvas de sortie via `CanvasRenderingContext2D`.
- Avantages: 3–10x plus rapide, zéro souci CSS/CORS, mémoire maîtrisée.

2) WebP + Blob/FormData (fort → faible)
- Exporter en `image/webp` via `canvas.toBlob(...)` (qualité ~0.9).
- Uploader en `FormData` (binaire) plutôt qu'en Base64 (−33% payload, moins de CPU).

3) Réduction charge côté client (fort → faible)
- `html2canvas` seulement en fallback (nous l’avons déjà) et avec options « light »: `scale: 1`, `logging: false`, `useCORS: true`.
- Throttle UI (toasts/progress) → mise à jour toutes les N frames (ex: N=10), pas à chaque frame.
- Désactiver temporairement transitions/animations/logs pendant la capture.

4) Ressources locales pendant la capture (moyen → faible)
- Remplacer les CDN (OpenLayers CSS, Materialize, etc.) par leurs versions locales pendant la capture pour éviter 304/réseau et avertissements CORS.
- Filtrer tout `<link rel="stylesheet" href="http...">` de la zone capturée (déjà partiellement fait).

5) OpenLayers (moyen → faible)
- `map.renderSync()` avant lecture du canvas.
- Simplifier temporairement le style des points (moins d’effets, tailles réduites).
- Pré-calculer l’index des features par date pour des mises à jour incrémentales.

6) Upload/batching (moyen → moyen)
- Option: bufferiser et envoyer par lots (ex: 10 images) si acceptable.
- Backoff/retry réseau léger pour robustesse.

7) Divers (selon besoin)
- Créer le context en `willReadFrequently: true` pour de fortes lectures (cf. warning navigateur).
- `OffscreenCanvas` + Worker (si environnement compatible) pour déplacer le rendu hors du thread UI.

---

### Étapes d’implémentation (checklist)

- [x] A. Implémenter « Canvas-only » pour la capture OL
  - [x] Utiliser `map.getViewport().querySelector('canvas')` (ou composites) comme source
  - [x] Copier dans un `outCanvas` et dessiner overlays au `ctx`
  - [x] `outCanvas.toBlob('image/webp', 0.9)` → upload

- [x] B. Passer l’upload en `FormData` + Blob
  - [x] Client: `fetch('/upload_image', { method: 'POST', body: formData })`
  - [x] Serveur: accepter `multipart/form-data` (extraction via `request.files`), enregistrer directement le binaire

- [x] C. Throttle des toasts/progress
  - [x] Mettre à jour la barre toutes les 5 frames (optimisé)

- [ ] D. Désactiver animations/logs pendant capture
  - [ ] Basculer un flag global (désactive transitions CSS/Materialize init/logs)

- [ ] E. Basculer ressources externes vers local pendant capture
  - [ ] Remplacer CDN par fichiers locaux (déjà présents dans `static/`), ou mode « capture » qui n’insère que le strict nécessaire

- [ ] F. Styles OL simplifiés pendant capture
  - [ ] Points sans halo/effets lourds, tailles réduites, tracer uniquement l’essentiel

---

### Exemples d’implémentation

1) Canvas-only (client)
```js
// Après avoir mis à jour la carte pour la frame courante
map.renderSync();
const srcCanvas = map.getViewport().querySelector('canvas');

const outCanvas = document.createElement('canvas');
outCanvas.width = srcCanvas.width;
outCanvas.height = srcCanvas.height;
const ctx = outCanvas.getContext('2d', { willReadFrequently: true });

// Rendu de la carte
ctx.drawImage(srcCanvas, 0, 0);

// Overlays (titre/date/nb caches)
ctx.fillStyle = 'rgba(255,255,255,0.85)';
ctx.fillRect(12, 12, 320, 56);
ctx.fillStyle = '#000';
ctx.font = '16px Arial';
ctx.fillText(titleText, 20, 32);
ctx.fillText(dateText, 20, 52);

// Export WebP + upload binaire
outCanvas.toBlob((blob) => {
  const fd = new FormData();
  fd.append('image', blob, fileName /* .webp */);
  fetch('/upload_image', { method: 'POST', body: fd });
}, 'image/webp', 0.9);
```

2) html2canvas (fallback « light »)
```js
html2canvas(element, { backgroundColor: '#fff', scale: 1, useCORS: true, allowTaint: false, logging: false })
  .then(canvas => new Promise(res => canvas.toBlob(res, 'image/webp', 0.9)))
  .then(blob => {
    const fd = new FormData();
    fd.append('image', blob, fileName);
    return fetch('/upload_image', { method: 'POST', body: fd });
  });
```

3) Serveur Flask – upload binaire (exemple)
```python
@app.route('/upload_image', methods=['POST'])
def upload_image_binary():
    image = request.files.get('image')
    if not image:
        return jsonify({'success': False, 'message': 'Aucun fichier'}), 400
    os.makedirs('captured', exist_ok=True)
    image.save(os.path.join('captured', secure_filename(image.filename)))
    return jsonify({'success': True})
```

---

### Mesures & validation

- Temps moyen/frame et variance
- Taille moyenne des images (PNG vs WebP) et débit upload
- Taux d’images perdues/échouées
- Utilisation CPU/JS main thread pendant capture

---

### Plan de déploiement itératif

1. Basculer upload → WebP + Blob/FormData (simple, gros gains)
2. Throttle UI (progrès toutes les N frames)
3. Canvas-only pour la carte OL + overlays dessinés au `ctx`
4. Simplifier styles OL pendant capture
5. Remplacer CDN par local en mode capture
6. Option: batching upload, OffscreenCanvas/Worker

Ces étapes peuvent être activées via un « mode capture » (flag) pour ne pas impacter l’usage normal.

---

## Résultats attendus des optimisations

### Métriques avant/après optimisation

**Avant optimisation (votre situation actuelle) :**
- FPS: ~0.6 frames/seconde
- Taille images: ~PNG full size
- Mémoire: Élevée (html2canvas traite tout le DOM)
- CPU: Élevé (conversion Base64, traitement DOM complet)

**Après optimisation (résultats attendus) :**
- FPS: 3-8 frames/seconde (amélioration de 5-13x)
- Taille images: -33% (WebP vs PNG)
- Mémoire: Réduite (canvas-only, pas de DOM)
- CPU: Réduit (pas de traitement DOM, upload binaire)

### Comment mesurer les améliorations

Le toast affiche maintenant en temps réel :
```
25.0% | 15/07/2018 | f:25/120 | fps:4.2 | cap:45.3ms | up:120.1ms
```

- `fps`: Frames par seconde (objectif: 3-8)
- `cap`: Temps moyen de capture en ms (objectif: <100ms)
- `up`: Temps moyen d'upload en ms (objectif: <200ms)

### Test de performance

1. Lancez un enregistrement avant optimisation
2. Notez les métriques dans le toast
3. Redémarrez l'application avec les optimisations
4. Lancez un nouvel enregistrement
5. Comparez les métriques

**Résultat typique attendu :**
- Amélioration FPS: 5-10x
- Réduction taille: 30-40%
- Stabilité UI: Plus fluide (throttling toasts)


