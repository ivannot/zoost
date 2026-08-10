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
    the change was broad. It over-reports rather than under-reports.

    The digest is the *only* thing that decides, and it has to be, because a render is not bit-exact:
    the panel does asynchronous work and the capture happens on a time budget, so drawing the same
    commit twice can differ by a few dozen bytes on three hundred thousand - measured, and with no
    visible difference. Comparing the produced bytes would therefore re-publish for ever. What that
    costs is a diff with a little noise in it on the runs where something genuinely moved; what it
    buys is that no image is ever skipped because its bytes happened to match.

    That direction matters more now that the digest decides what to *re-render* and not only what to
    report: rendering something that did not need it costs ten seconds, and skipping something that
    did publishes a picture of a product that no longer exists. So the renderers themselves are in
    the hash - `shots.py` holds the window size, the scale and the stub the panel is fed through, and
    a change to any of those changes every image without touching an app.
    """
    h = hashlib.sha256()
    for f in sorted((ROOT / "apps" / app).rglob("*")):
        if f.is_file() and f.suffix in (".html", ".js", ".css", ".json"):
            h.update(f.name.encode()); h.update(f.read_bytes())
    for f in sorted((ROOT / "fixtures").rglob("*")):
        if f.is_file() and app in str(f.relative_to(ROOT / "fixtures")):
            h.update(f.read_bytes())
    for f in (ROOT / "tools" / "shots.py", ROOT / "tools" / "fsshim.js"):
        h.update(f.read_bytes())
    h.update(script.encode())
    return h.hexdigest()[:16]


def render_og_card() -> pathlib.Path:
    """The 1200x630 card a link unfurls into, drawn from tools/ogcard.html.

    Every page declared `icon-512.png` with `twitter:card: summary`, so a link pasted anywhere - and
    this project is shared on LinkedIn - came out as a small square icon. The card is rendered the
    same way everything else here is, through Chrome against files in this repository, and it embeds
    the screenshot the site already publishes, so it cannot advertise an interface that does not
    exist. PNG rather than WebP: a scraper that cannot decode the image shows nothing at all, and
    what a given scraper supports is not something this repository can check.
    """
    out = OUT / "og.png"
    subprocess.run([shots.CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                    "--window-size=1200,630", "--force-device-scale-factor=1",
                    "--virtual-time-budget=4000", "--screenshot=" + str(out),
                    (ROOT / "tools" / "ogcard.html").as_uri()], check=True, capture_output=True)
    return out


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
    # What was rendered last time, and from what. An image whose sources have not moved is already
    # correct on disk, and re-rendering it costs ten seconds of headless Chrome to produce the same
    # bytes. Measured across the whole set: a run that changes nothing now takes about a second.
    was = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
    force = "--force" in sys.argv
    print(f"{'image':22} {'rendered':>13} {'published':>10}")
    every = shots.SHOTS + shots.PANELS + shots.OPTIONS
    kept = 0
    for shot in every:
        key = shot[0]
        digest = source_digest(shot[1], shot[-1])
        dest = OUT / (key + ".webp")
        if not force and dest.exists() and (was.get(key) or {}).get("from") == digest:
            stamp[key] = {"app": shot[1], "from": digest}
            total += dest.stat().st_size
            kept += 1
            continue
        png = (shots.render_options if shot in shots.OPTIONS else
               shots.render_panel if shot in shots.PANELS else shots.render)(shot)
        raw = png.stat().st_size
        tmp = png.with_name(key + "-scaled.png")
        subprocess.run([sips, "-Z", str(WIDTH), str(png), "--out", str(tmp)],
                       check=True, capture_output=True)
        subprocess.run([cwebp, "-q", str(QUALITY), "-quiet", str(tmp), "-o", str(dest)], check=True)
        tmp.unlink()
        total += dest.stat().st_size
        stamp[key] = {"app": shot[1], "from": digest}
        print(f"  {key:20} {raw // 1024:>8} KB {dest.stat().st_size // 1024:>8} KB")
    # The 2x renders are working material - what is published is site/img/. Leaving them in dist/
    # meant a folder of PNGs that look like something to upload and are not.
    for f in shots.OUT.glob("*.png"):
        f.unlink()
    try:
        shots.OUT.rmdir()
    except OSError:
        pass
    card = render_og_card()
    print(f"  {'og':20} {card.stat().st_size // 1024:>8} KB (1200x630, the card a link unfurls into)")
    LEDGER.write_text(json.dumps(stamp, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"\n  {len(every) - kept} rendered, {kept} already current; "
          f"{len(every)} image(s), {total // 1024} KB published under site/img/")
    print(f"  what each was rendered from is recorded in {LEDGER.relative_to(ROOT)}, so imgcheck can")
    print("  say when the panel moved and the picture did not.")
    print("  They are lazy-loaded and carry their own width and height, so nothing below them moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
