# MyGCFlow — Import et affichage des découvertes Adventure Lab

## Consigne pour le LLM de l’IDE

Implémente dans MyGCFlow la prise en charge facultative des découvertes de Lab Caches en **mode Normal**, appelé `main` dans le code. L’utilisateur doit pouvoir afficher ses géocaches, ses étapes Adventure Lab découvertes, ou les deux, sur la carte et dans l’animation chronologique, y compris dans la vidéo exportée.

MyGCFlow ne dispose pas de clé pour l’API officielle Groundspeak. La solution de départ repose sur un **export de l’historique de `https://labs.geocaching.com/logs` et son enrichissement avec les coordonnées des étapes**. Prévoir un fonctionnement par fichiers, indépendant de tout accès API. L’enrichissement automatique est un adaptateur facultatif à développer uniquement après preuve d’un accès exploitable pour MyGCFlow.

Lis d’abord `AGENTS.md` et les fichiers concernés dans le checkout courant. Ce plan a été préparé à partir de la branche `main`, commit `f4000290cec83e7cfec9b1187947c175f597f326`, consulté le 12 octobre 2026. Les chemins sont réels à ce commit ; les nouveaux noms de modules et d’endpoints ci-dessous sont des propositions, à ajuster sobrement aux conventions actuelles.

Ne crée pas un troisième mode d’application. Ne transforme pas les thèmes graphiques en comptes Geocaching. Préserve le mode Évolution, ses bases, ses filtres et ses réglages.

## 1. Décision fonctionnelle et limite d’accès

### 1.1 Une découverte représente une étape

Une Adventure regroupant cinq emplacements peut produire cinq découvertes, avec cinq coordonnées et éventuellement plusieurs dates. Afficher **une étape découverte = un point**, et non une Adventure = un point.

Importer aussi les étapes trouvées d’Adventures partiellement terminées. Ne pas sélectionner uniquement les Adventures complètes. Les étapes non trouvées présentes dans le fichier de coordonnées ne doivent jamais devenir des découvertes.

Ne pas utiliser le point de départ de l’Adventure comme position de toutes ses étapes. Ne pas affecter la date de fin de l’Adventure à ses cinq étapes. Ne pas substituer une date de publication à une date de découverte.

### 1.2 Ce qui est établi, ce qui reste à vérifier

Éléments inspectés :

- La page `/logs` est la source à étudier pour l’historique personnel. Des outils publics en exportent déjà les découvertes.
- Le connecteur Adventure Lab de c:geo lit les coordonnées d’étapes dans `GeocacheSummaries`, avec `Location.Latitude` et `Location.Longitude`.
- Ce connecteur utilise `X-Consumer-Key`, avec une clé d’application. Il ne récupère pas les dates personnelles de découverte des étapes dans son code inspecté.
- La documentation de l’ancienne API Labs décrit un historique avec `AdventureId`, `GeocacheId` et `DateLogged`, ainsi que des données d’export de compte avec `DateFoundUtc`. Plusieurs anciens endpoints sont marqués obsolètes.
- Le GPX Geocaching « My Finds » exclut les Lab Caches.

**Pas encore établi :** le schéma exact de la page `/logs` connectée aujourd’hui, les fichiers produits par chaque exporteur, et une voie d’enrichissement automatique en coordonnées utilisable par MyGCFlow sans clé partenaire.

Conséquence : ne pas coder un client d’un ancien endpoint comme s’il était une API libre et garantie. Ne pas reprendre les clés de c:geo, Lab2Gpx ou de l’application officielle. Ne pas inclure de récupération de cookies, mots de passe ou jetons dans cette première version.

Une V1 utilisable peut être livrée sans synchronisation réseau : **historique exporté + fichier de coordonnées compatibles**, ou un fichier enrichi contenant déjà les deux. L’obtention du fichier de coordonnées doit être expliquée honnêtement, sans promettre qu’un exporteur le fournit forcément.

## 2. Repères dans le dépôt et architecture recommandée

| Fichier existant | Rôle observé | Travail attendu |
|---|---|---|
| `models.py` | Modèle SQLAlchemy `Geocache` | Ajouter des modèles Labs distincts ; conserver le modèle existant |
| `migrations.py` | Migrations SQLite via `PRAGMA user_version` | Ajouter une migration nouvelle, sans réécrire une migration publiée |
| `bdd.py` | Import GPX, statistiques, GeoJSON, filtre SQL, tâches | Brancher un jeu Normal combiné ; maintenir l’import GPX autonome |
| `blueprints/gpx.py` | `/upload`, `/db_status`, `/clear_database` | Adapter les statuts globaux et expliciter la portée des suppressions |
| `blueprints/filters.py` | `/get_geojson_points`, `/filter_caches` | Servir le jeu Normal sélectionné, caches et/ou Labs |
| `geojson_cache.py` | Cache complet, cache filtré, index | Inclure les Labs, les nouvelles propriétés et le sélecteur de source |
| `task_manager.py`, `blueprints/tasks.py` | Tâches et suivi `/tasks/<id>` | Réutiliser le mécanisme d’import asynchrone |
| `templates/menu_data.html` | Imports et statut en mode Normal | Ajouter la section « Mes Lab Caches » et le choix des découvertes |
| `templates/_filter_cache_attrs.html` | Filtres partagés entre les modes | Option Labs limitée au mode Normal, si retenue dans Type |
| `static/js/bdd.js` | Chargement, filtre client, index `pointsByDate` | Charger et indexer le jeu combiné, conserver la révision et les états |
| `static/js/ui.js` | Sélections, états vide/prêt, lecture et enregistrement | Prendre en charge une base exclusivement Labs |
| `static/js/init.js` | Réglages et chargement initial | Restaurer la sélection de source avant le premier rendu |
| `static/js/mapgl.js` | OpenLayers, WebGL, popup et animation | Réutiliser le moteur ; popup spécifique Labs |
| `static/js/gc_colors.js`, `static/json/defaultGcColors.json` | Couleurs par type | Couleur Adventure Lab et repli cohérent |
| `settings_manager.py`, `blueprints/profiles.py` | Préférences globales et thèmes | Préférence globale Normal pour les sources affichées |
| `static/js/travel_trail.mjs`, `static/js/camera_follow.mjs` | Trajet et suivi caméra | Vérifier la compatibilité du jeu combiné, sans nouvel algorithme |
| `static/js/infos_template.mjs`, `static/js/overlay_canvas.js` | Compteurs et informations | Compteurs cohérents avec la sélection et vocabulaire adapté |
| `paths.py` | Emplacements de données et ressources | Utiliser ses chemins pour toute donnée persistée |
| `installer/mygcflow.spec` | Empaquetage | Inclure nouveaux modules, ressources et éventuels helpers exporteurs |

