<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Nothing was cut: this is the same text,
     in the file CLAUDE.md now names. -->

# Architectural decisions worth not re-litigating

**One folder per kind, one `index.json` in each, and no underscores.** A CRM workspace is:

```
functions/<namespace>/<name>.dg + .meta.json      modules/<Module>.json              workflows/<id>.json
functions/index.json                              modules/index.json                 workflows/index.json
schedules/index.json                              modules/layouts/<Module>.json      connections/index.json
export/                                           modules/layouts/index.json
```

Before 1.13 the Deluge namespaces sat in the workspace **root** and everything the pull created
carried a leading underscore — `_index/`, `_modules/`, `_workflows/` — so that a namespace called
`modules` could not collide with the folder of that name. The underscore was never a convention: it
was the symptom of there being no hierarchy, and `export/` never had one, so the rule did not even
hold against itself. Putting the functions under `functions/` removes the collision and the
underscore with it.

**`modules/layouts/` is inside `modules/`, because a layout is a property of a module.** It started
as a sibling and the reason given was that eight walks each said "a `.json` under `modules/` is one
module", so nesting anything would need a guard in every one of them — which is a folder shape chosen
to protect the code from a mistake I had just made, and the wrong direction entirely. The user said
so. The answer to eight repeated conditions is one named predicate: `isModuleFile()` and
`isLayoutFile()`, defined once, and the objection disappears.

That first attempt is still worth knowing about: a blanket rename inverted three skip-conditions at
once (`if (p.startsWith('_index/')) continue` became a skip of the very folder being collected), and
`!p.endsWith('_index.json')` had to move to `'/index.json'` or the index is parsed as an item. Both
fail silently — a walk that finds nothing and a JSON that parses.

**There is no migration, by decision.** Nothing reads the old paths — no fallback, per the rule
already here. A workspace still in the old shape is *reported*: the empty state names it, says to
press Pull all, and lists the folders to delete, in the same spirit as the older flat working-folder
layout being stated rather than adopted. Nothing reads or writes those paths any more, so nothing
touches them either.

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

**Leaving a workspace drops its data *and* resets what is on screen - two functions, deliberately.**
Reported: with the Health view open, switching workspace changed nothing, because what the switch
rebuilds is the list *underneath* an overlay covering it. The same held for a search term typed for
one org and still narrowing the next, and for the connection filter, which is a set of **file paths**
from the workspace being left - so the functions list could come back empty for a reason nothing on
screen explained. `dropWorkspaceState()` drops the data (and `healthData`, which was the one thing
left off that list); `resetView()` puts the interface back and rebuilds any overlay that is open. The
split is not cosmetic: **`dropWorkspaceState()` is what Clear in the chat calls**, and Clear must not
close the reader's preview or empty their search box. Both panels have both.

**A health finding that names something must open it, and a ternary is how two of four got left out.**
«Automation actions nothing fires» rendered a plain list for as long as it existed, because the click
handler was `kind === 'workflow' ? … : …` - two kinds fitted, the third and fourth did not, and
adding a group and adding a way to open it were two separate things to remember. `HEALTH_OPEN` is a
map from the kind a row declares to the function that opens it, and a test walks every `data-kind` in
the panel against it. The module in a broken-lookup row opens; its *target* stays plain text, because
that one is genuinely not in the workspace - which is the finding.

**Everything belonging to a workspace is dropped when you leave it, in one function.** Reported by
the user: the AI conversation survived a workspace switch, so replies naming the previous org's
functions sat above a question about the new one — and the whole thread is re-sent with every
message, so the model was asked to reason across two orgs with nothing marking the boundary. Worse,
and found while fixing it: `graphCache`, `aiModCache` and `aiConnCache` were cleared inside
`rebuildTree()`, which only runs on the Functions tab, so switching workspace from Workflows left the
assistant answering from the *previous* org's schema with no sign of it anywhere.
`dropWorkspaceState()` does both, exists on both sides, and is what `Clear` calls too — two ways to
empty the chat that reset different things is how the twins drifted on the large-index warning. It is
skipped when the "switch" is a re-activation of the workspace already open, because regranting a
lapsed folder permission must not throw away a conversation about the org you never left.

**Anything that writes the mirror asks for the folder first, and the twin comparison is what found
the gap.** Chrome drops the File System Access permission between sessions, so a write that has not
asked throws `NotAllowedError: The request is not allowed by the user agent…` - a sentence naming
neither the folder nor the remedy, which reads as the extension being broken. The CRM guarded all
fifteen of its writing entry points; **Analytics guarded two of five**, and `pullAll`, `pullOne` and
`retryFailed` went straight to disk. Nobody reported it: it surfaced while folding nine copies of the
guard into `requirePerm()`, when the counts came out nine against one and the question «which side is
wrong» was asked instead of making them match. Both panels now share the helper and the wording, and
a test walks the three entry points by name.

**The environment guard disabled the first Zoho button somebody remembered, not all of them.**
Reported: on a tab/workspace mismatch `Pull all` goes grey and the per-type `Pull` stays live, then
fails at the click with a message - two controls that read from Zoho, one guarded. `ZOHO_BTNS`
already knew there were two; every guard named `pull` by hand. Measured by rendering the panel
against a non-sample fixture with a tab reporting a different org: before, `pull=OFF pullone=on`;
after, both off, and both on again when the orgs line up.

**The fixture is a sample workspace, which made the first proof worthless.** `sample: true` means
`guardOk()` refuses it anyway, so both buttons came out disabled for a reason that had nothing to do
with the mismatch. The probe patches the config to `sample: false` in memory before loading it -
without that it cannot tell the two conditions apart, which is the same trap as a metric that cannot
fail.

**And the check found four more instances than the report did.** A test that refuses any
`$('pull').disabled =` written by hand turned up the two early returns in `refreshContext` - no Zoho
tab, and tab not ready - and both «download the missing ones» loops, which held `pull` down while
they ran and left the per-type `Pull` free to start on top. Those two go through `setPullBusy()` now,
which owns the state for both buttons and which `pullCurrent()` already consults before starting.

**The environment guard is the most important safety property.** Each workspace is bound to one
org, host and instance. If the active Zoho tab belongs to a different org, every Zoho-bound action
is disabled. Do not weaken this for convenience.

**Layout, relation and schema data come from the pull, not from live calls.** The graph window
reads what was written to disk. If a feature needs data that is not in the module JSON, the pull
has to be extended and the user has to re-pull — say so in the UI rather than failing silently.

**«Size & calls» held only proxies, and Zoho knows the answer.** Length and outbound-call counts are
a *guess* at what a function costs; `dashboard/top_usage?type=function_most_used` says how many times
it actually ran, and `functions/dashboard` says what the org spent against its ceiling. Both are
aggregates - a count and a name, no record, no identifier - which is why this half costs nothing in
posture. The static rows now carry the measured number beside them, so a function that is long *and*
runs two hundred times a day reads as one thing rather than two.

Two limits are stated on screen rather than left to be discovered: Zoho answers with the **busiest
few**, so an absent function means «not in the top list» and never «never ran»; and it reports how
*often*, not how *long*.

**`type=function_most_credits` is deliberately not fetched.** In the capture it returned **rows
byte-identical** to `function_most_used`, so showing both would put the same number on screen twice
under two names and invent a distinction the data does not support. The comment in the bridge says
where to add it if Zoho ever makes them differ. Two other things in that capture are refused for
their own reasons: `type=ip_address` is about people, and `getDependencies` is a false friend - it
returns the fingerprints of Zoho's own IDE bundles, nothing to do with dependencies between
functions.

