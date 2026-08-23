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
    ("owner", "diagrams"): ("every module-level `let` assigned 3+ times and reset once - curFocus, "
                            "erTx, erTy, ids - is view state, not a flag anybody holds; the "
                            "beforeprint/afterprint pair closes itself", "2026-08-23"),
    ("owner", "crm-ai"): ("every flag is owned by its generation - aiBusy released only when aiGen "
                          "has not moved, aiSeedWarned and the conversation cleared together - in "
                          "both products", "2026-08-23"),
    ("siblings", "store"): ("both listings carry the same ten sections and nine payload blocks, the "
                            "same claims, disclosures that differ only where the products do, and a "
                            "whatsnew note for every tag since each adopted the convention",
                            "2026-08-23"),
    ("fastpath", "diagrams"): ("driven, not read: after a fold the window says erHiddenSet=1, "
                              "erVisibleIds=17; force the slow path and the same questions answer 0 "
                              "and 18 with erCut still at 1 - the fold is remembered and stops "
                              "taking effect. NOT fixed: which of the two behaviours is wanted is a "
                              "product decision. docs/findings/2026-08-23-a-fold-does-not-survive-a-"
                              "relayout.md", "2026-08-23"),
    ("claim", "diagrams"): ("every absolute in the graph windows checked against the code: «every "
                           "loss is counted» holds - matchArrangement puts every id in matched, "
                           "fresh or stale - and docs/diagrams.md's «both skip what erHiddenSet "
                           "hides» is true of the two it names. The paragraph that was *not* stale "
                           "named a live defect and it is fixed under this cell", "2026-08-23"),
    ("claim", "options"): ("every absolute on the page checked against the code: the passphrase is "
                           "never stored (what session holds is the decrypted key, and privacy.html "
                           "says so), «nothing on disk is deleted» holds, and «until a workspace has "
                           "been pulled, every tab is offered» is what the empty access map does",
                           "2026-08-23"),
}

# Closed: (class, surface) -> (what catches it, where the plant is recorded).
# **Only a plant seen to fail first closes a cell.** An opinion that something is probably covered is
# an open cell with a comment attached, which is the thing this grid exists to stop.
CLOSED = {
    ("await", "crm-panel"):   ("tools/asynccheck.py + tools/asyncglobals.txt", "planted 2026-08-20"),
    ("await", "an-panel"):    ("tools/asynccheck.py", "planted 2026-08-20"),
    ("await", "options"):     ("tests/panel.test.mjs: an overtaken loader publishes nothing", "planted 2026-08-23"),
    ("await", "crm-export"):  ("tests/tools_test.py: the export reads no panel state after an await", "planted 2026-08-23"),
    ("owner", "options"):     ("tests/panel.test.mjs: a refused save keeps the edits and says so", "planted 2026-08-23"),
    ("workspace", "crm-ai"):  ("tests/panel.test.mjs: every reader of the seed facts rebuilds the seed first", "planted 2026-08-23"),
    ("await", "diagrams"):    ("tools/asynccheck.py now separates the awaits it entered from the ones it did not, per file; tests/tools_test.py plants one of each", "planted 2026-08-23"),
    ("await", "crm-ai"):      ("tests/keyvault.test.mjs: two changes to the session cache cannot erase each other", "planted 2026-08-23"),
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
