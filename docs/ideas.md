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

**Opening the other extension is a different question, and the answer is no.** `chrome.sidePanel.open()`
acts on the calling extension only; nothing lets one extension open another's panel. What is available:

- **a link to the other listing**, which needs no permission and no API at all. The ids are ours:
  Zoost CRM `flffecjpbmjfonhoojaiemgjanbjkmpj`, Zoost Analytics `gmelnigbgklfjgceldicakkomhgplgge`.
- **telling whether it is installed**, with `chrome.runtime.sendMessage(<id>, ...)`. That needs the
  *receiving* extension to declare `externally_connectable.ids` - a manifest field, not a permission,
  with no prompt for the user. Both extensions are ours, so each can name the other. If it answers it
  is installed, and the message can say «open it from the toolbar» instead of «install it».
- **not** `chrome.management`, which is a permission this project would have to justify for a cosmetic
  gain. Out.

**Cost:** the code is small and the permissions do not move. The one real cost is the listing: the
published `tabs` justification opens with «tabs is used to identify the Zoho CRM tab», and recognising
another Zoho product to point at it wants a clause. The paragraph's promise - «does not enumerate tabs
unrelated to Zoho CRM» - stays true, since this is the active tab and not an enumeration. A field
edited is a field re-pasted by hand in the dashboard, which is the price.

**State:** open, answered on the feasibility, and it addresses the reported friction on its own.

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
