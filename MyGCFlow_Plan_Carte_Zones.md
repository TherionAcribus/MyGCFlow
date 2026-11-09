# Carte par zones : animation sur la carte, mini-cartes dans Statistiques

Plan rédigé le 2026-11-09 et révisé le même jour pour les joueurs du monde
entier. **Rien n'est codé.**

Idée : colorer des zones (pays, régions, sous-régions, puis cases d'une
grille) selon une valeur calculée sur les caches. Exemples de valeurs : nombre
de trouvailles, types différents, combinaisons D/T différentes, % de caches
trouvées. Les zones s'affichent à deux endroits :

- **sur la carte normale**, en couche animée sous les points : les zones se
  colorent jour après jour pendant l'aperçu et dans la vidéo ;
- **dans la page Statistiques**, en **mini-cartes recalculées** (petits
  multiples) figées aux moments clés. Un clic sur une mini-carte ouvre la
  carte normale en pause à cette date.

Choix validés avec l'utilisateur :
- mini-cartes **recalculées** (pas de captures d'écran de l'animation) ;
- **un seul calcul partagé** par les deux pages, pour que les chiffres soient
  identiques ;
- **une échelle de couleurs fixe** pendant toute l'animation, et commune aux
  mini-cartes ;
- **l'app sert des joueurs du monde entier**. Aucun code n'est propre à la
  France. Chaque pays est décrit par une **recette** de données. Pays prévus
  dès le départ : **France, Allemagne, États-Unis**. Les suivants s'ajoutent
  par une procédure simple et documentée (§ 3).

## 0. État d'avancement

**Lot 1 livré le 2026-11-09** : recettes `world`, `FR`, `DE`, `US`,
`tools/build_geo_zones.py` (mapshaper 0.7.94 en dépendance de
développement), `static/geo/` + `geo/match/`, `zones.py`, colonnes de zones
dans `/api/stats/finds` (format v2), tests génériques, docs
`docs/carte-zones.md` et `docs/zones-ajouter-un-pays.md`. Questions
ouvertes en § 12.

Écarts avec le plan ci-dessous, constatés en codant :
- **Alias et points témoins dans la recette** elle-même (`aliases`,
  `samples`), pas dans `static/geo/aliases/` ni `*.samples.json` : un seul
  fichier par pays. Les alias générés viennent des champs de la source.
- **Encarts** : métadonnées seulement (`insets` d'`index.json`). La
  géométrie d'affichage reste à sa vraie place, car la couche OpenLayers de
  la carte en a besoin. Le déplacement se fera au rendu des mini-cartes
  (lot 3).
- **Niveau 1 de Natural Earth inégal** : France en départements, Italie et
  Espagne en provinces, Royaume-Uni en 232 districts. `world.json`
  regroupe par champ (`dissolve`) : IT et ES par région, SI par région
  statistique, GB par nation en attendant sa recette. La France a sa
  recette de régions (IGN).
- **Sous-région seulement parmi les enfants de la région** retenue (et pas
  de repli sur tout le pays). La somme des sous-régions fait toujours la
  région. Une position qui contredit la région de GC laisse la cache hors
  carte au niveau 2 : 8 trouvailles sur 24 000 en dev, des mystères.
- **Îlots** (Helgoland, île de Sein) effacés du contour simplifié des pays,
  même au 1:10m : retrouvés dans les niveaux fins des pays voisins.
- **Poids réel** : ~6 Mo d'affichage et ~5,7 Mo de rattachement (et non
  ~5 Mo en tout). Le gros vient des régions du monde (3,3 + 2,4 Mo) et des
  comtés US (1,5 + 1,8 Mo). Tout est chargé à la demande.
- **Colonnes Évolution** reportées à la source Évolution des mini-cartes :
  ~3,5 s de rattachement pour 464 000 caches, à faire à l'import.

## 1. Contexte constaté dans le code

