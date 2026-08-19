<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Nothing was cut: this is the same text,
     in the file CLAUDE.md now names. -->

# Traps already hit

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
- **Closed since: every Analytics writer asks first.** `pullAll()`, `pullOne()` and `retryFailed()`
  each open with `requirePerm(op.root)` now - the workspace-op rework routed every writer through an
  operation, and the permission ask travelled with it. The census below is kept as the method: walk
  every top-level function that reaches a writer, count the guards, and let the twin asymmetry be
  the signal.
- **The original finding, for the record: the Analytics pull wrote the mirror with no permission
  guard at all.** Folding the CRM's nine copies of
  `if (!(await ensurePerm(dir))) throw new Error(<the folder message>);` into `requirePerm()`
  raised the obvious twin question - nine on one side, one on the other - and the answer is not that
  the CRM over-guards. Censused by walking every top-level function that reaches `writeFile`,
  `writeJson`, `patchCfg` or `writeToDisk`: **the CRM guards all fifteen**, with `ensurePerm` where a
  gesture exists and `hasPerm`-and-bail in `syncOne()`, which runs from a background message and by
  the rule above cannot ask. **Analytics guards two of five** - `doExport()` and `renameWorkspace()` -
  while `pullAll()`, `pullOne()` and `retryFailed()` go straight to disk. With the permission lapsed
  those three do not re-request it and the `getDirectoryHandle` below them throws `NotAllowedError`,
  so the panel prints Chrome's own sentence under «Pull failed:» - the symptom-as-message trap in the
  bullet below, on the path most likely to meet it. **What is not established is how often it is
  reachable**: the click listener re-grants `root`, and whether that grant covers the workspace's own
  `dir` handle was not tested, in a browser or otherwise. Deliberately left alone - it is a behaviour
  change and the fold was not - but it is the next thing to do on that side, and the fix is the CRM's
  helper, not a tenth copy of the line.
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
- **An explanation goes next to the control it explains, and this one had drifted past four of them.**
  The paragraph describing **Max tool steps** sat *after* the whole passphrase block - the checkbox, the
  three password fields, the two hints and the sixty-word note on why encryption at rest is not offered -
  so on screen it read as an explanation of the passphrase, and the number field it belongs to had
  nothing beside it. Reported. It is the mirror image of the bullet below: that one is about a sentence
  conditioned on the wrong state, this one about a sentence *positioned* against the wrong control, and
  neither is visible to a checker because the markup is valid and the words are true. Same defect in
  both panels, since the section is shared chrome.
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
- **`opacity` composites the subtree, so it un-masks whatever a child was hiding.** `.explabel` sits
  over `.expgroup`'s top border with an opaque `background:var(--surface)`: that is what gives the
  export box its legend look. Fading the box with `opacity:.32` when Health or the assistant opened
  made that background translucent too, and the border drew straight through the word EXPORT -
  measured at 6.5px down an 8px label, so through the letters. The first instinct was to shrink the
  label; measured, that does not help, because at 7px the border still crosses at 5 of 7 and the
  cause is the compositing, not the size. The box dims **from the inside**: the label stays fully
  opaque and goes on masking, while the border colour and the buttons are dimmed by hand, with the
  two replacement colours computed as the .32 blend over `--surface` rather than picked by eye.
- **The box stays, and it is the *other* rectangle that was decoration.** I read "that rectangle is
  useless" as the export box and deleted it, which was wrong twice over: the legend is the only thing
  that says those two buttons *export* - `HTML` and `MD` name a file format and nothing else - and
  the rectangle he meant was `.wsgroup` taking an accent border while Health or the assistant is
  open. That one said a third time what the faded controls and the lit-up button already say. It is
  gone; the box is back. The lesson is not about CSS: **when a report names a thing by pointing at
  it, confirm which thing before deleting it**, because deleting is the one direction that cannot be
  reviewed from a screenshot. What survived the round trip is the `aria-label` on each button, which
  is worth keeping either way.
