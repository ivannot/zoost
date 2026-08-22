#!/usr/bin/env python3
"""tools/matrix.py - how much is left, as a number that can only go down.

**The question this answers.** «Do one at a time» is not a method without a «how many times». A
count of defects cannot supply it: defects are unbounded by construction, which is why every sweep
pays out and none of them ever felt like progress. Asked for in those words, and the objection was
right.

What *is* bounded is the pair that produces them: the **classes** of defect this repository keeps
meeting, and the **surfaces** of the product. Every one of the 51 findings of 22 August fell into
nine classes. The surfaces are countable. So the work is the grid, and one unit of work is one cell:

    plant the defect on that surface -> watch nothing catch it -> write the check -> watch it caught

A cell closed that way stays closed, because a derived check does not forget. A cell «fixed» without
one is not closed at all - that is the whole history of this file's neighbours.

**A cell is closed only by a plant that was seen to fail first.** Not by an opinion that a check
probably covers it. `CLOSED` below records, per cell, the check and the commit where the plant was
made; anything else is open, including cells somebody is fairly sure about.

    python3 tools/matrix.py            # the grid and what is left
    python3 tools/matrix.py --open     # just the open cells, worst first
"""
import sys

# The nine, each earned by defects this repository has actually met. The wording is the question a
# reader asks of a piece of code, because that is how they were written down in CLAUDE.md.
CLASSES = [
    ("await",     "a global written after an await, with no guard between"),
    ("owner",     "a flag set by several paths and released by one"),
    ("siblings",  "one of a set changed, the others left behind"),
    ("partial",   "partial data authorising a destructive act"),
    ("silent",    "an exit that says nothing"),
    ("workspace", "state that survives a change of workspace"),
    ("fastpath",  "a fast path that makes an answer differ from the slow path"),
    ("claim",     "prose that outlived the code it describes"),
    ("blindspot", "a check reporting zero over a surface it never reads"),
]

# The product, in the units somebody works on. Not files: a defect lives in an area.
SURFACES = [
    ("crm-panel",    "apps/crm/{sidepanel,tabs,modules,automation,connections,health}.js"),
    ("crm-ai",       "apps/crm/{ai,keyvault}.js"),
    ("crm-export",   "apps/crm/export.js"),
    ("an-panel",     "apps/analytics/sidepanel.js"),
    ("options",      "apps/*/options.js + options.html"),
    ("bridges",      "apps/*/{hook,content-bridge,background}.js"),
    ("diagrams",     "apps/*/{graphview,graphlogic,graph-core}.js"),
    ("worker",       "site/_worker.js"),
    ("site",         "site/**.html + site.js"),
    ("store",        "store/*/store-listing.md"),
    ("tools",        "tools/*.py + tests/"),
]

# Cells where a class cannot occur on that surface. Each owes a reason, like every other declared
# exception here.
NA = {
    ("await", "site"): "static pages; no async state",
    ("await", "store"): "prose",
    ("workspace", "worker"): "no workspace exists there",
    ("workspace", "site"): "ditto",
    ("workspace", "store"): "ditto",
    ("workspace", "tools"): "ditto",
    ("partial", "site"): "nothing there deletes",
    ("partial", "store"): "ditto",
    ("fastpath", "store"): "prose has no fast path",
    ("owner", "store"): "ditto",
    ("owner", "site"): "no long-running state",
    ("siblings", "worker"): "one file, no twin",
}

# Closed: (class, surface) -> (what catches it, where the plant is recorded).
# **Only a plant seen to fail first closes a cell.** An opinion that something is probably covered is
# an open cell with a comment attached, which is the thing this grid exists to stop.
CLOSED = {
    ("await", "crm-panel"):   ("tools/asynccheck.py + tools/asyncglobals.txt", "planted 2026-08-20"),
    ("await", "an-panel"):    ("tools/asynccheck.py", "planted 2026-08-20"),
    ("blindspot", "site"):    ("tools/htmlcheck.py crude/careful position audit", "planted 2026-08-21"),
    ("blindspot", "tools"):   ("tools/csscheck.py + featurecheck coverage audits", "planted 2026-08-22"),
    ("claim", "site"):        ("tools/auditcheck.py absolutes ledger", "planted 2026-08-20"),
    ("siblings", "diagrams"): ("tools/twincheck.py", "planted 2026-08-19"),
    ("workspace", "crm-panel"): ("tests/panel.test.mjs derives every *Data/*Index", "planted 2026-08-22"),
    ("owner", "crm-panel"):   ("tests/panel.test.mjs derives every pull that reaches Zoho", "planted 2026-08-22"),
    ("siblings", "crm-panel"): ("tests/panel.test.mjs derives every «press Pull» empty state", "planted 2026-08-22"),
    ("partial", "crm-panel"):  ("tests/panel.test.mjs derives every folder-walking deletion", "planted 2026-08-22"),
    ("claim", "store"):        ("tests/tools_test.py derives every numbered section from the headings", "planted 2026-08-22"),
    ("partial", "an-panel"):   ("tests/panel.test.mjs: a prune's keep-set may not be optional", "planted 2026-08-22"),
    ("owner", "an-panel"):     ("tests/panel.test.mjs: a toggle released in a finally, everywhere", "planted 2026-08-22"),
    ("siblings", "an-panel"):  ("tests/panel.test.mjs: every control greyed by a verdict says why", "planted 2026-08-22"),
}


def cells():
    for ck, cd in CLASSES:
        for sk, sd in SURFACES:
            if (ck, sk) in NA:
                continue
            yield ck, cd, sk, sd


def main() -> int:
    all_cells = list(cells())
    open_cells = [c for c in all_cells if (c[0], c[2]) not in CLOSED]
    if "--open" in sys.argv:
        for ck, cd, sk, sd in open_cells:
            print(f"{ck:10s} x {sk:11s}  {cd}")
        return 0

    print(f"matrix: {len(CLASSES)} classes x {len(SURFACES)} surfaces = "
          f"{len(CLASSES) * len(SURFACES)} cells, {len(NA)} do not apply, "
          f"{len(all_cells)} real.")
    print(f"        {len(CLOSED)} closed by a plant that was seen to fail first. "
          f"**{len(open_cells)} left.**")
    print()
    head = "class \\ surface"
    print(f"  {head:12s}" + "".join(f"{s[0][:9]:>11s}" for s in SURFACES))
    for ck, _ in CLASSES:
        row = f"  {ck:12s}"
        for sk, _ in SURFACES:
            row += f"{('  -' if (ck, sk) in NA else ' ok' if (ck, sk) in CLOSED else '  .'):>11s}"
        print(row)
    print()
    print("  ok = a plant was made, nothing caught it, a check was written, the plant is caught now")
    print("   . = open: this is where a scan still finds things, and how many times is this number")
    print("   - = cannot occur here, with the reason in NA")
    print()
    print(f"One unit of work is one cell. {len(open_cells)} of them. A cell does not reopen, so this")
    print("number only goes down - which is the property a count of findings never had.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