- **Colonnes déjà là** : les tables de `chart_sources.mjs` ont `country`,
  `state` et `county` (dictionnaires). `county` n'existe que pour Évolution :
  le GPX My Finds ne donne pas le niveau sous la région.
- **Coordonnées** : `/api/stats/finds` (`stats_finds.py`) n'envoie **pas** de
  coordonnées. Évolution les a (`lat`, `lon` de `evolution.db`).
- **Jeu Évolution du poste de dev** : « France », 464 475 caches, 13 régions,
  97 départements, outre-mer compris. Les longitudes vont de -126 à 139 : il y
  a des coordonnées hors métropole, voire aberrantes.
- **Noms de régions de Geocaching.com** (`instance/country_state.json` du
  poste de dev) :
  - **« Limburg »** existe en Belgique *et* aux Pays-Bas : un nom n'a de sens
    qu'avec son pays ;
  - **« Catalunya » et « Cataluña »** sont la même région : une zone a
    plusieurs alias ;
  - **« Réunion » et « Mayotte »** sont des *pays* pour Geocaching.com, mais
    des parties de la France pour nous ;
  - le **Royaume-Uni** a ses propres régions (« London ») ;
  - plusieurs pays n'ont **aucune région** (`__unknown__`) ;
  - en France : `Grand-Est`, `Centre-Val-de-Loire` (IGN : « Grand Est »,
    « Centre-Val de Loire ») ; en Italie : `Friuli–Venezia Giulia`, avec un
    tiret demi-cadratin.
- **Le modèle de Statistiques porte déjà l'essentiel** :
  - groupement `country` / `state` / `county` ;
  - mesures `count`, `distinct`, `mean`, `cumulative` (avec `from: "all"`),
    `active` ;
  - périodes `each` (une par année) et comparaison `side` (petits multiples,
    même échelle).

  Une mini-carte, c'est donc « ce résultat par zone, dessiné en carte ». Il
  faut un nouveau `view.chart`, pas un nouveau moteur.
- **Vidéo** : les deux pipelines assemblent tous les canvas du viewport
  (`mapgl.js` l. ~4953 et ~5595). Une couche OpenLayers de plus est capturée
  sans rien ajouter.
- **Ordre des couches** (`zIndex`) : trait 1000, points 1001, DNF 1000 / 999.9,
  tête du trait 1050, flashs 1100. La couche de zones se place **sous tout
  cela** (vers 500), au-dessus du fond de carte. Le `zIndex` des tuiles reste
  à vérifier.
- **Branchements de l'animation** : `accumulateStatsForDates` et
  `seekStatsToDate` (panneaux Stats), `lifecycle_engine.mjs` (Évolution, Mes
  poses).
- **Retour à la carte** : `chart_map_link.mjs` écrit `filtersSelection`. Ouvrir
  la carte en pause à une date n'existe pas encore, mais `startPausedPreview`
  et `seekAnimationToDate` existent.
- **Réglages** : l'apparence de la carte va dans le **profil**, ce qui décrit
  la machine ou l'utilisateur va en **global** (`docs/preferences-et-profils.md`).
- **Distribution** : mises à jour par les Releases GitHub. Les nouveaux pays
  arrivent donc avec les mises à jour de l'app.

## 2. Les données de zones : un format, trois niveaux

### 2.1 Niveaux

| Niveau | Clé | Exemples | Couverture |
|---|---|---|---|
| 0 | `country` | France, Deutschland | **monde entier**, embarqué |
| 1 | `region` | régions FR, Länder, États US | **monde entier**, embarqué |
| 2 | `subregion` | départements, Landkreise, counties | **pays par pays**, avec un pack |

- Le code ne connaît que ces trois clés. Le **nom affiché** du niveau vient du
  pack : « départements », « Landkreise », « counties ».
- **Niveau 1 pour tous dès le départ** : Natural Earth admin-1 couvre le monde
  (domaine public). Un joueur japonais ou brésilien a ses pays et ses régions
  sans rien attendre.
