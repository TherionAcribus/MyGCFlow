"""Dossier audio/ : les copies des musiques choisies.

Chaque musique choisie y est copiée (capture._save_uploaded_audio), pour être
lue par ffmpeg à l'export et rechargée au démarrage. Seules comptent la
musique courante (recording.audio_file) et les musiques récentes
(recording.audio_recent) : une copie sortie de ces listes ne sert plus à
rien, mais restait sur le disque indéfiniment. Ce module les inventorie, les
balaie et les retire.

Il produit aussi, pour un format que le navigateur ne sait pas décoder
(.wma, .aiff…), une version lisible convertie par ffmpeg — qui lit bien plus
de formats. Elle ne sert qu'à l'écran (forme d'onde, mesure, écoute) : l'export
garde l'original, pour ne pas ajouter une compression à la vidéo.
"""

import os
import subprocess
import tempfile
import time

from werkzeug.utils import secure_filename

import paths
from capture import _SUBPROCESS_FLAGS, _get_ffmpeg_exe

# Version lisible d'une musique : son nom suivi de ce suffixe.
PLAYABLE_SUFFIX = '.playable.flac'

# Une copie non référencée n'est balayée qu'après ce délai : la musique tout
# juste envoyée n'entre dans les préférences qu'une fois sa copie faite
# (rememberMusic, ui.js) — elle ne doit pas disparaître entre-temps.
AUDIO_SWEEP_GRACE_S = 3600

# Conversion d'un morceau entier : quelques secondes d'ordinaire.
PLAYABLE_TIMEOUT_S = 300

# Fichiers temporaires d'un envoi interrompu (cf. _save_uploaded_audio).
_UPLOAD_PART_PREFIX = '.upload-'


def safe_audio_name(name):
    """Nom de fichier du dossier audio/, jamais un chemin ; '' si inexploitable."""
    if not isinstance(name, str):
        return ''
    return secure_filename(os.path.basename(name))


def original_name(name):
    """Musique d'origine d'un fichier du dossier : elle-même, ou celle dont il
    est la version lisible."""
    return name[:-len(PLAYABLE_SUFFIX)] if name.endswith(PLAYABLE_SUFFIX) else name


def referenced_audio_files(recording):
    """Musiques que les préférences désignent : la courante et les récentes."""
    names = {recording.audio_file} if recording.audio_file else set()
    for entry in recording.audio_recent or []:
        if isinstance(entry, dict) and entry.get('file'):
            names.add(entry['file'])
    return names


def list_audio_files(referenced):
    """Contenu du dossier, version lisible comptée avec sa musique :
    {'files': [{'file', 'size_bytes', 'referenced'}], 'total_bytes'}."""
    folder = paths.audio_dir()
    sizes = {}
    try:
        entries = list(os.scandir(folder))
    except OSError:
        entries = []
    for entry in entries:
        if not entry.is_file() or entry.name.startswith(_UPLOAD_PART_PREFIX):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        base = original_name(entry.name)
        sizes[base] = sizes.get(base, 0) + size
    files = [
        {'file': name, 'size_bytes': size, 'referenced': name in referenced}
        for name, size in sorted(sizes.items())
    ]
    return {'files': files, 'total_bytes': sum(sizes.values())}


def sweep_audio_dir(referenced, now=None, grace_s=AUDIO_SWEEP_GRACE_S):
    """Supprime les copies que plus rien ne désigne (et les envois interrompus),
    passé le délai de grâce. Renvoie les noms supprimés. Un fichier en cours
    de lecture (export) ne peut pas être supprimé sous Windows : il est laissé
    pour le prochain balayage."""
    folder = paths.audio_dir()
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
        if not is_part and original_name(entry.name) in referenced:
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            os.remove(entry.path)
            removed.append(entry.name)
        except OSError:
            pass
    return removed


def delete_audio_file(name):
    """Supprime une musique du dossier, et sa version lisible. False si elle
    n'y était pas ; OSError si elle est en cours de lecture."""
    safe = safe_audio_name(name)
    if not safe:
        return False
    folder = str(paths.audio_dir())
    found = False
    for candidate in (safe, safe + PLAYABLE_SUFFIX):
        path = os.path.join(folder, candidate)
        if os.path.isfile(path):
            os.remove(path)
            found = True
    return found


class UnreadableAudio(Exception):
    """ffmpeg ne trouve aucune piste audio lisible dans le fichier."""


def playable_audio(name):
    """Nom de la version lisible par le navigateur d'une musique du dossier,
    convertie au premier appel puis réutilisée. En FLAC : décodé par tous les
    navigateurs — l'AAC ne l'est pas par Chromium sans codecs propriétaires
    (Linux, navigateur des tests) —, encodé par ffmpeg sans bibliothèque
    externe, et sans perte. FileNotFoundError si la musique n'est
    pas dans le dossier ; UnreadableAudio si ffmpeg ne la lit pas non plus."""
    safe = safe_audio_name(name)
    if not safe or safe.endswith(PLAYABLE_SUFFIX):
        raise FileNotFoundError(name)
    folder = str(paths.audio_dir())
    source = os.path.join(folder, safe)
    if not os.path.isfile(source):
        raise FileNotFoundError(name)
    target_name = safe + PLAYABLE_SUFFIX
    target = os.path.join(folder, target_name)
    if os.path.isfile(target):
        return target_name
    fd, tmp_path = tempfile.mkstemp(dir=folder, prefix=_UPLOAD_PART_PREFIX, suffix='.flac')
    os.close(fd)
    try:
        proc = subprocess.run(
            [_get_ffmpeg_exe(), '-y', '-v', 'error', '-i', source,
             '-map', '0:a:0', '-vn', '-c:a', 'flac', '-f', 'flac', tmp_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            universal_newlines=True, encoding='utf-8', errors='replace',
            timeout=PLAYABLE_TIMEOUT_S, creationflags=_SUBPROCESS_FLAGS,
        )
        if proc.returncode != 0 or os.path.getsize(tmp_path) == 0:
            print(f"[audio] conversion impossible de {safe}: {(proc.stderr or '').strip()[:500]}")
            raise UnreadableAudio(safe)
        os.replace(tmp_path, target)
        return target_name
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
