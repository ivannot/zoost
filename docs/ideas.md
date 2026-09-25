# Ideas not yet decided

Things worth considering that are **not** commitments. An idea lands here the day it is raised, so it
stops depending on somebody remembering it; it leaves the day it is done or dropped, with a line
saying which. What it must never become is a pile: an entry with no argument in it is a wish, and a
wish nobody can act on is noise in a file people read to decide.

Each entry says what it is, why it was raised, what it would cost, and where it stands. **The cost is
the part that earns its place** - an idea whose price has not been looked at cannot be compared with
the work it would displace.

---

## The panel says what changed after an update

**Raised** 18 September 2026, by the author, after asking why the CRM notes did not mention pipelines.
They did - third paragraph of `store/crm/whatsnew/1.52.0.md` and of the published Release - and he had
simply not seen them. That is the finding: not a gap in the notes, a gap in where they can be read.

The notes exist in exactly one readable place, the GitHub Releases page. The Chrome Web Store has no
per-version field at all, and the panel shows nothing. So somebody whose extension updates overnight
has no way to learn what changed unless they go to GitHub of their own accord, which nobody does.

**What it would be:** the panel notices its version has moved since the last time it ran, and says so
once - a line, dismissible, linking to that version's Release. The version is in the manifest; what
the panel would need to keep is the last version it greeted, in its own storage.

**Cost:** small, and confined to the panel. The risks are the usual ones for anything that speaks
without being asked: it must appear once and never again, it must not push the first-run guidance off
the screen, and it must say something rather than «we improved things».

**State:** open, not scheduled.

---

## Landing on the other product's tab should offer the other product

**Raised** 18 September 2026. A user opened Zoost CRM with a Zoho Analytics tab in front, and the
panel said «Not on a Zoho tab» - wrong twice over: the tab *was* Zoho, and the message did not say
which product was expected. The message now names the product, and that is a correction rather than a
solution: the reader still has to work out what to do.

**Can it know? Yes, and it costs nothing - measured, not assumed.** Both manifests already declare the
`tabs` permission, and in MV3 that is what grants `url` on a Tab object; host permissions are only the
other way of getting it. The panel is already using it: `apps/crm/zoho-bridge.js:42` queries the
active tab with **no** URL filter and then tests the host itself, so an Analytics URL is in the
panel's hands today, on the very code path that ends in that message. `activeZohoTabId()` answers an
id or `null`, and the `null` branch in `apps/crm/crm-context.js` is where the line is written - so the
URL is not missing, it is discarded one step earlier. Nothing new would be read, no host added, no
re-authorisation.

**Opening the other extension: measured, on 18 September 2026, by loading two throwaway extensions
in the author's own Chrome (151) and clicking the buttons himself.** A bench was needed because the
question is entirely about *user activation*, and a simulated click is the variable under test; his
click is the real thing. It carried its own positive control - a button that opens the bench's **own**
side panel - because without it a failure at the cross-extension step could not be told from a bench
that cannot open a panel at all. The control passed, so the two answers below mean what they say.

  - **A message does reach the other extension.** With `externally_connectable.ids` naming the sender,
    `chrome.runtime.sendMessage(<other id>, ...)` arrives and is answered. So «is the other one
    installed?» is answerable: if it replies, it is there.
  - **It cannot open its own side panel from that message.** Chrome refused it in as many words:
    `sidePanel.open() may only be called in response to a user gesture`. The user's click lives in the
    *calling* extension and does not cross the boundary. There is no API that opens another
    extension's panel, and this is the evidence rather than the expectation.
  - **Its page does open in an ordinary tab**, via `chrome-extension://<id>/<page>` with the receiver
    listing it in `web_accessible_resources`. Worse than the side panel, and still one click.

So the shape this can take is settled: **name the tab, then either «Zoost Analytics is installed -
open it from the toolbar» or «install it», with a link.** Which of the two sentences is shown is a
question the other extension answers about itself. What cannot be promised is opening it for them.

