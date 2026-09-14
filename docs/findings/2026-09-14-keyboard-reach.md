# Controls a mouse can use and a keyboard cannot - 14 September 2026

Reported from outside, in one sentence: «questa modalità di dichiarare i pulsanti impedirebbe
l'utilizzo da tastiera». It was about `<span role="button">`, and it was the smaller half of what was
there. Two readers with no memory of writing any of it were pointed at the two extensions and found
**125 sites**; the static chrome accounted for **49**, across six shipped pages, and this note is
about those. Six commits took them to **5**, and the five that remain are recorded as *not*
conversions, each with its reason beside it.

What makes the day worth a note is not the count. It is that **four of my own instruments answered
«fine» because they could not answer anything else**, and every one of them was found by planting a
defect or by measuring with a second method - never by reading more carefully.

## The rules it left behind

**What broke.** Nothing in this repository could see the defect. `featurecheck.py` exists to prove
the site names every control the panels have, and it enumerates `<button ...>...</button>`; a `<span>`
that closes a dialog was never a control to it. Its own cruder denominator - the pass that exists to
catch exactly this - counts `<button` too. Numerator and blind spot agreed, so the number on screen
was the evidence that stopped anyone looking.

**The fix.** `tools/keycheck.py` derives the subject instead: every element with an id, of any tag,
that the panel's own scripts wire a click to, that is not natively focusable and carries no
`tabindex`. It counts every `id` attribute in the file against what it inspected - 504 of 504 - so it
cannot quietly shrink. `tools/keyreach.txt` holds what is known and not yet fixed.

**The rule.** **When a check derives its subject by one shape, ask what that shape cannot be** - and
derive the denominator by a method that does not share the assumption. A count that shares the
numerator's blind spot is not a coverage measure, it is a reassurance.

---

**What broke.** The first case written to hold the new focus ring could not fail. It asserted «the
outline is not `none` and is at least 1px», and Chrome draws a default ring: measured inside the
panel, `auto 1px rgb(16,16,16)`. With the panel's own rule deleted the case stayed green. It would
have been committed as a proof.

**The fix.** It asks for contrast now, computed in the page against the first painted ancestor -
1.02:1 for the browser default, 5.10:1 and 4.19:1 for the two products, against the 3:1 a non-text
indicator is asked for.

**The rule.** **Asserting how a rule is spelled is how a gate loses the ability to refuse.** Assert
what the reader receives, and prove both halves on the day it is written: red on a planted defect,
green on the state it is meant to allow.

---

**What broke.** Three of my own verifications were built so that they could not contradict me. A
sweep for clickable elements looked inside `<span>` and `<a>` only, so it could not see `#scrim`, a
`<div>` that closes two dialogs. A `grep` used `\s` in an engine that reads it as the letter s, found
nothing, and nearly deleted three real findings. A third had its conclusion - «nothing above means
none» - written into the command by me, and printed it underneath two lines that said the opposite.

**The fix.** Each was re-asked with the engine that had produced the finding, and the sweep was
widened to every tag and compared by position against a cruder pass.

**The rule.** **When a verification of mine contradicts the tool, suspect the verification first.**
A query that cannot return a positive is not evidence, and a command that prints its own conclusion
is not a measurement.

---

**What broke.** Converting the history arrows to buttons shrank their drawn mark from 16px to 12px.
`.dhead button .mk` was written for the three real buttons already in that header, which want 12; the
moment the arrows became buttons they fell into it. Every check that reads source stayed green.

**The fix.** `.dhead button .nvmk` restates 16px at equal weight, later in the file. The rule serving
the other three buttons is untouched.

**The rule.** **A CSS rule keyed to an element type is a rule that changes when the type changes** -
so before converting a tag, find every selector that reaches the element through its tag rather than
its class. And: **a check that executes the product goes before the checks that describe it.** This
was found by `tools/probe.py` measuring the drawn mark in a real browser; it is the only thing that
saw it.

---

