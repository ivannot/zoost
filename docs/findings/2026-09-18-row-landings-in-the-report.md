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

## The cause, found last and derivable first

**Everything above treats a symptom. The cause is that the report's script never runs in the window
the panel opens.** «Open» builds a `blob:` in the extension's own origin; both manifests declare
`script-src 'self'`; a one-file report has nowhere to put a script but inline. So in that window the
stylesheet applies and the script does not - which is why the sticky head and the row highlight were
visible while every landing was wrong, and why the same file behaved when opened from the folder.

Measured on the user's own export, served over HTTP twice, one header apart:

| | script | `--stick` | offset used | the card's title |
|---|---|---|---|---|
| without the policy | runs | 213px | 227px | visible, 15px below the band |
| with the policy | **never runs** | unset | 134px, the stylesheet's fallback | **77.8px behind the band** |

One variable, one outcome. And it was derivable from three facts already in this repository - the
declared policy, the origin the panel opens, and the inline `<script>` - on the day the report was
written.

**The fix is to stop needing the script.** The band is a row of the page and `main` is its own
scrollport, so a fragment lands at the top of `main`, which is below the band by construction: no
constant, no measured property, no correction after the jump, nothing a policy can switch off.
`--stick`, `stick()`, `land()` and four listeners are gone. Measured on the same export under the
same policy: the card's title lands 15px clear, and the deepest row of a 363-row table clears its own
column heads by 14.2px.

## The rules it left behind

**When a symptom depends on *how* something is opened, the cause is the environment, and the
environment is knowable without asking anyone.** Five hours went into measuring reconstructions -
his file dressed in a patched shell, in a headless browser, at a guessed width - and every one of
them ran the script, so every one of them came back clean. The user said it twice («il problema è
ovunque», «non possiamo lavorare così») before I stopped reproducing and started reading what makes
that window different from the other. **A reconstruction that cannot exhibit the defect is not
evidence about the product; it is evidence about the reconstruction.** The instrument that settled it
in one run was the same document served with the same policy the manifest declares - two HTTP
responses differing in one header.

**A constant that only a script keeps current is a constant that will be wrong for somebody.** The
offset had a fallback precisely because the script might not run - and the fallback was 120px against
a 213px band, so the code that anticipated the failure also guaranteed it. Where a browser can be
asked to do the positioning, ask the browser.

**And the third time in one day that a quoting mistake of mine was caught by a check rather than by
me.** A backtick in a stylesheet comment inside a template literal, twice, and an apostrophe inside a
single-quoted string in a scenario. All three were caught in a second by something mechanical; none
was caught by rereading. The rule the repository already holds - a builder is executed, not read -
extends to the prose inside a builder: **a comment lives inside the syntax it explains.**



**A jump lands what the reader needs to read, which for a row is its column names.** «The target is
below the band» is the property a card satisfies by carrying its own head; a row satisfies nothing.
`tools/probe.py` drives the report the Zoho CRM panel actually **writes**, read back out of the file-system
shim, and requires that after a jump to an anchored row the table's head is on screen and the row
clears it - green with the rules, and `exit 1` naming `#conn-catalogue_feed` (head bottom 175 against
a band ending at 213) without them.

**What that proved was half of the fix, and «proved in both directions» was written here before
anybody asked which half.** Two reviews measured the same thing independently: delete `land()`'s head
compensation and the check stays green. The reason is arithmetic - `tr[id]` carries a constant 40px of
scroll-margin, which clears any head up to 26px, and every head in both shipped reports measures 24px
- so on real geometry the CSS does all the work and the measured correction never fires. Two
consequences, and the second is the one worth keeping. The check now *makes* the state it cannot wait
for: a second header row taller than the constant, then the same jump, which only the measurement can
satisfy. Measured on the delivered sample's own report, on the 369th row of the 369-row Actions table
with the head grown to 83.5px against a band of 213: **with the correction the row lands 13.6px below
the head; without it, 43.4px behind it.** The first version of *that* experiment proved nothing
either - it took the first row-anchored link in the document, which is row 0 of its table, and a
table's first row sits directly under its own head whether anything measures or not: 0.0px both
ways. The trap is the same one twice in an hour, one level down each time, and the way out was the
same: **ask which case the measurement can distinguish, before believing what it says.** And the landings it judges are no longer the first three in document order - in the sample
those are rows 0, 1 and 3 of a six-row table, and two of the three pass with the sticky rule deleted,
so the ability to fail rested on one link that happened to point deep enough. It takes the deepest
anchored row of each anchored table now. **A check that passes is worth exactly as much as the worst
case it can distinguish, and «it went red once» does not establish which case did it.**

