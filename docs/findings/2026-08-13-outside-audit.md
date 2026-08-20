# The August 2026 external audit: what was taken, what was refused, what it found by accident

An outside technical audit of `apps/crm` arrived on 13 August 2026 - priorities P0 to P3, an
architecture proposal, and a testing roadmap. This is the record of what happened to it. Open it
before reacting to the next outside review: it is the worked example of the rule this project already
states, that **a review is evidence, not a verdict**, and of how much of a confident document can be
wrong while still being worth every minute.

Its own summary was accurate on the important thing: no confirmed P0, and the largest risk is
concentration rather than indiscipline. Six of its findings were real and are fixed. Three were false
or already satisfied. Three are refused, with reasons. Two more defects were found while checking it,
by machinery built to check it - neither of them in the audit.

---

## Done

### 1. «No write path to Zoho» is enforced, not promised (their P1.4)

The first non-negotiable in `CLAUDE.md` lived only as prose. `tests/tools_test.py` now reads every
`fetch` in the shipped code, resolves single-quoted constants until the text stops growing - so a URL
moved into a variable cannot hide - and requires anything that is not a GET to be either one of the
two declared AI hosts or an endpoint named in an allowlist with its reason. The allowlist holds one
entry, `ZDBCreateERD`, the call that returns the ER model - and what is asserted about it is what
Zoost sends, because what a server keeps is not observable from here.

Two things it had to learn by being wrong first, both worth keeping: the URL is usually *not* at the
call site (`BASE + path`), and the exception cannot be keyed on the call - what is exceptional is the
**endpoint**, so a second endpoint handed to the same helper fails. Both proven by planting them.

The same class also holds that nothing injected into Zoho's page drives it: an injected file must be
one of ours, and an injected function must not click, dispatch an event or set a value.

### 2. The page-world channel is narrowed and asserted at both ends (their P1.3)

`hook.js` posted to `'*'`; it posts to `location.origin`. The receiver, which the audit said validated
nothing, was already checking that the sender is this window - it now also requires the id to be
digits. What the message buys is a re-read of one function from Zoho, so a forged one can only ask for
a re-read of something that exists. A test holds both halves, because neither is visible in a review
of one file.

### 3. Empty, refused, and «a shape that moved» are three different answers (their P2.2)

The important one. `(resp.workflow_rules || [])` turned «this is not the response I read» into «there
are none», in a tool whose whole promise is a faithful copy: an endpoint that changed would have been
mirrored as an empty area, silently, and believed. Twelve reads in the CRM bridge and the entire
Analytics census went through that pattern.

204 is the only absence Zoho states, so it is the only one accepted as one; anything else missing its
collection now stops with the field named. A module whose fields come back unrecognisable records
that as its reason, beside refused and failed, instead of landing on disk empty and unexplained.

**What this costs, stated rather than discovered:** if some endpoint answers 200 with the collection
absent for an org that genuinely has none - not observed here, and not testable without such an org -
that area now reports an error instead of writing zero. For a mirror that is the right way round, and
it is visible and reportable instead of silent.

### 4. Every page loop has one ceiling, and every result says whether it hit it (their P2.3)

Two loops carried `page > 20` written out twice; two had no bound at all. So the two that could run
away were also the two that could not report having stopped. One `MAX_PAGES`, and `capped` on every
result.

### 5. The key envelope records the cost it was written at (their P2.9)

PBKDF2's iteration count is an input to the key, so raising it - the one change the vault is meant to
accept as machines get faster - would make every box already written derive a different key and fail
as «wrong passphrase», which is the single error this design cannot explain. The number now travels
with the ciphertext; a box written before this reads at the old cost, so nothing is migrated.

**And a real defect underneath it:** `forget()` existed and *nothing called it*. Pressing **Forget**
cleared the key from storage and left the plaintext in the session cache until the browser restarted -
which is not what that button says. It is per-provider now, and the options page calls it.

### 6. Hostile strings, and the boundaries written down (their P2.5, P2.10, P3.4)

Escaping is asserted against the inputs an attacker would send, in both products, including what a
model can be talked into echoing. And `docs/boundaries.md` is the map those comments never added up
to: who is trusted for what, what the one page-world channel may cause, what the assistant can reach,
where read-only is actually enforced, and what is deliberately not defended against.

---

## Found while checking it, by the machinery built to check it

Neither of these is in the audit. Both were in shipped code and in published pictures.

**Every render stub has written `SHOT ERROR: ...` into the page title when its click script throws, for
as long as the stubs have existed, and nothing ever read it.** A panel could fail on load and still
produce a perfectly good picture of a panel that had not run. The capture now reports the title and
any uncaught exception with its top stack frame, and `shots.py` refuses the picture. That is also the
browser-level coverage the audit asked for (their P1.5), arriving from a direction that costs nothing:
the shipped pages are loaded in a real Chrome on every render, so «it loads and its scripts run» is
asserted for both panels, both graph windows and both options pages - no framework, no dependency.

On its first run it caught the Analytics **Lineage tab throwing** on `s.columns.length`: the sample
writes SQL sources as `[name]` where a pull writes `{ name, kind, columns[] }`, so the fixture
described a shape the product never produces. Fixing that exposed the second half in the picture -
`deps` carried bare ids where a pull writes `{ id, level }`, and the tab had been rendering
**«? level undefined»** beside every parent, in an image published on the site. The panel also stops
trusting the field: a detail pane that throws half-drawn is not where you find out something was
missing, and the count is omitted rather than shown as zero, because zero is a measurement.

