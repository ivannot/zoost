# How the suite is written

Open this before adding a test, changing one, or building a checker - and after any session that
proved something by hand. It is the «Tests» section of `CLAUDE.md`, moved out whole when that file
reached 94% of a budget that exists so nothing is dropped in silence. Nothing was cut.

What stayed in `CLAUDE.md` is what binds *every* change - the command, prove-red-and-prove-green, and
that a check worth running once is kept. What is here is true about **one area**: this suite, its
lifters, its reporter, and the traps met while writing it.

**No framework, no dependencies, no build step** — node's own runner and Python's `unittest`, both
already present on any machine that can build this project. A suite needing `npm install` would be
the first dependency in a repository whose pitch is that it has none.

**Every case is a bug that actually happened.** A test written from imagination tests the
imagination; these were lifted from the throwaway checks run while fixing real defects — the Deluge
comment/string scanner, which CSRF cookie belongs to which family, staleness derived per area,
reading an annotated tag out of an Atom feed, the shape guard on what the Store reports. **The checkers are
tested too**, and that is not ceremony: two of the three shipped broken on the day they were written,
and a broken checker reports success over the thing it exists to catch, which is worse than none.

**A test written from the same premise as the code cannot fail on it, and a fixture with one source
cannot show a defect between two.** Both halves happened in one day. «Outdated» was decided by
`row.listUpdated !== meta.updatedTime` - an epoch in milliseconds from the org *list* against a
formatted string from a function's *detail*, so every function in every real org was outdated for
ever. It shipped with two tests, and one of them asserted that exact expression with a regex: written
from the same belief, it could only confirm the belief was still spelled the same way. Nothing in the
sample could contradict it either, because the sample's `index.json` carried no `updatedTime` at all
- one source, so no pair, so no mismatch. It was found by a user, on his own org, the next morning.

Three rules, and the third is the general one. **Assert the behaviour on real values, never the
expression** - `movedInZoho(1773397259000, '2026-03-13 11:20:59.0')` is a case; `/a !== b/.test(src)`
is a photograph. **A fixture must carry every source the code compares**, or the comparison is
untested by construction. And **when a value crosses a boundary, the two sides are two shapes until
something proves otherwise** - this repository has now met that class four times: the `\x1e` record
separator, the CSRF cookie family, the `.dg`/`.meta.json` pair, and this. The fix is never to parse
one into the other on the machine you happen to be on: it worked here, and would have failed for
anyone whose browser sits in a different timezone from the org. Store the same kind of value on both
sides and compare like with like.

**A check worth running once is worth keeping.** Verifying a fix by hand — the `node -e` throwaway,
the loop that tries five inputs — is already writing a test; the only difference is whether it
survives the session. It goes into `tests/` before the commit that fixes the thing. No ceremony and
no separate task: if a defect was worth reasoning about, the reasoning belongs where it can run
again. The suite grows by the bugs we meet, which is why it has teeth.

**One message, one place - and the panel said the same sentence three ways in ten sites.** «Se
proliferano le funzioni duplicate è la fine», and a *message* written out twice is that defect one
layer down: the two copies are one careless edit away from disagreeing, and nothing would say so.
Measured on the tree before the fold - a quoted literal, never a template chunk, starting with a
capital and containing a space - **39 clusters across the 22 shipped scripts**, 25 of them in
`apps/crm/sidepanel.js` alone. The worst was not the count: a lapsed folder permission was reported
as **«needs re-granting» (x5), «denied» (x3) and «not granted» (x2)**, so one browser behaviour
arrived as three different problems, one of which - «denied» - names a state with no action in it.
They are one sentence now, **`Folder access needs re-granting - click ↻ Refresh.`**, which names the
control that fixes it; `requirePerm()` throws it in **both** apps, because the same helper wording
the same fact differently per product is the drift the twin rule exists to stop.

Everything else folded into a `const MSG = {…}` per file - the two panels, both graph windows, the
Analytics options page - plus `engineLabel()` for the `'anthropic' ? 'Anthropic (Claude)' : …`
ternary that both options pages carried twice, and plain data constants in `sample-org.js`, where
the repeated strings are a fixture author and a workflow trigger rather than messages. The health
audit's seven section titles were duplicated between the panel's view and the HTML export, which is
exactly the pair that must not drift, since a reader moves between the two.

**The check is `tests/panel.test.mjs`, it globs `apps/*/*.js`, and it has no allow-list.** That is
the load-bearing part: the file set is derived, so a script added tomorrow is covered without anyone
remembering, and there is no exemption map to become a checklist wearing a script's clothes - the
two failure modes this repository has already recorded. The criterion was tuned by measuring rather
than argued: on the folded tree it reports **zero** across all 22 scripts, so every future finding is
real. It reads literals inside `${…}` interpolations (that is where both options pages' engine
labels were hiding, invisible to the first pass), decodes escapes so `'…'` and `'…'` are one
message, and skips comments - outward the rule never bends, between us it can. Proven by
reintroducing a duplicate in `sidepanel.js` and in `options.js`, and by drifting the twin wording by
one verb: three findings, one each.

