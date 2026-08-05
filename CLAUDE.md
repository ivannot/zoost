# CLAUDE.md

Working notes for this repository. Conventions, decisions already taken, and traps already hit.
Read this before changing anything.

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

## Repository layout

Zoost is becoming a family: one root brand, one repository, **one extension per Zoho product**.
They are separate extensions on purpose — different host permissions, a different single purpose for
the Web Store, a different data model — sharing only the name, the site and the philosophy.

```
apps/crm/        the Zoho CRM extension. Exactly what ships. Nothing else lives here.
apps/analytics/  the Zoho Analytics extension
site/            zoost.it — deployed by Cloudflare on push to main (root directory: site)
site/_worker.js  the Worker script (see the Cloudflare notes further down)
store/crm/       Chrome Web Store listing copy and permission justifications, per app
dist/            build output, git-ignored
```

Each app carries its **own `manifest.json` and its own version number** — they do not move in step.
`./build.sh crm` and `./build.sh analytics` package them separately.

**No code is shared between apps yet, and that is deliberate.** The two will look similar (a tree, a
preview, a health view, exports) but they read different platforms with different shapes. Factor
something out only once both sides actually use it and it has stopped changing — sharing too early
between two products that are still finding their form costs more than the duplication.

**But separate code must not mean separate products. The apps are twins, and it has to show.**
Technically independent, one product to whoever uses both. Anything they have in common — the
working-folder and workspace bar, the environment guard and its mismatch overlay, the dialogs, the
button semantics, the empty states, the wording, the colours, the philosophy — is **the same thing**
on both sides, down to the element ids. Two consequences, both binding:

- **Never invent what already exists.** Before building anything on one side, look at whether the
  other side already solved it, and port it. The Analytics panel shipped 0.2.0 with a working-folder
  picker invented from scratch: no Remove, no mismatch bar, no blocking overlay, no About dialog, an
  ad-hoc `.primary` class where the CRM has a five-class button grammar, and different ids for
  identical concepts. All of that was rework that need not have happened.
- **A change to something shared is a change on both sides.** Fixing the workspace bar in one app and
  not the other silently breaks the continuity for the person using both. If a shared change can only
  land on one side for now, say so explicitly rather than letting the two drift apart in silence.

Check it with the tool, not by memory, and **not by a checklist either**. A checklist only ever
contains the mistakes already made: this one grew a line after each of ten reported divergences and
was still incomplete every time, because the next drift was always in a dimension nobody had thought
to list. Run this instead — it compares the two panels rather than remembering to:

A class used but never defined renders as nothing, and nothing is hard to see. That check is now
inside `sitecheck.py` (`classes_defined`), and the one-liner that used to live here is worth
recording as a failure: it concatenated `site.css` with **every** page's inline `<style>` and then
asked each page separately, so a class defined in one page's block read as defined on all of them —
which is exactly the defect it existed to catch. It printed nothing for months while `/how-to.html`
rendered its two product cards, and both guides their callouts, as unstyled paragraphs. `.card`,
`.cards`, `.note` and `.meta` now live in `site.css`, scoped to `main` so no landing page changes.
Per page, the CSS is `site.css` plus that page's own block, and the class name must end at a
boundary — the substring test counted `.cards` as a definition of `.card`.

The site has its own version of the same problem and its own checker. The navigation grew a
different *shape* on two of six pages — a `<span>` holding two sub-links where the rest had one
`<a>` — and a bar that changes as you move through a site is disorienting in a way that is easy to
notice and hard to name. It was reported by the user, which is the failure. **A contextual
*target* is fine and invisible; a contextual *shape* is not.**

```bash
python3 tools/sitecheck.py           # header and footer must have one shape across all pages
python3 tools/namecheck.py           # no shipped file may name, link to or identify as the other product
python3 tools/featurecheck.py        # every control a panel offers must be named somewhere on the site
```

**The site may keep a technical register; it may not be incomplete.** The test it has to survive is a
real one: hand `zoost.it` to an assistant, ask what the product does and whether it is trustworthy,
and see whether the answer matches the software. A capability that exists in the panel and is
described nowhere makes that answer wrong by omission, so `featurecheck.py` compares the panels'
control labels against the pages. It cannot judge whether the prose is good — nothing can — only that
nothing is missing. **`site/llms.txt` is the map that assessment starts from**: what the products are,
what they refuse to do, where each claim is verified, and what none of it proves. It is listed in
`robots.txt` and the sitemap, and it is checked by `sitecheck.py` like any other outward prose,
because it makes claims.

**And run them without being asked.** The user should not be the one noticing that a guide describes
a button the panel stopped drawing, or that a short description repeats the item name it sits under.
Both of those reached him, and neither was a lapse of attention that more attention would have fixed:
each was a dimension nothing measured. `featurecheck.py` now compares the panel's *marks* against what
the guide draws, not only what it names — and its **filter and sort dropdowns**, which it could not
see at all: it read `<button>` elements in `sidepanel.html`, while those menus are built in JS from
literal pairs inside `buildTypeChips()`. Every choice in them is a capability with a name, and
`Has scheduled actions` shipped past the check without the site knowing the feature existed, and `auditcheck.py` reports a description that borrows three
consecutive words from its own item name. The rule is the one already here — **extend the check, never
the care** — and the corollary is that the battery is run at every checkpoint, by me, unprompted:
`tests/run.sh`, then `auditcheck.py`, then `reachcheck.sh` when the site moved.

**Run all three before calling a change done.** They divide the problem three ways and each was
written after something got past the others. The third exists because of a pattern worth naming:
five naming defects reached the user, and all five were invisible for the same two reasons.
`twincheck` reads **two files out of the twelve each app ships**, with the pair written by hand —
a checklist wearing a script's clothes, inside the tool built to prevent exactly that. And every
check compared *structure* — ids, classes, declarations, handlers — while a product name is a
**string**, which nothing read.

So `namecheck.py` globs (a file added tomorrow is covered without anyone remembering) and reads
strings: every shipped page's `<title>` must name its own product; no file may name or link to the
other one; the manifest's identity fields are the authority rather than a copy kept in the tool; and
it reads `release.yml`, because "Zoost for crm 1.9.0" was published by the one file that is neither
panel nor page. Proven against all four defects: each is reported when reintroduced.

**When a check misses something, extend the check — never the care.** "Be more careful" had already
been tried five times.

```bash
python3 tools/twincheck.py          # shared chrome: ids, classes, inline styles, CSS declarations
python3 tools/twincheck.py --all    # everything, product-specific parts included
```

**The lists inside it are of what is deliberately different, never of what to check.** That
direction is the whole point: forgetting to declare something makes it *reported*, not silent. Two
earlier versions had it the other way round and both went quiet on real bugs — one because the rule
styling a button existed on a single side, the other because nobody had added the resizer to a list
of things worth comparing. An allow-list is a checklist wearing a script's clothes.

Where a criterion can be derived, it is: the set of shared classes comes from reading both files'
markup, not from a list, so a class used on both sides but styled on one is always reported. A rule
is anchored on the first class or id of its first token — `.dtab.active` is about `.dtab`, not about
`.active`.

It also compares **behaviour**, because markup and CSS can match perfectly while a control does
nothing on one side — the dimension that let the detail pane keep its scroll position when the CRM's
resets. Two checks, both approximations and honest about it: which shared controls have a handler and
of what event type, and which platform and DOM techniques each panel uses *at all*. What a handler
*does* is not statically comparable, so the second is a smell detector at file granularity: it would
have caught the missing scroll reset, and would not have caught the search box failing to take focus
back, because that file used `focus` elsewhere.

**Prove it against a bug you already know about before trusting it.** Removing `.aiinrow #aisend`
from Analytics must make the tool print three findings; putting it back must return it to zero. A
checker that has never caught anything is a claim, not a check — and claiming otherwise is how this
took three attempts instead of one. It decides nothing — a difference may be deliberate.
**It must print zero unexplained differences before a UI change is done.** Anything genuinely
deliberate goes in its `EXPECTED` map *with the reason on the same line*; a checker that keeps
reporting known-good noise is a checker nobody reads.

Walk each difference and decide: is it genuinely product-specific (functions, modules and Deluge
exist only in CRM; views, query tables and the ER model only in Analytics), or is it shared chrome
that has drifted? Only the first kind is allowed to differ.

**The accent is the one deliberate exception, and everything derived from it follows.** `--sel` is
`#2563eb` in CRM and `#dc2d7a` in Analytics — each panel's own icon colour, so the app you are in
says so without a label. `--sel-soft`, `.zbtn`, `.znav` and the user's chat bubble derive from it and
are expected to differ; they are declared in `twincheck.py` with that reason. Nothing else may.

**Five roles, five hues — check the accent has not eaten one.** The button grammar needs the accent
to be distinct from `.lbtn` teal, `.pbtn` violet and `.abtn` amber. Analytics ran with a teal accent
for a while and `.lbtn` collided with it: two roles, one colour, and one fewer distinguishable
meaning than the CRM had. A new product's accent has to clear those three before anything else.

**That grep only covers markup. The twin rule covers behaviour and artefacts too**, and that is
where it was broken next: exports were written to `export/` in CRM and to the workspace root in
Analytics, under a different filename shape and a different timestamp format. Nothing in the markup
could have caught it. So also compare, by reading both sides:

- **what an overlay covers.** In the CRM panel `#aiview` and `#healthview` live inside `#belowbar`
  at `inset:0`, so opening one hides the mode segments and the per-type button row beneath it — the
  view owns everything below the main toolbar. An overlay that starts lower leaves a strip of stale
  controls visible and looks like a different product.
- **a control that has nothing to do is absent, not disabled.** The CRM's "Complete missing" button
  is `display:none` until there is something missing, and its label carries the count. A greyed
  button still says "there is something here you cannot have", which is misleading when there is no
  something. Disabled is for *temporarily* unavailable — wrong workspace, pull running.
