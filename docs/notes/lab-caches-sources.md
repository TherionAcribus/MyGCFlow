# Sources d'export Adventure Lab — état des lieux (Lot 0)

Document de travail pour le lot « Sources réelles » du plan
`MyGCFlow_Plan_Implementation_Lab_Caches.md`. Distingue ce qui est **vérifié
par inspection du code/source** de ce qui reste **à confirmer sur un export
réel**. Vérifié le 12 octobre 2026.

## Ce qui est vérifié

### Page `labs.geocaching.com/logs` (historique personnel)

- Page connectée listant les découvertes d'étapes, regroupées par Adventure.
- Chaque `li` = **une étape trouvée** (vérifié sur un compte réel) : lien
  `/Adventures/GetSmartLink/<uuid-adventure>`, titre d'étape, et
  `<small class="log-date">Complétées: JJ/MM/AAAA</small>` (format localisé
  du navigateur ; le libellé « Complétées » est celui de la page en
  français). Le titre de l'Adventure est dans un `h2` au-dessus du groupe.
- Le DOM ne porte **aucun UUID d'étape** — mais la réponse JSON que la page
  consomme, si (voir ci-dessous). Le vieux bookmarklet rragan
  (`li[data-adv-id]`) est **cassé** : la structure actuelle n'utilise plus
  cet attribut.

### Endpoint `GetLogsByAdventureGrouping` (vérifié sur réponse réelle)

- Appelé par la page `/logs`, **même origine** `labs.geocaching.com` → un
  script console/bookmarklet exécuté sur la page peut le re-fétcher avec
  les cookies de session (pagination complète sans scraping DOM).
- Forme de la réponse (réel, 2026-10) :

  ```json
  {"totalCount": 1117, "items": [{
    "adventureId": "<uuid>",
    "adventureTitle": "…",
    "adventureKeyImageUrl": "https://gsmediadata.blob.core.windows.net/…",
    "isArchived": false,
    "dateLastLoggedUtc": "2026-09-17T15:37:17.327-07:00",
    "playerLogs": [{
      "id": 201771996,
      "stageId": "<uuid-étape>",
      "stageTitle": "…",
      "dateLogged": "2026-09-17T18:35:48.487-07:00",
      "stageKeyImageUrl": "…",
      "isArchived": false
    }]
  }]}
  ```

- `playerLogs[].id` : ID numérique de log — clé de dédoublonnage stable.
- `stageId` : **vrai UUID d'étape**, le même que `gsak:Guid` du GPX
  Lab2Gpx → jointure automatique par UUID (règle 1 du plan).
- `dateLogged` : instant ISO **avec offset `-07:00`** (heure du Pacifique,
  timezone de Groundspeak/Seattle, pas UTC malgré le nom
  `dateLastLoggedUtc`). La date affichée par la page correspond à la date
  civile **dans cet offset**.
- Pagination **vérifiée** : `POST /Logs/GetLogsByAdventureGrouping/` avec
  corps JSON `{id: "<GUID public joueur>", skip, take}`. `take=100/200`
  → HTTP 500 ; `take=50` OK. Boucler sur `skip` jusqu'à page vide ; la
  page hors borne renvoie `totalCount: 0` (bizarrerie, sans impact).
  Export complet réel : 1117 Adventures / 4953 étapes (2015-07 → 2026-09),
  tout `stageId` et `dateLogged` renseignés, offsets `-07:00`/`-08:00`.
- `playerLogs[].id` : ID numérique de log — clé de dédoublonnage stable.
- Le nombre de `playerLogs` par Adventure reflète les étapes trouvées — une
  Adventure partielle n'en liste que les étapes trouvées.
- `isArchived` existe aux deux niveaux (Adventure et étape).

### Bookmarklet « FoundLabsIdBookmarklet » (rragan)

- Source : https://rragan.github.io/FoundLabsIdBookmarklet.html (inspecté).
- Produit : une liste d'UUID d'**Adventures** séparés par des virgules,
  rien d'autre — ni étapes, ni dates.
- Usage prévu : alimenter le champ « UUIDs » de Lab2Gpx.

### Lab2Gpx (https://lab2gpx.gcutils.de/, dépôt mirsch/lab2gpx)

