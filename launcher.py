"""Point d'entrée de l'application installée (MyGCFlow.exe).

    python launcher.py [--no-browser] [--no-tray] [--port N]

- démarre le serveur (waitress) sur 127.0.0.1 uniquement ;
- ouvre MyGCFlow dans le navigateur par défaut ;
- place une icône dans la zone de notification (Ouvrir, dossiers, Quitter) ;
  Windows 11 la range par défaut dans le débordement masqué, et une
  application ne peut pas se rendre visible elle-même : l'arrêt passe donc
  aussi par le bouton « Quitter » de l'interface (POST /api/quit), qui reste
  disponible même si l'icône n'a pas pu être créée ;
- instance unique : relancer MyGCFlow rouvre simplement l'onglet.

`python app.py` reste le serveur de développement (rechargement, débogueur).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import threading
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler

import paths
from version import __version__

HOST = "127.0.0.1"
# Port fixe plutôt qu'aléatoire : le navigateur range le localStorage (thème,
# réglages d'interface…) par origine, donc par port. Un port qui changerait à
# chaque lancement ferait perdre ces préférences. Les ports suivants ne servent
# que si celui-ci est déjà pris par un autre programme.
PREFERRED_PORT = 51730
PORT_ATTEMPTS = 10
# Vidéos MediaRecorder brutes : plusieurs Go possibles (défaut waitress : 1 Go).
MAX_REQUEST_BODY = 16 * 1024 ** 3

logger = logging.getLogger("mygcflow.launcher")

_LABELS = {
    "fr": {
        "open": "Ouvrir MyGCFlow",
        "videos": "Dossier des vidéos",
        "logs": "Journaux",
        "quit": "Quitter",
        "busy_title": "MyGCFlow",
        "busy": "Un import ou un traitement vidéo est en cours.\n"
                "Il sera interrompu si vous quittez maintenant.\n\nQuitter quand même ?",
        "no_port": "Impossible de démarrer MyGCFlow : aucun port libre entre {first} et {last}.",
        "crash": "MyGCFlow n'a pas pu démarrer :\n{error}\n\nDétails dans le journal :\n{log}",
    },
    "en": {
        "open": "Open MyGCFlow",
        "videos": "Videos folder",
        "logs": "Logs",
        "quit": "Quit",
        "busy_title": "MyGCFlow",
        "busy": "An import or a video processing task is running.\n"
                "It will be interrupted if you quit now.\n\nQuit anyway?",
        "no_port": "MyGCFlow cannot start: no free port between {first} and {last}.",
        "crash": "MyGCFlow could not start:\n{error}\n\nDetails in the log file:\n{log}",
    },
}


# --------------------------------------------------------------------------
# Journalisation
# --------------------------------------------------------------------------

class _LogWriter:
    """Remplace stdout/stderr absents (exécutable sans console) par le journal.

    Sans console, sys.stdout vaut None : les print() du code serveur seraient
    perdus, et une écriture directe sur sys.stderr lèverait une exception.
    """

    def __init__(self, log, level):
        self._log = log
        self._level = level

    def write(self, message):
        for line in str(message).rstrip().splitlines():
            if line.strip():
                self._log.log(self._level, line)
        return len(message)

    def flush(self):
        pass

    def isatty(self):
        return False


def log_file_path():
    return paths.logs_dir() / "mygcflow.log"


def setup_logging():
    paths.ensure_dir(paths.logs_dir())
    handler = RotatingFileHandler(log_file_path(), maxBytes=2 * 1024 ** 2, backupCount=3, encoding="utf-8")
    handlers = [handler]
    if sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        handlers=handlers,
        force=True,
    )
    if sys.stdout is None:
        sys.stdout = _LogWriter(logging.getLogger("stdout"), logging.INFO)
    if sys.stderr is None:
        sys.stderr = _LogWriter(logging.getLogger("stderr"), logging.WARNING)


# --------------------------------------------------------------------------
# Instance unique et choix du port
# --------------------------------------------------------------------------

def _url(port):
    return f"http://{HOST}:{port}/"


def is_mygcflow(port, timeout=1.0):
    """Vrai si une instance de MyGCFlow répond sur ce port."""
    try:
        with urllib.request.urlopen(_url(port) + "api/ping", timeout=timeout) as response:
            return json.load(response).get("app") == "MyGCFlow"
    except Exception:
        return False


def is_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((HOST, port))
            return True
        except OSError:
            return False


def find_port(preferred=PREFERRED_PORT, attempts=PORT_ATTEMPTS):
    """(port, déjà_lancé). Cherche d'abord une instance existante sur toute la
    plage — un port libéré entre-temps ne doit pas faire démarrer un doublon —
    puis le premier port libre. (None, False) si rien n'est disponible."""
    candidates = range(preferred, preferred + attempts)
    # On ne sonde que les ports occupés : sous Windows, une connexion vers un
    # port fermé de 127.0.0.1 n'est pas refusée immédiatement (~1 s chacune).
    free = [port for port in candidates if is_port_free(port)]
    for port in candidates:
        if port not in free and is_mygcflow(port):
            return port, True
    return (free[0], False) if free else (None, False)


