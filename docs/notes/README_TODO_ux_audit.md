# Programme de corrections UX/UI — audit du 2026-10-03

Issu d'un audit de l'interface (templates, CSS, 20 captures Playwright en
1440×900 et 1024×700, thèmes clair/sombre, mode principal et mode Évolution).
Aucune erreur console ni débordement horizontal n'a été relevé : les points
ci-dessous sont des corrections d'ergonomie et de hiérarchie visuelle.

Chaque lot est indépendant et livrable séparément. Les lots sont classés par
rapport effet/effort décroissant. **Lire d'abord « Règles communes ».**

---

> **Statut** — Lot 1 : fait (commit « UX > Boutons… »). Lot 3 : fait (commit
> « UX > Toasts… »). Autres lots : à faire.
>
> **Environnement (important)** : `npm run test:e2e` gèle indéfiniment sous
> **Node 24** (bug nodejs/node#63085 + Playwright 1.52). Lancer la suite sous
> Node 22 : `"C:\Users\fabie\AppData\Local\nvm\v22.22.2\node.exe"
> tests/e2e/run-tests.mjs <specs>` (attention : `C:\nvm4w\nodejs\node.exe` est
> le lien nvm-for-windows vers la version *active*, actuellement Node 24 — ne
> pas l'utiliser). Corriger en montant la version d'@playwright/test (fix PR
> #35933) ou en épinglant Node ≤24.11.

## Règles communes à tous les lots

- Langue : contenu, commentaires et commits en français. Tout texte visible
  passe par `{{ _("…") }}` (Jinja) ou `t('…')` / `pkg.t('…')` (JS) ; après
  ajout ou modification de chaînes, régénérer les catalogues
  (voir `docs/translations.md` et `check_missing_translations.py`).
- Ne pas ajouter ni retirer de commentaires existants sans raison ; les
  commentaires du code expliquent souvent un choix délibéré — les lire avant
  de changer un comportement.
- Vérification minimale par lot : `npm run test:e2e -- <spec(s) cités>` puis,
  en fin de programme, la suite complète `npm run test:e2e` et
  `python -m pytest tests/`. Les tests e2e démarrent leur propre serveur
  (`tests/e2e/run_server.py`, runtime jetable) ; ne pas lancer l'app réelle.
- Les captures de référence de l'audit sont dans `output/ux-audit/` (ignoré
  par git). Le script `output/ux-audit/capture.mjs` peut être relancé pour
  comparer avant/après.
- Ne jamais toucher aux fichiers `static/vendor/**`.

---

## Lot 1 — Rendre leur sémantique aux boutons (hiérarchie visuelle)

**Constat.** `static/css/theme.css` lignes 33-44 : une règle
`.btn:not(.btn-link):not(.btn-outline-*)…` force `background-color:
var(--color-accent)` sur **toutes** les variantes pleines. Résultat :
`btn-danger`, `btn-secondary`, `btn-success` et `btn-primary` sont identiques
(bleu accent). Exemples visibles :
- `#clearDatabaseBtn` (« Supprimer mes trouvailles », `btn-danger w-100`,
  `templates/menu_data.html` l.26) est le bouton le plus voyant de l'onglet
  Données, en couleur « action principale ».
- Onglet Animation (`templates/menu_animation.html` l.25-49) : « Plein
  écran » (`btn-secondary`), « Prévisualiser » / « Exporter » (`btn-primary`)
  et « Menu flottant » (`btn-primary`, toggle) ont le même poids.

**À faire.**
1. `static/css/theme.css` : supprimer les trois règles `.btn:not(…)` (l.34-44)
   et les variantes `.btn.green/.orange/.red/.grey` (l.47-50) si plus aucun
   élément ne porte ces classes (vérifier par grep `class="[^"]*\b(green|orange|red|grey)\b`
   dans `templates/` et `static/js/`). La surcharge de l'accent reste assurée
   par `static/css/tabler_theme.css` l.48-51 (`--tblr-primary`) et l.121
   (`.btn-primary`). Vérifier que `--tblr-danger`, `--tblr-secondary`,
   `--tblr-success` restent mappés (l.59 et voisines) et lisibles en thème
   sombre (`[data-bs-theme="dark"]`).
2. `#clearDatabaseBtn` : remplacer `btn btn-danger w-100` par
   `btn btn-outline-danger btn-sm` et le sortir du bloc `mt-3` pleine largeur
   pour le placer à droite de `#infosBDD` (ligne « Aucune trouvaille chargée /
   N trouvailles… »). La confirmation modale existe déjà (`bdd.js`
   `clearDatabase()` l.1131-1160) ; ne pas y toucher.
3. Toggle « Menu flottant » (`#btnToggleControlBar`) : dans
   `templates/menu_animation.html` l.45 utiliser `btn btn-outline-secondary` ;
   dans `static/js/ui.js` `updateControlBarToggleButton()` (l.6075-6087)
   remplacer le basculement `btn-primary`/`btn-secondary` par le basculement
   d'une classe `active` (Bootstrap rend l'état pressé) en gardant
   `aria-pressed`. Même traitement pour `#btnFullscreenMode` dans
   `updateFullscreenButtonAppearance()` (l.6147-6175).
4. Dans l'en-tête Animation, hiérarchie cible : « Prévisualiser » = `btn-primary`,
   « Exporter » = `btn-primary` (ou `btn-success` si on veut le distinguer, à
   condition que le même choix soit appliqué à `#btnQuickExport` et
   `#btnRecordBar`), « Plein écran » et « Menu flottant » = `btn-outline-secondary`.

**Vérification.** Captures des onglets Données et Animation en clair et sombre ;
`npm run test:e2e -- tests/e2e/control-bar.spec.mjs tests/e2e/empty-state.spec.mjs tests/e2e/upload-feedback.spec.mjs`.

---

## Lot 2 — Donner de la place au panneau de réglages

**Constat.** `static/js/ui.js` `initMapTabsSplitPane()` l.1290+ :
`LAYOUT_PRESETS = { map: 0.8, balanced: 0.6, tabs: 0.25, sidebar: 0.7 }`.
Le préréglage par défaut « équilibré » donne 60 % de la hauteur à la carte.
À 1440×900 il reste ~300 px au panneau dont ~60 px pour la barre collante ;
à 1024×700 il reste ~100 px (on ne voit que les sous-onglets et une rangée de
boutons). L'alerte « Vos trouvailles sont prêtes → Choisir un style »
(`#dataNextStep`) est systématiquement sous la ligne de flottaison.

**À faire.**
1. Nouvelles valeurs : `balanced: 0.45`, `map: 0.75`, `tabs: 0.25`,
   `sidebar: 0.62`. Mettre à jour `LAYOUT_PRESET_TOLERANCE` si nécessaire pour
   que `syncLayoutPresets()` continue de marquer le bon bouton actif.
2. Choix initial (première ouverture, aucune valeur dans `localStorage`
   `mapTabsMapHeightPx` / `mapTabsLayoutMode`) : si `window.innerWidth >= 1280`
   appliquer le préréglage `sidebar`, sinon `balanced`. Localiser l'endroit
   où la hauteur initiale est lue (`STORAGE_KEY`, l.1299) et ajouter ce repli.
3. Poignée du séparateur `#mapTabsResizer` (`static/css/ui_improvements.css`
   l.695-710) : ajouter un indicateur central visible (pseudo-élément
   `::before`, 36×4 px, arrondi, couleur `rgba(0,0,0,.25)` / blanc-alpha en
   sombre dans `tabler_theme.css` l.354-358) pour qu'il soit découvrable.
4. Barre collante en mode latéral (capture `05-layout-sidebar.png` : onglets,
   actions rapides et préréglages passent sur deux lignes, le groupe
   `#layoutPresets` est tronqué). Dans `ui_improvements.css`, réutiliser le
   mécanisme `panel-lt-md` (posé par `ui.js` l.1544-1546 sur `#tabsPanel`)
   pour appliquer au panneau étroit le mode « icônes seules » déjà écrit pour
   `@media (max-width: 575.98px)` (l.867-889) : masquer `#quickActions
   .btn-label`, réduire le padding des `.nav-link`. Les `aria-label` existent
   déjà sur ces boutons.

**Vérification.**
`npm run test:e2e -- tests/e2e/splitter-keyboard.spec.mjs tests/e2e/empty-state.spec.mjs` ;
capture 1024×700 onglet Données : `#dataNextStep` doit être visible sans
défilement après import.

---

## Lot 3 — Discipline des notifications (toasts)

**Constat.**
- Au démarrage, deux toasts systématiques et sans action possible :
  « Chargement de l'application… » (`static/js/bdd.js` `readBdd()` l.968,
  `showLoadingToast`) et « Profils : Profil "Default" chargé »
  (`static/js/profiles.js` l.281 et l.1101, `this.showToast(…, 'green')`).
  Le second déborde du bord droit de la fenêtre (capture `01`).
