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
    # The three added on 23 August 2026, after five outside sweeps of a grid that was 87 of 87
    # closed. Not one of the nine above produced an instance in that audit - the reviewers looked
    # and reported clean - and about thirty findings came out anyway, every one of them of these
    # three shapes. A class is added the day a defect nobody predicted arrives; three arrived at once.
    ("compose",   "two parts each correct, and the defect is in the composition"),
    ("copy",      "a list the code holds, written out again by hand somewhere else"),
    ("fake",      "a stub or fixture kinder than the thing it stands for"),
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
    # `compose` needs two parts that can be changed independently, `copy` needs a list the code holds,
    # `fake` needs something standing in for something else. Where a surface has none of those, it is
    # declared here rather than left to be wondered about.
    ("fake", "site"): "static pages stand in for nothing",
    ("fake", "store"): "prose stands in for nothing",
    ("fake", "worker"): "no fixture: the Worker is exercised against real shapes in tests/worker.test.mjs",
    ("copy", "worker"): "it holds the lists; nothing here restates one",
    ("compose", "store"): "prose has no parts that compose",
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

# Examined and no defect found: (class, surface) -> (what was measured, when).
#
# **Not closed.** A cell is closed by a plant that was seen to fail; this is the honest third state -
# somebody looked, measured, and found nothing to write a check from. It stays in the open count,
# because an unchecked cell is unchecked however carefully it was read.
#
# It exists because the alternative is worse in both directions. Without it, five cells examined in
# one day look identical to five nobody has opened, and the next session re-derives them; with it
# recorded as *closed*, the grid would claim a check that does not exist - which is the one thing
# this file is built to refuse. What it saves is the re-derivation; what it must never do is stand
# in for a plant.
EXAMINED = {
}

