# Three reviewers on the panel refactor - 7 September 2026

Twenty-four commits split `apps/crm/sidepanel.js` from 7,110 lines to 4,005 across thirteen new
files. The battery was green on arrival - 1,103 node cases, 413 python, every checker at zero, both
packages built, all six browser paths driven. Three readers with no memory of writing any of it were
pointed at what does not work. They found eight things, and the two that matter are not in the
refactor at all: they are gates that had quietly stopped refusing.

## The rules it left behind

**A gate is bound to what runs it, not to the file somebody named.** `battery.yml` set
`ZOOST_REQUIRE_CHROME`; `release.yml` ran the same `bash tests/run.sh` without it, so the one job
that builds, signs and publishes was the one where `tools/probe.py` could say «no Chrome here», exit
0, and let a green suite mean no extension had been executed. The case holding the rule read a named
path. It derives the list from which workflows run the battery now - `tests/tools_test.py`,
`test_every_workflow_that_runs_the_battery_refuses_to_skip_the_browser`.

**A ledger that only unions is a standing permission.** `htmlcheck --accept` merged the new reading
with the old, so a row outlived its code: 21 of 266 matched nothing, 9 added during a refactor that
never touched `export.js`. Rows there pre-bless interpolations in the one document with an inline
script and no CSP, so a phantom row is markup nobody will read. It is derived from the file now and a
stale row is a finding - which is what the sibling `csscheck` had always done, and what this
ledger's own «it should shrink» had been claiming with nothing behind it.

**A claim moves with the code, on every surface, including the ones inside the product.**
`product-help.js` - the assistant's own context, in both products - said the sample button «is
absent once one exists»; `updateSampleButtons` sets `hidden = false` unconditionally. The website was
corrected for this in the same series. `llms.txt` contradicted itself about how many files there are
to read, on the sentence that invites the reader to check there is no write path.

**Two owners of one value is one owner too many.** `searchState` owns the search text since it left
the composition root; `health.js` still wrote the input. The list filtered, nothing was recorded, and
leaving the tab lost it. Held by a check that counts the writers of `$('find').value` and expects
exactly one - the painter.

**A script before the composition root declares; the root binds.** `live-sync.js` called
`addListener` at load, four scripts before `sidepanel.js` declares what the handler reads. Nothing
was observed, because no sender exists in that window - which is why it needed a check rather than a
report: `test('no script before the composition root binds a runtime listener at load time')`
derives the order from the page.

**A count states its denominator, and a checker states what it does not read.** `typecheck.sh`
printed «13 contract module(s)» over 39 scripts and never reads a call site in the other 26 - where
the wiring lives. Both are printed now.

**A list of files maintained by hand is a list that goes stale.** `matrix.py` had 23 shipped scripts
in no surface, 12 created in one refactor. Derived from the directory now, in both directions.

## Stated, not solved

`/api/funnel` is the only unauthenticated write on the site. An `Origin` header is set by the browser
and forged by anything else, so a stranger can add points to a billed dataset and skew what
`tools/funnel.py` prints. `/api/report` can afford Turnstile and a counter because it runs when
somebody presses a button; this runs on every page view, and a per-request store would cost more than
the measurement is worth. The proportionate answer is a rate limit at the edge - a zone setting, not
a line of code - so it is written in the function rather than solved badly in it.

## The rule this sweep is really about

Every one of these passed a green battery. The refactor did not break them: it moved the ground under
checks that were pinned to a name, a file or a hand-written list, and each went on printing a number
while measuring less. **When code moves, a check that names something is a check that has stopped
measuring - derive its subject, or expect it to go quiet.**
