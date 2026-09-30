# Mode Évolution

Le mode Évolution anime **toutes les caches d'une zone** au fil du temps :
chaque cache apparaît à sa date de placement et disparaît à sa date
d'archivage, et le compteur affiche le nombre de caches **actives** (il monte
et descend). C'est un mode secondaire, sur une page à part (`/evolution`),
atteinte par le sélecteur de mode en haut de l'onglet Données
(`templates/_mode_switch.html`, présent sur les deux pages). Les
deux pages partagent l'interface (carte, thèmes, animation, export vidéo) mais
jamais leurs données.

## Utilisation

1. Onglet **Données** de `/evolution` : sélectionner (ou glisser-déposer) un ou
   plusieurs exports CSV. Sans base existante, une base est créée au nom du
   premier fichier (horodatage final retiré) ; sinon les fichiers sont ajoutés
   à la base ouverte.
2. Le compte rendu d'import détaille, par fichier : lignes lues, nouvelles,
   mises à jour, inchangées, plus anciennes ignorées, doublons, caches
   archivées depuis l'export précédent, archivées sans date, lignes invalides,
   types non reconnus.
3. Carte au repos : état à la **date de fin** de l'animation (par défaut la
   date de l'export le plus récent, colonne « Ajouté »). Changer la date de fin
   dans l'onglet Animation met la carte au repos à jour.
4. Filtre **Pays / Région** (les autres filtres ne sont pas proposés en v1).
5. Lecture et export vidéo comme dans le mode principal. Le suivi de caméra
   n'existe pas dans ce mode.

Plusieurs **bases nommées** peuvent coexister (une par zone). Réimporter une
zone plus tard complète la base : nouvelles caches ajoutées, caches archivées
entre-temps mises à jour.

## Format CSV

Lecture en flux (`evolution_csv.py`), UTF-8 avec ou sans BOM, repli `cp1252`,
séparateur détecté (`,`, `;`, tabulation). Les en-têtes sont comparés après
normalisation (minuscules, sans accents) à une table d'alias français et
anglais ; la première colonne sans nom et les colonnes inconnues sont ignorées.

