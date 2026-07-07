from __future__ import annotations
from dataclasses import dataclass, field, asdict
from pathlib import Path
import json
import os
import shutil
import uuid
from typing import Tuple, Optional, List
from dataclasses import field


APP_NAME = "GCMap"


def app_config_dir() -> Path:
    # Windows: %APPDATA%\GCMap ; fallback vers home si non défini
    base = os.getenv("APPDATA") or os.path.expanduser("~")
    return Path(base) / APP_NAME


CONFIG_DIR = app_config_dir()
PROFILES_DIR = CONFIG_DIR / "profiles"
SETTINGS_PATH = CONFIG_DIR / "settings.json"


def atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    bak = path.with_suffix(path.suffix + ".bak")
    tmp.write_text(data, encoding="utf-8")
    if path.exists():
        try:
            shutil.copy2(path, bak)
        except Exception:
            pass
    os.replace(tmp, path)


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
class AppSettings:
    version: int = 1
    language: str = "fr"
    check_updates: bool = True
    default_profile_uid: Optional[str] = None  # UUID du profil par défaut (None = aucun)
    map_default_center: Optional[Tuple[float, float]] = None
    map_default_zoom: Optional[int] = None


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
    tile_provider: str = "OpenStreetMap"
    default_center: Tuple[float, float] = (48.8566, 2.3522)
    default_zoom: int = 6
    vector_options: VectorMapOptions = field(default_factory=VectorMapOptions)
    toner_options: TonerMapOptions = field(default_factory=TonerMapOptions)
    # Réservé à l'avenir: support d'options spécifiques providers (souples)
    # extra: dict = field(default_factory=dict)


@dataclass
class AnimationOptions:
    enabled: bool = True
    speed: float = 1.0


@dataclass
class FlashOptions:
    mode: str = "circle"  # "none", "circle", "star", "sparkle", "square", "triangle", "diamond"
    duration: int = 1000  # en ms
    size: int = 50  # en px
    color: str = "#FF00FF"
    color_type: str = "fix"  # "gc", "none", "fix"


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
    version: int = 1
    name: str = "Default"
    uid: str = field(default_factory=lambda: uuid.uuid4().hex)
    map: MapOptions = field(default_factory=MapOptions)
    animation: AnimationOptions = field(default_factory=AnimationOptions)
    points: PointStyle = field(default_factory=PointStyle)
    flash: FlashOptions = field(default_factory=FlashOptions)
    infos: InfosOptions = field(default_factory=InfosOptions)


def coerce_settings(d: dict) -> AppSettings:
    s = AppSettings()
    if isinstance(d, dict):
        s.language = d.get("language", s.language)
        s.check_updates = bool(d.get("check_updates", s.check_updates))

        raw_center = d.get("map_default_center")
        if isinstance(raw_center, (list, tuple)) and len(raw_center) == 2:
            try:
                s.map_default_center = (float(raw_center[0]), float(raw_center[1]))
            except Exception:
                pass

        raw_zoom = d.get("map_default_zoom")
        if raw_zoom is not None:
            try:
                s.map_default_zoom = int(raw_zoom)
            except Exception:
                pass

        if d.get("default_profile_uid"):
            s.default_profile_uid = d.get("default_profile_uid")

        try:
            s.version = int(d.get("version", s.version))
        except Exception:
            s.version = s.version
    return s


