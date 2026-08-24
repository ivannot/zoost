# Findings - 24 August 2026, one value has to be true of everything it stands for

A day of driving the two panels rather than reading them, and of measuring the ground they run on.
Fourteen findings, all fixed. They are not one subject, but they rhyme: **a single value was standing
for a set whose members disagreed** - one frame id for three frames, one boolean for two products,
one ledger row for a whole file, one footer for two reports. Where that happened, the value was
split until each one was true of everything it named.

The principle it leaves is the one the day was spent on: **an on/off value must be true of everything
it represents; if it cannot be, split it.**

## 1. A builder that nothing executes - high, **fixed**

**What broke.** `Export error: Cannot access 'srcBlock' before initialization`, reported by Ivan from
a real org. A `const` arrow was declared 76 lines below its first use in `buildExportHtml`, so every
CRM export with source ticked died at the first function it tried to render. 530 tests were green.

Twelve hours later, the same class in the other product: a backtick inside a *comment* inside a
template literal ended the literal early, and `esc2(...).legal is not a function` reached his screen.
Then a third time, in the same shape. Nothing read-based can see either: to a scanner the file is
well-formed text, and `sliceFn` happily lifts a function whose template ended three lines ago.

**The fix.** `tools/probe.py` drives both panels in a real Chrome and fails on anything the page
logs - it existed, and it was only in `tools/prepare.sh`. It is in `tests/run.sh` now, so the battery
is red when the product is broken instead of green while the product is broken.

> **The rule.** *A builder that produces a shipped artefact must be **executed** by something, never
> only read.* A test that reads source is a photograph of a belief; the browser is the only reader
> whose opinion counts.

## 1b. The check that executes was placed where it would not run - high, **fixed**

**What broke.** The probe from finding 1 was in the battery, and a **fourth** early-ended template
literal still reached Ivan's screen: `Cannot access 'EXPORT_CSS' before initialization`, from a
backtick inside the comment that explained the *third* one. The battery had been run. It was red -
on `imgcheck`, because the site pictures were being re-rendered at that moment - and `set -e` ends
the run at the first red. The probe was the last line of the file, so it never executed.

**The fix.** Two. The probe now runs **third**, before everything that only reads source, and a case
derives that ordering from `tests/run.sh` and refuses to let it drift back. And the class got a
second, cheaper reader: every script the two panels load is evaluated in a `vm`, in the order the
page's own `<script src>` tags give, against a Proxy environment that answers anything - a file whose
top level cannot evaluate is broken whatever the DOM would have handed it. It costs milliseconds,
needs no Chrome, and catches the planted backtick. What it does not reach is stated in the case: a
defect that only fires when a function is *called* is the probe's half.

> **The rule.** *Order the battery by what you want to know first, because `set -e` makes order into
> presence.* A check that only runs when everything before it passed is absent exactly when something
> is wrong - and «it is in the suite» stops being true without anyone editing it.

## 2. Waiting for the second instance - process, **fixed**

**What broke.** After finding 1 I wrote a case that executes the *CRM* builder, and did not write the
twin. The Analytics builder broke that evening. Ivan, exactly: «non devi aspettare 3 fail per mettere
un controllo. ne basta 1», and then: «scolpiscilo sulla pietra».

**The fix.** Carved into `CLAUDE.md` above the two proofs a check must pass, and into memory.

> **The rule.** *One failure earns a check immediately, and the check is not done until its siblings
> are walked* - the other product, the other builder, the other surface. Waiting for a pattern to
> emerge means shipping the second instance in order to see it.

## 3. One frame id for three frames - high, **fixed**

**What broke.** Zoost did nothing inside Zoho One. Diagnosed three times, and each diagnosis was a
real cause standing in front of the next.

The tab is the shell (`one.zoho.<dc>`) and the product runs in an iframe. First: the manifest did not
name the shell hosts, so nothing was injected. Then: `chrome.tabs.sendMessage` addresses frame 0 by
default, which is the shell and has no bridge. Then, the one that would not have been found by
reading: the panel picked the CRM frame **by position** in the frame tree and cached the answer -
including a *miss*. One negative result, remembered, made the panel mute for the rest of the session.

Under it sat a fourth: the bridge answered `context` unconditionally, so a shell frame that had the
content script and no product replied with `origin: 'html'` and won the race.

