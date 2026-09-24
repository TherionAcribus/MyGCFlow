"""Vérification des mises à jour : lecture des Releases GitHub du dépôt.

Source unique de vérité : les Releases créées par `.github/workflows/release.yml`
sur un tag `v*`. Il n'y a donc plus de fichier de versions à tenir à jour à la
main — ce que publie la CI est exactement ce que voit l'utilisateur.

Le module est sans état : la périodicité des vérifications et la version que
l'utilisateur a choisi d'ignorer vivent dans les préférences globales, et sont
appliquées par la route `/check_version` (blueprints/core.py).
"""

import html
import json
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests
from packaging.version import InvalidVersion, Version

# Dépôt public de distribution. Le tag `v<version>` de chaque Release porte le
# numéro de version, ses assets l'installeur et l'archive portable.
GITHUB_OWNER = "TherionAcribus"
GITHUB_REPO = "MyGCFlow"
RELEASES_URL = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"

# Paramètres HTTP pour la robustesse réseau.
HTTP_TIMEOUT = 5
RELEASES_PER_PAGE = 30
HTTP_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": f"MyGCFlow/VersionCheck (+https://github.com/{GITHUB_OWNER}/{GITHUB_REPO})",
}

# Délai minimal entre deux vérifications automatiques. Une vérification demandée
# par l'utilisateur (bouton « Vérifier ») l'ignore toujours.
CHECK_INTERVAL = timedelta(hours=24)

# Le lien de téléchargement est le seul élément de la réponse sur lequel
# l'utilisateur va cliquer pour exécuter un binaire : il doit venir de GitHub et
# de nulle part ailleurs, même si la réponse est un jour servie par autre chose
# que l'API officielle.
ALLOWED_DOWNLOAD_HOSTS = frozenset({
    "github.com",
    "www.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
})

# Asset proposé en priorité : l'installeur. À défaut, on renvoie vers la page de
# la Release, où l'utilisateur choisit entre installeur et version portable.
INSTALLER_ASSET_PREFIX = "MyGCFlow-Setup"

# Les notes de Release générées par GitHub tiennent en quelques lignes ; la borne
# évite qu'un corps de Release inhabituel remplisse la modale.
MAX_CHANGELOG_LINES = 40


def _text(value):
    """Texte distant échappé avant insertion dans le HTML de la modale.

    Le client insère ces champs via `innerHTML` : les échapper ici garantit
    qu'un corps de Release ne peut pas injecter de balise, quel que soit le
    chemin qu'emprunte ensuite la donnée.
    """
    return html.escape(str(value if value is not None else ''))


def _safe_url(value):
    """Ne laisse passer qu'une URL HTTPS hébergée par GitHub."""
    url = str(value or '')
    try:
        parsed = urlparse(url)
    except ValueError:
        return ''
    if parsed.scheme != 'https':
        return ''
    hostname = parsed.hostname
    if hostname is None or hostname.lower() not in ALLOWED_DOWNLOAD_HOSTS:
        return ''
    return url


def _version_of(tag_name):
    """Numéro de version porté par un tag `v1.2.0`, ou None s'il est illisible."""
    raw = str(tag_name or '').strip().lstrip('vV')
    try:
        return Version(raw)
    except InvalidVersion:
        return None


def _changelog_lines(body):
    """Corps Markdown d'une Release ramené à une liste de puces échappées.

    Les notes produites par `gh release create --generate-notes` sont une liste
    à puces précédée d'un titre et suivie d'un lien de comparaison : ni l'un ni
    l'autre n'apportent quelque chose dans la modale.
    """
    lines = []
    for raw_line in str(body or '').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or line.startswith('**Full Changelog**'):
            continue
        # Soulignement de titre (`-----`, `=====`) : un titre en notation
        # reStructuredText passe sinon pour une puce de deux caractères.
        if not line.strip('-=~^*_'):
            continue
        if line[:2] in ('- ', '* ', '+ '):
            line = line[2:].strip()
        if line:
            lines.append(_text(line))
        if len(lines) >= MAX_CHANGELOG_LINES:
            break
    return lines