**Execution failures have no tab, and that was a level error worth recording.** They shipped as a
sixth tab beside Functions, Modules, Workflows, Schedules and Connections, and he said it was out of
scope. The sharper reason: **the tabs are kinds of object, and a failure is not one** - it is an
event about a function. Giving it a sibling tab put it a level too high, which is the same dimension
mistake this file already records twice (a dot coloured by namespace while the chips filtered on
category; entity chips dressed like category chips). It shows where that dimension belongs: on the
**function's own detail**, under its callers, and in the **health view** under Functions, which is
already the place that answers «what is wrong across this org». The pull, the file and the export
chapter are unchanged - only the level was wrong.

**And the join was on the wrong name.** Zoho's `function_info.name` is the **display** name, so the
fixture generating a technical one meant the panel found no match and showed nothing on the function
while the health list was full - a defect that looks like «the feature does not work» and is really
two names for one thing. The lookup now tries every name a function is known by rather than picking
one.

**The Failures reading is a runtime, and it is the only thing here that is.** Everything else in
the mirror is a photograph of a structure that changes rarely, and its whole point is that `git diff`
answers «what changed». Execution failures change hourly: a diff of them is noise, not history. So
they are written as **one file that states when it was read** - `failures/index.json`, holding `at`,
the 24-hour run counts and the list - rather than a folder of items pretending to be durable, and
every surface that shows them carries that date, the export chapter included.
`GET /crm/v2/settings/functions/failures` and `.../dashboard/top_usage` are both **public `v2`
paths**, which is the most stable ground anything in this extension stands on, and neither needs a
host the manifest does not already grant.

**`params` is dropped in the bridge, and that placement is the whole guarantee.** The response
carries the input of the failed execution: 36 bytes for a Workflow or a Button - a record id - and
**8-9 KB for a REST API failure**, holding the request body and a `user_info` block with a real
person's name and email. That is a record, and Zoost says on three surfaces that it does not read
any. Dropping it at the boundary rather than «not writing it» downstream is the difference between a
rule and a habit: the panel cannot mirror what it was never handed, and a probe asserts the string
never reaches the DOM.

**Re-running a failure is a write, so it is not offered.** It makes Zoho execute code that changes
records - the first non-negotiable. The panel builds the URL of the failures page and the last click
is the user's, exactly as «Find» does for the functions list.

**And the run counts are aggregates, which is why they cost nothing in posture.** `top_usage` answers
with a count per hour and nothing else: no record, no identifier. An aggregate that could not be read
is **unknown**, never zero - the same rule as a workflow with no scheduled-action count until it is
downloaded.

**A fact already on disk is derived, not re-captured.** «How many workflows have actions that do not
run immediately» had no answer anywhere: the workflow *list* endpoint does not carry it, so
`workflows/index.json` does not either — and it was sitting unread in every `workflows/<id>.json`,
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

**A refusal is data, and `catch {}` throws the answer away.** Both `settings/fields` attempts in
`pullModules()` were swallowed, so a module Zoho will not describe was written with zero fields, zero
layouts and zero related lists and looked exactly like one nobody had pulled - under a panel saying
«None recorded - re-run **Pull Modules** to fetch them», advice that could not work and was offered
for ever. Reported with a HAR: a hidden module answers `400 INVALID_MODULE`, «operation cannot be
performed for hidden module». The status, Zoho's `code` and Zoho's own sentence are now written to the
module file with the **date they were given** - the same shape as the per-area `access` record, and
for the same reason: it is what was asked and what came back, never a permanent verdict, so the dot
still re-asks and a module since unhidden clears itself. `errorDetail()` returns `{message, code}`,
and `code` is read by its own regex rather than added to the alternation, because it appears *first*
in a CRM error body and folding it in would have returned `INVALID_MODULE` where `api()` compares
against `INVALID_CSRF_TOKEN`.

**And everything downstream of a refusal is the same defect, one projection at a time.** Reported:
the refused module's detail pane still drew the ER button, which opened a window with nothing in it.
A box with no rows, a node with no edges, a count of zero - each is a *claim*, and none of them is
one we are entitled to make, because the fields were never read. So the button is **absent** rather
than disabled (the rule already here), `openSchemaFocus()` refuses the module even if something else
calls it, the graph window will not make it the focus and says why, it is marked in every list it
appears in - it stays in them, because dropping it would quietly shrink the module count - and
`dead_suspect` is false for it: «nothing references this» is a measurement, and on that module it was
never taken. Same rule as a workflow with no scheduled-action count until it is downloaded.

**A refusal reaches the diagram window's detail pane too, and I only found that by looking.** While
checking something else, the refused module's pane still printed «0 fields · 0 layouts · 0 related
lists», «Referenced by (0) - no incoming lookup», «Lookups (0) - no lookup fields» and - word for word
- the sentence the side panel had already stopped giving: «Nothing recorded for this module. Related
lists are fetched by **Pull Modules** - run it again». Five surfaces in one pane, all of them counts
of zero where no count was taken. **When a fact turns out to be a claim, grep for every place that
states it** - the same discipline as grepping a corrected claim rather than the paragraph it sat in.

**And refusing to move the focus left the other two projections showing the previous module.** The
guard above returns early from `setFocus()`, so the ER diagram went on drawing the last valid item
while the Explorer list said this one - reported, and caused by the fix rather than surviving it.
Both panes looked right on their own, which is the worst state a two-pane interface can be in.
`updateProjectableTabs()` runs on every `select()`: **Visual, ER and Relations are unavailable while
the selection cannot be projected**, and if the reader is already looking at one of them it goes back
to Explorer instead of leaving a stale diagram under a new title. **Disabled, not hidden** - this is
the textbook temporarily-unavailable case, one click on another module restores it, and a tab strip
that changes length as you move down a list is disorienting in the way already described here. It is
the same decision Analytics took for its detail tabs, with the reason in the same words.

Analytics has no equivalent bug: `$('dgraph').disabled = !relationsOf(srcId).length` already guards
it. It *disables* where the CRM now *hides*, which is a drift against the rule above - left alone on
purpose, because the two conditions differ. Analytics knows the table joins nothing and the disabled
tooltip is where it says so; the CRM knows nothing at all, and has the banner to say that instead.

One sentence, one function, five consumers: `moduleRefusal()` feeds the row, the detail banner, the
fields table, the HTML and Markdown exports and the AI - and the assistant is told **before** the
empty table, because a model handed a module with no fields will explain why a module has none.

**The mark says "no", not "not yet", and it may not borrow one that already says something else.**
The refused row wore `\u27f3` in amber - the panel's *failed, click to retry* - so it advertised an
action that changes nothing, and he said so. It is **`\u2298` in `var(--muted)`**. Two things decided
that. Amber in this panel means *do something*, and there is nothing to do, so the colour had to be
neutral **and legible** - not `.st-no`'s dim `#5b6b82`, which means "not here yet" and is dim because
it is waiting. And `\u25cb` was the obvious reuse and would have been worse than a new glyph: three tabs
away it means *click to download*, which is the opposite claim. The vocabulary now runs
**`\u25cf` here \u00b7 `\u25cb` not here yet \u00b7 `\u25d0` partial \u00b7 `\u27f3` failed \u00b7 `\u2298` refused**, and only the last is a no.

**A refusal is a 4xx; everything else stays a failure.** The first version wrote `unreadable` on any
thrown error, so a dropped connection would have been dated on disk as a settled refusal and the row
would never have looked retryable again. `isRefusal()` guards both writers - the pull and the
per-module resync - and it is the same rule as the per-area `access` verdicts, which count an
outright 401/403 and nothing else.