**A check may not ask about the mechanism it exists to catch.** The first version of that check read
`getComputedStyle(thead).position === 'sticky'` before judging a landing, so removing the rule made it
skip every row - it switched itself off in exactly the state it was written for, and reported a pass.
Assert the property the reader needs; never the implementation that delivers it.

**A pass has to mean something was judged, and the counts are what prove it.** The same check then
ran in the Analytics scenario, whose report puts its ids on headings and holds no anchored row at
all: it judged nothing and said nothing, twice, across two full battery-length runs. The assertion
that matters now runs in the scenario whose report *has* anchored rows, and «no row landing was
judged» is a finding there that prints how many anchored rows and how many links at one it found -
because zero of either is the check having lost its subject, and that is indistinguishable from
success in any output that stays silent. The copy in the other scenario is kept and says in its own
comment that it can only ever judge nothing today: it is the net for the day that product starts
anchoring rows, and its counts are what would say so.

**The same rules apply to a report this change touched without being asked about.** The shell is one
file in two products, so the sticky head reached the other product's chapter tables as well - Views,
Relations and Lineage, whose builder writes `table.ftbl` straight into `main`. That is an improvement
of the same kind, and it is written down here because a change measured on one product and shipped to
two is exactly the sort that surprises somebody later. Three of this product's own chapter tables
were carrying no class at all - the two usage tables and the failures table - so they had neither the
report's table styling nor the new head; they carry `ftbl` now, which is what every other chapter
table has. Found by a review pointed at the change, not by its author.

**A comment inside a template literal may not contain a backtick.** Already a known class here, and
it recurred today: the explanatory comment added to `REPORT_CSS` carried backticks around the
identifiers it named, ended the stylesheet early, and left both shipped shells unparseable. Nothing
that reads source saw it; the browser probe did, in seconds - which is the right answer arriving
after the wrong one has been acted on. Nothing read the shipped scripts for syntax at all:
`reportshell.js` is outside the typecheck gate by declaration, because DOM-only surfaces are. Parsing
every shipped script is the first thing `tests/run.sh` does now - 90 of them, the list derived from
the filesystem and the count printed, ahead of the unit tests, because a file that does not parse
makes every later answer meaningless. Asked for in one sentence: «tutto quello che serve per
aggiungere robustezza va fatto».

**And the gate's first version was wrong twice, both found by a review pointed at it rather than by
its author.** It ran `node --check`, which parses a `.js` file as a CommonJS module: planted and
measured, it accepts a top-level `return`, an `import` statement and a top-level `await`, each of
which stops a *classic* script - what both extensions ship - from loading at all. So the gate parses
with `vm.Script`, which refuses all three, and its verdict stops depending on which node is
installed. And the case holding it read the gate instead of running it: with `|| true` planted on the
gate's own line, all four assertions stayed green over a tree carrying the original defect. The gate
now lives between two markers and the case executes *that text* against a copy of `apps/` with three
different defects planted in turn, requiring a refusal that names the file - and requiring a pass on
the tree as it stands, because a gate that always refuses is not strict, it is broken.

**A link only where the section exists - and the emitter that forgot it was the one nobody could
see.** Four of the five things that write a function link in the HTML report ask `fnKeySet` first;
`codeResolve`, which resolves a call *inside highlighted Deluge*, resolved against the call graph
instead - and that holds every function in the org, while the anchors exist only for the functions
the report gives a card to. Measured on a real export: 9 distinct targets in no document, 11 links at
them, each a click that lands nowhere. It asks the set now, and an unanchored call keeps its name as
text. The rule is the one `hLink` already stated in its own comment: **a link only where the section
exists** - so when a report gains a new way to name a function, the question is not «does this name
resolve» but «does this document have that anchor». Found by a review pointed at this change, in code
the change never touched.