- **«A control that comes and goes» is a rule about a navigation *shape*, not about any control.** The
  diagram window's fold control shipped in all four views on that argument, and outside Explorer there
  is no list, so it commanded nothing. Reported. The rule that actually applies is the other one:
  **a control with nothing to do is absent**, the same way `#ertab` is absent on a function graph.
  It took three versions - everywhere, then a guard in the view switch, then **placed inside
  `#v-explorer`**, where it cannot be anywhere else. The third is the one worth remembering: *put a
  control inside the thing it acts on and the question stops being asked.* It is a tab on the column's
  edge now, not a button in the header, and the header carries the view tabs on their own row under
  the title instead of opposite it. **The same edge drags to resize**, told apart from a click by four
  pixels of movement - the way the ER boxes already separate the two - and the width goes into a custom
  property rather than an inline style, or it would beat the fold rule on specificity the first time
  anyone dragged. `asideWidth()` is lifted out of the drag so the clamp can be tested without a DOM,
  and it treats **a container reporting no width as no constraint**: a hidden pane measures 0, and
  reading that as a bound snapped the column to its minimum. **The click stopped working the moment
  the drag landed** and I shipped it: `pointerup` folded, and the `click` the browser sends straight
  after read the class that had just changed and unfolded again. Two handlers cancelling each other
  is invisible in the source and obvious the first time anyone presses it - which is why the fold is
  now wired by a **named** function the tests can lift and drive, instead of an anonymous IIFE they
  could only read. Giving the tabs square bottom corners to
  sit flush against the pane below was tried and reverted - it makes the header and the content argue
  about where the line is, and he said so.
- **A repaint does not happen inside the task that schedules it, and one `requestAnimationFrame` is
  not a painted frame.** (Historical note - the Visual tab named here has since been removed; the
  lesson is about repaints, not about that tab.) It ran an O(n²) force layout on the main
  thread - measured at 53ms for 50 nodes, 359ms for 150, 1.4s for 300 and 5.9s at the 600-node cap -
  and the window simply froze with the previous view still on screen. A spinner drawn in the same
  task never reaches the screen, and neither does one drawn inside a single rAF: that callback runs
  *before* its frame is painted, so blocking in it blocks that very frame. `runHeavy()` uses two, and
  the test asserts the **order** - shown, then work, then hidden - rather than the nesting. Below
  `SPIN_NODES` the layout is under ~350ms and the spinner would only flicker, so it stays out of the
  way; the threshold is a rendering decision backed by that measurement, not a claim about anyone's
  org. It was **150 and had to come down to 60**: tuned on the force layout alone, on an org of 87
  modules it never appeared, which was reported as the spinner having disappeared. And the boxed
  diagram - the slower of the two, and the one that leaves a pane blank - had none at all until
  then. **A threshold measured on one path is not a threshold for the others.** The third path was
  `setScope()`, which lays the whole org out again and did it inside the click handler: the window
  sat there looking hung and then jumped to the finished drawing. It clears the old one first as
  well - leaving a drawing up while a different graph is computed is the stale-projection problem
  in miniature, which this window has already had once. The ER free-layout branch calls the same `settle()` and has the same cost, and is **not**
  covered - its entry point cannot tell in advance whether the concentric branch will be taken.
- **`width:0` on a flex item does nothing unless `min-width:0` goes with it.** A flex item's default
  `min-width:auto` resolves to its *min-content* size, so the folded-away list in the diagram window
  stayed exactly as wide as its search box. The rule was applying - `visibility:hidden` from the same
  declaration took effect - and the panel simply did not move, which is the hardest kind of nothing to
  diagnose by looking at it. Found by measuring, and asserted since.
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

**A read that fails and a file that is not there arrive as the same fact, and the empty state then
names the wrong cause.** Reported on Analytics: a workspace with every file on disk was announced as
«Nothing pulled yet», which sends the reader to press Pull all on a workspace that has already been
pulled - and pulling changes nothing, so the panel is now lying twice. One line did it,
`readJson(rel, fallback)` swallowing every exception into the fallback. It is fixed there: anything
that is not `NotFoundError` leaves a trace, and the empty state names the file and what the browser
called the failure.

**The same shape is still in the CRM panel and has not been reproduced.** `functions/index.json` is
read inside a bare `try { … } catch {}`, and the meta walk swallows per-file failures the same way,
so an unreadable workspace there would also come out as an empty one. It is left alone deliberately:
the load path is different enough - it walks the directory rather than reading one index - that a fix
written from the Analytics symptom would be a guess, and this project does not ship guesses. Reproduce
it first: make the folder unreadable between two opens, and see which sentence the panel chooses.

