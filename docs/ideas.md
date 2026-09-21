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

**State:** open, not scheduled. Nothing on the listing is wrong, so this waits behind anything a
user can see.