Point critique : `bdd.uploadBdd()` remplace actuellement les lignes de la table `geocache` après parsing, en une transaction. Il ne faut pas importer les Labs avec cette fonction.

### Architecture choisie : stockage indépendant, rendu commun

Ajouter les tables Labs **dans la base SQLite principale gérée par SQLAlchemy**, séparément de `geocache`. Un import GPX continue de remplacer uniquement les caches, et un import Labs modifie uniquement les Labs.

Créer un adaptateur, par exemple `main_dataset.py`, qui :

1. sérialise les caches avec leur contrat GeoJSON actuel ;
2. sérialise les découvertes Labs exploitables dans un contrat compatible ;
3. construit le jeu complet Normal combiné ;
4. fournit les métriques et les sélections nécessaires.

Réutiliser ensuite `pointsByDate`, les styles, les flashs, les trajets, la caméra et l’export vidéo. Une deuxième couche cartographique avec une deuxième animation indépendante compliquerait inutilement la cohérence.

Le cache de base doit contenir toutes les données exploitables des deux sources. La sélection de source intervient lors du filtrage, y compris au chargement initial : on doit pouvoir basculer de Caches à Labs sans réimporter ni perdre une source.

## 3. Phase préalable obligatoire : examiner de vrais exports

Avant de figer les parseurs, obtenir et analyser de petits échantillons anonymisés :

- historique d’une Adventure complètement trouvée ;
- historique d’une Adventure partiellement trouvée ;
- Adventure dont les étapes ont été trouvées sur plusieurs jours ;
- fichier de coordonnées GPX/CSV/JSON réellement disponible ;
- si possible, ancienne étape archivée ou supprimée.

Documenter pour chacun les champs présents : identifiant d’Adventure, identifiant d’étape, titre, date, heure/fuseau, latitude, longitude. Examiner aussi si le GPX contient les étapes comme waypoints autonomes ou comme éléments imbriqués.

Vérifier la distinction entre identifiant de log, identifiant d’étape et identifiant d’Adventure. Ils ne sont pas interchangeables. Un code généré par un outil tiers n’est pas nécessairement le UUID d’étape utilisé par Geocaching.

Ne pas supposer qu’un GPX exporté par c:geo/Lab2Gpx conserve cet UUID. Si les deux sources n’ont pas d’identifiant commun, il faut un rapprochement explicite et contrôlé, pas un assemblage silencieux par ordre ou par titre.

Un export de `/logs` peut être :

- un JSON normalisé généré par un petit exporteur MyGCFlow exécuté volontairement sur la page ;
- un CSV d’un exporteur identifié et dont le schéma est documenté ;
- un GPX comportant de véritables logs personnels et identifiants exploitables.

Supporter d’abord un format historique vérifié et un format coordonnées vérifié. Ne pas annoncer une prise en charge universelle de tous les CSV/GPX.

Si aucun fichier de coordonnées suffisamment identifiable n’est disponible, terminer les briques indépendantes et rapporter précisément cette limite. La phase de validation de source ne doit pas être remplacée par des champs inventés.

## 4. Contrat d’échange MyGCFlow

Proposer un JSON versionné, nom indicatif `mygcflow-lab-finds-v1.json`. Les noms ci-dessous appartiennent à **notre format**, pas à une réponse présumée de Groundspeak.

```json
{
  "format": "mygcflow-lab-finds",
  "schema_version": 1,
  "exported_at": "2026-10-12T08:00:00Z",
  "account": { "username": "Exemple" },
  "source": "labs.geocaching.com/logs",
  "coverage": "unknown",
  "discoveries": [
    {
      "adventure_id": "11111111-1111-4111-8111-111111111111",
      "stage_id": "22222222-2222-4222-8222-222222222222",
      "adventure_title": "Exemple d’Adventure",
      "stage_title": "Exemple d’étape",
      "found_date": "2026-09-10",
      "found_at": null,
      "date_precision": "day",
      "date_basis": "source_displayed_date",
      "latitude": null,
      "longitude": null,
      "coordinate_scope": null,
      "adventure_url": null
    }
  ]
}
```

Les UUID et dates ci-dessus sont fictifs. `coverage` prend `unknown`, `partial` ou `complete` ; un exporteur ne doit déclarer `complete` que s’il a effectivement parcouru ou obtenu toutes les découvertes.

Règles :

