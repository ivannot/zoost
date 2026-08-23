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

**And a mention of a call is not a call.** `CALL_RE` used to run over the source as it is written, so
`// standalone.log();`, a name inside an error message and a whole block someone had switched off
were all edges. Measured on six shapes that occur in ordinary Deluge: **five were wrong**. The
drawing was the least of it - `dead_suspect` is «nothing calls this», so a function whose only
mention was a disabled line looked alive and the audit said nothing about it, and a commented-out
call to a function that no longer exists was reported as a call resolving to nothing. Both failures
point the same way: **towards silence, in the view that exists to break it.**

The reader that tells code from comments already existed - the statistics have used it since they
were written - and it simply was not shared with the extractor, which is this repository's oldest
shape of defect: two readers of the same thing, one of them better. It lives in `graph-core.js` now
and both use it. What is **analysed** is stripped; what is **shown** is not - the detail pane, the
exports and the assistant all still receive the source as it was written, comments included, and a
test holds that separation because it is the one that would be easy to lose.

**The same reading, turned into the join the platform does not have.** Once a source can be read
without counting its comments, the *arguments* are worth reading too: `zoho.crm.getRecordById(
"Contacts", id)` names a module, and the task says whether it is a read or a write. So each function
carries the modules it names, and a module's detail carries the functions that name it - the second
question being the one Zoho cannot answer at all. Three places a module gets named, all measured
before being written: the documented tasks, a COQL query, and the path of a REST url.

Three decisions hold it up. It is **candidates, resolved late** - `graph-core` reads words out of
text and knows nothing about which modules exist, so the panel checks each against
`modules/index.json` and draws nothing it cannot match; on two production orgs that refused three and
four names each that look like modules and are not. **Read and write stay apart**, because that is
the distinction somebody about to change a field is actually asking about, and it comes from the
task's documented signature rather than from a guess about the verb. And a call whose module is
computed at run time is **counted and shown**, never dropped: every list is a floor, and the panel
says so - measured at 17 such calls in one org and none in the other.

It needed a second output from the one scanner, which is the part worth remembering: the module names
live *inside* the string literals that the call reading blanks out. One pass now returns both the
code with its strings emptied and the source with only its comments gone. Two readers of the same
text is the shape this file keeps recording; one reader with two answers is not.

**Measured on real Deluge, which is the only place this could be settled.** Two production orgs read
in session and never committed - 428 functions, 673 KB of source: **793 references read as text, 775
after cleaning**. Every one of the 18 that went was a mention inside a comment (nine line, nine
block); **none was inside a string, and not one line of live code was lost.** Edges fell 96 to 90 and
249 to 240, and «nothing calls this» gained one function in each org - both of them named only by a
commented-out line, which is exactly the finding the audit exists to make and had been silently
swallowing. That is the answer to the risk stated when this was proposed: it was a hope, and now it
is a measurement, on the only corpus that could produce one.

A second check, because a lexer that gets lost damages the badges and not only the drawing: in eight
functions the cleaning removes more than half the lines. The worst is 183 lines of 193 - and that
function really is a block comment with eight lines of code left in it, counted the same by two
independent methods. Nowhere did the scanner run past the end of a construct.

One artefact, known and harmless: a function's own **declaration line** matches the call pattern, so
it appears among the references stored for it. It never becomes an edge - resolution drops a
reference to the node it is on - and telling a declaration from a call needs more than a regex, so it
is left alone rather than fixed with a heuristic that would be its own small defect.

It is a cache-shaped change as well as a parsing one: every `refs` already written into
`functions/meta-index.json` was the previous reader's answer, and nothing on disk would ever have
said so. `SUMMARY_V` moved to 2, which discards the summary wholesale - one slow open, then back to
one read. Measured on the workspace `+ Sample` delivers: **112 edges and 115 references before and
after**, so the fixture, the counts on `try.html` and the published screenshots do not move. That is
also the fixture's own blind spot, stated rather than left to be found - it contains no commented-out
call, so it could never have caught this.

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

**A hue alone asks the reader to hold a key in their head.** «The colours help but are not
enough» - the boxes name their category next to it now, and the category comes first, because it
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

**A box drawn over another hides its content, and 230 of them did so in silence.** The pass that pulls
overlapping boxes apart compared every pair against every other - O(n^2) - so its budget was cut from
140 passes to 60 above 150 nodes: fewer passes exactly where there are more boxes to separate. Measured
on generated graphs of the size a real org reaches (generated, because a real org's names never enter
this repository):

