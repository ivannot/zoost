# CLAUDE.md

Working notes for this repository. Conventions, decisions already taken, and traps already hit.
Read this before changing anything.

## Where the rest of it is

This file was 280,000 characters against a limit of 150,000, which means half of it was not being
read and nobody could say which half - the failure this repository spends its length preventing,
happening to the file that describes the preventing. Nothing was cut. What is *always* true lives
here; what is true *about one thing* lives beside it, and this is the index that says when to open
each. **The rule is the same as everywhere else: if you are about to touch one of these areas, read
its file first.** A rule you did not read is a rule that gets broken and then re-learnt.

| file | open it |
|---|---|
| [`docs/layout.md`](docs/layout.md) | before adding a file, a folder or a second product - and before changing where a workspace puts anything on disk. Includes the checkers that hold the two apps together, and how to run them |
| [`docs/decisions.md`](docs/decisions.md) | before changing what a pull captures, how a workspace sits on disk, or what happens when Zoho refuses. The one that answers «why is it like this» about the mirror itself |
| [`docs/diagrams.md`](docs/diagrams.md) | before touching either drawing: what the call graph and the ER model contain, what the filters and the focus mean, how a layout is chosen and what it is allowed to cost |
| [`docs/fixtures.md`](docs/fixtures.md) | before changing what `+ Sample` writes - and before touching any picture on the site or the Store, because every one of them is rendered from **the workspace `+ Sample` delivers**, through the shipped panel |
| [`docs/panels.md`](docs/panels.md) | before rearranging the chrome, the tabs, a settings form or a second window - and for what the Zoho Analytics data model actually exposes, measured rather than assumed |
| [`docs/assistant.md`](docs/assistant.md) | before changing what the assistant is told, what it may read, or anything touching the API key and the passphrase that protects it |
| [`docs/boundaries.md`](docs/boundaries.md) | before touching anything that crosses one: the hook in Zoho's page, the bridge, what a message is allowed to cause, what the assistant may reach, what «read-only» means and where it is enforced |
| [`docs/findings/`](docs/findings) | before acting on any review of this codebase, and after finishing one. A dated note per sweep - what broke, what was done, and the rule that stops it coming back. `2026-08-13-outside-audit.md` is the worked example of «evidence, not a verdict» |
| [`docs/traps.md`](docs/traps.md) | when something does nothing and says nothing. Every entry in it failed silently once |
| [`docs/naming.md`](docs/naming.md) | before writing anything a user or a reviewer can read: the product names, the site, the translations, and the checks that hold them |
| [`docs/releases.md`](docs/releases.md) | when something in the chain misbehaves - Cloudflare, the Store API, the workflows, the attestations. The routine itself is below, in this file |

**Before adding anything here, ask which of the two it is.** A rule that binds every change - a
non-negotiable, a step of the definition of done, how to work with me - belongs in this file. A rule
about *one area* belongs in that area's note, where it will be read by whoever opens it and by nobody
else. Writing it here because it is fresh is how the file got to 280k: nothing is ever wrong in the
moment it is added, and the cost lands on a session months later that reads half a file.

**Measure the instrument before you believe it about the product.** A generated org of 5,000
functions - `node tools/bigorg.mjs <dir> 5000`, which replicates what the shipped sample generator
writes - said the panel took forty seconds to open. It did not: `tools/fsshim.js`, the render
harness's in-memory file system, resolved every path by scanning all 10,000 of its keys, and the
whole of those forty seconds was there. The panel was blamed twice before the tool was measured.
**A slow tool does not look like a slow tool; it looks like a slow product.**

What the same benchmark then measured, honestly: opening a 5,000-function workspace cost **60,015
file-system calls**, of which 40,000 were the call graph being built speculatively for two numbers in
a badge. It is **8** now - `functions/meta-index.json`, written by the pull and checked against the
folder walk on every load - and the badges wait to be asked for above `STATS_LIMIT`. The numbers that
matter are the *calls*, not the milliseconds: the harness cannot model what the File System Access
API charges per file, so the only honest claim is the shape. **Whether a real org of that size is
comfortable in a real Chrome is still unmeasured**, and saying otherwise would be exactly the kind of
green light this file exists to refuse.

**The summary cache (`functions/meta-index.json`) has its own history of three defects and the
discipline they earned - one writer, marks cleared only on a successful write, Refresh distrusting
everything.** It lives in [`docs/decisions.md`](docs/decisions.md) under «The summary cache», because
it is true about one area; what is always true stayed here: **for every fast path, write the test
that tries to make it lie before you write the fast path** (`tools/probe.py` holds those tests), and
**invalidation must derive from the event, never from the memory of whoever caused it** -
`noteWrite(rel)` maps what was written to what must be forgotten, reached from `writeFile` and
`removeFile` both, so a write path added tomorrow inherits it. `tests/panel.test.mjs` derives every
`*Cache` in the shipped scripts and fails when one is named by no test.

**An intermittent defect is a sequence, so record the sequence - do not sample it and never deduce
it.** A row selected by a jump was not scrolled into view «sometimes»; it took **five** changes to
the panel, each reverted, before anybody wrote down what actually happened in what order. When that
was finally done - wrap the function that scrolls, put a `MutationObserver` and a `ResizeObserver` on
the box, number every entry - the answer was one line long:

    list drawn -> reveal: box 401..777, row 424, INSIDE, does nothing -> pane opens -> box 401..469

The reveal was running and was **right**; then the detail pane opened, the list went from 376px to
68px, and nothing revealed again. Whether the row was still on screen depended on where the scroll
happened to be, which is what «random» is. The event nobody had named was not «the list has been
drawn» - every one of the five attempts aimed at that - it was «the pane has opened».

Three rules come out of it, and the third is the one that costs the most to learn:

- **Sampling at chosen instants is not measuring.** «Read `scrollTop` after a second» is the 1990s
  junior's `sleep`, and it produces a fix of the same shape - one that waits instead of knowing.
  Reported that way by the author, and he was right. Record events in order; the causality is then in
  the data instead of in your head.
- **A guard that skips when the thing is absent is not a guard.** The first check here read the row's
  position *if there was a row*, so it passed on exactly the case it was written for. Absence is the
  finding.
- **Every change made before the sequence existed was wrong, and every change made after it was
  right.** Not most: all of them, five against three. When a report contains the word «sometimes»,
  the next action is an instrument, never an edit.

**And a mechanical replace decides which call sites it hits - twice it decided wrong.** Both times the
helper being introduced *contained the pattern being replaced*, so the new function was rewritten
into a call to itself, and both times every unit test passed because nothing executes it: the browser
caught it. Insert the helper **after** the replacement, and read the count it reports - «7 sites» when
grep said 6 is the defect announcing itself.

**Before saying «done», read the code the way somebody who did not write it would.** Five outside
scans in one day found twenty-two real defects in code that was green - 530 tests, every checker at
zero, the probe passing. Not one was subtle. They were missed because the author reads a diff for
confirmation that it works, and a reader with no intention reads it for how it breaks; those are
different activities, and the second one has to be *performed*, not hoped for.

So it is a step, not an attitude: **spawn a subagent per area touched, with the fixed prompt below,
then verify every finding yourself before reporting it.** A fresh subagent has no memory of the
session - no knowledge of why a line is as it is, which is exactly the knowledge that hides the
defect. What it cannot do is remove the *model's* blind spots: it shares them. It reduces what
reaches an independent review; it does not replace one, and saying otherwise would be the false
reassurance this file exists to refuse.

The six questions, each earned by a defect that shipped:

- **What global state is written after an `await`?** The folder can change under an operation, and a
  check between two effects protects the first one only - one save left the source in one workspace
  and its metadata in the next.
- **Who else owns this flag?** `pullActive` was set by five pulls and consumed by one, so a change
  arriving during the other four was remembered and never answered.
- **Is this constant shared by uses with different parameters?** One page bound served walks reading
  50 and 200 a page: a thousand functions on one side, eighty thousand rows on the other.
- **Which exit says nothing?** A silent bail is indistinguishable from a working feature, and one of
  them cost an evening - the hook was bowing out of every page and nobody could see it.
- **Does partial data authorise a destructive act?** A list that stopped early was written as the
  index and everything missing from it deleted, in two pulls, in two files.
- **What survives a change of workspace?** A queue of relative paths followed the reader into the
  next org and tried to delete a file there.

Two rules about the list itself. **The seventh question will be written by the next defect nobody
predicted** - add it the day it happens. And where one can be *derived*, derive it: «every walk that
reads 200 a page counts against the wide bound» is a test that reads the requests, and it will hold
when the prose has been forgotten.

**Six reviews found the same defect six times, and the way out was not a seventh fix.** A value read
from Zoho or from disk, an `await`, then a write into a module-level variable - by which time the
workspace on screen may be another one. Each instance was fixed where it was found and reported as
closed; the next review found the next one, in a function that did not resemble the last. That is
what a rule living only as prose does: it is recalled by resemblance to its own wording, and the
seventh instance never resembles it.

