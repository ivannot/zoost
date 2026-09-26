# The window move, swept a second time before publishing 2.0.0

Five scans over the whole of the change that made Zoost its own window, run the day the release was
being prepared: the CRM shell, the Analytics shell, the diagram view, the settings view, and the
CRM's Zoho-facing code. Read-only; every claim below was verified here against the source before it
was acted on, and the ones marked *measured* were reproduced in a browser by the scan that found
them. Twenty-two defects, all fixed in the same change. The first sweep of this move is
[`2026-09-25-the-window-move.md`](2026-09-25-the-window-move.md); this one found more than that one
did, which is the fact the last section is about.

## The class four of the five scans found independently: a view is not a page

`graphview.html` and `options.html` were documents. A document dies when it closes, and *that* is
what reset them - the variables, the DOM, the listeners, the search box, every class a click handler
had ever toggled. As views inside one window they are opened and closed repeatedly in a document
that never dies, and only the half somebody wrote down came back.

- **A section of the settings could never be saved again.** Type an API key, close the settings
  (the ✕, or Escape), open them again, press Save: *"This page was still loading when you changed
  something... Reload the page"* - about a page that cannot be reloaded, for the rest of the
  window's life. `openSettingsView` treated a reopen as a first open and re-ran `init()`; the
  `dirty` set had survived the close, so every loader's `beginLoad` guard found its section dirty,
  cancelled its own read and left the flag at `cancelled`. The only way out was to discard the edit,
  which is what the reader was avoiding. *Measured.* The form is read **once per window** now.
- **The diagram's search box kept its text while `renderGraph` filtered on it**, so the second open
  drew an empty list under an empty box with nothing on screen to explain it. *Measured.*
- **The detail pane still described an item from the previous projection**, while `sel` was null and
  no row was highlighted - two views of the workspace disagreeing, each looking right alone.
- **The Relations facet chips doubled on every open** (4 -> 8 -> 12), and one click lit two of them.
- **`Fields: key` was greyed out for ever** after one use of Emphasis, and `Emphasis` read its
  resting word while still drawn pressed: `disabled` and `.on` were written only by the click
  handler, so nothing put them back. *Measured.*
- **The Layout popover was open over a drawing it had never been opened on**, and with the diagram
  closed the first Escape anywhere in the panel was swallowed clearing it. *Measured.*

The rule: **when a page becomes a view, enumerate every fact that lives in the DOM rather than in a
variable, and give one function the job of putting them back.** The list is derivable and it is not
the list of variables - it is every `classList.toggle`, every `disabled =`, every `.value =`, every
`innerHTML =` that only one handler writes. `resetGraphState()` was complete about variables and
that is exactly why nobody looked further; `syncGraphChrome()` is now the other half, and it runs
*before* the graph is applied, because the thing that reads the search box is the render.

## Two overlays, one z-index, and a winner nobody chose

`#graphview` and `#settingsview` were both `position:fixed; inset:0; z-index:82`, siblings in one
stacking context. A tie is broken by document order, the diagram is written later, so opening the
settings while the diagram was up painted the entire form **underneath** it: Chrome's own «Options»
entry read as doing nothing at all. Found by two scans independently.

It compounded twice. The first Escape then closed the settings the reader could not see - and
`escapeCloses()` called only `preventDefault()`, which does **not** stop a sibling listener on the
same node, so `graphview.js`'s handler ran on the same keypress and destroyed a hand-made
arrangement of boxes. And nothing behind either view was `inert`, so Tab walked into the covered
panel - in Analytics the *first* Tab after opening the settings lands on the workspace-folder button,
and Enter there opens the folder picker. *Measured.*

Three rules, and the second is the one that generalises furthest:

- **Two layers that can cover the same thing may not share a z-index.** The settings are 83 now, one
  above the diagram, so closing them reveals the drawing exactly as it was.
- **`preventDefault()` is not `stopImmediatePropagation()`.** A handler that *answers* a key must
  stop the event, or every other listener on that node answers it too. The comment in the panel said
  «the diagram owns Escape while it is open» and was true of the branch below it and false of the
  branch above.
- **A full-window view must make what it covers inert**, and it must derive what to mark by walking
  its own ancestors - the two products put these views at different depths, and a helper that knew
  which would be wrong in one of them the day the other moved.

## A comparison that could never be true, and a flag whose twin said so

`applySettingsChange` re-read the working folder and compared it with `===`:

    const prevRoot = root; root = await window.idbHandle.get('rootDir');
    if (root === prevRoot && dir) { updateWsButtons(); return; }