- Toast « Fichier chargé avec succès ! » (`bdd.js` l.943 et l.1252) : il
  s'empile avec les autres et la pile masque `#layoutPresets` (coin haut-droit
  du panneau) ; durant l'audit les clics sur ces boutons ont été interceptés
  pendant 30 s.
- Le conteneur `.gcm-toast-container` (`ui_improvements.css` l.294-300) est en
  `position: fixed; top: 20px; right: 20px`, c'est-à-dire **sur la carte** et
  sur le menu flottant `#controlBar`.

**À faire.**
1. `profiles.js` : ne plus émettre le toast « Profil chargé » quand le
   chargement vient de la restauration au démarrage. `restoreStartupProfile()`
   (vers l.1284) appelle le chargement : ajouter un paramètre `quiet` (le
   pattern existe déjà pour la sauvegarde, l.304 `if (result.success && !quiet)`)
   et le passer à `true` depuis la restauration. Le nom du thème est déjà
   affiché dans `#current-profile-indicator`.
2. `bdd.js` `readBdd()` : remplacer le toast « Chargement de l'application… »
   par l'indicateur inline déjà prévu dans l'état vide
   (`#emptyStateUploadProgress`, `templates/app.html` l.112-120) ou, si une
   base existe, par un simple `aria-busy` sur `#tabsPanel` — pas de toast.
   Conserver la mise à jour de progression si elle est utile (`onProgress`
   l.976) en la redirigeant vers la barre inline.