`python3 tools/asynccheck.py` derives the instances instead - every global written after an `await`
with no check in between, per panel - and it is a ledger like `tools/cssdupes.txt`: 59 sites are
recorded as read, anything new fails, and **the ledger may only shrink**. It earned its place on the
first run by finding four real ones *and* a fix I believed I had applied and had not: a Python
edit script had died on an assertion before writing the file, so the function was untouched while
the commit message said otherwise. The class this belongs to is the one this file already states -
**a check that runs is worth more than a claim that was made** - and the specific lesson is narrower:
an edit applied by a script is not applied until something that reads the file says so.

What it cannot do is written in its own docstring rather than left to be discovered: it is
line-based, a global written after an await is not automatically wrong, and it says nothing about
*what* a guard checks. That is why it is a ledger and not a gate.

**And every so often, sweep rather than check.** The battery answers questions somebody thought to
ask; a sweep asks what nobody has. Two commands, neither of them a gate: `python3 tools/deadcode.py`
lists what is declared, styled or marked up and used by nothing - candidates, never verdicts, because
a name built at run time looks identical to a dead one - and `python3 tools/samplecheck.py` (which
*is* in the battery) holds the sample page to what `+ Sample` actually writes. The first sweep of this
kind found a raw NUL byte in a shipped file that had been making `grep` skip 31KB of it in silence,
two dead functions, a helper copied to a product that cannot call it, and a table on `try.html` that
did not add up to its own heading. **Read every line before acting**: that same sweep also "found"
seven numbers that were right, by counting `fixtures/` - the edge-case tree - instead of the sample a
reader receives, and putting them back cost more than the real findings.

**The room left is printed on every run: `python3 tools/notescheck.py`, and it is in `tests/run.sh`.**
The budget is 100,000 characters, two thirds of the 150,000 at which this file stops being read. It
fires early on purpose - splitting a topic out and giving it an index row takes judgement, and a gate
at the limit itself would fire only after content had already been dropped in silence. **When it goes
red, move a topic into `docs/`; never raise the budget.** That is the one-line fix that would put this
back where it was, and a test holds the budget under three quarters of the limit so it cannot creep.

---

## What Zoost is

Zoost mirrors what you have built inside a Zoho product into plain local files, then layers
navigation, diagrams, search, audit and export on top of that mirror. The premise is the same for
every product it covers: **you built it, it is yours, and the platform gives you no way to see it
whole.**

- **Zoost for Zoho CRM** (`apps/crm`) — Deluge functions, module schema, layouts, related lists,
  workflows, schedules, connections.
- **Zoost for Zoho Analytics** (`apps/analytics`) — workspaces, tables, query tables, reports and
  dashboards, their lineage, and what nothing depends on any more.

Every one of them is **read-only towards the platform**. They never write back, and never touch
customer records.

## Build

```bash
./build.sh crm          # dist/zoost-crm-<v>-store.zip     manifest at archive ROOT — for the Web Store
./build.sh crm --unpacked  # dist/zoost-crm-<v>-unpacked.zip  folder-wrapped — for Load unpacked
```

Getting these the wrong way round wastes half an hour: the Web Store rejects a zip whose manifest
is inside a folder, and `chrome://extensions` wants the folder.

## Non-negotiables

- **No write path to Zoho.** Zoho compiles and validates server-side. A write path means owning
  deployment, conflicts and rollback — a different product.
- **No dependencies, no build step, no framework.** Plain JavaScript. The extension ships as
  readable source and must stay auditable by anyone about to give it access to their CRM.
- **Both manifests declare a content security policy**, and it may only ever be tightened:
  `script-src 'self'; object-src 'self'; base-uri 'self'; form-action 'none'`. The first two are what
  MV3 enforces regardless — writing them down is the point, because this was the one security decision
  the project left implicit while every other one is stated. The last two are stricter than the default
  and free *today*, which is the condition to keep checking: a `<form>` or a `<base>` anywhere in a
  shipped page would silently stop working, so `tests/tools_test.py` asserts neither exists. Chrome
  refuses a manifest that relaxes `script-src` or `object-src`, so the failure mode of a careless edit
  is a release that will not load — the test catches it first.
- **No new `manifest.json` permissions** without discussing it first. Every one has to be
  justified to the Web Store and to users, and the justification text lives in `store/`.
- **Zoho CRM does keep version history for a Deluge function**, one function at a time, and the site
  used to imply otherwise with "Your history, your Git". What Zoost adds is the org in one place — a
  diff across every function between two points, branches, review — and the `git init` step is
  **optional**: without it the mirror is still ordinary files. Corrected on both product pages, the
  README and the Store copy. It was the author who noticed, which is the failure: nothing can check a
  claim about what another product does, so this is the class where reading remains the only method.
  **And the correction itself was incomplete, which the author also had to notice.** «It gives you the
  versioning, comprehension and audit that the editor does not» survived on `crm.html`, in both guides
  and in `README.md` — four surfaces, three paragraphs below a block that had just been rewritten to say
  the opposite and correct thing. This is the enumeration trap running backwards: a *claim* is repeated
  in as many places as a feature is, so correcting one and not grepping for the rest leaves the page
  contradicting itself. Grep the claim, not the paragraph.
  The heading above it had the same shape of defect twice over: «Read-only, on purpose» was the absolute
  this project walks back, and «Read-first, on purpose» — its replacement — promises a second step that
  does not exist, since reading is all there is. It is **«Not an editor, on purpose»**, which is what the
  paragraph was always about.
- **Never ship a claim that has not been tested.** Only Anthropic and OpenAI are supported as AI
  engines, because those are the two that are tested and the only two the manifest grants network
  access to. An untested feature is worse than a missing one.
- **Never add data fetching without the UI that shows it**, and never add UI for data that is not
  fetched. Dead code in either direction is not acceptable.
- **No legacy fallbacks left lying around.** When something is renamed or replaced, the old path
  goes. Migration code is written to delete itself.
- **Do what you're certain of, or stop — never click-and-hope.** No retry loops against an
  assumption, no matching Zoho's *localized* UI text, no synthetic clicks into a DOM contract we
  do not own. Reach Zoho by constructed URL and read it through the API; if a certain path does not
  exist, the feature stops with a precise message instead of guessing. This is why the function
  "Go to" (which drove the Zoho editor via synthetic clicks on a localized "Edit function" label,
  and looped ten times before failing with a wrong message) was removed in 1.1.0. "Find" navigates
  to the functions list and filters it deterministically — the last, language-dependent click is
  the user's. Legitimate exceptions the rule still allows: a *bounded* wait for a known element to
  appear after a navigation, recovering by a known action (re-injecting the bridge), handling known
  API variants (OpenAI `max_tokens` vs `max_completion_tokens`), and one retry on a genuinely
  transient failure (network, 429, 5xx) — never on a deterministic 4xx.

  **This rule binds the extension absolutely; the website is judged differently.** The extension is
  where work happens: someone acts on what it says, so an uncertain answer there can cost real time
  or real data. `zoost.it` is informational — if a number goes missing the page says "unknown" and
  nobody is harmed. So the site may depend on a source we do not control, provided the dependency
  **fails visibly and cannot lie**: validate the shape of what came back, discard anything that does
  not match, show "unknown" rather than a stale or guessed value, and cache so a blip is invisible.
  Never carry this licence back into an app under `apps/`.

  **The licence was being spent on a scrape, and it did not have to be.** The badge read the Chrome
  Web Store listing's markup for a `class="nBZElf"` span, on the belief that Google published no API
  — a claim about another vendor's product that nothing here could check, which is the class this
  file already flags as the one where reading the documentation is the only method. **V2 exists**:
  `publishers.items.fetchStatus` reports the published revision and the submitted one, each with a
  state, read through a service account and a token minted for `chromewebstore.readonly`.

  **That used to read «a credential that can read our items' status and do nothing else to them», and
  it was false.** Google links a service account to a publisher to «manage items owned by your
  publisher account» - one per publisher, no narrower grant offered - and the scope is chosen when the
  token is minted, so read-only is a property of **what this Worker asks for** and not of what the key
  may do. Measured rather than argued: `python3 tools/cwsscope.py <key.json>` mints a token for the
  full `chromewebstore` scope from that same key and the API answers with the item. **Every key of
  that service account is a publishing credential**, the one in Cloudflare included. The account is
  called `zoost-store-reader`, which is a label and not a permission - and only one service account
  may be linked per publisher, so that slot is spent and the name stays.

  It also took two passes to correct, which is the part worth keeping: the fix reached
  `site/_worker.js` and not this file, and was reported as done. **Grep the claim, not the paragraph**
  - already written here, about a different claim. Three gains, and the third was invisible until
  the API made it expressible: the DOM contract is gone, «in review» is Google saying so instead of a
  row typed into `RELEASES.md` after clicking Submit, and a **rejected** submission can be stated at
  all. Without a state a refusal is indistinguishable from a queue, so the badge would have promised
  «awaiting review» about a version Google had already turned down, for ever.

## Definition of done

A change is not finished when the code works. It is finished when everything that describes the
code has caught up with it. **Do this without being asked** — never wait for me to request a
documentation update or a build.

### Documentation must follow the code, in the same change

When behaviour, UI or features change, check every one of these and update what is stale:

| File | Update when |
|---|---|
| `apps/<app>/manifest.json` | the `description` (max 132 chars) — it is what Chrome shows on the extensions page **and** the Store's short description, so it is the most-read sentence the project has. Keep it identical to §2 of `store/<app>/store-listing.md` |
| `README.md` | features, interface, quick start, known limitations |
| `site/index.html` | the **suite** home: what the products share, and the card for each. A new product means a new card and a new page |
| `site/try.html` | the sample workspace as the trust argument: what it contains, what it refuses, what it does not prove. A change to what `+ Sample` writes changes the counts on this page |
| `site/crm.html`, `site/analytics.html` | the **product** pages. One per app, same structure and voice: why it exists, what's inside, what it does *not* do, get started. A feature landing in an app lands on its page in the same change |
| `site/docs-crm.html`, `site/docs-analytics.html`, `site/how-to.html` | anything a user does differently. **A control drawn as a mark is shown as that mark in the guide**, inside the `b.ui` chip and next to its name — a guide that spells out a word the panel no longer shows is one the reader has to translate, and it is read by people who are not developers. The version line above it (`Covers Zoost X …`) is filled from `/api/versions`, so it always states which version the page describes; the number in the markup is only the fallback. The two guides must also *look* alike: a class copied from a page that defines it renders as nothing on one that does not — `td.p` and `.note` came from `privacy.html` and left the Analytics guide's term cells unstyled. Check with the one-liner below |
| `site/privacy.html` | what data is stored, or where it travels, changes at all |
| `store/<app>/store-listing.md` | description, single purpose, or any permission justification. **Each app has its own**, and both are published |
| `CLAUDE.md` | a new convention, decision or trap that the next session must know |

Two rules that are not optional. **Never let a claim outlive its truth**: today the store
description still said the extension "never sends your code anywhere", which the AI assistant made
false. And **never describe a feature that is not tested** — the OpenAI-compatible endpoint claim
was written before anyone had tried it, and had to be walked back everywhere.

A third, just as binding. **Declare only what we have; have everything we declare — on every surface,
on adding *and* on removing.** This is not tidiness, it is the product's claim to being correct and
transparent. Catching it is **your** job, never the user's.

Mentioning a feature once is not enough, and it is the trap that has actually been hit here twice.
Every surface enumerates the product's parts in several places — a meta description, a hero
paragraph, a "whole org at once" list, a feature card, a quick-start step, a mode-segment list, a
pull description, an export-scope list, a stored-data table. **A new part must appear in every list
its siblings appear in**; a removed one must disappear from all of them. Connections shipped in
1.3.0 mentioned in two places while Functions/Modules/Workflows/Schedules were enumerated in nine —
that is the product lying by omission about its own shape.

So do it mechanically, not by memory. When a capability lands or is cut:

```bash
# every place a sibling is enumerated is a place the new part probably belongs
grep -rn "schedules\|Schedules" README.md site/ store/     # pick any established sibling
```

Walk each hit and decide — include, or consciously not. Then the reverse pass: read each surface top
to bottom and check that every claim on it is still true of the code (verify in the source, do not
assume). Do this across `README.md`, `site/index.html`, `site/docs-crm.html`, `site/privacy.html` (what
is stored and where it travels) and `store/<app>/store-listing.md`. Only then is the change done.

If a change touches what data leaves the machine, `site/privacy.html` and the Web Store data
disclosures are not optional follow-ups. They are part of the change.

### Anything shown in the UI must also be in the reports

**Every piece of information the panel shows about an item belongs in the HTML and Markdown exports
too.** The exports exist so someone without the extension sees what you see; a number that lives
only on screen makes the report a lesser, quietly incomplete copy — and the person reading it cannot
know what they are missing. When you add a column, a badge, a chip or a line of detail, add it in the
same change to `buildExportHtml` **and** `buildExportMarkdown`, and to the AI context if it helps the
model answer about it. The reverse also holds: nothing in a report should be invented there.

### Numbers are exposed, never interpreted

When surfacing a measurement (size, counts, usage), give the reader the number and what it counts —
not a verdict. No thresholds, no red "too big", no "worst offenders", no quality score. Length is
verbosity, not complexity; a long function may be a clean mapping table and a short one may be a
minefield. State plainly what a metric does **not** capture, the way the health audit states its
coverage gaps, and let the user decide how to read it. We inform; we do not grade their work.

### What to produce, by size of change

### Tests

```bash
bash tests/run.sh          # unit tests, the three checkers, and both builds
```

**No framework, no dependencies, no build step** — node's own runner and Python's `unittest`, both
already present on any machine that can build this project. A suite needing `npm install` would be
the first dependency in a repository whose pitch is that it has none.

**Every case is a bug that actually happened.** A test written from imagination tests the
imagination; these were lifted from the throwaway checks run while fixing real defects — the Deluge
comment/string scanner, which CSRF cookie belongs to which family, staleness derived per area,
reading an annotated tag out of an Atom feed, the shape guard on what the Store reports. **The checkers are
tested too**, and that is not ceremony: two of the three shipped broken on the day they were written,
and a broken checker reports success over the thing it exists to catch, which is worse than none.

**A test written from the same premise as the code cannot fail on it, and a fixture with one source
cannot show a defect between two.** Both halves happened in one day. «Outdated» was decided by
`row.listUpdated !== meta.updatedTime` - an epoch in milliseconds from the org *list* against a
formatted string from a function's *detail*, so every function in every real org was outdated for
ever. It shipped with two tests, and one of them asserted that exact expression with a regex: written
from the same belief, it could only confirm the belief was still spelled the same way. Nothing in the
sample could contradict it either, because the sample's `index.json` carried no `updatedTime` at all
- one source, so no pair, so no mismatch. It was found by a user, on his own org, the next morning.

Three rules, and the third is the general one. **Assert the behaviour on real values, never the
expression** - `movedInZoho(1773397259000, '2026-03-13 11:20:59.0')` is a case; `/a !== b/.test(src)`
is a photograph. **A fixture must carry every source the code compares**, or the comparison is
untested by construction. And **when a value crosses a boundary, the two sides are two shapes until
something proves otherwise** - this repository has now met that class four times: the `\x1e` record
separator, the CSRF cookie family, the `.dg`/`.meta.json` pair, and this. The fix is never to parse
one into the other on the machine you happen to be on: it worked here, and would have failed for
anyone whose browser sits in a different timezone from the org. Store the same kind of value on both
sides and compare like with like.

**A check worth running once is worth keeping.** Verifying a fix by hand — the `node -e` throwaway,
the loop that tries five inputs — is already writing a test; the only difference is whether it
survives the session. It goes into `tests/` before the commit that fixes the thing. No ceremony and
no separate task: if a defect was worth reasoning about, the reasoning belongs where it can run
again. The suite grows by the bugs we meet, which is why it has teeth.

**One message, one place - and the panel said the same sentence three ways in ten sites.** «Se
proliferano le funzioni duplicate è la fine», and a *message* written out twice is that defect one
layer down: the two copies are one careless edit away from disagreeing, and nothing would say so.
Measured on the tree before the fold - a quoted literal, never a template chunk, starting with a
capital and containing a space - **39 clusters across the 22 shipped scripts**, 25 of them in
`apps/crm/sidepanel.js` alone. The worst was not the count: a lapsed folder permission was reported
as **«needs re-granting» (x5), «denied» (x3) and «not granted» (x2)**, so one browser behaviour
arrived as three different problems, one of which - «denied» - names a state with no action in it.
They are one sentence now, **`Folder access needs re-granting - click ↻ Refresh.`**, which names the
control that fixes it; `requirePerm()` throws it in **both** apps, because the same helper wording
the same fact differently per product is the drift the twin rule exists to stop.

Everything else folded into a `const MSG = {…}` per file - the two panels, both graph windows, the
Analytics options page - plus `engineLabel()` for the `'anthropic' ? 'Anthropic (Claude)' : …`
ternary that both options pages carried twice, and plain data constants in `sample-org.js`, where
the repeated strings are a fixture author and a workflow trigger rather than messages. The health
audit's seven section titles were duplicated between the panel's view and the HTML export, which is
exactly the pair that must not drift, since a reader moves between the two.

**The check is `tests/panel.test.mjs`, it globs `apps/*/*.js`, and it has no allow-list.** That is
the load-bearing part: the file set is derived, so a script added tomorrow is covered without anyone
remembering, and there is no exemption map to become a checklist wearing a script's clothes - the
two failure modes this repository has already recorded. The criterion was tuned by measuring rather
than argued: on the folded tree it reports **zero** across all 22 scripts, so every future finding is
real. It reads literals inside `${…}` interpolations (that is where both options pages' engine
labels were hiding, invisible to the first pass), decodes escapes so `'…'` and `'…'` are one
message, and skips comments - outward the rule never bends, between us it can. Proven by
reintroducing a duplicate in `sidepanel.js` and in `options.js`, and by drifting the twin wording by
one verb: three findings, one each.

**What it does not catch, said rather than left to be found.** A fragment starting lowercase -
` - click to retry` was duplicated three times beside `Failed: ` and is folded, but nothing here
would have found it. A message built by concatenation, which is not one literal. And the same
sentence in two *files*: only the folder wording is held across the twins, by a case of its own.
Extend the check when one of those bites; do not extend the care.

