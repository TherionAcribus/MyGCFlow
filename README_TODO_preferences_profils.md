## TODO: Gestion des préférences et des profils (App et Carte/Points)

Objectif: implémenter une gestion simple, fiable et robuste des paramètres utilisateur avec deux catégories distinctes:
- Paramètres d’application (globaux, uniques, réinitialisables)
- Profils Carte/Points (ensembles multiples: créer, charger, dupliquer, réinitialiser, importer/exporter JSON)

### 0) Préparation
- [x] Créer une branche de travail: `feature/preferences-profiles`
- [x] Dépendances Python: aucune obligatoire (stdlib uniquement)
  - (optionnel) `platformdirs` pour des chemins cross-OS
  - (optionnel) `filelock` si concurrence multi-processus
- [x] Définir versionnement de schéma: `version` pour `settings.json` et chaque profil

### 1) Architecture de stockage et écriture atomique
- [x] Créer utilitaire de chemins (stdlib):
  - Dossier config utilisateur (Windows: `%APPDATA%/GCMap`)
  - Sous-dossier `profiles/` pour les profils
- [x] Fichiers cibles:
  - `settings.json` (paramètres d'app)
  - `profiles/<nom>.json` (un par profil)
- [x] Implémenter écriture atomique:
  - écrire vers `*.tmp`, puis `os.replace(tmp, final)`
  - si fichier existant: créer `*.bak` (sauvegarde)
- [x] Implémenter lecture sûre:
  - si fichier absent/corrompu: valeurs par défaut avec validation stdlib

### 2) Modèles et validation (stdlib: dataclasses + coercition)
- [x] `AppSettings`:
  - `version: int = 1`
  - `language: str = "fr"` (valeurs possibles: `fr`, `en`)
  - `check_updates: bool = True`
- [x] `MapOptions`:
  - `tile_provider: str = "OpenStreetMap"`
  - `default_center: tuple[float, float] = (2.3522, 48.8566)` (`longitude, latitude`)
  - `default_zoom: int = 6`
- [x] `AnimationOptions`:
  - `enabled: bool = True`
  - `speed: float = 1.0`
- [x] `PointStyle`:
  - `size: int = 8`, `color: str = "#ff5722"`, `shape: str = "circle"`, `halo: bool = False`
- [x] `MapProfile`:
  - `version: int = 1`
  - `name: str`, `uid: str` (généré),
  - `map: MapOptions`, `animation: AnimationOptions`, `points: PointStyle`

- [x] Fonctions de coercition/validation simples (stdlib):
  - `coerce_settings(data: dict) -> AppSettings`
  - `coerce_profile(data: dict) -> MapProfile`

### 3) Manager des paramètres et profils
- [x] Créer `settings_manager.py` avec la classe `SettingsManager` (stdlib) fournissant:
  - [x] App:
    - `get_app_settings() -> AppSettings`
    - `save_app_settings(settings: AppSettings) -> None`
    - `reset_app_settings() -> None`
  - [x] Profils:
    - `list_profiles() -> list[str]`
    - `load_profile(name: str) -> MapProfile`
    - `save_profile(profile: MapProfile) -> None`
    - `create_profile(name: str, base: str | None) -> MapProfile`
    - `duplicate_profile(name: str, new_name: str) -> MapProfile`
    - `delete_profile(name: str) -> None`
    - `reset_profile(name: str) -> None`
    - `export_profile(name: str, dest: Path) -> None`
    - `import_profile(src: Path, new_name: str | None) -> MapProfile`
  - [x] Migrations (facultatif au départ):
    - `migrate_settings(data: dict) -> dict`
    - `migrate_profile(data: dict) -> dict`
- [x] Assurer: nettoyage de nom de fichier (`[a-zA-Z0-9_-]`), création des dossiers, et backups `*.bak`

### 4) Intégration backend (Flask)
- [x] Déclarer une instance unique de `SettingsManager` dans `app.py`
- [x] Endpoints Paramètres d'app (JSON):
  - `GET /api/settings` → retourne `AppSettings`
  - `PUT /api/settings` → valide et enregistre
  - `POST /api/settings/reset` → réinitialise
- [x] Endpoints Profils (JSON):
  - `GET /api/profiles` → liste des profils
  - `GET /api/profiles/<name>` → charge un profil
  - `POST /api/profiles` → crée un profil (option `base`)
  - `PUT /api/profiles/<name>` → enregistre/maj profil
  - `POST /api/profiles/<name>/duplicate` → duplique
  - `DELETE /api/profiles/<name>` → supprime
  - `POST /api/profiles/<name>/reset` → réinitialise
  - `POST /api/profiles/<name>/export` → télécharge JSON (ou sauvegarde serveur)
  - `POST /api/profiles/import` → upload/import JSON (avec `new_name` optionnel)
- [x] Gestion d'erreurs claire (400 validation, 404 profil introuvable, 500 IO)
- [x] Tests manuels rapides via `curl`/`httpie`/Postman

### 5) Intégration UI (templates + JS)
- [ ] Page Préférences (ex: `templates/menu_options.html` ou nouvelle modale):
  - [ ] Sélecteur de langue (`fr`/`en`) → `PUT /api/settings`
  - [ ] Case à cocher "Vérifier les mises à jour au démarrage" → `PUT /api/settings`
  - [ ] Bouton "Réinitialiser" → `POST /api/settings/reset`
  - [ ] Rechargement i18n au besoin (forcer refresh ou re-render)
- [x] Page Bibliothèque de profils (intégrée dans `menu_style.html`):
  - [x] Liste des profils via `GET /api/profiles`
  - [x] Actions par profil: Appliquer, Enregistrer, Dupliquer, Renommer, Supprimer, Réinitialiser
  - [ ] Import / Export: bouton import (file input) → `POST /api/profiles/import`, bouton export → téléchargement JSON
  - [x] Bouton "Nouveau profil" (à partir de rien ou d'un profil de base)
  - [x] Confirmation de suppression (modale)
- [x] Persistance côté client (JS): rafraîchir la carte et l'UI lors du chargement/apply d'un profil

### 6) Connexion avec la carte (JS)
- [x] Adapter `static/js/profiles.js` pour consommer un `MapProfile` depuis l'API
- [x] Normaliser un format interne côté client correspondant aux dataclasses
- [x] Avant rendu:
  - `GET /api/profiles/<name>` (par défaut: "Default")
  - Appliquer: provider, vue initiale, zoom, options d'animation, style des points
- [x] Ajouter une fonction utilitaire JS `applyProfile(profile)` appelée après chaque chargement/duplication/reset

### 7) Paramètres par défaut et bootstrap
- [x] Au démarrage serveur: s'assurer que `settings.json` existe, sinon créer avec valeurs par défaut
- [x] Au premier lancement: créer le profil "Default" s'il n'existe pas
- [ ] Optionnel: fournir 2–3 profils d'exemple (Clair, Sombre, Présentation)

### 8) Internationalisation (i18n)
- [x] Ajouter clés de traduction pour la nouvelle UI (Fr/En) dans `messages.po`
- [x] Extraire/mettre à jour `messages.pot` (via `pybabel`), compiler
- [x] Utiliser `_()` dans les templates concernés

### 9) Robustesse et résilience
- [x] Backups `*.bak` lors des sauvegardes
- [x] Lecture tolérante: si JSON corrompu → revenir aux valeurs par défaut et notifier l'utilisateur
- [ ] (Optionnel) Verrou fichier avec `filelock` si multiprocess
- [x] Journalisation: logs clairs lors des opérations CRUD profils et settings

### 10) Tests et validation
- [x] Tests unitaires basiques des fonctions du `SettingsManager`
- [x] Tests d'intégration API (heureux et cas d'erreur)
- [x] Tests manuels UI: création, import/export, duplication, reset, changement de langue

### 11) Déploiement et maintenance
- [x] Documenter l'emplacement des fichiers sur Windows
- [x] Ajouter guide pour exporter/partager des profils
- [x] Noter la compatibilité de versions (migrations de schéma)

---

## Détails techniques rapides (extraits)

### Chemins (Windows)
- Config: `%APPDATA%/GCMap/`
- Profils: `%APPDATA%/GCMap/profiles/`

### Schémas JSON
- `settings.json`:
```json
{
  "version": 2,
  "language": "fr",
  "check_updates": true
}
```

- `profiles/<nom>.json`:
```json
{
  "version": 1,
  "name": "Default",
  "uid": "<uuid>",
  "map": {
    "tile_provider": "OpenStreetMap",
    "default_center": [2.3522, 48.8566],
    "default_zoom": 6
  },
  "animation": { "enabled": true, "speed": 1.0 },
  "points": { "size": 8, "color": "#ff5722", "shape": "circle", "halo": false }
}
```

### Endpoints (proposition)
- `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/reset`
- `GET /api/profiles`, `GET /api/profiles/<name>`
- `POST /api/profiles` (create), `PUT /api/profiles/<name>` (save)
- `POST /api/profiles/<name>/duplicate`, `DELETE /api/profiles/<name>`
- `POST /api/profiles/<name>/reset`
- `POST /api/profiles/<name>/export`, `POST /api/profiles/import`

### Intégration UI (emplacements possibles)
- `templates/menu_options.html` : préférences d’app
- `templates/menu_maps.html` ou `templates/menu_points.html` : gestion des profils
- `static/js/mapOptions.js`, `static/js/point_style.js`, `static/js/options.js` : application du profil

### Risques et garde-fous
- Validation/coercition stdlib avec valeurs par défaut
- Écriture atomique + sauvegarde `.bak`
- Migrations de schéma via champ `version`