| nodes | overlapping pairs, before | after | fit before | after |
|---|---|---|---|---|
| 60 | 4-6 | **0** | 11% | **15%** |
| 120 | 47-99 | 38-61 | 11% | 8-10% |
| 200 | 169-410 | 78-139 | 8% | 7-8% |
| 500 | 1547-2554 | 451-585 | 5-6% | 5-6% |

Two changes. A **uniform grid** rebuilt each pass, so only boxes that could touch are compared - a cell
is the widest box plus the margin, which makes a pass cost about n and a generous uniform budget cheaper
than the old 60 passes were. And the run keeps its **best pass rather than its last**, because the push
oscillates: a pair that keeps trading places can leave pass 240 worse than pass 90, so any fixed budget
is a bet on where the run happens to stop. Over 25 graphs from 60 to 500 nodes, **no case came out worse
on both counts** and the overlaps fell in every one. It costs time - 93ms at 60 nodes against 3ms, 1.5s
at 500 - and one or two points of fit in the middle of the range. Deliberate: a covered box loses
information where a smaller drawing only makes it smaller, and zoom is a control the reader has.

**The canvas is given the panel's proportions, not a square's.** The panel is about two and a half times
wider than it is tall, and the collision pass separates a pair along the axis needing the smaller move -
which for boxes 190 wide and 82 tall is the vertical one. So every overlapping pair was pushed downwards
and a round blob came out as a column: 1972 x 4676 at 60 nodes, with the fit decided by the height every
time. Same area, shape of the thing it has to fit in: the fit improves at every size measured from 20 to
150 nodes (28% to 37% at 20, 11% to 15% at 60), and the layout places every box clear of every other in
5 runs out of 5 up to **80 nodes**, where a square canvas managed 3 out of 5. It distorts - stretching
one axis lengthens the edges that run that way, and the force layout's distances carry the structure -
and it is kept because the measurements are better on both counts, not because the distortion is free.

**What none of it fixes, and the arithmetic that says so.** 200 boxes occupy about 3.1 million px2; the
panel has 746,000. Even touching, with no gaps and no arcs, they need **4.2 times the panel's area**, so
the best possible fit for a whole-org drawing is about 49% - 10px text at 5px. Three approaches were
measured and all three hit that wall: growing the canvas until nothing overlaps reaches zero overlaps at
every size and drops the fit to **2%**; a radius derived from arc length is 70% too large; relaxation
does not converge at all, because the cause is global - a canvas too small in a dense region - and
pushing harder only moves the problem. **The conclusion is a product one, not a layout one**: above a
readability limit the honest answer is to say so and let the reader narrow down.

**And the limit that blocks is a limit of cost, not of quality - because the first attempt got that
backwards and made the feature unreachable.** A readability limit at 80 was tried as a wall, and it is
wrong in a way worth recording: an org with more than eighty functions in *one category* can never get
under it, so no combination of chips reaches the whole-org view at all. That is worse for a real org
than a crowded picture, which was the thing being avoided. Two numbers now, with two jobs:

| | what it is | measured how | what it does |
|---|---|---|---|
| `CROWDED_NODES` = 80 | where the drawing stops being clean | five generated graphs per size: no box covering another up to 80, 4 of 5 at 90 and 100, 1 of 5 at 120, none at 150 | the count turns amber and the tooltip says so. **It does not block** |
| `DRAW_MAX_NODES` = 800 | where the layout stops being affordable | profiled end to end against the current collision pass: 200 in 0.5s, 400 in 1.3s, 600 in 2.2s, 1000 in 4.9s, 1200 in **7.2s**. 400 satisfied the two-second criterion and refused a real org of 725 - a number that served the rule and missed the user - so the ceiling is 800, about 3.6s behind a spinner, once, and the options page lets the reader raise it further | refuses, and the view says why |

`FORCE_MAX_NODES` is gone, folded into the ceiling. It was 1200 on a profile of about 2.1 seconds taken
against the all-pairs collision pass that has since been replaced - **so the change to that pass
invalidated the number and nothing said so.** That is the argument for quoting a profile where the
constant lives rather than remembering it. Two seconds is a wait and seven is a hang, the same
criterion as before, so the line is the largest round size measured under two seconds. Those figures
are **layout only**: `erRender` then builds an SVG path and a div per box, and headless Chrome cannot
be trusted to time that because virtual time advances the clock, so the real wait is longer and the
line is drawn at the measured 1.3s rather than at the 2.2s that would otherwise have qualified.

**A box can be dragged, and the automatic layout is a starting point rather than a verdict.** Past
eighty boxes it crowds whatever it does, the reader is the one who knows which two have to sit together
for the print, and `Save PDF` already sizes the page from `erPos` - so an arrangement leaves the window
with nothing added for it. Three decisions in it, each with a reason that is not obvious:

**The arcs are hidden for the duration of the drag and drawn again on the drop.** Their paths are
derived from the positions, so following a box live means recomputing every path that touches it inside
a 16ms frame, and the collision pass alone measures 93ms at sixty boxes. Hidden and then correct beats
present and stuttering. This was the reader's own suggestion, and it is better than the live version it
replaced.

**Nothing else moves on the drop, which is a deliberate departure from what was agreed.** Making the
neighbours give way would fight the reader, who has just said where they want that box. The reason for
wanting it - never hiding content unknowingly - is served by *saying* what the drop covers, which is
this project's position on numbers anyway. `Re-layout` is the way back.

**Nothing is persisted *automatically*, and the argument against it is better than the cost
argument.** A silently restored arrangement is only coherent if the window is re-entered from the
same button on the same context; change the entry point and it has lost coherence with the click
that asked for it, which is worse than no arrangement. So nothing about the boxes reaches
`chrome.storage` (the layout *sliders* do persist there, keyed by kind - a spread tuned on an ER
diagram is the wrong start for a call graph).

What exists instead is a **deliberate** save: an arrangement can be written to a `.json` file and
loaded back, through the file picker, because twenty minutes of deciding which boxes sit side by
side is work and it used to die with the window. The coherence objection is answered by checking
rather than assuming - a loaded file names the workspace it was saved from, and loading it over a
different one is refused with both names in the message.

**An arrangement is kept across a re-layout, not defended against one - and the first attempt is worth
recording because it was reported as a bug within the hour.** Refusing a re-layout was tried, in one
place, in `erShow`. It is downstream of the controls: by the time it fires, the chip that asked has
already toggled its own colour, so the diagram refused the filter and the chip showed it as applied -
a control lying about itself, which is the defect class this window has already had once. Fixing that
properly would have meant intercepting all eight entry points, which is the enumeration trap.

Keeping the positions removes the question. What is still on screen stays where it was put, what is new
is placed by the layout, the hint line says how many of each, and `Re-layout` starts over. A box that
has left the screen keeps its entry, so switching a category off and on again finds it where it was.

**Taking off the drawing what you are not looking at, one box at a time.** The filters answer «which
kinds am I looking at»; this answers the other half, and the reader's own statement of it is the
specification: *«an arc relates two elements and I can click at each of
those two elements to remove what is upstream or downstream, taking away in cascade everything that
is connected to it»*. So an arc carries a `-` at **each** of the two points where it meets a box:
the one on A takes B away and whatever came into the drawing with it, the one on B says the same of A.
A `+` where a removal was made brings it back. It is a filter on the *drawing*, not on the layout -
nothing is laid out again, so it composes with an arrangement, and the PDF prints what you see.

**It went in twice, and the first version answered a different question.** «Hide only what becomes
unreachable any other way» is a defensible rule - a helper called from ten places should not vanish
because one caller was cut - and it is the rule this file recorded, chosen for the arc-cutting the card
offered. Put on the drawing as a mark per arc it fell over immediately, reported with a picture: a hub
carrying forty arcs and **six** controls. Measured on a star of forty with thirty-four of the
neighbours also referenced elsewhere, it is exactly six; the other thirty-four arcs said «nothing hangs
off this» - true, and no use whatever to somebody trying to clear the view. The lesson is not about
graphs: **a rule that is right about the data can still be the wrong answer to what the reader is
doing**, and the way that showed up was a control that was absent in most of the places he looked.

**What «in cascade everything that is connected to it» has to mean, because it cannot mean itself.** Taken
literally, everything connected to B includes the way back round to A and then the whole component, so
the first click would empty the diagram. What goes is B **and whatever was in the drawing only through
B**: two walks from the box the control sits on, one with B and one without, and the difference is the
answer. In a triangle A-B-C with D under B, taking B from A takes D and leaves C, which A can still
see. Taking it as a difference is also what stops a second component being swallowed - it was not in
the first walk either - and there is nothing left to decide about «which end hangs off», because the
control names its own end.

**A removal always removes something, which is what makes a mark at every meeting point honest.** The
far box goes whatever else it is attached to, so no mark is ever a control that does nothing - the
state `erPickCard` used to have a sentence for («nothing hangs off this arc») cannot occur, and that
sentence is gone. The card offers **both** directions instead, named and counted: `Hide Accounts` /
`Hide Invoices`.

