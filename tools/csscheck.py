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
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ledger import delta as ledger_delta, count as ledger_count, keep_comments  # noqa: E402

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


def _blank_noise(css, strings=True):
    """Comments - and, for the structural pass, string bodies - replaced by spaces, offsets intact.

    Removing them would be simpler and would move every position after the cut, which is exactly what
    the coverage audit below compares. A `}` inside `content: "}"` or a `{` inside a `url(...)` is
    text, not structure, and reading it as structure is how a scanner loses the rest of a file.

    Two passes, because the first version had one and got it wrong in both directions. Slicing a
    selector out of the *raw* text put a comment written above a rule into the selector - which is how
    `[hidden]` arrived carrying the four-line note that explains it. And blanking strings before
    comparing declarations would make `content: "a"` and `content: "b"` equal, which is a divergence
    reported as agreement. So: comments always, strings only where braces are being counted.
    """
    out, i, n = [], 0, len(css)
    while i < n:
        c = css[i]
        if c == "/" and i + 1 < n and css[i + 1] == "*":
            j = css.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(" " if ch != "\n" else "\n" for ch in css[i:j]))
            i = j
            continue
        if strings and c in "\"'":
            j = i + 1
            while j < n and css[j] != c:
                j += 2 if css[j] == "\\" else 1
            j = min(j + 1, n)
            out.append(c + " " * (j - i - 2) + (c if j <= n else ""))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)[:len(css)].ljust(len(css))


def scan(css):
    """Every top-level rule, as (selector, body, offset-of-its-brace), plus the spans skipped.

    Written as a scanner rather than a line reader, and the two defects that cost say why. A rule
    whose body ran onto a second line was **dropped entirely** - the reader required the line to end
    in `}` and threw away the selector it had accumulated when it did not. And two rules on one line,
    `a{x}b{y}`, were read as one: `a` took `x}b{y` as its declarations and `b` was never seen at all.
    Measured on the tree at the time: 1329 rules read of 1497 written.

    Inside `@media` a selector is *supposed* to appear again with different declarations - that is
    what a breakpoint is - so at-rule blocks are skipped whole. They are returned as spans rather
    than silently jumped, because the audit below has to be able to account for every brace in the
    file, and «inside an at-rule» is an answer where «unread» is not.
    """
    text = _blank_noise(css)                  # braces: comments and strings are not structure
    clean = _blank_noise(css, strings=False)  # what a selector or a body actually says
    rules_out, spans = [], []
    i, n, depth, sel_start = 0, len(text), 0, 0
    while i < n:
        c = text[i]
        if c == "{":
            sel = " ".join(clean[sel_start:i].split())
            if sel.startswith("@") or not sel:
                j, d = i, 0
                while j < n:
                    if text[j] == "{":
                        d += 1
                    elif text[j] == "}":
                        d -= 1
                        if d == 0:
                            break
                    j += 1
                spans.append((i, min(j + 1, n)))
                i = min(j + 1, n)
                sel_start = i
                continue
            j, d = i, 0
            while j < n:
                if text[j] == "{":
                    d += 1
                elif text[j] == "}":
                    d -= 1
                    if d == 0:
                        break
                j += 1
            body = clean[i + 1:min(j, n)]
            rules_out.append((sel, body, i))
            # A nested block inside a rule body - CSS nesting, or a stray - is part of this rule, not
            # a rule of its own, and the audit must not read its brace as unaccounted for.
            if "{" in body:
                spans.append((i + 1, min(j, n)))
            i = min(j + 1, n)
            sel_start = i
            continue
        if c == "}":
            sel_start = i + 1
        i += 1
    return rules_out, spans


def unread(css):
    """The braces the careful scan cannot account for - a finding about this tool, not about the CSS.

    The crude pass is deliberately dumber than `scan()`: every `{` in the file, comments and strings
    blanked, and nothing else. Each one has to fall on a rule the careful pass read or inside a span
    it consciously skipped. One that does not is a rule nobody looked at, and a count of duplicates
    taken under an unstated blind spot is the number that gets quoted as evidence.

    The same mechanism as `tools/htmlcheck.py`, and for the same reason: this checker reported zero
    over 168 rules it never read, and nothing said so - including the headline, which counted the
    rules it *had* read and looked complete.
    """
    text = _blank_noise(css)
    rules_out, spans = scan(css)
    known = {off for _, _, off in rules_out}
    out = []
    for i, c in enumerate(text):
        if c != "{" or i in known:
            continue
        if any(a <= i < b for a, b in spans):
            continue
        out.append(i)
    return out


def rules():
    """(world, selector) -> {declarations -> [where]}, counting only rules at the top level."""
    found = {}
    for world, where, css in sheets():
        for sel, body, _ in scan(css)[0]:
            if sel.startswith(("from", "to", "%")):
                continue
            found.setdefault((world, sel), {}).setdefault(body.strip(), []).append(where)
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
        _before = ledger_count(LEDGER)
        # The header this tool writes, and everything a *person* wrote, which is not the same thing.
        # `--accept` regenerates the file whole, so a reason noted beside a line was one run away from
        # being deleted without a word - the defect `keep_comments` was written for in `asynccheck`,
        # still live here and in `langcheck` because the fix reached three of the five ledgers.
        own = [
            "# Selectors written in more than one place, as they stand today. Derived by",
            "# tools/csscheck.py --accept; the check refuses anything not in here.",
            "# **This file should shrink, and a run that grows it says so.** Every line is a rule",
            "# waiting to be moved into the sheet",
            "# that should own it - and moving one is a job with a screenshot after it, because these",
            "# rules win by order inside their own page and lose that when they move.",
            "# selector\twhere",
        ]
        kept = keep_comments(LEDGER, own)
        LEDGER.write_text("".join(f"{line}\n" for line in own + kept)
                          + "".join(f"{s}\t{w}\n" for s, w in rows), encoding="utf-8")
        print(ledger_delta(f"csscheck: {LEDGER.relative_to(ROOT)}", _before, ledger_count(LEDGER)))
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
            kind = ("means different things in" if sel in div
                    else f"is written {len(dup[sel])} times in")
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

    # What the tool did not read, before what it found. A finding count taken under an unstated blind
    # spot is the number that gets quoted as evidence, so this line goes first and names places.
    blind = []
    read = 0
    for _, where, css in sheets():
        read += len(scan(css)[0])
        for off in unread(css):
            line = css.count("\n", 0, off) + 1
            blind.append(f"{where}:{line} - a rule this check never read")

    worlds = len({w for w, _, _ in sheets()})
    print(f"csscheck: {read} rule(s) read across {len(sheets())} stylesheets in {worlds} documents"
          + (f", {len(blind)} NOT LOOKED AT" if blind else ", none left unread")
          + f"; {len(dup)} repeated and {len(div)} divergent, {len(known)} of them recorded")
    for b in blind:
        print("  " + b)
    findings = blind + findings
    for f in findings[len(blind):]:
        print("  " + f)
    print()
    print(f"{len(findings)} finding(s). A selector belongs to one stylesheet; the ledger holds the "
          f"ones that do not yet." if findings else
          "0 findings. Nothing is defined twice that is not written down.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