# --------------------------------------------------------------------------
# Interface système
# --------------------------------------------------------------------------

def _language():
    try:
        from settings_manager import get_settings_manager
        lang = (get_settings_manager().get_app_settings().language or "fr")[:2]
    except Exception:
        lang = "fr"
    return lang if lang in _LABELS else "fr"


def _message_box(text, title="MyGCFlow", question=False):
    """Boîte de dialogue native (Windows). Renvoie True pour « Oui » / OK."""
    if os.name == "nt":
        import ctypes
        MB_YESNO, MB_ICONWARNING, MB_ICONERROR, MB_TOPMOST = 0x4, 0x30, 0x10, 0x40000
        flags = (MB_YESNO | MB_ICONWARNING if question else MB_ICONERROR) | MB_TOPMOST
        IDYES, IDOK = 6, 1
        return ctypes.windll.user32.MessageBoxW(None, text, title, flags) in (IDYES, IDOK)
    print(text, file=sys.stderr)
    return not question


def _open_folder(path):
    paths.ensure_dir(path)
    try:
        if os.name == "nt":
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            import subprocess
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
    except Exception:
        logger.exception("Ouverture du dossier impossible : %s", path)


def open_browser(port):
    webbrowser.open(_url(port), new=2)


# --------------------------------------------------------------------------
# Serveur
# --------------------------------------------------------------------------

def create_server(port):
    from waitress import create_server as waitress_server

    from app import app

    return waitress_server(
        app, host=HOST, port=port, threads=8,
        max_request_body_size=MAX_REQUEST_BODY,
        ident="MyGCFlow",
    )


# Icône de la zone de notification, une fois créée. Un arrêt demandé depuis
# l'interface doit la retirer lui aussi, sinon Windows en laisse le fantôme
# jusqu'au prochain survol de la souris.
_tray_icon = None

# `server.close()` débloque le `server.run()` du fil principal, qui enchaîne
# alors sur son propre `_shutdown` : sans ce verrou, la séquence d'arrêt se
# déroulait deux fois de front (ffmpeg tué deux fois, deux `logging.shutdown()`
# concurrents, course sur `os._exit`).
_shutdown_lock = threading.Lock()
_shutting_down = False


