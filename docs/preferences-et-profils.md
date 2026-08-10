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
  qui émettent un événement par frappe.
- `static/js/theme.js` — le thème est enregistré côté serveur, avec un
  **miroir `localStorage`** (`gcmap_theme`). Le miroir n'existe que pour le
  script anti-FOUC du `<head>` d'`app.html`, qui doit connaître la préférence
  avant le premier octet de CSS, donc avant tout aller-retour réseau.
  `syncThemeFromSettings()` réaligne le miroir sur le serveur au démarrage : sur
  un navigateur neuf, c'est ce qui rend le thème choisi ailleurs.
- `static/js/ui.js` — `recordSettingsPayload()` / `applyRecordSettingsPayload()`
  traduisent entre `pkg.options.record` (camelCase, bitrate en bits/s) et la
  forme de l'API (snake_case, bitrate en Mbps comme dans l'UI).

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

## Tests

- `tests/test_global_preferences.py` — coercition, bornes, patch partiel, reset.
- `tests/e2e/global-preferences.spec.mjs` — persistance serveur du thème et de
  l'enregistrement, reprise du `localStorage`, indicateur inline, badges.

Les tests e2e écrivent leur configuration dans le runtime jetable via
`GCMAP_CONFIG_DIR` (posé par `tests/e2e/run_server.py`). Sans cette variable,
`app_config_dir()` retombe sur `%APPDATA%\GCMap` — c'est-à-dire la configuration
réelle de l'utilisateur.
