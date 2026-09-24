"""MyGCFlow tourne en local : l'interface doit se charger sans connexion.

Ces tests verrouillent le fait que les templates ne tirent aucune feuille de
style ni aucun script depuis un CDN (cf. static/vendor/README.md), et que les
fichiers vendorés référencés existent réellement sur le disque — y compris les
ressources annexes (polices) référencées depuis les CSS.
"""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
VENDOR = ROOT / "static" / "vendor"

# <script src="..."> et <link rel="stylesheet" href="..."> : les seules balises
# qui chargent du code/du style. Les <a href="https://..."> du guide sont des
# liens que l'utilisateur clique, ils n'ont pas à être vendorés.
SCRIPT_SRC = re.compile(r"<script\b[^>]*\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE)
STYLESHEET_HREF = re.compile(
    r"<link\b(?=[^>]*\brel=[\"']stylesheet[\"'])[^>]*\bhref=[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)
# url(...) dans une CSS, hors data: URI.
CSS_URL = re.compile(r"url\(\s*[\"']?(?!data:)([^\"')]+)[\"']?\s*\)", re.IGNORECASE)

# Templates réellement rendus par une route (blueprints/core.py) et leurs
# includes. templates/test.html n'est rendu par aucune route.
RENDERED_TEMPLATES = sorted(
    p for p in TEMPLATES.glob("*.html") if p.name != "test.html"
)


def _local_asset_path(url):
    """Chemin disque d'une URL d'asset locale, ou None si ce n'est pas un asset local."""
    path = url.split("?", 1)[0].split("#", 1)[0]
    if not path or path.startswith(("http://", "https://", "//", "data:")):
        return None
    marker = "static/"
    index = path.find(marker)
    if index == -1:
        return None
    return ROOT / "static" / path[index + len(marker):]


class OfflineAssetsTests(unittest.TestCase):
    def test_no_template_loads_css_or_js_from_a_cdn(self):
        for template in RENDERED_TEMPLATES:
            content = template.read_text(encoding="utf-8")
            urls = SCRIPT_SRC.findall(content) + STYLESHEET_HREF.findall(content)
            for url in urls:
                self.assertFalse(
                    url.startswith(("http://", "https://", "//")),
                    f"{template.name} charge {url} depuis un hôte externe : "
                    "vendorer la bibliothèque dans static/vendor/ "
                    "(voir static/vendor/README.md)",
                )

    def test_assets_referenced_by_templates_exist(self):
        for template in RENDERED_TEMPLATES:
            content = template.read_text(encoding="utf-8")
            urls = SCRIPT_SRC.findall(content) + STYLESHEET_HREF.findall(content)
            for url in urls:
                asset = _local_asset_path(url)
                if asset is None:
                    continue
                self.assertTrue(
                    asset.is_file(),
                    f"{template.name} référence {url}, absent du disque ({asset})",
                )

    def test_vendored_css_resources_are_vendored_too(self):
        """Une CSS vendorée ne doit pas pointer sur un fichier manquant (polices)."""
        stylesheets = sorted(VENDOR.rglob("*.css"))
        self.assertTrue(stylesheets, "aucune CSS trouvée dans static/vendor/")

        for stylesheet in stylesheets:
            content = stylesheet.read_text(encoding="utf-8")
            for url in CSS_URL.findall(content):
                self.assertFalse(
                    url.startswith(("http://", "https://", "//")),
                    f"{stylesheet.name} charge {url} depuis un hôte externe",
                )
                resource = stylesheet.parent / url.split("?", 1)[0].split("#", 1)[0]
                self.assertTrue(
                    resource.is_file(),
                    f"{stylesheet.name} référence {url}, absent du disque ({resource})",
                )


if __name__ == "__main__":
    unittest.main()
