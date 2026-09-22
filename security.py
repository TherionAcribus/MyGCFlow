"""Protection du serveur local contre les autres sites ouverts dans le navigateur.

GCMap écoute sur 127.0.0.1 : n'importe quelle page web visitée par
l'utilisateur peut viser cette adresse. Deux attaques sont à bloquer :

- **requête inter-sites** : une page malveillante soumet un formulaire ou un
  fetch « simple » (POST sans en-têtes exotiques) vers /clear_database. Le
  navigateur l'envoie sans demander de pré-vol CORS ; la politique CORS
  empêche seulement de lire la réponse, pas l'effet de bord. On refuse donc
  toute requête modifiante dont l'Origin n'est pas GCMap lui-même ;
- **DNS rebinding** : un domaine attaquant se résout vers 127.0.0.1 et sa page
  devient alors « même origine » que GCMap. L'en-tête Host porte cependant
  toujours le nom de ce domaine : on n'accepte que localhost / 127.0.0.1.

Le front étant servi par le même serveur, aucune en-tête CORS n'est émise.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from flask import abort, request

ALLOWED_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _hostname(host: str) -> str:
    # « 127.0.0.1:51730 », « [::1]:51730 », « localhost »
    return (urlsplit(f"//{host}").hostname or "").lower()


def check_request() -> None:
    if _hostname(request.host) not in ALLOWED_HOSTNAMES:
        abort(403)
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("Origin")
    if origin is not None:
        # « null » (iframe sandboxée, fichier local) ne correspond jamais.
        if origin.rstrip("/") != request.host_url.rstrip("/"):
            abort(403)
        return
    # Sans Origin (anciens navigateurs, outils) : Sec-Fetch-Site, s'il est
    # présent, dit tout de même d'où vient la requête. Absent = client non
    # navigateur (tests, curl), qui n'agit pas au nom d'une page web.
    fetch_site = request.headers.get("Sec-Fetch-Site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        abort(403)


def init_app(app) -> None:
    app.before_request(check_request)
