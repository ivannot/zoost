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
| [`docs/decisions.md`](docs/decisions.md) | before changing how the panels behave: what is captured, what is drawn, what the assistant is told, what a refusal means. The longest of them, and the one that answers «why is it like this» |
| [`docs/traps.md`](docs/traps.md) | when something does nothing and says nothing. Every entry in it failed silently once |
| [`docs/naming.md`](docs/naming.md) | before writing anything a user or a reviewer can read: the product names, the site, the translations, and the checks that hold them |
| [`docs/releases.md`](docs/releases.md) | when something in the chain misbehaves - Cloudflare, the Store API, the workflows, the attestations. The routine itself is below, in this file |

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
is stored and where it travels) and `store/store-listing.md`. Only then is the change done.

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

**Any code change → nothing to package.** Local testing runs straight off the repository:
`chrome://extensions` → *Load unpacked* → `~/Developer/zoost/apps/<app>`, then hit reload after edits.
No zip, no reinstall. Just tell me what to look at and what should have changed.

**Commit messages carry no co-author trailer, and no attribution of any kind.** Not `Co-Authored-By`,
not a generated-with line, nothing. The repository's first 136 commits have none; nine acquired one in
a single session without being asked for, and they are on GitHub. The default the tooling suggests is
overridden here and stays overridden — **only Ivan decides what goes in a commit message.** Ask if you
think there is a reason; do not infer one.

**`b.ui` was defined in four inline copies and is now in `site.css` once.** It is the chip that
names a control - `Clear`, `Pull all` - and both guides in both languages carried their own copy, so
the first page outside the guides to use it rendered it as ordinary bold text. Exactly the `.k` /
`.card` / `.note` history repeating, and this time `classes_defined` caught it on the same day rather
than after months. It is `.doc`-scoped, so no landing page changes.

**A change worth keeping → a commit.** Bump `version` in the app's `apps/<app>/manifest.json`: patch for fixes,
minor for features. Propose the commit message; do not batch unrelated work into one commit.

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
`store/store-listing.md` no longer matches: description, single purpose, permission
justifications. Hand me the finished text ready to paste, and tell me which dashboard fields to
change alongside the package — they are reviewed together, and an inconsistency between manifest,
description and privacy policy is what delays or fails a review.

**A change touching permissions, data flow or naming → stop and say so before writing code.**
Those have consequences outside the repository.

## How to work with me on this

This project was built by argument, not by dictation, and that is why it holds together. Keep it
that way.

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

**Own mistakes plainly.** When a bug traces back to something you wrote, say that, name the cause,
and fix it. No hedging, no diffusing it into the passive voice.

**At handover time, give me the steps and nothing else.** When a release is ready, or anything is
waiting on an action of mine, lead with a numbered list of what *I* do: which file to download and
from where, which fields change and what to paste, what stays untouched. Leave out what you verified
and how — that is your business unless it changes one of my steps. A decision genuinely needing me
goes in a short paragraph after the list, not woven through it. Store review takes two to three days
while we iterate hourly, so a submission redone because a step was buried is expensive out of all
proportion to the change.

**Every command says which shell it goes in.** The work now spans a Mac and a Windows PC, and on the
PC there are three prompts that look alike and are not: **PowerShell**, **cmd**, and the **Ubuntu
shell** inside WSL. `wsl --shutdown` belongs to Windows and fails inside Ubuntu; `systemctl` is the
other way round; a path is `G:\My Drive` on one side and `/mnt/g/My Drive` on the other. Say which,
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
  **The product name keeps its long dash**, because `name` in `manifest.json` is the authority and
  changing it is a change to the product's identity, not to its typography.
- British-leaning English in user-facing copy; comments explain **why**, not what.
- **An absolute claim invites a literal check, and a literal check is what this project asks for.**
  `llms.txt` moves an assistant from summarising the page to verifying it sentence by sentence, and in
  that mode every absolute is a target. "Zoost never writes to Zoho" fell to one authenticated POST
  whose URL contains `CREATE` — it computes the ER model and creates nothing, but the guarantee is a
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
3. **`tools/release.sh <app>`** — runs the battery and `auditcheck --offline` and refuses on any
   finding (it used to refuse a dirty tree and nothing else, so a red suite could be tagged: the one
   step that is public and irreversible was the one that checked least), verifies the tree, builds
   twice locally and compares (fast feedback: a non-reproducible build must fail *before* the tag
   exists), then creates `<app>-v<version>`.
4. **`git push --follow-tags`** — this, and nothing else, starts the public build. GitHub checks out
   the tag, builds it twice, prints `unzip -l` into the public log, signs a provenance attestation
   and publishes the Release.
5. **Watch the workflow and read its log.** It is the only place a build failure appears. Report what
   it said — including the hash — rather than assuming it passed.
6. **Hand over the link to the Release asset, plus the hash, plus what to paste** into the Store
   dashboard. Never a path into `dist/`.
6b. **Re-upload the screenshots if they changed.** `python3 tools/shots.py` writes
   `dist/store/<app>/1.png` .. `5.png` - a folder per product, the file named by its slot and nothing
   else, so uploading is opening one folder and taking what is in it - in the order the Store shows them - the interface first,
   then the rest of the interface, then the diagrams - and prints the digest of the set against
   `store/<app>/screenshots.json`, which records what is on the listing. This is part of every
   release for both products, not an occasional tidy-up: the Zoost Analytics listing sat on one image
   from its first submission because nothing measured it. The names are numbers on purpose; see
   `store/assets.md`.
6c. **Actions → «store upload» → the tag.** The CI downloads that Release's asset and puts it on the
   item **as a draft**; it never publishes, and it refuses if Google already has a revision in review.
   The listing fields and the screenshots cannot be set through the API, so the dashboard is still
   where a submission is finished - which is the right place for the decision to be taken.
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
