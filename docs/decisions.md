<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Split again at 102k, along its own
     topics; the other four are named in CLAUDE.md's index. Nothing was cut. -->

# Decisions: the mirror, what is captured, and what a refusal means

## Function mirror: single-file Deluge, multi-file compiled runtimes

Zoho returns Deluge source in the function detail as one script. Java, Python and Node functions use
the ZCE project API instead: first `getFileList`, then one `code` request for every non-directory
entry. The function API name is `functionName`; its category is `repositoryName`.

The local layout is additive, so existing workspaces and Git histories remain readable:

- `functions/<namespace>/<name>.dg` for Deluge;
- `functions/<namespace>/<name>.files/<Zoho relative path>` for every Java, Python or Node project file;
- `functions/<namespace>/<name>.meta.json` for both shapes. Schema v3 records `language`, `runtime`,
  `files` and `primary_file`.

Paths returned by Zoho are untrusted. Absolute paths, empty segments, `.` and `..` are refused before
anything is written. The sidecar is committed only after every source file, and files no longer in
Zoho's list are removed after the new sidecar is in place. Full-text search and exports include all
project files. The call graph, module reads/writes and connection usage remain a Deluge-only static
analysis until parsers for the other languages exist; that limitation is reported as an analysis
boundary, never as source missing from the mirror.

**One folder per kind, one `index.json` in each, and no underscores.** A CRM workspace is:

```
functions/<namespace>/<name>.dg or .files/ + .meta.json  modules/<Module>.json       workflows/<id>.json
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

**An Analytics full pull is committed by `.pull-state.json`.** The File System Access API cannot
atomically replace `views.json`, `schema.json`, `lineage.json`, the SQL files and their index. The
panel therefore writes `state: writing` before the first of them and `state: complete` after the
last. A loader that finds `writing` refuses the files as a hybrid and asks for Pull all; absence is
accepted for mirrors made before the marker existed. Partial writers replace one view's SQL and
lineage only and do not open a full-snapshot transaction.

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
split is not cosmetic: Clear must not close the reader's preview or empty their search box. Both
panels have both. (Clear went through `dropWorkspaceState()` whole for a while, and that turned out
to be its own defect - see below.)

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
`dropWorkspaceState()` does both and exists on both sides. It is skipped when the "switch" is a
re-activation of the workspace already open, because regranting a lapsed folder permission must not
throw away a conversation about the org you never left.

**Clear is not a workspace change, and routing it through the same function was the defect, not the
rule.** For a while `Clear` called `dropWorkspaceState()` whole - chosen so two ways of emptying the
chat could not drift, which is a real hazard and was the twins' actual history. But that function
also drops every cache *and the queue of removals still owed to the disk*, which are facts about the
mirror with no relation to a conversation: measured, Clear alone took the retry queue from 1 to 0.
The shared part is the conversation, so `clearConversationState()` is that part, `Clear` calls it,
and `dropWorkspaceState()` calls it too and then drops what belongs to the workspace.

**The workspace cannot change while a pull is writing it - the selector refuses, and says so.**
For months the panels were built as if switching org mid-pull had to keep working: every operation
captured the folder and the generation before its first await, every write re-checked, and a ledger
grew to 78 sites where a global was written after an await. That requirement was never stated by
anybody - it was written into a comment by one session, read as a constraint by every session after
it, and defended at increasing cost until the user was finally asked and said he found the behaviour
confusing. The lesson is recorded in CLAUDE.md: a sentence about what the product must do is a
requirement, and requirements are the user's.

So now: while `pullBusy` holds, the workspace list and its buttons are disabled, and a change that
arrives anyway - a keyboard, a race - is refused with «Pull in progress», putting the selection back.
The op machinery stays, deliberately: pulls are not the only long operations (the assistant, an
export, a health audit, a preview all read across awaits), those still run with the selector live,
and for them «certain, or stopped» still needs the op to say which workspace an answer belongs to.
What the block removes is the class where the *mirror on disk* could take another org's files.

**And what is dropped when a *file* changes is decided by the write, never by the caller.** The same
defect as the paragraph above, one layer down and four times over: each thing read off the mirror and
kept in memory - the sources behind `in: code`, the call graph, the assistant's modules, connections
and actions, and the map of which rule fires which action - used to be cleared at whichever call site
had just written the file. Counted rather than assumed: two of the six were, four were not. A
function saved in Zoho was mirrored correctly and then searched as it read before the edit; a module
resync left the assistant holding the field list it had replaced; a workflows pull changed the answer
to "which rule fires this" and rebuilt nothing. Every one of them is invisible from the panel,
because **the mirror on disk is right and only the memory over it is wrong** - there is nothing on
screen to compare against. So `noteWrite(rel)` maps what was written to what must be forgotten, both
panels have one, and it is reached from `writeFile` *and* `removeFile`, since a deletion is a write.
A path that writes tomorrow inherits it without being told. The one thing it cannot do is rebuild:
`actionFiredBy()` is called while a row is drawn and cannot read a file, so the workflows pull
rebuilds that map itself - a map that is merely absent would be drawn as "no rule fires this", which
is a stronger claim than the stale one it replaced.

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
`updateProjectableTabs()` runs on every `select()` (historical note - superseded: the tabs named here
were Visual, ER and Relations; Visual has since been removed): **the diagram tabs are unavailable while
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

## The summary cache: three defects and what each taught

<!-- Moved from CLAUDE.md 2026-08-19: true about one area, read when touching the cache. -->

**What the summary holds is a reading, never a judgement.** `functions/meta-index.json` keeps, per
function, what opening its files produced: the stale mark, the modified date, the *references* the
parser found in the source, and the size counts. It does **not** keep edges - an edge is a reference
resolved against the whole workspace, and that answer changes the day a function is added or renamed,
so a stored edge would be a cached verdict with nothing to say when it went stale. The resolution runs
on every build, from one extractor: `buildGraph()` hands back what it read so the panel writes down
the parser's own findings rather than running a second regex over the same text. A test builds the
graph both ways and compares it node for node, because the whole point of the shortcut is that nobody
should have to wonder whether it sees something different.

Measured on 5,000 functions: opening 60,015 file-system calls -> **8** warm; the diagram 40,014 ->
**17** after the first build; a code search 60,012 -> **0** after the first. What stays is reading
each source once - searching text means having read it - and that now happens in tranches with the
count on screen instead of a dead panel.

**A cache is not finished until you have proved it cannot serve an old photograph.** The summary
above was checked against the folder walk and the comment said the readings «age exactly when the
file changes, which the walk detects». They do not: a walk sees paths appear and disappear, not a
file whose bytes changed while its name stayed the same. An outside review asked for the invariant to
be *proved* rather than assumed - and both halves failed the first test written for it. A function
pulled again in place kept its old references in the diagram, and its old date in the tree.

The fix is at the point where this panel writes: every write marks the function it touched, the next
load re-reads exactly those, and the mark clears only when the summary has been written out again.
No fingerprint and no second read to check the first: we know what we wrote, because we wrote it.
**What no cheap check can see is somebody else's write** - an editor, a `git checkout`, a synced
folder - so ↻ Refresh now distrusts the summary and reads everything, and its tooltip says so.

**And a cache with two writers has a third failure nobody looks for: they overwrite each other.**
`saveMetaIndex()` describes what a `.meta.json` says and `saveGraphFacts()` what a `.dg` says, into
one file - and the first version of the first one *rebuilt the file from scratch*, throwing away
every reference and size the other had written. Nothing broke: the diagram simply read five thousand
sources again, and the summary looked complete while being useless to it. A silent loss of the whole
optimisation, found only because a review asked how the two interleave. Two writers, one file: merge,
never replace, and let each clear only the marks it refreshed.

The ordering question that found it is worth keeping too. `attachFnStats()` is started and
deliberately not awaited, so a graph build runs *inside* the tree load - which means «did the
metadata writer declare a function done before the source was re-read» had no answer in the code, only
in how the promises happened to resolve. Now each reader snapshots the marks **before its first
await** and each writer clears **only its own**, so there is no ordering to reason about. The hazard
was reachable only above `STATS_LIMIT`, where the build does not happen during the load - which is
exactly the kind of window that is never hit in testing and always hit by somebody's real org.

**And when two producers write one file, give the file one writer.** Both savers did
read-modify-write on the summary, and merging was not enough: each read version X, each merged its
own half, and whoever wrote second put back what the other had just changed. Proved by marking a
function stale and running the two together - the file came back saying it was fresh, undone by the
writer that has no opinion about that field at all. `updateMetaIndex(mutator)` queues each change
behind the one in flight and reads the merge base *inside* the queue, so there is one writer and two
producers. No lock and no version field: the contention is between two known callers in one document.

The half worth remembering is the diagnosis. Each of the three defects in this cache was found by
someone asking *how do the two halves interleave* and refusing «the promises resolve favourably» as
an answer - and each time the fix was not more bookkeeping but a sharper question: **what is a fact,
who produced it, and who has the authority to call it fresh.**

The rule this leaves: **for every fast path, write the test that tries to make it lie before you
write the fast path.** `tools/probe.py` rewrites a source and a meta in a real browser and checks
that the diagram and the tree both moved; it goes red on a one-line regression, which was proved by
putting the defect back.

**Then the rule was turned on the caches that were already here, and four of the six were wrong.**
That is the part worth keeping: the discipline was written the day the summary was fixed, and the
summary was the *only* cache it had ever been applied to. Asking the same question of the rest -
what does this hold, what makes it untrue, who is supposed to notice - found `in: code` searching a
function as it read before the edit Zoho had just synced, «which rule fires this action» describing
rules the workflows pull had replaced, and both of the assistant's catalogues answering from the org
state of a minute earlier. None of them is visible: **the mirror on disk is right in every case, and
the panel is confidently out of date about it** - there is nothing on screen to compare against,
which is why they had survived since they were written. The two that were right were right by luck.

The class, which is not about caches: **invalidation must derive from the event, never from the
memory of whoever caused it.** Each of these was dropped at the call site that had just written the
file - three call sites remembered and two did not, and the three that were right were right by
luck, since nothing would have said otherwise. The fix is the one this repository keeps arriving at
from different directions: put the knowledge at the single point the event passes through.
`noteWrite(rel)` in both panels now maps *what was written* to *what must be forgotten*, and it is
reached from `writeFile` **and `removeFile`** - a deletion is a write, and the pull that prunes
functions Zoho no longer has was the sixth path that had to remember. A write path added tomorrow
inherits all of it without being told it exists.

And the discipline itself is now a check rather than a sentence, because this file has already
established what happens to the other kind: `tests/panel.test.mjs` derives every `*Cache` declared
in `apps/*/*.js` and fails when one is named by no test - no allow-list, so tomorrow's is covered by
the naming convention the code already follows. It says what it misses, too: a cache whose name does
not end in `Cache` escapes it, and being *mentioned* by a test is not the same as its staleness
being *proved*. The mention is what makes an absence visible; the proof is still judgement.
