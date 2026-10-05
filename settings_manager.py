from __future__ import annotations
from dataclasses import dataclass, field, asdict
from pathlib import Path
import copy
import functools
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from typing import Callable, Tuple, Optional, List


APP_NAME = "MyGCFlow"
# Nom historique (GCMap) : sert à reprendre la configuration d'une installation
# antérieure au changement de nom. À retirer quand plus aucune installation
# n'est concernée.
LEGACY_APP_NAME = "GCMap"
COORDINATE_ORDER_VERSION = 2
# Lots de profils d'exemple. Une installation ne reçoit que les lots plus récents
# que celui qu'elle a déjà vu : supprimer volontairement un ancien exemple ne le
# fait donc pas revenir lors de l'ajout d'une nouvelle collection.
EXAMPLE_PROFILE_BATCHES = {
    2: {"Épure", "Cinématique"},
    3: {
        "Encre & Papier",
        "Aurore Polaire",
        "Sakura Pastel",
        "Signal Technique",
        "Randonnée Topo",
    },
    # Thèmes du mode Évolution : points minuscules et flashs courts, pour des
    # dizaines de milliers de caches (voir PROFILE_MODES).
    4: {"Évolution Classique", "Évolution Black", "Évolution Encre", "Évolution Nuit"},
}
EXAMPLES_VERSION = max(EXAMPLE_PROFILE_BATCHES)
# Thème chargé à la toute première ouverture. Sans lui, l'application démarrait
# sans thème actif : l'écran affichait les valeurs de defaultValues.json, qui ne
# correspondent à aucun thème de la liste, et les réglages faits alors n'étaient
# rattachés à rien (ni indicateur « • », ni avertissement avant fermeture).
FIRST_LAUNCH_PROFILE = "Default"
# Son équivalent pour la page /evolution, dont la liste de thèmes est séparée.
FIRST_LAUNCH_EVOLUTION_PROFILE = "Évolution Classique"
# Mode auquel un thème appartient. Chaque page ne liste que les siens : un
# thème réglé pour quelques milliers de trouvailles (points de 5 à 10 px)
# noie la carte en mode Évolution, et l'inverse y est illisible. Un fichier
# sans ce champ est un thème du mode principal (tous ceux d'avant la séparation).
PROFILE_MODE_MAIN = "main"
PROFILE_MODE_EVOLUTION = "evolution"
PROFILE_MODES = (PROFILE_MODE_MAIN, PROFILE_MODE_EVOLUTION)
# Compatibilité avec les tests et extensions qui importent encore ce nom.
EXAMPLES_ADDED_AFTER_V1 = set().union(*EXAMPLE_PROFILE_BATCHES.values())
MAX_OVERLAY_TITLE_LENGTH = 500
MAX_OVERLAY_CSS_LENGTH = 20_000


def _tr(msgid: str, **kwargs) -> str:
    """Traduit via Flask-Babel si un contexte d'application existe, msgid brut sinon.

    Ce module est aussi utilisé hors contexte Flask (tests unitaires, scripts) :
    un appel direct à gettext lèverait RuntimeError, et les apps de test sans
    extension Babel provoqueraient un KeyError. Le repli renvoie le msgid
    français, qui reste la chaîne de référence du catalogue.
    """
    try:
        from flask_babel import gettext
        return gettext(msgid, **kwargs)
    except Exception:
        return msgid % kwargs if kwargs else msgid


def sanitize_overlay_css(value) -> str:
    """Conserve des déclarations locales sûres pour un profil importable."""
    if not isinstance(value, str):
        return ""
    safe = []
    for declaration in value[:MAX_OVERLAY_CSS_LENGTH].split(";"):
        if ":" not in declaration:
            continue
        prop, raw_value = declaration.split(":", 1)
        prop = prop.strip()
        raw_value = raw_value.strip()
        if not prop or not raw_value:
            continue
        if prop.lower() == "display" or "url(" in raw_value.lower():
            continue
        safe.append(f"{prop}: {raw_value}")
    return ";\n".join(safe) + (";" if safe else "")


def coerce_overlay_title(value, default: str = "My Geocaching Map") -> str:
    if not isinstance(value, str):
        return default
    return value[:MAX_OVERLAY_TITLE_LENGTH]


def adopt_legacy_dir(current: Path, legacy: Path) -> None:
    """Reprend le dossier de l'ancien nom (GCMap) s'il est le seul présent.

    Renommage atomique : les deux dossiers sont sur le même volume. Sans effet
    si le dossier actuel existe déjà (l'utilisateur a déjà démarré la nouvelle
    version) ou si l'ancien n'existe pas. Un échec n'est jamais bloquant :
    l'application repart alors d'une configuration vierge.
    """
    if current == legacy or current.exists() or not legacy.is_dir():
        return
    try:
        current.parent.mkdir(parents=True, exist_ok=True)
        os.rename(legacy, current)
        logging.getLogger(__name__).info(
            "Configuration reprise depuis %s vers %s", legacy, current
        )
    except OSError as exc:
        logging.getLogger(__name__).warning(
            "Reprise de %s impossible : %s", legacy, exc
        )


def app_config_dir() -> Path:
    # MYGCFLOW_CONFIG_DIR redirige la configuration entière (préférences + profils)
    # vers un dossier choisi par l'appelant. Utilisé par le harnais Playwright :
    # sans lui, un test qui change le thème ou un réglage vidéo écrirait dans la
    # configuration réelle de l'utilisateur.
    # GCMAP_CONFIG_DIR est l'ancien nom de cette variable, encore accepté.
    override = os.getenv("MYGCFLOW_CONFIG_DIR") or os.getenv("GCMAP_CONFIG_DIR")
    if override:
        return Path(override)
    # Windows: %APPDATA%\MyGCFlow ; fallback vers home si non défini
    base = Path(os.getenv("APPDATA") or os.path.expanduser("~"))
    current = base / APP_NAME
    adopt_legacy_dir(current, base / LEGACY_APP_NAME)
    return current


CONFIG_DIR = app_config_dir()
PROFILES_DIR = CONFIG_DIR / "profiles"
SETTINGS_PATH = CONFIG_DIR / "settings.json"


def backup_path(path: Path) -> Path:
    """Copie de sécurité laissée par atomic_write() à côté de `path`."""
    return path.with_suffix(path.suffix + ".bak")


# Sous Windows, os.replace() échoue (PermissionError) tant qu'un autre handle
# tient le fichier cible ouvert : une lecture concurrente, un antivirus ou
# l'indexeur de recherche. Ces ouvertures ne durent que quelques millisecondes,
# quelques nouvelles tentatives suffisent.
_REPLACE_ATTEMPTS = 5
_REPLACE_RETRY_DELAY_S = 0.05


def atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Temporaire propre à chaque écriture : un nom fixe (« x.json.tmp ») était
    # partagé par deux écritures simultanées du même fichier, qui pouvaient
    # alors s'écraser mutuellement ou déplacer le temporaire de l'autre.
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(data, encoding="utf-8")
        if path.exists():
            try:
                shutil.copy2(path, backup_path(path))
            except Exception:
                pass
        for attempt in range(_REPLACE_ATTEMPTS):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == _REPLACE_ATTEMPTS - 1:
                    raise
                time.sleep(_REPLACE_RETRY_DELAY_S)
    finally:
        # Échec d'écriture ou de remplacement : ne pas laisser de temporaire.
        tmp.unlink(missing_ok=True)


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_json(path: Path, obj: dict) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))


@dataclass
class RecordingSettings:
    """Réglages d'enregistrement vidéo.

    Préférence globale (comme la langue), pas un réglage de profil : ils
    décrivent la machine et le navigateur de l'utilisateur, pas le style de la
    carte. Stockés côté serveur pour survivre à un changement de navigateur ou
    à un vidage du cache (l'ancien stockage était localStorage seul).

    Ces valeurs par défaut doivent rester identiques à celles de
    static/json/defaultValues.json : tant que `recording_configured` est faux,
    c'est le fichier JSON que le client applique, sans lire celles-ci. Une
    divergence est donc invisible côté serveur mais visible à l'écran — c'est ce
    qui laissait un nouvel utilisateur sur le mode « images » avec tous les
    réglages MediaRecorder masqués. Un test verrouille l'égalité
    (RecordingDefaultsMatchTheClientTests).
    """
    mode: str = "mediarecorder"  # "mediarecorder" | "images"
    # Résolution de sortie du mode images : "window" (taille de la fenêtre,
    # comportement historique) ou une hauteur cible. La carte est alors rendue
    # plus finement pendant la capture (cf. static/js/capture_resolution.mjs).
    capture_resolution: str = "window"
    # "compatible" (yuv420p, lisible partout) ou "fidele" (yuv444p, couleurs
    # exactes mais refusé par certains lecteurs et téléviseurs).
    color_fidelity: str = "compatible"
    fps: int = 30
    mime_type: str = "video/webm;codecs=vp9"
    bitrate_mbps: int = 6
    slowdown_factor: int = 1
    scale_factor: float = 1.0
    upload_to_server: bool = True
    download_local: bool = True
    offline_normalization: bool = True
    audio_enabled: bool = False
    audio_volume: float = 1.0


@dataclass
class AppSettings:
    version: int = COORDINATE_ORDER_VERSION
    language: str = "fr"
    check_updates: bool = True
    # Horodatage ISO-8601 (UTC) de la dernière vérification de mise à jour
    # aboutie. Sert à espacer les vérifications automatiques : sans lui, chaque
    # lancement interrogeait GitHub et rouvrait la modale déjà vue.
    last_update_check: Optional[str] = None
    # Version pour laquelle l'utilisateur a cliqué sur « Ignorer cette version ».
    # Seule la vérification automatique en tient compte, et seulement tant que
    # c'est encore la plus récente : une version ultérieure sera bien annoncée.
    skipped_update_version: Optional[str] = None
    theme: str = "system"  # "system" | "light" | "dark"
    # Format d'affichage des dates : "auto" suit la langue (fr → jj/mm/aaaa,
    # en → mm/jj/aaaa) ; "eu" et "us" forcent le format quelle que soit la langue.
    date_format: str = "auto"  # "auto" | "eu" | "us"
    default_profile_uid: Optional[str] = None  # UUID du profil par défaut (None = aucun)
    # UUID du dernier profil rendu actif par l'utilisateur (None = aucun). C'est
    # lui que le démarrage restaure ; `default_profile_uid` ne sert plus que de
    # repli, pour qu'un profil enregistré puis retrouvé au lancement suivant ne
    # dépende pas d'un passage par « Définir comme par défaut ».
    last_profile_uid: Optional[str] = None
    # Interrupteur « Toujours démarrer sur ce thème » (onglet Paramètres).
    # False (défaut) : le démarrage restaure `last_profile_uid`, le profil par
    # défaut ne servant que de repli. True : `default_profile_uid` passe en
    # premier, le dernier profil utilisé n'étant alors que le repli.
    startup_default_profile: bool = False
    # Mêmes rôles pour la page /evolution, qui a sa propre liste de thèmes
    # (MapProfile.mode) : sans ces deux clés, changer de page rappellerait un
    # thème de l'autre mode.
    evolution_default_profile_uid: Optional[str] = None
    evolution_last_profile_uid: Optional[str] = None
    # Convention persistée/API : (longitude, latitude).
    map_default_center: Optional[Tuple[float, float]] = None
    map_default_zoom: Optional[int] = None
    # Cadrage de la carte quand des données sont chargées : "fit" ajuste la vue
    # sur l'emprise des caches (défaut), "custom" applique le centre et le zoom
    # ci-dessus — choisis dans l'onglet Paramètres.
    map_framing: str = "fit"
    recording: RecordingSettings = field(default_factory=RecordingSettings)
    # True dès que l'utilisateur a enregistré des réglages vidéo côté serveur.
    # Sert uniquement à la reprise des anciens réglages : tant qu'il est False,
    # le client sait qu'il peut pousser ceux restés dans son localStorage (voir
    # migrateLegacyRecordSettings dans static/js/ui.js). Sans ce drapeau,
    # `recording` renvoyant toujours des valeurs par défaut, « jamais configuré »
    # serait indiscernable de « configuré avec les valeurs par défaut ».
    recording_configured: bool = False
    # Rythme et déroulement temporel de l'animation : préférences GLOBALES,
    # persistées dans settings.json comme `recording`. Elles ne vivent jamais
    # dans un thème (MapProfile) : changer de thème ne doit pas modifier le
    # timing, le rythme ni le suivi de caméra.
    animation: "AnimationPrefs" = field(default_factory=lambda: AnimationPrefs())
    # Mode Évolution (page /evolution) : son propre rythme, pour qu'un réglage
    # adapté à des décennies de données (150 jours/s) ne déborde pas sur le
    # mode principal, et la dernière base ouverte, restaurée au retour.
    evolution_animation: "AnimationPrefs" = field(default_factory=lambda: evolution_animation_defaults())
    evolution_dataset_id: Optional[int] = None
    # Ligne d'informations du mode Évolution : texte libre avec balises
    # ({date}, {actives}, {placees}, {archivees}, {total}) remplacées par les
    # valeurs courantes. Une chaîne vide masque la ligne.
    evolution_infos_template: str = '{date} · {actives}'
    # Mode Évolution : sort des caches archivées sans date d'archivage.
    # "hide" (défaut) : elles ne figurent ni sur la carte ni dans les
    #   compteurs (on ne sait pas quand elles ont disparu, rien à animer).
    # "keep" : elles restent affichées jusqu'à la fin, comme les actives.
    # "expire" : elles apparaissent puis disparaissent à la date du dernier
    #   export, seul instant où l'on sait qu'elles n'existaient plus.
    evolution_undated_archives: str = "hide"  # "hide" | "keep" | "expire"
    examples_seeded: bool = False  # True une fois les profils d'exemple créés (premier lancement)
    # Lot de profils d'exemple déjà installé. Permet d'ajouter des exemples dans
    # une version ultérieure sans les réinstaller à chaque démarrage, ni faire
    # revenir ceux que l'utilisateur a supprimés (voir EXAMPLES_VERSION).
    examples_version: int = 0


