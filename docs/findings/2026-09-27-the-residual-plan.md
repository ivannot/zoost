# The residual plan of 27 September 2026: what it asked for, and what checking it found

A work plan arrived naming four high-priority items and four of medium priority, each with a stated
benefit and a completion criterion, and an explicit list of what it did **not** want: no keyboard
navigation of the graphs, no coverage target, no React, no wholesale TypeScript, no splitting a file
because of its line count. That restraint is why it was worth executing rather than arguing with.

This is the record of what was done, and - the part worth keeping - the four defects found while
doing it, none of which the plan named.

---

## What the plan asked for, and what happened

### P1.1 Room in `CLAUDE.md`

97,332 characters against a budget of 100,000, with 2,668 to spare. The section that moved was
**not** chosen for its size: the file's biggest heading says «Tests» and from its middle onward it is
the argument behind the publication chain - reproducibility, why the zip is not kept, what each store
field is for, how the release notes are composed. `docs/releases.md` already existed for exactly
that. The margin is 10,780 now. The size of the move was written down three different ways in
three files on the day - 8,889, 8,916 and 8,917 - which is what happens to a number retyped
instead of measured; none of them is load-bearing and none is repeated here.

**Found while doing it:** «No framework, no dependencies, no build step» stood **word for word** in
`CLAUDE.md` and in `docs/testing.md`. Not divergent - identical, which is worse in one way, because
it will diverge the first time somebody edits one of them and neither says it has a twin.

**The rule, and it is checked:** a rule lives in one file. `notescheck.py` now reads the **bold lead**
of every paragraph in `CLAUDE.md` and in every note beside it, and a lead that opens a paragraph in
two files is a finding. The lead is the unit because that is how a rule is recalled here and what a
grep for it would find; two paragraphs sharing a word are not a finding. Proved by planting a copy
and watching it go red.

### P1.2 What a CRM reply must carry

Six commands past the envelope validated nothing, and three of them authorise a **destructive** act:
`listBlueprints` builds the set of live ids from `entries` and deletes every blueprint file outside
it, so `{ok: true}` and nothing else empties the folder; `pullConnections` writes the whole
connections index from `connections`; `pullModules` reads `modules.length` with no guard and throws a
TypeError carrying no area. Each command now declares the fields the panel actually reads - derived
twice, from the call sites and from the bridge's own `return` statements - or is named in an exempt
table **with its reason**, and a case derives the command list from the typedef so a command added
tomorrow and forgotten is a finding rather than a silence.

The five that fetch one thing are shaped and not required: their callers already read an absent key
as «Zoho no longer has this», and that sentence is the one the row shows and the retry logic
understands. Requiring the key would have replaced it with an envelope complaint about the same
condition - the trade this project already had to undo once, for `fetchOne`.

### P1.3 Telling test-only code from dead code

The sweep counted the product, its markup and the suite as one corpus, so it answered «does any file
mention this name» where there are two questions. A function called only by a test is alive in the
suite and dead in the product. Split into three readers: **0 candidates before, 14 after**, twelve of
them the class that had been invisible.

Two were dead outright and are gone - a `refreshBlueprints` wrapper whose only caller had been
removed by the fix for «one click re-read the whole area», and a `removeFile` alias left behind when
the writes moved onto `op.remove`. Removing the first exposed a third underneath it,
`refreshBlueprintsNow`, reachable only through the wrapper.

**And it stopped costing minutes.** The per-name search re-read the whole corpus once per
declaration: **3m23s**. Tallied once into a counter per reader: **3.2s**, same expression, same
semantics.

**The rule:** a removal here is followed by another run, not by a commit - one dead name hides the
next.

### P1.4 The upgrade from 1.x

`render_panel` answered `chrome.storage.local` with `{}` for every scenario the probe has ever run,
so it only ever started a **fresh install** - and the path every existing user takes was driven by
nothing. Two states, derived from the tagged trees `crm-v1.53.0` and `analytics-v1.34.0` by reading
which keys those versions actually wrote, now drive the shipped panel as `upgrade-crm` and
`upgrade-analytics`: the workspace survives, a malformed `erDrawMax` falls back instead of disabling
the diagram, a key 2.0 reads nowhere is ignored, and Pull all is available at the end.

What is **not** covered is said rather than implied: `tools/fsshim.js` replaces `idbHandle`, so no
probe scenario touches IndexedDB. The database that comes up without its object store is held by
four cases in `tests/panel.test.mjs` instead.

`tools/storage-manifest.json` records what an upgraded install carries that 2.0 ignores, and what it
lacks that 2.0 supplies - and why neither is deleted.

### P2.1 Concentration in `analytics/workbench.js`