**The fold found a live bug through the suite, which is the argument for the suite.** `MSG.errPrefix`
landed inside `friendlyError()`, which `tests/keyvault.test.mjs` lifts and *runs* in a bare context -
a ReferenceError three lines in, `node --check` perfectly happy, exactly the free-variable trap
already recorded above. The lifters now take the panel's `MSG` block with the function, reading the
wording from the shipped constant instead of restating it. Both panels and both graph windows were
then re-rendered headless through `tools/shots.py` (11 shots, all ok) and both options pages loaded
in headless Chrome with zero console errors - because a scope bug is only ever found by running.

**The panels are not restructured to be importable.** `tests/slice.mjs` lifts a named function out
of a browser script and runs it alone; refactoring 3000 lines of DOM-bound code *in order to* add
tests would spend the risk before earning the cover. The limit is stated rather than hidden: this
proves the logic, not the wiring — a correct helper called from the wrong place still passes. If
`sliceFn` cannot find a function it **throws**, so a rename cannot silently drop the cover.

**And what it lifts has to be a *declaration*.** `sliceConst` ends a `const` at the first semicolon
that closes a line, which for a multi-line arrow is its **first statement** - so the slice is short,
wrong and silent. A comparator written `const cmpVer = (a, b) => {…}` in `site/_worker.js` was cut
after one line, and the red mark landed three tests away, on `pickLatestTag`, which sorts with it. A
shared helper that a test will lift is a `function`; one-line arrows are fine as they are.

**A test appended below `unittest.main()` never runs, and the suite still says OK.** Six cases were
added to the end of `tests/tools_test.py` and `tests/run.sh` reported 78 passing while ignoring them;
`unittest discover` found 84. Nothing is wrong on screen — a number changes, and a number nobody
compares against anything is not evidence. The trailer is last in the file and two cases hold it
there, one reading the source for a class below it and one comparing what the loader collects against
what is written. The first version of the second shelled out to the same file and recursed until it
was killed, which is its own small lesson: a test about a suite reads the suite, it does not run it.

**A test that fails unreadably is half a test, and there is more than one way to get there.**
`assert.match` on a large haystack is one: it prints the whole `actual` into the failure, and node
19's TAP lexer dies on a multi-byte character split across a socket read. **A `#` in the message is
the other**: TAP reads it as the start of a comment, so `${app}: #${id} does not say it exports`
arrived as `analytics: ` and said nothing. Write ids as `id=exportmd`, and assert with
`assert.ok(regex.test(x), 'why')` whenever `x` is a slice of source. Both times the suite went
red, so the guard worked; both times whoever tripped it would have learnt nothing.

**`sed -i ''` corrupts a UTF-8 source on macOS, and it corrupts it silently.** Used to apply a
deliberate mutation while proving the check above, it mangled the panel's `\u00ab\u00bb` and arrows into bytes
that would not parse - and the resulting error looked exactly like the reporter bug being chased.
Mutations are applied from Python, which is what every working one in this repository already used.

**And `git checkout <file>` to undo one is still the trap this file already names.** It happened
again, in the same context - proving a checker - and it discarded real uncommitted work in the same
file. The rule was already written down: copy the file aside first and restore from the copy. Writing
a lesson down is not the same as having learnt it; the only thing that actually prevents this is
never typing the command.

**Prove a test can fail before trusting it.** Same rule as the checkers. Break the thing on purpose
— point the deluge token at the wrong cookie, set the staleness margin to zero, restore the tag
filter that dropped annotated tags — and confirm red, then restore. A suite that has never failed is
a claim.

**And prove it can pass, which is the half that was missing everywhere this was written.** A gate
that always refuses is not strict, it is broken, and it looks identical to a strict one until
somebody needs it. `release.sh` ran `auditcheck --offline`, which reports the skipped live comparison
as a *finding* by design — so the one step that is public and irreversible refused every run, over a
line nobody can act on, from the hour it landed until somebody tried to cut a release. It was never
noticed because a release gate is exercised once per release and there had not been one since. The
rule is mechanical: **a check that runs rarely gets both proofs on the day it is written** — red on a
planted defect, and green on the state it is actually meant to allow. `auditcheck --before-tag` is
that state, and four cases hold the difference between it and `--offline`.

**Any code change → nothing to package.** Local testing runs straight off the repository:
`chrome://extensions` → *Load unpacked* → `<the checkout>/apps/<app>`, or the synced copy `tools/totest.sh`
writes if the browser is on the other machine. Then hit reload after edits.
No zip, no reinstall. Just tell me what to look at and what should have changed.

**Commit messages carry no co-author trailer, and no attribution of any kind.** Not `Co-Authored-By`,
not a generated-with line, nothing. The repository's first 136 commits have none; nine acquired one in
a single session without being asked for, and they are on GitHub. The default the tooling suggests is
overridden here and stays overridden — **only Ivan decides what goes in a commit message.** Ask if you
think there is a reason; do not infer one.

**A selector is defined in one place, and `python3 tools/csscheck.py` refuses a second.** The rule
this repository kept re-learning: `.k`, `.card`, `.note` and `b.ui` were each written beside their
first user, and each rendered as nothing the day a second page used it. Prose did not stop it four
times, so the check does - it reads every stylesheet and every inline `<style>`, per document, and
reports a selector written twice (**duplicated**) or written twice with different declarations
(**divergent**, which is worse: a class meaning two things, and which one wins depends on which page
you landed on).

It is a ledger and not a red light, because on the day it was written 86 repetitions already existed
and a gate that always refuses is one nobody reads. `tools/cssdupes.txt` holds them with their places;
anything not in it fails, and so does a **new place** for something already listed - that hole was
found by planting a seventh copy of `.cta` and watching the first version let it through. **The
ledger may only shrink**: a line that no longer matches is a finding, so consolidating something
means recording it with `--accept` in the same change.

Two things it will not do for you. Moving a rule into `site.css` **changes what the page looks like**
whenever that rule was winning by order inside its own `<style>` - measured: consolidating all 58
shifted 5-20% of the pixels on six pages. And the four selectors that are *deliberately* repeated -
`:root`, `.btn.p:hover`, `.steps`, `.steps li`, which carry the product colour or a page's own list -
are declared in the tool with their reason. So: one selector at a time, `tools/pngsame.py` on the
before and after, and the ledger shrinks by one line. The first pass did exactly that for `.toc` -
thirty copies into one - and found on the way that every guide had been carrying *two* of them, a
16px and a 20px padding, with half of each page's copy dead.

**`b.ui` was defined in four inline copies and is now in `site.css` once.** It is the chip that
names a control - `Clear`, `Pull all` - and both guides in both languages carried their own copy, so
the first page outside the guides to use it rendered it as ordinary bold text. Exactly the `.k` /
`.card` / `.note` history repeating, and this time `classes_defined` caught it on the same day rather
than after months. It is `.doc`-scoped, so no landing page changes.

**A change worth keeping → a commit.** Do not batch unrelated work into one commit. Commit it yourself
rather than proposing a message and waiting — the rule that only Ivan decides what goes in a commit
message is about *attribution*, which stays absent, not about a review gate on the wording.

**And the commit is pushed in the same breath. Ivan never touches the code — the git is yours, all of
it.** He decides *when the publication process starts*; every mechanical step of it is yours, push
included. This is the boundary this file already states — decisions his, derivations and executions
here — applied to the one place it had been drawn in the wrong spot: a commit left sitting locally is
work nobody can see, and it fails `auditcheck` as a finding, so «I have committed, you push» leaves a
red gate behind and calls it done. **The one thing still gated on his word is `git push --follow-tags`
with a release tag on it**, because that is what publishes a Release and signs an attestation — not
because it is a push, but because it is publication. An ordinary push to `main` deploys the site and
is expected of you without asking.

**A version is bumped for a release, not for a commit.** This used to say "patch for fixes, minor for
features" per commit, and one afternoon took Zoho CRM from 1.41.2 to 1.43.0 while the Store was still
serving 1.39.0 — four minors of distance on work nobody outside had seen. **The distance is what a user
reads**, and a dev version far ahead of the published one says "unstable" rather than "busy": the
number is a claim about how much has changed for *them*, and there is nothing to claim until a package
is submitted. So the manifest moves when a release is being cut, once, sized to the whole span it
covers — patch if the span is fixes, minor if it carries a feature — and a commit in between leaves it
alone. Nothing derives from a per-commit bump: `stamp.py` writes whatever the manifest says into the
guides, and `/api/versions` compares the manifest against the Store, so both are happier with a number
that moves deliberately. `whatsnew.py` already prints the manifest version at each end of the range,
which is how a release sees the span it has to cover.

**A release → tag, and the tag is the trigger.** `tools/release.sh <app>` refuses a dirty tree,
proves the build reproducible locally, and creates the tag. `git push --follow-tags` then makes
**GitHub** check out that commit, build it twice, attach the archive to a Release and sign a
provenance attestation for it.

**The file uploaded to the Store is the Release asset, never a local build.** That is the rule the
whole chain rests on: a package built on the author's machine and uploaded from it asks a reviewer to
take his word for it, and reproducibility only helps if someone independent actually rebuilds —
which nobody does spontaneously. Moving the build to a machine with a public log removes the author
from the chain; the attestation makes it checkable with one command.