def coerce_profile(d: dict) -> MapProfile:
    p = MapProfile()
    if isinstance(d, dict):
        p.name = d.get("name", p.name)
        try:
            p.version = int(d.get("version", p.version))
        except Exception:
            p.version = p.version
        p.uid = d.get("uid", p.uid)

        # Options de carte
        m = d.get("map", {}) if isinstance(d.get("map", {}), dict) else {}
        default_center = m.get("default_center", p.map.default_center)
        try:
            default_center_tuple = (float(default_center[0]), float(default_center[1]))
        except Exception:
            default_center_tuple = p.map.default_center

        # Options vectorielles
        raw_vm = m.get("vector_options") or {}
        vm = raw_vm if isinstance(raw_vm, dict) else {}
        vector_options = VectorMapOptions(
            stroke_color=vm.get("stroke_color", p.map.vector_options.stroke_color),
            fill_color=vm.get("fill_color", p.map.vector_options.fill_color),
            background_color=vm.get("background_color", p.map.vector_options.background_color),
            stroke_width=float(vm.get("stroke_width", p.map.vector_options.stroke_width)),
        )

        # Options Toner
        raw_tm = m.get("toner_options") or {}
        tm = raw_tm if isinstance(raw_tm, dict) else {}
        toner_options = TonerMapOptions(
            variant=tm.get("variant", p.map.toner_options.variant),
        )

        p.map = MapOptions(
            tile_provider=m.get("tile_provider", p.map.tile_provider),
            default_center=default_center_tuple,
            default_zoom=int(m.get("default_zoom", p.map.default_zoom)),
            vector_options=vector_options,
            toner_options=toner_options,
        )

        # Options d'animation
        a = d.get("animation", {}) if isinstance(d.get("animation", {}), dict) else {}
        p.animation = AnimationOptions(
            enabled=bool(a.get("enabled", p.animation.enabled)),
            speed=float(a.get("speed", p.animation.speed)),
        )

        # Options des points
        pt = d.get("points", {}) if isinstance(d.get("points", {}), dict) else {}
        p.points = PointStyle(
            size=int(pt.get("size", p.points.size)),
            color=pt.get("color", p.points.color),
            shape=pt.get("shape", p.points.shape),
            halo=bool(pt.get("halo", p.points.halo)),
            border_color=pt.get("border_color", p.points.border_color),
            border_size=int(pt.get("border_size", p.points.border_size)),
            fill_color_type=pt.get("fill_color_type", p.points.fill_color_type),
            border_color_type=pt.get("border_color_type", p.points.border_color_type),
            mode=pt.get("mode", p.points.mode),
            icon_set=pt.get("icon_set", p.points.icon_set) or p.points.icon_set,
            icon_size=int(pt.get("icon_size", p.points.icon_size) or p.points.icon_size),
        )

        # Options flash
        f = d.get("flash", {}) if isinstance(d.get("flash", {}), dict) else {}
        p.flash = FlashOptions(
            mode=f.get("mode", p.flash.mode),
            duration=int(f.get("duration", p.flash.duration)),
            size=int(f.get("size", p.flash.size)),
            color=f.get("color", p.flash.color),
            color_type=f.get("color_type", p.flash.color_type),
        )

        # Options infos (titre, cases à cocher, CSS)
        i = d.get("infos", {}) if isinstance(d.get("infos", {}), dict) else {}
        t = i.get("title", {}) if isinstance(i.get("title", {}), dict) else {}
        p.infos = InfosOptions(
            title=InfosTitle(
                display=bool(t.get("display", p.infos.title.display)),
                text=t.get("text", p.infos.title.text),
            ),
            number_of_caches=bool(i.get("number_of_caches", p.infos.number_of_caches)),
            current_date=bool(i.get("current_date", p.infos.current_date)),
            title_css=i.get("title_css", p.infos.title_css) or "",
            infos_css=i.get("infos_css", p.infos.infos_css) or "",
        )

    return p