@dataclass
class VectorMapOptions:
    stroke_color: str = "#000000"
    fill_color: str = "#ff5722"
    background_color: str = "#ffffff"
    stroke_width: float = 2.5

@dataclass
class TonerMapOptions:
    variant: str = "light"  # "light" or "dark"

@dataclass
class MapOptions:
    tile_provider: str = "OSM"
    vector_options: VectorMapOptions = field(default_factory=VectorMapOptions)
    toner_options: TonerMapOptions = field(default_factory=TonerMapOptions)
    # Réservé à l'avenir: support d'options spécifiques providers (souples)
    # extra: dict = field(default_factory=dict)
    # Le centre et le zoom par défaut ne font PAS partie du thème : ce sont un
    # état de vue (session) / des préférences globales (AppSettings
    # map_default_center / map_default_zoom). Les anciens fichiers de profil
    # peuvent encore contenir ces clés : elles sont ignorées à la lecture.


@dataclass
class AnimationPrefs:
    """Préférences globales de rythme/timing (hors thème et hors enregistrement).

    Persistées sous la clé `animation` de settings.json. Les bornes reflètent
    TIMING_LIMITS de static/js/video_timing.mjs : un settings.json édité à la
    main ne doit pas pouvoir produire une animation impossible.
    """
    rhythm_mode: str = "rate"  # "rate" | "duration" | "music"
    days_per_second: float = 20.0
    total_duration_seconds: float = 60.0
    extra_end_seconds: float = 0.0
    # La vue suit les caches du jour selon une zone de confort réglable.
    camera_follow: bool = False
    camera_dynamism: int = 2
    # Miroir persisté de la durée du flash : le réglage appartient au thème
    # (FlashOptions.duration), cette clé reste la valeur de repli au démarrage
    # quand aucun thème ne s'applique, et pour les anciens thèmes sans durée.
    flash_duration_ms: int = 1000
    # Durée maximale du tracé d'une étape du trajet (même logique que la durée
    # du flash) ; raccourcie à l'exécution quand les jours défilent plus vite.
    trail_duration_ms: int = 800


def evolution_animation_defaults() -> AnimationPrefs:
    """Rythme par défaut du mode Évolution : une minute pour tout le jeu.

    Un export couvre souvent plus de vingt ans : au rythme du mode principal
    (20 jours/s), l'animation durerait plusieurs minutes. Le suivi de caméra
    n'y a pas de sens (des milliers de caches à la fois) et reste désactivé.
    """
    return AnimationPrefs(
        rhythm_mode="duration",
        days_per_second=150.0,
        total_duration_seconds=60.0,
        camera_follow=False,
        flash_duration_ms=500,
    )


@dataclass
class DisappearFlashOptions:
    """Flash de disparition d'une cache (mode Évolution, à son archivage)."""
    mode: str = "implode"  # "none", "implode", "target", "circle", "star", "sparkle", "square", "triangle", "diamond"
    size: int = 30  # en px
    # Gris plutôt que rouge : le rouge est déjà la couleur des events.
    color: str = "#9E9E9E"
    color_type: str = "fix"  # "gc", "none", "fix"
    # Contour des formes qui en ont un (étoile, scintillement, carré, ...) :
    # "auto" garde la couleur historique du mode (noir, blanc pour le
    # scintillement).
    border_color: str = "#000000"
    border_color_type: str = "auto"  # "auto", "gc", "none", "fix"


@dataclass
class FlashOptions:
    mode: str = "circle"  # "none", "circle", "impulse", "implode", "echo", "target", "star", "sparkle", "square", "triangle", "diamond"
    # Durée (ms) : caractère du flash autant que sa forme — un flash sec de
    # 300 ms et un halo lent de 2 s sont deux styles différents.
    duration: int = 1000
    size: int = 50  # en px
    color: str = "#FF00FF"
    color_type: str = "fix"  # "gc", "none", "fix"
    # Contour des formes qui en ont un : "auto" garde la couleur historique du
    # mode ; en petit taille de scintillement, seul le contour reste visible.
    border_color: str = "#000000"
    border_color_type: str = "auto"  # "auto", "gc", "none", "fix"
    disappear: DisappearFlashOptions = field(default_factory=DisappearFlashOptions)


@dataclass
class TrailOptions:
    """Traits de déplacement : le trajet du géocacheur d'une étape à l'autre.

    Mêmes valeurs par défaut que TRAIL_DEFAULTS (static/js/travel_trail.mjs) et
    le bloc `trail` de static/json/defaultValues.json. La durée du tracé n'en
    fait pas partie : c'est un réglage temporel (AnimationPrefs).
    """
    enabled: bool = False
    routing: str = "clusters"  # "day", "clusters", "all"
    cluster_km: float = 2.0  # rayon de regroupement des caches d'un jour
    jump_km: int = 150  # au-delà, le segment est un « grand saut »
    jump_style: str = "arc"  # "arc", "dashed", "straight", "hidden"
    curve: str = "straight"  # "straight", "smooth"
    color: str = "#00B8D4"
    width: int = 3  # en px
    opacity: int = 85  # en %
    line_style: str = "solid"  # "solid", "dashed", "dotted"
    effect: str = "none"  # "none", "glow"
    head: str = "dot"  # "none", "dot", "pulse"
    persist_days: int = 30  # 0 = tout le parcours reste affiché


@dataclass
class PointStyle:
    size: int = 8
    color: str = "#ff5722"
    shape: str = "circle"
    halo: bool = False
    border_color: str = "#000000"
    border_size: int = 0
    fill_color_type: str = "fix"  # "gc", "none", "fix"
    border_color_type: str = "fix"  # "gc", "none", "fix"
    mode: str = "vectoriel"  # "icone", "vectoriel"
    icon_set: str = "geocaching"
    icon_size: int = 24
    appear_animation: bool = False  # apparition animée (agrandissement + rebond)
    # Fenêtre de persistance des points récents, en jours (0 = désactivée) :
    # les caches des derniers jours restent plus claires et un peu plus grosses.
    recent_glow_days: int = 0


@dataclass
class InfosTitle:
    display: bool = True
    text: str = "My Geocaching Map"


@dataclass
class InfosOptions:
    title: InfosTitle = field(default_factory=InfosTitle)
    number_of_caches: bool = True
    current_date: bool = True
    title_css: str = ""
    infos_css: str = ""


@dataclass
class MapProfile:
    """Un thème : réglages VISUELS uniquement.

    Ni le rythme/timing (animation), ni le centre et le zoom de la carte n'y
    figurent : les anciens fichiers contenant ces blocs restent lisibles (les
    clés inconnues sont ignorées par coerce_profile) mais elles ne sont plus
    écrites ni appliquées. La durée du flash y figure en revanche : elle fait
    partie du caractère du flash autant que sa forme (FlashOptions.duration).
    """
    version: int = COORDINATE_ORDER_VERSION
    name: str = "Default"
    uid: str = field(default_factory=lambda: uuid.uuid4().hex)
    # Page à laquelle le thème appartient (PROFILE_MODES). Jamais modifié par
    # une sauvegarde : on change un thème de mode en le copiant
    # (SettingsManager.copy_profile_to_mode).
    mode: str = PROFILE_MODE_MAIN
    map: MapOptions = field(default_factory=MapOptions)
    points: PointStyle = field(default_factory=PointStyle)
    flash: FlashOptions = field(default_factory=FlashOptions)
    infos: InfosOptions = field(default_factory=InfosOptions)
    trail: TrailOptions = field(default_factory=TrailOptions)


class InvalidProfileNameError(ValueError):
    """Nom de profil inutilisable (vide une fois réduit au nom de fichier).

    Sous-classe de ValueError pour rester attrapée par le code existant, mais
    distincte pour que l'API réponde 400 (saisie invalide) plutôt que 404/409.
    """


def _to_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp_int(value, default: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, _to_int(value, default)))


def _clamp_float(value, default: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, _to_float(value, default)))


def _coerce_optional_str(value) -> Optional[str]:
    """Chaîne non vide, ou None. Tout autre type (nombre, objet) vaut None."""
    return value if isinstance(value, str) and value.strip() else None


def _coerce_choice(value, choices: tuple, default: str) -> str:
    return value if value in choices else default


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _coerce_hex_color(value, default: str) -> str:
    # Les sélecteurs de couleur produisent du « #rrggbb », et hexToRgb()
    # (static/js/utils.js) ne sait lire que cette forme : une autre valeur
    # donnerait une couleur NaN, voire une exception sur un non-texte.
    return value if isinstance(value, str) and _HEX_COLOR_RE.match(value) else default


def _expand_hex_color(value):
    """« #abc » -> « #aabbcc » ; le sélecteur couleur HTML n'accepte que la forme longue."""
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return "#" + "".join(c * 2 for c in value[1:])
    return value


# Valeurs admises dans un thème. Miroir des contrôles de l'onglet Style
# (templates/menu_points.html, menu_flash.html, menu_style.html) et des fonds
# enregistrés par static/js/basemaps.js : un thème importé ou édité à la main
# ne doit pas pouvoir porter une valeur que l'interface ne sait ni afficher ni
# rendre. Hors de ces listes ou bornes, la valeur précédente est conservée.
TILE_PROVIDERS = ("OSM", "watercolor", "stamenToner", "vectorMap")
TONER_VARIANTS = ("light", "dark")
POINT_MODES = ("vectoriel", "icone")
POINT_SHAPES = ("circle", "triangle")
ICON_SETS = ("geocaching", "smiley")  # ICON_SETS de static/js/ui.js
COLOR_TYPES = ("gc", "none", "fix")
# Couleur du contour des formes de flash : « auto » garde le contour historique
# du mode (noir, blanc pour le scintillement), les autres valeurs sont celles
# de COLOR_TYPES.
FLASH_BORDER_TYPES = ("auto", "gc", "none", "fix")
FLASH_MODES = ("none", "circle", "impulse", "implode", "echo", "target", "star", "sparkle", "square", "triangle", "diamond")
# Flash de disparition (mode Évolution) : seuls les mouvements convergents ont
# du sens pour une cache qui s'éteint — ni la vague « impulse » ni l'écho,
# qui s'étendent depuis le point.
DISAPPEAR_FLASH_MODES = ("none", "implode", "target", "circle", "star", "sparkle", "square", "triangle", "diamond")
POINT_SIZE_RANGE = (1, 10)
BORDER_SIZE_RANGE = (0, 10)
ICON_SIZE_RANGE = (12, 40)
FLASH_SIZE_RANGE = (5, 200)
# Durée du flash (ms) : même plage que le champ inputTimeFlash.
FLASH_DURATION_RANGE = (100, 10000)
STROKE_WIDTH_RANGE = (0.0, 5.0)
RECENT_GLOW_DAYS_RANGE = (0, 365)
# Traits de déplacement : miroir de static/js/travel_trail.mjs (TRAIL_*).
TRAIL_ROUTINGS = ("day", "clusters", "all")
TRAIL_JUMP_STYLES = ("arc", "dashed", "straight", "hidden")
TRAIL_CURVES = ("straight", "smooth")
TRAIL_LINE_STYLES = ("solid", "dashed", "dotted")
TRAIL_EFFECTS = ("none", "glow")
TRAIL_HEADS = ("none", "dot", "pulse")
TRAIL_PERSIST_DAYS = (7, 30, 90, 365, 0)
TRAIL_CLUSTER_KM_RANGE = (0.1, 100.0)
TRAIL_JUMP_KM_RANGE = (10, 5000)
TRAIL_WIDTH_RANGE = (1, 20)
TRAIL_OPACITY_RANGE = (10, 100)