def _release_entry(release):
    """Release GitHub convertie en entrée exploitable, ou None si inutilisable."""
    if not isinstance(release, dict) or release.get('draft'):
        return None
    version = _version_of(release.get('tag_name'))
    if version is None:
        logging.debug("Release ignorée : tag illisible (%r).", release.get('tag_name'))
        return None

    download_url = ''
    assets = release.get('assets')
    if isinstance(assets, list):
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            if str(asset.get('name') or '').startswith(INSTALLER_ASSET_PREFIX):
                download_url = _safe_url(asset.get('browser_download_url'))
                if download_url:
                    break
    release_url = _safe_url(release.get('html_url'))

    # `published_at` est une date ISO-8601 en UTC : la partie date suffit.
    published_at = str(release.get('published_at') or '')
    return {
        'parsed_version': version,
        'version': _text(str(release.get('tag_name') or '').strip().lstrip('vV')),
        'release_date': _text(published_at.split('T')[0]),
        'changelog': _changelog_lines(release.get('body')),
        'download_url': _text(download_url or release_url),
        'release_url': _text(release_url),
        'prerelease': bool(release.get('prerelease')),
    }


def _empty_payload(current_version, checked, error=False):
    """Réponse sans version à proposer : à jour, report, ou échec."""
    return {
        "error": error,
        "checked": checked,
        "update_available": False,
        "skipped": False,
        "current_version": current_version,
        "latest_version": None,
        "versions": [],
    }


def check_version_error(reason, current_version=None):
    """Réponse d'échec. Le détail reste dans les journaux, pas dans l'interface.

    L'ancienne version renvoyait le texte brut de l'exception (donc l'URL
    interrogée) directement dans la modale : sans intérêt pour l'utilisateur,
    et une fuite d'information gratuite.
    """
    logging.error("Vérification des mises à jour impossible : %s", reason)
    return _empty_payload(current_version, checked=False, error=True)


def throttled_payload(current_version):
    """Réponse renvoyée quand la vérification est reportée : aucune donnée."""
    return _empty_payload(current_version, checked=False)


def fetch_version_info(current_version):
    """État des mises à jour d'après les Releases GitHub (fonction testable)."""
    try:
        response = requests.get(
            RELEASES_URL,
            headers=HTTP_HEADERS,
            params={"per_page": RELEASES_PER_PAGE},
            timeout=HTTP_TIMEOUT,
        )
        response.raise_for_status()
        releases = response.json()
    except requests.RequestException as error:
        return check_version_error(f"erreur réseau ({error})", current_version)
    except (json.JSONDecodeError, ValueError) as error:
        return check_version_error(f"réponse illisible ({error})", current_version)

    if not isinstance(releases, list):
        return check_version_error("réponse inattendue de l'API GitHub", current_version)

    installed = _version_of(current_version)
    if installed is None:
        # Version locale illisible : mieux vaut ne rien proposer que tout
        # proposer. Le cas signale un empaquetage fautif, d'où le journal.
        return check_version_error(
            f"version installée illisible ({current_version!r})", current_version
        )

    # Une Release malformée ne doit pas faire échouer toute la vérification :
    # chaque entrée est validée pour elle-même et ignorée si elle ne tient pas.
    newer = [
        entry for entry in map(_release_entry, releases)
        if entry is not None and entry['parsed_version'] > installed
    ]
    if not newer:
        return _empty_payload(current_version, checked=True)

    newer.sort(key=lambda entry: entry['parsed_version'], reverse=True)
    versions = [
        {key: value for key, value in entry.items() if key != 'parsed_version'}
        for entry in newer
    ]
    latest = versions[0]

    return {
        "error": False,
        "checked": True,
        "update_available": True,
        "skipped": False,
        "current_version": current_version,
        "latest_version": {
            "version": latest['version'],
            "date": latest['release_date'],
            "download_url": latest['download_url'],
            "release_url": latest['release_url'],
        },
        "versions": versions,
    }


def should_check(last_check, force=False, now=None):
    """Faut-il interroger GitHub, ou la dernière vérification est-elle récente ?

    `last_check` est l'horodatage ISO-8601 de la dernière vérification aboutie.
    Une valeur absente, illisible ou postérieure à maintenant (horloge reculée)
    relance la vérification : le repli sûr est de vérifier, pas de se taire.
    """
    if force or not last_check:
        return True
    try:
        last = datetime.fromisoformat(str(last_check))
    except (TypeError, ValueError):
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    if last > reference:
        return True
    return reference - last >= CHECK_INTERVAL


def now_iso():
    """Horodatage à enregistrer dans les préférences après une vérification."""
    return datetime.now(timezone.utc).isoformat(timespec='seconds')
