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
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shots  # noqa: E402  - the renderers, the fixture wiring and the click scripts all live there

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "img"
LEDGER = ROOT / "tools" / "imgstamp.json"
WIDTH = 1760      # 2x the 880px the content column reaches at its widest
QUALITY = 80


def source_digest(app: str, script: str) -> str:
    """What this image is a picture of: the app's shipped files, the fixture it was rendered
    against, and the click script that drove it. Any of the three moving means the picture may no
    longer be one of the product - which is the thing nothing could tell you before this existed.

    Per app rather than per screen, deliberately: a panel is one HTML file and one script, so a
    change anywhere in it can reach any shot, and pretending otherwise would go quiet exactly when
    the change was broad. It over-reports rather than under-reports, and re-rendering is cheap.
    """
    h = hashlib.sha256()
    for f in sorted((ROOT / "apps" / app).rglob("*")):
        if f.is_file() and f.suffix in (".html", ".js", ".css", ".json"):
            h.update(f.name.encode()); h.update(f.read_bytes())
    for f in sorted((ROOT / "fixtures").rglob("*")):
        if f.is_file() and app in str(f.relative_to(ROOT / "fixtures")):
            h.update(f.read_bytes())
    h.update(script.encode())
    return h.hexdigest()[:16]


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
    stamp = {}
    print(f"{'image':22} {'rendered':>13} {'published':>10}")
    every = shots.SHOTS + shots.PANELS + shots.OPTIONS
    for shot in every:
        key = shot[0]
        png = (shots.render_options if shot in shots.OPTIONS else
               shots.render_panel if shot in shots.PANELS else shots.render)(shot)
        raw = png.stat().st_size
        tmp = png.with_name(key + "-scaled.png")
        subprocess.run([sips, "-Z", str(WIDTH), str(png), "--out", str(tmp)],
                       check=True, capture_output=True)
        dest = OUT / (key + ".webp")
        subprocess.run([cwebp, "-q", str(QUALITY), "-quiet", str(tmp), "-o", str(dest)], check=True)
        tmp.unlink()
        total += dest.stat().st_size
        stamp[key] = {"app": shot[1], "from": source_digest(shot[1], shot[-1])}
        print(f"  {key:20} {raw // 1024:>8} KB {dest.stat().st_size // 1024:>8} KB")
    # The 2x renders are working material - what is published is site/img/. Leaving them in dist/
    # meant a folder of PNGs that look like something to upload and are not.
    for f in shots.OUT.glob("*.png"):
        f.unlink()
    try:
        shots.OUT.rmdir()
    except OSError:
        pass
    LEDGER.write_text(json.dumps(stamp, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"\n  {len(every)} image(s), {total // 1024} KB published under site/img/")
    print(f"  what each was rendered from is recorded in {LEDGER.relative_to(ROOT)}, so imgcheck can")
    print("  say when the panel moved and the picture did not.")
    print("  They are lazy-loaded and carry their own width and height, so nothing below them moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