- **Niveau 2 seulement là où il y a un pack.** Ailleurs, l'éditeur propose le
  niveau 2 grisé : « Pas encore de découpage plus fin pour ce pays », avec un
  lien vers la demande d'ajout (§ 3.5). Dans une carte qui mélange plusieurs
  pays, un pays sans pack s'affiche au niveau 1.

### 2.2 Fichiers (`static/geo/`)

```
static/geo/
  index.json            catalogue : pays, niveaux disponibles, versions, tailles, attributions
  countries.json        niveau 0, monde
  regions/<ISO>.json    niveau 1, un fichier par pays (chargé à la demande)
  subregions/<ISO>.json niveau 2, un fichier par pack
  aliases/<ISO>.json    noms Geocaching.com → id de zone (niveaux 0 et 1)
```

- **Format** : GeoJSON simplifié, coordonnées à 4 décimales. ECharts
  (`registerMap`) et OpenLayers le lisent tous les deux tel quel.
- **Chaque zone porte** :
  - un `id` stable, ISO 3166-2 quand il existe (`FR-44`, `DE-BY`, `US-TX`).
    Sinon un code officiel préfixé par le pays (`DE-09162` pour un Kreis,
    `US-48201` pour un comté, code FIPS) ;
  - `name` (nom local), `name_fr`, `name_en` ;
  - `parent` (id du niveau au-dessus) ;
  - `area_km2` (pour la densité).
- **Encarts** (Outre-mer, Alaska, Hawaï) : géométries repositionnées dans le
  fichier lui-même, avec `inset: true` et le décalage appliqué. Le
  rattachement par position utilise la vraie géométrie, gardée à part
  (§ 4.2).
- **Chargement paresseux** et cache navigateur long (nom de fichier versionné
  dans `index.json`).
- **Budget** : pays ~250 Ko ; régions du monde ~2-3 Mo au total, en fichiers
  par pays ; un pack niveau 2 ≤ 1,5 Mo (counties US ≈ le plus gros). Le test
  générique (§ 3.4) refuse un fichier hors budget.

### 2.3 Embarqué ou téléchargé ?

**Tout est embarqué** dans l'app, et un nouveau pays arrive avec une mise à
jour. C'est le plus simple : pas d'interface de téléchargement, pas de
vérification d'intégrité, l'app reste hors ligne. Avec les trois premiers
packs, ~5 Mo en tout.

Le téléchargement à la demande (packs publiés en Releases) ne vaudra la peine
que si le total dépasse ~20 Mo. Le format est prévu pour : un pack est un
fichier autonome décrit dans `index.json`.

## 3. Ajouter un pays : la procédure

Doc de référence : `docs/zones-ajouter-un-pays.md`. Objectif : **une recette,
une commande, des tests qui passent tout seuls**. Pas de code à écrire.

### 3.1 La recette (`geo/recipes/<ISO>.json`)

Un fichier déclaratif par pays, versionné dans le dépôt :

```json
{
  "country": "DE",
  "level": "subregion",
  "label": { "fr": "arrondissements (Kreise)", "en": "districts (Kreise)", "local": "Landkreise" },
  "source": {
    "url": "https://…/vg250_01-01.utm32s.shape.ebenen.zip",
    "sha256": "…",
    "layer": "VG250_KRS",
    "licence": "dl-de/by-2-0",
    "attribution": "© GeoBasis-DE / BKG (2025)"
  },
  "fields": { "code": "AGS", "name": "GEN", "parent": "SN_L" },
  "parent_map": { "09": "DE-BY", "08": "DE-BW" },
  "simplify": "2%",
  "insets": [],
  "dissolve": null
}
```

- `parent_map` relie le code de la source à l'id de la région (niveau 1).
- `insets` : zones à déplacer en encart (ex. US : Alaska, Hawaï ; FR : outre-mer).
- `dissolve` : table de fusion d'unités, pour les pays où Geocaching.com a
  son propre découpage (Royaume-Uni, § 3.6).

### 3.2 La commande

```
python tools/build_geo_zones.py DE
```