**One sentence per surface, though, not per empty section.** Having one function meant every place
that had something to say could say the whole thing, so the first version put the same sixty words on
screen **three times** in a 300px pane - the banner, the fields area, the related lists area - and he
sent a screenshot. A reason repeated underneath the reason stops being read as an explanation. The
banner explains; each section below states its own fact in one line and stops. A test counts the uses
of the full text inside the detail pane and holds it at one, while leaving the exports and the AI
their own copy - a reader of an export cannot come back and ask the panel.

**The preview header names the file, and it named it in one place badly.** Selecting a function put
`functions/<namespace>/<name>.dg` into a 400px header, so the ellipsis ate the file name and left the
folder - and no other tab named a file at all, which reads as five products rather than five tabs.
`setPvName(label, path)` is the only writer of `#pvname`: the item's name, then the file, then the
whole path in the tooltip. Where the label *is* the file name it is not printed twice, decided by
comparing the two strings rather than per tab. Schedules and connections carry a synthetic path
(`schedules/<id>`) with no such file on disk, so they name the index that holds them instead of a
file that is not there.

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
because there are genuinely two drawings: **Graph** for functions, **ER diagram** for modules and
for tables. It was «Call graph» and the rename had to be asked for **twice**, because the first pass
changed the markup and `$('ertab').textContent = … : 'Call graph'` wrote the old word back over it on
every open — the trap already recorded here about a label that lives in the markup and is rebuilt by
the code that updates state, hit again in the one place where the label genuinely does vary. Anything that opens it focused on one item uses the same name and says *what* it is opened
on in the tooltip. The dead `graph:` field in the `TABS` registry, which nothing read and which kept
two retired names alive, is gone.

**The same mismatch had a second half, and it survived the fix for eight months.** `KINDOF` was
corrected to read `category`; the **list of values** was not, and it still held `NS` from
`graph-core` - `standalone`, `automation`, `button`, `schedule`, `validation_rule` - which are the
Deluge **namespaces** the call regex matches. Real categories are `scheduler`, `crmfundamentals`,
`custombutton`. So a function whose category was not coincidentally one of the five namespaces
matched no chip, got no hue, and **could never be switched off**: it was found because «None» left
items on screen. The kinds are **derived from the nodes** now - a category Zoho invents tomorrow gets
a chip and a hue without anyone remembering, a kind with no nodes gets none, and the empty category
is a kind of its own («no category»), because a value nothing lists is a value nothing can filter.
Declared hues still win; anything else gets a stable hashed fallback, since the set of categories is
the platform's to decide and not ours.

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

**The Visual view is gone from both apps**, and removing it from Analytics cost a lesson the CRM's
removal had not. `$('visScope').onclick = …` survived at the **top level** of the script: `$()`
returned null, assigning to `.onclick` threw, and **the whole file stopped evaluating there** — so
every `const` below it stayed in its temporal dead zone and the window came up with no chips, no
list, and a status line still holding the text authored in the markup. Nothing in the console,
because the page had already finished loading. A test now compares every `$('x')` in each panel
against the ids its own markup carries, with the runtime-built ones named rather than pattern-matched.

**The Visual view is gone, and the tab is called `Graph`.** It was a second, weaker drawing of what
the boxed diagram already shows - dots and lines against boxes with their contents - and «poco
visibile» was the report. Deleting a *view* rather than a file is the risky kind: `settle()`, the
position arrays, `forceFeasible()` and the whole force layout are **shared with the boxed free
branch**, so what came out was only what nothing else used - `draw`, `fitView`, `screenXY`, `pick`,
the canvas and its listeners, `labelMode`, `subFocus`, five toolbar buttons. `initCanvas` became
`initPositions()`, which is what the other branch always wanted from it. `Name:` moved into
`#ertools`, because `nameMode` feeds `label()` and losing the button would have lost the setting.
A test asserts the dead half is gone, the shared half is not, and that **every `$('x')` still has an
element** - the deletion took `#v-rel` with it on the first pass, because that view sat between
Visual and ER in the markup.

**The tab is `Graph` and the window keeps its two names.** «Call graph» and «ER diagram» still name
the *window*, from the panel's button and in the docs; the tab is one word because the subject is
already on screen, in the `Functions / Modules` switch beside the title. That is not the fourth name
this file bans - it is one fewer.

**A box is as wide as what is written in it.** It was a fixed 250px and long headers ran past their
own edge. Text is measured with a 2D context made on the spot, since this window no longer has a
canvas, and the result is clamped between 190 and 460.

**`spread` and `ring` drive two different branches, and only one is ever in use.** The `relations`
preset's spread had never been exercised, because «edges» used to be reachable only with a focus -
where `ring` does the work. Reaching it with `Scope: everything` put 19 boxes on a 3000px canvas:
measured at 0.25 zoom against 0.39 for the same graph in boxes mode, which is a diagram laid out
correctly and drawn too small to read. The free branch now **normalises the settled positions** - the
canvas is sized from the boxes that have to fit on it - so `spread` means the same thing at 20 nodes
and at 300, and the preset came down from 72 to 38.

**The boxed diagram draws functions too, and it is the same tab under the drawing's own name.**
Functions already had Explorer and Visual - Visual *is* the who-calls-whom graph, and it was there
long before anyone asked for one. What they did not have is the boxed, focusable, printable view the
modules get. They do now: a function's box lists **what it calls**, the way a module's lists its
fields, expressed as the same `{api_name, data_type}` rows so the renderer learns nothing new. The
tab reads **Call graph** on a function graph and **ER diagram** on a schema - two names, never a
third, exactly as the window itself is named.

**Relations puts the link first, and it does that for calls too.** One row per related list on a
schema; one row per call on a call graph - caller, callee, both namespaces, the callee's kind, and
the call itself copyable **with its parameter names**. The snippet is derived rather than invented:
`graph-core`'s `CALL_RE`, the regex that finds calls in real Deluge sources, matches
`namespace.name(`, so that is how one is written, and the parameters come from the captured meta.
The facets follow the catalogue - «crosses namespace / same namespace / all» where a schema has
«module relations / many-to-many / system / all» - and the default facet moves with them, because
`user` (hide the system related lists) is the right first view of a schema and means nothing here.
A call to a name that resolves to nothing is **not** a row: those are measurements of absence and
they live in the Health audit, which the hint under the table says.

Two things this uncovered. The Explorer selection moved the focus only `if (schema)`, so on a call
graph the diagram stayed where it opened while the list said otherwise - the same "one of a set" miss
this file already names. And four status lines spelt out «modules» and «lookups» as literals; `NOUN()`
derives them from the kind now, and a test refuses any `statline` that names one directly. It found a
fifth the sweep had missed.

**The window changes subject by asking the panel, never by growing file access.** `Functions` /
`Modules` beside the title switches between the two drawings. The diagram window holds **no folder
handle at all** and that is deliberate; giving it one for a convenience would be a permission nobody
asked for. So it sends `graphSwitch` to the panel, which builds the graph and leaves it in storage.
Two consequences, both stated to the user rather than hidden: the panel has to be **open**, and the
folder still **granted** - the handler checks with `hasPerm`, never `ensurePerm`, because asking
needs a user gesture a message handler does not have. And the window **reloads** instead of swapping
the data in place: every global in `graphview.js` is derived from the graph being replaced, and
re-deriving them one at a time is precisely the half-migrated state this file keeps recording.