**What broke.** `escapeCloses()` was added to both panels, and reported as «Escape closes the
dialogs». It did - in the panels. The diagram window is a separate page that loads none of those
scripts, so its canvas was left exactly where it was. Half the class, fixed and reported as whole.

**The fix.** The diagram window got the same behaviour in its own existing `keydown` listener, which
already handled `/`.

**The rule.** **Correct a class where it lives, not where it was found.** A fix that reaches one of
two pages is a fix whose scope was decided by which file was open.

---

**What broke.** `tools/attrraw.txt` recorded three interpolations by `file:line`, and a comment block
added elsewhere pushed them down by 13 lines. The check never noticed - its keys hash the
interpolation, not the position - so it reported 0 findings over a ledger that was stale in the only
half a person reads. It surfaced when the battery's own guard saw the checkout change under it.

**The fix.** `--accept` realigned the positions: 40 entries before, 40 after.

**The rule.** **A ledger whose key is content and whose payload is a position will go stale in the
payload, silently.** When a ledger is accepted, say which of the two things happened - it grew, it
shrank, or it was realigned - because the file cannot tell them apart and the reader cannot either.

---

**What broke.** `featurecheck` held two positions on one control at the same time. `EXPECTED_ABSENT`
declared that «Close» needs no mention on the site; the pass that requires a drawn mark to be
depicted in the guide did not consult that list, and demanded «Close» be drawn in both. The
inconsistency was older than the change that revealed it - the assistant's ✕ had carried a drawn mark
all along, and only became countable when it became a `<button>`. Separately, the same file's marks
pattern matched `class="mk"` and not `class="mk nvmk"`, so it saw 10 marked controls where there were
12, and the two it could not see were the two this work converted.

**The fix.** The marks pass honours `EXPECTED_ABSENT`; the pattern accepts a mark carrying a second
class. Back and Forward are declared rather than left invisible.

**The rule.** **A checker with several passes must apply its declared exceptions to all of them** -
one pass ignoring the list is a tool disagreeing with itself, and it will be discovered by whoever
next makes a control visible to it. And widening a checker while its red is blocking you deserves
saying out loud: the justification has to be that the blind spot is older than the change.

## What is not done, and is not a mechanical follow-on

The generated half - roughly **80 sites** - is untouched and outside `keycheck`'s stated reach, which
its docstring says rather than leaves to be found. Three groups, and they need decisions rather than
conversions:

- **Per-row status dots** (`.st` in five lists, both products). The row itself is reachable: both
  panels' lists hold the focus and their arrow keys move *and* activate. The dot is a second,
  different action on the same row - fetch or re-read that one item - and nothing reaches it. Making
  each a `<button>` would put one tab stop per row in the panel: on a 500-function tree that is a
  keyboard made worse, not better.
- **The ER diagram**: boxes are `<div>`, the arcs and their labels are SVG `<path>` and `<g>`. A
  `<path>` cannot become a button. This needs a keyboard model for the drawing itself.
- **Links inside generated content**: cross-references in highlighted code, foreign keys, lineage,
  history rows, audit findings. These are `<a>` with no `href` and would convert cleanly, but they
  are unbounded in the size of the org and share the tab-order question above.

**The rule.** **A sweep's findings are not a work queue.** 125 sites were found; 49 were a class with
one answer, and the rest are three classes with three different answers, two of which are design
decisions that belong to the person whose product it is. Reporting «125 found, 44 fixed» as progress
would hide that.

## What the ledger holds now

Five entries, none of them a conversion: `#scrim` in both panels and `#v-er` in both diagram windows
are dismissal surfaces - backdrop and canvas - which fill the viewport, carry no label, and owe a
keyboard **Escape** rather than focus; that debt is paid in this work. `#pvtable` is not a control at
all: it holds one delegated listener for every fields table there will ever be, and what it acts on is
already a real `<button>` with `aria-expanded`. It is recorded because `keycheck` keys on the element
carrying the handler and cannot tell a delegation host from a control - stated rather than taught,
because the alternative is a checker that guesses at intent.