**The fix.** The panel keeps the CRM-origin frames as *candidates*, injects into all of them, asks
each, and keeps the one that **answers** - `ok | declined | half | no-listener`, printed. A miss is
never cached. The bridge answers only when origin *and* instance *and* org are present.

> **The rule.** *Identify a participant by what it answers, never by where it sits* - and **never
> cache a negative**: a position is a coincidence of layout, and an absence is a moment in time.

## 4. The same defect, waiting, in the other product - high, **fixed**

**What broke.** Ivan opened Analytics inside the same shell: nothing. `apps/analytics` had no shell
hosts, **no `all_frames` at all**, and an unconditional `context` reply. The whole of finding 3, one
directory over, discovered only because he happened to try.

**The fix.** 18 shell hosts, `all_frames: true`, and the identity gate, in the same change as the
frame-answering logic - both products, one commit.

> **The rule.** *A fix to one twin is unfinished until the other has been read for the same shape.*
> Twins do not diverge by decision; they diverge because one of them was in front of someone.

## 5. Navigating the tab when the product is in a frame - medium, **fixed**

**What broke.** «Open in Zoho» inside the shell opened a new tab in Analytics and moved the whole tab
in the CRM. Both are wrong for the same reason: the thing that should navigate is the frame the
product occupies, and frame 0 only happens to be that frame when there is no shell.

**The fix.** `goToZoho(url, opts)` navigates the product's frame; frame 0 is the ordinary case, not
the assumption.

> **The rule.** *Act on the thing you identified, not on the container you found it in.* A tab, a
> window, a folder - each is a wrapper that is the same as its content right up to the day it is not.

## 6. One of a set that did not do what its siblings do - medium, **fixed**

**What broke.** Analytics' `Open in Zoho` was wired to `chrome.tabs.create`, alone among the panel's
navigations. Nothing was wrong with it in isolation, which is why it survived.

**The fix.** It goes through `goToZoho` like every sibling.

> **The rule.** *When you add one of a kind, walk the others; when you change the kind, walk the
> instances.* This repository already says so about tabs, dots and export sections - the class is
> «one of a set», not «a tab».

## 7. Three sets of controls that had to agree - medium, **fixed**

**What broke.** Which buttons are disabled while Zoho is unreachable was written three times, in
three places, with three memberships. Two of them had drifted; nobody could say which was right.

**The fix.** `ZOHO_BTNS` is one list and `blockZoho(on)` is the only writer.

> **The rule.** *A membership written more than once is a membership that will disagree with itself.*
> One list, one writer - the same argument as a selector defined once.

## 8. Empty states that named the wrong missing thing - medium, **fixed**

**What broke.** A stored folder handle loses its permission between sessions. Analytics recited the
whole sequence (pick a folder, create a workspace, Pull all) when the only thing in the way was one
click, and the sentence existed **twice** - in `render()` and hard-coded in the markup, the second
being the one on screen. The CRM never showed it at all: its early returns did not draw the tree.

**The fix.** `emptyBlocker()` / `emptyReason()`, shared word for word, drawn from every early return,
and no empty state in the markup at all.

> **The rule.** *Say **the** reason, not **a** reason.* A true-but-not-blocking instruction is worse
> than silence: the reader goes and does it, nothing changes, and they conclude the product is broken.

## 9. Two reports that were not twins - medium, **fixed**

**What broke.** Ivan: «l'export è completamente diverso tra i 2. header, toc, etc. io voglio che
questi prodotti siano davvero gemelli. non perchè l'hai scritto in un file che continui a ignorare.»
Measured, nine differences: a footer that did not span the page, SQL shipped unhighlighted while the
panel highlights it, **no attribution at all** in the Analytics report, two different headers, a
table of contents in one and not the other, no filter in one, and no hyperlinks between the Analytics
sections - a report that was not a hypertext.

**The fix.** `reportshell.js`, byte-identical in both apps and held by `twincheck`: the frame, the
header, the table of contents, the filter script, the one-line attribution. What differs is the
accent colour, deliberately, and a case demands it.

> **The rule.** *Sameness between twins is held by a shared artefact and a check, never by prose.*
> Prose describing two files as identical is a wish; a byte comparison is a fact.