- Un seul historique peut déjà contenir les coordonnées ; sinon on les complète depuis un second fichier.
- Pour le fichier coordonnées, utiliser un format analogue `mygcflow-lab-stages`, `schema_version: 1`, avec `stages` contenant les identifiants, titres, coordonnées et `coordinate_scope: "stage"`.
- Un identifiant inconnu reste absent. La validation distingue champ manquant, champ mal formé et identifiant tiers non UUID.
- `account.username` peut être absent ; demander alors une étiquette de collection lors du premier import. Ne pas prétendre vérifier l’identité depuis un simple pseudo.
- Conserver le texte de date d’origine dans la provenance, pas seulement sa conversion.
- Ne pas mettre de cookie, jeton, clé API, HTML complet ou données d’autres joueurs dans ce fichier.

Pour un exporteur MyGCFlow de `/logs`, lire le contenu réellement présent après chargement. Vérifier origine et chemin, identifier les Adventures et étapes avec des attributs/liens attestés par les fixtures, et afficher un bilan avant téléchargement. Si le schéma change, produire un diagnostic plutôt qu’un export vide présenté comme réussi.

Un bookmarklet ne peut pas forcément lire les pages ou réponses d’une autre origine à cause des règles du navigateur. Ne pas supposer qu’il pourra joindre `labs-api.geocaching.com` ni contourner cela avec un proxy tiers.

Ne pas développer une extension complète de navigateur dans le MVP sauf nécessité démontrée. Un exporteur léger, ou la lecture d’un export existant vérifié, suffit.

## 5. Modèle de données

Ajouter dans `models.py` deux modèles, noms indicatifs `LabCollection` et `LabDiscovery`.

### 5.1 Collection

Une collection représente l’historique importé d’un joueur, pas un thème graphique.

| Champ | Rôle |
|---|---|
| `id` | Clé locale |
| `uid` | Identité locale stable de collection |
| `account_label` | Pseudo ou étiquette renseignée/extraite |
| `last_import_at` | Dernier import validé |
| `last_exported_at` | Horodatage de l’export si connu |
| `last_coverage` | Couverture déclarée de l’export |
| `last_import_summary` | Résumé non sensible du dernier import |

V1 : une collection Labs active. Réimporter dans cette collection ; en cas de pseudo différent, expliquer le risque de mélange et proposer remplacement explicite de la collection Labs ou annulation. Ne pas effacer les GPX. Préparer une identité stable permettant un éventuel multi-compte ultérieur sans l’implémenter maintenant.

### 5.2 Découverte

| Champ | Rôle |
|---|---|
| `id`, `collection_id` | Clés locales |
| `local_uid` | Identité stable, notamment pour une ligne sans UUID externe |
| `adventure_uuid`, `stage_uuid` | Identifiants externes vérifiés, nullable |
| `adventure_title`, `stage_title` | Libellés indépendants |
| `adventure_url` | Lien validé, nullable |
| `found_date` | Date civile utilisée par l’animation, nullable |
| `found_at_utc` | Instant si fourni et interprétable, nullable — pour `/logs`, décalé (heure locale sous étiquette Pacifique, voir `docs/notes/lab-caches-sources.md`) |
| `date_precision`, `date_basis`, `source_date_text` | Précision et origine de la date |
| `latitude`, `longitude` | Coordonnées de l’étape, nullable |
| `coordinate_scope`, `coordinate_source` | Qualité et provenance des coordonnées |
| `coordinate_status` | `missing`, `resolved`, `ambiguous`, `invalid` |
| `source_format`, `source_record_key` | Traçabilité et dédoublonnage sans UUID |
| `is_archived` | État connu de l’étape ; ne retire pas une découverte historique |
| `imported_at`, `updated_at` | Suivi local |

Ajouter une contrainte unique `(collection_id, stage_uuid)` pour les UUID présents. SQLite autorise plusieurs valeurs nulles ; utiliser `local_uid` unique pour les autres lignes. Ajouter les index sur collection, date de découverte, Adventure et état des coordonnées.

Une donnée exploitable par la carte animée a une date valide et des coordonnées d’étape validées. Les lignes incomplètes restent en base, visibles dans le bilan, mais ne sont pas envoyées au moteur de points en V1.

Conserver `country`/`state` optionnels si une source fiable les fournit. Aucun reverse geocoding réseau obligatoire et aucune déduction du pays à partir du nom.

Ajouter une migration dans `migrations.py`, en respectant `db.create_all()` puis `migrations.upgrade()` dans `app.create_app()`. Tester base historique, base neuve et relancement. Vérifier aussi qu’une migration appliquée à une base neuve ne recrée pas les tables déjà créées par `create_all()`.

## 6. Parsing, dates et rapprochement

Créer des modules ciblés, par exemple `lab_import.py`, `lab_formats.py`, `lab_store.py`. Les parseurs doivent être utilisables sans Flask et testables sur fichiers.

### 6.1 Import historique

1. Identifier format et version par contenu, pas uniquement par extension.
2. Parser sans exécuter de HTML ni de JavaScript du fichier.
3. Normaliser identifiants, Unicode, espaces, dates et coordonnées.
4. Produire des découvertes intermédiaires et des erreurs par ligne.
5. Détecter doublons et conflits avant écriture.
6. Préparer un aperçu et un rapport ; enregistrer uniquement après validation de l’import.

Une erreur structurelle invalide tout le fichier sans mutation. Une ligne isolée invalide peut être rejetée dans un import partiel explicitement accepté, avec nombre et raison des rejets.

### 6.2 Dates