Measured before touching anything: over four months the functions that moved most were `toBridge`,
`tabWorkspace`, `refreshContext`, `offerTwin`, `isZohoUrl` and `goToZoho` - a navigation and context
cluster, not a spread. And the twin already had `apps/crm/zoho-navigation.js` while this side kept
the same logic inline, reading the panel's globals. So the extraction follows a sibling rather than
inventing a boundary, which is the only argument this project accepts for a split. The workbench
keeps hoisted one-line delegations, so no call site moved.

Two cases that had been **reading** that logic as source now **execute** it, which is the gain the
split was for.

### P2.2 The word «side panel»

`docs/boundaries.md` drew the central component as a side panel, which is what it was through 1.x
and is not in 2.0. Diagram, responsibility table and dependency arrows say «workbench window», with
a paragraph saying what changed and when; the historical mentions elsewhere are left alone and named
as historical. `docs/assistant.md` carried a live claim resting on the old shape - «the panel is
~400px wide» - and the arrangement it justified has outlived the justification: the reason is stated
afresh rather than left standing on a fact that stopped being true.

### P2.3 The 2.0 publication

Both products read `PENDING_REVIEW` at the Store as of 12:20 on 27 September. Nothing here is
waiting: the site reports it correctly because the badge derives it, and the post-publication checks
the plan lists cannot be run against an artefact Google has not published. Recorded, not attempted.

### P2.4 Keeping the checks proportionate

Checked rather than assumed, and both hold already: `ZOOST_REQUIRE_CHROME=1` in both workflows, so a
CI run cannot be green without driving a real browser; and `tests/run.sh` compares case counts with
`-eq`, so a **drop** is a failure and not a quiet pass. Nothing to add - which is the honest answer
and the one worth writing down.

---

## What the verification found, and four of them were in the work itself

Five subagents were pointed at the areas this touched, each told to hunt for what does not work and
nothing else. They returned eleven findings. Four were defects introduced **by this plan's own
execution**, and those are the ones worth the file.

### Introduced here, and serious: a remedy made unreachable

`pullActions` was declared to need `sv: 'number'`. The panel already has a branch for a reply
without it - `if ((Number(r.sv) || 0) < ACT_SV)`, where the `|| 0` exists for exactly the absent
case - and what that branch shows is «The Zoho tab is still running an older copy of this extension
- reload that tab, then pull again». Requiring the key threw before the branch could run. The reader
would have got «bridge pullActions response has invalid sv» in red, a persistent `failed` verdict
written into their workspace for an area Zoho never refused, and no remedy named anywhere.

**A validator that replaces a precise message with a generic one has made the product worse in the
act of making it stricter.** The case written alongside it had locked the wrong behaviour in; it
asserts the opposite now.

### Introduced here: an invented fact, documented as measured

The upgrade fixture seeded `sidePanelMode` and described it as «a key 2.0 reads nowhere, left in to
prove an obsolete value is ignored», under a paragraph claiming the state was derived from the
tagged trees. **No version of this product ever wrote that key** - `git log -S` finds it nowhere.
`tools/storage-manifest.json` then recorded it with a plausible rationale, inside the one storage
file the battery does read, which is what made it look checked.

It is gone, `previewW` stands in its place - written by the CRM, never by Analytics, so an Analytics
install carrying it is genuinely something 2.0 must ignore - and the manifest block now says in its
own text that nothing verifies it.

### Introduced here: a test that could not tell an upgrade from a fresh install

**Proved fixed the same way it was proved broken.** The rebuilt scenario was run once with
`stored` forced to `{}` - an install that has never been upgraded - and it goes red:
«waited 2500ms and the data centre stored by the previous version did not survive the upgrade».
Stated with its limit: it fails at the *first* upgrade-specific assertion, so the two after it -
the hidden tab from `tabPrefs` and the `320px` from `previewH` - were not reached by that control
and are argued rather than demonstrated. Arguing is what was wrong the first time, so it is written
here rather than rounded up.

The original defect follows.

A control run with an empty store proved that **one** of the scenario's six assertions went red.
The other five pass on any install. One of them was worse than vacuous: step 5 claimed a malformed
`erDrawMax` must not disable the diagram, and watched a control that never reads `erDrawMax`.

Four of the seeded values were also shapes those versions could not have written - `previewH` and
`detailH` as numbers where 1.x stored the CSS string off `style.height`, `rxShortcuts` as a boolean
where it wrote an array, `tabAccessView` as a string where it wrote `{ws, access}`. A seed in a
shape no version produced exercises a branch no user can reach. And the scenario had no terminal
title, so it could not have gone green even had every assertion held.

### Introduced here: a check that swallowed the duplicate it was written for