**A message that states a precondition names the thing it requires - and one product had two
spellings of the same state.** Reported by a user: they opened the Zoho CRM panel while standing on a
Zoho Analytics tab and were told «Not on a Zoho tab», which is false about where they were and silent
about what was needed. The off-platform overlay in the same product has always said «Not on a Zoho
CRM tab», and its own guide quotes that wording - so the lying line was the odd one out *inside* its
own panel, and the other product's equivalent line had been right all along. The rule generalises
past this sentence: **when a panel refuses because of where the browser is, the refusal names the
platform that panel needs**, never the vendor. The two siblings in the same function were aligned to
the twin in the same change - «Zoho CRM tab (not ready - reload it)» instead of «Zoho tab (not
ready)», which stated a state with no way out of it, and the chip beside the org name. Four strings
elsewhere that say «the Zoho tab» were read and deliberately left: they speak about the tab you came
from, not about a precondition, and both products spell them identically.

**A derived date and a translation marker are written in one order and only one.** `stamp.py` rewrites
the «updated» line on a page from the page's last commit; `sitecheck --retranslated` records a digest
of the English page. Recording the marker first and stamping second leaves the marker naming a file
that no longer exists in that shape - measured twice in a row here, the second time deliberately.
Stamp, then move the marker, then verify both.

**A link to a row the filter has hidden moved the reader 250px away from what they were reading.**
The report's filter hides rows with `display:none` and deliberately leaves the index alone, so a
reader who filters and then clicks an index entry or a cross-reference is following a link to
something that is not on screen. `getBoundingClientRect()` on a hidden row answers zeros, so the
landing correction read the row as sitting at the top of the window and scrolled the page up by the
whole clearance - measured here at -250px, from a document position the reader had chosen, with
nothing on screen to say why. It asks whether the target has a box now, and does nothing when it has
none. The defect is older than this change, which only made the wrong number bigger - a review
reported -227px before it and -250px after, which I did not re-measure myself. The class is one this
repository has already written down and paid for again: **a guard that skips when the thing is absent
is not a guard - absence is the first thing to ask about**, and a rect is not evidence that an
element is rendered.

**The push gate photographs the tree at the wrong instant, and refused four pushes over a file that
was already back.** `tools/hooks/pre-push` runs the battery and then refuses if the working tree
changed - which is right, because a derived file that moved belongs in the commit going out. But
`tests/tools_test.py` plants defects on purpose to prove its checks can fail, `tools/asyncscopes.txt`
among them, and restores them; the hook compared the tree while one of those was in flight and
reported «the battery left changes behind» over a file that is identical to HEAD a second later.
Measured: after the refusal, `git status --porcelain` is empty, `git diff` on that file is empty, and
`asynccheck` reports zero. The finding is recorded rather than fixed today - a gate is not something
to edit while a release is waiting on it - and the shape of the fix is to compare after the suite has
put its own plants back, not while it still has them out.

**A derived ledger is accepted on a tree nobody else is writing.** `twincheck --accept` records a
hash per twin function, and it was run while a review agent had a shipped file mutated in flight: the
run read `apps/crm/options.js` mid-experiment and wrote `saveKeys` into the ledger as divergent when
the two products' copies are identical. The file was back at `HEAD` a minute later, with nothing to
show what had happened except a line in a file that is not read by hand. Caught by comparing the
accept's diff against the list of files this session had actually touched - which is the check worth
keeping: **before accepting anything derived, confirm that what changed is what you changed.** The
same applies to any run that measures the tree: the earlier «green» from a concurrent suite was
measured over somebody else's mutation and had to be thrown away.

**A proof that mutates a shipped file restores it from a trap, not from the next line of the
script.** Two runs of the red/green proof were killed mid-way when the machine ran short of memory,
and both left the mutated rule in `apps/crm/` and `apps/analytics/`. A restore that only happens on
the happy path is not a restore. The same rule covers concurrency: several Chrome-driving instruments
at once is what caused the kills, so a proof that mutates runs alone.