- Une date seule reste une date seule ; ne pas inventer une heure `00:00:00` comme heure réelle.
- Si la source donne une date affichée de découverte, la conserver pour la chronologie.
- Si elle donne un instant ISO avec offset ou `Z`, conserver l’instant UTC et déterminer explicitement la date d’animation.
- Ne pas choisir implicitement le fuseau de la machine : proposer un fuseau d’import lorsque seul l’instant est disponible, prérempli selon les préférences pertinentes. Conserver cette décision dans `date_basis`/provenance.
- Préférer la date personnelle de découverte attestée, jamais `PublishedUtc`, une date de dernière mise à jour ou la fin globale de l’Adventure.
- Gérer formats ISO, offset et fractions de seconde. Pour un CSV `03/04/2026`, exiger un format de date attesté par le parseur ou une sélection explicite ; pas de devinette silencieuse.
- Date manquante ou illisible : conserver la ligne en attente ; ne pas utiliser la date du jour ni 1970.

Le `parse_gpx_time()` existant retourne des datetimes naïfs et ne couvre pas tous les offsets. Il n’est pas suffisant pour ce nouvel import sans traitement dédié ; éviter une réécriture du parsing GPX historique dans cette fonctionnalité.

L’animation existante est indexée par jour. Ne pas la transformer en animation à la seconde. Conserver les heures connues comme provenance et tri stable, sans présenter l’ordre d’animation comme un trajet réellement mesuré.

### 6.3 Coordonnées

- Exiger deux valeurs numériques finies, latitude dans `[-90, 90]`, longitude dans `[-180, 180]`.
- Distinguer coordonnées d’étape et coordonnées d’Adventure.
- Ne pas inverser les axes automatiquement sur une simple heuristique.
- Un zéro dans une coordonnée peut être valide. Le couple `(0,0)` est parfois une sentinelle dans les sources Labs : le signaler pour vérification si la source n’en atteste pas la validité, sans rejeter l’équateur ou Greenwich en général.
- Les géométries GeoJSON sont `[longitude, latitude]`, convention du dépôt.
- Les corrections utilisateur validées ont priorité sur un enrichissement externe ultérieur. Garder leur provenance.

### 6.4 Rapprochement historique ↔ coordonnées

Ordre de confiance :

1. UUID d’étape identique, avec Adventure compatible si connue : automatique.
2. Identifiant tiers présent dans les deux exports et dont la signification est documentée : automatique dans l’adaptateur concerné.
3. Adventure connue + titre exact normalisé donnant un candidat unique : **proposition à confirmer**, pas fusion automatique universelle.
4. Plusieurs candidats, Adventure inconnue, titre seul ou ordre des étapes : laisser en attente et afficher les candidats.

Interdiction de joindre automatiquement sur une distance, le rang d’étape ou un titre seul. Les titres peuvent se répéter et les étapes peuvent changer d’ordre.

Prévoir une petite interface de résolution manuelle : découverte, Adventure, date, candidat/coordonnées proposées ; validation individuelle ou d’un lot non ambigu après aperçu. Les liens confirmés sont persistés et réutilisés aux imports suivants.

### 6.5 Réimport

- Import par défaut : ajouter/mettre à jour, jamais supprimer les lignes absentes du nouvel export.
- Même UUID déjà importé : mise à jour idempotente ; ne pas dupliquer.
- Pour un UUID absent, employer une clé source fiable quand disponible. Sinon détecter les ressemblances et demander résolution ; ne pas fusionner arbitrairement deux découvertes différentes.
- Un champ vide du nouvel export ne remplace pas une donnée fiable déjà connue.
- Un conflit entre deux dates attestées ou deux jeux de coordonnées fiables apparaît dans l’aperçu ; la résolution retenue doit être traçable.
- Importer le fichier de coordonnées n’ajoute aucune découverte : il enrichit les découvertes déjà importées.
- Le remplacement intégral de la collection Labs est une action séparée, annoncée et confirmée. Même un export déclaré complet ne déclenche pas de suppression implicite.

## 7. API locale et tâches

Créer `blueprints/labs.py`, enregistré dans `blueprints/__init__.py`. Endpoints proposés :

| Méthode et route | Fonction |
|---|---|
| `POST /api/labs/import/preview` | Analyser historique et/ou coordonnées, retourner aperçu et jeton local temporaire |
| `POST /api/labs/import/commit` | Enregistrer le plan validé, retourner `202` + `task_id` |
| `GET /api/labs/status` | Compteurs importés/exploitables/en attente, collection et dernier import |
| `GET /api/labs/unresolved` | Liste paginée des découvertes incomplètes et motifs |
| `POST /api/labs/discoveries/<local_uid>/resolve` | Confirmer une association ou correction |
| `POST /api/labs/clear` | Supprimer seulement la collection Labs après confirmation UI |
| `GET /api/labs/export` | Exporter le JSON MyGCFlow enrichi et versionné |

Réutiliser `/tasks/<task_id>?include_result=true` pour progression et résultat final. Si le parsing du preview est lui-même long, le faire aussi en tâche ; ne pas bloquer une requête Flask pendant un gros import.

Ne pas transmettre tous les enregistrements à nouveau dans `commit`. Le jeton correspond à un import préanalysé dans un emplacement temporaire géré par l’application. Il a une durée de vie, une limite de taille et est consommable une fois. Contrôler la révision de la collection à l’enregistrement : si elle a changé depuis l’aperçu, recalculer les conflits avant mutation.

Transaction : validation/préparation hors transaction, puis upserts Labs atomiques. En cas d’échec, rollback complet du lot ; ne jamais modifier `geocache`. Protéger côté serveur les imports/clear/resolve Labs simultanés avec le mécanisme d’exclusivité du projet ou un verrou dédié ; désactiver les boutons ne suffit pas.

Pour l’écriture principale combinée et les imports GPX en parallèle, garantir une publication cohérente du cache : verrou court de mutation/invalidation ou révision de données contrôlée avant publication. Ne pas permettre qu’une génération commencée avant l’import republie ensuite un cache périmé.