**The state is the removals, replayed - not the hidden set.** `erCut` is the arc and the end that went,
in the order the reader took them away, and `erHiddenSet` replays them. Recomputing rather than
storing is what lets a filter change or a new focus re-evaluate cleanly; replaying *in order* is what
keeps two removals one inside the other from claiming each other's boxes, and `erWouldShow` measures
the difference so the `+` offers back exactly what its `-` took. A removal whose own box has since
gone is skipped rather than reinterpreted.

**A fold survives a relayout, and that is a decision rather than a consequence.** Taking a branch off
the drawing is the reader's decision; changing the depth is not a request to bring it back. The other
answer was defensible - a relayout is a fresh sheet, folds cleared, the window saying so - and this
one was chosen because the arrangement file already assumes it: `folds` is saved beside `positions`,
which reads as a fold belonging to what the reader arranged rather than to one drawing.

What the code did before was neither answer, and it took driving the window to see it. The replay is
a reachability walk, and it used to run over `erIds` - what is drawn now. After a relayout the folded
box is no longer in that set, because the layout had excluded it using this very walk, so the walk
found nothing to take away and returned empty. Measured on `graph-crm-schema.json`: the fold was still
recorded, it hid nothing, the box counted as visible again, and the badge said 17 only because nothing
had refreshed it. Which number a surface reported depended on when it asked.

So the two questions are asked over different sets, and `erReach` takes which one as a parameter.
**Offering** a fold is about the drawing in front of the reader - «this arc would take four boxes
away» must count the four they can see - and walks `erIds`. **Applying** one is about a decision
already made and walks the whole graph, so the branch stays away when the depth changes and takes
with it anything that only ever hung off it. The box the reader clicked goes unconditionally, after
the walk rather than before it: adding it first would make the walk skip it and answer that nothing
was ever attached.

`erHiddenSet` and `erUnhide` ran that loop twice, separately, and the day one of them learnt this the
other did not - the set said the box was away and the unhide could not find who had taken it, so a
fold became impossible to undo. **A fold that will not come back is worse than one that does not
stick.** One walk now, `erFoldedBy`, which answers which fold took each box; both read it.

**And the focus can be taken off the drawing, which is why `erUnhide` exists.** The Explorer beside the
diagram still lists what has been removed - deliberately - so the reader can focus a box that is not
drawn, and a diagram whose subject is missing is one lying about itself. Asking to look at something is
the clearest statement there is that he wants it back: the removals that took *it* are dropped, oldest
first, and everything else he put away stays away.

**The marks are their own layer above the boxes, and their width comes from the drawing.** The meeting
point *is* the box's edge, and a control the box paints over half of is not a control - so they sit
above `#erboxes`, which also means they go with the arcs for the duration of a drag, their anchors
being derived from positions that are moving. Size: constant on screen (the argument the arrowheads
already won - 3.3px across on a whole-org view, reported as missing) up to a cap, because a circle that
keeps growing as the reader zooms out ends up wider than the box it hangs off; and never wider than the
distance between two landing points on that side, because the second report was thirteen arcs on one
rim with 20px circles touching. `erFitToArcs` already grows a box until its arcs land `ARC_GAP` apart,
so taking the width from that gap means the marks can crowd but never cover each other. Measured on a
generated hub of forty: 80 arcs, 160 marks, widths from 14.7 to 20px, none overlapping.

**No number on the `+`.** It carried the count for half a day - the reader's objection is the right
one: two arcs never meet a box at the same point, so one `+` is one removal and the number is telling
him something he did not ask. It is in the tooltip, and in the line under the drawing at the moment it
happens.

**The tooltip says the names, because the count answers the wrong question.** Reported: *«un tooltip
che mi dice "stai rimuovendo a - b - c" mi aiuta molto»*, and the reason is in the same sentence -
reaching one of these marks usually means being zoomed in on a crowded rim, where most of what a
cascade would take is off screen. It cannot be looked at, only read. So the tooltip is a heading and a
list: a heading, a blank line, and **one dash per box**, the one the control names first and the
cascade after it alphabetically, capped at ten with «and N more» - a tooltip is not a report, and the
count in the heading stays true at any size.

The dashes went in on the second pass and the first pass's reasoning was wrong in a way worth keeping:
it put one name per line on the belief that **a tooltip does not wrap**. It does, and the reader's own
screenshot is the proof - a workflow called «Formazione specialistica valorizza esito e Crea Compito
dopo colloquio» takes three lines by itself, so «one line, one box» stops being true exactly where the
names are long enough for it to matter. Reported as «it all looks stuck together». A dash survives the wrap:
a continuation line has none, so what is one item and what is two is never in question. `erTipText` is one helper for the mark and for the card button, because the same click described
two ways, ten pixels apart, is the drift this repository spends its length on.

