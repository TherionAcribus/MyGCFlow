# Où les réglages sont enregistrés

MyGCFlow a **deux** endroits de persistance, avec deux moments de sauvegarde
différents. L'interface le dit désormais explicitement ; ce document décrit le
mécanisme sous-jacent.

## Les quatre responsabilités

| Responsabilité | Contenu | Stockage | Sauvegarde |
| --- | --- | --- | --- |
| **Thème** | fond de carte et ses options ; forme, taille, couleurs des points ; icônes et halos ; forme, taille, durée, couleur des flashs ; traits de déplacement (tracé, couleur, épaisseur, motif, effet, tête, persistance) ; effets visuels ; présentation des textes et infos | `%APPDATA%\MyGCFlow\profiles\<nom>.json` (serveur) | manuelle, bouton **Sauvegarder** de la section Thèmes |
| **Animation** | mode de rythme (jours/s, durée finale, musique), jours par seconde, durée finale demandée, temps additionnel de fin, suivi de caméra, durée du tracé des traits de déplacement — et `flash_duration_ms`, simple miroir persisté de la durée de thème servant de repli au démarrage | clé `animation` de `%APPDATA%\MyGCFlow\settings.json` | automatique, à chaque modification |
| **Enregistrement** | mode de capture, FPS, bitrate, codec, ralentissement, échelle, résolution, destinations, musique (volume, inclusion) | clé `recording` de `settings.json` | automatique, à chaque modification |
| **Session** | centre et zoom courants de la carte, plage de dates de l'animation | mémoire uniquement (vue courante) ; le cadrage par défaut reste une préférence globale : `map_framing` (« fit » = emprise des données au chargement, « custom » = `map_default_center`/`map_default_zoom`) | non persistée |

Un réglage global (Animation, Enregistrement, préférences) suit l'utilisateur
quel que soit le thème chargé. Un réglage de thème est appliqué immédiatement
à la carte mais n'existe sur disque qu'après un clic sur **Sauvegarder**.

**Règle d'isolation** : appliquer un thème ne modifie jamais le timing, les
dates, le calage musique, le suivi de caméra, les réglages d'enregistrement ni
la vue courante. Les anciens fichiers de profil qui embarquent un bloc
`animation` ou un centre/zoom (`map.default_center`/`default_zoom`) restent
**lisibles** : ces clés sont simplement ignorées par `coerce_profile()` et ne
sont plus écrites par `_profile_to_dict()` ni par `_buildProfilePayload()`
côté client. Elles ne sont **pas** migrées vers les préférences globales :
deux anciens thèmes pouvaient contenir des vitesses différentes, un choix
automatique serait arbitraire. La durée du flash (`flash.duration`) fait
exception depuis qu'elle est redevenue un réglage de thème : lue et appliquée
comme la forme, avec repli sur la valeur courante quand la clé est absente.

## Les deux portées de stockage

| Portée | Contenu | Stockage | Sauvegarde |
| --- | --- | --- | --- |
| **Globale** | langue, thème de l'app, vérification des mises à jour, thème par défaut, dernier thème actif, cadrage de la carte (`map_framing`) et centre/zoom par défaut, réglages d'enregistrement vidéo (mode, FPS, bitrate, codec, ralentissement, échelle, destinations, musique), réglages d'animation (rythme, durées, suivi de caméra, durée du tracé des traits — `flash_duration_ms` n'y est qu'un miroir de repli de la durée de thème), et pour le mode Évolution son propre rythme (`evolution_animation`) et la dernière base ouverte (`evolution_dataset_id`) | `%APPDATA%\MyGCFlow\settings.json` (serveur) | automatique, à chaque modification |
| **Thème** | fond de carte et ses options, style des points, flash (forme/taille/durée/couleur), flash de disparition du mode Évolution (`flash.disappear`), traits de déplacement (`trail`, voir [traits-de-deplacement.md](traits-de-deplacement.md)), titre et bloc d'infos (+ CSS) | `%APPDATA%\MyGCFlow\profiles\<nom>.json` (serveur) | manuelle, bouton **Sauvegarder** de la section Thèmes |