THEMES = ("system", "light", "dark")
RECORDING_MODES = ("mediarecorder", "images")
# Fidélité de couleur de l'encodage final. Miroir de COLOR_FIDELITIES dans
# capture.py (qui fait la conversion en pix_fmt) et static/js/color_fidelity.mjs.
COLOR_FIDELITIES = ("compatible", "fidele")
# Résolutions de sortie du mode images. Miroir de CAPTURE_RESOLUTIONS dans
# static/js/capture_resolution.mjs, qui fait le calcul côté client.
CAPTURE_RESOLUTIONS = ("window", "1080p", "1440p", "2160p")

# Plage de zoom acceptée par la carte, en miroir des attributs min/max de
# #inputMapDefaultZoom et de MAP_ZOOM_LIMITS (static/js/ui.js). Comme pour les
# réglages vidéo, la borne posée dans l'interface ne garantit rien : settings.json
# s'édite à la main et PUT /api/settings accepte le JSON qu'on lui envoie.
MAP_ZOOM_MIN = 0
MAP_ZOOM_MAX = 22

# Plages du centre par défaut, en miroir de la validation faite dans l'interface
# (saveMapCenterSettings, static/js/ui.js).
MAP_LONGITUDE_MAX = 180.0
MAP_LATITUDE_MAX = 90.0

# Modes de cadrage de la carte au chargement des données, en miroir du
# sélecteur #selectMapFraming (templates/menu_options.html) : « fit » ajuste
# la vue sur l'emprise des caches, « custom » applique map_default_center/zoom.
MAP_FRAMINGS = ("fit", "custom")


def coerce_map_framing(value, default: str = "fit") -> str:
    return value if value in MAP_FRAMINGS else default


def coerce_map_zoom(value, default: Optional[int] = None) -> Optional[int]:
    """Zoom ramené dans la plage de la carte ; `default` si la valeur est illisible.

    None reste None : « aucun zoom par défaut » est un choix, pas une absence de
    réglage à combler.
    """
    if value is None:
        return None
    try:
        return max(MAP_ZOOM_MIN, min(MAP_ZOOM_MAX, int(value)))
    except (TypeError, ValueError):
        return default


def coerce_map_center(value, default: Optional[Tuple[float, float]] = None) -> Optional[Tuple[float, float]]:
    """Couple (longitude, latitude) lisible et situé sur le globe, sinon `default`.

    Contrairement au zoom, une valeur hors plage n'est pas ramenée dans les
    bornes : une latitude de 200 ne « voulait » pas dire 90, et ramener une
    longitude de 400 à 180 désignerait un endroit que personne n'a choisi. Le
    client refuse déjà d'enregistrer un tel couple ; ici on conserve ce qui était
    en place plutôt que d'inventer un centre.

    Un couple absent ou de forme inattendue vaut « pas de centre » (None) : c'est
    ainsi que l'interface efface le réglage.
    """
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        lon, lat = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return default
    # Toute comparaison est fausse pour NaN, donc les valeurs non finies sortent
    # ici — et n'atteignent jamais settings.json, où `NaN` produirait un JSON
    # que les analyseurs stricts refusent.
    if not (-MAP_LONGITUDE_MAX <= lon <= MAP_LONGITUDE_MAX):
        return default
    if not (-MAP_LATITUDE_MAX <= lat <= MAP_LATITUDE_MAX):
        return default
    return (lon, lat)


def coerce_theme(value, default: str = "system") -> str:
    return value if value in THEMES else default


DATE_FORMATS = ("auto", "eu", "us")


def coerce_date_format(value, default: str = "auto") -> str:
    return value if value in DATE_FORMATS else default


def coerce_recording_settings(d: dict) -> RecordingSettings:
    """Borne les réglages d'enregistrement aux plages acceptées par l'UI.

    Les mêmes bornes sont appliquées côté client (static/js/recording_settings.mjs) :
    on les répète ici parce qu'un settings.json édité à la main, ou écrit par une
    version antérieure, ne doit pas pouvoir produire un enregistrement impossible.
    """
    r = RecordingSettings()
    if not isinstance(d, dict):
        return r
    mode = d.get("mode", r.mode)
    r.mode = mode if mode in RECORDING_MODES else r.mode
    capture_resolution = d.get("capture_resolution", r.capture_resolution)
    r.capture_resolution = (
        capture_resolution if capture_resolution in CAPTURE_RESOLUTIONS else r.capture_resolution
    )
    color_fidelity = d.get("color_fidelity", r.color_fidelity)
    r.color_fidelity = color_fidelity if color_fidelity in COLOR_FIDELITIES else r.color_fidelity
    r.fps = _clamp_int(d.get("fps"), r.fps, 1, 60)
    if isinstance(d.get("mime_type"), str) and d.get("mime_type"):
        r.mime_type = d["mime_type"]
    r.bitrate_mbps = _clamp_int(d.get("bitrate_mbps"), r.bitrate_mbps, 1, 30)
    r.slowdown_factor = _clamp_int(d.get("slowdown_factor"), r.slowdown_factor, 1, 20)
    r.scale_factor = _clamp_float(d.get("scale_factor"), r.scale_factor, 1.0, 3.0)
    r.upload_to_server = bool(d.get("upload_to_server", r.upload_to_server))
    r.download_local = bool(d.get("download_local", r.download_local))
    r.offline_normalization = bool(d.get("offline_normalization", r.offline_normalization))
    r.audio_enabled = bool(d.get("audio_enabled", r.audio_enabled))
    r.audio_volume = _clamp_float(d.get("audio_volume"), r.audio_volume, 0.0, 1.0)
    return r


ANIMATION_RHYTHM_MODES = ("rate", "duration", "music")


def coerce_animation_settings(d: dict, defaults: Optional[AnimationPrefs] = None) -> AnimationPrefs:
    """Borne les préférences d'animation aux plages acceptées par l'UI.

    Même motif que coerce_recording_settings : settings.json peut être édité à
    la main, les bornes de TIMING_LIMITS (static/js/video_timing.mjs) sont donc
    répétées ici plutôt que faisant confiance au fichier. `defaults` fournit
    les valeurs de repli (celles du mode Évolution pour son propre bloc).
    """
    a = copy.deepcopy(defaults) if defaults is not None else AnimationPrefs()
    if not isinstance(d, dict):
        return a
    mode = d.get("rhythm_mode", a.rhythm_mode)
    a.rhythm_mode = mode if mode in ANIMATION_RHYTHM_MODES else a.rhythm_mode
    a.days_per_second = _clamp_float(d.get("days_per_second"), a.days_per_second, 0.01, 1000.0)
    a.total_duration_seconds = _clamp_float(d.get("total_duration_seconds"), a.total_duration_seconds, 1.0, 21600.0)
    a.extra_end_seconds = _clamp_float(d.get("extra_end_seconds"), a.extra_end_seconds, 0.0, 3600.0)
    a.camera_follow = bool(d.get("camera_follow", a.camera_follow))
    a.camera_dynamism = _clamp_int(d.get("camera_dynamism"), a.camera_dynamism, 1, 4)
    a.flash_duration_ms = _clamp_int(d.get("flash_duration_ms"), a.flash_duration_ms, *FLASH_DURATION_RANGE)
    a.trail_duration_ms = _clamp_int(d.get("trail_duration_ms"), a.trail_duration_ms, 100, 10000)
    return a


def coerce_evolution_animation(d: dict) -> AnimationPrefs:
    """Rythme du mode Évolution : jamais de suivi de caméra."""
    a = coerce_animation_settings(d, evolution_animation_defaults())
    a.camera_follow = False
    return a


def coerce_dataset_id(value) -> Optional[int]:
    """Identifiant de base du mode Évolution (entier positif), None sinon."""
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def coerce_undated_archives(value, fallback: str = "hide") -> str:
    """Sort des archivées sans date (mode Évolution) ; inconnu → repli."""
    return value if value in ("hide", "keep", "expire") else fallback


def coerce_infos_template(value, fallback: str = '{date} · {actives}') -> str:
    """Modèle de la ligne d'infos du mode Évolution ; non-texte → repli.

    Texte libre : pas de strip (les espaces peuvent être voulus) et la chaîne
    vide est admise (elle masque la ligne). Une seule ligne d'infos : les sauts
    de ligne sont aplanis en espaces. Plafonné à 200 caractères comme le champ
    de saisie (inputInfosTemplate)."""
    if not isinstance(value, str):
        return fallback
    return value.replace('\r\n', ' ').replace('\r', ' ').replace('\n', ' ')[:200]


def coerce_settings(d: dict) -> AppSettings:
    s = AppSettings()
    if isinstance(d, dict):
        try:
            source_version = int(float(d.get("version", 1)))
        except (TypeError, ValueError):
            source_version = 1
        s.language = d.get("language", s.language)
        s.check_updates = bool(d.get("check_updates", s.check_updates))
        s.last_update_check = _coerce_optional_str(d.get("last_update_check"))
        s.skipped_update_version = _coerce_optional_str(d.get("skipped_update_version"))
        s.theme = coerce_theme(d.get("theme"), s.theme)
        s.date_format = coerce_date_format(d.get("date_format"), s.date_format)
        s.recording = coerce_recording_settings(d.get("recording"))
        s.animation = coerce_animation_settings(d.get("animation"))
        s.evolution_animation = coerce_evolution_animation(d.get("evolution_animation"))
        s.evolution_dataset_id = coerce_dataset_id(d.get("evolution_dataset_id"))
        s.evolution_infos_template = coerce_infos_template(
            d.get("evolution_infos_template"), s.evolution_infos_template)
        s.evolution_undated_archives = coerce_undated_archives(
            d.get("evolution_undated_archives"), s.evolution_undated_archives)
        # Un settings.json antérieur à la migration n'a pas de bloc `recording` :
        # il compte comme « jamais configuré ».
        s.recording_configured = bool(d.get("recording_configured", "recording" in d))

        raw_center = d.get("map_default_center")
        if isinstance(raw_center, (list, tuple)) and len(raw_center) == 2:
            # Les versions 1 stockaient [latitude, longitude]. La conversion en
            # mémoire rend les anciennes préférences compatibles sans ambiguïté
            # pour tout le reste de l'application. Elle précède le contrôle des
            # plages, sinon une longitude légitime de 150 serait jugée comme une
            # latitude hors bornes.
            ordered = tuple(raw_center)[::-1] if source_version < 2 else tuple(raw_center)
            s.map_default_center = coerce_map_center(ordered)

        s.map_default_zoom = coerce_map_zoom(d.get("map_default_zoom"))

        s.map_framing = coerce_map_framing(d.get("map_framing"), s.map_framing)
        if "map_framing" not in d and (s.map_default_center is not None or s.map_default_zoom is not None):
            # Réglage écrit avant l'apparition du mode : un centre ou un zoom
            # déjà choisi vaut « custom », sinon le nouveau défaut « fit »
            # écraserait le cadrage réglé à la main.
            s.map_framing = "custom"

        if d.get("default_profile_uid"):
            s.default_profile_uid = d.get("default_profile_uid")

        if d.get("last_profile_uid"):
            s.last_profile_uid = d.get("last_profile_uid")

        s.evolution_default_profile_uid = _coerce_optional_str(d.get("evolution_default_profile_uid"))
        s.evolution_last_profile_uid = _coerce_optional_str(d.get("evolution_last_profile_uid"))

        s.startup_default_profile = bool(d.get("startup_default_profile", s.startup_default_profile))

        s.examples_seeded = bool(d.get("examples_seeded", s.examples_seeded))
        s.examples_version = _to_int(d.get("examples_version"), s.examples_version)

        s.version = max(source_version, COORDINATE_ORDER_VERSION)
    return s


