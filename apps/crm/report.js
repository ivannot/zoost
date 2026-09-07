// @ts-check
// ---------- problem reports ----------
//
// Nothing here is sent by the extension. It builds a text, shows it to the reader in full, and -
// only on a click - opens zoost.it/report and writes the text **into that page**, through the DOM.
// It used to travel in the URL fragment, on the reasoning that a fragment is never transmitted to a
// server: true, and not the whole question, because the navigation itself is written to the
// browser's history and syncs with it. Nothing about the report is in any address now. The page
// shows it again, and the reader is the one who submits it. So «no telemetry, nothing automatic»
// stays true in the strong sense, and the report that does travel has been read twice by the person
// sending it.
//
// Two defences, because one is a promise and the other is a mechanism. The mechanism: what goes in
// comes from a **whitelist of known fields**, never from a sweep of state - a field added tomorrow
// is a decision, not an accident. The promise, kept honest by a test: free text passes `redact()`.

/** @typedef {{
 * product: unknown,
 * version: unknown,
 * browser: unknown,
 * message: unknown,
 * stack?: unknown,
 * tab: unknown,
 * search: unknown,
 * pullActive: boolean,
 * sample: boolean,
 * ai?: unknown,
 * counts?: Record<string, unknown>,
 * refused?: unknown[],
 * diag?: {what?: unknown, from?: unknown, shape?: unknown, cookies?: unknown[]},
 * steps?: unknown[],
 * }} ProblemReport */

// Everything that is never collected. It was dead - declared here, read by nothing, while the
// comment claimed a test enforced it: a decoration wearing the clothes of a mechanism, found by an
// audit. `tests/panel.test.mjs` now reads this very array out of the source and checks that neither
// `reportFacts` nor `buildReport` mentions any of it, so the list and the check cannot drift.
const REPORT_NEVER = ['apiKey', 'apiKeyEnc', 'source', 'sql', 'code', 'name', 'displayName',
  'folderName', 'owner', 'org', 'instance', 'path', 'root'];

