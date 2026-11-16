"""Parcours enregistrés : création, lecture, modification, suppression.

Un parcours est une sélection de trouvailles sur une plage de dates courte
(une journée, des vacances), rejouée cache par cache sur la page /parcours
(MyGCFlow_Plan_Parcours.md). Seule la sélection est stockée : l'ordre de
passage et les heures sont reconstruits à chaque ouverture.

Les erreurs de saisie lèvent `ParcoursError(code)` ; le blueprint traduit le
code en message (comme evolution_store).
"""

from __future__ import annotations

from datetime import date, datetime

from models import Parcours

NAME_MAX_LENGTH = 80
# Format pensé pour des sorties courtes : au-delà, l'animation cache par cache
# n'a plus de sens (l'animation jour par jour de la page principale s'impose).
MAX_DAYS = 92


class ParcoursError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _name(value) -> str:
    name = value.strip() if isinstance(value, str) else ''
    if not name:
        raise ParcoursError('name-empty')
    if len(name) > NAME_MAX_LENGTH:
        raise ParcoursError('name-too-long')
    return name


def _date(value) -> date:
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    raise ParcoursError('date-invalid')


def _bool(value, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _check_range(start: date, end: date) -> None:
    if end < start:
        raise ParcoursError('range-reversed')
    if (end - start).days + 1 > MAX_DAYS:
        raise ParcoursError('range-too-long')


def to_dict(parcours: Parcours) -> dict:
    return {
        'id': parcours.id,
        'name': parcours.name,
        'date_start': parcours.date_start.isoformat(),
        'date_end': parcours.date_end.isoformat(),
        'include_labs': bool(parcours.include_labs),
        'include_dnf': bool(parcours.include_dnf),
        'created_at': parcours.created_at.isoformat() if parcours.created_at else None,
        'updated_at': parcours.updated_at.isoformat() if parcours.updated_at else None,
    }


def list_parcours(session) -> list[dict]:
    """Les plus récents d'abord (plage), puis par nom."""
    rows = session.query(Parcours).order_by(
        Parcours.date_start.desc(), Parcours.date_end.desc(), Parcours.name, Parcours.id).all()
    return [to_dict(row) for row in rows]


def get(session, parcours_id: int) -> Parcours:
    row = session.get(Parcours, parcours_id)
    if row is None:
        raise ParcoursError('not-found')
    return row


def create(session, data: dict) -> Parcours:
    data = data if isinstance(data, dict) else {}
    start = _date(data.get('date_start'))
    end = _date(data.get('date_end', data.get('date_start')))
    _check_range(start, end)
    now = datetime.now()
    row = Parcours(
        name=_name(data.get('name')),
        date_start=start,
        date_end=end,
        include_labs=_bool(data.get('include_labs'), True),
        include_dnf=_bool(data.get('include_dnf'), True),
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.commit()
    return row


def update(session, parcours_id: int, data: dict) -> Parcours:
    """Patch : une clé absente garde sa valeur."""
    row = get(session, parcours_id)
    data = data if isinstance(data, dict) else {}
    name = _name(data['name']) if 'name' in data else row.name
    start = _date(data['date_start']) if 'date_start' in data else row.date_start
    end = _date(data['date_end']) if 'date_end' in data else row.date_end
    _check_range(start, end)
    row.name = name
    row.date_start = start
    row.date_end = end
    row.include_labs = _bool(data.get('include_labs'), row.include_labs)
    row.include_dnf = _bool(data.get('include_dnf'), row.include_dnf)
    row.updated_at = datetime.now()
    session.commit()
    return row


def delete(session, parcours_id: int) -> None:
    row = get(session, parcours_id)
    session.delete(row)
    session.commit()