1. Télécharge la source et vérifie son `sha256`. Cache local dans
   `geo/.cache/`, non versionné.
2. Simplifie avec **mapshaper**, en dépendance de développement npm. Sa
   simplification **garde les frontières communes** : pas de trous ni de
   chevauchements entre zones voisines, ce qu'une simplification polygone par
   polygone ne garantit pas.
3. Calcule ids, parents, surfaces, encarts, puis écrit
   `static/geo/subregions/DE.json`.
4. Met à jour `static/geo/index.json` et l'**attribution** dans
   `licenses/THIRD_PARTY_NOTICES.txt` (section générée, pas à la main).
5. Affiche un **rapport** : nombre de zones, taille, zones sans parent, noms
   Geocaching.com connus sans correspondance (§ 3.3).

Le script et mapshaper sont des outils de développement : l'app ne les
embarque pas et ne fait aucun traitement géographique lourd.

### 3.3 Les alias de noms Geocaching.com (`static/geo/aliases/<ISO>.json`)

```json
{ "country": ["Germany", "Deutschland", "Allemagne"],
  "regions": { "DE-BY": ["Bayern", "Bavaria"], "DE-BW": ["Baden-Württemberg"] } }
```

- **Générés d'abord** à partir des noms de Natural Earth (`name`, `name_en`,
  `name_local`, `name_alt`), puis **complétés à la main** pour les écarts. La
  comparaison ignore casse, accents, tirets (y compris demi-cadratin) et
  espaces.
- **Rangés par pays** : « Limburg » belge et néerlandais ne se confondent
  jamais.
- **Pays Geocaching.com qui sont des régions chez nous** : `"Réunion"` dans
  `aliases/FR.json` sous `"as_region": {"FR-974": ["Réunion"]}`.
- **Un nom inconnu n'est jamais bloquant** : la position prend le relais
  (§ 4). L'app relève ces noms (§ 3.5), ce qui alimente les alias au fil du
  temps.

### 3.4 Les tests, génériques

`tests/test_geo_zones.py` parcourt **tous** les fichiers de `static/geo/` :
- ids uniques, parents existants, noms FR/EN/local présents ;
- géométries valides, surfaces cohérentes, encarts dans le cadre du pays ;
- budget de taille respecté ;
- chaque attribution présente dans `THIRD_PARTY_NOTICES.txt` ;
- chaque nom de `aliases/` pointe vers une zone existante, sans doublon
  ambigu dans un même pays.

Seule partie écrite à la main par pays : **`geo/recipes/<ISO>.samples.json`**,
5 à 10 points connus avec leur zone attendue (dont un près d'une frontière et
un sur la côte). Le test les vérifie avec le vrai code de rattachement.

### 3.5 Côté joueurs : demander un pays, signaler un nom

- Dans les réglages de zones, un **rapport de rattachement** : « 3 régions de
  tes trouvailles n'ont pas été reconnues par leur nom, rattachées par
  position », avec un bouton **« Copier le rapport »** (noms bruts + pays).
- Un **modèle d'issue GitHub** « Ajouter un pays / corriger un nom ». Une
  recette est assez petite pour qu'un joueur la propose lui-même en PR : la
  doc l'explique.

### 3.6 Sources et licences