**Cost:** the code is small and the permissions do not move. The one real cost is the listing: the
published `tabs` justification opens with «tabs is used to identify the Zoho CRM tab», and recognising
another Zoho product to point at it wants a clause. The paragraph's promise - «does not enumerate tabs
unrelated to Zoho CRM» - stays true, since this is the active tab and not an enumeration. A field
edited is a field re-pasted by hand in the dashboard, which is the price.

**State: done, 18 September 2026.** Both panels name the twin's tab and point at the product that
reads it, choosing between «open it from the toolbar» and a link to its listing by whether the
other extension answers. Ambiguous hosts - `one.zoho.*`, `crmplus.zoho.*`, which are in both
manifests - keep the plain message, because naming a product there would be a new false sentence
in place of the old one; a case holds that line. No permission changed: `tabs` was already
declared and the URL was already being read and thrown away.

---

## One extension instead of two

**Raised** 18 September 2026 by the author, explicitly as a question rather than a plan: «non so
nemmeno se varrà la pena portare avanti». The reasoning: a user can click the wrong icon, and the two
products already share a great deal of code, so why not one extension that changes behaviour and
layout according to the URL in front of it.

**What it would buy, measured:** `tools/twins.txt` records 301 function names defined in both products,
186 of them byte-identical - 80,726 characters of deliberate copy. The defect class that copy creates
is real and recurrent: a fix that lands on one twin and not the other. It has produced the divergent
empty states, two different exclusion lists for the same click handler, and most recently a redraw
after a pull. One codebase would end that class, and one release chain would replace two.

**What it would cost, measured on the manifests:**

- **Host permissions become the union.** The CRM declares 39 host patterns, Analytics 29, and they
  share 20 (`one.zoho.*`, `crmplus.zoho.*`, the two AI hosts, zoost.it). Merged: 48. A CRM user would
  newly grant the 9 `analytics.*` hosts; an Analytics user the 18 `crm.*` and `crmsandbox.*` ones.
  Chrome does not apply added host permissions silently - **the whole installed base is asked to
  re-authorise**, and an extension sitting in that state does nothing until they do.
- **Two Store items cannot be merged.** One would be retired and its users do not migrate: they would
  have to install the other, which is a request most of them will never see.
- **«Single purpose» is a Store field and a Store policy.** A merged item has to state one purpose.
  «Understand and version-control what you built in your Zoho org» probably carries both, but it is an
  argument to be made to a reviewer rather than a fact, and it is made with two listings' history
  behind it.
- **Every user ships both products' code.** Minor next to the above, and worth saying anyway.

**The middle path, and why it is not free either.** One source producing two packages would end the
divergence without touching permissions or listings - but it collides with a non-negotiable: no build
step, and `apps/<app>/` is what Chrome loads unpacked. Generating or assembling those folders means
the repository no longer holds what ships, which is the property that makes this extension auditable
by whoever is about to give it their CRM. That trade is a bigger decision than the merge itself.

**Where it stands:** open, and the honest reading is that the benefits are internal and the costs are
the user's. It should not be decided as a remedy for the wrong-icon problem, which the entry above
solves for a fraction of the price. If it is ever taken up, the reason will be one codebase and one
release chain - and the day to do it is before there is a third product, not after.

**State:** open question. Not scheduled, and not recommended on today's evidence.

---

## The call graph screenshot is not the same picture twice

**Raised** 21 September 2026, measured rather than suspected, while checking whether a change to
`shots.py` had moved any pixels. `tools/pngsame.py` between the five CRM images that were uploaded
for 1.53.0 and a fresh render of the same tree:

    crm/1..4.png    same picture
    crm/5.png       38,147 of 1,024,000 pixels differ (3.7%), worst channel difference 240/255

Slot 5 is the call graph. The other nine shots across both products are identical or differ by
1/255 on a few dozen pixels, which is encoder-level noise; this one moves structure. Nothing in the
shipped tree changed between the two renders - the last commit touching `apps/` was three commits
earlier - so the graph is being captured in two different states.

**It is not the layout.** [`docs/diagrams.md`](diagrams.md) states, with six renders behind it, that
`settle()` runs a fixed 300 iterations with no random and that the starting ring is a hash of each
id. That claim is about the *layout*; this is about the *capture*, and `shots.py` says in its own
comment that «the shot happens on a time budget». The likely reading is that the picture is taken
while the graph is still settling, which no amount of determinism downstream can fix.

