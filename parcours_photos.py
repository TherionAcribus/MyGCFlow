"""Photos des parcours (MyGCFlow_Plan_Parcours.md, § 8 ; lot 4).

À l'envoi, dans cet ordre :

1. **l'EXIF est lu** — heure murale de l'appareil (`DateTimeOriginal`),
   décalage horaire s'il est noté (`OffsetTimeOriginal`), position GPS,
   marque et modèle. La normalisation qui suit le retire : il faut le lire
   avant ;
2. l'image est **normalisée** comme celles de l'onglet Images
   (image_library.normalize_image : redressée, réduite à 2048 px, HEIC
   décodé), puis une **vignette** de 320 px est tirée ;
3. elle est rangée dans `parcours_photos/<parcours>/<empreinte>.<ext>` : la
   même photo envoyée deux fois dans un parcours n'y est gardée qu'une fois.

Le RATTACHEMENT à une étape (position, heure) et l'usage de l'heure comme
ancre sont calculés côté client (static/js/parcours_photos.mjs), comme la
reconstruction : on ne stocke que le rattachement manuel (`stop_key`) et le
décalage d'horloge de chaque appareil (`parcours_camera`).
"""

from __future__ import annotations

import hashlib
import io
import re
import shutil
from datetime import datetime
from pathlib import Path

from PIL import Image

import image_library
import paths
import parcours_store
from parcours_store import ParcoursError
from models import ParcoursCamera, ParcoursPhoto

MAX_PHOTOS = 300
THUMB_SIDE = 320
THUMB_QUALITY = 80
CAMERA_MAX_LENGTH = 120
# Décalage d'horloge borné à ±2 jours : au-delà, ce n'est plus une horloge
# mal réglée mais une photo d'une autre sortie.
OFFSET_RANGE_MINUTES = 2 * 24 * 60
# Affichage par photo (lot 8) : légende, proportions du cadrage, point focal
# (% de l'image) et zoom (%). Mêmes bornes que parcours_photo_layout.mjs.
CAPTION_MAX_LENGTH = 200
ASPECTS = ('original', '1:1', '4:3', '3:4', '16:9')
FOCUS_RANGE = (0, 100)
ZOOM_RANGE = (100, 300)

_EXIF_IFD = 0x8769
_GPS_IFD = 0x8825
_TAG_MAKE = 271
_TAG_MODEL = 272
_TAG_DATETIME = 306
_TAG_DATETIME_ORIGINAL = 36867
_TAG_OFFSET_TIME_ORIGINAL = 36881
_EXIF_DATETIME = re.compile(r'(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})')
_EXIF_OFFSET = re.compile(r'([+-])(\d{2}):(\d{2})')
_FILE_RE = re.compile(r'[0-9a-f]{16}(?:\.thumb)?\.(?:jpg|png)')


def _rational(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_degrees(parts, ref) -> float | None:
    if not isinstance(parts, (tuple, list)) or len(parts) != 3:
        return None
    values = [_rational(part) for part in parts]
    if any(v is None for v in values):
        return None
    degrees = values[0] + values[1] / 60 + values[2] / 3600
    if isinstance(ref, bytes):
        ref = ref.decode('ascii', 'ignore')
    return -degrees if str(ref).strip().upper() in ('S', 'W') else degrees


def _clean_text(value) -> str:
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'ignore')
    return str(value or '').replace('\x00', '').strip()


def read_metadata(data: bytes) -> dict:
    """{taken_at, offset_minutes, lat, lon, camera} lus dans l'EXIF ; chaque
    valeur absente ou illisible vaut None. Ne lève jamais : une photo sans
    EXIF reste une photo (rattachement manuel)."""
    meta = {'taken_at': None, 'offset_minutes': None, 'lat': None, 'lon': None, 'camera': None}
    try:
        with Image.open(io.BytesIO(data)) as img:
            exif = img.getexif()
            sub = exif.get_ifd(_EXIF_IFD)
            gps = exif.get_ifd(_GPS_IFD)
    except Exception:
        return meta
    match = _EXIF_DATETIME.fullmatch(_clean_text(sub.get(_TAG_DATETIME_ORIGINAL) or exif.get(_TAG_DATETIME)))
    if match:
        y, mo, d, h, mi, s = (int(g) for g in match.groups())
        try:
            meta['taken_at'] = datetime(y, mo, d, h, mi, s).isoformat()
        except ValueError:
            pass
    match = _EXIF_OFFSET.fullmatch(_clean_text(sub.get(_TAG_OFFSET_TIME_ORIGINAL)))
    if match:
        sign = -1 if match.group(1) == '-' else 1
        meta['offset_minutes'] = sign * (int(match.group(2)) * 60 + int(match.group(3)))
    lat = _gps_degrees(gps.get(2), gps.get(1))
    lon = _gps_degrees(gps.get(4), gps.get(3))
    # (0, 0) : position par défaut d'un GPS sans fix, jamais une vraie photo.
    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 \
            and not (abs(lat) < 1e-6 and abs(lon) < 1e-6):
        meta['lat'], meta['lon'] = lat, lon
    make, model = _clean_text(exif.get(_TAG_MAKE)), _clean_text(exif.get(_TAG_MODEL))
    camera = model if make and model.lower().startswith(make.lower()) else f'{make} {model}'.strip()
    meta['camera'] = camera[:CAMERA_MAX_LENGTH] or None
    return meta