// Free text - an error message, a status line - with everything that could name your business
// taken out of it. Aggressive on purpose: a message can embed an org id, an instance, a function
// name in quotes. What it keeps is the *shape* of the sentence, which is what diagnoses.
// It cannot be proven exhaustive, and it is not the only defence: the whitelist above decides what
// is offered at all, the reader sees the result before sending, and the Worker redacts again.
// A declaration, byte-identical in both panels and in the report page: one text, one meaning.
/** @param {unknown} text */
function redact(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  const out = String(text)
    // Ours, and the whole diagnostic value of a stack: kept, minus the extension id, which is noise.
    .replace(/chrome-extension:\/\/[a-z]+\//gi, '')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, () => { n++; return '<email>'; })
    .replace(/https?:\/\/[^\s)"']+/gi, () => { n++; return '<url>'; })
    .replace(/\b\d{8,}\b/g, () => { n++; return '<id>'; })
    .replace(/«[^»]*»/g, () => { n++; return '«…»'; })
    .replace(/"[^"]*"/g, () => { n++; return '"…"'; });
  return { text: out, n };
}

// Free text that this panel *interpolated names into*, treated as hostile. `redact()` is not enough
// for it and an audit proved it: the status line says `Synced: functions/Commissions/Recalc_Fees.dg`
// and `Working folder: <a client's name>`, and none of that is an email, a URL or a long number. The
// call sites are ~150 and nothing can constrain what one written tomorrow will interpolate, so this
// takes the opposite approach: anything shaped like an identifier, a path or a host goes, and what
// survives is the sentence around it - which is what actually diagnoses.
// It cannot be proven exhaustive. That is why the reader is shown the result and asked to read it,
// and why the wording on the site says «what it recognises», never «never».
/** @param {unknown} text */
function redactHard(text) {
  if (text == null) return { text: '', n: 0 };
  let n = 0;
  /** @param {string} mark */
  const hit = (mark) => () => { n++; return mark; };
  const out = String(text)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, hit('<email>'))
    .replace(/https?:\/\/[^\s)"']+/gi, hit('<url>'))
    .replace(/[a-z]:\\[^\s"']*/gi, hit('<path>'))
    // A path, or a Zoho namespace: anything with a slash joining two names.
    .replace(/[\w.-]+(?:\/[\w.-]+)+/g, hit('<path>'))
    // Quoted, in every style the panels and the platform actually use - Chrome's own DOMException
    // messages quote with apostrophes, which the first version did not touch.
    .replace(/«[^»]*»|"[^"]*"|'[^']*'|[‘“][^’”]*[’”]|`[^`]*`/g, hit('«…»'))
    // No word boundary: an id glued to a prefix - `zcrm_349725000131663089` - kept its digits.
    .replace(/\d{6,}/g, hit('<id>'))
    // A host without a scheme, which the URL rule above never saw: `crm.zoho.eu`.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, hit('<host>'))
    // What is left of an identifier: dotted or underscored, which is what a function, a module api
    // name and a mirror filename all look like.
    .replace(/\b\w+[._]\w[\w._]*\b/g, hit('<name>'));
  return { text: out, n };
}

// The report as the reader will see it and as the page will re-render it: a pure function of an
// object nobody had to be trusted about. Every value it prints is either a number, a boolean, one
// of a fixed set of words, or free text that has been through `redact()`.
/** @param {ProblemReport} r */
function buildReport(r) {
  /** @type {string[]} */
  const L = [];
  const red = { n: 0 };
  // Two levels, because the two kinds of text are not alike. The stack is ours by construction -
  // chrome-extension://<id>/sidepanel.js - so it keeps its file and line, which is the whole of its
  // value. Everything else was built by interpolating whatever was to hand, and is treated as such.
  /** @param {unknown} s */
  const clean = (s) => { const o = redactHard(s); red.n += o.n; return o.text; };
  /** @param {unknown} s */
  const ours = (s) => { const o = redact(s); red.n += o.n; return o.text; };
  L.push(`${r.product} ${r.version} · ${clean(r.browser)}`);
  L.push('');
  L.push('what happened');
  L.push(`  ${clean(r.message) || '(no message)'}`);
  // **Only the frames.** The comment above is true of the frames and false of the first line:
  // V8 puts the message there verbatim, so the light redaction reprinted, one line below, the
  // portal name and the org id that `redactHard` had just removed from that same sentence -
  // under a footer telling the reader that names and ids are stripped. Every message this panel
  // builds by interpolation was affected, and the header is `r.message` again anyway.
  const frames = r.stack ? String(r.stack).split('\n').filter((s) => /^\s*at\s/.test(s)) : [];
  if (frames.length) ours(frames.join('\n')).split('\n').slice(0, 12).forEach((s) => L.push(`  ${s.trim()}`));
  L.push('');
  L.push('state');
  L.push(`  tab: ${r.tab} · search: ${r.search} · pull: ${r.pullActive ? 'running' : 'idle'}`);
  L.push(`  workspace: ${r.sample ? 'the sample - invented data' : 'a real one'} · assistant: ${r.ai || 'not configured'}`);
  if (r.counts && Object.keys(r.counts).length) {
    L.push(`  counts: ${Object.entries(r.counts).map(([k, v]) => `${k} ${Number(v)}`).join(' · ')}`);
  }
  if (r.refused && r.refused.length) L.push(`  areas your Zoho role refused: ${r.refused.join(', ')}`);
  // **Printed as fields, and not through `clean`.** The bridge writes the same three facts into the
  // message as well, and the message cannot carry them here: `redactHard` turns `INVALID_CSRF_TOKEN`
  // and every cookie name into `<name>` and reads «128 chars, no '='» as a quotation - correctly,
  // because its whole job is to destroy anything shaped like an identifier. The diagnostic was added
  // so a refusal arrives as evidence instead of three words, and the report is exactly where it was
  // being asked to arrive.
  //
  // Safe without redaction by construction, which is why it is a *field* and not a licence: two
  // names, a length, and a list of cookie names. No value of any cookie is read anywhere on this
  // path, and `shape` is a count of characters and a yes/no about one of them.
  if (r.diag && r.diag.what === 'csrf') {
    L.push(`  csrf: token from ${r.diag.from || '?'} (${r.diag.shape || 'no value'})`);
    L.push(`  cookies on that page, names only: ${(r.diag.cookies || []).join(' ') || '(none readable)'}`);
  }
  if (r.steps && r.steps.length) {
    L.push('');
    L.push('last steps, oldest first');
    r.steps.forEach((s) => L.push(`  ${clean(s)}`));
  }
  L.push('');
  L.push(`redactions: ${red.n} · no source, no SQL, no keys, and no file of yours was read to build this.`);
  L.push('Names, paths and ids are stripped where they are recognised - which is why you are being shown it.');
  return L.join('\n');
}

// The last lines the status bar said, in memory only - never written to disk, gone when the panel
// closes. Thirty because a failure is usually three or four steps after the thing that caused it,
// and a reader has to be able to read the whole buffer before deciding to publish it.
const REPORT_STEPS_MAX = 30;
/** @type {string[]} */
const reportSteps = [];
/** @param {unknown} text */
function noteStep(text) {
  if (!text) return;
  const t = String(text);
  if (reportSteps[reportSteps.length - 1] === t) return;   // a progress line repeating itself
  reportSteps.push(t);
  if (reportSteps.length > REPORT_STEPS_MAX) reportSteps.shift();
}
