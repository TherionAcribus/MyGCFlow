# Gestion des Profils GCMap

## Vue d'ensemble

La gestion des profils permet aux utilisateurs de sauvegarder, charger et gérer différentes configurations de leur carte geocaching. Chaque profil contient :

- **Paramètres de carte** : fournisseur de tuiles, centre par défaut, zoom
- **Paramètres d'animation** : activation/désactivation, vitesse
- **Paramètres des points** : taille, couleur, forme, halo

## Utilisation

### Interface utilisateur

La section **Profils** est accessible dans l'onglet **Style** de l'application.

#### Créer un profil
1. Cliquez sur **Nouveau**
2. Saisissez un nom pour votre profil
3. Cliquez sur **Créer**

#### Sauvegarder un profil
1. Modifiez les paramètres de votre carte (points, animations, etc.)
2. Cliquez sur **Sauvegarder** pour enregistrer les changements dans le profil actif

#### Charger un profil
- Cliquez sur le nom du profil dans la liste pour l'activer

#### Actions sur les profils
Chaque profil dispose d'un menu (⋮) avec les options :
- **Dupliquer** : créer une copie du profil
- **Renommer** : changer le nom du profil
- **Réinitialiser** : remettre le profil à ses valeurs par défaut
- **Supprimer** : supprimer définitivement le profil

### Stockage

Les profils sont sauvegardés localement dans :
- **Windows** : `%APPDATA%\GCMap\profiles\`
- Chaque profil est un fichier JSON nommé d'après son nom (caractères alphanumériques uniquement)

### API REST

L'application expose une API REST pour la gestion des profils :

#### Endpoints

- `GET /api/profiles` : liste tous les profils
- `GET /api/profiles/<nom>` : récupère un profil spécifique
- `POST /api/profiles` : crée un nouveau profil
- `PUT /api/profiles/<nom>` : sauvegarde un profil
- `POST /api/profiles/<nom>/duplicate` : duplique un profil
- `DELETE /api/profiles/<nom>` : supprime un profil
- `POST /api/profiles/<nom>/reset` : réinitialise un profil

#### Exemple d'utilisation

```javascript
// Créer un profil
fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        name: 'Mon Profil',
        base: null // ou nom d'un profil existant
    })
});

// Sauvegarder un profil
fetch('/api/profiles/Mon Profil', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        name: 'Mon Profil',
        map: {
            tile_provider: 'OpenStreetMap',
            default_center: [48.8566, 2.3522],
            default_zoom: 6
        },
        animation: { enabled: true, speed: 1.0 },
        points: { size: 8, color: '#ff5722', shape: 'circle', halo: false }
    })
});
```

### Format JSON des profils

```json
{
  "version": 1,
  "name": "Default",
  "uid": "uuid-unique",
  "map": {
    "tile_provider": "OpenStreetMap",
    "default_center": [48.8566, 2.3522],
    "default_zoom": 6
  },
  "animation": {
    "enabled": true,
    "speed": 1.0
  },
  "points": {
    "size": 8,
    "color": "#ff5722",
    "shape": "circle",
    "halo": false
  }
}
```

## Développement

### Architecture

- **Backend** : `settings_manager.py` (dataclasses + coercition)
- **API** : Endpoints Flask dans `app.py`
- **Frontend** : `static/js/profiles.js` (gestionnaire JavaScript)
- **UI** : Section dans `templates/menu_style.html`

## Profils d'exemple inclus

Au premier lancement, GCMap crée automatiquement 4 profils d'exemple :

### 🏠 **Default** (Par défaut)
- **Carte** : OpenStreetMap centrée sur Paris (zoom 6)
- **Points** : Cercle orange moyen (taille 8, sans halo)
- **Animation** : Activée, vitesse normale
- **Usage** : Configuration de base équilibrée

### ☀️ **Clair** (Light)
- **Carte** : OpenStreetMap centrée sur la France (zoom 6)
- **Points** : Cercle bleu clair avec halo (taille 10)
- **Animation** : Activée, vitesse légèrement augmentée
- **Usage** : Bonne visibilité en extérieur/jour

### 🌙 **Sombre** (Dark)
- **Carte** : Stamen Toner (fond sombre) centrée sur Paris (zoom 7)
- **Points** : Triangle blanc avec halo (taille 6)
- **Animation** : Désactivée pour économiser la batterie
- **Usage** : Économique pour la batterie, nuit/extérieur sombre

### 📊 **Présentation** (Presentation)
- **Carte** : OpenStreetMap vue large sur la France (zoom 5)
- **Points** : Cercle vert avec halo (taille 12)
- **Animation** : Activée, vitesse doublée
- **Usage** : Optimisé pour les présentations/démonstrations

### Extension

Pour ajouter de nouveaux paramètres aux profils :
1. Étendre les dataclasses dans `settings_manager.py`
2. Mettre à jour les fonctions de coercition
3. Adapter l'interface utilisateur
4. Mettre à jour les traductions si nécessaire

### Internationalisation

Les textes sont gérés via Flask-Babel. Pour ajouter de nouvelles langues :
1. Ajouter les traductions dans `translations/<lang>/LC_MESSAGES/messages.po`
2. Compiler avec `pybabel compile -d translations`