## Le plan de timing partagé

`static/js/video_timing.mjs` est la **source de vérité unique** pour tout ce
qui touche au temps : le comptage des jours (inclusif, normalisé UTC — correct
autour des changements d'heure), la validation des saisies, le formatage des
durées et le plan complet (`buildTimingPlan`) qui décompose la durée finale en
animation principale + pause automatique de fin + temps additionnel. L'onglet
Animation (synthèse lisible `refreshTimingPlan` dans `ui.js`), la
prévisualisation, le pipeline MediaRecorder (`computeTotalAnimationMs` +
`mrTailMs` dans `mapgl.js`) et le mode Images (`buildImageTimingPlan` via
`updateInfosForPictures` dans `utils.js`) dérivent tous leurs durées de ce
module : la durée affichée est celle qui est produite, à une frame près.

Trois modes de rythme **exclusifs** (`options.animation.rhythmMode`) : `rate`
(jours par seconde), `duration` (durée finale mm:ss), `music` (calé sur le
fichier audio). Un seul champ est éditable à la fois ; les autres affichent le
résultat calculé en lecture seule.

## Ce que l'interface montre

- **Badge de portée** (`templates/_scope_badges.html`) à côté de chaque titre de
  section : pastille violette « Thème », pastille bleue « Global », avec une
  infobulle qui rappelle la règle de sauvegarde. Une pastille orange
  « Expérimental » (même base de style) marque les fonctionnalités en cours de
  validation. Les styles vivent dans
  `static/css/ui_improvements.css` (`.gc-scope-badge`) et leurs variantes sombres
  dans `static/css/tabler_theme.css`. Une dérogation unique : la **durée max.
  du tracé** (`inputTimeTrail`) est une préférence globale placée dans
  Style > Trajet — elle se règle à côté de l'aperçu du trajet et garde son
  badge « Global » pour rappeler qu'elle n'est pas enregistrée avec le thème.
- **Indicateur inline « Enregistré ✓ »** (`static/js/saved_indicator.mjs`) posé
  dans le `<label>` du champ modifié, pour les réglages globaux uniquement. Il
  remplace les toasts qui ne couvraient qu'une partie des champs (le centre de
  carte en avait un, la langue et le thème rien du tout). En cas d'échec, il
  affiche « Non enregistré » et **reste affiché** : la valeur n'est pas sur le
  disque, l'utilisateur doit pouvoir le constater après coup. Un échec ne doit
  pas non plus mettre à jour le suivi « déjà enregistré » d'un champ : sinon
  ressaisir la même valeur passerait pour un non-changement et ne repartirait
  jamais vers le serveur (cf. `lastSavedCenterKey` dans `ui.js`).