**The first drawing is called «Wiring» because it stopped being about functions.** The switch beside
the title read `Functions | Modules` while that side already held workflows, schedules and
connections - reported - and actions and modules then made it plainly false: six kinds of thing under
a label naming one. It is **`Wiring | Schema`**, the view tab is **`Wiring`**, and the panel's button
says the same. «Wiring» is not a new word here: it is what the health view has always called the
group that answers what fires what and what references what. Two names for two drawings, and the ban
on a third still stands - what changed is which two.

**Everything in the org that runs is in it, and the modules it touches.** Every automation action is
a node, **including the ones no rule fires** - roughly half of them in a real org, and precisely the
ones worth seeing as a box on their own rather than leaving out. A module is a node **only when
something names it**: a rule that fires on it, an action that writes to it. Drawing all thirty-eight
would put boxes with no arrow into a diagram whose subject is what connects to what, and «no
automation touches this module» is a measurement the health view already makes.

**`entity` and `category` are two fields because they are two questions.** What kind of *thing* it is
- function, action, workflow, schedule, connection, module - and what kind of *that* it is: a Deluge
category, or `email_notifications`. They were one field while every non-function entity had exactly
one category, and the moment four kinds of action arrived under one entity they landed among the
Deluge categories in the chips: one dimension wearing another's clothes, which is the mistake this
file already records twice. `kindGroups()` now derives **both** levels from the nodes, so an entity
Zoho invents tomorrow gets its own group and each of its kinds gets a chip, with nothing enumerated
in the window. Ported to Analytics unchanged, where it collapses to one group and looks exactly as it
did - the shape is shared chrome, not a CRM feature.

**What is not in it, said rather than left to be discovered:** a function's own record access. Nothing
parses `zoho.crm.getRecords("Contacts")`, so a function is never joined to a module - the modules
drawn are the ones a *rule* or an *action* names. The guide says so in a note, in both languages.

**The diagram fixtures are produced by the panel now - `tools/graphdata.py`.** `tools/fixtures.mjs`
built them itself «from the same files, so the two cannot describe different orgs», and they described
different orgs anyway: its workflow reader looked for `conditions[].actions`, the key the pull stopped
writing when it started writing `instant_actions.actions`, so **every workflow-to-function edge was
missing from the fixture** while the panel drew nine. Both files parsed, both produced a graph, and
the screenshots were of a graph the product does not build. The payload is now taken from the shipped
`callGraphWithContext()` / `buildSchemaGraph()` through `tools/fsshim.js` - the same technique as the
screenshots - and the sources are stripped afterwards, because they are already on disk beside it. It
needs Chrome, which is why it is a separate tool: `fixtures.mjs` writes the tree and stays pure node.

**The call chain no longer stops at functions, and `callGraphWithContext()` is a separate function
for a reason.** The graph now carries what *starts* the code and what it *reaches*: a workflow or a
schedule that fires a function is a node, and so is every connection a function uses. Everything is
read from disk - the workflow's own JSON, the schedule's index row, the function's captured meta -
so nothing is fetched and nothing is inferred.

It does **not** widen `ensureGraph()`, which has **eleven** other readers - the health audit, both
exports, the AI index and seed, the connection usage counts, `showCallers`, `makeCallResolver` - and
every one of them assumes each node is a Deluge function. Widening that shape would have made all
eleven quietly wrong, which is why the enrichment is built beside it and only the diagram window
sees it. **Find every other user before touching a shared thing** - here it was cheaper to add one
than to alter one.

Three consequences worth keeping. `dead_suspect` is recomputed after the new edges, so «nothing calls
this» is a stronger statement than it was and a **connection nobody uses** becomes visible as the
same kind of candidate. A workflow whose file has not been pulled is a node with **no measured
actions**, never one with none - the rule this file already states for its scheduled-action count.
And the status line stops saying «N functions»: it prints the breakdown, because «3 functions · 1
workflow · 2 connections» is a fact and «6 nodes» is a shrug.

**The chips are two dimensions, and dressing them the same said they were one.** Reported: Workflows,
Schedules and Connections are Zoho objects, not categories a function can have, and nine identical
pills read as one list of nine kinds. The entity chips are **square**; the categories stay rounded.
They are **multi-select** now - within a dimension they are ORed, across dimensions ANDed, and empty
means everything, which is what the old `All` chip was without a chip that had to be kept in step.
A `\u2715` clears them, and the search box has one of its own; both are absent while there is nothing to
clear.

**A filter that hides one thing should cost one click, not eight.** «Nothing selected means
everything» is the tidy model and it inverts the work: to exclude the connections you had to select
the other eight kinds. The chips now start **on** and are switched **off** - so they show what is on
screen, which is the question «what am I looking at», and removing something is one click. `Only`
(REST, no-caller, unresolved) is the other question and starts empty, because that is the truth when
no condition is chosen. Two behaviours, so two labelled groups: **the level of a dimension has to be
visible, not inferred.** `Functions` is a box holding the five Deluge categories; Workflows,
Schedules and Connections are one chip each at the same level - a label plus a single chip saying the
same word twice is a box drawn for symmetry's sake.

**And neither starting point is right on its own, which is the actual lesson.** All-off charged
eight clicks to exclude one kind; all-on charges eight to isolate one. So the window offers both
ends - **`\u21ba All`** and **`None`** - and each is absent when it would do nothing. The chips
themselves keep the all-on default, because «what am I looking at» is the question you have most of
the time; `None` is there for the other one. Two buttons is a smaller answer than a mode.

**An empty list has three reasons here and they are different advice**: everything switched off, a
filter that matches nothing, a search that matches nothing. It names which - the rule this project
applies to every empty state, and one that becomes easy to break the moment a list can be emptied
from three directions.

**The focus is the window's context, so it is chrome — and «Scope» was the same lesson unlearnt.**
The focus is projected by all three views, and the two controls that changed it (`Scope`, `↺ Whole
graph`) lived in the *diagram's* toolbar: from Relations, the control deciding what Relations was
scoped to sat on another tab. It is one labelled group beside the view tabs now — the item's name,
`Everything`, the depth, and `✕` — wearing the same shape as the chips because it answers its own
question. **The depth moved with it**, and had to: leaving it in the diagram would have recreated the
identical problem one control over, which is the trap this file already records about doing one of a
set. `Everything` **pauses** the focus rather than dropping it (the name stays on screen, one click
picks it up again) and `✕` is the one that forgets it — two actions, two controls, no mode. The
status line stopped repeating the name, the depth and «paused», which the header now says.

**A control that governs the window belongs to the window, not to one of its views.** The chips
steered all four views and lived inside the Explorer column - which three of the four do not have -
so from the diagram, the control that decides what the diagram draws was off screen. It was reported
as «why is there no filter for the connections»: there was, and it could not be reached from where
it mattered. They are in the header now, above the tabs. **They are also the colour key**: each
carries its hue and its word, and they are on screen always, which the canvas legend never was - so
that legend is gone rather than being a second key for one dimension.

**A hue alone asks the reader to hold a key in their head.** «I colori sono utili ma non
sufficienti» - the boxes name their category next to it now, and the category comes first, because it
is the dimension everything in this window is coloured and filtered by.

**And they steer all three projections, not just the list.** «Show me this without the connections»
is the question, and answering it in the Explorer while the diagram beside it drew everything is two
panes disagreeing again. One predicate - `passKind` - feeds `render()`, `draw()` and `erVisibleIds()`,
and a callee filtered out is not listed inside a box either. The **search box narrows the list only**:
hiding the diagram down to one node as you type would be a different feature wearing the same control.