**It stopped being the browser's tooltip when the names needed their colour.** «Le etichette
potrebbero stare all'interno di badge con quel colore» - and a `title` cannot be styled at all, so a
name arrives in it stripped of the one thing that says what kind of thing it is. The panel is ours
now: same order, same cap, same wording, each name in a badge wearing **the colour its box wears** on
the diagram, which is also the colour of its chip in the header. One key, three places. `erPaint` is
what decides that colour, for the box and for the badge, because «which colour is this node» written
twice is two answers waiting to disagree - and the second would be in a tooltip nobody diffs against a
box. The two schema colours moved into CSS variables for the same reason.

Three properties it has and the browser's has not: it appears in 120ms rather than a second (long
enough that a pointer crossing a rim of twenty marks on its way somewhere else does not flash them
all), it is positioned against the panel and flipped at an edge rather than clipped, and it **never
takes the pointer** - a tooltip that can be hovered is one that can stand between the reader and the
control it is about. What it loses is the accessible name the `title` gave for free, so `erTipText`
stays and becomes the `aria-label`: the only form of this a screen reader can be given.

**And what *is* on screen is outlined at the same moment.** The list answers for what cannot be seen
and the outline for what can; neither does the other's job. It is rebuilt with the boxes, so it cannot
outlive the render that drew them.

**The marks are one size rule, with a floor, and the first version had neither.** It sized the `-` from
the gap and left the `+` at the full 20px, so a crowded rim carried two sizes and read as two kinds of
control - reported with a picture. And the floor was 11px, which is smaller than the pointer that has
to hit it. The gap is a *starting* number rather than a guarantee: `erFitToArcs` grows a box for the
arcs its sides carried **as laid out**, and the collision pass then moves boxes, which can put an arc
on a side that was never sized for it. So both marks follow the same rule between a floor of 15 and a
cap of 20, and where a rim is genuinely tighter than that they touch - two circles overlapping by a
pixel is a smaller failure than a control nobody can hit, and the one under the pointer comes forward.

**The tooltip is worked out on hover, not on render.** Two walks per mark is nothing once and 2N times
is the render; a tooltip nobody has pointed at has told nobody anything. Measured on the sample schema,
folding changes neither the scale nor the pan - 1.102 and tx 339 before and after - so nothing moves
under the click except what was asked to go.

**And counting the elements found a leak nobody could see.** `.erhit` is a transparent 14px-wide copy
of every arc, and it was not in the list `erRender` clears: six arcs on screen, **thirty** hit
corridors under them after five renders, each still carrying the geometry of the layout it was drawn
for - so a click beside an arc could select a relation that had moved, and the count grew for as long
as the window stayed open. It predates all of this and was found while counting marks against arcs for
something else.

**A fold hides boxes and the frame was still sized for them.** `erFit` and the print handler both
walk `erIds` for the widest and tallest box - a folded box keeps its position, which is what lets a
fold compose with an arrangement, so both were framing the window and sizing the PDF page for boxes
nobody can see. Fold a branch at the far edge and `Fit` zoomed out to include it; `Save PDF` printed
the empty space where it used to be. It was there before the marks and nothing had found it, because
folding was three clicks deep and the two are only visible together. Both skip what `erHiddenSet`
hides now, and the case is a unit one - a box 2000px to the right, fitted with and without it.

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

**What a reader placed may not be moved, and what «placed» means is decided at two moments.** The
collision pass takes the set of boxes it may not push. Without it the sentence in `erLayout` -
newcomers make room around an arrangement rather than the arrangement being computed away - was an
intention rather than a behaviour: held positions were written back and then pushed like any others,
so switching a category on could move what somebody had spent twenty minutes building. When one of
an overlapping pair is pinned the other takes the whole push, so a pair separates in as many passes
as before; when both are pinned the overlap is **counted and left**, because the reader put them
there and is already told when one box covers another. `erResize` deliberately does not pin: that
overlap is made by labels changing size, not by the reader, and a hidden box is a correctness
problem whoever caused it.

The two moments differ, and the difference is settled rather than left to whoever writes the second
one. **While working**, a drag pins *everything on screen* - the decision from «an arrangement is the
relationships», where holding only the dragged box preserved nothing. **On loading a saved
arrangement**, which does not exist yet, only the boxes the reader had actually moved are pinned.
Both restore every position the file carries; the question is only who may be nudged aside when a
new box needs room, and there the tables nobody chose to place are the ones that give way. Decided
with Ivan on 13 August 2026, on the functional question - «when you reload, what is *yours*» - and
recorded here because the file that would carry it does not exist.