- **Indicateur de thème** (`#current-profile-indicator`) : masqué tant que le
  thème actif est enregistré (le sélecteur affiche déjà son nom) ; affiche
  « Modifications non enregistrées » (`aria-live="polite"`) dès que des
  réglages diffèrent de la version enregistrée. Le « • » compact reste accolé
  au nom du thème actif dans les options du sélecteur `#profile-select`.
  Le suivi (`_bindDirtyTracking()`) écoute `input`, `change` **et `click`** sur
  le conteneur `#style`, puis compare l'état lu dans `pkg.options` à la dernière
  référence enregistrée. `click` est indispensable : plusieurs réglages de thème
  ne passent par aucun champ de formulaire mais par un bouton — choix du fond de
  carte (`.changeMap`), variante Toner clair/sombre, « Appliquer » du style
  Titre/Infos. Ils n'émettent ni `input` ni `change` : leurs modifications
  partaient bien dans le thème enregistré, mais n'étaient jamais signalées comme
  en attente. Les clics de la barre et du tiroir Thèmes (`#profile-bar`,
  `#profiles-manager`) sont ignorés : ils ne touchent aucun réglage de style. Comme le suivi **compare** au lieu de
  poser un drapeau, un clic sans effet (un onglet, un bouton d'action) ne rend
  pas le thème « modifié », et revenir à la valeur enregistrée éteint le « • ».
  Le rappel lui-même est discret (texte gris, pastille verte) et ne passe en
  orange que dans l'état « modifications en attente », le seul qui mérite
  d'attirer l'œil.
- **Thème actif dans la liste** (`_setProfileItemActive()`) : liseré d'accent
  sur la ligne (`.active-profile-item`) et nom en accent (`.active-profile`).
  Volontairement sobre : l'encadré, le badge « ACTIF » et la coche cumulaient
  trois marquages pour une seule information. Le texte du badge ayant disparu,
  l'état est exposé aux lecteurs d'écran par `aria-current` sur la ligne. À ne
  pas confondre avec l'**étoile** (`.profile-default-star`), qui marque le
  thème *par défaut* : les deux états sont indépendants et rafraîchis
  séparément (cf. `profile-style-state.spec.mjs`).

## Cycle de vie d'un thème

**Création.** « Nouveau » (et « Sauvegarder » quand aucun thème n'est
actif, qui ouvre la même modale sous l'intitulé « Enregistrer dans un nouveau
thème ») enregistre **les réglages affichés**. Deux requêtes :
`POST /api/profiles` écrit un thème aux valeurs par défaut et renvoie son
`uid`, puis `PUT /api/profiles/<nom>` y dépose l'état courant — le même corps
que le bouton « Sauvegarder », construit par `_buildProfilePayload()`. Sans ce
second appel, le thème créé restait vide alors que l'écran continuait
d'afficher les réglages de l'utilisateur, présentés comme enregistrés : le
travail était perdu au rechargement suivant, sans message. Si le `PUT` échoue,
le thème existe mais est vide, et le toast le dit.

**Enregistrer sous…** Le menu du bouton « Sauvegarder » permet d'écrire les
réglages affichés dans un **autre** thème que l'actif : destination existante
(`PUT`, précédée d'une confirmation d'écrasement), ou nom libre — le nom est
alors créé par `createProfile()` comme « Nouveau », avec les réglages
affichés. Choisir le thème actif retombe sur la sauvegarde ordinaire, sans
confirmation. Convention « Save As » : la destination devient le thème actif,
la source conserve ses réglages enregistrés, et la marque « modifications en
attente » s'éteint. Choisir « Annuler » à la confirmation rouvre la modale
avec le choix intact, rien n'est écrit.

**Restauration au démarrage.** `restoreStartupProfile()` (appelée par `init.js`
après `init_ui()`) charge le **dernier thème actif** — `last_profile_uid` dans
`settings.json` — et n'utilise `default_profile_uid` qu'en repli : première
ouverture, ou dernier thème devenu illisible. L'interrupteur « Toujours
démarrer sur ce thème » de l'onglet Paramètres (`startup_default_profile`,
`handleStartupDefaultToggle()`) inverse la priorité : `default_profile_uid`
passe alors d'abord. Coché sans thème choisi, le thème actif devient le choix ;
le choix n'est jamais réécrit ni effacé en basculant l'interrupteur. Le repli
qui aboutit est aussitôt mémorisé comme dernier thème actif, sinon chaque
démarrage repasserait par la même lecture ratée. Si aucun candidat n'est
lisible, l'application démarre **sans thème actif** et le dit : pas de repli
sur un thème « Default » ni sur un pseudo-thème temporaire, que l'utilisateur
ne pourrait ni retrouver dans la liste ni enregistrer.

**Première ouverture.** Au tout premier lancement, `SettingsManager` installe
les thèmes d'exemple et fait du thème « Default » (`FIRST_LAUNCH_PROFILE`) le
thème par défaut. C'est donc lui que la restauration charge : l'utilisateur
démarre sur un vrai thème de la liste, et ses premiers réglages sont suivis
(« • », avertissement avant fermeture). Les installations existantes ne
sont pas concernées.

