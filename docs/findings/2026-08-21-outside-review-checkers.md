# Findings - 21 August 2026, an outside review of the checkers

An outside review of `main` at `12fe202`, 79 commits after the previous one. It confirmed what the
suite says - 751 Node tests, 273 Python, every checker at zero, both apps packaging - and then found
three things the suite could not, because two of them were **in the checkers themselves**.

All three were verified here before anything was changed. All three were real. The note is kept
because of what they have in common: **a tool that reports zero over a surface it does not look at**,
which this repository has now met three times.

## 1. `htmlcheck` inspected 148 of 210 attribute interpolations, and printed 0 - high

**What broke.** The pattern was `attr="${...}"`: the whole attribute value, and nothing else. So
`href="#${id}"`, `class="row ${cls}"` and `style="background:${c}"` were never examined at all.
Measured on the tree: **148 inspected, 62 invisible**. The tool's docstring declares one limit - it
does not check element *content*, with reasons - so the silence read as complete coverage of what it
did claim.

**The fix.** The pattern is `="[^"\n]*\${`, and every `${...}` inside the value is read, brace-counted
so a nested object literal stays whole. Widening it uncovered 41 expressions that are inert and cannot
be shown to be inert *by syntax*: an anchor through `sanitize()`, a colour from the panel's own
palette, a class from a ternary of literals, a number. Teaching `suspect()` their names would be an
allow-list of functions, so they are a **ledger** - `tools/attrraw.txt`, like `cssdupes.txt` and
`asyncglobals.txt`: recorded with their place, anything new is a finding, and it may only shrink.
Proven by planting a new raw interpolation and watching it come back.

**The rule.** **A limit that is not written down is a blind spot.** The distinction is not the size of
what a tool skips, it is whether the skip is *declared*: `htmlcheck` skipping element content is a
conclusion, and it says so; skipping two thirds of its own subject was invisible to everyone,
including the person who wrote it. Every checker here should state what it does not look at, in its
docstring, in the terms a reader would use to check.

## 2. Two `escHtml` in attribute position, in the blind spot, on one twin only - medium

**What broke.** `apps/crm/sidepanel.js` built `href="${escHtml(PRODUCT_URL)}/privacy.html"` and
`href="mailto:${escHtml(CONTACT_EMAIL)}"`. `escHtml` does not escape quotes - that is the whole reason
`escA` exists and the whole reason `htmlcheck` exists. Inert, because both are module constants; the
Analytics twin uses `escA` on the identical line.

**The fix.** `escA` in both, which also makes the twins agree again. `tools/twins.txt` records the
one-sided change.

**The rule.** **Three protections that each depend on the other two are one protection.** The escaper
was wrong, the checker did not look there, and the twin comparison sees function *bodies* rather than
this line - and each of the three would have been enough on its own. When a defect survives, ask which
guards it passed and why, rather than fixing the one that happened to be nearest.

## 3. The report endpoint's rate limit failed open on the write - medium

**What broke.** In `/api/report`, the read of the per-address counter fails closed - a KV error
refuses the request, with a comment explaining that a limit which disappears when things go wrong is
not one. The **write** immediately below it was `catch (_) {}`. A fault that stopped `put` while `get`
kept answering would return 0 for ever, and the five-a-day ceiling would stop existing in silence, on
the one endpoint here that opens public issues under the maintainer's token. Turnstile still stood in
front of it, so it was never open to anybody; what it lost was the only limit that applies to somebody
who *can* pass Turnstile.

**The fix.** It fails closed, like the read. Three cases in `tests/worker.test.mjs` run the endpoint
with a counter that cannot be written (refused, and no issue opened), one that can (sent), and one
over the ceiling - the middle one because a gate that always refuses looks strict until somebody needs
it. Proven by restoring `catch (_) {}` and watching the first go red.

**The rule.** **A swallowed write is a lie about state, wherever it is.** This is the same defect this
repository recorded in `updateMetaIndex` - a refused write caught and dropped, so the caller cleared
its dirty mark over something that never happened - reappearing one system over, in a language and a
runtime the earlier fix never touched. A rule learnt in the panel does not travel to the Worker by
itself.

## Said rather than fixed

- **The origin check sits inside `if (origin)`**, so a client that omits the header skips it. Left as
  it is, and the reason is now in the file: the endpoint has no cookie and no session, so there is
  nothing for a forged cross-site request to spend, and Turnstile is the gate that matters. The review
  was right that the *shape* claims more than the check does.
- **No content-security-policy on the site.** Raised by the review as explicitly *not* a finding,
  because `site/_headers` states the decision and its reason. Recorded here so it is not rediscovered
  as an omission.
- **The `/report` flow's 700 new lines** were read once by the reviewer and found sound - the write
  into the page's DOM rather than the fragment, and the double redaction. One reading is not an audit,
  and it is not claimed as one.

## What this review could not establish

It read the tree at one commit. It did not run either extension against a real Zoho organisation, and
it says so; the manual checks that cover that are recorded in `store/*/handchecks.json`, on the
author's own word, and they are the only evidence of that kind this project has.