Tags are per product — `crm-v1.8.1`, not `vX.Y.Z`: with two extensions a bare version says nothing
about which one. The single legacy `v1.0.0` predates that and is left alone; moving a published ref
is worse than an untidy one.

**The build is reproducible, and that is load-bearing.** Publishing a SHA-256 is worth nothing if two
builds of the same commit differ — a reviewer who rebuilds gets another number and can prove nothing
either way. Ours did differ, because `zip` stores each file's mtime and walks the directory in
filesystem order. `build.sh` now stamps every file with the commit's own date, sorts the file list
before handing it to `zip`, and passes `-X`. Verify with three consecutive builds: same hash, or the
guarantee is gone.

**The zip is never committed** — it is a build artefact, reproducible from the tagged commit, and
`dist/` is git-ignored. It lives as a Release attachment, nowhere else.

**And it does not survive the check that made it.** `dist/` had grown to **72** local archives,
one per version ever built here - eleven megabytes of the single file the routine above says must
never be uploaded, any one of which could be dragged into the dashboard by mistake. `release.sh`
removes the pair it built once the two hashes match (and keeps them when they do not, which is
when you need to look at them), and `tests/run.sh` removes what its packaging check produced. The
proof is the hash; the file is a means. `dist/` holds one thing between runs now:
`store/<app>/1..5.png`, the set to upload. `tools/shots.py` and `tools/siteimg.py` clear their
1280x800 working renders after publishing - a folder of PNGs that look like something to upload
and are not is the same hazard one directory over. A run for a single named shot keeps its file,
because that is what it was asked for.

**Record what cannot be verified, rather than omitting it.** `RELEASES.md` states that CRM 0.13.8 —
the version on the Store — predates this repository and has no commit to point at, and that
Analytics 1.0.0 was submitted before the build was deterministic so no hash is published for it. A
verifiable record that quietly papered over its first entries would be worth less than none.

**A justification says *why*, and the manifest says *what*.** The host justification enumerated every
data centre - so adding one meant editing the manifest and then remembering a paragraph in the store
copy, which is the duplication this file spends its length fighting, in the one place I had not
looked. Google already has the list: it is in the manifest inside the package being reviewed. The
field exists to explain *why the extension needs to reach them at all*, and that argument does not
change when Zoho opens a region. Reported by the author, and both listings now name the families
(`crm.*`, `crmsandbox.*`, `one.*`, the two AI hosts) and argue from there.

**Every store field states its own ceiling, and `sitecheck.py` counts.** The CRM's storage
justification had been over 1000 characters for an unknown length of time and nothing was measuring —
it was found by counting while editing it, which is luck, not process. The limit lives in the section
heading and the check reads it there, so a section added tomorrow is measured without anyone
remembering and changing a limit means editing one place. A submission that stops at the dashboard
form costs a round trip of two to three days.

**Every host a manifest may reach is named in `privacy.html`, and `sitecheck.py` derives that from
the manifests.** `one.zoho.*` was in the Zoho CRM manifest and missing from §5's opening paragraph
through three separate readings, because the page *did* contain the fact — in a bullet further down —
and the sentence a reader starts from did not. Deriving the list rather than reading the prose also
found three nobody had reported: the Canadian `zohocloud.ca` data centres were reachable and declared
nowhere, and they are a different family from `crm.zoho.*` however similar they look.

**«Fixed» means fixed where the user is looking, and `auditcheck` now refuses to pretend otherwise.**
Four commits sat unpushed while the fix in them was reported as done — true of the working tree, false
of the page on screen, and the user found it by opening the site. The mechanism was `--offline`: it
skips the live comparison, which is the *only* thing in this file that speaks about zoost.it, and
reported the skip as a quiet note among the passes, so a run that had proved nothing about the site
still ended in «0 findings». It is a finding now, and `deploy_state()` reports unpushed commits and an
uncommitted tree without needing the network — git knows. **Say "in the repository" until it is
pushed, and "live" only after `auditcheck` has said so with the network on.**

**A deploy does not land everywhere at once, and `auditcheck` cried wolf twice before that was
written down.** Run within a minute of a push it reported `crm-preview.webp` once and `index.html`
the next time - each byte-identical a moment later, each a PoP that had not caught up. The rule this
file already states («a push is not a publication until `curl` says so») needed its other half:
**a single file differing seconds after a deploy is propagation, not a stale deploy.** Neither
answer was acceptable on its own - ignoring it would blind the one check that speaks about zoost.it,
reporting it would make the release gate noisy - so a difference is now **fetched once more, ten
seconds later**, and only what still differs is a finding. Nothing real is hidden: a file that is
genuinely wrong is still wrong on the second fetch, which was proven by making one wrong on purpose.

**An outside review is evidence, not a verdict — check every claim before acting on it.** One arrived
saying the homepage and `llms.txt` served by zoost.it were still the pre-analysis versions, "not a
part: all of it", and recommended an edge purge. All five pages were **byte-identical to the
repository** when compared with `shasum`; the stale copy was between the reviewer and the origin, as
their own caveat allowed. Two of the same review's smaller findings were exactly right and are fixed
here. Take the findings, verify each one, and say which were real — agreeing with a confident report
is as much a failure as ignoring it.

**The short description is read under the item name, so it must not repeat it.** Both extensions
opened theirs with a near-copy of their own name — 40 of 132 characters spent saying the line above
again, visible in a Web Store search result and invisible in the dashboard. It keeps **"Independent,
unofficial"**, because that is the disclaimer doing its job on the most-read sentence the project has,
and it does **not** say "read-only": that is an absolute this project has already had to walk back
once, and 132 characters have no room for the qualification the full description gives it.

**«What's new» comes from the commits, not from memory: `python3 tools/whatsnew.py <app>`.** Two
products come out of one history, so what changed in Zoho CRM is not the last N commits — it is the
ones that touched `apps/crm/`, with a fortnight of site and other-product work sitting between them.
The tool lists them since that app's newest tag, marks the ones that also touched the site, the store
copy or the README (their wording exists already and should not be invented twice), and prints the
manifest version at each end so a bump nobody made is visible before the tag exists. **It gathers; it
does not write** — a commit subject is addressed to this repository and a "What's new" to somebody
who has the extension installed and has never read one. What it guarantees is that nothing is
missing, which is the part memory gets wrong.

**And there is no "What's new" field on the Chrome Web Store**, which both this file and the tool
asserted for months. The Store listing tab holds the detailed description, the category, the language,
the graphic assets, the URLs and the content declaration, and nothing per version. It was believed on
nobody's authority in particular, which is how a claim about another product's dashboard survives:
nothing here can check it, so this is the class where reading the documentation remains the only
method.

**The consequence is that the GitHub Release is the only place the notes can be published**, and
therefore that forgetting them is unrecoverable rather than untidy — nobody else can add them later.
They live at **`store/<app>/whatsnew/<version>.md`**, `release.sh` refuses to tag without one, the
workflow puts it at the top of the Release body and fails if it is missing, and `tools_test.py` holds
every ledger row at or after the version each app adopted the convention.

**The Release body has two readers, so it is composed for them.** The notes from
`store/<app>/whatsnew/<version>.md` come first - more people want to know what changed than want
to check a hash - then a rule, then `## Provenance` with the commit, the SHA-256 and the two
verification commands. Mixed together each reader scans the other's half looking for their own.
The footer link to them is called **Release notes** and not «Changelog», because that is the word
GitHub puts on the page it lands on, and a link should say where it goes in the words used there.

**What hid this for 69 commits is worth knowing, because the shape recurs: an automated artefact that
looks finished.** The workflow already wrote a body — the hash, the commit, the two verification
commands, the `RELEASES.md` row — so every Release *had* one and nothing looked absent. But that body
answers "is this archive what it claims to be", and never answered "what am I getting"; two questions,
one of them unasked. The routine below had seven steps and none of them said "write the notes", so it
was not a lapse of memory - there was nothing to remember. **When a generated artefact stands where a
written one should be, check which question it answers before reading it as done.**

Its first version used `\x1e` as the field separator and reported that **nothing had changed** —
Python's `splitlines()` treats `\x1e`, `\x1c`, `\x1d`, `\x85`, `\u2028` and `\u2029` as line
boundaries, so every record broke in half. The worst possible answer from a release-notes tool, and
another instance of the pattern already named here: a value crossing a boundary and being read
differently on the other side. Split on `\n`, separate with a tab.

**A release with user-visible change → store copy as well.** Regenerate whatever in
`store/<app>/store-listing.md` no longer matches: description, single purpose, permission
justifications. Hand me the finished text ready to paste, and tell me which dashboard fields to
change alongside the package — they are reviewed together, and an inconsistency between manifest,
description and privacy policy is what delays or fails a review.

**A review of the codebase → a dated note in `docs/findings/`, and every entry ends in a rule.**
Not a report of an activity: the activity is over and nobody will read about it. What is worth keeping
is the *defect*, what was done about it, and - the part that pays for the file - **the rule that stops
it happening again**, named as a class rather than as the incident. Where the rule can be checked by a
machine, the note names the check and the check goes in on the same day; where it cannot, the note
says so instead of leaving it to be discovered. One file per sweep, `YYYY-MM-DD-<what-it-was>.md`, so
they sort by date and say what they were. `tests/tools_test.py` holds the shape: an entry without a
rule is a finding.

