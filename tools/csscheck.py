#!/usr/bin/env python3
"""tools/csscheck.py - a class is defined in one place, and the ledger says where the old ones are.

**The rule.** A selector belongs to exactly one stylesheet. Copying it into a second page is how this
site lost four classes to invisibility - `.k`, `.card`, `.note` and `b.ui` were each defined beside
their first user, and the day a second page used one it rendered as ordinary text with nothing broken
and nothing said. Prose did not stop it happening four times, so this does.

**Two kinds of finding, and the second is worse.**

  - *duplicated*: the same selector with the same declarations in more than one place. Harmless today,
    a divergence tomorrow: two copies are one careless edit away from disagreeing.
  - *divergent*: the same selector with **different** declarations in different places. That is a
    class meaning two things, and which one wins depends on which file the reader landed on.

**Why a ledger rather than a red light.** Measured when this was written: 58 rules are duplicated
across the site's pages and four more are deliberately divergent - the product colour in `:root` and
`.btn.p:hover`, the list `try.html` styles its own way. Consolidating them is not a tidy-up: those
rules sit *after* other rules in their own page and win by order, and moving them into `site.css`
shifted 5-20% of the pixels on six pages. So the ones that exist today are written down, with the
reason, and the check refuses **new** ones. `--accept` records the current state; the ledger may only
shrink, and a line that no longer matches anything is reported so it goes.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER = ROOT / "tools" / "cssdupes.txt"

# Where a selector is allowed to be repeated because the repetition *is* the meaning. Each owes a
# reason, the way every other declared exception in this repository does.
DELIBERATE = {
    ":root": "each product page carries its own accent, which is what makes it that product's page",
    ".btn.p:hover": "ditto - the hover of the accent",
    ".steps": "try.html numbers its steps its own way; the guides use the shared counter",
    ".steps li": "ditto",
}


def sheets():
    """Every place a rule can be written, and which world it belongs to.

    The site and each extension are separate documents: `body` in `site.css` and `body` in the CRM
    panel are not two definitions of one thing, they are two documents. Comparing across that line
    produced twenty findings and not one of them was real, which is how this function came to carry a
    world alongside the path.
    """
    out = [("site", "site/site.css", (ROOT / "site/site.css").read_text(encoding="utf-8"))]
    for p in sorted((ROOT / "site").rglob("*.html")):
        css = "".join(m.group(1) for m in re.finditer(r'<style[^>]*>(.*?)</style>',
                                                      p.read_text(encoding="utf-8"), re.S))
        if css.strip():
            out.append(("site", p.relative_to(ROOT).as_posix(), css))
    for p in sorted((ROOT / "apps").rglob("*.html")):
        css = "".join(m.group(1) for m in re.finditer(r'<style[^>]*>(.*?)</style>',
                                                      p.read_text(encoding="utf-8"), re.S))
        if css.strip():
            out.append((p.parent.name, p.relative_to(ROOT).as_posix(), css))
    return out


def rules():
    """(world, selector) -> {declarations -> [where]}, counting only rules at the top level.

    Inside `@media` a selector is *supposed* to appear again with different declarations - that is
    what a breakpoint is - so the depth is tracked and only the outermost rules are read. Without
    that, `header nav` looked like five contradictory definitions when it is one plus four
    breakpoints.
    """
    found = {}
    for world, where, css in sheets():
        css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        depth, pending = 0, ""
        for line in css.splitlines():
            s = line.strip()
            if not s:
                continue
            opens, closes = s.count("{"), s.count("}")
            at_top = depth == 0
            depth += opens - closes
            if not at_top or s.startswith("@"):
                pending = ""
                continue
            # A selector list written over several lines: the first lines have no brace at all, and
            # reading only the last of them turned `a,\n b,\n c{...}` into a definition of `c` -
            # which then looked like a second definition of the `c` that follows. Accumulate instead.
            if "{" not in s:
                pending += s
                continue
            if not s.rstrip().endswith("}"):
                pending = ""
                continue
            s, pending = pending + s, ""
            sel, body = s.split("{", 1)
            sel = " ".join(sel.split())
            if not sel or sel.startswith(("from", "to", "%")) or "}" in sel:
                continue
            found.setdefault((world, sel), {}).setdefault(body.strip().rstrip("}"), []).append(where)
    return found


def survey():
    """What is duplicated and what is divergent, within each world."""
    dup, div = {}, {}
    for (world, sel), bodies in rules().items():
        if sel in DELIBERATE:
            continue
        if len(bodies) > 1:
            div[f"{world}:{sel}"] = {b: sorted(w) for b, w in bodies.items()}
        elif len(next(iter(bodies.values()))) > 1:
            dup[f"{world}:{sel}"] = sorted(next(iter(bodies.values())))
    return dup, div


def ledger():
    if not LEDGER.exists():
        return {}
    out = {}
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        sel, places = line.split("\t", 1)
        out[sel] = places.strip()
    return out


def main() -> int:
    dup, div = survey()
    known = ledger()
    if "--accept" in sys.argv:
        rows = sorted({**{s: ",".join(w) for s, w in dup.items()},
                       **{s: ",".join(sorted({x for ws in v.values() for x in ws})) for s, v in div.items()}}.items())
        LEDGER.write_text(
            "# Selectors written in more than one place, as they stand today. Derived by\n"
            "# tools/csscheck.py --accept; the check refuses anything not in here.\n"
            "# **This file may only shrink.** Every line is a rule waiting to be moved into the sheet\n"
            "# that should own it - and moving one is a job with a screenshot after it, because these\n"
            "# rules win by order inside their own page and lose that when they move.\n"
            "# selector\twhere\n"
            + "".join(f"{s}\t{w}\n" for s, w in rows), encoding="utf-8")
        print(f"csscheck: {len(rows)} repetition(s) recorded in {LEDGER.relative_to(ROOT)}")
        return 0

    # The ledger records *where*, not just what. Recording the selector alone let a seventh copy of
    # an already-listed class through - proven by planting one - which is a gate with a hole in it.
    findings = []
    live = {}
    for sel, where in dup.items():
        live[sel] = set(where)
    for sel, bodies in div.items():
        live[sel] = {w for ws in bodies.values() for w in ws}
    for sel in sorted(live):
        now = live[sel]
        if sel not in known:
            kind = "means different things in" if sel in div else f"is defined in {len(now)} places:"
            findings.append(f"«{sel}» {kind} {', '.join(sorted(now))}")
            continue
        was = {w for w in known[sel].split(",") if w}
        new_places = sorted(now - was)
        if new_places:
            findings.append(f"«{sel}» has gained {', '.join(new_places)} - it was already in "
                            f"{len(was)} places and the rule is one")
        elif now != was:
            findings.append(f"«{sel}» is in fewer places than the ledger says - run --accept so the "
                            f"record shrinks with it")
    for sel in sorted(set(known) - set(live)):
        findings.append(f"«{sel}» is in the ledger and no longer repeated - remove the line")

    worlds = len({w for w, _, _ in sheets()})
    print(f"csscheck: {len(rules())} rules across {len(sheets())} stylesheets in {worlds} documents, "
          f"{len(dup)} repeated and {len(div)} divergent, {len(known)} of them recorded")
    for f in findings:
        print("  " + f)
    print()
    print(f"{len(findings)} finding(s). A selector belongs to one stylesheet; the ledger holds the "
          f"ones that do not yet." if findings else
          "0 findings. Nothing is defined twice that is not written down.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
