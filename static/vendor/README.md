# Bibliothèques tierces servies en local

MyGCFlow est une application de bureau : Flask tourne en local et l'utilisateur peut
très bien travailler sans connexion (import d'un GPX, mise en forme, animation,
enregistrement vidéo). Tant que ces bibliothèques venaient d'un CDN
(jsdelivr / unpkg), une coupure réseau cassait **toute** l'interface : plus de
Bootstrap/Tabler (mise en page), plus de Tom Select (les multi-sélecteurs
restaient des `<select>` bruts), plus de Tempus Dominus (les datepickers ne
s'ouvraient plus), plus d'OpenLayers (aucune carte).

Elles sont donc copiées ici et référencées en `../static/vendor/...` dans les
templates. Aucun fichier n'est modifié par rapport à l'original publié sur npm.

## Contenu

| Dossier | Paquet npm | Version | Fichiers |
| --- | --- | --- | --- |
| `tabler/` | `@tabler/core` | 1.4.0 | `tabler.min.css`, `tabler.min.js` (inclut le bundle Bootstrap 5) |
| `tabler-icons/` | `@tabler/icons-webfont` | 3.34.1 | `tabler-icons.min.css` + `fonts/` (woff2, woff, ttf) |
| `tom-select/` | `tom-select` | 2.4.3 | `tom-select.bootstrap5.css`, `tom-select.complete.min.js` |
| `tempus-dominus/` | `@eonasdan/tempus-dominus` | 6.10.4 | `tempus-dominus.min.css`, `tempus-dominus.min.js` |
| `popperjs/` | `@popperjs/core` | 2.11.8 | `popper.min.js` (requis par Tempus Dominus) |
| `ol/` | `ol` | 10.6.0 | `ol.css`, `ol.js` |
| `htmx/` | `htmx.org` | 2.0.10 | `htmx.min.js` |

`static/js/vendor/html2canvas.min.js` est également vendoré, mais reste à part :
il n'est pas chargé par les templates, `loadHtml2Canvas()` (dans
`static/js/mapgl.js`) l'injecte à la demande au début d'un enregistrement.

## Mettre à jour une bibliothèque

Les fichiers proviennent de jsDelivr (`htmx` d'unpkg). Pour passer par exemple
Tom Select en 2.5.0 :

```sh
curl -fL https://cdn.jsdelivr.net/npm/tom-select@2.5.0/dist/css/tom-select.bootstrap5.css \
     -o static/vendor/tom-select/tom-select.bootstrap5.css
curl -fL https://cdn.jsdelivr.net/npm/tom-select@2.5.0/dist/js/tom-select.complete.min.js \
     -o static/vendor/tom-select/tom-select.complete.min.js
```

Puis mettre à jour la version dans le tableau ci-dessus. Points d'attention :

- **Ne pas remettre d'URL CDN dans un template** :
  `tests/test_offline_assets.py` échoue si un template rendu par une route
  référence un hôte externe, et vérifie que chaque chemin `static/` existe.
- **Fichiers annexes** : certaines CSS référencent des ressources voisines. Pour
  `tabler-icons`, le `@font-face` pointe sur `./fonts/tabler-icons.{woff2,woff,ttf}`
  qu'il faut télécharger en même temps, sinon toutes les icônes disparaissent.
- **Sourcemaps** : les fichiers gardent leur commentaire `sourceMappingURL`, mais
  les `.map` ne sont pas vendorés (plusieurs Mo pour un usage strictement
  devtools). Cela se traduit par un 404 visible uniquement dans les devtools.

## Ce qui a toujours besoin du réseau

Vendorer ces bibliothèques rend l'**interface** fonctionnelle hors ligne, pas la
carte : les tuiles des fonds de carte (`static/js/basemaps.js`) sont téléchargées
depuis les serveurs des fournisseurs. Hors ligne, l'application s'affiche et
reste pilotable, mais le fond de carte reste vide.