- **what a symbol means.** The glyphs are a vocabulary shared across the apps, and one that means
  two different things is worse than none: **`↻` is local** — "reload from disk / re-grant folder
  access" — and **anything that reads from Zoho says "Pull"** and wears `.zbtn`, whether it is
  "Pull all", the per-type "Pull", or the per-item one. The Analytics detail pane shipped a `↻` that
  called Zoho; it was the right colour and the wrong glyph, which is the confusing combination.
  **A mark may replace the visible word, and never the name.** The toolbar's `Pull all`, `Pull` and the
  diagram button are inline SVG in `.mk` — 1.6px stroke at 13px, `currentColor`, so each inherits its
  button's role colour instead of introducing a sixth. The rule above still holds, with the emphasis
  moved: anything that reads from Zoho is still *called* Pull and still wears `.zbtn`; the name lives
  in `aria-label` and `title`, which is where a name has to be for anyone not looking at pixels. Two
  down arrows mean **all** — adding the word beside them was saying it twice.
  This cost coverage the moment it landed: `featurecheck.py` read visible text, so three controls went
  from checked to invisible without a word. It reads `aria-label` first now, and the first thing it did
  was find two controls the site had never named.
  **A glyph that merely *resembles* another is the same defect.** The AI chat's Clear wore `↺`, which
  differs from `↻` only in the direction of an arrow, at 11px, a few pixels from the real Refresh.
  It lost the glyph rather than gaining a new one: the label already says Clear, and the vocabulary is
  better one symbol smaller than one ambiguity larger.
- **where a file is written and what it is called** — `export/zoost-<name>-<stamp>.<ext>`, with
  `stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')` and `sanitize()` on the name
- **what the status line says afterwards**, word for word
- **which guards run before an action** — e.g. `ensurePerm(dir)` before writing an export
- **which folders a workspace walk skips** (`_index/`, `_modules/`, `export/`)

An export is the artefact a user collects from both apps. Finding it in a different place in one of
them is exactly the discontinuity these two are supposed to avoid.