def parcours_dir(parcours_id: int) -> Path:
    return paths.parcours_photos_dir() / str(int(parcours_id))


def safe_file_name(name) -> str:
    return name if isinstance(name, str) and _FILE_RE.fullmatch(name) else ''


def thumb_name(file: str) -> str:
    stem, ext = file.rsplit('.', 1)
    return f'{stem}.thumb.jpg'


def _thumbnail(normalized: bytes) -> bytes:
    with Image.open(io.BytesIO(normalized)) as img:
        img = img.convert('RGB')
        img.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, 'JPEG', quality=THUMB_QUALITY, optimize=True)
        return out.getvalue()


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + '.part')
    tmp.write_bytes(data)
    tmp.replace(path)


def photo_to_dict(row: ParcoursPhoto) -> dict:
    return {
        'id': row.id,
        'file': row.file,
        'name': row.original_name or '',
        'takenAt': row.taken_at,
        'offsetMinutes': row.offset_minutes,
        'lat': row.latitude,
        'lon': row.longitude,
        'camera': row.camera,
        'width': row.width,
        'height': row.height,
        'stopKey': row.stop_key,
        'hidden': bool(row.hidden),
        'caption': row.caption or '',
        'aspect': row.aspect or 'original',
        'focusX': 50 if row.focus_x is None else row.focus_x,
        'focusY': 50 if row.focus_y is None else row.focus_y,
        'zoom': 100 if row.zoom is None else row.zoom,
    }


def camera_to_dict(row: ParcoursCamera) -> dict:
    return {'camera': row.camera, 'offsetMinutes': row.offset_minutes}


def list_photos(session, parcours_id: int) -> dict:
    """{photos, cameras} d'un parcours, photos dans l'ordre de prise de vue
    (sans heure : à la fin, dans l'ordre d'envoi)."""
    photos = session.query(ParcoursPhoto).filter_by(parcours_id=parcours_id).all()
    photos.sort(key=lambda row: (row.taken_at is None, row.taken_at or '', row.id))
    cameras = session.query(ParcoursCamera).filter_by(parcours_id=parcours_id) \
        .order_by(ParcoursCamera.camera).all()
    return {'photos': [photo_to_dict(r) for r in photos], 'cameras': [camera_to_dict(r) for r in cameras]}


def save_photo(session, parcours_id: int, data: bytes, name: str = '') -> dict:
    """Lit l'EXIF, normalise et range une photo. Lève InvalidImage (fichier
    refusé) ou ParcoursError (`photos-full`)."""
    parcours = parcours_store.get(session, parcours_id)
    meta = read_metadata(data)
    normalized, ext, (width, height) = image_library.normalize_image(data)
    file = f'{hashlib.sha256(normalized).hexdigest()[:16]}.{ext}'
    existing = session.query(ParcoursPhoto).filter_by(parcours_id=parcours.id, file=file).one_or_none()
    if existing is not None:
        return photo_to_dict(existing)
    if session.query(ParcoursPhoto).filter_by(parcours_id=parcours.id).count() >= MAX_PHOTOS:
        raise ParcoursError('photos-full')
    folder = parcours_dir(parcours.id)
    folder.mkdir(parents=True, exist_ok=True)
    _write(folder / file, normalized)
    _write(folder / thumb_name(file), _thumbnail(normalized))
    row = ParcoursPhoto(
        parcours_id=parcours.id, file=file, original_name=(name or '')[:255],
        taken_at=meta['taken_at'], offset_minutes=meta['offset_minutes'],
        latitude=meta['lat'], longitude=meta['lon'], camera=meta['camera'],
        width=width, height=height, created_at=datetime.now(),
    )
    session.add(row)
    parcours.updated_at = datetime.now()
    session.commit()
    return photo_to_dict(row)


