# Traitements GPX et GeoJSON en tâche de fond

Ce projet exécute désormais les prétraitements lourds (import GPX et génération GeoJSON) dans des tâches de fond pour ne plus bloquer les requêtes Flask.

## Vue d'ensemble
- Les tâches sont exécutées dans un pool de threads (`task_manager.py`).
- Chaque soumission retourne un `task_id` utilisé pour sonder l'état et récupérer le résultat.
- Les opérations longues existantes (import GPX, génération/filtrage GeoJSON) ont été adaptées pour utiliser ce mécanisme.

## API disponibles

### Import GPX
- **POST** `/upload`  
  - Body: formulaire avec `file` (.gpx).  
  - Réponse: `202` + `{ success, task_id, state }`. Aucune donnée importée n'est renvoyée dans la réponse immédiate.

- **GET** `/progressBar?task_id=<id>` (compat rétro)  
  - Réponse: `{ progress, message, state, task_id, error }`.

### Génération de GeoJSON
- **POST** `/get_geojson_points`  
  - Réponse: `202` + `{ success, task_id, state }` pour la génération complète.

- **POST** `/filter_caches`  
  - Body: `{ types: <payload filtres> }` (inchangé côté frontend).  
  - Réponse: `202` + `{ success, task_id, state }` pour la génération filtrée.

### Suivi générique de tâche
- **GET** `/tasks/<task_id>?include_result=true`  
  - Réponse: `{ task_id, type, state, progress, message, error, result? }`.  
  - `result` est présent uniquement quand `state == "finished"` et `include_result` n'est pas `false`.  
  - Types connus: `gpx_import`, `geojson_generation`.

## Comportement frontend (static/js/bdd.js)
- Upload GPX (formulaire principal et modale) : envoie `/upload`, récupère `task_id`, puis sonde `/tasks/<id>` et n’affiche le succès qu’après `finished`.
- Chargement initial (readBdd) et refresh points (loadAndDisplayPoints) : déclenchent `/get_geojson_points`, puis sonde `/tasks/<id>` pour récupérer `geojson` + `metadata`.
- Filtrage (changeSelect) : déclenche `/filter_caches`, puis sonde `/tasks/<id>` pour récupérer les données filtrées.

## Points d’extension
- Ajouter une nouvelle tâche longue : soumettre via `task_manager.submit(<type>, fn, *args)` et retourner `task_id` dans la route. Exposer le résultat en fin de tâche via `status.set_result(...)`.
- Toute tâche peut signaler une erreur avec `status.fail(err)`; l’API renverra `state: "failed"` + `error`.

## Rappels d’usage
- Les appels `/upload`, `/get_geojson_points`, `/filter_caches` répondent maintenant en différé (`202`). Les clients doivent **obligatoirement** consommer `/tasks/<task_id>` (ou `/progressBar` pour l’import) pour obtenir l’issue et les données.
