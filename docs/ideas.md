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
panel said «Not on a Zoho tab» - which was wrong twice over: the tab *was* Zoho, and the message did
not say which product was expected. The message now names the product («Not on a Zoho CRM tab»), and
that is a correction, not a solution: the reader still has to work out what to do.

**What it would be:** when the tab is a Zoho product this extension does not cover, say what it is and
point at the one that does - «This is Zoho Analytics. Zoost Analytics reads it», with a link that
opens the other extension if it is installed and its listing if it is not. Whether one extension can
detect another is a question to answer before anything is built (`chrome.management` is a permission
this project would not add; a link to the listing needs nothing).

**Cost:** small. The one thing to establish first is the detection, and the fallback - a link to the
listing - is free and needs no permission, so the feature stands even if detection is refused.

**State:** open. This is the cheap half of the question below, and it addresses the reported friction
on its own.

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