def _shutdown(server):
    """Arrête tout, y compris un encodage en cours, puis termine le processus.

    os._exit plutôt qu'un retour normal : les tâches de fond (import GPX,
    encodage) tournent dans un pool de threads que l'interpréteur attendrait
    à la sortie.

    Appelable depuis n'importe quel fil : le premier arrivé fait le travail,
    les suivants repartent aussitôt.
    """
    global _shutting_down
    with _shutdown_lock:
        if _shutting_down:
            return
        _shutting_down = True

    logger.info("Arrêt de MyGCFlow")
    try:
        from capture import kill_running_ffmpeg
        kill_running_ffmpeg()
    except Exception:
        logger.exception("Arrêt des processus ffmpeg")
    if _tray_icon is not None:
        try:
            _tray_icon.stop()
        except Exception:
            logger.exception("Retrait de l'icône de notification")
    try:
        server.close()
    except Exception:
        pass
    logging.shutdown()
    os._exit(0)


def _register_quit_hook(server):
    """Permet à l'interface web d'arrêter l'application (POST /api/quit).

    L'arrêt est différé de quelques centaines de millisecondes : `_shutdown`
    termine le processus sur-le-champ, et la réponse HTTP doit d'abord partir,
    sinon le navigateur n'affiche qu'une erreur réseau au lieu de la
    confirmation.
    """
    from app import app

    def request_shutdown():
        threading.Timer(0.5, _shutdown, args=(server,)).start()

    app.config['QUIT_HOOK'] = request_shutdown


def run_tray(server, port, labels):
    global _tray_icon

    import pystray
    from PIL import Image

    from task_manager import task_manager

    def on_quit(icon, _item):
        if task_manager.active_tasks() and not _message_box(labels["busy"], labels["busy_title"], question=True):
            return
        icon.stop()
        _shutdown(server)

    image = Image.open(paths.resource_dir() / "static" / "img" / "mygcflow-icon.png")
    menu = pystray.Menu(
        pystray.MenuItem(labels["open"], lambda: open_browser(port), default=True),
        pystray.MenuItem(labels["videos"], lambda: _open_folder(paths.video_dir())),
        pystray.MenuItem(labels["logs"], lambda: _open_folder(paths.logs_dir())),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(labels["quit"], on_quit),
    )
    _tray_icon = pystray.Icon("MyGCFlow", image, f"MyGCFlow {__version__}", menu)
    _tray_icon.run()


def main(argv=None):
    parser = argparse.ArgumentParser(description="MyGCFlow")
    parser.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur")
    parser.add_argument("--no-tray", action="store_true", help="pas d'icône de notification (Ctrl+C pour quitter)")
    parser.add_argument("--port", type=int, default=PREFERRED_PORT, help="port préféré")
    args = parser.parse_args(argv)

    setup_logging()
    logger.info("MyGCFlow %s — données : %s", __version__, paths.data_dir())
    labels = _LABELS[_language()]

    try:
        port, running = find_port(args.port)
        if running:
            logger.info("MyGCFlow tourne déjà sur le port %s : ouverture de l'onglet", port)
            if not args.no_browser:
                open_browser(port)
            return 0
        if port is None:
            _message_box(labels["no_port"].format(first=args.port, last=args.port + PORT_ATTEMPTS - 1))
            return 1

        server = create_server(port)
        _register_quit_hook(server)
    except Exception as exc:
        logger.exception("Échec du démarrage")
        _message_box(labels["crash"].format(error=exc, log=log_file_path()))
        return 1

    logger.info("Serveur prêt : %s", _url(port))
    if not args.no_browser:
        open_browser(port)

    if args.no_tray:
        try:
            server.run()
        except KeyboardInterrupt:
            pass
        _shutdown(server)

    threading.Thread(target=server.run, name="waitress", daemon=True).start()
    try:
        run_tray(server, port, labels)
    except Exception:
        # Pas de zone de notification disponible (session sans bureau…) : le
        # serveur continue. L'exécutable étant construit sans console, il n'y a
        # ici ni Ctrl+C ni fenêtre — l'arrêt passe forcément par le bouton
        # « Quitter » de l'interface (POST /api/quit).
        logger.exception("Icône de notification indisponible — arrêt depuis l'interface uniquement")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
    _shutdown(server)
    return 0


if __name__ == "__main__":
    sys.exit(main())