IndexedDB deserializes a **new** `FileSystemDirectoryHandle` on every read - which is precisely why
the File System Access API ships `isSameEntry()`. So the early return was dead code whenever a
folder was set, and *every* save in the settings fell through to `loadWorkspaces()` and re-activated
the workspace. The visible cost: the open function closed and History emptied, for a change to the
box spacing. The unseen one is worse - the guard below it read `pullActive`, which each *area*
runner sets and clears, while the comment twenty lines above says in as many words that `pullBusy`
is the flag that matches this sentence. A save landing between two areas of a Pull all moved the
workspace generation, and every `op.write` still in flight threw `WS_MOVED` - silently, by design.
The pull stopped part-way through the org and said nothing.

And one line of `activate()` sat outside the `if (!sameWs)` guard it belongs to, so re-activating
the workspace already open dropped the navigation chain and shut the detail pane. The twin has
always had it inside, with a comment explaining why. The click-anywhere folder re-grant takes that
path too.

The rules: **identity comparison on anything that crosses a serialization boundary is always false -
ask the API that exists for the question.** And **when two guards about the same fact name different
flags, one of them is wrong; the comment that explains the choice is the evidence, and it was
already there.**

## A scoped stylesheet takes its custom properties with it

The diagram's `--n-*` node colours were declared on `:root` while it was a page of its own. Scoping
the sheet moved them onto `#graphview` - and `declaredHue()` went on asking
`getComputedStyle(document.documentElement)`, which no longer has any of them. **Every declared hue
in both products was dead**, silently replaced by the hashed fallback: `modules`, deliberately the
one neutral grey because a module does not run, came out saturated like everything else, and the
near-neighbour pairs the stylesheet's own comments reason about were gone. Every published
screenshot of a diagram was of the wrong colour key. *Measured, with the before and after of six
kinds.*

In the same family, `@media print{ body.printing-diagram > *:not(#graphview) }` assumed the diagram
was a child of `<body>`. In the CRM it is not, so the rule matched the diagram's own **ancestor** and
**Save PDF printed a blank sheet**. And `printing-diagram` was set only for the ER view, so Ctrl+P
with the diagram open on Explorer printed the panel the reader could not see.

The rule: **a selector written `> *`, or a lookup written against `:root`, encodes where the markup
happens to put a thing today.** When a subtree moves, everything that named its position has to move
with it - and the way to avoid the class is to name the *relationship* instead: the print rule is
`:has(#graphview) > *:not(#graphview):not(:has(#graphview))`, which is true at any depth, and the
hue lookup asks the element that declares the tokens.

## Two writers for one identity, hidden by a stale fixture

`graphIdentity()` - added so a graph could not be stamped with the workspace it finished in - omitted
`idWord`, the word that introduces the id in the header both products share. So every graph published
through it wrote «· sampleorg · 1234567890» with nothing saying what the number is. A case exists
that would have caught it; it reads `fixtures/graph-*.json`, and all three were behind the panel, so
it was asserting against a payload no version of this product builds. `buildSchemaGraph` also held a
second, drifted copy of the same three fields, which `publishGraph` then overwrote - which is what
kept the divergence invisible from both ends.

The rule: **a fixture that nothing in the battery regenerates is a photograph, and it ages into a
test of nothing.** `python3 tools/graphdata.py --check` needs Chrome, so it cannot live in
`tests/run.sh` - it is in `tools/prepare.sh` now, which is where the other Chrome-driven steps are,
and it runs before every release rather than when somebody remembers.

## The rest, each fixed where it was found

- **The CRM context bar clobbered its own twin sentence.** A second `who.innerHTML =` below the
  ternary overwrote the «a Zoho Analytics tab is open, that product reads it» sentence with «No Zoho
  CRM tab is open» and hid the way-out button - so standing on the other product's tab gave the
  reader the problem, no explanation and no control. The twin has never had that second write.
- **«Open «workspace» ↗» navigated a background Zoho tab with no confirmation.** The predicate that
  takes the silent branch compares only the data centre and the environment word, so any production
  tab plus any sandbox workspace qualifies - and since Zoost became a window, the tab it takes over
  is by construction one the reader is not looking at. It asks now; the branch that ends a session
  always did.
- **Two Zoho help links in the Analytics settings opened a second popup.** The click handler
  exempted every `zoho.*` host «because those belong in the Zoho tab» - but nothing in that handler
  navigates the Zoho tab, so the exemption simply handed the anchor back to the browser and
  `target="_blank"` from a popup opens another popup. The exemption, its predicate and its four
  cases are gone: every outward anchor opens one ordinary tab.
- **«Report this problem» opened a whole browser window**, on a rationale that named the side panel.
- **The Analytics Save buttons had no primary styling at all.** `button.primary` moved to `base.css`
  (0,1,1) while `#settingsview button` (1,0,1) stayed - so the id rule won on background, colour
  and, through the `font` shorthand, weight. The CRM kept its own copy and was never affected, which
  is how a twin divergence hides. *Measured, computed style before and after `paintDirty()`.*