**A change touching permissions, data flow or naming → stop and say so before writing code.**
Those have consequences outside the repository.

## How to work with me on this

This project was built by argument, not by dictation, and that is why it holds together. Keep it
that way.

**Anything that can run for more than a few seconds says where it has got to, and flushes.** A silent
process and a hung one are the same thing from outside, and the difference is only learnt afterwards.
`siteimg.py` rendered 27 images for **thirty-four minutes** without emitting a line, and the only way
to tell it was alive was to look at Chrome's process table and the mtimes of the files it had not
written yet. Two halves, and the second is the one that gets forgotten: **print a line per unit of
work before doing it, and `flush=True`** - stdout is block-buffered whenever it is not a terminal, so
a background run's progress sits in a 4KB buffer until the process exits, which is the same as
printing nothing exactly when somebody is asking. Put the elapsed seconds on the line too: the first
run with them showed one shot at 85s beside another at 1s, a spread nobody had suspected and nothing
could have reported. Reported as a rule - «un task monolitico che gira per tanti minuti e'
indistinguibile da uno stuck».

**Everything that can be automated is automated, and what is left is stated.** The author's rule, and
it is the general form of what this file already does in a dozen places: the sitemap is derived, the
dates and versions on the page are written by a tool, the store fields are counted against their
ceilings, the graph fixtures come out of the shipped panel. A step done by hand twice is a step that
will be done wrong once.

**The boundary is decisions, not effort.** What gets automated is every *derivation* and every
*verification* - anything whose right answer can be computed from something that already exists.
What stays with the author is every *decision*: when to tag, when to submit, whether a claim is
worth making. That line is why `whatsnew.py` gathers the commits and refuses to write the notes, why
a release is cut on request and never as a consequence, and why the one thing `shots.py --uploaded=<app>`
records is the one thing no tool can observe - that a person uploaded the files. Automating a
decision would not save work; it would move it somewhere nobody is watching.

**And a tool that records a fact must record only the fact that happened.** `--uploaded` took no
argument in its first version and wrote *both* products down as uploaded when one had been - a
hand-edited file replaced by an automatic lie, which is worse than what it replaced.

**A rule that is only written down is a rule that will be broken. Writing it is the first of two
steps.** This file and the nine notes beside it are ~300,000 characters of rules, and the record is
not ambiguous: **every rule with a checker behind it has held, and every rule that lives only as
prose has been broken at least once** - several of them by the session that had just read them. The
reason is not carelessness. A rule is recalled by resemblance to its own *wording*, and a violation
happens while attention is on something that does not resemble it: the size test asserted the limit
itself while the rule about a checker firing too late sat two files away, filed under «checkers».
Volume makes it worse, so answering a broken rule by writing another one is the mechanism that took
this file to 280k.

So the second step is a question, asked every time: **can this be derived or verified?** If it can,
the check *is* the rule and the prose is only its explanation - and it goes in on the same day, not
«later». If it genuinely cannot - when to tag, whether a claim is worth making - then it is attached
to the **moment** it applies rather than filed by topic: a step in the routine, a line in the tool
that prints at that moment, a note at the top of the file that will be open when it matters. That is
why the reminder about §9 sits in `store/crm/store-listing.md` and not in a list of pending things.

**And write the class, not the incident.** A rule written the day after has the shape of that day:
«grep the claim, not the paragraph» was true of a claim, and did not fire for a claim about a scope,
or for a block that enumerated directories. Say what the class is, then the instance as evidence.

**Give unsolicited critical opinion.** When I share something — a design, a name, a piece of copy,
a licence choice — say what is weak about it, what objection someone will raise, what reads badly.
Do this alongside doing the task, not instead of it. The most valuable moments here have been the
ones where I was told something I had not asked about: that the product name invited a takedown,
that the store description had become factually false, that the licence contradicted my stated
intent, that the interface was asking too much of a first-time user. None of those were requests.

**Do not agree to be agreeable.** If I push a direction and it is wrong, say so and say why, then
do what I decide. I am fine being told I am wrong; I am not fine discovering it later.

**Separate what you verified from what you assume.** If something has not been tested — a
performance threshold, an API response shape, a browser behaviour — say so explicitly rather than
letting it sound settled. Several times today the honest "I could not check this" was worth more
than a confident answer would have been.

**A conclusion inherited from an earlier session is evidence, not a verdict — and that includes your
own.** The same rule as an outside review, and harder to apply, because the claim arrives in your own
voice with all of its measurements stripped off and the user's approval already attached. A dead
thread's diagnosis of the ER fit was handed back to be implemented, and two of its three claims died
on the first measurement: `#ertools` is `position:absolute`, so the "chip bar wrapping onto a third
row" could never change what the panel measures, and its 70px came from the ratio of two images
rather than from the page. The generalisation is about *method*, not about that bug: a number derived
from an artefact is not a measurement of the thing that produced it, and the way to check a function
is to instrument the function. Re-derive before building, and say which half survived — a fix built
on the dead half is a change nobody can defend later.

**Own mistakes plainly.** When a bug traces back to something you wrote, say that, name the cause,
and fix it. No hedging, no diffusing it into the passive voice.

**A finding is not handed over without the thing that fixes it.** «Always put me in a position to have
all the material, otherwise I have to ask for it and we slow down for nothing.» Said about a dashboard
field reported as drifted with a *command* to run for the text - and he does not run commands, so it
was an instruction to nobody: a correct finding, and useless. The rule was already here as «hand me
the finished text ready to paste»; what was missing is that it binds **every** report, not only the
ones that look like a handover. Name the file, quote the text, print the number. `dashcheck` does it
now instead of pointing at `storecopy`, and a case holds it - the failure is invisible in a green run,
because the finding was right.

**At handover time, give me the steps and nothing else.** When a release is ready, or anything is
waiting on an action of mine, lead with a numbered list of what *I* do: which file to download and
from where, which fields change and what to paste, what stays untouched. Leave out what you verified
and how — that is your business unless it changes one of my steps. A decision genuinely needing me
goes in a short paragraph after the list, not woven through it. Store review takes two to three days
while we iterate hourly, so a submission redone because a step was buried is expensive out of all
proportion to the change.

**Two machines, and only one of them runs anything.** The work happens on an always-on Windows PC,
inside WSL2, where the repository lives at `~/zoost` and a Claude Code session is kept alive by a
systemd user service - so it is reachable from a phone or a browser through Remote Control, and keeps
going while nobody is at a desk. The **repository is never in a synced folder**: git written file by
file with no ordering is a repository that goes wrong, and the machine doing the work is the one that
pays for it.

What the other machine needs is not the repository - it is `apps/<app>/`, which is what Chrome reads
when you load an unpacked extension, and `dist/store/<app>/1..5.png`, which is what the dashboard
asks for. `bash tools/totest.sh` writes exactly those into that folder as `crm/`, `analytics/` and
`store/`, one direction, `--delete`, and the other machine loads the extension from there. Testing
what is still on the working tree is the whole reason a `git pull` on the other side would not do.
The images are copied only when they exist: a run that rendered none leaves the last set alone,
because that is the set the listing carries.

**Where that folder actually is, is not in this repository.** It is a drive letter and a mount point -
a property of one machine - so a path committed here is one that is wrong on the next machine while
looking perfectly right on this one. It has already moved once, from a cloud-sync folder to a share
on the network, and no tracked file changed with it. `ZOOST_TEST_DIR` lives in **`tools/machine.env`**, which is
git-ignored and is the single place any such value goes; every tracked file says the placeholder.
**The values belong to a machine, the schema does not**: `tools/machine.env.example` is tracked,
lists every key with what happens when it is unset, and a test derives the keys from the tools that
read them - so a new machine has something to read, and a key added tomorrow cannot be invisible.
`tests/tools_test.py` reads the values out of that file and fails if one has leaked into something
tracked, and it also refuses machine-shaped absolute paths anywhere in the tree - because the first
copy of this rule I wrote checked `tools/` and `tests/run.sh` only, and I put the path in **this
file** in the same commit, under a test that said it was written in one place.

**And it is not something to remember at all: a hook syncs it after every change.** «Every time you change something I have to be able to
test it - I should not have to ask you to copy it to the test folder each time.» The rule below was real and insufficient: it only fired when the *battery* was
run, so a UI change checked with `tools/probe.py` alone, or with `node --test`, left the folder Chrome
loads from a version behind - and he found it by testing something that had already been fixed. The
fix is the second step this file demands of every rule that keeps being broken: `tools/synctest.sh`
copies when anything under `apps/` is newer than its stamp and costs milliseconds when nothing is,
and `.claude/settings.json` runs it after every tool call. **Never hand over a fix without the mirror
carrying it**, and never wait to be asked.

**It is not something to remember: `tests/run.sh` does it first thing, on every run.** "Run it when
the user asks" was a rule, and this file has just finished establishing that a rule living only as
prose is one that will be broken - so it was mechanised the same day, which is the second step that
rule demands. First and not last, because a red suite is exactly when you want to look at the thing
in a browser and `set -e` would never reach the end of the file. It is a no-op where that folder is
not mounted, it can never fail the battery, and asked directly rather than by the suite it *says* so
instead of reporting success over a folder it never wrote to.

