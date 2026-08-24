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
