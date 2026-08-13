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

`cwebp` and `dwebp` are required, and they are the whole list. It used to be three: `sips` did the
resizing, which is macOS-only and was the one thing keeping these tools on one operating system -
`cwebp -resize W 0` does the same job inside the encode, so a step and a dependency disappeared
together. They are accepted for the same reason Chrome is: this runs when somebody publishes images,
not when somebody builds the extension, and nothing under `apps/` gains a dependency.
"""
import hashlib
import json
import re
import pathlib
import shutil
import subprocess
import sys
import concurrent.futures
import threading
import os
import time
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shots  # noqa: E402  - the renderers, the fixture wiring and the click scripts all live there

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = ROOT / "site" / "img"
LEDGER = ROOT / "tools" / "imgstamp.json"
# Serial by default, and that is the conclusion rather than the starting point. When every image
# meant its own browser, six at a time took the set from 39 minutes to 8 by overlapping the warm-ups;
# with one browser there is one warm-up and the overlapping buys about a minute - and it costs the
# thing that matters more. Measured: rendered six at a time, two of twenty-seven images came out
# different between two consecutive runs, because concurrent captures contend for the machine and a
# page can look still while it is only starved. Rendered one at a time, two consecutive runs of the
# whole set are identical, image for image. `ZOOST_RENDER_JOBS` still raises it for anyone who wants
# the minute and can live without that.
JOBS = int(os.environ.get("ZOOST_RENDER_JOBS", "1"))

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


OG_KEY = "og"     # its slot in the ledger, beside the screenshots


def og_sources() -> list:
    """The files the card is composed from: the template, and whatever it embeds.

    Derived from the template rather than listed here, because the pairing is the part that rots:
    point `ogcard.html` at another screenshot and a written-down `crm-preview.webp` would go on
    watching a file the card no longer contains, reporting current while the card went stale. The
    same argument as everywhere else - the set is read from the thing itself, so there is no second
    place to remember.
    """
    card = ROOT / "tools" / "ogcard.html"
    out = [card]
    for src in re.findall(r'<img[^>]+\bsrc="([^"]+)"', card.read_text(encoding="utf-8")):
        out.append((card.parent / src).resolve())
    return out


def og_digest() -> str:
    """What the card is a picture of, in the same shape as `source_digest()` for the screenshots.

    The card was the one published image outside all of this: not a WebP, not inside an `<img>` -
    it lives in a `<meta og:image>` - so nothing recorded what it was drawn from and nothing
    compared it against its sources. Its bytes changed under nobody's eye, and the only reason it
    was noticed at all is that the digest in every page's URL changed with them.

    A missing embed is hashed as its absence rather than skipped, so a card whose screenshot has
    been renamed away is redrawn instead of quietly keeping the old picture; `imgcheck` names it.
    """
    h = hashlib.sha256()
    for f in og_sources():
        h.update(f.name.encode())
        h.update(f.read_bytes() if f.exists() else b"(missing)")
    return h.hexdigest()[:16]


def render_og_card(dest: pathlib.Path) -> pathlib.Path:
    """The 1200x630 card a link unfurls into, drawn from tools/ogcard.html.

    Every page declared `icon-512.png` with `twitter:card: summary`, so a link pasted anywhere - and
    this project is shared on LinkedIn - came out as a small square icon. The card is rendered the
    same way everything else here is, through Chrome against files in this repository, and it embeds
    the screenshot the site already publishes, so it cannot advertise an interface that does not
    exist. PNG rather than WebP: a scraper that cannot decode the image shows nothing at all, and
    what a given scraper supports is not something this repository can check.
    """
    # A profile of its own, for the reason written above shots.render: the shared one is locked by
    # whichever Chrome has not finished exiting, and the wait is a hundred seconds.
    with tempfile.TemporaryDirectory() as prof:
        subprocess.run([shots.CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--user-data-dir=" + prof,
                        "--window-size=1200,630", "--force-device-scale-factor=1",
                        "--virtual-time-budget=4000", "--screenshot=" + str(dest),
                        (ROOT / "tools" / "ogcard.html").as_uri()], check=True, capture_output=True)
    return dest


def same_picture(a: pathlib.Path, b: pathlib.Path, dwebp: str) -> bool:
    """Do these two WebPs decode to the same pixels?

    A render is not bit-exact - the panel does asynchronous work and the capture happens on a time
    budget - so re-encoding an unchanged screen produces a file that differs by a few dozen bytes
    with nothing to see. Published, that is a commit that says an image changed when the picture did
    not, which is the complaint that led here.

    The digest decides whether to *draw*; this decides whether to *replace*. `dwebp -ppm` writes raw
    pixels, so the comparison is a byte comparison of two decodes, with no image library and no
    threshold to argue about: identical pixels or not.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out = []
        for f in (a, b):
            ppm = pathlib.Path(tmp) / (f.stem + f.suffix.replace('.', '_') + '.ppm')
            r = subprocess.run([dwebp, str(f), '-ppm', '-o', str(ppm), '-quiet'], capture_output=True)
            if r.returncode != 0 or not ppm.exists():
                return False                       # undecodable: treat as different and replace
            out.append(ppm.read_bytes())
        return out[0] == out[1]