**What it does not catch, said rather than left to be found.** A fragment starting lowercase -
` - click to retry` was duplicated three times beside `Failed: ` and is folded, but nothing here
would have found it. A message built by concatenation, which is not one literal. And the same
sentence in two *files*: only the folder wording is held across the twins, by a case of its own.
Extend the check when one of those bites; do not extend the care.

**The fold found a live bug through the suite, which is the argument for the suite.** `MSG.errPrefix`
landed inside `friendlyError()`, which `tests/keyvault.test.mjs` lifts and *runs* in a bare context -
a ReferenceError three lines in, `node --check` perfectly happy, exactly the free-variable trap
already recorded above. The lifters now take the panel's `MSG` block with the function, reading the
wording from the shipped constant instead of restating it. Both panels and both graph windows were
then re-rendered headless through `tools/shots.py` (11 shots, all ok) and both options pages loaded
in headless Chrome with zero console errors - because a scope bug is only ever found by running.

**The panels are not restructured to be importable.** `tests/slice.mjs` lifts a named function out
of a browser script and runs it alone; refactoring 3000 lines of DOM-bound code *in order to* add
tests would spend the risk before earning the cover. The limit is stated rather than hidden: this
proves the logic, not the wiring — a correct helper called from the wrong place still passes. If
`sliceFn` cannot find a function it **throws**, so a rename cannot silently drop the cover.

**And what it lifts has to be a *declaration*.** `sliceConst` ends a `const` at the first semicolon
that closes a line, which for a multi-line arrow is its **first statement** - so the slice is short,
wrong and silent. A comparator written `const cmpVer = (a, b) => {…}` in `site/_worker.js` was cut
after one line, and the red mark landed three tests away, on `pickLatestTag`, which sorts with it. A
shared helper that a test will lift is a `function`; one-line arrows are fine as they are.

**A test appended below `unittest.main()` never runs, and the suite still says OK.** Six cases were
added to the end of `tests/tools_test.py` and `tests/run.sh` reported 78 passing while ignoring them;
`unittest discover` found 84. Nothing is wrong on screen — a number changes, and a number nobody
compares against anything is not evidence. The trailer is last in the file and two cases hold it
there, one reading the source for a class below it and one comparing what the loader collects against
what is written. The first version of the second shelled out to the same file and recursed until it
was killed, which is its own small lesson: a test about a suite reads the suite, it does not run it.

**A test that fails unreadably is half a test, and there is more than one way to get there.**
`assert.match` on a large haystack is one: it prints the whole `actual` into the failure, and node
19's TAP lexer dies on a multi-byte character split across a socket read. **A `#` in the message is
the other**: TAP reads it as the start of a comment, so `${app}: #${id} does not say it exports`
arrived as `analytics: ` and said nothing. Write ids as `id=exportmd`, and assert with
`assert.ok(regex.test(x), 'why')` whenever `x` is a slice of source. Both times the suite went
red, so the guard worked; both times whoever tripped it would have learnt nothing.

**`sed -i ''` corrupts a UTF-8 source on macOS, and it corrupts it silently.** Used to apply a
deliberate mutation while proving the check above, it mangled the panel's `\u00ab\u00bb` and arrows into bytes
that would not parse - and the resulting error looked exactly like the reporter bug being chased.
Mutations are applied from Python, which is what every working one in this repository already used.

**And `git checkout <file>` to undo one is still the trap this file already names.** It happened
again, in the same context - proving a checker - and it discarded real uncommitted work in the same
file. The rule was already written down: copy the file aside first and restore from the copy. Writing
a lesson down is not the same as having learnt it; the only thing that actually prevents this is
never typing the command.

**Prove a test can fail before trusting it.** Same rule as the checkers. Break the thing on purpose
— point the deluge token at the wrong cookie, set the staleness margin to zero, restore the tag
filter that dropped annotated tags — and confirm red, then restore. A suite that has never failed is
a claim.

**And prove it can pass, which is the half that was missing everywhere this was written.** A gate
that always refuses is not strict, it is broken, and it looks identical to a strict one until
somebody needs it. `release.sh` ran `auditcheck --offline`, which reports the skipped live comparison
as a *finding* by design — so the one step that is public and irreversible refused every run, over a
line nobody can act on, from the hour it landed until somebody tried to cut a release. It was never
noticed because a release gate is exercised once per release and there had not been one since. The
rule is mechanical: **a check that runs rarely gets both proofs on the day it is written** — red on a
planted defect, and green on the state it is actually meant to allow. `auditcheck --before-tag` is
that state, and four cases hold the difference between it and `--offline`.
