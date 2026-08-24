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

**And an on/off must be true of everything it stands for - otherwise the unit is split.** Ivan's
rule, and it is why a cell is `(class, surface, capability)` rather than `(class, surface)`. It was
the second: «compose x an-panel» printed *closed* on the strength of one plant about the order of
chapters in an export, while a different composition on that same surface - the AI index telling the
panel and the model two different things about what it had dropped - was broken and shipped. The
arithmetic was right and the sentence it printed was not, which is the worst kind of number: one that
is checked and still wrong.

So the count fell from 115 of 115 to 115 of what it really is, and cells reopened. That is the
outcome, not a side effect: a low true number is worth more than a high one that promises what it
cannot keep. A permanent red is the last resort, not the first - splitting comes first.

**Capabilities are derived, not listed per cell.** `CAPABILITIES` names eight things this product
does, each with a probe that reads a *property of the code* - the function that implements it, not a
mention of its name. A surface has a capability when its own files implement it, so moving code
between surfaces re-derives the grid and nobody edits a table. The limit, stated: a probe is a
declared detector and can be wrong in either direction, which is why what it decides is printed.

**A check may claim a whole surface, and must say why in writing.** `*` as the capability means the
check is itself derived over the whole surface - every declaration, every id, every sentence - and
the reason is recorded beside it, the same discipline as `NA`. Twelve entries carry one; each names
what makes it exhaustive rather than asserting that it is.

    python3 tools/matrix.py            # the grid and what is left
    python3 tools/matrix.py --open     # just the open cells, worst first
