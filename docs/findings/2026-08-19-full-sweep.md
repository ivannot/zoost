# Findings - 19 August 2026, full sweep

A sweep of both extensions, the sample-workspace generators, the site and the checking tools, from
`main` at `d253360`. The image staleness and the release/tag artefacts were excluded on request.

Eleven defects, each reproduced before it was fixed. Every one of them ends in a **rule**, because a
defect that is only fixed comes back in a function that does not resemble the last one - the whole
argument this repository makes about itself. Where a rule can be checked by a machine, the check is
named; where it cannot, that is said rather than left to be discovered.

Nothing here is a guarantee that no defects remain. What this sweep could not establish is at the
bottom, in its own words.

## 1. Analytics: `get_relations` by name never reached its own handler - high

**What broke.** `||` binds tighter than the conditional operator, so the view for `get_relations` was
always `null`. The documented call `{ name: "T1" }` answered `View not found: T1`. The test that
covered it asserted only that a non-empty string came back, so it passed on the wrong answer.

**The fix.** The distinction is now only between global tools and view-bound tools, and a relations
search by name resolves the view. `dispatch()` in `apps/analytics/sidepanel.js`, its handler, and a
semantic case in `tests/panel.test.mjs`.

**The rule.** **A test that asserts «something came back» tests the plumbing, not the answer.** Assert
what the answer *says*: a tool that cannot find its subject must be indistinguishable from a broken
one to the test, or the test is decoration.

## 2. Analytics: a missing or unreadable SQL file still counted as «searched» - high

**What broke.** A row in `sql/index.json` was taken as proof that the `.sql` file beside it had
opened. A full-text search could report having searched every query, `get_view` could omit the SQL
section entirely, and Health and the export could show no gap.

**The fix.** One shared state with three values - not a query, SQL read, SQL not read - and every
surface that needs the text does the asynchronous check. Disk errors are visible in search and in
Health, counted once, and retried: a transient failure does not become a verdict for the session. An
explicit pull failure beats an older SQL body, so plausible-but-stale text is never served.

**The rule.** **An index entry is a claim about a file, never the file.** Anything that reports
coverage - «searched all», «read all» - must derive it from what actually opened, and say what it
could not open. Absence has to be reportable, or the product lies by omission.

## 3. Analytics: an interrupted pull left a usable hybrid snapshot - high

**What broke.** The `.pull-state.json` marker protected the *next* opening and not the panel already
open. If a write failed after `state: writing`, the old structures stayed in memory while some SQL
files on disk were already new, so the assistant and the export could combine two moments.

**The fix.** Every error after the marker carries `mirrorIncomplete`; `pullAll()` drops the live
snapshot at once and blocks until a new Pull all. `complete` is written only after data, index and
cleanup.

**The rule.** **A transaction that protects the disk must also protect the memory of whoever is
watching.** The marker is not the guarantee; the guarantee is that no reader can hold half of one
state and half of another.

## 4. CRM: cleaning up a renamed function could leave orphaned metadata - medium

**What broke.** The `.dg` source and the `.meta.json` sidecar were removed inside one `try`. If the
first succeeded and the second failed, the retry could see `NotFound` on the source and give up on
the metadata. The Pull all cleanup swallowed its errors too, and could finish green with residue on
disk.

**The fix.** The two halves are removed independently, `NotFound` is idempotent success, and the exact
unfinished path is queued. `removeFunctionPaths()` is shared by the rename and by Pull all; residue is
reported and makes the access verdict incomplete.

**The rule.** **Two files are two operations.** A pair removed or written in one `try` is a pair that
can half-exist, and the failure is invisible on the next pass because the half that succeeded now
looks like nothing to do.

## 5. Analytics: a failed SQL cleanup was covered by the final success - medium

**What broke.** If an old `.sql` could not be removed, the warning was immediately overwritten by the
pull's closing message. `WS_MOVED` could also be demoted to an ordinary cleanup error.

**The fix.** `pruneSql()` returns the number of failures, rethrows a workspace change, and uses the
operation-bound status. `pullAll()` keeps the count in the snapshot and ends in warning, not green.

**The rule.** **The last message wins, so the last message must know everything.** A warning raised
mid-operation is lost unless the outcome carries it; «it ended green» has to mean every part ended
green.

## 6. CRM: the workspace boundary did not cover every configuration read - high

**What broke.** Pulls captured root and generation for their writes, but several `.zoost.json` checks
still went through the global resolver. The disabled selector made the race hard to trigger from the
UI, and the contract did not hold if anything re-enabled it. `noteAccess()` also published the new
verdict in memory before the configuration was written, so a disk error could hide a tab until the
panel was reopened.

**The fix.** Every CRM pull reads binding and indexes through the same operation it writes with.
`patchCfg()` reads through `opReadCfg(op)` when given one. The access verdict is published only after
the configuration commits, and discarded if the operation has been superseded.