Après une mutation réussie : invalider le cache GeoJSON complet et filtré, reconstruire la géographie pertinente et notifier le frontend pour rechargement. Ne pas s’appuyer seulement sur le mtime SQLite : le dépôt mentionne déjà le problème WAL.

Résultat de tâche proposé : `success`, `added`, `updated`, `unchanged`, `rejected`, `unresolved`, `conflicts`, `ready_total`, avertissements et détail des lignes rejetées. Le succès UI arrive après `finished` avec résultat valide, jamais au simple `202`.

Les endpoints locaux doivent respecter `security.py` et les contrôles d’origine. Limiter taille, nombre d’éléments et diagnostics ; rejeter DTD/entités externes si parsing XML/GPX ; aucune récupération réseau automatique depuis des URL contenues dans les imports. Ne pas ajouter de CORS permissif pour qu’un bookmarklet distant puisse écrire dans le serveur local : il télécharge un fichier que l’utilisateur importe.

## 8. Jeu GeoJSON Normal commun

Les caches conservent leurs propriétés existantes. Les features Labs comportent au minimum :

```json
{
  "type": "Feature",
  "id": "lab:collection-uid:stage-uid",
  "geometry": { "type": "Point", "coordinates": [6.17, 49.12] },
  "properties": {
    "source_kind": "lab",
    "record_uid": "lab:collection-uid:stage-uid",
    "cache_type": "Adventure Lab",
    "name": "Exemple d’étape",
    "gc_code": null,
    "adventure_id": "11111111-1111-4111-8111-111111111111",
    "stage_id": "22222222-2222-4222-8222-222222222222",
    "adventure_title": "Exemple d’Adventure",
    "date_find": "2026-09-10",
    "time_find": null,
    "found": true,
    "date_precision": "day",
    "coordinate_scope": "stage",
    "difficulty": null,
    "terrain": null,
    "container": null,
    "country": null,
    "state": null,
    "owner": null,
    "published_date": null,
    "adventure_url": null
  }
}
```

Exemple fictif. Pour une découverte sans UUID externe, la fin de `record_uid` utilise `local_uid`, explicitement une identité locale. Ne pas fabriquer un code `GC...` ou utiliser un identifiant local comme URL Geocaching.

Ajouter `source_kind: "geocache"` aux caches, avec repli de lecture pour anciens caches persistés sans ce champ. Ne pas modifier arbitrairement les types GPX existants (`Earthcache`, `Unknown Cache`, etc.).

Les lignes Labs non exploitables n’émettent pas de feature Point avec `[null,null]`, `[0,0]` forcé ou date factice. Les conserver séparément dans les bilans d’import et `/api/labs/status`.

Trier le jeu complet de façon déterministe par date puis identité stable. Les sous-comptages et dates min/max portent sur les données sélectionnables ; distinguer les données importées mais encore en attente.

Adapter `db_infos`/`/db_status` pour reconnaître un mode Normal contenant seulement des Labs. Conserver les champs consommés par les clients existants et ajouter une ventilation par source. Exemple : 100 caches exploitables, 250 Labs exploitables, 20 Labs en attente ; le jeu animable contient 350 éléments, pas 370.

Vérifier les fonctions `hasDatabase()`, `hasAnimationData()` et `updateDataAvailabilityUI()` : les boutons de lecture/enregistrement ne doivent pas rester bloqués quand il n’y a aucun GPX mais des Labs exploitables.

## 9. Choix des sources, filtres et cache

### 9.1 Sélecteur principal

Ajouter trois choix en mode Normal :

- « Géocaches » ;
- « Lab Caches » ;
- « Géocaches et Lab Caches ».

Préférence globale proposée `main_discovery_sources`, normalisée vers `geocaches`, `labs`, `both`. Valeur par défaut pour une installation existante : `geocaches`. Après le premier import Labs, proposer explicitement l’affichage mixte ; sur une installation ne contenant que des Labs, sélectionner Labs après l’import validé pour que le résultat soit immédiatement visible.

Stockage dans `AppSettings`, validation dans `coerce_settings`, GET/PUT `/api/settings`, application dans `init.js`. Ne pas enregistrer dans `MapProfile` : changer de thème ne doit pas changer les données affichées.

Le champ de filtre transmis contient une liste explicite `sources: ["geocache", "lab"]`. Champ absent = comportement de compatibilité défini, par exemple caches seuls ; liste vide = aucun résultat. Le sélecteur à trois choix n’émet pas une liste vide, mais l’API sait la traiter.

Le jeu complet du cache reste combiné ; appliquer les sources dès le premier affichage et pas uniquement au premier clic sur un filtre. Les rechargements après import et au démarrage restaurent la sélection et les filtres pertinents.

### 9.2 Politique de filtres à implémenter partout

| Filtre | Géocaches | Labs |
|---|---|---|
| Sources | Sélection normale | Sélection normale |
| Type | Types historiques | `Adventure Lab` si l’option existe dans Type |
| Date de découverte | Oui | Oui, selon `found_date` |
| Difficulté, terrain, taille | Comportement historique | Non applicables, ne retirent pas les Labs |
| Publication | Comportement historique | Non applicable en V1, ne retire pas les Labs |
| Pays/région | Comportement historique | Appliqués si demandés ; valeur inconnue ne correspond pas à une région nommée |

Pour pays/région : l’état neutre « tous » doit inclure les valeurs inconnues. Ajouter une option explicite « Non renseigné » lorsqu’il existe des valeurs inconnues et distinguer l’absence de filtre d’une sélection géographique réelle. Ainsi l’import Labs par défaut reste visible, mais une sélection « France uniquement » ne garde pas silencieusement des Labs de pays inconnu.

