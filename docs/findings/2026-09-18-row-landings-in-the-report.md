# 18 September 2026 - a report link that lands on a row, and the checks that did not

Reported by the user: opening the HTML export from the workspace folder behaved one way, and opening
it through the panel's **Open** another - "the links reach the paragraph, then you have to scroll up
to see the title". Two copies of the export were handed over, one from each route.

## What was measured

- **The two files are the same file.** They differ by one byte: a newline before the `<!doctype`,
  and `A[1:]` is byte-identical to `B`. Both parse in standards mode, both carry the same band and
  the same landing. So the export is not the variable, and any explanation that lives in the file
  was dead before it was written.
- **The band arithmetic is right everywhere it was driven.** 121 internal links at 1224, 1240 and
  1920px: zero targets under the band. Eight window widths against three display scales, 48 cases:
  zero. Five reader paths - first click, the same link clicked again with the hash unchanged, a hash
  set with no click at all, back then forward, and a band grown without a resize - all landed 14px
  clear. The band crosses a wrap threshold between 1180 and 1224px (234px against 213px) and lands
  correctly on both sides.
- **What is real is the target that carries no title.** 382 of the links in that report point at a
  bare `<tr>` - 194 distinct action rows, 7 connection rows - against 4,326 pointing at a card,
  which names itself in its own head. Landing on the 254th of 369 action rows put the row 14px below
  the band with the column headers **19,563px above it** and the chapter heading 19,680px above: the
  reader arrives on seven cells with nothing naming them.

**And the user's own comparison is still unexplained.** The row defect is structural: it is identical
from the folder and through **Open**, and it was reproduced from `file://` in both copies. The likely
reading is that the links he clicked on the two occasions were of different kinds - 92% of them are
cards, and those are fine - but that is his observation to make, not a conclusion to record here. The
one route that could not be driven is the real thing: the panel's window is a `blob:` document in the
extension's own origin, and on this machine an unpacked extension does not load in headless Chrome
and there is no xvfb, so that path is approximated by geometry and said to be an approximation.

## What was done

`main>table.ftbl>thead` is sticky under the band, `tr[id]` clears the band *and* that head, `land()`
adds the head's height measured at the instant of the landing rather than assuming it, and
`tr[id]:target` marks the row you arrived on. Measured on the user's own report at the geometry
**Open** creates: the head stays pinned at the band, the row lands 16px below it, the card and
chapter landings are unchanged at 14px, and a card's own field table is untouched because the rule is
scoped to chapter tables.

Two measurements paid for one line each. `position:sticky` on the `<th>` does nothing here while the
borders are collapsed, and on the row group it works - so it is on `thead`, with the borders left
alone. And the first attempt at the rule never applied at all: `.ftbl` loses to the shipped
`table.ftbl` on specificity, so the variant that was supposed to test the collapse hypothesis tested
nothing and read as a refutation.

## The rules it left behind

**A jump lands what the reader needs to read, which for a row is its column names.** «The target is
below the band» is the property a card satisfies by carrying its own head; a row satisfies nothing.
`tools/probe.py` drives the report the Zoho CRM panel actually **writes**, read back out of the file-system
shim, and requires that after a jump to an anchored row the table's head is on screen and the row
clears it - proved in both directions on the day it was written: green with the rule, and `exit 1`
naming `#conn-catalogue_feed` (head bottom 175 against a band ending at 213) without it.

**A check may not ask about the mechanism it exists to catch.** The first version of that check read
`getComputedStyle(thead).position === 'sticky'` before judging a landing, so removing the rule made it
skip every row - it switched itself off in exactly the state it was written for, and reported a pass.
Assert the property the reader needs; never the implementation that delivers it.

**A pass has to mean something was judged, and the counts are what prove it.** The same check then
ran in the Analytics scenario, whose report puts its ids on headings and holds no anchored row at
all: it judged nothing and said nothing, twice, across two full battery-length runs. It lives where
its subject exists now, and «no row landing was judged» is a finding that prints how many anchored
rows and how many links at one it found - because zero of either is the check having lost its
subject, and that is indistinguishable from success in any output that stays silent.

**A comment inside a template literal may not contain a backtick.** Already a known class here, and
it recurred today: the explanatory comment added to `REPORT_CSS` carried backticks around the
identifiers it named, ended the stylesheet early, and left both shipped shells unparseable. Nothing
that reads source saw it; the browser probe did, in seconds - which is the right answer arriving
after the wrong one has been acted on. `node --check` over the shipped scripts would have seen it in
one second and was in nothing: `reportshell.js` is outside the typecheck gate by declaration, because
DOM-only surfaces are, so no tool was reading it for syntax at all. It is the first thing
`tests/run.sh` does now - 90 shipped scripts, the list derived from the filesystem and the count
printed, ahead of the unit tests, because a file that does not parse makes every later answer
meaningless. Asked for in one sentence: «tutto quello che serve per aggiungere robustezza va fatto».

**A proof that mutates a shipped file restores it from a trap, not from the next line of the
script.** Two runs of the red/green proof were killed mid-way when the machine ran short of memory,
and both left the mutated rule in `apps/crm/` and `apps/analytics/`. A restore that only happens on
the happy path is not a restore. The same rule covers concurrency: several Chrome-driving instruments
at once is what caused the kills, so a proof that mutates runs alone.
