"""Generate the PWA icon set into ../frontend/icons.

    .venv\\Scripts\\python -m app.tools.gen_icons

Draws the Kodi mark (a house with a keyhole door) with Pillow, supersampled
for smooth edges. Produces: any-purpose icons with rounded corners, a
full-bleed maskable icon (logo inside the 80% safe zone), the iOS
apple-touch-icon (opaque), a monochrome notification badge and favicons.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[3] / "frontend" / "icons"
TOP = (13, 110, 253)       # #0d6efd
BOTTOM = (8, 66, 152)      # #084298
WHITE = (255, 255, 255, 255)
SS = 4                     # supersampling factor


def _gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        draw.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    return img


def _mark(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float, color, hole) -> None:
    """House + keyhole centred on (cx, cy); `scale` is the mark's width."""
    w = scale
    roof_top = cy - 0.50 * w
    eave = cy - 0.08 * w
    base = cy + 0.42 * w
    half = 0.5 * w
    body = 0.36 * w
    draw.polygon([(cx, roof_top), (cx + half, eave), (cx + body, eave), (cx + body, base),
                  (cx - body, base), (cx - body, eave), (cx - half, eave)], fill=color)
    # chimney
    draw.rectangle([cx + 0.20 * w, cy - 0.40 * w, cx + 0.30 * w, cy - 0.22 * w], fill=color)
    # keyhole door
    r = 0.09 * w
    kcy = cy + 0.08 * w
    draw.ellipse([cx - r, kcy - r, cx + r, kcy + r], fill=hole)
    draw.polygon([(cx - 0.05 * w, kcy), (cx + 0.05 * w, kcy), (cx + 0.09 * w, base - 0.06 * w),
                  (cx - 0.09 * w, base - 0.06 * w)], fill=hole)


def _rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def make_icon(size: int, *, maskable: bool = False, opaque: bool = False) -> Image.Image:
    big = size * SS
    img = _gradient(big)
    draw = ImageDraw.Draw(img)
    mark_width = big * (0.50 if maskable else 0.62)
    _mark(draw, big / 2, big / 2 + big * 0.02, mark_width, WHITE, TOP + (255,))
    if not (maskable or opaque):
        img.putalpha(_rounded_mask(big, big * 0.22))
    img = img.resize((size, size), Image.LANCZOS)
    return img.convert("RGB") if opaque else img


def make_badge(size: int) -> Image.Image:
    """Android status-bar badge: white silhouette on transparent."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    _mark(ImageDraw.Draw(img), big / 2, big / 2 + big * 0.02, big * 0.86, WHITE, (0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        make_icon(size).save(OUT / f"icon-{size}.png", optimize=True)
    make_icon(512, maskable=True).save(OUT / "maskable-512.png", optimize=True)
    make_icon(192, maskable=True).save(OUT / "maskable-192.png", optimize=True)
    make_icon(180, opaque=True).save(OUT / "apple-touch-icon.png", optimize=True)
    make_badge(96).save(OUT / "badge-96.png", optimize=True)
    make_icon(32).save(OUT / "favicon-32.png", optimize=True)
    make_icon(48).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"Icons written to {OUT}")


if __name__ == "__main__":
    main()