**Why it matters, and why it is small:** the images on the listing are valid pictures either way, so
no user sees anything wrong. What it costs is the one question this tool exists to answer - «did the
screenshots change?» - on one slot out of ten, for ever. That is the failure the source-digest
criterion was introduced to remove, arriving by another road.

**Cost:** small if the cause is the capture - wait for the layout to report itself settled instead of
for a duration, which is the same «record the event, do not sample the clock» rule this repository
has already paid for twice. Unknown if the layout is in fact not deterministic under the panel's own
conditions, which would be a finding about the product and not about the shot. **The first step is an
instrument, not an edit**: render slot 5 three times and compare, which costs about a minute and
decides which of the two it is.

**State: no longer optional - it gates the CSS consolidation.** Merging a divergent selector is a
decision per declaration with a screenshot on either side of it, and a before-and-after on
`graphview.css` cannot be read while two renders of the same tree already differ by 3.7% of their
pixels. The identical selectors were lifted without it (they need no comparison); the divergent ones
wait for this. Nothing on the listing is wrong, so this is not urgent for a reader - it is a
prerequisite for a piece of work, which is a different kind of priority.

---

## Zoost outside Chrome: a desktop app that embeds the browser

**Raised** 25 September 2026 by the author, as a fantasy rather than a plan, and from a real
complaint: the product is good and its limit is usability, because it lives in a side panel and
sometimes there is not enough room. The shape imagined: a desktop app for Mac and Windows that
embeds a browser, with the Zoho page in the background and Zoost in front - a browser that exists
only to visit Zoho.

**What actually binds this product to Chrome**, in increasing order of difficulty:

- **Where the panel sits** (`sidePanel`). Placement, nothing else.
- **The mirror on disk** (File System Access, persisted handles, the permission that lapses between
  sessions). Native makes this *vanish* rather than easier: direct file system, no handles, no
  «grant access again», and with it goes a class of defects and one of the manual checks.
- **The authentication, which decides the whole question.** Zoost never logs in. It reads the org
  and user id out of the page and **borrows the session of the Zoho tab you already have open** -
  the CSRF tokens come from cookies (`CT_CSRF_TOKEN`, `crmcsr`, `drecn`) and the requests go out
  with that session. It is authenticated because *you* are, in that browser. A native app can only
  reproduce that by embedding a real browser you log into.

**The fast road is Electron**, and not out of habit: Electron *is* Chromium. The panel - 40k lines
of JavaScript with no framework and no build step - ports nearly as it stands; the Zoho view becomes
a `BrowserView` in a persistent partition, which is a profile with its own cookies; the bridge
becomes a preload in the same model as today; cross-origin calls leave from the main process, where
CORS does not apply. Tauri is the elegant answer and the wrong one here: it uses the system webview,
so Chromium on Windows and Safari on macOS - two engines under the part that borrows another page's
tokens, which is the twin divergence this repository already pays for, multiplied by two operating
systems.

**What it would cost, and the expensive half is not the code:**

- **Distribution.** No Web Store: an Apple Developer ID with notarization, a Windows code-signing
  certificate (without one, SmartScreen treats the installer as suspect for months), an update
  server, and the release chain - reproducible build, Release asset, signed attestation - redesigned
  for two installers instead of one zip. These are recurring costs.
- **The trust posture inverts.** Today the pitch is readable source, minimal permissions all visible
  in the manifest, no write path to Zoho, and it never sees a password because it rides a session it
  did not create. An app that embeds a browser is an app you **log into**: it holds the Zoho session,
  and what is being asked of the user changes category. That is not a technical obstacle, it is the
  selling argument turning around.
- **Three products, not one.** The extension cannot be withdrawn - it is published and has users -
  so a desktop app is added to the two, not substituted for them. This is the same arithmetic the
  «one extension instead of two» entry above gets wrong if read hopefully.

