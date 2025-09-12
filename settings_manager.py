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


@dataclass
class AnimationOptions:
    enabled: bool = True
    speed: float = 1.0


@dataclass
class FlashOptions:
    mode: str = "circle"  # "none", "circle", "star", "square", "triangle", "diamond"
    duration: int = 1000  # en ms
    size: int = 50  # en px
    color: str = "#FF00FF"


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

        # Migration: ancien format (nom) vers nouveau format (UUID)
        old_profile_name = d.get("default_profile")
        if old_profile_name and not d.get("default_profile_uid"):
            # Si on a un ancien nom de profil mais pas d'UUID, essayer de trouver l'UUID correspondant
            try:
                # Charger tous les profils pour trouver celui avec ce nom
                profiles_dir = Path(CONFIG_DIR) / "profiles"
                if profiles_dir.exists():
                    for profile_file in profiles_dir.glob("*.json"):
                        try:
                            profile_data = json.loads(profile_file.read_text(encoding="utf-8"))
                            if profile_data.get("name") == old_profile_name:
                                s.default_profile_uid = profile_data.get("uid")
                                print(f"Migration: profil '{old_profile_name}' -> UUID '{s.default_profile_uid}'")
                                break
                        except Exception as e:
                            print(f"Erreur lors de la migration du profil {old_profile_name}: {e}")
            except Exception as e:
                print(f"Erreur lors de la migration des paramètres: {e}")

        # Nouveau format: UUID direct
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
        vm = m.get("vector_options", {}) if isinstance(m.get("vector_options", {}), dict) else {}
        vector_options = VectorMapOptions(
            stroke_color=vm.get("stroke_color", p.map.vector_options.stroke_color),
            fill_color=vm.get("fill_color", p.map.vector_options.fill_color),
            background_color=vm.get("background_color", p.map.vector_options.background_color),
            stroke_width=float(vm.get("stroke_width", p.map.vector_options.stroke_width)),
        )

        # Options Toner
        tm = m.get("toner_options", {}) if isinstance(m.get("toner_options", {}), dict) else {}
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
        )

        # Options flash
        f = d.get("flash", {}) if isinstance(d.get("flash", {}), dict) else {}
        p.flash = FlashOptions(
            mode=f.get("mode", p.flash.mode),
            duration=int(f.get("duration", p.flash.duration)),
            size=int(f.get("size", p.flash.size)),
            color=f.get("color", p.flash.color),
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

        # Créer des profils d'exemple si c'est le premier lancement
        self._create_example_profiles()

    def _create_example_profiles(self) -> None:
        """Crée des profils d'exemple au premier lancement"""
        example_profiles = {
            "Default": MapProfile(
                name="Default",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(48.8566, 2.3522),  # Paris
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#000000",
                        fill_color="#ff5722",
                        background_color="#ffffff",
                        stroke_width=2.5
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.0),
                points=PointStyle(
                    size=8,
                    color="#ff5722",
                    shape="circle",
                    halo=False,
                    border_color="#000000",
                    border_size=0,
                    fill_color_type="fix",
                    border_color_type="fix"
                ),
                flash=FlashOptions(
                    mode="circle",
                    duration=1000,
                    size=50,
                    color="#FF00FF"
                )
            ),

            "Clair": MapProfile(
                name="Clair",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(46.603354, 1.888334),  # Centre de la France
                    default_zoom=6,
                    vector_options=VectorMapOptions(
                        stroke_color="#2196f3",
                        fill_color="#4caf50",
                        background_color="#f5f5f5",
                        stroke_width=2.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=1.2),
                points=PointStyle(
                    size=10,
                    color="#2196f3",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=2,
                    fill_color_type="fix",
                    border_color_type="fix"
                ),
                flash=FlashOptions(
                    mode="star",
                    duration=800,
                    size=40,
                    color="#00ff00"
                )
            ),

            "Sombre": MapProfile(
                name="Sombre",
                map=MapOptions(
                    tile_provider="stamenToner",
                    default_center=(48.8566, 2.3522),
                    default_zoom=7,
                    vector_options=VectorMapOptions(
                        stroke_color="#ffffff",
                        fill_color="#666666",
                        background_color="#000000",
                        stroke_width=1.5
                    ),
                    toner_options=TonerMapOptions(variant="dark")
                ),
                animation=AnimationOptions(enabled=False, speed=1.0),
                points=PointStyle(
                    size=6,
                    color="#ffffff",
                    shape="triangle",
                    halo=True,
                    border_color="#cccccc",
                    border_size=1,
                    fill_color_type="fix",
                    border_color_type="fix"
                ),
                flash=FlashOptions(
                    mode="diamond",
                    duration=1500,
                    size=60,
                    color="#ffffff"
                )
            ),

            "Présentation": MapProfile(
                name="Présentation",
                map=MapOptions(
                    tile_provider="OSM",
                    default_center=(46.0, 2.0),  # Vue large sur la France
                    default_zoom=5,
                    vector_options=VectorMapOptions(
                        stroke_color="#000000",
                        fill_color="#4caf50",
                        background_color="#ffffff",
                        stroke_width=3.0
                    ),
                    toner_options=TonerMapOptions(variant="light")
                ),
                animation=AnimationOptions(enabled=True, speed=2.0),
                points=PointStyle(
                    size=12,
                    color="#4caf50",
                    shape="circle",
                    halo=True,
                    border_color="#ffffff",
                    border_size=3,
                    fill_color_type="fix",
                    border_color_type="fix"
                ),
                flash=FlashOptions(
                    mode="square",
                    duration=600,
                    size=80,
                    color="#ff9800"
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
        return coerce_settings(data)

    def save_app_settings(self, settings: AppSettings) -> None:
        write_json(SETTINGS_PATH, asdict(settings))

    def reset_app_settings(self) -> None:
        self.save_app_settings(AppSettings())

    # Profiles
    def _profile_path(self, name: str) -> Path:
        safe = "".join(c for c in name if c.isalnum() or c in ("-", "_")) or "Default"
        return PROFILES_DIR / f"{safe}.json"

    def list_profiles(self) -> List[str]:
        return sorted(p.stem for p in PROFILES_DIR.glob("*.json"))

    def load_profile(self, name: str) -> MapProfile:
        path = self._profile_path(name)
        return coerce_profile(read_json(path))

    def load_profile_by_uid(self, uid: str) -> MapProfile:
        """Charge un profil par son UUID"""
        profiles_dir = CONFIG_DIR / "profiles"
        if not profiles_dir.exists():
            raise FileNotFoundError(f"Répertoire des profils introuvable: {profiles_dir}")

        for profile_file in profiles_dir.glob("*.json"):
            try:
                profile_data = json.loads(profile_file.read_text(encoding="utf-8"))
                if profile_data.get("uid") == uid:
                    return coerce_profile(profile_data)
            except Exception as e:
                print(f"Erreur lors de la lecture du profil {profile_file}: {e}")
                continue

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

    def create_profile(self, name: str, base: Optional[str] = None) -> MapProfile:
        if base and self._profile_path(base).exists():
            prof = self.load_profile(base)
            prof.name = name
            prof.uid = uuid.uuid4().hex
        else:
            prof = MapProfile(name=name)
        self.save_profile(prof)
        return prof

    def duplicate_profile(self, name: str, new_name: str) -> MapProfile:
        prof = self.load_profile(name)
        prof.name = new_name
        prof.uid = uuid.uuid4().hex
        self.save_profile(prof)
        return prof

    def delete_profile(self, name: str) -> None:
        path = self._profile_path(name)
        if path.exists():
            path.unlink()

    def reset_profile(self, name: str) -> None:
        self.save_profile(MapProfile(name=name))

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

    def export_profile_payload(self, name: str, app_version: str) -> dict:
        prof = self.load_profile(name)
        payload = {
            "$schema": "gcmap.profile.v1",
            "kind": "profile",
            "app": APP_NAME,
            "app_version": app_version,
            "profile": {
                "version": prof.version,
                "name": prof.name,
                "uid": prof.uid,
                "map": {
                    "tile_provider": prof.map.tile_provider,
                    "default_center": list(prof.map.default_center),
                    "default_zoom": prof.map.default_zoom,
                    "vector_options": {
                        "stroke_color": prof.map.vector_options.stroke_color,
                        "fill_color": prof.map.vector_options.fill_color,
                        "background_color": prof.map.vector_options.background_color,
                        "stroke_width": prof.map.vector_options.stroke_width,
                    },
                    "toner_options": {
                        "variant": prof.map.toner_options.variant,
                    },
                },
                "animation": {
                    "enabled": prof.animation.enabled,
                    "speed": prof.animation.speed,
                },
                "points": {
                    "size": prof.points.size,
                    "color": prof.points.color,
                    "shape": prof.points.shape,
                    "halo": prof.points.halo,
                    "border_color": prof.points.border_color,
                    "border_size": prof.points.border_size,
                    "fill_color_type": prof.points.fill_color_type,
                    "border_color_type": prof.points.border_color_type,
                },
                "flash": {
                    "mode": prof.flash.mode,
                    "duration": prof.flash.duration,
                    "size": prof.flash.size,
                    "color": prof.flash.color,
                },
                "infos": {
                    "title": {
                        "display": prof.infos.title.display,
                        "text": prof.infos.title.text,
                    },
                    "number_of_caches": prof.infos.number_of_caches,
                    "current_date": prof.infos.current_date,
                    "title_css": prof.infos.title_css,
                    "infos_css": prof.infos.infos_css,
                },
            },
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


