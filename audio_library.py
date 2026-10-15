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

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time

from werkzeug.utils import secure_filename

import paths
from capture import _SUBPROCESS_FLAGS, _get_ffmpeg_exe, _probe_duration_seconds

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
    """Musiques que les préférences désignent : la courante et les récentes,
    et, pour un enchaînement, chacun de ses morceaux (pour pouvoir le
    modifier)."""
    names = {recording.audio_file} if recording.audio_file else set()
    playlists = [getattr(recording, 'audio_playlist', None) or []]
    for entry in recording.audio_recent or []:
        if isinstance(entry, dict) and entry.get('file'):
            names.add(entry['file'])
            playlists.append(entry.get('playlist') or [])
    for playlist in playlists:
        for track in playlist:
            if isinstance(track, dict) and track.get('file'):
                names.add(track['file'])
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


# --------- Enchaînement de plusieurs morceaux ---------
#
# Les morceaux sont assemblés une fois pour toutes en un seul fichier du
# dossier, que l'application traite ensuite comme n'importe quelle musique :
# départ, boucle, fondus, forme d'onde, écoute et exports n'ont rien de
# particulier à savoir. FLAC : sans perte (l'export compresse une seule fois),
# et lisible par tous les navigateurs.

# Version de l'assemblage : la changer invalide les enchaînements déjà faits
# (leur nom en dépend).
MIX_VERSION = 1
MIX_PREFIX = 'enchainement-'
MIX_TIMEOUT_S = 600

# Équilibrage des morceaux : chacun ramené au même niveau moyen, sans que ses
# crêtes ne dépassent PEAK_CEILING_DB — mêmes valeurs que l'harmonisation du
# volume côté navigateur (static/js/music_analysis.mjs).
LOUDNESS_TARGET_DB = -16.0
PEAK_CEILING_DB = -0.9
MAX_GAIN_DB = 20.0
# Seuil des blancs retirés aux raccords (même que audio_silence.mjs), et
# traîne gardée en fin de morceau pour ne pas couper une réverbération.
SILENCE_THRESHOLD_DB = -50
SILENCE_TAIL_KEPT_S = 0.3
# Part maximale du plus court morceau que peut occuper un fondu enchaîné.
MAX_CROSSFADE_SHARE = 0.4

_MEAN_VOLUME_RE = re.compile(r'mean_volume:\s*(-?[\d.]+|-inf) dB')
_MAX_VOLUME_RE = re.compile(r'max_volume:\s*(-?[\d.]+|-inf) dB')


class MixError(Exception):
    """L'assemblage a échoué (morceau illisible, trop court pour le fondu…)."""


def _run(cmd, timeout):
    return subprocess.run(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        universal_newlines=True, encoding='utf-8', errors='replace',
        timeout=timeout, creationflags=_SUBPROCESS_FLAGS,
    )


def track_gain_db(path):
    """Gain (dB) qui amène un morceau au niveau commun, sans saturer : niveau
    moyen et crête mesurés par ffmpeg (volumedetect). 0 pour un morceau muet
    ou non mesurable."""
    proc = _run([_get_ffmpeg_exe(), '-v', 'info', '-nostats', '-i', path,
                 '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], MIX_TIMEOUT_S)
    mean = _MEAN_VOLUME_RE.search(proc.stderr or '')
    peak = _MAX_VOLUME_RE.search(proc.stderr or '')
    if proc.returncode != 0:
        raise MixError(os.path.basename(path))
    if not mean or not peak or '-inf' in (mean.group(1), peak.group(1)):
        return 0.0
    wanted = LOUDNESS_TARGET_DB - float(mean.group(1))
    headroom = PEAK_CEILING_DB - float(peak.group(1))
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, wanted, headroom))


def mix_name(tracks, crossfade_s):
    """Nom de l'enchaînement de ces morceaux : tiré de ses paramètres, il est
    retrouvé tel quel au lieu d'être refait."""
    key = json.dumps([MIX_VERSION, list(tracks), round(float(crossfade_s), 3)])
    return f"{MIX_PREFIX}{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}.flac"


