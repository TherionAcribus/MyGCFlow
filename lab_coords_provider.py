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
_READ_CHUNK = 64 * 1024
# ~1 Mo mesurés pour un GPX de 50 UUID sans descriptions : borne très large
# contre un flux qui s'emballerait (service défaillant, mauvaise réponse).
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
# Borne du travail complet : une récupération n'a pas à tourner sans fin
# (service lent, reprises en cascade) — 30 min ≈ 130 lots nominaux.
DEFAULT_MAX_DURATION_S = 30 * 60
# Certains UUID (Adventures archivées/cassées) font échouer tout un lot en
# HTTP 500 : le lot est isolé par bissection jusqu'à l'UUID fautif.
USER_AGENT = "MyGCFlow/lab-import (+https://github.com/TherionAcribus/MyGCFlow)"


@dataclass
class FetchResult:
    """GPX récupérés + UUID restés irrécupérables après bissection."""
    payloads: list = field(default_factory=list)   # (nom, bytes) GPX par lot
    failed_uuids: list = field(default_factory=list)
    fetched_adventures: int = 0


class FetchCancelled(Exception):
    """Annulation demandée par l'utilisateur : le parcours s'arrête au
    prochain point de contrôle (lot, bissection, reprise ou pause) — ce qui
    est déjà téléchargé et remis via `on_payload` reste acquis."""


class ResponseTooLarge(Exception):
    """Réponse au-delà de la borne d'un GPX : traitée comme une erreur de
    lot — la bissection peut faire repasser chaque moitié sous la borne."""


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


def _read_bounded(resp, max_bytes: int) -> bytes:
    """Lit la réponse par blocs : un flux dépassant `max_bytes` est coupé
    (ResponseTooLarge) au lieu d'être chargé entièrement en mémoire."""
    parts, total = [], 0
    while True:
        chunk = resp.read(_READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ResponseTooLarge(
                f"réponse lab2gpx au-delà de {max_bytes // (1024 * 1024)} Mo")
        parts.append(chunk)
    return b"".join(parts)


def _checked_sleep(seconds: float, is_cancelled, deadline, now, sleep):
    """Attente découpée en tranches courtes : annulation (`is_cancelled`) et
    borne de durée (`deadline`, horloge `now`) n'attendent pas la fin."""
    remaining = seconds
    while remaining > 0:
        if is_cancelled and is_cancelled():
            raise FetchCancelled()
        if deadline is not None and now() > deadline:
            raise TimeoutError("durée maximale de récupération dépassée")
        step = min(0.25, remaining)
        sleep(step)
        remaining -= step


def post_download(payload: dict, retries: int = MAX_RETRIES,
                  timeout: int = REQUEST_TIMEOUT_S,
                  retry_server_errors: bool = True,
                  is_cancelled=None, deadline=None, now=time.monotonic,
                  sleep=time.sleep,
                  max_bytes: int = MAX_RESPONSE_BYTES) -> bytes:
    """Un POST /download avec reprise exponentielle sur HTTP 5xx et timeouts.

    Les erreurs non transitoires (4xx) ne sont pas retentées : ce sont les
    mêmes réponses que le bissection doit isoler. `retry_server_errors=False`
    remonte aussi un 5xx sans attendre (429 reste retenté) : pour un lot
    encore divisible, la bissection est déjà la reprise. `is_cancelled()`
    est vérifié avant chaque tentative et pendant l'attente de reprise — une
    annulation évite la reprise. `deadline` (horloge `now`) borne le travail
    complet : dépassée, chaque tentative et chaque attente remonte
    `TimeoutError`. La réponse est lue par blocs et bornée à `max_bytes`."""
    body = json.dumps(payload).encode("utf-8")
    last_exc = None
    for attempt in range(1, retries + 1):
        if is_cancelled and is_cancelled():
            raise FetchCancelled()
        attempt_timeout = timeout
        if deadline is not None:
            left = deadline - now()
            if left <= 0:
                raise TimeoutError("durée maximale de récupération dépassée")
            attempt_timeout = max(1, min(timeout, int(left)))
        try:
            req = urllib.request.Request(
                API_URL, data=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "*/*",
                    "User-Agent": USER_AGENT,
                },
            )
            with urllib.request.urlopen(req, timeout=attempt_timeout) as resp:
                return _read_bounded(resp, max_bytes)
        except urllib.error.HTTPError as exc:
            last_exc = exc
            # 4xx : erreur définitive (UUID fautif dans le lot) — remonter de
            # suite pour la bissection ; 5xx/429 : transitoire, réessayer.
            if 400 <= exc.code < 500 and exc.code != 429:
                raise
            if not retry_server_errors and exc.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
        if attempt < retries:
            _checked_sleep(DEFAULT_DELAY_S * attempt,
                           is_cancelled, deadline, now, sleep)
    raise last_exc


