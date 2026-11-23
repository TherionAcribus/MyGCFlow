"""Chapitres d'une vidéo exportée (une journée de parcours par chapitre).

Le client relève le début de chaque journée pendant la capture et l'envoie
avec la demande d'encodage (`chapters`, JSON : [{start, day, date}], start en
secondes de la vidéo finale, date déjà formatée pour l'affichage). Deux
sorties :

- les chapitres intégrés au MP4 (fichier de métadonnées ffmpeg passé en
  entrée, `-map_chapters`) : tous, quelle que soit leur durée ;
- la liste au format des chapitres YouTube, à coller dans la description,
  écrite à côté de la vidéo (`<nom>.youtube.txt`). YouTube ignore toute la
  liste si un chapitre dure moins de 10 s ou s'il y en a moins de trois :
  les journées trop courtes y sont regroupées avec la précédente.

Module sans Flask (testé seul) ; les titres passent par le gettext reçu.
"""

import json
import math
import os
import re

MAX_CHAPTERS = 1000
YOUTUBE_MIN_SECONDS = 10.0
YOUTUBE_MIN_CHAPTERS = 3
CHAPTERS_FILE_SUFFIX = '.youtube.txt'

_CONTROL_RE = re.compile(r'[\x00-\x1f\x7f]')


def _identity(msgid, **kwargs):
    return msgid % kwargs if kwargs else msgid


def parse_chapters(raw):
    """Chapitres valides triés, le premier ramené à 0 s ; [] si moins de deux.

    `raw` : liste, ou chaîne JSON (champ de formulaire). Toute entrée mal
    formée est écartée sans faire échouer l'export.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else []
        except ValueError:
            return []
    if not isinstance(raw, list):
        return []
    chapters = []
    for item in raw[:MAX_CHAPTERS]:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get('start'))
            day = int(item.get('day'))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or start < 0 or day < 1:
            continue
        date = _CONTROL_RE.sub('', str(item.get('date') or '')).strip()[:40]
        chapters.append({'start': start, 'day': day, 'date': date})
    chapters.sort(key=lambda chapter: chapter['start'])
    unique = []
    for chapter in chapters:
        if unique and chapter['start'] <= unique[-1]['start']:
            continue
        unique.append(chapter)
    if len(unique) < 2:
        return []
    unique[0]['start'] = 0.0
    return unique


def within_duration(chapters, total_seconds):
    """Chapitres qui commencent dans la vidéo ; [] s'il en reste moins de deux."""
    if not total_seconds or total_seconds <= 0:
        return chapters
    kept = [chapter for chapter in chapters if chapter['start'] < total_seconds]
    return kept if len(kept) >= 2 else []


def chapter_title(group, gettext=_identity):
    """Titre d'un chapitre : une journée, ou plusieurs regroupées."""
    first, last = group[0], group[-1]
    if len(group) == 1:
        if first['date']:
            return gettext('Jour %(day)s — %(date)s', day=first['day'], date=first['date'])
        return gettext('Jour %(day)s', day=first['day'])
    if first['date'] and last['date']:
        return gettext('Jours %(first)s à %(last)s — %(start)s → %(end)s',
                       first=first['day'], last=last['day'], start=first['date'], end=last['date'])
    return gettext('Jours %(first)s à %(last)s', first=first['day'], last=last['day'])


def _escape_ffmetadata(value):
    # Caractères spéciaux du format ffmetadata : '=', ';', '#', '\' et saut de ligne.
    return re.sub(r'([=;#\\\n])', r'\\\1', value)


def ffmetadata_text(chapters, total_seconds=None, gettext=_identity):
    """Contenu du fichier de métadonnées ffmpeg (base de temps : la ms)."""
    lines = [';FFMETADATA1']
    for index, chapter in enumerate(chapters):
        start = int(round(chapter['start'] * 1000))
        if index + 1 < len(chapters):
            end = int(round(chapters[index + 1]['start'] * 1000))
        elif total_seconds and total_seconds * 1000 > start:
            end = int(round(total_seconds * 1000))
        else:
            end = start + 1
        lines += [
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            f'START={start}',
            f'END={end}',
            f'title={_escape_ffmetadata(chapter_title([chapter], gettext))}',
        ]
    return '\n'.join(lines) + '\n'


def format_timestamp(seconds):
    """Horodatage YouTube : m:ss, ou h:mm:ss au-delà d'une heure."""
    total = max(0, int(math.floor(seconds)))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f'{hours}:{minutes:02d}:{secs:02d}'
    return f'{minutes}:{secs:02d}'


def youtube_groups(chapters, total_seconds, min_seconds=YOUTUBE_MIN_SECONDS):
    """Journées regroupées pour que chaque chapitre dure au moins `min_seconds`
    (le plus court rejoint le précédent, le premier le suivant) ; None si la
    liste reste refusée par YouTube (moins de trois chapitres)."""
    if not chapters or not total_seconds or total_seconds <= 0:
        return None
    groups = [[chapter] for chapter in chapters]

    # Horodatages tronqués à la seconde : c'est la durée affichée qui compte.
    def length(index):
        end = groups[index + 1][0]['start'] if index + 1 < len(groups) else total_seconds
        return math.floor(end) - math.floor(groups[index][0]['start'])

    while len(groups) > 1:
        short = next((i for i in range(len(groups)) if length(i) < min_seconds), None)
        if short is None:
            break
        at = max(1, short)
        groups[at - 1:at + 1] = [groups[at - 1] + groups[at]]
    if len(groups) < YOUTUBE_MIN_CHAPTERS:
        return None
    return groups


def youtube_text(chapters, total_seconds, gettext=_identity):
    """Liste à coller dans la description YouTube, ou None si elle n'y serait
    pas reconnue."""
    groups = youtube_groups(chapters, total_seconds)
    if not groups:
        return None
    return '\n'.join(
        f"{format_timestamp(group[0]['start'])} {chapter_title(group, gettext)}" for group in groups
    ) + '\n'


def chapters_file_path(video_path):
    """Fichier de la liste YouTube, à côté de la vidéo."""
    return os.path.splitext(str(video_path))[0] + CHAPTERS_FILE_SUFFIX
