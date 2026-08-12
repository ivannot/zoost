<!-- Split out of docs/decisions.md, which had grown to 102k in one flat run of 147
     decisions with no heading to navigate by. Nothing was cut: this is the same text,
     in the file CLAUDE.md's index now names. -->

# The diagram window: the call graph, the ER model, and what they are allowed to draw

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

**A fit divides by a measurement, so it never invents one.** `erFit()` read
`clientWidth || 1000, clientHeight || 700`, which substitutes a viewport for the case where the panel
measures 0 - a real state, since a `.view` without `.on` is `display:none`. Measured on the sample
schema at 1280 x 800, where the panel is 1280x583: the true fit is 1.018 centred at x=358 and the
invented pair gives 1.255 at x=153, a diagram 23% too big and 200px off. It measures instead, and
returns when there is nothing to measure. **It was unreachable, and that is the reason it went rather
than an excuse to leave it**: instrumenting `erFit()` across all six rendered shots while driving Fit,
depth, focus and scope gives 35 calls, and every one that measured 0 needed a click on a button that
was `display:none`, because all four call sites are guarded by `curView === 'er'`. A guard on the
caller was the only thing between an invented number and a wrong drawing, so the fifth call site would
have got a silently mis-scaled diagram instead of no diagram. `tests/graphview.test.mjs` names the old
answer, not just the new one: reintroducing `|| 1000` fails there rather than in a screenshot three
commits later. All 27 site images are byte-identical across the change, which is the same fact from
the other side.

**Two things were disproved on the way, and they are recorded so nobody chases them again.** Neither
the layout nor the fit is non-deterministic: six renders of the same tree are identical, `settle()`
runs a fixed 300 iterations with no random and the scatter is already a hash of the id. And **no stale
scale was ever observed**. The panel does change height at a fixed window size - 542 then 512 then 482
within the wiring shot, because `#v-er` is `100vh` minus a header whose rows wrap - but a fit follows
each time, since every handler updates the header *before* calling `erShow()`. The chip bar was the
suspect twice and cannot be: `#ertools` is `position:absolute` and out of flow, so it cannot change
what the panel measures. A `ResizeObserver` was therefore *not* added: there is no demonstrated
condition for it to correct, and it would change when the drawing re-adapts under a reader's hands.

**Readability trade-offs are exposed, not guessed.** Diagram spacing, spread and label size are
runtime sliders, because there is no single right value across graphs.

**Fixed: the concentric ring is as wide as what sits on it, and the slider that compensated is gone.**
It was `ringR = max(L * erP.ring, needed)` with a default of 420 - a radius that is a fixed multiple of
the level, so the same for eight boxes as for eighty, and `erFit` then scaled the whole drawing down to
fit a circle that was mostly empty. Measured on the shipped fixtures at 1280 x 800, default against
default, which is the comparison that matters because a reader who never opens `Layout ⚙` only ever
sees the default:

| drawing | old default (`ring` 420) | derived radii |
|---|---|---|
| Analytics ER, focus at depth 2 | **0.289** | **0.857** |
| CRM ER, focus at depth 1 | 0.523 | 1.018 |
| CRM wiring, focus at depth 1 | 0.657 | 0.767 |

Both terms are measured. **Radially**, a ring clears the one inside it by half of each ring's tallest
box plus `margin` - the same clearance the collision pass enforces between any two boxes, so the two
agree instead of one undoing the other. **Tangentially**, the chord between neighbours has to clear the
*narrower* of a box's two sides, because two axis-aligned rectangles are apart as soon as either axis
separates them. That second term is a starting position and not a proof: near the top of a ring it is
the wide axis that has to separate, and the collision pass finishes the job - which is the point, since
the pass packs denser than a perfect circle ever does.

**Choosing between the candidates was done by modelling seven shapes, not by eye**, and two plausible
formulas lost. A radius derived from arc length alone - circumference equal to the sum of the box
widths, which is the obvious reading of "derived from what sits on it" - comes out **70% too large**
(47% zoom where this gives 76%), because boxes at the sides of a ring are separated vertically and
their widths are irrelevant there. A radial-only radius, leaving all crowding to the collision pass,
lets twelve boxes collapse into a blob that no longer reads as a ring. The winner also **matches or
beats the hand-tuned `ring: 140`** that `tools/shots.py` was setting on three shots, which is the
outcome worth having: the published screenshots are now the *default*, not a setting the reader would
have had to discover.

`erP.ring` is therefore gone - from both presets, the control table, the relayout set, the visibility
map and the markup - and `margin` drives the radii, which is also what the collision pass has always
used. A browser that drew one diagram before this version still holds `ring: 420` in
`chrome.storage.local`, so the merge takes only keys the presets declare: not migration code with a
version to grow out of, but the permanent shape of the merge, so the next parameter that goes has
nothing left to leave behind.

**What it cost, stated rather than left to be found.** The CRM wiring shot came out slightly *smaller*
(0.767 against the 0.83 the tuned setting gave) because seven boxes on one ring make the tangential
term bind at 147 where the tuning used 140 - the arrangement has fewer crossing arcs, but it is not
uniformly bigger. And on the Analytics fixture one `Account_Id` edge label now falls under the
`Order_Lines` box where it used to sit clear: a denser layout crowds the labels that live between the
boxes. Raising `margin` is the control for that, which is what it is for.

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