3. `bdd.js` l.943 et l.1252 : succès d'import → `showToast(msg, 'success',
   title, 4000)` (4 s). Le message durable est déjà porté par `#dataNextStep`
   et `#infosBDD`.
4. `notifications.js` `NotificationManager.show()` : plafonner la pile à
   3 toasts (retirer le plus ancien non-persistant au-delà) et ne jamais
   empiler deux toasts de même `title + message`.
5. Position : déplacer `.gcm-toast-container` en **bas-droite**
   (`bottom: 20px; right: 20px; top: auto`) pour libérer la carte et
   `#controlBar`. Ajouter `max-width: min(400px, calc(100vw - 40px))` pour
   supprimer le débordement. Adapter la media query l.634 (petit écran).
   Vérifier que la variante plein écran et les toasts de progression
   d'enregistrement (`recording_perf.js`, `mapgl.js`) restent lisibles.

**Vérification.**
`npm run test:e2e -- tests/e2e/upload-feedback.spec.mjs tests/e2e/profile-style-state.spec.mjs tests/e2e/first-use.mjs` ;
au démarrage avec base vide : zéro toast visible après 2 s.

---

## Lot 4 — Un seul parcours d'import au premier lancement

**Constat.** Trois points d'entrée identiques sont visibles en même temps à la
première ouverture (capture `02`) : la modale `#modal_first_use`
(`templates/modal_first_use.html`), la carte d'état vide `#emptyState`
(`templates/app.html` l.94-124) et la carte « Mes trouvailles »
(`templates/menu_data.html` l.10-49). La modale et l'état vide répètent le
même bouton et la même consigne de glisser-déposer.

**À faire.**
1. `bdd.js` l.400-414 : ne plus ouvrir `modal_first_use` automatiquement.
   Garder `markFirstUseSettled()` pour que le reste de la logique (toasts
   différés, etc.) ne change pas.
2. Dans `#emptyState` (mode principal uniquement), ajouter sous le bouton un
   lien `btn btn-link btn-sm` « Comment obtenir mon fichier .gpx ? » qui ouvre
   `modal_first_use` (`showBsModal('modal_first_use')`). Garder le lien vers
   le guide. La modale devient une aide contextuelle, pas une barrière.