## 10. A jump that landed behind the header - low, **fixed**

**What broke.** «i link degli export portano alla sezione corretta ma qualche riga più in basso.»
The band at the top of a report is sticky, and an anchor puts its target at the top of the *window* -
behind it. Only `.item` carried a `scroll-margin-top`, so chapter headings and per-view anchors
landed under the band.

**The fix.** Every `[id]` clears it, and the height is **measured** at load and on resize rather than
written down: the two headers are not the same height and either can gain a line. Verified in a
browser - the heading lands 14px below the band, not behind it.

> **The rule.** *A constant that stands for the size of something is a measurement someone stopped
> taking.* If the thing can change, ask it.

## 11. The perimeter nobody had measured - medium, **fixed**

**What broke.** A friend of Ivan's installed the CRM extension and it did nothing: his org is on
`crmplus.zoho.eu`, which no manifest named. The perimeter had been assumed rather than enumerated.

**What was measured**, rather than argued: five host families across ten data centres, every one of
them live; `crmplus.*` serves its own `login.sas`, so it is a first-class entry point and not a
redirect; `.ae` answers on `?DC=AE`; the official Zoho documentation lists seven data centres, which
is not the same set. A custom domain (`crm.<customer>.<tld>`) resolves and then redirects to a Zoho
host - it cannot be enumerated, so it is not covered, and saying so is the honest answer.

`https://*.zoho.com/*` was considered and rejected: 22 of 22 probed subdomains are live, it would
include `accounts.`, it covers one data centre out of ten, and Chrome refuses a TLD wildcard.

**The fix.** Nine `crmplus.*` hosts on the CRM, eighteen shell hosts on Analytics. Nothing untested
was added: `marketingplus`, `serviceplus`, `financeplus`, `peopleplus` stay out until there is
evidence, the same rule that keeps China out.

> **The rule.** *A perimeter is enumerated and probed, never inferred from the case in front of you.*
> Every host in it is one somebody reached; every host outside it is one nobody has.

## 12. An answer budget that could truncate the answer - low, **fixed**

**What broke.** The assistant's reply limit was a constant sized for one engine, applied to both.

**The fix.** Sized per engine, and the panel says when a reply was cut rather than presenting a
truncated answer as a whole one.

> **The rule.** *A limit reached in silence is indistinguishable from an answer.* Say it.

## 13. A ledger row that stood for a whole file - process, **fixed**

**What broke.** `asynccheck` recorded «this file has unread scopes», so converting nine of eleven
moved nothing and the grid kept calling the file covered. One boolean, two truths.

**The fix.** The row is now «the Nth scope of this shape in this file», the ceiling falls with every
conversion, and a run that grows the ledger says so. 93 scopes at the start of the day, 30 now.

> **The rule.** *If a cell cannot be represented by one boolean, split it until each one can.* This
> is the day's principle, and it was learnt on the instrument rather than on the product.

## 14. Method, five lessons that cost time - process

- **When a report says «sometimes», or when two fixes have already failed, the next action is an
  instrument.** Zoho One was diagnosed in one round once the panel printed `ctx tab=… frames=[…]
  asked=… -> ok|NOT READY`, after three rounds of reasoning about it. Hosts and ids only, never a
  portal name.
- **A numeric ceiling ages into a floor.** Any ledger with a limit needs its direction printed, or
  the number becomes the target instead of the bound.
- **A heuristic that looks one level deep cannot answer a transitive question.** «Is this reachable»
  is a closure, and computing one level and calling it an answer produced two wrong verdicts.
- **A stub that answers the wrong question makes working code look broken.** A fixture returning a
  shape the caller never asks for sends the reader into the caller.
- **A declaration lifted out of a chain goes to file level.** Twice it was placed inside the wiring
  function it came from, and twice the lifters could no longer see it - the line of the match is not
  the start of the statement.

## 15. Links to anchors the document does not contain - medium, **fixed**

**What broke.** «Un link che non porta da nessuna parte non è un link e non deve esistere.
Altrimenti l'utente clicca per sempre e pensa che ci sia qualcosa di rotto.» Reported with a dead
link pasted in: `#v-<id>`, from the Zoho Analytics report. The link was decided by asking whether a
name is a view in the org; the anchor exists only for the views that get a heading of their own -
tables and query tables - so every report and dashboard named in a cell pointed at nothing.
Unticking a chapter is a second route to the same place: the anchors go and the links stay.