| Licence | Statut | Exemples |
|---|---|---|
| Domaine public, CC0 | acceptée | Natural Earth, US Census (cartographic boundary files) |
| CC BY 4.0 | acceptée, attribution | geoBoundaries (repli générique) |
| Licence Ouverte 2.0 | acceptée, attribution | IGN Admin Express (France) |
| dl-de/by-2-0 | acceptée, attribution | BKG VG250 (Allemagne) |
| ODbL | **refusée** (partage à l'identique sur la base : contrainte de trop) | OpenStreetMap |
| non commerciale (GADM, CC BY-NC) | **refusée** | GADM |

Ordre de préférence : la source officielle du pays si sa licence est
acceptée, sinon geoBoundaries. La doc garde cette table à jour.

**Royaume-Uni** (plus tard) : les régions de Geocaching.com ne sont pas un
découpage standard. Recette avec `dissolve` (comtés → régions GC). C'est le
seul pays connu qui en a besoin, mais le mécanisme est générique.

## 4. Rattachement de chaque cache à sa zone

Fait **côté serveur, une seule fois** (`zones.py`, Python pur), pour que les
deux pages reçoivent la même attribution.

### 4.1 Ordre

1. **Nom Geocaching.com** (niveaux 0 et 1) : `country` puis `state` via les
   alias du pays. C'est cohérent avec le filtre « Région » de la carte.
2. **Position** sinon (nom absent, inconnu, ou niveau 2) : point dans
   polygone, préfiltre par rectangle englobant.
3. **Zone la plus proche**, à moins de 5 km, si le point ne tombe dans aucun
   polygone : caches côtières ou sur des îlots que la simplification a
   gommés.
4. Sinon `-1`, **« Hors carte »**, compté et visible dans la légende et
   l'infobulle. Une cache n'est jamais perdue en silence.

Niveau 2 pour Évolution : son champ `county` via les alias du pack s'il y en
a, sinon la position.

### 4.2 Géométries de rattachement

Le rattachement utilise des géométries **non déplacées** (sans encarts) et
moins simplifiées que celles de l'affichage. Elles sont produites par le même
script et rangées hors de `static/` (`geo/match/`), car seul le serveur les
lit. Pour 20 000 trouvailles, l'affaire de la seconde. Le résultat est
calculé à la construction du jeu de base (`geojson_cache`) et gardé avec lui.
Évolution le calcule à l'import (464 000 caches : à mesurer, sinon
parallélisé ou index spatial simple par grille).

### 4.3 Colonnes

Nouvelles colonnes de la table commune : `zone_country`, `zone_region`,
`zone_subregion` (index dans un dictionnaire d'`id`, `-1` = hors carte). Elles
sont distinctes de `country` / `state`, qui gardent les libellés bruts pour
les filtres.

**Grille** (lot 5) : la case se calcule côté client à partir de `lat`/`lon`.
`/api/stats/finds` gagne donc deux colonnes, en ajout compatible.

## 5. Le calcul partagé : `zone_model.mjs`

Module **pur** (ni DOM, ni OpenLayers, ni ECharts), testé sous Node.

### 5.1 Mesures par zone

| Mesure | Sens | Mode |
|---|---|---|
| `count` | trouvailles (ou caches) | cumul |
| `distinct` sur `cache_type`, `container`, `owner` | valeurs différentes | cumul (ensembles par zone) |
| `dt_coverage` | combinaisons D/T différentes, sur 81 | cumul |
| `mean` sur `difficulty`, `terrain` | moyenne | cumul (somme + nombre) |
| `first_day` | date de la première trouvaille dans la zone : la « conquête » | fixé au premier événement |
| `density` | valeur ÷ surface (km²) | dérivé |
| `active` | caches vivantes (Évolution) | stock : monte **et descend** |
| `found_share` | % des caches d'un jeu Évolution que j'ai trouvées (lot 6) | croisé |

### 5.2 État et déplacement dans le temps

- `createZoneState({ table, level, measure })` renvoie un état avec :
  - `apply(rows)` / `remove(rows)` pour un lot de jours ;
  - `valueOf(zoneId)` et `changedSince(token)` (zones à redessiner) ;
  - `snapshot()`.
- **Saut** : points de reprise tous les N jours, plafonnés en mémoire. Un saut
  repart du plus proche, comme `seekPointsToDay`. Pour `active`, recalcul par
  le moteur de cycle de vie.
- **Instantanés aux moments clés** : un seul passage sur les événements triés
  par jour.

### 5.3 Échelle de couleurs

- `zoneScale(values, { mode, classes })` : `quantile` (défaut), `linear`,
  `log`, seuils fixes. **5 à 7 classes discrètes**.
- **Calculée sur l'état final** (fin de la plage d'animation, ou dernier
  moment affiché) : une teinte garde le même sens tout du long.
