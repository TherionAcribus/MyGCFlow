#!/usr/bin/env python3
"""Remplace les <i class="material-icons">X</i> par <i class="ti ti-Y"></i>
dans guide.html en utilisant le mapping Material → Tabler."""
import re
from pathlib import Path

# Mapping Material Icons → Tabler Icons (complété pour le guide)
ICON_MAP = {
    'menu': 'menu-2',
    'map': 'map',
    'arrow_back': 'arrow-left',
    'rocket_launch': 'rocket',
    'info': 'info-circle',
    'storage': 'database',
    'lightbulb': 'bulb',
    'cloud_upload': 'cloud-upload',
    'delete': 'trash',
    'palette': 'color-swatch',
    'touch_app': 'hand-click',
    'add': 'plus',
    'save': 'device-floppy',
    'file_upload': 'file-upload',
    'movie': 'movie',
    'timer': 'clock',
    'play_arrow': 'player-play',
    'videocam': 'video',
    'pause': 'player-pause',
    'stop': 'player-stop',
    'folder_open': 'folder-open',
    'delete_sweep': 'trash-x',
    'settings': 'settings',
    'my_location': 'current-location',
    'place': 'map-pin',
    'help_outline': 'help',
    'check_circle': 'circle-check',
}

def replace_icon(match):
    """Remplace <i class="material-icons" ...>NAME</i> par <i class="ti ti-TABLER" ...></i>"""
    full = match.group(0)
    prefix = match.group(1)  # <i class="material-icons" ...>
    name = match.group(2).strip()
    suffix = match.group(3)  # </i>
    tabler_name = ICON_MAP.get(name, name)
    # Préserver les attributs style s'ils existent
    return f'{prefix[:-1]} class="ti ti-{tabler_name}">{suffix}'

# Pattern : <i class="material-icons"[attrs]>NAME</i>
pattern = re.compile(
    r'(<i\s+class="material-icons"[^>]*>)([a-z_]+)(</i>)',
    re.IGNORECASE
)

guide_path = Path(r'C:/Users/fabie/Documents/Projets/GCMap/templates/guide.html')
content = guide_path.read_text(encoding='utf-8')

def replacer(match):
    full = match.group(0)
    attrs = match.group(1)  # <i class="material-icons" ...>
    name = match.group(2).strip()
    close = match.group(3)  # </i>
    tabler_name = ICON_MAP.get(name, name)
    # Extraire les attributs autres que class
    # attrs = '<i class="material-icons" style="...">'
    other_attrs = re.sub(r'class="material-icons"\s*', '', attrs[3:])  # retire '<i ' et class
    other_attrs = other_attrs.strip()
    if other_attrs:
        return f'<i class="ti ti-{tabler_name}" {other_attrs}></i>'
    return f'<i class="ti ti-{tabler_name}"></i>'

new_content = pattern.sub(replacer, content)

# Vérifier les remplacements
count = len(pattern.findall(content))
print(f"Remplacements effectués : {count}")

# Vérifier qu'il ne reste plus de material-icons
remaining = re.findall(r'class="material-icons"', new_content)
print(f"Occurrences restantes de material-icons : {len(remaining)}")

guide_path.write_text(new_content, encoding='utf-8')
print(f"Fichier écrit : {guide_path}")
