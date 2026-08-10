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
3. Cliquez sur **Créer** — le profil est créé **avec les réglages actuellement affichés** et devient le profil actif

#### Sauvegarder un profil
1. Modifiez les paramètres de votre carte (points, animations, etc.)
2. Cliquez sur **Sauvegarder** pour enregistrer les changements dans le profil actif

Sans profil actif, **Sauvegarder** propose d'enregistrer les réglages dans un nouveau profil.

#### Charger un profil
- Cliquez sur le nom du profil dans la liste pour l'activer

#### Au redémarrage
GCMap rouvre le **dernier profil utilisé**. Le profil marqué d'une étoile
(**Définir comme par défaut**) ne sert qu'à la première ouverture, ou si le
dernier profil utilisé a été supprimé.

#### Actions sur les profils
Chaque profil dispose d'un menu (⋮) avec les options :
- **Dupliquer** : créer une copie du profil ; une modale propose un nom (`<profil>_copy`, complété d'un `(n)` s'il est déjà pris) que l'on peut remplacer avant de valider
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
- `DELETE /api/profiles/<nom>` : supprime un profil (404 si le profil n'existe pas)
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
            default_center: [2.3522, 48.8566], // [longitude, latitude]
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
  "version": 2,
  "name": "Default",
  "uid": "uuid-unique",
  "map": {
    "tile_provider": "OpenStreetMap",
    "default_center": [2.3522, 48.8566],
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

Au premier lancement, GCMap crée automatiquement 11 profils d'exemple :

### 🏠 **Default** (Par défaut)
- **Carte** : OpenStreetMap centrée sur Paris (zoom 6)
- **Points** : Cercle avec couleurs GC, halo blanc et flash circulaire par type
- **Animation** : Activée, vitesse normale
- **Usage** : Configuration générale équilibrée et immédiatement lisible

### 🌃 **Nocturne Neon**
- **Carte** : Stamen Toner sombre centrée sur Paris (zoom 7)
- **Points** : Triangles cyan avec halo sombre
- **Animation** : Activée, légèrement accélérée
- **Usage** : Rendu nocturne fort pour captures, vidéos et démos

### 🎨 **Carnet Aquarelle**
- **Carte** : Watercolor centrée sur la France (zoom 6)
- **Points** : Icônes geocaching avec encarts style carnet
- **Animation** : Activée, légèrement ralentie
- **Usage** : Ambiance voyage, douce et illustrative

### 🗺️ **Atlas Vintage**
- **Carte** : Carte vectorielle en palette papier ancien, centrée sur Lyon (zoom 6)
- **Points** : Triangles terracotta avec bordure crème
- **Animation** : Activée, discrète
- **Usage** : Rendu cartographique rétro, adapté aux exports statiques

### 📣 **Présentation Impact**
- **Carte** : OpenStreetMap vue large sur la France (zoom 5)
- **Points** : Cercles orange avec halo blanc et flash carré ample
- **Animation** : Activée, vitesse doublée
- **Usage** : Profil conçu pour présentation, projection ou vidéo

### 🍬 **Bonbon Pop**
- **Carte** : OSM clair centrée sur la France (zoom 6)
- **Points** : Cercles rose bonbon, halo blanc épais, flash étoile jaune
- **Animation** : Activée, vive
- **Usage** : Look acidulé et contrasté sur fond clair

### 🌅 **Coucher Tropical**
- **Carte** : Watercolor centrée sur la Méditerranée (zoom 6)
- **Points** : Cercles corail colorés par type de cache, flash losange orange
- **Animation** : Activée, posée
- **Usage** : Ambiance chaude « carte postale »

### 🌿 **Forêt Émeraude**
- **Carte** : Carte vectorielle en palette verte, centrée sur les Alpes (zoom 6)
- **Points** : Triangles vert forêt, halo clair, flash triangle
- **Animation** : Activée, calme
- **Usage** : Rendu nature, apaisant et lisible

### 🫧 **Océan Bubble**
- **Carte** : OSM clair centré sur la côte (zoom 6)
- **Points** : Cercles turquoise, gros halo blanc, flash cercle qui s'étend
- **Animation** : Activée, vitesse normale
- **Usage** : Effet aquatique et frais

### 🕹️ **Arcade 80**
- **Carte** : Stamen Toner sombre centrée sur Paris (zoom 7)
- **Points** : Cercles jaunes à halo rose, flash carré vert menthe rapide
- **Animation** : Activée, nerveuse
- **Usage** : Néon rétro joueur, vibe pixel/arcade

### 🎉 **Fête Confetti**
- **Carte** : OSM vue large sur la France (zoom 5)
- **Points** : Cercles colorés par type de cache (remplissage + bordure), flash étoile par type
- **Animation** : Activée, enjouée
- **Usage** : Le plus multicolore, esprit festif

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