3. Dans `modal_first_use.html`, retirer la section « Chargement de vos
   données » (form `#uploadBddFormModal`, l.27-55) et le code associé dans
   `bdd.js` (`fileInputModal` l.49+, `performUploadFromModal`, `#infosBDDModal`,
   `#modalUploadProgress`) **uniquement si** `tests/e2e/first-use.mjs` ne
   l'exerce pas ; sinon adapter le test. Garder le bouton « Ouvrir mes Pocket
   Queries » et le lien guide. Renommer le bouton de fermeture « Fermer ».
4. Titre et compteur de la carte en état vide (`frames.js`
   `syncOverlayVisibility()` l.15-41) : ajouter la condition « une base est
   chargée » — exposer `hasDatabase()` de `ui.js` (l.6201) via `pkg` et
   l'utiliser : `const dbReady = pkg.hasDatabase?.() ?? true;` puis
   `showTitle = dbReady && …`, `showInfos = dbReady && …`. Appeler
   `syncOverlayVisibility()` depuis `updateDataAvailabilityUI()` (`ui.js`
   l.6219) pour rafraîchir au chargement/vidage.

**Vérification.**
`npm run test:e2e -- tests/e2e/first-use.mjs tests/e2e/empty-state.spec.mjs tests/e2e/overlay.spec.mjs`.

---

## Lot 5 — Dédoublonner les commandes de lecture

**Constat.** Prévisualiser / Exporter / Pause / Arrêter existent à trois
endroits : barre collante `#quickActions` (`app.html` l.155-173), en-tête du
panneau Animation (`menu_animation.html` l.29-44) et menu flottant
`#controlBar`. La rangée du panneau Animation consomme la hauteur la plus rare
(cf. Lot 2) pour une redite.

