"""Dossier images/ : les images de l'utilisateur posées sur la carte.

Avatar, logo d'association… (onglet Images, MyGCFlow_Plan_Images.md). Chaque
image envoyée est NORMALISÉE avant d'être gardée : vérifiée par Pillow,
redressée selon son orientation EXIF, réduite à IMAGE_MAX_SIDE px sur son
grand côté, réencodée en PNG si elle a de la transparence, en JPEG sinon. Le
navigateur ne reçoit donc jamais qu'un fichier propre, léger, servi par le
serveur local — la même origine que la page, condition pour que le canvas de
la vidéo ne soit pas « contaminé » (export impossible).

Le nom du fichier est l'empreinte de son contenu normalisé : la même image
envoyée deux fois n'est stockée qu'une fois, et un nom ne désigne jamais deux
contenus (servi avec un cache long). Le nom d'origine, lisible, vit dans les
réglages (images.items[].name), pas sur le disque.

Comme pour audio/ (audio_library.py), les fichiers que plus rien ne désigne
sont balayés passé un délai de grâce.
"""

import hashlib
import io
import os
import re
import tempfile
import time

from PIL import Image, ImageOps, UnidentifiedImageError

import paths

# Envoi refusé au-delà (le fichier brut, avant réduction).
IMAGE_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# Grand côté après normalisation : assez pour un logo en 4K, léger à dessiner.
IMAGE_MAX_SIDE = 1024
# Garde-fou contre les « bombes de décompression » (PNG minuscule déclarant
# des dimensions gigantesques) : refusées avant tout décodage.
IMAGE_MAX_SOURCE_PIXELS = 50_000_000
JPEG_QUALITY = 90
# Formats acceptés à l'envoi (Image.format). GIF : première image seulement.
ACCEPTED_FORMATS = frozenset({'PNG', 'JPEG', 'WEBP', 'GIF'})

# Une image tout juste envoyée n'entre dans les préférences qu'ensuite : elle
# ne doit pas être balayée entre-temps.
IMAGE_SWEEP_GRACE_S = 3600

_UPLOAD_PART_PREFIX = '.upload-'
# Nom d'un fichier du dossier : empreinte + extension produite ici.
_NAME_RE = re.compile(r'[0-9a-f]{16}\.(?:png|jpg)')


class InvalidImage(ValueError):
    """Fichier refusé. `reason` : 'too_large', 'not_image', 'format',
    'too_many_pixels' — le message montré à l'utilisateur en dépend."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def safe_image_name(name):
    """Nom d'un fichier du dossier images/, jamais un chemin ; '' sinon."""
    if isinstance(name, str) and _NAME_RE.fullmatch(name):
        return name
    return ''


def _has_transparency(img):
    """Vrai si l'image a de la transparence réellement utilisée (un PNG RGBA
    entièrement opaque devient un JPEG, bien plus léger)."""
    if img.mode in ('RGBA', 'LA', 'PA') or (img.mode == 'P' and 'transparency' in img.info):
        alpha = img.convert('RGBA').getchannel('A')
        return alpha.getextrema()[0] < 255
    return False


def normalize_image(data):
    """Octets d'une image envoyée → (octets normalisés, extension, (l, h)).

    Lève InvalidImage si le fichier est trop lourd, n'est pas une image, est
    d'un format non accepté ou déclare trop de pixels."""
    if len(data) > IMAGE_MAX_UPLOAD_BYTES:
        raise InvalidImage('too_large')
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format
            width, height = probe.size
            probe.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise InvalidImage('not_image')
    if fmt not in ACCEPTED_FORMATS:
        raise InvalidImage('format')
    if width * height > IMAGE_MAX_SOURCE_PIXELS:
        raise InvalidImage('too_many_pixels')

    try:
        # verify() laisse l'objet inutilisable : réouverture pour le décodage.
        with Image.open(io.BytesIO(data)) as source:
            source.seek(0)
            img = ImageOps.exif_transpose(source)
            alpha = _has_transparency(img)
            img = img.convert('RGBA' if alpha else 'RGB')
            img.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            if alpha:
                img.save(out, 'PNG', optimize=True)
                ext = 'png'
            else:
                img.save(out, 'JPEG', quality=JPEG_QUALITY, optimize=True)
                ext = 'jpg'
            return out.getvalue(), ext, img.size
    except (OSError, ValueError, Image.DecompressionBombError):
        raise InvalidImage('not_image')