**The fix.** The set of anchors the document will actually contain is derived from the same sections
the body is drawn from, and a name outside it stays plain text. `tools/probe.py` builds the report
against the sample in every scope and fails on any href with no target; with the fix reverted it
reports seventeen. The Zoho CRM report was measured across all thirteen scopes and is clean - and
the case that guards it says so, and says that two plants failed to make it dangle, because a guard
that has never fired is not the same thing as a proof.

> **The rule.** *Two questions that sound alike are not one value: «does this exist» and «is it in
> what I am producing».* Every generated document that links to itself has this pair, and they part
> company the moment anything is filtered.

## 16. Nothing looked clickable, and something that was not looked it - medium, **fixed**

**What broke.** With the dead links gone: «non si distingue cosa è cliccabile e cosa no». Two halves.
The link styling was written per context - the reference lines, the index, the workflow actions - so
a link written anywhere else rendered as ordinary black text. And the first column of every table was
painted the accent colour whether or not the cell was a link, so where the two met the colour said
nothing at all.

**The fix.** One rule for the whole body, underlined as well as coloured - colour alone is not an
affordance for a reader who does not see this one - and the colour taken off the column. A case
fails if any non-anchor rule borrows it.

> **The rule.** *Style a role, not a place.* A rule written per location covers the places that
> existed when it was written, and every later one silently opts out.

## 17. A filter with no rule anyone could state - medium, **fixed**

**What broke.** «La feature per fare la ricerca testuale non si capisce minimamente su cosa agisce.
Alcune cose le filtra e altre no. Sarebbe meglio toglierla se non si riesce a dargli un comportamento
coerente e comprensibile.» It hid elements carrying a `data-name` attribute, which some rows had and
most of the document did not.

**The fix.** It hides any row, list entry or card that does not contain what you typed, judged on
visible text, leaving the index alone - and the placeholder says that instead of naming chapters it
does not restrict itself to. The conclusion offered with the report was the right one and is worth
keeping: a control nobody can predict is worse than no control.

> **The rule.** *A control that cannot be described in one sentence should be made describable or
> removed.* «It filters some things» is not a feature, it is a bug with a text box.

## 18. A finished pull that looked hung - medium, **fixed**

**What broke.** After a Pull all: «Rebuilding the list…» with the spinner turning, indefinitely.
It had finished. The rebuild's own message is a *busy* line, and when there was nothing to append to
it - no refusal, nothing skipped - nothing ever replaced it. From outside, a finished operation
showing a spinner and a hung one are the same thing.

**The fix.** The summary the last area wrote is held across the rebuild and put back, and the note is
appended to that rather than to whatever the status happens to say. The twin already did this right,
which is the tell: Zoho Analytics ends on its own summary, always.

> **The rule.** *Every operation ends on a line that says it ended.* A busy message is a promise of a
> next one, and a promise nothing keeps is indistinguishable from a hang.

## 19. The probe drove the function, not the button - process, **fixed**

**What broke.** Finding 18 should have been caught: the browser probe drives a pull. It called
`pullAll()`, which is the *functions* pull; the button the user presses is `pullEverything()`, and
the defect was in the tail of that one. The scenario had never executed the control it was named
after, and the plant proved it - the defect was put back and nothing failed.

**The fix.** Both pull scenarios now assert that a finished pull leaves no spinner behind, and the
gap between «the function a control calls» and «the control» is the thing to look for next time.

> **The rule.** *Drive the control, not the function behind it.* Everything between the click and
> the call - the wiring, the guards, the tail nobody re-reads - is exactly where the defects that
> reach a user live.

## 20. A stub that made a branch unreachable - process, **fixed**

**What broke.** Measuring whether the Zoho CRM report has dead links, across every scope: it did not,
in any of them. The fixture could not produce one - `isFnAction: () => false` in the test's globals
meant no workflow action ever resolved to a function, so the cross-references the check was about
were never emitted. A green sweep over a document with no links in it.

**The fix.** The real one-liner, lifted from the panel. The measurement then meant something, and the
answer stayed «clean» - which is a different sentence from the one before it.