**À faire.**
1. Retirer de `menu_animation.html` les boutons `#btnStartAnimation`,
   `#btnRecordAnimation`, `#btnPauseAnimation`, `#btnStopAnimation` du flux
   visible. **Attention** : `ui.js` les utilise comme source de vérité
   (`quickActionsMap` l.656-662 relaie les clics des boutons rapides vers eux ;
   `updateControlBar()` l.6252+ lit `getComputedStyle(btnStartAnimation).display`
   pour déterminer l'état repos). Approche sans risque : les garder dans le DOM
   dans un conteneur `hidden` dédié (`<div id="animationControlsSource" hidden>`)
   et faire porter l'état « idle » par une variable ou un `data-state` sur
   `#controlBar`, plutôt que par le `display` calculé. Mettre à jour
   `updateControlBar()` en conséquence.
2. Garder dans l'en-tête Animation uniquement « Plein écran » et « Menu
   flottant » (en `btn-outline-secondary`, cf. Lot 1) et déplacer le badge
   `global_scope_badge()` orphelin (l.48) à côté du libellé « Menu flottant »
   ou le supprimer là (la portée globale est déjà indiquée par la préférence).
3. Les boutons rapides `#btnQuickPreview` / `#btnQuickExport` deviennent les
   seules commandes dans le panneau ; vérifier que `disabled` suit toujours
   `canRun` (`updateDataAvailabilityUI()` l.6246-6248 ne met à jour que
   `btnStart`/`btnRecord` ; chercher la synchronisation des boutons rapides
   vers l.6386 `qPreview`).

**Vérification.**
`npm run test:e2e -- tests/e2e/animation-playback.spec.mjs tests/e2e/control-bar.spec.mjs tests/e2e/video-export.spec.mjs`.

---

## Lot 6 — En-tête d'application léger

**Constat.** `templates/app.html` n'a aucun en-tête : ni logo, ni accès au
guide (enterré dans Préférences, `menu_options.html` l.130), ni indication du
mode actif hors onglet Données (`_mode_switch.html`), ni bascule clair/sombre
rapide.

**À faire.**
1. Ajouter dans `#panelToolbar` (barre collante, `app.html` l.148), à gauche
   des onglets, un bloc `#appBrand` : logo `_brand_logo.html` (hauteur 22 px),
   puis un `select`/menu compact du mode (réutiliser les liens de
   `_mode_switch.html` ; retirer alors le `nav.mode-switch` de l'onglet
   Données ou le réduire à la phrase d'explication).
2. À droite de `#layoutPresets`, un groupe `#appQuickLinks` : bouton icône
   `ti-help` → `/guide` (`target="_blank"`), bouton icône `ti-sun`/`ti-moon`
   qui cycle `system → light → dark` en appelant la même fonction que
   `#selectTheme` (`static/js/theme.js`) et resynchronise le select.
   Tooltips + `aria-label` comme les autres boutons icône.
3. En mode latéral / panneau étroit (`panel-lt-md`), masquer le texte du
   mode, garder l'icône.

**Vérification.** Visuelle (4 dispositions, clair/sombre) ;
`npm run test:e2e -- tests/e2e/global-preferences.spec.mjs tests/e2e/evolution.spec.mjs`.

---

## Lot 7 — Mode Évolution : onglet d'arrivée

**Constat.** `ui.js` `initTabMemory()` l.1264-1288 restaure
`localStorage.activeTab` quelle que soit la page. Sur `/evolution` sans base,
la page s'ouvre sur « Animation & vidéo » (capture `16`) alors que l'état vide
demande d'importer.

**À faire.** Dans `initTabMemory()`, si `document.body.dataset.mode ===
'evolution'` **et** qu'aucune base n'est chargée (utiliser la même source que
`hasDatabase()`, ou lire l'état après `updateDataAvailabilityUI`), forcer
`activeTab = 'data'`. Idem en mode principal quand la base est vide. Stocker la
clé par page (`activeTab:main` / `activeTab:evolution`) pour que les deux modes
ne se marchent plus dessus (vérifier l'autre lecture l.2356).

**Vérification.** `npm run test:e2e -- tests/e2e/evolution.spec.mjs tests/e2e/empty-state.spec.mjs`.

---

## Lot 8 — Champs fichier natifs

**Constat.** `<input type="file" class="form-control">` (`menu_data.html`
l.16, `menu_data_evolution.html` l.45, `menu_animation.html` l.204 pour
l'audio) affiche « Choose File / No file chosen » dans la langue du navigateur,
pas celle de l'app.

**À faire.** Remplacer chaque input visible par : `<input type="file" …
class="visually-hidden">` + `<label for="…" class="btn btn-outline-primary">
<i class="ti ti-upload me-1"></i>{{ _("Choisir un fichier") }}</label>` +
`<span class="form-hint ms-2" id="…FileName">{{ _("Aucun fichier") }}</span>`.
Au `change`, afficher `files[0].name` (ou « N fichiers ») dans le span. Les
écouteurs existants restent sur l'input. Vérifier le `gpx-dropzone__hint`
(`ui_improvements.css`) qui enveloppe l'input.

**Vérification.** `npm run test:e2e -- tests/e2e/upload-feedback.spec.mjs tests/e2e/evolution.spec.mjs`
(les tests utilisent `setInputFiles('#file-input', …)`, qui fonctionne sur un
input masqué).

---

## Lot 9 — Filtres : retour d'état visible

**Constat.** Le compteur `#filtersCounter` (« Sélection : 6 / 6 »,
`menu_data.html` l.65-69) est dans une ligne séparée en bas à droite de
l'onglet, hors écran. « Réinitialiser tous les filtres » (`menu_filtre.html`
l.4) est toujours en `btn-outline-danger`, même sans filtre actif.

**À faire.**
1. Déplacer `#filtersCounter` dans le `h5.gc-section-title` « Filtres »
   (`menu_data.html` l.55 et `menu_data_evolution.html` l.95) sous forme de
   `<span class="badge bg-secondary-lt ms-2">`. `bdd.js`
   `updateFiltersCounter()` l.1089 continue d'écrire dedans ; adapter le format
   (« 6 / 6 »).
2. `#btnResetAllFilters` : `btn-outline-secondary` par défaut ; `ui.js` ajoute
   `btn-outline-danger` + un point coloré uniquement quand au moins un filtre
   diffère de « tout sélectionné / toutes dates ». Trouver la fonction qui
   recalcule la sélection (celle qui appelle `updateFiltersCounter` l.1086) et
   y poser un `data-filters-active` sur `#filterPanel`, lu par le CSS.

**Vérification.** `npm run test:e2e -- tests/e2e/filters-compact.spec.mjs`.

---

## Lot 10 — Assistant « Titre et informations » : mode simple / avancé

**Constat.** `templates/menu_informations.html` : trois niveaux d'onglets
imbriqués (Style → Carte/titre → Titre|Infos → Texte|Boîte|Ombre|Position) et
des libellés CSS bruts (`left`, `relative`, `fixed`, `z-index`, `Blur`,
`Spread`, `bold`, `top/right/bottom/left`) dans une interface grand public.

**À faire.**
1. Mode simple (défaut, `#gcCssAdvancedMode` décoché) : ne montrer que
   Texte (couleur, taille, police, graisse « Normal / Gras »), Boîte (fond,
   marge intérieure, arrondi) et un sélecteur de **position par coin**
   (haut-gauche, haut-centre, haut-droit, bas-gauche, bas-centre, bas-droit)
   qui écrit `top/right/bottom/left` dans le CSS généré.
2. Mode avancé (`#gcCssAdvancedMode` coché) : conserver les panneaux
   Ombre / Position actuels **et** l'éditeur `#gcCssRawEditor`.
3. Traduire les libellés d'options : `left/center/right` → Gauche/Centre/
   Droite ; `normal/bold` → Normal/Gras ; `solid/dashed/dotted` → Plein/Tirets/
   Pointillés ; `none` → Aucun. Les `value` ne changent pas.
4. Les anciens profils avec `position: relative/absolute` et valeurs libres
   doivent rester lisibles : si le CSS enregistré ne correspond à aucun coin,
   afficher « Personnalisé » dans le sélecteur et basculer le badge
   `#gcCssUnmanagedBadge` (déjà prévu pour ce cas).

**Vérification.** `npm run test:e2e -- tests/e2e/overlay.spec.mjs` ;
`python -m pytest tests/test_overlay_settings.py tests/test_profile_validation.py`.

---

## Lot 11 — Finitions et libellés

1. **Radios/cases à libellé non cliquable** : `menu_points.html` (l.70-81,
   l.136-147), `menu_flash.html` (l.38-49, l.60-75), `menu_informations.html`
   (l.175-178) utilisent `<span aria-labelledby>` à la place de `<label for>`,
   volontairement (commentaire). C'est contraire à la convention des
   formulaires et surprend l'utilisateur : repasser en `<label class="form-check-label" for="…">`.
   Vérifier que `profile-style-state.spec.mjs` et `flash-color-live.spec.mjs`
   ne dépendent pas du non-clic.
2. **Vocabulaire « thème »** : `menu_options.html` l.50 « Thème par défaut au
   démarrage » côtoie « Apparence (Système/Clair/Sombre) ». Renommer en
   « Style par défaut au démarrage » **ou** renommer toute la notion
   « Thème » en « Style » (`menu_style.html` `#profile-bar`, badges
   `_scope_badges.html`, toasts `profiles.js`, guide). Choisir une seule
   option et l'appliquer partout, y compris les traductions.
3. **Aide « Suivi de caméra »** (`menu_animation.html` l.190) : ramener à une
   phrase + lien « En savoir plus » vers `/guide#camera` (ajouter l'ancre dans
   `templates/guide.html`).
4. **Options de police / graisse** (`menu_informations.html` l.87-114) : les
   `option` « normal / bold » et les chiffres 100-900 → garder Normal, Gras et
   un sous-menu « Avancé » pour les valeurs numériques (ou ne les montrer qu'en
   mode avancé, cf. Lot 10).
5. **Toast de confirmation « Images de capture supprimées »** et autres
   `showToast(…, 4000)` : aligner toutes les durées de succès sur 4 s via
   `showSuccess()` (`notifications.js` l.285) et ne plus passer de durée en
   dur dans les appelants.

---

## Ordre de livraison conseillé et estimation relative

| Lot | Impact | Effort | Dépendances |
| --- | --- | --- | --- |
| 1 Boutons | Fort | Faible | — |
| 3 Toasts | Fort | Faible | — |
| 2 Espace panneau | Fort | Moyen | — |
| 4 Import unique | Fort | Moyen | 3 |
| 5 Dédoublonnage lecture | Moyen | Moyen | 1, 2 |
| 7 Onglet Évolution | Moyen | Faible | — |
| 9 Filtres | Moyen | Faible | — |
| 8 Input fichier | Moyen | Faible | 4 |
| 6 En-tête | Moyen | Moyen | 1 |
| 10 Assistant CSS | Moyen | Fort | — |
| 11 Finitions | Faible | Faible | 10 pour le point 4 |

Clôture : `npm run test:e2e` complet, `python -m pytest tests/`, relance de
`output/ux-audit/capture.mjs` et comparaison des 20 captures avec la série de
référence ; note de version dans `docs/release_notes/`.