**The rule.** **A boundary that only holds when the UI is cooperating is not a boundary.** State it in
the code, not in the disabled state of a control - and publish an effect only after the write it
describes has landed.

## 7. Documentation and the sample did not describe the new commit protocol - medium

**What broke.** The code had introduced `.pull-state.json`; the sample-workspace generator did not
write it and neither guide described it. The published Analytics sample count was still 13 files
instead of 14.

**The fix.** The sample writes a `complete` marker; the decisions note and both guides explain the
transactional semantics; the demo pages, the translation digest and the derived sitemap follow.

**The rule.** Already in `CLAUDE.md` and broken again here: **a change to what `+ Sample` writes is a
change to every number printed about it.** `tools/samplecheck.py` holds the counts to what the
generator actually produces, which is why this was found rather than shipped.

## 8. Review tools: unclosed file descriptors and an id with no reader - low

**What broke.** `asynccheck.py` opened the two HTML files without closing them, so the suite emitted
`ResourceWarning`. The dead-code sweep also reported `tab_cols`: an id nothing read, because the
Columns tab is handled generically by class and `data-tab`.

**The fix.** A context manager, and the id is gone.

**The rule.** **A warning in the suite's own output is a finding.** Noise trains the reader to skip
the place where the next real message will appear.

## 9. The workspace binding was lost across transitive calls - high

**What broke.** Several functions received the operation that identifies root and generation, then
called a second loader without passing it. That loader made a new one from whatever workspace was
visible at that moment. The locked selector reduced the odds from the UI but protected neither
rebuilds, Health, export and the assistant, nor anything re-enabling the selector programmatically.
The possible result: an answer built from two workspaces, or published into the one that had taken
over.

**The fix.** The operation is propagated along the whole chain - modules, schedules, workflows, action
users, Health, export and the AI tools of both extensions. Error messages and the rename check they
are still in the workspace they started in.

**The rule.** **Derive the callers, never list them.** The test reads the operation-aware signatures
out of the source and reports every call that drops `op`, so a function added tomorrow is covered by
nobody remembering. Proven red by removing `op` from `rebuildModules(op)` on purpose.

## 10. Analytics: one global read error contaminated the next workspace - high

**What broke.** `readJson()` wrote every error into a global accumulator. An incidental configuration
read could therefore make the *following* workspace look unreadable, and a slow read overtaken by a
workspace change could revoke `rootGranted` in the new one.

**The fix.** The read discards every effect if its operation is no longer current, and hands any error
only to the caller that observed it. `loadFromDisk()` collects the failures of its own four parts
locally and publishes that verdict alone.

**The rule.** **An error is owned by the caller that asked, not by the module that noticed.** A global
error bucket outlives the question that filled it, and the next reader inherits an answer to a
question they never asked.

## 11. Analytics: partial refreshes could leave memory and disk in two moments - high

**What broke.** `pullOne()` and `retryFailed()` mutated `sqls`, `deps` and `pullFailed` before writing
lineage, SQL files and index. A full disk, an unreadable index or a permission revoked halfway left
the panel on the new state while the mirror was only partly updated. An unreadable `sql/index.json`
was also degraded to an empty fallback and could then be written over it, losing every row the
refresh did not touch.

**The fix.** Both flows build local copies, write under the `.pull-state.json` marker, and publish the
globals only after `complete`. A failure blocks the live snapshot and demands a Pull all. A
non-`NotFound` read of the index aborts the write instead of becoming `{}`.

**The rule.** **A read that failed is not an empty read.** Treating «I could not read it» as «there is
nothing there» turns a transient error into a deletion - and the deletion is written confidently,
because the code believes it knows.

## What was verified

- 658 Node tests green; 240 Python tests green, 2 skipped for machine configuration.
- 460 panel tests, including the new cases, green.
- `twincheck`, `asynccheck`, `sitecheck`, `samplecheck`, `csscheck`, `namecheck`, `featurecheck`,
  `htmlcheck`, `sitemap --check`, `stamp --check`, `notescheck` and the dead-code sweep: no findings.
- The probe in a real Chrome: both panels green.
- Store packaging of both extensions succeeded; the temporary archives were removed.
- Site audit: hosts, routes, canonical URLs and published files all reachable. Files changed by this
  sweep differ from the live site until they are committed and deployed, which is expected.
- `imgcheck`: two known findings, the CRM and Analytics screenshots to re-render, excluded on request.

## What this sweep cannot establish

1. Fixtures and the probe cannot reproduce every shape and every limit of Zoho's API responses across
   real organisations, roles, rate limits and data centres.
2. Site changes cannot match the public site before they are deployed.
3. No manual authenticated session was run against a real CRM organisation or Analytics workspace; the
   probe uses the sample workspace and checks the wiring in the browser.