- Outil web public ; la clé `X-Consumer-Key` reste côté serveur.
- **UI actuelle (V2, carte) : plus de champ « liste d'UUID ».** Les
  Settings n'ont ni rayon ni UUID ; le téléchargement se fait par cercle
  ~10 km sur la carte — inutilisable pour couvrir un historique mondial.
  L'ancien conseil « coller les UUID dans Lab2Gpx » (bookmarklet rragan)
  visait la V1 et produit aujourd'hui « code invalide » (les UUID sont
  collés dans un champ de coordonnées ; le seul champ UUID subsistant,
  « UUIDs to exclude », est une liste d'**exclusion**).
- **API `POST https://api.lab2gpx.gcutils.de/download` (vérifiée)** :
  endpoint documenté du même service (`api/src/request/*.http` du dépôt),
  sans auth ni clé. Le champ JSON `uuidsToFetch` (UUID séparés par
  virgules/retours) télécharge **exactement** les Adventures demandées —
  `coordinates`/`radius`/`limit` restent requis par la validation mais
  sont ignorés. `userGuid` (GUID public) optionnel → marqueurs
  `IsComplete` réels par étape (les étapes non trouvées d'une Adventure
  partielle restent `Geocache`). `locale` limité à `en`/`de`. Chaque UUID
  déclenche un fetch amont côté serveur : mesuré ~11 s pour 50 UUID ;
  certains UUID archivés provoquent un HTTP 500 → isoler par bissection.
  Outillage local : `tools/fetch_lab2gpx.py` (lots + bissection + reprise).
- `GET https://api.lab2gpx.gcutils.de/lab2gpx-data/by-uuid/{uuid}` :
  renvoie `{uuid, code, url(smartlink), title, lat, lon}` — **position de
  l'Adventure seulement**, pas les étapes : insuffisant, juste utile pour
  mapper UUID ↔ smartlink/titre.