- **«Reset to preset» was dark navy on near-black** - it had never declared a background, and the
  panel's unscoped `button{}` found it the day the two shared a document.
- **Alt+←** walked the panel's navigation history underneath both views.
- The pending-view note was written *after* the window was created, racing the page that reads it.
- «Working folder set. **Reopen the Zoost window** to see the workspaces» - there is nothing to
  reopen.
- The two guides claimed **«Nothing is lost by closing it»** about the diagram. Closing it discards
  the arrangement, the filters and the selection; they say so now, in both languages.

## Two defects in the tools, and they are the reason this note exists

**`storecopy --changed` said five dashboard boxes needed pasting in each product when one had
moved.** The submitted record was keyed by section *number*, and removing the `sidePanel`
justification renumbered everything after it. Four pastes for nothing, with the one that mattered
standing among them indistinguishable - and the cost lands at the submission, where a round trip is
two to three days. It is keyed by the box name now, which is the name the files are already written
under, on his own rule that «il numero progressivo e' fuorviante». A case removes a section from the
middle and asserts the rest do not read as drifted; it fails on the ordinal version.

**`handcheck` demanded a manual check for files that no longer exist.** `sidepanel.html` and
`graphview.html` were deleted by this release, `git diff --name-only` lists a deletion, and the run
ended in a finding that could not be cleared - so `release.sh` would have refused to tag. A deleted
file is not a changed file.

The rule both share: **a tool that reports work for somebody else is measured by whether that work
is real.** A false item costs more than a missing one, because it teaches the reader the list is
noise, and the item they then skip is the true one.

## What this sweep says about the last one

The first sweep of this move ran the day before, found and fixed nineteen defects, and this one -
same change, same files, five fresh readers - found twenty-two more, several of them severe and two
of them in code the first sweep had just written. That is not an argument for a third sweep; it is
the measurement this repository already states, arriving again: **a scan finds what its questions
reach, and «the sweep came back full» is the normal outcome, not a signal to keep going.** What
changed the yield here was pointing the scans at *malfunctions in a named area* and requiring each
to reproduce what it claimed - three of the five drove the real page in a browser and the findings
they measured are the ones that had survived every previous reading.

## The rules it left behind

- **When a page becomes a view, enumerate every fact that lives in the DOM rather than in a
  variable.** The list is not the list of variables: it is every `classList.toggle`, every
  `disabled =`, every `.value =` and every `innerHTML =` that one handler writes and nothing else
  puts back. Give them one function, and run it before whatever reads them.
- **Two layers that can cover the same thing may not share a z-index.** A tie is resolved by
  document order, which is a decision nobody made. `tests/panel.test.mjs` holds it now, and also
  that both stay between the empty-state overlay and the dialogs.
- **`preventDefault()` is not `stopImmediatePropagation()`.** A handler that answers a key must stop
  the event, or every sibling listener on that node answers it too.
- **A full-window view makes what it covers inert**, deriving what to mark by walking its own
  ancestors rather than assuming where the markup puts it.
- **Identity comparison across a serialization boundary is always false.** A handle read back from
  IndexedDB is a new object every time; ask `isSameEntry()`, which exists for this.
- **When two guards about one fact name different flags, one of them is wrong** - and the comment
  that explains the choice is usually already in the file, next to the other one.
- **A scoped stylesheet takes its custom properties with it**, so every `getComputedStyle` that read
  them off `:root` has to move to the element that declares them.
- **A selector written `> *`, or a lookup anchored at `:root`, encodes where the markup happens to
  put a thing.** Name the relationship instead - `:has()` is true at any depth.
- **A fixture nothing regenerates is a photograph.** If the regeneration needs a browser it cannot
  live in `tests/run.sh`; put it in `tools/prepare.sh` and say so in the docstring.
- **A record keyed by an ordinal lies the day something is removed from the middle.** Key it by the
  name of the thing it describes - here, the dashboard box, which is the name the files already use.
- **A deleted file is not a changed file.** `git diff --name-only` lists deletions; a tool that asks
  a person to exercise a file must exclude them, or it produces a finding nobody can clear.
- **A tool that reports work for somebody else is measured by whether that work is real.** A false
  item costs more than a missing one: it teaches the reader the list is noise, and the item they
  then skip is the true one.
- **When a page is deleted, grep for the harness that renders it.** `shots.py` went on injecting
  itself before `<script src="options.js">` in a page that no longer loads one, and its stubbed
  `getManifest()` had no `version` - so the settings picture would have published «vundefined»
  under the product name. Both were invisible until the render was run.