**Every command says which shell it goes in.** The work now spans a Mac and a Windows PC, and on the
PC there are three prompts that look alike and are not: **PowerShell**, **cmd**, and the **Ubuntu
shell** inside WSL. `wsl --shutdown` belongs to Windows and fails inside Ubuntu; `systemctl` is the
other way round; a Windows drive is `<letter>:\<folder>` there and `/mnt/<letter>/<folder>` here. Say which,
every time - a command pasted into the wrong prompt costs a round trip and reads as the instruction
being wrong.

**One step at a time when I am learning something new.** If I am on unfamiliar ground — git, ssh,
a dashboard I have never opened — give me one instruction, wait for the output, then the next. Ten
steps at once is how people get lost and blame themselves for it.

**Flag scope creep in both directions.** Tell me when a change touches more than I asked for, and
tell me when a feature I am asking for should wait until it can be tested.

**There is no regression testing. You are the safety net.** I test the thing that just changed, and
nothing else — deliberately: the time saved by working with you would go straight back into
re-testing, which defeats the point. So a regression will not be caught by me. It will ship.

This is not a reason to be timid, it is a reason to be precise. Before touching anything **shared** —
a CSS class, a helper, a piece of module state, a constant — find every other user of it and decide
consciously whether they survive the change; prefer adding a new thing over altering a shared one;
and after the change, verify the other users mechanically rather than by eye. This is how the
functions list got its own `.rr/.rn/.rfl/.rc` badge classes instead of widening `.rf/.rl`, which
Modules and Connections rows also use: reusing them would have silently changed those two tabs, and
nobody would have looked. Say plainly which parts of a change you actually exercised and which you
only reasoned about — an honest "not verified" is worth more than a confident guess.

**Follow the established pattern unless there is a real reason not to — and police this yourself.**
When a new thing is an instance of an existing kind (another tab, another list row, another pull,
another export section, another status dot), it must match how its siblings already behave: the
status dot acts on click, the pull re-renders its own view, the preview clears the previous item's
bars, the export gets a section and a TOC entry and a scope toggle. Deviating is allowed only with a
stated, valid reason. **It is your job to catch the missing schematic piece, not mine.** When you
add one of a set, walk the others and check you did everything they do. If I am the one spotting
that the new tab's dot does nothing while every other tab's dot downloads, we have both failed —
but the miss is yours to prevent. Before calling a feature done, diff it against its siblings.

## Style

- **Never let the test environment show through.** No real org, portal, instance, module, field,
  function or connection names from the CRM this is developed against — not in code, not in comments,
  not in examples, not in commit messages, not in the site. Use neutral placeholders:
  `yourinstance`, `1234567890`, `Contacts`. This is not tidiness: Zoost is stated to be built
  independently of its author's day job, and a real portal name in a comment quietly contradicts
  that. Anything pasted in during a session — HAR files, exported JSON, function sources — is
  reference material for the conversation and must never reach the repository.
- **ASCII punctuation in everything a reader might copy.** The long dash `—`, curly quotes and the
  curly apostrophe were used throughout and are gone: `-`, `"`, `'`. Not a matter of taste — the
  reader cannot tell the difference, which was the argument for using them and turns out to be the
  argument against. What a reader *can* tell is `â€”`, which is what a mangled `—` looks like the
  moment the text lands somewhere that guesses the encoding. **It has already happened here**:
  `llms.txt` served as `text/plain` with no charset did exactly that to every dash on the page. Store
  fields, release notes and a chat window are all places our prose gets pasted and none of them are
  ours. Two things are deliberately kept: the panel's **glyph vocabulary** (`↻ ↗ → ♥ ⚙ ⏱ ◐`), which
  carries meaning a hyphen cannot, and a lone `—` standing for "no value" in a table cell, which is a
  placeholder rather than punctuation and has whitespace on neither side — which is how the
  replacement told them apart, rather than by a list.
  **The product name used to be the exception and no longer is**: both manifests now read
  `Zoost - workbench for Zoho <product>`, so the only long dashes left are the two above. The rule
  that survived the change is the one about *authority*, not about the dash - `name` in
  `manifest.json` says what the product is called, and prose that spells it otherwise is wrong about
  a fact rather than about typography. This line was itself read as licence a session later: an issue
  title arriving as «Zoost Zoho CRM» was diagnosed as the charset dropping a dash the product no
  longer has, from sample text I had written myself. **A rule about an exception outlives the
  exception**, so when one is removed, the sentence that granted it goes in the same change.
- **One language: English.** Code, comments, notes, tests, tool output, file names, commit messages -
  all of it. The only Italian in this repository is the site's **Italian pages**, and the strings and
  quotations that belong to them: a citation of Italian copy inside a note about that copy stays as it
  was said, because translating a quotation falsifies it. Asked for on 20 August 2026, after a review
  note written in Italian was found at the repository root and two `background.js` files were seen to
  have opened with an Italian comment since the first commit - the author thinks in Italian, so the
  words arrive already written and this is the rule most easily broken by whoever has just read it.
  So it is not prose: **`python3 tools/langcheck.py`**, in `tests/run.sh`, is a ledger like
  `tools/cssdupes.txt` - `tools/notenglish.txt` records the 29 deliberate lines with their reason,
  anything new is a finding, and the ledger may only shrink. What it cannot do is in its docstring: it
  knows Italian by a word list, so it is a net and not a proof.
- British-leaning English in user-facing copy; comments explain **why**, not what.
- **An absolute claim invites a literal check, and a literal check is what this project asks for.**
  `llms.txt` moves an assistant from summarising the page to verifying it sentence by sentence, and in
  that mode every absolute is a target. "Zoost never writes to Zoho" fell to one authenticated POST
  whose URL contains `CREATE` — it returns the ER model, and «creates nothing» is not something a
  client can establish about somebody else's server, so what is claimed is what Zoost sends. The guarantee is a
  property of *which endpoints we call*, not one the browser enforces. Say the precise thing instead:
  it is less elegant and it cannot be knocked down. Where an absolute already exists, name the
  exception yourself — a reader who finds it after reading "certain, or stopped" concludes the
  opposite of what the sentence intended.
- **What the product rests on is stated, not discovered.** Both extensions run on undocumented
  internal interfaces, read the org and user id out of the page's HTML, and observe the requests the
  Zoho page makes in order to reuse its token. That is the foundation, it can break without notice,
  and nothing is guaranteed — only effort. Said in our own voice it is evidence of seriousness; found
  by a reader in the source after a page of absolutes, it is the opposite.
- Say what a thing does not do, next to what it does. The health audit states its coverage gaps;
  the AI panel states that OpenAI cannot explore on its own; the export dialog flags source code.
  This is deliberate: an honest limitation prevents a bad review.
- Empty states are never silent. "Nothing here" plus the reason plus what to do about it — and it
  must be **the** reason, not a reason. Analytics recited the whole sequence (pick a folder, create a
  workspace, Pull all) while the only thing in the way was one click on **Grant access**: four
  instructions where one would do, three of them already done. Saying the wrong missing thing is
  worse than silence, because the reader goes and does it and nothing changes. `emptyBlocker()` /
  `emptyReason()` walk the states in the order they actually block each other, and every list asks
  them before blaming the pull. The CRM looked correct only because its status line happened to say
  the true thing; its five tree messages had the same defect — **do not align a twin to the one that
  is accidentally right**, fix both.

  Two more turns of the same screw, both reported by the user because nothing checked them. The
  sentence existed **twice** in Analytics — `render()` produced it and the markup hard-coded it inside
  `#list` — and the markup copy is the one on screen at startup, because `refreshWorkspaces` returns
  early when access is not granted and never redraws; fixing the other one changed nothing. And the
  CRM never showed it at all, for the same reason one layer up: its early returns did not draw the
  tree, so the state was announced in the status line on one side and in the list on the other, which
  reads as two different products. Both panels now share `emptyReason()` **word for word**, both draw
  it from every early return, and the markup carries no empty state at all.

  Also typographic, and it is what "misleading" actually meant the second time: `.empty b{display:block}`
  hit **every** `<b>`, so «Press **Grant access** above» became its own line and one sentence arrived as
  four fragments that read as four statements. Only the first `<b>` is the heading.

  And the message now names the shortcut, because it exists and is faster: **a click anywhere in the
  panel re-grants the folder**. A stored handle loses its permission between sessions and can only be
  restored from a user gesture, so a capture-phase listener piggybacks on the first click the user
  makes — staying out of `#wsroot`, `#pfoot`, `.dlg`, `#aiview` and `#offoverlay`, which either ask by
  themselves or belong to something else. Both panels had it and **excluded different subsets**,
  neither list wrong, which is how that kind of divergence survives: both looked deliberate. It is the
  union now, checked.

## Release routine

**A release happens when I ask for it, for the app I name, and never as a consequence of anything
else.** This is the standing instruction and it overrides every inference. Naming one product is not
naming both; finishing a feature is not asking for a release; a clean tree and a passing suite are not
permission. Tagging is the one step here that is *public and irreversible* — a tag, a Release and a
signed attestation exist the moment it runs — so the bar for it is an explicit instruction, not a
reasonable reading of one.