- Gabarit **un waypoint par étape** (`api/templates/gpx.xml.twig`, vérifié) :
  chaque `<wpt>` est une étape.
  - `lat`/`lon` : coordonnées **de l'étape** (`wpt.Location`) ;
  - `<name>` : code généré par Lab2Gpx (base32 + suffixe d'étape, ex.
    `LCxxxx-1`) — **pas un UUID, pas stable entre outils** ;
  - `<desc>` : titre de l'étape ; `<urlname>` : `S<n> <titre Adventure>` ;
  - `<url>` : DeepLink de l'Adventure ;
  - `<time>` : `PublishedUtc` de l'Adventure — **jamais la date de
    découverte** ;
  - `<sym>` : `Geocache Found` si l'étape est trouvée (`wpt.IsComplete` ou
    Adventure complète) — marque de découverte **sans date** ;
  - `<gsak:wptExtension><gsak:Guid>` : **UUID de l'étape** (`wpt.Id`) ;
  - bloc `<lab2gpx:adventureLab>` : `uuid` (**UUID de l'Adventure**),
    `stagesTotal`, `stagesCompleted`, `themes`, `bonus` (codes GC) ;
  - `<groundspeak:name>` : `<Titre Adventure> : S<n> <titre étape>` ;
    owner/placed_by = pseudo du propriétaire ; D/T forcés à 1 ; container
    Virtual ; `<groundspeak:logs>` vide.
- Gabarit alternatif `gpxwaypoints.xml.twig` : un `<wpt>` parent à la
  position de l'Adventure + des étapes en `Waypoint|Virtual Stage` avec
  `gsak:Parent` = code généré — **sans UUID d'étape** : rapprochement moins
  fiable, à éviter comme format coordonnées.
- Pour que `IsComplete` soit renseigné, l'utilisateur doit fournir son GUID
  public (« Calling user's public GUID », trouvable via la page « find » de
  son profil geocaching.com). Les coordonnées sont présentes quand même.
- **Conclusion : fichier coordonnées exploitable** — UUID d'étape +
  UUID d'Adventure permettent la jointure forte du §6.4 du plan. Aucune
  date de découverte.

### APIs Labs (contexte — hors voie V1)

- `labs-api.geocaching.com` : `GET /Api/Adventures/{uuid}` (GeocacheSummaries
  → `Location` par étape, `IsComplete` si `callerGuid`), `SearchV4`
  (`CompletionStatuses` + `CallingUserPublicGuid`),
  `GetAdventureIdBySmartLink`. Toutes requièrent `X-Consumer-Key` — les clés
  connues sont celles de c:geo, Lab2Gpx ou de l'app officielle ; le plan les
  exclut. Endpoint `GET /Api/Adventures/{id}` marqué obsolète
  (mirsch/lab2gpx#180).
- `api.groundspeak.com/adventuresmobile` : API de l'app officielle
  (`/v1/public/adventures/{uuid}` accessible avec la seule clé consumer de
  l'app — exclue par le plan également).
- `labs.geocaching.com/gpx/search?latitude&longitude&skip&take` : endpoint
  GPX par zone (max take=500, session geocaching.com requise) — à
  documenter si besoin.
- La doc communautaire adv-lab/geocaching-adventure-labs-doc confirme :
  pas de date de découverte personnelle dans les réponses documentées ;
  `IsComplete` par étape seulement.

## Extensions tierces (schéma non vérifié — export réel attendu)

### « Export Found Lab Caches » (Lil Devil)

- Chrome `cjkdhjilamnglgjpabhmadhkaoiinegk`, existe aussi sur Firefox.
- Ajoute un bouton à la page des découvertes → export **GPX pour GSAK** ;
  un macro GSAK compagnon complète les infos absentes de la page (donc le
  GPX porte probablement les dates mais pas les coordonnées — à confirmer).
- Permissions : `www.geocaching.com`, `labs.geocaching.com`.

### « User's Found Adventure Labs Data » (Clan-Wallace)

- Chrome `jmeldfibneeolkjmjojmafcnmnmaikhp` / Firefox « User's Found
  Adventure Labs ».
- Bouton sur `/logs` → **CSV** des découvertes, pensé pour un macro GSAK
  qui crée ensuite les waypoints (dates + identifiants attendus,
  coordonnées improbables — à confirmer).

## Dictionnaire des identifiants

| Identifiant | Rôle | Où il apparaît |
|---|---|---|
| UUID d'Adventure | Identifie une Adventure | `li[data-adv-id]` sur /logs, `lab2gpx:uuid`, `Id`/`adventureGuid` des APIs |
| UUID d'étape | Identifie une étape | `gsak:Guid` du GPX Lab2Gpx, `Id` des GeocacheSummaries |
| Code généré (`LC…-N`) | Libellé lisible fabriqué par l'exporteur | `<name>`/`<gsak:Code>` Lab2Gpx — jamais un UUID, pas stable |
| Smart link | Alias d'Adventure | `labs.geocaching.com/goto/<nom>` → UUID via GetAdventureIdBySmartLink |
| GUID public du joueur | Identité publique du compte | URL de « Find a player » sur geocaching.com ; requis par Lab2Gpx pour `IsComplete` |

## Croisement réel historique ↔ coordonnées (2026-10-12)

Données réelles : `labs_sources/mygcflow-lab-finds-2026-10-12.json`
(1117 Adventures / 4953 étapes) contre 32 GPX produits par
`tools/fetch_lab2gpx.py` (mode `uuidsToFetch`, GUID public fourni).

| Mesure | Valeur |
|---|---|
| Étapes historique jointes par UUID exact (`stage_id` = `gsak:Guid`) | **4756 / 4953 (96,0 %)** |
| Désaccords d'Adventure sur les jointures | **0** |
| Étapes jointes avec `<sym>Geocache Found</sym>` | **4756 / 4756 (100 %)** |
| Étapes historique sans coordonnées | 197 |
| → Adventures absentes du GPX (31) | 190 étapes |
| → Étapes absentes dans Adventures présentes (remaniées) | 7 |
| Étapes GPX hors historique (non trouvées — à ignorer) | 796 |

Détail des 197 non résolues :

- **29 Adventures archivées** (188 étapes) : supprimées côté Labs API →
  `getAdventureById` échoue (`POSSIBLE_ARCHIVED`), lab2gpx les saute
  silencieusement. Coordonnées introuvables par cette voie — structurel.
- **2 UUID en HTTP 500** (`598ca6b4-…`, `fbdafada-…`, 2 étapes, non
  archivées) : réponses amont corrompues ; isolées par bissection.
- **7 étapes dans 3 Adventures remaniées** : nouvelles étapes créées avec
  nouveaux UUID **et** nouveaux titres (ex. « LabMier Part 1 » → « Point 1
  … Point 5 ») — même le rapprochement par titre (règle 3 du plan) ne peut
  pas les sauver. Restent non résolues, légitimement.

Enseignements pour l'import :

- La jointure par **UUID d'étape seul** suffit ; `lab2gpx:uuid` sert de
  contrôle (0 désaccord observé).
- `<sym>Geocache Found</sym>` recoupe l'historique à 100 % — utile comme
  sanity check d'import, jamais comme source de découverte (796 étapes
  non trouvées présentes dans le même fichier).
- Le GPX `<time>` = `PublishedUtc` de l'Adventure : confirmé, à ignorer.
- Taux d'échec structurel ~4 % : le modèle « unresolved » du plan est
  indispensable (archivées, remaniées, 500).

## Échantillons (checklist du plan §3)

Fichiers bruts dans `labs_sources/` (ignoré par git) ; fixtures
anonymisées à dériver dans `tests/fixtures/labs/`.

- [x] Historique complet réel (1117 Adventures, complet + partiels)
- [x] Adventures partiellement trouvées (marqueurs `IsComplete` réels
      croisés : 796 étapes GPX non trouvées présentes)
- [x] Étapes trouvées sur plusieurs jours/années (2015-07 → 2026-09)
- [x] GPX Lab2Gpx « un waypoint par étape » réel (32 lots,
      ~5 552 étapes avec coordonnées)
- [x] Étapes et Adventures archivées (179 Adventures `isArchived`,
      dont 29 confirmées absentes de l'API)
- [x] Endpoint `/logs` identifié et paginé (`GetLogsByAdventureGrouping`,
      payload `{id, skip, take}`, `take` max constaté = 50)

## Verdict

- **Pipeline validé de bout en bout** : export historique JSON (UUID +
  dates) → liste d'UUID → GPX coordonnées via API `uuidsToFetch` →
  jointure UUID exacte à 96 %, 0 faux positif.
- Les 4 % non résolus sont **structurellement** irrécupérables par cette
  voie (archivés/supprimés côté serveur) — ils entrent dans le bac
  « unresolved » prévu par le plan, sans jamais devenir de faux points.
- Aucune date de découverte dans le GPX : `found_date`/`found_at` viennent
  exclusivement de l'export `/logs`.

## Fixtures (Lot 0 — livrables)

`tests/fixtures/labs/` — données 100 % fictives reproduisant les cas
réels (voir README local) :

- `lab-finds-valid.json` + `lab2gpx-stages.gpx` : matrice complète —
  Adventure complète, partielle multi-jours, archivée, remaniée, export
  coordonnées incomplet ; 8 jointures UUID attendues, 4 non résolues.
- `lab-finds-invalid.json` : validation de l'import (date ambiguë,
  IDs manquants/non UUID, champ inconnu, doublon `log_id`).
- `lab2gpx-edgecases.gpx` : wpt sans `gsak:Guid`, `lat=95`, `(0,0)`,
  sans bloc `adventureLab`.
- `lab2gpx-doctype.gpx` : DTD/XXE à rejeter.

**Lot 0 terminé** : schémas confirmés sur données réelles, jointure UUID
validée, limites identifiées, fixtures prêtes pour le Lot 1.

## Addendum — automatisation (2026-10-12)

Le pipeline « fichier GPX manuel » est devenu un appel serveur direct :
`lab_coords_provider.py` encapsule `POST /download` (mêmes lots de 50,
reprises exponentielles, bissection des lots en échec pour isoler les UUID
fautifs, budget d'échecs consécutifs contre une panne 5xx persistante).
La tâche `lab_fetch_coords` (`POST /api/labs/fetch-coordinates`, opt-in
`labs_auto_fetch_coords`) enchaîne automatiquement après chaque import.

Côté historique, le bookmarklet `GET /api/labs/bookmarklet` rejoue la boucle
de `tools/export_lab_logs.js` dans la page `/logs` et POSTe le payload à
`POST /api/labs/receive` (origine `labs.geocaching.com` + jeton local
`labs_receive_token`, CORS + Private-Network-Access ; seule route exemptée
du garde inter-sites de `security.py`). Le GUID joueur est auto-détecté
(session → lien profil → invite, mémorisé en localStorage).