def coerce_profile(d: dict, base: Optional[MapProfile] = None) -> MapProfile:
    """Construit un thème valide à partir d'un dict (fichier, import, PUT).

    Les valeurs absentes, illisibles ou hors des listes/bornes admises sont
    reprises de `base` (le thème existant lors d'une sauvegarde), à défaut des
    valeurs par défaut de MapProfile.
    """
    p = copy.deepcopy(base) if base is not None else MapProfile()
    if isinstance(d, dict):
        p.name = d.get("name", p.name)
        try:
            source_version = int(float(d.get("version", 1)))
        except (TypeError, ValueError):
            source_version = 1
        p.version = max(source_version, COORDINATE_ORDER_VERSION)
        p.uid = d.get("uid", p.uid)
        p.mode = _coerce_choice(d.get("mode"), PROFILE_MODES, p.mode)

        # Options de carte. `default_center` et `default_zoom`, présents dans
        # les anciens fichiers, ne sont plus lus : le centre et le zoom sont un
        # état de vue / une préférence globale, pas un réglage de thème.
        m = d.get("map", {}) if isinstance(d.get("map", {}), dict) else {}

        # Options vectorielles
        raw_vm = m.get("vector_options") or {}
        vm = raw_vm if isinstance(raw_vm, dict) else {}
        pvm = p.map.vector_options
        vector_options = VectorMapOptions(
            stroke_color=_coerce_hex_color(vm.get("stroke_color"), pvm.stroke_color),
            fill_color=_coerce_hex_color(vm.get("fill_color"), pvm.fill_color),
            background_color=_coerce_hex_color(vm.get("background_color"), pvm.background_color),
            stroke_width=_clamp_float(vm.get("stroke_width"), pvm.stroke_width, *STROKE_WIDTH_RANGE),
        )

        # Options Toner
        raw_tm = m.get("toner_options") or {}
        tm = raw_tm if isinstance(raw_tm, dict) else {}
        toner_options = TonerMapOptions(
            variant=_coerce_choice(tm.get("variant"), TONER_VARIANTS, p.map.toner_options.variant),
        )

        p.map = MapOptions(
            tile_provider=_coerce_choice(m.get("tile_provider"), TILE_PROVIDERS, p.map.tile_provider),
            vector_options=vector_options,
            toner_options=toner_options,
        )

        # Le bloc `animation` des anciens fichiers (speed, camera_follow…) est
        # volontairement ignoré : le timing est une préférence globale
        # (AppSettings.animation), jamais un attribut de thème. Aucune migration
        # automatique vers les préférences : deux anciens thèmes pouvaient
        # contenir des vitesses différentes, choisir au hasard serait faux.

        # Options des points
        pt = d.get("points", {}) if isinstance(d.get("points", {}), dict) else {}
        pp = p.points
        p.points = PointStyle(
            size=_clamp_int(pt.get("size"), pp.size, *POINT_SIZE_RANGE),
            color=_coerce_hex_color(pt.get("color"), pp.color),
            shape=_coerce_choice(pt.get("shape"), POINT_SHAPES, pp.shape),
            halo=bool(pt.get("halo", pp.halo)),
            border_color=_coerce_hex_color(pt.get("border_color"), pp.border_color),
            border_size=_clamp_int(pt.get("border_size"), pp.border_size, *BORDER_SIZE_RANGE),
            fill_color_type=_coerce_choice(pt.get("fill_color_type"), COLOR_TYPES, pp.fill_color_type),
            border_color_type=_coerce_choice(pt.get("border_color_type"), COLOR_TYPES, pp.border_color_type),
            mode=_coerce_choice(pt.get("mode"), POINT_MODES, pp.mode),
            icon_set=_coerce_choice(pt.get("icon_set"), ICON_SETS, pp.icon_set),
            icon_size=_clamp_int(pt.get("icon_size"), pp.icon_size, *ICON_SIZE_RANGE),
            appear_animation=bool(pt.get("appear_animation", pp.appear_animation)),
            recent_glow_days=_clamp_int(pt.get("recent_glow_days"), pp.recent_glow_days, *RECENT_GLOW_DAYS_RANGE),
        )

        # Options flash
        f = d.get("flash", {}) if isinstance(d.get("flash", {}), dict) else {}
        # Flash de disparition (mode Évolution) : absent des thèmes antérieurs,
        # qui reçoivent alors les valeurs par défaut.
        raw_fd = f.get("disappear") or {}
        fd = raw_fd if isinstance(raw_fd, dict) else {}
        pfd = p.flash.disappear
        p.flash = FlashOptions(
            mode=_coerce_choice(f.get("mode"), FLASH_MODES, p.flash.mode),
            # Thèmes antérieurs au déplacement de la durée : repli sur la
            # valeur existante (défaut 1000), bornée comme le champ.
            duration=_clamp_int(f.get("duration"), p.flash.duration, *FLASH_DURATION_RANGE),
            size=_clamp_int(f.get("size"), p.flash.size, *FLASH_SIZE_RANGE),
            color=_coerce_hex_color(f.get("color"), p.flash.color),
            color_type=_coerce_choice(f.get("color_type"), COLOR_TYPES, p.flash.color_type),
            border_color=_coerce_hex_color(f.get("border_color"), p.flash.border_color),
            border_color_type=_coerce_choice(f.get("border_color_type"), FLASH_BORDER_TYPES, p.flash.border_color_type),
            disappear=DisappearFlashOptions(
                mode=_coerce_choice(fd.get("mode"), DISAPPEAR_FLASH_MODES, pfd.mode),
                size=_clamp_int(fd.get("size"), pfd.size, *FLASH_SIZE_RANGE),
                color=_coerce_hex_color(fd.get("color"), pfd.color),
                color_type=_coerce_choice(fd.get("color_type"), COLOR_TYPES, pfd.color_type),
                border_color=_coerce_hex_color(fd.get("border_color"), pfd.border_color),
                border_color_type=_coerce_choice(fd.get("border_color_type"), FLASH_BORDER_TYPES, pfd.border_color_type),
            ),
        )

        # Options infos (titre, cases à cocher, CSS)
        i = d.get("infos", {}) if isinstance(d.get("infos", {}), dict) else {}
        t = i.get("title", {}) if isinstance(i.get("title", {}), dict) else {}
        p.infos = InfosOptions(
            title=InfosTitle(
                display=bool(t.get("display", p.infos.title.display)),
                text=coerce_overlay_title(t.get("text", p.infos.title.text), p.infos.title.text),
            ),
            number_of_caches=bool(i.get("number_of_caches", p.infos.number_of_caches)),
            current_date=bool(i.get("current_date", p.infos.current_date)),
            title_css=sanitize_overlay_css(i.get("title_css", p.infos.title_css)),
            infos_css=sanitize_overlay_css(i.get("infos_css", p.infos.infos_css)),
        )

        # Traits de déplacement : absents des thèmes antérieurs, qui reçoivent
        # alors les valeurs par défaut (trait désactivé).
        tr = d.get("trail", {}) if isinstance(d.get("trail", {}), dict) else {}
        pt = p.trail
        # Liste fermée (comme le <select>) ; un booléen n'est pas un nombre de
        # jours, alors que False vaudrait 0, « tout le parcours ».
        raw_persist = tr.get("persist_days", pt.persist_days)
        persist = None if isinstance(raw_persist, bool) else _to_int(raw_persist, None)
        # Un booléen n'est pas une valeur numérique (int(True) vaudrait 1) :
        # rejeté comme côté client (clampNumber), la valeur précédente reste.
        def _tget(key, fallback):
            v = tr.get(key, fallback)
            return fallback if isinstance(v, bool) else v
        p.trail = TrailOptions(
            enabled=tr.get("enabled") if isinstance(tr.get("enabled"), bool) else pt.enabled,
            routing=_coerce_choice(tr.get("routing"), TRAIL_ROUTINGS, pt.routing),
            cluster_km=_clamp_float(_tget("cluster_km", pt.cluster_km), pt.cluster_km, *TRAIL_CLUSTER_KM_RANGE),
            jump_km=_clamp_int(_tget("jump_km", pt.jump_km), pt.jump_km, *TRAIL_JUMP_KM_RANGE),
            jump_style=_coerce_choice(tr.get("jump_style"), TRAIL_JUMP_STYLES, pt.jump_style),
            curve=_coerce_choice(tr.get("curve"), TRAIL_CURVES, pt.curve),
            color=_expand_hex_color(_coerce_hex_color(tr.get("color"), pt.color)),
            width=_clamp_int(_tget("width", pt.width), pt.width, *TRAIL_WIDTH_RANGE),
            opacity=_clamp_int(_tget("opacity", pt.opacity), pt.opacity, *TRAIL_OPACITY_RANGE),
            line_style=_coerce_choice(tr.get("line_style"), TRAIL_LINE_STYLES, pt.line_style),
            effect=_coerce_choice(tr.get("effect"), TRAIL_EFFECTS, pt.effect),
            head=_coerce_choice(tr.get("head"), TRAIL_HEADS, pt.head),
            persist_days=persist if persist in TRAIL_PERSIST_DAYS else pt.persist_days,
        )

    return p


# Échelle des tailles entre les deux modes. Le mode principal affiche quelques
# milliers de points (rayon 5 à 10 px dans les exemples), le mode Évolution des
# dizaines de milliers : au-delà de 2 ou 3 px les points se recouvrent et la
# carte devient un aplat.
EVOLUTION_POINT_SCALE = 0.25
EVOLUTION_FLASH_SCALE = 0.4
# Des dizaines de flashs par image : au-delà, ils se fondent en un voile.
EVOLUTION_FLASH_MAX_DURATION = 500


def _scaled(value: int, factor: float, minimum: int, maximum: int) -> int:
    # Arrondi au plus proche, la moitié vers le haut (round() de Python arrondit
    # 2,5 à 2) : une taille de 6 doit donner 2 et non 1.
    return max(minimum, min(maximum, int(value * factor + 0.5)))


def convert_profile_for_mode(prof: MapProfile, target_mode: str) -> MapProfile:
    """Adapte un thème (modifié en place) à la densité de `target_mode`.

    Fond de carte, couleurs, formes, titre et CSS sont conservés tels quels :
    seul ce qui dépend du nombre de points à l'écran est ramené à l'échelle du
    mode visé. Le trajet et le flash de disparition, sans effet dans l'un des
    deux modes, traversent sans changement.
    """
    if target_mode == prof.mode:
        return prof
    points, flash = prof.points, prof.flash
    if target_mode == PROFILE_MODE_EVOLUTION:
        points.size = _scaled(points.size, EVOLUTION_POINT_SCALE, *POINT_SIZE_RANGE)
        # Une icône par cache est illisible à cette densité : pastille aux
        # couleurs du type, ce que l'icône exprimait.
        if points.mode == "icone":
            points.mode = "vectoriel"
            points.fill_color_type = "gc"
        # Un contour autour d'un point de 1 ou 2 px le recouvre entièrement.
        # Un point dessiné par son seul contour (centre « aucun ») en reprend
        # donc la couleur, sinon il disparaîtrait.
        if points.fill_color_type == "none" and points.halo and points.border_size > 0:
            points.fill_color_type = points.border_color_type
            points.color = points.border_color
        if points.fill_color_type == "none":
            points.fill_color_type = "fix"
        points.halo = False
        points.border_size = 0
        flash.size = _scaled(flash.size, EVOLUTION_FLASH_SCALE, *FLASH_SIZE_RANGE)
        flash.duration = min(flash.duration, EVOLUTION_FLASH_MAX_DURATION)
    else:
        points.size = _scaled(points.size, 1 / EVOLUTION_POINT_SCALE, *POINT_SIZE_RANGE)
        flash.size = _scaled(flash.size, 1 / EVOLUTION_FLASH_SCALE, *FLASH_SIZE_RANGE)
    prof.mode = target_mode
    return prof


def _profiles_locked(method):
    """Exécute une opération sur les fichiers de thèmes verrou tenu.

    Les opérations en plusieurs étapes (vérifier qu'un nom est libre puis
    écrire, écrire le nouveau fichier puis supprimer l'ancien) ne doivent pas
    s'entrelacer : le serveur Flask est multithread, et un double clic ou deux
    onglets suffisent à envoyer deux requêtes simultanées.
    """
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._profiles_lock:
            return method(self, *args, **kwargs)
    return wrapper


