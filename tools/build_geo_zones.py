#!/usr/bin/env python3
"""Prépare les données de zones à partir des recettes de geo/recipes/.

    python tools/build_geo_zones.py            reconstruit tout
    python tools/build_geo_zones.py --offline  sans téléchargement (cache seul)

Produit, à partir des recettes :
  static/geo/index.json                catalogue (niveaux par pays, sources)
  static/geo/countries.json            niveau 0, affichage
  static/geo/regions/<CC>.json         niveau 1, affichage
  static/geo/subregions/<CC>.json      niveau 2, affichage
  geo/match/countries.json.gz          rattachement (serveur, zones.py)
  geo/match/<CC>.json.gz               rattachement, niveaux 1 et 2
  la section « Contours des zones » de installer/licenses/THIRD_PARTY_NOTICES.txt

Outil de développement : il demande Node et mapshaper (`npm install`).
L'application ne l'exécute jamais. Procédure : docs/zones-ajouter-un-pays.md.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import zones  # noqa: E402  (normalize_name, encode_ring, Zone, ZoneSet)

RECIPES = ROOT / "geo" / "recipes"
CACHE = ROOT / "geo" / ".cache"
MATCH = ROOT / "geo" / "match"
STATIC = ROOT / "static" / "geo"
NOTICES = ROOT / "installer" / "licenses" / "THIRD_PARTY_NOTICES.txt"
MAPSHAPER = ROOT / "node_modules" / "mapshaper" / "bin" / "mapshaper"

# Licences acceptées (docs/zones-ajouter-un-pays.md › Sources et licences).
# ODbL (OpenStreetMap) et les licences non commerciales (GADM) sont refusées.
LICENCES = {
    "public-domain": "Domaine public",
    "cc0": "CC0 1.0",
    "cc-by-4.0": "CC BY 4.0",
    "etalab-2.0": "Licence Ouverte 2.0 (Etalab)",
    "dl-de-by-2.0": "Datenlizenz Deutschland – Namensnennung 2.0",
    "ogl-uk-3.0": "Open Government Licence v3.0",
}
DISPLAY_PRECISION = 0.001      # ~100 m : assez pour des cartes de synthèse
MATCH_PRECISION = 0.0001       # ~11 m, aligné sur zones.COORD_SCALE
NOTICE_START = "[Section générée par tools/build_geo_zones.py — ne pas modifier à la main.]"
NOTICE_END = "[Fin de la section générée.]"
NOTICE_TITLE = "Contours des zones (dossiers static/geo et geo/match)"


class BuildError(Exception):
    pass


# ---------------------------------------------------------------------------
# Recettes et sources

def load_recipes():
    world = None
    countries = []
    for path in sorted(RECIPES.glob("*.json")):
        recipe = json.loads(path.read_text(encoding="utf-8"))
        recipe["_file"] = path.name
        if recipe.get("kind") == "world":
            world = recipe
        elif recipe.get("kind") == "country":
            if path.stem != recipe.get("country"):
                raise BuildError(f"{path.name} : le nom du fichier doit être le code du pays ({recipe.get('country')}).")
            countries.append(recipe)
        else:
            raise BuildError(f"{path.name} : « kind » doit valoir « world » ou « country ».")
    if world is None:
        raise BuildError("geo/recipes/world.json manquant.")
    sources = {}
    for recipe in [world, *countries]:
        for sid, src in recipe.get("sources", {}).items():
            if sid in sources:
                raise BuildError(f"source « {sid} » déclarée deux fois.")
            if src.get("licence") not in LICENCES:
                raise BuildError(f"source « {sid} » : licence « {src.get('licence')} » non acceptée "
                                 f"(acceptées : {', '.join(LICENCES)}).")
            for key in ("url", "sha256", "title", "attribution", "homepage"):
                if not src.get(key):
                    raise BuildError(f"source « {sid} » : champ « {key} » manquant.")
            sources[sid] = src
    return world, countries, sources


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(sid: str, src: dict, offline: bool) -> Path:
    """Fichier source vérifié (sha256), extrait si c'est une archive."""
    CACHE.mkdir(parents=True, exist_ok=True)
    # « file » : nom local quand l'adresse n'en donne pas (requête d'API).
    name = src.get("file") or Path(urlparse(src["url"]).path).name
    target = CACHE / f"{sid}-{src['sha256'][:12]}-{name}"
    if not target.exists():
        if offline:
            raise BuildError(f"{sid} : absent du cache ({target.name}) et --offline demandé.")
        import requests
        print(f"  téléchargement {sid} …")
        part = target.with_suffix(target.suffix + ".part")
        with requests.get(src["url"], stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with part.open("wb") as fh:
                for chunk in resp.iter_content(1 << 20):
                    fh.write(chunk)
        part.replace(target)
    digest = _sha256(target)
    if digest != src["sha256"]:
        target.unlink()
        raise BuildError(
            f"{sid} : le fichier téléchargé a changé (sha256 {digest}). Vérifier la source, "
            f"puis mettre à jour « sha256 » dans la recette.")
    member = src.get("member")
    if not member:
        return target
    folder = target.with_name(target.name + ".d")
    if not folder.exists():
        with zipfile.ZipFile(target) as archive:
            archive.extractall(folder)
    path = folder / member
    if not path.exists():
        raise BuildError(f"{sid} : « {member} » introuvable dans l'archive.")
    return path


# ---------------------------------------------------------------------------
# mapshaper

def mapshaper(args):
    if not MAPSHAPER.exists():
        raise BuildError("mapshaper introuvable : lancer `npm install` à la racine du dépôt.")
    proc = subprocess.run(["node", str(MAPSHAPER), "-quiet", *args],
                          capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise BuildError("mapshaper : " + (proc.stderr or proc.stdout).strip())


def shape(src: Path, *, simplify_m: int, precision: float, measure: bool,
          filter_expr: str | None = None, pre=()) -> list[dict]:
    """Une passe mapshaper → features GeoJSON (WGS84). `measure` ajoute le
    point intérieur et la surface, calculés AVANT simplification."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.json"
        args = ["-i", str(src), "-proj", "wgs84"]
        if filter_expr:
            args += ["-filter", filter_expr]
        args += list(pre)
        if measure:
            args += ["-each", "mgz_ix=this.innerX, mgz_iy=this.innerY, mgz_area=this.area"]
        args += ["-simplify", f"interval={simplify_m}", "keep-shapes",
                 "-o", str(out), "format=geojson", f"precision={precision}", "force"]
        mapshaper(args)
        return json.loads(out.read_text(encoding="utf-8"))["features"]


# ---------------------------------------------------------------------------
# Champs, identifiants, noms

_FIELD = re.compile(r"\{([^{}]+)\}")
_EMPTY = {"", "-99", "none", "null"}


def _value(props, field):
    value = props.get(field)
    if value is None:
        return None
    text = str(value).strip()
    return None if text.casefold() in _EMPTY else text


def fill(template: str, props: dict) -> str | None:
    """« US-{GEOID} » → « US-48201 » ; None si un champ manque."""
    missing = False

    def sub(match):
        nonlocal missing
        value = _value(props, match.group(1))
        if value is None:
            missing = True
            return ""
        return value

    out = _FIELD.sub(sub, template)
    return None if missing else out


def template_fields(*templates) -> set[str]:
    fields = set()
    for template in templates:
        if not template:
            continue
        for t in ([template] if isinstance(template, str) else template):
            fields.update(_FIELD.findall(t))
    return fields


def alias_values(entries, props):
    """Valeurs des alias d'une recette : nom de champ, ou modèle « {A} {B} ».
    Les listes « a|b » de Natural Earth sont dépliées."""
    out = []
    for prio, entry in enumerate(entries, start=1):
        raw = fill(entry, props) if "{" in entry else _value(props, entry)
        if not raw:
            continue
        for part in raw.split("|"):
            key = zones.normalize_name(part)
            if key:
                out.append((prio, key))
    return out


def assign_ids(records, templates):
    """Premier modèle d'id non vide ; un id en double fait passer les zones
    concernées au modèle suivant."""
    templates = [templates] if isinstance(templates, str) else list(templates)
    level = {id(r): 0 for r in records}
    while True:
        for r in records:
            r["id"] = None
            for t in templates[level[id(r)]:]:
                r["id"] = fill(t, r["props"])
                if r["id"]:
                    break
                level[id(r)] += 1
            if not r["id"]:
                raise BuildError(f"aucun identifiant pour {r['props']}")
        seen = {}
        for r in records:
            seen.setdefault(r["id"], []).append(r)
        dups = [group for group in seen.values() if len(group) > 1]
        if not dups:
            return
        bumped = False
        for group in dups:
            for r in group:
                if level[id(r)] + 1 < len(templates):
                    level[id(r)] += 1
                    bumped = True
        if not bumped:
            raise BuildError("identifiants en double : " + ", ".join(sorted({g[0]["id"] for g in dups})))


def names_index(records):
    """{nom normalisé: [ids]} — la meilleure priorité l'emporte ; à égalité,
    tous les ids sont gardés (ambiguïté : levée par le parent, ou
    rattachement par la position)."""
    best = {}
    for r in records:
        for prio, key in r["names"]:
            current = best.get(key)
            if current is None or prio < current[0]:
                best[key] = [prio, {r["id"]}]
            elif prio == current[0]:
                current[1].add(r["id"])
    return {key: sorted(ids) for key, (_, ids) in sorted(best.items())}


def _rings(geometry):
    if not geometry:
        return []
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    return [ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            for poly in polys for ring in poly]


def _area_km2(m2):
    km2 = (m2 or 0) / 1e6
    if km2 < 10:          # Vatican, Monaco… : ne pas tomber à 0
        return round(km2, 3)
    return round(km2, 1) if km2 < 100 else round(km2)


# ---------------------------------------------------------------------------
# Niveaux

def build_level(src_path, spec, *, pre=(), extra_fields=()):
    """Deux passes (rattachement fin, affichage léger), jointes par position."""
    simplify = spec["simplify"]
    match = shape(src_path, simplify_m=simplify["match"], precision=MATCH_PRECISION,
                  measure=True, filter_expr=spec.get("filter"), pre=pre)
    display = shape(src_path, simplify_m=simplify["display"], precision=DISPLAY_PRECISION,
                    measure=False, filter_expr=spec.get("filter"), pre=pre)
    if len(match) != len(display):
        raise BuildError("passes mapshaper incohérentes (nombre de features).")
    records = []
    for m, d in zip(match, display):
        if not m.get("geometry"):
            continue
        props = m["properties"]
        records.append({
            "props": props,
            "match": m["geometry"],
            "display": d["geometry"],
            "area_km2": _area_km2(props.get("mgz_area")),
            "inner": [round(props.get("mgz_ix") or 0, 4), round(props.get("mgz_iy") or 0, 4)],
        })
    return records


def source_values(src: Path, field: str, filter_expr: str | None = None) -> set[str]:
    """Valeurs d'un champ de la source (après le filtre du niveau)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.json"
        args = ["-i", str(src)]
        if filter_expr:
            args += ["-filter", filter_expr]
        mapshaper(args + ["-o", str(out), "format=json", "force"])
        return {str(row.get(field)) for row in json.loads(out.read_text(encoding="utf-8"))}


def unit_groups(spec, levels, where):
    """Table unité de la source → groupe, d'après « groups » du niveau.

    Avec « groups_of », les membres sont des groupes de cet autre niveau de la
    recette (régions composées de comtés), sinon des valeurs de « group_by »."""
    nested = None
    if spec.get("groups_of"):
        nested = (levels.get(spec["groups_of"]) or {}).get("groups")
        if not nested:
            raise BuildError(f"{where} : « groups_of » vers un niveau sans « groups ».")
    mapping = {}
    for group, members in spec["groups"].items():
        for member in members:
            if nested is not None and member not in nested:
                raise BuildError(f"{where} : « {member} » (groupe {group}) n'est pas un groupe de {spec['groups_of']}.")
            for unit in (nested[member] if nested is not None else [member]):
                if unit in mapping:
                    raise BuildError(f"{where} : unité {unit} dans deux groupes ({mapping[unit]}, {group}).")
                mapping[unit] = group
    return mapping


def merged_inputs(spec, source_path) -> Path:
    """Plusieurs sources pour un même niveau (« inputs ») : chacune réduite à
    son champ d'unité (`mgz_u`), puis réunies en un GeoJSON du cache. Ex. :
    comtés de la République d'Irlande (Tailte Éireann) et districts
    d'Irlande du Nord (ONS) pour les provinces de Geocaching.com."""
    paths = [source_path(i["source"]) for i in spec["inputs"]]
    key = hashlib.sha1(json.dumps([spec["inputs"], [p.name for p in paths]], sort_keys=True).encode("utf-8"))
    target = CACHE / f"merge-v2-{key.hexdigest()[:12]}.geojson"
    if target.exists():
        return target
    features = []
    with tempfile.TemporaryDirectory() as tmp:
        for n, (inp, path) in enumerate(zip(spec["inputs"], paths)):
            out = Path(tmp) / f"in{n}.json"
            args = ["-i", str(path), "-proj", "wgs84"]
            if inp.get("filter"):
                args += ["-filter", inp["filter"]]
            args += ["-each", f"mgz_u = String(this.properties[{json.dumps(inp['unit'])}])",
                     "-filter-fields", "mgz_u", "-o", str(out), "format=geojson", "force"]
            mapshaper(args)
            features += json.loads(out.read_text(encoding="utf-8"))["features"]
        # Deux sources ne se rejoignent jamais au mètre près : -clean comble
        # les interstices et partage les chevauchements le long de leur limite.
        combined = Path(tmp) / "combined.json"
        combined.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
        mapshaper(["-i", str(combined), "snap", "-clean", f"gap-fill-area={spec.get('gap_fill_km2', 1)}km2",
                   "-o", str(target), "format=geojson", "force"])
    return target


def level_records(spec, levels, source_path, where):
    """Enregistrements d'un niveau de recette : source unique ou « inputs »,
    unités telles quelles ou regroupées (« groups »)."""
    if spec.get("inputs"):
        if not spec.get("groups"):
            raise BuildError(f"{where} : « inputs » demande « groups ».")
        spec = {**spec, "group_by": "mgz_u", "filter": None}
        return build_grouped_level(merged_inputs(spec, source_path), spec, levels, where)
    path = source_path(spec["source"])
    return build_grouped_level(path, spec, levels, where) if spec.get("groups") else build_level(path, spec)


def level_sources(spec):
    return [i["source"] for i in spec["inputs"]] if spec.get("inputs") else [spec["source"]]


def build_grouped_level(src_path, spec, levels, where):
    """Niveau composé d'unités de la source fusionnées par groupe (comtés
    cérémoniaux faits d'autorités unitaires, régions faites de comtés).
    Champs disponibles pour les modèles : {group} et {group_key} (normalisé)."""
    field = spec["group_by"]
    mapping = unit_groups(spec, levels, where)
    unknown = sorted(set(mapping) - source_values(src_path, field, spec.get("filter")))
    if unknown:
        raise BuildError(f"{where} : unités absentes de la source : {', '.join(unknown)}.")
    pre = ["-each", (f"mgz_g = ({json.dumps(mapping, ensure_ascii=False)})[this.properties[{json.dumps(field)}]] "
                     f"|| ('?' + this.properties[{json.dumps(field)}])"),
           "-dissolve", "mgz_g"]
    records = build_level(src_path, spec, pre=pre)
    orphans = sorted(r["props"]["mgz_g"][1:] for r in records if r["props"]["mgz_g"].startswith("?"))
    if orphans:
        raise BuildError(f"{where} : unités de la source sans groupe : {', '.join(orphans)}.")
    for r in records:
        r["props"]["group"] = r["props"]["mgz_g"]
        r["props"]["group_key"] = zones.normalize_name(r["props"]["mgz_g"])
    return records


def finish_records(records, spec, *, manual_aliases=None):
    """Ids, noms affichés et alias d'un niveau."""
    assign_ids(records, spec["id"])
    id_map = spec.get("id_map") or {}
    for r in records:
        r["id"] = id_map.get(r["id"], r["id"])
        props = r["props"]
        r["name"] = fill(spec["name"], props) or r["id"]
        r["name_fr"] = fill(spec.get("name_fr", spec["name"]), props) or r["name"]
        r["name_en"] = fill(spec.get("name_en", spec["name"]), props) or r["name"]
        r["names"] = [(1, zones.normalize_name(r["name"]))] + alias_values(spec.get("aliases", []), props)
    if spec.get("name_unique"):
        counts = {}
        for r in records:
            counts[zones.normalize_name(r["name"])] = counts.get(zones.normalize_name(r["name"]), 0) + 1
        for r in records:
            if counts[zones.normalize_name(r["name"])] > 1:
                unique = fill(spec["name_unique"], r["props"])
                if unique:
                    r["name"] = r["name_fr"] = r["name_en"] = unique
                    r["names"].append((1, zones.normalize_name(unique)))
    for zone_id, names in (manual_aliases or {}).items():
        target = next((r for r in records if r["id"] == zone_id), None)
        if target is not None:
            target["names"] += [(0, zones.normalize_name(n)) for n in names]
    ids = [r["id"] for r in records]
    if len(ids) != len(set(ids)):
        raise BuildError("identifiants en double après id_map : " + ", ".join(sorted({i for i in ids if ids.count(i) > 1})))
    return records


def zone_set(records):
    return zones.ZoneSet(
        zones.Zone(r["id"], r.get("parent"), [zones.decode_ring(zones.encode_ring(ring)) for ring in _rings(r["match"])])
        for r in records)


def compute_parents(records, parents, spec, country):
    """Parent : modèle de la recette, sinon la région qui contient le point
    intérieur de la zone."""
    known = {r["id"] for r in parents}
    index = zone_set(parents) if not spec.get("parent") else None
    for r in records:
        if spec.get("parent"):
            r["parent"] = fill(spec["parent"], r["props"])
        else:
            x, y = r["inner"]
            zone, _ = index.locate(x, y)
            r["parent"] = zone.id if zone else None
        if r["parent"] not in known:
            raise BuildError(f"{country} : parent introuvable pour {r['id']} ({r['name']}) → {r['parent']!r}.")


# ---------------------------------------------------------------------------
# Écriture

def _dumps(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _rev(blob: bytes) -> str:
    return hashlib.sha1(blob).hexdigest()[:10]


def write_bytes(path: Path, blob: bytes, written: set):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != blob:
        path.write_bytes(blob)
    written.add(path.resolve())


def write_gzip(path: Path, blob: bytes, written: set):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as fh:
        fh.write(blob)
    write_bytes(path, buf.getvalue(), written)


def display_collection(records, level):
    features = []
    for r in sorted(records, key=lambda r: r["id"]):
        props = {"id": r["id"], "name": r["name"], "name_fr": r["name_fr"], "name_en": r["name_en"],
                 "area_km2": r["area_km2"], "ix": r["inner"][0], "iy": r["inner"][1]}
        if level != "country":
            props["parent"] = r["parent"]
        features.append({"type": "Feature", "properties": props, "geometry": r["display"]})
    return {"type": "FeatureCollection", "features": features}


def match_records(records):
    return [{"id": r["id"], **({"parent": r["parent"]} if r.get("parent") else {}),
             "rings": [zones.encode_ring(ring) for ring in _rings(r["match"])]}
            for r in sorted(records, key=lambda r: r["id"])]


def update_notices(sources_used):
    lines = [NOTICE_TITLE, "-" * len(NOTICE_TITLE), NOTICE_START,
             "Données géographiques simplifiées par MyGCFlow (mapshaper) à partir de :"]
    for sid in sorted(sources_used):
        src = sources_used[sid]
        lines.append(f"  - {src['title']}")
        lines.append(f"      {LICENCES[src['licence']]} — {src['attribution']}")
        lines.append(f"      {src['homepage']}")
    lines.append(NOTICE_END)
    block = "\n".join(lines) + "\n"
    raw = NOTICES.read_bytes()
    eol = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8").replace("\r\n", "\n")
    start = text.find(NOTICE_TITLE)
    if start >= 0:
        end = text.index(NOTICE_END, start) + len(NOTICE_END) + 1
        text = text[:start] + block + text[end:]
    else:
        anchor = text.find("Fonds de carte\n")
        anchor = anchor if anchor >= 0 else len(text)
        text = text[:anchor] + block + "\n" + text[anchor:]
    NOTICES.write_bytes(text.replace("\n", eol).encode("utf-8"))


def remove_stale(directory: Path, written: set, patterns):
    for pattern in patterns:
        for path in directory.glob(pattern):
            if path.resolve() not in written:
                print(f"  suppression de {path.relative_to(ROOT)} (plus produit)")
                path.unlink()


# ---------------------------------------------------------------------------
# Construction

def build(offline=False):
    world, recipes, sources = load_recipes()
    used = {}
    paths = {}

    def source_path(sid):
        if sid not in sources:
            raise BuildError(f"source « {sid} » non déclarée.")
        if sid not in paths:
            paths[sid] = fetch(sid, sources[sid], offline)
            used[sid] = sources[sid]
        return paths[sid]

    # Niveau 0 : pays.
    print("Pays …")
    spec = world["countries"]
    countries = build_level(source_path(spec["source"]), spec)
    finish_records(countries, spec)
    key_to_country = {fill(spec["key"], r["props"]): r["id"] for r in countries}
    country_ids = {r["id"] for r in countries}
    for cid, names in world.get("aliases", {}).get("countries", {}).items():
        target = next((r for r in countries if r["id"] == cid), None)
        if target is None:
            raise BuildError(f"world.json : alias pour un pays inconnu ({cid}).")
        target["names"] += [(0, zones.normalize_name(n)) for n in names]
    for recipe in recipes:
        cc = recipe["country"]
        if cc not in country_ids:
            raise BuildError(f"{recipe['_file']} : pays {cc} absent du niveau 0.")
        target = next(r for r in countries if r["id"] == cc)
        target["names"] += [(0, zones.normalize_name(n)) for n in recipe.get("aliases", {}).get("country", [])]

    # Niveau 1 par défaut (Natural Earth), sauf pays qui fournissent le leur.
    print("Régions du monde …")
    spec = world["regions"]
    overridden = {r["country"] for r in recipes if "region" in r.get("levels", {})}
    adm0_of = {v: k for k, v in key_to_country.items()}
    excluded = sorted(adm0_of[c] for c in overridden)
    dissolve = spec.get("dissolve") or {}
    fields = template_fields(spec["id"], spec["name"], spec.get("name_fr"), spec.get("name_en"),
                             spec["country_key"]) | {a for a in spec.get("aliases", []) if "{" not in a} \
        | template_fields(*[a for a in spec.get("aliases", []) if "{" in a]) | {"iso_a2", "adm1_code"}
    pre = ["-filter", f"!{json.dumps(excluded)}.includes(adm0_a3)",
           "-each", (f"mgz_dk = ({json.dumps(dissolve)})[adm0_a3] || null, "
                     "mgz_dv = mgz_dk ? this.properties[mgz_dk] : null, "
                     "mgz_key = mgz_dv ? adm0_a3 + '|' + mgz_dv : adm1_code"),
           "-dissolve", "mgz_key", "copy-fields=" + ",".join(sorted(fields | {"mgz_dv"}))]
    region_records = build_level(source_path(spec["source"]), spec, pre=pre)
    regions_by_country = {}
    for r in region_records:
        cid = key_to_country.get(fill(spec["country_key"], r["props"]))
        if cid is None:
            continue
        r["parent"] = cid
        regions_by_country.setdefault(cid, []).append(r)
    manual = world.get("aliases", {}).get("zones", {})
    for cid, records in regions_by_country.items():
        plain = [r for r in records if not r["props"].get("mgz_dv")]
        merged = [r for r in records if r["props"].get("mgz_dv")]
        if plain:
            finish_records(plain, spec, manual_aliases=manual)
            # L'id d'une zone commence par celui de son pays : le client en
            # déduit les contours à charger. Natural Earth donne parfois le
            # code ISO d'un autre pays (Sébastopol « UA-40 » en Russie, « US-PR »
            # à Porto Rico) ou aucun (« -99-X04~ ») : id tiré de adm1_code.
            for r in plain:
                if not r["id"].startswith(cid + "-"):
                    r["id"] = f"{cid}-{zones.normalize_name(r['props'].get('adm1_code') or r['id'])}"
        for r in merged:
            value = r["props"]["mgz_dv"]
            r["id"] = f"{cid}-{zones.normalize_name(value)}"
            r["name"] = r["name_fr"] = r["name_en"] = value
            r["names"] = [(1, zones.normalize_name(value))]
            r["names"] += [(0, zones.normalize_name(n)) for n in manual.get(r["id"], [])]
        ids = [r["id"] for r in records]
        if len(ids) != len(set(ids)):
            raise BuildError(f"{cid} : identifiants de région en double.")
    region_label = {cid: spec.get("label") for cid in regions_by_country}
    region_sources = {cid: [spec["source"]] for cid in regions_by_country}
    sub_by_country, sub_label, sub_sources = {}, {}, {}
    as_region, insets = {}, {}

    # Recettes de pays.
    for recipe in recipes:
        cc = recipe["country"]
        print(f"{cc} …")
        levels = recipe.get("levels", {})
        manual = recipe.get("aliases", {}).get("zones", {})
        if "region" in levels:
            spec = levels["region"]
            records = level_records(spec, levels, source_path, f"{cc} region")
            finish_records(records, spec, manual_aliases=manual)
            for r in records:
                r["parent"] = cc
            regions_by_country[cc] = records
            region_label[cc] = spec.get("label")
            region_sources[cc] = level_sources(spec)
        elif manual:
            for r in regions_by_country.get(cc, []):
                r["names"] += [(0, zones.normalize_name(n)) for n in manual.get(r["id"], [])]
        if "subregion" in levels:
            spec = levels["subregion"]
            parents = regions_by_country.get(cc)
            if not parents:
                raise BuildError(f"{cc} : pas de niveau 1 pour rattacher les sous-régions.")
            records = level_records(spec, levels, source_path, f"{cc} subregion")
            finish_records(records, spec, manual_aliases=manual)
            compute_parents(records, parents, spec, cc)
            sub_by_country[cc] = records
            sub_label[cc] = spec.get("label")
            sub_sources[cc] = level_sources(spec)
        for rid, names in recipe.get("aliases", {}).get("as_region", {}).items():
            if rid not in {r["id"] for r in regions_by_country.get(cc, [])}:
                raise BuildError(f"{recipe['_file']} : as_region vers une région inconnue ({rid}).")
            for n in names:
                as_region[zones.normalize_name(n)] = [cc, rid]
        known = {r["id"] for r in regions_by_country.get(cc, [])} | {r["id"] for r in sub_by_country.get(cc, [])}
        for inset in recipe.get("insets", []):
            missing = [z for z in inset["zones"] if z not in known]
            if missing:
                raise BuildError(f"{recipe['_file']} : encart « {inset['name']} » vers des zones inconnues {missing}.")
        if recipe.get("insets"):
            insets[cc] = recipe["insets"]

    # Alias vers une zone inconnue : faute de frappe dans une recette.
    region_ids = {r["id"] for records in regions_by_country.values() for r in records}
    unknown = sorted(set(world.get("aliases", {}).get("zones", {})) - region_ids)
    if unknown:
        raise BuildError(f"world.json : alias vers des régions inconnues {unknown}.")
    for recipe in recipes:
        cc = recipe["country"]
        known = {r["id"] for r in regions_by_country.get(cc, [])} | {r["id"] for r in sub_by_country.get(cc, [])}
        unknown = sorted(set(recipe.get("aliases", {}).get("zones", {})) - known)
        if unknown:
            raise BuildError(f"{recipe['_file']} : alias vers des zones inconnues {unknown}.")

    # Écriture.
    print("Écriture …")
    written = set()
    blob = _dumps(display_collection(countries, "country"))
    write_bytes(STATIC / "countries.json", blob, written)
    index = {
        "v": zones.FORMAT_VERSION,
        "countries": {"file": "countries.json", "rev": _rev(blob), "count": len(countries), "bytes": len(blob)},
        "by_country": {},
        # Continent de chaque pays (« europe », « northamerica »…) : cadrage
        # des cartes de Statistiques sur un continent.
        "continents": {r["id"]: zones.normalize_name(world["countries"].get("continent_fix", {}).get(r["id"])
                                                     or fill(world["countries"]["continent"], r["props"]) or "")
                       for r in sorted(countries, key=lambda r: r["id"])
                       if world["countries"].get("continent")},
        "sources": {sid: {"title": s["title"], "licence": s["licence"], "licence_title": LICENCES[s["licence"]],
                          "attribution": s["attribution"], "homepage": s["homepage"]}
                    for sid, s in sorted(used.items())},
    }
    files = []
    ambiguous = 0
    for cc in sorted(regions_by_country):
        entry = {}
        for level, by_country, labels, srcs in (("region", regions_by_country, region_label, region_sources),
                                                ("subregion", sub_by_country, sub_label, sub_sources)):
            records = by_country.get(cc)
            if not records:
                continue
            blob = _dumps(display_collection(records, level))
            rel = f"{level}s/{cc}.json"
            write_bytes(STATIC / rel, blob, written)
            entry[level] = {"file": rel, "rev": _rev(blob), "count": len(records), "bytes": len(blob),
                            "label": labels.get(cc) or {}, "sources": srcs[cc]}
        if cc in insets:
            entry["insets"] = insets[cc]
        index["by_country"][cc] = entry
        levels = {"region": match_records(regions_by_country[cc])}
        names = {"region": names_index(regions_by_country[cc])}
        if cc in sub_by_country:
            levels["subregion"] = match_records(sub_by_country[cc])
            names["subregion"] = names_index(sub_by_country[cc])
        ambiguous += sum(1 for ids in names["region"].values() if len(ids) > 1)
        write_gzip(MATCH / f"{cc}.json.gz",
                   _dumps({"v": zones.FORMAT_VERSION, "country": cc, "levels": levels, "names": names}), written)
        files.append(cc)
    world_names = names_index(countries)
    ambiguous += sum(1 for ids in world_names.values() if len(ids) > 1)
    write_gzip(MATCH / "countries.json.gz",
               _dumps({"v": zones.FORMAT_VERSION, "zones": match_records(countries), "names": world_names,
                       "as_region": dict(sorted(as_region.items())), "files": files}), written)
    write_bytes(STATIC / "index.json", json.dumps(index, ensure_ascii=False, indent=1).encode("utf-8"), written)
    remove_stale(STATIC, written, ["*.json", "regions/*.json", "subregions/*.json"])
    remove_stale(MATCH, written, ["*.json.gz"])
    update_notices(used)

    print(f"\n{len(countries)} pays, régions pour {len(regions_by_country)} pays, "
          f"sous-régions pour {', '.join(sorted(sub_by_country)) or 'aucun'}.")
    for cc in sorted(sub_by_country):
        e = index["by_country"][cc]
        size = (MATCH / f"{cc}.json.gz").stat().st_size
        print(f"  {cc} : {e.get('region', {}).get('count', 0)} régions, {e['subregion']['count']} sous-régions "
              f"(affichage {e['subregion']['bytes'] // 1024} Ko, rattachement {size // 1024} Ko)")
    total_static = sum(p.stat().st_size for p in STATIC.rglob("*.json"))
    total_match = sum(p.stat().st_size for p in MATCH.glob("*.json.gz"))
    print(f"  total : affichage {total_static // 1024} Ko, rattachement {total_match // 1024} Ko ; "
          f"{ambiguous} noms ambigus (rattachés par position).")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--offline", action="store_true", help="n'utiliser que le cache local")
    args = parser.parse_args(argv)
    try:
        build(offline=args.offline)
    except BuildError as exc:
        print(f"Erreur : {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