It has already cost twice in a single session, and the second cost is the argument: asked to package
Analytics, I applied the routine to the whole repository and tagged Zoho CRM too, while its previous
version was still in review. And the Analytics tag itself was cut before the user had finished
testing, so it captured a `ReferenceError` that made the whole options page stop loading — a defect
found by *him*, minutes later, in an artefact already published and attested. **Tagging early does not
save time; it publishes whatever has not been checked yet.** Wait for the word.

**"Give me the zip to publish" is a request for the whole chain, never for a file.** This is standing
instruction, not a per-release choice: a package built here and handed over is exactly the weak link
the chain was built to remove, so producing one on request would undo the work silently. If the
answer is ever a local `./build.sh` artefact, something has gone wrong — say so instead of handing it
over.

What that request means, in order. Do all of it without being asked:

0. **`bash tools/prepare.sh`** — renders what has moved, stamps the pages and the asset URLs, moves
   the translation markers, rebuilds the sitemap, runs the battery and the image checks, and stops at
   the first finding. It was five commands in an order that mattered, run by hand every time.
1. **Check the release is actually warranted and complete.** Run "Definition of done" over the change
   — docs, site, store copy, `manifest.json` description — before anything is tagged. A tag is a
   public ref; fixing a premature one costs more than waiting.
2. **Bump `version` in `apps/<app>/manifest.json`** — patch for fixes, minor for features — and
   commit everything. The tree must be clean or `release.sh` refuses, by design.
2b. **Write `store/<app>/whatsnew/<version>.md`.** `python3 tools/whatsnew.py <app>` gathers the raw
   material; the file is written for somebody who has the extension installed and has never read a
   commit. `release.sh` **refuses to tag without it** and so does the workflow, because this is the
   one thing in the release that cannot be added afterwards by anyone but the author.
2c. **Hand him the manual checks: `python3 tools/handcheck.py <app>`.** It prints what has to be
   exercised **on a real org** for this release - derived from the shipped files that changed since
   that app's tag - and how to answer. He runs them, records each with `--pass` or `--fail`, and the
   record is committed with the release. **This is not a formality: `release.sh` refuses to tag
   without it**, and an answer stops counting the moment the code moves, because it names a commit.

   **He does not run it, and that is the agreed shape**: «I talk to you in natural language and I use
   the app as a user, that's it». So you produce the plan, he exercises the product, he says in words
   what happened, and **you record it for him** - his sentence in `--note`, because that is the
   evidence. Never record what he has not said, and never infer a pass from a green suite: the whole
   value of the step is that it is his answer and not yours.

   It exists because a defect that made every Pull all fail reached a submitted package. Nothing here
   could execute a pull; both pulls now run headless in `tools/probe.py` against the sample, and what
   is left needs an org, a role, a data centre and a person. He asked to be in the chain rather than
   around it - so the instructions are yours to produce, clearly, every release, and the answer is
   his. A file that changed and no check covers is a finding, so the catalogue grows with the product.
3. **`tools/release.sh <app>`** — it used to refuse a dirty tree and nothing else, so a red suite
   could be tagged: the one step that is public and irreversible was the one that checked least. It
   now refuses on exactly seven things, and knowing them beforehand is the difference between a
   two-minute release and an afternoon:

   | it stops if | fix |
   |---|---|
   | the tree is dirty | commit or stash - a release has to be a commit someone else can check out |
   | `<app>-v<version>` already exists | bump `version` in `apps/<app>/manifest.json` |
   | `store/<app>/whatsnew/<version>.md` is missing | write it; `python3 tools/whatsnew.py <app>` gathers the material |
   | `bash tests/run.sh` is red | fix it; a tag is public |
   | `python3 tools/auditcheck.py --before-tag` has a finding | **most often an unread absolute claim**: read them, then `--accept` |
   | the manual checks are not recorded for this commit | `python3 tools/handcheck.py <app>` - he runs them, `--pass` records them |
   | two local builds of the same commit differ | the build is not reproducible - stop, that guarantee is load-bearing |

   The fifth is the one that surprises, because it fails for something written weeks earlier and
   nowhere near the release: `--accept` is all-or-nothing, so a single unread claim means reading
   every pending one. **Run `python3 tools/auditcheck.py` when you finish a piece of work, not when
   you want to tag.** Then it builds twice and compares - a non-reproducible build must fail *before*
   the tag exists - and creates `<app>-v<version>`.
4. **`git push --follow-tags`** — this, and nothing else, starts the public build. GitHub checks out
   the tag, builds it twice, prints `unzip -l` into the public log, signs a provenance attestation
   and publishes the Release. You run it, like every other step here; what made it his was never the
   command but the word that started the routine, and that word has already been given by the time
   you reach step 4.
5. **Watch the workflow and read its log.** It is the only place a build failure appears. Report what
   it said — including the hash — rather than assuming it passed.
6. **Hand over the link to the Release asset, plus the hash, plus what to paste** into the Store
   dashboard. Never a path into `dist/`.
6b. **Re-upload the screenshots if they changed.** `python3 tools/shots.py` writes
   `dist/store/<app>/1.png` .. `5.png` - a folder per product, the file named by its slot and nothing
   else, so uploading is opening one folder and taking what is in it - in the order the Store shows them - the interface first,
   then the rest of the interface, then the diagrams - and prints the digest of the set against
   `store/<app>/screenshots.json`, which records what is on the listing. **The folder to open is on
   the mirror, not here**: `tools/totest.sh` carries them across as `store/<app>/`, because the
   machine that renders them is not the one with the dashboard open. This is part of every
   release for both products, not an occasional tidy-up: the Zoost Analytics listing sat on one image
   from its first submission because nothing measured it. The names are numbers on purpose; see
   `store/assets.md`.
6c. **Nothing: «store upload» runs itself** once step 5's workflow finishes. It downloads that
   Release's asset and puts it on the item **as a draft**, never publishes, and when Google already
   has a revision in review it says so and stops at 0 - that is the normal state of the week after a
   submission, not a failure, and it is staged by dispatching the workflow by hand once the review
   clears. This used to be a by-hand step on the argument that «putting a package in front of Google
   is a decision»; by the boundary this file states, that argument was in the wrong place. A draft is
   reversible, invisible to users and cannot touch the listing fields, so once the tag exists there is
   no judgement left in it. **The decision is Submit for review**, it is in the dashboard, and it stays
   yours - the listing fields and the screenshots cannot be set through the API anyway, so you open
   the dashboard regardless, with the package already there.
6d. **`python3 tools/dashcheck.py <app> page.html` is available to him, and is not a gate you hold
   him to.** «You have to trust that I pasted the texts, the way you trust that I ran the tests.»
   Right, and the asymmetry was mine: the manual checks are recorded on his word, so a paste is too.
   What the tool is for is catching a *slip* - a box filled with the wrong section, a paste cut short -
   so offer it when he wants it, and reach for it after a refusal. Never make the submission wait on
   it. What it must always do is hand over the finished texts *before* he opens the dashboard, so
   there is nothing to come back for: that is the rule three lines up, and it is what makes this step
   optional rather than skipped. Not the fields one by one - the whole page source, which is easier
   for him to paste and carries every field at once. It reads the six texts by their `data-payload` anchor, the privacy URL, the
   data-collection boxes, the three attestations and the remote-code answer, and diffs them against
   `store/<app>/store-listing.md`. This is the only check that exists on the listing, and it has to
   be asked for: Google exposes no API for those fields, which is why the step is by hand at all.
   **The page is never committed** - it carries a session token and an email address; the fixtures
   are written from `store-listing.md` instead.

   It found two on its first run, and that is the standing warning about `submitted.py`: it records
   what is *in the repository* when it runs and takes the click on trust, so a field corrected here
   and never pasted is recorded as sent. §4 and §5 had drifted for four and nine days while
   `--changed` reported nothing to paste, and the Store was still serving «a local, read-only mirror»
   - the absolute walked back everywhere else.
   **Ask at step 6, before Submit**, not after: a field pasted short or pasted over a leftover is
   fixable while the form is open and awkward once a revision is in review. It costs him a copy and
   me a `diff`, and it is what found that the Analytics §9 was in step after an hour of believing it
   might not be. He asked to be reminded, so this is the reminder: it lives here because there is no
   command that can carry it.

7. **After submission: `python3 tools/submitted.py <app>`.** It takes the `RELEASES.md` row from the
   published Release - the commit and the hash GitHub signed, not ones recomputed here - and records
   which screenshots the listing now carries. Running it is the one thing it takes on trust: nothing
   can observe the click. The Release body prints the row ready to paste, with the date left blank -
   it is the one figure nobody else holds, since the Store API reports which state a revision is in
   and never when it entered it. Nothing on the site derives from that column any more; the row is
   the provenance record - which commit, which hash - and that is why it is still part of a release.

**Everything else about the chain is in [`docs/releases.md`](docs/releases.md)** - what the Release
title is built from, why every Action is pinned to a commit hash, how the Store upload works and
where it deliberately stops, what Cloudflare does with a push, and the traps in the badge's own
endpoint. Read it when a step misbehaves; the steps above are what you follow when it does not.