`notescheck`'s new lead check used `re.M | re.S` with an unbounded `.+?`. One stray `*` closing a
line early is enough for a lead to walk past blank lines and eat the paragraphs after it, duplicate
included, and the run then prints zero. Demonstrated by planting exactly that shape. The span stops
at a paragraph break now, the match must *start* one - `^` under `re.M` was reading 33 mid-paragraph
emphases as rules - and the run prints how many leads it read against a cruder count of bold
line-starts.

### Introduced here: a reading sampled instead of waited for

The rebuilt scenario checked the Diagram section's ceiling by reading `$('pDrawMax').value` the
moment Settings opened. That field is painted by an async loader, so the read is a bet on the loader
having finished - and the bet won on CRM and lost on Analytics, in the same run. «Sometimes», from
one line of a driver. The condition is the assertion now, and the message names what never became
true rather than what happened to be on screen.

### Found here, pre-existing

- **Three dead aliases** the sweep could not see: `removeFileAt` and `ensureDirectoryAt` in the CRM
  panel, `removeFileAt` in the Analytics one. Each is an alias of a module's own export, *named
  after it*, so the tally scored the namesake declared inside the adapter's factory - a different
  scope, same name. The limit is in the tool's docstring now, with the shape to watch for, because
  distinguishing them needs scope and that is a different tool.
- **Five claims naming a `removeFile` that no longer exists**, `CLAUDE.md` among them. The guarantee
  they describe holds, and from a better place than they said: `onWrite` fires *inside*
  `writeFileAt` and `removeFileAt`, so every caller inherits it without picking the right helper.
- **`handcheck` named the CRM's `zoho-navigation.js` file by file**, so the Analytics one it gained
  was covered by nothing and `release.sh analytics` would have refused to tag - a gate firing
  correctly at the worst possible moment. A glob names both.
- **The site stated 33 Analytics files in seven places**; `sitecheck` caught four and is blind to
  the other three because it matches number *words* and the English pages use digits.
- **Six self-references in the moved release text** - «the routine above», «this file», «the routine
  below» - true of `CLAUDE.md` and false of the file they now sit in. A move is not a copy: prose
  that points at its own container has to be re-pointed.
- **The same rule left in both files anyway.** The whatsnew-notes paragraph was restated in
  `CLAUDE.md` while the note kept its own copy, and the new check reported nothing because the two
  openings are worded differently. The check reads leads; a reader has to read meaning.

### And one intermittency, instrumented rather than fixed

A run reported «Cannot set properties of null (setting 'onclick') @ options.js:1485» for a file
1,483 lines long, and did not reproduce. The explanation came from a reviewer running the probe over
a tree being edited underneath it: a staged snapshot of a file mid-write. The report could not have
said so, because it printed a basename. It prints two path segments now.

## The rules it left behind

- **A validator must not take a message away.** Before making a reply stricter, find the branch that
  already answers the case you are about to refuse - and if it names a remedy, the boundary must not
  speak first. Strictness that costs the reader a sentence is a regression wearing a gate's clothes.
- **Never write down as measured what you did not measure.** The `sidePanelMode` entry read exactly
  like the derived ones beside it, in a file the battery opens. A fabricated fact is worse in a
  checked file than in an unchecked one, because the file's reputation carries it.
- **A scenario over seeded state must be run once with that state removed.** If it still passes, it
  is not testing the state. That control run costs one minute and is the only thing that tells a
  fixture from a decoration - and it is the same rule this file already states about making a
  subject dirty on purpose, applied to a *stored* subject.
- **Bound every lazy span, and print what the pass inspected.** `re.S` with an unbounded `.+?` does
  not fail loudly; it eats the finding and reports zero.
- **In a driver, the condition is the assertion.** Reading a value at a chosen instant is a bet on an
  async loader, and this file already says so about waiting; what it did not say is that the bet can
  land differently on two products in one run, so a driver that samples produces «sometimes» rather
  than a finding.

- **A rule lives in one file, and `notescheck.py` refuses a second.** Splitting a topic out is the
  fix this check asks for, and the way it goes wrong is copying instead of moving.
- **Validate at the boundary what a destructive act depends on.** «Does partial data authorise a
  destructive act?» is already one of the six questions; asking it of the reply rather than of each
  call site is where it costs least and catches most.
- **«Used» is three answers, not one.** The product, its markup and the suite are different readers,
  and a sweep that merges them cannot see code that only the suite keeps alive.
- **A probe that always starts from an empty store only ever tests a fresh install.** The seam
  existed and nothing reached for it; the default is the measurement.
- **Extract on measured churn and an existing sibling, never on line count.** And when the split
  lands, move the cases from reading the code to running it - that is what was bought.
- **A justification can outlive the fact it rested on.** «The panel is ~400px wide» explained where
  the AI settings live; the panel is a 1200x900 window now and the settings have not moved. State
  the reason that holds today, or move the thing.
