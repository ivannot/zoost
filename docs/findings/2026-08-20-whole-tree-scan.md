# Findings - 20 August 2026, a scan of the whole tree

A sweep of both extensions, the site, the Worker, the release workflows and the checking tools, from
`main` at `d04f9ad`. Asked for as «find anomalies, bugs and security problems, and fix what is
anomalous», with no area excluded.

Four defects. One was on `main` and red in the battery; one was inside the package Google was
reviewing, one approval away from every Analytics user. Neither was subtle once it was looked at,
which is the sweep's own finding about itself: **the gates in this repository check what somebody
thought to check, and a sweep asks what nobody has.** Every entry ends in a rule, and three of the
four rules have a machine behind them by the end of this note.

Nothing here is a guarantee that no defects remain. What this sweep could not establish is at the
bottom, in its own words.

## 1. Analytics: every Pull all failed, and said the mirror was corrupt - critical

**What broke.** `pruneSql()` in `apps/analytics/sidepanel.js` enumerated the workspace with
`walk(op.root)`. `walk()` is a **CRM panel** function and has never existed on the Analytics side -
the line was written from the CRM side, which is what the twin rule makes likely rather than
unlikely. Every Pull all therefore threw `ReferenceError: walk is not defined`, and it threw *inside
the one `try` block that marks the mirror incomplete*: a pull that had written every one of its bytes
correctly ended as «the last pull was interrupted mid-write - run Pull all to repair», `.pull-state.json`
stayed at `writing`, the loader refused the snapshot, and the repair ran into the same wall. The
workspace could never be pulled again.

**Where it actually is, corrected.** This note first said it had shipped, «the version the Store is
serving». It has not: `/api/versions` - the Store's own answer, read through Google's API - reports
Analytics **1.27.0 published** and **1.28.0 PENDING_REVIEW**, and 1.27.0 does not contain the call
(`pruneSql()` arrives with 1.28.0). So nobody was affected, and the margin was one review queue. The
error was mine and it is the class this repository already names: a version number was inferred from
the manifest and the tag instead of asked of the one system that knows.

Nothing here could see it. `node --check` accepts a free variable; `twincheck` compares functions that
exist on both sides and this one existed on neither page; the panels are not importable, so no unit
test runs it; `tools/probe.py` drives the sample workspace, where no pull happens; and `deadcode.py`
looks for the opposite - a declaration nobody calls.

**The fix.** The helper is defined in the Analytics panel, byte-identical to the CRM's, beside
`readFile`/`writeFile` where its twin sits. And the class is now checked rather than remembered:
**`tools/callcheck.py`** reads, per page, the scripts that page loads and reports every name they
call that is neither declared in one of them nor a platform global. It is in `tests/run.sh`, it
reports zero on this tree, and it was proven both ways - it names `walk()` with the fix reverted and
says nothing with it in place. Five cases in `tests/tools_test.py` hold its shapes, including the one
that made its own first run report 87 findings with a straight face: a regular expression containing
an apostrophe, read as the start of a string, blanked 54% of the CRM panel.

**The rule.** **A call is a claim that something exists, and nothing in a browser checks it until the
line runs.** Where a project has twins, that claim is made most often in the file that has *not* got
the thing - so the check belongs at the boundary the browser actually enforces, which is the **page**,
not the file. And the corollary this cost the most: a defect that only appears on a path no test and
no probe walks - a pull, a delete, a permission refusal - will be found by a user or by a sweep, so
the sweep is not optional.

## 2. The battery was red on `main`, and the checker was reporting its own ledger - high

**What broke.** `tools/langcheck.py` scans every tracked text file for Italian, and its ledger,
`tools/notenglish.txt`, quotes every line it records. The ledger is a `.txt` file, so the scan read
it - and reported 33 of its own entries back as findings, plus the five lines of the tool's own
Italian word list. `--accept` could not converge either: each run writes lines that the next run
finds. `tests/run.sh` was red at `d04f9ad`, the commit that introduced it.

**The fix.** The ledger is skipped, for the reason `tools/absolutes.txt` already is: a derived file is
read, not judged. The word list is recorded in the ledger like any other deliberate line. The suite is
green and `--accept` is idempotent.

