# Traits de déplacement

Option de thème, désactivée par défaut (onglet **Style › Trajet**) : pendant
l'animation, un trait relie les caches trouvées d'un jour à l'autre et montre
le chemin du géocacheur. Mode principal seulement : sur `/evolution`, les caches
sont posées par des centaines de propriétaires et un trajet n'aurait pas de sens
(l'onglet est masqué, le moteur neutralise l'option).

## Principe

Les dates de trouvaille ne disent pas dans quel ordre les caches d'un même jour
ont été visitées, et passer par chacune dessinerait une pelote illisible. Le
trajet relie donc des **étapes** :

1. **Étapes d'une journée** (réglage « Étapes du trajet ») :
   - *Groupes de caches proches* (défaut) : les caches du jour à moins du
     **rayon de regroupement** (2 km par défaut) les unes des autres, de proche
     en proche, forment une étape (grille + union-find, linéaire) ;
   - *Un point par jour* : une seule étape par jour ;
   - *Toutes les caches* : chaque cache est une étape (au-delà de 300 caches
     dans la journée, repli sur les groupes).

   Une étape est toujours une **vraie cache** : la plus proche du barycentre de
   son groupe (médoïde). Le trait ne passe jamais au milieu d'un lac.
2. **Ordre de passage** : plus proche voisin depuis la position précédente (le
   trajet enchaîne naturellement d'un jour à l'autre), puis 2-opt pour défaire
   les croisements des journées de moins de 120 étapes. L'heure des logs
   (`time_find`) n'est pas utilisée : dans les GPX elle est souvent fictive.
