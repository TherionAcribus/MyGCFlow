"""Génère l'icône provisoire de MyGCFlow (exécutable, installeur, zone de notification).

    python installer/make_icon.py

Produit installer/mygcflow.ico (multi-résolutions) et static/img/mygcflow-icon.png.
À remplacer par un vrai logo : il suffit d'écraser ces deux fichiers.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SIZE = 256
GREEN = (46, 125, 50, 255)
WHITE = (255, 255, 255, 255)


def draw_icon(size: int = SIZE) -> Image.Image:
    scale = 4  # sur-échantillonnage pour des bords lisses
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 5, fill=GREEN)
    # Repère de carte : disque + pointe, trou central.
    cx, cy, r = s / 2, s * 0.40, s * 0.24
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=WHITE)
    d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, s * 0.86)], fill=WHITE)
    hole = r * 0.42
    d.ellipse((cx - hole, cy - hole, cx + hole, cy + hole), fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    icon = draw_icon()
    icon.save(ROOT / "static" / "img" / "mygcflow-icon.png")
    icon.save(ROOT / "installer" / "mygcflow.ico",
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Icônes générées.")