# Closed: (class, surface) -> (what catches it, where the plant is recorded).
# **Only a plant seen to fail first closes a cell.** An opinion that something is probably covered is
# an open cell with a comment attached, which is the thing this grid exists to stop.
CLOSED = {
    # The three new classes, where a plant was seen to fail first *today* - recorded rather than
    # re-derived tomorrow. Everything else in those three rows is open.
    ("compose", "diagrams"):  ("tests/panel.test.mjs: diagram defaults saved in Settings are applied by either graph", "planted 2026-08-23"),
    ("copy", "crm-panel"):    ("tests/panel.test.mjs: a constant declared in two scripts of one product is not two lists", "planted 2026-08-23"),
    ("compose", "crm-panel"):("tests/panel.test.mjs: every area the panel reports on is an area the panel can record", "planted 2026-08-24"),
    ("compose", "options"): ("tests/panel.test.mjs: every key the settings page reads is a key it is told about", "planted 2026-08-24"),
    ("fake", "crm-panel"):   ("tests/panel.test.mjs: a write the browser refuses forgets nothing, in either product", "planted 2026-08-24"),
    ("fake", "an-panel"):    ("tests/panel.test.mjs: a write the browser refuses forgets nothing, in either product", "planted 2026-08-24"),
    ("fake", "diagrams"):    ("tests/panel.test.mjs: the diagram walks a graph that loops, and comes back", "planted 2026-08-24"),
    ("fake", "crm-ai"):      ("tests/panel.test.mjs: the model stream is assembled by index, across whatever chunks arrive", "planted 2026-08-24"),
    ("fake", "bridges"):     ("tests/panel.test.mjs: the bridge answers Zoho four ways, and none of them was ever tried", "planted 2026-08-24"),
    ("copy", "bridges"):     ("tests/tools_test.py: the two halves of live sync reach the same pages", "planted 2026-08-24"),
    ("copy", "an-panel"):    ("tests/panel.test.mjs: every export scope has a box to untick it, and every box is a scope", "planted 2026-08-24"),
    ("copy", "crm-ai"):      ("tests/panel.test.mjs: a number the settings page offers is the number the panel uses", "planted 2026-08-24"),
    ("compose", "site"):     ("tests/worker.test.mjs: «updated» on a guide names that guide, through all three programs", "planted 2026-08-23"),
    ("copy", "diagrams"):    ("tests/panel.test.mjs: the settings sliders start where the diagram starts, in both products", "planted 2026-08-23"),
    ("fake", "crm-export"): ("tests/panel.test.mjs: the reports escape what came out of the org, with the escapers the page ships", "planted 2026-08-23"),
    ("compose", "an-panel"):  ("tests/panel.test.mjs: the analytics export contents name the chapters in the order the document has them", "planted 2026-08-23"),
    ("compose", "crm-export"):("tests/panel.test.mjs: the export contents name the chapters the export has, in the order it has them", "planted 2026-08-23"),
    ("compose", "bridges"):  ("tests/panel.test.mjs: the panel, the bridge and the hook share one vocabulary, not two lists", "planted 2026-08-23"),
    ("copy", "store"):       ("tests/tools_test.py: every permission is justified and every justification is asked for", "planted 2026-08-23"),
    ("copy", "site"):         ("tests/tools_test.py: the site names every assistant tool, and every tab where its siblings are", "planted 2026-08-23"),
    ("copy", "options"):      ("tests/panel.test.mjs: Settings can set every export scope the panel offers", "planted 2026-08-23"),
    ("copy", "crm-export"):   ("tests/panel.test.mjs: both reports carry the run counts and the credit reading", "planted 2026-08-23"),
    ("fake", "tools"):        ("tools/probe.py sends what the bridge sends; tests/panel.test.mjs builds the cache from it", "planted 2026-08-23"),
    ("await", "crm-panel"):   ("tools/asynccheck.py + tools/asyncglobals.txt", "planted 2026-08-20"),
    ("await", "an-panel"):    ("tools/asynccheck.py", "planted 2026-08-20"),
    ("await", "options"):     ("tests/panel.test.mjs: an overtaken loader publishes nothing", "planted 2026-08-23"),
    ("await", "crm-export"):  ("tests/tools_test.py: the export reads no panel state after an await", "planted 2026-08-23"),
    ("owner", "options"):     ("tests/panel.test.mjs: a refused save keeps the edits and says so", "planted 2026-08-23"),
    ("workspace", "crm-ai"):  ("tests/panel.test.mjs: every reader of the seed facts rebuilds the seed first", "planted 2026-08-23"),
    ("await", "diagrams"):    ("tools/asynccheck.py now separates the awaits it entered from the ones it did not, per file; tests/tools_test.py plants one of each", "planted 2026-08-23"),
    ("await", "crm-ai"):      ("tests/keyvault.test.mjs: two changes to the session cache cannot erase each other", "planted 2026-08-23"),
    ("await", "worker"):      ("tests/worker.test.mjs: a cached payload cannot change shape behind its own cache key", "planted 2026-08-23"),
    ("owner", "worker"):      ("tests/worker.test.mjs: a complete answer is held for the full time even when nothing is published", "planted 2026-08-23"),
    ("owner", "tools"):       ("tests/tools_test.py: every ledger keeps what a person wrote, driven per ledger", "planted 2026-08-23"),
    ("fastpath", "crm-export"): ("tests/panel.test.mjs: a size ranking states how many functions it could measure", "planted 2026-08-23"),
    ("owner", "crm-export"): ("tests/panel.test.mjs: asking for the export scope twice never abandons the first question", "planted 2026-08-23"),
    ("fastpath", "options"): ("tests/panel.test.mjs: a stored diagram setting outside a slider is saved as what is shown", "planted 2026-08-23"),
    ("await", "tools"):       ("tests/tools_test.py: the probe says how many of its waits are bets; the ceiling moves only deliberately, in either direction", "planted 2026-08-23"),
    ("siblings", "store"):    ("tests/tools_test.py: both listings have the same numbered sections, and each number means the same field", "planted 2026-08-23"),
    ("claim", "options"):     ("tools/auditcheck.py now reads the shipped pages; tests/tools_test.py holds every one of them in the subject", "planted 2026-08-23"),
    ("claim", "diagrams"):    ("tools/auditcheck.py now reads the MSG tables - what the product says, not what its markup holds", "planted 2026-08-23"),
    ("owner", "crm-ai"):      ("tests/panel.test.mjs: a flag raised in a function is released whatever happens in it - every shipped script, either spelling", "planted 2026-08-23"),
    ("fastpath", "diagrams"): ("tests/graphview.test.mjs: a box folded away is still away after the drawing is laid out again", "planted 2026-08-23"),
    ("owner", "diagrams"):    ("tests/graphview.test.mjs: everything printing changes is put back afterwards", "planted 2026-08-23"),
    ("blindspot", "site"):    ("tools/htmlcheck.py crude/careful position audit", "planted 2026-08-21"),
    ("blindspot", "tools"):   ("tools/csscheck.py + featurecheck coverage audits", "planted 2026-08-22"),
    ("claim", "site"):        ("tools/auditcheck.py absolutes ledger", "planted 2026-08-20"),
    # NOT closed by `twincheck` alone, and this was recorded as closed for three days on that basis.
    # `twincheck` compares the two products: it catches a change made on one side and not the other,
    # and it is blind by construction to a defect that is *identical in both*. Four counters in both
    # diagram windows ignored the folded set while two consulted it - one of a set changed, the
    # others left behind, in both twins at once - and the cell said «ok».
    #
    # The lesson for the grid itself: a cell is closed by a check that would catch the class **on
    # that surface**, not by a check that happens to read that surface. Anything closed on a
    # comparison between two things is only closed for what differs between them.
    ("siblings", "diagrams"): ("tests/panel.test.mjs: nothing counts a box the reader folded away "
                              "(twincheck reads this surface too, and cannot see a defect both twins share)",
                              "planted 2026-08-23"),
    ("workspace", "crm-panel"): ("tests/panel.test.mjs derives every *Data/*Index", "planted 2026-08-22"),
    ("owner", "crm-panel"):   ("tests/panel.test.mjs derives every pull that reaches Zoho", "planted 2026-08-22"),
    ("siblings", "crm-panel"): ("tests/panel.test.mjs derives every «press Pull» empty state", "planted 2026-08-22"),
    ("partial", "crm-panel"):  ("tests/panel.test.mjs derives every folder-walking deletion", "planted 2026-08-22"),
    ("claim", "store"):        ("tests/tools_test.py derives every numbered section from the headings", "planted 2026-08-22"),
    ("partial", "an-panel"):   ("tests/panel.test.mjs: a prune's keep-set may not be optional", "planted 2026-08-22"),
    ("owner", "an-panel"):     ("tests/panel.test.mjs: a toggle released in a finally, everywhere", "planted 2026-08-22"),
    ("siblings", "an-panel"):  ("tests/panel.test.mjs: every control greyed by a verdict says why", "planted 2026-08-22"),
    ("silent", "an-panel"):    ("tests/panel.test.mjs: a refused folder permission is never a silent return", "planted 2026-08-22"),
    ("silent", "crm-panel"):   ("ditto - the same check reads both products", "planted 2026-08-22"),
    ("workspace", "an-panel"): ("tests/panel.test.mjs: the selection and the nav chain are forgotten where the workspace changes", "planted 2026-08-22"),
    ("fastpath", "an-panel"):  ("tests/panel.test.mjs: sqlBodyOf has one caller, the one that dates it", "planted 2026-08-22"),
    ("claim", "an-panel"):     ("tests/panel.test.mjs: every control the assistant is told about exists - limit stated in the check", "planted 2026-08-22"),
    ("claim", "crm-panel"):    ("ditto - the same check reads both products", "planted 2026-08-22"),
    ("claim", "bridges"):      ("tools/auditcheck.py now reads docs/boundaries.md as outward prose", "planted 2026-08-22"),
    ("siblings", "bridges"):   ("tests/tools_test.py: every injected host is a permitted host", "planted 2026-08-22"),
    ("silent", "bridges"):     ("tests/panel.test.mjs: every xRead flag starts false, is set, and is sent on", "planted 2026-08-22"),
    ("partial", "bridges"):    ("tests/panel.test.mjs: every paged walk has a ceiling and reports hitting it", "planted 2026-08-22"),
    ("await", "bridges"):      ("tools/asynccheck.py now reads inside the IIFE; 787 of 789 functions", "planted 2026-08-22"),
    ("blindspot", "bridges"):  ("ditto - the coverage is printed and held by tests/tools_test.py", "planted 2026-08-22"),
    ("workspace", "bridges"):  ("tests/panel.test.mjs: a memo belongs to the URL it was read at", "planted 2026-08-22"),
    ("owner", "bridges"):      ("tests/panel.test.mjs: an injection guard is a version, not a boolean", "planted 2026-08-22"),
    ("fastpath", "bridges"):   ("tests/panel.test.mjs: the meta schema version moves when the captured fields do", "planted 2026-08-22"),
    ("blindspot", "diagrams"): ("tools/probe.py: the diagram window is driven and asserted, not only photographed", "planted 2026-08-23"),
    ("workspace", "options"):  ("tests/panel.test.mjs: a folder changed in Settings waits for the pull to finish", "planted 2026-08-23"),
    ("partial", "options"):    ("tests/panel.test.mjs: a failed read of aicfg refuses the write that would overwrite it", "planted 2026-08-23"),
    ("blindspot", "crm-export"): ("tests/tools_test.py: the exported report's content is ledgered; a new one is a finding", "planted 2026-08-23"),
    ("blindspot", "an-panel"):  ("tests/tools_test.py: the probe prints how many controls it drove, and claims nothing wider", "planted 2026-08-23"),
    ("blindspot", "crm-panel"): ("tests/panel.test.mjs: every id the panel reaches for is defined somewhere", "planted 2026-08-23"),
    ("fastpath", "crm-ai"):    ("tests/panel.test.mjs: a cache read out of the graph is invalidated with the graph", "planted 2026-08-23"),
    ("silent", "crm-ai"):      ("tests/panel.test.mjs: an overtaken load refuses instead of answering empty", "planted 2026-08-23"),
    ("partial", "crm-ai"):     ("tests/panel.test.mjs: «none» from the assistant says what it was measured over", "planted 2026-08-23"),
    ("siblings", "crm-ai"):    ("tests/panel.test.mjs: the prompt names the tools from the registry, never typed", "planted 2026-08-23"),
    ("silent", "store"):       ("tests/tools_test.py: auditcheck says which listing sections differ from what was pasted", "planted 2026-08-23"),
    ("blindspot", "store"):    ("tests/tools_test.py: the listing checker enforces §2 and prints what it skips", "planted 2026-08-23"),
    ("blindspot", "options"):  ("tests/panel.test.mjs: every setting Settings writes is read by something", "planted 2026-08-23"),
    ("blindspot", "crm-ai"):   ("tests/panel.test.mjs: every declared CRM tool is run, and a fall-through is a finding", "planted 2026-08-23"),
    ("workspace", "diagrams"): ("tests/panel.test.mjs: the diagram names its workspace or says it cannot", "planted 2026-08-23"),
    ("partial", "diagrams"):   ("tests/panel.test.mjs: «no caller» says it was measured over the mirror, not the org", "planted 2026-08-23"),
    ("workspace", "crm-export"): ("tests/panel.test.mjs: a function that guards one status message guards them all", "planted 2026-08-23"),
    ("partial", "crm-export"): ("tests/panel.test.mjs: an empty section says whether it was asked for", "planted 2026-08-23"),
    ("silent", "crm-export"):  ("tests/panel.test.mjs: both exports say which kind of missing source it is", "planted 2026-08-23"),
    ("fastpath", "crm-panel"): ("tests/panel.test.mjs: an unread source measures as nothing, and nobody substitutes a number", "planted 2026-08-23"),
    ("siblings", "tools"):    ("tests/tools_test.py: every checker is in the battery or says beside itself why not", "planted 2026-08-23"),
    ("claim", "tools"):       ("tests/tools_test.py: no tool states the absolute a measurement disproved; ledgers print direction", "planted 2026-08-23"),
    ("silent", "tools"):       ("tests/tools_test.py: the sync stamp is written only when the copy happened", "planted 2026-08-23"),
    ("partial", "tools"):      ("tests/tools_test.py: the screenshot mirror deletes inside one product, never across", "planted 2026-08-23"),
    ("fastpath", "tools"):     ("tests/tools_test.py: the screenshot verdict is one sentence, taken from sources not bytes", "planted 2026-08-23"),
    ("fastpath", "site"):      ("tests/worker.test.mjs: what site and Worker both compute is compared on real tags", "planted 2026-08-23"),
    ("silent", "site"):        ("tests/worker.test.mjs: every fetch the site makes words its own failure", "planted 2026-08-23"),
    ("blindspot", "worker"):   ("tests/tools_test.py: nothing shipped or served is outside asynccheck unannounced", "planted 2026-08-23"),
    ("claim", "worker"):       ("tests/worker.test.mjs: the upstream cost in the comment is measured, not typed", "planted 2026-08-23"),
    ("silent", "worker"):      ("tests/worker.test.mjs: a 404 is «none» and any other failure is «unreadable», worded apart", "planted 2026-08-23"),
    ("partial", "worker"):     ("tests/tools_test.py: a Store reading missing a product is refused, not published", "planted 2026-08-23"),
    ("fastpath", "worker"):    ("tests/worker.test.mjs: every surface stating a Store version consults staleReading", "planted 2026-08-23"),
    ("siblings", "options"):   ("tests/panel.test.mjs: a preset keeps what the page cannot show", "planted 2026-08-22"),
    ("claim", "crm-ai"):       ("tests/panel.test.mjs: the passphrase field is emptied on both branches", "planted 2026-08-22"),
    ("siblings", "crm-export"): ("tests/panel.test.mjs: both reports read every action field the panel shows", "planted 2026-08-22"),
    ("claim", "crm-export"):   ("ditto - the contents line is built from the chapters written", "planted 2026-08-22"),
    ("silent", "diagrams"):    ("tests/panel.test.mjs: a settings key written twice is merged; the window applies a kind-less default", "planted 2026-08-22"),
    ("silent", "options"):     ("ditto - the same check reads both pages", "planted 2026-08-22"),
    ("siblings", "site"):      ("tests/worker.test.mjs: the site and the Worker agree on which version is newer", "planted 2026-08-23"),
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
    # An open cell somebody has already measured says so, with what they measured. Without this the
    # next session re-derives it from nothing, which is the waste this state exists to stop.
    if "--open" in sys.argv:
        for ck, cd, sk, sd in open_cells:
            if (ck, sk) in EXAMINED:
                what, when = EXAMINED[(ck, sk)]
                print(f"{ck:10s} x {sk:12s} {cd}\n{'':12s}   LOOKED AT {when}: {what}")
                continue
            print(f"{ck:10s} x {sk:11s}  {cd}")
        return 0

    print(f"matrix: {len(CLASSES)} classes x {len(SURFACES)} surfaces = "
          f"{len(CLASSES) * len(SURFACES)} cells, {len(NA)} do not apply, "
          f"{len(all_cells)} real.")
    print(f"        {len(CLOSED)} closed by a plant that was seen to fail first. "
          f"**{len(open_cells)} left.**")
    # The subject line for the next one, ready to paste. A remainder - «33 left» - is what the
    # commits between 475bbc0 and here carried, in the *body* only, and it reads as work trailing
    # off: `git log --oneline` showed no progress at all, and a number with no denominator cannot
    # say whether a run is a third done or nearly finished. Reported by Ivan, reading the log.
    #
    # Printed rather than remembered, because the form drifted once by being remembered. The
    # denominator moves when a cell is declared not-applicable, which is why it is derived here and
    # not typed: the earlier subjects say «of 80» and were right when they were written.
    # Both forms, because the counter has now been dropped twice - once by moving it out of the
    # subject into the body as a bare remainder, and once by leaving it off entirely on a commit that
    # recorded a cell as *examined* rather than closed. Both times `git log --oneline` stopped showing
    # progress and the run read as work trailing off. Both reported by Ivan, reading the log.
    #
    # A cell that is examined does not advance the numerator, and the subject says so rather than
    # borrowing the number of the cell that will be closed next.
    #
    # And when there is nothing left, it says so instead of offering «Cell 88 of 87». An out-of-range
    # subject is not a rounding error: this line is *read and copied*, and the number in it is the one
    # thing a reader of the log uses to tell progress from drift. It nearly went into the last commit
    # of the grid.
    if len(CLOSED) >= len(all_cells):
        print(f"\n  every cell is closed by a plant that was seen to fail first.")
        print(f"  there is no next subject. A new class or surface is what makes one.")
    else:
        print(f"\n  next commit subject, if it CLOSES a cell:")
        print(f"    Cell {len(CLOSED) + 1} of {len(all_cells)}: <what broke>")
        print(f"  next commit subject, if it only EXAMINES one:")
        print(f"    Cell {len(CLOSED) + 1} of {len(all_cells)}, examined: <what was measured>")
    print()
    head = "class \\ surface"
    print(f"  {head:12s}" + "".join(f"{s[0][:9]:>11s}" for s in SURFACES))
    for ck, _ in CLASSES:
        row = f"  {ck:12s}"
        for sk, _ in SURFACES:
            row += f"{('  -' if (ck, sk) in NA else ' ok' if (ck, sk) in CLOSED else '  ~' if (ck, sk) in EXAMINED else '  .'):>11s}"
        print(row)
    print()
    print("  ~  = looked at and measured; nothing found to write a check from. Still open.")
    print("  ok = a plant was made, nothing caught it, a check was written, the plant is caught now")
    print("   . = open: this is where a scan still finds things, and how many times is this number")
    print("   - = cannot occur here, with the reason in NA")
    print()
    print(f"One unit of work is one cell. {len(open_cells)} of them. A cell does not reopen, so this")
    print("number only goes down - which is the property a count of findings never had.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