def need(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        sys.exit(f"{binary} is not installed - it is what turns the render into something worth serving")
    return path


def say(*a, **k):
    """Print where the run has got to, immediately.

    `flush` is not decoration: stdout is block-buffered whenever it is not a terminal, so every
    progress line a background run writes sits in a 4KB buffer until the process exits - which is
    the same as printing nothing, exactly when somebody is asking whether it is still alive.
    """
    print(*a, flush=True, **k)


def main() -> int:
    cwebp, dwebp = need("cwebp"), need("dwebp")
    shots.SCALE = 2                       # a retina source; see the module docstring
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    stamp = {}
    # What was rendered last time, and from what. An image whose sources have not moved is already
    # correct on disk, and re-rendering it costs ten seconds of headless Chrome to produce the same
    # bytes. Measured across the whole set: a run that changes nothing now takes about a second.
    was = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
    force = "--force" in sys.argv
    say(f"{'image':22} {'rendered':>13} {'published':>10}   ({JOBS} at a time)")
    every = shots.SHOTS + shots.PANELS + shots.OPTIONS
    kept = unchanged = 0
    lock = threading.Lock()

    def one(i, shot):
        nonlocal kept, unchanged, total
        key = shot[0]
        # Named when it starts and again when it ends, both flushed. The start line is what makes a
        # run observable at all: the lines used to be printed after the work, and stdout block-buffers
        # whenever it is not a terminal, so a run redirected to a file said nothing until it exited -
        # thirty-four minutes in which working and hung looked identical. Asked for as a rule: «un
        # task monolitico che gira per tanti minuti e' indistinguibile da uno stuck».
        say(f"  [{i:>2}/{len(every)}] {key:20} …")
        t0 = time.monotonic()
        digest = source_digest(shot[1], shot[-1])
        dest = OUT / (key + ".webp")
        if not force and dest.exists() and (was.get(key) or {}).get("from") == digest:
            with lock:
                stamp[key] = {"app": shot[1], "from": digest}
                total += dest.stat().st_size
                kept += 1
            say(f"  [{i:>2}/{len(every)}] {key:20} {'':>8}    "
                f"{dest.stat().st_size // 1024:>8} KB  unchanged source")
            return
        png = (shots.render_options if shot in shots.OPTIONS else
               shots.render_panel if shot in shots.PANELS else shots.render)(shot)
        raw = png.stat().st_size
        # One pass: cwebp resizes and encodes. The 2x render is landscape, so a width is the whole
        # constraint and the height follows - which is what `-resize W 0` means.
        fresh = png.with_name(key + "-new.webp")
        subprocess.run([cwebp, "-q", str(QUALITY), "-resize", str(WIDTH), "0", "-quiet",
                        str(png), "-o", str(fresh)], check=True)
        note = ""
        if dest.exists() and same_picture(fresh, dest, dwebp):
            fresh.unlink()                          # same pixels: the file on disk stays untouched
            note = "  same picture"
            with lock:
                unchanged += 1
        else:
            fresh.replace(dest)
        with lock:
            total += dest.stat().st_size
            stamp[key] = {"app": shot[1], "from": digest}
        say(f"  [{i:>2}/{len(every)}] {key:20} {raw // 1024:>8} KB "
            f"{dest.stat().st_size // 1024:>8} KB{note}  {time.monotonic() - t0:.0f}s")

    with concurrent.futures.ThreadPoolExecutor(max_workers=JOBS) as pool:
        for fut in [pool.submit(one, i, s) for i, s in enumerate(every, 1)]:
            fut.result()                      # re-raises, so a failed render still stops the run
    # The card, under the guard the screenshots are under. It was rendered unconditionally on every
    # run - four seconds of Chrome to produce, most of the time, the same picture - and because
    # `--screenshot=` writes the file whatever comes out, a run that changed nothing could still
    # replace its bytes and restamp its URL on all 21 pages.
    #
    # After the loop and before the stamping, and both halves of that are load-bearing: the card
    # embeds a screenshot this run may just have redrawn, so its digest is only final once the loop
    # is done - and the pages carry the card's *own* bytes in `og:image`, so stamping it before it
    # is drawn writes last run's digest. That was the order until now, and it held together only
    # because prepare.sh happens to stamp again afterwards; run on its own, `siteimg.py` left the
    # pages pointing at a card that no longer existed.
    card, digest, note = OUT / "og.png", og_digest(), ""
    if not force and card.exists() and (was.get(OG_KEY) or {}).get("from") == digest:
        note = "  not drawn"
    else:
        with tempfile.TemporaryDirectory() as tmp:
            fresh = render_og_card(pathlib.Path(tmp) / "og.png")
            # Whether to draw is the digest's question; whether to replace is the bytes'. The same
            # pair as `same_picture()` one loop up, and a byte comparison is all it needs: this
            # render is static HTML against a local image, and two consecutive runs were measured
            # identical to the byte, where a panel shot is not.
            if card.exists() and fresh.read_bytes() == card.read_bytes():
                note = "  same picture"
            else:
                shutil.copyfile(fresh, card)
    print(f"  {'og':20} {card.stat().st_size // 1024:>8} KB (1200x630, the card a link "
          f"unfurls into){note}")
    stamp[OG_KEY] = {"from": digest}
    # The 2x renders are working material - what is published is site/img/. Leaving them in dist/
    # meant a folder of PNGs that look like something to upload and are not.
    # One implementation, in the tool that owns everything a page prints and is derived. A picture
    # that changed is a URL that changed, so a week's cache cannot serve last week's screenshot.
    import stamp as stamptool
    moved = stamptool.stamp_assets()
    if moved:
        print(f"  {len(moved)} asset URL(s) restamped")
    for f in shots.OUT.glob("*.png"):
        f.unlink()
    try:
        shots.OUT.rmdir()
    except OSError:
        pass
    LEDGER.write_text(json.dumps(stamp, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"\n  {len(every) - kept} rendered ({unchanged} of them the same picture as before, left "
          f"alone), {kept} not drawn at all; {len(every)} screenshot(s) and the card, "
          f"{(total + card.stat().st_size) // 1024} KB under site/img/")
    print(f"  what each was rendered from is recorded in {LEDGER.relative_to(ROOT)}, so imgcheck can")
    print("  say when the panel moved and the picture did not.")
    print("  They are lazy-loaded and carry their own width and height, so nothing below them moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
