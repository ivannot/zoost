#!/usr/bin/env python3
"""imgcheck.py - the site's screenshots, checked rather than remembered.

«Copertura visiva totale delle feature» is an intention until something measures it. The site is
built so that a capability which exists in the panel and is described nowhere makes `featurecheck.py`
speak; this is the same rule one dimension over - a screen that exists and is *shown* nowhere.

Seven checks, all derived, none holding a list of pages:

  1. every image the renderer produces is published under site/img/
  2. every image published is used by at least one page - an unused one is weight nobody sees
  3. every `<img>` on the site points at a file that exists
  4. every one carries alt text and an explicit width and height, so a screen reader has something
     to read and nothing below the image moves when the bytes land
  5. a page and its translation carry the **same number** of figures. The twin rule applies to
     pictures too: a reader who switches language and finds one page illustrated and the other bare
     is meeting two different products.
  6. **the picture is still a picture of the product.** `tools/imgstamp.json` records what each
     image was rendered from - the app's shipped files, the fixture, and the click script that drove
     it - so a panel that has moved since is reported rather than left to be noticed. This is the
     one thing the first version could not do: it checked that images existed and were used, which
     says nothing about whether they are still true. Per app, not per screen: a panel is one file
     and a change anywhere in it can reach any shot, so it over-reports rather than going quiet on a
     broad change. The fix is always the same - run `python3 tools/siteimg.py` again.
  7. **the card a link unfurls into is one of the images.** `site/img/og.png` sat outside every
     check above, and not by anyone's decision: check 1 asks the renderer which images exist and
     the card is not one of its shots, checks 2 to 5 read `<img>` tags and the card lives in a
     `<meta property="og:image">`, and every set in here is globbed as `*.webp` while the card is
     a PNG. Four independent reasons to be skipped, so removing one would have changed nothing -
     which is why it was invisible rather than merely missed. Its bytes changed between two
     machines and the only thing that said so was `git status`. It is stamped like the rest now,
     from `tools/ogcard.html` and the screenshot that template embeds.

    python3 tools/imgcheck.py
"""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
IMG = SITE / "img"
STAMP = ROOT / "tools" / "imgstamp.json"
sys.path.insert(0, str(ROOT / "tools"))
import shots  # noqa: E402  - the renderer is the authority on which images exist


def pages():
    return sorted(SITE.glob("*.html")) + sorted((SITE / "it").glob("*.html"))


