"""Fournisseur de coordonnées Adventure Lab via l'API publique lab2gpx.

`POST https://api.lab2gpx.gcutils.de/download` accepte une liste d'UUID
d'Adventures (`uuidsToFetch`) sans compte ni clé — endpoint documenté dans le
dépôt du service (api/src/request/download-by-uuid.http, mirsch/lab2gpx).
C'est le même service que l'utilisateur sollicite manuellement via le site
lab2gpx ; l'appel est fait ici côté serveur, sur consentement explicite
(`labs_auto_fetch_coords`), avec débit modéré, timeouts et reprise.

Le GPX produit (un waypoint par étape, UUID d'étape en gsak:Guid) est reparsé
par `lab_formats.parse_lab2gpx_gpx` : tout le chemin d'enrichissement
(jointure par UUID exacte, conflits, provenance `lab2gpx`) est réutilisé.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

API_URL = "https://api.lab2gpx.gcutils.de/download"

DEFAULT_BATCH_SIZE = 50
DEFAULT_DELAY_S = 2.0        # pause entre lots — débit modéré
REQUEST_TIMEOUT_S = 120      # ~11 s mesurés pour 50 UUID ; marge large
MAX_RETRIES = 4
# Certains UUID (Adventures archivées/cassées) font échouer tout un lot en
# HTTP 500 : le lot est isolé par bissection jusqu'à l'UUID fautif.
USER_AGENT = "MyGCFlow/lab-import (+https://github.com/TherionAcribus/MyGCFlow)"


@dataclass
class FetchResult:
    """GPX récupérés + UUID restés irrécupérables après bissection."""
    payloads: list = field(default_factory=list)   # (nom, bytes) GPX par lot
    failed_uuids: list = field(default_factory=list)
    fetched_adventures: int = 0


def build_payload(uuids: list[str], user_guid: str | None = None) -> dict:
    """Corps de la requête /download en mode uuidsToFetch (cf. fetch_lab2gpx.py)."""
    return {
        "locale": "en",
        # Requis par la validation du service, ignorés en mode uuidsToFetch.
        "coordinates": {"lat": 0, "lon": 0},
        "radius": 1,
        "limit": 0,
        "cacheType": "Lab Cache",
        "prefix": "LC",
        "linear": "default",
        "userGuid": user_guid,
        "completionStatuses": ["0", "1", "2"],
        # Descriptions inutiles pour la jointure — allège beaucoup le GPX.
        "includeQuestion": False,
        "includeWaypointDescription": False,
        "includeCacheDescription": False,
        "outputFormat": "gpx",
        "uuidsToFetch": ",".join(uuids),
    }


def post_download(payload: dict, retries: int = MAX_RETRIES,
                  timeout: int = REQUEST_TIMEOUT_S) -> bytes:
    """Un POST /download avec reprise exponentielle sur HTTP 5xx et timeouts.

    Les erreurs non transitoires (4xx) ne sont pas retentées : ce sont les
    mêmes réponses que le bissection doit isoler."""
    body = json.dumps(payload).encode("utf-8")
    last_exc = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                API_URL, data=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "*/*",
                    "User-Agent": USER_AGENT,
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last_exc = exc
            # 4xx : erreur définitive (UUID fautif dans le lot) — remonter de
            # suite pour la bissection ; 5xx/429 : transitoire, réessayer.
            if 400 <= exc.code < 500 and exc.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
        if attempt < retries:
            time.sleep(DEFAULT_DELAY_S * attempt)
    raise last_exc


def fetch_gpx_batches(
    uuids: list[str],
    user_guid: str | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    delay: float = DEFAULT_DELAY_S,
    progress=None,
    sleep=time.sleep,
) -> FetchResult:
    """Télécharge un GPX par lot d'UUID, en isolant les UUID fautifs.

    `progress(fait, total)` est appelé après chaque lot résolu ou isolé ;
    `sleep` est injectable pour les tests.

    Stratégie d'erreur (calquée sur tools/fetch_lab2gpx.py) :
    - HTTPError quel que soit le code → bissection : les Adventures cassées
      ou archivées font échouer tout le lot, souvent en 500 — les isoler est
      le seul moyen de sauver le reste ;
    - erreur réseau/timeout épuisée → abandon : un service ou une connexion
      en panne n'est pas une donnée à isoler ;
    - budget d'échecs HTTP consécutifs → abandon : borne la panne 5xx
      persistante, qui sinon ferait bissecter des milliers d'UUID."""
    result = FetchResult()
    uuids = list(dict.fromkeys(uuids))  # dédoublonnage, ordre conservé
    total = max(1, len(uuids))
    done = 0
    consecutive_failures = 0

    def report():
        if progress:
            progress(done, total)

    def fetch_batch(batch: list[str], tag: str):
        nonlocal done, consecutive_failures
        if not batch:
            return
        try:
            data = post_download(build_payload(batch, user_guid))
        except urllib.error.HTTPError as exc:
            consecutive_failures += 1
            if consecutive_failures > 12:
                raise   # panne persistante côté service — pas des données
            if len(batch) == 1:
                result.failed_uuids.append(batch[0])
                done += 1
                report()
                return
            mid = len(batch) // 2
            fetch_batch(batch[:mid], f"{tag}a")
            fetch_batch(batch[mid:], f"{tag}b")
            return
        consecutive_failures = 0
        result.payloads.append((f"lab2gpx-auto-{tag}.gpx", data))
        done += len(batch)
        report()
        sleep(delay)

    for i in range(0, len(uuids), batch_size):
        fetch_batch(uuids[i:i + batch_size], f"{i // batch_size + 1:03d}")
    result.fetched_adventures = len(uuids) - len(result.failed_uuids)
    return result
