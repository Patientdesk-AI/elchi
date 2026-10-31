"""Render the DMG window's background (scripts/brand/dmg_background.html).

    uv run --with playwright python scripts/brand/gen_dmg_background.py

Writes scripts/release/dmg/background.tiff: the 660x420 picture at 1x and 2x in one
file, which Finder shows at the right density. Needs Google Chrome (Playwright drives
the installed one) and macOS's tiffutil. The page's Outfit and Karla fonts load from
node_modules/@fontsource-variable/{outfit,karla}, which the app no longer depends on:
unpack them there first (`npm pack`), or the text renders in fallback fonts.
"""

import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "scripts/brand/dmg_background.html"
OUT = ROOT / "scripts/release/dmg/background.tiff"
W, H = 660, 420


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        shots = []
        for scale in (1, 2):
            page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=scale)
            page.goto(PAGE.as_uri())
            page.evaluate("document.fonts.ready")
            shot = Path(tmp) / f"bg@{scale}x.png"
            page.screenshot(path=str(shot))
            shots.append(shot)
        browser.close()
        subprocess.run(["tiffutil", "-cathidpicheck", *map(str, shots), "-out", str(OUT)], check=True)
        for shot in shots:
            (OUT.parent / shot.name).write_bytes(shot.read_bytes())   # previews, not shipped
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
