# Tests automatisés de génération vidéo

Le socle actuel vérifie les calculs de timing et produit six vidéos synthétiques couvrant les deux pipelines de MyGCFlow. Chaque fichier est ensuite contrôlé avec `ffprobe` : durée, FPS, résolution, codecs, piste audio et taille minimale.

## Lancer la suite

Depuis la racine du projet :

```powershell
.\.venv\Scripts\python.exe run_video_tests.py
```

Pour un contrôle rapide, sans réencoder les vidéos :

```powershell
.\.venv\Scripts\python.exe run_video_tests.py --quick
```

Pour ajouter le parcours navigateur complet :

```powershell
npm install
npx playwright install chromium
.\.venv\Scripts\python.exe run_video_tests.py --e2e
```

Les médias de test sont créés dans des répertoires temporaires et supprimés automatiquement. Les dossiers `video/`, `captured/` et `audio/` du projet ne sont pas modifiés.

## Matrice actuelle

| Scénario | Pipeline | FPS | Audio | Ralentissement | Durée attendue |
|---|---|---:|---|---:|---:|
| `images_24_sans_audio` | Images + ffmpeg | 24 | non | — | 1,0 s |
| `images_30_avec_audio_court` | Images + ffmpeg | 30 | oui, plus court | — | 1,0 s |
| `images_24_avec_audio_long` | Images + ffmpeg | 24 | oui, plus long | — | 1,0 s |
| `images_24_dimensions_impaires` | Images + ffmpeg | 24 | non | — | 1,0 s |
| `mediarecorder_24_sans_audio` | Post-traitement MediaRecorder | 24 | non | ×1 | 1,2 s |
| `mediarecorder_30_normalise_x2_audio_court` | Post-traitement MediaRecorder | 30 | oui, plus court | ×2 normalisé | 1,0 s |
| `mediarecorder_24_dimensions_impaires_audio` | Post-traitement MediaRecorder | 24 | oui, plus court | ×1 | 1,2 s |
| `mediarecorder_24_non_normalise_x2` | Post-traitement MediaRecorder | 24 | non | ×2 conservé | 2,0 s |

La matrice se trouve dans `video_test_scenarios.json`. Pour ajouter un cas, copier un scénario et modifier ses options ainsi que le bloc `expected`.

Les deux scénarios `dimensions_impaires` produisent une source en 161×91 et attendent une sortie en 160×90 : `libx264` en `yuv420p` exige des dimensions paires, et les deux pipelines rognent donc au multiple de 2 inférieur. Les dimensions de la source se règlent par `source_width` / `source_height` (160×90 par défaut).

## Valider manuellement un export MyGCFlow

Le validateur est également utilisable indépendamment des tests :

```powershell
.\.venv\Scripts\python.exe video_validator.py `
  video\mon_export.mp4 `
  --expect video_expectation.example.json
```

Pour obtenir un rapport JSON exploitable par une intégration continue :

```powershell
.\.venv\Scripts\python.exe video_validator.py `
  video\mon_export.mp4 `
  --expect video_expectation.example.json `
  --json
```

Le processus retourne le code `0` si tout correspond, `1` si la vidéo ne respecte pas les attentes et `2` si le fichier ou `ffprobe` est indisponible.

## Exécution sur GitHub

Le workflow `.github/workflows/video-tests.yml` exécute la suite complète à chaque push, pull request et lancement manuel. Il installe uniquement les dépendances listées dans `requirements-test-video.txt`.

## Couverture navigateur

Le fichier `tests/e2e/fixtures/my-finds.gpx` contient six caches déterministes. Playwright lance une instance Flask isolée, sans toucher à la base, au GeoJSON ni aux dossiers média de travail, puis vérifie :

- l’import GPX complet et la timeline de six dates ;
- le filtre de type `Traditional Cache` avec un résultat attendu de `3 / 6` ;
- la propagation des contrôles FPS, codec, bitrate, ralentissement et durée vers les options de capture ;
- un enregistrement MediaRecorder court, post-traité en MP4 par le serveur ;
- la durée, les FPS, le codec, l’absence d’audio et la taille via le même validateur `ffprobe`.

Les traces, captures et vidéos conservées en cas d’échec sont placées dans `output/playwright`. Pour garder aussi le répertoire Flask temporaire après un test local, définir `MYGCFLOW_E2E_KEEP_RUNTIME=1`.

La prochaine extension logique sera la comparaison d’images-clés (date, compteur et position des points) afin de couvrir le contenu visuel, pas seulement la structure et les métadonnées de la vidéo.