class SettingsManager:
    def __init__(self) -> None:
        # Sérialise les cycles lire-modifier-écrire de settings.json. Le serveur
        # de développement Flask est multithread : deux requêtes rapprochées
        # (changer la langue pendant qu'un blur enregistre le centre de carte)
        # lisent sinon le même état de départ, et la seconde écriture efface la
        # première (« lost update »). Réentrant car get_app_settings() peut
        # réécrire le fichier (nettoyage d'un profil par défaut disparu) alors
        # que le verrou est déjà tenu par update_app_settings().
        # Posé avant tout accès au fichier : la suite du constructeur écrit déjà.
        self._app_settings_lock = threading.RLock()
        # Même rôle pour les fichiers de thèmes (cf. _profiles_locked).
        # Réentrant : create_profile() appelle save_profile(), par exemple.
        self._profiles_lock = threading.RLock()

        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        if not SETTINGS_PATH.exists():
            self.save_app_settings(AppSettings())

        # Caches construits en un seul scan pour éviter de reparser tous les
        # profils à chaque appel (list_profiles est re-demandé après chaque action).
        self._uid_to_path_cache: dict[str, Path] = {}
        self._uid_to_name_cache: dict[str, str] = {}
        self._name_to_path_cache: dict[str, Path] = {}
        # Mode de chaque thème (PROFILE_MODES), par nom et par uid : la liste
        # filtrée d'une page est demandée après chaque action.
        self._name_to_mode_cache: dict[str, str] = {}
        self._uid_to_mode_cache: dict[str, str] = {}
        self._cache_signature: tuple = ()
        self._build_profile_cache()

        # Créer les profils d'exemple une seule fois, au tout premier lancement.
        # Une fois ce flag posé, un utilisateur qui supprime un exemple ne le voit
        # pas revenir au redémarrage suivant. Les exemples ajoutés par une version
        # ultérieure (EXAMPLES_VERSION) sont installés une fois eux aussi, sans
        # toucher aux profils existants.
        settings = self.get_app_settings()
        if not settings.examples_seeded:
            self._create_example_profiles()
            self._mark_examples_seeded(
                default_profile_name=FIRST_LAUNCH_PROFILE,
                evolution_default_profile_name=FIRST_LAUNCH_EVOLUTION_PROFILE,
            )
        elif settings.examples_version < EXAMPLES_VERSION:
            missing_examples = set().union(*(
                names
                for version, names in EXAMPLE_PROFILE_BATCHES.items()
                if version > settings.examples_version
            ))
            self._create_example_profiles(only=missing_examples)
            # Installation antérieure aux thèmes du mode Évolution : la page
            # /evolution n'a encore aucun thème à elle, elle reçoit le sien.
            # Contrairement au mode principal, aucun choix existant n'est
            # écrasé — la clé n'existait pas.
            evolution_default = (
                FIRST_LAUNCH_EVOLUTION_PROFILE
                if FIRST_LAUNCH_EVOLUTION_PROFILE in missing_examples else None
            )
            self._mark_examples_seeded(evolution_default_profile_name=evolution_default)

    def _mark_examples_seeded(
        self,
        default_profile_name: Optional[str] = None,
        evolution_default_profile_name: Optional[str] = None,
    ) -> None:
        # Le thème par défaut n'est posé qu'au premier lancement, et seulement
        # si aucun n'est déjà choisi : c'est lui que restoreStartupProfile()
        # (static/js/profiles.js) charge faute de dernier thème actif.
        def uid_of(name: Optional[str], mode: str) -> Optional[str]:
            if not name:
                return None
            try:
                prof = self.load_profile(name)
            except FileNotFoundError:
                logging.warning("Thème de premier lancement '%s' introuvable", name)
                return None
            # Un thème de l'utilisateur peut porter ce nom dans l'autre mode.
            return prof.uid if prof.mode == mode else None

        default_uid = uid_of(default_profile_name, PROFILE_MODE_MAIN)
        evolution_default_uid = uid_of(evolution_default_profile_name, PROFILE_MODE_EVOLUTION)

        def mark(current: AppSettings) -> AppSettings:
            current.examples_seeded = True
            current.examples_version = EXAMPLES_VERSION
            if default_uid and not current.default_profile_uid:
                current.default_profile_uid = default_uid
            if evolution_default_uid and not current.evolution_default_profile_uid:
                current.evolution_default_profile_uid = evolution_default_uid
            return current

        self.update_app_settings(mark)

    def _profiles_dir_signature(self) -> tuple:
        """Empreinte du dossier profils : une énumération, aucun parse JSON.

        Permet de détecter une modification faite hors de l'application (fichier
        ajouté, supprimé ou édité à la main) sans relire tous les profils.
        """
        entries = []
        try:
            with os.scandir(PROFILES_DIR) as it:
                for entry in it:
                    if not entry.name.endswith(".json") or not entry.is_file():
                        continue
                    st = entry.stat()
                    entries.append((entry.name, st.st_mtime_ns, st.st_size))
        except OSError:
            return ()
        entries.sort()
        return tuple(entries)

    def _build_profile_cache(self) -> None:
        """Construit les caches uid→path, uid→nom et nom→path en un seul scan.

        Les dictionnaires sont remplis à part puis substitués d'un coup : vidés
        puis remplis en place, ils paraissaient vides à une lecture faite au
        même moment depuis une autre requête.
        """
        uid_to_path: dict[str, Path] = {}
        uid_to_name: dict[str, str] = {}
        name_to_path: dict[str, Path] = {}
        name_to_mode: dict[str, str] = {}
        uid_to_mode: dict[str, str] = {}
        signature = self._profiles_dir_signature()
        for profile_file in PROFILES_DIR.glob("*.json"):
            try:
                data = read_json(profile_file)
                name = data.get("name") or profile_file.stem
                uid = data.get("uid")
                mode = _coerce_choice(data.get("mode"), PROFILE_MODES, PROFILE_MODE_MAIN)
                if uid:
                    uid_to_path[uid] = profile_file
                    uid_to_name[uid] = name
                    uid_to_mode[uid] = mode
                name_to_path[name] = profile_file
                name_to_mode[name] = mode
            except Exception:
                # Fichier illisible : on garde au moins le nom de fichier comme nom
                name_to_path[profile_file.stem] = profile_file
                name_to_mode[profile_file.stem] = PROFILE_MODE_MAIN
        self._uid_to_path_cache = uid_to_path
        self._uid_to_name_cache = uid_to_name
        self._name_to_path_cache = name_to_path
        self._name_to_mode_cache = name_to_mode
        self._uid_to_mode_cache = uid_to_mode
        # Empreinte prise AVANT le scan : un fichier modifié pendant celui-ci
        # rendra l'empreinte périmée, et le prochain accès reconstruira.
        self._cache_signature = signature

    def _invalidate_profile_cache(self) -> None:
        """Invalide et reconstruit les caches profils (après écriture/suppression)."""
        self._build_profile_cache()

    def _ensure_profile_cache(self) -> None:
        """Reconstruit les caches uniquement si le dossier a changé hors application."""
        if self._profiles_dir_signature() != self._cache_signature:
            self._build_profile_cache()

    @staticmethod
    def _example_profile_definitions() -> dict:
        """Définitions des thèmes d'exemple, par nom.

        Chaque appel construit des objets neufs (uid compris) : l'appelant peut
        les modifier sans toucher aux suivants. Servent à l'installation
        (_create_example_profiles) et à la réinitialisation d'un exemple
        (reset_profile), qui retrouve ainsi son design d'origine.
        """
        def build_infos(title_text: str, title_css: str, infos_css: str) -> InfosOptions:
            return InfosOptions(
                title=InfosTitle(display=True, text=title_text),
                number_of_caches=True,
                current_date=True,
                title_css=title_css.strip(),
                infos_css=infos_css.strip(),
            )

        # Chaque exemple doit montrer quelque chose que les autres ne montrent
        # pas (fond, forme, couleurs GC ou non, flash, trajet…) : la liste sert
        # d'inspiration, pas de nuancier. Un exemple retiré d'ici reste chez
        # ceux qui l'ont déjà reçu — il n'est simplement plus installé.
        example_profiles = {
            "Default": MapProfile(
                name="Default",
                map=MapOptions(
                    tile_provider="OSM",
                    vector_options=VectorMapOptions(
                        stroke_color="#1f2937",
                        fill_color="#f97316",
                        background_color="#f8fafc",
                        stroke_width=2.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=8,
                    color="#f97316",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=2,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="circle",
                    size=42,
                    color="#f59e0b",
                    color_type="gc"
                ),
                infos=build_infos(
                    "My Geocaching Map",
                    """
                    color: #ffffff;
                    background: rgba(15, 23, 42, 0.78);
                    padding: 10px 16px;
                    border-radius: 999px;
                    font-weight: 700;
                    letter-spacing: 0.4px;
                    box-shadow: 0 10px 25px rgba(15, 23, 42, 0.24);
                    """,
                    """
                    color: #0f172a;
                    background: rgba(255, 255, 255, 0.88);
                    padding: 8px 12px;
                    border-radius: 10px;
                    border: 1px solid rgba(148, 163, 184, 0.5);
                    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.12);
                    """
                )
            ),

            "Nocturne Neon": MapProfile(
                name="Nocturne Neon",
                map=MapOptions(
                    tile_provider="stamenToner",
                    vector_options=VectorMapOptions(
                        stroke_color="#6ef2ff",
                        fill_color="#111827",
                        background_color="#020617",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                points=PointStyle(
                    size=7,
                    color="#6ef2ff",
                    shape="triangle",
                    halo=True,
                    border_color="#0b1020",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="diamond",
                    size=65,
                    color="#ff4fd8",
                    color_type="fix"
                ),
                trail=TrailOptions(
                    enabled=True,
                    curve="smooth",
                    color="#ff4fd8",
                    width=3,
                    opacity=90,
                    line_style="solid",
                    effect="glow",
                    head="pulse",
                    persist_days=30
                ),
                infos=build_infos(
                    "Night Cache Trail",
                    """
                    color: #6ef2ff;
                    background: rgba(11, 16, 32, 0.82);
                    padding: 10px 16px;
                    border-radius: 8px;
                    border: 1px solid #ff4fd8;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    box-shadow: 0 0 24px rgba(110, 242, 255, 0.16);
                    """,
                    """
                    color: #f8fafc;
                    background: rgba(11, 16, 32, 0.76);
                    padding: 8px 12px;
                    border-radius: 8px;
                    border-left: 3px solid #6ef2ff;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
                    """
                )
            ),

            "Carnet Aquarelle": MapProfile(
                name="Carnet Aquarelle",
                map=MapOptions(
                    tile_provider="watercolor",
                    vector_options=VectorMapOptions(
                        stroke_color="#b08968",
                        fill_color="#e6ccb2",
                        background_color="#fff8eb",
                        stroke_width=1.4
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=7,
                    color="#7c5a43",
                    shape="circle",
                    halo=False,
                    border_color="#d7c1a2",
                    border_size=0,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="icone",
                    icon_set="geocaching",
                    icon_size=22,
                    appear_animation=True
                ),
                # Pas de flash : seule l'apparition animée des icônes donne le
                # mouvement.
                flash=FlashOptions(
                    mode="none",
                    size=35,
                    color="#d7c1a2",
                    color_type="none"
                ),
                infos=build_infos(
                    "Carnet de Geocaching",
                    """
                    color: #5c4633;
                    background: rgba(255, 248, 235, 0.88);
                    padding: 10px 14px;
                    border-radius: 6px;
                    border: 1px solid #d7c1a2;
                    font-family: Georgia;
                    font-weight: 700;
                    box-shadow: 0 8px 24px rgba(87, 69, 48, 0.18);
                    """,
                    """
                    color: #5c4633;
                    background: rgba(255, 252, 244, 0.9);
                    padding: 8px 12px;
                    border-radius: 6px;
                    border: 1px dashed #d7c1a2;
                    box-shadow: 0 6px 18px rgba(87, 69, 48, 0.12);
                    """
                )
            ),

            "Atlas Vintage": MapProfile(
                name="Atlas Vintage",
                map=MapOptions(
                    tile_provider="vectorMap",
                    vector_options=VectorMapOptions(
                        stroke_color="#6b5b4d",
                        fill_color="#d8ccb4",
                        background_color="#efe6d2",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=8,
                    color="#8b3a2e",
                    shape="triangle",
                    halo=True,
                    border_color="#f6f0e3",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel",
                    appear_animation=True,
                    recent_glow_days=30
                ),
                flash=FlashOptions(
                    mode="implode",
                    duration=800,
                    size=38,
                    color="#8b3a2e",
                    color_type="fix"
                ),
                infos=build_infos(
                    "Atlas Geocaching",
                    """
                    color: #4e342e;
                    background: rgba(246, 240, 227, 0.92);
                    padding: 10px 16px;
                    border-radius: 4px;
                    border: 1px solid #6b5b4d;
                    font-family: Georgia;
                    font-weight: 700;
                    letter-spacing: 0.6px;
                    """,
                    """
                    color: #5f4339;
                    background: rgba(239, 230, 210, 0.9);
                    padding: 8px 12px;
                    border-radius: 4px;
                    border-top: 2px solid #8b3a2e;
                    """
                )
            ),

            "Présentation Impact": MapProfile(
                name="Présentation Impact",
                map=MapOptions(
                    tile_provider="OSM",
                    vector_options=VectorMapOptions(
                        stroke_color="#111827",
                        fill_color="#ff6b35",
                        background_color="#ffffff",
                        stroke_width=2.8
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=7,
                    color="#ff6b35",
                    shape="circle",
                    halo=True,
                    border_color="#111827",
                    border_size=2,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="square",
                    size=50,
                    color="#ffd166",
                    color_type="fix"
                ),
                infos=build_infos(
                    "MyGCFlow Highlights",
                    """
                    color: #ffffff;
                    background: rgba(17, 24, 39, 0.85);
                    padding: 10px 16px;
                    border-radius: 10px;
                    font-size: 22px;
                    font-weight: 800;
                    letter-spacing: 1px;
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
                    """,
                    """
                    color: #111827;
                    background: rgba(255, 255, 255, 0.92);
                    padding: 8px 12px;
                    border-radius: 8px;
                    border-left: 4px solid #ff6b35;
                    box-shadow: 0 10px 24px rgba(17, 24, 39, 0.12);
                    """
                )
            ),

            "Fête Confetti": MapProfile(
                name="Fête Confetti",
                map=MapOptions(
                    tile_provider="OSM",
                    vector_options=VectorMapOptions(
                        stroke_color="#7b2ff7",
                        fill_color="#ffd166",
                        background_color="#fffdf5",
                        stroke_width=2.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=9,
                    color="#7b2ff7",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=2,
                    fill_color_type="gc",
                    border_color_type="gc",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="sparkle",
                    size=65,
                    color="#ff4fd8",
                    color_type="gc"
                ),
                infos=build_infos(
                    "Cache Party!",
                    """
                    color: #ffffff;
                    background: linear-gradient(135deg, #7b2ff7 0%, #ff4fd8 50%, #ffd166 100%);
                    padding: 12px 20px;
                    border-radius: 14px;
                    font-weight: 800;
                    letter-spacing: 0.8px;
                    box-shadow: 0 12px 28px rgba(123, 47, 247, 0.28);
                    """,
                    """
                    color: #4a148c;
                    background: rgba(255, 253, 245, 0.94);
                    padding: 8px 14px;
                    border-radius: 12px;
                    border-left: 4px solid #ff4fd8;
                    box-shadow: 0 8px 20px rgba(123, 47, 247, 0.16);
                    """
                )
            ),

            # Les deux profils ci-dessous sont des styles d'animation (EXAMPLES_VERSION 2) :
            # ils mettent en scène le flash « impulsion » et l'apparition animée des
            # points, éteints par défaut ailleurs.
            # Anciennement « Équilibré ».
            "Épure": MapProfile(
                name="Épure",
                map=MapOptions(
                    tile_provider="stamenToner",
                    vector_options=VectorMapOptions(
                        stroke_color="#94a3b8",
                        fill_color="#e2e8f0",
                        background_color="#f8fafc",
                        stroke_width=1.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                # Bordure fine et points un peu plus petits : sur une grosse base,
                # la carte reste lisible quand les points se densifient.
                points=PointStyle(
                    size=7,
                    color="#0ea5e9",
                    shape="circle",
                    halo=True,
                    border_color="#000000",
                    border_size=3,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel",
                    appear_animation=False
                ),
                # Flash court et net : l'animation reste nerveuse même quand
                # beaucoup de caches tombent le même jour.
                flash=FlashOptions(
                    mode="impulse",
                    size=40,
                    color="#0ea5e9",
                    color_type="gc"
                ),
                infos=build_infos(
                    "My Geocaching Map",
                    """
                    color: #0f172a;
                    background: rgba(255, 255, 255, 0.9);
                    padding: 10px 18px;
                    border-radius: 12px;
                    border: 1px solid rgba(148, 163, 184, 0.45);
                    font-weight: 600;
                    letter-spacing: 0.3px;
                    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.1);
                    """,
                    """
                    color: #0f172a;
                    background: rgba(255, 255, 255, 0.9);
                    padding: 8px 14px;
                    border-radius: 10px;
                    border: 1px solid rgba(148, 163, 184, 0.45);
                    font-variant-numeric: tabular-nums;
                    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.1);
                    """
                )
            ),

            "Cinématique": MapProfile(
                name="Cinématique",
                map=MapOptions(
                    # Carte vectorielle : c'est le seul fond réellement sombre
                    # (la variante « dark » de Toner reste noir sur blanc). Les
                    # halos des flashs et les couleurs GC y ressortent bien mieux.
                    tile_provider="vectorMap",
                    vector_options=VectorMapOptions(
                        stroke_color="#475569",
                        fill_color="#0f172a",
                        background_color="#020617",
                        stroke_width=1.4
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                points=PointStyle(
                    size=8,
                    color="#f8fafc",
                    shape="circle",
                    halo=True,
                    border_color="#0b1020",
                    border_size=1,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel",
                    appear_animation=True,
                    recent_glow_days=30
                ),
                flash=FlashOptions(
                    mode="impulse",
                    size=60,
                    color="#f8fafc",
                    color_type="gc"
                ),
                infos=build_infos(
                    "My Geocaching Map",
                    """
                    color: #f8fafc;
                    background: rgba(2, 6, 23, 0.72);
                    padding: 12px 20px;
                    border-radius: 4px;
                    border-left: 3px solid #38bdf8;
                    font-weight: 700;
                    letter-spacing: 1.5px;
                    text-transform: uppercase;
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
                    """,
                    """
                    color: #e2e8f0;
                    background: rgba(2, 6, 23, 0.66);
                    padding: 8px 14px;
                    border-radius: 4px;
                    font-variant-numeric: tabular-nums;
                    letter-spacing: 0.5px;
                    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32);
                    """
                )
            ),

            # Collection esthétique EXAMPLES_VERSION 3. Elle explore des
            # combinaisons très différentes sans dépasser 7 px pour les points
            # vectoriels (18 px pour l'unique profil à icônes).
            "Encre & Papier": MapProfile(
                name="Encre & Papier",
                map=MapOptions(
                    tile_provider="stamenToner",
                    vector_options=VectorMapOptions(
                        stroke_color="#292524",
                        fill_color="#e7e5e4",
                        background_color="#fafaf9",
                        stroke_width=1.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=3,
                    color="#1c1917",
                    shape="circle",
                    halo=False,
                    border_color="#ffffff",
                    border_size=1,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="none",
                    size=30,
                    color="#1c1917",
                    color_type="none"
                ),
                infos=build_infos(
                    "CARNET DE TROUVAILLES",
                    """
                    color: #1c1917;
                    background: rgba(250, 250, 249, 0.94);
                    padding: 9px 14px;
                    border-radius: 2px;
                    border: 1px solid #292524;
                    font-family: Georgia;
                    font-weight: 700;
                    letter-spacing: 1.4px;
                    """,
                    """
                    color: #292524;
                    background: rgba(250, 250, 249, 0.92);
                    padding: 7px 11px;
                    border-radius: 2px;
                    border-bottom: 2px solid #292524;
                    font-variant-numeric: tabular-nums;
                    """
                )
            ),

            "Aurore Polaire": MapProfile(
                name="Aurore Polaire",
                map=MapOptions(
                    tile_provider="vectorMap",
                    vector_options=VectorMapOptions(
                        stroke_color="#334155",
                        fill_color="#111827",
                        background_color="#030712",
                        stroke_width=1.2
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                points=PointStyle(
                    size=7,
                    color="#5eead4",
                    shape="triangle",
                    halo=True,
                    border_color="#082f49",
                    border_size=1,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel",
                    appear_animation=True,
                    recent_glow_days=7
                ),
                flash=FlashOptions(
                    mode="echo",
                    duration=1800,
                    size=55,
                    color="#67e8f9",
                    color_type="fix"
                ),
                infos=build_infos(
                    "AURORA CACHE FLOW",
                    """
                    color: #ecfeff;
                    background: linear-gradient(135deg, rgba(8, 47, 73, 0.88), rgba(76, 29, 149, 0.78));
                    padding: 11px 18px;
                    border-radius: 999px;
                    border: 1px solid rgba(94, 234, 212, 0.7);
                    font-weight: 700;
                    letter-spacing: 1.8px;
                    box-shadow: 0 0 26px rgba(94, 234, 212, 0.2);
                    """,
                    """
                    color: #cffafe;
                    background: rgba(3, 7, 18, 0.76);
                    padding: 8px 13px;
                    border-radius: 999px;
                    border: 1px solid rgba(103, 232, 249, 0.38);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
                    """
                )
            ),

            "Sakura Pastel": MapProfile(
                name="Sakura Pastel",
                map=MapOptions(
                    tile_provider="watercolor",
                    vector_options=VectorMapOptions(
                        stroke_color="#9f7aea",
                        fill_color="#fce7f3",
                        background_color="#fff7fb",
                        stroke_width=1.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=6,
                    color="#f472b6",
                    shape="circle",
                    halo=True,
                    border_color="#fff7fb",
                    border_size=1,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel",
                    appear_animation=True,
                    recent_glow_days=30
                ),
                flash=FlashOptions(
                    mode="star",
                    duration=600,
                    size=45,
                    color="#c084fc",
                    color_type="fix"
                ),
                infos=build_infos(
                    "Sakura Cache Diary",
                    """
                    color: #831843;
                    background: rgba(255, 247, 251, 0.9);
                    padding: 10px 17px;
                    border-radius: 16px 4px 16px 4px;
                    border: 1px solid #f9a8d4;
                    font-family: Georgia;
                    font-weight: 700;
                    box-shadow: 0 10px 24px rgba(244, 114, 182, 0.18);
                    """,
                    """
                    color: #701a75;
                    background: rgba(253, 242, 248, 0.9);
                    padding: 8px 12px;
                    border-radius: 12px 3px 12px 3px;
                    border-left: 3px solid #c084fc;
                    """
                )
            ),

            # Aucun point affiché, volontairement (centre « aucun », contour
            # désactivé) : seuls les flashs aux couleurs GC signalent les
            # caches, la carte se vide entre deux trouvailles.
            "Signal Technique": MapProfile(
                name="Signal Technique",
                map=MapOptions(
                    tile_provider="stamenToner",
                    vector_options=VectorMapOptions(
                        stroke_color="#334155",
                        fill_color="#cbd5e1",
                        background_color="#f8fafc",
                        stroke_width=1.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=5,
                    color="#ffffff",
                    shape="circle",
                    halo=False,
                    border_color="#2563eb",
                    border_size=2,
                    fill_color_type="none",
                    border_color_type="gc",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="square",
                    size=36,
                    color="#2563eb",
                    color_type="gc"
                ),
                infos=build_infos(
                    "CACHE // SIGNAL",
                    """
                    color: #f8fafc;
                    background: rgba(15, 23, 42, 0.9);
                    padding: 9px 14px;
                    border-radius: 0px;
                    border-left: 4px solid #22d3ee;
                    font-family: monospace;
                    font-weight: 700;
                    letter-spacing: 2px;
                    """,
                    """
                    color: #0f172a;
                    background: rgba(248, 250, 252, 0.94);
                    padding: 7px 11px;
                    border-radius: 0px;
                    border: 1px solid #64748b;
                    font-family: monospace;
                    font-variant-numeric: tabular-nums;
                    """
                )
            ),

            "Randonnée Topo": MapProfile(
                name="Randonnée Topo",
                map=MapOptions(
                    tile_provider="OSM",
                    vector_options=VectorMapOptions(
                        stroke_color="#3f6212",
                        fill_color="#d9f99d",
                        background_color="#f7fee7",
                        stroke_width=1.4
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=6,
                    color="#3f6212",
                    shape="circle",
                    halo=False,
                    border_color="#ffffff",
                    border_size=1,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="icone",
                    icon_set="geocaching",
                    icon_size=18,
                    appear_animation=True,
                    recent_glow_days=90
                ),
                # Flash « cible » : le point de passage atteint, aux couleurs
                # du type de cache.
                flash=FlashOptions(
                    mode="target",
                    duration=900,
                    size=46,
                    color="#c2410c",
                    color_type="gc"
                ),
                # Le sentier : tirets rouille (le balisage), courbes douces,
                # arcs pour les grands sauts, et tout le parcours reste tracé.
                trail=TrailOptions(
                    enabled=True,
                    routing="clusters",
                    jump_style="arc",
                    curve="smooth",
                    color="#c2410c",
                    width=4,
                    opacity=90,
                    line_style="dashed",
                    effect="none",
                    head="pulse",
                    persist_days=0
                ),
                infos=build_infos(
                    "Carnet des sentiers",
                    """
                    color: #1c1917;
                    background: rgba(255, 255, 255, 0.94);
                    padding: 10px 16px 10px 14px;
                    border-radius: 6px;
                    border-left: 6px solid #c2410c;
                    font-family: Georgia;
                    font-weight: 700;
                    letter-spacing: 0.3px;
                    box-shadow: 0 8px 20px rgba(28, 25, 23, 0.2);
                    """,
                    """
                    color: #1c1917;
                    background: rgba(255, 255, 255, 0.92);
                    padding: 8px 12px;
                    border-radius: 6px;
                    border-bottom: 3px solid #c2410c;
                    font-variant-numeric: tabular-nums;
                    box-shadow: 0 6px 16px rgba(28, 25, 23, 0.14);
                    """
                )
            ),

            # Thèmes du mode Évolution (EXAMPLES_VERSION 4) : des dizaines de
            # milliers de caches à l'écran. Points de 1 ou 2 px sans contour,
            # flashs petits et brefs — plusieurs dizaines peuvent partir sur la
            # même image. Les trois premiers déclinent des thèmes du mode
            # principal : « Default », « Black » et « Encre & Papier ».
            "Évolution Classique": MapProfile(
                name="Évolution Classique",
                mode=PROFILE_MODE_EVOLUTION,
                map=MapOptions(
                    tile_provider="OSM",
                    vector_options=VectorMapOptions(
                        stroke_color="#64748b",
                        fill_color="#e2e8f0",
                        background_color="#f8fafc",
                        stroke_width=1.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=2,
                    color="#d32f2f",
                    shape="circle",
                    halo=False,
                    border_color="#ffffff",
                    border_size=0,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="circle",
                    duration=400,
                    size=16,
                    color="#f59e0b",
                    color_type="gc",
                    disappear=DisappearFlashOptions(mode="implode", size=12, color="#616161")
                ),
                infos=build_infos(
                    "Évolution des géocaches",
                    """
                    color: #ffffff;
                    background: rgba(15, 23, 42, 0.78);
                    padding: 10px 16px;
                    border-radius: 999px;
                    font-weight: 700;
                    letter-spacing: 0.4px;
                    box-shadow: 0 10px 25px rgba(15, 23, 42, 0.24);
                    """,
                    """
                    color: #0f172a;
                    background: rgba(255, 255, 255, 0.88);
                    padding: 8px 12px;
                    border-radius: 10px;
                    border: 1px solid rgba(148, 163, 184, 0.5);
                    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.12);
                    """
                )
            ),

            "Évolution Black": MapProfile(
                name="Évolution Black",
                mode=PROFILE_MODE_EVOLUTION,
                map=MapOptions(
                    tile_provider="vectorMap",
                    vector_options=VectorMapOptions(
                        stroke_color="#fafafa",
                        fill_color="#000000",
                        background_color="#4d4c4c",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=1,
                    color="#8b3a2e",
                    shape="circle",
                    halo=False,
                    border_color="#f6f0e3",
                    border_size=0,
                    fill_color_type="gc",
                    border_color_type="gc",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="sparkle",
                    duration=400,
                    size=6,
                    color="#fbff00",
                    color_type="fix",
                    disappear=DisappearFlashOptions(mode="implode", size=10, color="#9E9E9E")
                ),
                infos=build_infos(
                    "Black Geocaching",
                    """
                    color: #f8fafc;
                    background: rgba(11, 16, 32, 0.76);
                    padding: 8px 12px;
                    border-radius: 8px;
                    border-left: 3px solid #6ef2ff;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
                    """,
                    """
                    color: #f8fafc;
                    background: rgba(11, 16, 32, 0.76);
                    padding: 8px 12px;
                    border-radius: 8px;
                    border-left: 3px solid #6ef2ff;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
                    """
                )
            ),

            "Évolution Nuit": MapProfile(
                name="Évolution Nuit",
                mode=PROFILE_MODE_EVOLUTION,
                map=MapOptions(
                    tile_provider="vectorMap",
                    vector_options=VectorMapOptions(
                        stroke_color="#334155",
                        fill_color="#111827",
                        background_color="#030712",
                        stroke_width=1.0
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                points=PointStyle(
                    size=1,
                    color="#fde047",
                    shape="circle",
                    halo=False,
                    border_color="#000000",
                    border_size=0,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel",
                    recent_glow_days=30
                ),
                flash=FlashOptions(
                    mode="impulse",
                    duration=400,
                    size=12,
                    color="#fef9c3",
                    color_type="fix",
                    disappear=DisappearFlashOptions(mode="implode", size=10, color="#ef4444")
                ),
                infos=build_infos(
                    "ÉVOLUTION DES GÉOCACHES",
                    """
                    color: #fef9c3;
                    background: rgba(3, 7, 18, 0.78);
                    padding: 10px 18px;
                    border-radius: 999px;
                    border: 1px solid rgba(253, 224, 71, 0.5);
                    font-weight: 700;
                    letter-spacing: 1.6px;
                    """,
                    """
                    color: #e2e8f0;
                    background: rgba(3, 7, 18, 0.72);
                    padding: 8px 13px;
                    border-radius: 999px;
                    font-variant-numeric: tabular-nums;
                    """
                )
            ),

            "Évolution Encre": MapProfile(
                name="Évolution Encre",
                mode=PROFILE_MODE_EVOLUTION,
                map=MapOptions(
                    tile_provider="stamenToner",
                    vector_options=VectorMapOptions(
                        stroke_color="#292524",
                        fill_color="#e7e5e4",
                        background_color="#fafaf9",
                        stroke_width=1.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                points=PointStyle(
                    size=2,
                    color="#1c1917",
                    shape="circle",
                    halo=False,
                    border_color="#ffffff",
                    border_size=0,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="none",
                    duration=400,
                    size=12,
                    color="#1c1917",
                    color_type="none",
                    disappear=DisappearFlashOptions(mode="none", size=10, color="#9E9E9E")
                ),
                infos=build_infos(
                    "ÉVOLUTION DES GÉOCACHES",
                    """
                    color: #1c1917;
                    background: rgba(250, 250, 249, 0.94);
                    padding: 9px 14px;
                    border-radius: 2px;
                    border: 1px solid #292524;
                    font-family: Georgia;
                    font-weight: 700;
                    letter-spacing: 1.4px;
                    """,
                    """
                    color: #292524;
                    background: rgba(250, 250, 249, 0.92);
                    padding: 7px 11px;
                    border-radius: 2px;
                    border-bottom: 2px solid #292524;
                    font-variant-numeric: tabular-nums;
                    """
                )
            ),
        }
        return example_profiles

    def _blank_profile(self, mode: str) -> MapProfile:
        """Thème aux valeurs par défaut de `mode` (création, réinitialisation).

        Les défauts de MapProfile sont ceux du mode principal (points de 8 px) ;
        un thème Évolution part du thème d'exemple de premier lancement.
        """
        if mode == PROFILE_MODE_EVOLUTION:
            return self._example_profile_definitions()[FIRST_LAUNCH_EVOLUTION_PROFILE]
        return MapProfile()

    def _create_example_profiles(self, only: Optional[set] = None) -> None:
        """Crée des profils d'exemple (tous, ou seulement ceux nommés dans `only`)"""
        # Créer chaque profil s'il n'existe pas déjà
        for profile_name, profile_data in self._example_profile_definitions().items():
            if only is not None and profile_name not in only:
                continue
            profile_path = self._profile_path(profile_name)
            if not profile_path.exists():
                self.save_profile(profile_data)

    # App settings
    def get_app_settings(self) -> AppSettings:
        with self._app_settings_lock:
            data = read_json(SETTINGS_PATH)
            settings = coerce_settings(data)

            # Si un profil pointé n'existe plus (ex: après suppression des fichiers de profils),
            # on nettoie la référence pour éviter des erreurs 404 récurrentes au démarrage.
            # Les deux références sont examinées avant l'écriture : une seule
            # sauvegarde, même si les deux pointent sur le profil supprimé.
            # Une référence vers un thème de l'autre mode est effacée de la
            # même façon : la page le chargerait sans pouvoir le montrer dans
            # sa liste.
            stale = False
            for attr, mode in (
                ("default_profile_uid", PROFILE_MODE_MAIN),
                ("last_profile_uid", PROFILE_MODE_MAIN),
                ("evolution_default_profile_uid", PROFILE_MODE_EVOLUTION),
                ("evolution_last_profile_uid", PROFILE_MODE_EVOLUTION),
            ):
                uid = getattr(settings, attr)
                if uid and self.get_profile_mode_by_uid(uid) != mode:
                    logging.warning("Thème référencé par %s introuvable (uid=%s), réinitialisation.", attr, uid)
                    setattr(settings, attr, None)
                    stale = True
            if stale:
                self.save_app_settings(settings)

            return settings

    def save_app_settings(self, settings: AppSettings) -> None:
        with self._app_settings_lock:
            write_json(SETTINGS_PATH, asdict(settings))

    def update_app_settings(self, mutate: Callable[[AppSettings], AppSettings]) -> AppSettings:
        """Lit, transforme et réécrit les préférences globales sans interruption.

        À utiliser dès qu'une écriture dépend de l'état déjà enregistré — soit
        toute écriture partielle, puisque les champs absents de la requête sont
        repris de l'existant. `mutate` reçoit les préférences courantes et
        renvoie celles à écrire ; elle est appelée verrou tenu, donc courte et
        sans entrée/sortie autre que celles du gestionnaire.
        """
        with self._app_settings_lock:
            updated = mutate(self.get_app_settings())
            self.save_app_settings(updated)
            return updated

    def reset_app_settings(self) -> None:
        # examples_seeded et examples_version sont des flags internes de migration,
        # pas des préférences utilisateur : un reset des paramètres ne doit pas
        # faire revenir les profils d'exemple supprimés.
        self.update_app_settings(
            lambda current: AppSettings(
                examples_seeded=current.examples_seeded,
                examples_version=current.examples_version,
            )
        )

    # Profiles
    @staticmethod
    def _profile_file_key(name: str) -> str:
        """Nom de fichier (sans extension) correspondant à un nom de profil.

        Ne conserve que les caractères alphanumériques, '-' et '_' : deux noms qui
        se réduisent à la même clé partagent le même fichier ("Mon Profil" et
        "MonProfil"). La modale de nom reproduit cette règle pour montrer la
        collision à la saisie (cf. profileNameKey() dans static/js/profiles.js).

        Peut être vide : c'est à l'appelant de refuser un tel nom (voir
        _require_valid_profile_name) plutôt que de le laisser retomber sur un
        fichier générique qui écraserait un profil existant.
        """
        return "".join(c for c in name if c.isalnum() or c in ("-", "_"))

    def _require_valid_profile_name(self, name: str) -> str:
        """Valide un nom fourni par l'utilisateur et retourne sa forme nettoyée."""
        name = (name or "").strip()
        if not self._profile_file_key(name):
            raise InvalidProfileNameError(
                _tr("Le nom '%(name)s' ne contient aucun caractère utilisable "
                    "(au moins une lettre ou un chiffre est nécessaire)", name=name)
            )
        return name

    def _profile_path(self, name: str) -> Path:
        return PROFILES_DIR / f"{self._profile_file_key(name) or 'Default'}.json"

    def list_profiles(self, mode: Optional[str] = None) -> List[str]:
        """Noms des thèmes (pas des fichiers) ; ceux de `mode` seulement s'il est donné."""
        self._ensure_profile_cache()
        if mode is None:
            return sorted(self._name_to_path_cache)
        return sorted(name for name, m in self._name_to_mode_cache.items() if m == mode)

    def list_profiles_with_modes(self) -> List[dict]:
        """Tous les thèmes avec leur mode : `[{"name": ..., "mode": ...}]`.

        Les noms sont uniques tous modes confondus (un fichier par nom) : une
        page a besoin de ceux de l'autre mode pour signaler une collision.
        """
        self._ensure_profile_cache()
        return [{"name": name, "mode": self._name_to_mode_cache[name]} for name in sorted(self._name_to_mode_cache)]

    def load_profile(self, name: str) -> MapProfile:
        path = self._profile_path(name)
        if not path.exists():
            raise FileNotFoundError(_tr("Thème '%(name)s' introuvable", name=name))
        return coerce_profile(read_json(path))

    def load_profile_by_uid(self, uid: str) -> MapProfile:
        """Charge un profil par son UUID"""
        # Utiliser le cache uid→path
        self._ensure_profile_cache()
        profile_path = self._uid_to_path_cache.get(uid)
        if profile_path and profile_path.exists():
            try:
                profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                return coerce_profile(profile_data)
            except Exception as e:
                logging.warning("Erreur lors de la lecture du profil %s: %s", profile_path, e)
                # Fallback: reconstruire le cache et réessayer une fois
                self._build_profile_cache()
                profile_path = self._uid_to_path_cache.get(uid)
                if profile_path and profile_path.exists():
                    profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                    return coerce_profile(profile_data)
        
        raise FileNotFoundError(_tr("Aucun thème trouvé avec l'UUID: %(uid)s", uid=uid))

    def get_profile_name_by_uid(self, uid: str) -> Optional[str]:
        """Retourne le nom d'un profil par son UUID (sans relire le fichier)"""
        self._ensure_profile_cache()
        return self._uid_to_name_cache.get(uid)

    def get_profile_mode_by_uid(self, uid: str) -> Optional[str]:
        """Mode d'un thème par son UUID, None s'il n'existe pas."""
        self._ensure_profile_cache()
        return self._uid_to_mode_cache.get(uid)

    @_profiles_locked
    def save_profile(self, profile: MapProfile) -> None:
        write_json(self._profile_path(profile.name), asdict(profile))
        self._invalidate_profile_cache()

    def is_name_available(self, name: str, exclude_uid: Optional[str] = None) -> bool:
        """Vérifie si un nom de profil est libre.

        Un nom est considéré pris si le fichier sanitizé correspondant existe déjà,
        sauf si ce fichier appartient au profil `exclude_uid` (renommage cosmétique
        d'un profil vers un nom qui sanitize vers le même fichier que l'actuel).
        """
        path = self._profile_path(name)
        if not path.exists():
            return True
        if exclude_uid is None:
            return False
        return read_json(path).get("uid") == exclude_uid

    @_profiles_locked
    def create_profile(self, name: str, base: Optional[str] = None, mode: str = PROFILE_MODE_MAIN) -> MapProfile:
        name = self._require_valid_profile_name(name)
        mode = _coerce_choice(mode, PROFILE_MODES, PROFILE_MODE_MAIN)
        if not self.is_name_available(name):
            raise ValueError(_tr("Un thème nommé '%(name)s' existe déjà", name=name))
        if base and self._profile_path(base).exists():
            prof = self.load_profile(base)
        else:
            prof = self._blank_profile(mode)
        prof.name = name
        prof.uid = uuid.uuid4().hex
        prof.mode = mode
        self.save_profile(prof)
        return prof

    @_profiles_locked
    def rename_profile(self, old_name: str, new_name: str) -> MapProfile:
        """Renomme un profil de façon atomique (conserve son UUID).

        Écrit d'abord le nouveau fichier puis supprime l'ancien, sauf si les deux
        noms sanitizent vers le même fichier (auquel cas il n'y a rien à supprimer).
        """
        old_path = self._profile_path(old_name)
        if not old_path.exists():
            raise FileNotFoundError(_tr("Thème '%(name)s' introuvable", name=old_name))

        new_name = self._require_valid_profile_name(new_name)
        prof = coerce_profile(read_json(old_path))
        if new_name != prof.name and not self.is_name_available(new_name, exclude_uid=prof.uid):
            raise ValueError(_tr("Un thème nommé '%(name)s' existe déjà", name=new_name))

        prof.name = new_name
        new_path = self._profile_path(new_name)
        self.save_profile(prof)
        if new_path != old_path and old_path.exists():
            self._remove_profile_file(old_path)
        return prof

    @_profiles_locked
    def duplicate_profile(self, name: str, new_name: str) -> MapProfile:
        if not self._profile_path(name).exists():
            raise ValueError(_tr("Thème source '%(name)s' introuvable", name=name))
        new_name = self._require_valid_profile_name(new_name)
        prof = self.load_profile(name)
        prof.name = self._generate_unique_name(new_name)
        prof.uid = uuid.uuid4().hex
        self.save_profile(prof)
        return prof

    @_profiles_locked
    def copy_profile_to_mode(self, name: str, target_mode: str, new_name: str) -> MapProfile:
        """Copie un thème dans l'autre mode, tailles ramenées à son échelle.

        Une copie et non un déplacement : l'original reste disponible dans son
        mode, inchangé (voir convert_profile_for_mode pour ce qui est adapté).
        """
        if target_mode not in PROFILE_MODES:
            raise ValueError(_tr("Mode de thème inconnu"))
        prof = self.load_profile(name)  # FileNotFoundError si absent
        if prof.mode == target_mode:
            raise ValueError(_tr("Le thème '%(name)s' appartient déjà à ce mode", name=name))
        new_name = self._require_valid_profile_name(new_name)
        convert_profile_for_mode(prof, target_mode)
        prof.name = self._generate_unique_name(new_name)
        prof.uid = uuid.uuid4().hex
        self.save_profile(prof)
        return prof

    @_profiles_locked
    def delete_profile(self, name: str) -> None:
        # Une suppression sur un profil absent est signalée (comme load_profile
        # et rename_profile) : sans cela l'appelant croit avoir supprimé un
        # profil qui n'a jamais existé, ce qui masque une désynchronisation
        # entre la liste affichée et le disque.
        path = self._profile_path(name)
        if not path.exists():
            raise FileNotFoundError(_tr("Thème '%(name)s' introuvable", name=name))
        self._remove_profile_file(path)

    def _remove_profile_file(self, path: Path) -> None:
        # Le .bak laissé par atomic_write() part avec son thème : sinon il
        # reste indéfiniment dans le dossier, invisible (list_profiles ne lit
        # que les *.json) et jamais réutilisé.
        path.unlink()
        backup_path(path).unlink(missing_ok=True)
        self._invalidate_profile_cache()

    @_profiles_locked
    def reset_profile(self, name: str) -> MapProfile:
        """Remet un thème à son état d'origine, sous le même nom et le même uid.

        Un thème d'exemple retrouve sa définition d'origine, les autres les
        valeurs par défaut. L'uid est conservé : un uid neuf rendait orphelines
        les références de settings.json (thème par défaut, dernier thème
        actif), que get_app_settings() effaçait alors sans rien dire.
        """
        current = self.load_profile(name)  # FileNotFoundError si absent
        prof = self._example_profile_definitions().get(current.name)
        # Un thème de l'utilisateur peut porter le nom d'un exemple de l'autre
        # mode (après suppression de celui-ci) : il n'en reprend pas le design.
        if prof is None or prof.mode != current.mode:
            prof = self._blank_profile(current.mode)
        prof.name = current.name
        prof.uid = current.uid
        prof.mode = current.mode
        self.save_profile(prof)
        return prof

    # ---------- Import/Export utilitaires ----------
    def _name_exists(self, name: str) -> bool:
        return self._profile_path(name).exists()

    def _uid_exists(self, uid: str) -> bool:
        self._ensure_profile_cache()
        return uid in self._uid_to_path_cache

    def _generate_unique_name(self, base_name: str) -> str:
        if not self._name_exists(base_name):
            return base_name
        idx = 1
        while True:
            candidate = f"{base_name} ({idx})"
            if not self._name_exists(candidate):
                return candidate
            idx += 1

    def _profile_to_dict(self, prof: MapProfile) -> dict:
        """Convertit un MapProfile en dictionnaire pour l'API/export."""
        return {
            'version': prof.version,
            'name': prof.name,
            'uid': prof.uid,
            'mode': prof.mode,
            'map': {
                'tile_provider': prof.map.tile_provider,
                'vector_options': {
                    'stroke_color': prof.map.vector_options.stroke_color,
                    'fill_color': prof.map.vector_options.fill_color,
                    'background_color': prof.map.vector_options.background_color,
                    'stroke_width': prof.map.vector_options.stroke_width,
                },
                'toner_options': {
                    'variant': prof.map.toner_options.variant,
                },
            },
            'points': {
                'size': prof.points.size,
                'color': prof.points.color,
                'shape': prof.points.shape,
                'halo': prof.points.halo,
                'border_color': prof.points.border_color,
                'border_size': prof.points.border_size,
                'fill_color_type': prof.points.fill_color_type,
                'border_color_type': prof.points.border_color_type,
                'mode': prof.points.mode,
                'icon_set': prof.points.icon_set,
                'icon_size': prof.points.icon_size,
                'appear_animation': prof.points.appear_animation,
                'recent_glow_days': prof.points.recent_glow_days,
            },
            'flash': {
                'mode': prof.flash.mode,
                'duration': prof.flash.duration,
                'size': prof.flash.size,
                'color': prof.flash.color,
                'color_type': prof.flash.color_type,
                'border_color': prof.flash.border_color,
                'border_color_type': prof.flash.border_color_type,
                'disappear': {
                    'mode': prof.flash.disappear.mode,
                    'size': prof.flash.disappear.size,
                    'color': prof.flash.disappear.color,
                    'color_type': prof.flash.disappear.color_type,
                    'border_color': prof.flash.disappear.border_color,
                    'border_color_type': prof.flash.disappear.border_color_type,
                },
            },
            'infos': {
                'title': {
                    'display': prof.infos.title.display,
                    'text': prof.infos.title.text,
                },
                'number_of_caches': prof.infos.number_of_caches,
                'current_date': prof.infos.current_date,
                'title_css': prof.infos.title_css,
                'infos_css': prof.infos.infos_css,
            },
            'trail': {
                'enabled': prof.trail.enabled,
                'routing': prof.trail.routing,
                'cluster_km': prof.trail.cluster_km,
                'jump_km': prof.trail.jump_km,
                'jump_style': prof.trail.jump_style,
                'curve': prof.trail.curve,
                'color': prof.trail.color,
                'width': prof.trail.width,
                'opacity': prof.trail.opacity,
                'line_style': prof.trail.line_style,
                'effect': prof.trail.effect,
                'head': prof.trail.head,
                'persist_days': prof.trail.persist_days,
            },
        }

    def export_profile_payload(self, name: str, app_version: str) -> dict:
        prof = self.load_profile(name)
        profile_dict = self._profile_to_dict(prof)
        
        payload = {
            "$schema": "mygcflow.profile.v1",
            "kind": "profile",
            "app": APP_NAME,
            "app_version": app_version,
            "profile": profile_dict,
        }
        return payload

    @_profiles_locked
    def import_profile_payload(self, payload: dict) -> MapProfile:
        """Importe un profil depuis un payload JSON validé. Retourne le profil sauvegardé."""
        if not isinstance(payload, dict):
            raise ValueError(_tr("Payload invalide"))
        # "gcmap.profile.v1" : profils exportés avant le changement de nom.
        if payload.get("$schema") not in ("mygcflow.profile.v1", "gcmap.profile.v1")                 or payload.get("kind") != "profile":
            raise ValueError(_tr("Fichier de thème invalide (détrompeur manquant)"))

        prof_dict = payload.get("profile")
        if not isinstance(prof_dict, dict):
            raise ValueError(_tr("Section 'profile' manquante"))

        prof = coerce_profile(prof_dict)

        # Gérer conflits de nom. Un nom sans caractère utilisable (« !!! », ou
        # autre chose qu'un texte) retomberait sur le fichier générique
        # Default.json : on lui substitue un nom neutre.
        raw_name = prof.name.strip() if isinstance(prof.name, str) else ""
        if not self._profile_file_key(raw_name):
            raw_name = "Imported"
        prof.name = self._generate_unique_name(raw_name)

        # Gérer collisions d'UUID
        if not prof.uid or self._uid_exists(prof.uid):
            prof.uid = uuid.uuid4().hex

        self.save_profile(prof)
        return prof


_settings_manager_singleton: Optional["SettingsManager"] = None


def get_settings_manager() -> "SettingsManager":
    """Retourne l'instance partagée de SettingsManager.

    Instancier plusieurs SettingsManager fait vivre plusieurs caches
    uid->path indépendants : une modification via l'un ne se répercute pas
    sur les autres, ce qui peut faire échouer un load_profile_by_uid juste
    après une écriture faite ailleurs. Un singleton évite cette désynchro.
    """
    global _settings_manager_singleton
    if _settings_manager_singleton is None:
        _settings_manager_singleton = SettingsManager()
    return _settings_manager_singleton

