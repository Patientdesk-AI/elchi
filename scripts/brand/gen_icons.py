#!/usr/bin/env python3
"""Generate Eshlik's icon artwork (app icon master + tray glyphs) as SVG.

The motif is the eight-point star of Turkish tile work (Akdeniz / Çini): a
16-point star in a 100-unit box with a round eye.

Usage: python3 scripts/brand/gen_icons.py <out_dir>
Writes elchi.svg (app icon master) and the tray_*.svg glyphs into out_dir.
Render with rsvg-convert, e.g. `rsvg-convert -w 1024 elchi.svg -o icon.png`,
then `bunx tauri icon icon.png` for every platform size.
"""
import sys
from pathlib import Path

TEAL = "#0b6e79"
TURQUOISE = "#3fb8c0"
CORAL = "#f0654a"

# The star in a 100-unit box centred on (50, 50).
STAR = [
    (50, 4), (61, 27), (86, 18), (77, 43), (96, 50), (77, 57), (86, 82), (61, 73),
    (50, 96), (39, 73), (14, 82), (23, 57), (4, 50), (23, 43), (14, 18), (39, 27),
]


def star_path(cx, cy, size):
    """The star scaled to `size` px across, centred on (cx, cy)."""
    s = size / 100
    pts = " ".join(f"{cx + (x - 50) * s:.2f},{cy + (y - 50) * s:.2f}" for x, y in STAR)
    return f"M{pts}Z"


def circle_path(cx, cy, r):
    """A circle as a path, so it can punch a hole with fill-rule evenodd."""
    return f"M{cx - r:.2f},{cy:.2f}a{r:.2f},{r:.2f} 0 1,0 {2 * r:.2f},0a{r:.2f},{r:.2f} 0 1,0 {-2 * r:.2f},0Z"


def app_icon():
    """Teal rounded square, a faint tile pattern, the coral star with a teal eye."""
    tile = []
    for row in range(-1, 10):
        for col in range(-1, 10):
            cx, cy = 100 + col * 112 + (56 if row % 2 else 0), 100 + row * 112
            tile.append(f'<path d="{star_path(cx, cy, 72)}"/>')
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>Eshlik</title>
  <defs><clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath></defs>
  <g clip-path="url(#sq)">
    <rect x="100" y="100" width="824" height="824" fill="{TEAL}"/>
    <g fill="none" stroke="{TURQUOISE}" stroke-width="3" opacity="0.28">
    {"".join(tile)}
    </g>
  </g>
  <path d="{star_path(512, 512, 560)}" fill="{CORAL}"/>
  <circle cx="512" cy="512" r="78" fill="{TEAL}"/>
</svg>
"""


def tray_svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">{body}</svg>'


def tray_idle(color):
    # The star with its eye punched out, so it reads at 16-22 px.
    return tray_svg(
        f'<path fill="{color}" fill-rule="evenodd" d="{star_path(32, 32, 60)}{circle_path(32, 32, 8)}"/>'
    )


def tray_recording(color):
    # A solid disc with the star cut out of it.
    return tray_svg(
        f'<path fill="{color}" fill-rule="evenodd" d="{circle_path(32, 32, 30)}{star_path(32, 32, 44)}"/>'
    )


def tray_transcribing(color):
    # A solid disc with three dots cut out: working.
    holes = "".join(circle_path(32 + dx, 32, 4.5) for dx in (-12, 0, 12))
    return tray_svg(f'<path fill="{color}" fill-rule="evenodd" d="{circle_path(32, 32, 30)}{holes}"/>')


def tray_warning(color):
    # The idle star with a "!" badge in the corner (the "!" cut out).
    bang = "M48,6h4v10h-4Z" + circle_path(50, 21, 2.4)
    return tray_svg(
        f'<path fill="{color}" fill-rule="evenodd" d="{star_path(28, 34, 52)}{circle_path(28, 34, 7)}"/>'
        f'<path fill="{color}" fill-rule="evenodd" d="{circle_path(50, 14, 13)}{bang}"/>'
    )


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    (out / "elchi.svg").write_text(app_icon())
    glyphs = {
        # Template images (macOS) and the light/dark trays elsewhere.
        "tray_idle": (tray_idle, "#ffffff"),
        "tray_idle_dark": (tray_idle, "#000000"),
        "tray_recording": (tray_recording, "#ffffff"),
        "tray_recording_dark": (tray_recording, "#000000"),
        "tray_transcribing": (tray_transcribing, "#ffffff"),
        "tray_transcribing_dark": (tray_transcribing, "#000000"),
        "tray_idle_warning": (tray_warning, "#ffffff"),
        "tray_idle_warning_dark": (tray_warning, "#000000"),
        # "Colored" theme (Linux trays, no template images): turquoise.
        "handy": (tray_idle, TURQUOISE),
        "handy_warning": (tray_warning, TURQUOISE),
        "recording": (tray_recording, CORAL),
        "transcribing": (tray_transcribing, TURQUOISE),
    }
    for name, (fn, color) in glyphs.items():
        (out / f"{name}.svg").write_text(fn(color))


if __name__ == "__main__":
    main()