def mix_filter_graph(gains_db, crossfade_s):
    """Graphe ffmpeg de l'enchaînement, des entrées [0:a]… à la sortie [out].

    Chaque morceau est mis au même format, équilibré (gain), et débarrassé des
    blancs qui le séparent de ses voisins : le début des suivants, la fin des
    précédents (une traîne courte gardée). Puis ils s'enchaînent, en fondu
    (acrossfade, quart de sinus comme les reprises de boucle) ou bout à bout.
    """
    count = len(gains_db)
    silence = f"silenceremove=start_periods=1:start_threshold={SILENCE_THRESHOLD_DB}dB"
    parts = []
    for i, gain in enumerate(gains_db):
        chain = [f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                 f"volume={gain:.2f}dB"]
        if i > 0:
            chain.append(silence)
        if i < count - 1:
            chain += ['areverse', f"{silence}:start_silence={SILENCE_TAIL_KEPT_S}", 'areverse']
        parts.append(f"[{i}:a]{','.join(chain)}[t{i}]")
    if crossfade_s > 0:
        previous = 't0'
        for i in range(1, count):
            label = 'out' if i == count - 1 else f"m{i}"
            parts.append(f"[{previous}][t{i}]acrossfade=d={crossfade_s:.3f}:c1=qsin:c2=qsin[{label}]")
            previous = label
    else:
        inputs = ''.join(f"[t{i}]" for i in range(count))
        parts.append(f"{inputs}concat=n={count}:v=0:a=1[out]")
    return ';'.join(parts)


def build_playlist_mix(tracks, crossfade_s=0.0):
    """Assemble les morceaux `tracks` (noms du dossier, dans l'ordre) en un
    enchaînement, ou retrouve celui déjà fait. Renvoie {'file', 'tracks':
    [{'file', 'duration_seconds'}]}. FileNotFoundError si un morceau manque ;
    MixError si ffmpeg échoue."""
    names = [safe_audio_name(t) for t in tracks]
    if len(names) < 2 or not all(names):
        raise ValueError('tracks')
    folder = str(paths.audio_dir())
    sources = [os.path.join(folder, n) for n in names]
    for source in sources:
        if not os.path.isfile(source):
            raise FileNotFoundError(os.path.basename(source))
    durations = [_probe_duration_seconds(source) or 0.0 for source in sources]
    described = [{'file': n, 'duration_seconds': d} for n, d in zip(names, durations)]
    # Fondu borné par le plus court morceau (acrossfade exige des morceaux
    # plus longs que lui).
    crossfade = max(0.0, float(crossfade_s or 0))
    shortest = min(d for d in durations if d > 0) if any(d > 0 for d in durations) else 0.0
    if crossfade > 0 and shortest > 0:
        crossfade = min(crossfade, shortest * MAX_CROSSFADE_SHARE)
    name = mix_name(names, crossfade)
    target = os.path.join(folder, name)
    if os.path.isfile(target):
        os.utime(target)  # de nouveau demandé : pas une copie oubliée
        return {'file': name, 'tracks': described}

    gains = [track_gain_db(source) for source in sources]
    fd, tmp_path = tempfile.mkstemp(dir=folder, prefix=_UPLOAD_PART_PREFIX, suffix='.flac')
    os.close(fd)
    try:
        cmd = [_get_ffmpeg_exe(), '-y', '-v', 'error']
        for source in sources:
            cmd += ['-i', source]
        cmd += ['-filter_complex', mix_filter_graph(gains, crossfade), '-map', '[out]',
                '-c:a', 'flac', '-f', 'flac', tmp_path]
        proc = _run(cmd, MIX_TIMEOUT_S)
        if proc.returncode != 0 or os.path.getsize(tmp_path) == 0:
            print(f"[audio] enchaînement impossible: {(proc.stderr or '').strip()[:500]}")
            raise MixError(name)
        os.replace(tmp_path, target)
        return {'file': name, 'tracks': described}
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
