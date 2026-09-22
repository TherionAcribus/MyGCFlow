"""Copie les licences des paquets Python installés dans le dossier de l'exécutable.

    python installer/collect_licenses.py dist/GCMap/licenses/python

À lancer avec l'interpréteur de l'environnement de construction : ce sont ses
paquets que PyInstaller a embarqués. Les outils de construction eux-mêmes
(PyInstaller et ses dépendances) ne sont pas redistribués et sont ignorés.
"""

import re
import shutil
import sys
from importlib import metadata
from pathlib import Path

BUILD_ONLY = {"pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "pefile",
              "pywin32-ctypes", "setuptools", "pip"}
LICENSE_FILE = re.compile(r"(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", re.IGNORECASE)


def main(target: Path) -> int:
    target.mkdir(parents=True, exist_ok=True)
    summary = []
    for dist in sorted(metadata.distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        if name.lower() in BUILD_ONLY:
            continue
        declared = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        declared = declared.splitlines()[0][:80] if declared else "voir fichiers"
        summary.append(f"{name} {dist.version} — {declared}")
        copied = 0
        for file in dist.files or []:
            if LICENSE_FILE.search(Path(file).name) and ".dist-info" in str(file):
                source = Path(dist.locate_file(file))
                if source.is_file():
                    folder = target / f"{name}-{dist.version}"
                    folder.mkdir(exist_ok=True)
                    shutil.copy2(source, folder / source.name)
                    copied += 1
        if not copied:
            summary[-1] += " (aucun fichier de licence fourni par le paquet)"
    (target / "PACKAGES.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"{len(summary)} paquets recensés dans {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