**The rule.** **A checker that reads the tree must decide what it is *not* about itself, and the first
candidate is always its own output.** Every ledger in this repository - `cssdupes.txt`,
`asyncglobals.txt`, `notenglish.txt`, `twins.txt`, `absolutes.txt` - is a file full of exactly what its
checker looks for. Ask, when writing the next one, what happens on the run after `--accept`.

## 3. Both bridges truncated a CSRF token at the first `=` in its value - medium

**What broke.** `cookie(n)` in both content bridges was
`document.cookie.split('; ').find((c) => c.startsWith(n + '='))?.split('=')[1]`, which stops at the
first `=` **inside the value**. That is padding on anything base64. The request then goes out with
part of a token and Zoho answers 400 or 401 - indistinguishable from a session that has expired, and
pointing at the wrong thing entirely. Not observed in the field: the values captured on this account
are hex, so today it is a latent defect rather than a live one, and the reading was covered by no test
because `csrfToken()` is tested with the jar injected.

**The fix.** The value is everything after the first `=`, which is what a cookie is. A declaration
rather than an arrow in both bridges, so `tests/slice.mjs` can lift it; eight cases in
`tests/panel.test.mjs`, four per app, including a name that is a prefix of another. Proven red against
the old expression.

**The rule.** **A value crossing a boundary is parsed by the boundary's rules, not by what today's
values happen to look like.** This is the fifth time this repository has met that class - the `\x1e`
record separator, the CSRF cookie *family*, the `.dg`/`.meta.json` pair, an epoch against a formatted
string, and now a cookie value against `split`. The second half is narrower and is what left this
one uncovered: **a helper that tests inject a stand-in for is a helper nothing tests.**

## 4. The site served no security headers at all - low

**What broke.** `curl -sSI https://zoost.it/` returns no `x-content-type-options`, no
`referrer-policy` and no framing header. `/report` is the page that matters: it holds a button that
publishes to a public issue tracker, and a page that can be framed can be framed invisibly.

**The fix.** `site/_headers` sets `nosniff`, `strict-origin-when-cross-origin` and
`X-Frame-Options: SAMEORIGIN` for every asset. Deliberately **not** a content-security-policy: the
report page loads Cloudflare's Turnstile and every page carries an inline `<style>`, so a policy would
have to allow both and would have to be verified against the deployed site rather than reasoned about.
That is a separate, deliberate piece of work, and the reason is written in the file rather than left
as an absence.

**The rule.** **What a platform does by default is a measurement, not an assumption** - the check
here was one `curl`, and it is the same discipline this repository already applies to Zoho's API and
to Google's dashboard. And: ship the hardening that cannot break a correct page today; do not ship the
one that needs a deploy to verify, and say which is which.

## What was verified

- `tests/run.sh` green end to end: 721 Node tests, 257 Python tests, every checker at zero, both apps
  package.
- `tools/callcheck.py` proven in both directions - it names the real defect when the fix is reverted.
- `tools/probe.py` in a real Chrome: both panels green.
- `twincheck`, `deadcode` and `imgcheck`: no findings. The 28 site images were re-rendered from the
  changed panels and all 28 came back as the same picture; `tools/imgstamp.json` records the new
  sources.
- A scope-aware sweep of every shipped script for free variables, over the AST rather than the text,
  found `walk()` and nothing else in either app, and nothing in the site scripts or the tools.
- What the Store is actually serving, asked of `/api/versions` rather than inferred: Zoho CRM 1.44.0
  published with 1.45.0 in review, Zoho Analytics 1.27.0 published with 1.28.0 in review.
- Read for this sweep and clean: both manifests and their CSP, the page-world hook and the message
  boundary at both ends, `keyvault.js`, the export's HTML escaping and the Deluge highlighter,
  `/api/report` and the rest of the Worker, and `release.yml`.

## What this scan cannot establish

1. No authenticated session was run against a real CRM organisation or Analytics workspace. Defect 1
   was found by reading and by a checker, and the fix is the CRM's own helper - it is *not* confirmed
   against a real Zoho Analytics pull.
2. The free-variable sweep is file-scoped: a name declared inside one function and used freely in
   another passes it, and `callcheck.py` reads calls rather than every reference.
3. The site's new headers are in the repository until the site is deployed, and only `curl` can say
   they are live.
4. Nothing here says anything about the two panels' behaviour under a real org's shapes, limits,
   roles and data centres - the standing limit of every sweep in this folder.
