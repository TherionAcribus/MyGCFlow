# Où les réglages sont enregistrés

GCMap a **deux** endroits de persistance, avec deux moments de sauvegarde
différents. L'interface le dit désormais explicitement ; ce document décrit le
mécanisme sous-jacent.

## Les deux portées

| Portée | Contenu | Stockage | Sauvegarde |
| --- | --- | --- | --- |
| **Globale** | langue, thème, vérification des mises à jour, profil par défaut, dernier profil actif, centre/zoom par défaut, réglages d'enregistrement vidéo (mode, FPS, bitrate, codec, ralentissement, échelle, destinations, musique) | `%APPDATA%\GCMap\settings.json` (serveur) | automatique, à chaque modification |
| **Profil** | fond de carte et ses options, style des points, flash, titre et bloc d'infos (+ CSS) | `%APPDATA%\GCMap\profiles\<nom>.json` (serveur) | manuelle, bouton **Sauvegarder** de la section Profils |

Un réglage global suit l'utilisateur quel que soit le profil chargé. Un réglage
de profil est appliqué immédiatement à la carte mais n'existe sur disque
qu'après un clic sur **Sauvegarder**.

## Ce que l'interface montre

- **Badge de portée** (`templates/_scope_badges.html`) à côté de chaque titre de
  section : pastille violette « Profil », pastille bleue « Global », avec une
  infobulle qui rappelle la règle de sauvegarde. Les styles vivent dans
  `static/css/ui_improvements.css` (`.gc-scope-badge`) et leurs variantes sombres
  dans `static/css/tabler_theme.css`.
- **Indicateur inline « Enregistré ✓ »** (`static/js/saved_indicator.mjs`) posé
  dans le `<label>` du champ modifié, pour les réglages globaux uniquement. Il
  remplace les toasts qui ne couvraient qu'une partie des champs (le centre de
  carte en avait un, la langue et le thème rien du tout). En cas d'échec, il
  affiche « Non enregistré » et **reste affiché** : la valeur n'est pas sur le
  disque, l'utilisateur doit pouvoir le constater après coup. Un échec ne doit
  pas non plus mettre à jour le suivi « déjà enregistré » d'un champ : sinon
  ressaisir la même valeur passerait pour un non-changement et ne repartirait
  jamais vers le serveur (cf. `lastSavedCenterKey` dans `ui.js`).
- **Indicateur de profil** (`#current-profile-indicator`) : nom du profil actif,
  suivi d'un « • » tant que des modifications de style ne sont pas enregistrées.
  Le suivi (`_bindDirtyTracking()`) écoute `input`, `change` **et `click`** sur
  le conteneur `#style`, puis compare l'état lu dans `pkg.options` à la dernière
  référence enregistrée. `click` est indispensable : plusieurs réglages de profil
  ne passent par aucun champ de formulaire mais par un bouton — choix du fond de
  carte (`.changeMap`), variante Toner clair/sombre, « Appliquer » du style
  Titre/Infos. Ils n'émettent ni `input` ni `change` : leurs modifications
  partaient bien dans le profil enregistré, mais n'étaient jamais signalées comme
  en attente. Les clics du panneau Profils (`#profiles-section`) sont ignorés :
  ils ne touchent aucun réglage de style. Comme le suivi **compare** au lieu de
  poser un drapeau, un clic sans effet (un onglet, un bouton d'action) ne rend
  pas le profil « modifié », et revenir à la valeur enregistrée éteint le « • ».

## Cycle de vie d'un profil

**Création.** « Nouveau profil » (et « Sauvegarder » quand aucun profil n'est
actif, qui ouvre la même modale sous l'intitulé « Enregistrer dans un nouveau
profil ») enregistre **les réglages affichés**. Deux requêtes :
`POST /api/profiles` écrit un profil aux valeurs par défaut et renvoie son
`uid`, puis `PUT /api/profiles/<nom>` y dépose l'état courant — le même corps
que le bouton « Sauvegarder », construit par `_buildProfilePayload()`. Sans ce
second appel, le profil créé restait vide alors que l'écran continuait
d'afficher les réglages de l'utilisateur, présentés comme enregistrés : le
travail était perdu au rechargement suivant, sans message. Si le `PUT` échoue,
le profil existe mais est vide, et le toast le dit.

**Restauration au démarrage.** `restoreStartupProfile()` (appelée par `init.js`
après `init_ui()`) charge le **dernier profil actif** — `last_profile_uid` dans
`settings.json` — et n'utilise `default_profile_uid` qu'en repli : première
ouverture, ou dernier profil devenu illisible. Le repli qui aboutit est
aussitôt mémorisé comme dernier profil actif, sinon chaque démarrage repasserait
par la même lecture ratée. Si aucun candidat n'est lisible, l'application
démarre **sans profil actif** et le dit : pas de repli sur un profil « Default »
ni sur un pseudo-profil temporaire, que l'utilisateur ne pourrait ni retrouver
dans la liste ni enregistrer.

`last_profile_uid` est écrit par `_rememberActiveProfile()` à chaque changement
de profil actif décidé par l'utilisateur (chargement depuis la liste ou le
sélecteur, création, « définir comme par défaut ») — jamais pendant la
restauration elle-même, qui recharge précisément la valeur mémorisée. Son
échec n'est pas signalé à l'utilisateur : il ne perd que la restauration
automatique, pas son profil.

Auparavant seul `default_profile_uid` décidait du démarrage : un profil créé ou
sélectionné puis enregistré revenait au lancement suivant sous les réglages d'un
autre profil, tant que l'utilisateur n'avait pas pensé à « Définir comme par
défaut ». L'étoile garde son sens — c'est le profil des débuts —, elle ne décide
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
  **miroir `localStorage`** (`gcmap_theme`). Le miroir n'existe que pour le
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
  "default_profile_uid": null,
  "default_profile_name": null,
  "last_profile_uid": null,
  "last_profile_name": null
}
```

Les deux `*_name` sont résolus à la lecture depuis l'`uid` : le nom d'un profil
peut changer (renommage), l'`uid` non. Une référence dont l'`uid` ne correspond
plus à aucun profil est effacée par `get_app_settings()`, pour éviter un 404
récurrent à chaque démarrage.

`PUT /api/settings` accepte ces deux clés en patch partiel ; `recording` est
fusionné avec la valeur enregistrée, donc `{"recording": {"fps": 24}}` ne touche
pas au bitrate. Les valeurs sont bornées côté serveur
(`coerce_recording_settings`) : `settings.json` est éditable à la main et ne doit
pas pouvoir produire un enregistrement impossible.

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
`GCMAP_CONFIG_DIR` (posé par `tests/e2e/run_server.py`). Sans cette variable,
`app_config_dir()` retombe sur `%APPDATA%\GCMap` — c'est-à-dire la configuration
réelle de l'utilisateur.
