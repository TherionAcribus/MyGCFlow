"""Export complet d'un parcours (sauvegarde, transfert entre machines) :
archive ZIP embarquant le document JSON réimportable enrichi — métadonnées
`photos`, `cameras` et `tracks` en plus, ignorées par l'import v1 actuel —
et les fichiers : photos normalisées et traces reconstruites en GPX.

Module à part : `parcours_photos` importe déjà `parcours_store`
(STOP_KEY_MAX_LENGTH), qui ne peut donc pas le réimporter.
"""

from __future__ import annotations

import io
import json
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from xml.sax.saxutils import escape

import parcours_photos
import parcours_store as store
from models import ParcoursCamera, ParcoursPhoto, ParcoursTrack
from parcours_photos import camera_to_dict, photo_to_dict
from parcours_tracks import track_to_dict


def slug(name, fallback='export'):
    """Nom de fichier sûr : minuscules ASCII, tirets."""
    text = unicodedata.normalize('NFKD', name or '').encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'[^a-zA-Z0-9._-]+', '-', text.lower()).strip('-.')
    return text[:60] or fallback


def _track_gpx(row) -> bytes:
    """GPX reconstruit depuis la trace simplifiée : même géométrie et mêmes
    heures qu'elle — un segment par trkseg, <time> ISO UTC par point."""
    segments = json.loads(row.segments)
    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="MyGCFlow" xmlns="http://www.topografix.com/GPX/1/1">',
             f'  <trk><name>{escape(row.name or "trace")}</name>']
    for seg in segments:
        parts.append('    <trkseg>')
        for lon, lat, t in seg:
            when = datetime.fromtimestamp(t, timezone.utc).isoformat().replace('+00:00', 'Z')
            parts.append(f'      <trkpt lat="{lat}" lon="{lon}"><time>{when}</time></trkpt>')
        parts.append('    </trkseg>')
    parts.append('  </trk>\n</gpx>')
    return '\n'.join(parts).encode('utf-8')


def export_zip(session, parcours_id) -> io.BytesIO:
    """Archive ZIP : parcours.json enrichi + photos/* + tracks/*.gpx."""
    parcours = store.get(session, parcours_id)   # lève not-found
    payload = store.export_payload(session, parcours_id)
    photos = session.query(ParcoursPhoto).filter_by(parcours_id=parcours.id) \
        .order_by(ParcoursPhoto.id).all()
    tracks = session.query(ParcoursTrack).filter_by(parcours_id=parcours.id) \
        .order_by(ParcoursTrack.id).all()
    cameras = session.query(ParcoursCamera).filter_by(parcours_id=parcours.id) \
        .order_by(ParcoursCamera.id).all()

    # Métadonnées des fichiers embarqués, jointes au document réimportable.
    payload['photos'] = [
        {k: v for k, v in {**photo_to_dict(row), 'path': f'photos/{row.file}'}.items() if k != 'id'}
        for row in photos]
    payload['cameras'] = [camera_to_dict(row) for row in cameras]
    payload['tracks'] = []
    track_members = []
    for i, row in enumerate(tracks, 1):
        member = f'tracks/{i}-{slug(row.name, "trace")}.gpx'
        meta = {k: v for k, v in track_to_dict(row, with_points=False).items() if k != 'id'}
        meta['file'] = member
        payload['tracks'].append(meta)
        track_members.append((row, member))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('parcours.json', json.dumps(payload, ensure_ascii=False, indent=1))
        folder = parcours_photos.parcours_dir(parcours.id)
        for row in photos:
            path = folder / row.file
            if path.is_file():   # fichier disparu : métadonnées gardées
                z.write(path, f'photos/{row.file}')
        for row, member in track_members:
            z.writestr(member, _track_gpx(row))
    buffer.seek(0)
    return buffer