3. **Grands sauts** (au-delà d'un seuil, 150 km par défaut) : arc « comme un
   vol » (toujours à gauche du sens de parcours, un aller-retour dessine deux
   arcs distincts), pointillés, trait normal, ou masqué (le géocacheur se
   téléporte).
4. **Forme** : lignes droites, ou courbes lissées (Catmull-Rom centripète, qui
   passent exactement par chaque étape).

Les longitudes sont **dépliées** le long du trajet : le trait franchit la
couture ±180 (antiméridien) au plus court au lieu de traverser la carte
entière. Les regroupements et comparaisons de distances utilisent la même
convention (projection locale dépliée), donc deux caches de part et d'autre
de la couture forment bien une seule étape.

Les trouvailles antérieures à la date de début de l'animation font partie du
trajet : le géocacheur part de sa dernière étape connue, sans que ce passé soit
dessiné.

## Synchronisation : le trait arrive avec les caches

Le dessin avance comme un **stylo** le long de la polyligne. Quand un jour de
trouvailles s'affiche, le stylo repart vers le jour de trouvailles suivant et
part assez tard pour y **arriver au moment où ses caches apparaissent** et
flashent : `arrivée = maintenant + écart en jours × durée d'un jour`, durée du
tracé = `min(durée réglée, écart)`.

- En retard (plusieurs jours affichés dans la même frame en lecture rapide), le
  stylo repart immédiatement de sa position courante : il ne saute jamais.
- En avance (le suivi de caméra fait attendre une date, pause), il attend sur
  place.
- L'horloge est celle de l'apparition des points (`sampleAppearClock`) : temps
  vidéo en capture image par image (enregistrement reproductible à
  l'identique), temps actif hors pauses en MediaRecorder. Le ralentissement
  MediaRecorder s'applique aussi à la durée du tracé.

## Apparence

Couleur, épaisseur, opacité, motif (plein, tirets, points), effet (lueur),
tête (le géocacheur : aucune, point, point pulsant) et persistance :

- **Traînée** de 7, 30 (défaut), 90 jours ou un an : le trait s'estompe avec
  l'âge de ses étapes et disparaît au bout de la fenêtre ;
- **Tout le parcours** : les 30 derniers jours restent vifs, puis le trajet se
  pose à 35 % de l'opacité choisie.

Le trait est dessiné **sous** les points (couche zIndex 1000) pour mener aux
caches sans les masquer ; la tête est **au-dessus** (1050) pour rester visible
quand elle se pose sur une cache ; les flashs restent au premier plan (1100).
Les réglages d'apparence s'appliquent immédiatement, y compris à un trait en
cours ; ceux du tracé (étapes, rayon, sauts, forme) au lancement suivant.

Trois **préréglages** (boutons sous le mini-aperçu de la carte « Apparence »)
ajustent les réglages d'apparence sans toucher au tracé ni à la durée :

- **Discret** : opacité 40 %, épaisseur 2, plein, sans effet ni tête,
  traînée 30 jours — la couleur du thème est conservée ;
- **Voyage** : les valeurs par défaut (opacité 85 %, épaisseur 3, lueur
  désactivée, tête point, traînée 30 jours, grands sauts en arc) ;
- **Parcours complet** : tout le parcours (persistance 0), opacité 60 %,
  épaisseur 2,5, lueur et tête pulsante.

Le **mini-aperçu** (canvas `#trailStylePreview`) redessine un trajet
synthétique — étapes proches plus un grand saut — avec la couleur, l'épaisseur,
le motif, l'effet et la tête choisis, à chaque changement de réglage. Statique
(sans `requestAnimationFrame`) : la tête « pulsante » est figée à mi-période.

## Aperçu du trajet et inspection des étapes

Le bouton **Aperçu du trajet** (onglet Style › Trajet, à côté de
l'interrupteur) affiche le trajet calculé tel quel sur la carte, sans lancer
la lecture : tout le parcours, à pleine opacité (pas de fondu de
persistance), avec le style courant et sans tête animée. Il réutilise la
géométrie **mémoïsée** (`getTrailGeometry`), donc son ouverture ne coûte rien
si les réglages n'ont pas changé — et un changement de tracé ou de style le
recalcule/redessine à la volée (`refreshTrailPreview`).

En aperçu, un **clic près d'une étape** (tolérance ~12 px) ouvre la popup
habituelle avec le rang de l'étape, sa date et le nombre de caches qu'elle
regroupe (`route.stopSize`) — chaque étape sait combien de caches elle
représente (groupe, jour, ou 1 en mode « Toutes les caches »). Un clic sur
une vraie cache garde la priorité (popup de la cache) ; un clic ailleurs
referme la popup comme avant.

L'aperçu se referme de lui-même quand le tracé n'est plus valable ou utile :
nouvelles données ou filtre modifié (`addVector`), option désactivée, lancement
de la lecture ou de l'enregistrement (`resetTravelTrail` — l'animation prend le
relais). En revanche il **survit à l'arrêt** de la lecture : après un stop,
l'utilisateur revoit sa route. Le bouton reflète l'état réel (`aria-pressed`)
et est désactivé quand l'aperçu ne pourrait pas s'ouvrir (trajet désactivé,
pas de données, animation ou enregistrement en cours).

## Réglages et portée

| Réglage | Portée | Stockage |
| --- | --- | --- |
| Activation, étapes, rayon, forme, grands sauts, couleur, épaisseur, opacité, motif, effet, tête, persistance | Thème | section `trail` du profil (`TrailOptions`) |
| Durée max. du tracé d'une étape (800 ms par défaut, onglet Animation) | Globale | `animation.trail_duration_ms` de `settings.json` |

Même partage que pour le flash : l'aspect appartient au thème, le temps aux
préférences d'animation. Le rayon de regroupement sert aussi de **repli** en
mode « Toutes les caches » : au-delà de 300 caches dans une journée, celle-ci
est regroupée comme en mode « Groupes » (et les journées repliées sont
signalées). Les valeurs par défaut sont définies trois fois (`TRAIL_DEFAULTS`
de `static/js/travel_trail.mjs`, bloc `trail` de
`static/json/defaultValues.json`, dataclasses Python) ; des tests en verrouillent
l'égalité.

## Précalcul et coût

Le trajet est **précalculé automatiquement** au lancement de la lecture ou de
l'enregistrement, sans bouton : il le faut pour connaître le prochain jour de
trouvailles (arrivée synchronisée) et le point suivant (courbes). Il est
mémoïsé (clé : révision de l'index des jours + réglages de tracé) : relancer
sans rien changer ne recalcule rien.

Le dessin se fait par tracé (un par palier d'opacité, 8 paliers, et par type de
segment), directement sur le canvas (aucune géométrie OpenLayers créée par
frame), limité à la fenêtre de persistance, avec une décimation des sommets à
moins de 1,5 px les uns des autres.

Côté précalcul : les ancres des groupes d'une journée partagent une **projection
locale unique** (kilomètres équirectangulaires, longitudes dépliées autour du
premier point du jour), au lieu d'une allocation par groupe ; et
l'ordonnancement des étapes compare des distances locales — ~50× moins cher
qu'un haversine par paire pour le plus proche voisin, qui est quadratique. Le
2-opt, borné aux petites journées, garde l'haversine pour l'exactitude des
sauts.

Mesures du 30/09/2026 (Chromium headless des tests e2e, rendu **logiciel**
SwiftShader, vue France entière, lecture à 300 jours/s) sur 28 000 caches
synthétiques en 8 ans, regroupées en ~10 700 étapes :

| Cas | Précalcul | JS de dessin par frame (moy. / p95) | Frame moyenne |
| --- | --- | --- | --- |
| Sans trait | — | — | 22,5 ms |
| Traînée 30 j, droit | 41 ms | 0,1 / 0,2 ms | 24,0 ms |
| Traînée 30 j, lissé + lueur | 44 ms | 0,13 / 0,2 ms | 24,8 ms |
| Tout le parcours, droit | 36 ms | 0,6 / 1,3 ms | 38,3 ms |
| Tout le parcours, lissé + lueur | 41 ms | 0,9 / 1,9 ms | 49,1 ms |

En Node, 48 500 caches (38 400 étapes) : trajet ~80 ms, géométrie lissée
(252 000 sommets) ~40 ms. Journées extrêmes (tests Node) : 2 000 caches dans
~1 km regroupées en 1 étape en ~14 ms ; 2 000 caches isolées ordonnées en
~10 ms (~60 ms avant que le plus proche voisin ne passe en distances locales).

Lecture : la traînée ne coûte presque rien. « Tout le parcours » sur des
dizaines de milliers d'étapes alourdit nettement chaque frame alors que le code
de dessin lui-même ne prend qu'environ 1 ms : le coût est la **rastérisation**
du canvas (dizaines de milliers de segments). Ces chiffres viennent d'un rendu
logiciel ; ils n'ont pas été mesurés avec une carte graphique. Pour une grosse
collection en « Tout le parcours », le mode d'enregistrement Images (déterministe,
insensible à la cadence) est le plus sûr ; en MediaRecorder, des images peuvent
être sautées. Piste si besoin : mettre en cache dans un canvas hors écran la
partie du trajet qui ne change plus (à invalider à chaque mouvement de vue).

## Code

- `static/js/travel_trail.mjs` : logique pure (regroupement, ordre, géométrie,
  stylo, opacité), sans DOM ni OpenLayers.
- `static/js/mapgl.js`, section « TRAITS DE DÉPLACEMENT » : couches, calcul
  mémoïsé (`getTrailGeometry`), planification (`scheduleTravelTrail`), dessin
  (`drawTravelTrail`, `drawTravelTrailHead`), aperçu statique
  (`toggleTrailPreview`, `refreshTrailPreview`, `isTrailPreviewActive`),
  inspection au clic (`inspectTrailStopAt`), diagnostic
  (`getTravelTrailDebugState` — dont `preview`).
- Interface : `templates/menu_trail.html`, `initTrailControls` /
  `syncTrailOptionsUI` / `drawTrailStylePreview` / `applyTrailPreset` dans
  `static/js/ui.js`, `applyTrailState` dans `static/js/profiles.js`.

Note : `trailGeometry` et `trailPreview` sont déclarés avec `var` dans
`mapgl.js` — `initUIElements` (ui.js) s'exécute pendant l'évaluation des
modules, avant la fin de celle de mapgl (import circulaire via `index.js`) ;
un `let` serait encore en zone morte quand `syncTrailOptionsUI` appelle
`pkg.isTrailGeometryStale`/`pkg.isTrailPreviewActive`.

## Tests

- Node : `node --test test_travel_trail.mjs` (dont `stopSize` : taille de
  chaque étape en modes jour/groupes/toutes les caches, points invalides).
- Python : `tests/test_trail_profile.py`.
- Les deux tournent dans `run_video_tests.py` (étapes « Calculs du trajet
  JavaScript » et « Réglages du trajet côté serveur »), donc en CI via le
  workflow `video-tests.yml`.
- Playwright : `tests/e2e/travel-trail.spec.mjs` (lecture, arrêt, préférence
  globale, enregistrement images et MediaRecorder, aperçu + inspection au
  clic, préréglages, absence en mode Évolution).