Pour les filtres de caches, « Aucun » continue d’exclure les géocaches selon les conventions UI ; il n’exclut pas les Labs, auxquels la dimension ne s’applique pas. Expliquer ce comportement près des contrôles en mode mixte ; en Labs seuls, désactiver les filtres non applicables.

Si le type est vide, aucun élément ne passe, Labs comprises. En Labs seuls, la sélection de source doit garantir que `Adventure Lab` est sélectionné ou proposer une correction visible. Changer de source ne doit pas laisser un état incohérent produisant un écran vide inattendu.

### 9.3 Trois moteurs de filtrage à aligner

Le dépôt filtre à trois endroits :

1. SQL, `bdd.filter_session` ;
2. cache/index, `GeojsonIndexCache._candidate_ids` et `_matches_filters` ;
3. JavaScript, `filterFeaturesClientSide` dans `static/js/bdd.js`.

Adapter les trois. En SQL, construire deux branches (caches et Labs), avec les dimensions applicables à chacune, puis sérialiser/fusionner ; le modèle Geocache seul ne peut plus représenter tout le jeu Normal.

Dans les index, une intersection préalable sur terrain/taille/difficulté ne doit pas supprimer les Labs avant que la logique « non applicable » soit évaluée. Ajouter un index source ou conserver les candidats Labs lors des intersections réservées aux caches.

Dans le filtre client, l’actuel retour immédiat quand difficulté/terrain/taille est vide doit être limité aux caches, pas au jeu entier. Traiter `null` explicitement ; `Number(null)` vaut zéro en JavaScript et ne doit pas servir à comparer une valeur inconnue.

Ajouter sources et nouveaux états géographiques à `_normalize_filter_key`. Versionner/invalider aussi les caches persistés du disque à l’upgrade : un cache d’une ancienne version ne comporte pas les Labs ni les bonnes propriétés. Une simple différence de mtime ne suffit pas.

Ajouter des fixtures partagées de filtrage pour vérifier les mêmes identités dans SQL, index et JS. La sémantique du tableau ci-dessus doit être la référence, pas trois interprétations indépendantes.

## 10. Interface d’import et gestion des données

Dans `templates/menu_data.html`, conserver « Mes Géocaches » et ajouter « Mes Lab Caches », chacune avec import, statut et suppression propres. Ajouter le sélecteur des découvertes affichées au-dessus des filtres.

Parcours Labs :

1. « Obtenir mon historique » ouvre `/logs` et l’aide expliquant l’export vérifié.
2. « Importer l’historique » accepte le format supporté ; « Ajouter les coordonnées » accepte le format coordonnées supporté.
3. Aperçu : étapes découvertes, identifiants exploitables, dates valides, associations, conflits et rejets.
4. Import confirmé et progression asynchrone.
5. Bilan : « 245 étapes importées, 230 prêtes à afficher, 15 à compléter ».
6. « Compléter les coordonnées » ouvre la liste des lignes en attente et leur résolution.

Un fichier enrichi peut réaliser les étapes 2–4 en une seule opération. Les imports historiques et coordonnées peuvent aussi être effectués dans un même assistant, avec aperçu commun.

Le glisser-déposer global actuel est orienté GPX et valide son en-tête. Pour le MVP, offrir une zone Labs dédiée ; empêcher qu’un GPX coordonnées Labs soit envoyé par erreur au remplacement GPX classique. Si un routage global est ajouté, il doit reconnaître le contenu et afficher la destination avant mutation.

Suppression :

- « Supprimer mes géocaches » supprime seulement `geocache`, préserve les Labs et recharge le jeu Normal restant.
- « Supprimer mes Lab Caches » supprime seulement leur collection/découvertes.
- Une éventuelle action « Tout supprimer » est séparée, explicite et confirmée ; ne pas l’ajouter implicitement au bouton existant.

Le frontend de suppression actuel appelle `clearLocalData()` et suppose une base entièrement vide : après suppression d’une seule source, recharger l’autre au lieu de laisser l’écran vide.

États UI distincts : aucune donnée importée ; données importées mais à compléter ; données exploitables mais source masquée ; filtres sans résultat ; import en cours. Ne pas suggérer « réinitialiser les filtres » pour une absence de coordonnées.

Tous les nouveaux textes utilisent gettext et `t()` selon `AGENTS.md`, avec français source, anglais traduit et catalogue FR cohérent. Prévoir clavier, labels, focus, progression `aria-live`, erreur par fichier et contraste des points.

## 11. Carte, animation, compteurs et vidéo

### Carte et popup

- `cache_type = "Adventure Lab"` et `source_kind = "lab"` permettent le rendu et la distinction.
- Ajouter une couleur dédiée au fichier de couleurs et à son repli JS ; la décrire comme un choix MyGCFlow, pas une couleur officielle attestée.
- Le style global du thème reste applicable aux deux sources. Ne pas ajouter une personnalisation complète des Labs dans la V1.
- En mode icône, prévoir un rendu compatible avec le système actuel ; à défaut, repli vectoriel lisible pour Labs plutôt qu’une icône cassée.
- Popup Labs : nom de l’étape, Adventure, date de découverte, précision si utile, lien valide si connu. Masquer D/T/taille non applicables.
- Ne pas fabriquer `https://coord.info/<id-lab>`. Les liens doivent provenir d’un champ valide ou d’un schéma Adventure démontré, limité à des URL HTTPS de confiance.
- Rendre les titres importés comme texte échappé ; ne pas injecter le HTML source.

### Animation commune