**What it would buy, beyond the room:** one codebase and one release chain for both products, which
is exactly what that other entry wants and cannot have without asking the whole installed base to
re-authorise.

**The recommendation, and the order matters.** Separate the *problem* from the *fantasy*. The
problem is room, and the cure for it is half-built already: detached windows exist here (the graph,
the exports, the report all open 1240px windows). A persistent detached panel, or a full-tab mode,
costs days rather than months and must be measured **first** - if it settles the usability, the
desktop app becomes something done because it is wanted, not because it is needed.

If it is still wanted, the first step is not architecture but **one probe**, as the standing rule
demands: a minimal Electron shell, a `BrowserView` on Zoho, a login by hand, and the bridge reading
the CSRF and making one call that works today. A day of work, and it answers the only question the
rest depends on. **Everything written above about the third binding is reasoning, not measurement**,
and stays that way until that probe runs.

**State:** open. Worth a day of probing before it is worth an hour of planning.

---

## The two other pages inline their stylesheets

**Raised** 25 September 2026 by the author, reading the markup and asking why some styles are
declared in the HTML at all when a stylesheet exists. Measured rather than argued:

| page | inline CSS | selectors | also in `workbench.css` |
|---|---|---|---|
| `workbench.html` | none | - | links the sheet |
| `graphview.html` | 34,228 chars | 246 | **13** |
| `options.html` | 7,780 chars | 78 | **11** |

He is right in principle and this repository already agrees with him: `csscheck` exists for the rule
that a selector is defined in one place, it reads inline `<style>` blocks per document, and
`tools/cssdupes.txt` records 40 known repetitions that **should shrink**. So this is recorded debt,
not an oversight.

**What makes it not a tidy-up.** Consolidating is measured to move pixels: `CLAUDE.md` records that
merging 58 rules into the site's shared sheet shifted 5-20% of the pixels on six pages, because a
rule that was winning by order inside its own `<style>` stops winning. It is one selector at a time
with `tools/pngsame.py` on the before and after, not a file move.

**And the target is not «one CSS file».** 233 of the graph view's 246 selectors are about a canvas,
boxes and arcs, and have nothing to do with the panel; a shared sheet would make every page load a
vocabulary it does not use. The shape worth having is:

- a shared sheet for what is genuinely shared - the ~24 selectors above: the `:root` tokens, `body`,
  `.mk`, `button`, `.ck`, `.chips`, `.ftbl`, `.empty`. Those are the ones that can drift, and drift
  is the real defect: a class meaning two things depending on which page you landed on;
- each page's own rules in its own `.css` file rather than inline - free, and it makes them greppable
  and reachable by the same tools as everything else.

**Cost:** about half a day. ~24 selectors, each with a pixel comparison across three documents. The
payoff is measurable - the duplication ledger loses 24 of its 40 rows - and the risk is real if it is
done quickly rather than one at a time.

**State:** open, deliberately behind anything a user can feel - agreed as «not now» on the day it
was raised, with the overlay work taking its place.

---

## The graph and the settings become views inside the window, not pages of their own

**Raised** 25 September 2026, minutes apart, by the author - first about the diagram, then about the
settings - and they are one piece of work. His argument: a separate window made sense for
readability while the panel was narrow, and now it only risks confusing the reader.

**The reason they were separate has gone.** Both opened in their own popup window because the side
panel was capped at two thirds of a browser window and a diagram cannot be read in 400px. Zoost is
now a window of its own, as wide as the reader makes it, so a second window is no longer room - it
is one more thing to find, raise and close.

**The pattern already exists in the product.** `#healthview`, `#aiview` and `#overviewview` are
full-panel overlays inside `#main`, each with its own header and its own close. The diagram and the
settings would be the fourth and the fifth of that family, which is also the answer to «where does
the reader close it».

**The prerequisite, and it is the whole cost.** These are not empty pages:

| page | inline CSS | selectors | shared with the panel |
|---|---|---|---|
| `graphview.html` | 34,228 chars | 246 | 13 |
| `options.html` | 7,780 chars | 78 | 11 |