def fetch_gpx_batches(
    uuids: list[str],
    user_guid: str | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    delay: float = DEFAULT_DELAY_S,
    progress=None,
    sleep=time.sleep,
    on_payload=None,
    on_failed=None,
    is_cancelled=None,
    max_duration_s: float = DEFAULT_MAX_DURATION_S,
    now=time.monotonic,
) -> FetchResult:
    """Télécharge un GPX par lot d'UUID, en isolant les UUID fautifs.

    `progress(fait, total)` est appelé après chaque lot résolu ou isolé ;
    `sleep` est injectable pour les tests. `on_payload(nom, gpx, uuids)`
    reçoit chaque GPX dès son téléchargement, avec les UUID du lot auquel le
    service vient de répondre, au lieu de `result.payloads` : ce qui est déjà
    traité survit ainsi à un abandon ultérieur. `on_failed(uuid)`
    signale de même chaque UUID isolé comme irrécupérable.
    `is_cancelled()` rend un arrêt coopératif (`FetchCancelled`), vérifié
    entre deux lots, avant une bissection, avant chaque reprise et pendant
    la pause entre lots. `max_duration_s` (horloge `now`) borne le travail
    complet : dépassée, `TimeoutError` est levé au prochain point de
    contrôle et se comporte comme une panne — les lots déjà remis via
    `on_payload` restent acquis. `None` la désactive.

    Stratégie d'erreur (calquée sur tools/fetch_lab2gpx.py) :
    - HTTPError quel que soit le code → bissection : les Adventures cassées
      ou archivées font échouer tout le lot, souvent en 500 — les isoler est
      le seul moyen de sauver le reste. Un 500 n'est donc retenté sur place
      que pour un UUID seul, où il décide du verdict « irrécupérable » ;
    - erreur réseau/timeout épuisée → abandon : un service ou une connexion
      en panne n'est pas une donnée à isoler ;
    - budget d'échecs HTTP consécutifs → abandon : borne la panne 5xx
      persistante, qui sinon ferait bissecter des milliers d'UUID."""
    result = FetchResult()
    uuids = list(dict.fromkeys(uuids))  # dédoublonnage, ordre conservé
    total = max(1, len(uuids))
    done = 0
    consecutive_failures = 0
    deadline = now() + max_duration_s if max_duration_s else None

    def check_cancel():
        if is_cancelled and is_cancelled():
            raise FetchCancelled()

    def check_deadline():
        if deadline is not None and now() > deadline:
            raise TimeoutError("durée maximale de récupération dépassée")

    def report():
        if progress:
            progress(done, total)

    def pause(seconds: float):
        # Pause entre lots : vérifiée par tranches courtes — annulation et
        # borne de durée n'attendent pas la fin de la pause.
        remaining = seconds
        while remaining > 0:
            check_cancel()
            check_deadline()
            step = min(0.25, remaining)
            sleep(step)
            remaining -= step

    def fetch_batch(batch: list[str], tag: str):
        nonlocal done, consecutive_failures
        if not batch:
            return
        # Point de contrôle : entre deux lots comme avant chaque moitié
        # d'une bissection (les appels récursifs repassent ici).
        check_cancel()
        check_deadline()
        try:
            data = post_download(build_payload(batch, user_guid),
                                 retry_server_errors=len(batch) == 1,
                                 is_cancelled=is_cancelled,
                                 deadline=deadline, now=now, sleep=sleep)
        except (urllib.error.HTTPError, ResponseTooLarge):
            consecutive_failures += 1
            if consecutive_failures > 12:
                raise   # panne persistante côté service — pas des données
            if len(batch) == 1:
                result.failed_uuids.append(batch[0])
                if on_failed:
                    on_failed(batch[0])
                done += 1
                report()
                return
            mid = len(batch) // 2
            fetch_batch(batch[:mid], f"{tag}a")
            fetch_batch(batch[mid:], f"{tag}b")
            return
        consecutive_failures = 0
        name = f"lab2gpx-auto-{tag}.gpx"
        if on_payload:
            on_payload(name, data, list(batch))
        else:
            result.payloads.append((name, data))
        done += len(batch)
        report()
        if done < total:
            # Pause entre requêtes uniquement — rien n'attend après le
            # dernier lot résolu.
            pause(delay)

    for i in range(0, len(uuids), batch_size):
        fetch_batch(uuids[i:i + batch_size], f"{i // batch_size + 1:03d}")
    result.fetched_adventures = len(uuids) - len(result.failed_uuids)
    return result