class SettingsManager:
    def __init__(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        if not SETTINGS_PATH.exists():
            self.save_app_settings(AppSettings())

        # Cache uid→path pour éviter les scans disque répétés
        self._uid_to_path_cache: dict[str, Path] = {}
        self._build_uid_cache()

        # Créer des profils d'exemple si c'est le premier lancement
        self._create_example_profiles()

    def _build_uid_cache(self) -> None:
        """Construit le cache uid→path en scannant une fois les profils."""
        self._uid_to_path_cache.clear()
        for profile_file in PROFILES_DIR.glob("*.json"):
            try:
                data = read_json(profile_file)
                uid = data.get("uid")
                if uid:
                    self._uid_to_path_cache[uid] = profile_file
            except Exception:
                continue

    def _invalidate_uid_cache(self) -> None:
        """Invalide et reconstruit le cache uid→path."""
        self._build_uid_cache()

    def _create_example_profiles(self) -> None:
        """Crée des profils d'exemple au premier lancement"""
        def build_infos(title_text: str, title_css: str, infos_css: str) -> InfosOptions:
            return InfosOptions(
                title=InfosTitle(display=True, text=title_text),
                number_of_caches=True,
                current_date=True,
                title_css=title_css.strip(),
                infos_css=infos_css.strip(),
            )

        example_profiles = {
            "Default": MapProfile(
                name="Default",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(48.8566, 2.3522),  # Paris
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#1f2937",
                        fill_color="#f97316",
                        background_color="#f8fafc",
                        stroke_width=2.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.0),
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
                    duration=900,
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
                    default_center=(48.8566, 2.3522),
                    default_zoom=7,
                    vector_options=VectorMapOptions(
                        stroke_color="#6ef2ff",
                        fill_color="#111827",
                        background_color="#020617",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                animation=AnimationOptions(enabled=True, speed=1.4),
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
                    duration=1200,
                    size=65,
                    color="#ff4fd8",
                    color_type="fix"
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
                    default_center=(46.603354, 1.888334),  # Centre de la France
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#b08968",
                        fill_color="#e6ccb2",
                        background_color="#fff8eb",
                        stroke_width=1.4
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=0.95),
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
                    icon_size=22
                ),
                flash=FlashOptions(
                    mode="none",
                    duration=900,
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
                    default_center=(45.7640, 4.8357),  # Lyon
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#6b5b4d",
                        fill_color="#d8ccb4",
                        background_color="#efe6d2",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=0.85),
                points=PointStyle(
                    size=8,
                    color="#8b3a2e",
                    shape="triangle",
                    halo=True,
                    border_color="#f6f0e3",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="none",
                    duration=1000,
                    size=40,
                    color="#8b3a2e",
                    color_type="none"
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
                    default_center=(46.0, 2.0),  # Vue large sur la France
                    default_zoom=5,
                    vector_options=VectorMapOptions(
                        stroke_color="#111827",
                        fill_color="#ff6b35",
                        background_color="#ffffff",
                        stroke_width=2.8
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=2.0),
                points=PointStyle(
                    size=10,
                    color="#ff6b35",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=3,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="square",
                    duration=700,
                    size=90,
                    color="#ffd166",
                    color_type="fix"
                ),
                infos=build_infos(
                    "GCMap Highlights",
                    """
                    color: #ffffff;
                    background: rgba(17, 24, 39, 0.85);
                    padding: 14px 18px;
                    border-radius: 12px;
                    font-size: 32px;
                    font-weight: 800;
                    letter-spacing: 1px;
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
                    """,
                    """
                    color: #111827;
                    background: rgba(255, 255, 255, 0.92);
                    padding: 10px 14px;
                    border-radius: 10px;
                    border-left: 4px solid #ff6b35;
                    box-shadow: 0 10px 24px rgba(17, 24, 39, 0.12);
                    """
                )
            ),

            "Bonbon Pop": MapProfile(
                name="Bonbon Pop",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(46.603354, 1.888334),  # France
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#ff4d9d",
                        fill_color="#ffe14d",
                        background_color="#fff5fb",
                        stroke_width=2.4
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.6),
                points=PointStyle(
                    size=10,
                    color="#ff4d9d",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=3,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="sparkle",
                    duration=800,
                    size=70,
                    color="#ffe14d",
                    color_type="fix"
                ),
                infos=build_infos(
                    "Candy Cache Map",
                    """
                    color: #ff2e88;
                    background: rgba(255, 255, 255, 0.92);
                    padding: 10px 18px;
                    border-radius: 999px;
                    font-weight: 800;
                    letter-spacing: 0.5px;
                    box-shadow: 0 10px 24px rgba(255, 77, 157, 0.32);
                    """,
                    """
                    color: #ff2e88;
                    background: rgba(255, 245, 251, 0.94);
                    padding: 8px 14px;
                    border-radius: 999px;
                    border: 2px solid #ffd1e8;
                    box-shadow: 0 8px 18px rgba(255, 77, 157, 0.18);
                    """
                )
            ),

            "Coucher Tropical": MapProfile(
                name="Coucher Tropical",
                map=MapOptions(
                    tile_provider="watercolor",
                    default_center=(43.7102, 7.2620),  # Méditerranée (Nice)
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#ff6b6b",
                        fill_color="#ffd29d",
                        background_color="#fff3e0",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.1),
                points=PointStyle(
                    size=9,
                    color="#ff6b6b",
                    shape="circle",
                    halo=True,
                    border_color="#fff3e0",
                    border_size=2,
                    fill_color_type="gc",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="diamond",
                    duration=1000,
                    size=60,
                    color="#ff9e2c",
                    color_type="gc"
                ),
                infos=build_infos(
                    "Sunset Cache Trail",
                    """
                    color: #fff3e0;
                    background: linear-gradient(135deg, #ff9e2c 0%, #ff6b6b 100%);
                    padding: 12px 18px;
                    border-radius: 14px;
                    font-weight: 700;
                    letter-spacing: 0.6px;
                    box-shadow: 0 12px 26px rgba(255, 107, 107, 0.3);
                    """,
                    """
                    color: #7a3b1d;
                    background: rgba(255, 243, 224, 0.92);
                    padding: 8px 14px;
                    border-radius: 12px;
                    border-left: 4px solid #ff9e2c;
                    box-shadow: 0 8px 18px rgba(255, 107, 107, 0.16);
                    """
                )
            ),

            "Forêt Émeraude": MapProfile(
                name="Forêt Émeraude",
                map=MapOptions(
                    tile_provider="vectorMap",
                    default_center=(45.8992, 6.1294),  # Alpes (Annecy)
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#1b4332",
                        fill_color="#95d5b2",
                        background_color="#ecf8f0",
                        stroke_width=1.6
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=0.9),
                points=PointStyle(
                    size=8,
                    color="#2d6a4f",
                    shape="triangle",
                    halo=True,
                    border_color="#d8f3dc",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="triangle",
                    duration=1000,
                    size=50,
                    color="#74c69d",
                    color_type="fix"
                ),
                infos=build_infos(
                    "Forest Geocaching",
                    """
                    color: #1b4332;
                    background: rgba(236, 248, 240, 0.94);
                    padding: 10px 16px;
                    border-radius: 10px;
                    border: 1px solid #74c69d;
                    font-weight: 700;
                    letter-spacing: 0.4px;
                    box-shadow: 0 8px 20px rgba(45, 106, 79, 0.18);
                    """,
                    """
                    color: #1b4332;
                    background: rgba(216, 243, 220, 0.9);
                    padding: 8px 12px;
                    border-radius: 10px;
                    border-left: 4px solid #2d6a4f;
                    box-shadow: 0 6px 16px rgba(45, 106, 79, 0.14);
                    """
                )
            ),

            "Océan Bubble": MapProfile(
                name="Océan Bubble",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(48.3905, -4.4860),  # Côte (Brest)
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#0077b6",
                        fill_color="#90e0ef",
                        background_color="#f0fbff",
                        stroke_width=2.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.0),
                points=PointStyle(
                    size=9,
                    color="#00b4d8",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=3,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="circle",
                    duration=1000,
                    size=80,
                    color="#90e0ef",
                    color_type="fix"
                ),
                infos=build_infos(
                    "Ocean Cache Map",
                    """
                    color: #023e8a;
                    background: rgba(240, 251, 255, 0.92);
                    padding: 10px 18px;
                    border-radius: 999px;
                    font-weight: 700;
                    letter-spacing: 0.5px;
                    box-shadow: 0 10px 24px rgba(0, 180, 216, 0.26);
                    """,
                    """
                    color: #023e8a;
                    background: rgba(144, 224, 239, 0.32);
                    padding: 8px 14px;
                    border-radius: 999px;
                    border: 1px solid rgba(0, 180, 216, 0.5);
                    box-shadow: 0 8px 18px rgba(0, 180, 216, 0.16);
                    """
                )
            ),

            "Arcade 80": MapProfile(
                name="Arcade 80",
                map=MapOptions(
                    tile_provider="stamenToner",
                    default_center=(48.8566, 2.3522),  # Paris
                    default_zoom=7,
                    vector_options=VectorMapOptions(
                        stroke_color="#2effc7",
                        fill_color="#1a1a2e",
                        background_color="#0d0d1a",
                        stroke_width=1.8
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                animation=AnimationOptions(enabled=True, speed=1.8),
                points=PointStyle(
                    size=9,
                    color="#ffe14d",
                    shape="circle",
                    halo=True,
                    border_color="#ff2e88",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix",
                    mode="vectoriel"
                ),
                flash=FlashOptions(
                    mode="square",
                    duration=500,
                    size=50,
                    color="#2effc7",
                    color_type="fix"
                ),
                infos=build_infos(
                    "ARCADE CACHE RUN",
                    """
                    color: #2effc7;
                    background: rgba(13, 13, 26, 0.9);
                    padding: 10px 16px;
                    border-radius: 4px;
                    border: 2px solid #ff2e88;
                    font-family: monospace;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 3px;
                    box-shadow: 0 0 22px rgba(46, 255, 199, 0.25);
                    """,
                    """
                    color: #ffe14d;
                    background: rgba(13, 13, 26, 0.85);
                    padding: 8px 12px;
                    border-radius: 4px;
                    border-left: 3px solid #2effc7;
                    font-family: monospace;
                    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
                    """
                )
            ),

            "Fête Confetti": MapProfile(
                name="Fête Confetti",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(46.0, 2.0),  # Vue large sur la France
                    default_zoom=5,
                    vector_options=VectorMapOptions(
                        stroke_color="#7b2ff7",
                        fill_color="#ffd166",
                        background_color="#fffdf5",
                        stroke_width=2.2
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.5),
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
                    duration=800,
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
            )
        }

        # Créer chaque profil s'il n'existe pas déjà
        for profile_name, profile_data in example_profiles.items():
            profile_path = self._profile_path(profile_name)
            if not profile_path.exists():
                self.save_profile(profile_data)

    # App settings
    def get_app_settings(self) -> AppSettings:
        data = read_json(SETTINGS_PATH)
        settings = coerce_settings(data)

        # Si le profil par défaut pointé n'existe plus (ex: après suppression des fichiers de profils),
        # on nettoie la référence pour éviter des erreurs 404 récurrentes au démarrage.
        if settings.default_profile_uid and not self.get_profile_name_by_uid(settings.default_profile_uid):
            print(f"[SETTINGS] Profil par défaut introuvable (uid={settings.default_profile_uid}), réinitialisation.")
            settings.default_profile_uid = None
            self.save_app_settings(settings)

        return settings

    def save_app_settings(self, settings: AppSettings) -> None:
        write_json(SETTINGS_PATH, asdict(settings))

    def reset_app_settings(self) -> None:
        self.save_app_settings(AppSettings())

    # Profiles
    def _profile_path(self, name: str) -> Path:
        safe = "".join(c for c in name if c.isalnum() or c in ("-", "_")) or "Default"
        return PROFILES_DIR / f"{safe}.json"

    def list_profiles(self) -> List[str]:
        """Retourne la liste des noms de profils (pas les noms de fichiers)"""
        profiles = []
        for p in PROFILES_DIR.glob("*.json"):
            try:
                data = read_json(p)
                name = data.get("name", p.stem)
                profiles.append(name)
            except Exception:
                # En cas d'erreur, utiliser le nom du fichier comme fallback
                profiles.append(p.stem)
        return sorted(profiles)

    def load_profile(self, name: str) -> MapProfile:
        path = self._profile_path(name)
        return coerce_profile(read_json(path))

    def load_profile_by_uid(self, uid: str) -> MapProfile:
        """Charge un profil par son UUID"""
        # Utiliser le cache uid→path
        profile_path = self._uid_to_path_cache.get(uid)
        if profile_path and profile_path.exists():
            try:
                profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                return coerce_profile(profile_data)
            except Exception as e:
                print(f"Erreur lors de la lecture du profil {profile_path}: {e}")
                # Fallback: reconstruire le cache et réessayer une fois
                self._build_uid_cache()
                profile_path = self._uid_to_path_cache.get(uid)
                if profile_path and profile_path.exists():
                    profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                    return coerce_profile(profile_data)
        
        raise FileNotFoundError(f"Aucun profil trouvé avec l'UUID: {uid}")

    def get_profile_name_by_uid(self, uid: str) -> Optional[str]:
        """Retourne le nom d'un profil par son UUID"""
        try:
            profile = self.load_profile_by_uid(uid)
            return profile.name
        except FileNotFoundError:
            return None

    def save_profile(self, profile: MapProfile) -> None:
        write_json(self._profile_path(profile.name), asdict(profile))
        self._invalidate_uid_cache()

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

    def create_profile(self, name: str, base: Optional[str] = None) -> MapProfile:
        if not self.is_name_available(name):
            raise ValueError(f"Un profil nommé '{name}' existe déjà")
        if base and self._profile_path(base).exists():
            prof = self.load_profile(base)
            prof.name = name
            prof.uid = uuid.uuid4().hex
        else:
            prof = MapProfile(name=name)
        self.save_profile(prof)
        return prof

    def rename_profile(self, old_name: str, new_name: str) -> MapProfile:
        """Renomme un profil de façon atomique (conserve son UUID).

        Écrit d'abord le nouveau fichier puis supprime l'ancien, sauf si les deux
        noms sanitizent vers le même fichier (auquel cas il n'y a rien à supprimer).
        """
        old_path = self._profile_path(old_name)
        if not old_path.exists():
            raise FileNotFoundError(f"Profil '{old_name}' introuvable")

        prof = coerce_profile(read_json(old_path))
        if new_name != prof.name and not self.is_name_available(new_name, exclude_uid=prof.uid):
            raise ValueError(f"Un profil nommé '{new_name}' existe déjà")

        prof.name = new_name
        new_path = self._profile_path(new_name)
        self.save_profile(prof)
        if new_path != old_path and old_path.exists():
            old_path.unlink()
            self._invalidate_uid_cache()
        return prof

    def duplicate_profile(self, name: str, new_name: str) -> MapProfile:
        if not self._profile_path(name).exists():
            raise ValueError(f"Profil source '{name}' introuvable")
        prof = self.load_profile(name)
        prof.name = self._generate_unique_name(new_name)
        prof.uid = uuid.uuid4().hex
        self.save_profile(prof)
        return prof

    def delete_profile(self, name: str) -> None:
        path = self._profile_path(name)
        if path.exists():
            path.unlink()
            self._invalidate_uid_cache()

    def reset_profile(self, name: str) -> None:
        self.save_profile(MapProfile(name=name))

    def update_existing_profiles_with_mode(self) -> None:
        """Met à jour tous les profils existants pour ajouter le paramètre mode s'il manque"""
        updated_count = 0
        for profile_path in self._iter_profile_files():
            try:
                profile_data = json.loads(profile_path.read_text(encoding="utf-8"))
                needs_update = False

                # Vérifier si le paramètre mode manque dans les points
                if "points" in profile_data and "mode" not in profile_data["points"]:
                    profile_data["points"]["mode"] = "vectoriel"  # valeur par défaut
                    needs_update = True
                    print(f"Mise à jour du profil {profile_path.name}: ajout du paramètre mode='vectoriel'")

                if needs_update:
                    # Sauvegarder avec atomic_write
                    self._atomic_write_profile(profile_path, profile_data)
                    updated_count += 1

            except Exception as e:
                print(f"Erreur lors de la mise à jour du profil {profile_path}: {e}")

        if updated_count > 0:
            print(f"{updated_count} profil(s) mis à jour avec le paramètre mode")
        else:
            print("Tous les profils sont déjà à jour")

    def _atomic_write_profile(self, profile_path: Path, data: dict) -> None:
        """Écriture atomique d'un profil"""
        import tempfile
        import os

        # Créer un fichier temporaire
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, dir=profile_path.parent, encoding='utf-8') as tmp_file:
            json.dump(data, tmp_file, ensure_ascii=False, indent=2)
            tmp_path = tmp_file.name

        # Sauvegarder l'ancien fichier
        bak_path = profile_path.with_suffix(profile_path.suffix + '.bak')
        if profile_path.exists():
            try:
                import shutil
                shutil.copy2(profile_path, bak_path)
            except Exception:
                pass

        # Remplacer atomiquement
        os.replace(tmp_path, profile_path)

    # ---------- Import/Export utilitaires ----------
    def _iter_profile_files(self):
        for p in PROFILES_DIR.glob("*.json"):
            yield p

    def _name_exists(self, name: str) -> bool:
        return self._profile_path(name).exists()

    def _uid_exists(self, uid: str) -> bool:
        for p in self._iter_profile_files():
            try:
                data = read_json(p)
                if data.get("uid") == uid:
                    return True
            except Exception:
                continue
        return False

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
            'map': {
                'tile_provider': prof.map.tile_provider,
                'default_center': list(prof.map.default_center),
                'default_zoom': prof.map.default_zoom,
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
            'animation': {
                'enabled': prof.animation.enabled,
                'speed': prof.animation.speed,
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
            },
            'flash': {
                'mode': prof.flash.mode,
                'duration': prof.flash.duration,
                'size': prof.flash.size,
                'color': prof.flash.color,
                'color_type': prof.flash.color_type,
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
            }
        }

    def export_profile_payload(self, name: str, app_version: str) -> dict:
        prof = self.load_profile(name)
        profile_dict = self._profile_to_dict(prof)
        
        payload = {
            "$schema": "gcmap.profile.v1",
            "kind": "profile",
            "app": APP_NAME,
            "app_version": app_version,
            "profile": profile_dict,
        }
        return payload

    def import_profile_payload(self, payload: dict) -> MapProfile:
        """Importe un profil depuis un payload JSON validé. Retourne le profil sauvegardé."""
        if not isinstance(payload, dict):
            raise ValueError("Payload invalide")
        if payload.get("$schema") != "gcmap.profile.v1" or payload.get("kind") != "profile":
            raise ValueError("Fichier de profil invalide (détrompeur manquant)")

        prof_dict = payload.get("profile")
        if not isinstance(prof_dict, dict):
            raise ValueError("Section 'profile' manquante")

        prof = coerce_profile(prof_dict)

        # Gérer conflits de nom
        prof.name = self._generate_unique_name(prof.name or "Imported")

        # Gérer collisions d'UUID
        if not prof.uid or self._uid_exists(prof.uid):
            prof.uid = uuid.uuid4().hex

        self.save_profile(prof)
        return prof