**`rest` was on the wrong side of the value/condition line, and multi-select is what exposed it.** A
function exposed as REST is still standalone, or automation, or a button - REST is something true
*about* it, so by the rule already in this file it may not have a hue, and it had one. Single-select
chips made the mistake unobservable: you could never hold REST and a category at once. The test that
was supposed to guard the rule listed `rest` among the values, so it recorded the error rather than
catching it - **a checker built from the same misunderstanding as the code confirms it**.

**And the canvas kept its own copy of the namespace/category mismatch.** `NSCOL(N[id].namespace)`
survived the fix that removed `NSCOL(n.namespace)`, because the assertion matched `n.` and this one
reads `N[id].`. On a call graph every dot in the Visual view was grey - `billing` has no hue and never
will. Both forms are asserted now, on both sides.

The hues are plural on purpose - `--n-workflows` against the Deluge category `schedule` - because
«Schedules» is the Zoho object and «schedule» is what a function attached to one is called, and the
two have to sit in the same chip row without reading as the same thing. `KIND_FILTERS` is derived
from `FILTERS` rather than repeated in `pass()`, since adding a kind and forgetting the second list
is how a chip ends up selecting nothing, silently.

**The ER diagram has two layout branches**, and they are mutually exclusive:
concentric (focus + ego set) driven by `ring`, and force-directed driven by `spread`.
A control that does nothing in the active branch must be hidden, not shown and ignored.

**A window resize re-fits the diagram, and the exception is the interesting half.** Resizing left
the drawing framed for a size it no longer had, and the only way back was clicking `Fit` every time.
But panning and zooming are a view somebody *chose*, and re-fitting because the window changed size
would be the window overruling them - so `erUserMoved` is set by the wheel and the drag, cleared by
`erFit()`, and the resize handler asks it. Measured on the sample org: fitted at 0.109, the reader
zooms to 0.119, a resize keeps 0.119, `Fit` hands it back and the next resize follows again. The
handler is debounced at 120ms, because resize fires continuously through a drag and `erFit()` walks
every box.

**Readability trade-offs are exposed, not guessed.** Diagram spacing, spread and label size are
runtime sliders, because there is no single right value across graphs.

**Open: the concentric ring is as wide for eight boxes as for eighty.** Measured while rendering the
Store screenshots, on the sample org at 1280 x 800: a focused ER at depth 2 with **eight** boxes fits
at **38%** zoom with the default `ring` (420), where `ring: 140` fits the same drawing at **101%** -
10px text rendered under 4px. The cause is `ringR = max(L * erP.ring, needed)`: the radius is a fixed
multiple of the level, so the ring is the same size whatever has to go on it, and `erFit` then scales
the whole drawing down to fit a circle that is mostly empty. A radius derived from what has to sit on
it - each ring just outside the previous one, plus a gap the slider controls - would fix it, and it
changes what the `ring` slider *means*, which is why it has not been done in passing. `tools/shots.py`
moves the slider and says so; the defect is still there for anyone who does not.

**An arc has to attach to the side that faces the other box.** It always used the left or right
edge, whatever the two boxes' relative positions - so on a focused diagram with one neighbour, which
the concentric layout puts **straight above** the focus, the arc left sideways, swept out, and came
back into the other box's side almost parallel to the edge it landed on. The head then lay against
the box and was painted over by it, since `#erboxes` comes after `#ersvg`. Reported with a picture,
after the size fix below had already shipped - two different causes for one symptom, and the first
fix made the second one easier to see rather than hiding it. The side is chosen by the dominant
direction now, and the bezier's control points are pulled along the same axis, or the curve leaves
the box sideways again whatever edge it started from.

**And the orphan cascade has to be computed on the set that will actually be drawn.** The first
version counted an edge anywhere in the graph while the drawing is restricted to the focus
neighbourhood, so a node was kept for a partner that was never going to be drawn: reported as
focusing a standalone function, switching the standalone chip off, and finding five boxes still
there with nothing attached - each held in by an edge to a connection outside the neighbourhood.
`erCandidate()` is the one predicate now - passes the chips **and** is in the neighbourhood - and
`erVisibleIds`, `orphanedByFilter` and the cascade all ask it rather than each testing the ego set
by hand. One of them testing it by hand is exactly how they came apart.