**Validation.** Lecture d'un fichier, import et sauvegarde (`PUT`, patch
partiel fusionné avec le thème enregistré) passent tous par `coerce_profile()`.
Fonds, formes, modes et types de couleur y sont restreints aux listes de
l'interface (`TILE_PROVIDERS`, `FLASH_MODES`…), les couleurs au format
`#rgb`/`#rrggbb`, les tailles aux bornes des curseurs. Une valeur refusée garde
la valeur enregistrée (à défaut, celle de `MapProfile`). Ajouter une option à
l'onglet Style suppose donc de l'ajouter aussi à ces listes, sans quoi elle
serait écartée à la sauvegarde.

`last_profile_uid` est écrit par `_rememberActiveProfile()` à chaque changement
de thème actif décidé par l'utilisateur (chargement depuis la liste ou le
sélecteur, création, « définir comme par défaut ») — jamais pendant la
restauration elle-même, qui recharge précisément la valeur mémorisée. Son
échec n'est pas signalé à l'utilisateur : il ne perd que la restauration
automatique, pas son thème.

Auparavant seul `default_profile_uid` décidait du démarrage : un thème créé ou
sélectionné puis enregistré revenait au lancement suivant sous les réglages d'un
autre thème, tant que l'utilisateur n'avait pas pensé à « Définir comme par
défaut ». L'étoile garde son sens — c'est le thème des débuts —, elle ne décide
plus de chaque démarrage.

## Côté client

- `static/js/settings_api.mjs` — `saveSettingsPatch(patch)` écrit un patch
  partiel via `PUT /api/settings`. Le serveur conserve tout champ absent du
  corps de la requête, donc **aucun `GET` préalable n'est nécessaire**.
  `makeDebouncedSettingsSaver()` regroupe les écritures des champs numériques,
  qui émettent un événement par frappe. Les requêtes sont **mises en file** :
  une seule est en vol à la fois, dans l'ordre des appels. Deux `fetch` lancés
  ensemble peuvent arriver au serveur dans le désordre, et deux enregistrements
  rapprochés du même champ (blur puis Entrée sur le centre de carte) laisseraient
  alors l'ancienne valeur en dernier.
- `static/js/theme.js` — le thème est enregistré côté serveur, avec un
  **miroir `localStorage`** (`mygcflow_theme`). Le miroir n'existe que pour le
  script anti-FOUC du `<head>` d'`app.html`, qui doit connaître la préférence
  avant le premier octet de CSS, donc avant tout aller-retour réseau.
  `syncThemeFromSettings()` réaligne le miroir sur le serveur au démarrage : sur
  un navigateur neuf, c'est ce qui rend le thème choisi ailleurs.
- `static/js/ui.js` — `reloadWithLanguage()` : la langue est appliquée par les
  templates rendus côté serveur, donc son changement impose un rechargement.
  L'URL cible (paramètre `?lang` retiré, fragment de l'onglet courant ajouté)
  est posée par `history.replaceState()`, **puis** `location.reload()` recharge.
  Un `location.replace()` ne conviendrait pas : quand seul le fragment change —
  le cas courant — le navigateur se contente d'une navigation de fragment et la
  page reste dans l'ancienne langue.
- `static/js/ui.js` — `recordSettingsPayload()` / `applyRecordSettingsPayload()`
  traduisent entre `pkg.options.record` (camelCase, bitrate en bits/s) et la
  forme de l'API (snake_case, bitrate en Mbps comme dans l'UI).
- `static/js/ui.js` — `animationSettingsPayload()` /
  `applyAnimationSettingsPayload()` font de même pour la clé `animation`
  (préférences globales de rythme). `refreshTimingPlan()` recalcule le plan à
  chaque saisie, écrit `options.animation.timePerDay` (valeur canonique lue par
  le moteur) et `options.record.totalTimeInMilliSec`, puis enregistre le tout
  débouncé via `saveAnimationSettings()`.
