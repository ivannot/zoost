/* CRM runtime failure index and pull. */
// ---------- execution failures (and the last 24 hours of run counts) ----------
//
// There is no Failures tab. A failure is not a kind of object - the tabs are functions, modules,
// workflows, schedules, connections - it is an *event about a function*, and giving it a sibling
// tab put it a level too high. It shows in the two places that dimension belongs: on the function
// itself, and in the health view, which already answers «what is wrong across this org».
let failIndex = null;   // {at, usage, runs, month, byName:Map} - built once per read, dropped on pull
async function failuresIndex(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (failIndex) return failIndex;
  let d = null; try { d = JSON.parse(await op.read('failures/index.json')); } catch (_) {}
  const byName = new Map();
  if (d && Array.isArray(d.failures)) {
    d.failures.forEach((f) => { const k = String(f.name || '').toLowerCase(); if (k) (byName.get(k) || byName.set(k, []).get(k)).push(f); });
  }
  if (!op.current()) return null;
  failIndex = { at: (d && d.at) || null, usage: (d && d.usage) || null, runs: (d && d.runs) || null,
                month: (d && d.month) || null,
                credits: (d && d.credits) || null, capped: !!(d && d.capped), byName, all: (d && d.failures) || [] };
  return failIndex;
}

//
// The rest of the mirror is a photograph of a structure that changes rarely, and its point is that
// `git diff` answers «what changed». This is not that: failures change hourly, and a diff of them is
// noise rather than history. It is written to disk all the same - so the export, the assistant and
// an offline read all see it - but as **one file that says when it was read**, not as a folder of
// items pretending to be durable.
//
// `params` - the input of the failed execution - is dropped in the bridge and never arrives here.
// See the comment there for why: for a REST API failure it carries a real person's name and email,
// and Zoost says on three surfaces that it does not read records.

/** «8 failing» beside a Pull reads as eight failed downloads - the opposite of what it means, since
 *  the pull worked and the number is functions Zoho reports failing at *runtime*. Reported, and the
 *  green did not save it: a colour cannot name a subject. One sentence for both readers of it, the
 *  status line and the health view's own line, so the two cannot drift. */
// The count is a reading of one page, so a full one says so wherever it is shown - here, in the
// health view, in both exports and in what the assistant is told. A number at its own ceiling and
// a number that happens to be the whole truth look identical.
const FAIL_CAPPED = 'Zoho\'s list was read to its first page - there may be more failures than these.';
function runtimeSummary(n, capped) {
  return (n ? `Read from Zoho \u00b7 ${n} function(s) failing there`
            : 'Read from Zoho \u00b7 nothing failing there')
       + (capped ? ` \u00b7 ${FAIL_CAPPED}` : '');
}
async function pullFailures() {
  const op = beginWorkspaceOp();   // the workspace this belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  try {
    pullActive = true;
    await requirePerm(op.root);
    const ctx = await getContext(); if (!ctx) throw new Error(MSG.noTab);
    const cfg = await opReadCfg(op);
    if (cfg?.org && (cfg.org !== ctx.org || (cfg.base && cfg.base !== ctx.origin) || (cfg.instance && ctx.instance && cfg.instance !== ctx.instance)))
      throw new Error(MSG.wrongTab);
    setStatus('Reading failures\u2026', 'busy');
    // Through `bridgeError`, like every other pull: a bare Error drops `forbidden`, `status` and
    // the refusal's own words at the message boundary, so a role that cannot read this area was
    // reported as «pull error: HTTP 403», the tab stayed, the verdict was recorded as a failure
    // rather than a refusal, and every later Pull all asked again for ever. Three pulls were still
    // doing it by hand while the helper's own comment said «every one goes through here».
    const r = await toBridge({ cmd: 'pullFailures' }); if (!r?.ok) throw bridgeError(r, 'failures read failed');
    // One file for everything Zoho knows about how this org *runs*: what failed, how much ran, and
    // what it cost. It keeps the `failures/` name because that is what a reader looks for, and the
    // shape says the rest.
    if (!op.current()) return;
    await op.write('failures/index.json', JSON.stringify({ at: r.at, usage: r.usage || null,
      runs: r.runs || null, credits: r.credits || null, capped: !!r.capped,
      // The month beside the day, and stored under its own key rather than replacing it: everything
      // that reads this file today speaks in the last twenty-four hours, and a key that quietly
      // changed window would move every number on screen without a word.
      month: r.month || null, failures: r.failures || [] }, null, 2));
    await noteAccess('failures', null, op);
    // No view of its own: a failure is a property of a function, not a kind of object, so it shows
    // where that dimension belongs - in the function's own detail, and in the health view, which is
    // already the place that answers «what is wrong across this org».
    setStatus(runtimeSummary((r.failures || []).length, r.capped), 'ok');
    if (viewMode === 'functions') { failIndex = null; await rebuildTree(); }
  } catch (e) { await notePullFailure('failures', e, op); }
  finally { endPull(); }
}