> **The rule.** *A stub is an assumption with a return value.* When a check comes back clean, ask
> what the fixture had to be able to do for it to come back dirty - and if it could not, the check
> proved nothing at all.

## 21. Comments that ship inside the reader's document - low, **fixed**

**What broke.** The report's stylesheet carries its own comments, and those comments travel into
every exported file. Two of them named the other product and one quoted Ivan in Italian - caught by
`namecheck` and `langcheck` on the same run, which is the only reason it was caught at all.

**The fix.** Neutral English in anything inside `REPORT_CSS`.

> **The rule.** *Know which of your comments are shipped.* A comment inside a template literal that
> becomes a user's file is not a note to the next maintainer; it is product copy.

## 22. The check that only runs when nothing else is wrong - high, **fixed**

Written up as finding 1b above, and repeated here because it is the day's most expensive lesson:
`set -e` turns the *order* of a battery into which answers exist. The check that executes the
product ran last, so on any day something else was red it did not run at all - and that is the day
you most want it. It runs third now, and a case derives the ordering from the file.

## 23. Every async scope in the tree is now a named declaration - process

Not a defect: the end of a migration that started at 93 unreadable scopes. `.then(cb)` and
`= async () => {}` are scopes the race checker cannot enter, so the awaits inside them - and every
global written after those awaits - were unread. The ledger is at zero, and the tool reads 964 of
964 awaits.

Two things fell out of finishing it. The tool's headline said «10 NOT read» beside a ledger at zero,
because its crude denominator counted the word `await` **in comments** - and the comments explaining
the conversions talk about little else. And correcting that found the last real gap: `async
function* walk(d)`, the folder walk in both panels, was invisible because the pattern required a
space after `function`.

> **The rule.** *When two counters in one tool disagree, one of them is lying and it is usually the
> crude one - but check which before you believe either.* A denominator that counts prose is worse
> than no denominator: it manufactures a gap that hides the real one.

## 24. Eighty-six bets on how long a panel takes - process

The browser probe waited by sleeping: click, sleep, read, ninety-two times over. That is the shape
this repository condemns in the product, living in the tool built to catch it.

They are ten now, five of them the polling step inside `until`. Not by naming a condition
seventy-six times - by naming the one they all shared: watch the document, and continue when it has
been quiet for a moment.

> **The rule.** *When a rule is broken in eighty-six places, look for the one condition all of them
> are approximating.* Eighty-six edits is a project; one shared condition is an afternoon.

## 25. Five outside scans, and what they cost to check - process

Five subagents read the two panels, the checkers, the public surfaces and the two reports, each with
no memory of why any line is as it is. Eleven findings survived verification here; several did not,
and the ones that did not were confident, specific and wrong in a detail that only reading the code
settles.

The one worth the whole exercise: **the Zoho CRM report's health chapter names functions the reader
unticked, and links each to a chapter that was never written.** Twelve hours earlier I had reported
that same report as measured clean across all thirteen scopes. It was - against a fixture whose node
had `dead_suspect: false`, no unresolved calls and no stats, so no health list could ever be
non-empty and the linking function was never called. The measurement was real and proved nothing.

> **The rule.** *A sweep that cannot produce a positive is not evidence.* Before believing a clean
> result, make the subject dirty on purpose and watch it go red - and if you cannot, say that instead
> of «clean».

Three of the findings were claims about where data goes - a privacy absolute, a line in `llms.txt`
saying the panel posts a report it never posts, and both store listings' scripting justification
naming two of its four uses. All three were written when they were true and outlived the code.

> **The rule.** *A claim about behaviour ages the moment the behaviour is extended.* The extension
> that added a use is the change that should have re-read every sentence describing the uses - the
> enumeration trap, running on justifications rather than features.

And three checkers were reporting zero over part of their subject: a `<script>` tag pattern that
dropped a file if it carried a second attribute, a write pattern that knew `=` but not `+=` or `--`,
and a declaration pattern anchored at column zero that swept none of the 54 functions inside the two
content bridges. Each is the same class this repository has already named twice, in a different tool
each time.

> **The rule.** *When a pattern is corrected in one checker, grep for the pattern in the others the
> same day.* All three of these were the identical regex, copied.
