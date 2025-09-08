### ToDo – Enregistrement vidéo (capture → assemblage → nettoyage)

Objectif: fiabiliser et automatiser l’enregistrement depuis le bouton « Enregistrer » (capture des frames → création du film → nettoyage), puis évaluer une approche plus performante (MediaRecorder).

#### Étape 0 — Pré-requis et contexte
- [x] Vérifier l’environnement Python virtualenv actif (`virtual/`) et l’accès en écriture aux répertoires `captured/` et `video/`.
- [x] Confirmer que `moviepy` est installé et que `ffmpeg` est disponible (MoviePy en a besoin). Si nécessaire, installer ffmpeg et l’ajouter au PATH sous Windows.

#### Étape 1 — Corriger les 404 des actions « Nettoyer images » et « Assembler film » ✅ TERMINÉ
- [x] Réactiver dans `app.py` les routes backend:
  - [x] `POST /clear_pictures_directory` → appelle `capture.clear_pictures_directory()`
  - [x] `POST /assemble_pictures_directory` → appelle `capture.assemble_pictures_directory("captured", "video/output.mp4", 24)`
- [x] Côté frontend `static/js/ui.js`, conserver les `fetch('/clear_pictures_directory')` et `fetch('/assemble_pictures_directory')` (ils seront de nouveau valides).
- [x] Tester manuellement depuis l’onglet Animation les boutons « Nettoyer images » et « Assembler film » pour valider qu’il n’y a plus de 404.

#### Étape 2 — Adapter l’assemblage aux fichiers réellement produits (WebP) ✅ TERMINÉ
- [x] Dans `capture.py/assemble_pictures_directory`, inclure `(.webp, .png, .jpg, .jpeg)` au lieu de seulement `.png`.
- [x] Créer si besoin le dossier de sortie `video/` avant l’écriture (`os.makedirs(os.path.dirname(output_video), exist_ok=True)`).
- [x] Vérifier qu’un film est bien généré depuis un lot d’images `.webp` existantes.

#### Étape 3 — Alignement capture côté client ✅ TERMINÉ
- [x] Confirmer que l’envoi d’images se fait via `FormData` en `.webp` dans `static/js/record.js` → `sendImageToServer()` et que le backend accepte `multipart/form-data` (`/upload_image`).
- [x] Vérifier la numérotation/format des noms de fichiers (`image_0001.webp`, etc.) et le paramètre `numberOfDigits`.

#### Étape 4 — Chaînage automatique à la fin de l’enregistrement ✅ TERMINÉ
- [x] Dans `static/js/mapgl.js`, au point de fin de capture (TODO existant), déclencher:
  - [x] `GET /start_create_video` (assemblage)
  - [x] Puis, si succès, `POST /clear_pictures_directory` (nettoyage)
- [x] Afficher un toast de succès/erreur (utiliser le système de toasts existant) pour informer l’utilisateur.

#### Étape 5 — UX et robustesse ✅ TERMINÉ
- [x] Bloquer/désactiver temporairement les boutons pendant l’assemblage pour éviter les clics multiples.
- [x] Ajouter un indicateur de progression/état pour l’assemblage (simple: toast « en cours… », avancé: polling d’une route de progression si besoin plus tard).
- [x] Gestion d’erreurs: messages clairs si aucun fichier trouvé, si ffmpeg manquant, etc.

#### Étape 6 — Option performance: PoC MediaRecorder (client-side)
- [ ] Prototype: capturer le `canvas` de la carte via `canvas.captureStream(24)` et `MediaRecorder` pour produire un `.webm` côté client sans images intermédiaires.
- [ ] Enregistrer localement (download) et/ou uploader en 1 requête vers le serveur.
- [ ] Mesurer le temps vs pipeline images+moviepy, qualité et poids du fichier.

#### Étape 7 — Choix de l’approche et factorisation
- [ ] Comparer pipelines (images+moviepy vs MediaRecorder) et choisir l’approche par défaut.
- [ ] Factoriser le code (frontend/back) selon l’approche retenue et garder l’autre en option.

#### Étape 8 — Nettoyage et documentation
- [ ] Mettre à jour `README_*` avec le flux final (boutons, formats, prérequis ffmpeg, lieux des sorties).
- [ ] Supprimer/commentez les prototypes non utilisés (ex: anciens listeners redondants dans `record.js` si non utilisés).

#### Étape 9 — Tests de bout en bout
- [ ] Jeu de tests manuels: petites, moyennes et grandes durées; avec/ sans « jours sans cache ».
- [ ] Valider le film produit (durée, fluidité, présence des frames « extraFrames » de fin, infos/titre si activés).

#### Étape 10 — Validation finale
- [ ] Vérifier qu’après « Enregistrer », la chaîne complète s’exécute: capture → assemblage → nettoyage, sans erreurs ni blocages UI.
- [ ] Confirmer la non-régression des autres fonctionnalités (filtrage, cartes, UI plein écran, toasts).

---

Références rapides:
- Backend: `app.py` (routes), `capture.py` (upload, clear, assemble)
- Frontend: `static/js/ui.js` (boutons UI), `static/js/mapgl.js` (capture/chaînage), `static/js/record.js` (upload images), `static/js/init.js` (CONFIG)
