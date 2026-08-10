#!/usr/bin/env python3
"""imgcheck.py - the site's screenshots, checked rather than remembered.

«Copertura visiva totale delle feature» is an intention until something measures it. The site is
built so that a capability which exists in the panel and is described nowhere makes `featurecheck.py`
speak; this is the same rule one dimension over - a screen that exists and is *shown* nowhere.

Five checks, all derived, none holding a list of pages:

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

    python3 tools/imgcheck.py
"""
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
            m = re.search(r'src="/img/([^"]+)\.webp"', tag)
            if not m:
                continue
            used.add(m.group(1))
            if m.group(1) not in published:
                findings.append(f"{rel}: uses /img/{m.group(1)}.webp, which does not exist")
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
    import hashlib
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

    for rel, n in sorted(per_page.items()):
        if rel.startswith("it/"):
            continue
        other = "it/" + rel
        if other in per_page and per_page[other] != n:
            findings.append(f"{rel} has {n} screenshot(s) and {other} has {per_page[other]} - "
                            f"a reader who switches language meets a different product")

    for f in findings:
        print("  " + f)
    total = sum(p.stat().st_size for p in IMG.glob("*.webp"))
    print(f"\n{len(findings)} finding(s). {len(published)} image(s), {total // 1024} KB, "
          f"used across {sum(1 for v in per_page.values() if v)} page(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
