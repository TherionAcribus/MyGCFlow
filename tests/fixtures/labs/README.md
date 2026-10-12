# Fixtures Adventure Lab (fictives)

Données 100 % fictives (UUID `fa1e0000-…` / `57a9e000-…`, titres et
coordonnées inventés). Calquées sur les formats réels documentés dans
`docs/notes/lab-caches-sources.md` — historique `/logs` + GPX Lab2Gpx.

## `lab-finds-valid.json` — export historique (`mygcflow-lab-finds` v1)

12 découvertes, 5 Adventures :

| Adventure | Scénario |
|---|---|
| `…0001` Circuit des Moulins | 5/5 étapes, même jour, offset `-07:00` |
| `…0002` Sentier du Vieux Pont | 3/5 étapes sur 2 jours (`…0202`, `…0205` absentes) — **partielle multi-jours** |
| `…0003` Labyrinthe du Port | 2 étapes, `adventure_is_archived: true` — **absente du GPX** (comme en réel) |
| `…0004` Promenade des Remparts | 1 étape `…0401` — Adventure **remaniée** dans le GPX (nouveaux UUID/titres) |
| `…0005` Les Deux Tours | 1 étape, offset `-08:00` (heure d'hiver) — **absente du GPX** (modélise l'échec de fetch réel : HTTP 500 / export coordonnées incomplet) |

Champs `latitude`/`longitude`/`adventure_url` à `null` — conformes à la
réalité (l'historique ne porte ni coords ni URL).

## `lab2gpx-stages.gpx` — fichier coordonnées

Structure Lab2Gpx « un waypoint par étape » réduite (sans descriptions).

- `…0001` : 5 wpt `Geocache Found`, UUID identiques à l'historique → **jointure complète**
- `…0002` : 5 wpt, 3 Found (`…0201/0203/0204`) + 2 non trouvés
  (`…0202`, `…0205`) → les non trouvés **ne deviennent jamais des points**
- `…0004` : 2 wpt UUID `…0491/…0492` + titres « Point N » → l'étape
  `…0401` de l'historique **reste non résolue** (Adventure remaniée)
- `…0006` Jardin Suspendu : 2 wpt hors historique → ignorés
- `…0003` absente (Adventure archivée) → les 2 découvertes historique
  restent non résolues

Croisement attendu : **8 jointures** (`…0101-0105`, `…0201`, `…0203`,
`…0204`), 4 non résolues (`…0301`, `…0302`, `…0401`, `…0501`), 0 faux
positif — les 4 modèles des cas réels : Adventure archivée (2),
Adventure remaniée (1), export coordonnées incomplet (1).

## `lab-finds-invalid.json` — validation de l'import historique

7 enregistrements (commentaire `_comment` sur chacun) :

- date ambiguë `14/05/2024` → rejet, jamais devinée
- `stage_id` null / non UUID → rejet
- `found_date` + `found_at` nulls → non résolu, aucune substitution
- `found_date` absente + `found_at` ISO → date dérivable
- champ inconnu → toléré
- `log_id` dupliqué → dédoublonné

## `lab2gpx-edgecases.gpx` — validation du GPX

- wpt sans `gsak:Guid` → injoignable
- `lat=95` hors bornes → rejet
- `lat=0 lon=0` → sentinelle signalée, pas rejet aveugle
- wpt sans bloc `lab2gpx:adventureLab` → pas d'UUID d'Adventure de contrôle

## `lab2gpx-doctype.gpx` — sécurité XML

DOCTYPE + entité externe : l'importeur doit **rejeter** le fichier (XXE).