La sérialisation Labs fournit `date_find` et le jeu sélectionné alimente `buildPointsByDateIndex`. Recalculer la révision `pointsByDateRevision` après import, enrichissement, suppression et changement de source. Les résumés caméra/trajet mémoïsés doivent être invalidés via le mécanisme existant.

Ne pas contourner l’index avec une couche Labs ajoutée après coup : les dates, le compteur, les flashs et la vidéo ne suivraient pas.

Vérifier play/pause/reprise/stop, réapparition des points, flashs, halo, cadrage sur les données, caméra quotidienne, caméra sur tête du trajet et retour au cadrage. Les seuls points sélectionnés et exploitables influencent l’emprise et le trajet.

### Compteurs

Une étape compte pour une découverte. Préserver les contrats historiques là où ils sont utilisés ; ajouter une ventilation `geocaches`, `labs`, `total` dans les métadonnées si utile.

En mixte, remplacer dans l’UI les libellés trompeurs « caches » par « découvertes » aux endroits qui comptent les deux. Les balises existantes `{trouvees}`, `{total}`, `{pct}` portent sur la sélection courante ; les anciennes vidéos caches seules conservent leur signification. Ne pas ajouter de nouvelles balises spécialisées dans la V1 sans besoin.

Les Labs incomplètes ne doivent pas apparaître dans le total annoncé de la vidéo. Leur nombre existe dans le bilan d’import, séparément. Conserver le comportement particulier des Locationless existantes, comptées mais masquées selon préférence : ne pas confondre ce mécanisme avec des Labs dont la position manque.

### Export vidéo

Utiliser le pipeline existant, MediaRecorder et capture image par image. Vérifier que l’enregistrement voit les mêmes features, couleurs, dates et nombres que l’aperçu. Ne pas déclencher de requête de coordonnées pendant une frame vidéo.

Après import complet, les découvertes Labs doivent être exploitables hors connexion sans accès Adventure Lab. Les besoins réseau déjà existants des fonds cartographiques ne sont pas modifiés par cette fonctionnalité.

## 12. Enrichissement réseau : extension ultérieure et conditionnelle

Prévoir une interface de fournisseur de coordonnées, mais le fournisseur par fichiers suffit à la V1.

Exemple de contrat interne : `resolve_stages(adventure_ids) -> résultats normalisés + capacités + erreurs`. Un fournisseur doit annoncer si les identifiants d’étapes sont réellement présents et si toutes les étapes sont accessibles, notamment pour les Adventures séquentielles.

Un fournisseur réseau n’est activé que si l’accès utilisé est documenté et disponible pour MyGCFlow. Une documentation Swagger publique, un endpoint fonctionnant pour une autre application, ou la possession d’un pseudo utilisateur ne constituent pas cette preuve.

Avant activation : tester les identifiants, coordonnées d’étapes, restrictions séquentielles, pagination, archivées/supprimées, limites et authentification autorisée. Renseigner la provenance et le statut de chaque résultat. Prévoir timeouts, débit modéré, cache local, reprise des erreurs et traitement des 401/403/429. L’échec du fournisseur ne doit pas compromettre les découvertes déjà importées.

L’accès officiel ultérieur pourra remplacer ce fournisseur sans modifier stockage, GeoJSON ni UI. Ne pas implémenter maintenant une connexion Geocaching automatisée ni présenter cette extension comme livrée.

## 13. Tests et critères d’acceptation

La tâche ne consiste pas à écrire des tests pour chaque ligne, mais à vérifier les risques réels : perte de données, jointure erronée, filtrage divergent, dates décalées et vidéo incohérente.

### Tests Python ciblés

- JSON historique/coordonnées valides ; schéma inconnu ; fichier connexion/HTML présenté comme export ; coordonnées non finies/hors plage.
- Date seule, instant UTC, offset, passage de minuit, heure d’été, date ambiguë, date absente et date de publication non substituée.
- Adventure partielle et étapes réparties sur plusieurs jours.
- Jointure exacte par UUID, identifiant tiers attesté, titre proposé à confirmer, titre ambigu et ordre incompatible.
- GPX coordonnées comportant les bonnes étapes mais aucune découverte : il n’ajoute aucun find.
- Réimport identique idempotent, enrichissement ultérieur, absence d’un champ conservant la donnée fiable, conflits explicites.
- Import invalide/commit échoué laissant intactes les deux sources.
- Import GPX après Labs préservant les Labs ; import Labs préservant les caches.
- Suppressions limitées à leur source, y compris cache et état UI rechargés.
- Base ancienne migrée, base neuve et migration rejouée sans dommage.
- Cache mémoire/disque invalidé après mutation et versionné ; génération en concurrence ne republie pas l’ancien jeu.
- Même résultat de filtrage SQL et index sur fixtures mixtes ; dates de fin inclusives par date civile.

### Tests JS et E2E ciblés

- Filtre client identique aux résultats Python sur les fixtures ; `null` n’est pas zéro.
- Installation avec Labs seules : points visibles, dates correctes, lecture et vidéo disponibles.
- Les trois choix de source produisent le bon jeu, le bon total et la bonne emprise ; rechargement et changement de thème gardent le choix.
- Filtres D/T/taille neutres et « Aucun » ne retirent pas les Labs ; sélection type vide retire tout.
- Pays inconnu visible au neutre mais exclu d’un pays choisi, sauf option « Non renseigné » explicitement sélectionnée.
- Titre contenant balises/script affiché comme texte ; URL dangereuse ignorée ; pas de lien coord.info Labs.
- Import de coordonnées en attente puis enrichissement rafraîchissant points, caméra et trajet.
- Suppression de caches avec Labs restantes, et inversement.
- Aperçu mixte et au moins un export vidéo court reproduisant les mêmes découvertes ; vérifier les deux pipelines par test ou smoke test adapté.
- Mode Évolution et thèmes existants toujours fonctionnels.