**A render that takes a hundred seconds is waiting, not working, and the wait is one per browser.**
`chrome --headless --screenshot` starts a browser per image. The first capture in any browser costs
about forty-five seconds here while the compositor produces its first frame; every capture after it
costs three tenths of a second - measured inside one browser: 45s, then 0.3s, 0.3s. Twenty-seven
images therefore cost twenty-seven warm-ups, which was the whole of the thirty-four minutes that set
used to take. What gave it away was the elapsed seconds per shot, once they were printed: a metronome
of 101s, 1s, 101s, 1s. **A number that repeats to the tenth is a timeout, not work.** Chrome's own log
names it - `CompositorAnimationObserver is active for too long (73.7s)` - and everything plausible was
tried against it and measured: a dedicated profile (real, 14.66s against 0.37s on a trivial page, and
it does not move the renders), the scale, the virtual time budget, old headless against new,
background networking, occluded-window backgrounding, `--timeout`. None of them.

It is one browser now, driven over the protocol by `tools/capture.mjs`, and the set renders in about
three minutes instead of thirty-nine. Three things had to be right, and each was found by a wrong
attempt first:

  - **the viewport is set by sizing the window at launch.** `Emulation.setDeviceMetricsOverride` lays
    the page out differently and produced a picture differing on 10.010% of its pixels, scattered over
    1121 rows; `Browser.setWindowBounds` is accepted at runtime and does nothing. How much bigger than
    its viewport the window has to be is a property of the installed Chrome, so it is probed rather
    than written down.
  - **when to capture is asked of the page.** `--virtual-time-budget` ran the clock forward, so one
    number covered every page; a real browser has no such clock. A fixed 4-6s wait left six of the
    twenty-seven different, and "two identical captures 400ms apart" left twenty-one, because these
    pages are perfectly still right after load, before the shot script has run. The stub counts the
    timers and frames it has outstanding in `__zoostPending` and the renderer waits for zero, for the
    fonts, and *then* for two identical captures - neither test is sufficient alone, since the counter
    cannot see work driven by events and the stillness test cannot see work not yet started.
  - **and rendering several at a time cost the determinism it was buying speed with.** Six at a time,
    two of twenty-seven came out different between consecutive runs; one at a time, two consecutive
    runs of the whole set are identical image for image. `ZOOST_RENDER_JOBS` still raises it.

Four images changed once when this landed, by antialiasing alone - 6-9% of pixels at a worst channel
difference of 24-38 out of 255, which is edges of text and not content. `tools/pngsame.py` is what
makes that sentence sayable rather than hopeful.

The pattern behind most of these: a value crossing a boundary — between languages, between
contexts, between code branches — and being interpreted differently on the other side. Those are
the places to look first when something "does nothing".

## Zoho's ids across a boundary: three records where a reader sees one

A function's `associated_place` says where that function is used. Measured on a real org of 270
functions, against the mirror those same pulls wrote:

  - **workflow rules: 0 of 77 matched by id, 77 of 77 by name.** Zoho puts an *action* record between
    a rule and the function it fires, and the id in that entry is the action's. The numbers even look
    right - the rule is `...21172047` and the entry says `...21172030`, adjacent because they were
    allocated together - which is what makes this so easy to believe.
  - **the reverse direction is no better: 0 of 93 by id, 93 by name.** A rule's own JSON lists its
    actions as `{name, id, type: 'functions'}`, and that id is the action's too. So neither end of the
    relation carries the other's key, and searching all 519 files of the mirror for one of those ids
    finds it only in the function meta that carried it.
  - **schedules are the exception: 2 of 2 by id.** Which is the trap's other half - the same field is
    exact for one kind and wrong for another, so a lookup that works is not evidence.
  - **`module` is the *localized* label.** «Contatti» where the api name is `Contacts`, so matching it
    against the mirror's index found 9 of 18 button entries and none of 77 rule ones. The panel's
    `moduleData.label` is that same localized plural, and against it the match is 18 of 18 and 77 of
    77, with no two modules sharing a label in that org.

The consequence is a design rule, not a fix: **id first, name second, and refuse when the name is
ambiguous.** Minting an identifier of our own does not help here and was considered - to attach the
same id to both records you must already know they are the same record, which is the question. A
generated id is a handle on something we hold (the history's steps are keyed by one), never a join
between two records the platform declines to join.