---

## Wrong, or already satisfied

- **«The bridge does not validate the message source.»** It did: `ev.source !== window` was there
  before the audit. The `'*'` half was right.
- **«The AI tools need an allowlist, argument validation, no arbitrary fetch, no eval.»** Already true
  by construction: a dispatch chain by name ending in `Unknown tool`, no tool taking a path, a URL or
  code, and every answer computed from the mirror already in memory. The constraint is in the code
  rather than in the prompt, which is what the audit asked for.
- **«Add a version field to the encrypted envelope.»** `v: 1` has been there since the vault was
  written. The iteration count was the part missing, and that is fixed above.
- Its line counts are slightly stale (`sidepanel.js` is 5,385 lines, not 5,288), which is worth
  knowing about the rest of it: it read a checkout that was a few days old.

---

## Refused, with reasons

### Splitting `sidepanel.js` into ~25 ES modules (their P1.1)

This is the single riskiest thing that could be done to this repository, and the audit says so itself
two paragraphs after proposing it: no big bang, extract one seam at a time. There is no regression
testing here by explicit choice - the author tests what just changed - so a wide structural move would
be caught by nobody. The project already does this the other way: `graphlogic.js` was extracted by a
**derived** criterion (byte-identical in both products, touching no DOM handle), with every rendered
picture proven unchanged. A folder tree drawn in advance is not that. The next extraction will be by
another measurable criterion, when one is worth its risk.

### A `zoho/` adapter folder (their P1.2)

`content-bridge.js` **is** the adapter: one file, 633 lines, every endpoint, the CSRF families, the
pagination, the warm-up. Splitting it into ten files adds imports, not a boundary. What the audit
actually wanted from that boundary - normalise before the rest of the product sees it, do not let a
changed shape become an empty list - is what section 3 above does, inside the file that already owns
it.

### Playwright or Puppeteer for integration tests (their P1.5)

It would be the project's first dependency, against a stated model whose whole pitch is that the
shipped source is what you audit. And it is not needed: this repository already drives headless Chrome
over the DevTools protocol with zero dependencies, and that machinery is what now refuses a page that
failed to load. If a boundary needs asserting that this cannot reach, it will be argued on its own.

### Also refused, briefly

- **An error taxonomy over ~76 empty catches (their P2.1).** The class that mattered - a read failure
  swallowed into «nothing there» - is fixed above and in the panel's disk reads. Rewriting the rest
  would be a wide edit for a diffuse benefit.
- **ESLint (their P3.1).** A dependency, for rules `node --check` and the existing checkers largely
  cover.
- **Moving forensic comments into ADRs (their P3.3).** They are load-bearing where they are: this
  project's comments explain *why a strange branch exists*, and the file is where somebody about to
  change that branch is looking. The long-form notes already live in `docs/`.
- **`MirrorFS`, schema-migration docs, provenance envelopes on every area (their P2.6, P2.7).** Real
  ideas, not refused on principle - not done now, and not claimed as done.

---

## Open, and deliberately left

**The committed CRM graph payloads are stale relative to the generator.** Regenerating `fixtures/`
rewrites `graph-crm-calls.json` and `graph-crm-schema.json` substantially and turns a test red: the
sample would then carry a function whose namespace is a **module name**, and Zoho has only
`standalone`, `automation`, `button`, `schedule`, `validation_rule`. So either the generator emits a
namespace Zoho does not have, or the test's list is incomplete. That is a decision about what the
sample should contain rather than a repair, and it was not made at the end of a long session. The
payloads are left exactly as they were; nothing published depends on them, because the pictures are
now rendered from the workspace `+ Sample` delivers.

**The screenshots of both listings changed** and have to be re-uploaded at the next submission.

---

## The rules it left behind

This note predates the shape the later ones use - what broke, the fix, **the rule** - and it is left
in its own form, because it is a reply to somebody else's document and its argument is what was taken
against what was refused. What it must not lack is the last part, so the rules it produced are
collected here. Each of them is enforced somewhere, and where nothing enforces it that is said.

- **An absolute is a claim about what we send, never about what the other side does.** «Zoost never
  writes to Zoho» became «these are the endpoints Zoost calls», asserted per endpoint in the bridge -
  and a second endpoint handed to the same helper fails the test.
- **A boundary is asserted at both ends or at neither.** The page-world channel is narrowed and
  checked from the panel *and* from the hook; one side alone is a promise.
- **«Nothing there», «you may not», and «the shape moved» are three answers.** Collapsing them into an
  empty result is how a permission problem and a broken parser arrive as the same silence.
- **Every walk that pages has one ceiling, and every result says whether it hit it.** A truncated
  read that does not admit it authorises a destructive act somewhere downstream.
- **A control that exists must be reachable.** `forget()` was written, tested by nobody, and called by
  nothing; `tools/featurecheck.py` now derives the controls from the panels and holds the site to
  them, which is the same defect one layer out.
- **A review is evidence, not a verdict.** Six findings were real, three were wrong or already
  satisfied, three were refused with reasons, and two defects nobody had reported were found by the
  machinery built to check the review. Agreeing with a confident document is as much a failure as
  ignoring it.
