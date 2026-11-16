# Plan — Thèmes de couleurs de la page Statistiques

Demande (2026-11-16) : laisser l'utilisateur choisir les couleurs des
graphiques de la page Statistiques, « un peu comme les thèmes de la carte » ;
régler toute la page d'un coup, mais pouvoir donner d'autres couleurs à un
tableau de bord particulier.

## Choix retenus

- **Thèmes nommés** propres aux Statistiques (pas de lien avec les thèmes de
  la carte : ceux-ci ne personnalisent pas les couleurs des types, et un lien
  vivant recolorerait les graphiques à chaque changement de thème carte).
- **Contenu d'un thème** : 8 teintes des séries, dégradé (cartes de chaleur,
  calendrier, grilles, cartes par zones), hausse / baisse, et couleurs des
  types de caches (« couleurs de la carte » par défaut, ou une par type).
  Restent neutres (non réglables) : quadrillage, « Autres », « Inconnu »,
  cases vides, textes.
- **Portée** : un thème pour la page (`doc.theme`), et par tableau de bord
  une exception facultative (`dashboard.theme`, null = thème de la page).
- **Thèmes fournis** (lecture seule, variantes clair ET sombre) : Défaut
  (palette actuelle), Pastel, Vives, Terre, Océan, Daltonisme
  (Okabe-Ito). « Dupliquer » en fait un thème personnel modifiable.
- **Thèmes personnels** : un seul jeu de couleurs pour le clair et le
  sombre ; le dégradé est soit généré depuis une couleur (adapté au fond de
  chaque mode), soit cinq couleurs libres. L'éditeur signale les teintes peu
  visibles sur l'un des deux fonds et les teintes trop proches.
- **Types de même couleur** : toujours distingués par une nuance voisine
  (`distinctTypeColors`), y compris avec des couleurs personnelles.
- **Stockage** : dans `dashboards.json` (`themes`, `theme`), enregistrement
  automatique comme le reste de la page. Un tableau exporté emporte son
  thème personnel ; à l'import, un thème identique existant est réutilisé.
- **Interface** : panneau latéral « Couleurs » (sans voile) : le tableau
  affiché se recolore en direct. Pendant la modification d'un thème, le
  tableau affiché le montre en aperçu.

## Lots

État au 2026-11-16 : lots 1 à 5 codés et testés (unitaires, Python,
`stats-themes.spec.mjs`). Doc : `docs/page-statistiques.md` › « Thèmes de
couleurs ».

1. **Modèle pur** `static/js/stats_theme_model.mjs` + `tests/js/stats_theme_model.test.mjs` :
   thèmes fournis, normalisation, résolution par mode (variables CSS),
   dégradé généré, avertissements, thème effectif d'un tableau,
   export / adoption à l'import.
2. **Document** : `dashboard_model.mjs` garde `themes` / `theme` (document)
   et `theme` (tableau), références orphelines nettoyées ; export / import /
   duplication ; serveur (`dashboards_store.py`) : forme vérifiée,
   sauvegarde de secours d'un seul tableau qui emporte aussi les thèmes.
3. **Application** : `stats_page_themes.js` pose les variables `--chart-*`
   sur `<html>`, relit les jetons, couleurs des types ; changement de
   tableau, de mode clair / sombre, impression, présentation, vidéo, exports.
4. **Interface** : bouton « Couleurs » de la barre, panneau (thème de la
   page, thème du tableau, liste, dupliquer / renommer / supprimer), éditeur
   avec aperçu en direct et « Annuler les modifications ».
5. **Finitions** : documentation (`docs/page-statistiques.md`),
   traductions, E2E (`stats-themes.spec.mjs`).
6. **Allure** (2026-11-16, retour : « les thèmes ne changent pas assez de
   look ») : forme et largeur des barres, épaisseur des courbes, points,
   aires, anneaux, style et coins des cartes, couleur des pastilles, ton
   des types de caches ; une allure propre à chaque thème fourni, réglable
   dans l'éditeur. Choisir un thème d'un clic dans la liste.
7. **Fond des exports** (2026-11-16) : comme l'écran / clair / sombre pour
   l'image du tableau, le PNG / SVG d'un graphique et la vidéo, sans
   toucher l'écran. Étape suivante possible (non faite) : une couleur de
   fond libre dans l'allure d'un thème, avec texte, quadrillage et dégradé
   calculés depuis ce fond (cartes et exports ; le fond de page autour des
   cartes resterait celui de l'app).