Bringing either into the panel's document means those selectors meet the panel's own. The shared
ones - `:root` tokens, `body`, `.mk`, `button`, `.ck`, `.chips`, `.ftbl`, `.empty` - are exactly the
ones recorded as repeated in `tools/cssdupes.txt`, so **the consolidation deferred in the entry
above stops being debt and becomes step one of this**. The rest are the graph's own vocabulary and
belong in a sheet the panel loads only where it draws one.

And the same measurement applies: merging rules moved 5-20% of the pixels on six site pages, because
a rule winning by order inside its own block stops winning. One selector at a time, with
`tools/pngsame.py` on the before and after.

**State: done, 25 September 2026** - and two things in the entry above were wrong, which is worth
more than the entry.

**The consolidation was never a dependency.** This said «246 selectors meet the panel's own», and it
was counting the *shared vocabulary* rather than the *collisions*. Measured: 2 ids and 4-8 selectors
per product for the diagram, and 22 ids for the settings. Nothing had to be merged - the diagram's
sheet is scoped under `#graphview` and the settings' under `#settingsview`, so the two never meet the
panel's rules at all, and the ids that did collide were renamed on the side that is the *copy* (the
settings form's `cfgsc_…` boxes, the diagram's `gv…`).

**And the instability that gated it does not reproduce.** The entry above says the call graph is
captured in two different states, on one observation. Rendering it three times in a row, which that
entry itself prescribes as the first step, gives three byte-identical files - so `pngsame.py` could
have measured this all along. It is what proved the move a no-op: the rendered diagram is identical
before and after.

What did cost, and was not in the estimate at all: **the shared global scope.** Classic scripts in
one document share one scope, and a redeclared `const` kills the second script outright - silently,
because the page has already loaded. `nameMode`, `MSG`, `esc`, `escA`, `$`, `render`, `SCOPE_*`,
`drawMax` and the rest were found by a derivation over every top-level binding, not by reading; the
first version of that derivation read only the first name in a comma list and missed the one that
actually broke the page.

---

## A Zoost handle injected into the Zoho page

**Raised** 25 September 2026 by the author: extensions can inject into a page, so put a Zoost mark
inside Zoho - the CRM one on a CRM URL, the Analytics one on an Analytics URL - draggable and
dismissible, so the reader decides whether to see it at all.

**It is cheap, and that is not the question.** Both products already inject `content-bridge.js` into
those hosts, so the handle needs no new permission, no new host and no re-authorisation. Opening the
window from it is one message to the service worker, which already answers exactly that ask - it is
how Chrome's own «Options» entry reaches the settings view.

**What it costs is the posture, and that is the argument against.** Everything this product says
about itself is that it *reads* the platform: «no write path to Zoho», «no synthetic clicks into a
DOM contract we do not own», a content script that observes and answers. A floating control is a
visible write into somebody else's page. It does not touch a record and it does not weaken the
bridge - but the sentence «Zoost never changes anything in Zoho» stops being simply true, and the
first person to test it is the approver reading the listing with the page open beside it. This
project has already had to walk back one absolute; walking back a second, for a shortcut, is a poor
trade.

Three smaller costs, each real:

- **Dismissible argues the feature away.** Once it is gone the way back is the toolbar icon - the
  thing the handle was there to replace - so for every reader who dismisses it, the feature has
  spent its complexity and bought nothing.
- **Position is somebody else's problem, permanently.** Zoho moves its layout without telling us;
  a handle that lands on their own floating controls is a defect report we cannot reproduce, and
  «drag it out of the way» makes the reader do the fixing.
- **It appears for every profile that has the extension**, including one used by somebody who only
  ever opens Zoho.

**The alternative that buys most of it for nothing: a keyboard shortcut.** A `commands` entry opens
the window from anywhere, in any tab, with no DOM written and no page touched - and it is the thing
that was lost when `_execute_side_panel` went with the panel. It costs one manifest key.

**Cost:** the handle is half a day and a paragraph of store copy re-pasted by hand. The shortcut is
an hour. They are not alternatives in effort, they are alternatives in what is being claimed.

**State:** open, and recommended against in its injected form - his call, not mine. The shortcut is
worth doing on its own merits and is not blocked by this.
