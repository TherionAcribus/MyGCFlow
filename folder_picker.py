"""Sélecteur de dossier natif, ouvert par le serveur local.

MyGCFlow s'affiche dans un navigateur, qui ne sait pas donner à une page le
chemin d'un dossier choisi par l'utilisateur. Le serveur tournant sur la même
machine, c'est lui qui ouvre la boîte de dialogue de Windows (IFileOpenDialog,
celle de l'Explorateur) et renvoie le chemin.

Sans dépendance : l'interface COM est appelée via ctypes. Ailleurs que sous
Windows, ou si la boîte de dialogue ne peut pas s'ouvrir, pick_folder() le
signale et l'interface propose une saisie manuelle du chemin.
"""

from __future__ import annotations

import os
import threading

PICKED = "picked"
CANCELLED = "cancelled"
UNAVAILABLE = "unavailable"
BUSY = "busy"

# Une seule boîte de dialogue à la fois : un second clic pendant qu'elle est
# ouverte en empilerait une autre derrière la fenêtre du navigateur.
_dialog_lock = threading.Lock()

_CLSID_FILE_OPEN_DIALOG = "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}"
_IID_FILE_OPEN_DIALOG = "{D57C7288-D4AD-4768-BE02-9D969532D960}"
_IID_SHELL_ITEM = "{43826D1E-E718-42EE-BC55-A1E261C37BFE}"

_CLSCTX_INPROC_SERVER = 0x1
_COINIT_APARTMENTTHREADED = 0x2
_FOS_PICKFOLDERS = 0x20
_FOS_FORCEFILESYSTEM = 0x40
_SIGDN_FILESYSPATH = 0x80058000
# HRESULT_FROM_WIN32(ERROR_CANCELLED) : boîte de dialogue fermée sans choisir.
_HRESULT_CANCELLED = 0x800704C7

# Rang des méthodes dans les tables virtuelles COM (ordre de déclaration des
# interfaces IUnknown → IModalWindow → IFileDialog, et IUnknown → IShellItem).
_RELEASE = 2
_DIALOG_SHOW = 3
_DIALOG_SET_OPTIONS = 9
_DIALOG_GET_OPTIONS = 10
_DIALOG_SET_FOLDER = 12
_DIALOG_SET_TITLE = 17
_DIALOG_GET_RESULT = 20
_ITEM_GET_DISPLAY_NAME = 5


def pick_folder(title: str = "", initial_dir: str | None = None) -> tuple[str, str | None]:
    """Ouvre le sélecteur de dossier et attend le choix de l'utilisateur.

    Renvoie (PICKED, chemin), (CANCELLED, None), (BUSY, None) si une boîte de
    dialogue est déjà ouverte, ou (UNAVAILABLE, None) si elle ne peut pas
    s'afficher sur ce système.
    """
    if os.name != "nt":
        return UNAVAILABLE, None
    if not _dialog_lock.acquire(blocking=False):
        return BUSY, None
    try:
        import ctypes

        # Relevée ici, dans le fil de la requête : la fenêtre au premier plan
        # est celle du navigateur où l'utilisateur vient de cliquer. Elle sert
        # de parente à la boîte de dialogue, qui s'ouvrirait sinon derrière.
        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        owner = user32.GetForegroundWindow()

        outcome: list = [UNAVAILABLE, None]

        def run():
            try:
                outcome[0], outcome[1] = _show_dialog(title, initial_dir, owner)
            except Exception as exc:  # COM indisponible, session sans bureau…
                print(f"[folder_picker] Boîte de dialogue indisponible : {exc}")

        # Fil dédié : COM y est initialisé puis libéré sans rien imposer au
        # fil du serveur qui traite la requête.
        worker = threading.Thread(target=run, name="folder-picker", daemon=True)
        worker.start()
        worker.join()
        return outcome[0], outcome[1]
    finally:
        _dialog_lock.release()


def _show_dialog(title, initial_dir, owner):
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    ole32.CLSIDFromString.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(GUID)]
    ole32.CLSIDFromString.restype = ctypes.HRESULT
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(GUID), ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoCreateInstance.restype = ctypes.HRESULT
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    shell32.SHCreateItemFromParsingName.argtypes = [
        ctypes.c_wchar_p, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHCreateItemFromParsingName.restype = ctypes.c_long

    def guid(text):
        value = GUID()
        ole32.CLSIDFromString(text, ctypes.byref(value))
        return value

    def method(pointer, index, restype, *argtypes):
        """Méthode COM de rang `index`, liée à l'objet `pointer`."""
        vtable = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        function = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])
        return lambda *args: function(pointer, *args)

    def release(pointer):
        if pointer:
            method(pointer, _RELEASE, wintypes.ULONG)()

    # S_OK ou S_FALSE (déjà initialisé) : dans les deux cas CoUninitialize est dû.
    initialized = ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED) >= 0
    dialog = ctypes.c_void_p()
    item = ctypes.c_void_p()
    try:
        ole32.CoCreateInstance(
            ctypes.byref(guid(_CLSID_FILE_OPEN_DIALOG)), None, _CLSCTX_INPROC_SERVER,
            ctypes.byref(guid(_IID_FILE_OPEN_DIALOG)), ctypes.byref(dialog),
        )

        options = wintypes.DWORD()
        method(dialog, _DIALOG_GET_OPTIONS, ctypes.HRESULT, ctypes.POINTER(wintypes.DWORD))(ctypes.byref(options))
        method(dialog, _DIALOG_SET_OPTIONS, ctypes.HRESULT, wintypes.DWORD)(
            options.value | _FOS_PICKFOLDERS | _FOS_FORCEFILESYSTEM
        )
        if title:
            method(dialog, _DIALOG_SET_TITLE, ctypes.HRESULT, ctypes.c_wchar_p)(title)

        # Dossier d'ouverture : facultatif, un échec laisse celui par défaut.
        if initial_dir and os.path.isdir(initial_dir):
            start = ctypes.c_void_p()
            if shell32.SHCreateItemFromParsingName(
                os.path.normpath(initial_dir), None, ctypes.byref(guid(_IID_SHELL_ITEM)), ctypes.byref(start),
            ) >= 0 and start:
                try:
                    method(dialog, _DIALOG_SET_FOLDER, ctypes.c_long, ctypes.c_void_p)(start)
                finally:
                    release(start)

        shown = method(dialog, _DIALOG_SHOW, ctypes.c_long, ctypes.c_void_p)(owner)
        if shown & 0xFFFFFFFF == _HRESULT_CANCELLED:
            return CANCELLED, None
        if shown < 0:
            raise OSError(f"IFileDialog::Show a échoué (0x{shown & 0xFFFFFFFF:08X})")

        method(dialog, _DIALOG_GET_RESULT, ctypes.HRESULT, ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(item))
        name = ctypes.c_void_p()
        method(item, _ITEM_GET_DISPLAY_NAME, ctypes.HRESULT, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))(
            _SIGDN_FILESYSPATH, ctypes.byref(name),
        )
        try:
            path = ctypes.wstring_at(name.value)
        finally:
            ole32.CoTaskMemFree(name)
        return PICKED, path
    finally:
        release(item)
        release(dialog)
        if initialized:
            ole32.CoUninitialize()