### Vérifications du dépôt

Utiliser les commandes pertinentes du checkout, notamment `python -m unittest discover -s tests` pour les tests Python compatibles et `npm run test:e2e -- <specs ciblées>` pour Playwright. Lire les conventions du projet avant de fixer les commandes définitives.

`AGENTS.md` signale un blocage Playwright 1.52 avec Node 24.21.0 : utiliser Node 22 pour ces tests. Respecter `MYGCFLOW_E2E_RUNTIME`, les répertoires temporaires et les réglages persistants partagés des tests. Ne pas tester sur la base personnelle du développeur.

Effectuer l’extraction/mise à jour/compilation Babel selon le README et lancer le contrôle des traductions. Examiner les entrées fuzzy avant compilation. Vérifier un build empaqueté ou, au minimum, l’inclusion des nouvelles ressources dans le spec.

Critère final : avec 3 caches et 4 étapes Labs exploitables, Caches affiche/compte 3, Labs 4, Mixte 7. Une cinquième étape Labs sans coordonnées est conservée « à compléter » mais ne crée aucun point ni fausse découverte animée. Réimporter les deux fichiers conserve ces nombres. Chaque source peut être supprimée indépendamment.

## 14. Découpage de réalisation et ordre recommandé

| Lot | Résultat attendu | Condition de passage |
|---|---|---|
| 0 — Sources réelles | Fixtures anonymisées, schémas d’export, identifiants et limites documentés | Une voie historique et une voie coordonnées effectivement exploitables, ou limite explicitée |
| 1 — Stockage et normalisation | Modèles Labs, migration, parseurs, dates, upsert et provenance | Tests migration/import/idempotence réussis |
| 2 — Import utilisateur | Aperçu, tâches, import historique et coordonnées, résolution, bilan et export enrichi | Parcours par fichiers utilisable sans API |
| 3 — Jeu Normal | Sérialisation commune, statut combiné, cache/index/version et filtres alignés | Parité SQL/index/JS, aucun effacement croisé |
| 4 — Affichage et préférences | Trois sources, popup, couleurs, base Labs seule, persistance | Rechargement et sélection cohérents |
| 5 — Animation et vidéo | Compteurs, révisions, trajet/caméra, smoke tests vidéo | Même sélection et même total dans aperçu/export |
| 6 — Documentation et distribution | Guide FR/EN, ressources empaquetées, limites connues | V1 livrable et transparente sur les formats supportés |
| Option future — Réseau | Fournisseur automatique autorisé et vérifié | Aucun accès garanti à ce stade ; ne bloque pas les lots indépendants |

Garder les lots petits et reviewables. En cas de découverte d’un schéma différent, adapter le contrat de parsing et les fixtures avant de poursuivre ; ne pas accumuler des heuristiques pour sauver une hypothèse initiale.

## 15. Livrables attendus du LLM codeur

À la fin, fournir :

1. les changements de code pour la V1 par fichiers ;
2. les migrations et tests ciblés ;
3. `docs/lab-caches.md` expliquant exports, formats, coordonnées, import, sources affichées et cas en attente ;
4. les fixtures fictives/anonymisées, sans identifiants de compte réels ;
5. les traductions françaises/anglaises et ressources de distribution ;
6. une synthèse indiquant ce qui fonctionne, les formats réellement testés, les commandes exécutées et les limites ;
7. une distinction explicite entre fonctionnalités livrées et éventuel enrichissement réseau non validé.

Ne pas annoncer « import automatique de toutes les Labs » si seules des coordonnées fournies par fichier sont disponibles. Ne pas annoncer une extraction complète de `/logs` si pagination/chargement de toute la liste n’ont pas été vérifiés.

## Références techniques consultées

- MyGCFlow, commit de référence : https://github.com/TherionAcribus/MyGCFlow/tree/f4000290cec83e7cfec9b1187947c175f597f326
- Import GPX et GeoJSON : https://github.com/TherionAcribus/MyGCFlow/blob/f4000290cec83e7cfec9b1187947c175f597f326/bdd.py
- Modèles : https://github.com/TherionAcribus/MyGCFlow/blob/f4000290cec83e7cfec9b1187947c175f597f326/models.py
- Cache/index : https://github.com/TherionAcribus/MyGCFlow/blob/f4000290cec83e7cfec9b1187947c175f597f326/geojson_cache.py
- Frontend données : https://github.com/TherionAcribus/MyGCFlow/blob/f4000290cec83e7cfec9b1187947c175f597f326/static/js/bdd.js
- c:geo, connecteur Labs : https://github.com/cgeo/cgeo/blob/master/main/src/main/java/cgeo/geocaching/connector/al/ALApi.java
- Lab2Gpx, client API : https://github.com/mirsch/lab2gpx/blob/main/api/src/Model/AdventureLabApiClient.php
- Ancienne documentation API Labs : https://labs-api.geocaching.com/swagger/ui/index
- Documentation API partenaire : https://api.groundspeak.com/documentation
- Exporteur GPX de découvertes : https://chromewebstore.google.com/detail/export-found-lab-caches/cjkdhjilamnglgjpabhmadhkaoiinegk
- Exporteur d’identifiants d’Adventures depuis `/logs` : https://rragan.github.io/FoundLabsIdBookmarklet.html

Ces références établissent des mécanismes et des formats décrits, pas la disponibilité d’une clé API pour MyGCFlow ni la compatibilité garantie de tous les exports. Le présent document est un plan d’implémentation, pas une extraction validée sur un compte connecté.