"""
import pathlib
import re
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

# What this product *does*, and how to tell whether a surface does it. The probe reads a property of
# the code - the function that implements the thing - and not a mention of its name: the first pass
# used `chromewebstore` and `manifest.json`, and every panel came out as a publisher because it links
# to its own listing. A detector is declared, like an NA is declared, and what it decides is printed.
CAPABILITIES = [
    ("pull",     "reading the platform into the mirror",
     r"cmd:\s*'pull|case\s*'pull|async function pull[A-Z]|noteAccess\("),
    ("persist",  "what is written to disk or remembered between sessions",
     r"\bop\.write\s*\(|function writeFileAt|storage\.local\.set\s*\(|idbHandle\.set\s*\("),
    ("search",   "finding something across the mirror",
     r"\brxShortcuts\b"),
    ("export",   "the reports, and what goes in them",
     r"function buildExport|function askScope|\bSCOPE_KEYS\b"),
    ("ai",       "the assistant, its index and its tools",
     r"\bAI_TOOLS\b|function aiBuildSeed|function aiSystemPrompt"),
    ("diagram",  "the drawing and its layout",
     r"\bER_PRESET\b|function erApplyParams|function buildSchemaGraph"),
    ("settings", "what the reader can change, and what remembers it",
     r"const SECTIONS\b|function openSettings|LAY_DEFAULT"),
    ("publish",  "what the project states outward, and what serves it",
     r"/api/versions|store-listing|<urlset|def sitemap|chromewebstore\.google\.com/detail"),
]

# The files each surface is made of. Written as paths rather than prose because the capabilities are
# derived by reading them - a surface whose files nobody can list is a surface nobody can measure.
SURFACE_FILES = {
    "crm-panel":  ["apps/crm/sidepanel.js", "apps/crm/tabs.js", "apps/crm/modules.js",
                   "apps/crm/automation.js", "apps/crm/connections.js", "apps/crm/health.js",
                   "apps/crm/sidepanel.html"],
    "crm-ai":     ["apps/crm/ai.js", "apps/crm/keyvault.js"],
    "crm-export": ["apps/crm/export.js"],
    "an-panel":   ["apps/analytics/sidepanel.js", "apps/analytics/sidepanel.html",
                   "apps/analytics/analytics-sql.js"],
    "options":    ["apps/crm/options.js", "apps/crm/options.html",
                   "apps/analytics/options.js", "apps/analytics/options.html"],
    "bridges":    ["apps/crm/hook.js", "apps/crm/content-bridge.js", "apps/crm/background.js",
                   "apps/analytics/content-bridge.js", "apps/analytics/background.js"],
    "diagrams":   ["apps/crm/graphview.js", "apps/crm/graphlogic.js", "apps/crm/graph-core.js",
                   "apps/crm/graphview.html", "apps/analytics/graphview.js",
                   "apps/analytics/graphlogic.js", "apps/analytics/graphview.html"],
    "worker":     ["site/_worker.js"],
    "site":       ["site/site.js", "site/*.html", "site/it/*.html"],
    "store":      ["store/*/store-listing.md"],
    "tools":      ["tools/*.py"],
}

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

# A check may close a whole surface - every capability of it - only when the check is itself
# derived over the whole surface. What makes it exhaustive is written here, in the same
# discipline as NA: an exception that owes a reason. Twelve of them, each naming what it walks.
WHOLE_SURFACE = {
    ("await", "an-panel"):             "ditto",
    ("await", "bridges"):              "ditto - 787 of 789 functions, the two named",
    ("await", "crm-panel"):            "asynccheck reads every declaration in the surface and ledgers each site",
    ("await", "diagrams"):             "ditto, and prints entered vs not per file",
    ("blindspot", "bridges"):          "the coverage figure is printed and held by a test",
    ("blindspot", "crm-panel"):        "every id in the markup is resolved against the scripts",
    ("blindspot", "site"):             "htmlcheck audits its own reach by position over every page",
    ("blindspot", "tools"):            "csscheck and featurecheck each audit their own subject",
    ("claim", "site"):                 "the absolutes ledger reads every outward sentence on every page",
    ("claim", "store"):                "every numbered section is derived from the headings",
    ("claim", "tools"):                "every tool is read for an absolute a measurement disproved",
    ("siblings", "tools"):             "every checker is in the battery or says why not, beside itself",
}

# Closed: (class, surface) -> (what catches it, where the plant is recorded).
# **Only a plant seen to fail first closes a cell.** An opinion that something is probably covered is
# an open cell with a comment attached, which is the thing this grid exists to stop.
CLOSED = {
    # The three new classes, where a plant was seen to fail first *today* - recorded rather than
    # re-derived tomorrow. Everything else in those three rows is open.
    ("compose", "diagrams", "diagram"): ("tests/panel.test.mjs: crm: diagram defaults saved in Settings are applied by either graph", "planted 2026-08-23"),
    ("copy", "crm-panel", "export"):    ("tests/panel.test.mjs: a constant declared in two scripts of one product is not two lists", "planted 2026-08-23"),
    ("compose", "crm-panel", "pull"):   ("tests/panel.test.mjs: crm: every area the panel reports on is an area the panel can record", "planted 2026-08-24"),
    ("compose", "crm-ai", "ai"):        ("tests/panel.test.mjs: what the index leaves out is said once, and inside the cap, in either product", "planted 2026-08-24"),
    ("compose", "worker", "publish"):   ("tests/worker.test.mjs: the other endpoint holds a complete answer for the full time too", "planted 2026-08-24"),
    ("compose", "tools", "publish"):    ("tests/tools_test.py: what decides a picture is what is hashed", "planted 2026-08-24"),
    ("fake", "options", "settings"):    ("tests/tools_test.py: the settings shot is of a product in use", "planted 2026-08-24"),
    ("copy", "tools", "publish"):       ("tests/tools_test.py: the render harness answers what the manifest says", "planted 2026-08-24"),
    ("compose", "options", "settings"): ("tests/panel.test.mjs: every key the settings page reads is a key it is told about", "planted 2026-08-24"),
    ("fake", "crm-panel", "persist"):   ("tests/panel.test.mjs: a write the browser refuses forgets nothing, in either product", "planted 2026-08-24"),
    ("fake", "an-panel", "persist"):    ("tests/panel.test.mjs: a write the browser refuses forgets nothing, in either product", "planted 2026-08-24"),
    ("fake", "diagrams", "diagram"):    ("tests/panel.test.mjs: the diagram walks a graph that loops, and comes back", "planted 2026-08-24"),
    ("fake", "crm-ai", "ai"):           ("tests/panel.test.mjs: crm: the model stream is assembled by index, across whatever chunks arrive", "planted 2026-08-24"),
    ("fake", "bridges", "pull"):        ("tests/panel.test.mjs: crm: the bridge answers Zoho four ways, and none of them was ever tried", "planted 2026-08-24"),
    ("copy", "bridges", "pull"):        ("tests/tools_test.py: the two halves of live sync reach the same pages", "planted 2026-08-24"),
    ("copy", "an-panel", "export"):     ("tests/panel.test.mjs: every export scope has a box to untick it, and every box is a scope", "planted 2026-08-24"),
    ("copy", "crm-ai", "ai"):           ("tests/panel.test.mjs: a number the settings page offers is the number the panel uses", "planted 2026-08-24"),
    ("compose", "site", "publish"):     ("tests/worker.test.mjs: «updated» on a guide names that guide, through all three programs", "planted 2026-08-23"),
    ("copy", "diagrams", "diagram"):    ("tests/panel.test.mjs: the settings sliders start where the diagram starts, in both products", "planted 2026-08-23"),
    ("fake", "crm-export", "export"):   ("tests/panel.test.mjs: crm: the reports escape what came out of the org, with the escapers the page ships", "planted 2026-08-23"),
    ("compose", "an-panel", "export"):  ("tests/panel.test.mjs: analytics: the export contents name the chapters in the order the document has them", "planted 2026-08-23"),
    ("compose", "crm-export", "export"): ("tests/panel.test.mjs: crm: the export contents name the chapters the export has, in the order it has them", "planted 2026-08-23"),
    ("compose", "bridges", "pull"):     ("tests/panel.test.mjs: the panel, the bridge and the hook share one vocabulary, not two lists", "planted 2026-08-23"),
    ("copy", "store", "publish"):       ("tests/tools_test.py: every permission is justified and every justification is asked for", "planted 2026-08-23"),
    ("copy", "site", "publish"):        ("tests/tools_test.py: the site names every assistant tool, and every tab where its siblings are", "planted 2026-08-23"),
    ("copy", "options", "export"):      ("tests/panel.test.mjs: crm: Settings can set every export scope the panel offers", "planted 2026-08-23"),
    ("copy", "crm-export", "export"):   ("tests/panel.test.mjs: crm: both reports carry the run counts and the credit reading", "planted 2026-08-23"),
    ("fake", "tools", "persist"):       ("tools/probe.py sends what the bridge sends; tests/panel.test.mjs builds the cache from it", "planted 2026-08-23"),
    ("await", "crm-panel", "*"):        ("tools/asynccheck.py + tools/asyncglobals.txt", "planted 2026-08-20"),
    ("await", "an-panel", "*"):         ("tools/asynccheck.py", "planted 2026-08-20"),
    ("await", "options", "settings"):   ("tests/panel.test.mjs: an overtaken loader on the options page publishes nothing", "planted 2026-08-23"),
    ("await", "crm-export", "export"):  ("tests/tools_test.py: the export reads no panel state after an await", "planted 2026-08-23"),
    ("owner", "options", "settings"):   ("tests/panel.test.mjs: a refused save keeps the edits and says so", "planted 2026-08-23"),
    ("workspace", "crm-ai", "ai"):      ("tests/panel.test.mjs: every reader of the seed facts rebuilds the seed first", "planted 2026-08-23"),
    ("await", "diagrams", "*"):         ("tools/asynccheck.py now separates the awaits it entered from the ones it did not, per file; tests/tools_test.py plants one of each", "planted 2026-08-23"),
    ("await", "crm-ai", "ai"):          ("tests/keyvault.test.mjs: two changes to the session cache cannot erase each other", "planted 2026-08-23"),
    ("await", "worker", "publish"):     ("tests/worker.test.mjs: a cached payload cannot change shape behind its own cache key", "planted 2026-08-23"),
    ("owner", "worker", "publish"):     ("tests/worker.test.mjs: a complete answer is held for the full time even when nothing is published", "planted 2026-08-23"),
    ("owner", "tools", "persist"):      ("tests/tools_test.py: every ledger keeps what a person wrote, driven per ledger", "planted 2026-08-23"),
    ("fastpath", "crm-export", "export"): ("tests/panel.test.mjs: a size ranking states how many functions it could measure", "planted 2026-08-23"),
    ("owner", "crm-export", "export"):  ("tests/panel.test.mjs: asking for the export scope twice never abandons the first question", "planted 2026-08-23"),
    ("fastpath", "options", "diagram"): ("tests/panel.test.mjs: a stored diagram setting outside a slider is saved as what is shown", "planted 2026-08-23"),
    ("await", "tools", "persist"):      ("tests/tools_test.py: TheProbeSaysHowMuchOfItIsGuessing", "planted 2026-08-23"),
    ("siblings", "store", "publish"):   ("tests/tools_test.py: both listings have the same numbered sections, and each number means the same field", "planted 2026-08-23"),
    ("claim", "options", "settings"):   ("tools/auditcheck.py now reads the shipped pages; tests/tools_test.py holds every one of them in the subject", "planted 2026-08-23"),
    ("claim", "diagrams", "diagram"):   ("tools/auditcheck.py now reads the MSG tables - what the product says, not what its markup holds", "planted 2026-08-23"),
    ("owner", "crm-ai", "ai"):          ("tests/panel.test.mjs: a flag raised in a function is released whatever happens in it", "planted 2026-08-23"),
    ("fastpath", "diagrams", "diagram"): ("tests/graphview.test.mjs: crm: the status breakdown stops counting a box that was folded away", "planted 2026-08-23"),
    ("owner", "diagrams", "diagram"):   ("tests/graphview.test.mjs: everything printing changes is put back afterwards", "planted 2026-08-23"),
    ("blindspot", "site", "*"):         ("tools/htmlcheck.py crude/careful position audit", "planted 2026-08-21"),
    ("blindspot", "tools", "*"):        ("tools/csscheck.py + featurecheck coverage audits", "planted 2026-08-22"),
    ("claim", "site", "*"):             ("tools/auditcheck.py absolutes ledger", "planted 2026-08-20"),
    # NOT closed by `twincheck` alone, and this was recorded as closed for three days on that basis.
    # `twincheck` compares the two products: it catches a change made on one side and not the other,
    # and it is blind by construction to a defect that is *identical in both*. Four counters in both
    # diagram windows ignored the folded set while two consulted it - one of a set changed, the
    # others left behind, in both twins at once - and the cell said «ok».
    #
    # The lesson for the grid itself: a cell is closed by a check that would catch the class **on
    # that surface**, not by a check that happens to read that surface. Anything closed on a
    # comparison between two things is only closed for what differs between them.
    ("siblings", "diagrams", "diagram"): ("tests/panel.test.mjs: nothing counts a box the reader folded away "
                              "(twincheck reads this surface too, and cannot see a defect both twins share)",
                              "planted 2026-08-23"),
    ("workspace", "crm-panel", "persist"): ("tests/panel.test.mjs: the CRM's per-org caches are dropped there too, not only in the Functions tab", "planted 2026-08-22"),
    ("owner", "crm-panel", "pull"):     ("tests/panel.test.mjs: every pull that reaches Zoho owns the flag that defers a reconcile", "planted 2026-08-22"),
    ("siblings", "crm-panel", "pull"):  ("tests/panel.test.mjs: nothing tells the reader to press Pull without asking what is in the way", "planted 2026-08-22"),
    ("partial", "crm-panel", "persist"): ("tests/panel.test.mjs: nothing deletes on the word of a list that may have stopped early", "planted 2026-08-22"),
    ("claim", "store", "*"):            ("tests/tools_test.py derives every numbered section from the headings", "planted 2026-08-22"),
    ("partial", "an-panel", "persist"): ("tests/panel.test.mjs: nothing deletes on the word of a list that may have stopped early", "planted 2026-08-22"),
    ("owner", "an-panel", "pull"):      ("tests/panel.test.mjs: a toggle released in a finally, everywhere", "planted 2026-08-22"),
    ("siblings", "an-panel", "pull"):   ("tests/panel.test.mjs: every control the panel greys out is told why", "planted 2026-08-22"),
    ("silent", "an-panel", "persist"):  ("tests/panel.test.mjs: a refused folder permission is never a silent return", "planted 2026-08-22"),
    ("silent", "crm-panel", "persist"): ("ditto - the same check reads both products", "planted 2026-08-22"),
    ("workspace", "an-panel", "persist"): ("tests/panel.test.mjs: the selection and the nav chain are forgotten where the workspace changes", "planted 2026-08-22"),
    ("fastpath", "an-panel", "search"): ("tests/panel.test.mjs: analytics: nothing reads the SQL body without asking whether it is still true", "planted 2026-08-22"),
    ("claim", "an-panel", "ai"):        ("tests/panel.test.mjs: the assistant is told about every tool it is given", "planted 2026-08-22"),
    ("claim", "crm-panel", "publish"):  ("ditto - the same check reads both products", "planted 2026-08-22"),
    ("claim", "bridges", "pull"):       ("tools/auditcheck.py now reads docs/boundaries.md as outward prose", "planted 2026-08-22"),
    ("siblings", "bridges", "pull"):    ("tests/tools_test.py: every injected host is a permitted host", "planted 2026-08-22"),
    ("silent", "bridges", "pull"):      ("tests/panel.test.mjs: every read the bridge reports on starts as «not read»", "planted 2026-08-22"),
    ("partial", "bridges", "pull"):     ("tests/panel.test.mjs: each walk has the ceiling its own page size needs", "planted 2026-08-22"),
    ("await", "bridges", "*"):          ("tools/asynccheck.py now reads inside the IIFE; 787 of 789 functions", "planted 2026-08-22"),
    ("blindspot", "bridges", "*"):      ("ditto - the coverage is printed and held by tests/tools_test.py", "planted 2026-08-22"),
    ("workspace", "bridges", "pull"):   ("tests/panel.test.mjs: a memo belongs to the URL it was read at", "planted 2026-08-22"),
    ("owner", "bridges", "pull"):       ("tests/panel.test.mjs: a script re-injected into a page it already ran in can replace itself", "planted 2026-08-22"),
    ("fastpath", "bridges", "persist"): ("tests/panel.test.mjs: the meta schema version moves when the captured fields do", "planted 2026-08-22"),
    ("blindspot", "diagrams", "diagram"): ("tools/probe.py: the diagram window is driven and asserted, not only photographed", "planted 2026-08-23"),
    ("workspace", "options", "settings"): ("tests/panel.test.mjs: a working folder changed in Settings waits for the pull to finish", "planted 2026-08-23"),
    ("partial", "options", "settings"): ("tests/panel.test.mjs: a failed read of aicfg refuses the write that would overwrite it", "planted 2026-08-23"),
    ("blindspot", "crm-export", "export"): ("tests/tools_test.py: TheExportedReportsContentIsLedgered", "planted 2026-08-23"),
    ("blindspot", "an-panel", "pull"):  ("tests/tools_test.py: the probe prints how many controls it drove, and claims nothing wider", "planted 2026-08-23"),
    ("blindspot", "crm-panel", "*"):    ("tests/panel.test.mjs: every id the panel reaches for is defined somewhere in its app", "planted 2026-08-23"),
    ("fastpath", "crm-ai", "ai"):       ("tests/panel.test.mjs: every cache read out of the graph is invalidated with the graph", "planted 2026-08-23"),
    ("silent", "crm-ai", "ai"):         ("tests/panel.test.mjs: an overtaken load refuses rather than answering empty", "planted 2026-08-23"),
    ("partial", "crm-ai", "ai"):        ("tests/panel.test.mjs: every surface that states «no caller» says what it was measured over", "planted 2026-08-23"),
    ("siblings", "crm-ai", "ai"):       ("tests/panel.test.mjs: the prompt names the tools from the registry, never typed", "planted 2026-08-23"),
    ("silent", "store", "publish"):     ("tests/tools_test.py: auditcheck says which listing sections differ from what was pasted", "planted 2026-08-23"),
    ("blindspot", "store", "publish"):  ("tests/tools_test.py: the listing checker enforces §2 and prints what it skips", "planted 2026-08-23"),
    ("blindspot", "options", "settings"): ("tests/panel.test.mjs: every setting the options page writes is read by something", "planted 2026-08-23"),
    ("blindspot", "crm-ai", "ai"):      ("tests/panel.test.mjs: crm: every declared tool runs on the minimum input its schema declares", "planted 2026-08-23"),
    ("workspace", "diagrams", "diagram"): ("tests/panel.test.mjs: the diagram names its workspace, or says it cannot", "planted 2026-08-23"),
    ("partial", "diagrams", "diagram"): ("tests/panel.test.mjs: every surface that states «no caller» says what it was measured over", "planted 2026-08-23"),
    ("workspace", "crm-export", "export"): ("tests/panel.test.mjs: a function that guards one status message guards them all", "planted 2026-08-23"),
    ("partial", "crm-export", "export"): ("tests/panel.test.mjs: an empty section says whether it was asked for", "planted 2026-08-23"),
    ("silent", "crm-export", "export"): ("tests/panel.test.mjs: both exports say which kind of missing source it is", "planted 2026-08-23"),
    ("fastpath", "crm-panel", "pull"):  ("tests/panel.test.mjs: nothing substitutes a number for a measurement that was not taken", "planted 2026-08-23"),
    ("siblings", "tools", "*"):         ("tests/tools_test.py: every checker is in the battery or says beside itself why not", "planted 2026-08-23"),
    ("claim", "tools", "*"):            ("tests/tools_test.py: no tool states the absolute a measurement disproved; ledgers print direction", "planted 2026-08-23"),
    ("silent", "tools", "persist"):     ("tests/tools_test.py: the sync stamp is written only when the copy happened", "planted 2026-08-23"),
    ("partial", "tools", "publish"):    ("tests/tools_test.py: the screenshot mirror deletes inside one product, never across", "planted 2026-08-23"),
    ("fastpath", "tools", "publish"):   ("tests/tools_test.py: the screenshot verdict is one sentence, taken from sources not bytes", "planted 2026-08-23"),
    ("fastpath", "site", "publish"):    ("tests/worker.test.mjs: what the site and the Worker both compute, they compute alike", "planted 2026-08-23"),
    ("silent", "site", "publish"):      ("tests/worker.test.mjs: every fetch the site makes says so when it fails", "planted 2026-08-23"),
    ("blindspot", "worker", "publish"): ("tests/tools_test.py: nothing shipped or served is outside asynccheck unannounced", "planted 2026-08-23"),
    ("claim", "worker", "publish"):     ("tests/worker.test.mjs: a cache miss costs what the comment says it costs", "planted 2026-08-23"),
    ("silent", "worker", "publish"):    ("tests/worker.test.mjs: a 404 is «there are none» and anything else is «I could not find out»", "planted 2026-08-23"),
    ("partial", "worker", "publish"):   ("tests/tools_test.py: a Store reading missing a product is refused, not published", "planted 2026-08-23"),
    ("fastpath", "worker", "publish"):  ("tests/worker.test.mjs: every surface that shows the Store reading says when it is old", "planted 2026-08-23"),
    ("siblings", "options", "settings"): ("tests/panel.test.mjs: a preset keeps what the page cannot show", "planted 2026-08-22"),
    ("claim", "crm-ai", "ai"):          ("tests/panel.test.mjs: both panels: the unlock passphrase does not stay in the DOM", "planted 2026-08-22"),
    ("siblings", "crm-export", "export"): ("tests/panel.test.mjs: both reports read every action field the panel shows", "planted 2026-08-22"),
    ("claim", "crm-export", "export"):  ("ditto - the contents line is built from the chapters written", "planted 2026-08-22"),
    ("silent", "diagrams", "diagram"):  ("tests/panel.test.mjs: the diagram window applies a default that names no graph kind", "planted 2026-08-22"),
    ("silent", "options", "settings"):  ("ditto - the same check reads both pages", "planted 2026-08-22"),
    ("siblings", "site", "publish"):    ("tests/worker.test.mjs: the site and the Worker agree on which version is newer", "planted 2026-08-23"),
}


ROOT = pathlib.Path(__file__).resolve().parent.parent


def capabilities_of(surface: str) -> list:
    """Which of the eight this surface implements, read off its own files.

    **This file is never one of them.** It holds the probes, so scanning `tools/*.py` read them back
    and `tools` came out implementing the export, the assistant, the diagram and the settings - a
    grid measuring its own detector table and believing it. Excluded by being *this file* rather
    than by name, so renaming it cannot bring the self-reference back. Found by reading the
    capability list the tool printed about itself, which is the reason it prints it.
    """
    me = pathlib.Path(__file__).resolve()
    text = ""
    for pat in SURFACE_FILES[surface]:
        for f in sorted(ROOT.glob(pat)) if "*" in pat else [ROOT / pat]:
            if f.is_file() and f.resolve() != me:
                text += f.read_text(encoding="utf-8", errors="ignore")
    return [c for c, _, rx in CAPABILITIES if re.search(rx, text)]


def cells():
    """Every (class, surface, capability) the product can have a defect in.

    The capability is what makes an `ok` mean something: a plant on the export path says nothing
    about the diagram, and this grid used to print one as though it did.
    """
    for ck, cd in CLASSES:
        for sk, sd in SURFACES:
            if (ck, sk) in NA:
                continue
            for cap in capabilities_of(sk):
                yield ck, cd, sk, sd, cap


def citations() -> list:
    """Every closed cell's citation, resolved against what is actually in the tree.

    `CLOSED` is a table maintained by hand, and nothing proved that the check it names still exists.
    A renamed test leaves the grid asserting a cover that nobody can find - the exact failure this
    file was built to refuse, in the file itself.

    Three kinds of citation, and each is resolved as far as it can be, which is not equally far:

      `tests/*.test.mjs: <title>`  the title is matched against `test('…')` in that file. Exact.
      `tests/*_test.py: <prose>`   the prose is a description, not a method name - Python cases are
                                   classes with docstrings - so it is required to appear in the file.
      `tools/*.py …`               a checker rather than a test: the file must exist. That is all
                                   this can say, and it says so rather than implying more.
      anything else                counted as unresolvable and printed, never passed over.
    """
    out = []
    for (ck, sk, cap), (what, when) in sorted(CLOSED.items()):
        head, _, rest = what.partition(": ")
        f = ROOT / head
        if head.endswith(".test.mjs") and f.is_file():
            body = f.read_text(encoding="utf-8", errors="ignore")
            ok = f"test('{rest}'" in body or f'test("{rest}"' in body
            out.append((ck, sk, cap, "exact" if ok else "MISSING", what))
        elif head.endswith("_test.py") and f.is_file():
            body = f.read_text(encoding="utf-8", errors="ignore")
            # A Python case is a class, so the citation names the class - exact, the same as a Node
            # title. «Described» was the first rule here and it is the weaker one: a paraphrase of a
            # docstring resolves for as long as the words survive and says nothing about the class
            # still being there. It is kept only for citations not yet repaired, and it is reported
            # apart so the two are never read as one.
            if f"class {rest}(" in body:
                out.append((ck, sk, cap, "exact", what))
            else:
                words = [w for w in rest.split() if len(w) > 4][:6]
                ok = words and all(w.strip(",.:;«»'\"") in body for w in words)
                out.append((ck, sk, cap, "described" if ok else "MISSING", what))
        elif head.split()[0].endswith(".py") and (ROOT / head.split()[0]).is_file():
            out.append((ck, sk, cap, "checker", what))
        else:
            out.append((ck, sk, cap, "unresolved", what))
    return out


def closes(ck: str, sk: str, cap: str) -> bool:
    """A cell is closed by its own entry, or by one that claims the whole surface with a reason."""
    return (ck, sk, cap) in CLOSED or (ck, sk, "*") in CLOSED


def main() -> int:
    all_cells = list(cells())
    open_cells = [c for c in all_cells if not closes(c[0], c[2], c[4])]
    # An open cell somebody has already measured says so, with what they measured. Without this the
    # next session re-derives it from nothing, which is the waste this state exists to stop.
    if "--open" in sys.argv:
        for ck, cd, sk, sd, cap in open_cells:
            if (ck, sk, cap) in EXAMINED:
                what, when = EXAMINED[(ck, sk, cap)]
                print(f"{ck:10s} x {sk:11s} x {cap:9s} {cd}\n{'':12s}   LOOKED AT {when}: {what}")
                continue
            print(f"{ck:10s} x {sk:11s} x {cap:9s} {cd}")
        return 0

    caps = {s[0]: capabilities_of(s[0]) for s in SURFACES}
    pairs = sum(len(v) for v in caps.values())
    shut = len(all_cells) - len(open_cells)
    print(f"matrix: {len(CLASSES)} classes x {pairs} surface/capability pair(s) "
          f"({len(SURFACES)} surfaces, capabilities read off their own files), "
          f"{len(NA)} class/surface pair(s) do not apply, {len(all_cells)} real cells.")
    print(f"        {shut} closed by a plant that was seen to fail first. "
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
    if not open_cells:
        print(f"\n  every cell is closed by a plant that was seen to fail first.")
        print(f"  there is no next subject. A new class or surface is what makes one.")
    else:
        print(f"\n  next commit subject, if it CLOSES a cell:")
        print(f"    Cell {shut + 1} of {len(all_cells)}: <what broke>")
        print(f"  next commit subject, if it only EXAMINES one:")
        print(f"    Cell {shut + 1} of {len(all_cells)}, examined: <what was measured>")
    print()
    # Per surface: how many of its cells are shut, out of how many it has. A fraction rather than a
    # tick, because a tick is the thing that was wrong - it said «this surface is done» on the
    # strength of one plant somewhere in it.
    head = "class \\ surface"
    print(f"  {head:12s}" + "".join(f"{s[0][:9]:>11s}" for s in SURFACES))
    for ck, _ in CLASSES:
        row = f"  {ck:12s}"
        for sk, _ in SURFACES:
            if (ck, sk) in NA:
                row += f"{'-':>11s}"; continue
            mine = caps[sk]
            shut_here = sum(1 for c in mine if closes(ck, sk, c))
            row += f"{f'{shut_here}/{len(mine)}':>11s}"
        print(row)
    print()
    cited = citations()
    by = {}
    for _, _, _, how, _ in cited:
        by[how] = by.get(how, 0) + 1
    loose = sum(by.get(k, 0) for k in ("MISSING", "unresolved"))
    print(f"  {len(cited)} citation(s): " + ", ".join(f"{n} {k}" for k, n in sorted(by.items())))
    # A ledger, and the direction is printed rather than promised: these should come down as the
    # citations are repaired, and a run that pushes the number up says which of the two reasons it
    # was - a citation that rotted, or a resolver that started seeing more. «Only shrinks» is the
    # absolute this repository measured false in three files of four, and it is not restated here.
    #
    # They are not missing checks. Spot-read, they are **paraphrases** - «an overtaken loader
    # publishes nothing» against the real «an overtaken loader on the options page publishes
    # nothing». A description rots quietly where a title breaks loudly, which is the argument for
    # recording the title.
    print(f"  {loose} of them do not resolve; tests/tools_test.py holds the count.")
    for ck, sk, cap, how, what in cited:
        if how in ("MISSING", "unresolved"):
            print(f"    {how}: ({ck}, {sk}, {cap}) cites «{what}» and nothing in the tree answers to it")
    print()
    print("  n/m = capabilities of that surface closed by a plant, out of the ones it has")
    print("   -  = the class cannot occur on that surface, with the reason in NA")
    print()
    print("  what each surface implements, read off its files:")
    for sk, _ in SURFACES:
        print(f"    {sk:11s} {', '.join(caps[sk]) or '(nothing recognised - the probes found no implementation)'}")
    print()
    print(f"One unit of work is one cell. {len(open_cells)} of them. A cell does not reopen, so this")
    print("number only goes down - which is the property a count of findings never had.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
