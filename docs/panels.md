<!-- Split out of docs/decisions.md, which had grown to 102k in one flat run of 147
     decisions with no heading to navigate by. Nothing was cut: this is the same text,
     in the file CLAUDE.md's index now names. -->

# The panels: what Analytics exposes, and how the chrome is arranged

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
