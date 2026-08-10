# Où les réglages sont enregistrés

GCMap a **deux** endroits de persistance, avec deux moments de sauvegarde
différents. L'interface le dit désormais explicitement ; ce document décrit le
mécanisme sous-jacent.

## Les deux portées

| Portée | Contenu | Stockage | Sauvegarde |
| --- | --- | --- | --- |
| **Globale** | langue, thème, vérification des mises à jour, profil par défaut, centre/zoom par défaut, réglages d'enregistrement vidéo (mode, FPS, bitrate, codec, ralentissement, échelle, destinations, musique) | `%APPDATA%\GCMap\settings.json` (serveur) | automatique, à chaque modification |
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
  disque, l'utilisateur doit pouvoir le constater après coup.
- **Indicateur de profil** (`#current-profile-indicator`) : nom du profil actif,
  suivi d'un « • » tant que des modifications de style ne sont pas enregistrées.

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
  "recording_configured": false
}
```

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