**An arrowhead is drawn in the diagram's coordinates, so its size on screen is the zoom.** Reported
as «sometimes I see the arrows and sometimes not»: they were always there - every link carries a
`marker-end` - and measured on the sample org the head came out **20.6px** across on a focused view
at 1.15 zoom and **3.3px** on the whole org at 0.28. Direction is half of what an edge says. The
marker is sized against the zoom now, which needs `markerUnits="userSpaceOnUse"` (or the size also
multiplies by each link's stroke width, and there are four of those against one marker) and a
`viewBox` (or the shape and `refX` move with the width, and the tip stops landing on the box edge).

**Derive a file shape from the writer, never from what looks reasonable.** The first sample
workspace invented every one of them - `{items: […]}` where the pull writes a **bare array**,
`namespace` where the meta says **`nameSpace`**, a boolean `rest` where it is **`rest_api`**, `sv: 3`
where `META_SV` is **2**, connections as strings where they are objects, and on the Analytics side
the raw `VIEW_ID`/`VIEW_NAME` the bridge renames to `id`/`name` before anything reaches disk. The
panel answered with «wfIdx is not iterable», «idx.map is not a function», no connections, a broken
export and a graph that would not open - five separate reports from one mistake. A test now reads
every key of every index against `content-bridge.js` and `sidepanel.js`, so the fixture cannot drift
from what a real workspace contains.

**And a state has to be *created*, not asserted.** «Unresolved» and «ambiguous» were written into the
meta as fields; they are not fields, they are what `graph-core` finds when it scans the Deluge. The
sample writes a call to a name that is not there, and a name that exists under two namespaces - so
the states come out of the sources the way they do in a real org, instead of being claimed by a
fixture that no pull could produce.

**One generator, two consumers: `apps/<app>/sample-org.js`.** It is shipped, because the panel has
to be able to write a sample workspace into the working folder; `node tools/fixtures.mjs` runs the
same code to write `fixtures/`. It replaced a Python script beside the fixture, which was a second
description of the same workspace shape with nothing keeping the two honest - the pattern this
project already uses for `product-help.js` and `analytics-sql.js`.

The difference between the two outputs is a **flag, not a fork**: `edgeCases` adds the states that
exist so the panel's own marks and filters have something to show. Those belong in a fixture the
tests read; they do not belong in the workspace somebody opens on their first day, where a module
Zoho refuses to describe is just a puzzle.

**Names: written by hand for the core, composed for the volume.** `buildInvoice` calls `calcTax`
which calls `formatMoney`, because that is what the screenshots show and what a first-time reader
explores - `standalone_1`, `standalone_2` would make the product look like a test harness. Beyond the
core, names are composed from a verb list and a noun list, deterministically, so a hundred plausible
ones exist without anyone inventing them one at a time. The generated ones are wired into what is
already there, so the graph gains depth rather than becoming a hedge of isolated boxes: 143 nodes and
135 edges today.

**«Fields first, state second» has a mirror image, and it cost the per-type Pull.** `setEnabled()`
asks `isSample()`, which reads `bound` - and `activate()` assigned `bound` four lines *after* calling
it, so the control was enabled from the workspace being left rather than the one being opened. The
handle and the binding are one fact about one workspace and are now set together. A test asserts the
order, and it needed comments stripped first: the note explaining the bug names `setEnabled(` above
the line that calls it, so the first version found the explanation and reported the fix as the defect.

**A button label is a statement, and «I have not looked» is not «there is none».** Four reports of
one thing, and I fixed the symptom three times before finding the cause. `+ Sample workspace` asserts
there is no sample; `Open sample workspace` asserts there is one. Until Chrome grants the folder
permission the panel has read nothing, so **neither claim is warranted** - and it was making the
first. The third state is a label that asserts nothing (`Sample workspace`) and a tooltip saying the
click will ask for access and then do whichever is right. The rule this project already applies to
every count and every empty state applies to a control's own text.

**And a state that has to hold across time is a term in the condition, never an assignment.** The
panel re-derives everything on a five-second poll. I hid the off-Zoho overlay with a
`classList.remove` at the click, and the next tick put it back - reported as the overlay returning in
the middle of writing the sample and then leaving again. `sampleBusy` is part of the derivation now.
Anything set imperatively on top of a periodic re-render survives until the next tick and no longer;
that is not a bug in the poll.

**A panel that cannot read the folder cannot answer questions about it - and that is the state it
opens in.** Chrome drops the File System Access permission between sessions, so `loadWorkspaces()`
returns *before it enumerates anything* until the first click grants it again. `wsList` is therefore
empty for a reason that has nothing to do with the question being asked, and the overlay offered to
**create a sample that was sitting right there**. It took three reports, and the diagnosis was mine
to make rather than his: he supplied it in the end.

Two fixes, and the order matters. `addSampleWorkspace()` **grants first and decides second** - a
click is the only context in which the permission can be re-requested, so anything decided before
that line is decided on an empty list. And whether a sample exists is kept in `chrome.storage.local`,
the same shape as `tabAccessView` and for the same reason: **a display-only copy of a fact, for a
surface that cannot reach the folder.** The folder stays the authority; the copy is only ever read
into a label, is refreshed from every real enumeration, and is set back to `null` when the sample is
deleted.

**A label can be stale; the action must not be.** Reported as pressing «+ Sample workspace» over and
over and recreating the sample each time. The label is repainted by `updateWsButtons()`, so between
the workspace list changing and that running it can say the wrong thing - and I could not reproduce
the stale label at all, which is exactly why the fix does not depend on finding it. **The function
checks**: with a sample on disk it opens it and never writes a second, whatever the button says. Two
more guards came with it, both of them ways this could go wrong rather than ways it had: a re-entry
flag, because nothing stopped a second click landing while the first was writing three hundred files,
and the overlay comes down *first*, because it is opaque and covers the status line - the progress was
being written where nobody could read it, which is what made pressing again look reasonable.

**«A control with nothing to do is absent» does not transfer between two copies of it.** The
workspace bar's `+ Sample` is hidden once one exists - right, because the dropdown beside it opens
the sample in one click either way. I gave the **overlay's** copy the same wiring without thinking
about where it sits: that overlay covers the whole panel, dropdown included, so hiding the button
there would leave somebody with a sample on disk and no way to reach it. And I got it wrong in the
other direction too - it went on saying «+ Sample workspace» when one already existed, offering to
write a second. It reads **Open sample workspace** and opens the existing one. Reported, and the
shape is the one this file keeps recording: *when you add one of a set, walk the others* - I did the
opposite here and copied a rule to a place where its reason did not hold.

**A sample needs no tab and no account, and the off-Zoho overlay was hiding it.** That overlay is
`position:fixed; inset:0; z-index:70`, so with no Zoho tab the whole panel - `+ Sample` included -
was unreachable: the one workspace anybody can open without an account was the one you could not open
without one. It is suppressed for a sample, and the overlay itself now carries
`+ Sample workspace`, because that screen is where somebody who has just installed Zoost actually is.

**`+ Sample` writes it, and `sample: true` in `.zoost.json` is the whole mechanism.** The button is
in the workspace bar, absent once one exists and while there is nowhere to write it. It writes the
generator's file tree into `<working folder>/<app>/<name>/` and stops: from that point the workspace
is read by the ordinary list, the ordinary walks and the ordinary exports.

**The discrepancy is stated for a sample too, and only the *blocking* differs.** Suppressing the
mismatch bar for it was wrong and was reported: reading invented data while looking at a real org is
exactly what that bar exists to say, and one muted line in the workspace half is too quiet to carry
it. What stays different is the overlay. A real mismatch can be resolved - one of the two is wrong -
and browsing until it is means reading org A's mirror while looking at org B; a sample will never
match anything, everything Zoho-bound is already refused for it, and blocking it would make it
unusable the whole time a Zoho tab is open, which is always. **Say it, do not stop it** - in a colder
colour than the bar that means «everything is disabled until you fix this», because they are
different situations and a reader has to tell them apart without reading. «Switch tab» is hidden:
there is no Zoho org to switch to.

**The flag is the mechanism; the enforcement has two shapes, and this file described only one.** It
said everything platform-bound is refused in one place - `guardOk()` - *rather than by a condition
repeated at each button*. Measured after an outside review said otherwise: `guardOk()` covers the
actions that move **data** (the save hook and the three pull paths) and drives the context bar, while
the eight «open this in Zoho» **navigations** each carry their own `if (isSample())`, seven of them
with the same message copied verbatim. So this note described an intention the code does not
implement, and the site repeated it **on the page that invites the reader to go and check** - the one
place where checking found something that did not hold. **The claim worth making is the single source
of truth, not the single checkpoint**: `sample: true` is read by everything and there is no second
code path, which is both true and stronger. The seven duplicated strings are a real smell and folding
them into one refusal helper is worth doing; until then, do not write it down as done. It is
**not dressed as a mismatch**: the mismatch bar and its overlay are for two environments that
could match, and offer actions that would fix it; a sample never will, so the bar is suppressed and
the workspace line says «sample - generated, never pulled» instead.

**Every rebuild of `bound` carries the flag, and a test enforces it.** `cacheBinding()` reconstructs
the binding from a listed subset - the trap this file already records - and dropping `sample` there
would silently re-enable every Zoho action on a sample workspace. The test reads the file line by
line rather than matching `bound = {...}`, because that regex stops at the first closing brace, which
on one of those lines is inside `readJson(CFG, {})` - it reported a line that did carry the flag.

**`sample: true` in `.zoost.json` is the whole mechanism.** Nothing about a sample workspace is
special once the files are on disk - it is read by the ordinary code, listed by the ordinary list,
and deleted by deleting the folder. There is no demo *mode* and there must never be one: an
`if (demo)` branch in shipped rendering code is how invented data eventually gets shown as somebody's
own. The flag exists so the panel can refuse everything that would talk to the platform, and to say
so.

**The sample org lives in `fixtures/`, outside `apps/`, so it can never ship.** `python3
fixtures/make.py` writes a workspace in the exact shape a pull produces, plus the `graphData`
payloads the diagram window consumes. It exists for three reasons and the second is the one that is
easy to forget: screenshots that need no blurring, **data that survives the session** (fixtures built
in a scratch directory die with the conversation that made them, so a fresh checkout starts with
nothing to point the panel at), and tests that want a real workspace. The seed is fixed, so two runs
are byte-identical and a diff means something changed on purpose.

**And it has to contain everything, which is a check rather than a habit.** «Put it all in the fake
data» decays the moment a new state is added and nobody remembers the fixture, so a test enumerates
them: every function category including the empty one, REST, unresolved, ambiguous, unreferenced, an
unused connection, a module Zoho refuses to describe, stale meta below `META_SV`, a hidden layout,
system and many-to-many related lists, system tables, an orphan view, a query whose SQL came back
**empty** and one that could not be read at all. Each of those has its own mark, message or filter,
and a screenshot taken against an org that has none of them shows a product simpler than the one
that ships. Every name in it is generic -
Zoho's own module names and ordinary business words - because a real portal or function name in a
fixture contradicts the independence this project states, on a surface about to be published.

**The panel is rendered too, through a shim, and that is what caught the fixture's own bug.**
Headless Chrome cannot be handed a folder - the permission is a user gesture by design - so
`tools/fsshim.js` is an in-memory File System Access API over a `{path: text}` map, plus enough of
`chrome.tabs` for the environment guard to see a matching Zoho tab. The page is the shipped one; only
the folder underneath it is invented. It is an approximation of an API and says so: it implements the
calls the panels make and nothing else, so a panel that starts using something new fails loudly here
rather than rendering a state the real API would not produce.

Two things it found immediately, neither of which any checker could have. The fixture wrote `host` in
`.zoost.json` where the panel writes **`base`**, so the guard compared a missing origin against a real
one and printed «tab «sampleorg» (org 1234567890) ≠ workspace «sampleorg» (org 1234567890)» - two
identical-looking values declared different, because the field that actually differed was not the one
in the sentence. And the fixture invented Deluge namespaces: **`CALL_RE` matches `<namespace>.<name>(`
for exactly the five namespaces Zoho CRM has**, so sources reading `billing.calcTax()` produced an
empty reference graph and the panel said «no known usage (orphan candidate)» about a function that
plainly calls four things. A test now holds every fixture function in a real namespace, and holds the
namespace and the category apart - the mismatch this file has already recorded twice.

**The site shows the product, and `tools/siteimg.py` renders those images from the same generator.**
Most readers do not read - they look at a picture and decide in two seconds whether a feature is for
them, which is the one thing a well-written page cannot do for them. Same renderers as the Store
shots, so a control that does not exist cannot appear in one; rendered at **2x** (`shots.SCALE`) and
published as **WebP at 1760 wide**, twice the widest the content column reaches. Measured on the
busiest shot: 115 KB as the 1x PNG, 284 KB as a 1760 PNG, **45-90 KB as WebP** - the format does the
work, not the resizing. Lazy-loaded, each carrying its own width and height so nothing below moves.

**Coverage is checked, not intended - `tools/imgcheck.py`.** «Copertura visiva totale delle feature»
is a wish until something measures it. Five derived checks, no list of pages: every image the
renderer produces is published; every image published is used by a page; every `<img>` points at a
file that exists, carries alt text, and declares width and height; and **a page and its translation
carry the same number of figures**, because a reader who switches language and finds one side
illustrated and the other bare is meeting two products. It found seven rendered-and-never-placed
images the first time it ran. 27 screenshots and the card, 1.55 MB, across 16 pages.

**And the sixth check is the one that keeps them true.** The first five say the images exist, are
used, are described and are symmetric across the two languages - none of which says whether a
picture still shows the product. `tools/imgstamp.json` records what each was rendered from: the
app's shipped files, the fixture, and the click script that drove it. Change any of the three and
the check says which app to re-render, in the same differential shape as `tools/twins.txt`. **Per
app rather than per screen, deliberately**: a panel is one HTML file and one script, so a change
anywhere in it can reach any shot, and per-screen precision would go quiet exactly when the change
was broad. It over-reports and re-rendering is cheap. Proven three ways - a line of panel markup, a
field in the fixture, a comment in a click script - one finding each.

**A click script that agrees with nothing renders the default state, silently.** The full-text search
shot toggled a `#findscope` that does not exist - the control is `#smode` - so it searched *names*
and published «No matches» under a caption about searching code. A screenshot that advertises a
feature by showing it finding nothing is worse than none. Look at every new shot before trusting it.

**And that is how the Analytics Store screenshots were found to be wrong.** `PANEL_CTX['analytics']`
was `{ ok: false }` against `example.com`, so every Analytics panel image carried the amber «Not on a
Zoho Analytics tab» - the off-platform state, photographed and published. It answers with the
fixture's own workspace id now, and the bar says what it says in use.

**And they are re-rendered only when something moved.** A full run was three minutes of headless
Chrome producing, for the most part, the same bytes again. The digest that already answered «is
this picture still of the product» now decides whether to draw it: `tools/siteimg.py` skips an
image whose recorded digest still matches, and `tools/shots.py` skips an app whose five published
images are current. Nothing changed: **1:35 to 0.5s** for the site set, three minutes to 0.2s for
the Store set. `--force` on either draws everything anyway.

**Two questions, two answers: whether to *draw*, and whether to *replace*.** The digest decides the
first - if nothing that can change a pixel has moved, Chrome is never started, which is where the
1:35 goes to 0.5s. The second is decided by the pixels: the fresh WebP and the published one are
decoded with `dwebp -ppm` and compared byte for byte, and an image whose picture has not changed
is left on disk untouched. No threshold, nothing to argue about - identical pixels or not. On a
forced re-render of all 26, **23 stayed untouched**.

**A render is not bit-exact, and the digest is the only thing that decides.** The panel does
asynchronous work and the capture happens on a time budget, so drawing the same commit twice can
differ by a few dozen bytes on three hundred thousand, with nothing visible to see - measured on
`crm-health` at 2x, five identical renders and a sixth that was not. Comparing produced bytes
would therefore republish for ever. The animations are frozen in the shot stub (`.spin` rotates,
the assistant's dots pulse, a focused search box blinks a caret) because a frame caught mid-
animation is a picture of a state nobody sits in front of - but that removes one source, not the
class. What remains is noise in the diff on runs where something genuinely moved.

That flips the cost of being wrong, so the hash had to grow: rendering needlessly costs ten
seconds, **skipping something that changed publishes a picture of a product that no longer
exists**. `source_digest()` therefore covers the renderers too - `shots.py` holds the window size,
the scale and the stub the panel is fed through - and the invalidation was proven in five
directions rather than assumed: a change to the CRM panel invalidates the CRM set alone, the same
for Analytics, a change to `shots.py` or `fsshim.js` invalidates both, and a change to a fixture
invalidates the app that fixture belongs to.

**And every word of that was true of the screenshots and of nothing else: the card a link unfurls
into was outside all of it.** `site/img/og.png` had no row in the ledger, was drawn unconditionally
at the end of every run, and appeared in none of `imgcheck`'s six checks. Not by anyone's decision -
by **four independent accidents**, which is why it was invisible rather than merely missed and why
removing any one of them would have changed nothing: check 1 asks the renderer which images exist
and the card is not one of its shots; checks 2 to 5 read `<img>` tags and the card lives in a
`<meta property="og:image">`; every set in the checker is globbed as `*.webp` and the card is a PNG;
and nothing recorded what it was drawn from, so check 6 had nothing to compare. It changed by 800
bytes between a macOS render and a WSL one and **the only thing in this repository that said so was
`git status`** - noticed while reading a diff, which is luck, not process. A checker whose set is
derived from one glob is blind to everything outside that glob, and being derived is exactly what
makes the blindness look like coverage.

It has a stamp of its own now, in the same ledger and under the same two questions. What the card is
a picture of is `tools/ogcard.html` plus **the screenshot that template embeds**, and which
screenshot that is comes from parsing the `<img src>` out of the template rather than being written
down beside it: point the card at another shot and a hardcoded `crm-preview.webp` would go on
watching a file the card no longer contains, reporting current for ever. The digest decides whether
to draw - a run that changes nothing no longer starts Chrome for it - and the bytes decide whether to
replace, as with the WebPs. The card's render *is* bit-exact, unlike a panel shot: static HTML
against a local image, measured identical across consecutive runs.

**The order it sits in is load-bearing in both directions, and it was wrong.** The card embeds a
screenshot the same run may have just redrawn, so its digest is only final once the loop is done; and
every page carries the card's own bytes in its `og:image` URL, so stamping before the card is drawn
writes last run's digest onto 21 pages. The card was rendered *after* `stamp_assets()`, which held
together only because `prepare.sh` happens to stamp again afterwards - run on its own, `siteimg.py`
left every page pointing at a card that no longer existed. Drawn between the loop and the stamping
now, and two consecutive runs of `siteimg.py` alone produce no diff at all, which is the property
that was being borrowed from `prepare.sh` before. Proven in both directions - a byte moved in the
template, and the embedded screenshot replaced with another - one finding each, green again after
each restore.

**Screenshots are rendered, never captured: `python3 tools/shots.py`.** Headless Chrome writes
exactly what the Store wants - 1280 x 800, `8-bit/color RGB`, no alpha - so nothing is converted
afterwards and nothing can quietly re-introduce an alpha channel. The pages are the shipped ones byte
for byte; only the data and a click script are added, so an image cannot show a control the product
does not have. `store/assets.md` records every slot the dashboard offers, including the one that
wastes an afternoon: **the promotional video is a YouTube link, not an upload**, and we have none.

**A filter says which graph you are looking at, so it changes the geometry — it is not a visibility
switch.** Reported: switching a category off in a large graph removed a big share of the boxes and
the drawing stayed the same size, so nothing became more readable. The force positions were computed
once for every node and latched behind a boolean, and filtering then drew a subset of a layout
computed for a set it no longer was — every survivor kept the place a few hundred invisible
neighbours had pushed it into. `laidOutKey` is now the **set** the positions belong to, so the layout
re-runs when the set changes and never when it has not, and the budget (`forceFeasible`) is asked
about what is about to be drawn rather than about the org — which means switching a category off can
bring a graph that was refused within reach, and the message says so. The starting ring is seeded
from a **hash of each id** rather than `Math.random()`, so the same filter always produces the same
drawing and the PDF is reproducible.

**And the layout underneath it was a circle by construction, which no amount of reading the code
would have told me.** The spring model here — repulsion 5200, rest length 90, a radius clamp of
`120 + 3n` — was tuned at about fifty nodes. Above that repulsion overwhelms attraction and the clamp
collects everything on its own radius: measured on a 728-node graph, **100% of the boxes sat on the
clamp**, and the mean edge came out as long as the distance between two nodes picked at random. A
drawing that says nothing about what is connected to what, and the real reason filtering it changed
nothing. It is **Fruchterman-Reingold** now — two forces derived from one ideal distance
`sqrt(area/n)`, cooled linearly — over **typed arrays**, which is where the O(n²) loop's cost
actually was: 4ms at 50 nodes, 27 at 150, 75 at 300, 294 at the 600 cap, against 53 / 359 / 1419 /
5854 before, with the structure ratio (mean edge length over mean distance between random pairs)
going from 0.98 to 0.31. `SPIN_NODES` was re-derived from that curve — 60 meant a spinner over five
milliseconds of work — and the whole engine was ported to Analytics, where the same `settle()` sat
byte-identical.

**The lesson is about method, not about force layouts.** Three of my own measurements said the fix
worked and did not discriminate at all — extent, zoom gain, edge length — because the normalisation
downstream rescales whatever it is given and my first synthetic graphs were random expanders with no
structure for a layout to reveal. **A metric that cannot fail is not evidence.** What settled it was
asking the drawing a question with a yes/no answer: *are all the nodes the same distance from the
centre?*

**A view's budget may not block a view that does not pay it.** «Show all» beside the Relations row
count did nothing on a large org, because `setScope` refused before setting the state — the *diagram*
could not lay that many out, and a table costs nothing to widen. The limit belongs where the cost is:
the setter refuses only while the diagram is the view on screen, and the diagram re-asserts it for
itself when it is opened, putting the scope back and **saying so** rather than drawing a ring nobody
can read. One sentence, one function (`tooWideToDraw`), two callers.

**A filter that removes a kind must remove what it strands.** Reported: switching `automation` off
left every node whose only links went into it — boxes with no arrow at all, in a window whose whole
subject is what connects to what. `linkedUnderFilter()` keeps only nodes with an edge to another node
the chips left standing, and **one pass is the whole cascade, not an approximation of it**: dropping
nodes with no surviving edge cannot remove an edge between two that have one, so a second pass finds
nothing. The Explorer still lists them — the diagram is answering a narrower question — so the status
line states how many are not drawn rather than leaving the reader to count boxes. Its first wording
(«with nothing left to link them») blamed the chips for a node that simply has no link of its own,
which is true with no filter applied at all.

**The budget was a guess and is now a measurement.** `FORCE_MAX_NODES` was 600, chosen when the force
layout cost 5.9 seconds there. Profiled end to end on a synthetic 2055-node graph — force layout,
collision passes and DOM:

| nodes | settle | collision + rest | DOM | total |
|---|---|---|---|---|
| 600 | 313ms | 204ms | 28ms | ~0.5s |
| 1200 | 1166ms | 885ms | 43ms | ~2.1s |
| 2055 | 3364ms | 3715ms | 83ms | ~7.1s |

Quality does not decay with size (the structure ratio is 0.13 at 600 and 0.116 at 1200), so the only
question is how long a deliberate «draw everything» may take behind a spinner: two seconds is a wait,
seven is a hang. Hence **1200**, on both sides. Two things the cap does *not* cover and neither is an
oversight: **the DOM is never the cost** (83ms for two thousand boxes), and the **collision passes are
the other O(n²)** and run whether or not the force layout does — past the cap an org still pays them.
If a real org lands there, that pass is what to attack, not this number.

**Explorer, the diagram and Relations are three projections of one context — Relations was the one
that never joined.** Selecting an item and switching to Relations showed the whole catalogue, so the
selection looked as though it had done nothing. It scopes to the focus neighbourhood now, states it
above the table, and offers the shared scope control as the way out rather than a second switch of
its own.

**A count in a status line is about what is on screen, and it must not be read off layout state.**
`nodesA`/`edgesA` are filled by `initPositions()`, which runs *after* the line is first written — so
counting from them reported «0 of 90 modules» on the schema side while the call graph, which counts
from `N`, was right. The one-of-a-set miss again: the same helper, two callers, one of them wrong.

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
per table **and the relations**), `lineage.json`, and one **`sql/<name>-<id>.sql` per query table** with `sql/index.json`
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

**The panel's width is Chrome's, and the segment row has to live with that.** `chrome.sidePanel`
offers no say in it - `getLayout()` reports which side the panel is on and nothing else - so «make it
wider» is not an option the API has, and the sixth tab wrapped the row onto two lines at whatever
width the user had dragged it to. Reported. A media query would not do either: the set of tabs is the
user's, hidden and reordered in Settings, so the width the labels need is not a constant - six need
380px and five need 300. `fitTabs()` therefore **asks**: it takes the classes off, measures whether
any segment has moved to a second line, and escalates one step at a time - close the spacing first,
shrink the type only if that was not enough, because the size of the words is worth more than the gaps
between them. Measured: as authored down to 400px, spacing closed to 380, 10px to 330, and below that
six labels do not fit at any size worth reading and it wraps, which is the honest end of it. Always
deciding from the untightened state is what stops it latching, and what lets it come back when the
panel is widened again.

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