def main() -> int:
    findings = []
    rendered = {s[0] for s in shots.SHOTS + shots.PANELS + shots.OPTIONS}
    published = {p.stem for p in IMG.glob("*.webp")}

    stamp = json.loads(STAMP.read_text(encoding="utf-8")) if STAMP.exists() else {}
    if not stamp:
        findings.append("tools/imgstamp.json is missing - nothing can say whether the images still "
                        "show the product; run python3 tools/siteimg.py")
    else:
        sys.path.insert(0, str(ROOT / "tools"))
        from siteimg import source_digest
        seen = set()
        for shot in shots.SHOTS + shots.PANELS + shots.OPTIONS:
            key, app = shot[0], shot[1]
            want = source_digest(app, shot[-1])
            got = (stamp.get(key) or {}).get("from")
            if got and got != want:
                seen.add(app)
            elif not got:
                findings.append(f"{key}: nothing records what it was rendered from")
        for app in sorted(seen):
            findings.append(f"{app}: the panel or its fixture has changed since these images were "
                            f"rendered - run python3 tools/siteimg.py so the site shows the product "
                            f"as it is now")

    # The card gets a block of its own rather than a row in the loop above, because it is not a shot
    # of a panel: it has no app, no click script, and what it is a picture of is a template plus the
    # screenshot that template embeds. That the URL on each page carries the card's own digest is
    # `tools/stamp.py`'s job and is not repeated here - one fact, one checker.
    from siteimg import OG_KEY, og_digest, og_sources
    card, template = IMG / "og.png", ROOT / "tools" / "ogcard.html"
    if not template.exists():
        findings.append("tools/ogcard.html is gone, so the card on every link to zoost.it can no "
                        "longer be redrawn from anything")
    else:
        if not card.exists():
            findings.append("img/og.png is missing and every page's og:image points at it - a link "
                            "to zoost.it would unfurl with nothing in it; run python3 tools/siteimg.py")
        for src in og_sources():
            if not src.exists():
                findings.append(f"tools/ogcard.html embeds {src.name}, which does not exist - the "
                                f"card is drawn with a hole where the screenshot goes")
        got = (stamp.get(OG_KEY) or {}).get("from")
        if stamp and not got:
            findings.append("og.png: nothing records what the card was rendered from - "
                            "run python3 tools/siteimg.py")
        elif got and got != og_digest():
            findings.append("og.png: the card's template or the screenshot inside it has moved since "
                            "the card was drawn - run python3 tools/siteimg.py")

    for key in sorted(rendered - published):
        findings.append(f"{key}: the renderer produces it and site/img/ has no copy - "
                        f"run python3 tools/siteimg.py")

    used, per_page = set(), {}
    for page in pages():
        html = page.read_text(encoding="utf-8")
        rel = str(page.relative_to(SITE))
        figs = re.findall(r"<figure class=\"shot\">([\s\S]*?)</figure>", html)
        per_page[rel] = len(figs)
        for tag in re.findall(r"<img\b[^>]*>", html):
            m = re.search(r'src="/img/([\w-]+)\.webp(\?v=([0-9a-f]+))?"', tag)
            if not m:
                continue
            used.add(m.group(1))
            if m.group(1) not in published:
                findings.append(f"{rel}: uses /img/{m.group(1)}.webp, which does not exist")
            else:
                # The token is the image's own digest, and a wrong one is worse than none: the URL
                # stops changing when the picture does, and a week's cache goes on serving the copy
                # a reader already has. That is the defect this replaced, so it is what is checked -
                # not that a token exists, but that it is *this* file's.
                want = hashlib.sha256((IMG / f"{m.group(1)}.webp").read_bytes()).hexdigest()[:10]
                if m.group(3) != want:
                    findings.append(f"{rel}: /img/{m.group(1)}.webp is stamped "
                                    f"{m.group(3) or '(not at all)'} and its bytes hash to {want} - "
                                    f"run python3 tools/siteimg.py")
            alt = re.search(r'alt="([^"]*)"', tag)
            if not alt or not alt.group(1).strip():
                findings.append(f"{rel}: /img/{m.group(1)}.webp has no alt text - it is the only "
                                f"thing a reader who cannot see it gets")
            if not (re.search(r'\bwidth="\d+"', tag) and re.search(r'\bheight="\d+"', tag)):
                findings.append(f"{rel}: /img/{m.group(1)}.webp has no explicit width and height, "
                                f"so the page moves under the reader when it loads")

    # Two names for one picture. `crm-preview` and `crm-panel` came out byte-identical when the
    # detail pane grew tabs and the preview shot stopped opening one - each still existed, each was
    # still used, so every check above stayed quiet while the home page carried a caption about
    # callers and a size over a screenshot of the source. A hash is the only thing that sees it.
    seen = {}
    for f in sorted(IMG.glob("*.webp")):
        seen.setdefault(hashlib.sha256(f.read_bytes()).hexdigest(), []).append(f.stem)
    for names in seen.values():
        if len(names) > 1:
            findings.append(", ".join(names) + " are byte-identical - one picture published under "
                            "several names, and their captions cannot both be about it")

    for key in sorted(published - used):
        findings.append(f"{key}.webp is published and no page uses it - either place it or stop "
                        f"publishing it, because it is weight nobody sees")

    # The same question one file type over, and it had never been asked: the check above globs
    # `*.webp`, so every icon was outside it. `crm-192.png` and `analytics-192.png` were rendered by
    # tools/icons.html, deployed, and referenced by nothing at all - found by hand while chasing a
    # stale logo in a search result. **Take out whatever is not needed**; being essential is the rule,
    # and a rule with nothing measuring it is one that lapses.
    #
    # The reference universe is what makes this honest rather than noisy. It is not just the pages:
    # site/icon.svg is named by no page, and deleting it would have destroyed the source every raster
    # icon and every favicon frame is rendered from - a first pass here counted references in HTML
    # alone and called it an orphan. So tools/icons.html counts too, and so does the web manifest.
    where = ([p.read_text(encoding='utf-8') for p in pages()]
             + [(SITE / 'site.webmanifest').read_text(encoding='utf-8')
                if (SITE / 'site.webmanifest').exists() else '']
             + [(ROOT / 'tools' / 'icons.html').read_text(encoding='utf-8')
                if (ROOT / 'tools' / 'icons.html').exists() else ''])
    haystack = '\n'.join(where)
    for f in sorted(list(SITE.glob('*.png')) + list(SITE.glob('*.ico')) + list(SITE.glob('*.svg'))):
        if f.name not in haystack:
            findings.append(f"{f.name} is published and nothing references it - no page, not the web "
                            f"manifest, not the icon generator. Take it out, or place it")

    for rel, n in sorted(per_page.items()):
        if rel.startswith("it/"):
            continue
        other = "it/" + rel
        if other in per_page and per_page[other] != n:
            findings.append(f"{rel} has {n} screenshot(s) and {other} has {per_page[other]} - "
                            f"a reader who switches language meets a different product")

    for f in findings:
        print("  " + f)
    total = sum(p.stat().st_size for p in IMG.glob("*.webp")) + (card.stat().st_size if card.exists() else 0)
    print(f"\n{len(findings)} finding(s). {len(published)} screenshot(s)"
          f"{' and the card' if card.exists() else ''}, {total // 1024} KB, "
          f"used across {sum(1 for v in per_page.values() if v)} page(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