- `first_day` : palette séquentielle par année, légende en années.

### 5.4 Moments clés

`keyMoments(table, rule)` renvoie `{day, label, kind}` :
- `year_end`, `quarter_end` ;
- `milestones` : 100e, 250e, 500e, 1 000e… trouvaille ;
- `new_zone` : premier pays / première région / sous-région ;
- `custom` : dates libres.

Dédoublonnage, **plafond de 12 vignettes** (priorité : libres, paliers,
nouvelles zones, réguliers), dernier jour des données toujours inclus.

## 6. Mini-cartes dans Statistiques

### 6.1 Dans le modèle existant

```json
{
  "source": "finds",
  "measure": { "op": "cumulative", "from": "all" },
  "groupBy": "zone_subregion",
  "periods": [{ "kind": "moments", "rule": "year_end", "max": 12 }],
  "compare": { "layout": "side" },
  "view": {
    "chart": "map",
    "map": { "frame": "auto", "scale": "quantile", "classes": 6, "highlightChanges": true }
  }
}
```

- `view.chart: "map"` est ajouté à `CHART_TYPES`. Il n'accepte que les
  groupements `zone_country`, `zone_region`, `zone_subregion` (règles dans
  `chart_spec.mjs`). Ces trois dimensions servent aussi aux autres
  graphiques : une barre « mes départements » bénéficie du rattachement par
  position.
- `periods: [{kind: "moments"}]` : nouveau type de période, une par moment
  clé, en cumul jusqu'à ce jour.
- Une période → **une grande carte**. Plusieurs en `side` → **grille de
  petits multiples**, à la même échelle.
- `view.map.frame` : `auto` (rectangle englobant des zones non vides, sans
  les points aberrants), `country:<ISO>`, `continent`, `world`.

### 6.2 Rendu (`chart_echarts.mjs`)

- `echarts.registerMap` par fichier chargé. Une carte multi-pays assemble les
  fichiers nécessaires en une carte composite.
- **Une seule instance ECharts** pour toute la grille : un `geo` par vignette,
  une série `map` chacune, un `visualMap` commun. Exports, présentation et
  vidéo marchent donc sans changement.
- **Titre de vignette** : date et chiffre clé (« 2019 · 312 trouvailles · 41
  départements »). Le nom du niveau vient du pack.
- **Contour accentué** des zones changées depuis la vignette précédente.
- **Infobulle** : nom dans la langue de l'app (`name_fr`/`name_en`, repli sur
  `name`), valeur, rang, écart avec la vignette précédente.
- **Attribution** des sources en pied de carte et dans les exports.
- **Accessibilité** : résumé textuel calculé.
- **Vidéo du tableau** : vignettes qui apparaissent l'une après l'autre.

### 6.3 Retour à la carte

Clic sur une zone d'une vignette → page « Mes Géocaches » :
- **en pause à la date de la vignette** : nouveau paramètre `/?at=YYYY-MM-DD`,
  lu après `mygcflowReady` (`startPausedPreview` puis `seekAnimationToDate`) ;
- **centrée sur la zone** ;
- filtrée sur le pays au niveau 0 (déjà su par `chart_map_link.mjs`).
  Niveaux 1 et 2 : centrage seul.

Évolution : même lien vers `/evolution?at=…`.

### 6.4 Questions toutes faites (galerie)

Rédigées sans référence à un pays : le pays vient des données.
- « Ma conquête » : niveau le plus fin disponible, `first_day`.
- « Mes zones année par année » : cumul, fin d'année.
- « Mes pays » : monde, cumul.
- « Ma grille D/T par région » : `dt_coverage`.
- « Ma couverture » : % trouvé (lot 6).

## 7. Couche animée sur la carte normale

### 7.1 Module `zone_layer.js` (DOM / OpenLayers)

