<!-- Split out of docs/decisions.md, which had grown to 102k in one flat run of 147
     decisions with no heading to navigate by. Nothing was cut: this is the same text,
     in the file CLAUDE.md's index now names. -->

# The sample workspace, and the pictures rendered from it

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

**And every published picture is the workspace `+ Sample` delivers, which is not where they came
from for months.** They were rendered from `fixtures/` - the edge-case tree - so the Chrome Web Store
listing for Zoho Analytics opened on a greyed **«Retry 1 failed»** chip: a query the generator writes
as unreadable *on purpose*, so that the retry path has something to act on, and that nobody who
presses `+ Sample` is ever handed. Nothing was failing. The shop window was photographing the test
fixture, and the same picture said **44 views** two clicks from a page that describes the sample as
**39**. Reported by the author, who asked the right question about it: whether the chip was an
application defect, and whether the clean answer was to remove the cause rather than the display.

So `node tools/fixtures.mjs --as-delivered <dir>` writes the other side of the flag, `tools/shots.py`
asks for it at render time, and nothing is committed twice - one generator, one command, two
consumers. There is **no exception list**, and there was going to be one: an audit photographed with
nothing to report documents nothing, so the figures whose subject is a refusal looked like they had
to keep the edge-case tree. Measured rather than assumed, and they do not - «Failing in Zoho» still
counts four and «Wiring» four, because those states are in the workspace the product delivers, while
what `edgeCases` adds is finer than anything a published figure points at. An exception nobody needs
would be a second workspace in the published material and a rule with a hole in it.

`tests/tools_test.py` holds the two halves that matter: the delivered workspace contains **nothing
recorded as failed**, and its view count is the number `site/try.html` prints. That second one is the
check that would have caught this the day it appeared.

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

**Coverage is checked, not intended - `tools/imgcheck.py`.** «Total visual coverage of the features»
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