def save_image(data):
    """Normalise et enregistre une image dans images/.

    Renvoie {'file', 'width', 'height', 'size_bytes'}. Un contenu déjà présent
    n'est pas réécrit (sa date est rafraîchie : de nouveau choisi, il ne doit
    pas être balayé avant d'entrer dans les préférences)."""
    normalized, ext, (width, height) = normalize_image(data)
    name = f"{hashlib.sha256(normalized).hexdigest()[:16]}.{ext}"
    folder = paths.ensure_dir(paths.images_dir())
    final_path = os.path.join(folder, name)
    if os.path.exists(final_path):
        try:
            os.utime(final_path)
        except OSError:
            pass
    else:
        fd, tmp_path = tempfile.mkstemp(dir=folder, prefix=_UPLOAD_PART_PREFIX, suffix='.part')
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(normalized)
            os.replace(tmp_path, final_path)
        except BaseException:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
    return {'file': name, 'width': width, 'height': height, 'size_bytes': len(normalized)}


def _value(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def referenced_image_files(images_settings):
    """Images que les préférences désignent : celles de la liste courante et
    celles des configurations nommées (pour pouvoir les réappliquer)."""
    referenced = set()

    def collect(items):
        for item in items or []:
            name = safe_image_name(_value(item, 'file'))
            if name:
                referenced.add(name)

    if images_settings is None:
        return referenced
    collect(_value(images_settings, 'items'))
    for config in _value(images_settings, 'configs') or []:
        collect(_value(config, 'items'))
    return referenced


def list_image_files(referenced):
    """Contenu du dossier : {'files': [{'file', 'size_bytes', 'width',
    'height', 'referenced', 'modified'}], 'total_bytes'}, du plus récent au
    plus ancien (la bibliothèque propose d'abord les derniers envois)."""
    folder = paths.images_dir()
    files = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        entries = []
    for entry in entries:
        if not entry.is_file() or not safe_image_name(entry.name):
            continue
        try:
            stat = entry.stat()
            # Lecture de l'en-tête seulement : les pixels ne sont pas décodés.
            with Image.open(entry.path) as img:
                width, height = img.size
        except (OSError, UnidentifiedImageError):
            continue
        files.append({
            'file': entry.name,
            'size_bytes': stat.st_size,
            'width': width,
            'height': height,
            'referenced': entry.name in referenced,
            'modified': stat.st_mtime,
        })
    files.sort(key=lambda f: (-f['modified'], f['file']))
    return {'files': files, 'total_bytes': sum(f['size_bytes'] for f in files)}


def sweep_image_dir(referenced, now=None, grace_s=IMAGE_SWEEP_GRACE_S):
    """Supprime les images que plus rien ne désigne (et les envois
    interrompus), passé le délai de grâce. Renvoie les noms supprimés. Les
    fichiers étrangers au dossier (autre nom) ne sont jamais touchés."""
    folder = paths.images_dir()
    cutoff = (now if now is not None else time.time()) - grace_s
    removed = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return removed
    for entry in entries:
        if not entry.is_file():
            continue
        is_part = entry.name.startswith(_UPLOAD_PART_PREFIX)
        if not is_part and (not safe_image_name(entry.name) or entry.name in referenced):
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            os.remove(entry.path)
            removed.append(entry.name)
        except OSError:
            pass
    return removed


def delete_image_file(name):
    """Supprime une image du dossier. False si elle n'y était pas."""
    safe = safe_image_name(name)
    if not safe:
        return False
    path = os.path.join(paths.images_dir(), safe)
    if not os.path.isfile(path):
        return False
    os.remove(path)
    return True
