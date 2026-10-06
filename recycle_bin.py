"""Suppression récupérable : envoie un fichier à la Corbeille.

Une vidéo peut représenter de longues minutes de rendu : la supprimer depuis
l'interface ne doit pas être définitif. Sous Windows, le fichier part dans la
Corbeille (SHFileOperation, via ctypes, sans dépendance). Ailleurs, ou si la
Corbeille refuse, il est supprimé pour de bon — l'interface demande de toute
façon une confirmation.
"""

from __future__ import annotations

import os

_FO_DELETE = 3
_FOF_SILENT = 0x0004
_FOF_NOCONFIRMATION = 0x0010
_FOF_ALLOWUNDO = 0x0040
_FOF_NOERRORUI = 0x0400


def send_to_trash(path) -> bool:
    """Supprime `path`. Renvoie True s'il est récupérable dans la Corbeille,
    False s'il a été supprimé définitivement. Lève OSError si rien n'a pu être
    supprimé."""
    path = os.path.abspath(str(path))
    if os.name == "nt":
        try:
            if _recycle_windows(path) and not os.path.exists(path):
                return True
        except Exception as exc:
            print(f"[recycle_bin] Corbeille indisponible, suppression directe : {exc}")
    if os.path.exists(path):
        os.remove(path)
    return False


def _recycle_windows(path) -> bool:
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", ctypes.c_void_p),
            ("pTo", ctypes.c_void_p),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_void_p),
        ]

    # pFrom est une liste de chemins : chacun terminé par un caractère nul, la
    # liste par un second (ajouté par create_unicode_buffer).
    source = ctypes.create_unicode_buffer(path + "\0")
    operation = SHFILEOPSTRUCTW(
        hwnd=None,
        wFunc=_FO_DELETE,
        pFrom=ctypes.cast(source, ctypes.c_void_p),
        pTo=None,
        fFlags=_FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_SILENT | _FOF_NOERRORUI,
    )
    shell32 = ctypes.windll.shell32
    shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    shell32.SHFileOperationW.restype = ctypes.c_int
    result = shell32.SHFileOperationW(ctypes.byref(operation))
    return result == 0 and not operation.fAnyOperationsAborted