| Champ | En-têtes reconnus (exemples) | Obligatoire |
| --- | --- | --- |
| Code GC | `GC code`, `Code GC`, `Code` | oui |
| Coordonnées | `Latitude`, `Longitude` | oui |
| Placement | `Date de placement`, `Placed` | oui |
| Archivage | `Dernière date d'archivage`, `Archivée` | non |
| Export | `Ajouté` (horodatage de l'export) | non |
| Descriptif | `Nom de la géocache`, `Type`, `Taille`, `Difficulté`, `Terrain`, `Propriétaire`, `Placée par`, `Pays`, `Région`, `Département` | non |

- Une ligne sans code GC valide, sans coordonnées utilisables ou sans date de
  placement est ignorée et comptée par motif.
- Types et tailles sont traduits vers les noms anglais de l'application
  (couleurs, icônes) : `Traditionnelle` → `Traditional Cache`,
  `Cache Mystère` → `Unknown Cache`, `Petite` → `Small`… Un libellé inconnu est
  conservé tel quel et signalé.
- **Archivage** :
  - archivée avec date → disparaît ce jour-là ;
  - archivée **sans date** → ne disparaît jamais (comptée active) ;
  - non archivée mais datée → cache réactivée, date ignorée ;
  - date antérieure au placement → disparition le jour du placement.
- Les **coordonnées corrigées** sont volontairement ignorées : dans une vidéo
  publiée, elles révéleraient des finales de mystery.

## Fusion et stockage

Fichier SQLite séparé, `instance/evolution.db` (`paths.evolution_database_path`,
voir `docs/distribution.md`), géré par `evolution_store.py` avec le module
`sqlite3` standard et son propre numéro de schéma (`PRAGMA user_version`).
Séparé de `geocaching.db` : le cache GeoJSON des trouvailles dépend de la date
de modification de celle-ci, et « Supprimer mes trouvailles » ne touche pas
aux bases du mode Évolution.

- Tables `datasets` (nom unique sans distinction de casse, révision,
  statistiques), `imports` (historique et compte rendu par fichier), `caches`
  (clé `(dataset_id, gc_code)`).
- Une cache présente dans plusieurs exports prend la version de l'export le
  plus récent (`Ajouté`) ; à égalité, celle du fichier importé en dernier.
  Un export plus ancien n'écrase jamais une version plus récente.
- Chaque fichier est importé dans sa propre transaction (tâche de fond
  `evolution_import`, voir `docs/async-tasks.md`).

## API

| Route | Rôle |
| --- | --- |
| `GET /evolution` | page du mode (même `app.html`, `data-mode="evolution"`) |
| `GET /api/evolution/datasets` | liste des bases (+ `import_task_id` si un import tourne) |
| `POST /api/evolution/datasets` | création `{ name }` (201, 409 si le nom est pris) |
| `GET /api/evolution/datasets/<id>` | base et historique des imports |
| `PATCH /api/evolution/datasets/<id>` | renommage `{ name }` |
| `DELETE /api/evolution/datasets/<id>` | suppression (409 pendant un import) |
| `POST /api/evolution/datasets/<id>/import` | multipart `files` (plusieurs .csv, 500 Mo max chacun) → 202 `{ task_id }` |
| `GET /api/evolution/datasets/<id>/data` | données en colonnes pour la carte (ETag par révision, 304) |
| `GET /api/evolution/datasets/<id>/caches/<code>` | détails d'une cache (popup) |

`/data` renvoie des tableaux parallèles plutôt qu'une FeatureCollection :
`code`, `lon`, `lat`, `placed` et `archived` (jours depuis `origin`, `-1` si
la cache ne disparaît pas), `status` (0 active, 1 archivée datée, 2 archivée
sans date), `type`/`country`/`region` (index dans `types`/`countries`/
`regions`), `meta` (totaux, dates extrêmes, date de l'export). Nom et
propriétaire n'y figurent pas : la popup les charge à la demande.

## Rendu : pourquoi rien n'est ajouté pendant l'animation

Avec OpenLayers, chaque ajout ou modification de feature reconstruit les
buffers WebGL de **tous** les points : jour après jour, c'est intenable
au-delà de quelques dizaines de milliers de caches. Le mode Évolution ajoute
donc toutes les caches sélectionnées **une seule fois** à la couche
`WebGLPoints`, avec trois attributs (`placedDay`, `archivedDay`, `stagger`),
et laisse le shader décider de leur visibilité :

- `static/js/evolution_style.mjs` : expressions de style (`EVO_AGE`,
  `EVO_GONE`) et filtre de couche `EVO_FILTER`, qui écarte aussi les points
  masqués de la détection de clic ;
- variables de style mises à jour à chaque rendu par
  `updatePointAppearClock` (`mapgl.js`) : `evoDay` (jour courant), `evoIntraMs`
  (temps écoulé dans le jour, plafonné à un jour tant que les dates défilent :
  une pause fige les effets au lieu de les rejouer), `evoFrom` (premier jour
  animé), `evoMsPerDay`, `evoStagger` ;
- `static/js/evolution_timeline.mjs` : chronologie en tableaux typés
  (événements par jour, caches actives par jour, pic), filtre Pays / Région,
  horloge des variables ;
- `static/js/evolution_data.js` : onglet Données, import, chargement d'une
  base, et interface avec le moteur (`evolutionBegin`, `evolutionStep`,
  `evolutionRestState`…).

Dans `mapgl.js`, chaque point d'entrée du moteur (début et fin d'animation,
jour affiché, deux pipelines d'enregistrement) teste `isEvolutionPage()` et
délègue à ces modules ; le chemin du mode principal est inchangé. Un jour
animé ne coûte que ses flashs d'apparition et de disparition (flash
« implosion », `flash_implode.mjs`).

## Timing

Des décennies de données ne tiennent pas dans la garantie « au moins une
image par jour » du mode principal (9 300 jours = 5 min minimum à 30 fps).
En mode Évolution, `buildTimingPlan` et `buildImageTimingPlan` reçoivent
`allowMultipleDaysPerFrame` : plusieurs jours peuvent partager une image
(`framesForDay(..., { allowZero: true })`), et `captureNextFrame` affiche les
jours sans image en un seul lot. En lecture et en MediaRecorder, jusqu'à
`EVOLUTION_MAX_DAYS_PER_FRAME` jours sont affichés par frame.

Le mode Images est exact à l'image près. MediaRecorder capture en temps réel :
sur une machine lente et à un rythme très élevé (plus de 1 000 jours/s), la
vidéo peut durer plus longtemps que prévu ; le mode Images est alors
recommandé (l'estimation de charge de l'onglet Animation le signale).

## Réglages

| Réglage | Portée | Stockage |
| --- | --- | --- |
| Rythme propre au mode (défaut : durée finale 1 min) | Globale | `evolution_animation` de `settings.json` |
| Dernière base ouverte | Globale | `evolution_dataset_id` de `settings.json` |
| Flash de disparition (forme, taille, couleur) | Thème | `flash.disappear` du profil |

Le rythme est séparé de celui du mode principal (`animation`) pour qu'un
réglage adapté à des décennies ne déborde pas sur l'animation des
trouvailles. La sélection Pays / Région n'est pas persistée et n'écrase pas
celle du mode principal (`filtersSelection` du localStorage).

## Tests

- Python : `tests/test_evolution_csv.py`, `tests/test_evolution_store.py`,
  `tests/test_evolution_api.py`, plus les cas `flash.disappear` et
  `evolution_*` de `test_profile_validation.py` et `test_global_preferences.py`.
- Node : `test_evolution_timeline.mjs`, `test_evolution_style.mjs`,
  `test_flash_implode.mjs`, et les cas « plusieurs jours par image » de
  `test_video_timing.mjs`.
- Playwright : `tests/e2e/evolution.spec.mjs` (fixtures
  `tests/e2e/fixtures/evolution-a.csv` / `evolution-b.csv`).

## Hors périmètre (v1)

Traits de déplacement, filtres Type / Taille / D / T / Département, caches
désactivées (traitées comme actives), coordonnées corrigées, annulation d'un
import, fusion de bases, thèmes propres à une base.