- `saveRecordSettings(field)` est **exportée** : `recording_perf.js` l'appelle
  quand l'utilisateur accepte le ralentissement suggéré depuis un toast. Son
  argument nomme le champ à confirmer visuellement — indispensable hors d'une
  saisie, où le « dernier champ manipulé » désignerait un champ sans rapport.
  Corollaire : `changeRecordValues` ne doit jamais être passée nue à
  `addEventListener`, l'objet `Event` atterrirait dans ce paramètre.

## Reprise des anciens réglages vidéo

Les réglages d'enregistrement vivaient dans la seule clé `localStorage`
`recordSettings`. `migrateLegacyRecordSettings()` (dans `static/js/ui.js`) les
pousse une fois vers le serveur, puis supprime la clé locale.

La reprise n'a lieu que si `recording_configured` est `false` côté serveur.
Ce drapeau est nécessaire parce que `recording` renvoie toujours un bloc
complet : sans lui, « jamais configuré » serait indiscernable de « configuré
avec les valeurs par défaut », et un `localStorage` périmé d'un autre navigateur
pourrait écraser un réglage plus récent.

## API

`GET /api/settings` renvoie, en plus des champs existants :

```json
{
  "theme": "system",
  "recording": {
    "mode": "mediarecorder",
    "fps": 30,
    "mime_type": "video/webm;codecs=vp9",
    "bitrate_mbps": 6,
    "slowdown_factor": 1,
    "scale_factor": 1.0,
    "upload_to_server": true,
    "download_local": true,
    "offline_normalization": true,
    "audio_enabled": false,
    "audio_volume": 1.0
  },
  "recording_configured": false,
  "animation": {
    "rhythm_mode": "rate",
    "days_per_second": 20.0,
    "total_duration_seconds": 60.0,
    "extra_end_seconds": 0.0,
    "camera_follow": false,
    "flash_duration_ms": 1000
  },
  "default_profile_uid": null,
  "default_profile_name": null,
  "last_profile_uid": null,
  "last_profile_name": null
}
```

Les deux `*_name` sont résolus à la lecture depuis l'`uid` : le nom d'un thème
peut changer (renommage), l'`uid` non. Une référence dont l'`uid` ne correspond
plus à aucun thème est effacée par `get_app_settings()`, pour éviter un 404
récurrent à chaque démarrage.

`PUT /api/settings` accepte ces clés en patch partiel ; `recording` et
`animation` sont fusionnés avec la valeur enregistrée, donc
`{"recording": {"fps": 24}}` ne touche pas au bitrate et
`{"animation": {"extra_end_seconds": 4}}` ne touche pas au rythme. Les valeurs
sont bornées côté serveur (`coerce_recording_settings`,
`coerce_animation_settings`) : `settings.json` est éditable à la main et ne doit
pas pouvoir produire un enregistrement ou une animation impossible.

Un patch partiel relit forcément les champs absents de la requête. Cette lecture
et l'écriture qui suit passent par `SettingsManager.update_app_settings()`, qui
les exécute d'un seul tenant sous verrou : le serveur de développement Flask est
multithread, et deux requêtes qui liraient le même état de départ perdraient
chacune la modification de l'autre. **Toute écriture des préférences globales
doit passer par `update_app_settings()`**, jamais par `get_app_settings()` suivi
de `save_app_settings()`.

## Tests

- `tests/test_global_preferences.py` — coercition, bornes, patch partiel, reset,
  et deux PUT concurrents qui doivent tous deux survivre.
- `test_settings_api.mjs` (`node --test`) — file d'attente des écritures :
  une requête en vol à la fois, dans l'ordre des appels, et un échec qui ne
  bloque pas la suite.
- `tests/e2e/global-preferences.spec.mjs` — persistance serveur du thème et de
  l'enregistrement, reprise du `localStorage`, indicateur inline, badges.

Les tests e2e écrivent leur configuration dans le runtime jetable via
`MYGCFLOW_CONFIG_DIR` (posé par `tests/e2e/run_server.py`). Sans cette variable,
`app_config_dir()` retombe sur `%APPDATA%\MyGCFlow` — c'est-à-dire la configuration
réelle de l'utilisateur.