`LICENSE`, `NOTICE` and `README.md` live at the root so GitHub picks them up; `build.sh` copies
the first two into the package at build time.

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
  or real data. `zoost.it` is informational — if a scraped number goes missing the page says
  "unknown" and nobody is harmed. So the site may depend on a source we do not control (the version
  badge reads the Chrome Web Store listing's markup, since Google publishes no API), provided the
  dependency **fails visibly and cannot lie**: validate the shape of what came back, discard anything
  that does not match, show "unknown" rather than a stale or guessed value, and cache so a blip is
  invisible. Never carry this licence back into an app under `apps/`.

## Architectural decisions worth not re-litigating

**Workspace identity is the org id inside `.zoost.json`, never the folder name.** The working folder
holds **a subfolder per product**, and one workspace folder inside that:

```
<working folder>/crm/<instance>[-sandbox]-<orgid>/
<working folder>/analytics/<project>/
```

so a single folder serves every Zoost product without the two ever meeting. Each app enumerates
**its own** subfolder (`APP_DIR`), never the root. The folder names are labels: renaming the folder,
or renaming the Zoho portal, must not orphan a workspace — the list is built by reading each config.

Workspaces found sitting directly in the working folder are the older flat layout. The panel does
not adopt them; it says precisely how many there are and where to move them. Detecting them is not a
compatibility fallback — nothing keeps working the old way — it is an empty state that tells the
truth instead of reporting "no workspaces" while the folders are plainly there.

**A workspace can carry a name of the user's own, and it never replaces the identity.** The derived
name comes from the platform and the platform is not always helpful: Zoho Analytics names the first
workspace of every account the same way, so several projects arrive on disk indistinguishable, and a
Zoho CRM instance id is exact without being memorable. `label` in `.zoost.json` is displayed *instead
of* the derived name in the workspace list — and the derived name is kept in the option's tooltip, in
the bar underneath (which always states the real org or workspace the folder is bound to) and in both
exports beside the label. **A list showing only our own words would be one nobody could check against
Zoho**, which is the whole posture of the product. It is written through `patchCfg`, never `writeCfg`.

**And the `cacheBinding` trap was still live in two places while this was being built.** The CRM's own
`pullAll()` wrote `.zoost.json` whole, dropping the access verdicts every other writer had put there;
Analytics had no `patchCfg` at all and its pull replaced the file twice over. Both now merge. The
lesson is the one already in this file and it keeps costing: **every writer of a shared file merges,
and the moment a new field lands there, the writers that predate it are wrong.**

**The environment guard is the most important safety property.** Each workspace is bound to one
org, host and instance. If the active Zoho tab belongs to a different org, every Zoho-bound action
is disabled. Do not weaken this for convenience.

**Layout, relation and schema data come from the pull, not from live calls.** The graph window
reads what was written to disk. If a feature needs data that is not in the module JSON, the pull
has to be extended and the user has to re-pull — say so in the UI rather than failing silently.

**A fact already on disk is derived, not re-captured.** «How many workflows have actions that do not
run immediately» had no answer anywhere: the workflow *list* endpoint does not carry it, so
`_workflows/_index.json` does not either — and it was sitting unread in every `_workflows/<id>.json`,
one level down, inside `conditions[].scheduled_actions[]`, along with `last_executed_time`.
`wfScheduled()` reads the rule the pull already wrote. Putting it in the index instead would have
meant a field older workspaces lack and a re-pull to acquire it, for something that was never
missing. **A workflow not downloaded yet has no count rather than a count of zero** — «0 scheduled»
about a rule nobody has read is a measurement that was never taken, and both the panel and the tool
say so.

**Function meta carries a schema version (`sv`), and old copies backfill themselves.** When the pull
starts capturing a new field (e.g. `connections`, `modified_by` in 1.2.0), bump `sv` in
`content-bridge.js` `toFile()` and in `META_SV` in `sidepanel.js`. Functions on disk below `META_SV`
render as **stale** (amber ◐ dot) and are folded into the "Complete missing / Refresh outdated"
flow, so existing workspaces top up the new fields with one click instead of a full re-download.
This is how you evolve the captured data without orphaning already-pulled workspaces.

**Related-list API names are a first-class concept.** The API name of a related list is neither
module's `api_name`, and it is what `zoho.crm.getRelatedRecords()` requires. This is the single
most valuable thing the tool surfaces; treat it accordingly.

**In CRM a node's id is its name; in Analytics it is a number.** The graph window prints
`DATA.focus` and node ids in the status line and in edge tooltips, which reads fine when the id is
`Contacts` and is useless when it is `177856000000004012`. Anything user-facing must go through
`label(N[id])` with the id only as a last-resort fallback. The same asymmetry is why `nameOf()` must
never return a bare `.name`: an id that does not resolve produced the literal string `undefined` and
it travelled all the way into the diagram as if it were a table.

**Validate ids where they enter, not where they are printed.** `dependencyview` returns
`{objId, level}` in every captured response, but `String(x.objId)` on an element without one yields
`"undefined"` — a string that passes every later check and only fails visibly at the far end, as a
node called "undefined". The bridge now accepts an object with `objId`/`id` or a bare id, requires it
to look like a Zoho id, drops what does not, and **counts what it dropped** so a silent gap becomes a
stated one.

**One window, two names, and never a third.** The same diagram window was reached as `Graph ↗`,
`Schema ↗`, `ER ↗` and `Open ER` — four names the author himself could not keep apart. Two survive,
because there are genuinely two drawings: **Call graph** for functions, **ER diagram** for modules and
for tables. Anything that opens it focused on one item uses the same name and says *what* it is opened
on in the tooltip. The dead `graph:` field in the `TABS` registry, which nothing read and which kept
two retired names alive, is gone.

**A colour is a claim about a dimension, and this one was wired to the wrong dimension.** In the graph
window the filter chips select a function's **category**; the dot beside each row was coloured by its
Deluge **namespace**, and `pass()` compared the chip against the namespace too — so those five filters
only ever worked in an org where Zoho returns no namespace, and every dot fell back to grey. The
`--n-*` variables were named after categories and consumed as namespaces, which is why the mismatch
survived: it looked right in the stylesheet. One accessor (`KINDOF`) now feeds the dot, the chips, the
filter and the legend, so they cannot disagree; **values get a hue, conditions do not** — hub, orphan,
no-caller and unresolved are facts *about* a thing, not kinds of thing, and colouring them would claim
eleven categories where there are six.

**"Modify" promised something the product refuses to do.** The Modules preview offered `Modify ↗`,
which opens Zoho's layout page and changes nothing — the button said the opposite of the first
non-negotiable. It is `View ↗` now, and so are the function name and the status message behind it: an
internal `openModuleLayoutEdit` is how the word gets back onto a surface later.

**The graph window is one engine, fed by two products.** `graphview.js` consumes a generic shape —
`{kind:'schema', nodes:{id:{fields[], calls[], called_by[], …}}, edges:[[a,b]], focus, depth}` — and
everything expensive lives there: the ER layout with both branches, the depth control, the layout
sliders, the force graph, the PDF export. So a new product does **not** get a second diagram: it
expresses its own world in that shape and the window works. Analytics maps table→node,
column→field, foreign key→`lookup`, relation→edge, and only the genuinely product-specific parts
were rewritten in its copy — the edge card (a join, not a related-list snippet), the relations table,
the filter chips and the wording. If you find yourself changing the layout maths on one side, it
almost certainly belongs on both.

**The ER diagram has two layout branches**, and they are mutually exclusive:
concentric (focus + ego set) driven by `ring`, and force-directed driven by `spread`.
A control that does nothing in the active branch must be hidden, not shown and ignored.

**Readability trade-offs are exposed, not guessed.** Diagram spacing, spread and label size are
runtime sliders, because there is no single right value across graphs.

**Analytics takes the workspace from the URL, not from a list.** `/workspace/{id}` carries it, so
there is nothing to scrape and nothing to be fragile about — and the workspace-list endpoint is not
needed at all. This is the same shape as the CRM panel taking the org from the tab it is looking at:
the user says which workspace by being in it. Outside a workspace URL the panel says so and every
action is disabled, rather than picking one.

**The Analytics data model, as measured — not as assumed.** Seven view types. Only **Table** and
**QueryTable** carry columns of their own; `GETALLTABLECOLDETAILS` describes exactly those in one
call, and its keys **are** `VIEW_ID`s (verified: 135/135 match, and its name and kind agree with the
view list's). Everything else is presentation, and `VIEWLIST`'s **`PARENT_ID`** says what it is built
on — every presentation view resolves to a data-bearing view in exactly **one hop**, so the whole
report-to-source graph costs no extra call. Dashboards have no `PARENT_ID` and no columns; that is
correct, not a gap. `structureChain()` walks the chain so a report can show its structure instead of
shrugging, and always states whose structure it is showing.

**Foreign keys are per column, and they are provable.** `ZDBCreateERD.ma`'s links carry
`sourceColumns` / `targetColumns` as **indices into that node's own `columns` array** — meaningless
outside the response, so the bridge resolves them to names before they travel. Rebuilding
`(A.col)=(B.col)` from the resolved pair reproduces Zoho's own `relationstring` on **119/119** links,
which is why the columns view can state a column's foreign key as fact rather than as a guess. The
panel shows both directions and they are different facts: **→** this column points at another table,
**←** another table's column points at this one. They are real navigation, like the CRM's function
cross-references — a name you cannot click is half an answer.

**Relations come from the ER endpoint, and nothing else exposes them.** Three kinds, all provable:
table↔table joins (`ZDBCreateERD.ma`, written as Zoho writes them), query→source at column level
(`editsql`'s `PAROBJID` / `PAROBJIDINVCOLS`), and view→view (`PARENT_ID` plus `dependencyview`).
Zoho's own `relationstring` is displayed verbatim rather than re-rendered in our words: the fact is
the product, our phrasing of it would be an interpretation.

**An Analytics pull fails in two different ways, and conflating them would be dishonest.** A
*stage* (view list, structure, ER model) is one call: if it does not answer there is no partial
result worth keeping, so the pull stops and **nothing is written** — what was on disk stays as it
was. An *item* (SQL, lineage) is one call per view: one unreadable view must not cost the other four
hundred, so failures are collected into `pullFailed`, the pull completes, and the panel states how
many were missed. Both are recoverable without re-downloading the workspace — **Retry failed**
re-reads exactly the failures, **↻** in the detail pane re-reads one view — and `writeLineage()` /
`writeSql()` are split out precisely so a single-item refresh rewrites only what it touched.

**A pulled Analytics workspace on disk** is `views.json` (census + folders), `schema.json` (columns
per table **and the relations**), `lineage.json`, and one **`sql/<name>-<id>.sql` per query table** with `sql/_index.json`
carrying the id-to-file map and the column-level lineage. The `.sql` files are the point: they are
the only thing in Analytics that is genuinely source someone wrote, and one file each is what makes
`git diff` able to answer "what changed in this workspace last month" — which Analytics cannot.

**"Nothing depends on it" is a candidate, never a verdict.** The dependency scan asks Analytics its
own question, one view at a time, and Analytics only knows what its views read from each other. A
shared link, a scheduled export, an embedded report or an API consumer is invisible to it. Same
discipline as the connection usage counts in CRM: the coverage gap is stated next to the number.

**The Analytics SQL dialect is a sourced reference, not knowledge.** `apps/analytics/analytics-sql.js`
is the one thing in that extension not derived from the user's own workspace, and every line in it
comes from Zoho's published documentation, cited in the file. It is a separate file because three
places need the same text — the AI system prompt, the options page (so the user can read what the
model is being told), and the **Markdown export**, which exists to be handed to an agent that has
never seen Analytics and would otherwise write SQL that cannot run. If a rule cannot be sourced it
is left out: an incomplete reference is recoverable, an invented one sends the user to paste a query
that fails. Zoost never runs, validates or deploys SQL — what the assistant writes is a draft.

**The CRM's tabs come from one registry, and what a role cannot reach is measured, not assumed.**
`TABS` in `sidepanel.js` is the single list; the segment row is built from it, so adding a type does
not mean remembering it in the markup, in five `.active` toggles, in five click handlers and in two
label maps — which is what it used to mean, and why the set could never be reordered. Two independent
reasons remove a tab, and they must not be conflated:

- **the user hid it** (`tabPrefs` in `chrome.storage.local`, with the order) — a preference, per
  install. It changes the panel and nothing else: `Pull all` still mirrors that type, and it still
  reaches the exports and the AI index. Hiding a tab must never quietly shrink the mirror.
- **Zoho refused it** (`access` in the workspace's `.zoost.json`) — per workspace, because a role is a
  property of an org and the same person can be an administrator in one and read-only in the next.

There is no reliable way to ask Zoho what a role permits, so it is discovered by pulling, and only an
outright **401/403** counts: anything else is a failure, stays visible, and is retried. The verdict
carries the date it was given, because "forbidden" is a record of what was asked and not a permanent
truth — `Pull all` re-asks, and skips areas already refused so a pull does not become a list of
failures nobody can act on. An area with no measurement is visible; absence of an answer is never
read as a no.

The panel publishes a display-only copy of that record to `chrome.storage.local` (`tabAccessView`)
because the options page has no folder handle and must still be able to say *why* a tab is gone.
`.zoost.json` stays the authority: the copy is only ever read into a sentence.

Two consequences that were nearly missed. The tab you are **looking at** always has a segment even if
hidden — Health links jump straight to a workflow or a schedule, and landing on a list whose segment
is absent reads as the panel having lost its place. And `writeCfg` replaces the whole file, so
everything that writes to `.zoost.json` now goes through `patchCfg`: the `cacheBinding` trap, arriving
a second time with a new field.

**Analytics has no tab registry, and that is deliberate, not drift.** It shows one list with a type
filter — there are no modes to enumerate. What *did* have to land on both sides is the permission
distinction: `api()` in each bridge raises a typed error carrying `status` and `forbidden`, and both
carry those two fields **explicitly across `chrome.runtime` messaging**, where `String(e)` would drop
them. That boundary swallowed the same fact in three separate places before it was written down.
Only the HTTP form is classified. Analytics also answers `200` with `{"status":"failure"}`, and
whether a permission refusal ever arrives that way has **not** been measured — so that path stays an
ordinary failure rather than being labelled a refusal on a guess.

**Anything that is not Zoho opens in its own window, never a tab.** `chrome.tabs.create` *activates*
the new tab, so the panel suddenly finds itself looking at a non-Zoho page: the environment guard
fires, the interface empties and the mismatch overlay appears. That is right when it means something
and disorienting when it does not — clicking Help made the workbench look like it had lost its place.
A delegated click handler routes every `http` link through `openExternal()`, and the *only* ones let
through to a tab are Zoho's own, decided by `isZohoUrl()` rather than by a list, so a link added
tomorrow is covered. `target="_blank"` stays on the markup on purpose: `preventDefault()` suppresses
it, and if the handler ever failed to attach the fallback is a stray tab rather than the side panel
navigating itself away.

**Settings open in one window, and the form still refuses to save over a value that moved.** Two
things, and the second is the one that matters. `openOptionsPage()` opens a *tab* and de-duplicates
only within the current browser window — while the side panel is per window, so two browser windows
give two settings tabs and a working day gives ten. `openSettings()` in each panel queries every
window for an existing `options.html` tab, focuses it, and opens a dedicated popup only if there is
none. Existing duplicates are **focused, never closed**: one of them may hold edits, and discarding
those to enforce uniqueness would commit the exact mistake this prevents.

But uniqueness by construction does not stop *this* copy going stale. It can sit open for hours while
the panel writes the same keys — `exportScope` is rewritten on every export with a different scope,
`aicfg` when the engine changes — and Save then writes back what was true at page load. That is the
lost update, and it is the same shape as having one Deluge function open in two tabs and being
invited to "save your work" by the older of them. So each section in `options.js` watches its own
key: changed elsewhere and untouched here, the form catches up silently; changed elsewhere while
being edited, **nothing is overwritten in either direction** and the section says so with both ways
out. The page's own writes are marked so it does not warn about itself, and that mark expires so a
real later change is still seen. **Never resolve this by guessing which side is newer** — the user is
the only one who knows which they meant.

**«Reveal in folder» was asked for and cannot be built — the reason is worth keeping.** Chrome gives
an extension no way to open the operating system's file manager: `chrome.downloads.show()` reveals
only files that went through the downloads API, and the File System Access API deliberately exposes
no absolute path — a `FileSystemDirectoryHandle` carries the folder's *name* and nothing else, which
is the whole point of the permission model. So the panel cannot even build the path to put on the
clipboard, let alone open it. What it can offer is the workspace-relative path, which is what the
export headers and the AI already print. Do not "just try" a native-messaging host for this: that is
a second installable component, outside the package a reviewer reads, for a convenience.

**Excluding an area never deletes its files, and a "remove local files" *flag* was considered and
refused.** A standing instruction to delete on every future pull is a foot-gun — re-enable the tab,
forget the flag, and the next pull has already thrown the files away — and deleting solves nothing
that dating solves: it destroys history that is sitting in Git, the reason the mirror exists, to stop
a report being misleading, which the per-area dates already stop. A **one-off action** ("delete the N
local files for this type", with the count and a confirmation) is defensible and is an accepted
nice-to-have, deliberately not built yet. If you find yourself adding a persistent delete switch,
this is the argument you are overturning.

**The assistant is told what the extension itself does, and that is the point of the product.**
`product-help.js` in each app is a plain-language description of what exists, where it is, and what it
will not do — same shape as `analytics-sql.js`: one text, more than one consumer, so it cannot drift
between them. The reason is not convenience. Zoost is used by people who know their org and are not
developers, and the assistant exists so their questions stop travelling to whoever administers the
system. That fails if the questions merely change shape: replacing "what does this workflow do?" with
"how do I use Zoost?" solves nothing, because the same person is still being asked. So "how do I
export this?" is answered in the panel, where the user already is.

It costs about a thousand tokens on **every** message, so the context line under the chat title
counts it: it reads *sent with every message*, not *index*, because a figure that reported only the
org index would understate what is billed. What belongs in that file is what exists and what it
refuses to do; how anything works inside does not — nobody asking "what happens if I click Export?"
wants to hear about the file system API. **A capability added to a panel belongs there too**, or the
assistant will confidently describe a product that is one version out of date.

**The AI index is layered, and what does not fit is named — in both apps.** A workspace of a thousand views does
not fit in a system prompt sent with every message, so the question is never "how big a cap" but
"what gets dropped". Dropping the tail is the wrong answer: it cuts an arbitrary half and the model
cannot tell it is missing, which is how it ends up asserting a view does not exist. `aiBuildSeed(cap)`
assembles in priority order — **the vocabulary is never dropped**: data objects in Analytics,
the function list in CRM, because they are the vocabulary
needed to write a query or follow a foreign key; reports and dashboards go first because
`list_views` can find them by name — and whatever is left out is stated in the prompt itself with
what to call instead. Measured: 1144 views and 444 data objects come to ~62k characters (~15k
tokens) and fit whole; at 2429 views the tables still fit in full and the reports are declared
absent.

The cap is a **setting**, because the trade it makes is the user's to price: a bigger index means
the assistant knows more names, and it is billed on every message. A number in a form is not a
choice, though — so the panel measures the index for the workspace actually open and prints it under
the chat title, in characters and approximate tokens. The knob and the consequence are in the same
sentence.

**`aiCap()` existed in Analytics only, for months, while this file described it as the rule.** The
CRM panel had no such helper and `search_code` truncated at 60 hits in silence — the exact defect the
convention was written against, on the side nobody checked. Ported byte-identical.

**Tool answers are capped too, and say how to narrow.** A tool that returns nine hundred lines has
not answered. `aiCap()` cuts the list, states the true total, and tells the model which argument
would narrow it.

**The assistant is told what you are looking at, whatever kind of thing it is.** `aiFocus()` builds
the `CURRENT FOCUS` block from `currentPath`, which every tab already sets. It handled `.dg` files
only for a long time, so selecting a workflow and asking "what does this do?" got "give me details"
while the same question about a function worked — the "one of a set" miss, invisible until somebody
asks the obvious question. The non-function kinds are **serialised from the captured data** rather
than described field by field: a second description of each shape is free to drift from the pull
that produces it, and a field named here that does not exist is how an assistant ends up discussing
something that was never there. Workflows read their **file**, not the index entry, because
conditions and actions are what the question is about — and when only the index is on disk the
prompt says so instead of looking complete.

**AI configuration lives in the options page**, not the side panel. The panel is ~400px wide and
those are set-once fields. The panel picks changes up via `chrome.storage.onChanged` plus a
`window.focus` re-read. A selector that changes a *mode* saves on change, not behind a Save button.

**The API key is stored in clear text by default, and the passphrase that changes that is opt-in.**
Chrome gives extensions no encryption at rest and no credential store, so anything the extension can
unlock by itself, anyone with the browser profile can unlock too — encrypting with a key kept beside
the ciphertext would be **theatre, and worse than storing plainly**, because it lets us claim a
protection we do not provide. The only real protection is a secret we do not hold. So `keyvault.js`
(byte-identical in both apps) offers PBKDF2-SHA256 → AES-GCM-256 over a passphrase the user chooses,
the ciphertext is what sits in `chrome.storage.local`, and the unlocked key lives in
`chrome.storage.session` for the browser session. **There is no recovery** — no hint, no escrow, no
reset — because a secret whose replacement costs one visit to a provider's dashboard does not deserve
a back door, and a back door is what a recovery path is.

**The switch works in both directions, and getting that wrong was nearly the worst bug in the
feature.** Turning the protection *off* needs the passphrase too — clear text means decrypting what is
stored, and we do not hold the secret — so the first version simply deleted the ciphertext and wrote a
config with no key at all: silent, total, irreversible. Two rules came out of it, both binding.
`mergeKeys()` **never destroys**: a failed or absent unlock keeps the ciphertext exactly as it was.
And the handler **refuses to save** a config that says "no protection" while a ciphertext survives,
because that state is a key nobody can read described as one anybody can. The question that found it
was the obvious one — *can I go back?* — asked by the user, not by a test, which is the failure.

**You cannot re-encrypt what you have not decrypted, and three different-looking actions are that one
fact.** Changing the passphrase, replacing the API key while protected, and turning the protection off
all end in a write that must start from the plaintext — which only the user can produce. Missing it
made **Change passphrase ask for the new one twice, save, report success and change nothing**: the
merge read `had.apiKeyEnc && !typed` as "leave it alone" and never looked at the new passphrase at all.
The form therefore asks for the passphrase **in use** whenever any of the three is happening
(`aiNeedCurrent()`), and the handler **proves it against the stored ciphertext before writing** rather
than taking it on trust — encrypting a new key with a mistyped passphrase locks the user out of a key
they believe they can open, and nothing would tell them until the next browser restart.

**A blank key field means "keep", except in the one place that says "erase".** Those two are the same
screen state and must do opposite things: blank-means-keep is what stops an unrelated save from wiping a
key the user cannot retype because it is encrypted, and a **Forget** button per provider is the declared
exception — it clears model and key on the next Save, and it is the only way out for a key whose
passphrase is gone. Without it "I have forgotten the passphrase" would have no answer inside the page,
because the merge rightly refuses to drop a ciphertext it cannot read.

**A rule enforced on the user and not on the default is worse than no rule.** The engine selector
refused a move *to* an unconfigured provider and said nothing about *sitting on* one — and a fresh
install sits on Anthropic with nothing filled in, so it showed a chosen, working engine that could not
answer a single question. Two consequences: every option states whether it is ready
(`markEngineOptions()`), and a save that leaves **exactly one** usable engine selects it and says so,
because choosing the only engine that works is not a decision worth asking about.

**A recovery path that has to be worked out is not a recovery path.** Losing the passphrase already had
an answer — Forget on each provider, untick, save — and it was reachable only by deduction, which is no
use to somebody who has just lost a passphrase. **Remove the protection** does it in one control, acts
immediately rather than through Save (Save asks for the passphrase in use, which is the one thing that
does not exist here), is offered in **every** state where a passphrase exists rather than only the quiet
one, and states what goes and what stays before acting. Every message that mentioned the old sequence
now names this button; a test asserts none of them says "Forget above" again.

**The engine selector refuses a provider with no model or no key**, names what is missing, and puts
itself back. Not a preference: choosing an engine that cannot answer is a dead end the *panel* discovers
later, in another window, at the moment of a question. It judges the **form**, never what is stored —
refusing a key the user can see they have just typed would be the tool arguing with its own screen — and
it is not a dead end either way, because both providers' fields are on the same page.

It is **off by default and stated rather than defaulted**, on the user's own reasoning: on a personal
machine a passphrase each session buys little, on a shared one it buys a lot, and nobody but the user
can price that. Three consequences that are not optional. The limit is named next to the promise — a
key already unlocked is in the browser's memory, so what a passphrase protects is the key *at rest*.
`aiGetCfg()` is the **single** place that puts the plaintext back into the config, so nothing
downstream learns about passphrases at all — which is why `aiSaveCfg()` had to go: it was already
dead, and the moment `aiGetCfg()` started returning a decrypted key, a config written back would have
put the plaintext on disk. And `mergeKeys()` in `options.js` exists as a named function purely so it
can be tested: **a blank key field with a key already stored means "leave it alone", never "erase
it"**, because a protected key cannot be redisplayed and reading that blank as a deletion would throw
the user's key away on any unrelated save.

## Traps already hit — check for these

These all failed **silently**, with no console error. They are the expensive kind.

- **A free variable is a syntax-clean bug, and only *running* the function finds it.** A bulk edit gave
  Analytics' `loadAi()` a reference to `cfg`, which exists in the CRM's copy of that function and not
  in its own: a ReferenceError three lines in, silently abandoning everything after it — the OpenAI
  fields, the tool-step cap, the index cap, the engine highlight, the dropdown labels. The page looked
  half-filled and said nothing, and `node --check` passes because the syntax is fine. A regex
  approximation of `no-undef` was written and **measured at 2251 findings** across the shipped scripts,
  then thrown away for the reason the content checker was: a checker with that ratio is one nobody
  reads. What works is the technique already here — lift the function and **run it** against a stub
  DOM. Zero false positives, exact, and it costs a test rather than a tool.
- **Fields first, state second.** The same `loadAi()` called `syncLockRow()` and `markEngineOptions()`
  before filling the form they both read, on *both* sides. It worked by accident, because the fallback
  path reads what is stored; after a save, the form still holds what the user typed, and the row would
  ask for a passphrase nobody needed.
- **An author `display` beats the `hidden` attribute, and nothing says so.** `hidden` is a UA rule, so
  `.lockrow{display:flex}` on an element that also carries `hidden` leaves it on screen — no console
  error, no layout break, just a row that is always there. It shipped **twice in one change** (the
  passphrase row in Settings, the unlock row in the panel) and was found by the user opening the page,
  not by a check. Every shipped page now states `[hidden]{display:none!important}` once, and
  `htmlcheck.py` reports a page that uses the attribute without carrying the rule. The check is
  deliberately per *page* and not per element: a per-element version goes quiet the moment someone adds
  a `display` to a class that did not have one, which is exactly how this happened.
  **And then it shipped a third time, on the site, where the check could not see it.** `.btn` is
  `display:inline-block`, so `analytics.html` showed *both* «Get it on the Chrome Web Store» and its
  «in review» alternative — live, for as long as the pair has existed — while `site.js` set
  `el.hidden` on one of them and had no way to know it was doing nothing. Note the shape: the fix was
  applied wherever the bug had been *seen* (`apps/`) and nowhere else, and `display_override()` read
  only inline `<style>`, which for a page that links a stylesheet is most of its CSS missing. It reads
  linked sheets now, `site.css` states the rule once, and the site's pages are in the checked set.
- **`requestPermission()` needs a user gesture, so it cannot live inside the agent loop.** Chrome lets a
  File System Access permission lapse after inactivity, and the AI path reads the mirror directly — the
  seed index, the tools, the graph — while being the one path that never re-requested it first. The read
  then throws `NotAllowedError: The request is not allowed by the user agent or the platform in the
  current context.`, which names neither the folder nor the remedy and reads as the extension being
  broken. It surfaced as "the chat fails until I click an item and come back", because clicking an item
  runs `ensurePerm()` under a real click and fixes it as a side effect. `aiEnsureFiles()` now runs at
  both entry points — **Send and opening the view, which are gestures** — and note *why* it has to be
  there: the same call made after a round trip to the model is refused for want of activation, which is
  the error itself. The Health view hit this first and its fix was never generalised; that is the
  recurring shape, not the DOMException.
- **A platform exception's message is a symptom, and shipping it verbatim ships a symptom.**
  `aiErrorText()` translates that one string into which button to press, and passes everything else
  through untouched rather than dressing it up. It matches, it does not parse, and it branches on
  nothing.
- **In the CRM panel `#status` is *inside* `#belowbar`, so the AI view covers it.** `#aiview` is
  `position:absolute; inset:0` in that container, which is the documented decision — the view owns
  everything below the main toolbar — but the consequence had never been drawn: **every `setStatus()`
  made while the chat is open is written to an element nobody can see.** In Analytics the status bar is
  a top-level sibling *above* the view, so the same code reports and the CRM does not. It surfaced as
  "typing a wrong passphrase shows no error", which was true on one side and not the other. The rule
  that follows is general and not about passphrases: **a verdict about a field goes beside that field**;
  the status line is a second copy, never the only one. A test asserts the containment so that whoever
  changes the layout finds this note instead of rediscovering it.
- **A form that has just written state must re-read it, not patch its own flags.** After saving a
  passphrase the two boxes were still on screen, empty — which reads as "the save did not take", and was
  reported as exactly that. The page carries three facts that have to stay in step (is a key stored, is
  it encrypted, is a passphrase set) and the save updated storage without updating any of them.
  Reconstructing them at the end of a handler is a second copy of `loadAi()` waiting to drift, so the
  handler calls `loadAi()` instead: the form agrees with the disk because it was read from it.
- **A control with nothing to ask is absent, not empty.** Same bug, other half: once a passphrase *is*
  set there is no question left — the passphrase is not ours to redisplay — so a pair of empty boxes is
  not "the field for it", it is a prompt with no prompt. The row now states that the key is encrypted
  and offers **Change passphrase**, which is what brings the boxes back. This is the same rule as the
  CRM's "Complete missing" button being `display:none` rather than greyed.
- **A sentence in the UI must derive from the state it describes, not from the control next to it.**
  The same change put "Enter the current passphrase to turn the protection off" under an unticked box
  on a machine where no passphrase had ever been set — correct for the only case it was written for,
  wrong the first time anyone opened the page. The row's *visibility* was right; the text was
  conditioned on the checkbox instead of on whether anything was actually protected.
- **A mark fused to a number changes the number.** The Analytics view list printed inherited column
  counts as `↳19`, flush against the digits, in the one column the reader scans as figures — and it
  read as «419». The fact is real (the view has no columns of its own; the count belongs to the view it
  is built on) so it stays, in brackets: `(19)`, muted, with the tooltip naming the source and the
  header explaining what brackets mean. **A mark that can be mistaken for a digit is worse than no
  mark**, and this is the same family as the `↺`/`↻` collision — a symbol judged on its own instead of
  next to what it sits beside.
- **A label that lives in the markup must not be rebuilt by the code that updates state.** Replacing
  three words with marks broke in three separate places at once, all of them invisible until you
  touched something: `$('pullone').textContent = 'Pull'` put the word back on every mode switch,
  `$('graph').textContent` did the same, and Analytics' `updateButtons()` set `$('pull').title = ''`
  on every repaint — which for a mark is not cosmetic, because **the tooltip is where the name lives**.
  Only what genuinely varies is written from code (the title's *detail*, the aria-label when a button
  means two things in two modes); the label itself stays where it was authored. A test asserts it,
  because the same defect appeared three times in one afternoon.
- **An icon button is not a text button with the padding removed.** `padding:0` made the marked
  controls visibly shorter than the words beside them: the height comes from the line box, and a 13px
  block is one pixel under the 14px a word makes. Keep the vertical padding, give the mark a 14px box,
  and note the general form — six buttons carried `style="font-size:15px;line-height:1"` inline and
  are now one `.glyph` class, because the next 1px difference should be fixable in one place.
- **JS escapes inside HTML text.** `\u2699` written into markup renders as the literal string.
  HTML does not interpret JavaScript escapes. Use the character, or an HTML entity.
- **`esc()` is not attribute-safe** — and writing that down was not enough, because it shipped again.
  An outside review found several `title="${esc(...)}"` carrying names that come from Zoho, and two
  carrying an API error message with no escaping at all. `tools/htmlcheck.py` now reports any
  `attr="${…}"` whose value is not demonstrably a literal and does not go through `escA`, and all six
  shipped scripts share one definition of `escA` — escaping `& < > " '` — so nobody has to work out
  which file they are in or which quote style an attribute used. Its own first version carried a list
  of identifiers "known to be ours", which let `n.name` through while reporting the number 42: the
  criterion has to be a property of the value, never a list of names. Element *content* was audited
  by hand across all 379 slots instead: 378 were numbers, our own literals, or markup this code had
  just built, and **one** was real — a Zoho namespace written raw into a group header. A general
  content checker was built to prevent a recurrence and then **discarded**: even after inferring
  escaper aliases, HTML-typed variables and accumulator patterns per file, it gave 87 false
  positives for that 1 finding, and a checker with that ratio is one nobody reads. The reason it
  cannot do better is worth knowing before rebuilding it: "this string is already markup" is a fact
  about intent, not about syntax. The exposure is narrow and real: MV3 blocks inline script, so what is left is a
  spoofed interface and an `<img src="https://…">` that fires on render, in a panel holding an API
  key.
- **`esc()` is not attribute-safe (original note).** It escapes `& < >` only. A double quote inside an attribute
  closes it early and truncates the value — this is what cut the `getRelatedRecords` snippet in
  half. Use `escA()` in attribute contexts.
- **CSS specificity and source order.** `.erbox.dim .erhdr` placed before `.erbox.custom .erhdr`
  loses at equal specificity. Muting rules must come after the rules they override.
- **Sticky headers need a z-index.** Without one, later siblings paint over them and rows appear
  to slide above the header.
- **A sticky header also needs its scroll container to have no padding above it.** `position:sticky;
  top:0` sticks to the container's *padding* box, so with `padding-top` on the scroller the header
  parks below the gap and rows scroll up into the strip above it — visible, and reported. Put the
  padding on the non-table content instead (`.dpad`), leave the scrolling box at `padding:0`, and
  let the table's own cells carry the spacing.
- **Overlays sized to the wrong container.** `inset:0` covers the positioned ancestor, not the
  panel. Check what actually needs covering before choosing `absolute` or `fixed`.
- **Functions that rewrite state as a side effect.** `cacheBinding` writing `.zoost.json` would
  have clobbered `lastPull`, because it carries fewer fields than the file holds.
- **OpenAI model compatibility.** Newer models reject `max_tokens` and require
  `max_completion_tokens`. The call tries the first and retries on that specific 400.
- **Stripping comments and strings from Deluge cannot be done with chained regexes.** Removing line
  comments before string literals cuts `url: "https://x"` at the `//`, which leaves an unterminated
  quote that swallows the following lines — the counts then silently under-report. `stripNonCode()`
  is a single left-to-right scan for exactly this reason. A unit check caught it; the eye did not.
- **`/deluge/` endpoints want a different CSRF prefix than `/crm/`.** The `/crm/...` APIs take the
  CSRF token as `crmcsrfparam=<token>`; the `/deluge/` (deluge runtime) APIs take the *same* token
  value as `drepn=<token>`. Wrong prefix → **400, not 401**, so it reads as a bad request, not an
  auth failure — misleading. `api(path, csrfPrefix)` in `content-bridge.js` carries the prefix; the
  connections catalogue (`/deluge/api/ui/v1/{org}/services/ZohoCRM/connections`) uses `drepn`, and
  needs the `zuid` (scraped from the page like the org id).
- **The deluge CSRF token is the `drecn` cookie, not `CT_CSRF_TOKEN`.** "Same token value, different
  prefix" was measured once and held for months because the cookies usually carry the same value —
  then `drecn` rotated on its own and the connections pull started answering **400
  INVALID_CSRF_TOKEN**. Note the shape: the header prefix is `drepn`, the cookie is `drecn`, one
  letter apart and neither derivable from the other. `CSRF_COOKIES` in `content-bridge.js` maps
  prefix → cookie names, and there is a cross-family fallback so a missing cookie degrades instead of
  sending an empty token. This is the same rule as the Analytics bridge, learnt from the other side:
  **find the source by making the page tell you** (hook `setRequestHeader`, compare what Zoho's own
  UI sends against the cookie jar, print only the matching *name*), never infer it from the prefix
  and never assume two tokens that match today are the same token.
- **The first `/deluge/` call after a fresh login is refused, and any `/crm/` call fixes it.**
  Reproduced deliberately: log out, log in, pull connections → **400 INVALID_CSRF_TOKEN**; pull
  schedules; pull connections → works. It never showed up in "Pull all" because functions run first.
  Whether `drecn` is not yet set/refreshed, or the deluge session is not yet initialised server-side,
  is **not established** — and does not need to be, because the remedy is the same either way. `api()`
  makes one ordinary CRM call and retries **once**, only on that exact status-and-message pair and
  only for the `drepn` family; the primer's result is ignored, since it is the side effect we want.
  This is the "recovering by a known action" exception, not a retry loop — and note it is allowed
  precisely because the recovery was *measured* rather than guessed at.

- **A failing response explains itself in its body, and throwing that away costs the answer.**
  `400 on /deluge/api/…` names the symptom; `— INVALID_CSRF_TOKEN` names the cause. Both bridges read
  a short prefix of the body and quote `errorMessage`/`message`/`error` if it is there. Nothing
  branches on it — it is quoted, not parsed.
- **Freshness is per area, and staleness is derived rather than declared.** Once areas can be
  excluded from a pull, one `lastPull` for the workspace is a lie: the mirror is current in four
  places and four months old in the fifth. `access[area]` carries **`at`** (when we asked) and
  **`pulledAt`** (when we last got data); `areaStale()` compares against the newest `pulledAt` with a
  six-hour margin, so the seconds between areas in one pull are not a finding. Nobody sets a flag,
  so nobody can forget to — and it is equally true for an area that was refused or that failed.
  Consequences, all binding: the export dialog **unticks** a section whose data is behind and says
  the date and the reason, both reports state the per-area dates **whether or not** anything is
  behind, and the choice to include an old chapter stays the user's.

- **An HTML numeric entity written into a JavaScript string becomes that byte.** `&#0;` used as a
  sentinel inside a JS string literal put a real NUL byte in the source. Nothing failed: the file
  parsed, the editor showed nothing, and `grep` quietly reported "Binary file matches" and returned
  no lines — so a search for the sentinel found it nowhere. The mirror image of the trap above it
  (JS escapes inside HTML text). Sentinels are plain ASCII: `'__orphans__'`, not an entity.
- **`toISOString()` on a date parsed as local time shifts the day.** `new Date(' 03 Jul 2025')` is
  local midnight; `.toISOString()` converts to UTC, so anywhere east of Greenwich every date reads
  one day early. Format from `getFullYear()/getMonth()/getDate()`, never through UTC.
- **Analytics dates arrive already localized; only one field is machine-readable.** In `VIEWLIST`,
  `ACT_VIEW_MODTIME` is epoch milliseconds — the only value that can be sorted or formatted.
  `LAST_DATA_MODIFY` comes back as `"1 ora minuto fa"` and `LAST_DESIGN_MODIFY` as `" 03 Jul 2025"`,
  both rendered in the user's interface language. Those are displayed verbatim and never parsed:
  reading a localized date is the same mistake as matching a localized button label, and it fails on
  the first user whose UI is not English. Consequence in the UI: Design is shown, and stated as
  unsortable with the reason; Data is a real timestamp and sorts.
- **An empty string is falsy, so "empty" and "missing" become one message.** Five surfaces wrote
  `body || '(could not be read)'` for a query table's SQL. A query Analytics returned empty read as
  one that had never been fetched — and the assistant, told the SQL was unreadable, reconstructed
  what the query probably did from column names and presented it as its logic. Keep the two apart:
  `null` is unreadable, `''` is empty, and one helper decides the wording so the surfaces cannot
  drift. The same shape of bug is anywhere `x || 'fallback'` guards a string that may legitimately be
  empty.
- **A response missing the field you came for is a failure, not a default.** `querySql` coerced an
  absent `SQLQUERY` to `''`: the pull reported success, wrote an empty file, and the gap was
  invisible until an assistant tripped over it. It throws now, so the item lands in `pullFailed`,
  is counted, and **Retry failed** can pick it up. Same rule as the dependency ids — validate where
  the value enters.
- **Analytics answers `200` with `{"status":"failure"}`.** The HTTP code alone is not the success
  signal, unlike CRM. `api()` in the Analytics bridge treats anything that is not an explicit
  success as an error.
- **Analytics CSRF follows the HTTP method, not the path.** Measured across a 104-request capture
  with **no exceptions**: every POST carries `X-ZCSRF-TOKEN: ZDB_CSRF_TOKEN=<value>`, and no GET
  does. `api()` (GET) sends none, `post()` sends it, and that split *is* the rule — not a list of
  paths to keep in step. "The `/reportsapi/` family needs no token" was the wrong generalisation,
  drawn from a capture that happened to contain only that family's GETs; `POST
  /reportsapi/DashAnalysisViewsJSON` carries one.
- **A CSRF header's prefix is not the cookie's name.** The CRM bridge in this same repository proves
  it — prefix `crmcsrfparam=`, cookie `CT_CSRF_TOKEN` — and assuming `ZDB_CSRF_TOKEN=` meant a
  cookie of that name is what made the first Analytics ER pull fail. Find the source, never infer it
  from the prefix. On `analytics.zoho.*` the value is the **`CSRF_TOKEN`** cookie, with
  `CT_CSRF_TOKEN` holding the identical value — established by hooking `setRequestHeader`/`fetch` in
  the page and comparing what the app itself sends against the cookie jar, printing only the *name*
  that matched. That technique is the general answer when a token's origin is not in a capture: make
  the application tell you, do not try candidates against a live endpoint.
- **Two Analytics endpoints are deliberately never called, and that is a safety decision, not an
  oversight.** `ZDBTableDataAction.ma` returns `dataTextNew`, the actual cell values of a table —
  customer records, which Zoost states it never touches. `ZAChartView.ve` would give the report
  definition we otherwise lack (graph type, groupings, axes, thresholds), but it comes welded to
  `chartJSON`, the computed series — still customer data, with no known way to ask for the
  configuration alone. So report definitions for the presentation views stay **uncovered**, and
  every surface says so rather than implying the mirror is complete. Do not "just try" a parameter
  to suppress the data: guessing at that boundary is exactly where a read-only claim gets broken.
- **`ZDBCreateERD.ma` is a strict superset of `GETALLTABLECOLDETAILS`, and it carries the relations.**
  One POST (`DBID`, `ISERDGNEWFLOW=true`) returns the workspace's whole ER model. Measured against a
  capture: same 135 objects, same columns and types (only ordered differently), **plus** 119
  relations with the join written out as `(A.col)=(B.col)`, **plus** `lastModTime` in epoch
  milliseconds that matched `LAST_DESIGN_MODIFY` on 135/135 — the machine-readable design date the
  view list only gives as localized text — **plus** `isSystemTable`, which flagged 37 objects while
  `VIEWLIST` flagged none, **plus** a stable `colid` per column. It answers with **no `status`
  field**, so the shape is the only success signal and `api()`'s check would wave anything through.
  Its `links` reference nodes and columns **by array index**; those indices mean nothing outside the
  response and are resolved to view ids and column names before travelling any further.

The pattern behind most of these: a value crossing a boundary — between languages, between
contexts, between code branches — and being interpreted differently on the other side. Those are
the places to look first when something "does nothing".

## Naming and positioning

The products are **Zoost — workbench for Zoho CRM** and **Zoost — workbench for Zoho Analytics**.
Not "IDE": you do not edit code in them, and the audience is wider than developers. "Zoho",
"Zoho CRM", "Zoho Analytics" and "Deluge" appear only in a descriptive position, never as the
leading element of the name, and never in the icon. Every user-facing surface carries the
independent/unofficial disclaimer.

**The generic URL may not belong to one product.** `/docs` was the Zoho CRM guide while Analytics
carried its name in the path — the same asymmetry as the navigation, one layer down. The guides are
`/docs-crm.html` and `/docs-analytics.html`, and `/how-to.html` is the neutral way in that the
horizontal pages link to. `/docs` and `/docs.html` **301 permanently** to the CRM guide and must
never stop doing so: Zoost for Zoho CRM 1.9.0 has that URL compiled into it, and a published
extension cannot be asked to change. The redirect lives in `_worker.js`, since assets are served
first and a file at that path would win.

**The site is translated page by page, and a translation that falls behind is reported, not
remembered.** `site/it/` holds the Italian pages. Each one carries
`<!-- translated-from: site/<page>.html @ <sha> -->`, and `sitecheck.py` compares that sha against the
English page's last commit — so forgetting to update the Italian makes it **reported**, which is the
only direction that fails safe. The marker lives in the file rather than a side table, so whoever
copies the page carries it with them.

The marker is a digest of the **content**, not of the commit that last touched it. The first version
used the commit and was wrong in a way only using it revealed: editing an English page and its
translation in one change leaves the marker naming the commit *before* that change, so the check fires
on a translation that is perfectly current and cannot be satisfied until a second commit exists.

Four consequences, all deliberate. The **chrome is one shape per language**, not one shape overall:
it must not change as you move through a site, and it must change when you change language, because
the labels are the point. The **naming rules apply in Italian too** — a bare «Analytics» says exactly
as little about whose product it is. And the **UI control names stay in English**, because the
extension is: a guide that says *premi **Pull all*** is naming the button the reader will actually
find, and the Italian page says so in a line under the hero rather than leaving it to be discovered.

The **version badge is the one thing on a page written by script**, so a translated page cannot
translate it by itself: `site.js` carries a small string table keyed on `<html lang>`, with English as
the fallback for anything unlisted — a missing key shows English, never a key.

**Six pages are translated and two deliberately are not.** `index`, `crm`, `analytics`, `how-to` and
both guides have Italian versions; `privacy.html` stays English because it carries legal weight and a
second wording is a second thing that can be argued about, and `llms.txt` stays English because it is
read by a machine and one version cannot disagree with itself. Both are stated on the page rather
than left to be noticed. **The control names inside a guide stay in English**, because the panel is —
a guide that says *premi Scarica tutto* names a button the reader will never find — and the note
under each guide's title says so.

**A translation is structurally its original, and that is what makes it checkable.** Same sections,
same paragraphs, same order, so blocks pair up by position. `shared_prose_stays_shared()` uses that
to enforce the twin rule one layer down: prose identical on `crm.html` and `analytics.html` must stay
identical on `it/crm.html` and `it/analytics.html`. Eleven of twenty had drifted — «leggi ciò che
viene spedito» against «leggi quello che viene distribuito», «un passo manuale» against «un passaggio
manuale». Nothing was *wrong* in either, which is the point: a reader moving between the two pages
meets the same sentence twice in two voices, and the twins stop reading as twins.

Where a translation legitimately adds something — the note saying the control names stay in English —
the element carries **`data-it-only`**. Forgetting to declare an addition makes the page reported,
never silently exempt, which is the direction every allow-list here runs in.

**The first version of that check counted shared blocks per pair, and it was useless.** The Italian
pages happened to share one block the English ones did not, and that single spare was exactly enough
slack to swallow a real drift when one was reintroduced on purpose. It is kept as a test case. The
rule it proves is the one already in this file: *a checker that goes quiet on the bug it was written
for is worse than none* — and the only way to know is to break the thing deliberately.

**The language switch is on every page of both languages, and its target is contextual.** A control
that appears and disappears as you move through a site is the contextual *shape* this file already
bans, so pages with no translation still carry it, pointing at the other language's home with a
tooltip saying why. It reuses `.ncta`, which was defined in `site.css` and used nowhere.

**An Italian page links Italian, or says why with `hreflang="en"`.** The Italian home's two
«Come si usa →» links opened the *English* guides — reported by the user, and invisible to every
check here, which read prose and chrome and never an `href`.
`translations_link_to_translations()` reports a link to a page that has a translation unless the
element declares `hreflang="en"`, which is what that attribute is for; the deliberate ones — the
switch, «la versione inglese di questa pagina» — all carry it now.

**Two of those links had been fixed and then thrown away by `git checkout <file>`**, used to undo a
deliberate mutation while proving a *different* checker. It reverted the real, uncommitted work
sitting in the same file, and nothing noticed — the page then went out linking the English guide
*and* claiming the guide was English-only. Undo a test mutation from a copy (`cp` the file aside
first), never from the index, unless the file is known to be clean.

**A translation is reviewed for its Italian, not only for its faithfulness.** A pass over all six
pages found about forty defects that no check could see: «legge la tua org vero» (a masculine
adjective postposed to a feminine noun, which is what the user reported); «La colonna References
*sono* le chiavi esterne»; «quello che *serve*» for "what it serves", inverting the sentence;
«i campi presenti in **nessun** layout» and «tabelle in nessuna relazione», a bare negative
determiner with no verb to negate; «un assistente che Zoho Analytics non **l'**ha mai vista», a
relative with a resumptive clitic; «per la domanda separata **di se**»; «rispondibile», «rimostra»;
«Zoost compresa» on a page that says «Zoost è gratuito» four paragraphs later; and a dozen
inanimate `lei`/`lui`. **A mechanical sweep was written for the classes above and then not kept**:
outside the handful of real hits it was almost all noise — every `un elenco`, `un arco`, `un
assistente` flagged as a missing elision — and the rule here is the one already written down, that a
checker with that ratio is one nobody reads. Reading remains the only method for this class.

**A canonical must be the page's own URL, and a translated pair must point both ways.** Neither was
checked, and both were wrong: `analytics.html` and `index.html` carried `crm.html`'s canonical,
copied along with the head block — which tells a search engine those pages *are* `crm.html`, so the
product page and the suite home were each asking to be dropped. The Italian pages declared their
English original from the day they were written and the English ones said nothing back, which leaves
the engine to pick the language a reader lands on. `canonical_and_alternates()` derives both
criteria from the file's own path, so a page added tomorrow is checked without being listed. Every
check here read the body; nothing read the head.

What is **not** translated, on purpose: `privacy.html`, which is the most claim-dense page and has
legal weight — English stays canonical; and `llms.txt`, whose reader is a machine and which is the
map of the evidence, so there is one version of it and only one.

**Pages are responsive, and that is checked at a width, not eyeballed.** Wide content — tables, long
code tokens, diagrams — scrolls inside its own box; the page body never scrolls sideways. The guides
overflowed 375px by ~95px from code tokens in table cells, and nobody had looked. The nav carries the
name in three forms rather than truncating it: full, then `Zoost CRM`, then the product's own icon
alone under 520px, with `aria-label` holding the full name throughout so the accessible name does not
shrink with the layout. Measure with the iframe sweep — 7 pages × {375, 768, 1280} must all report
zero overflow.

**Name the platform in full, every time: "Zoho CRM", "Zoho Analytics", never the bare word.** On a
page whose subject is *our* Zoho Analytics workbench, "it never writes to Analytics" does not say
which Analytics — and a reader who guesses will as often guess it means us. It is also the safer
trademark posture: nominative use is strongest when the mark is quoted exactly and sits in a
descriptive position, while an unqualified "Analytics" reads as a word we have adopted. The cost is
repetition, and this project has always priced precision above elegance.

**Never let Zoho's product name stand in for ours.** "Zoho CRM · Web Store 1.0.0" in the footer
badge does not read as "the Zoost you can install is 1.0.0" — it reads as a claim about Zoho's
product, and it is false, because 1.0.0 is ours. The same word was standing in for our extensions in
the navigation, the footer links, the home cards and the guide switcher. Nominative use means naming
*their* product when we mean theirs; it does not license borrowing their name for ours. Wherever a
label stands for one of our extensions it reads **"Zoost for Zoho CRM"** / **"Zoost for Zoho
Analytics"** — `sitecheck.py` reports any link, heading or bold run whose entire text is a bare
platform name.

**The name "Zoost" itself was never cleared, and after checking, it is kept.** Three unrelated parties
use it: `zoost.ai` (an AI shopping assistant — the only one in software), `zoostdigital.com` (a
marketing agency) and `zoostwellness.com` (pet supplements). None of them claims a mark: no ® or ™ on
any of the three sites. No "Zoost" registration surfaced in the software classes, and the one filing
found — Australian, 2009 — is dead for non-use. **That is a web search, not a clearance search**: the
official registers (EUIPO, UIBM, USPTO, WIPO) are JavaScript-gated and every consultable mirror
returns 403, so this was not established authoritatively and should not be described as if it were.

The decision is to keep the name and react if something happens, because the legal risk looks low and
the cost is not what it appears. **Renaming is not a find-and-replace.** The verification chain is
identity-bound: an attestation records `https://github.com/ivannot/zoost` in its certificate, and
`gh attestation verify --repo` is validated against the certificate's `SourceRepository`,
`SourceRepositoryOwner` and SAN fields. Artefacts already signed would stay verifiable **only under
the old name**, so the chain would run in two pieces and `RELEASES.md` would have to say which row
belongs to which. On top of that, `zoost.it` could never be retired — published extensions carry
`zoost.it/docs.html` compiled in — so a rename means two domains for good, plus both Store listings,
Cloudflare, the Sponsors page, the contact email, and Search Console starting its clock again.

**What would reopen it:** a live registration found in class 9 or 42 in the EU, Italy or the US; a
complaint from any of the three; or a takedown against a Store listing. The cost of moving grows
monotonically — every release adds an attestation bound to the current identity — so this is a
decision to revisit deliberately, not to drift past.

### The names, settled

**This is fixed. Outward it never bends; between us it can.** Everything a user or a reviewer can
read — the site, the Chrome Web Store copy, `README.md`, every string an extension ships, the release
titles — uses exactly the forms below, always. In conversation, shorthand is fine and nothing needs
correcting; the rule is about what leaves the building, not about how we talk while working.

**Three legitimate forms, and nothing else.** `Zoho CRM` / `Zoho Analytics` name **Zoho's** products
and are used only when we mean theirs. **`Zoost — workbench for Zoho CRM`** is ours in full, and it is
the `name` in `manifest.json` — the authority, never a copy. `Zoost CRM` / `Zoost Analytics` name ours
in short — always carrying *Zoost*, which is why they
are safe. **A bare `CRM` or `Analytics` is never used**, in any position: it is the one form that
cannot say whose product it means. "Zoost" on its own is fine and needs no qualifier — it is already
the family's full name — but "the CRM extension" or "the Analytics one" is not a name, and it made
our own products sound like they were called after Zoho's.

**"workbench" is part of the full name and was nearly lost by accident.** Shortening the nav to fit
produced `Zoost for Zoho CRM` — a fourth form nobody had declared — and it then spread across the
site and displaced the real name, taking with it the word that was chosen deliberately over "IDE".
Nobody shortens the name to make it fit: the nav carries three tiers instead, and the last one is the
icon. `sitecheck.py` now reads the manifest and reports any Zoost+product form that is neither its
`name` nor its `short_name`, so the fourth form cannot come back.

`sitecheck.py` enforces all of it: it strips the three legitimate forms and reports whatever bare
occurrence is left, and separately reports any link, heading or bold run whose *entire* text is a
platform name.

`tools/sitecheck.py` reports a bare platform name in prose; code, paths and markup are exempt,
because `analytics/` is a folder and not a sentence.

**The same rule binds the extensions, and for a long time only the site was checked for it.** The
apps had drifted **27 times** — "No answer from the Analytics page", "Your Analytics role does not
grant access", a `+ Workspace` tooltip, a system-table chip, the CRM's own system prompt — and none
of it was found by a check. Two of them were spotted **by eye, in one file, while doing something
else**, which is the definition of a check that does not exist. `namecheck.py` now runs the same
strip-the-legitimate-forms technique over what an app ships: **JS string literals outside comments**,
and in HTML **the text between tags plus `title` / `placeholder` / `aria-label` / `alt`**. Comments
stay exempt — outward it never bends, between us it can — and anything under 12 characters is skipped,
because a chip reading `Analytics tab` has nowhere to put the platform and demanding prose of a badge
is how a checker starts being ignored. Proven by reintroducing three of the defects, one per surface
type, and getting three findings.

The name comes from `chrome.runtime.getManifest().name` everywhere. Renaming means editing one
field in `manifest.json`.

**Two extensions means every identity surface has to say *which one*.** `name` is not enough on its
own: Chrome shows `short_name` where space is tight (the extensions menu) and
`action.default_title` as the toolbar tooltip, and a bare "Zoost" on both is how you end up unable
to tell them apart. Each app therefore carries a **qualified `short_name`** (`Zoost CRM`,
`Zoost Analytics`), a `default_title` **identical to its `name`**, and its own `<title>` on every
page it ships. The icons share one mark, measured off the CRM one so the geometry matches exactly —
a 52×48 Z at 14px bar weight in a 128 tile — and differ by **hue**, because at 16px in the toolbar
the hue is the only thing left that carries. Adding a third product means doing all four again.

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
reading an annotated tag out of an Atom feed, the store scrape's shape guard. **The checkers are
tested too**, and that is not ceremony: two of the three shipped broken on the day they were written,
and a broken checker reports success over the thing it exists to catch, which is worse than none.

**A check worth running once is worth keeping.** Verifying a fix by hand — the `node -e` throwaway,
the loop that tries five inputs — is already writing a test; the only difference is whether it
survives the session. It goes into `tests/` before the commit that fixes the thing. No ceremony and
no separate task: if a defect was worth reasoning about, the reasoning belongs where it can run
again. The suite grows by the bugs we meet, which is why it has teeth.

**The panels are not restructured to be importable.** `tests/slice.mjs` lifts a named function out
of a browser script and runs it alone; refactoring 3000 lines of DOM-bound code *in order to* add
tests would spend the risk before earning the cover. The limit is stated rather than hidden: this
proves the logic, not the wiring — a correct helper called from the wrong place still passes. If
`sliceFn` cannot find a function it **throws**, so a rename cannot silently drop the cover.

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

**Record what cannot be verified, rather than omitting it.** `RELEASES.md` states that CRM 0.13.8 —
the version on the Store — predates this repository and has no commit to point at, and that
Analytics 1.0.0 was submitted before the build was deterministic so no hash is published for it. A
verifiable record that quietly papered over its first entries would be worth less than none.

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

1. **Check the release is actually warranted and complete.** Run "Definition of done" over the change
   — docs, site, store copy, `manifest.json` description — before anything is tagged. A tag is a
   public ref; fixing a premature one costs more than waiting.
2. **Bump `version` in `apps/<app>/manifest.json`** — patch for fixes, minor for features — and
   commit everything. The tree must be clean or `release.sh` refuses, by design.
3. **`tools/release.sh <app>`** — verifies the tree, builds twice locally and compares (fast
   feedback: a non-reproducible build must fail *before* the tag exists), then creates
   `<app>-v<version>`.
4. **`git push --follow-tags`** — this, and nothing else, starts the public build. GitHub checks out
   the tag, builds it twice, prints `unzip -l` into the public log, signs a provenance attestation
   and publishes the Release.
5. **Watch the workflow and read its log.** It is the only place a build failure appears. Report what
   it said — including the hash — rather than assuming it passed.
6. **Hand over the link to the Release asset, plus the hash, plus what to paste** into the Store
   dashboard. Never a path into `dist/`.
7. **After submission: append the `RELEASES.md` row** from the Release body, with the real submission
   date, and commit it.

**The Release title comes from the manifest, and two earlier versions of that line invented one
instead.** First it took the *directory* name and published "Zoost for crm 1.9.0". The fix for that
replaced the directory name with the platform's and left `Zoost for …` in place — the fourth form the
project explicitly bans — so "Zoost for Zoho CRM 1.11.0" went out on the most public surface there is.
`namecheck.py` had been reading `release.yml` the whole time and checked only whether the title used
the directory name: **it was checking the last bug rather than the rule**, which is the exact failure
this repository's checkers exist to stop. It now masks the legitimate forms and reports whatever is
left, the same technique `sitecheck.py` uses, and the workflow reads `name` out of `manifest.json` so
there is no second copy to keep in step.

**Every GitHub Action is pinned to a commit hash, never to `@v2`.** A tag is a ref its owner can
repoint at any time, so a supply chain that ends in "and then whatever that tag says today" is not
one. The trailing comment records which release each hash was, so an upgrade stays a deliberate edit.
Resolve one with `curl -s https://api.github.com/repos/<owner>/<repo>/git/ref/tags/<tag>` — and note
that an annotated tag answers with `"type":"tag"`, which must then be dereferenced to its commit;
pinning the tag object's own sha would not be a commit at all.

**An HTML comment inside a Markdown table ends the table.** `<!-- rows appended here -->` sat between
the header and the first row of `RELEASES.md`, so GitHub rendered an empty table followed by loose
pipe-delimited text — locally invisible, wrong on the only surface that matters. Instructions to a
future editor go *before* the header, with a blank line after them.

Tags are per product (`crm-v1.8.1`), and `RELEASES.md` is part of the release, not a follow-up.
If anything user-facing changed, regenerate `store/<app>/store-listing.md` and say which dashboard
fields move alongside the package — they are reviewed together.

**Publishing itself is not on this list, and is not yours to initiate.** Releases go to the Store in
batches, when there is something solid; cut a tag when asked, not when a version looks ready.

Pushing to `main` deploys `site/` to zoost.it: the Worker is connected to `ivannot/zoost` with root
directory `site`, production branch `main`, and `npx wrangler deploy` as the deploy command.

**Do not read "Source: Wrangler" in the deployment history as "deployed by hand".** Cloudflare's own
build runs that same command on its machine, so every deployment says Wrangler whether it came from a
push or from a laptop. Reading it as proof that Git was not connected cost a wrong diagnosis and a
wrong correction to this file.

**Build watch paths must be `site/*`, not `*`.** With `*` every commit to the repository starts a
build, including the twenty a day that only touch `apps/`. That burns the plan's build allowance on
nothing and, when it runs out, builds simply stop being queued — no error on the push, no banner, and
the last successful deploy left serving. It is what happened on 3 August: about twenty-five builds
for four site changes.

The deployment list only shows **successful** deploys. When a push does not appear there, the build
either did not run or failed, and only the **Builds** page says which — the deployment history cannot.

And the lesson that keeps being re-learnt: a push is not a publication until `curl` says so.
Documentation has to be correct at commit time, but it becomes visible only when a build succeeds.

The site is static plus one edge function: `site/functions/api/versions.js` reports the Web Store
version, the newest git tag and when `site/` last changed, so the footer shows whether the three are
in step. It reads the **tags** rather than GitHub Releases, because the routine above always creates
a tag while attaching a Release is a manual step that may not happen. Tags are semver-sorted here
rather than trusting the API's unspecified order.

**zoost.it is a Cloudflare *Worker* with static assets, not a Pages project.** Worker name
`zoost-it`, deploy `npx wrangler deploy`, root directory `site` — so `site/wrangler.jsonc` is the
config and every path in it is relative to `site/`. **`functions/` is a Pages-only convention** and
is never looked at here: a file placed there is published as a static asset (if inside `site/`) or
ignored entirely. Server-side code goes in `site/_worker.js`, which answers `/api/versions` and
hands everything else to `env.ASSETS`. Assets are served first and the script runs only when no file
matches, so adding to it cannot change how an existing page is served.

Two traps that this layout hides:

- **`site/.assetsignore` is what stops `_worker.js` and `wrangler.jsonc` being served as files.**
  The assets directory is `site/` itself, so anything in it is public by default — the generated
  config used to be readable at `/wrangler.jsonc`. Anything added beside the pages that is not meant
  to be downloaded must go in that ignore list.
- **Cloudflare generates a `wrangler.jsonc` when none is committed, and ours must stay a superset of
  it.** The generated one carries `compatibility_flags: ["nodejs_compat"]` and `observability`;
  committing a config without them would have silently changed the runtime. If the platform's
  defaults ever move, compare against what it generates before assuming ours is complete.

**A release gate for the outside view: `python3 tools/auditcheck.py`.** Three things, all mechanical:
every published page and `.txt` fetched from zoost.it and compared **byte for byte** against the
repository; each store listing's §1 and §2 compared against the manifest's `name` and `description`;
and every **absolute claim** in outward prose listed *differentially* against `tools/absolutes.txt`, so
a new "never" or "only" has to be read once, deliberately, before it ships — printing all 354 every
run would be the checker nobody reads. `--accept` records them; `--offline` skips the network. Like
`reachcheck.sh` it is **not** in `tests/run.sh`: it needs the live site.

**It reads `site/it/` too, and the Italian words are in `ABSOLUTE` for the same reason the English
ones are** — «non scrive mai su Zoho» is exactly the sentence that fell to one POST, and a page
nobody's ledger reads is a page where an overstatement ships unread. It earned that immediately: the
Italian CRM page had translated the heading **"Read-first, on purpose"** as *«In sola lettura, per
scelta»* — promoting it to the absolute the English deliberately avoids, on a page whose whole
posture is that "read-only" has already had to be walked back once. Reviewing a translation is not
only asking whether it says the same thing; it is asking whether it says it **as weakly**.

The first section exists because a review opened by asserting that the homepage and `llms.txt` served
by zoost.it were still an earlier generation, "not a part: all of it". Five hashes refuted it in
thirty seconds. **Take an outside review as evidence, never as a verdict** — that same review was
exactly right about two smaller things, and both are fixed.

- **Reaching a site and being allowed to read it are different questions, and `reachcheck.sh` only
  asked the first.** Every probe returned 200 while Cloudflare's *managed robots.txt content* was
  injecting `Disallow: /` for **ClaudeBot, GPTBot, CCBot, Google-Extended, Applebot-Extended,
  Amazonbot, Bytespider and meta-externalagent**, above our own `Allow: /`. The door was open and the
  sign said keep out. Nothing in this repository could have caught it by reading the repository: it is
  an account setting, and `site/robots.txt` is correct. The practical effect is narrower than it looks
  — a user pasting the URL still gets a live fetch, which is the test this project is designed around
  — but AI *indexing* is refused, so an assistant that answers from an index has never seen the site.
  `reachcheck.sh` now parses robots.txt for the agents the strategy names.
- **And its HTTP probes prove less than they look.** They send a bot's user-agent string from an
  ordinary address; Cloudflare identifies a verified crawler by its **network**, not by that string, so
  a rule blocking ClaudeBot does not block the probe and the 200 is meaningless for it. The claim
  "every probe reached the site" was true and was being read as "every crawler can", which it never
  said. The script says so now. The authority is the toggle list in AI Crawl Control, which nothing
  here can read — so this is one of the few things that has to be looked at rather than checked.
- **An assessment measures what it could reach, and a 403 is invisible from a browser.** A review of
  this project concluded "still to be validated" while stating it had not managed to open the site —
  so its verdict measured its own reach rather than the product, and every "needs verifying" it
  listed was already answered on a page it never read. Cloudflare's default managed rules do 403 a
  couple of legacy scripted-client signatures (`Python-urllib`, `libwww-perl`); everything the
  strategy depends on — ClaudeBot, GPTBot, PerplexityBot, bingbot, Googlebot, curl, requests, no user
  agent at all — gets through, and `tools/reachcheck.sh` proves it rather than assuming it. Run it
  after any change to the Cloudflare configuration. It is **not** in `tests/run.sh`: it needs the
  network and the live site, and a suite that fails because DNS was slow is a suite nobody believes.
- **Do not call `api.github.com` from the Worker.** It allows 60 unauthenticated requests an hour
  *per IP*, and the Worker leaves through Cloudflare's shared egress addresses, where that budget is
  already spent by strangers' traffic. Three of the badge's four fields came back null because of it,
  intermittently and with no error. The Atom feeds on `github.com` carry the same facts with no such
  limit and no credential: `tags.atom` for the newest tag, `commits/main/<path>.atom` for when a path
  last changed. They are XML, so parse shallowly and keep the shape guards.
- **Assets are served first, which means a handler for an existing file never runs.** The `.txt`
  charset fix sat in `_worker.js` for weeks as **dead code**: `/llms.txt` is a file, so Cloudflare
  answered it directly and the script was never asked. It took `assets.run_worker_first` to make it
  real. Worse than the bug is how it survived — it was reported, corrected, and **declared fixed on
  the wrong evidence**: the live bytes were compared against the repo and matched, which they always
  had. The bytes were never the problem. A rendering defect is verified by rendering it; the browser
  reported `document.characterSet === 'windows-1252'` and `â€”` on screen the whole time.
  `sitecheck.py` now derives the route list from the directory, so a new `.txt` cannot be forgotten.
- **A `.txt` has no way to declare its own encoding, so the header must.** Cloudflare serves plain
  text as `text/plain` with no charset; the browser then guesses, picks Windows-1252, and every
  em-dash in `llms.txt` arrived as `â€”`. The bytes were valid UTF-8 the whole time — HTML escapes
  this only because `<meta charset>` says it in-band. `_worker.js` sets the charset for any `.txt`,
  and a short `max-age` with it: the asset cache key ignores the query string, so a wrong response
  cannot be busted from outside and has to expire on its own. The fix deployed and the old header
  kept being served for as long as the default TTL allowed.
- **The edge cache will hide your deploy.** `/api/versions` is cached for an hour and the Worker
  checks the cache before doing anything, so new code can run and still return the old body — no
  error, no 404, just a value that will not change. The key ignores the query string on purpose (so
  the cache cannot be flooded with junk keys), which means it cannot be busted from outside either.
  `CACHE_KEY` therefore carries a version marker: **bump it whenever the payload's shape changes, or
  the caching itself does**, or the change is invisible until the old entry happens to expire.
- **"Was this tag submitted" is not "is anything in review", and the footer answered the wrong one.**
  It read *Web Store 1.0.0 · latest release 1.11.0 not submitted yet* for Zoho CRM while 1.9.0 had been
  submitted the day before and was still being reviewed. Every word was true and the page was wrong,
  because the submission was looked up **by the newest tag** — so tagging something and not submitting
  it erases the release that is genuinely pending. Each product now carries `pending`, the newest
  version `RELEASES.md` records as submitted, independent of what is tagged; the footer states it only
  when it adds a fact. Versions there are compared **numerically**: 1.10.0 sorts before 1.9.0 as text,
  and the ledger will reach 1.10 long before anyone looks.
- **A failed source must not be cached for as long as a good answer.** One fetch to
  `raw.githubusercontent.com` timed out and both submission dates read "unknown" — correctly, and then
  **for an hour after the source had come back**, because the failure was stored under the same TTL as
  a complete reply. The point of caching here is that a blip is invisible; caching the blip is the
  opposite of that. `TTL_PARTIAL` is 60 seconds and applies whenever any source returned null, so an
  outage expires with the outage.

Preview deploys are enabled for non-production branches, and the URL is
`<branch>-zoost-it.ivannot.workers.dev`. Anything touching the deployment goes there first and gets
verified with `curl` — endpoint status **and** the pages — before it reaches `main`.

And the lesson that cost two wrong guesses: **a successful deploy says nothing about an endpoint
being live.** Request it and read the status code —
`curl -s -o /dev/null -w '%{http_code}' https://zoost.it/api/versions` — and when something 404s,
find out *what the platform actually is* before moving files around.
