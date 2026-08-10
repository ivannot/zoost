#!/usr/bin/env python3
"""Render the website's screenshots from the sample org: python3 tools/siteimg.py

The site explains Zoost in words and explains it well, and most readers do not read - they look at a
picture and decide in two seconds whether a feature is for them. This produces those pictures from
the same generator the Store screenshots come from, so what a reader sees on zoost.it is the product
and not a mock-up, and a control that does not exist cannot appear in one.

Two differences from `tools/shots.py`, and both are about where the image ends up:

  - **rendered at 2x** (2560x1600 for the same 1280x800 layout), because a screenshot displayed at
    880 CSS px on a retina laptop is judged on its sharpness before it is judged on its content;
  - **encoded as WebP at 1760 wide**, which is 2x the widest the content column ever gets. Measured
    on the busiest shot: 115 KB as the 1x PNG, 284 KB as a 1760 PNG, **and 45-60 KB as WebP**. The
    format is doing the work here, not the resizing.

`cwebp` and `sips` are both required. That is one more binary than this repository likes, and it is
accepted for the same reason Chrome is: this runs when somebody publishes images, not when somebody
builds the extension, and nothing under `apps/` gains a dependency.
"""
import pathlib
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shots  # noqa: E402  - the renderers, the fixture wiring and the click scripts all live there

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "img"
WIDTH = 1760      # 2x the 880px the content column reaches at its widest
QUALITY = 80


def need(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        sys.exit(f"{binary} is not installed - it is what turns the render into something worth serving")
    return path


def main() -> int:
    cwebp, sips = need("cwebp"), need("sips")
    shots.SCALE = 2                       # a retina source; see the module docstring
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    print(f"{'image':22} {'rendered':>13} {'published':>10}")
    every = shots.SHOTS + shots.PANELS
    for shot in every:
        key = shot[0]
        png = (shots.render_panel if shot in shots.PANELS else shots.render)(shot)
        raw = png.stat().st_size
        tmp = png.with_name(key + "-scaled.png")
        subprocess.run([sips, "-Z", str(WIDTH), str(png), "--out", str(tmp)],
                       check=True, capture_output=True)
        dest = OUT / (key + ".webp")
        subprocess.run([cwebp, "-q", str(QUALITY), "-quiet", str(tmp), "-o", str(dest)], check=True)
        tmp.unlink()
        total += dest.stat().st_size
        print(f"  {key:20} {raw // 1024:>8} KB {dest.stat().st_size // 1024:>8} KB")
    print(f"\n  {len(every)} image(s), {total // 1024} KB published under site/img/")
    print("  They are lazy-loaded and carry their own width and height, so nothing below them moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
