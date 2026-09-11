# Three readers on the raw-endpoint commits - 11 September 2026

Three commits added a way to drive both extensions' Pull all in headless Chrome against invented
wire fixtures, and changed the CRM bridge's token recovery on the strength of a real capture. Three
reviewers with no memory of either were pointed at what does not work. Four defects were real and
reproduced on both revisions before anything was touched; one risk was left as a decision; and the
battery itself was red for a reason that had nothing to do with the code.

## A mechanism with two jobs, replaced for one of them

**What broke.** The Deluge recovery used to make one ordinary CRM read with the token it had just
fetched. A capture proved that read does not recover the Connections catalogue, so it was replaced by
the three session reads Zoho's own Connections page makes. But the read had a second job, written in
the comment the change removed: the calm sentence for a refusal - «this Zoho user may not have access
to it» - requires the token to have been *seen accepted*, which only `api()` records. A non-admin user
pulling only Connections was shown the cookie diagnostic again, the message removed a week earlier
after it was reported from a real org.

**The fix.** Both reads, each for its own job: the CRM read only when the token has not already been
seen accepted, then the Deluge sequence only for a Deluge refusal, immediately before the retry.

**The rule.** **Before replacing a mechanism, list every job it does - not the one that motivated the
change.** The job that was dropped was stated in the comment that was deleted with it. Held by
`crm: Connections pulled alone and refused twice is still said calmly` in `tests/panel.test.mjs`,
which scripts requests by URL so it asserts *which* requests went out.

## A transient line nobody owns

**What broke.** The bridge began reporting «files for <function> n/m», and the panel showed it
whenever the pull buttons were held. A single-row download holds them and writes no closing
sentence, so the status bar kept spinning on the last progress line after the download ended.

**The fix.** When a single-row download returns, a `busy` status still on screen is stale by
definition and what was there before is put back.

**The rule.** **A message that says «in progress» needs an owner who ends it, on every path that can
start it** - including the ones that were never pulls. Held by a driven case, both outcomes.

## A client that waits for a remote without noticing it has gone

**What broke.** Both endpoint probes resolved a protocol call only when Chrome answered. Chrome dying
mid-run left every call pending, nothing kept Node alive, and the probe exited 0 - so the battery
said «ok» over a pull that had not finished. A page that never answered hung the battery, and the
pre-push hook with it, because no call had a bound.

**The fix.** A close or an error rejects every waiting call; every call has a timeout; `probe.py`
bounds each probe; a signal-killed Chrome counts as exited; a cleanup failure no longer replaces the
error of a run that had already failed.

**The rule.** **Anything a gate waits on must fail on loss and on silence, not only on a wrong
answer** - a gate that can exit 0 without an answer is green by absence. **Not held by a check in the
battery:** it was reproduced with a stub speaking the debugging protocol, outside the repository.

## Decoration in the output a gate parses

**What broke.** A Claude Code update exported `FORCE_COLOR`, node coloured its summary even into a
pipe, and `tests/run.sh` - matching the count on digits that end the line - read «ran no cases» over
1117 that had passed.

**The fix.** Colour codes are stripped from the saved copy before it is parsed.

**The rule.** **A gate that parses a tool's output must not depend on how a terminal would decorate
it.** Not held by a test; every run on a machine with `FORCE_COLOR` set exercises it.

## Left as a decision

`queryParents` in the Analytics bridge now refuses a `PAROBJID` that is not a JSON array. If Zoho ever
sends it absent, `null` or empty, that query loses its SQL on every pull and is offered a Retry that
cannot succeed - while the field it refuses over is shown nowhere. No capture has contained that
shape, and refusing an unmeasured shape was the deliberate choice of the commit, so it stands. The
rule this leaves: **a refusal should cost no more than the field it protects** - worth applying the
day that shape is seen.
