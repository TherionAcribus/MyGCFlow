#!/usr/bin/env python3
"""
Verifie que toutes les chaines du template messages.pot sont traduites
dans chaque fichier translations/<lang>/LC_MESSAGES/messages.po.
Renvoie un code de sortie non nul s'il manque des traductions.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from config import Config

BASE_DIR = Path(__file__).parent
POT_FILE = BASE_DIR / "messages.pot"
TRANSLATIONS_DIR = BASE_DIR / "translations"
SUPPORTED_LOCALES = getattr(Config, "BABEL_SUPPORTED_LOCALES", [])


def po_string_content(segment: str) -> str:
    return segment.strip().strip('"')


def parse_po_file(path: Path) -> Dict[str, List[str]]:
    """
    Retourne un mapping msgid -> liste de msgstr (pluriels inclus).
    Ne gere pas l'integralite du format PO mais suffit pour un controle rapide.
    """
    entries: Dict[str, List[str]] = {}
    if not path.exists():
        return entries

    current_id = None
    current_plural = None
    msgstrs: List[str] = []
    current_field = None  # 'msgid', 'msgid_plural', 'msgstr'

    def flush():
        nonlocal current_id, current_plural, msgstrs
        if current_id is not None:
            key = current_id
            entries[key] = msgstrs[:] if msgstrs else [""]
        current_id = None
        current_plural = None
        msgstrs = []

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            current_field = None
            continue
        if line.startswith("#"):
            continue

        if line.startswith("msgid_plural"):
            current_field = "msgid_plural"
            current_plural = po_string_content(line.split(" ", 1)[1])
            continue

        if line.startswith("msgid"):
            flush()
            current_field = "msgid"
            current_id = po_string_content(line.split(" ", 1)[1])
            continue

        if line.startswith("msgstr"):
            current_field = "msgstr"
            msgstrs.append(po_string_content(line.split(" ", 1)[1]))
            continue

        if line.startswith('"'):
            extra = po_string_content(line)
            if current_field == "msgid" and current_id is not None:
                current_id += extra
            elif current_field == "msgid_plural" and current_plural is not None:
                current_plural += extra
            elif current_field == "msgstr" and msgstrs:
                msgstrs[-1] += extra
            continue

    flush()
    entries.pop("", None)  # Supprimer l'entete
    return entries


def report_missing(locale: str, missing: List[str], empty: List[str]) -> None:
    def _print_list(title: str, items: List[str]) -> None:
        if not items:
            return
        print(f"  {title} ({len(items)}):")
        for msgid in items[:20]:
            print(f"    - {msgid}")
        if len(items) > 20:
            print(f"    ... (+{len(items) - 20} supplementaires)")

    print(f"[{locale}] Traductions manquantes:")
    _print_list("Absents", missing)
    _print_list("Sans msgstr", empty)
    print()


def main() -> int:
    if not POT_FILE.exists():
        print("Fichier messages.pot introuvable, impossible de verifier les traductions.")
        return 1

    pot_entries = parse_po_file(POT_FILE)
    if not pot_entries:
        print("Aucune entree trouvee dans messages.pot.")
        return 1

    has_errors = False
    for locale in SUPPORTED_LOCALES:
        po_path = TRANSLATIONS_DIR / locale / "LC_MESSAGES" / "messages.po"
        po_entries = parse_po_file(po_path)

        if not po_entries:
            print(f"[{locale}] Fichier de traduction manquant ou vide: {po_path}")
            has_errors = True
            continue

        missing_ids = [msgid for msgid in pot_entries if msgid not in po_entries]
        empty_ids = [
            msgid
            for msgid, translations in po_entries.items()
            if msgid in pot_entries and all(not part.strip() for part in translations)
        ]

        if missing_ids or empty_ids:
            has_errors = True
            report_missing(locale, missing_ids, empty_ids)

    if has_errors:
        print("Des traductions manquent. Completez messages.po puis recompilez.")
        return 1

    print(f"Aucune traduction manquante pour: {', '.join(SUPPORTED_LOCALES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