def _get_photo(session, parcours_id: int, photo_id: int) -> ParcoursPhoto:
    row = session.get(ParcoursPhoto, photo_id)
    if row is None or row.parcours_id != parcours_id:
        raise ParcoursError('photo-not-found')
    return row


def photo_path(session, parcours_id: int, photo_id: int, thumb: bool = False) -> Path:
    row = _get_photo(session, parcours_id, photo_id)
    return parcours_dir(parcours_id) / (thumb_name(row.file) if thumb else row.file)


def _int_in(value, bounds) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not bounds[0] <= value <= bounds[1]:
        raise ParcoursError('photo-invalid')
    return value


def update_photo(session, parcours_id: int, photo_id: int, data: dict) -> dict:
    """Rattachement manuel : `stopKey` (null : retour au rattachement
    automatique) ; affichage : `hidden`, `caption`, `aspect`, `focusX`,
    `focusY`, `zoom`. Tout est validé avant d'écrire : une valeur refusée
    ne laisse rien à moitié appliqué."""
    parcours = parcours_store.get(session, parcours_id)
    row = _get_photo(session, parcours.id, photo_id)
    data = data if isinstance(data, dict) else {}
    changes = {}
    if 'stopKey' in data:
        key = data['stopKey']
        if key is not None and (not isinstance(key, str) or not key
                                or len(key) > parcours_store.STOP_KEY_MAX_LENGTH):
            raise ParcoursError('photo-invalid')
        changes['stop_key'] = key
    if 'hidden' in data:
        if not isinstance(data['hidden'], bool):
            raise ParcoursError('photo-invalid')
        changes['hidden'] = data['hidden']
    if 'caption' in data:
        caption = data['caption']
        if caption is None:
            caption = ''
        if not isinstance(caption, str):
            raise ParcoursError('photo-invalid')
        caption = ' '.join(caption.split())
        if len(caption) > CAPTION_MAX_LENGTH:
            raise ParcoursError('photo-invalid')
        changes['caption'] = caption or None
    if 'aspect' in data:
        if data['aspect'] not in ASPECTS:
            raise ParcoursError('photo-invalid')
        changes['aspect'] = None if data['aspect'] == 'original' else data['aspect']
    for key, column, bounds in (('focusX', 'focus_x', FOCUS_RANGE), ('focusY', 'focus_y', FOCUS_RANGE),
                                ('zoom', 'zoom', ZOOM_RANGE)):
        if key in data:
            changes[column] = _int_in(data[key], bounds)
    for column, value in changes.items():
        setattr(row, column, value)
    parcours.updated_at = datetime.now()
    session.commit()
    return photo_to_dict(row)


def _unlink(folder: Path, file: str) -> None:
    for name in (file, thumb_name(file)):
        try:
            (folder / name).unlink()
        except FileNotFoundError:
            pass


def delete_photo(session, parcours_id: int, photo_id: int) -> None:
    parcours = parcours_store.get(session, parcours_id)
    row = _get_photo(session, parcours.id, photo_id)
    file = row.file
    session.delete(row)
    parcours.updated_at = datetime.now()
    session.commit()
    _unlink(parcours_dir(parcours.id), file)


def set_camera_offset(session, parcours_id: int, camera, offset) -> dict:
    """Décalage de l'horloge d'un appareil (minutes, null : l'efface)."""
    parcours = parcours_store.get(session, parcours_id)
    if not isinstance(camera, str) or not camera.strip() or len(camera) > CAMERA_MAX_LENGTH:
        raise ParcoursError('camera-invalid')
    row = session.query(ParcoursCamera).filter_by(parcours_id=parcours.id, camera=camera).one_or_none()
    if offset is None:
        if row is not None:
            session.delete(row)
    else:
        if isinstance(offset, bool) or not isinstance(offset, int) or abs(offset) > OFFSET_RANGE_MINUTES:
            raise ParcoursError('camera-invalid')
        if row is None:
            row = ParcoursCamera(parcours_id=parcours.id, camera=camera)
            session.add(row)
        row.offset_minutes = offset
    parcours.updated_at = datetime.now()
    session.commit()
    return list_photos(session, parcours.id)


def delete_all(session, parcours_id: int) -> None:
    """Photos, appareils et dossier d'un parcours (sans commit)."""
    session.query(ParcoursPhoto).filter_by(parcours_id=parcours_id).delete()
    session.query(ParcoursCamera).filter_by(parcours_id=parcours_id).delete()
    shutil.rmtree(parcours_dir(parcours_id), ignore_errors=True)