- `ol.layer.Vector` de polygones, `zIndex` ~500. 3 000 counties US restent
  raisonnables en canvas, à mesurer. La grille (lot 5) passera peut-être par
  `WebGLVector`.
- Styles en cache par classe, aucun nouvel objet par frame.
- **Branchements** comme les panneaux Stats : lot de jours → `apply` ; saut →
  `seek` ; arrêt → état de repos ; `pointsByDateRevision` → recalcul complet.
- **Évolution / Mes poses** : suit `lifecycle_engine.mjs`.
- **Vidéo** : capture automatique, à vérifier dans les **deux** pipelines.

### 7.2 Effets

- **Fondu de couleur** au changement de classe (~600 ms). Redessin seulement
  pendant un fondu.
- **Éclat** du contour au passage de palier, désactivable.
- **Légende** sur la carte et dans la vidéo (`overlay_canvas.js`, comme
  `#mapLegend`), avec l'attribution des sources.
- **Opacité** réglable (0,25 à 0,8).

### 7.3 Réglages (décidé le 2026-11-09)

- **Onglet à part « Zones »**, comme l'onglet Images : il ne s'ajoute pas à
  l'onglet Style. Son icône `ti-*` passe par `generate_icons_subset.py`.
  Chaque section porte son badge de portée (`global_scope_badge()` /
  `profile_scope_badge()`).
- **Bascule on/off : préférence globale**, sauvegardée automatiquement
  (`saveSettingsPatch` + `reportSave`), comme `dnf_display`. Une clé par page
  via `perPage(...)` : `zones_display` pour « Mes Géocaches »,
  `evolution_zones_display` pour Évolution, et pour Mes poses si la couche y
  vient. Les specs E2E qui l'activent la remettent à `false` en sortant
  (famille de AGENTS.md, à y ajouter au lot 4).
- **Profil** (apparence de la carte, bouton « Sauvegarder ») : niveau,
  mesure, palette, opacité, classes, contours, éclat, légende.

## 8. Croisement Évolution × Mes trouvailles (`found_share`)

- **Numérateur** : mes trouvailles dont le code GC est dans le jeu Évolution.
  **Dénominateur** : caches du jeu **actives à la date** (défaut), ou toutes
  celles ayant existé jusqu'à la date.
- **Statistiques** : jointure par code GC dans le module pur, les deux tables
  étant déjà chargées.
- **Carte normale** : le serveur précalcule par zone la série journalière du
  dénominateur (quelques milliers de lignes, ETag par révision), au lieu de
  charger 464 000 caches dans la page.

## 9. Lots

| Lot | Contenu | Livrable visible |
|---|---|---|
| **1. Données de zones** ✅ | Format § 2, `build_geo_zones.py` + mapshaper, recettes **FR, DE, US** (niveau 2 avec encarts : outre-mer, Alaska, Hawaï), pays + régions du monde (Natural Earth), alias générés + corrections, `zones.py` (rattachement § 4), colonnes `zone_*`, tests génériques § 3.4, doc **« Ajouter un pays »** | Rien de visible : tests et doc |
| **2. `zone_model.mjs`** | Mesures § 5.1 sauf `found_share`, état + saut, échelle, `keyMoments` | Rien de visible |
| **3. Mini-cartes** | `view.chart: "map"`, dimensions `zone_*`, période `moments`, rendu ECharts, éditeur, questions toutes faites, lien `?at=`, rapport de rattachement | Conquête et zones année par année dans Statistiques |
| **4. Couche animée** | `zone_layer.js` sur « Mes Géocaches », effets, légende, onglet « Zones » (bascule globale, apparence au profil), vidéo | Les zones se colorent pendant l'animation et dans la vidéo |
| **5. Évolution, Mes poses, grille** | Couche sur `/evolution` (`active`), coordonnées dans `/api/stats/finds`, niveau grille | Densité des caches actives qui évolue |
| **6. Croisement** | `found_share` | % de caches trouvées par zone, animé |
| **7. Pays suivants** | Royaume-Uni (`dissolve`), puis pays demandés par les joueurs, modèle d'issue GitHub | Nouveaux pays à chaque mise à jour |

