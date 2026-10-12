# Lab Caches (Adventure Lab)

Le mode Normal peut afficher les **étapes d'Adventure Lab** découvertes, aux
côtés des géocaches ou seules, dans la même carte, la même animation et la
même vidéo. Une **découverte = une étape** (pas un point par Adventure) :
5 étapes d'une même Adventure donnent 5 points.

Aucune connexion à l'API officielle n'est requise : tout se fait par fichiers
fournis par l'utilisateur, importés depuis la section « Mes Lab Caches » de
l'onglet Données.

## Les deux fichiers à fournir

L'affichage complet exige deux exports, qu'on peut importer ensemble ou l'un
après l'autre :

1. **L'historique de découvertes** (`labs.geocaching.com/logs`) — qui a été
   trouvé, et quand. Obtenu avec le script
   `static/labs/export_lab_logs.js`, téléchargeable depuis la modale d'aide
   de « Mes Lab Caches » : à exécuter dans la console du navigateur sur la
   page `/logs` connectée ; il produit un JSON `mygcflow-lab-finds` (le
   script interroge le même endpoint JSON que la page, avec les cookies de
   session — voir `tools/export_lab_logs.js` et
   `docs/notes/lab-caches-sources.md` pour l'état des lieux).
2. **Les coordonnées des étapes** — un ou plusieurs GPX **Lab2Gpx**
   (`lab2gpx` produit un waypoint par étape, nommé `LC…` / UUID d'étape).
   Les `.zip` produits par Lab2Gpx sont acceptés tels quels.

Un fichier seul suffit pour enregistrer les découvertes : elles restent
stockées « en attente » tant que les coordonnées (ou la date) manquent, et
deviennent des points dès qu'un import ultérieur les résout.

## Formats reconnus

| Fichier | Détection | Contenu attendu |
|---|---|---|
| `.json` | Contenu (pas l'extension) | `mygcflow-lab-finds`, `schema_version: 1`, liste `discoveries` |
| `.gpx` | Contenu | GPX Lab2Gpx : un `<wpt>` par étape, identifiant d'étape en `desc`/`cmt` |
| `.zip` | Contenu | Archive Lab2Gpx contenant un ou plusieurs `.gpx` |

Le dépôt d'un GPX Lab2Gpx dans la zone d'import **géocaches** est refusé avec
un message renvoyant vers « Mes Lab Caches » — un waypoint Lab2Gpx n'est pas
une géocache Groundspeak.

### Rapprochement historique ↔ coordonnées

La jointure se fait sur l'**UUID d'étape exact** — jamais sur le titre ni
l'ordre (fragiles). Une découverte dont l'UUID n'apparaît dans aucun GPX
importé reste en attente ; les réimports sont idempotents (même fichier →
rien de nouveau, fichier enrichi → mise à jour des champs autorisés, conflit
UUID → avertissement, jamais d'écrasement silencieux). Les corrections
manuelles (`coordinate_source = user_correction`) sont protégées : un
réimport ultérieur ne les efface pas.

Un GPX qui ne couvre **aucune** découverte connue n'ajoute rien (pas de
« find » fabriqué à partir de seules coordonnées).

## Import

Onglet **Données** → carte **« Mes Lab Caches »** :

1. Sélection d'un ou plusieurs fichiers `.json` / `.gpx` / `.zip`.
2. **Aperçu** : résultat projeté *du lot entier* dans une transaction unique
   (le GPX « voit » l'historique du même lot) puis annulé — détail par
   fichier plus les totaux projetés (nouvelles, mises à jour, inchangées,
   résolues, en attente).
3. **Validation** : import en tâche de fond (exclusif avec les autres
   mutations), puis bilan « N importées, X affichables, Y en attente ».
4. Après un premier import, l'affichage bascule automatiquement sur la
   source qui a du contenu (mixte si géocaches et Labs coexistent, Labs
   sinon) pour que le résultat soit immédiatement visible.

Le statut de la collection (total / affichables / en attente) est visible en
permanence dans la carte, avec accès à la liste des étapes en attente.

### Étapes « en attente » (cas non résolus)

Une découverte n'apparaît **jamais** comme point — ni dans la carte, ni dans
l'animation, ni dans les compteurs vidéo — tant qu'il lui manque une
coordonnée ou une date. Elle reste conservée en base. Le bouton « Compléter
les coordonnées » ouvre la modale des étapes en attente, où saisir à la main
coordonnée et/ou date manquantes ; ces corrections sont enregistrées comme
`user_correction` et survivent aux réimports.

Motifs d'attente remontés par `GET /api/labs/unresolved` :
`missing_coordinates` (UUID d'étape inconnu des GPX fournis — typiquement
une Adventure dont le GPX n'a pas été exporté, ou une étape séquentielle
non débloquée dans Lab2Gpx), `missing_date`, et `coordinate_<statut>`
(`ambiguous`, `invalid`…).

## Sources affichées

Le sélecteur **« Découvertes affichées »** en tête du panneau Filtres offre
trois choix persistés (`main_discovery_sources` dans les préférences) :

- **Géocaches** (défaut) — comportement historique inchangé ;
- **Lab Caches** — seules les étapes ;
- **Géocaches et Lab Caches** — les deux, mélangés chronologiquement.

Le choix s'applique dès le chargement initial, après un import, après une
suppression de source, et survit au rechargement.

### Filtres

| Dimension | Comportement |
|---|---|
| Type | `Adventure Lab` est un type comme les autres (sélection type vide → rien, Labs comprises) |
| Difficulté / Terrain / Taille / Période de pose | **Non applicables** : ils ne retirent jamais une étape Lab ; en mode « Labs seuls » ils sont désactivés |
| Pays / Région | Valeurs inconnues → option **« Non renseigné »** (sentinelle interne `__unknown__`) ; incluses à l'état neutre, exclues d'une sélection réelle sauf si « Non renseigné » est coché |
| Date de découverte | Appliquée à `found_date` des étapes |

Suppression : « Supprimer mes géocaches » et « Supprimer mes Lab Caches »
sont indépendantes ; l'affichage bascule sur la source restante.

## Rendu sur la carte

- **Couleur** : `#00C5A1` (turquoise de la palette MyGCFlow — choix interne,
  aucune couleur officielle attestée), déclarée dans
  `static/json/defaultGcColors.json` ; utilisée par les points en mode
  « Couleurs GC », les bordures et les flashs.
- **Icône** : slot `adventurelab` ajouté dans les sprites
  `static/img/geocaching-sprite*.png` (carré arrondi turquoise à anneau
  blanc), mappé dans `point_webgl_style.js`. En mode « forme » (cercle /
  triangle), les étapes suivent le style du thème comme les géocaches.
- **Popup** : titre de l'étape, titre de l'Adventure, date de découverte.
  Pas de D/T/taille (sans objet), pas de code GC ni de lien `coord.info`.
  Le titre de l'Adventure devient un lien **uniquement** quand l'URL
  importée est une URL HTTPS sur `labs.geocaching.com` ou
  `adventurelab.page.link` (champ `adventure_url`, présent dans les GPX
  Lab2Gpx) ; toute autre valeur est ignorée. Quand la coordonnée vient du
  centre de l'Adventure plutôt que de l'étape (`coordinate_scope =
  "adventure"`), le popup le signale.

## Animation, trajet, vidéo

Les étapes résolues entrent dans le même index `pointsByDate` (clé =
`date_find`) que les géocaches : elles participent à la lecture
chronologique, aux flashs, au trajet et au suivi de caméra sans code
spécifique — et donc à l'export vidéo, qui capture le même rendu. Une étape
compte pour **une** découverte dans les balises `{trouvees}` / `{total}` ;
les étapes en attente n'existent dans aucun de ces totaux.

## Export et données persistées

« Exporter » (carte Mes Lab Caches) produit un JSON `mygcflow-lab-finds`
**enrichi** des coordonnées, URLs et corrections — réimportable tel quel
dans MyGCFlow pour sauvegarde ou transfert.

Données conservées par découverte (`models.py` → `lab_discovery`) : UUIDs
Adventure et étape, date (civile, UTC, offset, précision, base), coordonnées
(portée `stage`/`adventure`, source `lab2gpx`/`user_correction`, statut),
provenance du fichier source, archivage. Révision de collection utilisée
pour détecter un commit obsolète.

## Limites connues

- Pas d'accès à l'API officielle : seuls les deux fichiers décrits sont
  exploitables. Un fournisseur réseau éventuel reste une extension future
  (voir plan §12).
- La jointure exige l'UUID d'étape : les étapes présentes dans l'historique
  mais absentes de tout GPX importé restent en attente (197 sur 4 953 sur
  les données réelles de test — Adventures non exportées).
- Les liens d'étape n'existent pas : seul le lien de l'Adventure importé
  est proposé.
