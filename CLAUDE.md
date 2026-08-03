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
apps/analytics/  the Zoho Analytics extension (in progress)
site/            zoost.it — deployed automatically by Cloudflare on push to main
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

Check it mechanically, not by memory — the same discipline as the documentation sweep:

```bash
# every id one panel has and the other does not is either a deliberate difference or a gap
grep -o 'id="[^"]*"' apps/crm/sidepanel.html | sort -u > /tmp/a
grep -o 'id="[^"]*"' apps/analytics/sidepanel.html | sort -u > /tmp/b
comm -3 /tmp/a /tmp/b
```

Walk each difference and decide: is it genuinely product-specific (functions, modules and Deluge
exist only in CRM; views, query tables and the ER model only in Analytics), or is it shared chrome
that has drifted? Only the first kind is allowed to differ. The colour `--sel` is the one deliberate
exception: blue in CRM, teal in Analytics, because that is what says which product you are in.

**That grep only covers markup. The twin rule covers behaviour and artefacts too**, and that is
where it was broken next: exports were written to `export/` in CRM and to the workspace root in
Analytics, under a different filename shape and a different timestamp format. Nothing in the markup
could have caught it. So also compare, by reading both sides:

- **what a symbol means.** The glyphs are a vocabulary shared across the apps, and one that means
  two different things is worse than none: **`↻` is local** — "reload from disk / re-grant folder
  access" — and **anything that reads from Zoho says "Pull"** and wears `.zbtn`, whether it is
  "Pull all", the per-type "Pull", or the per-item one. The Analytics detail pane shipped a `↻` that
  called Zoho; it was the right colour and the wrong glyph, which is the confusing combination.
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
- **No new `manifest.json` permissions** without discussing it first. Every one has to be
  justified to the Web Store and to users, and the justification text lives in `store/`.
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

**The environment guard is the most important safety property.** Each workspace is bound to one
org, host and instance. If the active Zoho tab belongs to a different org, every Zoho-bound action
is disabled. Do not weaken this for convenience.

**Layout, relation and schema data come from the pull, not from live calls.** The graph window
reads what was written to disk. If a feature needs data that is not in the module JSON, the pull
has to be extended and the user has to re-pull — say so in the UI rather than failing silently.

**Function meta carries a schema version (`sv`), and old copies backfill themselves.** When the pull
starts capturing a new field (e.g. `connections`, `modified_by` in 1.2.0), bump `sv` in
`content-bridge.js` `toFile()` and in `META_SV` in `sidepanel.js`. Functions on disk below `META_SV`
render as **stale** (amber ◐ dot) and are folded into the "Complete missing / Refresh outdated"
flow, so existing workspaces top up the new fields with one click instead of a full re-download.
This is how you evolve the captured data without orphaning already-pulled workspaces.

**Related-list API names are a first-class concept.** The API name of a related list is neither
module's `api_name`, and it is what `zoho.crm.getRelatedRecords()` requires. This is the single
most valuable thing the tool surfaces; treat it accordingly.

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

**AI configuration lives in the options page**, not the side panel. The panel is ~400px wide and
those are set-once fields. The panel picks changes up via `chrome.storage.onChanged` plus a
`window.focus` re-read. A selector that changes a *mode* saves on change, not behind a Save button.

## Traps already hit — check for these

These all failed **silently**, with no console error. They are the expensive kind.

- **JS escapes inside HTML text.** `\u2699` written into markup renders as the literal string.
  HTML does not interpret JavaScript escapes. Use the character, or an HTML entity.
- **`esc()` is not attribute-safe.** It escapes `& < >` only. A double quote inside an attribute
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
| `site/docs.html` | anything a user does differently. The "Covers Zoost X · updated Y" line fills itself from the manifest and from the last commit touching that file — do not hand-edit it; the values in the HTML are only the no-JavaScript fallback |
| `site/index.html` | a feature worth advertising appears or changes |
| `site/privacy.html` | what data is stored, or where it travels, changes at all |
| `store/<app>/store-listing.md` | description, single purpose, or any permission justification |
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
assume). Do this across `README.md`, `site/index.html`, `site/docs.html`, `site/privacy.html` (what
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

**Any code change → nothing to package.** Local testing runs straight off the repository:
`chrome://extensions` → *Load unpacked* → `~/Developer/zoost/apps/<app>`, then hit reload after edits.
No zip, no reinstall. Just tell me what to look at and what should have changed.

**A change worth keeping → a commit.** Bump `version` in the app's `apps/<app>/manifest.json`: patch for fixes,
minor for features. Propose the commit message; do not batch unrelated work into one commit.

**A release → tag plus package.** Tag `vX.Y.Z`, push with `--follow-tags`, run `./build.sh`, and
tell me to attach `dist/zoost-<app>-X.Y.Z-store.zip` to a GitHub Release for that tag.
**The zip is never committed** — it is a build artefact, reproducible from the tagged commit, and
`dist/` is git-ignored. It lives as a Release attachment, nowhere else.

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
- Say what a thing does not do, next to what it does. The health audit states its coverage gaps;
  the AI panel states that OpenAI cannot explore on its own; the export dialog flags source code.
  This is deliberate: an honest limitation prevents a bad review.
- Empty states are never silent. "Nothing here" plus the reason plus what to do about it.

## Release routine

The mechanics, once "Definition of done" says a release is warranted:

```bash
# 1. version bumped in apps/<app>/manifest.json, docs updated, all committed
git tag -a vX.Y.Z -m "Zoost X.Y.Z"
git push --follow-tags
./build.sh <app>                 # -> dist/zoost-<app>-X.Y.Z-store.zip
```

Then, by hand: attach that zip to a GitHub Release for the tag, and — if anything user-facing
changed — update the Web Store package, description, privacy policy URL and data disclosures in
the same submission.

Pushing to `main` also deploys `site/` to zoost.it via Cloudflare. Documentation goes live with
the commit, so it must be correct at commit time, not at release time.

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

- **Do not call `api.github.com` from the Worker.** It allows 60 unauthenticated requests an hour
  *per IP*, and the Worker leaves through Cloudflare's shared egress addresses, where that budget is
  already spent by strangers' traffic. Three of the badge's four fields came back null because of it,
  intermittently and with no error. The Atom feeds on `github.com` carry the same facts with no such
  limit and no credential: `tags.atom` for the newest tag, `commits/main/<path>.atom` for when a path
  last changed. They are XML, so parse shallowly and keep the shape guards.
- **The edge cache will hide your deploy.** `/api/versions` is cached for an hour and the Worker
  checks the cache before doing anything, so new code can run and still return the old body — no
  error, no 404, just a value that will not change. The key ignores the query string on purpose (so
  the cache cannot be flooded with junk keys), which means it cannot be busted from outside either.
  `CACHE_KEY` therefore carries a version marker: **bump it whenever the payload's shape changes**,
  or the change is invisible until the old entry happens to expire.

Preview deploys are enabled for non-production branches, and the URL is
`<branch>-zoost-it.ivannot.workers.dev`. Anything touching the deployment goes there first and gets
verified with `curl` — endpoint status **and** the pages — before it reaches `main`.

And the lesson that cost two wrong guesses: **a successful deploy says nothing about an endpoint
being live.** Request it and read the status code —
`curl -s -o /dev/null -w '%{http_code}' https://zoost.it/api/versions` — and when something 404s,
find out *what the platform actually is* before moving files around.