Faire FR, DE et US ensemble dès le lot 1 éprouve le format sur trois cas
différents : outre-mer, villes-États (Berlin, Hambourg à la fois Land et
Kreis), 3 000 comtés avec encarts. Si la recette suffit pour ces trois, elle
suffira pour les suivants.

Chaque lot comprend : doc (`docs/carte-zones.md`), guide, traductions (`t()`
hors template literal, pas de `t?.()`), tests unitaires, un spec E2E ciblé.
Suite E2E complète en fin de lot seulement. Les noms de zones viennent des
fichiers, ils ne passent pas par pybabel.

## 10. Tests

- **Python** :
  - génériques sur tous les fichiers (§ 3.4) et points témoins par pays ;
  - rattachement : ordre nom → position → plus proche → hors carte ;
    homonymes entre pays (« Limburg ») ; « Réunion » en pays GC ; Corse
    `2A`/`2B` ; encarts non utilisés pour le rattachement ;
  - le script `build_geo_zones.py` sur une mini-source de test (pas de
    téléchargement en test).
- **Node** (`tests/js/zone_model.test.mjs`) : valeurs par zone, saut
  avant/arrière = calcul depuis zéro, `active` qui redescend, échelle,
  `keyMoments`. `chart_echarts` : forme des options.
- **E2E** : `stats-zones.spec.mjs` (`getStatsPageSnapshot()`) et
  `zone-layer.spec.mjs` (`getZoneLayerDebugState()` : classe par zone, jour
  appliqué, fondus). Fixture GPX avec trouvailles en France, Allemagne et
  États-Unis.

## 11. Pièges identifiés d'avance

- **Noms** : jamais de comparaison de nom sans le pays ; normalisation
  (casse, accents, tirets, espaces). La position rattrape tout nom inconnu.
- **Frontières simplifiées** : simplifier avec la topologie (mapshaper),
  rattacher sur des géométries plus fines que celles de l'affichage.
- **Zones écrasantes** et **tailles très différentes** d'un pays à l'autre
  (département français contre comté texan) : quantiles par défaut, densité
  proposée.
- **Échelle mouvante** : figée (§ 5.3).
- **Encarts** : seulement pour l'affichage, jamais pour le rattachement ni
  pour le cadrage automatique.
- **Coordonnées aberrantes** : « Hors carte », sans étendre le cadrage.
- **Projection du monde** : cadrage `auto` et `continent`.
- **Poids** : budget par fichier vérifié par les tests, chargement paresseux.
- **Évolution à 464 000 caches** : tables en colonnes, rattachement mesuré à
  l'import, croisement carte par agrégat serveur.
- **Labs** : D/T `null`, exclus de `dt_coverage` et `mean`, comptés dans
  `count`.
- **Licences** : jamais ODbL ni non commerciale ; attribution générée par le
  script, vérifiée par les tests.
- **Modules** : `zone_model.mjs` ne tire ni `index.js` ni le DOM.
  `zone_layer.js` s'initialise en fin de fichier si `initUIElements` l'appelle
  (zone morte, cf. AGENTS.md).
- **Icônes** : toute nouvelle `ti-*` passe par `generate_icons_subset.py`.

## 12. Questions ouvertes

Tranchées le 2026-11-09 :
- **Niveau 2 en Allemagne** : les **Landkreise** (~400), que les joueurs
  allemands connaissent déjà par les défis par Kreis.
- **Réglages de la couche** : **onglet à part « Zones »** (§ 7.3).
- **Bascule on/off** : **préférence globale**, une clé par page (§ 7.3).

Restent ouvertes :
- **Dénominateur de `found_share`** par défaut : actives à la date (proposé),
  ou toutes celles ayant existé ? À trancher au lot 6.
- **Seuil du téléchargement à la demande** : ~20 Mo d'embarqué (§ 2.3).
