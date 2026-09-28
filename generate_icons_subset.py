#!/usr/bin/env python3
"""Génère un sous-ensemble de la fonte Tabler Icons limité aux icônes utilisées.

static/vendor/tabler-icons/ embarque la fonte complète (woff2 ~830 Ko,
css ~250 Ko, ~5 500 icônes) alors que l'application n'en utilise qu'une
centaine. Ce script produit, sans modifier les fichiers vendor d'origine :

  - static/vendor/tabler-icons/fonts/tabler-icons-subset.woff2
  - static/vendor/tabler-icons/tabler-icons-subset.css

Les templates référencent tabler-icons-subset.css. Pour revenir à la fonte
complète, repointer les <link> vers tabler-icons.min.css.

Usage : .venv/Scripts/python.exe generate_icons_subset.py

À relancer après toute mise à jour de @tabler/icons-webfont ou ajout d'une
classe `ti-*` dans templates/, static/js/ ou static/css/. Les icônes listées
dans ICON_MAP (ui_bootstrap.js) sont incluses même si aucune n'est utilisée
aujourd'hui : elles servent au mapping Material → Tabler.

Nécessite fontTools[woff] (brotli/zopfli pour la sortie woff2) — voir
requirements-build.txt.
"""

import re
import sys
from pathlib import Path

from fontTools import subset

ROOT = Path(__file__).resolve().parent
VENDOR_DIR = ROOT / 'static' / 'vendor' / 'tabler-icons'
CSS_IN = VENDOR_DIR / 'tabler-icons.min.css'
FONT_IN = VENDOR_DIR / 'fonts' / 'tabler-icons.woff2'
CSS_OUT = VENDOR_DIR / 'tabler-icons-subset.css'
FONT_OUT = VENDOR_DIR / 'fonts' / 'tabler-icons-subset.woff2'

SCAN_PATTERNS = [
    (ROOT / 'templates', '**/*.html'),
    (ROOT / 'static' / 'js', '**/*.js'),
    (ROOT / 'static' / 'css', '**/*.css'),
]
VENDOR_PARTS = ('vendor', 'node_modules')

ICON_CLASS_RE = re.compile(r'(?<![\w-])ti-([a-z0-9][a-z0-9-]*)')
CSS_ENTRY_RE = re.compile(r'\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-fA-F]+)"\}')


def iter_source_files():
    for base, pattern in SCAN_PATTERNS:
        for path in sorted(base.rglob(pattern.split('/')[-1])):
            if any(part in VENDOR_PARTS for part in path.parts):
                continue
            yield path


def collect_icon_names():
    """Noms d'icônes utilisés : classes ti-* dans les sources + valeurs ICON_MAP."""
    names = set()
    for path in iter_source_files():
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        names.update(ICON_CLASS_RE.findall(text))

    # ICON_MAP de ui_bootstrap.js : les valeurs sont des noms Tabler nus
    # (sans préfixe ti-) utilisables dynamiquement via materialToTabler().
    bootstrap_js = ROOT / 'static' / 'js' / 'ui_bootstrap.js'
    text = bootstrap_js.read_text(encoding='utf-8', errors='replace')
    match = re.search(r'ICON_MAP\s*=\s*\{(.*?)\};', text, re.DOTALL)
    if match:
        names.update(re.findall(r"'[^']*':\s*'([a-z0-9-]+)'", match.group(1)))
    else:
        print('AVERTISSEMENT : ICON_MAP introuvable dans ui_bootstrap.js', file=sys.stderr)

    return names


def parse_icon_css(css_text):
    """Retourne {nom: codepoint_hex} depuis tabler-icons.min.css."""
    return {name: code for name, code in CSS_ENTRY_RE.findall(css_text)}


def main():
    css_text = CSS_IN.read_text(encoding='utf-8')
    all_icons = parse_icon_css(css_text)
    used = collect_icon_names()

    unknown = sorted(n for n in used if n not in all_icons)
    if unknown:
        print('Classes ti-* introuvables dans la fonte (faux positifs ou coquilles) :')
        for n in unknown:
            print(f'  - ti-{n}')

    selected = {name: all_icons[name] for name in sorted(used) if name in all_icons}
    print(f'{len(selected)} icônes retenues sur {len(all_icons)} disponibles.')

    # --- Fonte : sous-ensemble woff2 ---
    codepoints = [int(cp, 16) for cp in selected.values()]
    options = subset.Options()
    options.flavor = 'woff2'
    options.notdef_outline = True
    options.name_IDs = ['*']  # conserve copyright/licence dans la fonte
    font = subset.load_font(str(FONT_IN), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    subset.save_font(font, str(FONT_OUT), options)

    # --- CSS : @font-face (woff2 seul : tous les navigateurs récents), base .ti,
    # puis une règle par icône utilisée ---
    lines = [
        '/*',
        ' * Tabler Icons — sous-ensemble généré par generate_icons_subset.py.',
        ' * Ne pas éditer à la main. Source : tabler-icons.min.css (3.34.1).',
        ' */',
        '@font-face {',
        '    font-family: "tabler-icons";',
        '    font-style: normal;',
        '    font-weight: 400;',
        '    src: url("./fonts/tabler-icons-subset.woff2") format("woff2");',
        '}',
        '.ti {',
        '    font-family: "tabler-icons" !important;',
        '    speak: none;',
        '    font-style: normal;',
        '    font-weight: normal;',
        '    font-variant: normal;',
        '    text-transform: none;',
        '    line-height: 1;',
        '    -webkit-font-smoothing: antialiased;',
        '    -moz-osx-font-smoothing: grayscale;',
        '}',
    ]
    for name, code in selected.items():
        lines.append(f'.ti-{name}:before {{ content: "\\{code}"; }}')
    lines.append('')
    CSS_OUT.write_text('\n'.join(lines), encoding='utf-8')

    for path in (FONT_IN, FONT_OUT, CSS_IN, CSS_OUT):
        print(f'{path.name:38} {path.stat().st_size:>9} octets')


if __name__ == '__main__':
    main()
